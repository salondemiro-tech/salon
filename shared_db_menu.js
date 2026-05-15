/*
 * shared_db_menu.js  -  TORITA Phase A-step2 / A-3
 * 作成: 2026/5/15
 *
 * 役割:
 *   メニュー専用の CRUD + 並び替え + 公開/非公開切り替えロジック。
 *   設計書 A-3 (862行) に明示された責務:
 *     - メニュー CRUD
 *     - メニューの並べ替え、公開/非公開切り替え
 *
 * 設計準拠:
 *   - DESIGN.md v6 セクション 1 (メニュースキーマ 180-193 行),
 *                 セクション 1 (読み取り権限 197-200 行),
 *                 A-3, A-8 (フェーズ1の自動フィールド付与)
 *   - DESIGN_NOTES.md 項目 2 (Rules最低限/複雑ロジックはFunctions)
 *   - firestore.rules (2026/5/15 sortOrder 追加版) と完全整合
 *   - shared_db.js が先にロードされている前提
 *
 * メニュードキュメントのフィールド (firestore.rules ホワイトリスト):
 *   必須:
 *     name (string)
 *     duration (int > 0)
 *     price (int >= 0)
 *     type ('main' or 'option')
 *     public (bool)
 *     eligibleStaffIds (list) - フェーズ1は ['owner'] 固定で自動付与
 *     requiredResourceIds (list) - フェーズ1は ['default'] 固定で自動付与
 *   省略可:
 *     intervalBefore (int) - 前のインターバル (分)、フェーズ1は 0 自動付与
 *     intervalAfter (int)  - 後のインターバル (分)、フェーズ1は 0 自動付与
 *     description (string) - メニュー説明文
 *     contraindications (string) - 注意事項・禁忌事項
 *     photoUrl (string) - フェーズ1未使用
 *     sortOrder (int >= 0) - 並び順 (このファイルが管理)
 *     createdAt (timestamp)
 *
 * 並び替え方式 (sortOrder):
 *   - 各メニューに sortOrder: 10, 20, 30, ... を持たせる
 *   - 10刻みにする理由: 上下ボタンで入れ替えるとき、2件を swap する以外に
 *     「中間に挿入」もサポートしやすい (将来のドラッグ&ドロップ実装向け)
 *   - 新規追加時は「現在の最大値 + 10」をセット (末尾に追加)
 *   - main/option の type ごとに別系列で管理 (main 同士で並び順を持つ)
 *
 * フィールド名対応 (旧画面 → 新TORITA):
 *   旧 desc           → 新 description       (ルール準拠)
 *   旧 caution        → 新 contraindications (ルール準拠)
 *
 * 関数ラインナップ:
 *   ── 取得 ──
 *     menuList(filterObj, cb)        全メニュー取得 (sortOrder 昇順)
 *     menuListPublic(cb)             公開メニューのみ (顧客アプリ用)
 *     menuGet(menuId, cb)            1件取得
 *     menuGetCount(cb)               件数取得 (100件上限チェック用)
 *
 *   ── 作成/更新/削除 ──
 *     menuCreate(data, cb)           新規追加 (sortOrder 自動採番)
 *     menuUpdate(menuId, patch, cb)  編集 (sortOrder は触らない)
 *     menuDelete(menuId, cb)         削除
 *     menuDuplicate(menuId, cb)      複製 (旧画面のコピー機能)
 *
 *   ── 公開/非公開 ──
 *     menuTogglePublic(menuId, currentPublic, cb)
 *
 *   ── 並び替え ──
 *     menuMoveUp(menuId, cb)         上に移動 (同type内で swap)
 *     menuMoveDown(menuId, cb)       下に移動 (同type内で swap)
 *
 * 制約:
 *   - 最大100件 (設計書0-2のフェーズ1運用想定、旧画面と同じ)
 *
 * ES5 互換:
 *   - var / function / Promise.then のみ
 *   - const / let / アロー関数 / async-await / テンプレートリテラル / ?. 禁止
 *
 * コールバック規約:
 *   - 全関数 cb(result) 形式
 *   - 成功時: result = データ または { ok: true, ... }
 *   - 失敗時: result = null または { ok: false, code, message }
 */

(function () {

  // ============================================================
  // 定数
  // ============================================================

  var MENU_MAX_COUNT = 100;            // メニュー上限件数 (旧画面と同じ)
  var SORT_STEP = 10;                  // sortOrder の刻み幅
  var DEFAULT_STAFF_IDS = ['owner'];   // フェーズ1固定値 (設計書 0-2 ルール8)
  var DEFAULT_RESOURCE_IDS = ['default']; // フェーズ1固定値

  // ============================================================
  // 内部ヘルパー
  // ============================================================

  function _safeCb(cb, value) {
    if (typeof cb === 'function') {
      try {
        cb(value);
      } catch (e) {
        console.error('[menu] cb error', e);
      }
    }
  }

  function _err(code, message) {
    return { ok: false, code: code, message: message };
  }

  function _ok(extra) {
    var r = { ok: true };
    if (extra) {
      var k;
      for (k in extra) {
        if (extra.hasOwnProperty(k)) {
          r[k] = extra[k];
        }
      }
    }
    return r;
  }

  // shared_db.js の関数が読み込まれているか確認
  function _checkSharedDb() {
    if (typeof window.dbReadCollection !== 'function' ||
        typeof window.dbAddDoc !== 'function' ||
        typeof window.dbUpdateDoc !== 'function' ||
        typeof window.dbDeleteDoc !== 'function' ||
        typeof window.getCurrentSalonId !== 'function') {
      console.error('[menu] shared_db.js が先にロードされていません');
      return false;
    }
    return true;
  }

  function _salonPath() {
    var sid = window.getCurrentSalonId();
    if (!sid) {
      return null;
    }
    return 'salons/' + sid;
  }

  // ============================================================
  // 取得系
  // ============================================================

  // 全メニュー取得 (サロン側の管理画面用)
  // filterObj: { type: 'main' or 'option' } で絞り込み可 (省略可)
  // 並び順: sortOrder 昇順 (sortOrder がないメニューは末尾、createdAt 昇順)
  function menuList(filterObj, cb) {
    if (!_checkSharedDb()) { _safeCb(cb, null); return; }
    var sp = _salonPath();
    if (!sp) { _safeCb(cb, null); return; }

    window.dbReadCollection(sp + '/menus', function (col) {
      var q = col;
      if (filterObj && filterObj.type) {
        q = q.where('type', '==', filterObj.type);
      }
      // orderBy は Firestore のインデックスが必要だが、menus は件数が少ない (最大100)
      // ので、クライアント側でソートする方が無難 (orderBy では sortOrder 未設定の
      // ドキュメントが取れないケースがあるため)
      return q;
    }, function (arr) {
      if (!arr) {
        _safeCb(cb, null);
        return;
      }
      // クライアント側ソート: sortOrder 昇順、未設定は末尾、tie-break は name 昇順
      arr.sort(function (a, b) {
        var aHas = (typeof a.sortOrder === 'number');
        var bHas = (typeof b.sortOrder === 'number');
        if (aHas && bHas) {
          if (a.sortOrder !== b.sortOrder) {
            return a.sortOrder - b.sortOrder;
          }
        } else if (aHas) {
          return -1;
        } else if (bHas) {
          return 1;
        }
        // tie-break: name 昇順
        var an = a.name || '';
        var bn = b.name || '';
        if (an < bn) { return -1; }
        if (an > bn) { return 1; }
        return 0;
      });
      _safeCb(cb, arr);
    });
  }
  window.menuList = menuList;

  // 公開メニューのみ取得 (顧客アプリ用、ルール 141-142 行)
  function menuListPublic(cb) {
    if (!_checkSharedDb()) { _safeCb(cb, null); return; }
    var sp = _salonPath();
    if (!sp) { _safeCb(cb, null); return; }

    window.dbReadCollection(sp + '/menus', function (col) {
      return col.where('public', '==', true);
    }, function (arr) {
      if (!arr) {
        _safeCb(cb, null);
        return;
      }
      // sortOrder 昇順 + tie-break で name 昇順 (menuList と同じロジック)
      arr.sort(function (a, b) {
        var aHas = (typeof a.sortOrder === 'number');
        var bHas = (typeof b.sortOrder === 'number');
        if (aHas && bHas) {
          if (a.sortOrder !== b.sortOrder) {
            return a.sortOrder - b.sortOrder;
          }
        } else if (aHas) {
          return -1;
        } else if (bHas) {
          return 1;
        }
        var an = a.name || '';
        var bn = b.name || '';
        if (an < bn) { return -1; }
        if (an > bn) { return 1; }
        return 0;
      });
      _safeCb(cb, arr);
    });
  }
  window.menuListPublic = menuListPublic;

  // 1件取得
  function menuGet(menuId, cb) {
    if (!_checkSharedDb()) { _safeCb(cb, null); return; }
    var sp = _salonPath();
    if (!sp || !menuId) { _safeCb(cb, null); return; }
    window.dbReadDoc(sp + '/menus/' + menuId, cb);
  }
  window.menuGet = menuGet;

  // メニュー総数取得 (100件上限チェック用)
  function menuGetCount(cb) {
    menuList(null, function (arr) {
      if (!arr) {
        _safeCb(cb, 0);
        return;
      }
      _safeCb(cb, arr.length);
    });
  }
  window.menuGetCount = menuGetCount;

  // ============================================================
  // 作成
  //
  // data の必須フィールド: name, duration, price, type, public
  // data の任意フィールド: description, contraindications,
  //                       intervalBefore, intervalAfter
  //
  // 自動付与 (フェーズ1):
  //   eligibleStaffIds: ['owner']
  //   requiredResourceIds: ['default']
  //   intervalBefore: 0 (data に指定があればそちら優先)
  //   intervalAfter: 0  (data に指定があればそちら優先)
  //   sortOrder: 同type内の最大値 + 10 (末尾に追加)
  //   createdAt: serverTimestamp
  // ============================================================

  function menuCreate(data, cb) {
    if (!_checkSharedDb()) {
      _safeCb(cb, _err('not-loaded', 'システムエラーが発生しました。'));
      return;
    }
    var sp = _salonPath();
    if (!sp) {
      _safeCb(cb, _err('not-authenticated', 'ログインが必要です。'));
      return;
    }
    if (!data || typeof data !== 'object') {
      _safeCb(cb, _err('invalid-data', 'メニュー情報が不正です。'));
      return;
    }

    // 必須フィールドのチェック
    if (!data.name || typeof data.name !== 'string') {
      _safeCb(cb, _err('invalid-name', 'メニュー名を入力してください。'));
      return;
    }
    if (typeof data.duration !== 'number' || data.duration <= 0 ||
        Math.floor(data.duration) !== data.duration) {
      _safeCb(cb, _err('invalid-duration', '所要時間を正しく入力してください (1分以上の整数)。'));
      return;
    }
    if (typeof data.price !== 'number' || data.price < 0 ||
        Math.floor(data.price) !== data.price) {
      _safeCb(cb, _err('invalid-price', '料金を正しく入力してください (0以上の整数)。'));
      return;
    }
    if (data.type !== 'main' && data.type !== 'option') {
      _safeCb(cb, _err('invalid-type', '種別が不正です。'));
      return;
    }
    if (typeof data.public !== 'boolean') {
      _safeCb(cb, _err('invalid-public', '公開設定が不正です。'));
      return;
    }

    // 件数チェック (100件上限)
    menuGetCount(function (count) {
      if (count >= MENU_MAX_COUNT) {
        _safeCb(cb, _err('limit-exceeded',
          'メニューは最大' + MENU_MAX_COUNT + '件まで登録できます。'));
        return;
      }

      // sortOrder の決定 (同type内の最大値 + 10)
      menuList({ type: data.type }, function (sameTypeList) {
        var maxSort = 0;
        if (sameTypeList && sameTypeList.length > 0) {
          var i;
          for (i = 0; i < sameTypeList.length; i++) {
            if (typeof sameTypeList[i].sortOrder === 'number' &&
                sameTypeList[i].sortOrder > maxSort) {
              maxSort = sameTypeList[i].sortOrder;
            }
          }
        }
        var newSortOrder = maxSort + SORT_STEP;

        // ドキュメント組み立て
        // ルール: hasOnly [name,duration,price,type,public,
        //                  eligibleStaffIds,requiredResourceIds,
        //                  intervalBefore,intervalAfter,
        //                  description,contraindications,
        //                  photoUrl,sortOrder,createdAt]
        // ルール: hasAll [name,duration,price,type,public,
        //                 eligibleStaffIds,requiredResourceIds]
        var doc = {
          name: String(data.name).trim(),
          duration: data.duration,
          price: data.price,
          type: data.type,
          public: data.public,
          eligibleStaffIds: DEFAULT_STAFF_IDS.slice(),    // フェーズ1自動付与
          requiredResourceIds: DEFAULT_RESOURCE_IDS.slice(), // フェーズ1自動付与
          intervalBefore: (typeof data.intervalBefore === 'number') ? data.intervalBefore : 0,
          intervalAfter: (typeof data.intervalAfter === 'number') ? data.intervalAfter : 0,
          sortOrder: newSortOrder,
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        // 任意フィールド
        if (data.description && typeof data.description === 'string') {
          doc.description = String(data.description).trim();
        }
        if (data.contraindications && typeof data.contraindications === 'string') {
          doc.contraindications = String(data.contraindications).trim();
        }
        if (data.photoUrl && typeof data.photoUrl === 'string') {
          doc.photoUrl = String(data.photoUrl);
        }

        // 書き込み
        window.dbAddDoc(sp + '/menus', doc, function (result) {
          if (!result) {
            _safeCb(cb, _err('create-failed', 'メニューの作成に失敗しました。'));
            return;
          }
          _safeCb(cb, _ok({
            menuId: result._id,
            sortOrder: newSortOrder,
            message: 'メニューを追加しました。'
          }));
        });
      });
    });
  }
  window.menuCreate = menuCreate;

  // ============================================================
  // 更新
  //
  // patch には変更したいフィールドだけ含める。
  // type が変更されると sortOrder の系列が変わるため、その場合は
  // 新 type の末尾に sortOrder を付け直す。
  // sortOrder 自体は通常 patch で送らない (menuMoveUp/Down が管理)。
  // ============================================================

  function menuUpdate(menuId, patch, cb) {
    if (!_checkSharedDb()) {
      _safeCb(cb, _err('not-loaded', 'システムエラーが発生しました。'));
      return;
    }
    var sp = _salonPath();
    if (!sp || !menuId) {
      _safeCb(cb, _err('invalid-args', 'メニューIDが指定されていません。'));
      return;
    }
    if (!patch || typeof patch !== 'object') {
      _safeCb(cb, _err('invalid-patch', '変更内容が不正です。'));
      return;
    }

    // 各フィールドの型チェック
    if (patch.hasOwnProperty('name')) {
      if (!patch.name || typeof patch.name !== 'string') {
        _safeCb(cb, _err('invalid-name', 'メニュー名を入力してください。'));
        return;
      }
      patch.name = String(patch.name).trim();
    }
    if (patch.hasOwnProperty('duration')) {
      if (typeof patch.duration !== 'number' || patch.duration <= 0 ||
          Math.floor(patch.duration) !== patch.duration) {
        _safeCb(cb, _err('invalid-duration', '所要時間を正しく入力してください。'));
        return;
      }
    }
    if (patch.hasOwnProperty('price')) {
      if (typeof patch.price !== 'number' || patch.price < 0 ||
          Math.floor(patch.price) !== patch.price) {
        _safeCb(cb, _err('invalid-price', '料金を正しく入力してください。'));
        return;
      }
    }
    if (patch.hasOwnProperty('type')) {
      if (patch.type !== 'main' && patch.type !== 'option') {
        _safeCb(cb, _err('invalid-type', '種別が不正です。'));
        return;
      }
    }
    if (patch.hasOwnProperty('public')) {
      if (typeof patch.public !== 'boolean') {
        _safeCb(cb, _err('invalid-public', '公開設定が不正です。'));
        return;
      }
    }

    // type が変わる場合は sortOrder を新 type の末尾に振り直す
    if (patch.hasOwnProperty('type')) {
      menuGet(menuId, function (cur) {
        if (!cur) {
          _safeCb(cb, _err('not-found', 'メニューが見つかりません。'));
          return;
        }
        if (cur.type === patch.type) {
          // type は実質変わっていない -> 通常の update
          _doMenuUpdate(sp, menuId, patch, cb);
          return;
        }
        // type 変更あり: 新 type の末尾に sortOrder を付与
        menuList({ type: patch.type }, function (sameTypeList) {
          var maxSort = 0;
          if (sameTypeList && sameTypeList.length > 0) {
            var i;
            for (i = 0; i < sameTypeList.length; i++) {
              if (typeof sameTypeList[i].sortOrder === 'number' &&
                  sameTypeList[i].sortOrder > maxSort) {
                maxSort = sameTypeList[i].sortOrder;
              }
            }
          }
          patch.sortOrder = maxSort + SORT_STEP;
          _doMenuUpdate(sp, menuId, patch, cb);
        });
      });
      return;
    }

    _doMenuUpdate(sp, menuId, patch, cb);
  }
  window.menuUpdate = menuUpdate;

  function _doMenuUpdate(sp, menuId, patch, cb) {
    window.dbUpdateDoc(sp + '/menus/' + menuId, patch, function (ok) {
      if (!ok) {
        _safeCb(cb, _err('update-failed', 'メニューの更新に失敗しました。'));
        return;
      }
      _safeCb(cb, _ok({ message: 'メニューを更新しました。' }));
    });
  }

  // ============================================================
  // 削除
  // ルール 168 行: 削除はオーナーのみ
  // フェーズ1ではスタッフ=オーナーなので問題なし
  // ============================================================

  function menuDelete(menuId, cb) {
    if (!_checkSharedDb()) {
      _safeCb(cb, _err('not-loaded', 'システムエラーが発生しました。'));
      return;
    }
    var sp = _salonPath();
    if (!sp || !menuId) {
      _safeCb(cb, _err('invalid-args', 'メニューIDが指定されていません。'));
      return;
    }
    window.dbDeleteDoc(sp + '/menus/' + menuId, function (ok) {
      if (!ok) {
        _safeCb(cb, _err('delete-failed', 'メニューの削除に失敗しました。'));
        return;
      }
      _safeCb(cb, _ok({ message: 'メニューを削除しました。' }));
    });
  }
  window.menuDelete = menuDelete;

  // ============================================================
  // 複製 (旧画面のコピー機能 ⧉ ボタン)
  //
  // 元メニューを取得 -> 名前に「（コピー）」を付ける -> menuCreate
  // sortOrder は menuCreate が末尾に振り直す
  // ============================================================

  function menuDuplicate(menuId, cb) {
    if (!menuId) {
      _safeCb(cb, _err('invalid-args', 'メニューIDが指定されていません。'));
      return;
    }
    menuGet(menuId, function (src) {
      if (!src) {
        _safeCb(cb, _err('not-found', '複製元のメニューが見つかりません。'));
        return;
      }
      // ルールのホワイトリストにあるフィールドだけ引き継ぐ
      // (createdAt/sortOrder は menuCreate が新規付与、_id は除外)
      var copy = {
        name: src.name + '（コピー）',
        duration: src.duration,
        price: src.price,
        type: src.type,
        public: src.public
      };
      if (typeof src.intervalBefore === 'number') {
        copy.intervalBefore = src.intervalBefore;
      }
      if (typeof src.intervalAfter === 'number') {
        copy.intervalAfter = src.intervalAfter;
      }
      if (src.description) { copy.description = src.description; }
      if (src.contraindications) { copy.contraindications = src.contraindications; }
      if (src.photoUrl) { copy.photoUrl = src.photoUrl; }

      menuCreate(copy, function (result) {
        if (!result || !result.ok) {
          _safeCb(cb, result || _err('duplicate-failed', '複製に失敗しました。'));
          return;
        }
        _safeCb(cb, _ok({
          menuId: result.menuId,
          message: '「' + src.name + '」を複製しました。'
        }));
      });
    });
  }
  window.menuDuplicate = menuDuplicate;

  // ============================================================
  // 公開/非public トグル
  // 引数: menuId, currentPublic (現在の状態、これを反転させる)
  //
  // 注: currentPublic を引数で受けるのは、トグル前に1回 menuGet するのを
  //     省くため。画面側は描画時にすでに現在値を持っているはず。
  // ============================================================

  function menuTogglePublic(menuId, currentPublic, cb) {
    if (!menuId) {
      _safeCb(cb, _err('invalid-args', 'メニューIDが指定されていません。'));
      return;
    }
    if (typeof currentPublic !== 'boolean') {
      _safeCb(cb, _err('invalid-current', '現在の公開状態が不正です。'));
      return;
    }
    menuUpdate(menuId, { public: !currentPublic }, cb);
  }
  window.menuTogglePublic = menuTogglePublic;

  // ============================================================
  // 並び替え (上下移動)
  //
  // 仕組み:
  //   1. 全メニューを取得 (同type内のリストを得る)
  //   2. 対象メニューの現在の sortOrder と、隣接メニューの sortOrder を取得
  //   3. 2つの sortOrder を swap して両方更新
  //
  // 注意:
  //   - 「上端 / 下端」のメニューに対する移動はエラーにせず、no-op で OK を返す
  //     (画面側でボタンを disabled にしている前提だが、二重防衛として)
  //   - main/option それぞれの中で並び替える (type をまたがない)
  // ============================================================

  function menuMoveUp(menuId, cb) {
    _menuMove(menuId, 'up', cb);
  }
  window.menuMoveUp = menuMoveUp;

  function menuMoveDown(menuId, cb) {
    _menuMove(menuId, 'down', cb);
  }
  window.menuMoveDown = menuMoveDown;

  function _menuMove(menuId, direction, cb) {
    if (!_checkSharedDb()) {
      _safeCb(cb, _err('not-loaded', 'システムエラーが発生しました。'));
      return;
    }
    if (!menuId) {
      _safeCb(cb, _err('invalid-args', 'メニューIDが指定されていません。'));
      return;
    }
    var sp = _salonPath();
    if (!sp) {
      _safeCb(cb, _err('not-authenticated', 'ログインが必要です。'));
      return;
    }

    // 対象メニューを取得して type を確認 -> 同type内のリスト取得 -> swap
    menuGet(menuId, function (target) {
      if (!target) {
        _safeCb(cb, _err('not-found', 'メニューが見つかりません。'));
        return;
      }
      menuList({ type: target.type }, function (list) {
        if (!list || list.length === 0) {
          _safeCb(cb, _err('not-found', 'メニューが見つかりません。'));
          return;
        }
        // 自分のインデックスを探す
        var idx = -1;
        var i;
        for (i = 0; i < list.length; i++) {
          if (list[i]._id === menuId) {
            idx = i;
            break;
          }
        }
        if (idx < 0) {
          _safeCb(cb, _err('not-found', 'メニューが一覧に見つかりません。'));
          return;
        }

        // 移動先のインデックス
        var swapIdx;
        if (direction === 'up') {
          if (idx === 0) {
            // 既に一番上 -> no-op
            _safeCb(cb, _ok({ message: '既に一番上です。', moved: false }));
            return;
          }
          swapIdx = idx - 1;
        } else {
          if (idx === list.length - 1) {
            // 既に一番下 -> no-op
            _safeCb(cb, _ok({ message: '既に一番下です。', moved: false }));
            return;
          }
          swapIdx = idx + 1;
        }

        var self = list[idx];
        var other = list[swapIdx];

        // sortOrder の値を取り出す
        // 片方が sortOrder 未設定の場合、便宜的に「インデックス×SORT_STEP + SORT_STEP」を割り当てる
        var selfOrder = (typeof self.sortOrder === 'number') ?
                        self.sortOrder : (idx + 1) * SORT_STEP;
        var otherOrder = (typeof other.sortOrder === 'number') ?
                         other.sortOrder : (swapIdx + 1) * SORT_STEP;

        // 同じ値だと swap しても順番が変わらないので、強制的に差をつける
        if (selfOrder === otherOrder) {
          if (direction === 'up') {
            // self を other より小さく
            selfOrder = otherOrder - 1;
          } else {
            selfOrder = otherOrder + 1;
          }
        } else {
          // 通常の swap
          var tmp = selfOrder;
          selfOrder = otherOrder;
          otherOrder = tmp;
        }

        // 両方を更新 (順次)
        // 注: WriteBatch でアトミックにする方が望ましいが、shared_db.js の
        //     抽象化レイヤを保つため、ここでは逐次更新 (片方失敗しても
        //     リカバリはユーザーの再操作で吸収)。
        //     フェーズ2でリアルタイム同期化するときに batch 化検討。
        window.dbUpdateDoc(sp + '/menus/' + self._id,
          { sortOrder: selfOrder }, function (ok1) {
            if (!ok1) {
              _safeCb(cb, _err('move-failed', '並び替えに失敗しました。'));
              return;
            }
            window.dbUpdateDoc(sp + '/menus/' + other._id,
              { sortOrder: otherOrder }, function (ok2) {
                if (!ok2) {
                  _safeCb(cb, _err('move-partial-failed',
                    '並び替えが途中で失敗しました。画面を更新してください。'));
                  return;
                }
                _safeCb(cb, _ok({
                  moved: true,
                  message: '順番を変更しました。'
                }));
              });
          });
      });
    });
  }

  // ============================================================
  // デバッグ用
  // ============================================================

  window._menuDebug = {
    MAX_COUNT: MENU_MAX_COUNT,
    SORT_STEP: SORT_STEP,
    DEFAULT_STAFF_IDS: DEFAULT_STAFF_IDS,
    DEFAULT_RESOURCE_IDS: DEFAULT_RESOURCE_IDS
  };

  console.log('[menu] loaded.');

})();
