/*
 * shared_db.js  -  TORITA Phase A-step2 / A-1
 * 作成: 2026/5/14
 *
 * 役割:
 *   Firestore アクセス層の土台。すべての画面はこのファイル経由で DB を読み書きする。
 *
 * 設計準拠:
 *   - DESIGN.md v6 セクション 0-2, 3-3, 3-4, 5-2, 5-4
 *   - firestore.rules (Phase A-step1-1 で deploy 済み) と完全整合
 *   - functions/index.js onAppointmentCreate (Phase A-step1-3 で deploy 済み) と整合
 *
 * 主要な設計判断 (2026/5/14):
 *   - staffs ドキュメント ID は Auth UID (ルールの isSalonStaff() の exists() に従う)
 *   - 予約の staffId フィールド値は 'owner' (Functions が確定するのでクライアントは送らない)
 *   - 顧客作成時 email 必須 (ルール 175-176 行)
 *   - 予約作成時 createdAt はクライアントから送らない (Functions に任せる)
 *
 * ES5 互換:
 *   - var / function / Promise.then のみ
 *   - const / let / アロー関数 / async-await / テンプレートリテラル / ?. は全て禁止
 *
 * コールバック規約:
 *   - 全関数 cb(result) 形式
 *   - 成功時: result = データ または true
 *   - 失敗時: result = null (console.error にログ)
 *   - getCurrentSalonId 等の同期関数のみ例外
 *
 * Firebase SDK 前提:
 *   - firebase-app-compat / firebase-auth-compat / firebase-firestore-compat
 *   - グローバル window.firebase が存在する compat 版で動作
 */

(function () {

  // ============================================================
  // 内部状態
  // ============================================================

  var _fbReady = false;
  var _readyCallbacks = [];
  var _urlSalonId = null;
  var _staffCheckCache = {};

  // ============================================================
  // URL パラメータ ?salon=xxx 解析 (即時実行)
  // ============================================================

  function _parseUrlSalonId() {
    try {
      var qs = window.location.search || '';
      if (qs.charAt(0) === '?') {
        qs = qs.substring(1);
      }
      if (!qs) {
        return null;
      }
      var pairs = qs.split('&');
      var i;
      for (i = 0; i < pairs.length; i++) {
        var kv = pairs[i].split('=');
        if (kv[0] === 'salon' && kv[1]) {
          return decodeURIComponent(kv[1]);
        }
      }
    } catch (e) {
      console.error('[shared_db] URL salon parse error', e);
    }
    return null;
  }
  _urlSalonId = _parseUrlSalonId();

  // ============================================================
  // getCurrentSalonId / getCurrentUserUid (設計書 5-2: 単一定義)
  //
  // 優先順位: URL ?salon=xxx  →  Auth UID  →  null
  // HTML 側は絶対にこの関数を上書きしないこと。
  // ============================================================

  function getCurrentSalonId() {
    if (_urlSalonId) {
      return _urlSalonId;
    }
    if (window.firebase && firebase.auth) {
      var u = firebase.auth().currentUser;
      if (u && u.uid) {
        return u.uid;
      }
    }
    return null;
  }
  window.getCurrentSalonId = getCurrentSalonId;

  function getCurrentUserUid() {
    if (window.firebase && firebase.auth) {
      var u = firebase.auth().currentUser;
      if (u && u.uid) {
        return u.uid;
      }
    }
    return null;
  }
  window.getCurrentUserUid = getCurrentUserUid;

  // ============================================================
  // onFbReady / isFbReady
  //
  // Firebase SDK ロード直後は currentUser が null なので、
  // onAuthStateChanged が 1 度発火するまで _fbReady=true にしない。
  // 各画面は必ず onFbReady(function(){ ... }) でラップして処理を開始する。
  // ============================================================

  function _initFirebaseReady() {
    if (!window.firebase || !firebase.auth) {
      setTimeout(_initFirebaseReady, 100);
      return;
    }
    firebase.auth().onAuthStateChanged(function (user) {
      _staffCheckCache = {};
      if (!_fbReady) {
        _fbReady = true;
        var cbs = _readyCallbacks;
        _readyCallbacks = [];
        var i;
        for (i = 0; i < cbs.length; i++) {
          try {
            cbs[i]();
          } catch (e) {
            console.error('[shared_db] onFbReady cb error', e);
          }
        }
      }
    });
  }
  _initFirebaseReady();

  function onFbReady(cb) {
    if (typeof cb !== 'function') {
      return;
    }
    if (_fbReady) {
      try {
        cb();
      } catch (e) {
        console.error('[shared_db] onFbReady cb error', e);
      }
    } else {
      _readyCallbacks.push(cb);
    }
  }
  window.onFbReady = onFbReady;

  function isFbReady() {
    return _fbReady;
  }
  window.isFbReady = isFbReady;

  // ============================================================
  // 内部ヘルパー
  // ============================================================

  function _db() {
    return firebase.firestore();
  }

  function _serverTimestamp() {
    return firebase.firestore.FieldValue.serverTimestamp();
  }

  function _deleteField() {
    return firebase.firestore.FieldValue.delete();
  }

  function _salonRef() {
    var sid = getCurrentSalonId();
    if (!sid) {
      return null;
    }
    return _db().collection('salons').doc(sid);
  }

  function _safeCb(cb, value) {
    if (typeof cb === 'function') {
      try {
        cb(value);
      } catch (e) {
        console.error('[shared_db] cb error', e);
      }
    }
  }

  function _logErr(label, err) {
    var msg = (err && err.message) ? err.message : String(err);
    var code = (err && err.code) ? err.code : '';
    console.error('[shared_db] ' + label + ' failed:', code, msg);
  }

  // ============================================================
  // requireSalonStaff / requireCustomerAuth
  //
  // 各画面が「自分が読み書きできる立場か」を確認するヘルパー。
  // 実際の権限制御は Firestore Rules が行うが、これはクライアント側で
  // 「無駄なリクエストを送る前に弾く」「画面遷移を制御する」ために使う。
  // ============================================================

  // ログイン中ユーザが現在の salonId のスタッフか
  // 判定: salons/{salonId}/staffs/{Auth UID} が存在するか
  function requireSalonStaff(cb) {
    onFbReady(function () {
      var uid = getCurrentUserUid();
      var sid = getCurrentSalonId();
      if (!uid || !sid) {
        _safeCb(cb, false);
        return;
      }
      var cacheKey = sid + '|' + uid;
      if (_staffCheckCache.hasOwnProperty(cacheKey)) {
        _safeCb(cb, _staffCheckCache[cacheKey]);
        return;
      }
      _db().collection('salons').doc(sid)
        .collection('staffs').doc(uid).get()
        .then(function (snap) {
          var ok = snap.exists;
          _staffCheckCache[cacheKey] = ok;
          _safeCb(cb, ok);
        })
        .catch(function (err) {
          _logErr('requireSalonStaff', err);
          _safeCb(cb, false);
        });
    });
  }
  window.requireSalonStaff = requireSalonStaff;

  // ログイン中ユーザが顧客 (メール認証済み) か
  // 判定: ログイン済み かつ emailVerified == true
  function requireCustomerAuth(cb) {
    onFbReady(function () {
      if (!window.firebase || !firebase.auth) {
        _safeCb(cb, false);
        return;
      }
      var u = firebase.auth().currentUser;
      if (!u) {
        _safeCb(cb, false);
        return;
      }
      if (u.emailVerified !== true) {
        _safeCb(cb, false);
        return;
      }
      _safeCb(cb, true);
    });
  }
  window.requireCustomerAuth = requireCustomerAuth;

  // ============================================================
  // 抽象化レイヤ (将来 onSnapshot に差し替え可能)
  //
  // 各画面は直接 firebase.firestore() を呼ばず、できるだけここを通す。
  // フェーズ 2 でリアルタイム同期に切り替えるとき、ここだけ書き換えれば済む。
  // ============================================================

  function dbReadDoc(path, cb) {
    onFbReady(function () {
      _db().doc(path).get()
        .then(function (snap) {
          if (!snap.exists) {
            _safeCb(cb, null);
            return;
          }
          var data = snap.data();
          data._id = snap.id;
          _safeCb(cb, data);
        })
        .catch(function (err) {
          _logErr('dbReadDoc(' + path + ')', err);
          _safeCb(cb, null);
        });
    });
  }
  window.dbReadDoc = dbReadDoc;

  // queryBuilder は省略可。あれば function(colRef){ return colRef.where(...).orderBy(...) } の形
  function dbReadCollection(path, queryBuilder, cb) {
    onFbReady(function () {
      var ref = _db().collection(path);
      var q = ref;
      if (typeof queryBuilder === 'function') {
        try {
          q = queryBuilder(ref);
        } catch (e) {
          _logErr('dbReadCollection queryBuilder', e);
          _safeCb(cb, null);
          return;
        }
      }
      q.get()
        .then(function (snap) {
          var arr = [];
          snap.forEach(function (d) {
            var data = d.data();
            data._id = d.id;
            arr.push(data);
          });
          _safeCb(cb, arr);
        })
        .catch(function (err) {
          _logErr('dbReadCollection(' + path + ')', err);
          _safeCb(cb, null);
        });
    });
  }
  window.dbReadCollection = dbReadCollection;

  function dbWriteDoc(path, data, mergeBool, cb) {
    onFbReady(function () {
      var opt = mergeBool ? { merge: true } : {};
      _db().doc(path).set(data, opt)
        .then(function () { _safeCb(cb, true); })
        .catch(function (err) {
          _logErr('dbWriteDoc(' + path + ')', err);
          _safeCb(cb, null);
        });
    });
  }
  window.dbWriteDoc = dbWriteDoc;

  function dbUpdateDoc(path, patch, cb) {
    onFbReady(function () {
      _db().doc(path).update(patch)
        .then(function () { _safeCb(cb, true); })
        .catch(function (err) {
          _logErr('dbUpdateDoc(' + path + ')', err);
          _safeCb(cb, null);
        });
    });
  }
  window.dbUpdateDoc = dbUpdateDoc;

  function dbDeleteDoc(path, cb) {
    onFbReady(function () {
      _db().doc(path).delete()
        .then(function () { _safeCb(cb, true); })
        .catch(function (err) {
          _logErr('dbDeleteDoc(' + path + ')', err);
          _safeCb(cb, null);
        });
    });
  }
  window.dbDeleteDoc = dbDeleteDoc;

  function dbAddDoc(collectionPath, data, cb) {
    onFbReady(function () {
      _db().collection(collectionPath).add(data)
        .then(function (ref) {
          _safeCb(cb, { _id: ref.id });
        })
        .catch(function (err) {
          _logErr('dbAddDoc(' + collectionPath + ')', err);
          _safeCb(cb, null);
        });
    });
  }
  window.dbAddDoc = dbAddDoc;

  // ============================================================
  // サロン側 CRUD  (dbSalon*)
  //
  // ログイン中のサロンスタッフが操作する想定。
  // 各関数は内部で getCurrentSalonId() を取得して使う。
  // ============================================================

  // サロン本体ドキュメント (salons/{salonId}) を取得
  function dbSalonGetInfo(cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, null); return; }
    dbReadDoc('salons/' + sid, cb);
  }
  window.dbSalonGetInfo = dbSalonGetInfo;

  // サロン本体ドキュメントを更新 (email は変更不可: ルール 62 行)
  function dbSalonUpdateInfo(patch, cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, null); return; }
    // email 変更はルールで弾かれるが、念のためクライアント側でも防ぐ
    if (patch && patch.hasOwnProperty('email')) {
      delete patch.email;
    }
    dbUpdateDoc('salons/' + sid, patch, cb);
  }
  window.dbSalonUpdateInfo = dbSalonUpdateInfo;

  // config 取得 (settings / cancelPolicy / stampCard など)
  function dbSalonGetConfig(configId, cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, null); return; }
    dbReadDoc('salons/' + sid + '/config/' + configId, cb);
  }
  window.dbSalonGetConfig = dbSalonGetConfig;

  // config 設定 (merge:true で部分更新)
  function dbSalonSetConfig(configId, data, cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, null); return; }
    dbWriteDoc('salons/' + sid + '/config/' + configId, data, true, cb);
  }
  window.dbSalonSetConfig = dbSalonSetConfig;

  // 顧客一覧
  function dbSalonListCustomers(cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, null); return; }
    dbReadCollection('salons/' + sid + '/customers', null, cb);
  }
  window.dbSalonListCustomers = dbSalonListCustomers;

  // 顧客 1 件取得
  function dbSalonGetCustomer(customerId, cb) {
    var sid = getCurrentSalonId();
    if (!sid || !customerId) { _safeCb(cb, null); return; }
    dbReadDoc('salons/' + sid + '/customers/' + customerId, cb);
  }
  window.dbSalonGetCustomer = dbSalonGetCustomer;

  // 顧客更新 (memo / stampCount / lastVisit / totalSpent などスタッフ専用フィールド含む)
  // lineUserId はルールで誰も書けないので、誤って送らないよう除外
  function dbSalonUpdateCustomer(customerId, patch, cb) {
    var sid = getCurrentSalonId();
    if (!sid || !customerId) { _safeCb(cb, null); return; }
    if (patch && patch.hasOwnProperty('lineUserId')) {
      delete patch.lineUserId;
    }
    if (patch) {
      patch.updatedAt = _serverTimestamp();
    }
    dbUpdateDoc('salons/' + sid + '/customers/' + customerId, patch, cb);
  }
  window.dbSalonUpdateCustomer = dbSalonUpdateCustomer;

  // 顧客削除 (オーナーのみ: ルール 199 行)
  function dbSalonDeleteCustomer(customerId, cb) {
    var sid = getCurrentSalonId();
    if (!sid || !customerId) { _safeCb(cb, null); return; }
    dbDeleteDoc('salons/' + sid + '/customers/' + customerId, cb);
  }
  window.dbSalonDeleteCustomer = dbSalonDeleteCustomer;

  // 予約一覧
  // filterObj: { dateKey: '2026-05-14' } のように指定可能 (任意)
  //            指定なしなら全件
  // 注: 大量取得を避けるため、画面側で必ず日付や status などを指定すること
  function dbSalonListAppointments(filterObj, cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, null); return; }
    dbReadCollection('salons/' + sid + '/appointments', function (col) {
      var q = col;
      if (filterObj && filterObj.dateKey) {
        q = q.where('dateKey', '==', filterObj.dateKey);
      }
      if (filterObj && filterObj.dateFrom && filterObj.dateTo) {
        q = q.where('dateKey', '>=', filterObj.dateFrom)
             .where('dateKey', '<=', filterObj.dateTo);
      }
      if (filterObj && filterObj.status) {
        q = q.where('status', '==', filterObj.status);
      }
      if (filterObj && filterObj.customerId) {
        q = q.where('customerId', '==', filterObj.customerId);
      }
      return q;
    }, cb);
  }
  window.dbSalonListAppointments = dbSalonListAppointments;

  // 予約 1 件取得
  function dbSalonGetAppointment(appointmentId, cb) {
    var sid = getCurrentSalonId();
    if (!sid || !appointmentId) { _safeCb(cb, null); return; }
    dbReadDoc('salons/' + sid + '/appointments/' + appointmentId, cb);
  }
  window.dbSalonGetAppointment = dbSalonGetAppointment;

  // 予約更新 (サロン側: status 変更や時間変更など)
  // 注: customerId は変更不可 (ルール 256 行)
  function dbSalonUpdateAppointment(appointmentId, patch, cb) {
    var sid = getCurrentSalonId();
    if (!sid || !appointmentId) { _safeCb(cb, null); return; }
    if (patch && patch.hasOwnProperty('customerId')) {
      delete patch.customerId;
    }
    if (patch) {
      patch.updatedAt = _serverTimestamp();
    }
    dbUpdateDoc('salons/' + sid + '/appointments/' + appointmentId, patch, cb);
  }
  window.dbSalonUpdateAppointment = dbSalonUpdateAppointment;

  // 予約削除 (オーナーのみ: ルール 260 行)
  // 通常は status='cancelled' でソフト削除する方を推奨
  function dbSalonDeleteAppointment(appointmentId, cb) {
    var sid = getCurrentSalonId();
    if (!sid || !appointmentId) { _safeCb(cb, null); return; }
    dbDeleteDoc('salons/' + sid + '/appointments/' + appointmentId, cb);
  }
  window.dbSalonDeleteAppointment = dbSalonDeleteAppointment;

  // ============================================================
  // 顧客側 CRUD  (dbCustomer*)
  //
  // 顧客アプリ (customer_app.html) から呼ばれる想定。
  // URL に ?salon=xxx を持っている前提で getCurrentSalonId() が値を返す。
  // ============================================================

  // 予約画面の最初に表示するサロン情報 (info ドキュメント)
  function dbCustomerGetSalonInfo(cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, null); return; }
    dbReadDoc('salons/' + sid, cb);
  }
  window.dbCustomerGetSalonInfo = dbCustomerGetSalonInfo;

  // 公開メニューのみ取得 (public:true)
  function dbCustomerGetPublicMenus(cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, null); return; }
    dbReadCollection('salons/' + sid + '/menus', function (col) {
      return col.where('public', '==', true);
    }, cb);
  }
  window.dbCustomerGetPublicMenus = dbCustomerGetPublicMenus;

  // 自分の顧客プロフィール (customers/{Auth UID})
  function dbCustomerGetMyProfile(cb) {
    var sid = getCurrentSalonId();
    var uid = getCurrentUserUid();
    if (!sid || !uid) { _safeCb(cb, null); return; }
    dbReadDoc('salons/' + sid + '/customers/' + uid, cb);
  }
  window.dbCustomerGetMyProfile = dbCustomerGetMyProfile;

  // 初回ログイン後の自分のプロフィール作成
  // ルール 169-181 行のホワイトリスト:
  //   許可: name, phone, email, notifyChannels, createdAt
  //   必須: name, email, notifyChannels
  //   notifyChannels: { email: bool, line: bool } のみ
  function dbCustomerCreateMyProfile(data, cb) {
    var sid = getCurrentSalonId();
    var uid = getCurrentUserUid();
    if (!sid || !uid) { _safeCb(cb, null); return; }

    if (!data || !data.name || !data.email) {
      console.error('[shared_db] dbCustomerCreateMyProfile: name and email are required');
      _safeCb(cb, null);
      return;
    }

    // notifyChannels のデフォルト
    var notifyChannels;
    if (data.notifyChannels && typeof data.notifyChannels === 'object') {
      notifyChannels = {
        email: (data.notifyChannels.email !== false),
        line: (data.notifyChannels.line === true)
      };
    } else {
      notifyChannels = { email: true, line: false };
    }

    // ホワイトリストに沿った形でドキュメント構築
    var doc = {
      name: String(data.name),
      email: String(data.email),
      notifyChannels: notifyChannels,
      createdAt: _serverTimestamp()
    };
    if (data.phone) {
      doc.phone = String(data.phone);
    }

    dbWriteDoc('salons/' + sid + '/customers/' + uid, doc, false, cb);
  }
  window.dbCustomerCreateMyProfile = dbCustomerCreateMyProfile;

  // 自分のプロフィール更新 (顧客本人が編集可能なフィールドのみ)
  // ルール 187-191 行:
  //   許可: name, phone, notifyChannels, updatedAt
  function dbCustomerUpdateMyProfile(patch, cb) {
    var sid = getCurrentSalonId();
    var uid = getCurrentUserUid();
    if (!sid || !uid) { _safeCb(cb, null); return; }
    if (!patch) { _safeCb(cb, null); return; }

    // 許可フィールド以外を除去
    var safe = {};
    if (patch.hasOwnProperty('name')) { safe.name = String(patch.name); }
    if (patch.hasOwnProperty('phone')) { safe.phone = String(patch.phone); }
    if (patch.hasOwnProperty('notifyChannels')) {
      var nc = patch.notifyChannels || {};
      safe.notifyChannels = {
        email: (nc.email !== false),
        line: (nc.line === true)
      };
    }
    safe.updatedAt = _serverTimestamp();

    dbUpdateDoc('salons/' + sid + '/customers/' + uid, safe, cb);
  }
  window.dbCustomerUpdateMyProfile = dbCustomerUpdateMyProfile;

  // 自分の予約一覧
  // ルール 209-210 行: 自分が customerId の予約は読める
  function dbCustomerListMyAppointments(cb) {
    var sid = getCurrentSalonId();
    var uid = getCurrentUserUid();
    if (!sid || !uid) { _safeCb(cb, null); return; }
    dbReadCollection('salons/' + sid + '/appointments', function (col) {
      return col.where('customerId', '==', uid);
    }, cb);
  }
  window.dbCustomerListMyAppointments = dbCustomerListMyAppointments;

  // 予約作成 (pendingCreate=true 方式)
  //
  // 設計書 3-4 + ルール 215-240 行:
  //   送れるフィールド:    dateKey, start, customerId, menuId, optionMenuIds, pendingCreate, createdAt
  //   必須フィールド:      dateKey, start, customerId, menuId, pendingCreate
  //   pendingCreate は必ず true
  //
  // 注: end / staffId / resourceIds / status / priceSnapshot 等は Functions が確定する。
  //     クライアントからは絶対に送らない。
  //     createdAt も Functions の serverTimestamp で確定するため、ここでは送らない。
  //
  // data: { dateKey, start, menuId, optionMenuIds? }
  function dbCustomerCreateAppointment(data, cb) {
    var sid = getCurrentSalonId();
    var uid = getCurrentUserUid();
    if (!sid || !uid) {
      console.error('[shared_db] dbCustomerCreateAppointment: not authenticated');
      _safeCb(cb, null);
      return;
    }
    if (!data || !data.dateKey || !data.start || !data.menuId) {
      console.error('[shared_db] dbCustomerCreateAppointment: missing required fields');
      _safeCb(cb, null);
      return;
    }

    // 形式チェック (ルール側でも弾かれるが、ここで先に弾いて無駄なリクエストを防ぐ)
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(data.dateKey)) {
      console.error('[shared_db] dbCustomerCreateAppointment: invalid dateKey');
      _safeCb(cb, null);
      return;
    }
    if (!/^[0-9]{2}:[0-9]{2}$/.test(data.start)) {
      console.error('[shared_db] dbCustomerCreateAppointment: invalid start');
      _safeCb(cb, null);
      return;
    }

    var doc = {
      dateKey: String(data.dateKey),
      start: String(data.start),
      customerId: uid,
      menuId: String(data.menuId),
      pendingCreate: true
    };
    if (data.optionMenuIds && data.optionMenuIds.length > 0) {
      // 配列だけを通す
      var opts = [];
      var i;
      for (i = 0; i < data.optionMenuIds.length; i++) {
        opts.push(String(data.optionMenuIds[i]));
      }
      doc.optionMenuIds = opts;
    }

    dbAddDoc('salons/' + sid + '/appointments', doc, cb);
  }
  window.dbCustomerCreateAppointment = dbCustomerCreateAppointment;

  // 自分の予約をキャンセル
  // ルール 246-252 行: 顧客は confirmed -> cancelled に変更可能
  function dbCustomerCancelMyAppointment(appointmentId, cb) {
    var sid = getCurrentSalonId();
    var uid = getCurrentUserUid();
    if (!sid || !uid || !appointmentId) { _safeCb(cb, null); return; }
    dbUpdateDoc(
      'salons/' + sid + '/appointments/' + appointmentId,
      {
        status: 'cancelled',
        updatedAt: _serverTimestamp()
      },
      cb
    );
  }
  window.dbCustomerCancelMyAppointment = dbCustomerCancelMyAppointment;

  // ============================================================
  // デバッグ用 (本番では呼ばれない想定)
  // ============================================================

  window._sharedDbDebug = {
    getUrlSalonId: function () { return _urlSalonId; },
    getReadyState: function () { return _fbReady; },
    getStaffCache: function () { return _staffCheckCache; },
    clearStaffCache: function () { _staffCheckCache = {}; }
  };

  console.log('[shared_db] loaded. urlSalonId =', _urlSalonId);

})();
