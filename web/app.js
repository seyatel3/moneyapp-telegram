/* MoneyAPP Web — Telegram mini-app logic */
"use strict";

const tg = window.Telegram && window.Telegram.WebApp;
if (tg) { tg.ready(); try { tg.expand(); } catch (e) {} }

// ------------------------------------------------------------- constants ---
const MONTHS_FULL = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];
const MONTHS_SHORT = ["Янв","Фев","Мар","Апр","Май","Июн","Июл","Авг","Сен","Окт","Ноя","Дек"];
const TINTS = ["#34D399","#38BDF8","#C084FC","#FBBF24","#FF8A65","#4ADE80","#7DD3FC","#F472B6","#A3E635","#FB923C"];
const NAME_ICONS = {
  "Зарплата":"wallet","Переработки":"work_history","Премия":"card_giftcard","Прочий доход":"attach_money",
  "Инвестиции":"trending_up","Продукты":"shopping_cart","Ипотека/Аренда":"home","ЖКХ":"electric_bolt",
  "Транспорт":"directions_car","Рестораны":"restaurant","Здоровье":"local_hospital","Одежда":"checkroom",
  "Подписки":"subscriptions","Спорт":"fitness_center","Образование":"school","Подарки":"card_giftcard",
  "Развлечения":"theaters","Связь":"smartphone","Услуги":"build","Маркетплейсы":"shopping_bag",
  "Вредные привычки":"smoke_free"
};
const ICON_FALLBACKS = ["category","label","attach_money","shopping_cart","payments","dining"];
// v1.11.0: aligned 1:1 with the Android CategoryIconPalette (Theme.kt) so the
// same stored icon key renders the same glyph in both apps.
const ICON_KEYS = {
  "wallet":"wallet","money":"attach_money","coins":"paid","card":"credit_card","cash":"payments",
  "bill":"money","savings":"savings","percent":"percent","trend-up":"trending_up","atms":"local_atm",
  "account":"account_balance","briefcase":"work","gift":"card_giftcard","cart":"shopping_cart",
  "bag":"shopping_bag","store":"storefront","home":"home","apartment":"apartment","bolt":"electric_bolt","bulb":"lightbulb",
  "car":"directions_car","bus":"directions_bus","bike":"directions_bike","moto":"motorcycle","plane":"flight",
  "gas":"local_gas_station","restaurant":"restaurant","food":"dining","coffee":"local_cafe",
  "breakfast":"free_breakfast","pizza":"local_pizza","icecream":"icecream","bar":"local_bar","hospital":"local_hospital",
  "pharmacy":"local_pharmacy","heart":"favorite","medicine":"medication","shirt":"checkroom","style":"style",
  "subscriptions":"subscriptions","phone":"smartphone","devices":"devices","wifi":"wifi","fitness":"fitness_center",
  "esports":"sports_esports","pool":"pool","school":"school","book":"menu_book","toy":"emoji_objects","theater":"theaters",
  "games":"videogame_asset","tools":"build","cleaning":"cleaning_services","laundry":"local_laundry_service",
  "smokefree":"smoke_free","pets":"pets","category":"category","label":"label","star":"star","mood":"mood"
};
const TYPE_ICON = { INCOME:"trending_up", EXPENSE:"trending_down", SAVINGS:"savings", SAVINGS_SPEND:"paid" };
const TYPE_LABEL = { INCOME:"Доход", EXPENSE:"Расход", SAVINGS:"Копилка", SAVINGS_SPEND:"Из накоплений" };
const TYPE_COLOR = { INCOME:"var(--income-text)", EXPENSE:"var(--expense-text)", SAVINGS:"var(--savings-text)", SAVINGS_SPEND:"var(--savings-text)" };
// v1.11.6: spending from savings has no own category pool — it reuses the
// EXPENSE categories (Android parity, categoryListForType).
const catTypeFor = (t) => (t === "SAVINGS_SPEND" ? "EXPENSE" : t);

const NOW = new Date();
function epochDay(y, m, d) { return Math.round(Date.UTC(y, m - 1, d) / 86400000); }
function todayEpoch() { return Math.floor(Date.now() / 86400000); }
function fromEpochDay(e) { const d = new Date(e * 86400000); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }; }
function isoDate(e) { const d = fromEpochDay(e); return `${d.y}-${String(d.m).padStart(2,"0")}-${String(d.d).padStart(2,"0")}`; }
function javaHash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }
function tintOf(name) { return TINTS[Math.abs(javaHash(name)) % 1000 % 10]; }
function catIcon(name) {
  const c = state.categories.find(c => c.name === name && c.icon);
  if (c) return ICON_KEYS[c.icon] || c.icon;
  if (NAME_ICONS[name]) return NAME_ICONS[name];
  // Parity with Android: (name.hashCode() and 0x7fffffff) % fallbacks.size
  return ICON_FALLBACKS[(javaHash(name) & 0x7fffffff) % ICON_FALLBACKS.length];
}
function fmtMoney(kop, signed = false) {
  const neg = kop < 0, a = Math.abs(kop);
  let s = Math.floor(a / 100).toLocaleString("ru-RU");
  const k = a % 100;
  if (k) s += "," + String(k).padStart(2, "0");
  s += " ₽";
  return (neg ? "−" : (signed ? "+" : "")) + s;
}
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function dayLabel(e) {
  const t = todayEpoch();
  if (e === t) return "Сегодня";
  if (e === t - 1) return "Вчера";
  if (e === t - 2) return "Позавчера";
  const d = fromEpochDay(e);
  let s = `${d.d} ${MONTHS_FULL[d.m - 1]}`;
  if (d.y !== NOW.getFullYear()) s += ` ${d.y}`;
  return s;
}
function periodLabel(p) {
  return p.mode === "month" ? `${MONTHS_FULL[p.month - 1]} ${p.year}` : String(p.year);
}
function periodRange(p) {
  if (p.mode === "month") return [epochDay(p.year, p.month, 1), p.month === 12 ? epochDay(p.year + 1, 1, 1) : epochDay(p.year, p.month + 1, 1)];
  return [epochDay(p.year, 1, 1), epochDay(p.year + 1, 1, 1)];
}

// ----------------------------------------------------------------- state ---
const state = {
  initData: "",
  user: null,
  settings: {},
  categories: [],
  tab: "dashboard",
  sub: null,
  period: { mode: "month", year: NOW.getFullYear(), month: NOW.getMonth() + 1 },
  filters: { type: null, q: "", start: null, end: null },
  tx: [],
  budgetPeriod: { year: NOW.getFullYear(), month: NOW.getMonth() + 1 },
  sheetTxId: null,
};
// Budget template UI (Settings): must outlive re-renders, otherwise group
// toggles reset. EXPENSE group is open by default (Android parity).
const tui = { open: true, groups: { INCOME: false, EXPENSE: true, SAVINGS: false, SAVINGS_SPEND: false } };
let selCat = "";

// ================================================================ E2E ======
// v1.11.10: all business logic runs in the browser (MALogic over
// store.state). The server keeps only an opaque encrypted blob
// (web/crypto.js + /api/blob in app.py); the PIN key is derived locally and
// never leaves the app, so the server owner cannot read any user's data.
const WEB_APP_VERSION = 12; // must equal app.py WEB_VERSION (stale-JS banner)
const C = window.MACrypto;
const M = window.MALogic;
const authCtx = { mode: null, legacyExport: null };

const store = {
  state: null,   // canonical dataset (logic.js shape), in memory only
  key: null,     // random 32 B master key (AES-GCM), in memory only
  pin: null,     // current PIN, in memory only
  uid: 0,
  rev: -1,       // optimistic-lock counter from /api/blob
  today: null,   // the SERVER's today (epoch day, MSK) — all date math uses it
  async http(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json", "X-Init-Data": state.initData },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(data.error || ("HTTP " + res.status));
      e.status = res.status;
      e.data = data;
      throw e;
    }
    return data;
  },
  async load() {
    const d = await this.http("GET", "/api/blob");
    this.rev = d.rev;
    this.today = d.today;
    return d.has ? d.blob : null;
  },
  _dataBlob(blob) { return { v: blob.v, iv: blob.iv, ct: blob.ct }; },
  // Apply an in-place mutation op(state), then persist the whole blob with
  // optimistic locking. On 409 (newer save elsewhere) re-fetch, re-decrypt
  // and re-apply the op on the fresh state (up to 3 tries).
  async mutate(op) {
    for (let i = 0; i < 3; i++) {
      const snapshot = JSON.parse(JSON.stringify(this.state));
      let out;
      try { out = op(this.state); }
      catch (e) { this.state = snapshot; throw e; }
      try {
        await this.save();
        return out;
      } catch (e) {
        if (e.status === 409) {
          const blob = await this.load();
          this.state = await C.decryptBlob(this._dataBlob(blob), this.key);
          continue;
        }
        this.state = snapshot; // not persisted — roll back the in-memory change
        throw e;
      }
    }
    throw new Error("Конфликт версий — попробуйте ещё раз");
  },
  async save() {
    const wrap = await C.wrapMasterKey(this.key, this.pin, this.uid);
    const db = await C.encryptData(this.state, this.key);
    const blob = { v: 1, ivKey: wrap.ivKey, ctKey: wrap.ctKey, iv: db.iv, ct: db.ct };
    const d = await this.http("PUT", "/api/blob", { rev: this.rev, blob });
    this.rev = d.rev;
  },
  // Unlock an existing blob with the PIN (throws "wrong key" on bad PIN).
  async unlockPin(pin) {
    if (!C.validPin(pin)) throw new Error("ПИН: 4–6 цифр");
    const blob = await this.load();
    if (!blob) throw new Error("На сервере пока нет данных");
    this.key = await C.unwrapMasterKey(blob, pin, this.uid);
    this.state = await C.decryptBlob(this._dataBlob(blob), this.key);
    this.pin = pin;
  },
  // First launch / migration: key already generated, show phrase, then save.
  async firstSave(pin, key, st) {
    if (!C.validPin(pin)) throw new Error("ПИН: 4–6 цифр");
    this.key = key;
    this.state = st;
    this.pin = pin;
    await this.load(); // sync rev/today from the server (returns blob|null)
    await this.save();
  },
  // Recovery: 24-word phrase -> master key -> decrypt.
  async unlockPhrase(words) {
    this.key = await C.keyFromMnemonic(words);
    const blob = await this.load();
    if (!blob) throw new Error("На сервере пока нет данных");
    this.state = await C.decryptBlob(this._dataBlob(blob), this.key);
  },
  // New PIN after phrase recovery (same master key -> phrase unchanged).
  async setPin(pin) {
    if (!C.validPin(pin)) throw new Error("ПИН: 4–6 цифр");
    this.pin = pin;
    await this.save();
  },
  // Phrase for the settings "show phrase" action: PIN-verify, then derive
  // the mnemonic from the in-memory key. Throws "wrong key" on bad PIN.
  async phraseForPin(pin) {
    if (!C.validPin(pin)) throw new Error("ПИН: 4–6 цифр");
    const blob = await this.load();
    const k = await C.unwrapMasterKey(blob, pin, this.uid);
    return C.keyToMnemonic(await C.keyBytesOf(k));
  },
  // Change PIN: verify the current one, re-wrap the same master key under
  // the new PIN. The master key (and the phrase) are untouched.
  async changePin(oldPin, newPin) {
    if (!C.validPin(newPin)) throw new Error("Новый ПИН: 4–6 цифр");
    const blob = await this.load();
    await C.unwrapMasterKey(blob, oldPin, this.uid); // throws "wrong key"
    this.pin = newPin;
    await this.save();
  },
};

// -------------------------------------------------------------- auth UI ----
function authBox(html) {
  const a = document.getElementById("auth");
  a.innerHTML = html;
  a.classList.remove("hidden");
}
function authDone() {
  document.getElementById("auth").classList.add("hidden");
  state.settings = store.state.settings;
  state.categories = M.listCats(store.state).categories;
  if (!state.settings.username && state.user && state.user.first_name)
    state.settings.username = state.user.first_name;
  applyTheme(state.settings.themeMode || "system");
  if (document.querySelector(".screen.active")) refresh();
  else showTab("dashboard");
}
function showVBanner() {
  const b = document.getElementById("vbanner");
  b.textContent = "Обнаружена новая версия приложения — нажмите, чтобы обновить";
  b.classList.remove("hidden");
  b.onclick = () => location.reload();
}
function screenPin() {
  authBox(`
    <div class="authwrap">
      <div class="authico"><span class="msrc">lock</span></div>
      <div class="autht">Введите ПИН</div>
      <div class="authh">Вход в MoneyAPP — данные расшифруются только на этом устройстве</div>
      <input id="authPin" class="authpin" type="password" inputmode="numeric" maxlength="6" placeholder="••••" autocomplete="off">
      <div id="authErr" class="autherr"></div>
      <button class="btn" id="authGo"><span class="msrc">check</span>Войти</button>
      <button class="btn text" id="authRecover"><span class="msrc">restore</span>Забыл ПИН — восстановить по фразе</button>
    </div>`);
  const go = async () => {
    try {
      await store.unlockPin(document.getElementById("authPin").value.trim());
      authDone();
    } catch (e) {
      document.getElementById("authErr").textContent =
        e.message === "wrong key" ? "Неверный ПИН" : e.message;
    }
  };
  document.getElementById("authGo").onclick = go;
  document.getElementById("authPin").addEventListener("keydown", e => { if (e.key === "Enter") go(); });
  document.getElementById("authRecover").onclick = screenRecover;
}
// First launch ("setup") or legacy migration ("migrate"): pick a PIN first.
function screenNewPin(infoHtml) {
  authBox(`
    <div class="authwrap">
      <div class="authico"><span class="msrc">fingerprint</span></div>
      <div class="autht">Придумайте ПИН</div>
      ${infoHtml}
      <div class="field"><label>ПИН (4–6 цифр)</label><input id="authPin1" class="authpin" type="password" inputmode="numeric" maxlength="6" placeholder="••••" autocomplete="off"></div>
      <div class="field"><label>Ещё раз</label><input id="authPin2" class="authpin" type="password" inputmode="numeric" maxlength="6" placeholder="••••" autocomplete="off"></div>
      <div id="authErr" class="autherr"></div>
      <button class="btn" id="authGo"><span class="msrc">arrow_forward</span>Далее</button>
    </div>`);
  document.getElementById("authGo").onclick = async () => {
    const p1 = document.getElementById("authPin1").value.trim();
    const p2 = document.getElementById("authPin2").value.trim();
    const err = document.getElementById("authErr");
    if (!C.validPin(p1)) { err.textContent = "ПИН: 4–6 цифр"; return; }
    if (p1 !== p2) { err.textContent = "ПИН не совпадает"; return; }
    try {
      store._tmpKey = await C.genMasterKey();
      await screenPhrase(p1);
    } catch (e) { err.textContent = e.message; }
  };
}
// The 24-word phrase is shown ONCE here (and re-viewable later in Settings).
async function screenPhrase(pin) {
  const words = await C.keyToMnemonic(await C.keyBytesOf(store._tmpKey));
  authBox(`
    <div class="authwrap">
      <div class="authico"><span class="msrc">key</span></div>
      <div class="autht">Фраза восстановления</div>
      <div class="authh">Скопируйте эти 24 слова и сохраните в надёжном месте.
        Если вы забудете ПИН, данные можно будет восстановить только по этой фразе.
        Никому её не показывайте и не отправляйте — с ней можно получить доступ к вашим данным.</div>
      <div class="phrase" id="phraseGrid">${words.map(w => `<span class="pw">${w}</span>`).join("")}</div>
      <button class="btn tonal" id="phCopy"><span class="msrc">copy</span>Скопировать фразу</button>
      <div class="setrow" style="margin-top:14px"><div class="lbl">Я сохранил(а) фразу</div>
        <label class="switch"><input type="checkbox" id="phSaved"><span class="sl"></span></label></div>
      <div id="authErr" class="autherr"></div>
      <button class="btn" id="phDone" disabled><span class="msrc">check</span>Готово</button>
    </div>`);
  document.getElementById("phCopy").onclick = async () => {
    try { await navigator.clipboard.writeText(words.join(" ")); snackbar("Фраза скопирована"); }
    catch (e) { snackbar("Скопируйте слова вручную"); }
  };
  document.getElementById("phSaved").onchange = (e) => {
    document.getElementById("phDone").disabled = !e.target.checked;
  };
  document.getElementById("phDone").onclick = async () => {
    const done = document.getElementById("phDone");
    done.disabled = true;
    try {
      if (authCtx.mode === "migrate") {
        const st = M.normalizeExport(authCtx.legacyExport);
        if (state.user && state.user.first_name && !st.settings.username)
          st.settings.username = state.user.first_name;
        await store.firstSave(pin, store._tmpKey, st);
        // mark the legacy DB migrated (30-day undo window on the server);
        // if this fails the blob is already safe, the marker can be set later
        try { await store.http("POST", "/api/migration_complete"); } catch (e) { /* ignore */ }
      } else {
        const st = M.freshState();
        if (state.user && state.user.first_name) st.settings.username = state.user.first_name;
        await store.firstSave(pin, store._tmpKey, st);
      }
      store._tmpKey = null;
      authDone();
      snackbar("Готово! Данные зашифрованы и сохранены");
    } catch (e) {
      document.getElementById("authErr").textContent = e.message;
      done.disabled = false;
    }
  };
}
// Forgot PIN: enter the 24 words, then set a new PIN (phrase stays the same).
function screenRecover() {
  authBox(`
    <div class="authwrap">
      <div class="authico"><span class="msrc">restore</span></div>
      <div class="autht">Восстановление по фразе</div>
      <div class="authh">Введите 24 слова фразы восстановления — в любом порядке ввода,
        построчно или через запятую. Затем задайте новый ПИН.</div>
      <textarea id="authPhrase" class="authphrase" rows="6" placeholder="abandon ability able …" autocomplete="off"></textarea>
      <div id="authErr" class="autherr"></div>
      <button class="btn" id="authGo"><span class="msrc">arrow_forward</span>Далее</button>
    </div>`);
  document.getElementById("authGo").onclick = async () => {
    const words = C.parsePhrase(document.getElementById("authPhrase").value);
    const err = document.getElementById("authErr");
    try {
      await store.unlockPhrase(words);
      authBox(`
        <div class="authwrap">
          <div class="authico"><span class="msrc">fingerprint</span></div>
          <div class="autht">Данные восстановлены</div>
          <div class="authh">Фраза верна. Задайте новый ПИН для входа — фраза восстановления при этом не меняется.</div>
          <div class="field"><label>Новый ПИН (4–6 цифр)</label><input id="authPin1" class="authpin" type="password" inputmode="numeric" maxlength="6" placeholder="••••" autocomplete="off"></div>
          <div class="field"><label>Ещё раз</label><input id="authPin2" class="authpin" type="password" inputmode="numeric" maxlength="6" placeholder="••••" autocomplete="off"></div>
          <div id="authErr2" class="autherr"></div>
          <button class="btn" id="authGo2"><span class="msrc">check</span>Готово</button>
        </div>`);
      document.getElementById("authGo2").onclick = async () => {
        const p1 = document.getElementById("authPin1").value.trim();
        const p2 = document.getElementById("authPin2").value.trim();
        const err2 = document.getElementById("authErr2");
        if (!C.validPin(p1)) { err2.textContent = "ПИН: 4–6 цифр"; return; }
        if (p1 !== p2) { err2.textContent = "ПИН не совпадает"; return; }
        try {
          await store.setPin(p1);
          authDone();
        } catch (e) { err2.textContent = e.message; }
      };
    } catch (e) {
      err.textContent = e.message === "wrong key" ? "Неверная фраза" : e.message;
    }
  };
}

// ------------------------------------------------------------------- api ---
// The UI calls api(method, path, body, query) exactly like the old server
// API; this routes reads to MALogic over store.state and persists mutations
// as a re-encrypted blob (store.mutate). Same response shapes as app.py.
async function api(method, path, body, query) {
  if (!store.state) throw new Error("Приложение заблокировано");
  const q = query || {};
  const S = store.state;
  const T = store.today;
  const num = v => (v == null || v === "" ? null : Number(v));
  if (method === "GET") {
    switch (path) {
      case "/api/bootstrap":
        return { ok: true, settings: S.settings, categories: M.listCats(S).categories };
      case "/api/summary":
        return M.summary(S, { start: num(q.start) || 0, end: num(q.end) || 0,
                              mode: q.mode || "month", year: num(q.year), month: num(q.month) });
      case "/api/transactions":
        return M.listTx(S, { type: q.type || null, category: q.category || null,
                             payment: q.payment || null, q: q.q != null ? q.q : null,
                             start: num(q.start), end: num(q.end) });
      case "/api/categories": return M.listCats(S);
      case "/api/goals": return M.listGoals(S, T);
      case "/api/budget": return M.budget(S, num(q.year) || 0, num(q.month) || 0);
      case "/api/budget_templates": return M.listTemplates(S);
      case "/api/analytics": return M.analytics(S, num(q.year) || NOW.getFullYear(), T);
      case "/api/settings": return { ok: true, settings: S.settings };
      case "/api/export": return M.toExport(S);
    }
    throw new Error("no route: " + path);
  }
  let op = null;
  if (method === "POST" && path === "/api/transactions") op = () => M.addTx(S, body);
  else if (method === "PUT" && path.startsWith("/api/transactions/")) {
    const id = path.slice("/api/transactions/".length);
    op = () => M.updateTx(S, id, body);
  }
  else if (method === "DELETE" && path === "/api/transactions") op = () => M.deleteTx(S, q.id);
  else if (method === "POST" && path === "/api/categories") op = () => M.addCat(S, body);
  else if (method === "PUT" && path === "/api/categories") op = () => M.updateCat(S, q.name, q.type, body);
  else if (method === "DELETE" && path === "/api/categories") op = () => M.deleteCat(S, q.name, q.type);
  else if (method === "POST" && path === "/api/goals") op = () => M.addGoal(S, body);
  else if (method === "PUT" && path === "/api/goals") op = () => M.updateGoal(S, q.id, body);
  else if (method === "DELETE" && path === "/api/goals") op = () => M.deleteGoal(S, q.id);
  else if (method === "POST" && path === "/api/goals_contribute") op = () => M.contribute(S, q.id, body, T);
  else if (method === "POST" && path === "/api/budget/cap") op = () => M.setCap(S, body);
  else if (method === "POST" && path === "/api/budget/plan") op = () => M.upsertPlan(S, body);
  else if (method === "DELETE" && path === "/api/budget/plan") op = () => M.deletePlan(S, num(q.year), num(q.month), q.category, q.type);
  else if (method === "PUT" && path === "/api/budget_templates") op = () => M.upsertTemplate(S, body);
  else if (method === "PUT" && path === "/api/settings") op = () => {
    const allowed = ["username", "currencySymbol", "themeMode", "budgetCopyPrevMonth"];
    for (const k of allowed) if (k in body) S.settings[k] = body[k];
    return { ok: true, settings: S.settings };
  };
  else if (method === "POST" && path === "/api/import") op = () => M.importBackup(S, body);
  if (!op) throw new Error("no route: " + method + " " + path);
  return store.mutate(op);
}

// --------------------------------------------------------------- theming ---
function applyTheme(mode) {
  let dark = true;
  if (mode === "light") dark = false;
  else if (mode === "dark") dark = true;
  else dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.body.dataset.theme = dark ? "dark" : "light";
  document.querySelector('meta[name=theme-color]').content = dark ? "#0F1115" : "#F5F7FA";
  if (tg) { try { tg.setHeaderColor(dark ? "#0F1115" : "#F5F7FA"); } catch (e) {} }
}
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change",
  () => { if ((state.settings.themeMode || "system") === "system") applyTheme("system"); });

// -------------------------------------------------------------- snackbar ---
let snTimer = null;
function snackbar(msg) {
  const el = document.getElementById("snackbar");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(snTimer);
  snTimer = setTimeout(() => el.classList.add("hidden"), 3200);
}

// -------------------------------------------------------- sheet / dialog ---
function openSheet(html) {
  const ov = document.getElementById("overlay");
  const sh = document.getElementById("sheet");
  sh.innerHTML = '<div class="grab"></div>' + html;
  sh.style.transform = "";
  sh.style.transition = "";
  document.getElementById("dialog").classList.add("hidden");
  ov.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  makeSheetHandleDraggable(sh);
  return sh;
}
// v1.11.7: the sheet collapses only when the top handle is dragged down
// (like the APK): a swipe on the sheet body no longer affects it.
function makeSheetHandleDraggable(sh) {
  const grab = sh.querySelector(".grab");
  if (!grab) return;
  let startY = null, dy = 0;
  grab.addEventListener("pointerdown", (e) => {
    startY = e.clientY;
    dy = 0;
    try { grab.setPointerCapture(e.pointerId); } catch (_) {}
    sh.style.transition = "none";
  });
  grab.addEventListener("pointermove", (e) => {
    if (startY === null) return;
    dy = Math.max(0, e.clientY - startY);
    sh.style.transform = "translateY(" + dy + "px)";
  });
  const finish = () => {
    if (startY === null) return;
    startY = null;
    if (dy > 60) {
      closeSheet();
    } else {
      sh.style.transition = "transform 0.2s ease";
      sh.style.transform = "";
    }
    dy = 0;
  };
  grab.addEventListener("pointerup", finish);
  grab.addEventListener("pointercancel", finish);
}
function closeSheet() {
  const sh = document.getElementById("sheet");
  sh.style.transform = "";
  sh.style.transition = "";
  document.getElementById("overlay").classList.add("hidden");
  sh.innerHTML = "";
  document.body.style.overflow = "";
}
function closeDialog() {
  // Hides the dialog AND the overlay: the overlay (fixed, full-screen)
  // otherwise stays behind a closed dialog and intercepts all taps.
  document.getElementById("dialog").classList.add("hidden");
  document.getElementById("overlay").classList.add("hidden");
  document.body.style.overflow = "";
}
function dialog(opts) {
  // opts: {title, text, fields:[{id,label,type,value,placeholder,inputclass}], buttons:[{label,cls,onclick}]}
  const dv = document.getElementById("dialog");
  const ov = document.getElementById("overlay");
  let h = `<h3>${esc(opts.title)}</h3>`;
  if (opts.text) h += `<div class="txt">${opts.text}</div>`;
  if (opts.body) h += opts.body;
  if (opts.fields) {
    for (const f of opts.fields) {
      h += `<div class="field"><label>${esc(f.label)}</label><input id="dlg_${f.id}" type="${f.type || "text"}" class="${f.cls || ""}" value="${esc(f.value ?? "")}" placeholder="${esc(f.placeholder || "")}"></div>`;
    }
  }
  h += '<div class="actions">';
  for (const b of (opts.buttons || [])) {
    h += `<button class="dbtn ${b.cls || ""}" data-act="${b.act}">${esc(b.label)}</button>`;
  }
  h += "</div>";
  dv.innerHTML = h;
  dv.classList.remove("hidden");
  ov.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  for (const b of (opts.buttons || [])) {
    const el = dv.querySelector(`[data-act="${b.act}"]`);
    if (el) el.onclick = () => {
      const vals = {};
      for (const f of (opts.fields || [])) vals[f.id] = dv.querySelector(`#dlg_${f.id}`).value;
      if (b.getVals) b.getVals(vals);
      b.onclick && b.onclick(vals);
      if (b.close !== false) closeDialog();
    };
  }
  return dv;
}

// ------------------------------------------------------------- navigation --
const TITLES = { dashboard: "Дашборд", operations: "Операции", budget: "Бюджет", goals: "Цели", analytics: "Анализ" };

function showTab(tab) {
  state.tab = tab;
  state.sub = null;
  document.body.classList.remove("nobnav");
  for (const s of document.querySelectorAll(".screen")) s.classList.remove("active");
  document.getElementById("screen-" + tab).classList.add("active");
  document.getElementById("topTitle").textContent = TITLES[tab];
  document.getElementById("settingsBtn").classList.remove("hidden");
  document.getElementById("backBtn").classList.add("hidden");
  document.querySelectorAll(".navitem").forEach(n => n.classList.toggle("active", n.dataset.tab === tab));
  const showFab = (tab === "dashboard" || tab === "operations");
  document.getElementById("fab").classList.toggle("hidden", !showFab);
  refresh();
}
function openSub(name) {
  state.sub = name;
  document.body.classList.add("nobnav");
  for (const s of document.querySelectorAll(".screen")) s.classList.remove("active");
  document.getElementById("screen-" + name).classList.add("active");
  document.getElementById("topTitle").textContent = name === "settings" ? "Настройки" : "Категории";
  document.getElementById("settingsBtn").classList.add("hidden");
  document.getElementById("backBtn").classList.remove("hidden");
  refresh();
}
function refresh() {
  const s = state.sub || state.tab;
  ({ dashboard: renderDashboard, operations: renderOperations, budget: renderBudget,
     goals: renderGoals, analytics: renderAnalytics, settings: renderSettings,
     categories: renderCategories }[s])();
}

document.querySelectorAll(".navitem").forEach(n => n.onclick = () => showTab(n.dataset.tab));
document.getElementById("settingsBtn").onclick = () => openSub("settings");
document.getElementById("backBtn").onclick = () => showTab(state.tab);
document.getElementById("fab").onclick = () => openTxSheet(null);
document.getElementById("overlay").onclick = (e) => { if (e.target.id === "overlay") closeSheet(); };

// ================================================================ DASH ====
async function renderDashboard() {
  const el = document.getElementById("screen-dashboard");
  const p = state.period;
  const [start, end] = periodRange(p);
  el.innerHTML = `<div class="loading" style="padding:40px;text-align:center;color:var(--on-surface-var)">Загрузка…</div>`;
  try {
    const s = await api("GET", "/api/summary", null,
      { start, end, mode: p.mode, year: p.year, month: p.month });
    const cap = s.cap;
    let capHtml = "";
    if (p.mode === "month" && cap.state !== "Disabled" && cap.info) {
      const info = cap.info;
      let statusTxt = "", statusCls = "";
      if (cap.state === "Ready") {
        const st = info.status;
        statusTxt = st === "OVER" ? "Лимит превышен" : st === "CLOSE" ? "Близко к лимиту" : "В норме";
        statusCls = st === "OVER" ? "var(--expense-text)" : st === "CLOSE" ? "var(--warning-text)" : "var(--income-text)";
      } else if (cap.state === "AwaitingIncome") {
        statusTxt = "Ждём доходы"; statusCls = "var(--warning-text)";
      } else {
        statusTxt = "По медиане"; statusCls = "var(--warning-text)";
      }
      const pct = info.capKopecks > 0 ? Math.min(150, info.spentKopecks * 100 / info.capKopecks) : 0;
      const barColor = cap.state === "Ready"
        ? (info.status === "OVER" ? "var(--expense)" : info.status === "CLOSE" ? "var(--warning)" : "var(--income)")
        : "var(--warning)";
      let footer = "";
      if (cap.state === "Ready") {
        footer = info.spentKopecks > info.capKopecks
          ? `Превышение ${fmtMoney(info.spentKopecks - info.capKopecks)} • ${Math.round(info.spentKopecks * 100 / info.capKopecks)}%`
          : `Осталось ${fmtMoney(info.capKopecks - info.spentKopecks)} • ${Math.round(pct)}%`;
      } else if (cap.state === "AwaitingIncome") {
        footer = `Лимит = ${Math.round(info.pct)}% дохода за месяц.`;
      } else {
        footer = `Лимит = ${Math.round(info.pct)}% от медианного дохода за год (${fmtMoney(info.medianIncomeKopecks)}).`;
      }
      capHtml = `
        <div class="card">
          <div class="row-between">
            <div class="card-title">Лимит на месяц</div>
            <div class="capstat" style="color:${statusCls}">${statusTxt}</div>
          </div>
          <div class="nums" style="margin-top:10px;font-weight:600;font-size:14px">${cap.state === "AwaitingIncome" ? "" : fmtMoney(info.spentKopecks) + " / " + fmtMoney(info.capKopecks)}</div>
          <div class="progress" style="margin-top:8px"><div style="width:${pct}%;background:${barColor}"></div></div>
          <div class="footer-note" style="${cap.state === "Ready" && info.status === "OVER" ? "color:var(--expense-text)" : ""}">${footer}</div>
        </div>`;
    }
    const bd = s.categoryBreakdown;
    let bdHtml = bd.length === 0
      ? `<div class="empty" style="padding:24px 0"><div class="box"><span class="msrc">pie_chart</span></div>
          <div class="t">Нет расходов за этот месяц</div>
          <div class="h">Добавьте операции — здесь появится структура затрат</div></div>`
      : `<div class="breakdown-row">` + bd.slice(0, 7).map(c => {
          const t = tintOf(c.category);
          return `<div>
            <div class="r1">
              <div class="ic" style="background:${hexA(t, 0.14)};color:${t}"><span class="msrc">${catIcon(c.category)}</span></div>
              <div class="nm">${esc(c.category)}</div>
              <div class="am">${fmtMoney(c.amountKopecks)}</div>
            </div>
            <div class="progress thin"><div style="width:${c.percent}%;background:${t}"></div></div>
          </div>`;
        }).join("") + `</div>`;
    const lbl = p.mode === "month" ? MONTHS_FULL[p.month - 1] : String(p.year);
    el.innerHTML = `
      <div class="stepper">
        <button class="iconbtn" id="pPrev" aria-label="Предыдущий период"><span class="msrc">chevron_left</span></button>
        <div class="mid"><div class="m">${p.mode === "month" ? MONTHS_FULL[p.month - 1] : p.year}</div>
        <div class="y">${p.mode === "month" ? p.year : ""}</div></div>
        <button class="iconbtn" id="pNext" aria-label="Следующий период"><span class="msrc">chevron_right</span></button>
      </div>
      <div class="chiprow-toggle">
        <button class="chip ${p.mode === "month" ? "active" : ""}" id="pmMonth">Месяц</button>
        <button class="chip ${p.mode === "year" ? "active" : ""}" id="pmYear">Год</button>
      </div>
      <div class="hero">
        <div class="chiprow">
          <div class="wallet-chip"><span class="msrc">wallet</span></div>
          <div class="label">Остаток</div>
        </div>
        <div class="value">${fmtMoney(s.balanceKopecks)}</div>
      </div>
      <div class="kpigrid">
        <div class="kpicard"><div class="top"><span class="msrc" style="color:var(--income-text)">trending_up</span><span class="t">Доходы</span></div>
          <div class="val" style="color:var(--income-text)">${fmtMoney(s.period.income)}</div></div>
        <div class="kpicard"><div class="top"><span class="msrc" style="color:var(--warning-text)">percent</span><span class="t">Норма</span></div>
          <div class="val">${Math.round(s.savingsRate)}%</div></div>
        <div class="kpicard"><div class="top"><span class="msrc" style="color:var(--expense-text)">trending_down</span><span class="t">Расходы</span></div>
          <div class="val" style="color:var(--expense-text)">${fmtMoney(s.period.expenses)}</div></div>
        <div class="kpicard"><div class="top"><span class="msrc" style="color:var(--savings-text)">savings</span><span class="t">Отложено</span></div>
          <div class="val" style="color:var(--savings-text)">${fmtMoney(s.savingsNetKopecks)}</div></div>
      </div>
      ${capHtml}
      <div class="card">
        <div class="card-row"><span class="card-title"><span class="msrc">receipt_long</span>Сводка за ${lbl}</span></div>
        <div class="tricol">
          <div><div class="l" style="color:var(--income-text)">Доход</div><div class="v">${fmtMoney(s.period.income)}</div></div>
          <div><div class="l" style="color:var(--expense-text)">Расход</div><div class="v">${fmtMoney(s.period.expenses)}</div></div>
          <div><div class="l" style="color:var(--savings-text)">Отложено</div><div class="v">${fmtMoney(s.savingsNetKopecks)}</div></div>
        </div>
      </div>
      <div class="card">
        <div class="card-row"><span class="card-title"><span class="msrc">pie_chart</span>Расходы по категориям</span></div>
        ${bdHtml}
      </div>`;
    const step = (dir) => {
      const p = state.period;
      if (p.mode === "month") {
        let m = p.month + dir, y = p.year;
        if (m < 1) { m = 12; y--; } if (m > 12) { m = 1; y++; }
        p.month = m; p.year = y;
      } else p.year += dir;
      renderDashboard();
    };
    el.querySelector("#pPrev").onclick = () => step(-1);
    el.querySelector("#pNext").onclick = () => step(1);
    el.querySelector("#pmMonth").onclick = () => { state.period.mode = "month"; renderDashboard(); };
    el.querySelector("#pmYear").onclick = () => { state.period.mode = "year"; renderDashboard(); };
  } catch (e) {
    el.innerHTML = errBox(e);
  }
}
function hexA(hex, a) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}
function errBox(e) {
  return `<div class="empty"><div class="box"><span class="msrc">error</span></div>
    <div class="t">Ошибка</div><div class="h">${esc(e.message)}</div></div>`;
}

// ============================================================== OPS ========
async function renderOperations() {
  const el = document.getElementById("screen-operations");
  el.innerHTML = `<div class="loading" style="padding:40px;text-align:center;color:var(--on-surface-var)">Загрузка…</div>`;
  const f = state.filters;
  let txs;
  try {
    txs = (await api("GET", "/api/transactions", null,
      { type: f.type, q: f.q, start: f.start, end: f.end })).transactions;
  } catch (e) { el.innerHTML = errBox(e); return; }
  state.tx = txs;
  const fchips = (active, id, label, icon, cls) =>
    `<button class="chip ${cls || ""} ${active ? "active" : ""}" data-fchip="${id}">${icon ? `<span class="msrc">${icon}</span>` : ""}${label}</button>`;
  el.innerHTML = `
    <div class="searchbar"><span class="msrc">search</span>
      <input id="opSearch" placeholder="Поиск по описанию" value="${esc(f.q)}"></div>
    <div class="chips-scroll">
      ${fchips(!f.type && f.start == null && f.end == null, "all", "Все")}
      ${fchips(f.type === "INCOME", "INCOME", "Доход", "trending_up", "type-in")}
      ${fchips(f.type === "EXPENSE", "EXPENSE", "Расход", "trending_down", "type-exp")}
      ${fchips(f.type === "SAVINGS", "SAVINGS", "Копилка", "savings", "type-sav")}
      ${fchips(f.type === "SAVINGS_SPEND", "SAVINGS_SPEND", "Из накоплений", "paid", "type-sav")}
      ${fchips(f.start != null || f.end != null, "dates", "Даты", "calendar_month")}
    </div>
    <div id="opList"></div>`;
  el.querySelector("#opSearch").oninput = (e) => {
    f.q = e.target.value;
    renderOpList();
  };
  el.querySelectorAll("[data-fchip]").forEach(b => b.onclick = () => {
    const id = b.dataset.fchip;
    if (id === "all") { f.type = null; f.start = null; f.end = null; renderOperations(); }
    else if (id === "dates") { openDateDialog(); }
    else {
      f.type = f.type === id ? null : id;
      renderOperations();
    }
  });
  renderOpList();
}
function renderOpList() {
  const listEl = document.getElementById("opList");
  if (!listEl) return;
  const txs = state.tx;
  if (!txs.length) {
    listEl.innerHTML = `<div class="empty"><div class="box"><span class="msrc">search</span></div>
      <div class="t">Нет транзакций</div>
      <div class="h">Нажмите «Добавить», чтобы записать первую операцию</div></div>`;
    return;
  }
  const groups = new Map();
  for (const t of txs) {
    if (!groups.has(t.date)) groups.set(t.date, []);
    groups.get(t.date).push(t);
  }
  let html = "";
  const t0 = todayEpoch();
  for (const [d, arr] of groups) {
    let net = 0;
    for (const t of arr) net += t.type === "INCOME" ? t.amountKopecks : -t.amountKopecks;
    html += `<div class="dayhdr"><div class="d">${dayLabel(d)}</div><div class="n">${fmtMoney(net)}</div></div>`;
    for (const t of arr) {
      const tint = tintOf(t.category);
      const main = t.description || t.category;
      html += `<div class="tx" data-id="${t.id}">
        <div class="ico" style="background:${hexA(tint, 0.14)};color:${tint}"><span class="msrc">${catIcon(t.category)}</span></div>
        <div class="body"><div class="main">${esc(main)}</div>
        ${t.description ? `<div class="sub">${esc(t.category)}${t.paymentMethod === "CASH" ? " • Наличные" : ""}</div>` : `<div class="sub">${t.paymentMethod === "CASH" ? "Наличные" : ""}</div>`}</div>
        <div class="amt" style="color:${TYPE_COLOR[t.type]}">${t.type === "INCOME" ? "+" : "−"}${fmtMoney(t.amountKopecks).replace(" ₽", "")} ₽</div>
      </div>`;
    }
  }
  listEl.innerHTML = html;
  listEl.querySelectorAll(".tx").forEach(r => r.onclick = () => {
    const t = state.tx.find(x => x.id === r.dataset.id);
    if (t) openTxSheet(t);
  });
}
function openDateDialog() {
  const f = state.filters;
  const cur = fromEpochDay(todayEpoch());
  dialog({
    title: "Даты",
    body: `
      <div class="setrow"><div class="lbl">От</div><input type="date" id="dlg_from" class="inline" value="${f.start != null ? isoDate(f.start) : ""}"></div>
      <div class="setrow"><div class="lbl">До</div><input type="date" id="dlg_to" class="inline" value="${f.end != null ? isoDate(f.end) : ""}"></div>`,
    buttons: [
      { label: "Сбросить", cls: "", act: "reset", onclick: () => { f.start = null; f.end = null; renderOperations(); } },
      { label: "Отмена", cls: "", act: "cancel", onclick: () => {} },
      { label: "OK", cls: "", act: "ok", getVals: (v) => {}, onclick: (vals) => {
          const dv = document.getElementById("dialog");
          const from = dv.querySelector("#dlg_from").value;
          const to = dv.querySelector("#dlg_to").value;
          let a = from ? epochDay(+from.slice(0, 4), +from.slice(5, 7), +from.slice(8, 10)) : null;
          let b = to ? epochDay(+to.slice(0, 4), +to.slice(5, 7), +to.slice(8, 10)) : null;
          if (a != null && b != null && a > b) [a, b] = [b, a];
          f.start = a; f.end = b;
          renderOperations();
        } },
    ],
  });
}

// ------------------------------------------------------- add/edit sheet ----
function openTxSheet(tx) {
  state.sheetTxId = tx ? tx.id : null;
  const editing = !!tx;
  const type = tx ? tx.type : "EXPENSE";
  let curType = type; // v1.11.2: follows the active type tab (was a stale const)
  const cats = state.categories.filter(c => c.type === catTypeFor(type) && (c.isVisible !== 0));
  selCat = tx ? tx.category : (cats[0] ? cats[0].name : "");
  const amount = tx ? String(Math.floor(tx.amountKopecks / 100)) : "";
  const date = tx ? isoDate(tx.date) : isoDate(todayEpoch());
  const sh = openSheet(`
    <div class="row-between">
      <h2 style="margin:0">${editing ? "Изменить транзакцию" : "Новая транзакция"}</h2>
      <button class="iconbtn" id="shClose" aria-label="Закрыть"><span class="msrc">close</span></button>
    </div>
    <div class="field"><label>Сумма (₽)</label>
      <input id="shAmount" class="amount" inputmode="numeric" placeholder="0" value="${esc(amount)}"></div>
    <div class="seg2x2" id="shType">
      <div class="seg"><button data-t="INCOME" class="${type === "INCOME" ? "active" : ""}"><span class="msrc">trending_up</span>Доход</button><button data-t="EXPENSE" class="${type === "EXPENSE" ? "active" : ""}"><span class="msrc">trending_down</span>Расход</button></div>
      <div class="seg"><button data-t="SAVINGS" class="${type === "SAVINGS" ? "active" : ""}"><span class="msrc">savings</span>Копилка</button><button data-t="SAVINGS_SPEND" class="${type === "SAVINGS_SPEND" ? "active" : ""}"><span class="msrc">paid</span>Из накоплений</button></div>
    </div>
    <div class="field"><label>Категория</label>
      <div class="catflow" id="shCats"></div></div>
    <div class="seg" id="shPay">
      <button data-p="CARD" class="${(tx ? tx.paymentMethod : "CARD") === "CARD" ? "active" : ""}"><span class="msrc">credit_card</span>Безнал</button>
      <button data-p="CASH" class="${tx && tx.paymentMethod === "CASH" ? "active" : ""}"><span class="msrc">money</span>Наличные</button>
    </div>
    <div class="field"><label>Дата</label><input id="shDate" type="date" value="${date}"></div>
    <div class="field"><label>Описание</label><input id="shDesc" value="${esc(tx ? tx.description : "")}"></div>
    <div class="field"><label>Примечание</label><textarea id="shNote" rows="2">${esc(tx ? tx.note || "" : "")}</textarea></div>
    <button class="btn" id="shSave" disabled><span class="msrc">check</span>${editing ? "Сохранить изменения" : "Сохранить"}</button>
    ${editing ? `<div class="btnrow"><button class="btn danger" id="shDel"><span class="msrc">delete</span>Удалить</button></div>` : ""}
  `);
  function renderCats() {
    const el = sh.querySelector("#shCats");
    const list = state.categories.filter(c => c.type === catTypeFor(curType) && c.isVisible !== 0);
    el.innerHTML = list.map(c => {
      const t = tintOf(c.name);
      return `<button class="catchip ${selCat === c.name ? "active" : ""}" data-c="${esc(c.name)}" style="--tint:${t}">
        <span class="msrc">${catIcon(c.name)}</span>${esc(c.name)}</button>`;
    }).join("") + `<button class="catchip" id="shCatAdd"><span class="msrc">add</span>Добавить</button>`;
    el.querySelectorAll("[data-c]").forEach(b => b.onclick = () => { selCat = b.dataset.c; renderCats(); });
    el.querySelector("#shCatAdd").onclick = () => quickAddCategory(catTypeFor(curType));
  }
  function updSave() {
    const amt = sh.querySelector("#shAmount").value;
    sh.querySelector("#shSave").disabled = !(amt && selCat);
  }
  renderCats();
  sh.querySelector("#shAmount").oninput = (e) => { e.target.value = e.target.value.replace(/\D/g, ""); updSave(); };
  updSave();
  sh.querySelectorAll("#shType button").forEach(b => b.onclick = () => {
    sh.querySelectorAll("#shType button").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    const t = b.dataset.t;
    curType = t;
    const list = state.categories.filter(c => c.type === catTypeFor(t) && c.isVisible !== 0);
    selCat = list[0] ? list[0].name : "";
    renderCats(); updSave();
  });
  sh.querySelectorAll("#shPay button").forEach(b => b.onclick = () => {
    sh.querySelectorAll("#shPay button").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
  });
  sh.querySelector("#shClose").onclick = closeSheet;
  sh.querySelector("#shSave").onclick = async () => {
    const amt = parseInt(sh.querySelector("#shAmount").value, 10);
    const dv = sh.querySelector("#shDate").value;
    const body = {
      type: sh.querySelector("#shType .active").dataset.t,
      category: selCat,
      description: sh.querySelector("#shDesc").value.trim(),
      amountKopecks: amt * 100,
      paymentMethod: sh.querySelector("#shPay .active").dataset.p,
      note: sh.querySelector("#shNote").value.trim() || null,
      date: dv ? epochDay(+dv.slice(0, 4), +dv.slice(5, 7), +dv.slice(8, 10)) : todayEpoch(),
    };
    try {
      if (state.sheetTxId) await api("PUT", "/api/transactions/" + state.sheetTxId, body);
      else await api("POST", "/api/transactions", body);
      closeSheet();
      snackbar(editing ? "Транзакция обновлена" : "Транзакция добавлена");
      refresh();
    } catch (e) { snackbar(e.message); }
  };
  const del = sh.querySelector("#shDel");
  if (del) del.onclick = () => {
    dialog({
      title: "Удалить транзакцию?",
      text: esc(tx.description || tx.category),
      buttons: [
        { label: "Отмена", cls: "", act: "c", onclick: () => {} },
        { label: "Удалить", cls: "danger", act: "d", onclick: async () => {
            try {
              await api("DELETE", "/api/transactions", null, { id: state.sheetTxId });
              closeSheet(); snackbar("Удалено"); refresh();
            } catch (e) { snackbar(e.message); }
          } },
      ],
    });
  };
}
function quickAddCategory(type) {
  dialog({
    title: "Новая категория",
    text: `Будет добавлена к типу «${TYPE_LABEL[type]}»`,
    fields: [{ id: "name", label: "Название" }],
    buttons: [
      { label: "Отмена", cls: "", act: "c", onclick: () => {} },
      { label: "Добавить", cls: "", act: "a", onclick: async (vals) => {
          const name = vals.name.trim();
          if (!name) return;
          if (state.categories.some(c => c.type === type && c.name.toLowerCase() === name.toLowerCase())) {
            snackbar("Категория с таким названием уже есть"); return;
          }
          try {
            const r = await api("POST", "/api/categories", { type, name });
            state.categories = r.categories;
            const added = r.categories.find(c => c.type === type && c.name === name);
            if (added) { selCat = name; renderCatsLocal(); }
          } catch (e) { snackbar(e.message); }
        } },
    ],
  });
}
function renderCatsLocal() {
  const el = document.getElementById("shCats");
  if (!el) return;
  const type = document.querySelector("#shType .active")?.dataset.t;
  const list = state.categories.filter(c => c.type === type && c.isVisible !== 0);
  el.innerHTML = list.map(c => {
    const t = tintOf(c.name);
    return `<button class="catchip ${selCat === c.name ? "active" : ""}" data-c="${esc(c.name)}" style="--tint:${t}">
      <span class="msrc">${catIcon(c.name)}</span>${esc(c.name)}</button>`;
  }).join("") + `<button class="catchip" id="shCatAdd"><span class="msrc">add</span>Добавить</button>`;
  el.querySelectorAll("[data-c]").forEach(b => b.onclick = () => { selCat = b.dataset.c; renderCatsLocal(); });
  el.querySelector("#shCatAdd").onclick = () => quickAddCategory(type);
}

// =============================================================== BUDGET ====
async function renderBudget() {
  const el = document.getElementById("screen-budget");
  const bp = state.budgetPeriod;
  el.innerHTML = `<div class="loading" style="padding:40px;text-align:center;color:var(--on-surface-var)">Загрузка…</div>`;
  try {
    const b = await api("GET", "/api/budget", null, { year: bp.year, month: bp.month });
    paintBudget(b);
  } catch (e) { el.innerHTML = errBox(e); }
}

// Renders the budget screen from a /api/budget payload (used by renderBudget and
// by the plan dialog, whose POST/DELETE responses carry the fresh budget).
function paintBudget(b) {
  const el = document.getElementById("screen-budget");
  const bp = state.budgetPeriod;
  let capHtml = "";
    if (b.capState === "Disabled") {
      capHtml = `<div class="card">
        <div class="empty" style="padding:12px 0">
          <div class="box"><span class="msrc">receipt_long</span></div>
          <div class="t">Бюджет не настроен</div>
          <div class="h">Настройте лимит в Настройках или добавьте план</div>
        </div></div>`;
    } else if (b.capState === "AwaitingIncome") {
      capHtml = `<div class="card">
        <div class="row-between"><div class="card-title">Лимит на месяц</div>
        <div class="capstat" style="color:var(--warning-text)">Ждём доходы</div></div>
        <div class="footer-note">Лимит = ${Math.round(b.capInfo.pct)}% дохода за месяц. Он появится автоматически, как только за этот месяц будут записаны доходы.</div>
        <div class="footer-note">Расходовано за месяц: ${fmtMoney(b.capInfo.spentKopecks)}</div>
      </div>`;
    } else {
      const info = b.capInfo;
      const st = info.status;
      const statusTxt = st === "OVER" ? "Лимит превышен" : st === "CLOSE" ? "Близко к лимиту" : "В норме";
      const statusCls = st === "OVER" ? "var(--expense-text)" : st === "CLOSE" ? "var(--warning-text)" : "var(--income-text)";
      const pct = Math.min(150, info.spentKopecks * 100 / info.capKopecks);
      const barColor = st === "OVER" ? "var(--expense)" : st === "CLOSE" ? "var(--warning)" : "var(--income)";
      const note = b.capState === "MedianBased"
        ? `Доходы за этот месяц ещё не записаны. Лимит = ${Math.round(info.pct)}% от медианного дохода за год (${fmtMoney(info.medianIncomeKopecks)}).` : "";
      capHtml = `<div class="card">
        <div class="row-between"><div class="card-title">Лимит на месяц</div>
        <div class="capstat" style="color:${statusCls}">${statusTxt}</div></div>
        <div class="nums" style="margin-top:8px;font-size:16px;font-weight:600">${fmtMoney(info.spentKopecks)} / ${fmtMoney(info.capKopecks)} <span style="color:${statusCls};font-size:14px;font-weight:600">${Math.round(pct)}%</span></div>
        <div class="progress" style="margin-top:8px"><div style="width:${pct}%;background:${barColor}"></div></div>
        <div class="footer-note">${info.spentKopecks > info.capKopecks ? "Превышение " + fmtMoney(info.spentKopecks - info.capKopecks) : "Осталось " + fmtMoney(info.capKopecks - info.spentKopecks)}</div>
        ${note ? `<div class="footer-note">${note}</div>` : ""}
      </div>`;
    }
    const typeSec = (type, title) => {
      const plans = b.plans.filter(p => p.type === type);
      if (!plans.length) return "";
      const col = TYPE_COLOR[type];
      return `<div style="display:flex;align-items:center;gap:8px;margin:14px 0 8px">
        <span class="msrc" style="font-size:20px;color:${col}">${TYPE_ICON[type]}</span>
        <span style="font-size:16px;font-weight:700;color:${col}">${title}</span></div>` +
        plans.map(p => {
          const t = tintOf(p.category);
          const stIco = p.status === "OVER" ? ["error", "var(--expense-text)"]
            : p.status === "CLOSE" ? ["priority_high", "var(--warning-text)"]
            : p.status === "UNDER" ? ["trending_down", "var(--expense-text)"]
            : ["check", "var(--income-text)"];
          return `<div class="card plan-card" data-plan="${esc(p.category)}|${p.type}|${p.plannedKopecks}|${p.source}" style="cursor:pointer">
            <div class="r1">
              <div class="ic" style="background:${hexA(t, 0.14)};color:${t}"><span class="msrc">${catIcon(p.category)}</span></div>
              <div class="nm">${esc(p.category)}</div>
              <span class="st msrc" style="color:${stIco[1]}">${stIco[0]}</span>
              <div class="nums" style="color:${col}">${fmtMoney(p.actualKopecks)} / ${fmtMoney(p.plannedKopecks)}</div>
            </div>
            <div class="progress" style="margin-top:8px"><div style="width:${Math.min(100, p.pct)}%;background:${stIco[1] === "var(--income-text)" ? "var(--income)" : stIco[1] === "var(--warning-text)" ? "var(--warning)" : "var(--expense)"}"></div></div>
            <div class="ftr"><span style="color:${p.actualKopecks >= p.plannedKopecks ? "var(--income-text)" : "var(--expense-text)"}">Разница: ${p.actualKopecks >= p.plannedKopecks ? "+" : "−"}${fmtMoney(Math.abs(p.actualKopecks - p.plannedKopecks))}</span>
            <span style="color:${stIco[1]}">${Math.round(p.pct)}%</span></div>
          </div>`;
        }).join("");
    };
    el.innerHTML = `
      <div class="stepper">
        <button class="iconbtn" id="bPrev"><span class="msrc">chevron_left</span></button>
        <div class="mid"><div class="m">${MONTHS_FULL[bp.month - 1]}</div><div class="y">${bp.year}</div></div>
        <button class="iconbtn" id="bNext"><span class="msrc">chevron_right</span></button>
      </div>
      ${capHtml}
      <button class="btn tonal" id="bAddPlan" style="margin-bottom:8px"><span class="msrc">add</span>Добавить план</button>
      ${typeSec("INCOME", "Доходы")}
      ${typeSec("EXPENSE", "Расходы")}
      ${typeSec("SAVINGS", "Сбережения")}`;
    el.querySelector("#bPrev").onclick = () => {
      let m = bp.month - 1, y = bp.year;
      if (m < 1) { m = 12; y--; }
      bp.month = m; bp.year = y; renderBudget();
    };
    el.querySelector("#bNext").onclick = () => {
      let m = bp.month + 1, y = bp.year;
      if (m > 12) { m = 1; y++; }
      bp.month = m; bp.year = y; renderBudget();
    };
    el.querySelector("#bAddPlan").onclick = () => openPlanDialog(null);
    el.querySelectorAll("[data-plan]").forEach(c => c.onclick = () => {
      const [cat, type, amt, source] = c.dataset.plan.split("|");
      openPlanDialog({ cat, type, planned: parseInt(amt, 10) || 0,
                       source: source || "explicit" });
    });
}

function openPlanDialog(plan) {
  const editing = !!plan;
  let selType = plan ? plan.type : "EXPENSE";
  const cats = () => state.categories.filter(c => c.type === selType && c.isVisible !== 0);
  let selCat = plan ? plan.cat : (cats()[0] ? cats()[0].name : "");
  const dv = dialog({
    title: editing ? "Изменить план" : "Новый план",
    body: `
      <div class="seg" id="plType">
        <button data-t="INCOME" class="${selType === "INCOME" ? "active" : ""}">Доход</button>
        <button data-t="EXPENSE" class="${selType === "EXPENSE" ? "active" : ""}">Расход</button>
        <button data-t="SAVINGS" class="${selType === "SAVINGS" ? "active" : ""}">Сбережения</button>
      </div>
      <div class="field"><label>Категория</label><div class="catflow" id="plCats"></div></div>
      <div class="field"><label>План (₽)</label><input id="plAmt" class="num" inputmode="numeric" value="${plan ? Math.floor(plan.planned / 100) : ""}"></div>
      ${plan && plan.source === "template" ? `<div class="footer-note" style="margin-top:2px">План из шаблона по категориям. Сохранение задаст план только на этот месяц; сам шаблон (в Настройках) не изменится.</div>` : ""}
      ${plan && plan.source === "prev" ? `<div class="footer-note" style="margin-top:2px">План скопирован из прошлого месяца. Сохранение задаст план только на этот месяц.</div>` : ""}`,
    buttons: [
      { label: "Отмена", cls: "", act: "c", onclick: () => {} },
      { label: editing ? "Сохранить" : "Добавить", cls: "", act: "s", close: false, onclick: async () => {
          const amt = parseInt(dv.querySelector("#plAmt").value, 10);
          if (!selCat || !(amt > 0)) { snackbar("Заполните категорию и сумму"); return; }
          const btn = dv.querySelector(".dbtn[data-act='s']");
          btn.disabled = true; btn.textContent = "Сохраняю…";
          try {
            // the POST response carries the fresh budget — no extra GET needed
            const b = await api("POST", "/api/budget/plan", {
              year: state.budgetPeriod.year, month: state.budgetPeriod.month,
              category: selCat, type: selType, plannedAmountKopecks: amt * 100,
            });
            snackbar("План сохранён");
            closeDialog();
            paintBudget(b);
          } catch (e) {
            btn.disabled = false; btn.textContent = editing ? "Сохранить" : "Добавить";
            snackbar(e.message);
          }
        } },
      ...(editing && plan.source === "explicit" ? [{ label: "Удалить", cls: "danger", act: "d", close: false, onclick: async () => {
          const btn = dv.querySelector(".dbtn[data-act='d']");
          btn.disabled = true; btn.textContent = "Удаляю…";
          try {
            const b = await api("DELETE", "/api/budget/plan", null, {
              year: state.budgetPeriod.year, month: state.budgetPeriod.month,
              category: plan.cat, type: plan.type,
            });
            closeDialog();
            snackbar("План удалён");
            paintBudget(b);
          } catch (e) {
            btn.disabled = false; btn.textContent = "Удалить";
            snackbar(e.message);
          }
        } }] : []),
    ],
  });
  function renderCats() {
    const el = dv.querySelector("#plCats");
    el.innerHTML = cats().map(c => {
      const t = tintOf(c.name);
      return `<button class="catchip ${selCat === c.name ? "active" : ""}" data-c="${esc(c.name)}" style="--tint:${t}">
        <span class="msrc">${catIcon(c.name)}</span>${esc(c.name)}</button>`;
    }).join("");
    el.querySelectorAll("[data-c]").forEach(b => b.onclick = () => { selCat = b.dataset.c; renderCats(); });
  }
  dv.querySelectorAll("#plType button").forEach(b => b.onclick = () => {
    dv.querySelectorAll("#plType button").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    selType = b.dataset.t;
    selCat = cats()[0] ? cats()[0].name : "";
    renderCats();
  });
  renderCats();
}

// ================================================================= GOALS ====
async function renderGoals() {
  const el = document.getElementById("screen-goals");
  el.innerHTML = `<div class="loading" style="padding:40px;text-align:center;color:var(--on-surface-var)">Загрузка…</div>`;
  try {
    const r = await api("GET", "/api/goals");
    const goals = r.goals;
    if (!goals.length) {
      el.innerHTML = `<div class="empty"><div class="box"><span class="msrc">savings</span></div>
        <div class="t">Нет целей</div><div class="h">Создайте первую цель для накоплений</div></div>
        <div style="text-align:center;padding:8px 0"><button class="btn tonal" id="gNew" style="width:auto;padding:0 24px"><span class="msrc">add</span>Создать цель</button></div>`;
      el.querySelector("#gNew").onclick = () => goalDialog(null);
      return;
    }
    el.innerHTML = goals.map(g => {
      const st = g.status;
      const stIco = st === "COMPLETED" ? ["check", "var(--income-text)", "Выполнено"]
        : st === "OVERDUE" ? ["error", "var(--expense-text)", "Просрочено"]
        : ["hourglass_top", "var(--savings-text)", "В процессе"];
      const pct = Math.min(100, g.currentKopecks * 100 / Math.max(1, g.targetAmountKopecks));
      return `<div class="card" data-goal="${g.id}">
        <div class="row-between">
          <div style="flex:1;min-width:0">
            <div style="font-size:16px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(g.name)}</div>
            ${g.description ? `<div style="font-size:12px;color:var(--on-surface-var)">${esc(g.description)}</div>` : ""}
          </div>
          <div style="display:flex;align-items:center;gap:4px;font-size:11px;font-weight:700;color:${stIco[1]}">
            <span class="msrc">${stIco[0]}</span>${stIco[2]}</div>
        </div>
        <div style="margin-top:10px">
          <span style="font-size:16px;font-weight:600;color:${stIco[1]};font-variant-numeric:tabular-nums">${fmtMoney(g.currentKopecks)}</span>
          <span style="font-size:12px;color:var(--on-surface-var);font-variant-numeric:tabular-nums"> / ${fmtMoney(g.targetAmountKopecks)}</span>
        </div>
        <div class="progress" style="height:12px;margin-top:6px"><div style="width:${pct}%;background:var(--savings)"></div></div>
        <div class="ftr" style="display:flex;justify-content:space-between;margin-top:8px;font-size:12px;font-weight:500;color:var(--on-surface-var)">
          <span>${Math.round(pct)}% выполнено</span>
          <span>Срок: ${isoDate(g.deadline).split("-").reverse().join(".")}</span>
        </div>
        ${st === "IN_PROGRESS" ? `<div class="footer-note">Осталось: ${fmtMoney(Math.max(0, g.targetAmountKopecks - g.currentKopecks))}${g.recommendedMonthlyKopecks > 0 ? " • Рекоменд. взнос: " + fmtMoney(g.recommendedMonthlyKopecks) : ""}</div>` : ""}
        <div class="btnrow">
          <button class="btn tonal gContrib" data-id="${g.id}"><span class="msrc">savings</span>Внести</button>
          <button class="btn text gEdit" data-id="${g.id}"><span class="msrc">edit</span>Изменить</button>
          <button class="iconbtn gDel" data-id="${g.id}" style="color:var(--error)"><span class="msrc">delete</span></button>
        </div>
      </div>`;
    }).join("") +
    `<div style="text-align:center;padding:8px 0"><button class="btn tonal" id="gNew" style="width:auto;padding:0 24px"><span class="msrc">add</span>Создать цель</button></div>`;
    el.querySelector("#gNew").onclick = () => goalDialog(null);
    el.querySelectorAll(".gEdit").forEach(b => b.onclick = () => {
      const g = goals.find(x => x.id === b.dataset.id);
      if (g) goalDialog(g);
    });
    el.querySelectorAll(".gContrib").forEach(b => b.onclick = () => {
      const g = goals.find(x => x.id === b.dataset.id);
      if (g) contributeDialog(g);
    });
    el.querySelectorAll(".gDel").forEach(b => b.onclick = () => {
      const g = goals.find(x => x.id === b.dataset.id);
      if (!g) return;
      dialog({
        title: "Удалить цель?",
        text: `«${esc(g.name)}» будет удалена. Транзакции сохранятся.`,
        buttons: [
          { label: "Отмена", cls: "", act: "c", onclick: () => {} },
          { label: "Удалить", cls: "danger", act: "d", onclick: async () => {
              try { await api("DELETE", "/api/goals", null, { id: g.id }); snackbar("Цель удалена"); renderGoals(); }
              catch (e) { snackbar(e.message); }
            } },
        ],
      });
    });
  } catch (e) { el.innerHTML = errBox(e); }
}
function goalDialog(g) {
  const editing = !!g;
  dialog({
    title: editing ? "Изменить цель" : "Новая цель",
    fields: [
      { id: "name", label: "Название", value: g ? g.name : "" },
      { id: "desc", label: "Описание", value: g ? g.description : "" },
      { id: "target", label: "Целевая сумма (₽)", type: "number", cls: "num", value: g ? Math.floor(g.targetAmountKopecks / 100) : "" },
      { id: "deadline", label: "Срок (ГГГГ-ММ-ДД)", type: "date", value: g ? isoDate(g.deadline) : isoDate(todayEpoch() + 30) },
    ],
    buttons: [
      { label: "Отмена", cls: "", act: "c", onclick: () => {} },
      { label: editing ? "Сохранить" : "Создать", cls: "", act: "s", onclick: async (vals) => {
          const target = parseInt(vals.target, 10);
          if (!vals.name.trim() || !(target > 0)) { snackbar("Заполните название и сумму"); return; }
          const dv = document.getElementById("dialog");
          const dl = dv.querySelector("#dlg_deadline").value;
          const body = { name: vals.name.trim(), description: vals.desc, targetAmountKopecks: target * 100,
                         deadline: dl ? epochDay(+dl.slice(0, 4), +dl.slice(5, 7), +dl.slice(8, 10)) : todayEpoch() };
          try {
            if (editing) await api("PUT", "/api/goals", body, { id: g.id });
            else await api("POST", "/api/goals", body);
            snackbar(editing ? "Цель обновлена" : "Цель создана");
            closeDialog();
            renderGoals();
          } catch (e) { snackbar(e.message); }
        } },
    ],
  });
}
function contributeDialog(g) {
  dialog({
    title: `Взнос в ${g.name}`,
    text: `Накоплено: ${fmtMoney(g.currentKopecks)}<br>Осталось: ${fmtMoney(Math.max(0, g.targetAmountKopecks - g.currentKopecks))}`,
    fields: [{ id: "amt", label: "Сумма взноса (₽)", type: "number", cls: "num" }],
    buttons: [
      { label: "Отмена", cls: "", act: "c", onclick: () => {} },
      { label: "Внести", cls: "", act: "s", onclick: async (vals) => {
          const amt = parseInt(vals.amt, 10);
          if (!(amt > 0)) { snackbar("Введите сумму"); return; }
          try {
            await api("POST", "/api/goals_contribute", { amountKopecks: amt * 100 }, { id: g.id });
            snackbar("Взнос добавлен в копилку");
            renderGoals();
          } catch (e) { snackbar(e.message); }
        } },
    ],
  });
}

// ============================================================= ANALYTICS ====
async function renderAnalytics() {
  const el = document.getElementById("screen-analytics");
  el.innerHTML = `<div class="loading" style="padding:40px;text-align:center;color:var(--on-surface-var)">Загрузка…</div>`;
  const year = NOW.getFullYear();
  let a;
  try { a = await api("GET", "/api/analytics", null, { year }); }
  catch (e) { el.innerHTML = errBox(e); return; }
  const activeMonths = a.monthly.filter(m => m.income > 0 || m.expenses > 0 || m.savings > 0);
  el.innerHTML = `
    <div class="card chart-card"><div class="card-row"><span class="card-title"><span class="msrc">bar_chart</span>Доходы / Расходы</span>${infoBtn("bars")}</div>
      <canvas id="chBars" height="200"></canvas>
      <div class="legend"><span><i style="background:var(--income)"></i>Доход</span><span><i style="background:var(--expense)"></i>Расход</span></div></div>
    <div class="card chart-card"><div class="card-row"><span class="card-title"><span class="msrc">trending_up</span>Накопления (нарастающий итог)</span>${infoBtn("cum")}</div>
      <canvas id="chLine" height="180"></canvas>
      <div class="footer-note" id="lineSel"></div></div>
    <div class="card"><div class="card-row"><span class="card-title"><span class="msrc">pie_chart</span>Расходы по категориям</span>${infoBtn("donut")}</div>
      <div id="donutWrap"></div></div>
    <div class="card"><div class="card-row"><span class="card-title"><span class="msrc">emoji_events</span>Топ-5 расходов</span>${infoBtn("top5")}</div>
      <div id="top5"></div></div>
    <div class="card"><div class="card-row"><span class="card-title"><span class="msrc">table_chart</span>Помесячная аналитика</span>${infoBtn("mtable")}</div>
      <div id="mtable"></div></div>
    <div class="card"><div class="card-row"><span class="card-title"><span class="msrc">percent</span>Тренд нормы сбережений</span>${infoBtn("rates")}</div>
      <div id="rates"></div></div>
    <div class="card"><div class="card-row"><span class="card-title"><span class="msrc">insights</span>Среднее за месяц (за год)</span>${infoBtn("averages")}</div>
      <div class="tricol" style="margin-top:8px">
        <div><div class="l" style="color:var(--income-text)">Доход</div><div class="v">${fmtMoney(a.averages.incomeKopecks)}</div></div>
        <div><div class="l" style="color:var(--expense-text)">Расход</div><div class="v">${fmtMoney(a.averages.expenseKopecks)}</div></div>
        <div><div class="l" style="color:var(--savings-text)">Сбережения</div><div class="v">${fmtMoney(a.averages.savingsKopecks)}</div></div>
      </div></div>
    <div class="card"><div class="card-row"><span class="card-title"><span class="msrc">receipt_long</span>Средний чек по категориям</span>${infoBtn("avgCheck")}</div>
      <div class="seg" id="avgSeg" style="margin-bottom:10px">
        <button data-p="month" class="active">Месяц</button>
        <button data-p="year">12 мес.</button>
      </div>
      <div id="avgCheck"></div></div>
    <div class="card"><div class="card-row"><span class="card-title"><span class="msrc">query_stats</span>Топ-5 месяца</span>${infoBtn("top5trend")}</div>
      <div id="top5trend"></div></div>
    <div class="card"><div class="card-row"><span class="card-title"><span class="msrc">shield</span>Финансовая подушка</span>${infoBtn("cushion")}</div>
      <div id="cushion"></div></div>
    <div class="card"><div class="card-row"><span class="card-title"><span class="msrc">speed</span>Темп бюджета</span>${infoBtn("pace")}</div>
      <div id="pace"></div></div>
    <div class="card"><div class="card-row"><span class="card-title"><span class="msrc">attach_money</span>Крупные траты</span>${infoBtn("bigExp")}</div>
      <div id="bigExp"></div></div>
    <div class="card chart-card"><div class="card-row"><span class="card-title"><span class="msrc">show_chart</span>Кривая баланса</span>${infoBtn("curve")}</div>
      <canvas id="chCurve" height="180"></canvas></div>
    <div class="card"><div class="card-row"><span class="card-title"><span class="msrc">calendar_month</span>Расходы по дням недели</span>${infoBtn("weekday")}</div>
      <div id="weekday"></div></div>
    <div class="card"><div class="card-row"><span class="card-title"><span class="msrc">grid_on</span>Расходы по дням</span>${infoBtn("heatmap")}</div>
      <div id="heatmap"></div></div>`;
  drawBars(el.querySelector("#chBars"), a.monthly);
  drawLine(el.querySelector("#chLine"), a.cumulative, a.monthly, el.querySelector("#lineSel"));
  drawDonut(el.querySelector("#donutWrap"), a.donut, a.expensesTotalKopecks);
  renderTop5(el.querySelector("#top5"), a.top5);
  renderMTable(el.querySelector("#mtable"), a.monthly);
  renderRates(el.querySelector("#rates"), a.savingsRate);
  renderAvgCheck(el.querySelector("#avgCheck"), el.querySelector("#avgSeg"), a.avgCheck, a.avgCheckYear);
  renderTop5Trend(el.querySelector("#top5trend"), a.top5trend);
  renderCushion(el.querySelector("#cushion"), a.cushion);
  renderPace(el.querySelector("#pace"), a.pace);
  renderBigExp(el.querySelector("#bigExp"), a.bigExpenses);
  drawCurve(el.querySelector("#chCurve"), a.balanceCurve);
  renderWeekday(el.querySelector("#weekday"), a.weekday);
  renderHeatmap(el.querySelector("#heatmap"), a.calendar);
  wireInfoButtons(el);
}

// ---- explanations: what each card shows and how it is calculated (v1.11.2)
const EXPL = {
  bars: "Столбцы — доход и расход по каждому месяцу выбранного года. Зелёный — поступления, красный — траты. Копилка (сбережения) в доход не входит, это отдельный тип операции.",
  cum: "Накопительный итог: сколько сейчас в копилке с начала года. Линия растёт на сумму вложений в каждый месяц и падает на траты из накоплений (снятия).",
  donut: "Распределение расходов по категориям за текущий год. Размер сектора пропорционален сумме трат в категории. Показаны 5 крупнейших, остальное — сектор «Прочее». Траты из накоплений учитываются как расходы.",
  top5: "5 категорий с самыми большими тратами за текущий год. Сумма — все расходы этой категории с января по декабрь, отсортировано по убыванию. Траты из накоплений учитываются как расходы.",
  mtable: "Помесячные итоги: доход, расход и сбережения за каждый месяц года. Показаны только месяцы, где была хотя бы одна операция.",
  rates: "Норма сбережений помесячно: сколько процентов дохода ушло в копилку. Формула: сбережения месяца ÷ доход месяца × 100. Месяцы без дохода не учитываются.",
  averages: "Средние месячные суммы за 12 месяцев года: (сумма доходов ÷ 12), (сумма расходов ÷ 12), (сумма сбережений ÷ 12). Сбережения — за вычетом трат из накоплений.",
  avgCheck: "Средний чек в категории = сумма расходов в ней ÷ количество операций. Показаны 6 категорий с самым большим числом операций. Переключатель: текущий месяц или последние 12 месяцев. Траты из накоплений учитываются как расходы.",
  top5trend: "Топ-5 категорий текущего месяца в сравнении с прошлым месяцем. Проценты — изменение: (траты сейчас − траты в прошлом месяце) ÷ прошлые траты × 100. Если прошлых трат не было — «без истории». Траты из накоплений учитываются как расходы.",
  cushion: "Финансовая подушка: на сколько месяцев хватит накоплений. База = текущий баланс (доходы − расходы − копилка) + деньги в копилке (вложения − траты из накоплений). Средний расход — по месяцам, где были траты. Месяцы = база ÷ средний расход.",
  pace: "Скорость трат месячного лимита. План на сегодня = лимит × (день месяца ÷ дней в месяце). Если потрачено больше плана — «Быстрее плана», меньше — «Медленнее плана». Линия-маркер — где должен быть план, полоса — что уже потрачено.",
  bigExp: "10 самых крупных трат за последние 3 месяца (сначала текущего). Каждая строка — одна операция, отсортировано по сумме. Траты из накоплений учитываются как расходы.",
  curve: "Кривая баланса в текущем месяце: остаток средств на конец каждого дня (баланс на начало месяца + накопленный результат дня). Показывает, как менялись деньги в течение месяца.",
  weekday: "Расходы по дням недели за текущий год. Сумма всех расходов, чья дата выпадает на этот день недели (Пн–Вс). Помогает видеть, в какие дни недели тратится больше. Траты из накоплений учитываются как расходы.",
  heatmap: "Карта расходов за последние 12 месяцев: каждый квадратик — день, чем темнее цвет, тем больше потрачено (5 оттенков + пустой день). Нажмите на день, чтобы увидеть дату и точную сумму. Рядом с сеткой — шкала «меньше…больше». Траты из накоплений учитываются как расходы.",
};

function infoBtn(key) {
  return `<button class="infobtn" data-expl="${key}" aria-label="Пояснение"><span class="msrc">info</span></button>`;
}
function wireInfoButtons(root) {
  root.querySelectorAll(".infobtn").forEach(b => {
    b.onclick = () => {
      const card = b.closest(".card");
      let box = card && card.querySelector(".expl");
      if (!box) {
        box = document.createElement("div");
        box.className = "expl";
        card.appendChild(box);
      }
      if (box.classList.contains("open")) {
        box.classList.remove("open");
      } else {
        box.textContent = EXPL[b.dataset.expl] || "";
        box.classList.add("open");
      }
      if (card) card.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };
  });
}
function emptyMsg(t) {
  return `<div class="empty" style="padding:16px 0"><div class="t">${t}</div></div>`;
}
function catIconChip(name, size) {
  const t = tintOf(name);
  size = size || 26;
  return `<span class="ic" style="width:${size}px;height:${size}px;border-radius:8px;background:${hexA(t, 0.14)};color:${t};display:flex;align-items:center;justify-content:center;flex:0 0 auto"><span class="msrc" style="font-size:${Math.round(size * 0.62)}px">${catIcon(name)}</span></span>`;
}
function renderAvgCheck(el, seg, rowsMonth, rowsYear) {
  let period = "month";
  const draw = () => {
    const rows = period === "month" ? rowsMonth : rowsYear;
    if (!rows.length) {
      el.innerHTML = emptyMsg(period === "month" ? "Нет расходов в текущем месяце" : "Нет расходов за 12 месяцев");
      return;
    }
    el.innerHTML = rows.map(r => `<div class="a-row" style="font-size:13px">
      ${catIconChip(r.category)}
      <span class="nm">${esc(r.category)} <span style="color:var(--on-surface-var)">· ${r.count} оп.</span></span>
      <span class="am">${fmtMoney(r.avgKopecks)}</span></div>`).join("");
  };
  seg.querySelectorAll("button").forEach(b => b.onclick = () => {
    period = b.dataset.p;
    seg.querySelectorAll("button").forEach(x => x.classList.toggle("active", x === b));
    draw();
  });
  draw();
}
function renderTop5Trend(el, rows) {
  if (!rows.length) { el.innerHTML = emptyMsg("Нет расходов в текущем месяце"); return; }
  el.innerHTML = rows.map((d, i) => {
    let tr;
    if (d.deltaPct === null) tr = `<span style="color:var(--on-surface-var);font-size:11px">без истории</span>`;
    else if (d.deltaKopecks > 0) tr = `<span style="color:var(--expense-text);font-size:11px;font-weight:700">▲ ${Math.abs(d.deltaPct)}%</span>`;
    else if (d.deltaKopecks < 0) tr = `<span style="color:var(--income-text);font-size:11px;font-weight:700">▼ ${Math.abs(d.deltaPct)}%</span>`;
    else tr = `<span style="color:var(--on-surface-var);font-size:11px;font-weight:700">— 0%</span>`;
    return `<div class="a-row" style="font-size:13px">
      <span style="width:18px;color:var(--on-surface-var);flex:0 0 auto">${i + 1}</span>
      <span class="nm">${esc(d.category)}</span>
      <span class="am">${fmtMoney(d.amountKopecks)}</span>
      <span style="width:78px;text-align:right;flex:0 0 auto">${tr}</span></div>`;
  }).join("");
}
function renderCushion(el, c) {
  const runway = c.runwayMonths === null
    ? emptyMsg("Мало данных для расчёта")
    : `<div style="text-align:center;padding:6px 0 4px">
        <div style="font-size:34px;font-weight:800;color:var(--savings-text)">${String(c.runwayMonths).replace(".", ",")}</div>
        <div style="font-size:12px;color:var(--on-surface-var)">месяцев при текущих расходах</div></div>`;
  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
      <div><div class="l" style="font-size:12px;color:var(--on-surface-var)">Баланс + копилка</div>
        <div style="font-size:16px;font-weight:700">${fmtMoney(c.baseKopecks)}</div></div>
      <div style="text-align:right"><div style="font-size:12px;color:var(--on-surface-var)">Средний расход/мес</div>
        <div style="font-size:16px;font-weight:700;color:var(--expense-text)">${fmtMoney(c.avgMonthlyExpenseKopecks)}</div></div>
    </div>${runway}`;
}
function renderPace(el, p) {
  const pct = x => x === null ? "—" : Math.round(x * 100) + "%";
  if (p.state === "Disabled") { el.innerHTML = emptyMsg("Задайте лимит бюджета в настройках"); return; }
  if (p.spentPct === null) { el.innerHTML = emptyMsg(p.state === "AwaitingIncome" ? "Ждём доход за месяц" : "Лимит ещё не определён"); return; }
  const now = new Date();
  const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const day = now.getDate();
  const planTodayKop = p.capKopecks ? Math.round(p.capKopecks * p.expectedPct) : null;
  const V = { AHEAD: ["Медленнее плана", "var(--income-text)"], ON: ["По плану", "var(--savings-text)"],
              BEHIND: ["Быстрее плана", "var(--expense-text)"] }[p.status] || ["", "var(--on-surface)"];
  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <span style="font-size:14px;font-weight:700;color:${V[1]}">${V[0]}</span>
      <span style="font-size:11px;color:var(--on-surface-var)">день ${day} из ${dim}</span>
    </div>
    <div style="height:12px;border-radius:6px;background:var(--track);position:relative">
      <div style="height:100%;border-radius:6px;width:${Math.min(100, Math.round(p.spentPct * 100))}%;background:var(--expense);opacity:0.75"></div>
      <div style="position:absolute;top:-3px;bottom:-3px;left:${Math.min(100, Math.round(p.expectedPct * 100))}%;width:2px;background:var(--on-surface);border-radius:1px"></div>
    </div>
    <div style="text-align:center;margin-top:6px;font-size:11px;color:var(--on-surface-var)">
      потрачено ${pct(p.spentPct)} · план на сегодня ${pct(p.expectedPct)}</div>
    <div class="tricol" style="margin-top:12px">
      <div><div class="l">Потрачено</div><div class="v" style="color:var(--expense-text)">${fmtMoney(p.spentKopecks)}</div></div>
      <div><div class="l">План на сегодня</div><div class="v">${planTodayKop === null ? "—" : fmtMoney(planTodayKop)}</div></div>
      <div><div class="l">Лимит</div><div class="v">${p.capKopecks ? fmtMoney(p.capKopecks) : "—"}</div></div>
    </div>`;
}
function renderBigExp(el, rows) {
  if (!rows.length) { el.innerHTML = emptyMsg("Нет данных за 3 месяца"); return; }
  el.innerHTML = rows.map(b => `<div class="a-row" style="font-size:13px">
    <span class="nm">${esc(b.category)}${b.description ? `<span style="color:var(--on-surface-var)"> · ${esc(b.description)}</span>` : ""}</span>
    <span style="flex:0 0 auto;color:var(--on-surface-var);font-size:11px;width:64px;text-align:right">${dayLabel(b.date)}</span>
    <span class="am" style="color:var(--expense-text)">${fmtMoney(b.amountKopecks)}</span></div>`).join("");
}
function drawCurve(c, pts) {
  const { ctx, w, h } = setupCanvas(c, 180);
  const n = pts.length;
  if (n < 2) return;
  const padB = 22, padT = 12, padL = 8, padR = 8;
  const max = Math.max(...pts.map(p => p.balanceKopecks), 1);
  const min = Math.min(...pts.map(p => p.balanceKopecks), 0);
  const span = max - min || 1;
  const xs = i => padL + (w - padL - padR) * (i / (n - 1));
  const ys = v => padT + (h - padB - padT) * (1 - (v - min) / span);
  if (min < 0) {
    ctx.strokeStyle = "rgba(150,150,160,0.4)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, ys(0)); ctx.lineTo(w - padR, ys(0)); ctx.stroke();
  }
  ctx.strokeStyle = cssVar("--income");
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.beginPath();
  pts.forEach((p, i) => i === 0 ? ctx.moveTo(xs(i), ys(p.balanceKopecks)) : ctx.lineTo(xs(i), ys(p.balanceKopecks)));
  ctx.stroke();
  ctx.fillStyle = cssVar("--income");
  pts.forEach((p, i) => { ctx.beginPath(); ctx.arc(xs(i), ys(p.balanceKopecks), 2.5, 0, Math.PI * 2); ctx.fill(); });
  ctx.font = "11px sans-serif";
  ctx.fillStyle = cssVar("--on-surface-var");
  ctx.textAlign = "center";
  const step = Math.max(1, Math.ceil(n / 6));
  for (let i = 0; i < n; i += step) ctx.fillText(String(pts[i].day), Math.max(14, Math.min(xs(i), w - 14)), h - 6);
}
function renderWeekday(el, rows) {
  const WD = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
  const total = rows.reduce((s, r) => s + r.amountKopecks, 0);
  if (!total) { el.innerHTML = emptyMsg("Нет расходов за год"); return; }
  const max = Math.max(...rows.map(r => r.amountKopecks), 1);
  el.innerHTML = rows.map(r => `<div style="display:flex;align-items:center;gap:10px;padding:4px 0">
    <div style="width:30px;font-size:12px;color:var(--on-surface-var)">${WD[r.weekday - 1]}</div>
    <div style="flex:1;height:8px;border-radius:4px;background:var(--track)">
      <div style="height:100%;border-radius:4px;width:${Math.round(r.amountKopecks * 100 / max)}%;background:var(--expense);opacity:0.7"></div></div>
    <div style="width:84px;text-align:right;font-size:12px;font-weight:600">${fmtMoney(r.amountKopecks)}</div></div>`).join("") +
    `<div class="footer-note">Итого за год: ${fmtMoney(total)}</div>`;
}
function renderHeatmap(el, cal) {
  const byDay = {};
  cal.days.forEach(d => { byDay[d.date] = d.amountKopecks; });
  const now = new Date();
  const sm = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
  const start = epochDay(sm.getUTCFullYear(), sm.getUTCMonth() + 1, 1);
  const em = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  const end = epochDay(em.getUTCFullYear(), em.getUTCMonth() + 1, em.getUTCDate());
  const max = cal.maxKopecks || 1;
  const lvl = v => { const f = v / max; return f < 0.15 ? 1 : f < 0.4 ? 2 : f < 0.7 ? 3 : 4; };
  const fill = ["var(--track)", "color-mix(in srgb, var(--expense) 18%, var(--track))",
                "color-mix(in srgb, var(--expense) 40%, var(--track))",
                "color-mix(in srgb, var(--expense) 65%, var(--track))", "var(--expense)"];
  const first = start - ((start + 3) % 7); // back to Monday (epoch 0 = Thursday)
  const last = end + (6 - (end + 3) % 7) % 7; // forward to Sunday
  // v1.11.2: only the grid scrolls horizontally; the detail line, legend and
  // footer notes stay in place
  let html = `<div class="hm-scroll" style="overflow-x:auto;-webkit-overflow-scrolling:touch">
    <div style="display:grid;grid-auto-flow:column;grid-template-rows:12px repeat(7,11px);gap:2px;width:max-content">`;
  let prevMonth = -1;
  for (let e = first; e <= last; e += 7) {
    let lbl = "";
    for (let x = e; x < e + 7; x++) {
      if (x >= start && x <= end) {
        const m = fromEpochDay(x).m;
        // v1.11.4: 3-letter short names, like the other chart axes
        // (overflows into the next empty label cells — the next month
        // label is always >= 4 columns away)
        if (m !== prevMonth) { lbl = MONTHS_SHORT[m - 1]; prevMonth = m; }
        break;
      }
    }
    html += `<div style="font-size:9px;color:var(--on-surface-var);align-self:end;padding-bottom:2px">${lbl}</div>`;
    for (let x = e; x < e + 7; x++) {
      const out = x < start || x > end;
      const v = out ? 0 : (byDay[x] || 0);
      const bg = out ? "transparent" : (v ? fill[lvl(v)] : fill[0]);
      html += `<div class="hm-cell${out ? "" : " hm-in"}" data-e="${x}" data-v="${v}" style="width:11px;height:11px;border-radius:2px;background:${bg}"></div>`;
    }
  }
  html += `</div></div>
    <div class="hm-detail" id="hmDetail"></div>
    <div style="display:flex;align-items:center;gap:4px;margin-top:8px;font-size:11px;color:var(--on-surface-var)">
      <span>меньше</span>${fill.map(f => `<span style="width:11px;height:11px;border-radius:2px;background:${f};display:inline-block"></span>`).join("")}<span>больше</span></div>
    <div class="footer-note">Нажмите на день — покажет дату и сумму</div>
    <div class="footer-note">Максимальный день: ${fmtMoney(cal.maxKopecks)} · строки: Пн–Вс</div>`;
  el.innerHTML = html;
  // v1.11.3: start scrolled to the RIGHT edge (current month) so the latest
  // days are visible without scrolling (the grid is 62 weeks wide)
  const hmScroll = el.querySelector(".hm-scroll");
  requestAnimationFrame(() => { hmScroll.scrollLeft = hmScroll.scrollWidth; });
  const detail = el.querySelector("#hmDetail");
  let sel = null;
  el.querySelectorAll(".hm-cell.hm-in").forEach(c => {
    c.onclick = () => {
      if (sel === c) { sel = null; c.classList.remove("hm-sel"); detail.textContent = ""; return; }
      if (sel) sel.classList.remove("hm-sel");
      sel = c; c.classList.add("hm-sel");
      const d = fromEpochDay(+c.dataset.e);
      const v = +c.dataset.v;
      detail.textContent = `${d.d} ${MONTHS_FULL[d.m - 1]} ${d.y} · ` + (v ? fmtMoney(v) : "без расходов");
    };
  });
}
function setupCanvas(c, cssH) {
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth || 320;
  c.width = w * dpr; c.height = cssH * dpr;
  c.style.height = cssH + "px";
  const ctx = c.getContext("2d");
  ctx.scale(dpr, dpr);
  return { ctx, w, h: cssH };
}
function cssVar(name) { return getComputedStyle(document.body).getPropertyValue(name).trim(); }
function drawBars(c, monthly) {
  const { ctx, w, h } = setupCanvas(c, 200);
  const padB = 22, padT = 10;
  const max = Math.max(1, ...monthly.map(m => Math.max(m.income, m.expenses)));
  const slot = w / 12, barW = Math.min(14, slot / 3), gap = 2;
  ctx.font = "11px sans-serif";
  monthly.forEach((m, i) => {
    const cx = slot * i + slot / 2;
    const hi = (h - padB - padT) * m.income / max;
    const he = (h - padB - padT) * m.expenses / max;
    ctx.fillStyle = cssVar("--income");
    rrect(ctx, cx - barW - gap / 2, h - padB - hi, barW, Math.max(0, hi), 3);
    ctx.fillStyle = cssVar("--expense");
    rrect(ctx, cx + gap / 2, h - padB - he, barW, Math.max(0, he), 3);
    ctx.fillStyle = cssVar("--on-surface-var");
    ctx.textAlign = "center";
    ctx.fillText(MONTHS_SHORT[i], Math.max(14, Math.min(cx, w - 14)), h - 6);
  });
}
function rrect(ctx, x, y, w, h, r) {
  if (h <= 0) return;
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
  ctx.fill();
}
function drawLine(c, cum, monthly, selEl) {
  const { ctx, w, h } = setupCanvas(c, 180);
  const padB = 22, padT = 14, padL = 8, padR = 8;
  const n = cum.length;
  const max = Math.max(1, ...cum);
  const xs = i => padL + (w - padL - padR) * (n === 1 ? 0.5 : i / (n - 1));
  const ys = v => padT + (h - padB - padT) * (1 - v / max);
  ctx.strokeStyle = cssVar("--savings");
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.beginPath();
  cum.forEach((v, i) => i === 0 ? ctx.moveTo(xs(i), ys(v)) : ctx.lineTo(xs(i), ys(v)));
  ctx.stroke();
  cum.forEach((v, i) => {
    ctx.fillStyle = cssVar("--savings");
    ctx.beginPath(); ctx.arc(xs(i), ys(v), 3, 0, Math.PI * 2); ctx.fill();
  });
  ctx.font = "11px sans-serif";
  ctx.fillStyle = cssVar("--on-surface-var");
  ctx.textAlign = "center";
  for (let i = 0; i < 12; i++) ctx.fillText(MONTHS_SHORT[i], Math.max(14, Math.min(xs(i), w - 14)), h - 6);
  c.onclick = (e) => {
    const r = c.getBoundingClientRect();
    const x = e.clientX - r.left;
    let best = 0, bd = Infinity;
    cum.forEach((v, i) => { const d = Math.abs(xs(i) - x); if (d < bd) { bd = d; best = i; } });
    const m = monthly[best];
    selEl.textContent = m ? `${MONTHS_FULL[m.month - 1]}: ${fmtMoney(cum[best])}` : "";
    drawLine(c, cum, monthly, selEl);
    ctx.strokeStyle = "rgba(192,132,252,0.3)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(xs(best), padT); ctx.lineTo(xs(best), h - padB); ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(xs(best), ys(cum[best]), 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = cssVar("--savings");
    ctx.beginPath(); ctx.arc(xs(best), ys(cum[best]), 5.5, 0, Math.PI * 2); ctx.fill();
  };
}
function drawDonut(wrap, donut, total) {
  if (!donut.length) {
    wrap.innerHTML = `<div class="empty" style="padding:16px 0"><div class="t">Нет данных</div></div>`;
    return;
  }
  const size = 190;
  let html = `<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
    <canvas id="donutC" width="${size}" height="${size}" style="width:${size}px;height:${size}px"></canvas>
    <div style="flex:1;min-width:140px">` +
    donut.map(d => {
      const t = tintOf(d.category);
      const pc = total ? Math.round(d.amountKopecks * 100 / total) : 0;
      return `<div class="a-row"><span class="sw" style="background:${t}"></span><span class="nm">${esc(d.category)}</span>
        <span class="am">${fmtMoney(d.amountKopecks)}</span><span class="pc">${pc}%</span></div>`;
    }).join("") + `</div></div>`;
  wrap.innerHTML = html;
  const c = wrap.querySelector("#donutC");
  const ctx = c.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  c.width = size * dpr; c.height = size * dpr;
  c.style.width = size + "px"; c.style.height = size + "px";
  ctx.scale(dpr, dpr);
  const cx = size / 2, cy = size / 2, r = size / 2 - 16, lw = 26;
  let a0 = -Math.PI / 2;
  const GAP = 2.5 * Math.PI / 180;
  donut.forEach(d => {
    const frac = total ? d.amountKopecks / total : 0;
    const a1 = a0 + Math.max(0.02, frac * Math.PI * 2) - GAP;
    ctx.beginPath();
    ctx.arc(cx, cy, r, a0 + GAP / 2, Math.max(a0 + GAP / 2, a1));
    ctx.strokeStyle = tintOf(d.category);
    ctx.lineWidth = lw;
    ctx.stroke();
    a0 += Math.max(0.02, frac * Math.PI * 2);
  });
  ctx.fillStyle = cssVar("--on-surface-var");
  ctx.font = "12px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("Итого", cx, cy - 8);
  ctx.fillStyle = cssVar("--on-surface");
  ctx.font = "600 15px sans-serif";
  ctx.fillText(fmtMoney(total), cx, cy + 12);
}
function renderTop5(el, top5) {
  if (!top5.length) { el.innerHTML = `<div class="empty" style="padding:16px 0"><div class="t">Нет данных</div></div>`; return; }
  const max = top5[0].amountKopecks || 1;
  el.innerHTML = top5.map((d, i) => {
    const t = tintOf(d.category);
    return `<div style="margin-bottom:10px">
      <div class="a-row"><span class="nm" style="font-size:14px">${i + 1}. ${esc(d.category)}</span><span class="am" style="font-size:14px">${fmtMoney(d.amountKopecks)}</span></div>
      <div style="height:6px;border-radius:3px;background:var(--track);margin-top:6px">
        <div style="height:100%;border-radius:3px;width:${Math.round(d.amountKopecks * 100 / max)}%;background:${hexA(t, 0.55)}"></div></div></div>`;
  }).join("");
}
function renderMTable(el, monthly) {
  const rows = monthly.filter(m => m.income > 0 || m.expenses > 0 || m.savings > 0);
  if (!rows.length) { el.innerHTML = `<div class="empty" style="padding:16px 0"><div class="t">Нет данных для сравнения</div></div>`; return; }
  el.innerHTML = `<table class="mtable"><tr><th>Месяц</th><th style="color:var(--income-text)">Доход</th>
    <th style="color:var(--expense-text)">Расход</th><th style="color:var(--savings-text)">Сбережения</th></tr>` +
    rows.map(m => `<tr><td>${MONTHS_SHORT[m.month - 1]}</td><td style="color:var(--income-text)">${fmtMoney(m.income)}</td>
      <td style="color:var(--expense-text)">${fmtMoney(m.expenses)}</td><td style="color:var(--savings-text)">${fmtMoney(m.savings)}</td></tr>`).join("") + "</table>";
}
function renderRates(el, rates) {
  if (!rates.length) { el.innerHTML = `<div class="empty" style="padding:16px 0"><div class="t">Нет данных</div></div>`; return; }
  const max = Math.max(...rates.map(r => r.rate), 1);
  el.innerHTML = rates.map(r => {
    const good = r.rate >= 20;
    return `<div style="display:flex;align-items:center;gap:10px;padding:5px 0">
      <div style="width:40px;font-size:12px;color:var(--on-surface-var)">${MONTHS_SHORT[r.month - 1]}</div>
      <div style="flex:1;height:8px;border-radius:4px;background:var(--track)">
        <div style="height:100%;border-radius:4px;width:${Math.round(r.rate * 100 / max)}%;background:${good ? "var(--income)" : "var(--expense)"};opacity:0.85"></div></div>
      <div style="width:44px;text-align:right;font-size:12px;font-weight:700;color:${good ? "var(--income-text)" : "var(--expense-text)"}">${Math.round(r.rate)}%</div></div>`;
  }).join("");
}

// =============================================================== SETTINGS ===
async function renderSettings() {
  const el = document.getElementById("screen-settings");
  const s = state.settings;
  let templates = [];
  try { templates = (await api("GET", "/api/budget_templates")).templates || []; } catch (e) { /* ignore */ }
  const tmplMap = {};
  templates.forEach(t => { tmplMap[t.type + "|" + t.category] = t.amountKopecks; });
  const tmplGroup = (type, title) => {
    const cats = state.categories.filter(c => c.type === type);
    if (!cats.length) return "";
    const col = TYPE_COLOR[type];
    const rows = cats.map(c => {
      const amt = tmplMap[type + "|" + c.name] || 0;
      return `<div class="setrow" style="padding:4px 0 4px 12px">
        <div class="lbl">${esc(c.name)}</div>
        <input class="inline num" inputmode="numeric" data-tmpl="${esc(c.name)}" data-tt="${type}" value="${amt ? Math.floor(amt / 100) : ""}">
      </div>`;
    }).join("");
    return `<div style="margin-top:8px">
      <div class="setrow" data-tg="${type}" style="cursor:pointer">
        <div class="lbl" style="font-weight:700;color:${col}">${title}</div>
        <span class="msrc" style="color:var(--on-surface-var);font-size:18px">${tui.groups[type] ? "expand_less" : "expand_more"}</span>
      </div>
      ${tui.groups[type] ? rows : ""}
    </div>`;
  };
  el.innerHTML = `
    <div class="card setsection"><div class="head"><span class="msrc">person</span><span class="t">Аккаунт</span></div>
      <div class="field"><label>Имя пользователя</label><input id="stUser" value="${esc(s.username || "")}"></div>
      <div class="field" style="margin-bottom:0"><label>Валюта</label><input id="stCur" value="${esc(s.currencySymbol || "₽")}" style="max-width:80px"></div>
    </div>
    <div class="card setsection"><div class="head"><span class="msrc">account_balance</span><span class="t">Бюджет на месяц</span></div>
      <div class="field"><label>Лимит (₽/мес)</label><input id="stCap" class="num" inputmode="numeric" value="${s.monthlyCapKopecks ? Math.floor(s.monthlyCapKopecks / 100) : ""}"></div>
      <div class="footer-note" style="margin-top:-6px;margin-bottom:10px">Пусто — общий лимит выключен</div>
      <div class="setrow"><div class="lbl">Связать с доходом</div>
        <label class="switch"><input type="checkbox" id="stLink" ${s.capLinkedIncome ? "checked" : ""}><span class="sl"></span></label></div>
      <div class="setrow" id="stPctRow" style="${s.capLinkedIncome ? "" : "opacity:0.4"}">
        <div class="lbl">Доля дохода, %</div><input id="stPct" class="inline num" inputmode="decimal" value="${s.capIncomePct ?? 30}"></div>
      <div class="setrow" id="stTplToggle" style="cursor:pointer">
        <div class="lbl">Шаблон по категориям</div>
        <span class="msrc" style="color:var(--on-surface-var);font-size:18px">${tui.open ? "expand_less" : "expand_more"}</span>
      </div>
      ${tui.open ? tmplGroup("INCOME", "Доходы") + tmplGroup("EXPENSE", "Расходы") + tmplGroup("SAVINGS", "Сбережения") : ""}
      ${templates.length === 0 ? `<div class="setrow" style="margin-top:8px"><div class="lbl">Копировать план прошлого месяца</div>
        <label class="switch"><input type="checkbox" id="stCopyPrev" ${s.budgetCopyPrevMonth ? "checked" : ""}><span class="sl"></span></label></div>
        <div class="footer-note">Срабатывает для категорий без явного плана и без шаблона.</div>` : ""}
    </div>
    <div class="card setsection"><div class="head"><span class="msrc">palette</span><span class="t">Оформление</span></div>
      <div class="radio ${s.themeMode === "system" ? "on" : ""}" data-th="system"><span class="rd"></span>Системная</div>
      <div class="radio ${s.themeMode === "light" ? "on" : ""}" data-th="light"><span class="rd"></span>Светлая</div>
      <div class="radio ${s.themeMode === "dark" ? "on" : ""}" data-th="dark"><span class="rd"></span>Тёмная</div>
    </div>
    <div class="card setsection"><div class="head"><span class="msrc">folder_open</span><span class="t">Данные</span></div>
      <button class="btn tonal" id="stExport"><span class="msrc">download</span>Резервная копия (JSON)</button>
      <div class="btnrow"><button class="btn tonal" id="stImport"><span class="msrc">upload</span>Восстановить из файла</button>
      <input type="file" id="stImportFile" accept="application/json,.json" class="hidden"></div>
      <div class="footer-note">Формат совместим с бэкапом Android-приложения MoneyAPP: транзакции, категории, цели и планы бюджета объединяются по id (upsert).</div>
    </div>
    <div class="card setsection"><div class="head"><span class="msrc">shield</span><span class="t">Безопасность</span></div>
      <div class="setrow"><div class="lbl">Сквозное шифрование</div>
        <div class="val" style="color:var(--income-text)">Включено</div></div>
      <div class="footer-note">Данные шифруются на твоём устройстве. На сервере хранится только зашифрованная копия — без ключа её не прочитает никто, даже владелец сервера.</div>
      <div class="btnrow" style="margin-top:10px">
        <button class="btn tonal" id="stShowPhrase"><span class="msrc">key</span>Фраза восстановления</button>
        <button class="btn tonal" id="stChangePin"><span class="msrc">lock_reset</span>Сменить ПИН</button>
      </div>
      <div class="btnrow"><button class="btn tonal" id="stLock"><span class="msrc">lock</span>Заблокировать</button></div>
    </div>
    <div class="card setsection"><div class="head"><span class="msrc">category</span><span class="t">Категории</span></div>
      <button class="btn tonal" id="stCats"><span class="msrc">edit</span>Управление категориями</button>
    </div>
    <div class="card setsection"><div class="head"><span class="msrc">info</span><span class="t">О приложении</span></div>
      <div style="font-size:14px;font-weight:600">MoneyAPP Web v1.12</div>
      <div class="footer-note">Персональный финансовый трекер • Telegram mini-app</div>
      <div class="footer-note">Все данные шифруются прямо в мини-приложении на твоём телефоне. Ключ создаётся из твоего ПИН-кода и никуда не отправляется — не на сервер и не в Telegram. Поэтому даже владелец сервера не может прочитать твои данные.</div>
      <div class="footer-note">При первом запуске ты получил(а) фразу из 24 слов — сохрани её в надёжном месте: это единственный способ вернуть данные, если забудешь ПИН.</div>
    </div>`;
  const saveUser = async () => {
    try {
      await api("PUT", "/api/settings", { username: el.querySelector("#stUser").value, currencySymbol: el.querySelector("#stCur").value });
      state.settings = (await api("GET", "/api/settings")).settings;
      snackbar("Сохранено");
    } catch (e) { snackbar(e.message); }
  };
  el.querySelector("#stUser").onchange = saveUser;
  el.querySelector("#stCur").onchange = saveUser;
  el.querySelector("#stLink").onchange = saveCap;
  el.querySelector("#stCap").onchange = saveCap;
  el.querySelector("#stPct").onchange = saveCap;
  el.querySelector("#stLink").onchange = (e) => { el.querySelector("#stPctRow").style.opacity = e.target.checked ? "" : "0.4"; };
  el.querySelector("#stTplToggle").onclick = () => { tui.open = !tui.open; renderSettings(); };
  el.querySelectorAll("[data-tg]").forEach(r => r.onclick = () => {
    tui.groups[r.dataset.tg] = !tui.groups[r.dataset.tg]; renderSettings();
  });
  el.querySelectorAll("[data-tmpl]").forEach(inp => inp.onchange = async () => {
    const val = inp.value.replace(/[^\d]/g, "");
    try {
      await api("PUT", "/api/budget_templates", {
        category: inp.dataset.tmpl, type: inp.dataset.tt,
        amountKopecks: parseInt(val || "0", 10) * 100,
      });
      snackbar(val ? "Шаблон сохранён" : "Шаблон удалён");
      renderSettings();
    } catch (e) { snackbar(e.message); }
  });
  const cp = el.querySelector("#stCopyPrev");
  if (cp) cp.onchange = async () => {
    try {
      await api("PUT", "/api/settings", { budgetCopyPrevMonth: cp.checked });
      state.settings = (await api("GET", "/api/settings")).settings;
      snackbar("Готово");
      renderSettings();
    } catch (e) { snackbar(e.message); }
  };
  async function saveCap() {
    const capRub = el.querySelector("#stCap").value.replace(/[^\d]/g, "");
    const pct = parseFloat(el.querySelector("#stPct").value) || 0;
    try {
      const r = await api("POST", "/api/budget/cap", {
        monthlyCapKopecks: parseInt(capRub || "0", 10) * 100,
        capLinkedIncome: el.querySelector("#stLink").checked,
        capIncomePct: pct,
      });
      state.settings = r.settings;
      snackbar("Бюджет сохранён");
    } catch (e) { snackbar(e.message); }
  }
  el.querySelectorAll(".radio").forEach(r => r.onclick = async () => {
    try {
      await api("PUT", "/api/settings", { themeMode: r.dataset.th });
      state.settings = (await api("GET", "/api/settings")).settings;
      applyTheme(r.dataset.th);
      renderSettings();
    } catch (e) { snackbar(e.message); }
  });
  el.querySelector("#stExport").onclick = async () => {
    try {
      const data = await api("GET", "/api/export");
      const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `moneyapp-backup-${isoDate(todayEpoch())}.json`;
      a.click();
      URL.revokeObjectURL(url);
      snackbar(`Резервная копия создана: ${data.transactions.length} транзакций`);
    } catch (e) { snackbar(e.message); }
  };
  el.querySelector("#stImport").onclick = () => el.querySelector("#stImportFile").click();
  el.querySelector("#stImportFile").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const body = JSON.parse(await file.text());
      const r = await api("POST", "/api/import", body);
      state.categories = (await api("GET", "/api/categories")).categories;
      snackbar(`Восстановлено: транзакций +${r.txAdded}/=${r.txUpdated}, категорий +${r.catAdded}, целей +${r.goalAdded}`);
      refresh();
    } catch (err) { snackbar("Ошибка импорта: " + err.message); }
    e.target.value = "";
  };
  el.querySelector("#stCats").onclick = () => openSub("categories");
  el.querySelector("#stLock").onclick = () => lockApp();
  el.querySelector("#stShowPhrase").onclick = () => phraseDialog();
  el.querySelector("#stChangePin").onclick = () => changePinDialog();
}

// --------------------------------------------------------- E2E dialogs ----
// Show the 24-word phrase after PIN verification (key -> mnemonic in memory).
function phraseDialog() {
  const dv = dialog({
    title: "Фраза восстановления",
    body: `
      <div class="footer-note">Введите ПИН, чтобы показать фразу.</div>
      <div class="field"><label>ПИН</label><input id="phPin" class="authpin" type="password" inputmode="numeric" maxlength="6" placeholder="••••" autocomplete="off"></div>
      <div id="phBody"></div>
      <div id="phErr" class="autherr"></div>`,
    buttons: [
      { label: "Закрыть", cls: "", act: "c", onclick: () => {} },
      { label: "Показать", cls: "", act: "s", onclick: async () => {
          const pin = dv.querySelector("#phPin").value.trim();
          const err = dv.querySelector("#phErr");
          const body = dv.querySelector("#phBody");
          err.textContent = "";
          try {
            const words = await store.phraseForPin(pin);
            body.innerHTML = `<div class="phrase" style="margin:12px 0">${words.map(w => `<span class="pw">${w}</span>`).join("")}</div>
              <div class="footer-note">Эта фраза не меняется при смене ПИН. Сохраните её и никому не показывайте.</div>`;
            const cp = document.createElement("button");
            cp.className = "btn tonal"; cp.style.cssText = "width:100%;margin-top:8px";
            cp.innerHTML = `<span class="msrc">copy</span>Скопировать фразу`;
            cp.onclick = async () => {
              try { await navigator.clipboard.writeText(words.join(" ")); snackbar("Фраза скопирована"); }
              catch (e) { snackbar("Скопируйте слова вручную"); }
            };
            body.appendChild(cp);
            dv.querySelector(".dbtn[data-act='s']").textContent = "Готово";
            dv.querySelector(".dbtn[data-act='s']").onclick = closeDialog;
          } catch (e) {
            err.textContent = e.message === "wrong key" ? "Неверный ПИН" : e.message;
          }
        } },
    ],
  });
}
function changePinDialog() {
  const dv = dialog({
    title: "Сменить ПИН",
    body: `
      <div class="footer-note">Фраза восстановления при смене ПИН не меняется.</div>
      <div class="field"><label>Текущий ПИН</label><input id="cpOld" class="authpin" type="password" inputmode="numeric" maxlength="6" placeholder="••••" autocomplete="off"></div>
      <div class="field"><label>Новый ПИН (4–6 цифр)</label><input id="cpNew" class="authpin" type="password" inputmode="numeric" maxlength="6" placeholder="••••" autocomplete="off"></div>
      <div class="field"><label>Новый ПИН ещё раз</label><input id="cpNew2" class="authpin" type="password" inputmode="numeric" maxlength="6" placeholder="••••" autocomplete="off"></div>
      <div id="cpErr" class="autherr"></div>`,
    buttons: [
      { label: "Отмена", cls: "", act: "c", onclick: () => {} },
      { label: "Сменить", cls: "", act: "s", onclick: async () => {
          const old = dv.querySelector("#cpOld").value.trim();
          const n1 = dv.querySelector("#cpNew").value.trim();
          const n2 = dv.querySelector("#cpNew2").value.trim();
          const err = dv.querySelector("#cpErr");
          if (!C.validPin(n1)) { err.textContent = "Новый ПИН: 4–6 цифр"; return; }
          if (n1 !== n2) { err.textContent = "Новый ПИН не совпадает"; return; }
          try {
            await store.changePin(old, n1);
            snackbar("ПИН обновлён");
            closeDialog();
          } catch (e) {
            err.textContent = e.message === "wrong key" ? "Неверный текущий ПИН" : e.message;
          }
        } },
    ],
  });
}
// Lock: wipe the in-memory key/state and ask for the PIN again.
function lockApp() {
  closeDialog();
  store.state = null; store.key = null; store.pin = null; store.rev = -1;
  document.getElementById("fab").classList.add("hidden");
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  screenPin();
}

// ============================================================= CATEGORIES ===
function renderCategories() {
  const el = document.getElementById("screen-categories");
  const sec = (type, title) => {
    const list = state.categories.filter(c => c.type === type);
    const col = TYPE_COLOR[type];
    let rows = list.length === 0
      ? `<div class="footer-note" style="padding:6px 0">Нет категорий — добавьте через «Добавить»</div>`
      : list.map(c => {
          const t = tintOf(c.name);
          return `<div class="card setrow catrow" data-name="${esc(c.name)}" data-type="${type}" style="padding:10px 12px;margin-bottom:8px">
            <div class="ic" style="width:32px;height:32px;border-radius:10px;background:${hexA(t, 0.14)};color:${t};display:flex;align-items:center;justify-content:center;flex:0 0 auto">
              <span class="msrc">${catIcon(c.name)}</span></div>
            <div class="lbl">${esc(c.name)}</div>
            <label class="switch" data-vis="${esc(c.name)}|${type}"><input type="checkbox" ${c.isVisible !== 0 ? "checked" : ""}><span class="sl"></span></label>
            <button class="iconbtn catdel" data-name="${esc(c.name)}" data-type="${type}" style="color:var(--error)"><span class="msrc">delete</span></button>
          </div>`;
        }).join("");
    return `<div style="display:flex;align-items:center;gap:8px;margin:14px 0 8px">
      <span class="msrc" style="font-size:20px;color:${col}">${TYPE_ICON[type]}</span>
      <span style="font-size:16px;font-weight:700;color:${col}">${title}</span></div>${rows}`;
  };
  el.innerHTML = `
    <div class="row-between" style="margin:4px 0 8px">
      <div style="font-size:19px;font-weight:700">Управление категориями</div>
      <button class="btn tonal" id="catAdd" style="width:auto;height:40px;padding:0 16px"><span class="msrc">add</span>Добавить</button>
    </div>
    <div class="footer-note" style="margin-bottom:4px">Тап по строке — редактирование, переключатель — видимость, корзина — удаление.</div>
    ${sec("INCOME", "Доходы")}
    ${sec("EXPENSE", "Расходы")}
    ${sec("SAVINGS", "Копилка")}`;
  el.querySelector("#catAdd").onclick = () => catDialog(null, "EXPENSE");
  el.querySelectorAll(".catrow").forEach(r => r.onclick = (e) => {
    if (e.target.closest(".catdel") || e.target.closest(".switch")) return;
    catDialog(state.categories.find(c => c.name === r.dataset.name && c.type === r.dataset.type), null);
  });
  el.querySelectorAll(".catdel").forEach(b => b.onclick = (e) => {
    e.stopPropagation();
    const name = b.dataset.name, type = b.dataset.type;
    dialog({
      title: "Удалить категорию?",
      text: `«${esc(name)}» будет удалена. Существующие транзакции сохранятся.`,
      buttons: [
        { label: "Отмена", cls: "", act: "c", onclick: () => {} },
        { label: "Удалить", cls: "danger", act: "d", onclick: async () => {
            try {
              await api("DELETE", "/api/categories", null, { name, type });
              state.categories = (await api("GET", "/api/categories")).categories;
              renderCategories();
            } catch (err) { snackbar(err.message); }
          } },
      ],
    });
  });
  el.querySelectorAll("[data-vis]").forEach(sw => sw.onclick = async (e) => {
    e.stopPropagation();
    const [name, type] = sw.dataset.vis.split("|");
    const on = sw.querySelector("input").checked;
    try {
      await api("PUT", "/api/categories", { name, type, visible: on }, { name, type });
      state.categories = (await api("GET", "/api/categories")).categories;
    } catch (err) { snackbar(err.message); }
  });
}
function catDialog(cat, defaultType) {
  const editing = !!cat;
  let selType = cat ? cat.type : defaultType || "EXPENSE";
  let selIcon = cat ? (cat.icon || null) : null;
  const dv = dialog({
    title: editing ? "Изменить категорию" : "Новая категория",
    body: `
      <div class="field"><label>Название</label><input id="catName" value="${esc(cat ? cat.name : "")}"></div>
      <div class="field"><label>Иконка</label><div class="icongrid" id="catIcons"></div></div>
      <div class="catflow" id="catTypes" style="margin-top:4px">
        <button class="chip ${selType === "INCOME" ? "active" : ""}" data-t="INCOME">Доход</button>
        <button class="chip ${selType === "EXPENSE" ? "active" : ""}" data-t="EXPENSE">Расход</button>
        <button class="chip ${selType === "SAVINGS" ? "active" : ""}" data-t="SAVINGS">Копилка</button>
      </div>`,
    buttons: [
      { label: "Отмена", cls: "", act: "c", onclick: () => {} },
      { label: editing ? "Сохранить" : "Добавить", cls: "", act: "s", onclick: async () => {
          const name = dv.querySelector("#catName").value.trim();
          if (!name) { snackbar("Введите название"); return; }
          try {
            if (editing) {
              await api("PUT", "/api/categories", { name, type: selType, icon: selIcon },
                { name: cat.name, type: cat.type });
            } else {
              await api("POST", "/api/categories", { name, type: selType, icon: selIcon });
            }
            state.categories = (await api("GET", "/api/categories")).categories;
            closeDialog();
            renderCategories();
            snackbar("Готово");
          } catch (e) { snackbar(e.message); }
        } },
    ],
  });
  function renderIcons() {
    const el = dv.querySelector("#catIcons");
    let h = `<button class="icontile ${selIcon === null ? "active" : ""}" data-k=""><span class="msrc">auto_awesome</span></button>`;
    for (const k of Object.keys(ICON_KEYS)) {
      h += `<button class="icontile ${selIcon === k ? "active" : ""}" data-k="${k}"><span class="msrc">${ICON_KEYS[k]}</span></button>`;
    }
    el.innerHTML = h;
    el.querySelectorAll(".icontile").forEach(b => b.onclick = () => {
      selIcon = b.dataset.k || null;
      renderIcons();
    });
  }
  dv.querySelectorAll("#catTypes .chip").forEach(b => b.onclick = () => {
    dv.querySelectorAll("#catTypes .chip").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    selType = b.dataset.t;
  });
  renderIcons();
}

// ================================================================== BOOT ====
async function boot() {
  let init = tg ? tg.initData : "";
  if (!init) {
    const p = new URLSearchParams(location.search).get("initData");
    if (p) init = p;
  }
  state.initData = init || "";
  if (!state.initData) {
    document.getElementById("content").innerHTML =
      `<div class="empty" style="padding-top:120px"><div class="box"><span class="msrc">error</span></div>
       <div class="t">Открой из Telegram</div>
       <div class="h">Мини-приложение работает через кнопку в боте @MoneyApp01_bot</div></div>`;
    return;
  }
  state.user = JSON.parse(new URLSearchParams(state.initData).get("user") || "{}");
  store.uid = state.user.id || 0;
  // Stale-JS banner: the server knows the deployed web version (no auth),
  // so even a cached copy of the app can offer a reload.
  try {
    const v = await store.http("GET", "/api/version");
    if (v.webVer !== WEB_APP_VERSION) showVBanner();
  } catch (e) { /* ignore */ }
  try {
    const d = await store.http("GET", "/api/blob");
    store.rev = d.rev;
    store.today = d.today;
    if (d.has) { screenPin(); return; }
    // No blob yet: either a migration (legacy DB with real data) or a
    // fresh first launch. Both start with the PIN setup screen.
    let exp = null;
    try { const l = await store.http("GET", "/api/legacy"); exp = l.export; } catch (e) { /* none */ }
    if (exp && M.hasRealData(exp)) {
      authCtx.mode = "migrate";
      authCtx.legacyExport = exp;
      screenNewPin(`<div class="authh">Мы перенесём твои данные из старого хранилища и зашифруем их на этом устройстве. После переноса прочитать их сможет только твой ПИН.</div>`);
    } else {
      authCtx.mode = "setup";
      screenNewPin(`<div class="authh">Защитим твои данные: придумай ПИН, а затем сохрани фразу восстановления. Даже владелец сервера не сможет прочитать твои финансы.</div>`);
    }
  } catch (e) {
    document.getElementById("content").innerHTML =
      `<div class="empty" style="padding-top:120px"><div class="box"><span class="msrc">error</span></div>
       <div class="t">Ошибка авторизации</div><div class="h">${esc(e.message)}</div></div>`;
  }
}
boot();
