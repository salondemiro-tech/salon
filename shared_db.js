// ============================================================
//  shared_db.js  - Firebase Firestore対応版
//  全HTMLファイルの<head>内で以下のように読み込んでください：
//  <script src="shared_db.js"></script>
// ============================================================

// –––––––––– Firebase設定 ––––––––––
var FIREBASE_CONFIG = {
apiKey: “AIzaSyCbU0t9GipUCu6WQFOJ5QLUjAjiFl3j3TY”,
authDomain: “salon-booking-1d9de.firebaseapp.com”,
projectId: “salon-booking-1d9de”,
storageBucket: “salon-booking-1d9de.firebasestorage.app”,
messagingSenderId: “230269330263”,
appId: “1:230269330263:web:0aa2f6b624f2f3803dd412”
};

// –––––––––– Firebase SDK読み込み ––––––––––
(function() {
var loaded = 0;
var total = 3;
var scripts = [
‘https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js’,
‘https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore-compat.js’,
‘https://www.gstatic.com/firebasejs/9.23.0/firebase-auth-compat.js’
];

window._fbReady = false;
window._fbReadyCbs = [];
window.onFbReady = function(cb) {
if (window._fbReady) { cb(); } else { window._fbReadyCbs.push(cb); }
};

function onAllLoaded() {
firebase.initializeApp(FIREBASE_CONFIG);
window.db = firebase.firestore();
window.auth = firebase.auth();
window._fbReady = true;
for (var i = 0; i < window._fbReadyCbs.length; i++) { window._fbReadyCbs[i](); }
window._fbReadyCbs = [];
}

// app-compatを先に読み込み、残り2つを並列で読み込む
function loadScript(src, cb) {
var s = document.createElement(‘script’);
s.src = src;
s.onload = cb;
s.onerror = cb; // エラー時も次へ進む
document.head.appendChild(s);
}

loadScript(scripts[0], function() {
var done = 0;
function check() { done++; if (done === 2) onAllLoaded(); }
loadScript(scripts[1], check);
loadScript(scripts[2], check);
});
})();

// –––––––––– サロンID管理 ––––––––––
// localStorageにはサロンIDのみ保持（どのサロンとしてログインしているか）
var SALON_ID_KEY = ‘salon_current_id’;

function getCurrentSalonId() {
var id = localStorage.getItem(SALON_ID_KEY);
if (id) return id;
// localStorageにない場合は固定サロンIDを返す
return ‘Ej3SdlceD3PZYJWd9t2dwZLHvx32’;
}
function setCurrentSalonId(id) {
localStorage.setItem(SALON_ID_KEY, id);
}
function clearCurrentSalonId() {
localStorage.removeItem(SALON_ID_KEY);
}

// –––––––––– Firestore パス ––––––––––
function salonDoc(salonId) {
return window.db.collection(‘salons’).doc(salonId);
}
function salonCol(salonId, colName) {
return salonDoc(salonId).collection(colName);
}

// –––––––––– デフォルト値 ––––––––––
var DEFAULT_SETTINGS = {
openTime: ‘10:00’, closeTime: ‘19:00’,
intervalMin: 30, slotMin: 30,
closedDows: [2],
weeklyClose: [{ dow: 3, start: ‘12:00’, end: ‘13:00’ }],
bookingWeeks: 8,
lastMin: ‘same1h’,
deadline: ‘前日24時まで’
};

var DEFAULT_STAMP_CARD = {
enabled: true,
goal: 10,
reward: ‘次回施術10%OFF’,
bonusStamps: [{ at: 5, reward: ‘オプション1品無料’ }],
color: ‘#b5845a’
};

var DEFAULT_CANCEL_POLICY = {
text: ‘・3日前まで：無料\n・2日前〜前日：ご予約料金の50%\n・当日：ご予約料金の100%\n・無断キャンセル：ご予約料金の100%’,
rates: [
{ id: 1, label: ‘3日前から’,     percent: 0   },
{ id: 2, label: ‘前日から’,      percent: 50  },
{ id: 3, label: ‘当日’,          percent: 100 },
{ id: 4, label: ‘無断キャンセル’, percent: 100 }
],
qrUrl: ‘’,
qrMsg: ‘{顧客名} 様\n\nキャンセル規定に基づき、下記のキャンセル料が発生しております。\n\n■ 予約日時：{予約日時}\n■ メニュー：{メニュー}\n■ キャンセル料：{キャンセル料}\n\n下記よりお支払いをお願いいたします。\n{QRリンク}’,
showOnBook: true,
showOnCancel: true
};

var DEFAULT_MENUS = [
{ id: ‘m1’, name: ‘フェイシャルトリートメント’, duration: 90,  price: 12000, type: ‘main’,   public: true },
{ id: ‘m2’, name: ‘ボディケア’,                 duration: 60,  price: 8000,  type: ‘main’,   public: true },
{ id: ‘m3’, name: ‘フェイシャル＋アイ’,          duration: 120, price: 16000, type: ‘main’,   public: true },
{ id: ‘m4’, name: ‘目元ケア’,                   duration: 30,  price: 3000,  type: ‘option’, public: true },
{ id: ‘m5’, name: ‘ヘッドスパ’,                 duration: 20,  price: 2500,  type: ‘option’, public: true },
{ id: ‘m6’, name: ‘デコルテケア’,               duration: 15,  price: 2000,  type: ‘option’, public: true }
];

// –––––––––– salon / auth ––––––––––
function dbGetSalon(cb) {
var id = getCurrentSalonId();
if (!id) { cb(null); return; }
salonDoc(id).get().then(function(doc) {
cb(doc.exists ? doc.data() : null);
}).catch(function() { cb(null); });
}

function dbSaveSalon(salon, cb) {
salonDoc(salon.id).set(salon, { merge: true }).then(function() {
setCurrentSalonId(salon.id);
if (cb) cb(null);
}).catch(function(e) { if (cb) cb(e); });
}

function dbSalonExists(cb) {
var id = getCurrentSalonId();
if (!id) { cb(false); return; }
salonDoc(id).get().then(function(doc) { cb(doc.exists); }).catch(function() { cb(false); });
}

// サロン登録（新規）
function dbRegisterSalon(name, email, password, cb) {
var id = ‘salon_’ + Date.now();
var salon = { id: id, name: name, email: email, password: password };
// 初期設定も同時に作成
var batch = window.db.batch();
batch.set(salonDoc(id), salon);
batch.set(salonDoc(id).collection(‘config’).doc(‘settings’), DEFAULT_SETTINGS);
batch.set(salonDoc(id).collection(‘config’).doc(‘stampCard’), DEFAULT_STAMP_CARD);
batch.set(salonDoc(id).collection(‘config’).doc(‘cancelPolicy’), DEFAULT_CANCEL_POLICY);
// デフォルトメニューも登録
DEFAULT_MENUS.forEach(function(m) {
batch.set(salonCol(id, ‘menus’).doc(m.id), m);
});
batch.commit().then(function() {
setCurrentSalonId(id);
if (cb) cb(null, salon);
}).catch(function(e) { if (cb) cb(e, null); });
}

// メールでサロン検索（ログイン用）
function dbFindSalonByEmail(email, cb) {
window.db.collection(‘salons’).where(‘email’, ‘==’, email).limit(1).get()
.then(function(snap) {
cb(snap.empty ? null : snap.docs[0].data());
}).catch(function() { cb(null); });
}

// –––––––––– settings ––––––––––
function dbGetSettings(cb) {
var id = getCurrentSalonId();
if (!id) { cb(Object.assign({}, DEFAULT_SETTINGS)); return; }
salonDoc(id).collection(‘config’).doc(‘settings’).get().then(function(doc) {
cb(doc.exists ? Object.assign({}, DEFAULT_SETTINGS, doc.data()) : Object.assign({}, DEFAULT_SETTINGS));
}).catch(function() { cb(Object.assign({}, DEFAULT_SETTINGS)); });
}

function dbSaveSettings(s, cb) {
var id = getCurrentSalonId();
if (!id) { if (cb) cb(‘no salon’); return; }
salonDoc(id).collection(‘config’).doc(‘settings’).set(s).then(function() {
if (cb) cb(null);
}).catch(function(e) { if (cb) cb(e); });
}

// –––––––––– menus ––––––––––
function dbGetMenus(cb) {
var id = getCurrentSalonId();
if (!id) { cb([]); return; }
salonCol(id, ‘menus’).orderBy(‘id’).get().then(function(snap) {
var menus = [];
snap.forEach(function(doc) { menus.push(doc.data()); });
cb(menus);
}).catch(function() { cb([]); });
}

function dbGetPublicMenus(cb) {
dbGetMenus(function(menus) {
cb(menus.filter(function(m) { return m.public; }));
});
}

function dbSaveMenus(menus, cb) {
var id = getCurrentSalonId();
if (!id) { if (cb) cb(‘no salon’); return; }
var batch = window.db.batch();
// 既存を全削除して再登録
salonCol(id, ‘menus’).get().then(function(snap) {
snap.forEach(function(doc) { batch.delete(doc.ref); });
menus.forEach(function(m) {
batch.set(salonCol(id, ‘menus’).doc(m.id), m);
});
return batch.commit();
}).then(function() {
if (cb) cb(null);
}).catch(function(e) { if (cb) cb(e); });
}

// –––––––––– customers ––––––––––
function dbGetCustomers(cb) {
var id = getCurrentSalonId();
if (!id) { cb([]); return; }
salonCol(id, ‘customers’).orderBy(‘name’).get().then(function(snap) {
var list = [];
snap.forEach(function(doc) { list.push(doc.data()); });
cb(list);
}).catch(function() { cb([]); });
}

function dbFindCustomer(query, cb) {
dbGetCustomers(function(customers) {
var found = customers.find(function(c) {
return (!query.name || c.name === query.name) && (!query.email || c.email === query.email);
});
cb(found || null);
});
}

function dbAddCustomer(c, cb) {
var id = getCurrentSalonId();
if (!id) { if (cb) cb(‘no salon’, null); return; }
c.id = c.id || (‘c’ + Date.now());
c.stamps = c.stamps || 0;
salonCol(id, ‘customers’).doc(c.id).set(c).then(function() {
if (cb) cb(null, c);
}).catch(function(e) { if (cb) cb(e, null); });
}

function dbUpdateCustomer(customerId, changes, cb) {
var id = getCurrentSalonId();
if (!id) { if (cb) cb(‘no salon’); return; }
salonCol(id, ‘customers’).doc(customerId).update(changes).then(function() {
if (cb) cb(null);
}).catch(function(e) { if (cb) cb(e); });
}

// –––––––––– stamps ––––––––––
function dbAddStamp(customerId, count, cb) {
count = count || 1;
var id = getCurrentSalonId();
if (!id) { if (cb) cb(‘no salon’); return; }
var ref = salonCol(id, ‘customers’).doc(customerId);
ref.get().then(function(doc) {
if (!doc.exists) { if (cb) cb(‘not found’); return; }
var cur = doc.data().stamps || 0;
return ref.update({ stamps: cur + count });
}).then(function() {
if (cb) cb(null);
}).catch(function(e) { if (cb) cb(e); });
}

function dbResetStamps(customerId, cb) {
dbUpdateCustomer(customerId, { stamps: 0 }, cb);
}

function dbGetStampCard(cb) {
var id = getCurrentSalonId();
if (!id) { cb(Object.assign({}, DEFAULT_STAMP_CARD)); return; }
salonDoc(id).collection(‘config’).doc(‘stampCard’).get().then(function(doc) {
cb(doc.exists ? Object.assign({}, DEFAULT_STAMP_CARD, doc.data()) : Object.assign({}, DEFAULT_STAMP_CARD));
}).catch(function() { cb(Object.assign({}, DEFAULT_STAMP_CARD)); });
}

function dbSaveStampCard(sc, cb) {
var id = getCurrentSalonId();
if (!id) { if (cb) cb(‘no salon’); return; }
salonDoc(id).collection(‘config’).doc(‘stampCard’).set(sc).then(function() {
if (cb) cb(null);
}).catch(function(e) { if (cb) cb(e); });
}

// –––––––––– appointments ––––––––––
function dbGetAppointments(cb) {
var id = getCurrentSalonId();
if (!id) { cb([]); return; }
salonCol(id, ‘appointments’).orderBy(‘date’).get().then(function(snap) {
var list = [];
snap.forEach(function(doc) { list.push(doc.data()); });
cb(list);
}).catch(function() { cb([]); });
}

function dbAddAppointment(a, cb) {
var id = getCurrentSalonId();
if (!id) { if (cb) cb(‘no salon’, null); return; }
a.id = a.id || (‘a’ + Date.now());
salonCol(id, ‘appointments’).doc(a.id).set(a).then(function() {
if (cb) cb(null, a);
}).catch(function(e) { if (cb) cb(e, null); });
}

function dbUpdateAppointment(appointmentId, changes, cb) {
var id = getCurrentSalonId();
if (!id) { if (cb) cb(‘no salon’); return; }
salonCol(id, ‘appointments’).doc(appointmentId).update(changes).then(function() {
if (cb) cb(null);
}).catch(function(e) { if (cb) cb(e); });
}

function dbCancelAppointment(appointmentId, cb) {
dbUpdateAppointment(appointmentId, { status: ‘cancelled’ }, cb);
}

// –––––––––– closeBlocks ––––––––––
function dbGetCloseBlocks(cb) {
var id = getCurrentSalonId();
if (!id) { cb([]); return; }
salonCol(id, ‘closeBlocks’).get().then(function(snap) {
var list = [];
snap.forEach(function(doc) { list.push(doc.data()); });
cb(list);
}).catch(function() { cb([]); });
}

function dbAddCloseBlock(b, cb) {
var id = getCurrentSalonId();
if (!id) { if (cb) cb(‘no salon’, null); return; }
b.id = b.id || (‘b’ + Date.now());
salonCol(id, ‘closeBlocks’).doc(b.id).set(b).then(function() {
if (cb) cb(null, b);
}).catch(function(e) { if (cb) cb(e, null); });
}

function dbDeleteCloseBlock(blockId, cb) {
var id = getCurrentSalonId();
if (!id) { if (cb) cb(‘no salon’); return; }
salonCol(id, ‘closeBlocks’).doc(blockId).delete().then(function() {
if (cb) cb(null);
}).catch(function(e) { if (cb) cb(e); });
}

// –––––––––– cancelPolicy ––––––––––
function dbGetCancelPolicy(cb) {
var id = getCurrentSalonId();
if (!id) { cb(Object.assign({}, DEFAULT_CANCEL_POLICY)); return; }
salonDoc(id).collection(‘config’).doc(‘cancelPolicy’).get().then(function(doc) {
cb(doc.exists ? Object.assign({}, DEFAULT_CANCEL_POLICY, doc.data()) : Object.assign({}, DEFAULT_CANCEL_POLICY));
}).catch(function() { cb(Object.assign({}, DEFAULT_CANCEL_POLICY)); });
}

function dbSaveCancelPolicy(p, cb) {
var id = getCurrentSalonId();
if (!id) { if (cb) cb(‘no salon’); return; }
salonDoc(id).collection(‘config’).doc(‘cancelPolicy’).set(p).then(function() {
if (cb) cb(null);
}).catch(function(e) { if (cb) cb(e); });
}

// –––––––––– 予約可能日範囲 ––––––––––
function dbGetBookingDateRange(settings) {
var weeks = (settings && settings.bookingWeeks) || 8;
var today = new Date(); today.setHours(0, 0, 0, 0);
var last = new Date(today); last.setDate(today.getDate() + weeks * 7);
return { from: today, to: last, fromStr: fmtDate(today), toStr: fmtDate(last) };
}

// –––––––––– 予約可否チェック（非同期版） ––––––––––
function canBook(dateStr, startMin, totalDur, excludeId, settings, appointments, closeBlocks, cb) {
var s = settings;
var a = appointments;
var bl = closeBlocks;
var endMin = startMin + totalDur;
var dow = new Date(dateStr).getDay();
var range = dbGetBookingDateRange(s);
if (dateStr < range.fromStr || dateStr > range.toStr) { cb({ ok: false, reason: ‘受付期間外’ }); return; }
if (s.closedDows.indexOf(dow) >= 0) { cb({ ok: false, reason: ‘定休日’ }); return; }
if (startMin < toMin(s.openTime)) { cb({ ok: false, reason: ‘営業時間外’ }); return; }
if (endMin + s.intervalMin > toMin(s.closeTime)) { cb({ ok: false, reason: ‘閉店時間’ }); return; }
var wc = s.weeklyClose || [];
for (var i = 0; i < wc.length; i++) {
if (wc[i].dow === dow) {
var ws = toMin(wc[i].start), we = toMin(wc[i].end);
if (startMin < we && endMin > ws) { cb({ ok: false, reason: ‘定期クローズ’ }); return; }
}
}
for (var j = 0; j < bl.length; j++) {
if (bl[j].date === dateStr) {
var bs = toMin(bl[j].start), be = toMin(bl[j].end);
if (startMin < be && endMin > bs) { cb({ ok: false, reason: ‘クローズ時間’ }); return; }
}
}
for (var k = 0; k < a.length; k++) {
if (a[k].status !== ‘active’ && a[k].status !== ‘visited’) continue;
if (a[k].id === excludeId) continue;
if (a[k].date === dateStr) {
var as = toMin(a[k].start), ae = as + a[k].durationMin + a[k].intervalMin;
if (startMin < ae && endMin + s.intervalMin > as) { cb({ ok: false, reason: ‘予約済み’ }); return; }
}
}
cb({ ok: true });
}

function hasAvailableSlot(dateStr, totalDur, excludeId, settings, appointments, closeBlocks) {
var s = settings, open = toMin(s.openTime), close = toMin(s.closeTime);
for (var m = open; m + totalDur + s.intervalMin <= close; m += s.slotMin) {
var result = { ok: false };
// 同期的チェック（データは既に取得済みの前提）
canBook(dateStr, m, totalDur, excludeId, settings, appointments, closeBlocks, function(r) { result = r; });
if (result.ok) return true;
}
return false;
}

// –––––––––– ユーティリティ ––––––––––
function toMin(t) { var parts = t.split(’:’); return Number(parts[0]) * 60 + Number(parts[1]); }
function toTime(m) { return String(Math.floor(m / 60)).padStart(2, ‘0’) + ‘:’ + String(m % 60).padStart(2, ‘0’); }
function fmtDate(d) {
return d.getFullYear() + ‘-’ +
String(d.getMonth() + 1).padStart(2, ‘0’) + ‘-’ +
String(d.getDate()).padStart(2, ‘0’);
}

// –––––––––– パスワードバリデーション ––––––––––
function validatePassword(pw) {
if (!pw || pw.length < 8) return { ok: false, msg: ‘8文字以上で入力してください’ };
if (!/[a-zA-Z]/.test(pw)) return { ok: false, msg: ‘英字を含めてください’ };
if (!/[0-9]/.test(pw)) return { ok: false, msg: ‘数字を含めてください’ };
return { ok: true };
}

// –––––––––– ログアウト ––––––––––
function dbLogout() {
clearCurrentSalonId();
if (window.auth) window.auth.signOut();
}

// –––––––––– Firebase Authentication ––––––––––
// サロン新規登録（Firebase Auth + Firestore）
function dbAuthRegister(name, email, password, cb) {
window.auth.createUserWithEmailAndPassword(email, password)
.then(function(cred) {
var uid = cred.user.uid;
var salon = { id: uid, name: name, email: email };
var batch = window.db.batch();
batch.set(salonDoc(uid), salon);
batch.set(salonDoc(uid).collection(‘config’).doc(‘settings’), DEFAULT_SETTINGS);
batch.set(salonDoc(uid).collection(‘config’).doc(‘stampCard’), DEFAULT_STAMP_CARD);
batch.set(salonDoc(uid).collection(‘config’).doc(‘cancelPolicy’), DEFAULT_CANCEL_POLICY);
DEFAULT_MENUS.forEach(function(m) {
batch.set(salonCol(uid, ‘menus’).doc(m.id), m);
});
return batch.commit().then(function() {
setCurrentSalonId(uid);
// メール確認送信
cred.user.sendEmailVerification();
if (cb) cb(null, salon);
});
})
.catch(function(e) {
var msg = ‘エラーが発生しました’;
if (e.code === ‘auth/email-already-in-use’) msg = ‘このメールアドレスはすでに登録されています’;
if (e.code === ‘auth/invalid-email’) msg = ‘メールアドレスの形式が正しくありません’;
if (e.code === ‘auth/weak-password’) msg = ‘パスワードは6文字以上で入力してください’;
if (cb) cb({ message: msg });
});
}

// サロンログイン（Firebase Auth）
function dbAuthLogin(email, password, cb) {
window.auth.signInWithEmailAndPassword(email, password)
.then(function(cred) {
var uid = cred.user.uid;
setCurrentSalonId(uid);
return salonDoc(uid).get();
})
.then(function(doc) {
var uid = getCurrentSalonId();
if (cb) cb(null, doc.exists ? doc.data() : { id: uid, email: email, name: '' });
})
.catch(function(e) {
var msg = 'メールアドレスまたはパスワードが正しくありません';
if (cb) cb({ message: msg });
});
}

// パスワードリセットメール送信
function dbAuthSendPasswordReset(email, cb) {
window.auth.sendPasswordResetEmail(email)
.then(function() { if (cb) cb(null); })
.catch(function(e) {
var msg = ‘メールアドレスが見つかりません’;
if (cb) cb({ message: msg });
});
}

// ログイン状態の確認
function dbAuthGetCurrentUser() {
return window.auth ? window.auth.currentUser : null;
}

// 認証状態の変化を監視
function dbAuthOnStateChanged(cb) {
if (window.auth) window.auth.onAuthStateChanged(cb);
}
