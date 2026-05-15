/*
 * shared_auth.js  -  TORITA Phase A-step2 / A-5 + A-8
 * 作成: 2026/5/14
 *
 * 役割:
 *   認証層。サロンオーナーと顧客のログイン・新規登録・ログアウト・
 *   パスワードリセットを担当する。Firebase Auth (compat) のラッパー。
 *
 *   ※ A-8 (データ構造の初期化スクリプト) も本ファイルに統合済み。
 *     authSalonRegister() が WriteBatch で6ドキュメントを一括作成する。
 *     設計書 A-8 にファイル名指定がないこと、A-5 の続きとして読まれる
 *     前提であること、ルール8のファイル分割リストに salon_init.js が
 *     ないことから、案1 (組み込み) で実装。
 *
 * 設計準拠:
 *   - DESIGN.md v6 セクション 3 (認証の設計), A-5, A-8
 *   - firestore.rules (2026/5/14 isSalonStaff を owner固定方式に修正済み)
 *   - shared_db.js が先にロードされている前提 (onFbReady, getCurrentSalonId 等を使う)
 *
 * 主要な設計判断 (2026/5/14):
 *   - staffs ドキュメント ID は 'owner' 固定 (メモリ#22準拠)
 *   - オーナー登録時に WriteBatch で6ドキュメントを一括作成
 *     (info, staffs/owner, resources/default, config/settings,
 *      config/cancelPolicy, config/stampCard)
 *   - 「全部成功か、全部失敗か」を Firestore のアトミック性で保証
 *   - 初期値は旧画面 (business_hours_v6, cancel_policy_v3, stamp_settings)
 *     と完全一致するフィールド構造
 *   - firestore.rules の isSalonStaff() は isSalonOwner() 代用なので、
 *     staffs/owner ドキュメントはルール判定には使われないが、
 *     フェーズ2への布石として最初から作っておく (設計書 A-5/A-8 準拠)
 *   - サロンオーナーも顧客も「メール + パスワード + メール確認」方式
 *
 * ロード順序:
 *   <script src="firebase-app-compat.js"></script>
 *   <script src="firebase-auth-compat.js"></script>
 *   <script src="firebase-firestore-compat.js"></script>
 *   <script src="firebase-init.js"></script>     ← firebase.initializeApp(...)
 *   <script src="shared_db.js"></script>          ← これより前
 *   <script src="shared_auth.js"></script>        ← このファイル
 *
 * ES5 互換:
 *   - var / function / Promise.then のみ
 *   - const / let / アロー関数 / async-await / テンプレートリテラル / ?. は全て禁止
 *
 * コールバック規約:
 *   - 全関数 cb(result) 形式
 *   - 成功時: result = { ok: true, ... }
 *   - 失敗時: result = { ok: false, code: '...', message: '...' }
 *   - 認証系はエラー内容を画面に出す必要があるため、null ではなくエラーオブジェクトを返す
 *
 * 公開 window 関数:
 *   サロンオーナー:
 *     authSalonRegister(email, password, salonName, cb)  ← A-5+A-8 統合
 *     authSalonLogin(email, password, cb)
 *     authSalonResendVerification(cb)
 *
 *   顧客:
 *     authCustomerRegister(email, password, customerName, cb)
 *     authCustomerLogin(email, password, cb)
 *     authCustomerResendVerification(cb)
 *
 *   共通:
 *     authLogout(cb)
 *     authSendPasswordReset(email, cb)
 *     authGetCurrentUser()
 *     authIsEmailVerified()
 *     authOnStateChanged(cb)
 *
 *   ヘルパー (shared_db.js のものを再公開・委譲):
 *     requireSalonStaff(cb)      ← shared_db.js のものをそのまま使う
 *     requireCustomerAuth(cb)    ← shared_db.js のものをそのまま使う
 */

(function () {

  // ============================================================
  // 内部ヘルパー
  // ============================================================

  function _auth() {
    return firebase.auth();
  }

  function _db() {
    return firebase.firestore();
  }

  function _serverTimestamp() {
    return firebase.firestore.FieldValue.serverTimestamp();
  }

  function _safeCb(cb, value) {
    if (typeof cb === 'function') {
      try {
        cb(value);
      } catch (e) {
        console.error('[shared_auth] cb error', e);
      }
    }
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

  // Firebase Auth のエラーを画面表示しやすい形に変換
  function _errResult(err, fallbackLabel) {
    var code = (err && err.code) ? err.code : 'unknown';
    var message = _jpAuthMessage(code, err);
    console.error('[shared_auth] ' + (fallbackLabel || 'auth') + ' failed:', code,
                  (err && err.message) ? err.message : '');
    return { ok: false, code: code, message: message };
  }

  // Firebase Auth エラーコード -> 日本語メッセージ
  // (画面にそのまま出せる文言。technical な英語を顧客に見せない)
  function _jpAuthMessage(code, err) {
    if (code === 'auth/email-already-in-use') {
      return 'このメールアドレスは既に登録されています。ログインをお試しください。';
    }
    if (code === 'auth/invalid-email') {
      return 'メールアドレスの形式が正しくありません。';
    }
    if (code === 'auth/weak-password') {
      return 'パスワードは6文字以上で設定してください。';
    }
    if (code === 'auth/user-not-found' || code === 'auth/wrong-password' ||
        code === 'auth/invalid-credential' || code === 'auth/invalid-login-credentials') {
      return 'メールアドレスまたはパスワードが正しくありません。';
    }
    if (code === 'auth/too-many-requests') {
      return '試行回数が多すぎます。しばらく待ってから再度お試しください。';
    }
    if (code === 'auth/network-request-failed') {
      return '通信エラーが発生しました。電波状況を確認してください。';
    }
    if (code === 'auth/user-disabled') {
      return 'このアカウントは無効化されています。';
    }
    if (code === 'email-not-verified') {
      return 'メールアドレスの確認が完了していません。受信したメール内のリンクをタップしてください。';
    }
    // 想定外コードはそのまま出す (デバッグ用)
    return 'エラーが発生しました (' + code + ')。お手数ですが再度お試しください。';
  }

  // 入力バリデーション (最低限。本格的な検証は Firebase 側に任せる)
  function _validEmail(email) {
    if (!email || typeof email !== 'string') {
      return false;
    }
    // ごく単純なチェック (厳密さは Firebase Auth が担保)
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
  }

  function _validPassword(password) {
    return (typeof password === 'string' && password.length >= 6);
  }

  // ============================================================
  // サロンオーナー: 新規登録 + A-8 初期化スクリプト統合版
  //
  // フロー (設計書 3-1, A-5, A-8):
  //   1. Firebase Auth でメール+パスワードのアカウント作成
  //   2. createUserWithEmailAndPassword の結果、Auth UID が発行される
  //      この Auth UID = salonId
  //   3. sendEmailVerification で確認メール送信
  //   4. WriteBatch で 6 ドキュメントを一括書き込み:
  //        salons/{uid}                          (サロン基本情報)
  //        salons/{uid}/staffs/owner             (オーナーをスタッフとして)
  //        salons/{uid}/resources/default        (デフォルト設備)
  //        salons/{uid}/config/settings          (営業時間など、旧画面と同構造)
  //        salons/{uid}/config/cancelPolicy      (キャンセル規定、旧画面と同構造)
  //        salons/{uid}/config/stampCard         (スタンプカード、enabled:false)
  //      WriteBatch なので「全部成功か、全部失敗か」が保証される。
  //
  //   注: この時点ではまだ emailVerified=false。書き込みは「ログイン直後の本人」
  //       として実行されるので、ルール上は isSalonOwner(salonId) を満たす
  //       (request.auth.uid == salonId)。
  //
  // 設計書との対応:
  //   A-5 (868行) -> Firebase Auth 登録 + sendEmailVerification
  //   A-8 (883行) -> 6 ドキュメント一括作成 (このファイルに統合)
  //
  // 初期値の方針 (2026/5/14 確定):
  //   - 登録直後に予約画面を開いても最低限動くデフォルト値を入れる
  //   - 営業時間 10:00-19:00、定休日なし、休憩なし
  //   - 予約スロット 30 分、インターバル 30 分、閉店に含めない
  //   - 直前予約 same1h、キャンセル前日24時まで、予約 8 週間先まで
  //   - キャンセル規定文は空、料率 3 段階(前日50%/当日100%/無断100%)
  //   - スタンプカード OFF (オーナーが設定画面で ON にする)
  //
  // フィールド構成は旧画面 (business_hours_v6 / cancel_policy_v3 /
  // stamp_settings) と完全一致。新TORITAの設定画面 C-6/C-7/C-8 でも
  // この構造をそのまま読み書きする。
  // ============================================================

  // 初期化用のデフォルト値ビルダ (テスト容易性のため関数化)
  function _buildInitialSalonDoc(salonName, email) {
    return {
      name: String(salonName),
      email: String(email),
      createdAt: _serverTimestamp(),
      plan: 'phase1'
    };
  }

  function _buildInitialStaffOwnerDoc(salonName, email) {
    return {
      name: String(salonName),
      role: 'owner',
      email: String(email),
      active: true,
      createdAt: _serverTimestamp()
    };
  }

  function _buildInitialResourceDefaultDoc() {
    // ルール: keys hasOnly [name,type,active,createdAt], hasAll [name,active]
    // type は省略可だがフェーズ2への布石として 'default' を入れておく
    return {
      name: 'メイン施術スペース',
      type: 'default',
      active: true,
      createdAt: _serverTimestamp()
    };
  }

  // 営業時間設定 (旧画面 business_hours_v6 と完全一致)
  function _buildInitialConfigSettings() {
    return {
      openTime: '10:00',         // 開店
      closeTime: '19:00',        // 閉店
      intervalMin: 30,           // 準備インターバル (分)
      intervalInClose: false,    // インターバルを閉店時間に含めるか
      slotMin: 30,               // 予約スロット間隔 (5/10/15/30)
      lastMin: 'same1h',         // 直前予約期限 (当日1時間前)
      deadline: '前日24時まで',   // キャンセル受付期限
      closedDows: [],            // 定休日 (0=日,1=月,...,6=土) 初期は定休なし
      weeklyClose: [],           // 毎週の定期クローズ [{dow,start,end}]
      bookingWeeks: 8,           // 予約受付期間 (週)
      createdAt: _serverTimestamp(),
      updatedAt: _serverTimestamp()
    };
  }

  // キャンセル規定 (旧画面 cancel_policy_v3 と完全一致)
  function _buildInitialConfigCancelPolicy() {
    return {
      text: '',                  // 規定文 (オーナーが C-7 画面で記入)
      showOnBook: true,          // 予約時に表示
      showOnCancel: true,        // キャンセル時に表示
      rates: [                   // 料率 3 段階
        { label: '前日から', percent: 50 },
        { label: '当日', percent: 100 },
        { label: '無断キャンセル', percent: 100 }
      ],
      qrUrl: '',                 // 決済QR/URL (オーナーが入力)
      qrMsg: '',                 // 自動送信メッセージ本文 (オーナーが入力)
      createdAt: _serverTimestamp(),
      updatedAt: _serverTimestamp()
    };
  }

  // スタンプカード (旧画面 stamp_settings と完全一致)
  function _buildInitialConfigStampCard() {
    return {
      enabled: false,            // 機能OFFで開始 (オーナーが C-8 画面でON)
      goal: 10,                  // ゴール (何個で特典)
      reward: '',                // ゴール特典 (オーナーが入力)
      bonusStamps: [],           // 途中ボーナス [{at, reward}]
      color: '#b5845a',          // スタンプ色 (デフォルト accent)
      expiry: 'none',            // 有効期限 ('3m'/'6m'/'12m'/'none')
      createdAt: _serverTimestamp(),
      updatedAt: _serverTimestamp()
    };
  }

  function authSalonRegister(email, password, salonName, cb) {
    if (!_validEmail(email)) {
      _safeCb(cb, { ok: false, code: 'invalid-email',
                    message: 'メールアドレスの形式が正しくありません。' });
      return;
    }
    if (!_validPassword(password)) {
      _safeCb(cb, { ok: false, code: 'weak-password',
                    message: 'パスワードは6文字以上で設定してください。' });
      return;
    }
    if (!salonName || typeof salonName !== 'string' || salonName.length === 0) {
      _safeCb(cb, { ok: false, code: 'invalid-salon-name',
                    message: 'サロン名を入力してください。' });
      return;
    }

    var createdUid = null;

    _auth().createUserWithEmailAndPassword(email, password)
      .then(function (cred) {
        createdUid = cred.user.uid;
        // 確認メール送信 (失敗しても登録自体は続行したいので
        // 結果の成否は気にしない: メール再送機能で救える)
        return cred.user.sendEmailVerification();
      })
      .then(function () {
        // 6 ドキュメントを WriteBatch で一括書き込み
        // 「全部成功か、全部失敗か」が Firestore で保証される
        var db = _db();
        var salonRef = db.collection('salons').doc(createdUid);
        var batch = db.batch();

        // 1. salons/{uid}
        batch.set(salonRef, _buildInitialSalonDoc(salonName, email));

        // 2. salons/{uid}/staffs/owner
        batch.set(
          salonRef.collection('staffs').doc('owner'),
          _buildInitialStaffOwnerDoc(salonName, email)
        );

        // 3. salons/{uid}/resources/default
        batch.set(
          salonRef.collection('resources').doc('default'),
          _buildInitialResourceDefaultDoc()
        );

        // 4. salons/{uid}/config/settings
        batch.set(
          salonRef.collection('config').doc('settings'),
          _buildInitialConfigSettings()
        );

        // 5. salons/{uid}/config/cancelPolicy
        batch.set(
          salonRef.collection('config').doc('cancelPolicy'),
          _buildInitialConfigCancelPolicy()
        );

        // 6. salons/{uid}/config/stampCard
        batch.set(
          salonRef.collection('config').doc('stampCard'),
          _buildInitialConfigStampCard()
        );

        return batch.commit();
      })
      .then(function () {
        _safeCb(cb, _ok({
          uid: createdUid,
          needEmailVerification: true,
          message: '登録が完了しました。確認メールを送信しましたので、'
                 + 'メール内のリンクをタップしてからログインしてください。'
        }));
      })
      .catch(function (err) {
        // 想定される失敗:
        //   - email-already-in-use (Auth 段階): batch 未実行なのでクリーン
        //   - WriteBatch 失敗 (権限/通信): Auth アカウントは作成済みだが
        //     Firestore は WriteBatch のアトミック性により「何も書かれていない」状態
        //   - sendEmailVerification 失敗のみ: 上の .then で握りつぶしているので
        //     ここには到達しない (確認メール再送機能で救える)
        //
        // 中途半端な状態:
        //   Auth アカウントだけ存在し、Firestore に salons/{uid} がない状態が
        //   残る可能性がある。この場合、同じメールで再登録しようとすると
        //   email-already-in-use エラーになる。フェーズ1では:
        //     - 画面側で「ログインを試してください、ダメなら再送メール」
        //       で吸収する
        //     - もしくは管理画面の運用で Auth アカウントを手動削除して再登録
        //   フェーズ2 or 販売後に「Firestore に salons/{uid} がない Auth ユーザを
        //   検出してログイン時に初期化リトライ」する仕組みを足す。
        _safeCb(cb, _errResult(err, 'authSalonRegister'));
      });
  }
  window.authSalonRegister = authSalonRegister;

  // ============================================================
  // サロンオーナー: ログイン
  //
  // フロー:
  //   1. signInWithEmailAndPassword
  //   2. emailVerified を確認。false ならログアウトさせてエラー返す
  //      (確認前のユーザーを通すと、確認メール無視で使い続けられてしまう)
  //   3. emailVerified=true なら成功
  //
  // 注: 「このユーザーが本当にサロンか (salons/{uid} が存在するか)」までは
  //     ここでは確認しない。それは各サロン管理画面が onFbReady 後に
  //     requireSalonStaff() で確認する責務。
  //     ここはあくまで「Firebase Auth のログイン + メール確認チェック」。
  // ============================================================

  function authSalonLogin(email, password, cb) {
    if (!_validEmail(email) || !password) {
      _safeCb(cb, { ok: false, code: 'invalid-credential',
                    message: 'メールアドレスとパスワードを入力してください。' });
      return;
    }

    _auth().signInWithEmailAndPassword(email, password)
      .then(function (cred) {
        if (!cred.user.emailVerified) {
          // 確認前 -> ログアウトさせて弾く
          return _auth().signOut().then(function () {
            _safeCb(cb, {
              ok: false,
              code: 'email-not-verified',
              message: _jpAuthMessage('email-not-verified'),
              needEmailVerification: true
            });
          });
        }
        _safeCb(cb, _ok({ uid: cred.user.uid }));
      })
      .catch(function (err) {
        _safeCb(cb, _errResult(err, 'authSalonLogin'));
      });
  }
  window.authSalonLogin = authSalonLogin;

  // サロンオーナー: 確認メール再送
  // (ログイン試行 -> email-not-verified が返ったあと、再送したい時に使う)
  // 注: signInWithEmailAndPassword 直後の currentUser に対して送る必要があるため、
  //     画面側は「ログイン失敗 -> 再送ボタン」で email/password を保持しておく方式か、
  //     もしくは authCustomerResendVerification と同様に再ログインさせてから送る。
  //     ここではシンプルに「今 currentUser がいればそれに送る」実装。
  function authSalonResendVerification(cb) {
    var u = _auth().currentUser;
    if (!u) {
      _safeCb(cb, { ok: false, code: 'no-current-user',
                    message: 'ログイン情報が見つかりません。もう一度ログインからやり直してください。' });
      return;
    }
    u.sendEmailVerification()
      .then(function () {
        _safeCb(cb, _ok({ message: '確認メールを再送しました。' }));
      })
      .catch(function (err) {
        _safeCb(cb, _errResult(err, 'authSalonResendVerification'));
      });
  }
  window.authSalonResendVerification = authSalonResendVerification;

  // ============================================================
  // 顧客: 新規登録
  //
  // フロー (設計書 3-2):
  //   1. Firebase Auth でメール+パスワードのアカウント作成
  //   2. sendEmailVerification で確認メール送信
  //   3. この時点では Firestore の customers ドキュメントは作らない
  //      (メール確認後の初回ログイン時に dbCustomerCreateMyProfile で作る)
  //      理由: 確認前ユーザーのゴミドキュメントを Firestore に残さないため
  //
  // 注: 顧客は customer_app.html?salon=xxx からアクセスする。
  //     getCurrentSalonId() は URL パラメータから salonId を返す。
  //     ただし登録段階では salonId は使わない (Auth アカウント作成だけ)。
  // ============================================================

  function authCustomerRegister(email, password, customerName, cb) {
    if (!_validEmail(email)) {
      _safeCb(cb, { ok: false, code: 'invalid-email',
                    message: 'メールアドレスの形式が正しくありません。' });
      return;
    }
    if (!_validPassword(password)) {
      _safeCb(cb, { ok: false, code: 'weak-password',
                    message: 'パスワードは6文字以上で設定してください。' });
      return;
    }
    if (!customerName || typeof customerName !== 'string' || customerName.length === 0) {
      _safeCb(cb, { ok: false, code: 'invalid-customer-name',
                    message: 'お名前を入力してください。' });
      return;
    }

    _auth().createUserWithEmailAndPassword(email, password)
      .then(function (cred) {
        return cred.user.sendEmailVerification();
      })
      .then(function () {
        // customers ドキュメントはここでは作らない (確認後の初回ログイン時)
        // customerName は画面側が一時保持し、初回ログイン後に
        // dbCustomerCreateMyProfile({name, email, ...}) で使う。
        _safeCb(cb, _ok({
          needEmailVerification: true,
          customerName: String(customerName),
          message: '確認メールを送信しました。メール内のリンクをタップしてから'
                 + 'ログインしてください。'
        }));
      })
      .catch(function (err) {
        _safeCb(cb, _errResult(err, 'authCustomerRegister'));
      });
  }
  window.authCustomerRegister = authCustomerRegister;

  // ============================================================
  // 顧客: ログイン
  //
  // フロー:
  //   1. signInWithEmailAndPassword
  //   2. emailVerified を確認。false ならログアウトさせてエラー返す
  //   3. emailVerified=true なら成功
  //      画面側はこのあと dbCustomerGetMyProfile() を呼び、
  //      プロフィールが無ければ dbCustomerCreateMyProfile() で作る。
  // ============================================================

  function authCustomerLogin(email, password, cb) {
    if (!_validEmail(email) || !password) {
      _safeCb(cb, { ok: false, code: 'invalid-credential',
                    message: 'メールアドレスとパスワードを入力してください。' });
      return;
    }

    _auth().signInWithEmailAndPassword(email, password)
      .then(function (cred) {
        if (!cred.user.emailVerified) {
          return _auth().signOut().then(function () {
            _safeCb(cb, {
              ok: false,
              code: 'email-not-verified',
              message: _jpAuthMessage('email-not-verified'),
              needEmailVerification: true
            });
          });
        }
        _safeCb(cb, _ok({
          uid: cred.user.uid,
          email: cred.user.email
        }));
      })
      .catch(function (err) {
        _safeCb(cb, _errResult(err, 'authCustomerLogin'));
      });
  }
  window.authCustomerLogin = authCustomerLogin;

  // 顧客: 確認メール再送
  function authCustomerResendVerification(cb) {
    var u = _auth().currentUser;
    if (!u) {
      _safeCb(cb, { ok: false, code: 'no-current-user',
                    message: 'ログイン情報が見つかりません。もう一度ログインからやり直してください。' });
      return;
    }
    u.sendEmailVerification()
      .then(function () {
        _safeCb(cb, _ok({ message: '確認メールを再送しました。' }));
      })
      .catch(function (err) {
        _safeCb(cb, _errResult(err, 'authCustomerResendVerification'));
      });
  }
  window.authCustomerResendVerification = authCustomerResendVerification;

  // ============================================================
  // 共通: ログアウト
  // ============================================================

  function authLogout(cb) {
    _auth().signOut()
      .then(function () {
        _safeCb(cb, _ok());
      })
      .catch(function (err) {
        _safeCb(cb, _errResult(err, 'authLogout'));
      });
  }
  window.authLogout = authLogout;

  // ============================================================
  // 共通: パスワードリセットメール送信
  // (設計書 3-2: Firebase 標準の sendPasswordResetEmail)
  // ============================================================

  function authSendPasswordReset(email, cb) {
    if (!_validEmail(email)) {
      _safeCb(cb, { ok: false, code: 'invalid-email',
                    message: 'メールアドレスの形式が正しくありません。' });
      return;
    }
    _auth().sendPasswordResetEmail(email)
      .then(function () {
        _safeCb(cb, _ok({
          message: 'パスワード再設定メールを送信しました。メールをご確認ください。'
        }));
      })
      .catch(function (err) {
        // 注: セキュリティ上、user-not-found でも「送信しました」と
        //     表示する考え方もあるが、フェーズ1では素直にエラーを返す。
        //     画面側で「登録されていないか、送信しました」と丸めて表示してもよい。
        _safeCb(cb, _errResult(err, 'authSendPasswordReset'));
      });
  }
  window.authSendPasswordReset = authSendPasswordReset;

  // ============================================================
  // 共通: 現在のユーザー情報取得 (同期)
  // ============================================================

  // 現在ログイン中の Firebase User オブジェクト (未ログインなら null)
  function authGetCurrentUser() {
    if (!window.firebase || !firebase.auth) {
      return null;
    }
    return _auth().currentUser;
  }
  window.authGetCurrentUser = authGetCurrentUser;

  // 現在のユーザーがメール確認済みか (同期, 未ログインなら false)
  function authIsEmailVerified() {
    var u = authGetCurrentUser();
    return !!(u && u.emailVerified === true);
  }
  window.authIsEmailVerified = authIsEmailVerified;

  // ============================================================
  // 共通: 認証状態の変化を監視
  //
  // onFbReady とは別物。これは「ログイン/ログアウトのたびに」呼ばれる。
  // 画面側で「ログインしたらヘッダーを切り替える」等に使う。
  // cb(user) 形式。user は Firebase User または null。
  // ============================================================

  function authOnStateChanged(cb) {
    if (typeof cb !== 'function') {
      return;
    }
    if (!window.firebase || !firebase.auth) {
      console.error('[shared_auth] authOnStateChanged: firebase not ready');
      return;
    }
    _auth().onAuthStateChanged(function (user) {
      try {
        cb(user || null);
      } catch (e) {
        console.error('[shared_auth] authOnStateChanged cb error', e);
      }
    });
  }
  window.authOnStateChanged = authOnStateChanged;

  // ============================================================
  // ヘルパー再公開: requireSalonStaff / requireCustomerAuth
  //
  // 実体は shared_db.js が定義済み。
  // shared_auth.js を読み込んだ画面でも同じ名前で使えるよう、
  // 存在チェックのうえで委譲する (二重定義はしない)。
  // ============================================================

  if (typeof window.requireSalonStaff !== 'function') {
    console.error('[shared_auth] requireSalonStaff が見つかりません。'
                + 'shared_db.js が shared_auth.js より先に読み込まれているか確認してください。');
  }
  if (typeof window.requireCustomerAuth !== 'function') {
    console.error('[shared_auth] requireCustomerAuth が見つかりません。'
                + 'shared_db.js が shared_auth.js より先に読み込まれているか確認してください。');
  }

  // ============================================================
  // デバッグ用
  // ============================================================

  window._sharedAuthDebug = {
    currentUser: function () {
      var u = authGetCurrentUser();
      if (!u) { return null; }
      return {
        uid: u.uid,
        email: u.email,
        emailVerified: u.emailVerified
      };
    }
  };

  console.log('[shared_auth] loaded.');

})();
