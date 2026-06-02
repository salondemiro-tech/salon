/*
 * shared_db.js  -  TORITA Phase A-step2 / A-1
 * 作成: 2026/5/14
 * 最終改訂: 2026/6/2 (F-3: dbSalonGetCustomerHistory の orderBy 復活)
 *
 * 役割:
 *   Firestore アクセス層の土台。すべての画面はこのファイル経由で DB を読み書きする。
 *
 * 設計準拠:
 *   - DESIGN.md v6 セクション 0-2, 3-3, 3-4, 5-2, 5-4
 *   - firestore.rules (Phase A-step1-1 で deploy 済み) と完全整合
 *   - functions/index.js onAppointmentCreate (Phase A-step1-3 で deploy 済み) と整合
 *
 * ES5 互換: var / function / Promise.then のみ
 */

(function () {

  var _fbReady = false;
  var _readyCallbacks = [];
  var _urlSalonId = null;

  function _parseUrlSalonId() {
    try {
      var qs = window.location.search || '';
      if (qs.charAt(0) === '?') { qs = qs.substring(1); }
      if (!qs) { return null; }
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

  function getCurrentSalonId() {
    if (_urlSalonId) { return _urlSalonId; }
    if (window.firebase && firebase.auth) {
      var u = firebase.auth().currentUser;
      if (u && u.uid) { return u.uid; }
    }
    return null;
  }
  window.getCurrentSalonId = getCurrentSalonId;

  function getCurrentUserUid() {
    if (window.firebase && firebase.auth) {
      var u = firebase.auth().currentUser;
      if (u && u.uid) { return u.uid; }
    }
    return null;
  }
  window.getCurrentUserUid = getCurrentUserUid;

  function _initFirebaseReady() {
    if (!window.firebase || !firebase.auth) {
      setTimeout(_initFirebaseReady, 100);
      return;
    }
    firebase.auth().onAuthStateChanged(function (user) {
      if (!_fbReady) {
        _fbReady = true;
        var cbs = _readyCallbacks;
        _readyCallbacks = [];
        var i;
        for (i = 0; i < cbs.length; i++) {
          try { cbs[i](); }
          catch (e) { console.error('[shared_db] onFbReady cb error', e); }
        }
      }
    });
  }
  _initFirebaseReady();

  function onFbReady(cb) {
    if (typeof cb !== 'function') { return; }
    if (_fbReady) {
      try { cb(); }
      catch (e) { console.error('[shared_db] onFbReady cb error', e); }
    } else {
      _readyCallbacks.push(cb);
    }
  }
  window.onFbReady = onFbReady;

  function isFbReady() { return _fbReady; }
  window.isFbReady = isFbReady;

  function _db() { return firebase.firestore(); }

  function _storage() {
    if (!firebase.storage) {
      console.warn('[shared_db] firebase.storage が未ロード。'
                 + 'firebase-storage-compat.js を <script> に追加してください');
      return null;
    }
    return firebase.storage();
  }

  function _serverTimestamp() {
    return firebase.firestore.FieldValue.serverTimestamp();
  }

  function _functions() {
    if (!firebase.functions) {
      console.warn('[shared_db] firebase.functions が未ロード。'
                 + 'firebase-functions-compat.js を <script> に追加してください');
      return null;
    }
    return firebase.app().functions('asia-northeast1');
  }

  function _deleteField() {
    return firebase.firestore.FieldValue.delete();
  }

  function _salonRef() {
    var sid = getCurrentSalonId();
    if (!sid) { return null; }
    return _db().collection('salons').doc(sid);
  }

  function _safeCb(cb /*, ...args */) {
    if (typeof cb === 'function') {
      var args = Array.prototype.slice.call(arguments, 1);
      try { cb.apply(null, args); }
      catch (e) { console.error('[shared_db] cb error', e); }
    }
  }

  function _logErr(label, err) {
    var msg = (err && err.message) ? err.message : String(err);
    var code = (err && err.code) ? err.code : '';
    console.error('[shared_db] ' + label + ' failed:', code, msg);
  }

  function requireSalonStaff(cb) {
    onFbReady(function () {
      var uid = getCurrentUserUid();
      var sid = getCurrentSalonId();
      if (!uid || !sid) { _safeCb(cb, false); return; }
      _safeCb(cb, uid === sid);
    });
  }
  window.requireSalonStaff = requireSalonStaff;

  function requireCustomerAuth(cb) {
    onFbReady(function () {
      if (!window.firebase || !firebase.auth) { _safeCb(cb, false); return; }
      var u = firebase.auth().currentUser;
      if (!u) { _safeCb(cb, false); return; }
      if (u.emailVerified !== true) { _safeCb(cb, false); return; }
      _safeCb(cb, true);
    });
  }
  window.requireCustomerAuth = requireCustomerAuth;

  function dbReadDoc(path, cb) {
    onFbReady(function () {
      _db().doc(path).get()
        .then(function (snap) {
          if (!snap.exists) { _safeCb(cb, null); return; }
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

  function dbReadCollection(path, queryBuilder, cb) {
    onFbReady(function () {
      var ref = _db().collection(path);
      var q = ref;
      if (typeof queryBuilder === 'function') {
        try { q = queryBuilder(ref); }
        catch (e) {
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
        .then(function (ref) { _safeCb(cb, { _id: ref.id }); })
        .catch(function (err) {
          _logErr('dbAddDoc(' + collectionPath + ')', err);
          _safeCb(cb, null);
        });
    });
  }
  window.dbAddDoc = dbAddDoc;

  function dbSalonGetInfo(cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, null); return; }
    dbReadDoc('salons/' + sid, cb);
  }
  window.dbSalonGetInfo = dbSalonGetInfo;

  function dbSalonUpdateInfo(patch, cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, null); return; }
    if (patch && patch.hasOwnProperty('email')) { delete patch.email; }
    dbUpdateDoc('salons/' + sid, patch, cb);
  }
  window.dbSalonUpdateInfo = dbSalonUpdateInfo;

  function dbSalonGetConfig(configId, cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, null); return; }
    dbReadDoc('salons/' + sid + '/config/' + configId, cb);
  }
  window.dbSalonGetConfig = dbSalonGetConfig;

  function dbSalonSetConfig(configId, data, cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, null); return; }
    dbWriteDoc('salons/' + sid + '/config/' + configId, data, true, cb);
  }
  window.dbSalonSetConfig = dbSalonSetConfig;

  function dbSalonListCustomers(cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, null); return; }
    dbReadCollection('salons/' + sid + '/customers', null, function (list) {
      if (!list) { _safeCb(cb, null); return; }
      var out = [];
      var i;
      for (i = 0; i < list.length; i++) {
        if (list[i] && list[i].isMerged === true) { continue; }
        out.push(list[i]);
      }
      _safeCb(cb, out);
    });
  }
  window.dbSalonListCustomers = dbSalonListCustomers;

  function dbSalonCreateCustomer(data, cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, null); return; }
    if (!data || !data.name) {
      console.error('[shared_db] dbSalonCreateCustomer: name is required');
      _safeCb(cb, null);
      return;
    }
    var notifyChannels;
    if (data.notifyChannels && typeof data.notifyChannels === 'object') {
      notifyChannels = {
        email: (data.notifyChannels.email === true),
        line: (data.notifyChannels.line === true)
      };
    } else {
      notifyChannels = { email: false, line: false };
    }
    var doc = {
      name: String(data.name),
      phone: data.phone ? String(data.phone) : '',
      email: data.email ? String(data.email) : '',
      authUid: null,
      createdSource: 'salon',
      notifyChannels: notifyChannels,
      isMerged: false,
      mergedInto: null,
      mergedAt: null,
      mergedAliases: [],
      createdAt: _serverTimestamp()
    };
    dbAddDoc('salons/' + sid + '/customers', doc, cb);
  }
  window.dbSalonCreateCustomer = dbSalonCreateCustomer;

  function dbSalonGetCustomer(customerDocId, cb) {
    var sid = getCurrentSalonId();
    if (!sid || !customerDocId) { _safeCb(cb, null); return; }
    dbReadDoc('salons/' + sid + '/customers/' + customerDocId, cb);
  }
  window.dbSalonGetCustomer = dbSalonGetCustomer;

  function dbSalonUpdateCustomer(customerDocId, patch, cb) {
    var sid = getCurrentSalonId();
    if (!sid || !customerDocId) { _safeCb(cb, null); return; }
    if (patch) {
      var _protected = [
        'lineUserId', 'authUid', 'isMerged', 'mergedInto',
        'mergedAt', 'mergedAliases', 'createdSource', 'lockedByJob'
      ];
      var i;
      for (i = 0; i < _protected.length; i++) {
        if (patch.hasOwnProperty(_protected[i])) { delete patch[_protected[i]]; }
      }
      patch.updatedAt = _serverTimestamp();
    }
    dbUpdateDoc('salons/' + sid + '/customers/' + customerDocId, patch, cb);
  }
  window.dbSalonUpdateCustomer = dbSalonUpdateCustomer;

  function dbSalonDeleteCustomer(customerDocId, cb) {
    var sid = getCurrentSalonId();
    if (!sid || !customerDocId) { _safeCb(cb, null); return; }
    dbDeleteDoc('salons/' + sid + '/customers/' + customerDocId, cb);
  }
  window.dbSalonDeleteCustomer = dbSalonDeleteCustomer;

  // ------------------------------------------------------------
  // Phase B-8: サロン側 顧客詳細の来店履歴 (current + archive 統合)
  //   戻り値: { current, archive, merged, upcoming, visits, excluded }
  // ------------------------------------------------------------
  function dbSalonGetCustomerHistory(customerDocId, cb) {
    var sid = getCurrentSalonId();
    if (!sid || !customerDocId) { _safeCb(cb, null); return; }

    var HISTORY_LIMIT = 100;

    function _queryCust(col) {
      // ★ v8.1: 予約は customerDocId を持つ（旧 customerId 廃止）
      // ★ 2026/6/2 F-3: 複合インデックス (customerDocId Asc, dateKey Desc)
      //   が appointments / appointments_archive 両方に作成・有効化された
      //   ため、暫定で外していた orderBy を復活。
      //   limit(100) が「新しい順100件」になる（旧: 順序不定100件）。
      //   取得後の merged.sort は current+archive 統合の最終並び保証として残す。
      return col.where('customerDocId', '==', customerDocId)
                .orderBy('dateKey', 'desc')
                .limit(HISTORY_LIMIT);
    }

    _parallelLoad([
      {
        key: 'current',
        run: function (done) {
          dbReadCollection(
            'salons/' + sid + '/appointments',
            _queryCust,
            function (v) { done(v || []); }
          );
        }
      },
      {
        key: 'archive',
        run: function (done) {
          dbReadCollection(
            'salons/' + sid + '/appointments_archive',
            _queryCust,
            function (v) { done(v || []); }
          );
        }
      }
    ], function (bundle) {
      var cur = bundle.current || [];
      var arc = bundle.archive || [];
      var merged = [];
      var i;
      for (i = 0; i < cur.length; i++) { merged.push(cur[i]); }
      for (i = 0; i < arc.length; i++) { merged.push(arc[i]); }
      merged.sort(function (a, b) {
        var ak = a.dateKey || '';
        var bk = b.dateKey || '';
        if (ak === bk) {
          var as = a.start || '';
          var bs = b.start || '';
          if (as === bs) { return 0; }
          return (as < bs) ? 1 : -1;
        }
        return (ak < bk) ? 1 : -1;
      });

      var nowMs = Date.now();
      var upcoming = [];
      var visits = [];
      var excluded = [];
      var j;
      for (j = 0; j < merged.length; j++) {
        var a = merged[j];
        var st = a.status || 'confirmed';
        if (st === 'cancelled' || st === 'no_show'
            || st === 'pendingCreate') {
          excluded.push(a);
          continue;
        }
        if (st === 'visited') { visits.push(a); continue; }
        var endMs = _calcEndMs(a);
        if (endMs == null) { upcoming.push(a); }
        else if (endMs >= nowMs) { upcoming.push(a); }
        else { visits.push(a); }
      }
      upcoming.sort(function (a, b) {
        var ak = a.dateKey || '';
        var bk = b.dateKey || '';
        if (ak === bk) {
          var as = a.start || '';
          var bs = b.start || '';
          if (as === bs) { return 0; }
          return (as < bs) ? -1 : 1;
        }
        return (ak < bk) ? -1 : 1;
      });
      visits.sort(function (a, b) {
        var ak = a.dateKey || '';
        var bk = b.dateKey || '';
        if (ak === bk) {
          var as = a.start || '';
          var bs = b.start || '';
          if (as === bs) { return 0; }
          return (as < bs) ? 1 : -1;
        }
        return (ak < bk) ? 1 : -1;
      });

      _safeCb(cb, {
        current: cur,
        archive: arc,
        merged: merged,
        upcoming: upcoming,
        visits: visits,
        excluded: excluded
      });
    });
  }
  window.dbSalonGetCustomerHistory = dbSalonGetCustomerHistory;

  function _calcEndMs(a) {
    if (!a) { return null; }
    if (a.endAt && typeof a.endAt.toMillis === 'function') {
      return a.endAt.toMillis();
    }
    if (a.dateKey && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(a.dateKey)
        && a.end && /^[0-9]{2}:[0-9]{2}$/.test(a.end)) {
      var p = a.dateKey.split('-');
      var t = a.end.split(':');
      var dt = new Date(parseInt(p[0], 10),
                         parseInt(p[1], 10) - 1,
                         parseInt(p[2], 10),
                         parseInt(t[0], 10),
                         parseInt(t[1], 10));
      return dt.getTime();
    }
    if (a.dateKey && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(a.dateKey)) {
      var p2 = a.dateKey.split('-');
      var dt2 = new Date(parseInt(p2[0], 10),
                          parseInt(p2[1], 10) - 1,
                          parseInt(p2[2], 10),
                          23, 59, 59);
      return dt2.getTime();
    }
    return null;
  }

  function dbSalonListMenus(cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, null); return; }
    dbReadCollection('salons/' + sid + '/menus', null, function (list) {
      if (!list) { _safeCb(cb, null); return; }
      list.sort(function (a, b) {
        var ao = (typeof a.sortOrder === 'number') ? a.sortOrder : 999999;
        var bo = (typeof b.sortOrder === 'number') ? b.sortOrder : 999999;
        if (ao !== bo) { return ao - bo; }
        var an = (a && a.name) ? String(a.name) : '';
        var bn = (b && b.name) ? String(b.name) : '';
        if (an === bn) { return 0; }
        return (an < bn) ? -1 : 1;
      });
      _safeCb(cb, list);
    });
  }
  window.dbSalonListMenus = dbSalonListMenus;

  function dbSalonGetMenu(menuId, cb) {
    var sid = getCurrentSalonId();
    if (!sid || !menuId) { _safeCb(cb, null); return; }
    dbReadDoc('salons/' + sid + '/menus/' + menuId, cb);
  }
  window.dbSalonGetMenu = dbSalonGetMenu;

  function dbSalonCreateMenu(data, cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, null); return; }
    if (!data || !data.name) {
      console.error('[shared_db] dbSalonCreateMenu: name is required');
      _safeCb(cb, null); return;
    }
    var dur = parseInt(data.duration, 10);
    if (isNaN(dur) || dur <= 0) {
      console.error('[shared_db] dbSalonCreateMenu: duration must be > 0');
      _safeCb(cb, null); return;
    }
    var pr = parseInt(data.price, 10);
    if (isNaN(pr) || pr < 0) { pr = 0; }
    var typ = (data.type === 'option') ? 'option' : 'main';
    var pub = (data.public !== false);
    var doc = {
      name: String(data.name),
      duration: dur,
      price: pr,
      type: typ,
      public: pub,
      eligibleStaffIds: ['owner'],
      requiredResourceIds: ['default'],
      createdAt: _serverTimestamp()
    };
    if (data.description) { doc.description = String(data.description); }
    if (data.contraindications) { doc.contraindications = String(data.contraindications); }
    if (data.photoUrl) { doc.photoUrl = String(data.photoUrl); }
    if (typeof data.sortOrder === 'number' && data.sortOrder >= 0) {
      doc.sortOrder = parseInt(data.sortOrder, 10);
    }
    dbAddDoc('salons/' + sid + '/menus', doc, cb);
  }
  window.dbSalonCreateMenu = dbSalonCreateMenu;

  function dbSalonUpdateMenu(menuId, patch, cb) {
    var sid = getCurrentSalonId();
    if (!sid || !menuId) { _safeCb(cb, null); return; }
    if (patch) {
      var _protected = ['createdAt', 'eligibleStaffIds', 'requiredResourceIds'];
      var i;
      for (i = 0; i < _protected.length; i++) {
        if (patch.hasOwnProperty(_protected[i])) { delete patch[_protected[i]]; }
      }
      if (patch.hasOwnProperty('duration')) {
        var d = parseInt(patch.duration, 10);
        if (isNaN(d) || d <= 0) { delete patch.duration; }
        else { patch.duration = d; }
      }
      if (patch.hasOwnProperty('price')) {
        var p = parseInt(patch.price, 10);
        if (isNaN(p) || p < 0) { p = 0; }
        patch.price = p;
      }
      if (patch.hasOwnProperty('type') &&
          patch.type !== 'main' && patch.type !== 'option') {
        delete patch.type;
      }
      if (patch.hasOwnProperty('public')) {
        patch.public = (patch.public === true);
      }
      if (patch.hasOwnProperty('sortOrder')) {
        var so = parseInt(patch.sortOrder, 10);
        if (isNaN(so) || so < 0) { delete patch.sortOrder; }
        else { patch.sortOrder = so; }
      }
      patch.updatedAt = _serverTimestamp();
    }
    dbUpdateDoc('salons/' + sid + '/menus/' + menuId, patch, cb);
  }
  window.dbSalonUpdateMenu = dbSalonUpdateMenu;

  function dbSalonDeleteMenu(menuId, cb) {
    var sid = getCurrentSalonId();
    if (!sid || !menuId) { _safeCb(cb, null); return; }
    dbDeleteDoc('salons/' + sid + '/menus/' + menuId, cb);
  }
  window.dbSalonDeleteMenu = dbSalonDeleteMenu;

  function dbSalonReorderMenus(orderList, cb) {
    var sid = getCurrentSalonId();
    if (!sid || !orderList || orderList.length === 0) {
      _safeCb(cb, false); return;
    }
    var done = 0, errCount = 0;
    var total = orderList.length;
    var i;
    function _one(item) {
      dbUpdateDoc('salons/' + sid + '/menus/' + item._id,
        { sortOrder: item.sortOrder, updatedAt: _serverTimestamp() },
        function (ok) {
          if (!ok) { errCount++; }
          done++;
          if (done >= total) { _safeCb(cb, errCount === 0); }
        });
    }
    for (i = 0; i < total; i++) {
      if (orderList[i] && orderList[i]._id != null
          && typeof orderList[i].sortOrder === 'number') {
        _one(orderList[i]);
      } else {
        done++;
        if (done >= total) { _safeCb(cb, errCount === 0); }
      }
    }
  }
  window.dbSalonReorderMenus = dbSalonReorderMenus;

  function dbGetSettings(cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, _defaultSettings()); return; }
    dbReadDoc('salons/' + sid + '/config/settings', function (doc) {
      if (!doc) { _safeCb(cb, _defaultSettings()); return; }
      var base = _defaultSettings();
      var k;
      for (k in doc) { if (doc.hasOwnProperty(k)) { base[k] = doc[k]; } }
      _safeCb(cb, base);
    });
  }
  window.dbGetSettings = dbGetSettings;

  function dbSaveSettings(settings, cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, new Error('no salon')); return; }
    if (!settings || typeof settings !== 'object') {
      _safeCb(cb, new Error('invalid settings')); return;
    }
    var doc = {};
    if (typeof settings.openTime === 'string')  { doc.openTime  = settings.openTime; }
    if (typeof settings.closeTime === 'string') { doc.closeTime = settings.closeTime; }
    if (settings.intervalMin != null) {
      var iv = parseInt(settings.intervalMin, 10);
      if (!isNaN(iv) && iv >= 0) { doc.intervalMin = iv; }
    }
    if (typeof settings.intervalInClose === 'boolean') {
      doc.intervalInClose = settings.intervalInClose;
    }
    if (settings.slotMin != null) {
      var sm = parseInt(settings.slotMin, 10);
      if (!isNaN(sm) && sm > 0) { doc.slotMin = sm; }
    }
    if (Array.isArray(settings.closedDows)) {
      doc.closedDows = settings.closedDows.slice();
    }
    if (Array.isArray(settings.weeklyClose)) {
      doc.weeklyClose = settings.weeklyClose.map(function (w) {
        return {
          dow: parseInt(w.dow, 10),
          start: String(w.start || ''),
          end: String(w.end || '')
        };
      });
    }
    if (settings.bookingWeeks != null) {
      var bw = parseInt(settings.bookingWeeks, 10);
      if (!isNaN(bw) && bw > 0) { doc.bookingWeeks = bw; }
    }
    if (typeof settings.lastMin === 'string')  { doc.lastMin = settings.lastMin; }
    if (typeof settings.deadline === 'string') { doc.deadline = settings.deadline; }
    doc.updatedAt = _serverTimestamp();
    dbWriteDoc('salons/' + sid + '/config/settings', doc, true,
      function (ok) { _safeCb(cb, ok ? null : new Error('save failed')); });
  }
  window.dbSaveSettings = dbSaveSettings;

  function _defaultSettings() {
    return {
      openTime: '10:00', closeTime: '19:00', intervalMin: 30,
      intervalInClose: false, slotMin: 30, closedDows: [],
      weeklyClose: [], bookingWeeks: 8, lastMin: 'same1h',
      deadline: '前日まで'
    };
  }

  function dbGetCancelPolicy(cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, _defaultCancelPolicy()); return; }
    dbReadDoc('salons/' + sid + '/config/cancelPolicy', function (doc) {
      if (!doc) { _safeCb(cb, _defaultCancelPolicy()); return; }
      var base = _defaultCancelPolicy();
      var k;
      for (k in doc) { if (doc.hasOwnProperty(k)) { base[k] = doc[k]; } }
      _safeCb(cb, base);
    });
  }
  window.dbGetCancelPolicy = dbGetCancelPolicy;

  function dbSaveCancelPolicy(policy, cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, new Error('no salon')); return; }
    if (!policy || typeof policy !== 'object') {
      _safeCb(cb, new Error('invalid policy')); return;
    }
    var doc = {};
    if (typeof policy.text === 'string')  { doc.text  = policy.text; }
    if (typeof policy.qrUrl === 'string') { doc.qrUrl = policy.qrUrl; }
    if (typeof policy.qrMsg === 'string') { doc.qrMsg = policy.qrMsg; }
    if (typeof policy.showOnBook === 'boolean') { doc.showOnBook = policy.showOnBook; }
    if (typeof policy.showOnCancel === 'boolean') { doc.showOnCancel = policy.showOnCancel; }
    if (Array.isArray(policy.rates)) {
      doc.rates = policy.rates.map(function (r) {
        var p = parseInt(r.percent, 10);
        if (isNaN(p) || p < 0) { p = 0; }
        if (p > 100) { p = 100; }
        return { label: String(r.label || ''), percent: p };
      });
    }
    doc.updatedAt = _serverTimestamp();
    dbWriteDoc('salons/' + sid + '/config/cancelPolicy', doc, true,
      function (ok) { _safeCb(cb, ok ? null : new Error('save failed')); });
  }
  window.dbSaveCancelPolicy = dbSaveCancelPolicy;

  function _defaultCancelPolicy() {
    return {
      text: '',
      rates: [
        { label: '3日前から', percent: 30 },
        { label: '前日から',  percent: 50 },
        { label: '当日',      percent: 100 },
        { label: '無断キャンセル', percent: 100 }
      ],
      showOnBook: true, showOnCancel: true, qrUrl: '', qrMsg: ''
    };
  }

  function dbGetStampCard(cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, _defaultStampCard()); return; }
    dbReadDoc('salons/' + sid + '/config/stampCard', function (doc) {
      if (!doc) { _safeCb(cb, _defaultStampCard()); return; }
      var base = _defaultStampCard();
      var k;
      for (k in doc) { if (doc.hasOwnProperty(k)) { base[k] = doc[k]; } }
      _safeCb(cb, base);
    });
  }
  window.dbGetStampCard = dbGetStampCard;

  function dbSaveStampCard(policy, cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, new Error('no salon')); return; }
    if (!policy || typeof policy !== 'object') {
      _safeCb(cb, new Error('invalid policy')); return;
    }
    var doc = {};
    if (typeof policy.enabled === 'boolean') { doc.enabled = policy.enabled; }
    if (policy.goal != null) {
      var g = parseInt(policy.goal, 10);
      if (!isNaN(g) && g >= 1 && g <= 100) { doc.goal = g; }
    }
    if (typeof policy.reward === 'string') { doc.reward = policy.reward; }
    if (typeof policy.color === 'string')  { doc.color  = policy.color; }
    if (typeof policy.expiry === 'string'
        && ['3m','6m','12m','none'].indexOf(policy.expiry) >= 0) {
      doc.expiry = policy.expiry;
    }
    if (Array.isArray(policy.bonusStamps)) {
      doc.bonusStamps = policy.bonusStamps.map(function (b) {
        var at = parseInt(b.at, 10);
        if (isNaN(at) || at < 1) { at = 1; }
        return { at: at, reward: String(b.reward || '') };
      });
    }
    doc.updatedAt = _serverTimestamp();
    dbWriteDoc('salons/' + sid + '/config/stampCard', doc, true,
      function (ok) { _safeCb(cb, ok ? null : new Error('save failed')); });
  }
  window.dbSaveStampCard = dbSaveStampCard;

  function _defaultStampCard() {
    return {
      enabled: false, goal: 10, reward: '', bonusStamps: [],
      color: '#b5845a', expiry: 'none'
    };
  }

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
      if (filterObj && filterObj.customerDocId) {
        q = q.where('customerDocId', '==', filterObj.customerDocId);
      }
      return q;
    }, cb);
  }
  window.dbSalonListAppointments = dbSalonListAppointments;

  function dbSalonGetAppointment(appointmentId, cb) {
    var sid = getCurrentSalonId();
    if (!sid || !appointmentId) { _safeCb(cb, null); return; }
    dbReadDoc('salons/' + sid + '/appointments/' + appointmentId, cb);
  }
  window.dbSalonGetAppointment = dbSalonGetAppointment;

  function dbSalonUpdateAppointment(appointmentId, patch, cb) {
    var sid = getCurrentSalonId();
    if (!sid || !appointmentId) { _safeCb(cb, null); return; }
    if (patch && patch.hasOwnProperty('customerDocId')) { delete patch.customerDocId; }
    if (patch && patch.hasOwnProperty('authUid')) { delete patch.authUid; }
    if (patch) { patch.updatedAt = _serverTimestamp(); }
    dbUpdateDoc('salons/' + sid + '/appointments/' + appointmentId, patch, cb);
  }
  window.dbSalonUpdateAppointment = dbSalonUpdateAppointment;

  function dbSalonUpdateAppointmentStatus(aid, newStatus, cb) {
    var sid = getCurrentSalonId();
    if (!sid || !aid) { _safeCb(cb, null); return; }
    var ALLOWED = ['confirmed', 'visited', 'cancelled', 'no_show'];
    if (ALLOWED.indexOf(newStatus) < 0) {
      _logErr('dbSalonUpdateAppointmentStatus', 'invalid status: ' + newStatus);
      _safeCb(cb, null);
      return;
    }
    dbSalonUpdateAppointment(aid, { status: newStatus }, cb);
  }
  window.dbSalonUpdateAppointmentStatus = dbSalonUpdateAppointmentStatus;

  function dbSalonCreateAppointment(data, cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, null); return; }
    if (!data || !data.dateKey || !data.start
        || !data.customerDocId || !data.menuId) {
      console.error('[shared_db] dbSalonCreateAppointment: '
                  + 'dateKey/start/customerDocId/menuId are required');
      _safeCb(cb, null);
      return;
    }
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(String(data.dateKey))) {
      console.error('[shared_db] invalid dateKey'); _safeCb(cb, null); return;
    }
    if (!/^[0-9]{2}:[0-9]{2}$/.test(String(data.start))) {
      console.error('[shared_db] invalid start'); _safeCb(cb, null); return;
    }
    var doc = {
      dateKey: String(data.dateKey),
      start: String(data.start),
      customerDocId: String(data.customerDocId),
      authUid: null,
      menuId: String(data.menuId),
      status: 'confirmed',
      source: 'manual',
      staffId: 'owner',
      resourceIds: ['default'],
      createdAt: _serverTimestamp()
    };
    if (Array.isArray(data.optionMenuIds)) {
      doc.optionMenuIds = data.optionMenuIds.map(String);
    }
    if (typeof data.end === 'string' && /^[0-9]{2}:[0-9]{2}$/.test(data.end)) {
      doc.end = data.end;
    }
    if (typeof data.durationMin === 'number' && data.durationMin > 0) {
      doc.durationMin = parseInt(data.durationMin, 10);
    }
    if (typeof data.priceSnapshot === 'number' && data.priceSnapshot >= 0) {
      doc.priceSnapshot = parseInt(data.priceSnapshot, 10);
    }
    if (typeof data.menuNameSnapshot === 'string') {
      doc.menuNameSnapshot = data.menuNameSnapshot;
    }
    if (typeof data.memo === 'string' && data.memo) { doc.memo = data.memo; }
    if (typeof data.intervalAfterOverride === 'number'
        && data.intervalAfterOverride >= 0) {
      doc.intervalAfterOverride = parseInt(data.intervalAfterOverride, 10);
    }
    dbAddDoc('salons/' + sid + '/appointments', doc, cb);
  }
  window.dbSalonCreateAppointment = dbSalonCreateAppointment;

  function dbSalonListCloseBlocks(yearMonth, cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, null); return; }
    if (!yearMonth || !/^[0-9]{4}-[0-9]{2}$/.test(String(yearMonth))) {
      dbReadCollection('salons/' + sid + '/closeBlocks', null, cb);
      return;
    }
    var ym = String(yearMonth);
    var from = ym + '-01';
    var to = ym + '-31';
    dbReadCollection('salons/' + sid + '/closeBlocks', function (col) {
      return col.where('dateKey', '>=', from).where('dateKey', '<=', to);
    }, cb);
  }
  window.dbSalonListCloseBlocks = dbSalonListCloseBlocks;

  function dbSalonCreateCloseBlock(data, cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, null); return; }
    if (!data || !data.dateKey || !data.start || !data.end) {
      console.error('[shared_db] dbSalonCreateCloseBlock: dateKey/start/end are required');
      _safeCb(cb, null);
      return;
    }
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(String(data.dateKey))) {
      console.error('[shared_db] invalid dateKey'); _safeCb(cb, null); return;
    }
    if (!/^[0-9]{2}:[0-9]{2}$/.test(String(data.start))
        || !/^[0-9]{2}:[0-9]{2}$/.test(String(data.end))) {
      console.error('[shared_db] invalid start/end'); _safeCb(cb, null); return;
    }
    if (data.start >= data.end) {
      console.error('[shared_db] start must be < end'); _safeCb(cb, null); return;
    }
    var doc = {
      dateKey: String(data.dateKey),
      start: String(data.start),
      end: String(data.end),
      reason: (typeof data.reason === 'string') ? data.reason : '',
      createdAt: _serverTimestamp()
    };
    dbAddDoc('salons/' + sid + '/closeBlocks', doc, cb);
  }
  window.dbSalonCreateCloseBlock = dbSalonCreateCloseBlock;

  function dbSalonDeleteCloseBlock(blockId, cb) {
    var sid = getCurrentSalonId();
    if (!sid || !blockId) { _safeCb(cb, null); return; }
    dbDeleteDoc('salons/' + sid + '/closeBlocks/' + blockId, cb);
  }
  window.dbSalonDeleteCloseBlock = dbSalonDeleteCloseBlock;

  function dbSalonDeleteAppointment(appointmentId, cb) {
    var sid = getCurrentSalonId();
    if (!sid || !appointmentId) { _safeCb(cb, null); return; }
    dbDeleteDoc('salons/' + sid + '/appointments/' + appointmentId, cb);
  }
  window.dbSalonDeleteAppointment = dbSalonDeleteAppointment;

  function dbSalonUpdateAppointmentPayment(aid, payment, cb) {
    var sid = getCurrentSalonId();
    if (!sid || !aid) { _safeCb(cb, false); return; }
    var p = parseInt(payment, 10);
    var patch = {};
    if (isNaN(p) || p < 0) { patch.payment = _deleteField(); }
    else { patch.payment = p; }
    patch.updatedAt = _serverTimestamp();
    dbUpdateDoc('salons/' + sid + '/appointments/' + aid, patch, cb);
  }
  window.dbSalonUpdateAppointmentPayment = dbSalonUpdateAppointmentPayment;

  function dbSalonUpdateAppointmentMemo(aid, memo, cb) {
    var sid = getCurrentSalonId();
    if (!sid || !aid) { _safeCb(cb, false); return; }
    var patch = {
      visitMemo: String(memo == null ? '' : memo),
      updatedAt: _serverTimestamp()
    };
    dbUpdateDoc('salons/' + sid + '/appointments/' + aid, patch, cb);
  }
  window.dbSalonUpdateAppointmentMemo = dbSalonUpdateAppointmentMemo;

  function dbSalonUpdateCustomerKarteNote(customerDocId, note, cb) {
    var sid = getCurrentSalonId();
    if (!sid || !customerDocId) { _safeCb(cb, false); return; }
    var patch = {
      karteNote: String(note == null ? '' : note),
      updatedAt: _serverTimestamp()
    };
    dbUpdateDoc('salons/' + sid + '/customers/' + customerDocId, patch, cb);
  }
  window.dbSalonUpdateCustomerKarteNote = dbSalonUpdateCustomerKarteNote;

  function dbSalonUploadAppointmentPhoto(aid, blob, cb) {
    function callCb(err, photoObj) {
      if (typeof cb !== 'function') { return; }
      try { cb(err || null, photoObj || null); }
      catch (e) { console.error('[dbSalonUploadAppointmentPhoto] cb threw', e); }
    }
    var sid = getCurrentSalonId();
    if (!sid || !aid || !blob) {
      callCb(new Error('invalid args sid=' + sid + ' aid=' + aid + ' blob=' + (!!blob)), null);
      return;
    }
    var st = _storage();
    if (!st) { callCb(new Error('firebase.storage 未ロード'), null); return; }
    var photoId = 'p_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
    var path = 'salons/' + sid + '/appointmentPhotos/' + aid + '/' + photoId + '.jpg';
    var ref = st.ref(path);
    var metadata = { contentType: 'image/jpeg' };
    ref.put(blob, metadata)
      .then(function (snapshot) { return snapshot.ref.getDownloadURL(); })
      .then(function (url) {
        callCb(null, {
          id: photoId, path: path, url: url,
          time: new Date().toISOString()
        });
      })
      .catch(function (err) {
        _logErr('dbSalonUploadAppointmentPhoto(' + path + ')', err);
        callCb(err, null);
      });
  }
  window.dbSalonUploadAppointmentPhoto = dbSalonUploadAppointmentPhoto;

  function dbSalonAddAppointmentPhoto(aid, photoObj, cb) {
    function callCb(ok, errInfo) {
      if (typeof cb !== 'function') { return; }
      try { cb(ok, errInfo || null); }
      catch (e) { console.error('[dbSalonAddAppointmentPhoto] cb threw', e); }
    }
    var sid = getCurrentSalonId();
    if (!sid || !aid || !photoObj) {
      callCb(false, {
        code: 'invalid-args',
        message: 'sid=' + sid + ' aid=' + aid + ' photoObj=' + (!!photoObj)
      });
      return;
    }
    var docPath = 'salons/' + sid + '/appointments/' + aid;
    dbReadDoc(docPath, function (doc) {
      if (!doc) {
        callCb(false, {
          code: 'doc-not-found',
          message: '予約ドキュメントが読めない: ' + docPath
        });
        return;
      }
      var photos = Array.isArray(doc.photos) ? doc.photos.slice() : [];
      photos.push(photoObj);
      onFbReady(function () {
        _db().doc(docPath).update({
          photos: photos,
          updatedAt: _serverTimestamp()
        })
        .then(function () { callCb(true, null); })
        .catch(function (err) {
          _logErr('dbSalonAddAppointmentPhoto update(' + aid + ')', err);
          callCb(false, {
            code: (err && err.code) || 'update-failed-no-code',
            message: (err && err.message) || (err && String(err)) || '不明'
          });
        });
      });
    });
  }
  window.dbSalonAddAppointmentPhoto = dbSalonAddAppointmentPhoto;

  function dbSalonDeleteAppointmentPhoto(aid, photoId, cb) {
    var sid = getCurrentSalonId();
    if (!sid || !aid || !photoId) { _safeCb(cb, false); return; }
    var docPath = 'salons/' + sid + '/appointments/' + aid;
    dbReadDoc(docPath, function (doc) {
      if (!doc) { _safeCb(cb, false); return; }
      var photos = Array.isArray(doc.photos) ? doc.photos : [];
      var target = null;
      var kept = [];
      var i;
      for (i = 0; i < photos.length; i++) {
        if (photos[i] && photos[i].id === photoId) { target = photos[i]; }
        else { kept.push(photos[i]); }
      }
      if (!target) { _safeCb(cb, true); return; }
      dbUpdateDoc(docPath, {
        photos: kept,
        updatedAt: _serverTimestamp()
      }, function (ok) {
        if (!ok) { _safeCb(cb, false); return; }
        var st = _storage();
        if (st && target.path) {
          st.ref(target.path).delete()
            .then(function () { _safeCb(cb, true); })
            .catch(function (err) {
              _logErr('storage delete(' + target.path + ')', err);
              _safeCb(cb, true);
            });
        } else { _safeCb(cb, true); }
      });
    });
  }
  window.dbSalonDeleteAppointmentPhoto = dbSalonDeleteAppointmentPhoto;

  function dbCustomerGetSalonInfo(cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, null); return; }
    dbReadDoc('salons/' + sid, cb);
  }
  window.dbCustomerGetSalonInfo = dbCustomerGetSalonInfo;

  function dbCustomerGetPublicMenus(cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, null); return; }
    dbReadCollection('salons/' + sid + '/menus', function (col) {
      return col.where('public', '==', true);
    }, cb);
  }
  window.dbCustomerGetPublicMenus = dbCustomerGetPublicMenus;

  function dbCustomerResolveMyCard(cb) {
    var sid = getCurrentSalonId();
    var uid = getCurrentUserUid();
    if (!sid || !uid) { _safeCb(cb, null); return; }
    dbReadDoc('salons/' + sid + '/authIndex/' + uid, function (idx) {
      if (!idx || !idx.customerDocId) {
        _safeCb(cb, { customerDocId: null, customer: null });
        return;
      }
      var docId = idx.customerDocId;
      dbReadDoc('salons/' + sid + '/customers/' + docId, function (cust) {
        if (!cust) {
          _logErr('dbCustomerResolveMyCard',
                   'authIndex points to missing customer ' + docId);
          _safeCb(cb, { customerDocId: docId, customer: null });
          return;
        }
        _safeCb(cb, { customerDocId: docId, customer: cust });
      });
    });
  }
  window.dbCustomerResolveMyCard = dbCustomerResolveMyCard;

  function dbCustomerGetMyProfile(cb) {
    var sid = getCurrentSalonId();
    var uid = getCurrentUserUid();
    if (!sid || !uid) { _safeCb(cb, new Error('not authenticated'), null); return; }
    dbCustomerResolveMyCard(function (res) {
      if (!res) { _safeCb(cb, new Error('resolve failed'), null); return; }
      _safeCb(cb, null, {
        customerDocId: res.customerDocId || null,
        customer: res.customer || null
      });
    });
  }
  window.dbCustomerGetMyProfile = dbCustomerGetMyProfile;

  function dbCustomerClaimMyCard(data, cb) {
    var sid = getCurrentSalonId();
    var uid = getCurrentUserUid();
    if (!sid || !uid) { _safeCb(cb, new Error('not authenticated'), null); return; }
    var fns = _functions();
    if (!fns) {
      _safeCb(cb, new Error('firebase-functions-compat.js が未ロードです'), null);
      return;
    }
    var payload = { salonId: sid };
    if (data && data.name) { payload.name = String(data.name); }
    if (data && data.phone) { payload.phone = String(data.phone); }
    var callable;
    try { callable = fns.httpsCallable('resolveOrClaimCustomer'); }
    catch (e) {
      _logErr('dbCustomerClaimMyCard httpsCallable', e);
      _safeCb(cb, e, null);
      return;
    }
    callable(payload).then(function (res) {
      _safeCb(cb, null, (res && res.data) ? res.data : null);
    }).catch(function (err) {
      _logErr('dbCustomerClaimMyCard', err);
      _safeCb(cb, err, null);
    });
  }
  window.dbCustomerClaimMyCard = dbCustomerClaimMyCard;

  function dbCustomerGetAvailableSlots(dateKey, menuId, optionMenuIds, cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, new Error('salonId が取得できません。'), null); return; }
    var callable;
    try { callable = _functions().httpsCallable('getAvailableSlots'); }
    catch (e) {
      _logErr('dbCustomerGetAvailableSlots httpsCallable', e);
      _safeCb(cb, e, null);
      return;
    }
    callable({
      salonId: sid, dateKey: dateKey, menuId: menuId,
      optionMenuIds: optionMenuIds || []
    }).then(function (res) {
      _safeCb(cb, null, (res && res.data) ? res.data : null);
    }).catch(function (err) {
      _logErr('dbCustomerGetAvailableSlots', err);
      _safeCb(cb, err, null);
    });
  }
  window.dbCustomerGetAvailableSlots = dbCustomerGetAvailableSlots;

  function dbCustomerCreateMyProfile(data, cb) {
    var msg = 'dbCustomerCreateMyProfile は廃止されました（v8.1）。'
            + 'dbCustomerClaimMyCard を使ってください。';
    console.error('[shared_db] ' + msg);
    _safeCb(cb, new Error(msg), null);
  }
  window.dbCustomerCreateMyProfile = dbCustomerCreateMyProfile;

  function dbCustomerUpdateMyProfile(patch, cb) {
    var sid = getCurrentSalonId();
    var uid = getCurrentUserUid();
    if (!sid || !uid) { _safeCb(cb, new Error('not authenticated'), null); return; }
    if (!patch) { _safeCb(cb, new Error('patch is empty'), null); return; }
    dbCustomerResolveMyCard(function (res) {
      if (!res || !res.customerDocId) {
        _safeCb(cb, new Error('カルテ未紐付け（先に dbCustomerClaimMyCard が必要）'), null);
        return;
      }
      var docId = res.customerDocId;
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
      dbUpdateDoc('salons/' + sid + '/customers/' + docId, safe, function (ok) {
        if (ok === null || ok === false) {
          _safeCb(cb, new Error('update failed'), null);
        } else {
          _safeCb(cb, null, { customerDocId: docId });
        }
      });
    });
  }
  window.dbCustomerUpdateMyProfile = dbCustomerUpdateMyProfile;

  function dbCustomerListMyAppointments(cb) {
    var sid = getCurrentSalonId();
    var uid = getCurrentUserUid();
    if (!sid || !uid) { _safeCb(cb, null); return; }
    dbReadCollection('salons/' + sid + '/appointments', function (col) {
      return col.where('authUid', '==', uid);
    }, cb);
  }
  window.dbCustomerListMyAppointments = dbCustomerListMyAppointments;

  function dbCustomerCreateAppointment(data, cb) {
    var sid = getCurrentSalonId();
    var uid = getCurrentUserUid();
    if (!sid || !uid) { _safeCb(cb, new Error('not authenticated'), null); return; }
    if (!data || !data.dateKey || !data.start || !data.menuId) {
      _safeCb(cb, new Error('missing required fields'), null);
      return;
    }
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(data.dateKey)) {
      _safeCb(cb, new Error('invalid dateKey'), null);
      return;
    }
    if (!/^[0-9]{2}:[0-9]{2}$/.test(data.start)) {
      _safeCb(cb, new Error('invalid start'), null);
      return;
    }
    dbCustomerResolveMyCard(function (res) {
      if (!res || !res.customerDocId) {
        _safeCb(cb, new Error('カルテ未紐付け（先に dbCustomerClaimMyCard が必要）'), null);
        return;
      }
      var docId = res.customerDocId;
      var doc = {
        dateKey: String(data.dateKey),
        start: String(data.start),
        customerDocId: docId,
        authUid: uid,
        menuId: String(data.menuId),
        pendingCreate: true
      };
      if (data.customerEmail) { doc.customerEmail = String(data.customerEmail); }
      if (data.optionMenuIds && data.optionMenuIds.length > 0) {
        var opts = [];
        var i;
        for (i = 0; i < data.optionMenuIds.length; i++) {
          opts.push(String(data.optionMenuIds[i]));
        }
        doc.optionMenuIds = opts;
      }
      dbAddDoc('salons/' + sid + '/appointments', doc, function (addRes) {
        if (!addRes) { _safeCb(cb, new Error('予約作成に失敗しました'), null); }
        else { _safeCb(cb, null, addRes); }
      });
    });
  }
  window.dbCustomerCreateAppointment = dbCustomerCreateAppointment;

  function dbCustomerCancelMyAppointment(appointmentId, cb) {
    var sid = getCurrentSalonId();
    var uid = getCurrentUserUid();
    if (!sid || !uid || !appointmentId) { _safeCb(cb, null); return; }
    dbUpdateDoc(
      'salons/' + sid + '/appointments/' + appointmentId,
      { status: 'cancelled', updatedAt: _serverTimestamp() },
      cb
    );
  }
  window.dbCustomerCancelMyAppointment = dbCustomerCancelMyAppointment;

  function _parallelLoad(tasks, cb) {
    var bundle = {};
    var pending = tasks.length;
    if (pending <= 0) { _safeCb(cb, bundle); return; }
    var i;
    function _makeDone(key) {
      return function (value) {
        bundle[key] = value;
        pending--;
        if (pending <= 0) { _safeCb(cb, bundle); }
      };
    }
    for (i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      try { t.run(_makeDone(t.key)); }
      catch (e) {
        _logErr('_parallelLoad task(' + t.key + ')', e);
        _makeDone(t.key)(null);
      }
    }
  }

  function dbLoadSalonDashboard(cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, null); return; }
    _parallelLoad([
      { key: 'info', run: function (done) { dbSalonGetInfo(function (v) { done(v || null); }); } },
      { key: 'settings', run: function (done) { dbSalonGetConfig('settings', function (v) { done(v || null); }); } }
    ], cb);
  }
  window.dbLoadSalonDashboard = dbLoadSalonDashboard;

  function dbLoadSalonCalendar(arg, cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, null); return; }
    if (typeof arg === 'string' && /^[0-9]{4}-[0-9]{2}$/.test(arg)) {
      if (typeof window.calendarLoadMonth !== 'function') {
        _logErr('dbLoadSalonCalendar', 'shared_db_calendar.js not loaded');
        _safeCb(cb, null);
        return;
      }
      window.calendarLoadMonth(arg, cb);
      return;
    }
    if (typeof window.calendarLoadWeek !== 'function') {
      _logErr('dbLoadSalonCalendar', 'shared_db_calendar.js not loaded');
      _safeCb(cb, null);
      return;
    }
    var weekStart;
    if (arg instanceof Date) { weekStart = arg; }
    else if (typeof arg === 'string'
             && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(arg)) {
      var p = arg.split('-');
      weekStart = new Date(parseInt(p[0], 10),
                           parseInt(p[1], 10) - 1,
                           parseInt(p[2], 10));
    } else { weekStart = new Date(); }
    window.calendarLoadWeek(weekStart, cb);
  }
  window.dbLoadSalonCalendar = dbLoadSalonCalendar;

  function dbLoadSalonCustomers(cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, null); return; }
    _parallelLoad([
      { key: 'customers', run: function (done) { dbSalonListCustomers(function (v) { done(v || []); }); } }
    ], cb);
  }
  window.dbLoadSalonCustomers = dbLoadSalonCustomers;

  function dbLoadSalonMenus(cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, null); return; }
    var base = 'salons/' + sid;
    _parallelLoad([
      {
        key: 'menus',
        run: function (done) {
          if (typeof window.menuList === 'function') {
            window.menuList(null, function (v) { done(v || []); });
          } else {
            dbReadCollection(base + '/menus', null, function (v) { done(v || []); });
          }
        }
      },
      { key: 'staffs', run: function (done) { dbReadCollection(base + '/staffs', null, function (v) { done(v || []); }); } },
      { key: 'resources', run: function (done) { dbReadCollection(base + '/resources', null, function (v) { done(v || []); }); } }
    ], cb);
  }
  window.dbLoadSalonMenus = dbLoadSalonMenus;

  function dbLoadSalonSettings(cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, null); return; }
    _parallelLoad([
      { key: 'settings', run: function (done) { dbSalonGetConfig('settings', function (v) { done(v || null); }); } },
      { key: 'cancelPolicy', run: function (done) { dbSalonGetConfig('cancelPolicy', function (v) { done(v || null); }); } },
      { key: 'stampCard', run: function (done) { dbSalonGetConfig('stampCard', function (v) { done(v || null); }); } }
    ], cb);
  }
  window.dbLoadSalonSettings = dbLoadSalonSettings;

  function dbLoadCustomerHome(cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, null); return; }
    _parallelLoad([
      { key: 'info', run: function (done) { dbCustomerGetSalonInfo(function (v) { done(v || null); }); } },
      { key: 'settings', run: function (done) { dbSalonGetConfig('settings', function (v) { done(v || null); }); } },
      {
        key: 'menus',
        run: function (done) {
          if (typeof window.menuListPublic === 'function') {
            window.menuListPublic(function (v) { done(v || []); });
          } else {
            dbCustomerGetPublicMenus(function (v) { done(v || []); });
          }
        }
      },
      { key: 'cancelPolicy', run: function (done) { dbSalonGetConfig('cancelPolicy', function (v) { done(v || null); }); } }
    ], cb);
  }
  window.dbLoadCustomerHome = dbLoadCustomerHome;

  function dbLoadCustomerBooking(dateStr, cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, null); return; }
    if (typeof window.calendarLoadDay !== 'function') {
      _logErr('dbLoadCustomerBooking', 'shared_db_calendar.js not loaded');
      _safeCb(cb, null);
      return;
    }
    window.calendarLoadDay(dateStr, cb);
  }
  window.dbLoadCustomerBooking = dbLoadCustomerBooking;

  function dbLoadCustomerHistory(cb) {
    var sid = getCurrentSalonId();
    var uid = getCurrentUserUid();
    if (!sid || !uid) { _safeCb(cb, null); return; }

    var HISTORY_LIMIT = 50;

    function _queryMine(col) {
      // 【2026/5/28 D-step3 v8.1化】authUid == 自分 / dateKey 降順 / limit
      //   複合インデックス (authUid Asc, dateKey Desc) は ③で作成済み。
      return col.where('authUid', '==', uid)
                .orderBy('dateKey', 'desc')
                .limit(HISTORY_LIMIT);
    }

    _parallelLoad([
      {
        key: 'current',
        run: function (done) {
          dbReadCollection(
            'salons/' + sid + '/appointments',
            _queryMine,
            function (v) { done(v || []); }
          );
        }
      },
      {
        key: 'archive',
        run: function (done) {
          dbReadCollection(
            'salons/' + sid + '/appointments_archive',
            _queryMine,
            function (v) { done(v || []); }
          );
        }
      }
    ], function (bundle) {
      var cur = bundle.current || [];
      var arc = bundle.archive || [];
      var merged = [];
      var i;
      for (i = 0; i < cur.length; i++) { merged.push(cur[i]); }
      for (i = 0; i < arc.length; i++) { merged.push(arc[i]); }
      merged.sort(function (a, b) {
        var ak = a.dateKey || '';
        var bk = b.dateKey || '';
        if (ak === bk) {
          var as = a.start || '';
          var bs = b.start || '';
          if (as === bs) { return 0; }
          return (as < bs) ? 1 : -1;
        }
        return (ak < bk) ? 1 : -1;
      });
      _safeCb(cb, { current: cur, archive: arc, merged: merged });
    });
  }
  window.dbLoadCustomerHistory = dbLoadCustomerHistory;

  window._sharedDbDebug = {
    getUrlSalonId: function () { return _urlSalonId; },
    getReadyState: function () { return _fbReady; },
    loadApis: [
      'dbLoadSalonDashboard', 'dbLoadSalonCalendar', 'dbLoadSalonCustomers',
      'dbLoadSalonMenus', 'dbLoadSalonSettings', 'dbLoadCustomerHome',
      'dbLoadCustomerBooking', 'dbLoadCustomerHistory'
    ],
    salonCustomerHistoryApi: 'dbSalonGetCustomerHistory'
  };

  console.log('[shared_db] loaded. urlSalonId =', _urlSalonId,
              '(F-3: dbSalonGetCustomerHistory orderBy restored)');

})();
