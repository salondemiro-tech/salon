// ========================================
// TORITA Cloud Functions - メール送信
// ========================================

const { onCall, HttpsError } = require('firebase-functions/v2/https');
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
    throw new HttpsError('failed-precondition', 'RESEND_API_KEY is not configured');
  }
  return new Resend(apiKey);
};

// 送信元メールアドレス（後でドメイン認証後に変更可能）
const FROM_EMAIL = 'TORITA <onboarding@resend.dev>';

// ========================================
// メール送信 Function
// ========================================
// クライアントから呼び出される関数
// 引数: { to, subject, html, salonName }
exports.sendBookingEmail = onCall(
  { secrets: ['RESEND_API_KEY'] },
  async (request) => {
    // 認証チェック
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'ログインが必要です');
    }

    const { to, subject, html, salonName } = request.data;

    // 入力バリデーション
    if (!to || !subject || !html) {
      throw new HttpsError('invalid-argument', '必要なパラメータが不足しています');
    }

    // メールアドレス形式チェック
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(to)) {
      throw new HttpsError('invalid-argument', 'メールアドレスの形式が正しくありません');
    }

    try {
      const resend = getResend();
      const fromName = salonName ? `${salonName} <onboarding@resend.dev>` : FROM_EMAIL;
      
      const result = await resend.emails.send({
        from: fromName,
        to: to,
        subject: subject,
        html: html
      });

      console.log('メール送信成功:', { to, subject, id: result.data?.id });
      
      return {
        success: true,
        messageId: result.data?.id || null
      };
    } catch (error) {
      console.error('メール送信エラー:', error);
      throw new HttpsError('internal', 'メール送信に失敗しました: ' + error.message);
    }
  }
);
