/*
 * shared_notify.js  -  TORITA Phase A-step2 / A-7
 * 作成: 2026/5/16
 *
 * 役割:
 *   通知統一層。予約・キャンセル・変更の各タイミングで、顧客の
 *   notifyChannels 設定に応じてメール / LINE を振り分けて送る。
 *   各画面はこのファイルの 3 関数を呼ぶだけでよい。
 *
 * 設計準拠:
 *   - DESIGN.md v6 セクション 6 (通知の設計), Phase A-7, Phase E-1/E-5
 *     * 6-1: 販売版は Cloud Functions sendBookingEmail を使用
 *            (送信元 noreply@torita-app.com、表示名はサロン名)
 *     * 6-2-3: 統一API
 *            sendBookingNotification(customerId, appointment, cb)
 *            sendCancelNotification(customerId, appointment, cb)
 *            sendChangeNotification(customerId, oldAppt, newAppt, cb)
 *     * 6-2-6: フェーズ1 はメールのみ。LINE 分岐はスケルトンだけ。
 *     * 6-3: 失敗時 notificationLogs/{logId} に記録
 *   - DESIGN_NOTES.md には A-7 固有の補足記述なし
 *
 * 主要な設計判断 (2026/5/16):
 *   - 旧 v8 系の棚卸し結果に基づく:
 *       * 旧 customer_app_v8 は EmailJS と Cloud Functions を「並走」
 *         させていた。しかし設計書の移行ゴール (E-3 EmailJS 呼び出し
 *         完全削除 / E-4 アカウント解約) と「ゼロから作り直し」方針に
 *         従い、新 v2 系は最初から Cloud Functions 単独 とする。
 *         EmailJS を新規実装すると E フェーズで再削除する二度手間かつ
 *         設計書 6-1「販売版は Cloud Functions を使用」に反するため。
 *       * 旧 sendEmailViaFunctions の fetch + Bearer トークン方式
 *         (getIdToken → Authorization: Bearer) はそのまま踏襲。
 *       * 旧 buildEmailHtml の本文 HTML 構造・テーマ色 (#b5845a 等) を
 *         踏襲しつつ、予約オブジェクト (dateKey/start/menuName/
 *         priceSnapshot) から組み立てる形に作り直し。
 *   - LINE は 6-2-6 厳守: _sendViaLine() はスケルトン (no-op + ログ)。
 *     notifyChannels.line を見る分岐は今から書くが、中身は呼ばない。
 *   - 顧客の通知設定は customers ドキュメントの notifyChannels を見る。
 *     呼び出し元 (サロン管理画面 / 顧客アプリ) のどちらからでも
 *     使えるよう、customerId から顧客 doc を引く。
 *   - notificationLogs (6-3 / E-5) は本実装が Phase E だが、A-7 では
 *     失敗フック _logNotificationFailure を用意し最小記録のみ行う
 *     (設計書「箱は最初から」方針に合わせる)。Firestore 書き込みは
 *     shared_db.js の dbAddDoc を使い、失敗しても通知処理は止めない。
 *
 * ES5 互換:
 *   - var / function / Promise.then のみ
 *   - const / let / アロー関数 / async-await / テンプレートリテラル / ?. は全て禁止
 *
 * コールバック規約:
 *   - 全 3 関数 cb(result) 形式
 *   - result = { ok: true, channels: ['email', ...] }  成功
 *   - result = { ok: false, error: '理由' }             失敗
 *   - cb は任意 (省略可)
 *
 * 依存:
 *   - shared_db.js   : dbSalonGetCustomer / dbCustomerGetMyProfile /
 *                      dbCustomerGetSalonInfo / dbSalonGetInfo /
 *                      dbAddDoc / getCurrentSalonId / getCurrentUserUid
 *   - shared_auth.js : authGetCurrentUser (Bearer トークン取得用)
 *   いずれも本ファイルより先に読み込まれている前提。
 */

(function () {

  // ============================================================
  // 定数
  // ============================================================
  //
  // Cloud Functions メール送信エンドポイント
  // (メモリ #11 / functions/index.js exports.sendBookingEmail と一致)

  var FUNCTIONS_SEND_EMAIL_URL =
    'https://sendbookingemail-zycy3wf6ba-an.a.run.app';

  // 通知タイプのラベル (件名・本文見出しに使用。旧 v8 系と同一表現)
  var TYPE_BOOKING = 'ご予約';
  var TYPE_CANCEL = 'キャンセル';
  var TYPE_CHANGE = '変更';

  // ============================================================
  // 内部ユーティリティ
  // ============================================================

  function _safeCb(cb, result) {
    if (typeof cb === 'function') {
      try { cb(result); } catch (e) {
        console.error('[shared_notify] callback error:', e);
      }
    }
  }

  function _ok(channels) {
    return { ok: true, channels: channels || [] };
  }

  function _err(message) {
    return { ok: false, error: message || 'unknown' };
  }

  // HTML エスケープ (本文に名前等を埋め込む際の保険。旧実装踏襲)
  function _escapeHtml(s) {
    if (s == null) { return ''; }
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // "2026-05-14" -> "5月14日（水）"
  var _DOWS = ['日', '月', '火', '水', '木', '金', '土'];
  function _toDateLabel(dateKey) {
    if (!dateKey || typeof dateKey !== 'string') { return ''; }
    var p = dateKey.split('-');
    if (p.length !== 3) { return dateKey; }
    var d = new Date(
      parseInt(p[0], 10),
      parseInt(p[1], 10) - 1,
      parseInt(p[2], 10)
    );
    var dow = _DOWS[d.getDay()];
    return parseInt(p[1], 10) + '月'
         + parseInt(p[2], 10) + '日（' + dow + '）';
  }

  // 予約オブジェクトからメニュー表示名を取り出す
  //   優先: appointment.menuName (A-2 で予約docに残す設計)
  //   なければ menuId をそのまま (名前解決は呼び出し元の責務)
  function _menuLabel(appt) {
    if (!appt) { return ''; }
    if (appt.menuName) { return String(appt.menuName); }
    if (appt.menuId) { return String(appt.menuId); }
    return '';
  }

  // 金額を "¥12,000" 形式に
  function _yen(n) {
    if (typeof n !== 'number' || !isFinite(n)) { return ''; }
    return '¥' + n.toLocaleString();
  }

  // ============================================================
  // メール本文 HTML 生成 (旧 buildEmailHtml の構造・テーマ色を踏襲)
  // ============================================================
  //
  // type        : TYPE_BOOKING / TYPE_CANCEL / TYPE_CHANGE
  // salonName   : サロン表示名
  // customerName: 顧客名
  // dateLabel   : "5月14日（水）"
  // timeStr     : "10:00"
  // menuName    : メニュー名
  // extraInfo   : 任意の補足ブロック (変更前情報・キャンセル料など)
  // priceSnap   : 任意。数値なら金額行を出す

  function _buildEmailHtml(type, salonName, customerName,
                           dateLabel, timeStr, menuName,
                           extraInfo, priceSnap) {
    var heading =
        (type === TYPE_BOOKING) ? 'ご予約ありがとうございます'
      : (type === TYPE_CANCEL)  ? 'ご予約のキャンセルを承りました'
      : (type === TYPE_CHANGE)  ? 'ご予約の変更を承りました'
      :                           'ご予約について';

    var html = ''
      + '<div style="font-family:sans-serif;color:#1a1a18;'
      +   'line-height:1.7;max-width:560px;">'
      + '<h2 style="color:#b5845a;font-size:18px;'
      +   'margin-bottom:16px;">' + _escapeHtml(heading) + '</h2>'
      + '<p>' + _escapeHtml(customerName) + ' 様</p>'
      + '<p>このたびは ' + _escapeHtml(salonName)
      +   ' をご利用いただき、ありがとうございます。<br>'
      + '以下の内容で承りました。</p>'
      + '<div style="background:#f5ede4;border-radius:10px;'
      +   'padding:14px 18px;margin:14px 0;">'
      + '<div><strong>日時:</strong> '
      +   _escapeHtml(dateLabel) + ' ' + _escapeHtml(timeStr) + '〜</div>'
      + '<div><strong>メニュー:</strong> '
      +   _escapeHtml(menuName) + '</div>';

    if (typeof priceSnap === 'number' && priceSnap > 0) {
      html += '<div><strong>料金:</strong> '
            + _escapeHtml(_yen(priceSnap)) + '</div>';
    }
    html += '</div>';

    if (extraInfo) {
      html += '<div style="background:#faeaea;border-radius:10px;'
            +   'padding:12px 16px;margin:12px 0;'
            +   'white-space:pre-wrap;">'
            +   _escapeHtml(extraInfo) + '</div>';
    }

    html += '<p style="font-size:12px;color:#73726c;'
         +    'margin-top:24px;">— ' + _escapeHtml(salonName) + '</p>'
         + '</div>';
    return html;
  }

  // ============================================================
  // notificationLogs 失敗記録 (6-3 / E-5。A-7 は最小フックのみ)
  // ============================================================
  //
  // 通知が失敗しても通知処理自体は止めない。記録の失敗も握り潰す
  // (記録のために通知フローを壊さない)。本格運用は Phase E-5。

  function _logNotificationFailure(customerId, type, channel, reason) {
    try {
      if (typeof window.dbAddDoc !== 'function'
          || typeof window.getCurrentSalonId !== 'function') {
        return;
      }
      var sid = window.getCurrentSalonId();
      if (!sid) { return; }
      window.dbAddDoc(
        'salons/' + sid + '/notificationLogs',
        {
          customerId: (customerId == null) ? '' : String(customerId),
          type: String(type || ''),
          channel: String(channel || ''),
          reason: String(reason || ''),
          createdAtClient: new Date().toISOString(),
          ok: false
        },
        function () { /* 記録の成否は問わない */ }
      );
    } catch (e) {
      console.warn('[shared_notify] log failure skipped:', e);
    }
  }

  // ============================================================
  // 顧客プロフィール解決 (呼び出し元がサロン / 顧客どちらでも動く)
  // ============================================================
  //
  // customerId が現在ログイン中の顧客自身なら dbCustomerGetMyProfile、
  // それ以外 (サロン管理画面が他顧客に送る等) は dbSalonGetCustomer。
  // どちらも shared_db.js の API。戻り doc に notifyChannels / name /
  // email が含まれる前提 (A-1 で確定したスキーマ)。

  function _resolveCustomer(customerId, cb) {
    var myUid = (typeof window.getCurrentUserUid === 'function')
                ? window.getCurrentUserUid() : null;

    function _normalize(doc) {
      if (!doc) { _safeCb(cb, null); return; }
      var nc = (doc.notifyChannels && typeof doc.notifyChannels === 'object')
               ? doc.notifyChannels : {};
      _safeCb(cb, {
        id: customerId,
        name: doc.name || '',
        email: doc.email || '',
        notifyEmail: (nc.email !== false),   // 既定 ON
        notifyLine: (nc.line === true),      // 既定 OFF
        lineUserId: doc.lineUserId || null
      });
    }

    if (myUid && customerId && myUid === customerId
        && typeof window.dbCustomerGetMyProfile === 'function') {
      window.dbCustomerGetMyProfile(_normalize);
      return;
    }
    if (typeof window.dbSalonGetCustomer === 'function') {
      window.dbSalonGetCustomer(customerId, _normalize);
      return;
    }
    // どちらの API も無い (依存未ロード)
    _safeCb(cb, null);
  }

  // ============================================================
  // サロン表示名の解決
  // ============================================================
  //
  // 顧客アプリからは dbCustomerGetSalonInfo、サロン管理画面からは
  // dbSalonGetInfo。どちらも salons/{salonId} doc を返す。name を採用。

  function _resolveSalonName(cb) {
    function _pick(doc) {
      var nm = (doc && doc.name) ? String(doc.name) : 'サロン';
      _safeCb(cb, nm);
    }
    var myUid = (typeof window.getCurrentUserUid === 'function')
                ? window.getCurrentUserUid() : null;
    var sid = (typeof window.getCurrentSalonId === 'function')
              ? window.getCurrentSalonId() : null;

    // サロン本人がログインしている (uid == salonId) なら salon 側 API
    if (myUid && sid && myUid === sid
        && typeof window.dbSalonGetInfo === 'function') {
      window.dbSalonGetInfo(_pick);
      return;
    }
    if (typeof window.dbCustomerGetSalonInfo === 'function') {
      window.dbCustomerGetSalonInfo(_pick);
      return;
    }
    if (typeof window.dbSalonGetInfo === 'function') {
      window.dbSalonGetInfo(_pick);
      return;
    }
    _safeCb(cb, 'サロン');
  }

  // ============================================================
  // メール送信 (Cloud Functions 経由。旧 sendEmailViaFunctions 踏襲)
  // ============================================================
  //
  // Functions 契約 (functions/index.js exports.sendBookingEmail):
  //   req  : { to, subject, html, salonName }  + Authorization: Bearer
  //   res  : { success: true, messageId } | { success: false, error }

  function _sendViaEmail(toEmail, subject, html, salonName, cb) {
    if (!toEmail) {
      _safeCb(cb, _err('no-email'));
      return;
    }
    if (typeof window.authGetCurrentUser !== 'function') {
      _safeCb(cb, _err('auth-unavailable'));
      return;
    }
    var user = window.authGetCurrentUser();
    if (!user || typeof user.getIdToken !== 'function') {
      _safeCb(cb, _err('not-signed-in'));
      return;
    }

    user.getIdToken().then(function (idToken) {
      return fetch(FUNCTIONS_SEND_EMAIL_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + idToken
        },
        body: JSON.stringify({
          to: toEmail,
          subject: subject,
          html: html,
          salonName: salonName
        })
      });
    }).then(function (res) {
      if (!res) {
        _safeCb(cb, _err('no-response'));
        return null;
      }
      return res.json().then(function (data) {
        if (res.ok && data && data.success) {
          _safeCb(cb, _ok(['email']));
        } else {
          var reason = (data && data.error)
                       ? data.error : ('http-' + res.status);
          _safeCb(cb, _err(reason));
        }
      });
    }).catch(function (e) {
      var msg = (e && e.message) ? e.message : String(e);
      _safeCb(cb, _err(msg));
    });
  }

  // ============================================================
  // LINE 送信 (フェーズ1: スケルトンのみ。6-2-6 厳守)
  // ============================================================
  //
  // 設計書 6-2-6:
  //   「shared_notify.js の sendBookingNotification は実装するが、
  //     内部では LINE 分岐をスキップしてメールだけ送る。
  //     LINE Function はまだ作らない」
  //
  // よってこの関数は呼び出し経路だけ用意し、本体は no-op。
  // Phase H で sendBookingLine Function 実装時に中身を書く。
  // (引数シグネチャは 6-2-4: lineUserId, salonName, messageType, data)

  function _sendViaLine(lineUserId, salonName, messageType, data, cb) {
    // フェーズ1ではここに到達しても何もしない (設計書 6-2-6)。
    // Phase H で LINE Messaging API push message を実装する。
    console.log('[shared_notify] LINE skipped (phase1 skeleton):',
                messageType);
    _safeCb(cb, _err('line-not-implemented-phase1'));
  }

  // ============================================================
  // 共通ディスパッチ: 顧客設定を見てメール / LINE に振り分け
  // ============================================================
  //
  // フェーズ1 の確定挙動:
  //   - notifyEmail が ON なら メール送信
  //   - notifyLine が ON でも _sendViaLine はスケルトンなので
  //     実質メールのみ (設計書 6-2-6 準拠)
  //   - 両方 OFF / 顧客取得失敗 は「送信対象なし」として ok 扱い
  //     (通知が無くても予約処理自体は成功しているため、
  //      呼び出し元のフローを止めない)

  function _dispatch(customerId, type, subject, html, cb) {
    _resolveCustomer(customerId, function (cust) {
      if (!cust) {
        // 顧客が引けない = 通知できないが、致命ではない
        _logNotificationFailure(customerId, type, 'resolve',
                                'customer-not-found');
        _safeCb(cb, _err('customer-not-found'));
        return;
      }

      _resolveSalonName(function (salonName) {
        var sentChannels = [];
        var pending = 0;
        var settled = false;

        function _finish() {
          if (settled) { return; }
          settled = true;
          if (sentChannels.length > 0) {
            _safeCb(cb, _ok(sentChannels));
          } else {
            _safeCb(cb, _err('no-channel-succeeded'));
          }
        }

        // --- メール ---
        if (cust.notifyEmail && cust.email) {
          pending++;
          _sendViaEmail(cust.email, subject, html, salonName,
            function (r) {
              if (r && r.ok) {
                sentChannels.push('email');
              } else {
                _logNotificationFailure(
                  customerId, type, 'email',
                  (r && r.error) ? r.error : 'unknown'
                );
              }
              pending--;
              if (pending <= 0) { _finish(); }
            });
        }

        // --- LINE (フェーズ1: スケルトン。呼んでも no-op) ---
        if (cust.notifyLine && cust.lineUserId) {
          pending++;
          _sendViaLine(cust.lineUserId, salonName, type, null,
            function (r) {
              if (r && r.ok) {
                sentChannels.push('line');
              }
              // フェーズ1 では line 失敗をログしない
              // (未実装が既定動作であり「失敗」ではないため)
              pending--;
              if (pending <= 0) { _finish(); }
            });
        }

        // 送信対象チャネルが1つも無い場合
        if (pending === 0) {
          // 通知先未設定。予約自体は成功しているので ok 扱い。
          _safeCb(cb, _ok([]));
        }
      });
    });
  }

  // ============================================================
  // 公開 API (設計書 6-2-3 のシグネチャに準拠)
  // ============================================================

  // 予約完了通知
  //   sendBookingNotification(customerId, appointment, cb)
  function sendBookingNotification(customerId, appointment, cb) {
    if (!appointment) {
      _safeCb(cb, _err('no-appointment'));
      return;
    }
    var dateLabel = _toDateLabel(appointment.dateKey);
    var timeStr = appointment.start || '';
    var menuName = _menuLabel(appointment);
    var price = (typeof appointment.priceSnapshot === 'number')
                ? appointment.priceSnapshot : null;

    _resolveCustomer(customerId, function (cust) {
      var custName = (cust && cust.name) ? cust.name : '';
      // 件名はサロン名を含めるため一旦サロン名解決を挟む
      _resolveSalonName(function (salonName) {
        var subject = '[' + salonName + '] ' + TYPE_BOOKING
                    + ' ' + dateLabel + ' ' + timeStr;
        var html = _buildEmailHtml(
          TYPE_BOOKING, salonName, custName,
          dateLabel, timeStr, menuName, '', price
        );
        _dispatch(customerId, TYPE_BOOKING, subject, html, cb);
      });
    });
  }
  window.sendBookingNotification = sendBookingNotification;

  // キャンセル通知
  //   sendCancelNotification(customerId, appointment, cb)
  //   appointment.cancelFeeInfo (任意): キャンセル料の説明文字列。
  //   料金計算自体は呼び出し元 (予約ロジック層) の責務。
  function sendCancelNotification(customerId, appointment, cb) {
    if (!appointment) {
      _safeCb(cb, _err('no-appointment'));
      return;
    }
    var dateLabel = _toDateLabel(appointment.dateKey);
    var timeStr = appointment.start || '';
    var menuName = _menuLabel(appointment);
    var extra = appointment.cancelFeeInfo
                ? String(appointment.cancelFeeInfo) : '';

    _resolveCustomer(customerId, function (cust) {
      var custName = (cust && cust.name) ? cust.name : '';
      _resolveSalonName(function (salonName) {
        var subject = '[' + salonName + '] ' + TYPE_CANCEL
                    + ' ' + dateLabel + ' ' + timeStr;
        var html = _buildEmailHtml(
          TYPE_CANCEL, salonName, custName,
          dateLabel, timeStr, menuName, extra, null
        );
        _dispatch(customerId, TYPE_CANCEL, subject, html, cb);
      });
    });
  }
  window.sendCancelNotification = sendCancelNotification;

  // 変更通知
  //   sendChangeNotification(customerId, oldAppt, newAppt, cb)
  //   本文には新しい予約内容を出し、変更前を extraInfo に併記。
  function sendChangeNotification(customerId, oldAppt, newAppt, cb) {
    if (!newAppt) {
      _safeCb(cb, _err('no-new-appointment'));
      return;
    }
    var newDateLabel = _toDateLabel(newAppt.dateKey);
    var newTime = newAppt.start || '';
    var newMenu = _menuLabel(newAppt);
    var newPrice = (typeof newAppt.priceSnapshot === 'number')
                   ? newAppt.priceSnapshot : null;

    var extra = '';
    if (oldAppt) {
      extra = '［変更前］\n'
            + '■ 日時：' + _toDateLabel(oldAppt.dateKey)
            + ' ' + (oldAppt.start || '') + '\n'
            + '■ メニュー：' + _menuLabel(oldAppt);
    }

    _resolveCustomer(customerId, function (cust) {
      var custName = (cust && cust.name) ? cust.name : '';
      _resolveSalonName(function (salonName) {
        var subject = '[' + salonName + '] ' + TYPE_CHANGE
                    + ' ' + newDateLabel + ' ' + newTime;
        var html = _buildEmailHtml(
          TYPE_CHANGE, salonName, custName,
          newDateLabel, newTime, newMenu, extra, newPrice
        );
        _dispatch(customerId, TYPE_CHANGE, subject, html, cb);
      });
    });
  }
  window.sendChangeNotification = sendChangeNotification;

  // ============================================================
  // 依存ロード確認 (shared_db.js / shared_auth.js が先か)
  // ============================================================

  if (typeof window.dbSalonGetCustomer !== 'function'
      && typeof window.dbCustomerGetMyProfile !== 'function') {
    console.error('[shared_notify] shared_db.js が見つかりません。'
      + 'shared_db.js を shared_notify.js より先に読み込んでください。');
  }
  if (typeof window.authGetCurrentUser !== 'function') {
    console.error('[shared_notify] shared_auth.js が見つかりません。'
      + 'shared_auth.js を shared_notify.js より先に読み込んでください。');
  }

  // ============================================================
  // デバッグ用 (本番では呼ばれない想定)
  // ============================================================

  window._sharedNotifyDebug = {
    functionsUrl: function () { return FUNCTIONS_SEND_EMAIL_URL; },
    buildHtml: function (type, salon, name, dl, t, mn, ex, p) {
      return _buildEmailHtml(type, salon, name, dl, t, mn, ex, p);
    },
    dateLabel: function (dk) { return _toDateLabel(dk); }
  };

  console.log('[shared_notify] loaded.');

})();
