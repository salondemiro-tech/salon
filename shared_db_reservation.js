/*
 * shared_db_reservation.js  -  TORITA Phase A-step2 / A-2
 * 作成: 2026/5/14
 *
 * 役割:
 *   予約専用の上位ラッパー + 計算ユーティリティ集。
 *   shared_db.js の基本 CRUD の上に、入力検証・エラーハンドリング・
 *   時刻計算・キャンセル期限判定などの「予約に固有のロジック」を載せる。
 *
 *   Phase B-5 で実装される「3次元予約計算（時間×スタッフ×設備）」も、
 *   このファイルの部品関数（reservationCalcEndTime, reservationCheckOverlap,
 *   reservationParseTime, reservationFormatTime）を利用する想定。
 *
 * 設計準拠:
 *   - DESIGN.md v6 セクション 1 (3次元予約モデル), A-2, B-5
 *   - DESIGN_NOTES.md 項目 2 (Rules最低限/複雑ロジックはFunctions),
 *     3 (createdAtサーバ確定), 5 (dateKey + startAt/endAt 併用),
 *     6 (editingBy箱だけ), 8 (status将来肥大化)
 *   - firestore.rules (2026/5/14 改訂版) と完全整合
 *   - shared_db.js が先にロードされている前提
 *
 * 重要な責務の境界 (DESIGN_NOTES 項目2準拠):
 *   ── shared_db_reservation.js でやること ──
 *     A. 予約 CRUD の上位ラッパー (バリデーション + dbCustomer* / dbSalon* 呼び出し)
 *     B. 時刻計算ユーティリティ ("10:00" ⇔ 分単位の整数)
 *     C. 終了時刻計算 (start + duration + intervalAfter)
 *     D. 重複検出 (クライアント側の早期判定、UI 用)
 *     E. キャンセル期限判定 (cancelPolicy.deadline と現在時刻の比較)
 *     F. status 遷移の事前チェック (UI で「キャンセル可」ボタンを出すか等)
 *
 *   ── ここで「やらない」こと (Functions または Rules の責任) ──
 *     - 予約の最終的な重複チェック (Functions onAppointmentCreate で実施)
 *     - 営業時間との整合性検証 (Functions)
 *     - 価格計算 (Functions が priceSnapshot を確定)
 *     - end/startAt/endAt/staffId/resourceIds/status/priceSnapshot/createdAt
 *       のサーバ側確定 (Functions)
 *     - status 遷移の最終判定 (Functions / Rules)
 *
 *   ── Phase B-5 でやること (このファイルが部品を提供) ──
 *     - 3次元予約可能時間計算 (時間 × スタッフ × 設備)
 *       入力: メニューID, 日付, 既存予約一覧, スタッフ一覧, 設備一覧, シフト
 *       出力: 予約可能な時間枠リスト
 *
 * 関数ラインナップ:
 *   ── 予約 CRUD ラッパー ──
 *     reservationCreate(data, cb)              顧客の予約作成 (Phase D で使用)
 *     reservationCreateBySalon(data, cb)       サロンの手動登録 (旧画面の＋登録)
 *     reservationCancelByCustomer(apptId, cb)  顧客のキャンセル
 *     reservationCancelBySalon(apptId, reason, cb)  サロンのキャンセル
 *     reservationUpdateBySalon(apptId, patch, cb)   サロンの予約変更
 *     reservationGet(apptId, cb)                予約取得 (サロン/顧客自動判別)
 *
 *   ── 時刻計算ユーティリティ ──
 *     reservationParseTime(str)         "10:00" → 600 (minutes since midnight)
 *     reservationFormatTime(minutes)    600 → "10:00"
 *     reservationCalcEndTime(start, duration, intervalAfter)
 *                                       終了時刻 (HH:MM 文字列) を計算
 *     reservationCalcEndMinutes(startMin, duration, intervalAfter)
 *                                       終了時刻 (分単位整数) を計算
 *
 *   ── 重複・期限判定 ──
 *     reservationCheckOverlap(newStart, newEnd, existingList)
 *                                       既存予約との重複をクライアント側で検出
 *     reservationCanCancelByDeadline(apptDateKey, apptStart, deadlineSetting)
 *                                       cancelPolicy.deadline の値で判定
 *     reservationIsCancellableStatus(status)
 *                                       status が 'confirmed' ならキャンセル可
 *
 *   ── 状態定数 ──
 *     RESERVATION_STATUSES  status の許可リスト (設計書本体準拠)
 *
 * ES5 互換:
 *   - var / function / Promise.then のみ
 *   - const / let / アロー関数 / async-await / テンプレートリテラル / ?. 禁止
 *
 * コールバック規約:
 *   - 全関数 cb(result) 形式
 *   - 成功時: result = { ok: true, ... } または値
 *   - 失敗時: result = { ok: false, code: '...', message: '...' }
 *   - 同期ユーティリティ (時刻計算等) は例外的に値を直接返す
 */

(function () {

  // ============================================================
  // 状態定数 (設計書本体 85行)
  // ============================================================

  var RESERVATION_STATUSES = [
    'confirmed',     // 確定 (作成時のデフォルト、Functions が確定後にセット)
    'cancelled',     // キャンセル済み
    'no_show',       // 無断キャンセル (来店なし)
    'completed',     // 来店・施術完了
    'refunded'       // 返金済み
  ];
  window.RESERVATION_STATUSES = RESERVATION_STATUSES;

  // ============================================================
  // 内部ヘルパー
  // ============================================================

  function _safeCb(cb, value) {
    if (typeof cb === 'function') {
      try {
        cb(value);
      } catch (e) {
        console.error('[reservation] cb error', e);
      }
    }
  }

  function _errResult(code, message) {
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

  function _isHHMM(s) {
    return (typeof s === 'string' && /^[0-9]{2}:[0-9]{2}$/.test(s));
  }

  function _isYYYYMMDD(s) {
    return (typeof s === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s));
  }

  function _isPositiveInt(n) {
    return (typeof n === 'number' && isFinite(n) && n >= 0 && Math.floor(n) === n);
  }

  // ============================================================
  // 時刻計算ユーティリティ
  //
  // 内部表現:
  //   - 時刻ラベル: "HH:MM" 文字列 (DB 保存形式)
  //   - 計算用: 0時0分からの分数 (minutes since midnight, 整数)
  //
  // 例: "10:30" ⇔ 630
  //     "00:00" ⇔ 0
  //     "23:59" ⇔ 1439
  //
  // 日跨ぎは扱わない (フェーズ1の前提)。深夜営業の対応は Phase 2 以降。
  // ============================================================

  // "10:30" → 630 (失敗時 null)
  function reservationParseTime(str) {
    if (!_isHHMM(str)) {
      return null;
    }
    var parts = str.split(':');
    var h = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10);
    if (h < 0 || h > 23 || m < 0 || m > 59) {
      return null;
    }
    return h * 60 + m;
  }
  window.reservationParseTime = reservationParseTime;

  // 630 → "10:30"
  function reservationFormatTime(minutes) {
    if (!_isPositiveInt(minutes) || minutes < 0 || minutes >= 24 * 60) {
      return null;
    }
    var h = Math.floor(minutes / 60);
    var m = minutes % 60;
    var hh = (h < 10) ? ('0' + h) : String(h);
    var mm = (m < 10) ? ('0' + m) : String(m);
    return hh + ':' + mm;
  }
  window.reservationFormatTime = reservationFormatTime;

  // ============================================================
  // 終了時刻計算
  //
  // 設計書本体 89行:
  //   end = start + menu.duration + sum(optionMenuIds の duration) + intervalAfter
  //
  // ただし intervalAfter はサーバ確定 (Functions) の領域。
  // クライアントの A-2 では「表示用の見込み終了時刻」を出すために計算する。
  // 最終的な end は Functions が menus と optionMenuIds から再計算してセットする。
  //
  // 引数:
  //   start         - "HH:MM"
  //   duration      - メインメニューの所要時間 (分)
  //   intervalAfter - メニューの intervalAfter (分、省略時 0)
  //   optionDurationTotal - オプション合計時間 (分、省略時 0)
  // ============================================================

  function reservationCalcEndTime(start, duration, intervalAfter, optionDurationTotal) {
    var startMin = reservationParseTime(start);
    if (startMin === null) {
      return null;
    }
    var endMin = reservationCalcEndMinutes(startMin, duration, intervalAfter, optionDurationTotal);
    if (endMin === null) {
      return null;
    }
    return reservationFormatTime(endMin);
  }
  window.reservationCalcEndTime = reservationCalcEndTime;

  function reservationCalcEndMinutes(startMin, duration, intervalAfter, optionDurationTotal) {
    if (!_isPositiveInt(startMin) || !_isPositiveInt(duration) || duration <= 0) {
      return null;
    }
    var iv = _isPositiveInt(intervalAfter) ? intervalAfter : 0;
    var opt = _isPositiveInt(optionDurationTotal) ? optionDurationTotal : 0;
    var endMin = startMin + duration + opt + iv;
    if (endMin > 24 * 60) {
      // 日跨ぎ: フェーズ1では弾く (Phase 2 で対応)
      return null;
    }
    return endMin;
  }
  window.reservationCalcEndMinutes = reservationCalcEndMinutes;

  // ============================================================
  // 重複検出 (クライアント側の早期判定)
  //
  // 用途: 予約画面で「この時間は埋まっています」と表示するため。
  // 注意: これはあくまで UI 用。実際の予約成立は Functions の
  //       onAppointmentCreate で再チェックされる。
  //       クライアントの判定だけを信用してはいけない (DESIGN_NOTES 項目2)。
  //
  // 引数:
  //   newStart       - "HH:MM" or 分数
  //   newEnd         - "HH:MM" or 分数
  //   existingList   - 既存予約配列、各要素は { start: "HH:MM", end: "HH:MM", status }
  //                    または { startAt, endAt, status } でも可
  //                    status='cancelled' / 'no_show' は重複対象外
  //
  // 戻り値: 重複する既存予約の配列 (空なら重複なし)
  // ============================================================

  function reservationCheckOverlap(newStart, newEnd, existingList) {
    var nStart, nEnd;
    if (typeof newStart === 'string') {
      nStart = reservationParseTime(newStart);
    } else {
      nStart = newStart;
    }
    if (typeof newEnd === 'string') {
      nEnd = reservationParseTime(newEnd);
    } else {
      nEnd = newEnd;
    }
    if (nStart === null || nEnd === null || nStart >= nEnd) {
      return [];
    }
    if (!existingList || existingList.length === 0) {
      return [];
    }

    var overlaps = [];
    var i;
    for (i = 0; i < existingList.length; i++) {
      var a = existingList[i];
      if (!a) { continue; }
      // キャンセル済みは重複対象外
      if (a.status === 'cancelled' || a.status === 'no_show') {
        continue;
      }
      var aStart = null, aEnd = null;
      if (typeof a.start === 'string') {
        aStart = reservationParseTime(a.start);
      }
      if (typeof a.end === 'string') {
        aEnd = reservationParseTime(a.end);
      }
      // start/end 文字列がなければ startAt/endAt の Date 化を試みる
      if ((aStart === null || aEnd === null) && a.startAt && a.endAt) {
        try {
          var sd = (typeof a.startAt.toDate === 'function') ? a.startAt.toDate() : new Date(a.startAt);
          var ed = (typeof a.endAt.toDate === 'function') ? a.endAt.toDate() : new Date(a.endAt);
          aStart = sd.getHours() * 60 + sd.getMinutes();
          aEnd = ed.getHours() * 60 + ed.getMinutes();
        } catch (e) {
          continue;
        }
      }
      if (aStart === null || aEnd === null) { continue; }

      // 区間 [nStart, nEnd) と [aStart, aEnd) の重複判定
      if (nStart < aEnd && aStart < nEnd) {
        overlaps.push(a);
      }
    }
    return overlaps;
  }
  window.reservationCheckOverlap = reservationCheckOverlap;

  // ============================================================
  // キャンセル期限判定
  //
  // 設計書 cancelPolicy.deadline の値:
  //   '3日前まで'    → 予約日の3日前 23:59 まで
  //   '2日前まで'    → 予約日の2日前 23:59 まで
  //   '前日まで'     → 予約日の前日 23:59 まで
  //   '前日24時まで' → 予約日の前日 24:00 (= 当日 00:00) まで
  //
  // 引数:
  //   apptDateKey      - "2026-05-14" (予約日)
  //   apptStart        - "10:00" (予約開始時刻、フェーズ1では不使用、将来 same-day deadline 用)
  //   deadlineSetting  - cancelPolicy.deadline の文字列
  //   now              - 比較基準時刻 (省略時 new Date())
  //
  // 戻り値: true/false (true = まだキャンセル可能)
  // ============================================================

  function reservationCanCancelByDeadline(apptDateKey, apptStart, deadlineSetting, now) {
    if (!_isYYYYMMDD(apptDateKey)) {
      return false;
    }
    if (!deadlineSetting || typeof deadlineSetting !== 'string') {
      // 設定がなければ「期限なし」扱い = 常にキャンセル可
      return true;
    }
    var nowDate = (now instanceof Date) ? now : new Date();

    // 予約日の Date オブジェクト (ローカルタイム、その日の 00:00:00)
    var parts = apptDateKey.split('-');
    var apptDate = new Date(
      parseInt(parts[0], 10),
      parseInt(parts[1], 10) - 1,
      parseInt(parts[2], 10),
      0, 0, 0, 0
    );

    // deadline 種別に応じて、いつまで操作できるかの Date を計算
    var deadlineDate = null;
    if (deadlineSetting === '3日前まで') {
      // 予約日の3日前の 23:59:59 まで
      deadlineDate = new Date(apptDate.getTime());
      deadlineDate.setDate(deadlineDate.getDate() - 3);
      deadlineDate.setHours(23, 59, 59, 999);
    } else if (deadlineSetting === '2日前まで') {
      deadlineDate = new Date(apptDate.getTime());
      deadlineDate.setDate(deadlineDate.getDate() - 2);
      deadlineDate.setHours(23, 59, 59, 999);
    } else if (deadlineSetting === '前日まで') {
      deadlineDate = new Date(apptDate.getTime());
      deadlineDate.setDate(deadlineDate.getDate() - 1);
      deadlineDate.setHours(23, 59, 59, 999);
    } else if (deadlineSetting === '前日24時まで') {
      // 前日 24:00 = 当日 00:00 まで (apptDate がちょうどそれ)
      deadlineDate = new Date(apptDate.getTime());
      // 00:00:00.000 そのまま
    } else {
      // 未知の値: 安全側に倒して「キャンセル不可」
      console.warn('[reservation] unknown deadlineSetting:', deadlineSetting);
      return false;
    }

    // now < deadlineDate ならまだキャンセル可能
    return nowDate.getTime() < deadlineDate.getTime();
  }
  window.reservationCanCancelByDeadline = reservationCanCancelByDeadline;

  // status がキャンセル可能な状態か (UI で「キャンセル」ボタンを出す判定)
  // 設計書本体: 顧客本人は confirmed → cancelled のみ可
  // (Rules も同じ制約: firestore.rules 261-266 行)
  function reservationIsCancellableStatus(status) {
    return (status === 'confirmed');
  }
  window.reservationIsCancellableStatus = reservationIsCancellableStatus;

  // ============================================================
  // 予約 CRUD ラッパー
  // ============================================================

  // 予約取得 (サロン側でも顧客側でも使える共通ラッパー)
  // shared_db.js の dbSalonGetAppointment を呼ぶ (ルールで権限が制御される)
  function reservationGet(apptId, cb) {
    if (!apptId) {
      _safeCb(cb, null);
      return;
    }
    if (typeof window.dbSalonGetAppointment !== 'function') {
      console.error('[reservation] dbSalonGetAppointment not loaded');
      _safeCb(cb, null);
      return;
    }
    window.dbSalonGetAppointment(apptId, cb);
  }
  window.reservationGet = reservationGet;

  // ----------------------------------------------------------
  // 顧客の予約作成ラッパー
  //
  // 設計書 1 (predicate 3-4) + DESIGN_NOTES 項目 5:
  //   顧客が送れるフィールド: dateKey, start, customerId, menuId, optionMenuIds
  //   その他はサーバ確定 (end/startAt/endAt/staffId/resourceIds/status/
  //                     priceSnapshot/createdAt)
  //
  // このラッパーは shared_db.js の dbCustomerCreateAppointment を呼ぶ前に:
  //   - 必須フィールドの早期チェック
  //   - 形式チェック (dateKey: YYYY-MM-DD, start: HH:MM)
  //   - optionMenuIds は配列であること
  //
  // 引数:
  //   data: { dateKey, start, menuId, optionMenuIds? }
  // ----------------------------------------------------------
  function reservationCreate(data, cb) {
    if (!data || typeof data !== 'object') {
      _safeCb(cb, _errResult('invalid-data', '予約データが不正です。'));
      return;
    }
    if (!_isYYYYMMDD(data.dateKey)) {
      _safeCb(cb, _errResult('invalid-dateKey', '日付の形式が正しくありません。'));
      return;
    }
    if (!_isHHMM(data.start)) {
      _safeCb(cb, _errResult('invalid-start', '時刻の形式が正しくありません。'));
      return;
    }
    if (!data.menuId || typeof data.menuId !== 'string') {
      _safeCb(cb, _errResult('invalid-menuId', 'メニューを選択してください。'));
      return;
    }
    if (data.optionMenuIds && !(data.optionMenuIds instanceof Array)) {
      _safeCb(cb, _errResult('invalid-optionMenuIds', 'オプション指定が不正です。'));
      return;
    }
    if (typeof window.dbCustomerCreateAppointment !== 'function') {
      console.error('[reservation] dbCustomerCreateAppointment not loaded');
      _safeCb(cb, _errResult('not-loaded', 'システムエラーが発生しました。'));
      return;
    }
    // 過去日付は弾く (UI 早期チェック、最終チェックは Functions)
    // ES5 互換のため padStart は使わず、手動でゼロ埋め
    var today = new Date();
    var m = today.getMonth() + 1;
    var d = today.getDate();
    var todayKey = today.getFullYear() + '-' +
                   (m < 10 ? '0' + m : '' + m) + '-' +
                   (d < 10 ? '0' + d : '' + d);
    if (data.dateKey < todayKey) {
      _safeCb(cb, _errResult('past-date', '過去の日付には予約できません。'));
      return;
    }

    // dbCustomerCreateAppointment に丸投げ (内部で pendingCreate:true を付与)
    window.dbCustomerCreateAppointment(
      {
        dateKey: data.dateKey,
        start: data.start,
        menuId: data.menuId,
        optionMenuIds: data.optionMenuIds || []
      },
      function (result) {
        if (!result) {
          _safeCb(cb, _errResult('create-failed', '予約の作成に失敗しました。'));
          return;
        }
        // result は { _id: ドキュメントID }
        // Functions の onAppointmentCreate が pendingCreate を確定処理する
        // フェーズ1ではこのラッパーは「書き込み成功」までを返す
        _safeCb(cb, _ok({
          appointmentId: result._id,
          message: '予約を受け付けました。確認メールをお送りします。'
        }));
      }
    );
  }
  window.reservationCreate = reservationCreate;

  // ----------------------------------------------------------
  // 顧客のキャンセル
  //
  // フロー:
  //   1. 予約を取得
  //   2. キャンセル可能 status か確認
  //   3. cancelPolicy.deadline と現在時刻でキャンセル期限内か確認
  //   4. 期限内なら status を cancelled に更新
  //
  // 期限切れの判定はクライアント側 (UI で「キャンセル不可」を出すため)。
  // Rules はクライアントの「confirmed → cancelled」を許可するだけで、
  // 期限切れチェックは Cloud Functions で別途やる想定 (フェーズ2)。
  // フェーズ1では期限切れもクライアント側で弾く。
  // ----------------------------------------------------------
  function reservationCancelByCustomer(apptId, cb) {
    if (!apptId) {
      _safeCb(cb, _errResult('invalid-apptId', '予約IDが指定されていません。'));
      return;
    }
    if (typeof window.dbSalonGetAppointment !== 'function' ||
        typeof window.dbCustomerCancelMyAppointment !== 'function' ||
        typeof window.dbSalonGetConfig !== 'function') {
      _safeCb(cb, _errResult('not-loaded', 'システムエラーが発生しました。'));
      return;
    }

    // 1. 予約取得
    window.dbSalonGetAppointment(apptId, function (appt) {
      if (!appt) {
        _safeCb(cb, _errResult('not-found', '予約が見つかりません。'));
        return;
      }
      // 2. status チェック
      if (!reservationIsCancellableStatus(appt.status)) {
        _safeCb(cb, _errResult('not-cancellable',
                               'この予約はキャンセルできません (' + appt.status + ')'));
        return;
      }
      // 3. キャンセル期限チェック (cancelPolicy を取得して判定)
      window.dbSalonGetConfig('cancelPolicy', function (policy) {
        var deadlineSetting = (policy && policy.deadline) ? policy.deadline : null;
        var canCancel = reservationCanCancelByDeadline(
          appt.dateKey, appt.start, deadlineSetting, new Date()
        );
        if (!canCancel) {
          _safeCb(cb, _errResult('deadline-passed',
                                 'キャンセル受付期限を過ぎています。'
                                 + 'お手数ですがサロンに直接ご連絡ください。'));
          return;
        }
        // 4. キャンセル実行
        window.dbCustomerCancelMyAppointment(apptId, function (ok) {
          if (!ok) {
            _safeCb(cb, _errResult('cancel-failed', 'キャンセル処理に失敗しました。'));
            return;
          }
          _safeCb(cb, _ok({ message: 'キャンセルを受け付けました。' }));
        });
      });
    });
  }
  window.reservationCancelByCustomer = reservationCancelByCustomer;

  // ----------------------------------------------------------
  // サロンの手動登録 (旧画面の「＋登録」ボタン相当)
  //
  // 顧客アプリ経由ではなく、サロンスタッフがカレンダー画面から
  // 直接予約を登録する経路。pendingCreate は使わず、最初から
  // status='confirmed', source='manual' で書き込む。
  //
  // クライアント側で end / startAt / endAt / priceSnapshot を
  // 計算して送る (フェーズ1の運用、Phase B-5 で再考)。
  //
  // 引数:
  //   data: {
  //     dateKey: "YYYY-MM-DD" (必須)
  //     start: "HH:MM" (必須)
  //     end: "HH:MM" (省略可、UI で計算して送る)
  //     menuId: string (必須)
  //     menuName: string (任意、後でメニュー削除されても予約に名前残す用)
  //     optionMenuIds: array<string> (省略可)
  //     customerId: string (任意、Auth UID を持つ顧客なら指定)
  //     customerName: string (任意、Auth UID なし顧客の場合に名前だけ保存)
  //     durationMin: int (任意、UI で計算して送る)
  //     intervalAfterOverride: int >= 0 (省略可、メニューの intervalAfter を上書き)
  //     priceSnapshot: int >= 0 (任意、UI で計算して送る)
  //     memo: string (省略可)
  //   }
  //
  // 戻り値: { ok: true, appointmentId } または { ok: false, code, message }
  // ----------------------------------------------------------
  function reservationCreateBySalon(data, cb) {
    if (!data || typeof data !== 'object') {
      _safeCb(cb, _errResult('invalid-data', '予約データが不正です。'));
      return;
    }
    if (!_isYYYYMMDD(data.dateKey)) {
      _safeCb(cb, _errResult('invalid-dateKey', '日付の形式が正しくありません。'));
      return;
    }
    if (!_isHHMM(data.start)) {
      _safeCb(cb, _errResult('invalid-start', '時刻の形式が正しくありません。'));
      return;
    }
    if (data.end && !_isHHMM(data.end)) {
      _safeCb(cb, _errResult('invalid-end', '終了時刻の形式が正しくありません。'));
      return;
    }
    if (!data.menuId || typeof data.menuId !== 'string') {
      _safeCb(cb, _errResult('invalid-menuId', 'メニューを選択してください。'));
      return;
    }
    if (data.optionMenuIds && !(data.optionMenuIds instanceof Array)) {
      _safeCb(cb, _errResult('invalid-optionMenuIds', 'オプション指定が不正です。'));
      return;
    }
    if (data.hasOwnProperty('intervalAfterOverride')) {
      var iv = data.intervalAfterOverride;
      if (typeof iv !== 'number' || iv < 0 || Math.floor(iv) !== iv) {
        _safeCb(cb, _errResult('invalid-interval', 'インターバルを正しく入力してください。'));
        return;
      }
    }
    if (typeof window.dbAddDoc !== 'function' ||
        typeof window.getCurrentSalonId !== 'function') {
      _safeCb(cb, _errResult('not-loaded', 'システムエラーが発生しました。'));
      return;
    }

    var sid = window.getCurrentSalonId();
    if (!sid) {
      _safeCb(cb, _errResult('not-authenticated', 'ログインが必要です。'));
      return;
    }

    // ルールのホワイトリスト + 必須に沿った形でドキュメント組み立て
    // 必須: dateKey, start, menuId, status, source
    // 全許可: dateKey, start, end, startAt, endAt, customerId, customerName,
    //         menuId, menuName, optionMenuIds, staffId, resourceIds,
    //         status, source, priceSnapshot, durationMin,
    //         intervalAfterOverride, memo, editingBy, createdAt, updatedAt
    var doc = {
      dateKey: String(data.dateKey),
      start: String(data.start),
      menuId: String(data.menuId),
      status: 'confirmed',
      source: 'manual',
      // Phase I-step6: data から staffId/spaceId/equipmentId を受け取る
      staffId: (typeof data.staffId === 'string' && data.staffId) ? data.staffId : 'owner',
      spaceId: (typeof data.spaceId === 'string' && data.spaceId) ? data.spaceId : 'default',
      equipmentId: (typeof data.equipmentId === 'string' && data.equipmentId) ? data.equipmentId : null,
      resourceIds: ['default'],          // フェーズ1互換フィールド（残置）
      editingBy: null,                   // DESIGN_NOTES 項目6: 箱だけ用意
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    if (data.end) { doc.end = String(data.end); }
    if (data.customerId) { doc.customerId = String(data.customerId); }
    if (data.customerName) { doc.customerName = String(data.customerName); }
    if (data.menuName) { doc.menuName = String(data.menuName); }
    if (data.optionMenuIds && data.optionMenuIds.length > 0) {
      var opts = [];
      var i;
      for (i = 0; i < data.optionMenuIds.length; i++) {
        opts.push(String(data.optionMenuIds[i]));
      }
      doc.optionMenuIds = opts;
    }
    if (typeof data.durationMin === 'number') { doc.durationMin = data.durationMin; }
    if (typeof data.priceSnapshot === 'number') { doc.priceSnapshot = data.priceSnapshot; }
    if (data.hasOwnProperty('intervalAfterOverride')) {
      doc.intervalAfterOverride = data.intervalAfterOverride;
    }
    if (data.memo) { doc.memo = String(data.memo); }

    // startAt / endAt の Timestamp 化 (dateKey + start/end から合成)
    // DESIGN_NOTES 項目5: dateKey + startAt/endAt 併用設計
    try {
      var dParts = String(data.dateKey).split('-');
      var sParts = String(data.start).split(':');
      var startDate = new Date(
        parseInt(dParts[0], 10),
        parseInt(dParts[1], 10) - 1,
        parseInt(dParts[2], 10),
        parseInt(sParts[0], 10),
        parseInt(sParts[1], 10),
        0, 0
      );
      doc.startAt = firebase.firestore.Timestamp.fromDate(startDate);
      if (data.end) {
        var eParts = String(data.end).split(':');
        var endDate = new Date(
          parseInt(dParts[0], 10),
          parseInt(dParts[1], 10) - 1,
          parseInt(dParts[2], 10),
          parseInt(eParts[0], 10),
          parseInt(eParts[1], 10),
          0, 0
        );
        doc.endAt = firebase.firestore.Timestamp.fromDate(endDate);
      }
    } catch (e) {
      console.warn('[reservation] startAt/endAt 合成失敗', e);
      // startAt/endAt は省略可なので、合成失敗しても続行
    }

    // 書き込み
    window.dbAddDoc('salons/' + sid + '/appointments', doc, function (result) {
      if (!result) {
        _safeCb(cb, _errResult('create-failed', '予約の登録に失敗しました。'));
        return;
      }
      _safeCb(cb, _ok({
        appointmentId: result._id,
        message: '予約を登録しました。'
      }));
    });
  }
  window.reservationCreateBySalon = reservationCreateBySalon;

  // ----------------------------------------------------------
  // サロンのキャンセル
  //
  // サロン側からは status を任意に変更可能 (Rules: スタッフは customerId 改ざん以外 OK)。
  // reason は cancelReason フィールドに保存する想定 (将来 Functions で通知に使う)。
  //
  // 注: cancelReason はルールのホワイトリストに入っていないため、現状は
  //     書き込むと弾かれる。フェーズ1では reason は無視して status だけ更新。
  //     フェーズ2でルールにフィールド追加する。
  //
  // 引数:
  //   apptId - 予約ID
  //   reason - キャンセル理由 (フェーズ1では未使用、引数だけ受け付ける)
  // ----------------------------------------------------------
  function reservationCancelBySalon(apptId, reason, cb) {
    if (!apptId) {
      _safeCb(cb, _errResult('invalid-apptId', '予約IDが指定されていません。'));
      return;
    }
    if (typeof window.dbSalonUpdateAppointment !== 'function') {
      _safeCb(cb, _errResult('not-loaded', 'システムエラーが発生しました。'));
      return;
    }
    // フェーズ1: status のみ更新 (reason はメモリ#23の課題消化後にルール拡張)
    window.dbSalonUpdateAppointment(
      apptId,
      { status: 'cancelled' },
      function (ok) {
        if (!ok) {
          _safeCb(cb, _errResult('cancel-failed', 'キャンセル処理に失敗しました。'));
          return;
        }
        _safeCb(cb, _ok({ message: '予約をキャンセルしました。' }));
      }
    );
  }
  window.reservationCancelBySalon = reservationCancelBySalon;

  // ----------------------------------------------------------
  // サロンの予約変更
  //
  // 時刻変更・メニュー変更・status 変更などをサロンが行う。
  // patch には変更したいフィールドだけ含める。customerId は変更不可。
  //
  // 注: end/startAt/endAt の整合性はサロンの責任 (UI が事前計算して送る)。
  //     Functions が後追いで再計算する仕組みは今のところなし。
  //     これは設計書本体には書かれていない実装判断。Phase B-5 で再考。
  // ----------------------------------------------------------
  function reservationUpdateBySalon(apptId, patch, cb) {
    if (!apptId) {
      _safeCb(cb, _errResult('invalid-apptId', '予約IDが指定されていません。'));
      return;
    }
    if (!patch || typeof patch !== 'object') {
      _safeCb(cb, _errResult('invalid-patch', '変更内容が不正です。'));
      return;
    }
    if (typeof window.dbSalonUpdateAppointment !== 'function') {
      _safeCb(cb, _errResult('not-loaded', 'システムエラーが発生しました。'));
      return;
    }
    // status 値の事前チェック (許可リストにあるか)
    if (patch.hasOwnProperty('status')) {
      var found = false;
      var i;
      for (i = 0; i < RESERVATION_STATUSES.length; i++) {
        if (RESERVATION_STATUSES[i] === patch.status) {
          found = true;
          break;
        }
      }
      if (!found) {
        _safeCb(cb, _errResult('invalid-status',
                               '不正な状態です: ' + patch.status));
        return;
      }
    }
    // 安全のため customerId は除去 (Rules でも弾かれるが二重防衛)
    if (patch.hasOwnProperty('customerId')) {
      delete patch.customerId;
    }
    window.dbSalonUpdateAppointment(apptId, patch, function (ok) {
      if (!ok) {
        _safeCb(cb, _errResult('update-failed', '予約の変更に失敗しました。'));
        return;
      }
      _safeCb(cb, _ok({ message: '予約を変更しました。' }));
    });
  }
  window.reservationUpdateBySalon = reservationUpdateBySalon;

  // ============================================================
  // Phase B-5: 予約可能時間の3次元計算 (時間 × スタッフ × 設備)
  //
  // 設計準拠:
  //   - DESIGN.md v6 セクション 0-2 (3次元予約モデル / 9つの設計ルール
  //     特にルール4「予約可能時間の計算ロジックをスタッフ×設備の空きで書く」、
  //     ルール5「インターバルを最初から考慮」), 7 Phase B (B-5)
  //   - DESIGN_NOTES.md 項目 2 (これは UI 用の早期判定。最終確定は
  //     Functions onAppointmentCreate。クライアント判定だけを信用しない)
  //
  // 設計書 B-5 のロジック (DESIGN.md 908行〜) を 1対1 で実装:
  //   入力: メニューID, 日付, 既存予約一覧, スタッフ一覧, 設備一覧, シフト
  //   出力: 予約可能な時間枠リスト
  //   手順:
  //     1. メニューの eligibleStaffIds から候補スタッフを抽出
  //     2. メニューの requiredResourceIds から必要設備を抽出
  //     3. 各時間枠について:
  //        - 候補スタッフのうち、その時間に予約が無いスタッフがいるか
  //        - 必要設備のうち、その時間に予約が無い設備が確保できるか
  //        - スタッフのシフト内か (フェーズ1は営業時間=シフト)
  //        - インターバル時間も加味
  //     4. 両方OKな時間枠だけ返す
  //
  // フェーズ1の固定値 (設計書 0-2):
  //   - 候補スタッフ = メニューの eligibleStaffIds (常に ['owner'])
  //   - 必要設備     = メニューの requiredResourceIds (常に ['default'])
  //   - シフト       = 営業時間 settings.openTime〜closeTime
  //                    (calendarGetBusinessHours で休憩 weeklyClose も取得)
  //   ただしロジックは配列を総当たりする3次元構造で書く。
  //   フェーズ2でスタッフ/設備が増えても、この関数は一切変更不要。
  //
  // 責務境界 (DESIGN_NOTES 項目2):
  //   ここでやるのは「UI に予約可能スロットを出すための事前計算」のみ。
  //   実際に予約が成立するかは Functions onAppointmentCreate が再検証する。
  // ============================================================

  // 予約スロットの開始時刻刻み幅 (分)。
  // フェーズ1は 15 分刻み。将来 settings.slotInterval で上書き可能にする
  // 余地を残すが、現状は固定。
  var RESERVATION_SLOT_STEP_MIN = 15;
  window.RESERVATION_SLOT_STEP_MIN = RESERVATION_SLOT_STEP_MIN;

  // ------------------------------------------------------------
  // 内部: 配列ヘルパー (ES5、Array.indexOf は IE9+ で可だが念のため自前)
  // ------------------------------------------------------------
  function _arrIncludes(arr, val) {
    if (!arr || !arr.length) { return false; }
    var i;
    for (i = 0; i < arr.length; i++) {
      if (arr[i] === val) { return true; }
    }
    return false;
  }

  // ------------------------------------------------------------
  // 内部: 予約 a が time区間 [qStart, qEnd) (分) と重なるか
  //   キャンセル済み / no_show は対象外。
  //   a は { start:"HH:MM", end:"HH:MM", status } または
  //        { startAt, endAt, status }。
  //   intervalBefore/After を考慮するため、予約の占有区間を
  //   [aStart - aIntervalBefore, aEnd + aIntervalAfter) で見る…のは
  //   本来 Functions の責務。ここでは保存済み end が既に
  //   intervalAfter 込み (Functions が確定) という前提で素直に重なり判定する。
  // ------------------------------------------------------------
  function _apptOverlaps(a, qStart, qEnd) {
    if (!a) { return false; }
    if (a.status === 'cancelled' || a.status === 'no_show') {
      return false;
    }
    var aStart = null, aEnd = null;
    if (typeof a.start === 'string') {
      aStart = reservationParseTime(a.start);
    }
    if (typeof a.end === 'string') {
      aEnd = reservationParseTime(a.end);
    }
    if ((aStart === null || aEnd === null) && a.startAt && a.endAt) {
      try {
        var sd = (typeof a.startAt.toDate === 'function')
                 ? a.startAt.toDate() : new Date(a.startAt);
        var ed = (typeof a.endAt.toDate === 'function')
                 ? a.endAt.toDate() : new Date(a.endAt);
        aStart = sd.getHours() * 60 + sd.getMinutes();
        aEnd = ed.getHours() * 60 + ed.getMinutes();
      } catch (e) {
        return false;
      }
    }
    if (aStart === null || aEnd === null) { return false; }
    // 区間 [qStart, qEnd) と [aStart, aEnd) の重なり
    return (qStart < aEnd && aStart < qEnd);
  }

  // ------------------------------------------------------------
  // 内部: 指定スタッフ staffId が区間 [qStart,qEnd) に空いているか
  //   appts のうち staffId が一致する予約と重ならなければ true。
  //   フェーズ1では予約の staffId は全て 'owner'。
  // ------------------------------------------------------------
  function _isStaffFree(staffId, qStart, qEnd, appts) {
    if (!appts || !appts.length) { return true; }
    var i;
    for (i = 0; i < appts.length; i++) {
      var a = appts[i];
      if (!a) { continue; }
      // a.staffId 未設定 (pendingCreate 前) は owner 扱いで安全側に倒す
      var aStaff = a.staffId ? a.staffId : 'owner';
      if (aStaff !== staffId) { continue; }
      if (_apptOverlaps(a, qStart, qEnd)) {
        return false;
      }
    }
    return true;
  }

  // ------------------------------------------------------------
  // 内部: 指定設備 resourceId が区間 [qStart,qEnd) に空いているか
  //   appts のうち resourceIds に resourceId を含む予約と
  //   重ならなければ true。フェーズ1では resourceIds は ['default']。
  // ------------------------------------------------------------
  function _isResourceFree(resourceId, qStart, qEnd, appts) {
    if (!appts || !appts.length) { return true; }
    var i;
    for (i = 0; i < appts.length; i++) {
      var a = appts[i];
      if (!a) { continue; }
      var aRes = a.resourceIds;
      // resourceIds 未設定 (pendingCreate 前) は ['default'] 扱い
      if (!aRes || !aRes.length) { aRes = ['default']; }
      if (!_arrIncludes(aRes, resourceId)) { continue; }
      if (_apptOverlaps(a, qStart, qEnd)) {
        return false;
      }
    }
    return true;
  }

  // Phase I-step6: 場所（spaceId）の空き判定
  function _isSpaceFree(spaceId, qStart, qEnd, appts) {
    if (!appts || !appts.length) { return true; }
    var i;
    for (i = 0; i < appts.length; i++) {
      var a = appts[i];
      if (!a) { continue; }
      // spaceId 未設定の予約（フェーズ1）は 'default' 扱い
      var aSpace = a.spaceId ? a.spaceId : 'default';
      if (aSpace !== spaceId) { continue; }
      if (_apptOverlaps(a, qStart, qEnd)) { return false; }
    }
    return true;
  }

  // Phase I-step6: 機器（equipmentId）の空き判定
  function _isEquipmentFree(equipmentId, qStart, qEnd, appts) {
    if (!appts || !appts.length) { return true; }
    var i;
    for (i = 0; i < appts.length; i++) {
      var a = appts[i];
      if (!a) { continue; }
      // equipmentId 未設定の予約は機器を使っていない扱い → 競合しない
      if (!a.equipmentId) { continue; }
      if (a.equipmentId !== equipmentId) { continue; }
      if (_apptOverlaps(a, qStart, qEnd)) { return false; }
    }
    return true;
  }

  // ------------------------------------------------------------
  // 内部: 区間 [qStart,qEnd) が営業時間内かつ休憩(weeklyClose)と
  //   重ならないか。bh = calendarGetBusinessHours の戻り値
  //   { openTime, closeTime, isOpen, weeklyCloses:[{start,end}] }
  // ------------------------------------------------------------
  function _isWithinShift(qStart, qEnd, bh) {
    if (!bh || !bh.isOpen) { return false; }
    var openMin = reservationParseTime(bh.openTime);
    var closeMin = reservationParseTime(bh.closeTime);
    if (openMin === null || closeMin === null) { return false; }
    if (qStart < openMin || qEnd > closeMin) { return false; }
    // 休憩時間帯と重ならないこと
    if (bh.weeklyCloses && bh.weeklyCloses.length) {
      var i;
      for (i = 0; i < bh.weeklyCloses.length; i++) {
        var wc = bh.weeklyCloses[i];
        if (!wc) { continue; }
        var ws = reservationParseTime(wc.start);
        var we = reservationParseTime(wc.end);
        if (ws === null || we === null) { continue; }
        if (qStart < we && ws < qEnd) {
          return false;
        }
      }
    }
    return true;
  }

  // ------------------------------------------------------------
  // 内部: closeBlocks (臨時休業) と区間が重ならないか
  //   closeBlocks の各要素は { date:"YYYY-MM-DD", start?, end?, allDay? }
  //   想定 (旧v8互換)。allDay または start/end 無しは終日休業扱い。
  //   dateKey 一致のものだけを渡す前提だが、念のため date も照合する。
  // ------------------------------------------------------------
  function _hitsCloseBlock(qStart, qEnd, dateKey, closeBlocks) {
    if (!closeBlocks || !closeBlocks.length) { return false; }
    var i;
    for (i = 0; i < closeBlocks.length; i++) {
      var cb2 = closeBlocks[i];
      if (!cb2) { continue; }
      if (cb2.date && cb2.date !== dateKey) { continue; }
      // 終日休業
      if (cb2.allDay === true ||
          (typeof cb2.start !== 'string' && typeof cb2.end !== 'string')) {
        return true;
      }
      var cs = (typeof cb2.start === 'string')
               ? reservationParseTime(cb2.start) : null;
      var ce = (typeof cb2.end === 'string')
               ? reservationParseTime(cb2.end) : null;
      if (cs === null || ce === null) {
        // 時刻不正なら安全側 (終日休業扱い)
        return true;
      }
      if (qStart < ce && cs < qEnd) {
        return true;
      }
    }
    return false;
  }

  // ------------------------------------------------------------
  // 内部: 1メニュー分の所要時間 (分) を計算
  //   menu.duration + sum(optionMenus.duration) + intervalBefore +
  //   intervalAfter。
  //   ※ 表示用見込み。最終確定は Functions。
  // ------------------------------------------------------------
  function _calcServiceMinutes(menu, optionMenus) {
    if (!menu || !_isPositiveInt(menu.duration) || menu.duration <= 0) {
      return null;
    }
    var total = menu.duration;
    var ivB = _isPositiveInt(menu.intervalBefore) ? menu.intervalBefore : 0;
    var ivA = _isPositiveInt(menu.intervalAfter) ? menu.intervalAfter : 0;
    total += ivB + ivA;
    if (optionMenus && optionMenus.length) {
      var i;
      for (i = 0; i < optionMenus.length; i++) {
        var om = optionMenus[i];
        if (om && _isPositiveInt(om.duration) && om.duration > 0) {
          total += om.duration;
        }
      }
    }
    return total;
  }

  // ------------------------------------------------------------
  // reservationCalcAvailableSlotsSync(params)  ← 同期版 (本体)
  //
  // データを既に取得済みのとき (dbLoadCustomerBooking の戻り値など)
  // この同期版を直接呼べる。UI の再描画で何度も呼ばれても DB を
  // 叩かないので軽い。
  //
  // params = {
  //   dateKey:      "2026-05-14",          (必須)
  //   menu:         { duration, intervalBefore, intervalAfter,
  //                   eligibleStaffIds, requiredResourceIds },  (必須)
  //   optionMenus:  [ { duration }, ... ],  (任意)
  //   appointments: [ 既存予約... ],         (任意、無ければ [])
  //   staffs:       [ { _id, ... }, ... ],   (任意、無ければ menu.eligible から)
  //   resources:    [ { _id, ... }, ... ],   (任意)
  //   settings:     config/settings ドキュメント (営業時間),  (必須)
  //   closeBlocks:  [ 臨時休業... ],          (任意)
  //   slotStepMin:  15                       (任意、既定 15)
  // }
  //
  // 戻り値: {
  //   ok: true,
  //   slots: [ { start:"10:00", end:"11:00",
  //              staffId:"owner", resourceIds:["default"] }, ... ],
  //   serviceMinutes: 90
  // }
  // または { ok:false, code, message }
  // ------------------------------------------------------------
  function reservationCalcAvailableSlotsSync(params) {
    if (!params || typeof params !== 'object') {
      return _errResult('bad_params', 'params is required');
    }
    if (!_isYYYYMMDD(params.dateKey)) {
      return _errResult('bad_dateKey', 'dateKey must be YYYY-MM-DD');
    }
    var menu = params.menu;
    if (!menu || !_isPositiveInt(menu.duration) || menu.duration <= 0) {
      return _errResult('bad_menu', 'menu.duration is required (> 0)');
    }

    var serviceMin = _calcServiceMinutes(menu, params.optionMenus);
    if (serviceMin === null || serviceMin <= 0) {
      return _errResult('bad_duration', 'cannot compute service minutes');
    }

    // 1. 候補スタッフ抽出 (設計書 B-5 手順1)
    //    Phase I-step6: eligibleStaffIds を使用。未設定なら ['owner']。
    var eligibleStaffIds = (menu.eligibleStaffIds && menu.eligibleStaffIds.length)
                            ? menu.eligibleStaffIds : ['owner'];

    // 2. 必要場所・機器抽出
    //    Phase I-step6: eligibleSpaceIds / eligibleEquipmentIds を使用
    //    未設定または空なら判定スキップ（フェーズ1互換）
    var eligibleSpaceIds = (menu.eligibleSpaceIds && menu.eligibleSpaceIds.length)
                            ? menu.eligibleSpaceIds : [];
    var eligibleEquipmentIds = (menu.eligibleEquipmentIds && menu.eligibleEquipmentIds.length)
                                ? menu.eligibleEquipmentIds : [];

    // フェーズ1互換判定: staffIds が ['owner'] のみ or 空 → シフト条件スキップ
    var isPhase1Menu = eligibleStaffIds.length === 0 ||
      (eligibleStaffIds.length === 1 && eligibleStaffIds[0] === 'owner');

    // 営業時間 (= フェーズ1のシフト)。calendar.js があれば委譲。
    var bh;
    if (typeof window.calendarGetBusinessHours === 'function') {
      bh = window.calendarGetBusinessHours(params.dateKey, params.settings);
    } else {
      // フォールバック: settings から直接組む
      var s = params.settings || {};
      bh = {
        openTime: s.openTime || '10:00',
        closeTime: s.closeTime || '19:00',
        isOpen: true,
        weeklyCloses: []
      };
    }
    if (!bh || !bh.isOpen) {
      // 定休日 → 空スロット
      return _ok({ slots: [], serviceMinutes: serviceMin });
    }

    var openMin = reservationParseTime(bh.openTime);
    var closeMin = reservationParseTime(bh.closeTime);
    if (openMin === null || closeMin === null || openMin >= closeMin) {
      return _errResult('bad_hours', 'invalid business hours');
    }

    var step = _isPositiveInt(params.slotStepMin) && params.slotStepMin > 0
               ? params.slotStepMin : RESERVATION_SLOT_STEP_MIN;

    var appts = params.appointments || [];
    var closeBlocks = params.closeBlocks || [];

    var slots = [];
    var t;
    // 3. 各時間枠を総当たり (設計書 B-5 手順3)
    for (t = openMin; t + serviceMin <= closeMin; t += step) {
      var qStart = t;
      var qEnd = t + serviceMin;

      // シフト内か (営業時間 + 休憩 weeklyClose)
      if (!_isWithinShift(qStart, qEnd, bh)) {
        continue;
      }
      // 臨時休業と重ならないか
      if (_hitsCloseBlock(qStart, qEnd, params.dateKey, closeBlocks)) {
        continue;
      }

      // 候補スタッフのうち、その時間に空いている人を1人探す (3次元: スタッフ軸)
      var chosenStaff = null;
      var si;
      for (si = 0; si < eligibleStaffIds.length; si++) {
        var stf = eligibleStaffIds[si];
        if (_isStaffFree(stf, qStart, qEnd, appts)) {
          chosenStaff = stf;
          break;
        }
      }
      if (chosenStaff === null) {
        continue; // どのスタッフも埋まっている
      }

      // Phase I-step6: 場所・機器の空き判定
      // eligibleSpaceIds が空なら判定スキップ（フェーズ1互換）
      var chosenSpace = null;
      if (eligibleSpaceIds.length > 0) {
        var si2;
        for (si2 = 0; si2 < eligibleSpaceIds.length; si2++) {
          if (_isSpaceFree(eligibleSpaceIds[si2], qStart, qEnd, appts)) {
            chosenSpace = eligibleSpaceIds[si2];
            break;
          }
        }
        if (chosenSpace === null) {
          continue; // 空いている場所がない
        }
      }

      // eligibleEquipmentIds が空なら判定スキップ
      var chosenEquipment = null;
      if (eligibleEquipmentIds.length > 0) {
        var ei;
        for (ei = 0; ei < eligibleEquipmentIds.length; ei++) {
          if (_isEquipmentFree(eligibleEquipmentIds[ei], qStart, qEnd, appts)) {
            chosenEquipment = eligibleEquipmentIds[ei];
            break;
          }
        }
        if (chosenEquipment === null) {
          continue; // 空いている機器がない
        }
      }

      // スタッフ・場所・機器 全てOK → 予約可能スロット
      var startLabel = reservationFormatTime(qStart);
      var endLabel = reservationFormatTime(qEnd);
      if (startLabel === null || endLabel === null) {
        continue;
      }
      slots.push({
        start: startLabel,
        end: endLabel,
        staffId: chosenStaff,
        spaceId: chosenSpace,
        equipmentId: chosenEquipment
      });
    }

    return _ok({ slots: slots, serviceMinutes: serviceMin });
  }
  window.reservationCalcAvailableSlotsSync = reservationCalcAvailableSlotsSync;

  // ------------------------------------------------------------
  // reservationCalcAvailableSlots(params, cb)  ← 非同期版 (DB取得込み)
  //
  // 設計書 B-5 の「入力: メニューID, 日付, ...」をそのまま受け取り、
  // 足りないデータ (既存予約 / settings / closeBlocks 等) を
  // shared_db_calendar.js の calendarLoadDay 経由でまとめて取得してから
  // 同期計算に渡す。
  //
  // params = {
  //   dateKey:     "2026-05-14",   (必須)
  //   menuId:      "m1",           (必須。menu を直接渡すなら menu でも可)
  //   menu:        {...},          (任意。あれば menuId 取得をスキップ)
  //   optionMenuIds: ["m4"],       (任意)
  //   slotStepMin: 15              (任意)
  // }
  //
  // cb(result):
  //   成功: { ok:true, slots:[...], serviceMinutes:N }
  //   失敗: { ok:false, code, message }
  //
  // 注 (DESIGN_NOTES 項目2): これは UI 表示用の事前計算。
  //     予約の最終成立は Functions onAppointmentCreate が再検証する。
  // ------------------------------------------------------------
  function reservationCalcAvailableSlots(params, cb) {
    if (!params || !_isYYYYMMDD(params.dateKey)) {
      _safeCb(cb, _errResult('bad_dateKey', 'dateKey must be YYYY-MM-DD'));
      return;
    }
    if (!params.menu && !params.menuId) {
      _safeCb(cb, _errResult('bad_menu', 'menuId or menu is required'));
      return;
    }

    var dateKey = params.dateKey;

    // ステップ1: 日次データ (settings / appointments / closeBlocks) を取得
    function _withDayData(dayBundle) {
      var settings = dayBundle ? dayBundle.settings : null;
      var appointments = dayBundle ? (dayBundle.appointments || []) : [];
      var closeBlocks = dayBundle ? (dayBundle.closeBlocks || []) : [];

      // ステップ2: メニュー本体を用意
      function _withMenu(menuObj) {
        if (!menuObj) {
          _safeCb(cb, _errResult('menu_not_found', 'menu not found'));
          return;
        }
        // オプションメニュー解決
        function _withOptions(optionMenus) {
          var sync = reservationCalcAvailableSlotsSync({
            dateKey: dateKey,
            menu: menuObj,
            optionMenus: optionMenus || [],
            appointments: appointments,
            settings: settings,
            closeBlocks: closeBlocks,
            slotStepMin: params.slotStepMin
          });
          _safeCb(cb, sync);
        }

        if (params.optionMenuIds && params.optionMenuIds.length &&
            typeof window.menuGet === 'function') {
          var collected = [];
          var pending = params.optionMenuIds.length;
          var i;
          for (i = 0; i < params.optionMenuIds.length; i++) {
            window.menuGet(params.optionMenuIds[i], function (om) {
              if (om) { collected.push(om); }
              pending--;
              if (pending <= 0) {
                _withOptions(collected);
              }
            });
          }
        } else {
          _withOptions([]);
        }
      }

      if (params.menu) {
        _withMenu(params.menu);
      } else if (typeof window.menuGet === 'function') {
        window.menuGet(params.menuId, function (m) {
          _withMenu(m);
        });
      } else {
        _safeCb(cb, _errResult('no_menu_api',
          'menuGet unavailable; pass params.menu directly'));
      }
    }

    if (typeof window.calendarLoadDay === 'function') {
      window.calendarLoadDay(dateKey, function (bundle) {
        if (!bundle) {
          _safeCb(cb, _errResult('load_failed',
            'failed to load day data'));
          return;
        }
        _withDayData(bundle);
      });
    } else {
      _safeCb(cb, _errResult('no_calendar',
        'shared_db_calendar.js (calendarLoadDay) not loaded'));
    }
  }
  window.reservationCalcAvailableSlots = reservationCalcAvailableSlots;

  // ============================================================
  // デバッグ用
  // ============================================================

  window._reservationDebug = {
    parseTime: reservationParseTime,
    formatTime: reservationFormatTime,
    statuses: RESERVATION_STATUSES,
    // Phase B-5: 3次元予約可能時間計算
    slotStepMin: RESERVATION_SLOT_STEP_MIN,
    calcSlotsSync: reservationCalcAvailableSlotsSync,
    calcSlots: reservationCalcAvailableSlots
  };

  console.log('[reservation] loaded. (Phase B-5: 3D slot calc ready)');

})();
