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

## Запуск

```bash
# .env
BOT_TOKEN=123:ABC          # токен своего бота
WEBAPP_URL=https://…       # публичный адрес мини-аппа
LISTEN=0.0.0.0:8080

python3 app.py
```

Ноль зависимостей — только стандартная библиотека Python.
Мини-апп: статика из `web/`, бэкенд — `app.py` (свой HTTP-сервер на `urllib`).

## Данные

SQLite-базы и файлы владельцев живут в `data/` и в репозиторий **не** попадают (см. `.gitignore`).

## License

MIT
