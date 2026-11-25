<div align="center">

# 💬 MoneyAPP Telegram

**Telegram Mini-App — зеркало [MoneyAPP](https://github.com/seyatel3/moneyapp)** (Android).
Dashboard, транзакции, бюджет и цели в мини-приложении.

Python (только stdlib) · vanilla HTML/CSS/JS · SQLite

[![Python](https://img.shields.io/badge/Python-3.14-3776AB?style=for-the-badge&logo=python&logoColor=white)](https://python.org)
[![Dependencies](https://img.shields.io/badge/deps-stdlib_only-4CAF50?style=for-the-badge)](#)
[![License](https://img.shields.io/badge/License-MIT-607D8B?style=for-the-badge)](#license)

> 💜 **Vibe-coded** — написано совместно с ИИ-агентом (вайбкодинг):
> локальный Qwen3.8-27B в сессиях OpenCode, без облака.

</div>

## Конфиг и запуск

Конфиг лежит в **`.env` в корне проекта** — в репозиторий он **не** попадает
(см. `.gitignore`); шаблон с комментариями — [`.env.example`](.env.example).
Сервис сам читает `.env`, лишних переменных окружения не нужно.

| Переменная | Куда пихать | Зачем |
|---|---|---|
| `BOT_TOKEN` | свой `.env` | токен бота от [@BotFather](https://t.me/BotFather) (`/newbot`): все вызовы Telegram API + HMAC-проверка `initData` — единственная авторизация API, пользователи определяются по Telegram |
| `WEBAPP_URL` | свой `.env` | публичный **HTTPS**-адрес мини-аппа; приложение само вешает его на кнопку меню бота каждому юзеру |
| `LISTEN` | свой `.env` | локальный адрес прослушивания за reverse-прокси, напр. `127.0.0.1:8100` |

> ⚠️ Токен бота — секрет: только в локальный `.env`, ни в репо, ни в чаты.
> При компрометации — `/revoke` у @BotFather, старый токен умирает.

### Запуск

```bash
# dev
python3 app.py

# production (systemd-юнит, пример)
systemctl restart moneyapp-tg
```

Ноль зависимостей — только stdlib Python. Бот (long polling) + REST API +
статика мини-аппа (`web/`) в одном процессе, свой HTTP-сервер на `urllib`.

## Данные

У каждого Telegram-пользователя — изолированная SQLite-база
`data/users/<tg_id>/db.sqlite3`. Доступ к API только через initData,
проверенный HMAC'ом от токена бота, — чужие данные не увидеть.
`data/` и `.env` в репозиторий **не** попадают (см. `.gitignore`).

## License

MIT
