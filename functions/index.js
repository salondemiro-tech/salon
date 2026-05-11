// TORITA Functions ready version
// Existing code + booking email function

const { onRequest } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const { Resend } = require('resend');

admin.initializeApp();

setGlobalOptions({
  region: 'asia-northeast1',
  maxInstances: 10
});

const getResend = () => {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    throw new Error('RESEND_API_KEY is not configured');
  }

  return new Resend(apiKey);
};

const FROM_EMAIL =
  'TORITA <noreply@torita-app.com>';

function setCorsHeaders(res) {

  res.set(
    'Access-Control-Allow-Origin',
    '*'
  );

  res.set(
    'Access-Control-Allow-Methods',
    'POST, OPTIONS'
  );

  res.set(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization'
  );

  res.set(
    'Access-Control-Max-Age',
    '3600'
  );
}

exports.sendBookingEmail = onRequest(
  { secrets: ['RESEND_API_KEY'] },

  async (req, res) => {

    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {

      res.status(204).send('');
      return;
    }

    if (req.method !== 'POST') {

      res.status(405).json({
        success: false,
        error: 'Method Not Allowed'
      });

      return;
    }

    const authHeader =
      req.headers.authorization || '';

    if (!authHeader.startsWith('Bearer ')) {

      res.status(401).json({
        success: false,
        error: 'ログインが必要です'
      });

      return;
    }

    const idToken =
      authHeader.substring(7);

    let decodedToken;

    try {

      decodedToken =
        await admin
          .auth()
          .verifyIdToken(idToken);

    } catch (err) {

      console.error(
        'トークン検証失敗:',
        err.message
      );

      res.status(401).json({
        success: false,
        error: '認証トークンが無効です'
      });

      return;
    }

    const uid = decodedToken.uid;

    const {
      to,
      subject,
      html,
      salonName
    } = req.body || {};

    if (!to || !subject || !html) {

      res.status(400).json({
        success: false,
        error:
          '必要なパラメータ不足'
      });

      return;
    }

    try {

      const resend = getResend();

      const fromName =
        salonName
          ? `${salonName} <noreply@torita-app.com>`
          : FROM_EMAIL;

      const result =
        await resend.emails.send({

          from: fromName,
          to: to,
          subject: subject,
          html: html

        });

      res.status(200).json({
        success: true,
        messageId:
          result.data?.id || null
      });

    } catch (error) {

      res.status(500).json({
        success: false,
        error:
          'メール送信失敗: '
          + error.message
      });

    }

  }
);
