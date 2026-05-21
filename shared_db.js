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
 *   - staffs ドキュメント ID は 'owner' 固定 (メモリ#22準拠)
 *   - firestore.rules の isSalonStaff() は isSalonOwner() 代用に修正済み
 *     (Auth UID == salonId 判定)。requireSalonStaff もこれに合わせた。
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

  // ★ カルテ写真用 Storage ヘルパー（v8.1+ C-9）
  //   使用画面は <script src="firebase-storage-compat.js"> の追加が必要
  //   firebase.storage() が無ければ null を返す（写真機能 OFF 相当）
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
  // ------------------------------------------------------------
  // 【2026/5/14 owner固定方式】判定: Auth UID == salonId
  //   firestore.rules の isSalonStaff() が isSalonOwner() 代用に
  //   修正されたため、クライアント側も同じロジックに揃える。
  //   フェーズ1はスタッフ=オーナー1人なので UID==salonId で正しい。
  //   旧実装は staffs/{Auth UID} を exists で見ていたが、staffs の
  //   ドキュメントID が 'owner' 固定になったため永遠に false になる
  //   バグがあった。exists() の Firestore 読み取り(1read課金)も削減。
  //   フェーズ2で複数スタッフ対応時、staffs/{Auth UID} の get() に戻す。
  // ------------------------------------------------------------
  function requireSalonStaff(cb) {
    onFbReady(function () {
      var uid = getCurrentUserUid();
      var sid = getCurrentSalonId();
      if (!uid || !sid) {
        _safeCb(cb, false);
        return;
      }
      _safeCb(cb, uid === sid);
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
  // 顧客一覧。★ v8.1: 統合済み（isMerged==true）カルテは
  //   soft delete されているので一覧から除外する（v8.1 3-4）。
  //   取得後にクライアント側でフィルタ（Firestore の != クエリは
  //   インデックス制約が厳しいため、取得後フィルタが安全）
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

  // 顧客 1 件取得
  // ★ v8.1 新規: サロン側顧客登録（電話・店頭予約客をサロンが登録）
  //   DESIGN.md 3-3 customers 作成(a)サロン分岐と1対1:
  //     authUid=null 必須 / createdSource='salon' 必須
  //     ホワイトリスト: name,phone,email,authUid,createdSource,
  //       notifyChannels,isMerged,mergedInto,mergedAt,
  //       mergedAliases,createdAt
  //   customerDocId は Firestore 自動採番（add）。
  //   後でこの顧客がアプリ登録した時、claim Function が
  //   email 一致で authUid を後付けする（v8.1 2-3/2-4）。
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

    // ホワイトリストに厳密準拠したドキュメント（ルールと1対1）
    var doc = {
      name: String(data.name),
      phone: data.phone ? String(data.phone) : '',
      email: data.email ? String(data.email) : '',
      authUid: null,                 // サロン登録は必ず null
      createdSource: 'salon',        // 必ず 'salon'
      notifyChannels: notifyChannels,
      isMerged: false,
      mergedInto: null,
      mergedAt: null,
      mergedAliases: [],
      createdAt: _serverTimestamp()
    };

    // 自動採番 ID で作成（add）。customerDocId は Firestore が採番
    dbAddDoc('salons/' + sid + '/customers', doc, cb);
  }
  window.dbSalonCreateCustomer = dbSalonCreateCustomer;

  function dbSalonGetCustomer(customerDocId, cb) {
    var sid = getCurrentSalonId();
    if (!sid || !customerDocId) { _safeCb(cb, null); return; }
    dbReadDoc('salons/' + sid + '/customers/' + customerDocId, cb);
  }
  window.dbSalonGetCustomer = dbSalonGetCustomer;

  // 顧客更新 (memo / stampCount / lastVisit / totalSpent などスタッフ専用)
  // ★ v8.1: Firestoreルール 3-3 customers と1対1。クライアントから
  //   書けないフィールド（Function=admin 専用）を patch から除外する:
  //   lineUserId / authUid / isMerged / mergedInto / mergedAt /
  //   mergedAliases / createdSource / lockedByJob
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
        if (patch.hasOwnProperty(_protected[i])) {
          delete patch[_protected[i]];
        }
      }
      patch.updatedAt = _serverTimestamp();
    }
    dbUpdateDoc('salons/' + sid + '/customers/' + customerDocId, patch, cb);
  }
  window.dbSalonUpdateCustomer = dbSalonUpdateCustomer;

  // 顧客削除 (オーナーのみ。通常運用は soft delete を推奨だが、
  //  物理削除 API はルール上オーナーに許可されているため残す)
  function dbSalonDeleteCustomer(customerDocId, cb) {
    var sid = getCurrentSalonId();
    if (!sid || !customerDocId) { _safeCb(cb, null); return; }
    dbDeleteDoc('salons/' + sid + '/customers/' + customerDocId, cb);
  }
  window.dbSalonDeleteCustomer = dbSalonDeleteCustomer;

  // ------------------------------------------------------------
  // Phase B-8: サロン側 顧客詳細の来店履歴 (current + archive 統合)
  //
  // 設計準拠:
  //   - DESIGN.md v6 セクション 7 Phase B B-8
  //     「顧客履歴 / 顧客詳細画面は appointments(current) と
  //       appointments_archive の両方を読みに行く」
  //   - DESIGN_NOTES.md 項目7:
  //       原設計の「6ヶ月 / 月次バッチ」は早すぎるため
  //       「18ヶ月 / 半年に1回バッチ」に修正済み。
  //       なお appointments → appointments_archive へ移す
  //       Cloud Functions バッチ自体は後回し (今回方針)。
  //       今は「読む側」だけ両対応にしておき、将来バッチを足しても
  //       このAPIを一切変えずに済むようにする (設計書 0-2 の指針)。
  //
  //   dbLoadCustomerHistory (B-1) は「顧客本人が自分の履歴を見る」用。
  //   こちらは「サロンスタッフが特定顧客の来店履歴を見る」用 (顧客詳細画面)。
  //   firestore.rules: appointments / appointments_archive とも
  //   read は isSalonStaff(salonId) で許可済み (A-step1, 360-365行)。
  //
  //   B-6: customerId == 指定顧客で絞り、dateKey 降順 + limit。
  //        全件 get() しない。
  //
  //   戻り値: { current:[...], archive:[...], merged:[...] }
  //     merged は dateKey 降順 (同日は start 降順) で統合済み。
  // ------------------------------------------------------------
  function dbSalonGetCustomerHistory(customerDocId, cb) {
    var sid = getCurrentSalonId();
    if (!sid || !customerDocId) { _safeCb(cb, null); return; }

    var HISTORY_LIMIT = 100; // サロン側は本人画面より多めに見たい

    function _queryCust(col) {
      // ★ v8.1: 予約は customerDocId を持つ（旧 customerId 廃止）
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
            function (v) {
              // archive がまだ無い / 空でも [] に正規化
              done(v || []);
            }
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
      _safeCb(cb, {
        current: cur,
        archive: arc,
        merged: merged
      });
    });
  }
  window.dbSalonGetCustomerHistory = dbSalonGetCustomerHistory;

  // ============================================================
  // サロン側メニュー API
  // DESIGN.md 0-2 menus スキーマ / 3-3 menus ルールと1対1。
  // フィールドホワイトリスト:
  //   name,duration,price,type,public,eligibleStaffIds,
  //   requiredResourceIds,
  //   description,contraindications,photoUrl,sortOrder,createdAt
  // ★ v8.1: intervalBefore/intervalAfter は廃止。
  //   インターバルはサロン共通設定 settings.intervalMin に1本化
  //   （メニュー単位ではなく全予約に自動付与・後から変更可）
  // フェーズ1ではeligibleStaffIds=['owner'], requiredResourceIds=['default']固定
  // ============================================================

  // メニュー一覧（サロン側：public/非公開 両方取得、sortOrder順）
  function dbSalonListMenus(cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, null); return; }
    dbReadCollection('salons/' + sid + '/menus', null, function (list) {
      if (!list) { _safeCb(cb, null); return; }
      // sortOrder 昇順、未設定は末尾、同値は name 昇順で安定化
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

  // メニュー単体取得
  function dbSalonGetMenu(menuId, cb) {
    var sid = getCurrentSalonId();
    if (!sid || !menuId) { _safeCb(cb, null); return; }
    dbReadDoc('salons/' + sid + '/menus/' + menuId, cb);
  }
  window.dbSalonGetMenu = dbSalonGetMenu;

  // メニュー作成（DESIGN.md 3-3 menus 作成ホワイトリスト1対1）
  // data: { name, duration, price, type, public,
  //         description?, contraindications?, sortOrder? }
  // eligibleStaffIds/requiredResourceIds はフェーズ1固定値を自動付与
  // ★ v8.1: メニュー単位 interval は廃止（settings.intervalMin に1本化）
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
    var pub = (data.public !== false);  // 既定 true

    var doc = {
      name: String(data.name),
      duration: dur,
      price: pr,
      type: typ,
      public: pub,
      eligibleStaffIds: ['owner'],     // フェーズ1固定
      requiredResourceIds: ['default'], // フェーズ1固定
      createdAt: _serverTimestamp()
    };
    if (data.description) { doc.description = String(data.description); }
    if (data.contraindications) {
      doc.contraindications = String(data.contraindications);
    }
    if (data.photoUrl) { doc.photoUrl = String(data.photoUrl); }
    if (typeof data.sortOrder === 'number' && data.sortOrder >= 0) {
      doc.sortOrder = parseInt(data.sortOrder, 10);
    }

    dbAddDoc('salons/' + sid + '/menus', doc, cb);
  }
  window.dbSalonCreateMenu = dbSalonCreateMenu;

  // メニュー更新。createdAt/eligibleStaffIds/requiredResourceIds は
  // クライアント書込みから除外（フェーズ1固定値・サーバ管理）
  function dbSalonUpdateMenu(menuId, patch, cb) {
    var sid = getCurrentSalonId();
    if (!sid || !menuId) { _safeCb(cb, null); return; }
    if (patch) {
      var _protected = [
        'createdAt', 'eligibleStaffIds', 'requiredResourceIds'
      ];
      var i;
      for (i = 0; i < _protected.length; i++) {
        if (patch.hasOwnProperty(_protected[i])) {
          delete patch[_protected[i]];
        }
      }
      // 型の最低限の正規化
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

  // メニュー削除（オーナーのみ）。
  // 注意：過去予約は menuNameSnapshot 等を持っているので参照不能には
  //   ならないが、将来の予約導線から外したいだけなら public:false を
  //   推奨。物理削除する場合のみこれを使う。
  function dbSalonDeleteMenu(menuId, cb) {
    var sid = getCurrentSalonId();
    if (!sid || !menuId) { _safeCb(cb, null); return; }
    dbDeleteDoc('salons/' + sid + '/menus/' + menuId, cb);
  }
  window.dbSalonDeleteMenu = dbSalonDeleteMenu;

  // 並び替え用：複数メニューの sortOrder を一括更新
  // orderList: [{ _id: 'm1', sortOrder: 0 }, { _id: 'm2', sortOrder: 1 }, ...]
  // 1件ずつ dbUpdateDoc を順次実行（数件程度の想定・分割バッチ不要）
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

  // ============================================================
  // サロン共通設定 API（営業時間・インターバル等）
  // パス: salons/{salonId}/config/settings
  // DESIGN.md 0-2 サロン共通設定スキーマと1対1。
  // ★ v8.1: intervalMin はここで管理（メニュー単位の interval は廃止）
  // ============================================================

  // 設定取得。未作成なら null ではなく既定値を返して画面側を簡単にする
  function dbGetSettings(cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, _defaultSettings()); return; }
    dbReadDoc('salons/' + sid + '/config/settings', function (doc) {
      if (!doc) {
        // 未作成は既定値（初回起動時の挙動）
        _safeCb(cb, _defaultSettings());
        return;
      }
      // 既定値をベースに既存値で上書き（部分保存にも耐える）
      var base = _defaultSettings();
      var k;
      for (k in doc) {
        if (doc.hasOwnProperty(k)) { base[k] = doc[k]; }
      }
      _safeCb(cb, base);
    });
  }
  window.dbGetSettings = dbGetSettings;

  // 設定保存（set merge:true で部分更新可）
  // settings: { openTime, closeTime, intervalMin, intervalInClose,
  //             slotMin, closedDows, weeklyClose, bookingWeeks,
  //             lastMin, deadline }
  // 戻り値 cb(err): 成功時 null、失敗時 Error 相当の真値
  function dbSaveSettings(settings, cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, new Error('no salon')); return; }
    if (!settings || typeof settings !== 'object') {
      _safeCb(cb, new Error('invalid settings'));
      return;
    }
    // 型の最低限の正規化
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
      function (ok) {
        _safeCb(cb, ok ? null : new Error('save failed'));
      });
  }
  window.dbSaveSettings = dbSaveSettings;

  // 既定設定（初回起動時の表示用）
  function _defaultSettings() {
    return {
      openTime: '10:00',
      closeTime: '19:00',
      intervalMin: 30,
      intervalInClose: false,
      slotMin: 30,
      closedDows: [],
      weeklyClose: [],
      bookingWeeks: 8,
      lastMin: 'same1h',
      deadline: '前日まで'
    };
  }

  // ============================================================
  // キャンセル規定 API（cancelPolicy）
  // パス: salons/{salonId}/config/cancelPolicy
  // DESIGN.md 0-2 キャンセル規定スキーマと1対1
  // ============================================================

  // 取得。未作成なら既定値を返す（初回起動時の挙動）
  function dbGetCancelPolicy(cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, _defaultCancelPolicy()); return; }
    dbReadDoc('salons/' + sid + '/config/cancelPolicy', function (doc) {
      if (!doc) { _safeCb(cb, _defaultCancelPolicy()); return; }
      var base = _defaultCancelPolicy();
      var k;
      for (k in doc) {
        if (doc.hasOwnProperty(k)) { base[k] = doc[k]; }
      }
      _safeCb(cb, base);
    });
  }
  window.dbGetCancelPolicy = dbGetCancelPolicy;

  // 保存（set merge:true で部分更新）
  // policy: { text, rates[], showOnBook, showOnCancel, qrUrl, qrMsg }
  // 戻り値 cb(err): 成功 null / 失敗 Error 相当
  function dbSaveCancelPolicy(policy, cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, new Error('no salon')); return; }
    if (!policy || typeof policy !== 'object') {
      _safeCb(cb, new Error('invalid policy'));
      return;
    }
    var doc = {};
    if (typeof policy.text === 'string')  { doc.text  = policy.text; }
    if (typeof policy.qrUrl === 'string') { doc.qrUrl = policy.qrUrl; }
    if (typeof policy.qrMsg === 'string') { doc.qrMsg = policy.qrMsg; }
    if (typeof policy.showOnBook === 'boolean') {
      doc.showOnBook = policy.showOnBook;
    }
    if (typeof policy.showOnCancel === 'boolean') {
      doc.showOnCancel = policy.showOnCancel;
    }
    if (Array.isArray(policy.rates)) {
      doc.rates = policy.rates.map(function (r) {
        var p = parseInt(r.percent, 10);
        if (isNaN(p) || p < 0) { p = 0; }
        if (p > 100) { p = 100; }
        return {
          label: String(r.label || ''),
          percent: p
        };
      });
    }
    doc.updatedAt = _serverTimestamp();

    dbWriteDoc('salons/' + sid + '/config/cancelPolicy', doc, true,
      function (ok) {
        _safeCb(cb, ok ? null : new Error('save failed'));
      });
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
      showOnBook: true,
      showOnCancel: true,
      qrUrl: '',
      qrMsg: ''
    };
  }

  // ============================================================
  // スタンプカード API（stampCard）
  // パス: salons/{salonId}/config/stampCard
  // DESIGN.md 0-2 スタンプカードスキーマと1対1
  // ※ スタンプの「個数」は customers.stampCount にあり、
  //   このドキュメントは「カードの仕様」のみ保持
  // ============================================================

  // 取得。未作成なら既定値を返す
  function dbGetStampCard(cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, _defaultStampCard()); return; }
    dbReadDoc('salons/' + sid + '/config/stampCard', function (doc) {
      if (!doc) { _safeCb(cb, _defaultStampCard()); return; }
      var base = _defaultStampCard();
      var k;
      for (k in doc) {
        if (doc.hasOwnProperty(k)) { base[k] = doc[k]; }
      }
      _safeCb(cb, base);
    });
  }
  window.dbGetStampCard = dbGetStampCard;

  // 保存（set merge:true）
  // policy: { enabled, goal, reward, bonusStamps[], color, expiry }
  function dbSaveStampCard(policy, cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, new Error('no salon')); return; }
    if (!policy || typeof policy !== 'object') {
      _safeCb(cb, new Error('invalid policy'));
      return;
    }
    var doc = {};
    if (typeof policy.enabled === 'boolean') {
      doc.enabled = policy.enabled;
    }
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
        return {
          at: at,
          reward: String(b.reward || '')
        };
      });
    }
    doc.updatedAt = _serverTimestamp();

    dbWriteDoc('salons/' + sid + '/config/stampCard', doc, true,
      function (ok) {
        _safeCb(cb, ok ? null : new Error('save failed'));
      });
  }
  window.dbSaveStampCard = dbSaveStampCard;

  function _defaultStampCard() {
    return {
      enabled: false,
      goal: 10,
      reward: '',
      bonusStamps: [],
      color: '#b5845a',
      expiry: 'none'
    };
  }

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
  // ★ カルテ機能 API（v8.1+ C-9）
  // DESIGN.md 0-2 appointment スキーマ payment/visitMemo/photos
  //   + customer スキーマ karteNote と1対1。
  // 写真は Firebase Storage に保存し、photos[] にメタを持つ。
  // ============================================================

  // 支払い金額を更新（円・整数。-1 で未入力に戻す）
  function dbSalonUpdateAppointmentPayment(aid, payment, cb) {
    var sid = getCurrentSalonId();
    if (!sid || !aid) { _safeCb(cb, false); return; }
    var p = parseInt(payment, 10);
    var patch = {};
    if (isNaN(p) || p < 0) {
      patch.payment = _deleteField();
    } else {
      patch.payment = p;
    }
    patch.updatedAt = _serverTimestamp();
    dbUpdateDoc('salons/' + sid + '/appointments/' + aid, patch, cb);
  }
  window.dbSalonUpdateAppointmentPayment = dbSalonUpdateAppointmentPayment;

  // 訪問メモを更新（自動保存用・空文字許可）
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

  // 顧客カルテ全体メモ（karteNote）の更新（自動保存用）
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

  // 写真を Storage にアップロード（blob 受け取り。リサイズは画面側責務）
  // 戻り値 cb(err, { id, path, url, time })
  // path: salons/{sid}/appointmentPhotos/{aid}/{photoId}.jpg
  function dbSalonUploadAppointmentPhoto(aid, blob, cb) {
    var sid = getCurrentSalonId();
    if (!sid || !aid || !blob) {
      _safeCb(cb, new Error('invalid args'));
      return;
    }
    var st = _storage();
    if (!st) {
      _safeCb(cb, new Error('firebase.storage 未ロード'));
      return;
    }
    // 写真ID = 時刻 + ランダム（衝突回避）
    var photoId = 'p_' + Date.now() + '_' +
                  Math.floor(Math.random() * 100000);
    var path = 'salons/' + sid +
               '/appointmentPhotos/' + aid + '/' + photoId + '.jpg';
    var ref = st.ref(path);
    var metadata = { contentType: 'image/jpeg' };
    ref.put(blob, metadata)
      .then(function (snapshot) {
        return snapshot.ref.getDownloadURL();
      })
      .then(function (url) {
        _safeCb(cb, null, {
          id: photoId,
          path: path,
          url: url,
          time: new Date().toISOString()
        });
      })
      .catch(function (err) {
        _logErr('dbSalonUploadAppointmentPhoto(' + path + ')', err);
        _safeCb(cb, err);
      });
  }
  window.dbSalonUploadAppointmentPhoto = dbSalonUploadAppointmentPhoto;

  // appointment.photos[] に1枚追加（3枚上限は画面側で制御）
  // photoObj: { id, path, url, time }
  // 戻り値 cb(ok bool)
  function dbSalonAddAppointmentPhoto(aid, photoObj, cb) {
    var sid = getCurrentSalonId();
    if (!sid || !aid || !photoObj) { _safeCb(cb, false); return; }
    var ref = _db().collection('salons').doc(sid)
                   .collection('appointments').doc(aid);
    ref.update({
      photos: firebase.firestore.FieldValue.arrayUnion(photoObj),
      updatedAt: _serverTimestamp()
    })
    .then(function () { _safeCb(cb, true); })
    .catch(function (err) {
      _logErr('dbSalonAddAppointmentPhoto(' + aid + ')', err);
      _safeCb(cb, false);
    });
  }
  window.dbSalonAddAppointmentPhoto = dbSalonAddAppointmentPhoto;

  // appointment.photos から1枚削除 + Storage からも消す
  // 戻り値 cb(ok bool)
  //   Firestore の photos[] は要素全体一致でないと remove できないため
  //   一度ドキュメントを読み出し、対象 id を除外して書き戻す方式
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
        if (photos[i] && photos[i].id === photoId) {
          target = photos[i];
        } else {
          kept.push(photos[i]);
        }
      }
      if (!target) {
        // 既に Firestore からは消えている。Storage 残骸の可能性も低い
        _safeCb(cb, true);
        return;
      }
      // 先に Firestore を更新（成功してから Storage 削除）
      dbUpdateDoc(docPath, {
        photos: kept,
        updatedAt: _serverTimestamp()
      }, function (ok) {
        if (!ok) { _safeCb(cb, false); return; }
        // Storage 削除（失敗しても Firestore は更新済みなので OK 扱い）
        var st = _storage();
        if (st && target.path) {
          st.ref(target.path).delete()
            .then(function () { _safeCb(cb, true); })
            .catch(function (err) {
              _logErr('storage delete(' + target.path + ')', err);
              _safeCb(cb, true);  // メタは消えたので成功扱い
            });
        } else {
          _safeCb(cb, true);
        }
      });
    });
  }
  window.dbSalonDeleteAppointmentPhoto = dbSalonDeleteAppointmentPhoto;

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

  // ★ v8.1 新規: 顧客が「自分のカルテ」を解決するヘルパー
  //   DESIGN.md 0-2 / v8.1 1-3: authIndex が source of truth。
  //   流れ: 自分の Auth UID → authIndex/{uid} を1回 get →
  //         customerDocId を得て customers/{customerDocId} を直 get
  //   （query を使わず2回の直 get。速い・安い・index 不要）
  //   戻り値 cb(result):
  //     成功      → { customerDocId: 'cus_xxx', customer: {...} }
  //     未claim   → { customerDocId: null, customer: null }
  //                 （authIndex が無い＝まだ claim されていない。
  //                   claim 判定は Phase D で claim Function が担当）
  //     エラー    → null
  function dbCustomerResolveMyCard(cb) {
    var sid = getCurrentSalonId();
    var uid = getCurrentUserUid();
    if (!sid || !uid) { _safeCb(cb, null); return; }

    dbReadDoc('salons/' + sid + '/authIndex/' + uid, function (idx) {
      if (!idx || !idx.customerDocId) {
        // authIndex 未作成 = まだ claim されていない（正常な状態）
        _safeCb(cb, { customerDocId: null, customer: null });
        return;
      }
      var docId = idx.customerDocId;
      dbReadDoc('salons/' + sid + '/customers/' + docId, function (cust) {
        if (!cust) {
          // authIndex はあるがカルテが無い（merge 等の途中・異常）
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
  // Phase B-1: 画面別並列取得 API (dbLoad*)
  //
  // 設計準拠:
  //   - DESIGN.md v6 セクション 4 (速度設計 3秒以内), 5-3 (データ取得API統一),
  //     7 Phase B (B-1〜B-8)
  //   - DESIGN_NOTES.md 項目 7 (アーカイブ 18ヶ月/半年バッチ)
  //
  // 設計指針:
  //   B-2: 各 API は内部で並列取得し、全部揃ったら一度だけ cb を呼ぶ
  //        (Promise.all 相当を ES5 の pending カウンタで実現)
  //   B-3: 各画面に必要な最小限のデータだけ取得 (無駄なコレクションを引かない)
  //   B-4: ログイン直後は最小限 (dbLoadSalonDashboard は info + settings のみ)、
  //        重いデータは画面遷移時に各 dbLoad* で取得
  //   B-6: appointments は必ず dateKey 範囲 or == で絞る。全件 get() しない。
  //        顧客履歴は customerId == uid + limit。
  //   B-8: 顧客履歴のみ appointments(current) + appointments_archive 両方読む。
  //        ※ 古い予約を archive へ移す Cloud Functions バッチは後回し
  //          (DESIGN_NOTES 項目7。今は読む側だけ箱を用意)。
  //
  // 層分離 (設計書 5-3):
  //   shared_db.js の dbLoad* は「DB 抽象化層の窓口」。
  //   カレンダー固有の月/日バンドル取得は既に shared_db_calendar.js が
  //   並列実装済み (calendarLoadMonth / calendarLoadDay) なので、
  //   dbLoadSalonCalendar / dbLoadCustomerBooking はそれを薄くラップする。
  //   二重実装しない (設計書 進め方の鉄則2: 棚卸ししてから実装)。
  //
  // コールバック規約:
  //   - 成功時: result = バンドルオブジェクト
  //   - 失敗時でも、取得できたものは入れて返す (画面側で null チェック可能)
  //   - 致命的失敗 (salonId 取れない等) のみ result = null
  // ============================================================

  // 内部: 並列取得の合成ヘルパー
  // tasks = [ { key: 'menus', run: function(done){ ... done(value) } }, ... ]
  // 全 task 完了後、bundle = { menus: ..., ... } を cb に渡す
  function _parallelLoad(tasks, cb) {
    var bundle = {};
    var pending = tasks.length;
    if (pending <= 0) {
      _safeCb(cb, bundle);
      return;
    }
    var i;
    function _makeDone(key) {
      return function (value) {
        bundle[key] = value;
        pending--;
        if (pending <= 0) {
          _safeCb(cb, bundle);
        }
      };
    }
    for (i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      try {
        t.run(_makeDone(t.key));
      } catch (e) {
        _logErr('_parallelLoad task(' + t.key + ')', e);
        // 例外でも pending を進める (固まらないように)
        _makeDone(t.key)(null);
      }
    }
  }

  // ------------------------------------------------------------
  // dbLoadSalonDashboard(cb)
  //   サロンのトップ (ダッシュボード) 画面用。
  //   B-4: ログイン直後なので最小限。info + settings のみ。
  //        予約一覧やカレンダーは各画面遷移時に別途取得する。
  //   戻り値: { info, settings }
  // ------------------------------------------------------------
  function dbLoadSalonDashboard(cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, null); return; }
    _parallelLoad([
      {
        key: 'info',
        run: function (done) {
          dbSalonGetInfo(function (v) { done(v || null); });
        }
      },
      {
        key: 'settings',
        run: function (done) {
          dbSalonGetConfig('settings', function (v) { done(v || null); });
        }
      }
    ], cb);
  }
  window.dbLoadSalonDashboard = dbLoadSalonDashboard;

  // ------------------------------------------------------------
  // dbLoadSalonCalendar(monthStr, cb)
  //   サロンのカレンダー画面用。
  //   B-6: 指定月の appointments のみ (dateKey 範囲クエリ)。
  //   実体は shared_db_calendar.js の calendarLoadMonth に委譲。
  //   calendarLoadMonth は内部で settings/menus/appointments/closeBlocks を
  //   並列取得して { settings, menus, appointments, closeBlocks,
  //   monthStr, dateFrom, dateTo } を返す。
  //   monthStr: "2026-05" 形式。
  // ------------------------------------------------------------
  function dbLoadSalonCalendar(monthStr, cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, null); return; }
    if (typeof window.calendarLoadMonth !== 'function') {
      _logErr('dbLoadSalonCalendar', 'shared_db_calendar.js not loaded');
      _safeCb(cb, null);
      return;
    }
    window.calendarLoadMonth(monthStr, cb);
  }
  window.dbLoadSalonCalendar = dbLoadSalonCalendar;

  // ------------------------------------------------------------
  // dbLoadSalonCustomers(cb)
  //   サロンの顧客管理画面用。顧客一覧。
  //   戻り値: { customers }
  //   注: 顧客数が将来数千件規模になったら limit + ページングを検討
  //       (Phase 2 以降。フェーズ1の小規模サロンでは全件で問題なし)。
  // ------------------------------------------------------------
  function dbLoadSalonCustomers(cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, null); return; }
    _parallelLoad([
      {
        key: 'customers',
        run: function (done) {
          dbSalonListCustomers(function (v) { done(v || []); });
        }
      }
    ], cb);
  }
  window.dbLoadSalonCustomers = dbLoadSalonCustomers;

  // ------------------------------------------------------------
  // dbLoadSalonMenus(cb)
  //   メニュー設定画面用。
  //   設計書 B-1: menus + staffs + resources。
  //   フェーズ1では staffs は owner 1件、resources は default 1件だが、
  //   3次元予約モデル (設計書 0-2) のため最初から3点セットで取得する。
  //   戻り値: { menus, staffs, resources }
  // ------------------------------------------------------------
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
      {
        key: 'staffs',
        run: function (done) {
          dbReadCollection(base + '/staffs', null, function (v) { done(v || []); });
        }
      },
      {
        key: 'resources',
        run: function (done) {
          dbReadCollection(base + '/resources', null, function (v) { done(v || []); });
        }
      }
    ], cb);
  }
  window.dbLoadSalonMenus = dbLoadSalonMenus;

  // ------------------------------------------------------------
  // dbLoadSalonSettings(cb)
  //   営業時間・キャンセル規定・スタンプ設定の編集画面用。
  //   config 3 ドキュメントを並列取得。
  //   戻り値: { settings, cancelPolicy, stampCard }
  // ------------------------------------------------------------
  function dbLoadSalonSettings(cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, null); return; }
    _parallelLoad([
      {
        key: 'settings',
        run: function (done) {
          dbSalonGetConfig('settings', function (v) { done(v || null); });
        }
      },
      {
        key: 'cancelPolicy',
        run: function (done) {
          dbSalonGetConfig('cancelPolicy', function (v) { done(v || null); });
        }
      },
      {
        key: 'stampCard',
        run: function (done) {
          dbSalonGetConfig('stampCard', function (v) { done(v || null); });
        }
      }
    ], cb);
  }
  window.dbLoadSalonSettings = dbLoadSalonSettings;

  // ------------------------------------------------------------
  // dbLoadCustomerHome(cb)
  //   顧客アプリの初期表示用。
  //   設計書 4-2: 起動時は settings + menus(公開のみ) + cancelPolicy。
  //   サロン名表示のため info も含める (軽量)。
  //   B-6: メニューは公開のみ (menuListPublic)。
  //   戻り値: { info, settings, menus, cancelPolicy }
  // ------------------------------------------------------------
  function dbLoadCustomerHome(cb) {
    var sid = getCurrentSalonId();
    if (!sid) { _safeCb(cb, null); return; }
    _parallelLoad([
      {
        key: 'info',
        run: function (done) {
          dbCustomerGetSalonInfo(function (v) { done(v || null); });
        }
      },
      {
        key: 'settings',
        run: function (done) {
          dbSalonGetConfig('settings', function (v) { done(v || null); });
        }
      },
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
      {
        key: 'cancelPolicy',
        run: function (done) {
          dbSalonGetConfig('cancelPolicy', function (v) { done(v || null); });
        }
      }
    ], cb);
  }
  window.dbLoadCustomerHome = dbLoadCustomerHome;

  // ------------------------------------------------------------
  // dbLoadCustomerBooking(dateStr, cb)
  //   顧客アプリの予約日時選択用。
  //   B-6: 指定日の appointments のみ (dateKey == dateStr)。
  //   実体は shared_db_calendar.js の calendarLoadDay に委譲。
  //   calendarLoadDay は内部で settings/appointments/closeBlocks を
  //   並列取得して { settings, appointments, closeBlocks, dateKey } を返す。
  //   dateStr: "2026-05-14" 形式。
  // ------------------------------------------------------------
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

  // ------------------------------------------------------------
  // dbLoadCustomerHistory(cb)
  //   顧客の予約履歴画面用。
  //   設計書 B-1 / B-8: current (appointments) + archive
  //   (appointments_archive) の両方を読む。
  //   B-6: 自分の予約のみ (customerId == 自分の Auth UID)。
  //        さらに最近分に絞るため dateKey 降順 + limit。
  //
  //   ★ B-8 補足 (DESIGN_NOTES 項目7):
  //     古い予約を appointments → appointments_archive へ移す
  //     Cloud Functions バッチは「読む側」より後回し。
  //     今はバッチがまだ無いので appointments_archive は通常空。
  //     それでも最初から両方読む実装にしておくことで、将来バッチを
  //     足したときに顧客履歴のコードを一切変えずに済む (設計書0-2の指針)。
  //
  //   戻り値: { current: [...], archive: [...], merged: [...] }
  //     merged は両方を dateKey 降順で統合済み (画面はこれを使えばよい)。
  //
  //   注: appointments_archive の firestore.rules は Phase A-step1 で
  //       current と同じ読み取り権限で設定済み (allow read: 本人 or staff)。
  // ------------------------------------------------------------
  function dbLoadCustomerHistory(cb) {
    var sid = getCurrentSalonId();
    var uid = getCurrentUserUid();
    if (!sid || !uid) { _safeCb(cb, null); return; }

    var HISTORY_LIMIT = 50; // current/archive 各 50 件まで

    function _queryMine(col) {
      // customerId == 自分 / dateKey 降順 / limit
      return col.where('customerId', '==', uid)
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
            function (v) {
              // archive がまだ存在しない / 空でも [] を返す。
              // ルール上 read は許可済みだが、万一拒否されても
              // _logErr 済みで null が来るので [] に正規化。
              done(v || []);
            }
          );
        }
      }
    ], function (bundle) {
      var cur = bundle.current || [];
      var arc = bundle.archive || [];
      // merged: current + archive を dateKey 降順で統合
      var merged = [];
      var i;
      for (i = 0; i < cur.length; i++) { merged.push(cur[i]); }
      for (i = 0; i < arc.length; i++) { merged.push(arc[i]); }
      merged.sort(function (a, b) {
        var ak = a.dateKey || '';
        var bk = b.dateKey || '';
        if (ak === bk) {
          // 同日内は start 降順 (新しい時刻が上)
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
        merged: merged
      });
    });
  }
  window.dbLoadCustomerHistory = dbLoadCustomerHistory;

  // ============================================================
  // デバッグ用 (本番では呼ばれない想定)
  // ============================================================

  window._sharedDbDebug = {
    getUrlSalonId: function () { return _urlSalonId; },
    getReadyState: function () { return _fbReady; },
    // Phase B-1: 画面別並列取得 API の一覧 (動作確認用)
    loadApis: [
      'dbLoadSalonDashboard',
      'dbLoadSalonCalendar',
      'dbLoadSalonCustomers',
      'dbLoadSalonMenus',
      'dbLoadSalonSettings',
      'dbLoadCustomerHome',
      'dbLoadCustomerBooking',
      'dbLoadCustomerHistory'
    ],
    // Phase B-8: サロン側 顧客詳細の current+archive 統合履歴
    salonCustomerHistoryApi: 'dbSalonGetCustomerHistory'
  };

  console.log('[shared_db] loaded. urlSalonId =', _urlSalonId,
              '(Phase B complete: B-1 8 dbLoad* APIs + B-8 archive-merge ready)');

})();
