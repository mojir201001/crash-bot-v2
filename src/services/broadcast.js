import {
  answerCallbackQuery,
  sendMediaTelegramDetailed,
  sendMessageTelegramDetailed,
  sendTrackedSectionInlineTelegram,
  sendTrackedSectionNoticeTelegram
} from "../telegram/api.js";

const BATCH_SIZE = 20;
const MAX_TEXT_LENGTH = 4000;
const MAX_CAPTION_LENGTH = 1000;
const SEND_INTERVAL_MS = 50;
const MEDIA_METHODS = {
  photo: "sendPhoto",
  video: "sendVideo",
  document: "sendDocument",
  audio: "sendAudio",
  voice: "sendVoice",
  animation: "sendAnimation"
};

function pendingKey(ownerId) {
  return `broadcast_input:${String(ownerId)}`;
}

function textFromMessage(message) {
  return String(message?.text ?? message?.caption ?? "").trim();
}

function mediaFromMessage(message) {
  const photo = Array.isArray(message?.photo) ? message.photo.at(-1) : null;
  if (photo?.file_id) return { type: "photo", fileId: photo.file_id };
  for (const type of Object.keys(MEDIA_METHODS).filter((item) => item !== "photo")) {
    if (message?.[type]?.file_id) {
      return { type, fileId: message[type].file_id };
    }
  }
  return null;
}

function validOwner(env, ownerId, chatId) {
  return String(ownerId) === String(env.OWNER_TELEGRAM_ID) &&
    String(chatId) === String(ownerId);
}

async function sendCampaignMedia(env, chatId, mediaType, fileId, caption = "") {
  const method = MEDIA_METHODS[mediaType];
  if (!method) return { outcome: "rejected" };
  return sendMediaTelegramDetailed(env, method, {
    chat_id: chatId,
    [mediaType]: fileId,
    ...(caption ? { caption: caption.slice(0, MAX_CAPTION_LENGTH) } : {})
  });
}

async function displayCampaign(env, ownerId, chatId, campaignId) {
  const campaign = await env.CRASH_BOT_DB.prepare(`
    SELECT id, content, media_type, media_file_id, caption, status, recipient_count
    FROM broadcast_campaigns WHERE id = ? AND created_by = ?
  `).bind(campaignId, ownerId).first();
  if (!campaign) return false;

  const keyboard = [];
  if (campaign.status === "draft") {
    keyboard.push([{ text: "✅ تأیید نهایی و ارسال", callback_data: `broadcast:send:${campaign.id}` }]);
    keyboard.push([{ text: "لغو پیش‌نویس", callback_data: `broadcast:cancel:${campaign.id}` }]);
  } else if (campaign.status === "paused") {
    keyboard.push([{ text: "ادامهٔ گیرندگان باقی‌مانده", callback_data: `broadcast:continue:${campaign.id}` }]);
  } else if (campaign.status === "sending") {
    keyboard.push([{ text: "بررسی/ادامهٔ کنترل‌شده", callback_data: `broadcast:continue:${campaign.id}` }]);
  } else {
    keyboard.push([{ text: "🔄 به‌روزرسانی وضعیت", callback_data: `broadcast:view:${campaign.id}` }]);
  }

  const summary = await campaignSummary(env, campaign.id);
  const preview = [
    `📣 کمپین #${campaign.id} — ${campaign.status}`,
    campaign.content || campaign.caption || (campaign.media_type ? `رسانه: ${campaign.media_type}` : ""),
    "",
    `گیرندگان: ${summary.total}`,
    `موفق: ${summary.sent} · ناموفق: ${summary.failed} · نامشخص: ${summary.unknown} · باقی‌مانده: ${summary.pending + summary.sending}`
  ].join("\n").slice(0, 3800);

  if (campaign.media_type && campaign.media_file_id) {
    await sendCampaignMedia(env, chatId, campaign.media_type, campaign.media_file_id, campaign.caption || "");
  }
  const sent = await sendTrackedSectionInlineTelegram(env, chatId, preview, keyboard);
  if (!sent) throw new Error("Could not display broadcast campaign");
  return true;
}

async function campaignSummary(env, campaignId) {
  const row = await env.CRASH_BOT_DB.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status = 'unknown' THEN 1 ELSE 0 END) AS unknown,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'sending' THEN 1 ELSE 0 END) AS sending
    FROM broadcast_deliveries WHERE campaign_id = ?
  `).bind(campaignId).first();
  return {
    total: Number(row?.total ?? 0),
    sent: Number(row?.sent ?? 0),
    failed: Number(row?.failed ?? 0),
    unknown: Number(row?.unknown ?? 0),
    pending: Number(row?.pending ?? 0),
    sending: Number(row?.sending ?? 0)
  };
}

export async function startBroadcast(env, ownerId, chatId) {
  if (!validOwner(env, ownerId, chatId)) return false;
  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO bot_settings (key, value, updated_at)
    VALUES (?, '1', CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = CURRENT_TIMESTAMP
  `).bind(pendingKey(ownerId)).run();
  const sent = await sendTrackedSectionNoticeTelegram(
    env,
    chatId,
    "محتوای پیام همگانی را به‌صورت متن یا رسانه بفرست. پیش از ارسال، پیش‌نمایش و تأیید نهایی نمایش داده می‌شود. برای لغو «لغو» بنویس.",
    []
  );
  if (!sent) throw new Error("Could not start broadcast input");
  return true;
}

export async function handleBroadcastMessage(env, message, ownerId, isNavigation = false) {
  if (
    String(ownerId) !== String(env.OWNER_TELEGRAM_ID) ||
    message?.chat?.type !== "private" ||
    String(message?.chat?.id) !== String(ownerId)
  ) return false;
  const pending = await env.CRASH_BOT_DB.prepare(
    "SELECT value FROM bot_settings WHERE key = ?"
  ).bind(pendingKey(ownerId)).first();
  if (!pending) return false;
  const text = textFromMessage(message);
  if (isNavigation || text === "لغو") {
    await env.CRASH_BOT_DB.prepare(
      "DELETE FROM bot_settings WHERE key = ?"
    ).bind(pendingKey(ownerId)).run();
    return false;
  }
  const media = mediaFromMessage(message);
  if (
    (!text && !media) ||
    text.length > MAX_TEXT_LENGTH ||
    (media && text.length > MAX_CAPTION_LENGTH)
  ) {
    await sendTrackedSectionNoticeTelegram(
      env,
      message.chat.id,
      `پیام نامعتبر یا بیش از حد طولانی است. متن حداکثر ${MAX_TEXT_LENGTH} نویسه و کپشن رسانه حداکثر ${MAX_CAPTION_LENGTH} نویسه است.`,
      []
    );
    return true;
  }
  const row = await env.CRASH_BOT_DB.prepare(`
    INSERT INTO broadcast_campaigns
      (created_by, content, media_type, media_file_id, caption, status)
    VALUES (?, ?, ?, ?, ?, 'draft')
    RETURNING id
  `).bind(
    ownerId,
    text,
    media?.type ?? null,
    media?.fileId ?? null,
    message?.caption ?? null
  ).first();
  await env.CRASH_BOT_DB.prepare(
    "DELETE FROM bot_settings WHERE key = ?"
  ).bind(pendingKey(ownerId)).run();
  if (!row?.id) throw new Error("Could not create broadcast campaign");
  const recipients = await env.CRASH_BOT_DB.prepare(`
    SELECT COUNT(*) AS total FROM users
    WHERE started_at IS NOT NULL
      AND is_blocked = 0
      AND account_status = 'active'
      AND telegram_id <> ?
  `).bind(Number(ownerId)).first();
  await sendTrackedSectionInlineTelegram(
    env,
    message.chat.id,
    `پیش‌نمایش پیام همگانی\nگیرندگان واجد شرایط فعلی: ${Number(recipients?.total ?? 0)}\n\n${text || `رسانه: ${media.type}`}`,
    [[
      { text: "✅ تأیید نهایی و ارسال", callback_data: `broadcast:send:${row.id}` },
      { text: "لغو پیش‌نویس", callback_data: `broadcast:cancel:${row.id}` }
    ]]
  );
  if (media) {
    await sendCampaignMedia(env, message.chat.id, media.type, media.fileId, text);
  }
  return true;
}

async function claimNextDelivery(env, campaignId) {
  const claimToken = crypto.randomUUID();
  return env.CRASH_BOT_DB.prepare(`
    UPDATE broadcast_deliveries
    SET status = 'sending', attempts = attempts + 1,
        claim_token = ?, updated_at = CURRENT_TIMESTAMP
    WHERE campaign_id = ? AND user_id = (
      SELECT user_id FROM broadcast_deliveries
      WHERE campaign_id = ? AND status = 'pending'
      ORDER BY user_id LIMIT 1
    )
    AND status = 'pending'
    RETURNING user_id
  `).bind(claimToken, campaignId, campaignId).first();
}

async function sendToRecipient(env, campaign, recipientId) {
  if (!campaign.media_type) {
    return sendMessageTelegramDetailed(env, recipientId, campaign.content);
  }
  const method = MEDIA_METHODS[campaign.media_type];
  if (!method) return { outcome: "rejected" };
  return sendMediaTelegramDetailed(env, method, {
    chat_id: recipientId,
    [campaign.media_type]: campaign.media_file_id,
    ...(campaign.caption ? { caption: campaign.caption } : {})
  });
}

async function processCampaignBatch(env, campaignId) {
  const processingToken = crypto.randomUUID();
  const claimed = await env.CRASH_BOT_DB.prepare(`
    UPDATE broadcast_campaigns
    SET processing_token = ?, processing_until = datetime('now', '+15 minutes')
    WHERE id = ? AND status = 'sending'
      AND (processing_token IS NULL OR processing_until < CURRENT_TIMESTAMP)
    RETURNING id, created_by, content, media_type, media_file_id, caption, status
  `).bind(processingToken, campaignId).first();
  if (!claimed) return false;
  const campaign = claimed;

  await env.CRASH_BOT_DB.prepare(`
    UPDATE broadcast_deliveries
    SET status = 'unknown', claim_token = NULL,
        last_error = 'stale send claim; outcome requires review',
        updated_at = CURRENT_TIMESTAMP
    WHERE campaign_id = ? AND status = 'sending'
      AND updated_at < datetime('now', '-15 minutes')
  `).bind(campaignId).run();

  for (let index = 0; index < BATCH_SIZE; index += 1) {
    const claim = await claimNextDelivery(env, campaignId);
    if (!claim?.user_id) break;
    if (index > 0) {
      await new Promise((resolve) => setTimeout(resolve, SEND_INTERVAL_MS));
    }
    let result;
    try {
      result = await sendToRecipient(env, campaign, claim.user_id);
    } catch {
      result = { outcome: "unknown" };
    }
    const status = result?.outcome === "sent"
      ? "sent"
      : result?.outcome === "rejected"
        ? "failed"
        : "unknown";
    await env.CRASH_BOT_DB.prepare(`
      UPDATE broadcast_deliveries
      SET status = ?, claim_token = NULL, last_error = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE campaign_id = ? AND user_id = ? AND status = 'sending'
    `).bind(
      status,
      status === "failed" ? "Telegram rejected the message" :
        status === "unknown" ? "Delivery outcome is unknown" : null,
      campaignId,
      claim.user_id
    ).run();
  }

  const summary = await campaignSummary(env, campaignId);
  const nextStatus = summary.pending > 0
    ? "paused"
    : summary.sending > 0 || summary.unknown > 0
      ? "unknown"
      : "completed";
  await env.CRASH_BOT_DB.prepare(`
    UPDATE broadcast_campaigns SET status = ?, recipient_count = ?,
      updated_at = CURRENT_TIMESTAMP, processing_token = NULL,
      processing_until = NULL
    WHERE id = ? AND processing_token = ?
  `).bind(nextStatus, summary.total, campaignId, processingToken).run();
  return true;
}

export async function renderBroadcastPanel(env, ownerId, chatId) {
  if (!validOwner(env, ownerId, chatId)) return false;
  const rows = await env.CRASH_BOT_DB.prepare(`
    SELECT id, status, recipient_count, created_at
    FROM broadcast_campaigns
    WHERE created_by = ?
    ORDER BY id DESC LIMIT 5
  `).bind(ownerId).all();
  const keyboard = [[{ text: "📣 شروع پیام همگانی", callback_data: "broadcast:new" }]];
  const campaigns = rows.results ?? [];
  for (const campaign of campaigns) {
    keyboard.push([{
      text: `کمپین #${campaign.id} · ${campaign.status}`,
      callback_data: `broadcast:view:${campaign.id}`
    }]);
  }
  const sent = await sendTrackedSectionInlineTelegram(
    env,
    chatId,
    `📣 پیام همگانی\nگیرندگان: کاربرانی که ربات را شروع کرده‌اند، فعال و مجاز به دریافت پیام هستند؛ مالک کمپین گیرنده نیست.\nارسال با batchهای ${BATCH_SIZE}تایی و سقف ۲۰ پیام در ثانیه انجام می‌شود؛ فقط یک کمپین هم‌زمان ارسال می‌شود. نتیجهٔ نامطمئن خودکار تکرار نمی‌شود.`,
    keyboard
  );
  if (!sent) throw new Error("Could not display broadcast panel");
  return true;
}

export async function handleBroadcastCallback(env, callback) {
  const data = String(callback?.data ?? "");
  if (!/^broadcast:(?:new|send:\d+|continue:\d+|view:\d+|cancel:\d+)$/.test(data)) {
    return false;
  }
  const ownerId = callback?.from?.id;
  const chatId = callback?.message?.chat?.id;
  if (
    !validOwner(env, ownerId, chatId) ||
    callback?.message?.chat?.type !== "private"
  ) {
    await answerCallbackQuery(env, callback.id, "این بخش فقط برای مالک در دسترس است.");
    return true;
  }

  if (data === "broadcast:new") {
    await startBroadcast(env, ownerId, chatId);
  } else {
    const [, action, idText] = data.split(":");
    const campaignId = Number(idText);
    if (!Number.isSafeInteger(campaignId) || campaignId < 1) {
      await answerCallbackQuery(env, callback.id, "شناسهٔ کمپین معتبر نیست.");
      return true;
    }
    const campaign = await env.CRASH_BOT_DB.prepare(`
      SELECT id, status FROM broadcast_campaigns
      WHERE id = ? AND created_by = ?
    `).bind(campaignId, ownerId).first();
    if (!campaign) {
      await answerCallbackQuery(env, callback.id, "کمپین پیدا نشد.");
      return true;
    }
    if (action === "cancel") {
      await env.CRASH_BOT_DB.prepare(`
        UPDATE broadcast_campaigns SET status = 'cancelled',
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND created_by = ? AND status = 'draft'
      `).bind(campaignId, ownerId).run();
    } else if (action === "send" || action === "continue") {
      const active = await env.CRASH_BOT_DB.prepare(`
        SELECT id FROM broadcast_campaigns
        WHERE status = 'sending' AND id <> ? LIMIT 1
      `).bind(campaignId).first();
      if (active) {
        await answerCallbackQuery(env, callback.id, "کمپین دیگری در حال ارسال است؛ پس از پایان دوباره تلاش کن.");
        return true;
      }
      try {
        await env.CRASH_BOT_DB.batch([
          env.CRASH_BOT_DB.prepare(`
            INSERT OR IGNORE INTO broadcast_deliveries (campaign_id, user_id)
            SELECT ?, u.telegram_id FROM users u
            JOIN broadcast_campaigns c ON c.id = ?
            WHERE c.status = 'draft'
              AND u.started_at IS NOT NULL
              AND u.is_blocked = 0
              AND u.account_status = 'active'
              AND u.telegram_id <> c.created_by
          `).bind(campaignId, campaignId),
          env.CRASH_BOT_DB.prepare(`
            UPDATE broadcast_campaigns
            SET status = 'sending', updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND created_by = ?
              AND status IN ('draft', 'paused')
          `).bind(campaignId, ownerId)
        ]);
      } catch (error) {
        if (!String(error?.message ?? "").includes("broadcast_campaigns.status")) {
          throw error;
        }
        await answerCallbackQuery(env, callback.id, "کمپین دیگری هم‌زمان آغاز شد؛ این کمپین هنوز ارسال نشده است.");
        return true;
      }
      await processCampaignBatch(env, campaignId);
    }
    await displayCampaign(env, ownerId, chatId, campaignId);
  }
  await answerCallbackQuery(env, callback.id);
  return true;
}
