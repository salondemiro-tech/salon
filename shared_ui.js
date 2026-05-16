/*
 * shared_ui.js  -  TORITA Phase A-step2 / A-6
 * 作成: 2026/5/16
 *
 * 役割:
 *   共通UI層。全画面で同じ見た目のモーダル・トースト・エラー表示・
 *   ローディング表示を提供する。各画面の HTML に UI 部品の DOM/CSS を
 *   直書きする必要をなくす (読み込み時に自己注入する)。
 *
 * 設計準拠:
 *   - DESIGN.md v6 セクション 5-1, Phase A-step2 / A-6
 *     「共通モーダル、トースト、エラー表示、ローディング表示」
 *     「全画面で同じ見た目になる」
 *   - DESIGN_NOTES.md には A-6 固有の補足記述なし
 *
 * 主要な設計判断 (2026/5/16):
 *   - 旧 v8 系の棚卸し結果に基づく:
 *       * showToast() が全8画面で重複定義され表示時間が
 *         2200/2500/3000ms とバラバラ → uiToast() に一本化 (既定2500ms)
 *       * モーダルが画面ごとに modal-ov / modal-bg / modal と
 *         命名・構造バラバラ → uiModal/uiConfirm/uiAlert に統一
 *       * salon_auth_v2 のみ showErr(id,msg) を持っていた
 *         → uiShowError/uiClearError として汎用化
 *       * customer_app_v8 に .loading-screen クラスだけ存在し
 *         関数化されていなかった → uiShowLoading/uiHideLoading 新設
 *   - DOM と CSS は本ファイルが読み込み時に <head>/<body> へ自己注入する。
 *     これにより各画面 HTML は UI 部品を直書きしなくて済み、
 *     「全画面で同じ見た目」を機械的に保証する。
 *   - テーマカラーは customer_app_v8 の :root 変数
 *     (--ac, --gn, --rd, --tx, --mu, --bd, --bg 等) を参照。
 *     変数未定義の画面でも壊れないようフォールバック色を CSS で併記。
 *   - 本ファイルは DB / 認証 / Firebase に一切依存しない純粋 UI 層。
 *     shared_db.js / shared_auth.js より前に読み込まれても動作する。
 *
 * ES5 互換:
 *   - var / function / Promise.then のみ
 *   - const / let / アロー関数 / async-await / テンプレートリテラル / ?. は全て禁止
 *
 * コールバック規約:
 *   - uiConfirm(message, onOk, onCancel): ボタン押下で対応コールバックを呼ぶ
 *   - uiAlert(message, onClose): OK 押下で onClose (任意)
 *   - その他は同期関数 (即時に DOM 操作)
 *
 * 依存:
 *   - 素の DOM API のみ。外部ライブラリ不要。
 */

(function () {

  // ============================================================
  // 内部状態
  // ============================================================

  var _injected = false;        // CSS/DOM 注入済みか
  var _toastTimer = null;       // トースト自動非表示タイマー
  var _modalOnOk = null;        // 現在開いているモーダルの OK コールバック
  var _modalOnCancel = null;    // 同 キャンセルコールバック
  var _loadingCount = 0;        // ローディングの多重表示カウンタ

  // 旧 v8 系で確定していた既定値
  var TOAST_DURATION_MS = 2500; // 旧画面は 2200/2500/3000 とバラバラ → 中央値で統一

  // ============================================================
  // CSS (テーマ変数を使用。未定義環境向けにフォールバック色を併記)
  // ============================================================
  //
  // 旧 v8 系の実測値を踏襲:
  //   .toast  : 旧 customer_app_v8 / salon_calendar_v7 の値そのまま
  //   .modal  : 旧 salon_calendar_v7 の modal-ov / modal / modal-actions
  //   .err    : 旧 salon_auth_v2 の .err / .err.show
  //   loading : 旧 customer_app_v8 の .loading-screen を全画面オーバーレイ化

  var _CSS = [
    '.tui-toast{',
    '  position:fixed;bottom:24px;left:50%;',
    '  transform:translateX(-50%) translateY(60px);',
    '  background:var(--gt,#1e4d2b);color:#fff;font-size:12px;',
    '  padding:9px 20px;border-radius:20px;opacity:0;',
    '  transition:all .3s;z-index:3000;max-width:86%;',
    '  text-align:center;line-height:1.5;pointer-events:none;',
    '}',
    '.tui-toast.show{opacity:1;transform:translateX(-50%) translateY(0);}',

    '.tui-modal-ov{',
    '  display:none;position:fixed;inset:0;',
    '  background:rgba(0,0,0,.28);z-index:2000;',
    '  align-items:center;justify-content:center;padding:20px;',
    '}',
    '.tui-modal-ov.show{display:flex;}',
    '.tui-modal{',
    '  background:var(--bg,#fff);border-radius:14px;padding:20px;',
    '  width:320px;max-width:100%;',
    '  box-shadow:0 8px 32px rgba(0,0,0,.14);',
    '  font-family:inherit;color:var(--tx,#1a1a18);',
    '}',
    '.tui-modal-title{',
    '  font-size:15px;font-weight:600;margin:0 0 8px;',
    '  color:var(--tx,#1a1a18);',
    '}',
    '.tui-modal-msg{',
    '  font-size:13px;line-height:1.7;margin:0 0 4px;',
    '  color:var(--tx,#1a1a18);white-space:pre-wrap;word-break:break-word;',
    '}',
    '.tui-modal-actions{',
    '  display:flex;gap:8px;margin-top:16px;',
    '}',
    '.tui-btn{',
    '  flex:1;padding:11px;border:none;border-radius:10px;',
    '  font-size:14px;font-weight:600;cursor:pointer;',
    '  font-family:inherit;line-height:1;',
    '}',
    '.tui-btn-ok{background:var(--ac,#b5845a);color:#fff;}',
    '.tui-btn-cancel{',
    '  background:var(--s2,#f0ede8);color:var(--mu,#73726c);',
    '}',
    '.tui-btn-danger{background:var(--rd,#c47b7b);color:#fff;}',

    '.tui-err{',
    '  font-size:12px;color:var(--rt,#6b1f1f);',
    '  background:var(--rl,#faeaea);border-radius:7px;',
    '  padding:8px 11px;margin-top:8px;display:none;',
    '  white-space:pre-wrap;word-break:break-word;',
    '}',
    '.tui-err.show{display:block;}',

    '.tui-loading-ov{',
    '  display:none;position:fixed;inset:0;',
    '  background:rgba(255,255,255,.72);z-index:2500;',
    '  align-items:center;justify-content:center;flex-direction:column;',
    '}',
    '.tui-loading-ov.show{display:flex;}',
    '.tui-spinner{',
    '  width:34px;height:34px;border-radius:50%;',
    '  border:3px solid var(--bd,rgba(0,0,0,.10));',
    '  border-top-color:var(--ac,#b5845a);',
    '  animation:tui-spin .8s linear infinite;',
    '}',
    '.tui-loading-txt{',
    '  margin-top:12px;font-size:13px;color:var(--mu,#73726c);',
    '}',
    '@keyframes tui-spin{to{transform:rotate(360deg);}}'
  ].join('\n');

  // ============================================================
  // CSS / DOM 自己注入 (初回呼び出し時に一度だけ実行)
  // ============================================================

  function _ensureInjected() {
    if (_injected) { return; }
    if (!document || !document.body) {
      // body 未生成タイミングで呼ばれた場合は DOMContentLoaded を待たず
      // 次回呼び出しに委ねる (ES5 制約下での安全策)
      return;
    }

    // <style> 注入
    var st = document.createElement('style');
    st.setAttribute('data-tui', 'shared-ui');
    st.appendChild(document.createTextNode(_CSS));
    document.head ? document.head.appendChild(st)
                  : document.body.appendChild(st);

    // トースト要素
    var toast = document.createElement('div');
    toast.className = 'tui-toast';
    toast.id = 'tuiToast';
    document.body.appendChild(toast);

    // モーダル要素
    var ov = document.createElement('div');
    ov.className = 'tui-modal-ov';
    ov.id = 'tuiModalOv';
    ov.innerHTML =
      '<div class="tui-modal" role="dialog" aria-modal="true">' +
      '  <div class="tui-modal-title" id="tuiModalTitle"></div>' +
      '  <div class="tui-modal-msg" id="tuiModalMsg"></div>' +
      '  <div class="tui-modal-actions" id="tuiModalActions"></div>' +
      '</div>';
    document.body.appendChild(ov);

    // ローディング要素
    var lo = document.createElement('div');
    lo.className = 'tui-loading-ov';
    lo.id = 'tuiLoadingOv';
    lo.innerHTML =
      '<div class="tui-spinner"></div>' +
      '<div class="tui-loading-txt" id="tuiLoadingTxt">読み込み中...</div>';
    document.body.appendChild(lo);

    _injected = true;
  }

  function _byId(id) {
    return document.getElementById(id);
  }

  // ============================================================
  // トースト
  // ============================================================
  //
  // uiToast(message, durationMs)
  //   - message  : 表示文字列
  //   - durationMs: 任意。省略時 TOAST_DURATION_MS (2500ms)
  //   旧 showToast() の完全な置き換え。

  function uiToast(message, durationMs) {
    _ensureInjected();
    var t = _byId('tuiToast');
    if (!t) { return; }

    var ms = (typeof durationMs === 'number' && durationMs > 0)
             ? durationMs : TOAST_DURATION_MS;

    t.textContent = (message == null) ? '' : String(message);
    t.classList.add('show');

    if (_toastTimer) {
      clearTimeout(_toastTimer);
      _toastTimer = null;
    }
    _toastTimer = setTimeout(function () {
      var el = _byId('tuiToast');
      if (el) { el.classList.remove('show'); }
      _toastTimer = null;
    }, ms);
  }
  window.uiToast = uiToast;

  // ============================================================
  // モーダル (低レベル API)
  // ============================================================
  //
  // uiModal(opts)
  //   opts = {
  //     title:   文字列 (任意),
  //     message: 文字列,
  //     okText:    OK ボタン文言 (既定 'OK'),
  //     cancelText:キャンセル文言 (省略時はキャンセルボタンを出さない),
  //     danger:  true なら OK ボタンを赤系に (削除確認用),
  //     onOk:    OK 押下時コールバック (任意),
  //     onCancel:キャンセル押下 / 背景クリック時コールバック (任意)
  //   }
  //
  // uiCloseModal()
  //   開いているモーダルをコールバックを呼ばずに閉じる。

  function uiModal(opts) {
    _ensureInjected();
    opts = opts || {};

    var ov = _byId('tuiModalOv');
    var titleEl = _byId('tuiModalTitle');
    var msgEl = _byId('tuiModalMsg');
    var actEl = _byId('tuiModalActions');
    if (!ov || !titleEl || !msgEl || !actEl) { return; }

    // タイトル
    if (opts.title) {
      titleEl.textContent = String(opts.title);
      titleEl.style.display = '';
    } else {
      titleEl.textContent = '';
      titleEl.style.display = 'none';
    }

    // 本文
    msgEl.textContent = (opts.message == null) ? '' : String(opts.message);

    // コールバック保持
    _modalOnOk = (typeof opts.onOk === 'function') ? opts.onOk : null;
    _modalOnCancel = (typeof opts.onCancel === 'function')
                     ? opts.onCancel : null;

    // ボタン再構築
    while (actEl.firstChild) {
      actEl.removeChild(actEl.firstChild);
    }

    var hasCancel = (typeof opts.cancelText === 'string'
                     && opts.cancelText.length > 0);

    if (hasCancel) {
      var cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'tui-btn tui-btn-cancel';
      cancelBtn.textContent = opts.cancelText;
      cancelBtn.onclick = function () {
        var cb = _modalOnCancel;
        uiCloseModal();
        if (cb) { cb(); }
      };
      actEl.appendChild(cancelBtn);
    }

    var okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'tui-btn '
      + (opts.danger ? 'tui-btn-danger' : 'tui-btn-ok');
    okBtn.textContent = (typeof opts.okText === 'string'
                         && opts.okText.length > 0) ? opts.okText : 'OK';
    okBtn.onclick = function () {
      var cb = _modalOnOk;
      uiCloseModal();
      if (cb) { cb(); }
    };
    actEl.appendChild(okBtn);

    // 背景クリックで閉じる (キャンセル扱い)。
    // キャンセルボタンが無い alert 型では背景クリック無効にして
    // 「閉じ方が分からない」事故を防ぐ。
    ov.onclick = function (ev) {
      if (ev.target !== ov) { return; }
      if (!hasCancel) { return; }
      var cb = _modalOnCancel;
      uiCloseModal();
      if (cb) { cb(); }
    };

    ov.classList.add('show');
  }
  window.uiModal = uiModal;

  function uiCloseModal() {
    var ov = _byId('tuiModalOv');
    if (ov) { ov.classList.remove('show'); }
    _modalOnOk = null;
    _modalOnCancel = null;
  }
  window.uiCloseModal = uiCloseModal;

  // ============================================================
  // 確認ダイアログ / アラート (高レベル API)
  // ============================================================
  //
  // uiConfirm(message, onOk, onCancel, opts)
  //   旧画面の confirmDelete() 系を置き換える汎用確認ダイアログ。
  //   opts (任意) = { title, okText, cancelText, danger }
  //
  // uiConfirmDelete(message, onOk, onCancel)
  //   削除確認のショートカット (danger=true / 文言を削除向けに)。
  //
  // uiAlert(message, onClose, opts)
  //   OK だけのお知らせ。opts (任意) = { title, okText }

  function uiConfirm(message, onOk, onCancel, opts) {
    opts = opts || {};
    uiModal({
      title: opts.title || '',
      message: message,
      okText: opts.okText || 'OK',
      cancelText: opts.cancelText || 'キャンセル',
      danger: opts.danger === true,
      onOk: onOk,
      onCancel: onCancel
    });
  }
  window.uiConfirm = uiConfirm;

  function uiConfirmDelete(message, onOk, onCancel) {
    uiModal({
      title: '',
      message: (message == null) ? '削除してよろしいですか？'
                                 : String(message),
      okText: '削除する',
      cancelText: 'キャンセル',
      danger: true,
      onOk: onOk,
      onCancel: onCancel
    });
  }
  window.uiConfirmDelete = uiConfirmDelete;

  function uiAlert(message, onClose, opts) {
    opts = opts || {};
    uiModal({
      title: opts.title || '',
      message: message,
      okText: opts.okText || 'OK',
      // cancelText を渡さない = OK のみ。背景クリックでは閉じない。
      onOk: (typeof onClose === 'function') ? onClose : null
    });
  }
  window.uiAlert = uiAlert;

  // ============================================================
  // エラー表示 (フォーム等のインライン表示)
  // ============================================================
  //
  // 旧 salon_auth_v2 の showErr(id, msg) 相当を汎用化。
  //
  // uiShowError(targetId, message)
  //   - targetId が既存要素を指す場合: その要素を .tui-err 化して表示
  //     (旧 .err クラス前提の画面とも互換: .err クラスがあれば併用)
  //   - 要素が無い場合は何もしない (呼び出し側の凡ミスを握り潰さないため
  //     console.warn を出す)
  //
  // uiClearError(targetId)
  //   指定エラー表示を消す。

  function uiShowError(targetId, message) {
    _ensureInjected();
    var el = _byId(targetId);
    if (!el) {
      console.warn('[shared_ui] uiShowError: 要素が見つかりません id=',
                   targetId);
      return;
    }
    el.textContent = (message == null) ? '' : String(message);
    el.classList.add('tui-err');
    el.classList.add('show');
  }
  window.uiShowError = uiShowError;

  function uiClearError(targetId) {
    var el = _byId(targetId);
    if (!el) { return; }
    el.textContent = '';
    el.classList.remove('show');
  }
  window.uiClearError = uiClearError;

  // ============================================================
  // ローディング表示 (全画面オーバーレイ)
  // ============================================================
  //
  // uiShowLoading(text)
  //   全画面にスピナーを表示。多重呼び出しはカウンタで管理し、
  //   同数の uiHideLoading() が呼ばれるまで消えない
  //   (並列取得の各完了で個別に hide しても誤って消えない)。
  //
  // uiHideLoading()
  //   カウンタを1減らし、0になったら隠す。
  //
  // uiForceHideLoading()
  //   カウンタを無視して強制的に隠す (エラー処理の保険)。

  function uiShowLoading(text) {
    _ensureInjected();
    var ov = _byId('tuiLoadingOv');
    var txt = _byId('tuiLoadingTxt');
    if (!ov) { return; }

    if (txt) {
      txt.textContent = (typeof text === 'string' && text.length > 0)
                         ? text : '読み込み中...';
    }
    _loadingCount = _loadingCount + 1;
    ov.classList.add('show');
  }
  window.uiShowLoading = uiShowLoading;

  function uiHideLoading() {
    var ov = _byId('tuiLoadingOv');
    if (_loadingCount > 0) {
      _loadingCount = _loadingCount - 1;
    }
    if (_loadingCount <= 0) {
      _loadingCount = 0;
      if (ov) { ov.classList.remove('show'); }
    }
  }
  window.uiHideLoading = uiHideLoading;

  function uiForceHideLoading() {
    var ov = _byId('tuiLoadingOv');
    _loadingCount = 0;
    if (ov) { ov.classList.remove('show'); }
  }
  window.uiForceHideLoading = uiForceHideLoading;

  // ============================================================
  // 初期化 (body が既にあれば即注入、無ければ load 時に注入)
  // ============================================================
  //
  // ES5 制約: DOMContentLoaded は使わない方針 (設計書のコード規約に
  // 合わせる)。代わりに window.onload フォールバックと、各 ui* 関数
  // 冒頭の _ensureInjected() による遅延注入の二段構えで確実性を担保。

  _ensureInjected();

  if (!_injected) {
    var _prevOnload = window.onload;
    window.onload = function () {
      if (typeof _prevOnload === 'function') {
        try { _prevOnload(); } catch (e) {}
      }
      _ensureInjected();
    };
  }

  // ============================================================
  // デバッグ用 (本番では呼ばれない想定)
  // ============================================================

  window._sharedUiDebug = {
    isInjected: function () { return _injected; },
    getLoadingCount: function () { return _loadingCount; },
    getToastDuration: function () { return TOAST_DURATION_MS; },
    forceInject: function () { _ensureInjected(); return _injected; }
  };

  console.log('[shared_ui] loaded.');

})();
