// ============================================================
//  shared_db.js  - 全画面共通のlocalStorage読み書き
//  全HTMLファイルの<head>内で以下のように読み込んでください：
//  <script src="shared_db.js"></script>
// ============================================================

const STORAGE_KEY = 'salon_db';

const DEFAULT_DB = {
  salon: { id: null, name: '', email: '', password: '' },
  settings: {
    openTime: '10:00', closeTime: '19:00',
    intervalMin: 30, slotMin: 30,
    closedDows: [2],
    weeklyClose: [{ dow: 3, start: '12:00', end: '13:00' }],
    bookingWeeks: 8,   // 何週間先まで予約可能か（5〜25）
    lastMin: 'same1h',
    deadline: '前日24時まで',
  },
  menus: [
    { id: 'm1', name: 'フェイシャルトリートメント', duration: 90,  price: 12000, type: 'main',   public: true },
    { id: 'm2', name: 'ボディケア',                 duration: 60,  price: 8000,  type: 'main',   public: true },
    { id: 'm3', name: 'フェイシャル＋アイ',          duration: 120, price: 16000, type: 'main',   public: true },
    { id: 'm4', name: '目元ケア',                   duration: 30,  price: 3000,  type: 'option', public: true },
    { id: 'm5', name: 'ヘッドスパ',                 duration: 20,  price: 2500,  type: 'option', public: true },
    { id: 'm6', name: 'デコルテケア',               duration: 15,  price: 2000,  type: 'option', public: true },
  ],
  customers: [
    { id: 'c1', name: '山田 花子', phone: '090-1234-5678', email: 'hanako@example.com', isLine: false, stamps: 0 },
    { id: 'c2', name: '田中 美咲', phone: '090-2222-3333', email: 'misaki@example.com', isLine: false, stamps: 0 },
  ],
  appointments: [
    { id: 'a1', customerId: 'c2', name: '田中 美咲', date: '2026-04-02', start: '11:00', durationMin: 120, intervalMin: 30, menu: 'フェイシャル＋アイ',          status: 'active' },
    { id: 'a2', customerId: 'c1', name: '山田 花子', date: '2026-04-03', start: '14:00', durationMin: 90,  intervalMin: 30, menu: 'フェイシャルトリートメント', status: 'active' },
    { id: 'a3', customerId: 'c1', name: '山田 花子', date: '2026-04-04', start: '10:00', durationMin: 60,  intervalMin: 20, menu: 'ボディケア',                 status: 'active' },
  ],
  closeBlocks: [
    { id: 'b1', date: '2026-04-03', start: '15:30', end: '16:30', reason: '外出' },
  ],
  cancelPolicy: {
    text: '・3日前まで：無料\n・2日前〜前日：ご予約料金の50%\n・当日：ご予約料金の100%\n・無断キャンセル：ご予約料金の100%',
    rates: [
      { id: 1, label: '3日前から',     percent: 0   },
      { id: 2, label: '前日から',      percent: 50  },
      { id: 3, label: '当日',          percent: 100 },
      { id: 4, label: '無断キャンセル', percent: 100 },
    ],
    qrUrl: '',
    qrMsg: '{顧客名} 様\n\nキャンセル規定に基づき、下記のキャンセル料が発生しております。\n\n■ 予約日時：{予約日時}\n■ メニュー：{メニュー}\n■ キャンセル料：{キャンセル料}\n\n下記よりお支払いをお願いいたします。\n{QRリンク}',
    showOnBook: true,
    showOnCancel: true,
  },
  // スタンプカード設定
  stampCard: {
    enabled: true,
    goal: 10,          // 何スタンプで特典か
    reward: '次回施術10%OFF',
    bonusStamps: [     // 途中ボーナス特典（任意）
      { at: 5, reward: 'オプション1品無料' },
    ],
    color: '#b5845a',  // スタンプの色
  },
};

function dbLoad() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_DB));
    return JSON.parse(JSON.stringify(DEFAULT_DB));
  }
  const saved = JSON.parse(raw);
  // settings は深めにマージ
  const merged = Object.assign({}, DEFAULT_DB, saved);
  merged.settings = Object.assign({}, DEFAULT_DB.settings, saved.settings || {});
  merged.stampCard = Object.assign({}, DEFAULT_DB.stampCard, saved.stampCard || {});
  merged.salon = Object.assign({}, DEFAULT_DB.salon, saved.salon || {});
  return merged;
}
function dbSave(db) { localStorage.setItem(STORAGE_KEY, JSON.stringify(db)); }
function dbReset() { localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_DB)); }

// --- settings ---
function dbGetSettings() { return dbLoad().settings; }
function dbSaveSettings(s) { const db = dbLoad(); db.settings = s; dbSave(db); }

// --- salon / auth ---
function dbGetSalon() { return dbLoad().salon; }
function dbSaveSalon(salon) { const db = dbLoad(); db.salon = salon; dbSave(db); }
function dbSalonExists() { const s = dbGetSalon(); return !!(s && s.id); }

// --- menus ---
function dbGetMenus() { return dbLoad().menus; }
function dbGetPublicMenus() { return dbGetMenus().filter(m => m.public); }
function dbSaveMenus(menus) { const db = dbLoad(); db.menus = menus; dbSave(db); }

// --- customers ---
function dbGetCustomers() { return dbLoad().customers; }
function dbFindCustomer({ name, email } = {}) {
  return dbGetCustomers().find(c => (!name || c.name === name) && (!email || c.email === email));
}
function dbAddCustomer(c) { const db = dbLoad(); c.id = c.id || ('c' + Date.now()); db.customers.push(c); dbSave(db); return c; }
function dbUpdateCustomer(id, changes) {
  const db = dbLoad(); const i = db.customers.findIndex(c => c.id === id);
  if (i < 0) return null; db.customers[i] = Object.assign({}, db.customers[i], changes); dbSave(db); return db.customers[i];
}

// --- stamps ---
function dbAddStamp(customerId, count) {
  count = count || 1;
  const db = dbLoad();
  const i = db.customers.findIndex(c => c.id === customerId);
  if (i < 0) return null;
  db.customers[i].stamps = (db.customers[i].stamps || 0) + count;
  dbSave(db);
  return db.customers[i];
}
function dbResetStamps(customerId) {
  return dbUpdateCustomer(customerId, { stamps: 0 });
}
function dbGetStampCard() { return dbLoad().stampCard; }
function dbSaveStampCard(sc) { const db = dbLoad(); db.stampCard = sc; dbSave(db); }

// --- appointments ---
function dbGetAppointments() { return dbLoad().appointments; }
function dbAddAppointment(a) { const db = dbLoad(); a.id = a.id || ('a' + Date.now()); db.appointments.push(a); dbSave(db); return a; }
function dbUpdateAppointment(id, changes) {
  const db = dbLoad(); const i = db.appointments.findIndex(a => a.id === id);
  if (i < 0) return null; db.appointments[i] = Object.assign({}, db.appointments[i], changes); dbSave(db); return db.appointments[i];
}
function dbCancelAppointment(id) { return dbUpdateAppointment(id, { status: 'cancelled' }); }

// --- closeBlocks ---
function dbGetCloseBlocks() { return dbLoad().closeBlocks; }
function dbAddCloseBlock(b) { const db = dbLoad(); b.id = b.id || ('b' + Date.now()); db.closeBlocks.push(b); dbSave(db); return b; }
function dbDeleteCloseBlock(id) { const db = dbLoad(); db.closeBlocks = db.closeBlocks.filter(b => b.id !== id); dbSave(db); }

// --- cancelPolicy ---
function dbGetCancelPolicy() { return dbLoad().cancelPolicy; }
function dbSaveCancelPolicy(p) { const db = dbLoad(); db.cancelPolicy = p; dbSave(db); }

// --- 予約可能日範囲（bookingWeeks設定に従う） ---
function dbGetBookingDateRange() {
  const s = dbGetSettings();
  const weeks = s.bookingWeeks || 8;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const last = new Date(today); last.setDate(today.getDate() + weeks * 7);
  return { from: today, to: last, fromStr: fmtDate(today), toStr: fmtDate(last) };
}

// --- util ---
function toMin(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }
function toTime(m) { return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
function fmtDate(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

function canBook(dateStr, startMin, totalDur, excludeId) {
  const s = dbGetSettings(), a = dbGetAppointments(), bl = dbGetCloseBlocks();
  const endMin = startMin + totalDur, dow = new Date(dateStr).getDay();
  // 予約受付期間チェック
  const range = dbGetBookingDateRange();
  if (dateStr < range.fromStr || dateStr > range.toStr) return { ok: false, reason: '受付期間外' };
  if (s.closedDows.includes(dow)) return { ok: false, reason: '定休日' };
  if (startMin < toMin(s.openTime)) return { ok: false, reason: '営業時間外' };
  if (endMin + s.intervalMin > toMin(s.closeTime)) return { ok: false, reason: '閉店時間' };
  for (const wc of (s.weeklyClose || [])) {
    if (wc.dow === dow) { const ws = toMin(wc.start), we = toMin(wc.end); if (startMin < we && endMin > ws) return { ok: false, reason: '定期クローズ' }; }
  }
  for (const b of bl) {
    if (b.date === dateStr) { const bs = toMin(b.start), be = toMin(b.end); if (startMin < be && endMin > bs) return { ok: false, reason: 'クローズ時間' }; }
  }
  for (const ap of a) {
    if (ap.status !== 'active') continue;
    if (ap.id === excludeId) continue;
    if (ap.date === dateStr) { const as = toMin(ap.start), ae = as + ap.durationMin + ap.intervalMin; if (startMin < ae && endMin + s.intervalMin > as) return { ok: false, reason: '予約済み' }; }
  }
  return { ok: true };
}

function hasAvailableSlot(dateStr, totalDur, excludeId) {
  const s = dbGetSettings(), open = toMin(s.openTime), close = toMin(s.closeTime);
  for (let m = open; m + totalDur + s.intervalMin <= close; m += s.slotMin) {
    if (canBook(dateStr, m, totalDur, excludeId).ok) return true;
  }
  return false;
}

// --- パスワードバリデーション ---
function validatePassword(pw) {
  if (!pw || pw.length < 8) return { ok: false, msg: '8文字以上で入力してください' };
  if (!/[a-zA-Z]/.test(pw)) return { ok: false, msg: '英字を含めてください' };
  if (!/[0-9]/.test(pw)) return { ok: false, msg: '数字を含めてください' };
  return { ok: true };
}
