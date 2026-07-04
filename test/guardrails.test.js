import { _internal as browser } from "../src/browser.js";
import { _internal as parse } from "../src/parse.js";
import { _internal as ozon } from "../src/ozon.js";

let failed = 0;
const check = (cond, msg) => {
  console.error(`${cond ? "  ok " : " FAIL"}  ${msg}`);
  if (!cond) failed++;
};
const throws = (fn, re, msg) => {
  try {
    fn();
    check(false, msg);
  } catch (e) {
    check(re.test(e.message), `${msg}: ${e.message}`);
  }
};

console.error("── browser guardrails ──");
check(browser.validateOzonHome("https://www.ozon.ru/") === "https://www.ozon.ru/", "accepts ozon.ru origin");
check(browser.validateOzonHome("https://am.ozon.com") === "https://am.ozon.com/", "accepts regional ozon.com origin");
throws(() => browser.validateOzonHome("http://www.ozon.ru/"), /https/i, "rejects non-HTTPS OZON_HOME");
throws(() => browser.validateOzonHome("https://user:pass@www.ozon.ru/"), /credentials/i, "rejects credentialed OZON_HOME");
throws(() => browser.validateOzonHome("https://www.ozon.ru/search"), /origin only/i, "rejects OZON_HOME path");
throws(() => browser.validateOzonHome("https://example.com/"), /Ozon-owned/i, "rejects non-Ozon OZON_HOME");

check(
  browser.ozonRedirectTarget("https://www.ozon.ru/ozonid/domain_redirect?domain=am.ozon.com&redirect_uri=/product/1/") ===
    "https://am.ozon.com/product/1/",
  "follows Ozon-owned regional redirect"
);
throws(
  () => browser.ozonRedirectTarget("https://www.ozon.ru/ozonid/domain_redirect?domain=evil.example&redirect_uri=/"),
  /non-Ozon redirect domain/,
  "rejects non-Ozon redirect domain"
);
throws(
  () => browser.ozonRedirectTarget("https://evil.example/redirect"),
  /non-Ozon host/,
  "rejects non-Ozon direct redirect"
);
throws(
  () => browser.ozonRedirectTarget("http://www.ozon.ru/redirect"),
  /non-HTTPS/,
  "rejects non-HTTPS redirect"
);

console.error("── composer body parsing ──");
const validWithCaptchaString = {
  widgetStates: { "someWidget-1": JSON.stringify({ captchaURL: "https://static.example/captcha.png", value: 1 }) },
};
check(
  browser.parseComposerBody({ status: 200, text: JSON.stringify(validWithCaptchaString) }).widgetStates,
  "accepts valid composer JSON that contains CAPTCHA-like strings"
);
throws(
  () => browser.parseComposerBody({ status: 403, text: JSON.stringify({ incidentId: "abc", blockURL: "/" }) }),
  /CAPTCHA required/,
  "rejects explicit HTTP 403 CAPTCHA payload"
);
throws(
  () => browser.parseComposerBody({ status: 200, text: JSON.stringify({ incidentId: "abc", blockURL: "/", captchaURL: "/captcha" }) }),
  /CAPTCHA required/,
  "rejects explicit JSON CAPTCHA payload without widgetStates"
);

console.error("── regional URL and price guards ──");
check(
  parse.cleanUrl("/product/example-123/?at=token", "https://am.ozon.com") === "https://am.ozon.com/product/example-123/",
  "normalizes relative product URL to regional origin"
);
check(
  parse.cleanUrl("/seller/shop/?tracking=1", "https://www.ozon.ru") === "https://www.ozon.ru/seller/shop/",
  "normalizes relative seller URL to ozon.ru origin"
);
check(ozon.currencyForOrigin("https://www.ozon.ru") === "RUB", "ozon.ru currency is RUB");
check(ozon.currencyForOrigin("https://am.ozon.com") === null, "regional ozon.com currency is unknown/null");
const guarded = ozon.withRegionalPriceGuard({ price: 123, priceRegular: 456, oldPrice: 789, name: "x" }, null);
check(guarded.price === null && guarded.priceRegular === null && guarded.oldPrice === null && guarded.name === "x", "scrubs regional detail price fields");
const ru = ozon.withRegionalPriceGuard({ price: 123 }, "RUB");
check(ru.price === 123, "keeps RUB price fields");

console.error(failed ? `\n${failed} FAILED` : "\nALL PASSED");
process.exit(failed ? 1 : 0);
