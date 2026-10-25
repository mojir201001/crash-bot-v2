const SETTINGS_KEY = "forced_membership_channels";

export async function getRequiredChannels(env) {
  const row = await env.CRASH_BOT_DB.prepare(
    "SELECT value FROM bot_settings WHERE key = ?"
  ).bind(SETTINGS_KEY).first();

  if (!row) return [];
  if (typeof row.value !== "string" || !row.value.trim()) {
    throw new Error("Forced membership settings are empty or invalid");
  }

  let channels;

  try {
    channels = JSON.parse(row.value);
  } catch {
    throw new Error("Invalid forced membership settings JSON");
  }

  if (!Array.isArray(channels)) {
    throw new Error("Forced membership settings must be an array");
  }

  for (const channel of channels) {
    if (
      !channel ||
      typeof channel.chatId !== "string" ||
      !channel.chatId.trim() ||
      typeof channel.inviteUrl !== "string" ||
      !channel.inviteUrl.trim()
    ) {
      throw new Error("Invalid forced membership channel entry");
    }
  }

  return channels;
}

export async function saveRequiredChannels(env, channels) {
  if (!Array.isArray(channels)) {
    throw new Error("Channels must be an array");
  }

  for (const channel of channels) {
    if (
      !channel ||
      typeof channel.chatId !== "string" ||
      !channel.chatId.trim() ||
      typeof channel.inviteUrl !== "string" ||
      !channel.inviteUrl.trim()
    ) {
      throw new Error("Invalid forced membership channel entry");
    }
  }

  const value = JSON.stringify(channels);

  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO bot_settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `).bind(SETTINGS_KEY, value).run();
}

export async function checkRequiredMembership(env, userId) {
  const channels = await getRequiredChannels(env);

  if (channels.length === 0) {
    return { passed: true, missing: [], error: false };
  }

  const missing = [];

  for (const channel of channels) {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getChatMember`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: channel.chatId,
            user_id: Number(userId)
          })
        }
      );

      if (!response.ok) {
        return { passed: false, missing, error: true };
      }

      const result = await response.json();

      if (!result.ok || !result.result) {
        return { passed: false, missing, error: true };
      }

      const member = result.result;
      const isMember =
        ["creator", "administrator", "member"].includes(member.status) ||
        (member.status === "restricted" && member.is_member === true);

      if (!isMember) {
        missing.push(channel);
      }
    } catch {
      return { passed: false, missing, error: true };
    }
  }

  return {
    passed: missing.length === 0,
    missing,
    error: false
  };
}
