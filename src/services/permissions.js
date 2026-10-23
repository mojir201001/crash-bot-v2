export async function getUserRole(env, userId) {
  if (String(userId) === String(env.OWNER_TELEGRAM_ID)) {
    return "owner";
  }

  const result = await env.CRASH_BOT_DB.prepare(`
    SELECT user_id
    FROM admin_roles
    WHERE user_id = ?
  `).bind(userId).first();

  return result ? "admin" : "user";
}

export function canAccess(role, permission) {
  const permissions = {
    owner: ["admin_panel", "moderation", "message_archive", "ad_requests", "channel_archive", "chat_archive", "anonymous_chat_archive", "broadcast", "edit_rules", "forced_membership", "settings", "admin_management"],
    admin: ["admin_panel", "moderation", "message_archive", "ad_requests"],
    user: []
  };

  return permissions[role]?.includes(permission) ?? false;
}
