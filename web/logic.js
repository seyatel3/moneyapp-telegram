/* MoneyAPP Web — business logic (v1.11.10, E2E).
 *
 * Exact port of the computations that used to live in the Python server
 * (app.py, Api class). The state object is the user's full dataset, kept in
 * memory by app.js, encrypted in the browser and stored on the server as an
 * opaque blob. Every function here mirrors its Python counterpart 1:1 —
 * including the v1.11.6 SAVINGS_SPEND quirks and Python's round() semantics
 * (pyRound, see tests/parity).
 *
 * Browser: window.MALogic. Node (tests): require("logic.js").
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.MALogic = api;
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this),
function () {
  "use strict";

  /* ------------------------------------------------- server constants ---- */
  // Mirrors app.py SEED_CATEGORIES: (name, type, emoji, sortOrder).
  const SEED_CATEGORIES = [
    ["Зарплата", "INCOME", "💼", 1], ["Переработки", "INCOME", "💼", 2],
    ["Премия", "INCOME", "💼", 3], ["Прочий доход", "INCOME", "💼", 4],
    ["Прочее", "INCOME", "💼", 5],
    ["Инвестиции", "SAVINGS", "📈", 1],
    ["Продукты", "EXPENSE", "🛒", 1], ["Ипотека/Аренда", "EXPENSE", "🏠", 2],
    ["ЖКХ", "EXPENSE", "🏠", 3], ["Транспорт", "EXPENSE", "🚌", 4],
    ["Рестораны", "EXPENSE", "🍕", 5], ["Здоровье", "EXPENSE", "❤️", 6],
    ["Одежда", "EXPENSE", "👗", 7], ["Подписки", "EXPENSE", "📱", 8],
    ["Спорт", "EXPENSE", "💪", 9], ["Образование", "EXPENSE", "📚", 10],
    ["Подарки", "EXPENSE", "🎁", 11], ["Развлечения", "EXPENSE", "🎉", 12],
    ["Связь", "EXPENSE", "📱", 13], ["Услуги", "EXPENSE", "🔧", 14],
    ["Маркетплейсы", "EXPENSE", "🛍️", 15], ["Вредные привычки", "EXPENSE", "🚬", 16],
    ["Прочее", "EXPENSE", "📦", 17],
  ];
  const DEFAULT_SETTINGS = {
    username: "",
    currencySymbol: "₽",
    themeMode: "system",
    monthlyCapKopecks: 0,
    capLinkedIncome: false,
    capIncomePct: 30,
    budgetCopyPrevMonth: false,
  };
  const ICON_KEYS = new Set([
    "wallet", "money", "coins", "card", "cash", "bill", "savings", "percent",
    "trend-up", "atms", "account", "briefcase", "gift", "cart", "bag", "store",
    "home", "apartment", "bolt", "bulb", "car", "bus", "bike", "moto", "plane",
    "gas", "restaurant", "food", "coffee", "breakfast", "pizza", "icecream",
    "bar", "hospital", "pharmacy", "heart", "medicine", "shirt", "style",
    "subscriptions", "phone", "devices", "wifi", "fitness", "esports", "pool",
    "school", "book", "toy", "theater", "games", "tools", "cleaning", "laundry",
    "smokefree", "pets", "category", "label", "star", "mood",
  ]);
  function cleanIcon(v) {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    if (!s) return null;
    return ICON_KEYS.has(s) ? s : null;
  }

  /* ------------------------------------------------- pyRound parity ------ */
  // Python round(x, n): correct rounding of the exact binary value of the
  // double, ties to even. Implemented on the raw IEEE-754 bits so the JS
  // result is bit-identical to CPython for all values we produce (tests/parity
  // checks this against round() on the real user data).
  function pyRound(x, n) {
    n = n === undefined ? 0 : n;
    if (x === 0) return 0;
    if (typeof x !== "number" || !isFinite(x)) return x;
    const dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, x, false);
    const bits = dv.getBigUint64(0, false);
    const neg = (bits >> 63n) === 1n;
    const fieldExp = (bits >> 52n) & 0x7ffn;
    let mant = bits & 0xfffffffffffffn;
    let mantFull, e2; // x = ± mantFull * 2^e2 (exact)
    if (fieldExp === 0n) { mantFull = mant; e2 = -1075n; }        // subnormal: 2^-1074 * 2^-1
    else { mantFull = mant | (1n << 52n); e2 = BigInt(fieldExp) - 1075n; }
    if (mantFull === 0n) return 0;
    const scale = 10n ** BigInt(n);
    let num = mantFull * scale;   // x * 10^n = num * 2^e2
    let q;
    if (e2 >= 0n) {
      q = num << e2;
    } else {
      const den = 1n << -e2;
      const q0 = num / den;
      const rem = num % den;
      const twice = rem * 2n;
      if (twice > den) q = q0 + 1n;
      else if (twice === den) q = (q0 % 2n === 0n) ? q0 : q0 + 1n;
      else q = q0;
    }
    let r = Number(q) / Number(10n ** BigInt(n));
    return neg ? -r : r;
  }

  /* -------------------------------------------------------- date utils ---- */
  // All dates are epoch days (UTC), exactly like the Python server.
  function monthRange(year, month) {
    const start = dayOfYear(year, month, 1);
    const end = month === 12 ? dayOfYear(year + 1, 1, 1) : dayOfYear(year, month + 1, 1);
    return [start, end];
  }
  function yearRange(year) {
    return [dayOfYear(year, 1, 1), dayOfYear(year + 1, 1, 1)];
  }
  function dayOfYear(y, m, d) {
    return Math.round(Date.UTC(y, m - 1, d) / 86400000);
  }
  function daysInMonth(y, m) {
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  }
  // 1970-01-01 was a Thursday; Python weekday(): Mon=0..Sun=6.
  function weekdayOf(epochDay) {
    return ((epochDay + 3) % 7 + 7) % 7;
  }
  function fromEpochDay(e) {
    const d = new Date(e * 86400000);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
  }

  /* --------------------------------------------------- state container ---- */
  function freshState() {
    return {
      app: "moneyapp",
      version: 1,
      settings: Object.assign({}, DEFAULT_SETTINGS),
      transactions: [],
      categories: SEED_CATEGORIES.map(([name, type, emoji, sortOrder]) =>
        ({ name, type, emoji, icon: null, isVisible: 1, sortOrder })),
      goals: [],
      budgetPlans: [],
      budgetTemplates: [],
    };
  }

  function normInt(v, dflt) {
    if (v === null || v === undefined) return dflt;
    const n = Math.trunc(Number(v));
    return isFinite(n) ? n : dflt;
  }
  function normBool(v) {
    return v === true || v === "1" || v === "true" || v === "True" || v === 1;
  }
  // SQLite rowid of a legacy transaction (null/undefined for rows created
  // in the E2E app — they come "after" every legacy row, as a fresh
  // INSERT would). Used only to reproduce SQLite's stable-sort tie order.
  function normRid(v) {
    if (v == null) return null;
    const n = Math.trunc(Number(v));
    return isFinite(n) && n > 0 ? n : null;
  }
  // rowid DESC with nulls last (SQLite scans the date index backwards,
  // so within a (date, createdAt) tie the newer rowid sorts first)
  function cmpRidDesc(a, b) {
    if (a.rowid == null) return b.rowid == null ? 0 : 1;
    if (b.rowid == null) return -1;
    return b.rowid - a.rowid;
  }
  // rowid ASC with nulls last (plain table/index scan order)
  function cmpRidAsc(a, b) {
    if (a.rowid == null) return b.rowid == null ? 0 : 1;
    if (b.rowid == null) return -1;
    return a.rowid - b.rowid;
  }
  // rowid is an internal SQLite detail: it never appears in API responses
  // (the Python endpoints return tx_row_to_dict without it).
  function stripRid(o) {
    const c = Object.assign({}, o);
    delete c.rowid;
    return c;
  }
  // Mirrors app.py get_settings (typed parse of string values) + typed passthrough.
  function normalizeSettings(s, username) {
    const out = Object.assign({}, DEFAULT_SETTINGS);
    if (s && typeof s === "object") {
      for (const k of Object.keys(s)) {
        const v = s[k];
        if (k === "monthlyCapKopecks") out[k] = Math.trunc(Number(v) || 0);
        else if (k === "capLinkedIncome" || k === "budgetCopyPrevMonth") out[k] = normBool(v);
        else if (k === "capIncomePct") out[k] = Number(v) || 0;
        else out[k] = v;
      }
    }
    if (username != null) out.username = username;
    return out;
  }

  // Legacy export (app.py Api.export / /api/legacy payload) -> canonical state.
  function normalizeExport(exp) {
    if (!exp || typeof exp !== "object") throw new Error("bad backup");
    const now = Date.now();
    const st = freshState();
    st.settings = normalizeSettings(exp.settings, exp.username);
    st.transactions = (exp.transactions || []).map(t => ({
      id: t.id || crypto.randomUUID(),
      date: normInt(t.date, 0),
      type: t.type,
      category: t.category != null ? t.category : "",
      description: t.description != null ? t.description : "",
      amountKopecks: normInt(t.amountKopecks, 0),
      paymentMethod: t.paymentMethod || "CARD",
      tag: t.tag != null ? t.tag : null,
      note: t.note != null ? t.note : null,
      createdAt: normInt(t.createdAt, 0) || now,
      updatedAt: normInt(t.updatedAt, 0) || now,
      rowid: normRid(t.rowid),
    }));
    st.categories = (exp.categories || []).map(c => ({
      name: c.name, type: c.type,
      emoji: c.emoji != null ? c.emoji : "",
      icon: cleanIcon(c.icon),
      isVisible: c.isVisible === 0 ? 0 : 1,
      sortOrder: normInt(c.sortOrder, 0),
    })).filter(c => c.name && c.type);
    st.goals = (exp.goals || []).map(g => ({
      id: g.id, name: g.name,
      description: g.description != null ? g.description : "",
      targetAmountKopecks: normInt(g.targetAmountKopecks, 0),
      deadline: normInt(g.deadline, 0),
      createdAt: normInt(g.createdAt, 0) || now,
      rowid: normRid(g.rowid),
    })).filter(g => g.id && g.name);
    const plans = exp.budgets || exp.budgetPlans || [];
    st.budgetPlans = plans.filter(p => p && p.category && p.type &&
      p.plannedAmountKopecks != null).map(p => ({
      month: normInt(p.month, 0), year: normInt(p.year, 0),
      category: p.category, type: p.type,
      plannedAmountKopecks: normInt(p.plannedAmountKopecks, 0),
    }));
    st.budgetTemplates = (exp.budgetTemplates || []).filter(t => t && t.category && t.type)
      .map(t => ({ category: t.category, type: t.type, amountKopecks: normInt(t.amountKopecks, 0) }));
    return st;
  }

  // Canonical state -> legacy export file (Android BackupData-compatible shape).
  function toExport(state) {
    // Mirrors app.py export: ORDER BY date, createdAt, rowid (forward scan).
    // rowid is kept only when known (Android's Moshi ignores it anyway).
    const txs = state.transactions.slice()
      .sort((a, b) =>
        (a.date - b.date) || (a.createdAt - b.createdAt) || cmpRidAsc(a, b))
      .map(t => {
        const o = Object.assign({}, t);
        if (o.rowid == null) delete o.rowid;
        return o;
      });
    return {
      app: "moneyapp",
      version: 1,
      exportedAt: Date.now(),
      username: state.settings.username || "",
      transactions: txs,
      goals: state.goals.map(g => Object.assign({}, g)),
      categories: state.categories.map(c => Object.assign({}, c)),
      budgets: state.budgetPlans.map(p => ({
        month: p.month, year: p.year, category: p.category, type: p.type,
        plannedAmountKopecks: p.plannedAmountKopecks,
      })),
      budgetTemplates: state.budgetTemplates.map(t => Object.assign({}, t)),
      // settings are not part of the Android BackupData format (Moshi
      // ignores unknown keys); carrying them survives export-import.
      settings: Object.assign({}, state.settings),
    };
  }

  /* ------------------------------------------------------- totals (SQL) --- */
  // Mirrors app.py totals_between / totals_before over transactions[].
  function totalsBetween(state, start, end) {
    const r = { income: 0, expenses: 0, savings: 0, savings_spend: 0 };
    for (const t of state.transactions) {
      if (t.date < start || t.date >= end) continue;
      if (t.type === "INCOME") r.income += t.amountKopecks;
      else if (t.type === "EXPENSE") r.expenses += t.amountKopecks;
      else if (t.type === "SAVINGS") r.savings += t.amountKopecks;
      else if (t.type === "SAVINGS_SPEND") r.savings_spend += t.amountKopecks;
    }
    return r;
  }
  function totalsBefore(state, end) {
    return totalsBetween(state, -Infinity, end);
  }

  // Group sum of EXPENSE + SAVINGS_SPEND by category within [start, end),
  // ordered by total DESC, ties in first-seen order (matches SQLite scan order
  // for our insertion-ordered tables).
  function expenseByCategory(state, start, end) {
    const map = new Map();
    for (const t of state.transactions) {
      if (t.date < start || t.date >= end) continue;
      if (t.type !== "EXPENSE" && t.type !== "SAVINGS_SPEND") continue;
      map.set(t.category, (map.get(t.category) || 0) + t.amountKopecks);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }

  /* ------------------------------------------------------------- cap ----- */
  // Mirrors app.py cap_state (and Android BudgetService.capState).
  function capState(state, year, month) {
    const s = state.settings;
    const fixed = Math.trunc(Number(s.monthlyCapKopecks) || 0);
    const linked = !!s.capLinkedIncome;
    const pct = Number(s.capIncomePct) || 0;
    const [start, end] = monthRange(year, month);
    const m = totalsBetween(state, start, end);
    // v1.11.6: spending from the piggy bank also eats the monthly cap
    const spent = m.expenses + m.savings_spend;
    const income = m.income;
    let incomePart = (linked && pct > 0 && income > 0) ? Math.trunc(income * pct / 100.0) : null;
    let cap;
    if (incomePart !== null && fixed > 0) cap = Math.min(fixed, incomePart);
    else if (incomePart !== null) cap = incomePart;
    else if (fixed > 0) cap = fixed;
    else cap = 0;
    if (cap > 0) {
      let st;
      if (spent > cap * 1.1) st = "OVER";
      else if (spent >= cap * 0.9) st = "CLOSE";
      else st = "OK";
      return ["Ready", {
        capKopecks: cap, spentKopecks: spent,
        percentage: cap ? pyRound(spent * 100.0 / cap, 1) : 0.0,
        status: st,
      }];
    }
    if (linked && pct > 0) {
      // no income this month -> median of the year's monthly incomes
      const [y0, y1] = yearRange(year);
      const vals = [];
      for (let mm = 1; mm <= 12; mm++) {
        const [s0, s1] = monthRange(year, mm);
        if (s0 < y0 || s1 > y1) continue;
        const inc = totalsBetween(state, s0, s1).income;
        if (inc > 0) vals.push(inc);
      }
      vals.sort((a, b) => a - b);
      const n = vals.length;
      const median = n ? (n % 2 ? vals[n >> 1] : Math.floor((vals[n / 2 - 1] + vals[n / 2]) / 2)) : 0;
      let medianCap;
      if (median > 0) {
        const part = Math.trunc(median * pct / 100.0);
        medianCap = fixed > 0 ? Math.min(fixed, part) : part;
      } else medianCap = 0;
      if (medianCap > 0) {
        return ["MedianBased", { capKopecks: medianCap, spentKopecks: spent,
                                 pct: pct, medianIncomeKopecks: median }];
      }
      return ["AwaitingIncome", { pct: pct, spentKopecks: spent }];
    }
    return ["Disabled", null];
  }

  /* ----------------------------------------------------------- summary ---- */
  function summary(state, q) {
    const start = Number(q.start), end = Number(q.end);
    const before = totalsBefore(state, start);
    const period = totalsBetween(state, start, end);
    const balance = (before.income - before.expenses - before.savings) +
                    (period.income - period.expenses - period.savings);
    const rate = period.income > 0 ? (period.savings / period.income * 100.0) : 0.0;
    const mode = q.mode || "month";
    let capSt = "Disabled", info = null;
    if (mode === "month") [capSt, info] = capState(state, Number(q.year), Number(q.month));
    const rows = expenseByCategory(state, start, end);
    const totalExp = rows.reduce((s, r) => s + r[1], 0);
    const breakdown = rows.map(([category, t]) => ({
      category, amountKopecks: t,
      percent: totalExp ? pyRound(t * 100.0 / totalExp, 1) : 0.0,
    }));
    return {
      ok: true,
      balanceKopecks: balance,
      period, before,
      savingsRate: pyRound(rate, 1),
      // v1.11.6: the piggy KPI is the NET of SAVINGS_SPEND
      savingsNetKopecks: period.savings - period.savings_spend,
      cap: { state: capSt, info: info },
      categoryBreakdown: breakdown,
    };
  }

  /* ------------------------------------------------------ transactions ---- */
  // SQLite-default LIKE: ASCII case-insensitive, % and _ wildcards.
  function likeMatch(text, pattern) {
    let ti = 0, pi = 0, star = -1, mark = 0;
    while (ti < text.length) {
      if (pi < pattern.length) {
        const pc = pattern.charCodeAt(pi);
        if (pc === 0x25) { star = pi; mark = ti; pi++; continue; }
        if (pc === 0x5f) { pi++; ti++; continue; }
        let pv = pc, tv = text.charCodeAt(ti);
        if (pv >= 0x41 && pv <= 0x5a) pv += 32;
        if (tv >= 0x41 && tv <= 0x5a) tv += 32;
        if (pv === tv) { pi++; ti++; continue; }
      }
      if (star >= 0) { pi = star + 1; mark++; ti = mark; continue; }
      return false;
    }
    while (pi < pattern.length && pattern.charCodeAt(pi) === 0x25) pi++;
    return pi === pattern.length;
  }

  function listTx(state, f) {
    f = f || {};
    const out = [];
    let i = 0;
    for (const t of state.transactions) {
      const idx = i++;
      if (f.type && t.type !== f.type) continue;
      if (f.category && t.category !== f.category) continue;
      if (f.payment && t.paymentMethod !== f.payment) continue;
      if (f.q != null && f.q !== "" && !likeMatch(t.description, "%" + f.q + "%")) continue;
      if (f.start != null && t.date < Number(f.start)) continue;
      if (f.end != null && t.date > Number(f.end)) continue;
      out.push([t, idx]);
    }
    // Mirrors app.py: ORDER BY date DESC, createdAt DESC, rowid DESC.
    // SQLite scans idx_tx_date backwards for the date term, so within a
    // (date, createdAt) tie the input order is rowid DESC and the stable
    // sorter keeps it; idx DESC is the final fallback for fresh (rowid
    // null) rows.
    out.sort((a, b) =>
      (b[0].date - a[0].date) || (b[0].createdAt - a[0].createdAt) ||
      cmpRidDesc(a[0], b[0]) || (b[1] - a[1]));
    return { ok: true, transactions: out.slice(0, 2000).map(([t]) => stripRid(t)) };
  }

  function validateTx(body) {
    if (!body || body.type !== "INCOME" && body.type !== "EXPENSE" &&
        body.type !== "SAVINGS" && body.type !== "SAVINGS_SPEND") {
      throw new Error("type must be INCOME/EXPENSE/SAVINGS/SAVINGS_SPEND");
    }
    const amt = Number(body.amountKopecks);
    if (!Number.isInteger(amt) || amt <= 0 || typeof body.amountKopecks === "boolean") {
      throw new Error("amountKopecks must be positive int");
    }
  }

  function addTx(state, body) {
    validateTx(body);
    const now = Date.now();
    const tx = {
      id: crypto.randomUUID(),
      date: normInt(body.date, 0),
      type: body.type,
      category: body.category != null ? body.category : "",
      description: body.description != null ? body.description : "",
      amountKopecks: normInt(body.amountKopecks, 0),
      paymentMethod: body.paymentMethod || "CARD",
      tag: body.tag != null ? body.tag : null,
      note: body.note != null ? body.note : null,
      createdAt: now,
      updatedAt: now,
      rowid: null, // E2E row: no SQLite rowid (sorts "newest" in tie order)
    };
    state.transactions.push(tx);
    return { ok: true, transaction: stripRid(tx) };
  }

  function updateTx(state, txid, body) {
    validateTx(body);
    const i = state.transactions.findIndex(t => t.id === txid);
    if (i < 0) throw new Error("not found");
    const t = state.transactions[i];
    t.date = normInt(body.date, 0);
    t.type = body.type;
    t.category = body.category != null ? body.category : "";
    t.description = body.description != null ? body.description : "";
    t.amountKopecks = normInt(body.amountKopecks, 0);
    t.paymentMethod = body.paymentMethod || "CARD";
    t.tag = body.tag != null ? body.tag : null;
    t.note = body.note != null ? body.note : null;
    t.updatedAt = Date.now();
    return listTx(state, {});
  }

  function deleteTx(state, txid) {
    const i = state.transactions.findIndex(t => t.id === txid);
    if (i >= 0) state.transactions.splice(i, 1);
    return { ok: true, deleted: i >= 0 };
  }

  /* ---------------------------------------------------------- categories -- */
  function listCats(state) {
    const rows = state.categories.slice().sort((a, b) =>
      (a.type < b.type ? -1 : a.type > b.type ? 1 : 0) ||
      (a.sortOrder - b.sortOrder) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { ok: true, categories: rows.map(c => Object.assign({}, c)) };
  }

  function addCat(state, body) {
    const name = String(body.name || "").trim();
    const ctype = body.type;
    if (!name || (ctype !== "INCOME" && ctype !== "EXPENSE" && ctype !== "SAVINGS")) {
      throw new Error("name and type required");
    }
    if (state.categories.some(c => c.name === name && c.type === ctype)) {
      throw new Error("duplicate");
    }
    const emoji = { INCOME: "💼", EXPENSE: "📦", SAVINGS: "📈" }[ctype];
    let mx = 0;
    for (const c of state.categories) if (c.type === ctype) mx = Math.max(mx, c.sortOrder || 0);
    state.categories.push({ name, type: ctype, emoji, icon: cleanIcon(body.icon),
                            isVisible: 1, sortOrder: mx + 1 });
    return listCats(state);
  }

  function updateCat(state, oldName, oldType, body) {
    const newName = String(body.name != null ? body.name : oldName).trim();
    const newType = body.type != null ? body.type : oldType;
    if (!newName || (newType !== "INCOME" && newType !== "EXPENSE" && newType !== "SAVINGS")) {
      throw new Error("bad request");
    }
    const dup = state.categories.some(c =>
      c.name === newName && c.type === newType && (c.name !== oldName || c.type !== oldType));
    if (dup) throw new Error("duplicate");
    const row = state.categories.find(c => c.name === oldName && c.type === oldType);
    const icon = body.icon !== undefined ? cleanIcon(body.icon) : (row ? row.icon : null);
    const visible = body.visible === undefined ? 1 : (body.visible ? 1 : 0);
    if (!row) throw new Error("not found");
    row.name = newName; row.type = newType; row.icon = icon; row.isVisible = visible;
    // propagate rename to transactions and budget plans (type-scoped, like Android)
    if (newName !== oldName || newType !== oldType) {
      for (const t of state.transactions)
        if (t.category === oldName && t.type === oldType) t.category = newName;
      for (const p of state.budgetPlans)
        if (p.category === oldName && p.type === oldType) p.category = newName;
    }
    return listCats(state);
  }

  function deleteCat(state, name, type) {
    const i = state.categories.findIndex(c => c.name === name && c.type === type);
    if (i >= 0) state.categories.splice(i, 1);
    return { ok: true, deleted: i >= 0 };
  }

  /* -------------------------------------------------------------- goals --- */
  function listGoals(state, today) {
    const out = [];
    // Mirrors app.py: ORDER BY createdAt, rowid (stable scan order)
    const goals = state.goals.slice().sort((a, b) =>
      (a.createdAt - b.createdAt) || cmpRidAsc(a, b));
    for (const g of goals) {
      let curSum = 0;
      for (const t of state.transactions)
        if (t.type === "SAVINGS" && t.category === g.name) curSum += t.amountKopecks;
      const remaining = g.targetAmountKopecks - curSum;
      let status;
      if (curSum >= g.targetAmountKopecks) status = "COMPLETED";
      else if (g.deadline < today) status = "OVERDUE";
      else status = "IN_PROGRESS";
      const daysLeft = Math.max(1, g.deadline - today);
      const recommended = (status === "IN_PROGRESS" && remaining > 0)
        ? Math.floor(remaining / Math.max(1, Math.ceil(daysLeft / 30)))
        : 0;
      out.push(stripRid(Object.assign({}, g, {
        currentKopecks: curSum, status: status,
        recommendedMonthlyKopecks: recommended,
      })));
    }
    return { ok: true, goals: out };
  }

  function addGoal(state, body) {
    if (!String(body.name || "").trim() || normInt(body.targetAmountKopecks, 0) <= 0) {
      throw new Error("name and targetAmountKopecks required");
    }
    const g = {
      id: crypto.randomUUID(),
      name: String(body.name).trim(),
      description: body.description != null ? body.description : "",
      targetAmountKopecks: normInt(body.targetAmountKopecks, 0),
      deadline: normInt(body.deadline, 0),
      createdAt: Date.now(),
    };
    state.goals.push(g);
    return { ok: true, goal: g };
  }

  function updateGoal(state, gid, body) {
    const g = state.goals.find(x => x.id === gid);
    if (!g) throw new Error("not found");
    for (const k of ["name", "description", "targetAmountKopecks", "deadline"]) {
      if (body[k] !== undefined) {
        g[k] = (k === "targetAmountKopecks" || k === "deadline") ? normInt(body[k], 0) : body[k];
      }
    }
    return { ok: true };
  }

  function deleteGoal(state, gid) {
    const i = state.goals.findIndex(g => g.id === gid);
    if (i >= 0) state.goals.splice(i, 1);
    return { ok: true, deleted: i >= 0 };
  }

  function contribute(state, gid, body, today) {
    const g = state.goals.find(x => x.id === gid);
    if (!g) throw new Error("not found");
    const amt = normInt(body.amountKopecks, 0);
    if (amt <= 0) throw new Error("amount required");
    const now = Date.now();
    const tx = {
      id: crypto.randomUUID(), date: today, type: "SAVINGS",
      category: g.name, description: "Взнос в цель",
      amountKopecks: amt, paymentMethod: "CARD", tag: null,
      note: "Цель: " + gid, createdAt: now, updatedAt: now,
      rowid: null,
    };
    state.transactions.push(tx);
    return { ok: true, transaction: stripRid(tx) };
  }

  /* ------------------------------------------------------------- budget --- */
  function budget(state, year, month) {
    const [cs, info] = capState(state, year, month);
    const [start, end] = monthRange(year, month);
    const s = state.settings;
    const prev = month === 1 ? [year - 1, 12] : [year, month - 1];
    // Effective plans — same priority as Android BudgetService.effectivePlans:
    // explicit plan for the month > template > copy of the previous month.
    const eff = new Map();
    if (s.budgetCopyPrevMonth) {
      for (const p of state.budgetPlans)
        if (p.year === prev[0] && p.month === prev[1] && p.type !== "SUMMARY")
          eff.set(p.category + "\u0000" + p.type, { cat: p.category, typ: p.type,
                                                    planned: p.plannedAmountKopecks, source: "prev" });
    }
    for (const t of state.budgetTemplates)
      if (t.type !== "SUMMARY")
        eff.set(t.category + "\u0000" + t.type, { cat: t.category, typ: t.type,
                                                  planned: t.amountKopecks, source: "template" });
    for (const p of state.budgetPlans)
      if (p.year === year && p.month === month && p.type !== "SUMMARY")
        eff.set(p.category + "\u0000" + p.type, { cat: p.category, typ: p.type,
                                                  planned: p.plannedAmountKopecks, source: "explicit" });
    const entries = [...eff.values()].sort((a, b) =>
      (a.typ < b.typ ? -1 : a.typ > b.typ ? 1 : 0) ||
      (a.cat < b.cat ? -1 : a.cat > b.cat ? 1 : 0));
    const plans = [];
    for (const e of entries) {
      let actual = 0;
      for (const t of state.transactions) {
        if (t.date < start || t.date >= end) continue;
        // v1.11.6: EXPENSE plan actuals also count SAVINGS_SPEND
        if (e.typ === "EXPENSE") {
          if ((t.type === "EXPENSE" || t.type === "SAVINGS_SPEND") && t.category === e.cat)
            actual += t.amountKopecks;
        } else if (t.type === e.typ && t.category === e.cat) {
          actual += t.amountKopecks;
        }
      }
      const pct = e.planned > 0 ? (actual * 100.0 / e.planned) : 0.0;
      let st;
      if (pct > 110) st = "OVER";
      else if (pct > 90) st = "CLOSE";
      else if (pct < 50 && e.typ === "INCOME") st = "UNDER";
      else st = "OK";
      plans.push({ category: e.cat, type: e.typ, plannedKopecks: e.planned,
                   actualKopecks: actual, pct: pyRound(pct, 1), status: st, source: e.source });
    }
    return { ok: true, capState: cs, capInfo: info, plans: plans, settings: state.settings };
  }

  function setCap(state, body) {
    if (body.monthlyCapKopecks !== undefined) state.settings.monthlyCapKopecks = normInt(body.monthlyCapKopecks, 0);
    if (body.capLinkedIncome !== undefined) state.settings.capLinkedIncome = !!body.capLinkedIncome;
    if (body.capIncomePct !== undefined) state.settings.capIncomePct = Number(body.capIncomePct) || 0;
    return { ok: true, settings: state.settings };
  }

  function upsertPlan(state, body) {
    const year = normInt(body.year, 0), month = normInt(body.month, 0);
    const cat = body.category, typ = body.type;
    const amt = normInt(body.plannedAmountKopecks, 0);
    if (typ !== "INCOME" && typ !== "EXPENSE" && typ !== "SAVINGS" || amt < 0) {
      throw new Error("bad plan");
    }
    const i = state.budgetPlans.findIndex(p =>
      p.month === month && p.year === year && p.category === cat && p.type === typ);
    if (i >= 0) state.budgetPlans[i].plannedAmountKopecks = amt;
    else state.budgetPlans.push({ month, year, category: cat, type: typ, plannedAmountKopecks: amt });
    return budget(state, year, month);
  }

  function deletePlan(state, year, month, cat, typ) {
    const i = state.budgetPlans.findIndex(p =>
      p.month === month && p.year === year && p.category === cat && p.type === typ);
    if (i >= 0) state.budgetPlans.splice(i, 1);
    return budget(state, year, month);
  }

  function listTemplates(state) {
    const rows = state.budgetTemplates.slice().sort((a, b) =>
      (a.type < b.type ? -1 : a.type > b.type ? 1 : 0) ||
      (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));
    return { ok: true, templates: rows.map(t => Object.assign({}, t)) };
  }

  function upsertTemplate(state, body) {
    const cat = String(body.category || "").trim();
    const typ = body.type;
    const amt = normInt(body.amountKopecks, 0);
    if (typ !== "INCOME" && typ !== "EXPENSE" && typ !== "SAVINGS" || !cat) {
      throw new Error("bad template");
    }
    const i = state.budgetTemplates.findIndex(t => t.category === cat && t.type === typ);
    if (amt > 0) {
      if (i >= 0) state.budgetTemplates[i].amountKopecks = amt;
      else state.budgetTemplates.push({ category: cat, type: typ, amountKopecks: amt });
    } else if (i >= 0) {
      state.budgetTemplates.splice(i, 1);
    }
    return listTemplates(state);
  }

  /* ---------------------------------------------------------- analytics --- */
  function analytics(state, year, today) {
    const [y0, y1] = yearRange(year);
    const monthly = [];
    for (let mm = 1; mm <= 12; mm++) {
      const [s0, s1] = monthRange(year, mm);
      if (s0 < y0 || s1 > y1) continue;
      const t = totalsBetween(state, s0, s1);
      monthly.push({ month: mm, income: t.income, expenses: t.expenses,
                     savings: t.savings, savings_spend: t.savings_spend });
    }
    const cum = [];
    let acc = 0;
    for (const t of monthly) {
      // v1.11.6: the piggy line is the NET of SAVINGS_SPEND
      acc += t.savings - t.savings_spend;
      cum.push(acc);
    }
    const rows = expenseByCategory(state, y0, y1);
    const totalExp = rows.reduce((s, r) => s + r[1], 0);
    const top5 = rows.slice(0, 5).map(([category, t]) => ({ category, amountKopecks: t }));
    // Mirrors app.py `donut = list(top5)`: a separate ARRAY sharing the SAME
    // dict objects, so the "rest" merge below mutates the top5 entries as
    // well, but donut.push adds an entry to donut only.
    // (Yes, the old server leaked the merged sum into top5 — keep identical.)
    const donut = top5.slice();
    const rest = rows.slice(5).reduce((s, r) => s + r[1], 0);
    if (rest > 0) {
      let merged = false;
      for (const d of donut) {
        if (d.category === "Прочее") { d.amountKopecks += rest; merged = true; break; }
      }
      if (!merged) donut.push({ category: "Прочее", amountKopecks: rest });
    }
    const rates = [];
    for (const t of monthly) {
      if (t.income > 0)
        rates.push({ month: t.month, rate: pyRound(t.savings * 100.0 / t.income, 1) });
    }
    const n = monthly.length;
    const ti = monthly.reduce((s, t) => s + t.income, 0);
    const te = monthly.reduce((s, t) => s + t.expenses, 0);
    // v1.11.6: average savings is the NET of SAVINGS_SPEND
    const ts = monthly.reduce((s, t) => s + (t.savings - t.savings_spend), 0);

    // ==== v1.11.0: extended analytics (mirrored from app.py) ====
    const t0 = today;
    const todayD = fromEpochDay(t0);
    const cy = todayD.y, cm = todayD.m, cd = todayD.d;
    const [mStart, mEnd] = monthRange(cy, cm);
    const [pmStart, pmEnd] = cm > 1 ? monthRange(cy, cm - 1) : monthRange(cy - 1, 12);
    const dim = daysInMonth(cy, cm);

    function monthStartAgo(nMonths) {
      let y = cy, m = cm;
      for (let i = 0; i < nMonths - 1; i++) { m--; if (m < 1) { m = 12; y--; } }
      return dayOfYear(y, m, 1);
    }

    // 1) average check by category
    function avgCheck(start, end) {
      const map = new Map();
      for (const t of state.transactions) {
        if (t.date < start || t.date >= end) continue;
        if (t.type !== "EXPENSE" && t.type !== "SAVINGS_SPEND") continue;
        const e = map.get(t.category) || { category: t.category, count: 0, total: 0 };
        e.count++; e.total += t.amountKopecks;
        map.set(t.category, e);
      }
      return [...map.values()].sort((a, b) =>
        (b.count - a.count) || (b.total - a.total)).slice(0, 6)
        .map(r => ({ category: r.category, count: r.count,
                     avgKopecks: pyRound(r.total / r.count, 0) }));
    }
    const avgCheckMonth = avgCheck(mStart, mEnd);
    const avgCheckYear = avgCheck(monthStartAgo(12), mEnd);

    // 2) top-5 of the month with trend vs the previous month
    const mRows = expenseByCategory(state, mStart, mEnd).slice(0, 5);
    const top5trend = mRows.map(([category, t]) => {
      let prev = 0;
      for (const x of state.transactions)
        if ((x.type === "EXPENSE" || x.type === "SAVINGS_SPEND") && x.category === category &&
            x.date >= pmStart && x.date < pmEnd) prev += x.amountKopecks;
      return {
        category, amountKopecks: t, prevKopecks: prev, deltaKopecks: t - prev,
        deltaPct: prev > 0 ? pyRound((t - prev) * 100.0 / prev, 1) : null,
      };
    });

    // 3) financial cushion
    const bAll = totalsBefore(state, t0 + 1);
    const balanceAll = bAll.income - bAll.expenses - bAll.savings;
    const piggy = bAll.savings - bAll.savings_spend;
    const base = balanceAll + piggy;
    const active = monthly.filter(t => t.expenses > 0 || t.savings_spend > 0);
    const avgExp = active.length
      ? active.reduce((s, t) => s + (t.expenses + t.savings_spend), 0) / active.length
      : 0.0;
    const runway = avgExp > 0 ? (base / avgExp) : null;
    const cushion = {
      balanceKopecks: balanceAll, piggyKopecks: piggy, baseKopecks: base,
      avgMonthlyExpenseKopecks: pyRound(avgExp, 0),
      runwayMonths: runway === null ? null : pyRound(runway, 1),
    };

    // 4) budget pace
    const s = state.settings;
    let pace;
    if (Math.trunc(Number(s.monthlyCapKopecks) || 0) <= 0 && !s.capLinkedIncome) {
      pace = { state: "Disabled", expectedPct: 0.0, spentPct: null,
               spentKopecks: 0, capKopecks: null, status: null };
    } else {
      const [cstate, cinfo] = capState(state, cy, cm);
      const expected = cd / dim;
      const spent = cinfo ? (cinfo.spentKopecks != null ? cinfo.spentKopecks : 0) : 0;
      const cap = cinfo ? cinfo.capKopecks : null;
      const spentPct = cap ? (spent / cap) : null;
      let status = null;
      if (spentPct !== null) {
        const diff = spentPct - expected;
        status = diff > 0.05 ? "BEHIND" : (diff < -0.05 ? "AHEAD" : "ON");
      }
      pace = { state: cstate, expectedPct: pyRound(expected, 4),
               spentPct: spentPct === null ? null : pyRound(spentPct, 4),
               spentKopecks: spent, capKopecks: cap, status: status };
    }

    // 5) big expenses: top-10 of the last 3 months.
    // Mirrors app.py ORDER BY amountKopecks DESC: SQLite feeds the stable
    // sorter rows from idx_tx_type, i.e. (type ASC, rowid ASC), so equal
    // amounts keep that order — replicated here (idx ASC for fresh rows).
    const bigPool = [];
    for (let i = 0; i < state.transactions.length; i++) {
      const t = state.transactions[i];
      if ((t.type === "EXPENSE" || t.type === "SAVINGS_SPEND") &&
          t.date >= monthStartAgo(3) && t.date < t0 + 1) bigPool.push([t, i]);
    }
    const bigExpenses = bigPool
      .sort((a, b) =>
        (b[0].amountKopecks - a[0].amountKopecks) ||
        (a[0].type < b[0].type ? -1 : a[0].type > b[0].type ? 1 : 0) ||
        cmpRidAsc(a[0], b[0]) || (a[1] - b[1]))
      .slice(0, 10)
      .map(([t]) => ({ date: t.date, category: t.category,
                       description: t.description || "", amountKopecks: t.amountKopecks }));

    // 8) balance curve: daily balance of the current month
    const tb = totalsBefore(state, mStart);
    let acc2 = tb.income - tb.expenses - tb.savings;
    const balanceCurve = [];
    for (let dd = 1; dd <= dim; dd++) {
      const day0 = dayOfYear(cy, cm, dd);
      if (day0 > t0) break;
      const t = totalsBetween(state, day0, day0 + 1);
      acc2 += t.income - t.expenses - t.savings;
      balanceCurve.push({ day: dd, balanceKopecks: acc2 });
    }

    // 9) expenses by weekday (current year; 1 = Monday .. 7 = Sunday)
    const wd = [0, 0, 0, 0, 0, 0, 0];
    const byDay = new Map();
    for (const t of state.transactions) {
      if (t.date < y0 || t.date >= y1) continue;
      if (t.type !== "EXPENSE" && t.type !== "SAVINGS_SPEND") continue;
      byDay.set(t.date, (byDay.get(t.date) || 0) + t.amountKopecks);
    }
    for (const [d, v] of byDay) wd[weekdayOf(d)] += v;
    const weekday = wd.map((v, i) => ({ weekday: i + 1, amountKopecks: v }));

    // 10) calendar heatmap: daily expenses, last 12 months — window from
    // TODAY, independent of the analytics year (mirrors the Python query;
    // must NOT reuse byDay, which is filtered by the analytics year)
    const calStart = monthStartAgo(12);
    const calEnd = dayOfYear(cy, cm, 1) + dim;
    const calMap = new Map();
    for (const t of state.transactions) {
      if (t.type !== "EXPENSE" && t.type !== "SAVINGS_SPEND") continue;
      if (t.date < calStart || t.date >= calEnd) continue;
      calMap.set(t.date, (calMap.get(t.date) || 0) + t.amountKopecks);
    }
    const calDays = [...calMap.entries()]
      .map(([d, v]) => ({ date: d, amountKopecks: v }))
      .sort((a, b) => a.date - b.date);
    let calMax = 0;
    for (const r of calDays) calMax = Math.max(calMax, r.amountKopecks);

    return {
      ok: true, year, monthly, cumulative: cum,
      expensesTotalKopecks: totalExp, top5, donut,
      savingsRate: rates,
      averages: {
        incomeKopecks: n ? Math.floor(ti / 12) : 0,
        expenseKopecks: n ? Math.floor(te / 12) : 0,
        savingsKopecks: n ? Math.floor(ts / 12) : 0,
      },
      avgCheck: avgCheckMonth, avgCheckYear,
      top5trend, cushion, pace, bigExpenses,
      balanceCurve, weekday,
      calendar: { days: calDays, maxKopecks: calMax },
    };
  }

  /* ---------------------------------------------------- import / export --- */
  function importBackup(state, body) {
    if (!body || typeof body !== "object" || !Array.isArray(body.transactions)) {
      throw new Error("expected backup JSON with transactions[]");
    }
    const now = Date.now();
    const txs = body.transactions;
    const existing = new Set(state.transactions.map(t => t.id));
    let txAdded = 0;
    for (const t of txs) {
      const tid = t.id || crypto.randomUUID();
      const i = state.transactions.findIndex(x => x.id === tid);
      if (i >= 0) {
        const x = state.transactions[i];
        x.date = normInt(t.date, 0);
        x.type = t.type;
        x.category = t.category != null ? t.category : "";
        x.description = t.description != null ? t.description : "";
        x.amountKopecks = normInt(t.amountKopecks, 0);
        x.paymentMethod = t.paymentMethod || "CARD";
        x.tag = t.tag != null ? t.tag : null;
        x.note = t.note != null ? t.note : null;
        x.updatedAt = normInt(t.updatedAt, 0) || now;
        // SQLite ON CONFLICT(id) DO UPDATE keeps the old rowid
        x.rowid = x.rowid != null ? x.rowid : normRid(t.rowid);
      } else {
        state.transactions.push({
          id: tid,
          date: normInt(t.date, 0),
          type: t.type,
          category: t.category != null ? t.category : "",
          description: t.description != null ? t.description : "",
          amountKopecks: normInt(t.amountKopecks, 0),
          paymentMethod: t.paymentMethod || "CARD",
          tag: t.tag != null ? t.tag : null,
          note: t.note != null ? t.note : null,
          createdAt: normInt(t.createdAt, 0) || now,
          updatedAt: normInt(t.updatedAt, 0) || now,
          rowid: normRid(t.rowid),
        });
        txAdded++;
      }
    }
    const txUpdated = txs.length - txAdded;
    let catAdded = 0;
    for (const c of body.categories || []) {
      if (!c || !c.type || !c.name) continue;
      if (!state.categories.some(x => x.name === c.name && x.type === c.type)) {
        state.categories.push({
          name: c.name, type: c.type,
          emoji: c.emoji != null ? c.emoji : "",
          icon: cleanIcon(c.icon),
          isVisible: c.isVisible === 0 ? 0 : (c.isVisible === undefined ? 1 : c.isVisible ? 1 : 0),
          sortOrder: normInt(c.sortOrder, 0),
        });
        catAdded++;
      }
    }
    let gAdded = 0;
    for (const g of body.goals || []) {
      if (!g || !g.id || !g.name) continue;
      if (!state.goals.some(x => x.id === g.id)) {
        state.goals.push({
          id: g.id, name: g.name,
          description: g.description != null ? g.description : "",
          targetAmountKopecks: normInt(g.targetAmountKopecks, 0),
          deadline: normInt(g.deadline, 0),
          createdAt: normInt(g.createdAt, 0) || now,
        });
        gAdded++;
      }
    }
    let bAdded = 0;
    for (const p of body.budgets || []) {
      if (!p) continue;
      const amt = p.plannedAmountKopecks != null ? p.plannedAmountKopecks : p.amountKopecks;
      if (amt === undefined || amt === null || !p.category || !p.type) continue;
      const m = normInt(p.month, 0), y = normInt(p.year, 0);
      const i = state.budgetPlans.findIndex(x =>
        x.month === m && x.year === y && x.category === p.category && x.type === p.type);
      if (i >= 0) state.budgetPlans[i].plannedAmountKopecks = normInt(amt, 0);
      else { state.budgetPlans.push({ month: m, year: y, category: p.category, type: p.type,
                                      plannedAmountKopecks: normInt(amt, 0) }); bAdded++; }
    }
    let tAdded = 0;
    for (const t of body.budgetTemplates || []) {
      if (!t || !t.category || !t.type) continue;
      const amt = normInt(t.amountKopecks, 0);
      if (amt <= 0) continue;
      const i = state.budgetTemplates.findIndex(x => x.category === t.category && x.type === t.type);
      if (i >= 0) state.budgetTemplates[i].amountKopecks = amt;
      else { state.budgetTemplates.push({ category: t.category, type: t.type, amountKopecks: amt }); tAdded++; }
    }
    // settings: typed merge of the known keys (old backups simply lack the
    // field and pass through untouched)
    if (body.settings && typeof body.settings === "object") {
      for (const k of Object.keys(body.settings)) {
        const v = body.settings[k];
        if (k === "monthlyCapKopecks") state.settings[k] = Math.trunc(Number(v) || 0);
        else if (k === "capLinkedIncome" || k === "budgetCopyPrevMonth") state.settings[k] = normBool(v);
        else if (k === "capIncomePct") state.settings[k] = Number(v) || 0;
        else if (k in state.settings) state.settings[k] = v;
      }
    }
    return { ok: true, txAdded, txUpdated, catAdded: catAdded,
             goalAdded: gAdded, budgetAdded: bAdded, templateAdded: tAdded };
  }

  /* --------------------------------------------------------- seed detect -- */
  // Is a legacy export "real data" (worth migrating), or just server seeds?
  function hasRealData(exp) {
    if (!exp) return false;
    if ((exp.transactions || []).length > 0) return true;
    if ((exp.goals || []).length > 0) return true;
    if ((exp.budgets || []).length > 0) return true;
    if ((exp.budgetTemplates || []).length > 0) return true;
    const s = exp.settings || {};
    if (Math.trunc(Number(s.monthlyCapKopecks) || 0) > 0) return true;
    if (s.capLinkedIncome) return true;
    if (s.budgetCopyPrevMonth) return true;
    if (s.username) return true;
    if (Number(s.capIncomePct) > 0 && Number(s.capIncomePct) !== 30) return true;
    const seed = new Set(SEED_CATEGORIES.map(c => c[0] + "|" + c[1]));
    for (const c of exp.categories || [])
      if (!seed.has(c.name + "|" + c.type)) return true;
    return false;
  }

  return {
    SEED_CATEGORIES, DEFAULT_SETTINGS, cleanIcon, pyRound,
    monthRange, yearRange, dayOfYear, daysInMonth, weekdayOf, fromEpochDay,
    freshState, normalizeExport, normalizeSettings, toExport, hasRealData,
    totalsBetween, totalsBefore, expenseByCategory, capState, summary,
    listTx, addTx, updateTx, deleteTx, likeMatch,
    listCats, addCat, updateCat, deleteCat,
    listGoals, addGoal, updateGoal, deleteGoal, contribute,
    budget, setCap, upsertPlan, deletePlan,
    listTemplates, upsertTemplate,
    analytics, importBackup,
  };
});
