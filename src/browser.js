// Single long-lived headless Chromium that passes Ozon's anti-bot (Variti) challenge once
// and is reused for the whole process. Requests are issued as fetch() to Ozon's internal
// composer API from inside the page context — like an extension running in the open tab.
//
// Design (per researched best practices):
//  - lazy init: browser launches on first call, not at startup
//  - one browser + one context for the process; cookies live in the context
//  - browser 'disconnected' -> null refs -> transparent relaunch on next call
//  - all logs go to stderr (stdout is the MCP JSON-RPC wire)

import { chromium } from "playwright";

const DEFAULT_HOME = "https://www.ozon.ru/";
const API_PATH = "/api/composer-api.bx/page/json/v2?url=";
const CHALLENGE_WAIT_MS = 12000;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const NAV_TIMEOUT_MS = 90000;
const CAPTCHA_ERROR = "Ozon CAPTCHA required / public session unavailable";

const LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--mute-audio",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-background-networking",
];

const log = (...a) => console.error("[browser]", ...a);

let browser = null;
let context = null;
let mainPage = null;
let initPromise = null;
let challenged = false;
let effectiveOrigin = null;
let idleTimer = null;

export function isOzonHost(hostname) {
  return /(^|\.)ozon\.(ru|com)$/i.test(String(hostname || ""));
}

export function validateOzonHome(value = DEFAULT_HOME) {
  let u;
  try {
    u = new URL(value || DEFAULT_HOME);
  } catch {
    throw new Error("OZON_HOME must be a valid HTTPS Ozon origin");
  }
  if (u.protocol !== "https:") throw new Error("OZON_HOME must use https://");
  if (u.username || u.password) throw new Error("OZON_HOME must not contain credentials");
  if (!isOzonHost(u.hostname)) throw new Error("OZON_HOME must be an Ozon-owned host (*.ozon.ru or *.ozon.com)");
  if (u.search || u.hash) throw new Error("OZON_HOME must be an origin only, without query or fragment");
  if (u.pathname !== "/" && u.pathname !== "") throw new Error("OZON_HOME must be an origin only, without a path");
  return `${u.origin}/`;
}

const HOME = validateOzonHome(process.env.OZON_HOME);

function resetIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    log("idle timeout — closing browser to free RAM");
    shutdown().catch(() => {});
  }, IDLE_TIMEOUT_MS);
  idleTimer.unref();
}

function safeUrl(url) {
  try {
    const u = new URL(url, HOME);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "<unknown>";
  }
}

function currentSafePageUrl() {
  return safeUrl(mainPage?.url() || HOME);
}

function looksLikeCaptchaText(text = "") {
  return /antibot|captcha|captchaURL|incidentId|капч|пазл|подтвердите,? что вы не бот|ограничен|доступ/i.test(text);
}

function captchaError(status) {
  return new Error(`${CAPTCHA_ERROR} (HTTP ${status})`);
}

function pageOrigin() {
  try {
    const u = new URL(mainPage?.url() || HOME);
    if (u.protocol !== "https:" || !isOzonHost(u.hostname)) throw new Error(`unexpected Ozon page origin: ${u.origin}`);
    return u.origin;
  } catch (err) {
    throw new Error(`Cannot determine safe Ozon origin: ${err?.message || err}`);
  }
}

function safeOzonUrl(url, base = HOME) {
  const u = new URL(url, base);
  if (u.protocol !== "https:") throw new Error(`Refusing non-HTTPS Ozon URL: ${u.protocol}`);
  if (u.username || u.password) throw new Error("Refusing Ozon URL with credentials");
  if (!isOzonHost(u.hostname)) throw new Error(`Refusing non-Ozon host: ${u.hostname}`);
  return u;
}

export function ozonRedirectTarget(redirectUrl, base = HOME) {
  const u = safeOzonUrl(redirectUrl, base);
  if (u.pathname === "/ozonid/domain_redirect" && u.searchParams.get("domain")) {
    const domain = u.searchParams.get("domain");
    if (!/^[a-z0-9.-]+$/i.test(domain) || !isOzonHost(domain)) {
      throw new Error(`Refusing non-Ozon redirect domain: ${domain}`);
    }
    const redirectUri = u.searchParams.get("redirect_uri") || "/";
    if (!redirectUri.startsWith("/") || redirectUri.startsWith("//")) {
      throw new Error("Refusing unsafe Ozon redirect path");
    }
    return `https://${domain}${redirectUri}`;
  }
  return u.href;
}

async function fetchComposerText(sitePath) {
  return mainPage.evaluate(async ({ apiPath, sitePath }) => {
    const r = await fetch(apiPath + encodeURIComponent(sitePath), {
      headers: { accept: "application/json" },
      credentials: "include",
    });
    return { status: r.status, url: r.url, text: await r.text() };
  }, { apiPath: API_PATH, sitePath });
}

function isCaptchaJson(data) {
  if (!data || typeof data !== "object") return false;
  if (data.widgetStates) return false;
  if (data.incidentId || data.blockURL || data.supportURL) return true;
  return looksLikeCaptchaText(JSON.stringify(data).slice(0, 2000));
}

export function parseComposerBody(body) {
  if (body.status === 403) throw captchaError(body.status);
  if (body.status !== 200) throw new Error(`Ozon returned HTTP ${body.status}`);

  let data;
  try {
    data = JSON.parse(body.text);
  } catch {
    if (looksLikeCaptchaText(body.text)) throw captchaError(body.status);
    throw new Error("Ozon returned non-JSON composer response");
  }

  if (isCaptchaJson(data)) throw captchaError(body.status);
  return data;
}

async function launch() {
  log("launching Chromium…");
  browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  browser.on("disconnected", () => {
    log("disconnected — will relaunch on next request");
    browser = null;
    context = null;
    mainPage = null;
    challenged = false;
    effectiveOrigin = null;
  });

  context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    locale: "ru-RU",
    extraHTTPHeaders: { "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7" },
  });
  challenged = false;
  effectiveOrigin = null;
}

async function ensureContext() {
  if (context && challenged) return context;
  if (initPromise) {
    await initPromise;
    return context;
  }
  initPromise = (async () => {
    if (!browser || !browser.isConnected()) await launch();
    mainPage = await context.newPage();
    log("loading Ozon public session…", safeUrl(HOME));
    await mainPage.goto(HOME, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await mainPage.waitForTimeout(CHALLENGE_WAIT_MS);
    log("Ozon page loaded:", (await mainPage.title()).slice(0, 40), currentSafePageUrl());

    // Resolve regional Ozon origin once during bootstrap. fetchJson itself must not navigate:
    // details() calls it sequentially, and hidden navigation would race on the shared page.
    const probe = parseComposerBody(await fetchComposerText("/"));
    if (probe?.redirect) {
      const target = ozonRedirectTarget(probe.redirect, mainPage.url());
      log("following Ozon regional redirect:", safeUrl(target));
      await mainPage.goto(target, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      await mainPage.waitForTimeout(CHALLENGE_WAIT_MS);
      const state = await mainPage.evaluate(() => ({ title: document.title, text: document.body?.innerText?.slice(0, 300) || "" }));
      if (looksLikeCaptchaText(`${state.title} ${state.text}`)) {
        throw new Error(`${CAPTCHA_ERROR} after regional redirect`);
      }
    }

    effectiveOrigin = pageOrigin();
    challenged = true;
    log("using Ozon origin:", effectiveOrigin);
  })();
  try {
    await initPromise;
  } finally {
    initPromise = null;
  }
  return context;
}

const DEAD = /Target page, context or browser has been closed|Session closed|Connection closed|browser has been closed/i;

export async function fetchJson(path, { retries = 1 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      resetIdle();
      await ensureContext();
      const data = parseComposerBody(await fetchComposerText(path));
      if (data?.redirect) {
        throw new Error(`Ozon redirect unresolved after bootstrap: ${safeUrl(ozonRedirectTarget(data.redirect, mainPage.url()))}`);
      }
      data.__origin = effectiveOrigin;
      return data;
    } catch (err) {
      if (DEAD.test(String(err?.message)) && attempt < retries) {
        await shutdown();
        continue;
      }
      throw err;
    }
  }
}

export async function shutdown() {
  clearTimeout(idleTimer);
  challenged = false;
  effectiveOrigin = null;
  mainPage = null;
  try { await context?.close(); } catch {}
  try { await browser?.close(); } catch {}
  context = null;
  browser = null;
}

export const _internal = { isOzonHost, validateOzonHome, ozonRedirectTarget, parseComposerBody };
