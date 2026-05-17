/*
 * firebase-init.js  -  TORITA Phase C
 * 作成: 2026/5/17
 *
 * 役割:
 *   Firebase の初期化 (initializeApp) だけを行う単一ファイル。
 *   設計書 v6 / shared_auth.js のロード順序契約に従い、
 *   firebase-*-compat.js の後、shared_db.js の前に読み込む。
 *
 *   このファイルを独立させる理由 (設計書 5-2 / ルール6):
 *     - firebaseConfig を1箇所に集約 (全 HTML に直書きしない)
 *     - shared_db.js / shared_auth.js は「既に initializeApp 済み」を前提に書かれている
 *
 * プロジェクト: salon-booking-1d9de (メモリ / test_email_send.html と一致)
 *
 * ロード順序 (各 HTML で厳守):
 *   firebase-app-compat.js
 *   firebase-auth-compat.js
 *   firebase-firestore-compat.js
 *   firebase-init.js        ← このファイル
 *   shared_db.js
 *   shared_auth.js
 *   shared_ui.js
 *   (画面固有スクリプト)
 *
 * ES5 互換: var / function のみ
 */

(function () {

  if (!window.firebase || !firebase.initializeApp) {
    console.error('[firebase-init] firebase compat SDK が読み込まれていません。'
                + 'firebase-*-compat.js を先に読み込んでください。');
    return;
  }

  // 二重初期化ガード (同一ページで複数回読み込まれた場合の保険)
  if (firebase.apps && firebase.apps.length > 0) {
    console.log('[firebase-init] 既に初期化済み。スキップします。');
    return;
  }

  var FIREBASE_CONFIG = {
    apiKey: 'AIzaSyCbU0t9GipUCu6WQFOJ5QLUjAjiFl3j3TY',
    authDomain: 'salon-booking-1d9de.firebaseapp.com',
    projectId: 'salon-booking-1d9de',
    storageBucket: 'salon-booking-1d9de.firebasestorage.app',
    messagingSenderId: '230269330263',
    appId: '1:230269330263:web:0aa2f6b624f2f3803dd412'
  };

  try {
    firebase.initializeApp(FIREBASE_CONFIG);
    console.log('[firebase-init] initialized. projectId =', FIREBASE_CONFIG.projectId);
  } catch (e) {
    console.error('[firebase-init] initializeApp failed:', e);
  }

})();
