#!/usr/bin/env python3
"""MoneyApp Telegram mini-app: bot + API + static web server.

Multi-user: every Telegram user gets an isolated, E2E-ENCRYPTED store
(data/users/<user_id>/blob.json). All business logic runs in the browser
(web/logic.js); the user's data is encrypted client-side (AES-GCM under a
random 32 B master key wrapped with PBKDF2(PIN)) and the server only keeps
the opaque blob — it cannot read anyone's data. Access to the API is
authorized ONLY by Telegram WebApp initData (HMAC-SHA256 verified against
the bot token), so a user can never read another user's blob.

The legacy per-user SQLite databases (data/users/<uid>/db.sqlite3) stay
around as a read-only migration source (GET /api/legacy); after a user
migrates, the DB is renamed to db.sqlite3.bak-<ts> (30-day undo window) and
migrated.json marks the switch. The old /api/* computation endpoints remain
for the bot's /stats fallback and pre-migration users.

Stdlib only (Python 3.12+). Data model mirrors the Android app:
amounts in kopecks (positive int), dates as epoch days.
"""
import base64
import calendar
import hashlib
import hmac
import json
import os
import re
import shutil
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(BASE, "web")
DATA_DIR = os.path.join(BASE, "data")
USERS_DIR = os.path.join(DATA_DIR, "users")
OWNER_FILE = os.path.join(DATA_DIR, "owner.json")
TG_API = "https://api.telegram.org"
INIT_DATA_MAX_AGE = 24 * 3600  # initData auth_date freshness window, seconds
RATE_LIMIT_PER_MIN = 60        # per IP, all API endpoints
MAX_BODY = 8 * 1024 * 1024
# Bump on every web/ deploy. Served at GET /api/version (no auth); the mini-app
# shows a reload banner when its own embedded version differs (static files
# are cached with max-age=300).
WEB_VERSION = 13

# ---------------------------------------------------------------- config ---
def load_env():
    env = {}
    p = os.path.join(BASE, ".env")
    if os.path.exists(p):
        for line in open(p):
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env

ENV = load_env()
BOT_TOKEN = os.environ.get("BOT_TOKEN", ENV.get("BOT_TOKEN", ""))
WEBAPP_URL = ENV.get("WEBAPP_URL", "https://mvahome.mynewapp.space/")
LISTEN = ENV.get("LISTEN", "127.0.0.1:8100")
HOST, PORT = LISTEN.rsplit(":", 1)
PORT = int(PORT)

MONTHS_FULL = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
               "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"]
MONTHS_SHORT = ["Янв", "Фев", "Мар", "Апр", "Май", "Июн",
                "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек"]

# E2E (v1.11.10): privacy notes in words a regular user understands —
# the server owner cannot read the user's data. Shared by /start, /help
# and the migrated /stats.
E2E_NOTE_BOT = (
    "🔒 Твоя приватность: все твои финансы шифруются прямо в мини-приложении "
    "на твоём телефоне. На сервере хранится только зашифрованный набор данных, "
    "а ключ создаётся из твоего ПИН-кода и никуда не отправляется — не на "
    "сервер и не в Telegram. Поэтому даже я, владелец сервера, не могу "
    "прочитать твои данные. Их видишь только ты.")
E2E_NOTE_LONG = (
    "🔒 Твоя приватность (сквозное шифрование):\n"
    "Деньги, операции, бюджеты и цели шифруются прямо в мини-приложении на "
    "твоём телефоне. На сервере лежит только зашифрованный набор данных — "
    "без ключа это нечитаемая строка. Ключ создаётся из твоего ПИН-кода и "
    "никуда не отправляется: ни на сервер, ни в Telegram. Поэтому даже я — "
    "владелец сервера — не могу прочитать твои данные. Их видишь только ты.\n\n"
    "Расшифровать данные могут только твой ПИН-код и фраза из 24 слов, "
    "которую ты сохраняешь при первом запуске. При первом запуске она показана "
    "на русском и английском — это одна и та же фраза, при восстановлении "
    "ввести можно на любом языке. Если забудешь и то, и другое, восстановить "
    "данные будет невозможно — сохрани фразу в надёжном месте.")
E2E_STATS = (
    "🔒 Твои данные защищены сквозным шифрованием (E2E): сервер хранит только "
    "зашифрованную копию, а ключ создаётся из твоего ПИН-кода и никуда не "
    "отправляется — даже владелец сервера не может прочитать твои данные.\n\n"
    "Открой мини-приложение — остаток и все отчёты там:")

def today_epoch():
    return (date.today() - date(1970, 1, 1)).days

def epoch_day(d):
    return (d - date(1970, 1, 1)).days

def month_range(year, month):
    start = date(year, month, 1)
    if month == 12:
        end = date(year + 1, 1, 1)
    else:
        end = date(year, month + 1, 1)
    return epoch_day(start), epoch_day(end)

def year_range(year):
    return epoch_day(date(year, 1, 1)), epoch_day(date(year + 1, 1, 1))

# ------------------------------------------------------------- per-user DB --
SCHEMA = """
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  date INTEGER NOT NULL,
  type TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  amountKopecks INTEGER NOT NULL,
  paymentMethod TEXT NOT NULL DEFAULT 'CARD',
  tag TEXT,
  note TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_tx_type ON transactions(type);
CREATE INDEX IF NOT EXISTS idx_tx_cat ON transactions(category);
CREATE TABLE IF NOT EXISTS categories (
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '',
  icon TEXT,
  isVisible INTEGER NOT NULL DEFAULT 1,
  sortOrder INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (name, type)
);
CREATE TABLE IF NOT EXISTS budget_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  month INTEGER NOT NULL,
  year INTEGER NOT NULL,
  category TEXT NOT NULL,
  type TEXT NOT NULL,
  plannedAmountKopecks INTEGER NOT NULL,
  UNIQUE (month, year, category, type)
);
CREATE TABLE IF NOT EXISTS budget_templates (
  category TEXT NOT NULL,
  type TEXT NOT NULL,
  amountKopecks INTEGER NOT NULL,
  PRIMARY KEY (category, type)
);
CREATE TABLE IF NOT EXISTS savings_goals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  targetAmountKopecks INTEGER NOT NULL,
  deadline INTEGER NOT NULL,
  createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
"""

SEED_CATEGORIES = [
    ("Зарплата", "INCOME", "💼", 1), ("Переработки", "INCOME", "💼", 2),
    ("Премия", "INCOME", "💼", 3), ("Прочий доход", "INCOME", "💼", 4),
    ("Прочее", "INCOME", "💼", 5),
    ("Инвестиции", "SAVINGS", "📈", 1),
    ("Продукты", "EXPENSE", "🛒", 1), ("Ипотека/Аренда", "EXPENSE", "🏠", 2),
    ("ЖКХ", "EXPENSE", "🏠", 3), ("Транспорт", "EXPENSE", "🚌", 4),
    ("Рестораны", "EXPENSE", "🍕", 5), ("Здоровье", "EXPENSE", "❤️", 6),
    ("Одежда", "EXPENSE", "👗", 7), ("Подписки", "EXPENSE", "📱", 8),
    ("Спорт", "EXPENSE", "💪", 9), ("Образование", "EXPENSE", "📚", 10),
    ("Подарки", "EXPENSE", "🎁", 11), ("Развлечения", "EXPENSE", "🎉", 12),
    ("Связь", "EXPENSE", "📱", 13), ("Услуги", "EXPENSE", "🔧", 14),
    ("Маркетплейсы", "EXPENSE", "🛍️", 15), ("Вредные привычки", "EXPENSE", "🚬", 16),
    ("Прочее", "EXPENSE", "📦", 17),
]

DEFAULT_SETTINGS = {
    "username": "",
    "currencySymbol": "₽",
    "themeMode": "system",
    "monthlyCapKopecks": 0,
    "capLinkedIncome": False,
    "capIncomePct": 30,
    "budgetCopyPrevMonth": False,
}

# v1.11.0: icon keys stored in categories.icon. Must match the Android
# CategoryIconPalette keys (Theme.kt) so both apps render the same glyph.
ICON_KEYS = {
    "wallet", "money", "coins", "card", "cash", "bill", "savings", "percent",
    "trend-up", "atms", "account", "briefcase", "gift", "cart", "bag", "store",
    "home", "apartment", "bolt", "bulb", "car", "bus", "bike", "moto", "plane",
    "gas", "restaurant", "food", "coffee", "breakfast", "pizza", "icecream",
    "bar", "hospital", "pharmacy", "heart", "medicine", "shirt", "style",
    "subscriptions", "phone", "devices", "wifi", "fitness", "esports", "pool",
    "school", "book", "toy", "theater", "games", "tools", "cleaning", "laundry",
    "smokefree", "pets", "category", "label", "star", "mood",
}

def _clean_icon(value):
    """Normalize a category icon key: known key, or None (automatic)."""
    if value is None:
        return None
    v = str(value).strip()
    if not v:
        return None
    return v if v in ICON_KEYS else None

def ensure_user_db(user_id):
    """Create the per-user database with seed categories. Idempotent."""
    d = os.path.join(USERS_DIR, str(user_id))
    created = False
    if not os.path.exists(os.path.join(d, "db.sqlite3")):
        os.makedirs(d, exist_ok=True)
        created = True
    db = sqlite3.connect(os.path.join(d, "db.sqlite3"), timeout=10)
    try:
        db.executescript(SCHEMA)
        if created:
            now = int(time.time() * 1000)
            db.executemany(
                "INSERT OR IGNORE INTO categories(name,type,emoji,icon,sortOrder) "
                "VALUES(?,?,?,NULL,?)", SEED_CATEGORIES)
            db.executemany("INSERT OR IGNORE INTO settings(k,v) VALUES(?,?)",
                           [(k, str(v)) for k, v in DEFAULT_SETTINGS.items()])
            db.commit()
    finally:
        db.close()
    return created

def open_user_db(user_id):
    return sqlite3.connect(os.path.join(USERS_DIR, str(user_id), "db.sqlite3"),
                           timeout=10)

def get_settings(db):
    s = dict(DEFAULT_SETTINGS)
    for k, v in db.execute("SELECT k,v FROM settings"):
        if k == "monthlyCapKopecks":
            s[k] = int(float(v))
        elif k in ("capLinkedIncome", "budgetCopyPrevMonth"):
            s[k] = v in ("1", "true", "True")
        elif k == "capIncomePct":
            s[k] = float(v)
        else:
            s[k] = v
    return s

def set_settings(db, keys):
    for k in keys:
        v = keys[k]
        if isinstance(v, bool):
            v = "1" if v else "0"
        db.execute("INSERT INTO settings(k,v) VALUES(?,?) "
                   "ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, str(v)))
    db.commit()

# ------------------------------------------------------- SQL helpers --------
TOT = ("COALESCE(SUM(CASE WHEN type='INCOME' THEN amountKopecks ELSE 0 END),0), "
       "COALESCE(SUM(CASE WHEN type='EXPENSE' THEN amountKopecks ELSE 0 END),0), "
       "COALESCE(SUM(CASE WHEN type='SAVINGS' THEN amountKopecks ELSE 0 END),0), "
       "COALESCE(SUM(CASE WHEN type='SAVINGS_SPEND' THEN amountKopecks ELSE 0 END),0)")

def totals_between(db, start, end):
    r = db.execute(f"SELECT {TOT} FROM transactions WHERE date>=? AND date<?",
                   (start, end)).fetchone()
    return {"income": r[0], "expenses": r[1], "savings": r[2], "savings_spend": r[3]}

def totals_before(db, end):
    r = db.execute(f"SELECT {TOT} FROM transactions WHERE date<?", (end,)).fetchone()
    return {"income": r[0], "expenses": r[1], "savings": r[2], "savings_spend": r[3]}

def tx_row_to_dict(r):
    return {
        "id": r[0], "date": r[1], "type": r[2], "category": r[3],
        "description": r[4], "amountKopecks": r[5], "paymentMethod": r[6],
        "tag": r[7], "note": r[8], "createdAt": r[9], "updatedAt": r[10],
    }

TX_COLS = "id,date,type,category,description,amountKopecks,paymentMethod,tag,note,createdAt,updatedAt"

def cap_state(db, settings, year, month):
    """Returns (state, info) — mirrors Android BudgetService.capState:
    income part only when linked AND pct > 0 AND the month has income;
    cap = min(fixed, income part) / income part / fixed / 0;
    Ready when cap > 0, then the linked+pct>0 branch falls back to the
    median of the year's monthly incomes (only months with income > 0
    count), else AwaitingIncome; anything else is Disabled.
    """
    fixed = int(settings.get("monthlyCapKopecks") or 0)
    linked = bool(settings.get("capLinkedIncome"))
    pct = float(settings.get("capIncomePct") or 0)
    start, end = month_range(year, month)
    m = totals_between(db, start, end)
    # v1.11.6: spending from the piggy bank also eats the monthly cap
    spent = m["expenses"] + m["savings_spend"]
    income = m["income"]
    income_part = int(income * pct / 100.0) if (linked and pct > 0 and income > 0) else None
    if income_part is not None and fixed > 0:
        cap = min(fixed, income_part)
    elif income_part is not None:
        cap = income_part
    elif fixed > 0:
        cap = fixed
    else:
        cap = 0
    if cap > 0:
        if spent > cap * 1.1:
            st = "OVER"
        elif spent >= cap * 0.9:
            st = "CLOSE"
        else:
            st = "OK"
        return "Ready", {"capKopecks": cap, "spentKopecks": spent,
                         "percentage": round(spent * 100.0 / cap, 1) if cap else 0.0,
                         "status": st}
    if linked and pct > 0:
        # no income this month -> median of the year's monthly incomes
        # (only months with income > 0 count, like Android)
        y0, y1 = year_range(year)
        vals = []
        for mm in range(1, 13):
            s0, s1 = month_range(year, mm)
            if s0 < y0 or s1 > y1:
                continue
            inc = totals_between(db, s0, s1)["income"]
            if inc > 0:
                vals.append(inc)
        vals.sort()
        n = len(vals)
        median = (vals[n // 2] if n % 2 else (vals[n // 2 - 1] + vals[n // 2]) // 2) if n else 0
        if median > 0:
            part = int(median * pct / 100.0)
            median_cap = min(fixed, part) if fixed > 0 else part
        else:
            median_cap = 0
        if median_cap > 0:
            return "MedianBased", {"capKopecks": median_cap, "spentKopecks": spent,
                                   "pct": pct, "medianIncomeKopecks": median}
        return "AwaitingIncome", {"pct": pct, "spentKopecks": spent}
    return "Disabled", None

# ------------------------------------------------- Telegram initData auth ---
# Two schemes (clients differ by version):
#  * classic: hash = HMAC-SHA256(secret, data_check_string), secret =
#    HMAC-SHA256(bot_token, "WebAppData"), dcs = sorted k=v lines excl. hash.
#  * new: extra `signature` field = base64url(Ed25519 signature made by
#    Telegram) over "<bot_id>:WebAppData\n" + sorted k=v lines excl. hash AND
#    signature; verified against Telegram's production public key
#    (third-party verification, core.telegram.org/bots/webapps).
# If `signature` is present only the Ed25519 path is used (it covers the whole
# payload incl. the user field); otherwise the classic HMAC path.

# --- Ed25519 (pure Python, extended coords, complete RFC 8032 addition) ---
_ED_P = 2 ** 255 - 19
_ED_L = 2 ** 252 + 27742317777372353535851937790883648493
_ED_D = (-121665 * pow(121666, _ED_P - 2, _ED_P)) % _ED_P
_ED_BY = 4 * pow(5, _ED_P - 2, _ED_P) % _ED_P
_ED_BX = 15112221349535400772501151409588531511454012693041857206046113283949847762202
_ED_IDENT = (0, 1, 1, 0)
_ED_B = (_ED_BX, _ED_BY, 1, _ED_BX * _ED_BY % _ED_P)

def _ed_decode(s):
    """32-byte LE y + x parity -> (X, Y, Z, T) or None."""
    y = int.from_bytes(s, "little")
    sign = y >> 255
    y &= (1 << 255) - 1
    if y >= _ED_P:
        return None
    y2 = y * y % _ED_P
    xx = (y2 - 1) * pow(_ED_D * y2 + 1, _ED_P - 2, _ED_P) % _ED_P
    if xx == 0:
        if sign:
            return None
        x = 0
    else:
        x = pow(xx, (_ED_P + 3) // 8, _ED_P)
        if (x * x - xx) % _ED_P != 0:
            x = x * pow(2, (_ED_P - 1) // 4, _ED_P) % _ED_P
        if (x * x - xx) % _ED_P != 0:
            return None
        if (x & 1) != sign:
            x = _ED_P - x
    return (x, y, 1, x * y % _ED_P)

def _ed_add(p1, p2):
    A = (p1[1] - p1[0]) * (p2[1] - p2[0]) % _ED_P
    B = (p1[1] + p1[0]) * (p2[1] + p2[0]) % _ED_P
    C = 2 * p1[3] * p2[3] * _ED_D % _ED_P
    D = 2 * p1[2] * p2[2] % _ED_P
    E, F, G, H = B - A, D - C, D + C, B + A
    return (E * F % _ED_P, G * H % _ED_P, F * G % _ED_P, E * H % _ED_P)

def _ed_mul(pt, n):
    acc = _ED_IDENT
    addend = pt
    while n:
        if n & 1:
            acc = _ed_add(acc, addend)
        addend = _ed_add(addend, addend)
        n >>= 1
    return acc

def _ed_eq(p1, p2):
    return (p1[0] * p2[2] - p2[0] * p1[2]) % _ED_P == 0 and \
           (p1[1] * p2[2] - p2[1] * p1[2]) % _ED_P == 0

def _ed_on_curve(pt):
    X, Y, Z, T = pt
    return (Y * Y - X * X) % _ED_P == (Z * Z + _ED_D * X * X * Y * Y) % _ED_P and \
           X * Y % _ED_P == T * Z % _ED_P

def ed25519_verify(pub, msg, sig):
    """Verify Ed25519 signature sig = R(32)||S(32) over msg with 32-byte pub."""
    if len(sig) != 64 or len(pub) != 32:
        return False
    A = _ed_decode(pub)
    R = _ed_decode(sig[:32])
    s = int.from_bytes(sig[32:], "little")
    if A is None or R is None or not _ed_on_curve(A) or not _ed_on_curve(R):
        return False
    if s >= _ED_L:
        return False
    if not _ed_eq(_ed_mul(A, _ED_L), _ED_IDENT):  # prime-order subgroup check
        return False
    h = int.from_bytes(hashlib.sha512(sig[:32] + pub + msg).digest(), "little") % _ED_L
    return _ed_eq(_ed_mul(_ED_B, s), _ed_add(R, _ed_mul(A, h)))

# Telegram's production Ed25519 public key (third-party initData verification)
TG_ED25519_PROD_KEY = bytes.fromhex(
    "e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d")
BOT_ID = BOT_TOKEN.split(":")[0]

def _verify_init_data_legacy(params):
    """Classic scheme: hash = HMAC-SHA256 over sorted k=v lines excl. hash."""
    if "hash" not in params:
        return False
    dcs = "\n".join(f"{k}={params[k][0]}" for k in sorted(params) if k != "hash")
    secret_key = hmac.new(BOT_TOKEN.encode(), b"WebAppData", hashlib.sha256).digest()
    digest = hmac.new(secret_key, dcs.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(digest, params["hash"][0])

def _verify_init_data_signature(params):
    """New scheme: Ed25519 signature over '<bot_id>:WebAppData\\n' + k=v lines
    excluding hash and signature, made by Telegram (production key)."""
    s64 = params["signature"][0] + "=" * (-len(params["signature"][0]) % 4)
    try:
        sig = base64.urlsafe_b64decode(s64)
    except Exception:
        return False
    dcs = (f"{BOT_ID}:WebAppData\n" + "\n".join(
        f"{k}={params[k][0]}" for k in sorted(params)
        if k not in ("hash", "signature"))).encode()
    return ed25519_verify(TG_ED25519_PROD_KEY, dcs, sig)

def verify_init_data(init_data):
    """Telegram WebApp initData verification. Returns user dict or None.
    Accepts both the classic HMAC hash and the new Ed25519 `signature`."""
    try:
        params = urllib.parse.parse_qs(init_data or "", keep_blank_values=True)
        if "user" not in params:
            return None
        if "auth_date" in params:
            auth_date = int(params["auth_date"][0])
            if abs(time.time() - auth_date) > INIT_DATA_MAX_AGE:
                return None
        if "signature" in params:
            if not _verify_init_data_signature(params):
                return None
        elif not _verify_init_data_legacy(params):
            return None
        return json.loads(params["user"][0])
    except Exception:
        return None

# ------------------------------------------------------------ owner id -----
_owner_lock = threading.Lock()

def get_owner_id():
    if os.path.exists(OWNER_FILE):
        try:
            return json.load(open(OWNER_FILE)).get("owner_user_id")
        except Exception:
            return None
    return None

def set_owner_if_empty(user_id):
    with _owner_lock:
        if get_owner_id() is None:
            os.makedirs(DATA_DIR, exist_ok=True)
            json.dump({"owner_user_id": int(user_id), "set_at": int(time.time())},
                      open(OWNER_FILE, "w"))
            return True
    return False

SEED_FILE = os.path.join(DATA_DIR, "pending_seed.json")
OWNER_RESTORE = os.path.join(DATA_DIR, "owner_restore.json")


def seed_owner_db(user_id, backup):
    """One-time restore of the owner's data: upsert transactions, then make
    the category set exactly match the backup (drops seed defaults)."""
    ensure_user_db(user_id)
    a = Api(user_id)
    try:
        r = a.import_backup(backup)
        bk_cats = [c for c in (backup.get("categories") or [])
                   if c.get("name") and c.get("type")]
        for c in bk_cats:
            a.db.execute("DELETE FROM categories WHERE name=? AND type=?",
                         (c["name"], c["type"]))
            a.db.execute(
                "INSERT INTO categories(name,type,emoji,icon,isVisible,sortOrder) "
                "VALUES(?,?,?,?,?,?)",
                (c["name"], c["type"], c.get("emoji", ""), c.get("icon"),
                 1 if c.get("isVisible", 1) else 0, int(c.get("sortOrder", 0))))
        for row in a.db.execute("SELECT name, type FROM categories").fetchall():
            if not any(c["name"] == row[0] and c["type"] == row[1] for c in bk_cats):
                a.db.execute("DELETE FROM categories WHERE name=? AND type=?", row)
        a.db.commit()
    finally:
        a.close()
    return r

# ------------------------------------------------------------ API handlers --
class Api:
    def __init__(self, user_id):
        self.uid = int(user_id)
        self.db = open_user_db(self.uid)
        self.db.row_factory = sqlite3.Row

    def close(self):
        self.db.close()

    def settings(self):
        return get_settings(self.db)

    # ---- bootstrap
    def bootstrap(self):
        s = self.settings()
        cats = [dict(r) for r in self.db.execute(
            "SELECT name,type,emoji,icon,isVisible,sortOrder FROM categories "
            "ORDER BY type, sortOrder, name")]
        return {"ok": True, "settings": s, "categories": cats}

    # ---- summary / dashboard
    def summary(self, q):
        start = int(q.get("start", [0])[0])
        end = int(q.get("end", [0])[0])
        before = totals_before(self.db, start)
        period = totals_between(self.db, start, end)
        balance = (before["income"] - before["expenses"] - before["savings"]) + \
                  (period["income"] - period["expenses"] - period["savings"])
        rate = (period["savings"] / period["income"] * 100.0) if period["income"] > 0 else 0.0
        mode = q.get("mode", ["month"])[0]
        state, info = "Disabled", None
        if mode == "month":
            y, m = int(q.get("year", [0])[0]), int(q.get("month", [0])[0])
            state, info = cap_state(self.db, self.settings(), y, m)
        breakdown = []
        rows = self.db.execute(
            "SELECT category, SUM(amountKopecks) AS t FROM transactions "
            "WHERE type IN ('EXPENSE','SAVINGS_SPEND') AND date>=? AND date<? "
            "GROUP BY category ORDER BY t DESC",
            (start, end)).fetchall()
        total_exp = sum(r["t"] for r in rows)
        for r in rows:
            breakdown.append({"category": r["category"], "amountKopecks": r["t"],
                              "percent": round(r["t"] * 100.0 / total_exp, 1) if total_exp else 0.0})
        return {"ok": True, "balanceKopecks": balance,
                "period": period, "before": before, "savingsRate": round(rate, 1),
                # v1.11.6: the piggy KPI is the NET of SAVINGS_SPEND
                "savingsNetKopecks": period["savings"] - period["savings_spend"],
                "cap": {"state": state, "info": info}, "categoryBreakdown": breakdown}

    # ---- transactions
    def list_tx(self, q):
        where, args = [], []
        if q.get("type"):
            where.append("type=?"); args.append(q["type"][0])
        if q.get("category"):
            where.append("category=?"); args.append(q["category"][0])
        if q.get("payment"):
            where.append("paymentMethod=?"); args.append(q["payment"][0])
        if q.get("q"):
            where.append("description LIKE ?"); args.append("%" + q["q"][0] + "%")
        if q.get("start"):
            where.append("date>=?"); args.append(int(q["start"][0]))
        if q.get("end"):
            where.append("date<=?"); args.append(int(q["end"][0]))
        sql = f"SELECT {TX_COLS} FROM transactions"
        if where:
            sql += " WHERE " + " AND ".join(where)
        # rowid DESC pins the (date, createdAt) tie order (imported rows can
        # share timestamps): it reproduces SQLite's actual DESC output and
        # mirrors web/logic.js listTx (index DESC) after E2E migration.
        sql += " ORDER BY date DESC, createdAt DESC, rowid DESC LIMIT 2000"
        return {"ok": True, "transactions": [tx_row_to_dict(r) for r in
                                             self.db.execute(sql, args).fetchall()]}

    def add_tx(self, body):
        self._validate_tx(body, require_id=False)
        now = int(time.time() * 1000)
        tx = {
            "id": str(uuid.uuid4()),
            "date": int(body["date"]),
            "type": body["type"],
            "category": body.get("category", ""),
            "description": body.get("description", ""),
            "amountKopecks": int(body["amountKopecks"]),
            "paymentMethod": body.get("paymentMethod", "CARD"),
            "tag": body.get("tag"),
            "note": body.get("note"),
            "createdAt": now,
            "updatedAt": now,
        }
        self.db.execute(
            "INSERT INTO transactions VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (tx["id"], tx["date"], tx["type"], tx["category"], tx["description"],
             tx["amountKopecks"], tx["paymentMethod"], tx["tag"], tx["note"],
             tx["createdAt"], tx["updatedAt"]))
        self.db.commit()
        return {"ok": True, "transaction": tx}

    def _validate_tx(self, body, require_id, txid=None):
        if body.get("type") not in ("INCOME", "EXPENSE", "SAVINGS", "SAVINGS_SPEND"):
            raise HttpError(400, "type must be INCOME/EXPENSE/SAVINGS/SAVINGS_SPEND")
        if not isinstance(body.get("amountKopecks"), int) or body["amountKopecks"] <= 0:
            raise HttpError(400, "amountKopecks must be positive int")
        if require_id:
            if not self.db.execute("SELECT 1 FROM transactions WHERE id=?",
                                   (txid,)).fetchone():
                raise HttpError(404, "not found")

    def update_tx(self, txid, body):
        self._validate_tx(body, require_id=True, txid=txid)
        cur = self.db.execute(
            "UPDATE transactions SET date=?,type=?,category=?,description=?,amountKopecks=?,"
            "paymentMethod=?,tag=?,note=?,updatedAt=? WHERE id=?",
            (int(body["date"]), body["type"], body.get("category", ""),
             body.get("description", ""), int(body["amountKopecks"]),
             body.get("paymentMethod", "CARD"), body.get("tag"), body.get("note"),
             int(time.time() * 1000), txid))
        self.db.commit()
        if cur.rowcount == 0:
            raise HttpError(404, "not found")
        return self.list_tx({})

    def delete_tx(self, txid):
        cur = self.db.execute("DELETE FROM transactions WHERE id=?", (txid,))
        self.db.commit()
        return {"ok": True, "deleted": cur.rowcount > 0}

    # ---- categories
    def list_cats(self):
        rows = [dict(r) for r in self.db.execute(
            "SELECT name,type,emoji,icon,isVisible,sortOrder FROM categories "
            "ORDER BY type, sortOrder, name")]
        return {"ok": True, "categories": rows}

    def add_cat(self, body):
        name = (body.get("name") or "").strip()
        ctype = body.get("type")
        if not name or ctype not in ("INCOME", "EXPENSE", "SAVINGS"):
            raise HttpError(400, "name and type required")
        if self.db.execute("SELECT 1 FROM categories WHERE name=? AND type=?",
                           (name, ctype)).fetchone():
            raise HttpError(409, "duplicate")
        emoji = {"INCOME": "💼", "EXPENSE": "📦", "SAVINGS": "📈"}[ctype]
        icon = _clean_icon(body.get("icon"))
        mx = self.db.execute("SELECT MAX(sortOrder) FROM categories WHERE type=?",
                             (ctype,)).fetchone()[0] or 0
        self.db.execute(
            "INSERT INTO categories(name,type,emoji,icon,isVisible,sortOrder) "
            "VALUES(?,?,?,?,1,?)", (name, ctype, emoji, icon, mx + 1))
        self.db.commit()
        return self.list_cats()

    def update_cat(self, q, body):
        old_name, old_type = q.get("name", [""])[0], q.get("type", [""])[0]
        new_name = (body.get("name") or old_name).strip()
        new_type = body.get("type", old_type)
        if not new_name or new_type not in ("INCOME", "EXPENSE", "SAVINGS"):
            raise HttpError(400, "bad request")
        if self.db.execute("SELECT 1 FROM categories WHERE name=? AND type=? AND "
                           "(name<>? OR type<>?)", (new_name, new_type, old_name, old_type)).fetchone():
            raise HttpError(409, "duplicate")
        if "icon" in body:
            icon = _clean_icon(body.get("icon"))
        else:
            row = self.db.execute("SELECT icon FROM categories WHERE name=? AND type=?",
                                   (old_name, old_type)).fetchone()
            icon = row[0] if row else None
        visible = 1 if body.get("visible", True) else 0
        self.db.execute(
            "UPDATE categories SET name=?,type=?,icon=?,isVisible=? WHERE name=? AND type=?",
            (new_name, new_type, icon, visible, old_name, old_type))
        # propagate rename to transactions (type-scoped, like Android)
        if (new_name, new_type) != (old_name, old_type):
            self.db.execute(
                "UPDATE transactions SET category=? WHERE category=? AND type=?",
                (new_name, old_name, old_type))
            self.db.execute(
                "UPDATE budget_plans SET category=? WHERE category=? AND type=?",
                (new_name, old_name, old_type))
        self.db.commit()
        return self.list_cats()

    def delete_cat(self, q):
        cur = self.db.execute("DELETE FROM categories WHERE name=? AND type=?",
                              (q.get("name", [""])[0], q.get("type", [""])[0]))
        self.db.commit()
        return {"ok": True, "deleted": cur.rowcount > 0}

    # ---- goals
    def list_goals(self):
        today = today_epoch()
        out = []
        for g in self.db.execute("SELECT * FROM savings_goals ORDER BY createdAt, rowid"):
            cur_sum = self.db.execute(
                "SELECT COALESCE(SUM(amountKopecks),0) FROM transactions "
                "WHERE type='SAVINGS' AND category=?", (g["name"],)).fetchone()[0]
            remaining = g["targetAmountKopecks"] - cur_sum
            if cur_sum >= g["targetAmountKopecks"]:
                status = "COMPLETED"
            elif g["deadline"] < today:
                status = "OVERDUE"
            else:
                status = "IN_PROGRESS"
            days_left = max(1, g["deadline"] - today)
            recommended = remaining // (max(1, days_left // 30 + (1 if days_left % 30 else 0))) \
                if status == "IN_PROGRESS" and remaining > 0 else 0
            out.append({**dict(g), "currentKopecks": cur_sum, "status": status,
                        "recommendedMonthlyKopecks": recommended})
        return {"ok": True, "goals": out}

    def add_goal(self, body):
        if not (body.get("name") or "").strip() or int(body.get("targetAmountKopecks", 0)) <= 0:
            raise HttpError(400, "name and targetAmountKopecks required")
        g = {"id": str(uuid.uuid4()), "name": body["name"].strip(),
             "description": body.get("description", ""),
             "targetAmountKopecks": int(body["targetAmountKopecks"]),
             "deadline": int(body["deadline"]),
             "createdAt": int(time.time() * 1000)}
        self.db.execute("INSERT INTO savings_goals VALUES(?,?,?,?,?,?)",
                        (g["id"], g["name"], g["description"],
                         g["targetAmountKopecks"], g["deadline"], g["createdAt"]))
        self.db.commit()
        return {"ok": True, "goal": g}

    def update_goal(self, gid, body):
        if not self.db.execute("SELECT 1 FROM savings_goals WHERE id=?", (gid,)).fetchone():
            raise HttpError(404, "not found")
        fields, args = [], []
        for k in ("name", "description", "targetAmountKopecks", "deadline"):
            if k in body:
                fields.append(f"{k}=?")
                args.append(body[k])
        if fields:
            args.append(gid)
            self.db.execute(f"UPDATE savings_goals SET {', '.join(fields)} WHERE id=?", args)
            self.db.commit()
        return {"ok": True}

    def delete_goal(self, gid):
        cur = self.db.execute("DELETE FROM savings_goals WHERE id=?", (gid,))
        self.db.commit()
        return {"ok": True, "deleted": cur.rowcount > 0}

    def contribute(self, gid, body):
        g = self.db.execute("SELECT * FROM savings_goals WHERE id=?", (gid,)).fetchone()
        if not g:
            raise HttpError(404, "not found")
        amt = int(body.get("amountKopecks", 0))
        if amt <= 0:
            raise HttpError(400, "amount required")
        now = int(time.time() * 1000)
        tx = {"id": str(uuid.uuid4()), "date": today_epoch(), "type": "SAVINGS",
              "category": g["name"], "description": "Взнос в цель",
              "amountKopecks": amt, "paymentMethod": "CARD", "tag": None,
              "note": f"Цель: {gid}", "createdAt": now, "updatedAt": now}
        self.db.execute("INSERT INTO transactions VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                        (tx["id"], tx["date"], tx["type"], tx["category"],
                         tx["description"], tx["amountKopecks"], tx["paymentMethod"],
                         tx["tag"], tx["note"], tx["createdAt"], tx["updatedAt"]))
        self.db.commit()
        return {"ok": True, "transaction": tx}

    # ---- budget
    def budget(self, q):
        year, month = int(q.get("year", [0])[0]), int(q.get("month", [0])[0])
        state, info = cap_state(self.db, self.settings(), year, month)
        start, end = month_range(year, month)
        # Effective plans — same priority as Android BudgetService.effectivePlans:
        # explicit plan for the month > template > copy of the previous month
        # > nothing. SUMMARY is never resolved.
        s = self.settings()
        prev_year, prev_month = (year - 1, 12) if month == 1 else (year, month - 1)
        eff = {}  # (category, type) -> (plannedKopecks, source)
        if s.get("budgetCopyPrevMonth"):
            for p in self.db.execute(
                    "SELECT category,type,plannedAmountKopecks FROM budget_plans "
                    "WHERE year=? AND month=? AND type!='SUMMARY'",
                    (prev_year, prev_month)):
                eff[(p["category"], p["type"])] = (p["plannedAmountKopecks"], "prev")
        for t in self.db.execute(
                "SELECT category,type,amountKopecks FROM budget_templates "
                "WHERE type!='SUMMARY'"):
            eff[(t["category"], t["type"])] = (t["amountKopecks"], "template")
        for p in self.db.execute(
                "SELECT category,type,plannedAmountKopecks FROM budget_plans "
                "WHERE year=? AND month=? AND type!='SUMMARY'", (year, month)):
            eff[(p["category"], p["type"])] = (p["plannedAmountKopecks"], "explicit")
        plans = []
        for (cat, typ), (planned, source) in sorted(
                eff.items(), key=lambda kv: (kv[0][1], kv[0][0])):
            actual = self.db.execute(
                # v1.11.6: EXPENSE plan actuals also count SAVINGS_SPEND
                # (parity with Android getActualExpensesByCategory).
                "SELECT COALESCE(SUM(amountKopecks),0) FROM transactions "
                + ("WHERE type IN ('EXPENSE','SAVINGS_SPEND') " if typ == "EXPENSE"
                   else "WHERE type=? ")
                + "AND category=? AND date>=? AND date<?",
                (typ, cat, start, end) if typ != "EXPENSE" else (cat, start, end)).fetchone()[0]
            pct = (actual * 100.0 / planned) if planned > 0 else 0.0
            if pct > 110:
                st = "OVER"
            elif pct > 90:
                st = "CLOSE"
            elif pct < 50 and typ == "INCOME":
                st = "UNDER"
            else:
                st = "OK"
            plans.append({"category": cat, "type": typ, "plannedKopecks": planned,
                          "actualKopecks": actual, "pct": round(pct, 1),
                          "status": st, "source": source})
        return {"ok": True, "capState": state, "capInfo": info, "plans": plans,
                "settings": self.settings()}

    def set_cap(self, body):
        keys = {}
        if "monthlyCapKopecks" in body:
            keys["monthlyCapKopecks"] = int(body["monthlyCapKopecks"])
        if "capLinkedIncome" in body:
            keys["capLinkedIncome"] = bool(body["capLinkedIncome"])
        if "capIncomePct" in body:
            keys["capIncomePct"] = float(body["capIncomePct"])
        set_settings(self.db, keys)
        return {"ok": True, "settings": self.settings()}

    def upsert_plan(self, body):
        year, month = int(body["year"]), int(body["month"])
        cat, typ = body["category"], body["type"]
        amt = int(body["plannedAmountKopecks"])
        if typ not in ("INCOME", "EXPENSE", "SAVINGS") or amt < 0:
            raise HttpError(400, "bad plan")
        self.db.execute(
            "INSERT INTO budget_plans(month,year,category,type,plannedAmountKopecks) "
            "VALUES(?,?,?,?,?) ON CONFLICT(month,year,category,type) "
            "DO UPDATE SET plannedAmountKopecks=excluded.plannedAmountKopecks",
            (month, year, cat, typ, amt))
        self.db.commit()
        # return the fresh budget so the client renders without a second GET
        return self.budget({"year": [str(year)], "month": [str(month)]})

    def delete_plan(self, q):
        year, month = int(q["year"][0]), int(q["month"][0])
        self.db.execute(
            "DELETE FROM budget_plans WHERE year=? AND month=? AND category=? AND type=?",
            (year, month, q["category"][0], q["type"][0]))
        self.db.commit()
        # return the fresh budget so the client renders without a second GET
        return self.budget({"year": [str(year)], "month": [str(month)]})

    # ---- budget templates (parity with Android BudgetTemplateRepository) ----
    def list_templates(self):
        rows = self.db.execute(
            "SELECT category,type,amountKopecks FROM budget_templates "
            "ORDER BY type, category").fetchall()
        return {"ok": True, "templates": [dict(r) for r in rows]}

    def upsert_template(self, body):
        """amountKopecks > 0 upserts, <= 0 removes (mirrors Android
        SettingsViewModel.setTemplateAmount: blank text removes the row)."""
        cat = str(body.get("category", "")).strip()
        typ = body.get("type")
        try:
            amt = int(body.get("amountKopecks", 0) or 0)
        except (TypeError, ValueError):
            amt = 0
        if typ not in ("INCOME", "EXPENSE", "SAVINGS") or not cat:
            raise HttpError(400, "bad template")
        if amt > 0:
            self.db.execute(
                "INSERT INTO budget_templates(category,type,amountKopecks) VALUES(?,?,?) "
                "ON CONFLICT(category,type) DO UPDATE SET amountKopecks=excluded.amountKopecks",
                (cat, typ, amt))
        else:
            self.db.execute("DELETE FROM budget_templates WHERE category=? AND type=?",
                            (cat, typ))
        self.db.commit()
        return self.list_templates()

    # ---- analytics (current year, like Android)
    def analytics(self, q):
        year = int(q.get("year", [date.today().year])[0])
        y0, y1 = year_range(year)
        monthly = []
        for mm in range(1, 13):
            s0, s1 = month_range(year, mm)
            if s0 < y0 or s1 > y1:
                continue
            t = totals_between(self.db, s0, s1)
            monthly.append({"month": mm, **t})
        cum, acc = [], 0
        for t in monthly:
            # v1.11.6: the piggy line is the NET of SAVINGS_SPEND
            acc += t["savings"] - t["savings_spend"]
            cum.append(acc)
        rows = self.db.execute(
            "SELECT category, SUM(amountKopecks) AS t FROM transactions "
            "WHERE type IN ('EXPENSE','SAVINGS_SPEND') "
            "AND date>=? AND date<? GROUP BY category ORDER BY t DESC", (y0, y1)).fetchall()
        total_exp = sum(r["t"] for r in rows)
        top5 = [{"category": r["category"], "amountKopecks": r["t"]} for r in rows[:5]]
        donut = list(top5)
        rest = sum(r["t"] for r in rows[5:])
        if rest > 0:
            for d in donut:
                if d["category"] == "Прочее":
                    d["amountKopecks"] += rest
                    break
            else:
                donut.append({"category": "Прочее", "amountKopecks": rest})
        rates = []
        for t in monthly:
            if t["income"] > 0:
                rates.append({"month": t["month"],
                              "rate": round(t["savings"] * 100.0 / t["income"], 1)})
        n = len(monthly)
        ti = sum(t["income"] for t in monthly)
        te = sum(t["expenses"] for t in monthly)
        # v1.11.6: average savings is the NET of SAVINGS_SPEND
        ts = sum(t["savings"] - t["savings_spend"] for t in monthly)

        # ==== v1.11.0: extended analytics (10 new cards, mirrored in Android) ====
        today = date.today()
        cy, cm, cd = today.year, today.month, today.day
        t0 = epoch_day(today)
        m_start, m_end = month_range(cy, cm)
        pm_start, pm_end = (month_range(cy, cm - 1) if cm > 1
                            else month_range(cy - 1, 12))
        dim = calendar.monthrange(cy, cm)[1]

        def month_start_ago(n_months):
            """First day of the month n_months-1 months before the current one."""
            y, m = cy, cm
            for _ in range(n_months - 1):
                m -= 1
                if m < 1:
                    m, y = 12, y - 1
            return epoch_day(date(y, m, 1))

        # 1) average check by category: current month + last 12 months
        def _avg_check(start, end):
            return [
                {"category": r["category"], "count": r["cnt"],
                 "avgKopecks": int(round(r["total"] / r["cnt"]))}
                for r in self.db.execute(
                    "SELECT category, COUNT(*) AS cnt, SUM(amountKopecks) AS total "
                    "FROM transactions WHERE type IN ('EXPENSE','SAVINGS_SPEND') "
                    "AND date>=? AND date<? "
                    "GROUP BY category ORDER BY cnt DESC, total DESC LIMIT 6",
                    (start, end))]
        avgCheck = _avg_check(m_start, m_end)
        avgCheckYear = _avg_check(month_start_ago(12), m_end)

        # 2) top-5 of the month with trend vs the previous month
        top5trend = []
        for r in self.db.execute(
                "SELECT category, SUM(amountKopecks) AS t FROM transactions "
                "WHERE type IN ('EXPENSE','SAVINGS_SPEND') AND date>=? AND date<? "
                "GROUP BY category ORDER BY t DESC LIMIT 5", (m_start, m_end)):
            prev = self.db.execute(
                "SELECT COALESCE(SUM(amountKopecks),0) FROM transactions "
                "WHERE type IN ('EXPENSE','SAVINGS_SPEND') AND category=? AND date>=? AND date<?",
                (r["category"], pm_start, pm_end)).fetchone()[0]
            top5trend.append({
                "category": r["category"], "amountKopecks": r["t"],
                "prevKopecks": prev, "deltaKopecks": r["t"] - prev,
                "deltaPct": (round((r["t"] - prev) * 100.0 / prev, 1)
                             if prev > 0 else None)})

        # 3) financial cushion: runway = (balance + piggy) / avg monthly expense.
        # v1.11.6: the piggy is the NET of SAVINGS_SPEND; the wallet balance is
        # untouched (spending from savings does not come from the wallet).
        b_all = totals_before(self.db, t0 + 1)
        balance_all = b_all["income"] - b_all["expenses"] - b_all["savings"]
        piggy = b_all["savings"] - b_all["savings_spend"]
        base = balance_all + piggy
        active = [t for t in monthly if t["expenses"] > 0 or t["savings_spend"] > 0]
        avg_exp = (sum(t["expenses"] + t["savings_spend"] for t in active) / len(active)) if active else 0.0
        runway = (base / avg_exp) if avg_exp > 0 else None
        cushion = {
            "balanceKopecks": balance_all, "piggyKopecks": piggy,
            "baseKopecks": base,
            "avgMonthlyExpenseKopecks": int(round(avg_exp)),
            "runwayMonths": round(runway, 1) if runway is not None else None}

        # 4) budget pace: day of month vs % of the cap already spent
        s = self.settings()
        if int(s.get("monthlyCapKopecks") or 0) <= 0 and not bool(s.get("capLinkedIncome")):
            pace = {"state": "Disabled", "expectedPct": 0.0, "spentPct": None,
                    "spentKopecks": 0, "capKopecks": None, "status": None}
        else:
            cstate, cinfo = cap_state(self.db, s, cy, cm)
            expected = cd / dim
            spent = (cinfo or {}).get("spentKopecks", 0)
            cap = (cinfo or {}).get("capKopecks")
            spent_pct = (spent / cap) if cap else None
            status = None
            if spent_pct is not None:
                diff = spent_pct - expected
                status = "BEHIND" if diff > 0.05 else ("AHEAD" if diff < -0.05 else "ON")
            pace = {"state": cstate, "expectedPct": round(expected, 4),
                    "spentPct": round(spent_pct, 4) if spent_pct is not None else None,
                    "spentKopecks": spent, "capKopecks": cap, "status": status}

        # 5) big expenses: top-10 transactions of the last 3 months
        bigExpenses = [
            {"date": r["date"], "category": r["category"],
             "description": r["description"] or "",
             "amountKopecks": r["amountKopecks"]}
            for r in self.db.execute(
                "SELECT date, category, description, amountKopecks FROM transactions "
                "WHERE type IN ('EXPENSE','SAVINGS_SPEND') AND date>=? AND date<? "
                "ORDER BY amountKopecks DESC LIMIT 10", (month_start_ago(3), t0 + 1))
        ]

        # v1.11.2: year-end balance forecast removed (user request)

        # 8) balance curve: daily balance of the current month (carry-over + net)
        tb = totals_before(self.db, m_start)
        acc = tb["income"] - tb["expenses"] - tb["savings"]
        balanceCurve = []
        for dd in range(1, dim + 1):
            day0 = epoch_day(date(cy, cm, dd))
            if day0 > t0:
                break
            t = totals_between(self.db, day0, day0 + 1)
            acc += t["income"] - t["expenses"] - t["savings"]
            balanceCurve.append({"day": dd, "balanceKopecks": acc})

        # 9) expenses by weekday (current year; 1 = Monday .. 7 = Sunday)
        wd = [0] * 7
        for r in self.db.execute(
                "SELECT date, SUM(amountKopecks) AS t FROM transactions "
                "WHERE type IN ('EXPENSE','SAVINGS_SPEND') AND date>=? AND date<? GROUP BY date",
                (y0, y1)):
            d = date(1970, 1, 1) + timedelta(days=r["date"])
            wd[d.weekday()] += r["t"]
        weekday = [{"weekday": i + 1, "amountKopecks": v} for i, v in enumerate(wd)]

        # 10) calendar heatmap: daily expenses, last 12 months
        cal_rows = self.db.execute(
            "SELECT date, SUM(amountKopecks) AS t FROM transactions "
            "WHERE type IN ('EXPENSE','SAVINGS_SPEND') AND date>=? AND date<? GROUP BY date",
            (month_start_ago(12),
             epoch_day(date(cy, cm, 1)) + dim)).fetchall()
        calDays = [{"date": r["date"], "amountKopecks": r["t"]} for r in cal_rows]
        calMax = max((r["t"] for r in cal_rows), default=0)

        return {"ok": True, "year": year, "monthly": monthly, "cumulative": cum,
                "expensesTotalKopecks": total_exp, "top5": top5, "donut": donut,
                "savingsRate": rates,
                "averages": {"incomeKopecks": ti // 12 if n else 0,
                             "expenseKopecks": te // 12 if n else 0,
                             "savingsKopecks": ts // 12 if n else 0},
                "avgCheck": avgCheck, "avgCheckYear": avgCheckYear,
                "top5trend": top5trend, "cushion": cushion,
                "pace": pace, "bigExpenses": bigExpenses,
                "balanceCurve": balanceCurve, "weekday": weekday,
                "calendar": {"days": calDays, "maxKopecks": calMax}}

    # ---- export / import (Android BackupData-compatible)
    def export(self):
        s = self.settings()
        # rowid is carried so the E2E web app can reproduce SQLite's tie
        # order (web/logic.js listTx/bigExpenses). Android's Moshi adapter
        # ignores the unknown field; the legacy importer never reads it.
        txs = []
        for r in self.db.execute(
                f"SELECT {TX_COLS}, rowid FROM transactions "
                "ORDER BY date, createdAt, rowid"):
            d = tx_row_to_dict(r)
            d["rowid"] = r[11]
            txs.append(d)
        cats = [dict(r) for r in self.db.execute(
            "SELECT name,type,emoji,icon,isVisible,sortOrder FROM categories")]
        goals = [dict(r) for r in self.db.execute(
            "SELECT *, rowid FROM savings_goals ORDER BY rowid")]
        plans = [dict(r) for r in self.db.execute("SELECT * FROM budget_plans")]
        templates = [dict(r) for r in self.db.execute(
            "SELECT category,type,amountKopecks FROM budget_templates")]
        return {"app": "moneyapp", "version": 1, "exportedAt": int(time.time() * 1000),
                "username": s.get("username", ""), "transactions": txs,
                "goals": goals, "categories": cats, "budgets": plans,
                "budgetTemplates": templates,
                # settings are NOT part of the Android BackupData format,
                # but Android's Moshi ignores unknown keys — carrying them
                # keeps budget caps/links/username through export-import and
                # through the E2E migration (where they would be lost).
                "settings": s}

    def import_backup(self, body):
        if not isinstance(body, dict) or not isinstance(body.get("transactions"), list):
            raise HttpError(400, "expected backup JSON with transactions[]")
        txs = body["transactions"]
        existing = {r[0] for r in self.db.execute("SELECT id FROM transactions")}
        tx_added = sum(1 for t in txs if (t.get("id") or None) not in existing)
        tx_updated = len(txs) - tx_added
        for t in txs:
            tid = t.get("id") or str(uuid.uuid4())
            self.db.execute(
                "INSERT INTO transactions VALUES(?,?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET date=excluded.date,type=excluded.type,"
                "category=excluded.category,description=excluded.description,"
                "amountKopecks=excluded.amountKopecks,"
                "paymentMethod=excluded.paymentMethod,tag=excluded.tag,note=excluded.note,"
                "updatedAt=excluded.updatedAt",
                (tid, int(t["date"]), t["type"], t.get("category", ""),
                 t.get("description", ""), int(t["amountKopecks"]),
                 t.get("paymentMethod", "CARD"), t.get("tag"), t.get("note"),
                 int(t.get("createdAt", 0)) or int(time.time() * 1000),
                 int(t.get("updatedAt", 0)) or int(time.time() * 1000)))
        self.db.commit()
        cat_added = 0
        for c in body.get("categories") or []:
            if not c.get("type") or not c.get("name"):
                continue
            exists = self.db.execute("SELECT 1 FROM categories WHERE name=? AND type=?",
                                     (c["name"], c["type"])).fetchone()
            if not exists:
                self.db.execute(
                    "INSERT INTO categories(name,type,emoji,icon,isVisible,sortOrder) "
                    "VALUES(?,?,?,?,?,?)",
                    (c["name"], c["type"], c.get("emoji", ""), c.get("icon"),
                     1 if c.get("isVisible", 1) else 0, int(c.get("sortOrder", 0))))
                cat_added += 1
        g_added = 0
        for g in body.get("goals") or []:
            if not g.get("id") or not g.get("name"):
                continue
            if not self.db.execute("SELECT 1 FROM savings_goals WHERE id=?",
                                   (g["id"],)).fetchone():
                self.db.execute(
                    "INSERT INTO savings_goals VALUES(?,?,?,?,?,?)",
                    (g["id"], g["name"], g.get("description", ""),
                     int(g.get("targetAmountKopecks", 0)), int(g.get("deadline", 0)),
                     int(g.get("createdAt", 0)) or int(time.time() * 1000)))
                g_added += 1
        b_added = 0
        for p in body.get("budgets") or []:
            amt = p.get("plannedAmountKopecks", p.get("amountKopecks"))
            if amt is None or not p.get("category") or not p.get("type"):
                continue
            before = self.db.execute(
                "SELECT 1 FROM budget_plans WHERE month=? AND year=? AND category=? AND type=?",
                (int(p.get("month", 0)), int(p.get("year", 0)), p["category"], p["type"])).fetchone()
            self.db.execute(
                "INSERT INTO budget_plans(month,year,category,type,plannedAmountKopecks) "
                "VALUES(?,?,?,?,?) ON CONFLICT(month,year,category,type) "
                "DO UPDATE SET plannedAmountKopecks=excluded.plannedAmountKopecks",
                (int(p.get("month", 0)), int(p.get("year", 0)), p["category"], p["type"], int(amt)))
            if not before:
                b_added += 1
        t_added = 0
        for t in body.get("budgetTemplates") or []:
            if not t.get("category") or not t.get("type"):
                continue
            amt = int(t.get("amountKopecks", 0) or 0)
            if amt <= 0:
                continue
            before = self.db.execute(
                "SELECT 1 FROM budget_templates WHERE category=? AND type=?",
                (t["category"], t["type"])).fetchone()
            self.db.execute(
                "INSERT INTO budget_templates(category,type,amountKopecks) VALUES(?,?,?) "
                "ON CONFLICT(category,type) DO UPDATE SET amountKopecks=excluded.amountKopecks",
                (t["category"], t["type"], amt))
            if not before:
                t_added += 1
        self.db.commit()
        return {"ok": True, "txAdded": tx_added, "txUpdated": tx_updated,
                "catAdded": cat_added, "goalAdded": g_added, "budgetAdded": b_added,
                "templateAdded": t_added}

    # ---- E2E blob store (opaque to the server) ----
    def user_dir(self):
        return os.path.join(USERS_DIR, str(self.uid))

    def blob_path(self):
        return os.path.join(self.user_dir(), "blob.json")

    def get_blob(self):
        """Encrypted blob + rev (optimistic lock) + the server's today (MSK):
        all date math must use the server's day, not the device's timezone."""
        p = self.blob_path()
        rev, blob = 0, None
        if os.path.exists(p):
            try:
                d = json.load(open(p))
                rev = int(d.get("rev", 0))
                blob = d.get("blob")
            except Exception:
                raise HttpError(500, "blob corrupt")
        return {"ok": True, "has": blob is not None, "blob": blob,
                "rev": rev, "today": today_epoch()}

    def put_blob(self, body):
        if not isinstance(body, dict) or not isinstance(body.get("blob"), dict):
            raise HttpError(400, "bad request")
        blob = body["blob"]
        _validate_blob(blob)
        p = self.blob_path()
        cur = {"rev": 0}
        if os.path.exists(p):
            try:
                cur = json.load(open(p))
            except Exception:
                raise HttpError(500, "blob corrupt")
        want = int(body.get("rev", -1))
        if int(cur.get("rev", 0)) != want:
            raise HttpError(409, "conflict",
                            {"error": "conflict", "rev": int(cur.get("rev", 0))})
        tmp = p + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"rev": want + 1, "blob": blob}, f)
        os.replace(tmp, p)  # atomic
        return {"ok": True, "rev": want + 1}

    def legacy(self):
        """One-time plaintext export of the pre-E2E database, used only by the
        migration screen. Returns 404 once the user has migrated."""
        if os.path.exists(os.path.join(self.user_dir(), "migrated.json")):
            raise HttpError(404, "migrated")
        # settings ride along so the migration keeps caps/links/theme intact
        return {"ok": True, "export": self.export()}

    def migration_complete(self):
        """Mark the migration done: the legacy DB is renamed (not deleted —
        30-day undo window, cleaned up by the cleanup loop) and a marker is
        written so GET /api/legacy and the bot's /stats know."""
        d = self.user_dir()
        m = os.path.join(d, "migrated.json")
        if os.path.exists(m):
            return {"ok": True, "already": True}
        dbp = os.path.join(d, "db.sqlite3")
        ts = int(time.time())
        if os.path.exists(dbp):
            os.replace(dbp, os.path.join(d, f"db.sqlite3.bak-{ts}"))
        with open(m, "w") as f:
            json.dump({"migrated_at": ts}, f)
        return {"ok": True}

# ---------------------------------------------------------------- HTTP layer --

def _validate_blob(blob):
    """Shape check for the E2E blob: {v:1, ivKey(12B), ctKey(48B), iv(12B),
    ct(>=32B)} in base64. The server never decodes the payloads — it only
    refuses structurally broken or oversized blobs."""
    for k in ("ivKey", "ctKey", "iv", "ct"):
        if not isinstance(blob.get(k), str):
            raise HttpError(400, "bad blob")
    if blob.get("v") != 1:
        raise HttpError(400, "bad blob")
    try:
        ivk = base64.b64decode(blob["ivKey"])
        ctk = base64.b64decode(blob["ctKey"])
        iv = base64.b64decode(blob["iv"])
        ct = base64.b64decode(blob["ct"])
    except Exception:
        raise HttpError(400, "bad blob")
    if len(ivk) != 12 or len(ctk) != 48 or len(iv) != 12 or not (32 <= len(ct) <= MAX_BODY):
        raise HttpError(400, "bad blob")
class HttpError(Exception):
    def __init__(self, code, msg, payload=None):
        super().__init__(msg)
        self.code, self.msg, self.payload = code, msg, payload

ROUTES = {
    ("GET", "/api/bootstrap"): lambda api, q, b: api.bootstrap(),
    ("GET", "/api/summary"): lambda api, q, b: api.summary(q),
    ("GET", "/api/transactions"): lambda api, q, b: api.list_tx(q),
    ("POST", "/api/transactions"): lambda api, q, b: api.add_tx(b),
    ("DELETE", "/api/transactions"): lambda api, q, b: api.delete_tx(q.get("id", [""])[0]),
    ("GET", "/api/categories"): lambda api, q, b: api.list_cats(),
    ("POST", "/api/categories"): lambda api, q, b: api.add_cat(b),
    ("PUT", "/api/categories"): lambda api, q, b: api.update_cat(q, b),
    ("DELETE", "/api/categories"): lambda api, q, b: api.delete_cat(q),
    ("GET", "/api/goals"): lambda api, q, b: api.list_goals(),
    ("POST", "/api/goals"): lambda api, q, b: api.add_goal(b),
    ("PUT", "/api/goals"): lambda api, q, b: api.update_goal(q.get("id", [""])[0], b),
    ("DELETE", "/api/goals"): lambda api, q, b: api.delete_goal(q.get("id", [""])[0]),
    ("POST", "/api/goals_contribute"): lambda api, q, b: api.contribute(q.get("id", [""])[0], b),
    ("GET", "/api/budget"): lambda api, q, b: api.budget(q),
    ("POST", "/api/budget/cap"): lambda api, q, b: api.set_cap(b),
    ("POST", "/api/budget/plan"): lambda api, q, b: api.upsert_plan(b),
    ("DELETE", "/api/budget/plan"): lambda api, q, b: api.delete_plan(q),
    ("GET", "/api/budget_templates"): lambda api, q, b: api.list_templates(),
    ("PUT", "/api/budget_templates"): lambda api, q, b: api.upsert_template(b),
    ("GET", "/api/analytics"): lambda api, q, b: api.analytics(q),
    ("GET", "/api/export"): lambda api, q, b: api.export(),
    ("POST", "/api/import"): lambda api, q, b: api.import_backup(b),
    ("GET", "/api/settings"): lambda api, q, b: {"ok": True, "settings": api.settings()},
    ("PUT", "/api/settings"): lambda api, q, b: handle_settings_put(api, b),
    # E2E (v1.11.10): the mini-app now does all computation in the browser
    # and talks to these opaque-blob endpoints only.
    ("GET", "/api/blob"): lambda api, q, b: api.get_blob(),
    ("PUT", "/api/blob"): lambda api, q, b: api.put_blob(b),
    ("GET", "/api/legacy"): lambda api, q, b: api.legacy(),
    ("POST", "/api/migration_complete"): lambda api, q, b: api.migration_complete(),
}

def handle_settings_put(api, body):
    allowed = {"username", "currencySymbol", "themeMode", "budgetCopyPrevMonth"}
    keys = {k: v for k, v in body.items() if k in allowed}
    set_settings(api.db, keys)
    return {"ok": True, "settings": api.settings()}

RATE = {}
def rate_ok(ip):
    now = time.time()
    bucket = RATE.get(ip, [int(now // 60), 0])
    if bucket[0] != int(now // 60):
        bucket[0], bucket[1] = int(now // 60), 0
        RATE[ip] = bucket
    bucket[1] += 1
    return bucket[1] <= RATE_LIMIT_PER_MIN

STATIC_MIME = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
               ".js": "text/javascript; charset=utf-8", ".json": "application/json",
               ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
               ".woff2": "font/woff2"}

class Handler(BaseHTTPRequestHandler):
    server_version = "MoneyAppTG/1.0"

    def log_message(self, fmt, *args):
        pass  # quiet; systemd journal gets errors only

    def _send(self, code, body, ctype="application/json; charset=utf-8", extra=None):
        data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        if extra:
            for k, v in extra.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _auth(self):
        init_data = self.headers.get("X-Init-Data", "")
        if not init_data:
            q = self.path.split("?", 1)
            if len(q) == 2:
                p = urllib.parse.parse_qs(q[1])
                init_data = (p.get("initData") or [""])[0]
        user = verify_init_data(init_data)
        if not user:
            raise HttpError(401, "unauthorized")
        return user

    def _read_body(self):
        ln = int(self.headers.get("Content-Length") or 0)
        if ln > MAX_BODY:
            raise HttpError(413, "too large")
        raw = self.rfile.read(ln) if ln else b""
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            raise HttpError(400, "bad json")

    def _api(self, method):
        try:
            path = self.path.split("?", 1)[0]
            if not path.startswith("/api/"):
                self._send(404, {"error": "not found"})
                return
            if not rate_ok(self.client_address[0]):
                self._send(429, {"error": "rate limit"})
                return
            user = self._auth()
            q = {}
            if "?" in self.path:
                q = urllib.parse.parse_qs(self.path.split("?", 1)[1])
            ensure_user_db(user["id"])
            api = Api(user["id"])
            try:
                body = self._read_body() if method in ("POST", "PUT") else {}
                sub = re.match(r"^/api/transactions/([\w-]+)$", path)
                if sub:
                    if method == "PUT":
                        out = api.update_tx(sub.group(1), body)
                    elif method == "DELETE":
                        out = api.delete_tx(sub.group(1))
                    else:
                        raise HttpError(404, "no route")
                else:
                    fn = ROUTES.get((method, path))
                    if fn is None:
                        raise HttpError(404, "no route")
                    out = fn(api, q, body)
                self._send(200, out)
            finally:
                api.close()
        except HttpError as e:
            self._send(e.code, e.payload if e.payload is not None else {"error": e.msg})
        except Exception as e:
            try:
                self._send(500, {"error": f"internal: {type(e).__name__}: {e}"})
            except Exception:
                pass

    def _static(self):
        path = self.path.split("?", 1)[0]
        if path == "/":
            path = "/index.html"
        full = os.path.realpath(os.path.join(WEB_DIR, path.lstrip("/")))
        if not full.startswith(os.path.realpath(WEB_DIR)) or not os.path.isfile(full):
            self._send(404, {"error": "not found"})
            return
        ext = os.path.splitext(full)[1].lower()
        with open(full, "rb") as f:
            data = f.read()
        self._send(200, data, STATIC_MIME.get(ext, "application/octet-stream"),
                   extra={"Cache-Control": "max-age=300"} if ext in (".css", ".js", ".woff2") else None)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True, "ts": int(time.time())})
            return
        if self.path.split("?", 1)[0] == "/api/version":
            # no auth: a stale-JS client (even with an expired initData)
            # must still be able to notice the deploy and offer a reload
            self._send(200, {"ok": True, "webVer": WEB_VERSION})
            return
        if self.path.startswith("/api/"):
            self._api("GET")
            return
        self._static()

    def do_POST(self):
        if self.path.startswith("/api/"):
            self._api("POST")
        else:
            self._send(405, {"error": "method not allowed"})

    def do_PUT(self):
        if self.path.startswith("/api/"):
            self._api("PUT")
        else:
            self._send(405, {"error": "method not allowed"})

    def do_DELETE(self):
        if self.path.startswith("/api/"):
            self._api("DELETE")
        else:
            self._send(405, {"error": "method not allowed"})

# ---------------------------------------------------------------- bot loop --
def tg_call(method, **params):
    req = urllib.request.Request(
        f"{TG_API}/bot{BOT_TOKEN}/{method}",
        data=json.dumps(params).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read().decode())

def tg_send(chat_id, text, reply_markup=None, document_path=None, caption=None):
    if document_path:
        url = f"{TG_API}/bot{BOT_TOKEN}/sendDocument"
        with open(document_path, "rb") as f:
            doc_bytes = f.read()
        # multipart
        boundary = "----moneyapp" + uuid.uuid4().hex
        body = b""
        fields = {"chat_id": str(chat_id)}
        if caption:
            fields["caption"] = caption
        for k, v in fields.items():
            body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n").encode()
        body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"document\"; "
                 f"filename=\"{os.path.basename(document_path)}\"\r\n"
                 f"Content-Type: application/octet-stream\r\n\r\n").encode()
        body += doc_bytes + f"\r\n--{boundary}--\r\n".encode()
        req = urllib.request.Request(url, data=body,
                                     headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read().decode())
    params = {"chat_id": chat_id, "text": text}
    if reply_markup:
        params["reply_markup"] = json.dumps(reply_markup)
    return tg_call("sendMessage", **params)

def fmt_money(kopecks, signed=False):
    neg = kopecks < 0
    v = abs(int(kopecks)) // 100
    s = f"{v:,}".replace(",", " ")
    if neg:
        s = "−" + s
    elif signed:
        s = "+" + s
    return s + " ₽"

def handle_update(upd):
    msg = upd.get("message") or {}
    user = msg.get("from") or {}
    chat = msg.get("chat") or {}
    text = (msg.get("text") or "").strip()
    uid = user.get("id")
    if not uid:
        return
    if text == "/start":
        ensure_user_db(uid)
        set_owner_if_empty(uid)
        welcome = ("Привет! Я MoneyAPP — твой финансовый трекер.\n\n"
                   "Нажми кнопку, чтобы открыть мини-приложение.\n\n"
                   + E2E_NOTE_BOT)
        if os.path.exists(SEED_FILE) and get_owner_id() == uid:
            try:
                backup = json.load(open(SEED_FILE))
                r = seed_owner_db(uid, backup)
                os.replace(SEED_FILE, OWNER_RESTORE)
                welcome += (f"\n\n✅ Твои данные восстановлены: "
                            f"{r['txAdded']} транзакций, {r['catAdded']} категорий.")
            except Exception as e:
                print(f"[seed] error: {e}", flush=True)
        tg_send(chat["id"], welcome,
                reply_markup={"inline_keyboard": [[
                    {"text": "Открыть MoneyAPP",
                     "web_app": {"url": WEBAPP_URL}}]]})
    elif text == "/stats":
        if os.path.exists(os.path.join(USERS_DIR, str(uid), "migrated.json")):
            tg_send(chat["id"], E2E_STATS,
                    reply_markup={"inline_keyboard": [[
                        {"text": "Открыть MoneyAPP",
                         "web_app": {"url": WEBAPP_URL}}]]})
            return
        ensure_user_db(uid)
        y, m = date.today().year, date.today().month
        api = Api(uid)
        try:
            s = api.summary({"start": [str(month_range(y, m)[0])],
                             "end": [str(month_range(y, m)[1])],
                             "mode": ["month"], "year": [str(y)], "month": [str(m)]})
        finally:
            api.close()
        tg_send(chat["id"],
                f"💳 {MONTHS_FULL[m - 1]} {y}\n"
                f"Остаток: {fmt_money(s['balanceKopecks'])}\n"
                f"Доходы: {fmt_money(s['period']['income'])}\n"
                f"Расходы: {fmt_money(s['period']['expenses'])}\n"
                f"Отложено: {fmt_money(s['savingsNetKopecks'])}")
    elif text == "/backup":
        if get_owner_id() != uid:
            tg_send(chat["id"], "Эта команда доступна только владельцу.")
            return
        f = os.path.join(DATA_DIR, "owner_restore.json")
        if os.path.exists(f):
            tg_send(chat["id"], "Файл восстановления (импорт в приложении: Настройки → Данные).",
                    document_path=f)
        else:
            tg_send(chat["id"], "Файл восстановления не найден на сервере.")
    elif text == "/help":
        tg_send(chat["id"],
                "Команды:\n/start — открыть мини-приложение\n"
                "/stats — остаток за текущий месяц\n"
                "/backup — файл резервной копии (только владелец)\n"
                "/help — эта справка\n\n" + E2E_NOTE_LONG)
    else:
        tg_send(chat["id"], "Кнопка «Открыть MoneyAPP» есть в сообщении /start. Команды: /stats, /backup, /help")

def bot_loop():
    offset = None
    while True:
        try:
            params = {"timeout": 25, "allowed_updates": "[]"}
            if offset is not None:
                params["offset"] = offset
            url = f"{TG_API}/bot{BOT_TOKEN}/getUpdates?" + urllib.parse.urlencode(params)
            with urllib.request.urlopen(url, timeout=90) as r:
                res = json.loads(r.read().decode())
            for upd in res.get("result", []):
                offset = upd["update_id"] + 1
                try:
                    handle_update(upd)
                except Exception as e:
                    print(f"[bot] update error: {e}", flush=True)
        except Exception as e:
            print(f"[bot] loop error: {e}", flush=True)
            time.sleep(5)

# -------------------------------------------------------------------- main --
def cleanup_legacy_backups():
    """Remove db.sqlite3.bak-* older than 30 days (post-migration undo
    window). Runs once at start and every 6 h in a daemon thread."""
    cutoff = time.time() - 30 * 86400
    try:
        for entry in os.scandir(USERS_DIR):
            if not entry.is_dir():
                continue
            for f in os.scandir(entry.path):
                if f.name.startswith("db.sqlite3.bak-") and f.is_file() \
                        and f.stat().st_mtime < cutoff:
                    os.unlink(f.path)
                    print(f"[cleanup] removed {f.path}", flush=True)
    except Exception as e:
        print(f"[cleanup] error: {e}", flush=True)

def cleanup_loop():
    while True:
        cleanup_legacy_backups()
        time.sleep(6 * 3600)

def main():
    if not BOT_TOKEN:
        raise SystemExit("BOT_TOKEN missing (.env)")
    os.makedirs(USERS_DIR, exist_ok=True)
    threading.Thread(target=cleanup_legacy_backups, daemon=True).start()
    threading.Thread(target=cleanup_loop, daemon=True).start()
    t = threading.Thread(target=bot_loop, daemon=True)
    t.start()
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    print(f"[moneyapp-tg] listening on {HOST}:{PORT}, webapp={WEBAPP_URL}", flush=True)
    srv.serve_forever()

if __name__ == "__main__":
    main()
