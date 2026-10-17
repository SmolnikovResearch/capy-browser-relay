# capy-browser-relay

[English](README.md) | [Русский](README_RU.md)

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Go Version](https://img.shields.io/badge/Go-1.22+-00ADD8.svg)](https://go.dev)
[![Manifest](https://img.shields.io/badge/Chrome_Extension-MV3-orange.svg)](extension/manifest.json)

Локальный и сетевой мост-ретранслятор между расширением для Google Chrome (Manifest V3) и внешними ИИ-агентами. Расширение взаимодействует с ретранслятором по локальному сокету `127.0.0.1` (или по исходящему защищенному WSS-каналу на ваш сервер). ИИ-агенты вызывают браузер через стандартный протокол **Model Context Protocol (MCP)** (Streamable HTTP, заголовок `Authorization: Bearer`). 

Интерфейс спроектирован для бесшовной интеграции с **Claude Code, Codex, Antigravity, Hermes, OpenClaw и CapyAgent**.

---

## Ключевые возможности

* **Полный режим Zero-Disturbance (не мешает человеку):**
  * Вкладки агента создаются исключительно в фоновом режиме (`active: false`).
  * Звук на вкладках агента глушится автоматически при создании и на лету (`muted: true`).
  * Скрипты страницы изолированы от кражи фокуса и зависания UI: вызовы `window.alert`, `window.confirm`, `window.prompt`, `window.onbeforeunload` и `window.focus` нейтрализованы в главном контексте страницы (`world: "MAIN"`).
  * Вкладки агентов автоматически складываются в свернутые цветные группы `агент/сессия`.
  * Дочерние ссылки (`target="_blank"`) автоматически перехватываются, группируются и глушатся по `openerTabId`.
* **Мультиагентный параллелизм (Direct Lane Dispatching):**
  * Внутренний диспетчер Relay обрабатывает вызовы независимыми параллельными очередями (per-session/per-tab lanes). Несколько агентов или сессий (например, Claude Code и Codex) работают параллельно без взаимных блокировок при долгой загрузке страниц.
* **Универсальный DOM-движок:**
  * Извлечение чистого форматированного Markdown и текста с корректным рендерингом заголовков, списков и таблиц без платформенного хардкода.
  * Структурированный снимок интерактивных элементов (`snapshot`): семантические роли ARIA, доступные имена, типы полей, ссылки и точные координаты во viewport (`rect`).
  * Поддержка контролируемых форм React 16+ / Vue через сброс нативного прототипного трекера (`_valueTracker`) и дескрипторов `HTMLInputElement.prototype`.
  * Достоверная цепочка событий взаимодействия: `scrollIntoView` ➔ `pointerdown` ➔ `mousedown` ➔ `pointerup` ➔ `mouseup` ➔ `click`.
* **Эшелонированная безопасность (Defense-in-Depth):**
  * Хеширование всех токенов (SHA-256), криптографическая проверка владения устройством по ключам ECDSA P-256 при каждом подключении.
  * Двойная фильтрация доменов (на стороне Go-сервера и внутри расширения). Защита от обращения к банковским системам, почте, Госуслугам и Chrome Web Store.
  * Защита учетных данных: поля паролей (`type="password"`), одноразовых кодов (`otp`, `2fa`) и формы входа блокируют автоматический ввод и возвращают статус `needs_human`.
  * Деструктивные действия (удаление, оплата, отправка формы) требуют подтверждения пользователем на самом устройстве (`confirm.html`).

---

## Архитектура

```
[ На том же ПК ]:   Расширение Chrome ────> 127.0.0.1 Relay <──── MCP-агенты (Claude, Codex, Antigravity...)
                                                ▲
[ На другом ПК ]:  Расширение Chrome ──WSS──────┘ (исходящее защищенное соединение)
```

Реализация сервера: **Go 1.22+**, только стандартная библиотека, 0 внешних зависимостей.

---

## Быстрый старт (локальный запуск)

### 1. Сборка и запуск Relay

```bash
go build -o relay ./cmd/relay
RELAY_ADMIN_TOKEN=change-me ./relay -listen 127.0.0.1:8787 -data ./data
```

Ретранслятор работает по HTTP на loopback-интерфейсе. Привязка к внешним адресам без флага `-allow-non-loopback` запрещена. Для удаленной работы установите перед сервером reverse proxy с TLS (WSS/HTTPS). Если переменная `RELAY_ADMIN_TOKEN` не задана, одноразовый админ-токен сгенерируется автоматически при первом старте.

### 2. Инициализация (curl)

```bash
A=http://127.0.0.1:8787

# 1. Создаем аккаунт (tenant); токен владельца выдается один раз
curl -XPOST $A/admin/tenants -H 'Authorization: Bearer change-me' -d '{"name":"default"}'
# Сохраняем полученный owner_token в переменную OWNER

# 2. Получаем одноразовый 8-значный код сопряжения (действует 5 минут)
curl -XPOST $A/v1/owner/pair-codes -H "Authorization: Bearer $OWNER"

# 3. Вводим код в расширении Chrome (или проверяем тестовым эмулятором):
go run ./cmd/fakeext -relay $A -code ABCD2345 -name laptop

# 4. Выпускаем токен для ИИ-агента с нужными областями (scopes) и белым списком доменов:
curl -XPOST $A/v1/owner/agents -H "Authorization: Bearer $OWNER" \
  -d '{"name":"claude-code","scopes":["read","act"],"domains":["example.com"],"ttl_seconds":86400}'
```

Дополнительные эндпоинты:
* `GET /v1/owner/devices` — список подключенных браузеров
* `GET /v1/owner/agents` — список активных агентов
* `GET /v1/owner/audit?limit=100` — журнал действий (метаданные вызовов без секретов и содержимого страниц)
* `POST /v1/owner/kill` — аварийный отзыв всех прав и разрыв соединений
* `POST /mcp` — вызовы инструментов по протоколу MCP
* `GET /v1/device/ws` — WebSocket-канал для подключения расширения
* `GET /healthz` — проверка работоспособности

---

## Наборы инструментов MCP

* `browser_list` — список подключенных браузеров и их онлайн-статус.
* `browser_tabs_list` — список вкладок, открытых данным агентом.
* `browser_tabs_open` — открытие страницы в неактивной свернутой вкладке.
* `browser_navigate` — переход по адресу внутри существующей вкладки агента.
* `browser_read_page` — чтение страницы (режимы: `mode: "text"` — форматированный текст, `mode: "snapshot"` — снимок интерактивных элементов).
* `browser_click` — клик по элементу (`ref` или `selector`).
* `browser_type` — эмуляция ввода текста с клавиатуры.
* `browser_form_input` — быстрое заполнение поля формы.
* `browser_screenshot` — снимок видимой области вкладки (отклоняется с `not_visible`, если вкладка не активна, во избежание всплытия окон).

**Области доступа (scopes):**
* `read` — `tabs_list`, `read_page`, `screenshot`
* `act` — `tabs_open`, `navigate`, `click`, `type`, `form_input`

---

## Конфигурации для MCP-клиентов

### Claude Code

Добавление через CLI:
```bash
claude mcp add --transport http browser http://127.0.0.1:8787/mcp --header "Authorization: Bearer $AGENT_TOKEN"
```

Либо через файл проекта `.mcp.json`:
```json
{
  "mcpServers": {
    "browser": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp",
      "headers": {
        "Authorization": "Bearer <ТОКЕН_АГЕНТА>"
      }
    }
  }
}
```

### Codex

Команда CLI:
```bash
export RELAY_AGENT_TOKEN=<ТОКЕН_АГЕНТА>
codex mcp add browser --url http://127.0.0.1:8787/mcp --bearer-token-env-var RELAY_AGENT_TOKEN
```

Конфигурация в `~/.codex/config.toml`:
```toml
[mcp_servers.browser]
url = "http://127.0.0.1:8787/mcp"
bearer_token_env_var = "RELAY_AGENT_TOKEN"
```

### Hermes

Конфигурация в `~/.hermes/config.yaml`:
```yaml
mcp_servers:
  browser:
    url: "http://127.0.0.1:8787/mcp"
    headers:
      Authorization: "Bearer <ТОКЕН_АГЕНТА>"
```
Проверка подключения: `hermes mcp test browser`.

### OpenClaw

```bash
openclaw mcp set browser '{"url":"http://127.0.0.1:8787/mcp","transport":"streamable-http","headers":{"Authorization":"Bearer <ТОКЕН_АГЕНТА>"}}'
```

### CapyAgent

Файл конфигурации `~/.capyagent/config.yaml`:
```yaml
mcp_servers:
  browser:
    url: "http://127.0.0.1:8787/mcp"
    headers:
      Authorization: "Bearer <ТОКЕН_АГЕНТА>"
```

---

## Установка расширения в Chrome

1. Откройте в браузере страницу `chrome://extensions`.
2. Включите переключатель **Режим разработчика** (Developer mode) в правом верхнем углу.
3. Нажмите кнопку **Загрузить распакованное** (Load unpacked).
4. Выберите папку `extension/` из этого репозитория.
5. Нажмите на иконку расширения в панели Chrome, укажите адрес ретранслятора (по умолчанию `http://127.0.0.1:8787`), введите 8-значный код сопряжения и имя устройства (например, «Ноутбук»).

Расширение работает полностью на базе Manifest V3, не требует флага `--remote-debugging-port` и не использует опасный API `chrome.debugger` с предупреждающими плашками.

---

## Тестирование

### Тесты Go-сервера (с детектором гонок):
```bash
go vet ./... && go test -race ./...
```
Включает 32 сквозных модульных теста: привязка устройств, лимиты перебора, изоляция сессий, параллельная обработка дорожек (lane concurrency), проверка доменных политик и защита от кражи токенов.

### Тесты расширения Chrome:
```bash
cd extension && npm test
```
Включает 38 модульных и интеграционных тестов Node.js 22: детекторы опасных действий, симуляция React-ввода, проверка нейтрализаторов `window.alert` / `window.focus`, валидация доменных фильтров.

### Сквозной тест с реальным Chrome:
```bash
node e2e/live-chrome.mjs --chrome "/path/to/chrome" --relay ./relay --ext ./extension --work ./tmp-work
```

---

## Лицензия

Проект распространяется под открытой лицензией **Apache License, Version 2.0**. Подробности в файле [LICENSE](LICENSE).
