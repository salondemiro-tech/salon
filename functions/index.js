// ========================================
// TORITA Cloud Functions v2
// 設計書 v6 (DESIGN.md 3-4 pendingCreate 方式) 準拠
//
// 機能:
//   1. onAppointmentCreate トリガー (新)
//   2. sendBookingEmail (既存、互換性のため残置)
//   3. onAppointmentUpdate (キャンセル通知)
//   4. getAvailableSlots (callable)
//   5. resolveOrClaimCustomer (callable)
//   6. executeMergeCustomers (callable) ← 2026/6/7 追加
//
// 最終改訂: 2026/6/7 顧客統合機能追加
// ========================================

const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { setGlobalOptions } = require('firebase-functions/v2');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');
const { Resend } = require('resend');

admin.initializeApp();
const db = admin.firestore();

setGlobalOptions({
  region: 'asia-northeast1',
  maxInstances: 10
});

const getResend = () => {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not configured');
  return new Resend(apiKey);
};

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
function buildJstDate(dateKey, timeStr) {
  const parts = dateKey.split('-');
  const time = timeStr.split(':');
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1;
  const day = parseInt(parts[2], 10);
  const hour = parseInt(time[0], 10);
  const minute = parseInt(time[1], 10);
  return new Date(Date.UTC(year, month, day, hour - 9, minute));
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

function formatJstTime(date) {
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

    if (data.pendingCreate !== true) {
      logger.info('Skip: not pendingCreate', { appointmentId });
      return;
    }

    try {
      const { dateKey, start, customerDocId, menuId } = data;
      const optionMenuIds = data.optionMenuIds || [];

      if (!dateKey || !start || !customerDocId || !menuId) {
        await failAppointment(ref, salonId, 'missing_required_fields', { dateKey, start, customerDocId, menuId });
        return;
      }

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

      const intervalAfter = menu.intervalAfter || 0;

      const startAt = buildJstDate(dateKey, start);
      const endAt = addMinutes(startAt, totalDuration);
      const blockedUntil = addMinutes(endAt, intervalAfter);
      const end = formatJstTime(endAt);

      const now = new Date();
      if (startAt.getTime() < now.getTime()) {
        await failAppointment(ref, salonId, 'past_appointment', { startAt: startAt.toISOString(), now: now.toISOString() });
        return;
      }

      const settingsDoc = await db.collection('salons').doc(salonId).collection('config').doc('settings').get();
      if (settingsDoc.exists) {
        const settings = settingsDoc.data();
        const dow = new Date(dateKey + 'T12:00:00+09:00').getDay();
        if (settings.closedDows && settings.closedDows.indexOf(dow) >= 0) {
          await failAppointment(ref, salonId, 'closed_day', { dow });
          return;
        }
      }

      // ===== Phase I-step6: フェーズ2対応 =====
      // メニューの eligible 設定を取得
      const eligibleStaffIds     = Array.isArray(menu.eligibleStaffIds)     ? menu.eligibleStaffIds     : [];
      const eligibleSpaceIds     = Array.isArray(menu.eligibleSpaceIds)     ? menu.eligibleSpaceIds     : [];
      const eligibleEquipmentIds = Array.isArray(menu.eligibleEquipmentIds) ? menu.eligibleEquipmentIds : [];

      // フェーズ1互換判定
      const isPhase1Menu = eligibleStaffIds.length === 0 ||
        (eligibleStaffIds.length === 1 && eligibleStaffIds[0] === 'owner');

      // シフト（フェーズ2のみ）
      let shiftStaffIds = [];
      if (!isPhase1Menu) {
        const shiftDoc = await db.collection('salons').doc(salonId).collection('shifts').doc(dateKey).get();
        shiftStaffIds = shiftDoc.exists ? (shiftDoc.data().staffIds || []) : [];
      }

      // 同日の確定済み予約を取得
      const [sameDaySnap, closeBlocksSnap, customerDoc, salonDoc] = await Promise.all([
        db.collection('salons').doc(salonId).collection('appointments')
          .where('dateKey', '==', dateKey)
          .where('status', '==', 'confirmed')
          .get(),
        db.collection('salons').doc(salonId).collection('closeBlocks')
          .where('dateKey', '==', dateKey)
          .get(),
        db.collection('salons').doc(salonId).collection('customers').doc(customerDocId).get(),
        db.collection('salons').doc(salonId).get()
      ]);

      if (!customerDoc.exists) {
        await failAppointment(ref, salonId, 'customer_not_found', { customerDocId });
        return;
      }
      if (!salonDoc.exists) {
        await failAppointment(ref, salonId, 'salon_not_found', { salonId });
        return;
      }
      const customer = customerDoc.data();
      const salon = salonDoc.data();

      const newStart = startAt.getTime();
      const newEnd = blockedUntil.getTime();

      // closeBlocks チェック
      let closeConflict = false;
      closeBlocksSnap.forEach((d) => {
        const blk = d.data();
        if (!blk.startAt || !blk.endAt) return;
        const bStart = blk.startAt.toMillis ? blk.startAt.toMillis() : new Date(blk.startAt).getTime();
        const bEnd = blk.endAt.toMillis ? blk.endAt.toMillis() : new Date(blk.endAt).getTime();
        if (newStart < bEnd && bStart < newEnd) { closeConflict = true; }
      });
      if (closeConflict) {
        await failAppointment(ref, salonId, 'close_block_conflict', { dateKey, start, end });
        return;
      }

      // 同時間帯の確定済み予約を収集
      const conflictAppts = [];
      sameDaySnap.forEach((d) => {
        if (d.id === appointmentId) return;
        const other = d.data();
        if (!other.startAt || !other.endAt) return;
        const oStart = other.startAt.toMillis ? other.startAt.toMillis() : new Date(other.startAt).getTime();
        const oEnd   = other.blockedUntil
          ? (other.blockedUntil.toMillis ? other.blockedUntil.toMillis() : new Date(other.blockedUntil).getTime())
          : (other.endAt.toMillis ? other.endAt.toMillis() : new Date(other.endAt).getTime());
        if (newStart < oEnd && oStart < newEnd) {
          conflictAppts.push({
            staffId:     other.staffId     || 'owner',
            spaceId:     other.spaceId     || 'default',
            equipmentId: other.equipmentId || null
          });
        }
      });

      // 確定するスタッフ・場所・機器を決定
      let assignedStaffId     = 'owner';
      let assignedSpaceId     = null;
      let assignedEquipmentId = null;

      if (isPhase1Menu) {
        // フェーズ1: owner が埋まっていれば conflict
        if (conflictAppts.some(a => a.staffId === 'owner')) {
          await failAppointment(ref, salonId, 'time_conflict', { dateKey, start, end });
          return;
        }
        assignedStaffId = 'owner';
      } else {
        // フェーズ2: スタッフ選択
        const busyStaffIds = new Set(conflictAppts.map(a => a.staffId));
        const shiftSet     = new Set(shiftStaffIds);
        const availableStaff = eligibleStaffIds.filter(sid => shiftSet.has(sid) && !busyStaffIds.has(sid));
        if (availableStaff.length === 0) {
          await failAppointment(ref, salonId, 'time_conflict', { dateKey, start, end, reason: 'no_available_staff' });
          return;
        }
        // I-step8: 顧客が指名した場合は優先。指名なし or 指名スタッフが埋まっている場合は未割当（null）
        const nominatedStaffId = event.data.after.data().nominatedStaffId || null;
        if (nominatedStaffId && availableStaff.includes(nominatedStaffId)) {
          // 指名スタッフが空いている → そのスタッフに確定
          assignedStaffId = nominatedStaffId;
        } else {
          // 指名なし or 指名スタッフが埋まっている → 未割当（オーナーが手動で割り当て）
          assignedStaffId = null;
        }

        // フェーズ2: 場所選択
        if (eligibleSpaceIds.length > 0) {
          const busySpaceIds = new Set(conflictAppts.map(a => a.spaceId).filter(Boolean));
          const availableSpaces = eligibleSpaceIds.filter(sid => !busySpaceIds.has(sid));
          if (availableSpaces.length === 0) {
            await failAppointment(ref, salonId, 'time_conflict', { dateKey, start, end, reason: 'no_available_space' });
            return;
          }
          assignedSpaceId = availableSpaces[0];
        }

        // フェーズ2: 機器選択（未設定なら無視）
        if (eligibleEquipmentIds.length > 0) {
          const busyEquipIds = new Set(conflictAppts.map(a => a.equipmentId).filter(Boolean));
          const availableEquips = eligibleEquipmentIds.filter(eid => !busyEquipIds.has(eid));
          if (availableEquips.length === 0) {
            await failAppointment(ref, salonId, 'time_conflict', { dateKey, start, end, reason: 'no_available_equipment' });
            return;
          }
          assignedEquipmentId = availableEquips[0];
        }
      }

      // 予約確定 update
      const updatePayload = {
        end: end,
        startAt: admin.firestore.Timestamp.fromDate(startAt),
        endAt: admin.firestore.Timestamp.fromDate(endAt),
        blockedUntil: admin.firestore.Timestamp.fromDate(blockedUntil),
        // staffId: null = 未割当（指名なし）。オーナーがカレンダーで手動割り当て
        staffId: assignedStaffId,
        nominatedStaffId: nominatedStaffId || null,
        status: 'confirmed',
        priceSnapshot: totalPrice,
        durationSnapshot: totalDuration,
        menuNameSnapshot: menu.name || '',
        editingBy: null,
        confirmedAt: admin.firestore.FieldValue.serverTimestamp(),
        pendingCreate: admin.firestore.FieldValue.delete()
      };
      // フェーズ2フィールド（フェーズ1は保存しない）
      if (!isPhase1Menu) {
        if (assignedSpaceId)     { updatePayload.spaceId     = assignedSpaceId; }
        if (assignedEquipmentId) { updatePayload.equipmentId = assignedEquipmentId; }
      } else {
        // フェーズ1互換フィールドは残す
        updatePayload.resourceIds = ['default'];
      }

      await ref.update(updatePayload);

      logger.info('Appointment confirmed', { salonId, appointmentId });

      const notifyChannels = customer.notifyChannels || { email: true, line: false };
      const notifyTo = data.customerEmail || customer.email || '';

      if (notifyChannels.email && notifyTo) {
        try {
          const resend = getResend();
          const salonName = salon.name || 'サロン';
          const fromName = salonName + ' <noreply@torita-app.com>';

          await resend.emails.send({
            from: fromName,
            to: notifyTo,
            subject: '[' + salonName + '] ご予約ありがとうございます',
            html: buildCustomerEmailHtml(
              salonName, customer.name || '',
              dateKey, start, end,
              menu.name || '', optionMenuNames
            )
          });

          if (salon.email) {
            await resend.emails.send({
              from: FROM_EMAIL_DEFAULT,
              to: salon.email,
              subject: '[' + salonName + '] 新しい予約: ' + formatJpDate(dateKey) + ' ' + start,
              html: buildSalonEmailHtml(
                salonName, customer.name || '',
                notifyTo, customer.phone || '',
                dateKey, start, end,
                menu.name || '', optionMenuNames
              )
            });
          }

          logger.info('Notification emails sent', { salonId, appointmentId });
        } catch (mailErr) {
          logger.error('Email send failed', { error: mailErr.message, salonId, appointmentId });
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

// ========================================
// notificationLogs に失敗を記録
//
// ★ 2026/6/2 F-4: category を自動付与（シグネチャは不変）。
//   呼び出し側は一切変更不要。reason から category を判定する。
//     - 通知系 reason (email_send_failed / cancel_email_failed)
//       → category='notification'
//     - それ以外（予約検証エラー：menu_not_found / time_conflict 等）
//       → category='validation'
//   管理画面は将来 where('category','==','notification') で
//   「通知失敗だけ」を絞り込める。既存ログ（category なし）は
//   そのまま残る（後方互換）。
//   channel/to は今は入れない（通知系 reason は現状 email のみ。
//   必要になったら足す＝YAGNI）。
// ========================================
async function logNotificationFailure(salonId, appointmentId, reason, details) {
  const NOTIFICATION_REASONS = ['email_send_failed', 'cancel_email_failed'];
  const category = (NOTIFICATION_REASONS.indexOf(reason) >= 0)
    ? 'notification'
    : 'validation';
  try {
    await db.collection('salons').doc(salonId).collection('notificationLogs').add({
      appointmentId: appointmentId,
      category: category,
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
// onAppointmentUpdate トリガー（キャンセル通知）
// ========================================
exports.onAppointmentUpdate = onDocumentUpdated(
  {
    document: 'salons/{salonId}/appointments/{appointmentId}',
    secrets: ['RESEND_API_KEY']
  },
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();
    const salonId = event.params.salonId;
    const appointmentId = event.params.appointmentId;

    if (after.status !== 'cancelled_by_customer') return;
    if (before.status === 'cancelled_by_customer') return;

    logger.info('onAppointmentUpdate: cancel detected', { salonId, appointmentId });

    try {
      const { dateKey, start, end, customerDocId, menuNameSnapshot, priceSnapshot } = after;

      const customerDoc = await db.collection('salons').doc(salonId)
        .collection('customers').doc(customerDocId).get();
      const customer = customerDoc.exists ? customerDoc.data() : {};

      const salonDoc = await db.collection('salons').doc(salonId).get();
      const salon = salonDoc.exists ? salonDoc.data() : {};
      const salonName = salon.name || 'サロン';

      const policyDoc = await db.collection('salons').doc(salonId)
        .collection('config').doc('cancelPolicy').get();
      const pol = policyDoc.exists ? policyDoc.data() : {};
      const rates = pol.rates || [];
      let cancelFee = 0;
      let cancelPercent = 0;
      if (rates.length && priceSnapshot) {
        const now = new Date();
        const apptDate = new Date(dateKey + 'T' + (start || '00:00') + ':00+09:00');
        const diffDays = (apptDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
        for (let i = 0; i < rates.length; i++) {
          const r = rates[i];
          const lbl = r.label || '';
          const m = lbl.match(/(\d+)日前/);
          if (m) {
            if (diffDays <= parseInt(m[1], 10)) cancelPercent = r.percent;
          } else if (lbl.indexOf('前日') >= 0) {
            if (diffDays <= 1) cancelPercent = r.percent;
          } else if (lbl.indexOf('当日') >= 0) {
            if (diffDays <= 0) cancelPercent = r.percent;
          }
        }
        cancelFee = Math.round(priceSnapshot * cancelPercent / 100);
      }

      const dateLabel = formatJpDate(dateKey);
      const menuName  = menuNameSnapshot || '';

      // ★ 2026/6/13: キャンセル料発生時の自動送信メッセージ（pol.qrMsg）対応。
      //   サロンが設定画面で入力した本文を変数置換して使う。
      //   未設定（空）なら従来の固定文面にフォールバック。
      //   使える変数: {顧客名} {予約日時} {メニュー} {キャンセル料} {決済リンク}
      //   （旧 {QRリンク} も後方互換で受け付ける）
      function buildFeeText() {
        if (cancelFee <= 0) return '';

        // 固定のキャンセル料行（金額の明示は必ず入れる）
        const feeLine = '<p style="color:#c47b7b;font-weight:600;">キャンセル料: ¥'
          + cancelFee.toLocaleString() + '（' + cancelPercent + '%）</p>';

        const qrMsgRaw = (typeof pol.qrMsg === 'string') ? pol.qrMsg.trim() : '';

        // qrMsg 未設定: 従来通り（固定行＋QRリンク）
        if (!qrMsgRaw) {
          return feeLine
            + (pol.qrUrl ? '<p><a href="' + escapeHtml(pol.qrUrl) + '">お支払いはこちら</a></p>' : '');
        }

        // qrMsg 設定済み: 変数置換（テキスト変数を先に置換 → 全体をHTMLエスケープ
        //   → 改行を<br>化 → 最後に {QRリンク} をリンクHTMLへ差し替え）
        let msg = qrMsgRaw
          .split('{顧客名}').join(customer.name || '')
          .split('{予約日時}').join(dateLabel + ' ' + (start || ''))
          .split('{メニュー}').join(menuName)
          .split('{キャンセル料}').join('¥' + cancelFee.toLocaleString() + '（' + cancelPercent + '%）');

        let msgHtml = escapeHtml(msg).replace(/\r?\n/g, '<br>');

        const qrLinkHtml = pol.qrUrl
          ? '<a href="' + escapeHtml(pol.qrUrl) + '">お支払いはこちら</a>'
          : '';
        // {決済リンク} を主変数とする。旧 {QRリンク} も後方互換で受け付ける。
        const hasLinkVar = (msgHtml.indexOf('{決済リンク}') >= 0) ||
                           (msgHtml.indexOf('{QRリンク}') >= 0);
        if (hasLinkVar) {
          msgHtml = msgHtml.split('{決済リンク}').join(qrLinkHtml)
                           .split('{QRリンク}').join(qrLinkHtml);
        } else if (qrLinkHtml) {
          // リンク変数を書き忘れていても、URLが設定されていれば末尾に付ける
          msgHtml += '<br><br>' + qrLinkHtml;
        }

        return feeLine
          + '<div style="background:#fdf6e3;border-radius:10px;padding:14px 18px;margin:14px 0;">'
          + msgHtml
          + '</div>';
      }

      const feeText = buildFeeText();

      function buildCancelCustomerHtml() {
        return '<div style="font-family:sans-serif;color:#1a1a18;line-height:1.7;max-width:560px;">'
          + '<h2 style="color:#b5845a;font-size:18px;margin-bottom:16px;">ご予約のキャンセルを受け付けました</h2>'
          + '<p>' + escapeHtml(customer.name || '') + ' 様</p>'
          + '<p>以下の予約をキャンセルいたしました。</p>'
          + '<div style="background:#f5ede4;border-radius:10px;padding:14px 18px;margin:14px 0;">'
          + '<div><strong>日時:</strong> ' + escapeHtml(dateLabel) + ' ' + escapeHtml(start || '') + '〜' + escapeHtml(end || '') + '</div>'
          + '<div><strong>メニュー:</strong> ' + escapeHtml(menuName) + '</div>'
          + '</div>'
          + feeText
          + '<p style="font-size:12px;color:#73726c;margin-top:24px;">— ' + escapeHtml(salonName) + '</p>'
          + '</div>';
      }

      function buildCancelSalonHtml() {
        return '<div style="font-family:sans-serif;color:#1a1a18;line-height:1.7;max-width:560px;">'
          + '<h2 style="color:#c47b7b;font-size:18px;margin-bottom:16px;">予約がキャンセルされました</h2>'
          + '<div style="background:#faeaea;border-radius:10px;padding:14px 18px;margin:14px 0;">'
          + '<div><strong>お客様:</strong> ' + escapeHtml(customer.name || '') + '</div>'
          + '<div><strong>メール:</strong> ' + escapeHtml(customer.email || '') + '</div>'
          + (customer.phone ? '<div><strong>電話:</strong> ' + escapeHtml(customer.phone) + '</div>' : '')
          + '<div><strong>日時:</strong> ' + escapeHtml(dateLabel) + ' ' + escapeHtml(start || '') + '〜' + escapeHtml(end || '') + '</div>'
          + '<div><strong>メニュー:</strong> ' + escapeHtml(menuName) + '</div>'
          + (cancelFee > 0 ? '<div style="color:#c47b7b;font-weight:600;">キャンセル料: ¥' + cancelFee.toLocaleString() + '（' + cancelPercent + '%）</div>' : '')
          + '</div>'
          + '</div>';
      }

      const notifyChannels = customer.notifyChannels || { email: true };
      const cancelNotifyTo = after.customerEmail || customer.email || '';
      if (notifyChannels.email && cancelNotifyTo) {
        const resend = getResend();
        const fromName = salonName + ' <noreply@torita-app.com>';

        await resend.emails.send({
          from: fromName,
          to: cancelNotifyTo,
          subject: '[' + salonName + '] ご予約のキャンセルを受け付けました',
          html: buildCancelCustomerHtml()
        });

        if (salon.email) {
          await resend.emails.send({
            from: FROM_EMAIL_DEFAULT,
            to: salon.email,
            subject: '[' + salonName + '] キャンセル: ' + formatJpDate(dateKey) + ' ' + (start || ''),
            html: buildCancelSalonHtml()
          });
        }

        logger.info('Cancel emails sent', { salonId, appointmentId });
      }
    } catch (err) {
      logger.error('onAppointmentUpdate error', { error: err.message, stack: err.stack });
      // ★ 2026/6/1 ⑤：キャンセル通知失敗も notificationLogs に記録
      await logNotificationFailure(salonId, appointmentId, 'cancel_email_failed', err.message);
    }
  }
);

// ========================================
// getAvailableSlots callable
// ========================================
// ========================================
// getAvailableSlots (callable Function)
// ========================================
// Phase I-step6 2026/6/26 フェーズ2対応:
//   スタッフ × 場所 × 機器 × シフトで空き計算
//   フェーズ1互換: eligibleStaffIds=['owner']または未設定はスタッフ条件スキップ
//
// 予約可能条件:
//   ① eligibleStaffIds のうち出勤中（shifts）かつ予定が空いているスタッフが1人以上
//   ② eligibleSpaceIds のうち予定が空いている場所が1つ以上（未設定なら無視）
//   ③ eligibleEquipmentIds のうち予定が空いている機器が1つ以上（未設定なら無視）
//
// appointments 互換:
//   既存予約の spaceId 未設定 → 'default' 扱い
//   既存予約の equipmentId 未設定 → null 扱い（機器条件に影響しない）
exports.getAvailableSlots = onCall(
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'ログインが必要です。');
    }

    const { salonId, dateKey, menuId, optionMenuIds, nominatedStaffId } = request.data || {};

    if (!salonId || typeof salonId !== 'string') {
      throw new HttpsError('invalid-argument', 'salonId が不正です。');
    }
    if (!dateKey || typeof dateKey !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(dateKey)) {
      throw new HttpsError('invalid-argument', 'dateKey が不正です。');
    }
    if (!menuId || typeof menuId !== 'string') {
      throw new HttpsError('invalid-argument', 'menuId が不正です。');
    }
    const optIds = Array.isArray(optionMenuIds) ? optionMenuIds : [];

    const salonRef = db.collection('salons').doc(salonId);

    // フェーズ2: シフトも並行取得
    const [settingsDoc, menuDoc, apptSnap, closeBlockSnap, shiftDoc] = await Promise.all([
      salonRef.collection('config').doc('settings').get(),
      salonRef.collection('menus').doc(menuId).get(),
      salonRef.collection('appointments').where('dateKey', '==', dateKey).get(),
      salonRef.collection('closeBlocks').get(),
      salonRef.collection('shifts').doc(dateKey).get()
    ]);

    const optDocs = await Promise.all(
      optIds.map(id => salonRef.collection('menus').doc(id).get())
    );

    if (!menuDoc.exists) {
      throw new HttpsError('not-found', 'メニューが見つかりません。');
    }
    const menu = menuDoc.data();
    let totalDuration = menu.duration || 0;
    for (const optDoc of optDocs) {
      if (optDoc.exists) totalDuration += (optDoc.data().duration || 0);
    }
    const intervalAfter = menu.intervalAfter || 0;

    const settings = settingsDoc.exists ? settingsDoc.data() : {};
    const openMin  = hhmmToMin(settings.openTime  || '10:00');
    const closeMin = hhmmToMin(settings.closeTime || '19:00');
    const slotMin  = (typeof settings.slotMin === 'number' && settings.slotMin > 0) ? settings.slotMin : 30;
    const intervalMin = (typeof settings.intervalMin === 'number') ? settings.intervalMin : 0;
    const needMin  = totalDuration > 0 ? totalDuration : slotMin;
    const latestStart = closeMin - needMin;

    // ===== フェーズ2: スタッフ・場所・機器の設定を取得 =====
    const eligibleStaffIds     = Array.isArray(menu.eligibleStaffIds)     ? menu.eligibleStaffIds     : [];
    const eligibleSpaceIds     = Array.isArray(menu.eligibleSpaceIds)     ? menu.eligibleSpaceIds     : [];
    const eligibleEquipmentIds = Array.isArray(menu.eligibleEquipmentIds) ? menu.eligibleEquipmentIds : [];

    // フェーズ1互換判定: staffIds が ['owner'] のみ or 空 → シフト・スタッフ条件スキップ
    const isPhase1Menu = eligibleStaffIds.length === 0 ||
      (eligibleStaffIds.length === 1 && eligibleStaffIds[0] === 'owner');

    // その日出勤しているスタッフIDセット
    const shiftStaffIds = shiftDoc.exists
      ? (shiftDoc.data().staffIds || [])
      : [];
    const shiftSet = new Set(shiftStaffIds);

    // CANCEL_STATUSES
    const CANCEL_STATUSES = new Set([
      'cancelled', 'cancelled_by_customer', 'cancelled_by_salon',
      'no_show', 'time_conflict', 'failed'
    ]);

    // 既存予約を時間範囲に変換（フェーズ2: staffId / spaceId / equipmentId も保持）
    const busyAppts = []; // { startMin, endMin, staffId, spaceId, equipmentId }

    apptSnap.forEach(doc => {
      const a = doc.data();
      if (CANCEL_STATUSES.has(a.status)) return;
      const isConfirmed = a.status === 'confirmed';
      const isPending   = a.pendingCreate === true;
      if (!isConfirmed && !isPending) return;

      // フェーズ2互換: spaceId 未設定は 'default'、equipmentId 未設定は null
      const apptStaffId     = a.staffId     || 'owner';
      const apptSpaceId     = a.spaceId     || 'default';
      const apptEquipmentId = a.equipmentId || null;

      let startMin, endMin;
      if (a.startAt && a.startAt.toMillis) {
        const baseMs = a.startAt.toMillis();
        const endTs  = a.blockedUntil || a.endAt;
        const endMs  = endTs && endTs.toMillis ? endTs.toMillis() : (baseMs + needMin * 60000);
        const base   = new Date(dateKey + 'T00:00:00+09:00').getTime();
        startMin = Math.round((baseMs - base) / 60000);
        endMin   = Math.round((endMs  - base) / 60000);
      } else {
        startMin = hhmmToMin(a.start);
        if (isNaN(startMin)) return;
        const rawEnd = a.end ? hhmmToMin(a.end) : (startMin + (a.durationSnapshot || slotMin));
        startMin = startMin - intervalMin;
        endMin   = rawEnd   + intervalMin;
      }

      busyAppts.push({ startMin, endMin, staffId: apptStaffId, spaceId: apptSpaceId, equipmentId: apptEquipmentId });
    });

    // closeBlocks をグローバルbusy（スタッフ・設備を問わず全てブロック）に入れる
    const globalBusy = [];
    closeBlockSnap.forEach(doc => {
      const b = doc.data();
      if (b.dateKey && b.dateKey !== dateKey) return;
      const bs = hhmmToMin(b.start || settings.openTime  || '10:00');
      const be = hhmmToMin(b.end   || settings.closeTime || '19:00');
      globalBusy.push({ startMin: bs, endMin: be });
    });

    const dObj = new Date(dateKey + 'T12:00:00+09:00');
    const dow = dObj.getDay();
    const wcExceptions = Array.isArray(settings.weeklyCloseExceptions)
      ? settings.weeklyCloseExceptions : [];
    const isWcException = wcExceptions.indexOf(dateKey) >= 0;
    const weeklyClose = settings.weeklyClose || [];
    if (!isWcException) {
      for (const wc of weeklyClose) {
        if (wc && wc.dow === dow) {
          globalBusy.push({ startMin: hhmmToMin(wc.start), endMin: hhmmToMin(wc.end) });
        }
      }
    }

    const closedDows = settings.closedDows || [];
    if (closedDows.indexOf(dow) >= 0) {
      return { dateKey, slots: [] };
    }

    const now = new Date();
    const todayKey = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0')
    ].join('-');
    const nowMin = (dateKey === todayKey) ? (now.getHours() * 60 + now.getMinutes()) : -1;

    // ===== スロット判定 =====
    const slots = [];
    for (let t = openMin; t <= latestStart; t += slotMin) {
      const slotStart = t;
      const slotEnd   = t + needMin + intervalAfter;
      let available = true;

      // 過去スロットはスキップ
      if (nowMin >= 0 && slotStart <= nowMin) { available = false; }

      // グローバルブロック（closeBlocks / weeklyClose）チェック
      if (available) {
        for (const b of globalBusy) {
          if (slotStart < b.endMin && slotEnd > b.startMin) { available = false; break; }
        }
      }

      if (available) {
        // このスロットで各予約と重なるか
        const conflictAppts = busyAppts.filter(a =>
          slotStart < a.endMin && slotEnd > a.startMin
        );

        if (isPhase1Menu) {
          // ===== フェーズ1互換: staffId='owner' の予約が1件でもあれば埋まり =====
          const ownerBusy = conflictAppts.some(a => a.staffId === 'owner');
          if (ownerBusy) { available = false; }
        } else {
          // ===== フェーズ2: スタッフ・場所・機器をそれぞれチェック =====

          // ① スタッフ: eligibleStaffIds のうち出勤中かつ空きがある人が1人以上
          const busyStaffIds = new Set(conflictAppts.map(a => a.staffId));
          // I-step8: nominatedStaffId が指定されている場合はそのスタッフのみで判定
          const targetStaffIds = (nominatedStaffId && eligibleStaffIds.includes(nominatedStaffId))
            ? [nominatedStaffId]
            : eligibleStaffIds;
          const availableStaff = targetStaffIds.filter(sid =>
            shiftSet.has(sid) && !busyStaffIds.has(sid)
          );
          if (availableStaff.length === 0) { available = false; }

          // ② 場所: eligibleSpaceIds のうち空きがある場所が1つ以上（未設定なら無視）
          if (available && eligibleSpaceIds.length > 0) {
            const busySpaceIds = new Set(conflictAppts.map(a => a.spaceId).filter(Boolean));
            const availableSpaces = eligibleSpaceIds.filter(sid => !busySpaceIds.has(sid));
            if (availableSpaces.length === 0) { available = false; }
          }

          // ③ 機器: eligibleEquipmentIds のうち空きがある機器が1つ以上（未設定なら無視）
          if (available && eligibleEquipmentIds.length > 0) {
            const busyEquipIds = new Set(
              conflictAppts.map(a => a.equipmentId).filter(Boolean)
            );
            const availableEquips = eligibleEquipmentIds.filter(eid => !busyEquipIds.has(eid));
            if (availableEquips.length === 0) { available = false; }
          }
        }
      }

      slots.push({ start: minToHHMM(slotStart), available });
    }

    return { dateKey, slots };
  }
);

function hhmmToMin(s) {
  if (!s) return NaN;
  const parts = String(s).split(':');
  if (parts.length < 2) return NaN;
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}
function minToHHMM(m) {
  const h  = Math.floor(m / 60);
  const mi = m % 60;
  return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
}

// ========================================
// resolveOrClaimCustomer (callable Function)
// ========================================
exports.resolveOrClaimCustomer = onCall(
  { region: 'asia-northeast1' },
  async (request) => {
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
      throw new HttpsError('failed-precondition', 'メールアドレスが取得できませんでした');
    }

    const data = request.data || {};
    const salonId = data.salonId;
    const name = (data.name || '').trim();
    const phone = (data.phone || '').trim();

    if (!salonId || typeof salonId !== 'string') {
      throw new HttpsError('invalid-argument', 'salonId が指定されていません');
    }

    logger.info('resolveOrClaimCustomer called', { uid, email, salonId });

    const salonDocRef = db.collection('salons').doc(salonId);
    const salonDocSnap = await salonDocRef.get();
    if (!salonDocSnap.exists) {
      logger.warn('salon document does not exist', { salonId, uid });
      throw new HttpsError(
        'invalid-argument',
        '指定されたサロンが存在しません。URLを確認してください。'
      );
    }

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

    if (unclaimedCandidates.length === 1) {
      const candidateId = unclaimedCandidates[0].id;
      const candidateRef = customersRef.doc(candidateId);

      try {
        await db.runTransaction(async (tx) => {
          const freshDoc = await tx.get(candidateRef);
          if (!freshDoc.exists) {
            throw new HttpsError('not-found', '候補カルテが見つかりません');
          }
          const fresh = freshDoc.data();
          if (fresh.authUid != null || fresh.isMerged === true) {
            throw new HttpsError('aborted', 'CANDIDATE_STATE_CHANGED');
          }

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
          logger.warn('Candidate state changed during tx, retrying as new', { uid, salonId });
          return await createNewCustomerAndReturn(
            db, salonId, customersRef, authIndexRef, uid, email, name, phone, false, []
          );
        }
        logger.error('claim transaction failed', { uid, salonId, error: txErr.message });
        throw new HttpsError('internal', 'claim 処理に失敗しました: ' + txErr.message);
      }

      let claimedCount = 0;
      try {
        claimedCount = await backfillAuthUidOnPastAppointments(
          db, salonId, candidateId, uid
        );
      } catch (backfillErr) {
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

    if (unclaimedCandidates.length === 0) {
      return await createNewCustomerAndReturn(
        db, salonId, customersRef, authIndexRef,
        uid, email, name, phone, false, []
      );
    }

    const candidateIds = unclaimedCandidates.map((c) => c.id);
    return await createNewCustomerAndReturn(
      db, salonId, customersRef, authIndexRef,
      uid, email, name, phone, true, candidateIds
    );
  }
);

async function createNewCustomerAndReturn(
  db, salonId, customersRef, authIndexRef,
  uid, email, name, phone,
  needsMergeReview, candidateIdsToFlag
) {
  const newDocRef = customersRef.doc();
  const newDocId = newDocRef.id;

  try {
    await db.runTransaction(async (tx) => {
      const freshIndex = await tx.get(authIndexRef);
      if (freshIndex.exists) {
        throw new HttpsError('aborted', 'INDEX_ALREADY_EXISTS');
      }

      const candidateRefs = candidateIdsToFlag.map((id) => customersRef.doc(id));
      const candidateDocs = [];
      for (let i = 0; i < candidateRefs.length; i++) {
        const d = await tx.get(candidateRefs[i]);
        candidateDocs.push(d);
      }

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

      tx.set(authIndexRef, {
        customerDocId: newDocId,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

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

async function backfillAuthUidOnPastAppointments(db, salonId, customerDocId, uid) {
  const collectionsToProcess = ['appointments', 'appointments_archive'];
  let totalUpdated = 0;

  for (let ci = 0; ci < collectionsToProcess.length; ci++) {
    const colName = collectionsToProcess[ci];
    const colRef = db.collection('salons').doc(salonId).collection(colName);

    const snap = await colRef.where('customerDocId', '==', customerDocId).get();

    let batch = db.batch();
    let opsInBatch = 0;

    for (const doc of snap.docs) {
      const a = doc.data();
      if (a.authUid != null) continue;

      batch.update(doc.ref, {
        authUid: uid,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      opsInBatch++;
      totalUpdated++;

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

// ========================================
// ========================================
// Stripe 課金（Phase G / G-3）
//   追加日: 2026/6/4
//
//   関数:
//     A. createSalonCheckoutSession (callable)
//        - ログイン済みサロンオーナーが呼ぶ
//        - 14日トライアル付きサブスクの Checkout ページURLを返す
//     B. stripeWebhook (onRequest)
//        - Stripe からの通知を受けて config/settings の
//          planStatus / stripeCustomerId / stripeSubscriptionId を更新
//
//   設計方針:
//     - トライアル期間(14日)は Stripe 側 (trial_period_days) が管理。
//       TORITA 側で日付計算しない。
//     - salonId == Auth UID (Phase1)。client_reference_id に salonId を入れ、
//       Webhook で受け取って salons/{salonId}/config/settings に書き戻す。
//     - planStatus の値:
//         'trial'    … トライアル中（カード登録済み・未課金）
//         'active'   … 課金中（正常）
//         'past_due' … 支払い失敗
//         'canceled' … 解約済み
//
//   必要な Secret:
//     STRIPE_SECRET_KEY        … sk_test_... / sk_live_...
//     STRIPE_WEBHOOK_SECRET    … whsec_...（Webhook 登録後に取得して登録）
//
//   環境変数（GitHub Actions / functions のデプロイ時に設定）:
//     STRIPE_PRICE_ID          … price_...（テスト/本番で切替）
//     APP_BASE_URL             … https://torita-app.com
// ========================================

const Stripe = require('stripe');

// ----- 設定値（秘密情報ではないので直書き）-----
//   ★ 本番リリース時に TEST → LIVE の price_ID へ1行差し替える。
//      テスト: price_1TeJD5L5ab685f4daJW8vvOh
//      本番:   price_1TeJ3BL5ab685f4d1EkdnmuT
const STRIPE_PRICE_ID = 'price_1TeJ3BL5ab685f4d1EkdnmuT'; // 本番用
const APP_BASE_URL = 'https://torita-app.com';

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not configured');
  return new Stripe(key, { apiVersion: '2024-06-20' });
}

// --- A. Checkout セッション作成 (callable) ---
exports.createSalonCheckoutSession = onCall(
  { secrets: ['STRIPE_SECRET_KEY'] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'ログインが必要です。');
    }
    const uid = request.auth.uid;
    const email = (request.auth.token && request.auth.token.email) || '';

    // salonId == Auth UID (Phase1)
    const salonId = uid;

    const priceId = STRIPE_PRICE_ID;
    if (!priceId) {
      throw new HttpsError('failed-precondition', 'STRIPE_PRICE_ID が未設定です。');
    }
    const baseUrl = APP_BASE_URL;

    const stripe = getStripe();

    try {
      // 既に stripeCustomerId があれば再利用する
      const settingsRef = db.collection('salons').doc(salonId)
        .collection('config').doc('settings');
      const settingsSnap = await settingsRef.get();
      const settings = settingsSnap.exists ? settingsSnap.data() : {};

      let customerId = settings.stripeCustomerId || null;

      if (!customerId) {
        const customer = await stripe.customers.create({
          email: email,
          metadata: { salonId: salonId }
        });
        customerId = customer.id;
        // この時点で customerId だけ先に保存（重複作成防止）
        await settingsRef.set(
          { stripeCustomerId: customerId },
          { merge: true }
        );
      }

      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: customerId,
        client_reference_id: salonId,
        line_items: [{ price: priceId, quantity: 1 }],
        subscription_data: {
          trial_period_days: 14,
          metadata: { salonId: salonId }
        },
        success_url: baseUrl + '/salon_dashboard_v1.html?checkout=success',
        cancel_url: baseUrl + '/salon_billing_v1.html?checkout=cancel'
      });

      logger.info('Checkout session created', { salonId, sessionId: session.id });
      return { url: session.url };
    } catch (err) {
      logger.error('createSalonCheckoutSession error', { error: err.message, salonId });
      throw new HttpsError('internal', '決済ページの作成に失敗しました: ' + err.message);
    }
  }
);

// --- B. Stripe Webhook 受信 (onRequest) ---
exports.stripeWebhook = onRequest(
  { secrets: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'] },
  async (req, res) => {
    const stripe = getStripe();
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
      // 署名検証には raw body が必要。v2 onRequest は req.rawBody を提供する。
      const sig = req.headers['stripe-signature'];
      event = stripe.webhooks.constructEvent(req.rawBody, sig, webhookSecret);
    } catch (err) {
      logger.error('Webhook signature verification failed', { error: err.message });
      res.status(400).send('Webhook Error: ' + err.message);
      return;
    }

    try {
      switch (event.type) {

        // サブスク作成・更新（トライアル開始/課金/状態変化）
        case 'customer.subscription.created':
        case 'customer.subscription.updated': {
          const sub = event.data.object;
          const salonId = (sub.metadata && sub.metadata.salonId) || null;
          if (salonId) {
            await applySubscriptionState(salonId, sub);
          } else {
            logger.warn('subscription event without salonId metadata', { id: sub.id });
          }
          break;
        }

        // サブスク解約
        case 'customer.subscription.deleted': {
          const sub = event.data.object;
          const salonId = (sub.metadata && sub.metadata.salonId) || null;
          if (salonId) {
            await db.collection('salons').doc(salonId)
              .collection('config').doc('settings')
              .set({
                planStatus: 'canceled',
                stripeSubscriptionId: sub.id,
                planUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
              }, { merge: true });
            logger.info('subscription canceled', { salonId });
          }
          break;
        }

        // 支払い失敗
        case 'invoice.payment_failed': {
          const invoice = event.data.object;
          const salonId = await salonIdFromCustomer(invoice.customer);
          if (salonId) {
            await db.collection('salons').doc(salonId)
              .collection('config').doc('settings')
              .set({
                planStatus: 'past_due',
                planUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
              }, { merge: true });
            logger.info('payment failed', { salonId });
          }
          break;
        }

        default:
          // 他イベントは無視
          break;
      }

      res.status(200).json({ received: true });
    } catch (err) {
      logger.error('stripeWebhook handler error', { error: err.message, type: event.type });
      res.status(500).send('Handler Error');
    }
  }
);

// サブスクの status を planStatus に反映する
async function applySubscriptionState(salonId, sub) {
  // Stripe status: trialing / active / past_due / canceled / unpaid / incomplete...
  let planStatus;
  if (sub.status === 'trialing') {
    planStatus = 'trial';
  } else if (sub.status === 'active') {
    planStatus = 'active';
  } else if (sub.status === 'past_due' || sub.status === 'unpaid') {
    planStatus = 'past_due';
  } else if (sub.status === 'canceled' || sub.status === 'incomplete_expired') {
    planStatus = 'canceled';
  } else {
    planStatus = sub.status; // incomplete 等はそのまま
  }

  const update = {
    planStatus: planStatus,
    stripeSubscriptionId: sub.id,
    stripeCustomerId: sub.customer,
    planUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
  // トライアル終了予定（参考表示用。判定には使わない）
  if (sub.trial_end) {
    update.trialEndsAt = admin.firestore.Timestamp.fromMillis(sub.trial_end * 1000);
  }

  await db.collection('salons').doc(salonId)
    .collection('config').doc('settings')
    .set(update, { merge: true });

  logger.info('subscription state applied', { salonId, planStatus });
}

// ========================================
// createCustomerPortalSession (callable)
// 追加日: 2026/6/7
// サロンオーナーが「プラン・解約」ボタンをタップした際に
// Stripe カスタマーポータルのセッション URL を発行する。
// ========================================

exports.createCustomerPortalSession = onCall(
  { secrets: ['STRIPE_SECRET_KEY'] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'ログインが必要です。');
    }
    const uid = request.auth.uid;
    const salonId = uid;

    const stripe = getStripe();

    const settingsSnap = await db.collection('salons').doc(salonId)
      .collection('config').doc('settings').get();

    if (!settingsSnap.exists) {
      throw new HttpsError('not-found', 'サロン設定が見つかりません。');
    }

    const customerId = (settingsSnap.data().stripeCustomerId) || null;
    if (!customerId) {
      throw new HttpsError(
        'failed-precondition',
        'Stripe 顧客情報が見つかりません。先にプランへご登録ください。'
      );
    }

    try {
      const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: APP_BASE_URL + '/salon_dashboard_v1.html',
      });
      logger.info('Customer portal session created', { salonId, sessionId: session.id });
      return { url: session.url };
    } catch (err) {
      logger.error('createCustomerPortalSession error', { error: err.message, salonId });
      throw new HttpsError('internal', 'ポータルの起動に失敗しました: ' + err.message);
    }
  }
);

// stripeCustomerId から salonId を逆引き（metadata 優先、無ければ Firestore 検索）
async function salonIdFromCustomer(customerId) {
  if (!customerId) return null;
  try {
    const stripe = getStripe();
    const customer = await stripe.customers.retrieve(customerId);
    if (customer && customer.metadata && customer.metadata.salonId) {
      return customer.metadata.salonId;
    }
  } catch (e) {
    logger.warn('salonIdFromCustomer retrieve failed', { error: e.message });
  }
  return null;
}

// ========================================
// executeMergeCustomers (callable Function)
// Phase G / 顧客統合機能
// 追加日: 2026/6/7
//
// 処理の流れ:
//   1. 引数バリデーション（keepId / removeId / 選択フィールド）
//   2. mergeJobs に job ドキュメント作成（lockedByJob で排他）
//   3. keepDoc / removeDoc を Firestore から取得・検証
//   4. keep カルテを更新（name/phone/memo/stampCount を選択値で上書き）
//   5. appointments / appointments_archive の customerDocId を付け替え
//      （バッチ処理、450件ごとにコミット）
//   6. remove カルテを isMerged=true でマーク
//   7. authIndex の整合: removeDoc に authUid があった場合、
//      その authUid の authIndex を keepId に書き換え
//   8. mergeJobs を completed に更新
//
// セキュリティ:
//   - サロンオーナー（salonId == uid）のみ呼べる
//   - Admin SDK 使用 → Firestore Rules をバイパス
//   - lockedByJob フィールドで同時実行を防ぐ
// ========================================

exports.executeMergeCustomers = onCall(
  { region: 'asia-northeast1' },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'ログインが必要です。');
    }
    const uid = request.auth.uid;

    const data = request.data || {};
    const salonId   = data.salonId;
    const keepId    = data.keepId;
    const removeId  = data.removeId;

    const pickName  = data.pickName  || 'keep';
    const pickPhone = data.pickPhone || 'keep';
    const pickMemo  = data.pickMemo  || 'keep';

    // ---------- バリデーション ----------
    if (!salonId || typeof salonId !== 'string') {
      throw new HttpsError('invalid-argument', 'salonId が不正です。');
    }
    if (salonId !== uid) {
      throw new HttpsError('permission-denied', 'オーナー本人のみ操作できます。');
    }
    if (!keepId || typeof keepId !== 'string') {
      throw new HttpsError('invalid-argument', 'keepId が不正です。');
    }
    if (!removeId || typeof removeId !== 'string') {
      throw new HttpsError('invalid-argument', 'removeId が不正です。');
    }
    if (keepId === removeId) {
      throw new HttpsError('invalid-argument', '同じカルテを指定しています。');
    }
    if (['keep', 'remove'].indexOf(pickName)  < 0 ||
        ['keep', 'remove'].indexOf(pickPhone) < 0 ||
        ['keep', 'remove'].indexOf(pickMemo)  < 0) {
      throw new HttpsError('invalid-argument', 'pick フィールドの値が不正です。');
    }

    logger.info('executeMergeCustomers called', { uid, salonId, keepId, removeId });

    const salonRef      = db.collection('salons').doc(salonId);
    const customersRef  = salonRef.collection('customers');
    const keepRef       = customersRef.doc(keepId);
    const removeRef     = customersRef.doc(removeId);
    const mergeJobsRef  = salonRef.collection('mergeJobs');

    // ---------- 事前チェック ----------
    const keepSnap   = await keepRef.get();
    const removeSnap = await removeRef.get();

    if (!keepSnap.exists) {
      throw new HttpsError('not-found', '残すカルテが存在しません。');
    }
    if (!removeSnap.exists) {
      throw new HttpsError('not-found', '取り込むカルテが存在しません。');
    }

    const keepDoc   = keepSnap.data();
    const removeDoc = removeSnap.data();

    if (keepDoc.isMerged === true) {
      throw new HttpsError('failed-precondition', '残すカルテはすでに統合済みです。');
    }
    if (removeDoc.isMerged === true) {
      throw new HttpsError('failed-precondition', '取り込むカルテはすでに統合済みです。');
    }
    if (keepDoc.lockedByJob || removeDoc.lockedByJob) {
      throw new HttpsError('failed-precondition', '別の統合処理が進行中です。しばらく待ってから再試行してください。');
    }

    // ---------- mergeJob 作成 & ロック ----------
    const jobRef = mergeJobsRef.doc();
    const jobId  = jobRef.id;

    await jobRef.set({
      keepId:    keepId,
      removeId:  removeId,
      status:    'running',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await keepRef.update({ lockedByJob: jobId });
    await removeRef.update({ lockedByJob: jobId });

    try {
      // ---------- keep カルテの更新値を決定 ----------
      const newName  = (pickName  === 'remove') ? (removeDoc.name  || '') : (keepDoc.name  || '');
      const newPhone = (pickPhone === 'remove') ? (removeDoc.phone || '') : (keepDoc.phone || '');
      const newMemo  = (pickMemo  === 'remove') ? (removeDoc.memo  || '') : (keepDoc.memo  || '');

      const keepStamp   = (typeof keepDoc.stampCount   === 'number') ? keepDoc.stampCount   : 0;
      const removeStamp = (typeof removeDoc.stampCount === 'number') ? removeDoc.stampCount : 0;
      const newStamp    = keepStamp + removeStamp;

      const existingAliases = Array.isArray(keepDoc.mergedAliases) ? keepDoc.mergedAliases : [];
      const newAlias = {
        customerDocId: removeId,
        name:     removeDoc.name  || '',
        phone:    removeDoc.phone || '',
        mergedAt: new Date().toISOString()
      };

      // ---------- keep カルテ更新 ----------
      await keepRef.update({
        name:             newName,
        phone:            newPhone,
        memo:             newMemo,
        stampCount:       newStamp,
        isMerged:         false,
        needsMergeReview: false,
        mergedAliases:    existingAliases.concat([newAlias]),
        lockedByJob:      null,
        updatedAt:        admin.firestore.FieldValue.serverTimestamp()
      });

      // ---------- appointments / appointments_archive の customerDocId 付け替え ----------
      const collections = ['appointments', 'appointments_archive'];
      var totalUpdated = 0;

      for (var ci = 0; ci < collections.length; ci++) {
        const colRef = salonRef.collection(collections[ci]);
        const snap   = await colRef.where('customerDocId', '==', removeId).get();

        let batch      = db.batch();
        let opsInBatch = 0;

        for (const doc of snap.docs) {
          batch.update(doc.ref, {
            customerDocId: keepId,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
          opsInBatch++;
          totalUpdated++;

          if (opsInBatch >= 450) {
            await batch.commit();
            batch      = db.batch();
            opsInBatch = 0;
          }
        }
        if (opsInBatch > 0) {
          await batch.commit();
        }

        logger.info('appointments relinked', {
          salonId, collection: collections[ci], count: snap.size
        });
      }

      // ---------- authIndex 整合 ----------
      const removeAuthUid = removeDoc.authUid || null;
      if (removeAuthUid) {
        const authIndexRef = salonRef.collection('authIndex').doc(removeAuthUid);
        await authIndexRef.set({
          customerDocId: keepId,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        logger.info('authIndex relinked', { salonId, authUid: removeAuthUid, newDocId: keepId });
      }

      // ---------- remove カルテを isMerged=true でマーク ----------
      await removeRef.update({
        isMerged:    true,
        mergedInto:  keepId,
        mergedAt:    admin.firestore.FieldValue.serverTimestamp(),
        lockedByJob: null,
        updatedAt:   admin.firestore.FieldValue.serverTimestamp()
      });

      // ---------- mergeJob を completed に ----------
      await jobRef.update({
        status:              'completed',
        appointmentsUpdated: totalUpdated,
        completedAt:         admin.firestore.FieldValue.serverTimestamp()
      });

      logger.info('executeMergeCustomers completed', {
        salonId, keepId, removeId, totalUpdated
      });

      return {
        result:              'merged',
        keepId:              keepId,
        appointmentsUpdated: totalUpdated
      };

    } catch (err) {
      logger.error('executeMergeCustomers error', { error: err.message, stack: err.stack });

      try {
        await keepRef.update({ lockedByJob: null });
        await removeRef.update({ lockedByJob: null });
        await jobRef.update({
          status:       'failed',
          errorMessage: err.message,
          failedAt:     admin.firestore.FieldValue.serverTimestamp()
        });
      } catch (cleanupErr) {
        logger.error('cleanup failed', { error: cleanupErr.message });
      }

      throw new HttpsError('internal', '統合処理に失敗しました: ' + err.message);
    }
  }
);
