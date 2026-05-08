// ========================================
// TORITA Cloud Functions - メール送信
// onRequest 方式 + Firebase Auth トークン認証 + CORS
// ========================================

const { onRequest } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const { Resend } = require('resend');

// Firebase Admin の初期化
admin.initializeApp();

// グローバル設定（リージョンを東京に）
setGlobalOptions({
  region: 'asia-northeast1',
  maxInstances: 10
});

// Resend クライアントの初期化（API キーは Secret から取得）
const getResend = () => {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY is not configured');
  }
  return new Resend(apiKey);
};

// 送信元メールアドレス（独自ドメイン torita-app.com 認証済み 2026/5/7）
const FROM_EMAIL = 'TORITA <noreply@torita-app.com>';

// CORS ヘッダーを設定するヘルパー
function setCorsHeaders(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Max-Age', '3600');
}

// ========================================
// メール送信 Function (onRequest)
// ========================================
// 呼び出し方:
//   POST https://sendbookingemail-zycy3wf6ba-an.a.run.app
//   Headers:
//     Content-Type: application/json
//     Authorization: Bearer <Firebase Auth ID Token>
//   Body:
//     { "to": "...", "subject": "...", "html": "...", "salonName": "..." }
//
// レスポンス:
//   成功: { "success": true, "messageId": "..." }
//   失敗: { "success": false, "error": "..." }
exports.sendBookingEmail = onRequest(
  { secrets: ['RESEND_API_KEY'] },
  async (req, res) => {
    // CORS ヘッダーを必ず設定
    setCorsHeaders(res);

    // ---- (1) プリフライト (OPTIONS) リクエストへの対応 ----
    // ブラウザが本番リクエスト前に送ってくる確認リクエスト
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    // ---- (2) POST 以外は拒否 ----
    if (req.method !== 'POST') {
      res.status(405).json({ success: false, error: 'Method Not Allowed' });
      return;
    }

    // ---- (3) Firebase Auth トークン検証 ----
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      res.status(401).json({ success: false, error: 'ログインが必要です' });
      return;
    }
    const idToken = authHeader.substring(7); // "Bearer " を取り除く

    let decodedToken;
    try {
      decodedToken = await admin.auth().verifyIdToken(idToken);
    } catch (err) {
      console.error('トークン検証失敗:', err.message);
      res.status(401).json({ success: false, error: '認証トークンが無効です' });
      return;
    }
    const uid = decodedToken.uid;

    // ---- (4) 入力バリデーション ----
    const { to, subject, html, salonName } = req.body || {};

    if (!to || !subject || !html) {
      res.status(400).json({
        success: false,
        error: '必要なパラメータが不足しています (to, subject, html)'
      });
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(to)) {
      res.status(400).json({
        success: false,
        error: 'メールアドレスの形式が正しくありません'
      });
      return;
    }

    // ---- (5) Resend でメール送信 ----
    try {
      const resend = getResend();
      const fromName = salonName
        ? `${salonName} <noreply@torita-app.com>`
        : FROM_EMAIL;

      const result = await resend.emails.send({
        from: fromName,
        to: to,
        subject: subject,
        html: html
      });

      console.log('メール送信成功:', {
        uid: uid,
        to: to,
        subject: subject,
        id: result.data?.id
      });

      res.status(200).json({
        success: true,
        messageId: result.data?.id || null
      });
    } catch (error) {
      console.error('メール送信エラー:', error);
      res.status(500).json({
        success: false,
        error: 'メール送信に失敗しました: ' + error.message
      });
    }
  }
);
