const USER_BUTTONS = [
  [{ text: "👤 پروفایل من", callback_data: "act:profile" },
   { text: "💌 ثبت پست کراش", callback_data: "act:crush_post" }],
  [{ text: "🎭 ارتباط ناشناس", callback_data: "act:anonymous" },
   { text: "🤝 درخواست‌های ارتباط از کانال", callback_data: "act:connections" }],
  [{ text: "📢 ثبت درخواست تبلیغات", callback_data: "act:ads" },
   { text: "📖 راهنما و قوانین", callback_data: "act:rules" }]
];

const ADMIN_BUTTONS = [
  [{ text: "🔎 بررسی پیام‌های ناشناس", callback_data: "act:moderation" }],
  [{ text: "🗂 آرشیو پیام‌های ناشناس", callback_data: "act:message_archive" }],
  [{ text: "📢 درخواست‌های تبلیغات", callback_data: "act:ad_requests" }],
  [{ text: "🗃 آرشیو پیام‌های کانال", callback_data: "act:channel_archive" }],
  [{ text: "💬 آرشیو چت‌های کاربران", callback_data: "act:chat_archive" }],
  [{ text: "🎭 آرشیو ارتباط ناشناس", callback_data: "act:anonymous_chat_archive" }],
  [{ text: "📣 پیام همگانی", callback_data: "act:broadcast" }],
  [{ text: "📖 ویرایش راهنما و قوانین", callback_data: "act:edit_rules" }],
  [{ text: "🔗 عضویت اجباری", callback_data: "act:forced_membership" }],
  [{ text: "⚙️ تنظیمات ربات", callback_data: "act:settings" }],
  [{ text: "👥 مدیریت ادمین‌ها", callback_data: "act:admin_management" }]
];

export function buildNavigationPage(page, { isStaff = false, isOwner = false } = {}) {
  if (page === "admin" && isStaff) {
    return {
      text: isOwner
        ? "🛠 پنل مدیریت مالک اصلی"
        : "🛠 پنل مدیریت ادمین",
      keyboard: [
        ...ADMIN_BUTTONS,
        [{ text: "⬅️ بازگشت به منوی کاربر", callback_data: "nav:home" }]
      ]
    };
  }

  if (page === "home") {
    const keyboard = USER_BUTTONS.map(row => row.map(button => ({ ...button })));

    if (isStaff) {
      keyboard.push([
        { text: "🛠 پنل مدیریت", callback_data: "nav:admin" }
      ]);
    }

    return {
      text: "👋 سلام، به کراش‌یاب ادیب خوش اومدی!\n\nاز دکمه‌های زیر برای انتخاب بخش موردنظرت استفاده کن.",
      keyboard
    };
  }

  return {
    text: "این صفحه در دسترس نیست.",
    keyboard: [[{ text: "🏠 منوی اصلی", callback_data: "nav:home" }]]
  };
}

export function buildPlaceholderPage(action, { isStaff = false, isOwner = false } = {}) {
  const labels = {
    profile: "👤 پروفایل من",
    crush_post: "💌 ثبت پست کراش",
    anonymous: "🎭 ارتباط ناشناس",
    connections: "🤝 درخواست‌های ارتباط از کانال",
    ads: "📢 ثبت درخواست تبلیغات",
    rules: "📖 راهنما و قوانین",
    moderation: "🔎 بررسی پیام‌های ناشناس",
    message_archive: "🗂 آرشیو پیام‌های ناشناس",
    ad_requests: "📢 درخواست‌های تبلیغات",
    channel_archive: "🗃 آرشیو پیام‌های کانال",
    chat_archive: "💬 آرشیو چت‌های کاربران",
    anonymous_chat_archive: "🎭 آرشیو ارتباط ناشناس",
    broadcast: "📣 پیام همگانی",
    edit_rules: "📖 ویرایش راهنما و قوانین",
    forced_membership: "🔗 عضویت اجباری",
    settings: "⚙️ تنظیمات ربات",
    admin_management: "👥 مدیریت ادمین‌ها"
  };

  const label = labels[action];
  if (!label) return null;

  const adminActions = new Set([
    "moderation", "message_archive", "ad_requests", "channel_archive",
    "chat_archive", "anonymous_chat_archive", "broadcast", "edit_rules",
    "forced_membership", "settings", "admin_management"
  ]);

  if (adminActions.has(action) && !isStaff) return null;
  if (action === "forced_membership" || action === "broadcast" ||
      action === "edit_rules" || action === "settings" ||
      action === "admin_management" || action === "channel_archive" ||
      action === "chat_archive" || action === "anonymous_chat_archive") {
    if (!isOwner) return null;
  }

  return {
    text: `${label}\n\nاین بخش هنوز به گردش‌کار اصلی متصل نشده است.`,
    keyboard: [[
      {
        text: "⬅️ بازگشت",
        callback_data: adminActions.has(action) ? "nav:admin" : "nav:home"
      }
    ], [
      { text: "🏠 منوی اصلی", callback_data: "nav:home" }
    ]]
  };
}
