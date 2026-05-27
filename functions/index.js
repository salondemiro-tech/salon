// ========================================
// TORITA Cloud Functions v2
// 設計書 v6 (DESIGN.md 3-4 pendingCreate 方式) 準拠
//
// 機能:
//   1. onAppointmentCreate トリガー (新)
//      - 顧客が pendingCreate=true で予約作成
//      - サーバ側で検証 → 確定 or 削除
//      - 確定時に通知メールを送信
//   2. sendBookingEmail (既存、互換性のため残置)
//      - 将来削除予定
// ========================================

const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { setGlobalOptions } = require('firebase-functions/v2');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');
const { Resend } = require('resend');

// Firebase Admin 初期化
admin.initializeApp();
const db = admin.firestore();

// グローバル設定
setGlobalOptions({
  region: 'asia-northeast1',
  maxInstances: 10
});

// Resend クライアント
const getResend = () => {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not configured');
  return new Resend(apiKey);
};

// 送信元（独自ドメイン認証済み）
const FROM_EMAIL_DEFAULT = 'TORITA <noreply@torita-app.com>';

// ========================================
// HTML エスケープ
// ========================================
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ========================================
// 日時ユーティリティ
// ========================================

// "2026-05-14" + "10:00" → Date (JST)
// Firestore Timestamp で扱う際は admin.firestore.Timestamp.fromDate(d) を使う
function buildJstDate(dateKey, timeStr) {
  // dateKey: YYYY-MM-DD, timeStr: HH:MM
  const parts = dateKey.split('-');
  const time = timeStr.split(':');
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1; // 0-indexed
  const day = parseInt(parts[2], 10);
  const hour = parseInt(time[0], 10);
  const minute = parseInt(time[1], 10);
  // JST = UTC+9 なので、UTC で「9時間引いた時刻」として作る
  // toISOString で UTC が返るので、フロント側で +09:00 表示する
  return new Date(Date.UTC(year, month, day, hour - 9, minute));
}

// Date に分を加算
function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

// Date → "HH:MM" (JST)
function formatJstTime(date) {
  // UTC の時刻に +9 すれば JST
  const jst = new Date(date.getTime() + 9 * 3600000);
  const hh = String(jst.getUTCHours()).padStart(2, '0');
  const mm = String(jst.getUTCMinutes()).padStart(2, '0');
  return hh + ':' + mm;
}

// ========================================
// メール本文 HTML 生成
// ========================================

function buildCustomerEmailHtml(salonName, customerName, dateKey, start, end, menuName, optionNames) {
  const dateLabel = formatJpDate(dateKey);
  const optionText = optionNames.length > 0
    ? '<div><strong>オプション:</strong> ' + escapeHtml(optionNames.join('、')) + '</div>'
    : '';
  return ''
    + '<div style="font-family:sans-serif;color:#1a1a18;line-height:1.7;max-width:560px;">'
    + '<h2 style="color:#b5845a;font-size:18px;margin-bottom:16px;">ご予約ありがとうございます</h2>'
    + '<p>' + escapeHtml(customerName) + ' 様</p>'
    + '<p>このたびは ' + escapeHtml(salonName) + ' をご利用いただき、ありがとうございます。<br>'
    + '以下の内容で承りました。</p>'
    + '<div style="background:#f5ede4;border-radius:10px;padding:14px 18px;margin:14px 0;">'
    + '<div><strong>日時:</strong> ' + escapeHtml(dateLabel) + ' ' + escapeHtml(start) + '〜' + escapeHtml(end) + '</div>'
    + '<div><strong>メニュー:</strong> ' + escapeHtml(menuName) + '</div>'
    + optionText
    + '</div>'
    + '<p style="font-size:12px;color:#73726c;margin-top:24px;">— ' + escapeHtml(salonName) + '</p>'
    + '</div>';
}

function buildSalonEmailHtml(salonName, customerName, customerEmail, customerPhone, dateKey, start, end, menuName, optionNames) {
  const dateLabel = formatJpDate(dateKey);
  const optionText = optionNames.length > 0
    ? '<div><strong>オプション:</strong> ' + escapeHtml(optionNames.join('、')) + '</div>'
    : '';
  return ''
    + '<div style="font-family:sans-serif;color:#1a1a18;line-height:1.7;max-width:560px;">'
    + '<h2 style="color:#b5845a;font-size:18px;margin-bottom:16px;">新しい予約が入りました</h2>'
    + '<div style="background:#f5ede4;border-radius:10px;padding:14px 18px;margin:14px 0;">'
    + '<div><strong>お客様:</strong> ' + escapeHtml(customerName) + '</div>'
    + '<div><strong>メール:</strong> ' + escapeHtml(customerEmail) + '</div>'
    + (customerPhone ? '<div><strong>電話:</strong> ' + escapeHtml(customerPhone) + '</div>' : '')
    + '<div><strong>日時:</strong> ' + escapeHtml(dateLabel) + ' ' + escapeHtml(start) + '〜' + escapeHtml(end) + '</div>'
    + '<div><strong>メニュー:</strong> ' + escapeHtml(menuName) + '</div>'
    + optionText
    + '</div>'
    + '</div>';
}

// "2026-05-14" → "5月14日（木）"
function formatJpDate(dateKey) {
  const parts = dateKey.split('-');
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  const day = parseInt(parts[2], 10);
  const d = new Date(year, month - 1, day);
  const dows = ['日', '月', '火', '水', '木', '金', '土'];
  return month + '月' + day + '日（' + dows[d.getDay()] + '）';
}

// ========================================
// onAppointmentCreate トリガー
// 設計書 3-4 の pendingCreate 方式の実装
// ========================================

exports.onAppointmentCreate = onDocumentCreated(
  {
    document: 'salons/{salonId}/appointments/{appointmentId}',
    secrets: ['RESEND_API_KEY']
  },
  async (event) => {
    const snap = event.data;
    if (!snap) {
      logger.warn('onAppointmentCreate: no snapshot');
      return;
    }

    const data = snap.data();
    const salonId = event.params.salonId;
    const appointmentId = event.params.appointmentId;
    const ref = snap.ref;

    logger.info('onAppointmentCreate fired', { salonId, appointmentId, data });

    // pendingCreate=true でない場合（サロン側からの直接作成など）はスキップ
    if (data.pendingCreate !== true) {
      logger.info('Skip: not pendingCreate', { appointmentId });
      return;
    }

    try {
      // ============================================================
      // 1. 必須フィールドチェック
      // ============================================================
      const { dateKey, start, customerId, menuId } = data;
      const optionMenuIds = data.optionMenuIds || [];

      if (!dateKey || !start || !customerId || !menuId) {
        await failAppointment(ref, salonId, 'missing_required_fields', { dateKey, start, customerId, menuId });
        return;
      }

      // ============================================================
      // 2. メニュー取得 & duration / price 計算
      // ============================================================
      const menuDoc = await db.collection('salons').doc(salonId).collection('menus').doc(menuId).get();
      if (!menuDoc.exists) {
        await failAppointment(ref, salonId, 'menu_not_found', { menuId });
        return;
      }
      const menu = menuDoc.data();

      let totalDuration = menu.duration || 0;
      let totalPrice = menu.price || 0;
      const optionMenuNames = [];

      for (let i = 0; i < optionMenuIds.length; i++) {
        const optId = optionMenuIds[i];
        const optDoc = await db.collection('salons').doc(salonId).collection('menus').doc(optId).get();
        if (!optDoc.exists) {
          await failAppointment(ref, salonId, 'option_menu_not_found', { optId });
          return;
        }
        const opt = optDoc.data();
        totalDuration += (opt.duration || 0);
        totalPrice += (opt.price || 0);
        optionMenuNames.push(opt.name || '');
      }

      // インターバル（前後の片付け時間）も加算
      const intervalAfter = menu.intervalAfter || 0;

      // ============================================================
      // 3. startAt / endAt 計算（サーバ確定）
      // ============================================================
      const startAt = buildJstDate(dateKey, start);
      const endAt = addMinutes(startAt, totalDuration);
      const blockedUntil = addMinutes(endAt, intervalAfter); // インターバル含む占有終了
      const end = formatJstTime(endAt);

      // ============================================================
      // 4. 過去日チェック
      // ============================================================
      const now = new Date();
      if (startAt.getTime() < now.getTime()) {
        await failAppointment(ref, salonId, 'past_appointment', { startAt: startAt.toISOString(), now: now.toISOString() });
        return;
      }

      // ============================================================
      // 5. 営業時間チェック（settings 取得）
      // ============================================================
      const settingsDoc = await db.collection('salons').doc(salonId).collection('config').doc('settings').get();
      if (settingsDoc.exists) {
        const settings = settingsDoc.data();
        // 簡略チェック（厳密な営業時間は今後実装）
        const dow = new Date(dateKey + 'T12:00:00+09:00').getDay();
        if (settings.closedDows && settings.closedDows.indexOf(dow) >= 0) {
          await failAppointment(ref, salonId, 'closed_day', { dow });
          return;
        }
      }

      // ============================================================
      // 6. 同時刻の他予約との衝突チェック
      // ============================================================
      // フェーズ1: staffId='owner', resourceIds=['default'] 固定
      // 同じサロンの確定済み予約で、時間が重なるものがないかチェック
      const sameDaySnap = await db.collection('salons').doc(salonId).collection('appointments')
        .where('dateKey', '==', dateKey)
        .where('status', '==', 'confirmed')
        .get();

      const newStart = startAt.getTime();
      const newEnd = blockedUntil.getTime();

      let conflict = false;
      sameDaySnap.forEach((d) => {
        if (d.id === appointmentId) return; // 自分自身は除外
        const other = d.data();
        if (!other.startAt || !other.endAt) return;
        const otherStart = other.startAt.toMillis ? other.startAt.toMillis() : new Date(other.startAt).getTime();
        const otherEnd = other.endAt.toMillis ? other.endAt.toMillis() : new Date(other.endAt).getTime();
        // 区間 [newStart, newEnd) と [otherStart, otherEnd) が重なるか
        if (newStart < otherEnd && otherStart < newEnd) {
          conflict = true;
        }
      });

      if (conflict) {
        await failAppointment(ref, salonId, 'time_conflict', { dateKey, start, end });
        return;
      }

      // ============================================================
      // 7. closeBlocks（臨時休業）との衝突チェック
      // ============================================================
      const closeBlocksSnap = await db.collection('salons').doc(salonId).collection('closeBlocks')
        .where('dateKey', '==', dateKey)
        .get();

      let closeConflict = false;
      closeBlocksSnap.forEach((d) => {
        const blk = d.data();
        if (!blk.startAt || !blk.endAt) return;
        const bStart = blk.startAt.toMillis ? blk.startAt.toMillis() : new Date(blk.startAt).getTime();
        const bEnd = blk.endAt.toMillis ? blk.endAt.toMillis() : new Date(blk.endAt).getTime();
        if (newStart < bEnd && bStart < newEnd) {
          closeConflict = true;
        }
      });

      if (closeConflict) {
        await failAppointment(ref, salonId, 'close_block_conflict', { dateKey, start, end });
        return;
      }

      // ============================================================
      // 8. 顧客情報取得（メール用）
      // ============================================================
      const customerDoc = await db.collection('salons').doc(salonId).collection('customers').doc(customerId).get();
      if (!customerDoc.exists) {
        await failAppointment(ref, salonId, 'customer_not_found', { customerId });
        return;
      }
      const customer = customerDoc.data();

      // ============================================================
      // 9. サロン情報取得（メール用）
      // ============================================================
      const salonDoc = await db.collection('salons').doc(salonId).get();
      if (!salonDoc.exists) {
        await failAppointment(ref, salonId, 'salon_not_found', { salonId });
        return;
      }
      const salon = salonDoc.data();

      // ============================================================
      // 10. 検証 OK → 予約確定
      // ============================================================
      await ref.update({
        // サーバ確定フィールド
        end: end,
        startAt: admin.firestore.Timestamp.fromDate(startAt),
        endAt: admin.firestore.Timestamp.fromDate(endAt),
        blockedUntil: admin.firestore.Timestamp.fromDate(blockedUntil),
        staffId: 'owner',
        resourceIds: ['default'],
        status: 'confirmed',
        priceSnapshot: totalPrice,
        durationSnapshot: totalDuration,
        menuNameSnapshot: menu.name || '',
        editingBy: null,
        confirmedAt: admin.firestore.FieldValue.serverTimestamp(),
        // pendingCreate を削除
        pendingCreate: admin.firestore.FieldValue.delete()
      });

      logger.info('Appointment confirmed', { salonId, appointmentId });

      // ============================================================
      // 11. 通知メール送信（顧客 + サロン）
      // ============================================================
      const notifyChannels = customer.notifyChannels || { email: true, line: false };
      
      if (notifyChannels.email && customer.email) {
        try {
          const resend = getResend();
          const salonName = salon.name || 'サロン';
          const fromName = salonName + ' <noreply@torita-app.com>';

          // 顧客へ
          await resend.emails.send({
            from: fromName,
            to: customer.email,
            subject: '[' + salonName + '] ご予約ありがとうございます',
            html: buildCustomerEmailHtml(
              salonName, customer.name || '',
              dateKey, start, end,
              menu.name || '', optionMenuNames
            )
          });

          // サロンへ
          if (salon.email) {
            await resend.emails.send({
              from: FROM_EMAIL_DEFAULT,
              to: salon.email,
              subject: '[' + salonName + '] 新しい予約: ' + formatJpDate(dateKey) + ' ' + start,
              html: buildSalonEmailHtml(
                salonName, customer.name || '',
                customer.email, customer.phone || '',
                dateKey, start, end,
                menu.name || '', optionMenuNames
              )
            });
          }

          logger.info('Notification emails sent', { salonId, appointmentId });
        } catch (mailErr) {
          logger.error('Email send failed', { error: mailErr.message, salonId, appointmentId });
          // メール失敗してもログだけ残し、予約は確定済みなのでそのまま
          await logNotificationFailure(salonId, appointmentId, 'email_send_failed', mailErr.message);
        }
      }
    } catch (err) {
      logger.error('onAppointmentCreate error', { error: err.message, stack: err.stack });
      await failAppointment(ref, salonId, 'internal_error', { message: err.message });
    }
  }
);

// 予約失敗時の処理：ドキュメント削除 + ログ記録
async function failAppointment(ref, salonId, reason, details) {
  logger.warn('Appointment failed', { reason, details, path: ref.path });
  try {
    await ref.delete();
  } catch (e) {
    logger.error('Failed to delete appointment doc', { error: e.message });
  }
  await logNotificationFailure(salonId, ref.id, reason, JSON.stringify(details));
}

// notificationLogs に失敗を記録
async function logNotificationFailure(salonId, appointmentId, reason, details) {
  try {
    await db.collection('salons').doc(salonId).collection('notificationLogs').add({
      appointmentId: appointmentId,
      reason: reason,
      details: details,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) {
    logger.error('Failed to log notification failure', { error: e.message });
  }
}

// ========================================
// sendBookingEmail (既存、互換性のため残置)
// v8 系から呼ばれている可能性があるため当面残す
// 将来削除予定
// ========================================

function setCorsHeaders(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Max-Age', '3600');
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
      res.status(405).json({ success: false, error: 'Method Not Allowed' });
      return;
    }

    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      res.status(401).json({ success: false, error: 'ログインが必要です' });
      return;
    }
    const idToken = authHeader.substring(7);

    let decodedToken;
    try {
      decodedToken = await admin.auth().verifyIdToken(idToken);
    } catch (err) {
      res.status(401).json({ success: false, error: '認証トークンが無効です' });
      return;
    }

    const { to, subject, html, salonName } = req.body || {};
    if (!to || !subject || !html) {
      res.status(400).json({ success: false, error: '必要なパラメータが不足しています' });
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(to)) {
      res.status(400).json({ success: false, error: 'メールアドレスの形式が正しくありません' });
      return;
    }

    try {
      const resend = getResend();
      const fromName = salonName
        ? `${salonName} <noreply@torita-app.com>`
        : FROM_EMAIL_DEFAULT;
      const result = await resend.emails.send({
        from: fromName,
        to: to,
        subject: subject,
        html: html
      });
      res.status(200).json({ success: true, messageId: result.data?.id || null });
    } catch (error) {
      logger.error('sendBookingEmail error', { error: error.message });
      res.status(500).json({ success: false, error: 'メール送信に失敗しました: ' + error.message });
    }
  }
);

// ========================================
// resolveOrClaimCustomer (callable Function)
// 設計書 DESIGN_v8_1_customer_identity.md 2-4 に1対1照合
//
// 用途:
//   顧客アプリ登録後の初回ログイン時に呼び出される。
//   顧客の identity（authUid）を customerDocId に解決する。
//   - 既に authIndex に登録済みなら冪等に返す
//   - 同一サロン内の email 一致カルテが
//       * 0件 → 新カルテ作成
//       * 1件 → 既存カルテに claim
//       * 2件以上 → 新カルテ作成 + 候補に needsMergeReview=true
//
// 呼び出し方（クライアント側 JS）:
//   const fn = firebase.functions('asia-northeast1')
//                .httpsCallable('resolveOrClaimCustomer');
//   const result = await fn({ salonId, name, phone });
//   // result.data: { result: '...', customerDocId, ... }
//
// 認証コンテキストは Firebase SDK が自動付与（uid, token.email,
// token.email_verified）。
//
// 必須要件（v8.1 2-4）:
//   1. トランザクション必須（authIndex 作成と customers.authUid 付与の不可分性）
//   2. 冪等性（同じユーザーが2回呼んでも安全）
//   3. emailVerified=false 拒否
//   4. claim 成立時の過去予約 authUid 後埋め（分割バッチ）
//   5. エラー時の挙動：トランザクション失敗時はクライアントにエラーを返す
// ========================================

exports.resolveOrClaimCustomer = onCall(
  { region: 'asia-northeast1' },
  async (request) => {
    // ============================================================
    // 1. 認証チェック
    // ============================================================
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'ログインが必要です');
    }
    const uid = request.auth.uid;
    const email = (request.auth.token && request.auth.token.email) || '';
    const emailVerified = !!(request.auth.token && request.auth.token.email_verified);

    if (!emailVerified) {
      throw new HttpsError(
        'failed-precondition',
        'メール確認が完了していません。メールのリンクをタップしてから再度お試しください。'
      );
    }
    if (!email) {
      throw new HttpsError(
        'failed-precondition',
        'メールアドレスが取得できませんでした'
      );
    }

    // ============================================================
    // 2. 入力バリデーション
    // ============================================================
    const data = request.data || {};
    const salonId = data.salonId;
    const name = (data.name || '').trim();
    const phone = (data.phone || '').trim();

    if (!salonId || typeof salonId !== 'string') {
      throw new HttpsError('invalid-argument', 'salonId が指定されていません');
    }

    logger.info('resolveOrClaimCustomer called', { uid, email, salonId });
    
    // ================================================================
    // 2-5. salon 本体ドキュメント存在チェック（再発防止・O/0事故対策）
    // ================================================================
    const salonDocRef = db.collection('salons').doc(salonId);
    const salonDocSnap = await salonDocRef.get();
    if (!salonDocSnap.exists) {
      logger.warn('salon document does not exist', { salonId, uid });
      throw new HttpsError(
        'invalid-argument',
        '指定されたサロンが存在しません。URLを確認してください。'
      );
    }


    // ============================================================
    // 3. 冪等性チェック: 既に authIndex にあれば即返却
    // ============================================================
    const authIndexRef = db.collection('salons').doc(salonId)
      .collection('authIndex').doc(uid);
    const existingIndex = await authIndexRef.get();
    if (existingIndex.exists) {
      const existingCustomerDocId = existingIndex.data().customerDocId;
      logger.info('Already resolved', { uid, salonId, customerDocId: existingCustomerDocId });
      return {
        result: 'already_resolved',
        customerDocId: existingCustomerDocId
      };
    }

    // ============================================================
    // 4. メール一致候補検索
    //    （未 claim = authUid==null かつ isMerged==false）
    // ============================================================
    const customersRef = db.collection('salons').doc(salonId).collection('customers');
    const emailMatchSnap = await customersRef.where('email', '==', email).get();

    const unclaimedCandidates = [];
    emailMatchSnap.forEach((doc) => {
      const c = doc.data();
      if (c.authUid == null && c.isMerged !== true) {
        unclaimedCandidates.push({ id: doc.id, data: c });
      }
    });

    logger.info('Candidate search result', {
      uid, salonId, email,
      totalMatch: emailMatchSnap.size,
      unclaimedCount: unclaimedCandidates.length
    });

    // ============================================================
    // 5. 件数判定 → トランザクション実行
    // ============================================================

    // -------- 4-A: 候補=1件 → claim 成立 --------
    if (unclaimedCandidates.length === 1) {
      const candidateId = unclaimedCandidates[0].id;
      const candidateRef = customersRef.doc(candidateId);

      try {
        await db.runTransaction(async (tx) => {
          // トランザクション内で再 get（楽観ロック）
          const freshDoc = await tx.get(candidateRef);
          if (!freshDoc.exists) {
            throw new HttpsError('not-found', '候補カルテが見つかりません');
          }
          const fresh = freshDoc.data();
          if (fresh.authUid != null || fresh.isMerged === true) {
            // 直前で他者が claim した / merge された
            // → 候補なし扱いで新カルテ作成に切り替え（後続処理に委ねる）
            throw new HttpsError('aborted', 'CANDIDATE_STATE_CHANGED');
          }

          // claim 実行
          tx.update(candidateRef, {
            authUid: uid,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
          tx.set(authIndexRef, {
            customerDocId: candidateId,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
        });
      } catch (txErr) {
        if (txErr.code === 'aborted' && txErr.message === 'CANDIDATE_STATE_CHANGED') {
          // リトライ: 4-B / 4-C の経路に流し直す（簡易リトライ）
          logger.warn('Candidate state changed during tx, retrying as new', { uid, salonId });
          return await createNewCustomerAndReturn(
            db, salonId, customersRef, authIndexRef, uid, email, name, phone, false, []
          );
        }
        logger.error('claim transaction failed', { uid, salonId, error: txErr.message });
        throw new HttpsError('internal', 'claim 処理に失敗しました: ' + txErr.message);
      }

      // 過去予約の authUid 後埋め（トランザクション外・分割バッチ）
      let claimedCount = 0;
      try {
        claimedCount = await backfillAuthUidOnPastAppointments(
          db, salonId, candidateId, uid
        );
      } catch (backfillErr) {
        // 後埋め失敗は claim 自体は成立しているのでログのみ
        logger.error('backfillAuthUidOnPastAppointments failed', {
          uid, salonId, candidateId, error: backfillErr.message
        });
      }

      logger.info('claim succeeded', { uid, salonId, candidateId, claimedCount });
      return {
        result: 'claimed',
        customerDocId: candidateId,
        claimedAppointmentCount: claimedCount
      };
    }

    // -------- 4-B: 候補=0件 → 新カルテ作成 --------
    if (unclaimedCandidates.length === 0) {
      return await createNewCustomerAndReturn(
        db, salonId, customersRef, authIndexRef,
        uid, email, name, phone,
        /* needsMergeReview */ false,
        /* candidateIdsToFlag */ []
      );
    }

    // -------- 4-C: 候補=2件以上 → 新カルテ作成 + 候補に needsMergeReview --------
    const candidateIds = unclaimedCandidates.map((c) => c.id);
    return await createNewCustomerAndReturn(
      db, salonId, customersRef, authIndexRef,
      uid, email, name, phone,
      /* needsMergeReview */ true,
      /* candidateIdsToFlag */ candidateIds
    );
  }
);

// ========================================
// 新カルテ作成共通処理（4-B/4-C で使う）
// 4-C の場合: needsMergeReview=true で新カルテ作成 +
//             候補カルテ全件に needsMergeReview=true を立てる
// ========================================
async function createNewCustomerAndReturn(
  db, salonId, customersRef, authIndexRef,
  uid, email, name, phone,
  needsMergeReview, candidateIdsToFlag
) {
  const newDocRef = customersRef.doc(); // 自動採番
  const newDocId = newDocRef.id;

  try {
    await db.runTransaction(async (tx) => {
      // authIndex の二重チェック（4-A から落ちてきた場合の保険）
      const freshIndex = await tx.get(authIndexRef);
      if (freshIndex.exists) {
        // 既に他のパスで作られた → 既存値を返す（後続で読み直す）
        throw new HttpsError('aborted', 'INDEX_ALREADY_EXISTS');
      }

      // 候補カルテ全件を再 get（4-C 経路）
      const candidateRefs = candidateIdsToFlag.map((id) => customersRef.doc(id));
      const candidateDocs = [];
      for (let i = 0; i < candidateRefs.length; i++) {
        const d = await tx.get(candidateRefs[i]);
        candidateDocs.push(d);
      }

      // 新カルテ作成
      tx.set(newDocRef, {
        name: name,
        phone: phone,
        email: email,
        authUid: uid,
        createdSource: 'self',
        notifyChannels: { email: true, line: false },
        memo: '',
        karteNote: '',
        stampCount: 0,
        lastVisit: null,
        totalSpent: 0,
        isMerged: false,
        mergedInto: null,
        mergedAt: null,
        mergedAliases: [],
        lockedByJob: null,
        needsMergeReview: needsMergeReview,
        lineUserId: null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // authIndex 作成
      tx.set(authIndexRef, {
        customerDocId: newDocId,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // 4-C: 候補カルテ全件に needsMergeReview=true を立てる
      for (let i = 0; i < candidateDocs.length; i++) {
        const d = candidateDocs[i];
        if (d.exists && d.data().isMerged !== true) {
          tx.update(candidateRefs[i], {
            needsMergeReview: true,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }
      }
    });
  } catch (txErr) {
    if (txErr.code === 'aborted' && txErr.message === 'INDEX_ALREADY_EXISTS') {
      // 他のパスで authIndex が作られた → 既存を返す
      const re = await authIndexRef.get();
      if (re.exists) {
        return {
          result: 'already_resolved',
          customerDocId: re.data().customerDocId
        };
      }
    }
    logger.error('createNewCustomer transaction failed', {
      uid, salonId, error: txErr.message
    });
    throw new HttpsError('internal', 'カルテ作成に失敗しました: ' + txErr.message);
  }

  if (needsMergeReview) {
    logger.info('created_new with needs_merge_review', {
      uid, salonId, newDocId, candidateCount: candidateIdsToFlag.length
    });
    return {
      result: 'needs_merge_review',
      customerDocId: newDocId,
      candidateCount: candidateIdsToFlag.length
    };
  } else {
    logger.info('created_new', { uid, salonId, newDocId });
    return {
      result: 'created_new',
      customerDocId: newDocId
    };
  }
}

// ========================================
// 過去予約の authUid 後埋め（claim 成立時）
// 設計書 v8.1 2-4 必須要件 4
//
// 分割バッチで appointments / appointments_archive 両方を処理
// 1バッチ ≤ 500件（Firestore バッチ上限対策）
// 失敗時は logger に記録、claim 自体の成立は維持
// ========================================
async function backfillAuthUidOnPastAppointments(db, salonId, customerDocId, uid) {
  const collectionsToProcess = ['appointments', 'appointments_archive'];
  let totalUpdated = 0;

  for (let ci = 0; ci < collectionsToProcess.length; ci++) {
    const colName = collectionsToProcess[ci];
    const colRef = db.collection('salons').doc(salonId).collection(colName);

    // customerDocId 一致 かつ authUid==null のものを取得
    // ※ Firestore は != null クエリができないので、
    //   customerDocId 一致を取り → クライアント側で authUid==null をフィルタ
    //   件数が多いサロンでは複合インデックス（customerDocId, authUid）で
    //   将来最適化するが、フェーズ1では十分
    const snap = await colRef.where('customerDocId', '==', customerDocId).get();

    let batch = db.batch();
    let opsInBatch = 0;

    for (const doc of snap.docs) {
      const a = doc.data();
      if (a.authUid != null) continue; // 既に埋まっている

      batch.update(doc.ref, {
        authUid: uid,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      opsInBatch++;
      totalUpdated++;

      // 500件ごとにコミット（Firestore バッチ上限 500）
      if (opsInBatch >= 450) {
        await batch.commit();
        batch = db.batch();
        opsInBatch = 0;
      }
    }

    if (opsInBatch > 0) {
      await batch.commit();
    }

    logger.info('backfill collection done', {
      salonId, customerDocId, collection: colName,
      scanned: snap.size, updated: totalUpdated
    });
  }

  return totalUpdated;
}
