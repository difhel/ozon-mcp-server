<p align="center">
  <img src="https://raw.githubusercontent.com/eduard256/ozon-mcp-server/assets/img/ozon-mcp-logo.webp" alt="OZON MCP" width="420">
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/eduard256/ozon-mcp-server/assets/img/ozon-card.webp" alt="Ozon MCP — search, details, reviews" width="100%">
</p>

# Ozon MCP Server

MCP-сервер для поиска товаров на Ozon (ozon.ru). Даёт ИИ три инструмента: искать товары, читать карточку и читать отзывы.

Публичного API для покупателей у Ozon нет, а сайт закрыт антиботом Variti. Поэтому сервер держит один headless-браузер Chromium, который проходит проверку один раз, а дальше забирает данные JSON-ом из внутреннего `composer-api` прямо со страницы. HTML не парсится — данные приходят структурированными.

## Инструменты

1. **ozon_search** — поиск товаров. Возвращает origin/currency, название, цену, старую цену, скидку, рейтинг, число отзывов, бренд, картинку и чистую ссылку. Для `ozon.ru` цены возвращаются числом в RUB; для региональных `*.ozon.com` origin валюта может быть неизвестна (`currency: null`), а price-поля — `null`, чтобы не выдавать региональные цены за рубли.
2. **ozon_product_details** — карточка товара по SKU, ссылке или slug. Цена (с картой / без карты / старая), наличие, рейтинг, продавец, фото, характеристики, описание. Для региональных `*.ozon.com` price-поля могут быть `null`, если валюта не определена надёжно.
3. **ozon_product_reviews** — отзывы покупателей: текст, оценка, плюсы, минусы, дата.

## Запуск через Docker

Образ опубликован в Docker Hub.

```bash
docker run -i --rm --init --shm-size=1g eduard256/ozon-mcp-server:latest
```

Флаги обязательны: `-i` — stdin для stdio, `--init` — корректное завершение Chromium, `--shm-size=1g` — память для браузера.

## Установка в ваш клиент

Инструкция под каждую систему — отдельным файлом:

- [Claude Code](docs/CLAUDECODE-install.md)
- [Claude Desktop](docs/CLAUDE-install.md)
- [OpenAI Codex CLI](docs/CODEX-install.md)
- [Cursor](docs/CURSOR-install.md)
- [Windsurf](docs/WINDSURF-install.md)
- [VS Code (Copilot)](docs/VSCODE-install.md)
- [Cline](docs/CLINE-install.md)
- [Continue.dev](docs/CONTINUE-install.md)
- [Zed](docs/ZED-install.md)
- [JetBrains AI Assistant](docs/JETBRAINS-install.md)
- [Junie](docs/JUNIE-install.md)
- [Gemini CLI](docs/GEMINI-install.md)

## Как это работает

- `src/browser.js` — один Chromium. Проходит антибот на главной странице и держит её открытой; все `fetch` идут с неё. При HTTP 403/307 (сессия протухла) или падении браузера перезапускается сам. Через 10 минут простоя браузер закрывается, чтобы освободить память.
- `src/parse.js` — чистые парсеры JSON из `composer-api` (`widgetStates`). Без сети.
- `src/ozon.js` — строит пути API, забирает данные, парсит.
- `src/index.js` — MCP-сервер по stdio. Логи идут только в stderr (stdout занят протоколом JSON-RPC).

**Важно:**

1. Нельзя блокировать загрузку картинок, шрифтов и стилей — антибот грузит свои скрипты через них. Заблокируешь — Ozon вернёт 403.
2. `fetch` должен идти со страницы на валидированном домене Ozon (`*.ozon.ru` или `*.ozon.com`), а не с пустой — иначе CORS и 403. По умолчанию используется `https://www.ozon.ru/`; для публичного регионального origin можно задать `OZON_HOME`, например `OZON_HOME=https://am.ozon.com/`. Значение принимается только как HTTPS origin Ozon без path/query/credentials.
3. Первый запрос платит за прохождение антибота (~12 секунд). Дальше — 0.3–1 секунда.

## Локальная разработка

```bash
npm install
npx playwright install chromium
node src/index.js          # MCP-сервер по stdio
npm run test:parse         # офлайн-тесты парсеров на samples/
```
