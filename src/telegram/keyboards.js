export function userMenu(isStaff) {
  const keyboard = [
    [{ text: "👤 پروفایل من" }, { text: "💌 ثبت پست کراش" }],
    [{ text: "🎭 چت ناشناس تصادفی" }, { text: "🤝 درخواست‌های ارتباط از کانال" }],
    [{ text: "📚 ثبت کراش‌های من" }],
    [{ text: "📢 ثبت درخواست تبلیغات" }, { text: "📖 راهنما و قوانین" }]
  ];
  if (isStaff) keyboard.push([{ text: "🛠 پنل مدیریت" }]);
  return keyboard;
}

export function adminMenu(isOwner) {
  const keyboard = [
    [{ text: "🔎 بررسی پیام‌های ناشناس" }],
    [{ text: "🗂 آرشیو پیام‌های ناشناس" }],
    [{ text: "👤 پنل کاربر" }]
  ];

  if (isOwner) {
    keyboard.splice(2, 0,
      [{ text: "📢 درخواست‌های تبلیغات" }],
      [{ text: "🗃 آرشیو پیام‌های کانال" }],
      [{ text: "🔔 اعلان‌های نیازمند بررسی" }],
      [{ text: "📣 پیام همگانی" }],
      [{ text: "📖 ویرایش راهنما و قوانین" }],
      [{ text: "🔗 عضویت اجباری" }],
      [{ text: "⚙️ تنظیمات ربات" }],
      [{ text: "📊 خروجی Excel" }],
      [{ text: "👥 مدیریت ادمین‌ها" }]
    );
  }

  keyboard.push([{ text: "🏠 منوی اصلی" }]);
  return keyboard;
}

export function sectionMenu(isStaff, isAdminPage = false) {
  const keyboard = [
    [{ text: "⬅️ بازگشت" }, { text: "🏠 منوی اصلی" }]
  ];
  if (isStaff) {
    keyboard.push([{ text: isAdminPage ? "👤 پنل کاربر" : "🛠 پنل مدیریت" }]);
  }
  return keyboard;
}

export const stage3Routes = {
  // Main user menu
  "👤 پروفایل من": "profile",
  "💌 ثبت پست کراش": "crush_post",
  "🎭 چت ناشناس تصادفی": "anonymous",
  "🎭 ارتباط ناشناس": "anonymous",
  "🤝 درخواست‌های ارتباط از کانال": "connections",
  "📢 ثبت درخواست تبلیغات": "advertise",
  "📖 راهنما و قوانین": "help",

  // Existing management menu labels
  "🔎 بررسی پیام‌های ناشناس": "moderation",
  "🗂 آرشیو پیام‌های ناشناس": "message_archive",
  "📢 درخواست‌های تبلیغات": "ad_requests",
  "📣 پیام همگانی": "broadcast",
  "📖 ویرایش راهنما و قوانین": "edit_rules",
  "⚙️ تنظیمات ربات": "settings",
  "👥 مدیریت ادمین‌ها": "admin_management",
  "📊 خروجی Excel": "excel_export",

  // Profile
  "ویرایش اطلاعات": "profile_edit",
  "❤️ علاقه‌مندی‌های من": "interests",
  "➕ افزودن علاقه‌مندی": "interest_add",
  "📝 نام مستعار": "field_nickname",
  "🎂 سن و ماه تولد": "field_birth",
  "🕌 مذهب و فرقه": "field_religion",
  "🕌 مذهب": "field_religion",
  "🕋 فرقه/مذهب": "field_sect",
  "📍 محل سکونت": "field_location",
  "📍 شهر": "field_location",
  "💍 وضعیت تأهل": "field_marital",
  "⚧ جنسیت": "field_gender",
  "📝 درباره من": "field_bio",
  "💼 شغل": "field_job",
  "🎓 رشته تحصیلی": "field_field",
  "🎂 سال تولد شمسی": "field_birth",
  "🗓 ماه تولد": "field_birth_month",
  "✏️ ویرایش اطلاعات": "profile_edit",
  "📝 لقب": "field_nickname",
  "📝 دربارهٔ من": "field_bio",
  "🎓 رشتهٔ تحصیلی": "field_field",
  "🖼 عکس پروفایل مخصوص ربات": "field_image",
  "🖼 تصویر پروفایل کراش‌یاب": "field_image",

  // Crush post
  "📘 راهنمای ثبت پست": "post_guide",
  "✍️ شروع ثبت پست": "post_create",
  "📚 ثبت کراش‌های من": "my_posts",

  // Random anonymous chat
  "🔍 پیدا کردن فرد": "anonymous_gender",
  "👧 دختر": "anonymous_queue_girl",
  "👦 پسر": "anonymous_queue_boy",

  // Channel connections
  "📥 درخواست‌های دریافتی": "connection_incoming",
  "📤 درخواست‌های ارسالی": "connection_outgoing",
  "💬 ارتباط‌های فعال": "connection_active",

  // Archive navigation
  "📨 صف بررسی پیام‌ها": "moderation",
  "🗓 آرشیو پیام‌ها": "message_archive",
  // Other management screens
  "📣 شروع پیام همگانی": "broadcast",

  // Navigation
  "↩️ بازگشت به پروفایل": "profile",
  "↩️ بازگشت به ویرایش اطلاعات": "profile_edit",
  "↩️ بازگشت به ارتباط ناشناس": "anonymous",
  "↩️ بازگشت به درخواست‌ها": "connections",
  "↩️ بازگشت به منوی کاربر": "user_home",
  "↩️ بازگشت به پنل مدیریت": "admin_home"
};

// These permissions are checked on the server, not just by hiding buttons.
export const stage3Permissions = {
  moderation: "moderation",
  message_archive: "message_archive",
  ad_requests: "ad_requests",
  broadcast: "broadcast",
  edit_rules: "edit_rules",
  settings: "settings",
  admin_management: "admin_management",
  excel_export: "excel_export",
};

const screens = {
  profile: {
    text: "👤 پروفایل من",
    rows: [
      [{ text: "ویرایش اطلاعات" }],
      [{ text: "❤️ علاقه‌مندی‌های من" }]
    ],
    back: "↩️ بازگشت به منوی کاربر"
  },
  profile_edit: {
    text: "✏️ ویرایش اطلاعات\n\nفیلدی را برای ویرایش انتخاب کن.",
    rows: [
      [{ text: "📝 لقب" }, { text: "📝 دربارهٔ من" }],
      [{ text: "📍 شهر" }, { text: "🎂 سال تولد شمسی" }],
      [{ text: "🗓 ماه تولد" }, { text: "🕌 مذهب" }],
      [{ text: "🕋 فرقه/مذهب" }, { text: "💼 شغل" }],
      [{ text: "💍 وضعیت تأهل" }, { text: "⚧ جنسیت" }],
      [{ text: "🎓 رشتهٔ تحصیلی" }, { text: "🖼 عکس پروفایل مخصوص ربات" }],
      [{ text: "❤️ علاقه‌مندی‌های من" }]
    ],
    back: "↩️ بازگشت به پروفایل"
  },
  interests: {
    text: "❤️ علاقه‌مندی‌های من",
    rows: [[{ text: "➕ افزودن علاقه‌مندی" }]],
    back: "↩️ بازگشت به ویرایش اطلاعات"
  },
  interest_add: {
    text: "➕ افزودن علاقه‌مندی\n\nیک دسته را انتخاب کن.",
    rows: [],
    back: "↩️ بازگشت به ویرایش اطلاعات"
  },

  crush_post: {
    text: "💌 ثبت پست کراش\n\nپست متنی یا رسانه‌ای ثبت و برای بررسی در صف مشترک مدیریت قرار می‌گیرد.",
    rows: [
      [{ text: "📘 راهنمای ثبت پست" }],
      [{ text: "✍️ شروع ثبت پست" }]
    ],
    back: "↩️ بازگشت به منوی کاربر"
  },
  post_guide: {
    text: "📘 راهنمای ثبت پست\n\nپیام باید محترمانه باشد و اطلاعات خصوصی دیگران را بدون رضایت آن‌ها منتشر نکند.",
    rows: [],
    back: "↩️ بازگشت به منوی کاربر"
  },
  post_create: {
    text: "✍️ شروع ثبت پست\n\nبرای ثبت پیام ناشناس، متن یا رسانهٔ پشتیبانی‌شده بفرست.",
    rows: [],
    back: "↩️ بازگشت به منوی کاربر"
  },

  anonymous: {
    text: "🎭 چت ناشناس تصادفی\n\nاین گفت‌وگو از ارتباط‌های پذیرفته‌شده جداست.",
    rows: [[{ text: "🔍 پیدا کردن فرد" }]],
    back: "↩️ بازگشت به منوی کاربر"
  },
  anonymous_gender: {
    text: "🔍 پیدا کردن فرد\n\nجنسیت فرد موردنظر را انتخاب کن. تطبیق فقط با رضایت و ترجیح سازگار هر دو طرف انجام می‌شود.",
    rows: [[{ text: "👧 دختر" }, { text: "👦 پسر" }]],
    back: "↩️ بازگشت به ارتباط ناشناس"
  },
  anonymous_queue_girl: {
    text: "👧 جست‌وجوی فرد\n\nدر حال ثبت در صف سازگار.",
    rows: [],
    back: "↩️ بازگشت به ارتباط ناشناس"
  },
  anonymous_queue_boy: {
    text: "👦 جست‌وجوی فرد\n\nدر حال ثبت در صف سازگار.",
    rows: [],
    back: "↩️ بازگشت به ارتباط ناشناس"
  },

  connections: {
    text: "🤝 درخواست‌های ارتباط از کانال\n\nیکی از بخش‌ها را انتخاب کن. این بخش از چت تصادفی ناشناس جداست.",
    rows: [
      [{ text: "📥 درخواست‌های دریافتی" }],
      [{ text: "📤 درخواست‌های ارسالی" }],
      [{ text: "💬 ارتباط‌های فعال" }]
    ],
    back: "↩️ بازگشت به منوی کاربر"
  },
  connection_incoming: { text: "📥 درخواست‌های دریافتی\n\nدرخواست‌های ارتباطی که برای تو ارسال شده‌اند.", rows: [], back: "↩️ بازگشت به درخواست‌ها" },
  connection_outgoing: { text: "📤 درخواست‌های ارسالی\n\nوضعیت درخواست‌هایی که فرستاده‌ای.", rows: [], back: "↩️ بازگشت به درخواست‌ها" },
  connection_active: { text: "💬 ارتباط‌های فعال\n\nگفت‌وگوی خصوصی رباتی با ارتباط‌های پذیرفته‌شده.", rows: [], back: "↩️ بازگشت به درخواست‌ها" },

  advertise: {
    text: "📢 درخواست تبلیغات\n\nپیام‌ها در گفت‌وگوی خصوصی و اختصاصی با مالک ربات ثبت و پاسخ داده می‌شوند. توافق و پرداخت، در صورت نیاز، فقط به‌صورت دستی در همین مکالمه انجام می‌شود.",
    rows: [],
    back: "↩️ بازگشت به منوی کاربر"
  },
  help: {
    text: "📖 راهنما و قوانین\n\nمتن جاری قوانین از منبع پایدار ربات نمایش داده می‌شود.",
    rows: [],
    back: "↩️ بازگشت به منوی کاربر"
  },

  moderation: {
    text: "🔎 بررسی پیام‌های ناشناس\n\nصف مشترک پیام‌ها و پاسخ‌ها به ترتیب دریافت.",
    rows: [[{ text: "📨 صف بررسی پیام‌ها" }]],
    back: "↩️ بازگشت به پنل مدیریت"
  },
  message_archive: {
    text: "🗂 آرشیو پیام‌های ناشناس\n\nانتخاب سال و ماه و فیلتر واقعی از پایگاه داده در آرشیو انجام می‌شود.",
    rows: [],
    back: "↩️ بازگشت به پنل مدیریت"
  },

  ad_requests: {
    text: "📢 درخواست‌های تبلیغات\n\nفقط مالک اصلی می‌تواند فهرست درخواست‌دهندگان و مکالمه‌های خصوصی را مشاهده کند.",
    rows: [],
    back: "↩️ بازگشت به پنل مدیریت"
  },
  broadcast: {
    text: "📣 پیام همگانی\n\nپیش‌نمایش و تأیید مالک پیش از ارسال لازم است؛ ارسال‌ها به‌صورت batch و با ثبت نتیجهٔ هر گیرنده انجام می‌شوند.",
    rows: [[{ text: "📣 شروع پیام همگانی" }]],
    back: "↩️ بازگشت به پنل مدیریت"
  },
  edit_rules: {
    text: "📖 ویرایش راهنما و قوانین\n\nفقط مالک می‌تواند متن جدید را پیش‌نمایش و ذخیره کند؛ نسخه‌های قبلی در پایگاه داده نگهداری می‌شوند.",
    rows: [],
    back: "↩️ بازگشت به پنل مدیریت"
  },
  settings: {
    text: "⚙️ تنظیمات ربات\n\nوضعیت ربات، عضویت اجباری و تنظیمات عملیاتی غیرمحرمانه از این بخش قابل مدیریت‌اند. secretها هرگز نمایش داده نمی‌شوند.",
    rows: [],
    back: "↩️ بازگشت به پنل مدیریت"
  },
  admin_management: {
    text: "👥 مدیریت ادمین‌ها\n\nفهرست مدیران، اعطای دسترسی و لغو نقش فقط در اختیار مالک است.",
    rows: [],
    back: "↩️ بازگشت به پنل مدیریت"
  },
  excel_export: {
    text: "📊 خروجی Excel",
    rows: [],
    back: "↩️ بازگشت به پنل مدیریت"
  }
};

export const stage3ScreenIds = Object.keys(screens);

const adminScreens = new Set([
  "moderation", "message_archive", "ad_requests",
  "broadcast", "edit_rules", "settings", "excel_export",
  "admin_management"
]);

export function stage3ScreenText(screen) {
  return screens[screen]?.text ?? "این بخش در نسخهٔ فعلی فعال نیست.";
}

export function stage3Menu(screen, isOwner = false, isStaff = isOwner) {
  if (screen === "admin_home") return adminMenu(isOwner);
  if (screen === "user_home") return userMenu(isStaff);

  const config = screens[screen];
  if (!config) return sectionMenu(isStaff);

  const rows = config.rows.map(row => [...row]);
  if (config.back) rows.push([{ text: config.back }]);
  rows.push([{ text: "🏠 منوی اصلی" }]);

  if (isStaff) {
    rows.push([{
      text: adminScreens.has(screen) ? "👤 پنل کاربر" : "🛠 پنل مدیریت"
    }]);
  }

  return rows;
}
