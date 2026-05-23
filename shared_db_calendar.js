/*
 * shared_db_calendar.js  -  TORITA Phase A-step2 / A-4
 * 作成: 2026/5/15
 *
 * 役割:
 *   カレンダー画面 (salon_calendar) 専用のデータ取得・整形ロジック。
 *   設計書 A-4 の責務 (864-866 行):
 *     - 月別予約取得、closeBlocks 取得
 *     - 営業時間と組み合わせた表示用データ生成
 *
 *   旧 TORITA の salon_calendar_v7.html は週間ビュー (7日 × 時刻軸) なので、
 *   このファイルも週間ビューを前提に組み立てる。月別取得 API も持つ
 *   (Phase B-1 dbLoadSalonCalendar の準備)。
 *
 * 設計準拠:
 *   - DESIGN.md v6 セクション 1, 3-4, 4, A-4, B-1, B-6
 *   - DESIGN_NOTES.md 項目 2, 5 (dateKey+startAt/endAt 併用),
 *                     6 (editingBy は箱だけ)
 *   - firestore.rules (2026/5/15 source/intervalAfterOverride/手動登録対応版)
 *   - shared_db.js, shared_db_reservation.js が先にロードされている前提
 *
 * 重要な設計判断:
 *   - 表示形式: 週間ビュー (旧画面踏襲、Salon de Miro の運用感を維持)
 *   - 予約データの読み取り方針 (設計書 600 行):
 *       * pendingCreate: true の予約はカレンダーに表示しない (除外)
 *       * status: 'cancelled' / 'no_show' はデフォルトで除外
 *       * status: 'confirmed' / 'completed' のみ表示
 *   - クエリ範囲: 日付範囲 (dateFrom 〜 dateTo) で取得
 *       * 週間ビュー: 7日分
 *       * 月別取得: その月の1日〜末日
 *
 * 関数ラインナップ:
 *   ── データ取得 ──
 *     calendarLoadWeek(weekStartDate, cb)
 *           週間ビュー用データ一括取得 (settings + menus + appointments + closeBlocks)
 *     calendarLoadMonth(monthStr, cb)
 *           月別データ一括取得 (B-1 dbLoadSalonCalendar の準備)
 *     calendarLoadDay(dateKey, cb)
 *           1日分のデータ取得 (顧客アプリの予約日時選択用)
 *     calendarLoadAppointments(dateFrom, dateTo, cb)
 *           指定範囲の予約のみ取得 (pendingCreate と cancelled/no_show は除外)
 *     calendarLoadCloseBlocks(dateFrom, dateTo, cb)
 *           指定範囲の closeBlocks のみ取得
 *
 *   ── 営業日/営業時間判定 ──
 *     calendarIsBusinessDay(dateKey, settings)
 *           その日が営業日か (closedDows と照合)
 *     calendarGetBusinessHours(dateKey, settings)
 *           その日の営業時間 (openTime/closeTime と weeklyClose の該当分)
 *     calendarGetWeekClosesForDay(dow, settings)
 *           その曜日の weeklyClose リスト
 *
 *   ── 週間グリッド生成 ──
 *     calendarBuildWeekGrid(weekStartDate, settings, appointments, closeBlocks)
 *           週間ビューの描画用データ構造を返す:
 *           {
 *             hours: [10, 11, 12, ...],      // 時刻ラベル
 *             dayStart: 10,                   // 開始時刻 (時)
 *             days: [
 *               { date: Date, dateKey: "2026-05-15", dow: 5, isBusiness: true,
 *                 isToday: false, appointments: [...], closeBlocks: [...],
 *                 weeklyCloses: [...] },
 *               ... (7日分)
 *             ]
 *           }
 *
 *   ── ヘルパー ──
 *     calendarFormatDateKey(date)         Date → "YYYY-MM-DD"
 *     calendarParseDateKey(dateKey)       "YYYY-MM-DD" → Date
 *     calendarGetWeekStartDate(date)      その日を含む週の月曜日 (旧画面は日曜始まりだが
 *                                          フェーズ1は柔軟性のため引数の date を週頭にする)
 *     calendarShouldDisplay(appt)         予約をカレンダーに表示するか (pendingCreate判定)
 *
 * ES5 互換:
 *   - var / function / Promise.then のみ
 *   - const / let / アロー関数 / async-await / テンプレートリテラル / ?. 禁止
 */

(function () {

  // ============================================================
  // 内部ヘルパー
  // ============================================================

  function _safeCb(cb, value) {
    if (typeof cb === 'function') {
      try {
        cb(value);
      } catch (e) {
        console.error('[calendar] cb error', e);
      }
    }
  }

  function _pad2(n) {
    return (n < 10) ? ('0' + n) : ('' + n);
  }

  function _checkSharedDb() {
    if (typeof window.dbReadCollection !== 'function' ||
        typeof window.dbSalonGetConfig !== 'function' ||
        typeof window.getCurrentSalonId !== 'function') {
      console.error('[calendar] shared_db.js が先にロードされていません');
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
  // 日付ヘルパー (公開)
  // ============================================================

  // Date → "YYYY-MM-DD"
  function calendarFormatDateKey(date) {
    if (!(date instanceof Date)) {
      return null;
    }
    return date.getFullYear() + '-' +
           _pad2(date.getMonth() + 1) + '-' +
           _pad2(date.getDate());
  }
  window.calendarFormatDateKey = calendarFormatDateKey;

  // "YYYY-MM-DD" → Date (その日の 00:00:00)
  function calendarParseDateKey(dateKey) {
    if (typeof dateKey !== 'string' ||
        !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(dateKey)) {
      return null;
    }
    var p = dateKey.split('-');
    return new Date(
      parseInt(p[0], 10),
      parseInt(p[1], 10) - 1,
      parseInt(p[2], 10),
      0, 0, 0, 0
    );
  }
  window.calendarParseDateKey = calendarParseDateKey;

  // 週頭の Date を返す (引数の日付の 00:00:00 に丸めるだけ)
  // 注: 旧画面は「指定日を週の開始日とする」方式 (日曜始まりや月曜始まりに
  //     縛らない)。画面側で「今日を起点に7日」を表示するか「日曜始まり」を
  //     表示するかを決める。
  function calendarGetWeekStartDate(date) {
    if (!(date instanceof Date)) {
      return null;
    }
    var d = new Date(date.getTime());
    d.setHours(0, 0, 0, 0);
    return d;
  }
  window.calendarGetWeekStartDate = calendarGetWeekStartDate;

  // 予約をカレンダーに表示するか判定
  // 設計書 600 行: pendingCreate: true の予約は表示しない
  function calendarShouldDisplay(appt) {
    if (!appt) { return false; }
    // pendingCreate は false/undefined のみ表示
    if (appt.pendingCreate === true) { return false; }
    return true;
  }
  window.calendarShouldDisplay = calendarShouldDisplay;

  // ============================================================
  // 営業日・営業時間判定
  // ============================================================

  // その日が営業日か (closedDows と照合)
  // settings.closedDows: [0, 2] のような曜日番号配列 (0=日, 6=土)
  function calendarIsBusinessDay(dateKey, settings) {
    if (!settings) { return true; }  // 設定なしは営業扱い
    var d = calendarParseDateKey(dateKey);
    if (!d) { return true; }
    var dow = d.getDay();
    var closedDows = settings.closedDows || [];
    var i;
    for (i = 0; i < closedDows.length; i++) {
      if (closedDows[i] === dow) {
        return false;
      }
    }
    return true;
  }
  window.calendarIsBusinessDay = calendarIsBusinessDay;

  // その日の営業時間を返す
  // 戻り値: { openTime: "10:00", closeTime: "19:00", isOpen: true,
  //          weeklyCloses: [{start:"12:00", end:"13:00"}, ...] }
  //         isOpen: false (定休日)
  function calendarGetBusinessHours(dateKey, settings) {
    var result = {
      openTime: settings ? (settings.openTime || '10:00') : '10:00',
      closeTime: settings ? (settings.closeTime || '19:00') : '19:00',
      isOpen: calendarIsBusinessDay(dateKey, settings),
      weeklyCloses: []
    };
    if (!result.isOpen) {
      return result;
    }
    if (!settings || !settings.weeklyClose) {
      return result;
    }
    var d = calendarParseDateKey(dateKey);
    if (!d) {
      return result;
    }
    var dow = d.getDay();
    var i;
    for (i = 0; i < settings.weeklyClose.length; i++) {
      var wc = settings.weeklyClose[i];
      if (wc && wc.dow === dow) {
        result.weeklyCloses.push({
          start: wc.start,
          end: wc.end
        });
      }
    }
    return result;
  }
  window.calendarGetBusinessHours = calendarGetBusinessHours;

  // 指定曜日の weeklyClose リストを返す (UI が事前に曜日ごとにまとめたい場合)
  function calendarGetWeekClosesForDay(dow, settings) {
    var out = [];
    if (!settings || !settings.weeklyClose) {
      return out;
    }
    var i;
    for (i = 0; i < settings.weeklyClose.length; i++) {
      var wc = settings.weeklyClose[i];
      if (wc && wc.dow === dow) {
        out.push({ start: wc.start, end: wc.end });
      }
    }
    return out;
  }
  window.calendarGetWeekClosesForDay = calendarGetWeekClosesForDay;

  // ============================================================
  // データ取得
  // ============================================================

  // 指定範囲の予約を取得
  // pendingCreate: true / cancelled / no_show は除外
  // 注: Firestore のクエリでは「false / undefined / 存在しない」を1回で表現できないので、
  //     pendingCreate と status はクライアント側でフィルタする。
  //     dateKey の範囲はインデックスで効くので、最初の絞り込みはサーバ側。
  function calendarLoadAppointments(dateFrom, dateTo, cb) {
    if (!_checkSharedDb()) { _safeCb(cb, null); return; }
    var sp = _salonPath();
    if (!sp) { _safeCb(cb, null); return; }
    if (!dateFrom || !dateTo) {
      _safeCb(cb, null);
      return;
    }

    window.dbReadCollection(sp + '/appointments', function (col) {
      return col.where('dateKey', '>=', dateFrom)
                .where('dateKey', '<=', dateTo);
    }, function (arr) {
      if (!arr) {
        _safeCb(cb, null);
        return;
      }
      // クライアント側フィルタ
      var filtered = [];
      var i;
      for (i = 0; i < arr.length; i++) {
        var a = arr[i];
        // pendingCreate を除外
        if (!calendarShouldDisplay(a)) { continue; }
        // cancelled / no_show を除外 (表示しないステータス)
        if (a.status === 'cancelled' || a.status === 'no_show') { continue; }
        filtered.push(a);
      }
      // start 昇順でソート
      filtered.sort(function (a, b) {
        if (a.dateKey !== b.dateKey) {
          return (a.dateKey < b.dateKey) ? -1 : 1;
        }
        var as = a.start || '';
        var bs = b.start || '';
        if (as !== bs) {
          return (as < bs) ? -1 : 1;
        }
        return 0;
      });
      _safeCb(cb, filtered);
    });
  }
  window.calendarLoadAppointments = calendarLoadAppointments;

  // 指定範囲の closeBlocks を取得
  // closeBlocks のスキーマ (DESIGN.md 0-2 と1対1):
  //   { dateKey: "YYYY-MM-DD", start: "HH:MM", end: "HH:MM", reason, createdAt }
  // ★ 2026/5/23 修正: 旧版で "date" だったフィールド名を v8.1 仕様に合わせて
  //   "dateKey" に変更。書き込み(dbSalonCreateCloseBlock)と読み取りの整合を取る。
  function calendarLoadCloseBlocks(dateFrom, dateTo, cb) {
    if (!_checkSharedDb()) { _safeCb(cb, null); return; }
    var sp = _salonPath();
    if (!sp) { _safeCb(cb, null); return; }
    if (!dateFrom || !dateTo) {
      _safeCb(cb, null);
      return;
    }

    window.dbReadCollection(sp + '/closeBlocks', function (col) {
      return col.where('dateKey', '>=', dateFrom)
                .where('dateKey', '<=', dateTo);
    }, function (arr) {
      if (!arr) {
        _safeCb(cb, null);
        return;
      }
      // dateKey 昇順 + start 昇順でソート
      arr.sort(function (a, b) {
        var ad = a.dateKey || '';
        var bd = b.dateKey || '';
        if (ad !== bd) { return (ad < bd) ? -1 : 1; }
        var as = a.start || '';
        var bs = b.start || '';
        if (as !== bs) { return (as < bs) ? -1 : 1; }
        return 0;
      });
      _safeCb(cb, arr);
    });
  }
  window.calendarLoadCloseBlocks = calendarLoadCloseBlocks;

  // 週間ビュー用データ一括取得
  // 週頭の Date から 7日分を取る
  // 並列取得: settings + menus + appointments + closeBlocks
  //   注: shared_db.js には Promise.all 相当の並列取得が組み込まれていないので、
  //       コールバックを4つ揃えてから次に進む方式 (簡易並列)。
  function calendarLoadWeek(weekStartDate, cb) {
    if (!_checkSharedDb()) {
      _safeCb(cb, null);
      return;
    }
    if (!(weekStartDate instanceof Date)) {
      _safeCb(cb, null);
      return;
    }
    var sp = _salonPath();
    if (!sp) { _safeCb(cb, null); return; }

    var start = calendarGetWeekStartDate(weekStartDate);
    var end = new Date(start.getTime());
    end.setDate(end.getDate() + 6);
    var dateFrom = calendarFormatDateKey(start);
    var dateTo = calendarFormatDateKey(end);

    var bundle = {
      settings: null,
      menus: null,
      appointments: null,
      closeBlocks: null,
      weekStart: start,
      dateFrom: dateFrom,
      dateTo: dateTo
    };
    var pending = 4;

    function _done() {
      pending--;
      if (pending <= 0) {
        _safeCb(cb, bundle);
      }
    }

    // 1. settings
    window.dbSalonGetConfig('settings', function (s) {
      bundle.settings = s || null;
      _done();
    });

    // 2. menus (公開・非公開含めて全取得、type 区別もそのまま渡す)
    //    menuList が shared_db_menu.js で公開されているのでそれを使う
    if (typeof window.menuList === 'function') {
      window.menuList(null, function (arr) {
        bundle.menus = arr || [];
        _done();
      });
    } else {
      // フォールバック: shared_db_menu.js がない場合は直接 collection 読み
      window.dbReadCollection(sp + '/menus', null, function (arr) {
        bundle.menus = arr || [];
        _done();
      });
    }

    // 3. appointments (7日分)
    calendarLoadAppointments(dateFrom, dateTo, function (arr) {
      bundle.appointments = arr || [];
      _done();
    });

    // 4. closeBlocks (7日分)
    calendarLoadCloseBlocks(dateFrom, dateTo, function (arr) {
      bundle.closeBlocks = arr || [];
      _done();
    });
  }
  window.calendarLoadWeek = calendarLoadWeek;

  // 月別データ一括取得 (Phase B-1 dbLoadSalonCalendar の準備)
  // monthStr: "2026-05" 形式
  function calendarLoadMonth(monthStr, cb) {
    if (typeof monthStr !== 'string' ||
        !/^[0-9]{4}-[0-9]{2}$/.test(monthStr)) {
      _safeCb(cb, null);
      return;
    }
    if (!_checkSharedDb()) {
      _safeCb(cb, null);
      return;
    }
    var sp = _salonPath();
    if (!sp) { _safeCb(cb, null); return; }

    // 月の1日〜末日
    var p = monthStr.split('-');
    var year = parseInt(p[0], 10);
    var month = parseInt(p[1], 10) - 1; // 0-indexed
    var firstDay = new Date(year, month, 1, 0, 0, 0, 0);
    var lastDay = new Date(year, month + 1, 0, 0, 0, 0, 0); // 翌月0日 = 当月末日
    var dateFrom = calendarFormatDateKey(firstDay);
    var dateTo = calendarFormatDateKey(lastDay);

    var bundle = {
      settings: null,
      menus: null,
      appointments: null,
      closeBlocks: null,
      monthStr: monthStr,
      dateFrom: dateFrom,
      dateTo: dateTo
    };
    var pending = 4;

    function _done() {
      pending--;
      if (pending <= 0) {
        _safeCb(cb, bundle);
      }
    }

    window.dbSalonGetConfig('settings', function (s) {
      bundle.settings = s || null;
      _done();
    });

    if (typeof window.menuList === 'function') {
      window.menuList(null, function (arr) {
        bundle.menus = arr || [];
        _done();
      });
    } else {
      window.dbReadCollection(sp + '/menus', null, function (arr) {
        bundle.menus = arr || [];
        _done();
      });
    }

    calendarLoadAppointments(dateFrom, dateTo, function (arr) {
      bundle.appointments = arr || [];
      _done();
    });

    calendarLoadCloseBlocks(dateFrom, dateTo, function (arr) {
      bundle.closeBlocks = arr || [];
      _done();
    });
  }
  window.calendarLoadMonth = calendarLoadMonth;

  // 1日分のデータ取得 (顧客アプリの予約日時選択用)
  function calendarLoadDay(dateKey, cb) {
    if (typeof dateKey !== 'string' ||
        !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(dateKey)) {
      _safeCb(cb, null);
      return;
    }
    if (!_checkSharedDb()) {
      _safeCb(cb, null);
      return;
    }

    var bundle = {
      settings: null,
      appointments: null,
      closeBlocks: null,
      dateKey: dateKey
    };
    var pending = 3;

    function _done() {
      pending--;
      if (pending <= 0) {
        _safeCb(cb, bundle);
      }
    }

    window.dbSalonGetConfig('settings', function (s) {
      bundle.settings = s || null;
      _done();
    });

    calendarLoadAppointments(dateKey, dateKey, function (arr) {
      bundle.appointments = arr || [];
      _done();
    });

    calendarLoadCloseBlocks(dateKey, dateKey, function (arr) {
      bundle.closeBlocks = arr || [];
      _done();
    });
  }
  window.calendarLoadDay = calendarLoadDay;

  // ============================================================
  // 週間グリッド生成
  //
  // 入力: weekStartDate (Date), settings, appointments, closeBlocks
  // 出力: 週間ビューの描画用データ
  //   {
  //     hours: [10, 11, 12, ..., 18],     // 時刻ラベル (営業時間内)
  //     dayStart: 10,                      // 開始時刻 (時)
  //     dayEnd: 19,                        // 終了時刻 (時、表示するが予約は入らない)
  //     today: "2026-05-15",               // 今日の dateKey
  //     days: [
  //       {
  //         date: Date,
  //         dateKey: "2026-05-15",
  //         dow: 5,
  //         dowLabel: "金",
  //         isBusiness: true,              // 営業日か (closedDows と照合)
  //         isToday: false,
  //         appointments: [{appt+startHours+heightHours}, ...],
  //         closeBlocks: [{cb+startHours+heightHours}, ...],
  //         weeklyCloses: [{wc+startHours+heightHours}, ...],
  //         intervals: [{appt+intervalAfterMin+startHours+heightHours}, ...]
  //       },
  //       ... (7日分)
  //     ]
  //   }
  //
  // 注: 旧画面と同じく、appointments の後にインターバル枠を別オブジェクトで
  //     生成する。インターバル長は intervalAfterOverride > メニューの
  //     intervalAfter > settings.intervalMin の優先順位で決まる。
  //     ただしこのファイルではメニューや settings を引数で持つわけではないので、
  //     インターバル長は appointment.intervalAfterOverride のみ参照する。
  //     メニュー由来は menus を引いて判定するため、画面側で intervalAfterOverride
  //     を予約に明示的にセットする運用が必要 (旧画面はそうしていた)。
  // ============================================================

  var DOW_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

  function _hhmmToHours(hhmm) {
    if (typeof hhmm !== 'string') { return null; }
    var p = hhmm.split(':');
    if (p.length !== 2) { return null; }
    var h = parseInt(p[0], 10);
    var m = parseInt(p[1], 10);
    if (isNaN(h) || isNaN(m)) { return null; }
    return h + m / 60;
  }

  function calendarBuildWeekGrid(weekStartDate, settings, appointments, closeBlocks) {
    if (!(weekStartDate instanceof Date)) {
      return null;
    }

    // 営業時間の時刻軸を作る
    var openTime = (settings && settings.openTime) ? settings.openTime : '10:00';
    var closeTime = (settings && settings.closeTime) ? settings.closeTime : '19:00';
    var openH = parseInt(openTime.split(':')[0], 10);
    var closeH = parseInt(closeTime.split(':')[0], 10);
    var closeM = parseInt(closeTime.split(':')[1], 10);
    // 閉店時刻が 19:30 など分単位なら、20時まで枠を出す
    var dayEnd = (closeM > 0) ? (closeH + 1) : closeH;
    var hours = [];
    var h;
    for (h = openH; h < dayEnd; h++) {
      hours.push(h);
    }

    var todayKey = calendarFormatDateKey(new Date());

    var days = [];
    var i;
    for (i = 0; i < 7; i++) {
      var d = new Date(weekStartDate.getTime());
      d.setDate(weekStartDate.getDate() + i);
      var dateKey = calendarFormatDateKey(d);
      var dow = d.getDay();

      var isBusiness = calendarIsBusinessDay(dateKey, settings);
      var isToday = (dateKey === todayKey);

      var dayAppts = [];
      var dayCBs = [];
      var dayIntervals = [];
      var dayWeekly = [];

      // この日の appointments
      if (appointments) {
        var j;
        for (j = 0; j < appointments.length; j++) {
          var a = appointments[j];
          if (!a || a.dateKey !== dateKey) { continue; }
          if (!calendarShouldDisplay(a)) { continue; }
          if (a.status === 'cancelled' || a.status === 'no_show') { continue; }

          var startH = _hhmmToHours(a.start);
          if (startH === null) { continue; }

          // end があれば end-start、なければ durationMin から計算
          var endH = null;
          if (a.end) {
            endH = _hhmmToHours(a.end);
          }
          if (endH === null && typeof a.durationMin === 'number') {
            endH = startH + a.durationMin / 60;
          }
          if (endH === null) {
            // フォールバック: 60分
            endH = startH + 1;
          }

          dayAppts.push({
            ref: a,
            startHours: startH,
            endHours: endH,
            heightHours: endH - startH
          });

          // インターバル枠 (intervalAfterOverride のみ参照、メニュー由来は画面側で
          // 事前に intervalAfterOverride に展開しておく必要がある)
          var iv = (typeof a.intervalAfterOverride === 'number') ?
                   a.intervalAfterOverride : 0;
          if (iv > 0) {
            dayIntervals.push({
              ref: a,
              startHours: endH,
              endHours: endH + iv / 60,
              heightHours: iv / 60,
              intervalMin: iv
            });
          }
        }
      }

      // この日の closeBlocks
      if (closeBlocks) {
        var k;
        for (k = 0; k < closeBlocks.length; k++) {
          var c = closeBlocks[k];
          // ★ 2026/5/23 修正: c.date → c.dateKey (v8.1 統一漏れ最後の1個)
          if (!c || c.dateKey !== dateKey) { continue; }
          var cStartH = _hhmmToHours(c.start);
          var cEndH = _hhmmToHours(c.end);
          if (cStartH === null || cEndH === null) { continue; }
          dayCBs.push({
            ref: c,
            startHours: cStartH,
            endHours: cEndH,
            heightHours: cEndH - cStartH
          });
        }
      }

      // この日の weeklyClose
      var weekClosesRaw = calendarGetWeekClosesForDay(dow, settings);
      var w;
      for (w = 0; w < weekClosesRaw.length; w++) {
        var wc = weekClosesRaw[w];
        var wcStartH = _hhmmToHours(wc.start);
        var wcEndH = _hhmmToHours(wc.end);
        if (wcStartH === null || wcEndH === null) { continue; }
        dayWeekly.push({
          ref: wc,
          startHours: wcStartH,
          endHours: wcEndH,
          heightHours: wcEndH - wcStartH
        });
      }

      days.push({
        date: d,
        dateKey: dateKey,
        dow: dow,
        dowLabel: DOW_LABELS[dow],
        isBusiness: isBusiness,
        isToday: isToday,
        appointments: dayAppts,
        intervals: dayIntervals,
        closeBlocks: dayCBs,
        weeklyCloses: dayWeekly
      });
    }

    return {
      hours: hours,
      dayStart: openH,
      dayEnd: dayEnd,
      today: todayKey,
      days: days
    };
  }
  window.calendarBuildWeekGrid = calendarBuildWeekGrid;

  // ============================================================
  // デバッグ用
  // ============================================================

  window._calendarDebug = {
    DOW_LABELS: DOW_LABELS,
    hhmmToHours: _hhmmToHours
  };

  console.log('[calendar] loaded.');

})();
