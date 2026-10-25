export function userMenu(isStaff) {
  const keyboard = [
    [{ text: "👤 پروفایل من" }, { text: "💌 ثبت پست کراش" }],
    [{ text: "🎭 ارتباط ناشناس" }, { text: "🤝 درخواست‌های ارتباط از کانال" }],
    [{ text: "📢 ثبت درخواست تبلیغات" }, { text: "📖 راهنما و قوانین" }]
  ];
  if (isStaff) keyboard.push([{ text: "🛠 پنل مدیریت" }]);
  return keyboard;
}

export function adminMenu(isOwner) {
  const keyboard = [
    [{ text: "🔎 بررسی پیام‌های ناشناس" }],
    [{ text: "🗂 آرشیو پیام‌های ناشناس" }],
    [{ text: "📢 درخواست‌های تبلیغات" }],
    [{ text: "👤 پنل کاربر" }]
  ];

  if (isOwner) {
    keyboard.splice(3, 0,
      [{ text: "🗃 آرشیو پیام‌های کانال" }],
      [{ text: "💬 آرشیو چت‌های کاربران" }],
      [{ text: "🎭 آرشیو ارتباط ناشناس" }],
      [{ text: "📣 پیام همگانی" }],
      [{ text: "📖 ویرایش راهنما و قوانین" }],
      [{ text: "🔗 عضویت اجباری" }],
      [{ text: "⚙️ تنظیمات ربات" }],
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
  "🎭 ارتباط ناشناس": "anonymous",
  "🤝 درخواست‌های ارتباط از کانال": "connections",
  "📢 ثبت درخواست تبلیغات": "advertise",
  "📖 راهنما و قوانین": "help",

  // Existing management menu labels
  "🔎 بررسی پیام‌های ناشناس": "moderation",
  "🗂 آرشیو پیام‌های ناشناس": "message_archive",
  "📢 درخواست‌های تبلیغات": "ad_requests",
  "💬 آرشیو چت‌های کاربران": "chat_archive",
  "🎭 آرشیو ارتباط ناشناس": "anonymous_chat_archive",
  "📣 پیام همگانی": "broadcast",
  "📖 ویرایش راهنما و قوانین": "edit_rules",
  "⚙️ تنظیمات ربات": "settings",
  "👥 مدیریت ادمین‌ها": "admin_management",

  // Profile
  "ویرایش اطلاعات": "profile_edit",
  "❤️ علاقه‌مندی‌های من": "interests",
  "➕ افزودن علاقه‌مندی": "interest_add",
  "📝 نام مستعار": "field_nickname",
  "🎂 سن و ماه تولد": "field_birth",
  "🕌 مذهب و فرقه": "field_religion",
  "📍 محل سکونت": "field_location",
  "💍 وضعیت تأهل": "field_marital",
  "⚧ جنسیت": "field_gender",
  "📝 درباره من": "field_bio",
  "💼 شغل": "field_job",
  "🎓 رشته تحصیلی": "field_field",
  "🧠 تیپ شخصیتی": "field_personality",
  "🖼 تصویر پروفایل کراش‌یاب": "field_image",

  // Crush post
  "📘 راهنمای ثبت پست": "post_guide",
  "✍️ شروع ثبت پست": "post_create",

  // Random anonymous chat
  "🔍 پیدا کردن فرد": "anonymous_gender",
  "🔗 لینک ناشناس من": "anonymous_link",
  "👧 دختر": "anonymous_queue_girl",
  "👦 پسر": "anonymous_queue_boy",

  // Channel connections
  "📥 درخواست‌های دریافتی": "connection_incoming",
  "📤 درخواست‌های ارسالی": "connection_outgoing",
  "💬 ارتباط‌های فعال": "connection_active",

  // Archive navigation
  "📨 صف بررسی پیام‌ها": "moderation",
  "🗓 آرشیو پیام‌ها": "message_archive",
  "📅 سال ۱۴۰۵": "archive_1405",
  "📅 سال ۱۴۰۴": "archive_1404",
  "📅 سال ۱۴۰۳": "archive_1403",
  "📅 سال 1405": "archive_1405",
  "📅 سال 1404": "archive_1404",
  "📅 سال 1403": "archive_1403",
  "فروردین": "archive_month",
  "اردیبهشت": "archive_month",
  "خرداد": "archive_month",
  "تیر": "archive_month",
  "مرداد": "archive_month",
  "شهریور": "archive_month",
  "مهر": "archive_month",
  "آبان": "archive_month",
  "آذر": "archive_month",
  "دی": "archive_month",
  "بهمن": "archive_month",
  "اسفند": "archive_month",

  // Other management screens
  "👥 فهرست درخواست‌های تبلیغات": "ad_requests",
  "🗂 مشاهده آرشیو چت‌ها": "chat_archive",
  "🗂 مشاهده آرشیو ارتباط‌ها": "anonymous_chat_archive",
  "📣 شروع پیام همگانی": "broadcast",
  "📖 مشاهده و ویرایش متن قوانین": "edit_rules",
  "🔘 وضعیت ربات و آمار": "settings",
  "👥 فهرست ادمین‌ها": "admin_management",

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
  chat_archive: "chat_archive",
  anonymous_chat_archive: "anonymous_chat_archive",
  broadcast: "broadcast",
  edit_rules: "edit_rules",
  settings: "settings",
  admin_management: "admin_management",
  archive_1405: "message_archive",
  archive_1404: "message_archive",
  archive_1403: "message_archive",
  archive_month: "message_archive"
};

const months = [
  "فروردین", "اردیبهشت", "خرداد",
  "تیر", "مرداد", "شهریور",
  "مهر", "آبان", "آذر",
  "دی", "بهمن", "اسفند"
];

const screens = {
  profile: {
    text: "👤 پروفایل من\n\nدر این مرحله صفحه و مسیرهای ویرایش آماده می‌شوند. اتصال به اطلاعات واقعی پروفایل در مرحلهٔ بعد انجام می‌شود.",
    rows: [
      [{ text: "ویرایش اطلاعات" }],
      [{ text: "❤️ علاقه‌مندی‌های من" }]
    ],
    back: "↩️ بازگشت به منوی کاربر"
  },
  profile_edit: {
    text: "✏️ ویرایش اطلاعات\n\nفیلدی را برای ویرایش انتخاب کن. ذخیرهٔ اطلاعات در مرحلهٔ پروفایل پیاده‌سازی می‌شود.",
    rows: [
      [{ text: "📝 نام مستعار" }, { text: "🎂 سن و ماه تولد" }],
      [{ text: "🕌 مذهب و فرقه" }, { text: "📍 محل سکونت" }],
      [{ text: "💍 وضعیت تأهل" }, { text: "⚧ جنسیت" }],
      [{ text: "📝 درباره من" }, { text: "💼 شغل" }],
      [{ text: "🎓 رشته تحصیلی" }, { text: "🧠 تیپ شخصیتی" }],
      [{ text: "🖼 تصویر پروفایل کراش‌یاب" }],
      [{ text: "❤️ علاقه‌مندی‌های من" }]
    ],
    back: "↩️ بازگشت به پروفایل"
  },
  interests: {
    text: "❤️ علاقه‌مندی‌های من\n\nمدیریت و ذخیرهٔ دسته‌های علاقه‌مندی در مرحلهٔ پروفایل متصل می‌شود.",
    rows: [[{ text: "➕ افزودن علاقه‌مندی" }]],
    back: "↩️ بازگشت به ویرایش اطلاعات"
  },
  interest_add: {
    text: "➕ افزودن علاقه‌مندی\n\nثبت متن و رسانه در مرحلهٔ پروفایل پیاده‌سازی می‌شود.",
    rows: [],
    back: "↩️ بازگشت به ویرایش اطلاعات"
  },

  field_nickname: { text: "📝 نام مستعار\n\nفرم ثبت و ذخیره در مرحلهٔ پروفایل پیاده‌سازی می‌شود.", rows: [], back: "↩️ بازگشت به ویرایش اطلاعات" },
  field_birth: { text: "🎂 سال و ماه تولد\n\nفرم ثبت و محاسبهٔ سن در مرحلهٔ پروفایل پیاده‌سازی می‌شود.", rows: [], back: "↩️ بازگشت به ویرایش اطلاعات" },
  field_religion: { text: "🕌 مذهب و فرقه\n\nفرم ثبت و ذخیره در مرحلهٔ پروفایل پیاده‌سازی می‌شود.", rows: [], back: "↩️ بازگشت به ویرایش اطلاعات" },
  field_location: { text: "📍 محل سکونت\n\nفرم ثبت و ذخیره در مرحلهٔ پروفایل پیاده‌سازی می‌شود.", rows: [], back: "↩️ بازگشت به ویرایش اطلاعات" },
  field_marital: { text: "💍 وضعیت تأهل\n\nانتخاب و ذخیره در مرحلهٔ پروفایل پیاده‌سازی می‌شود.", rows: [], back: "↩️ بازگشت به ویرایش اطلاعات" },
  field_gender: { text: "⚧ جنسیت\n\nانتخاب و ذخیره در مرحلهٔ پروفایل پیاده‌سازی می‌شود.", rows: [], back: "↩️ بازگشت به ویرایش اطلاعات" },
  field_bio: { text: "📝 درباره من\n\nفرم ثبت و ذخیره در مرحلهٔ پروفایل پیاده‌سازی می‌شود.", rows: [], back: "↩️ بازگشت به ویرایش اطلاعات" },
  field_job: { text: "💼 شغل\n\nفرم ثبت و ذخیره در مرحلهٔ پروفایل پیاده‌سازی می‌شود.", rows: [], back: "↩️ بازگشت به ویرایش اطلاعات" },
  field_field: { text: "🎓 رشته تحصیلی\n\nفرم ثبت و ذخیره در مرحلهٔ پروفایل پیاده‌سازی می‌شود.", rows: [], back: "↩️ بازگشت به ویرایش اطلاعات" },
  field_personality: { text: "🧠 تیپ شخصیتی\n\nفرم ثبت و ذخیره در مرحلهٔ پروفایل پیاده‌سازی می‌شود.", rows: [], back: "↩️ بازگشت به ویرایش اطلاعات" },
  field_image: { text: "🖼 تصویر پروفایل کراش‌یاب\n\nدریافت و ذخیرهٔ تصویر در مرحلهٔ پروفایل پیاده‌سازی می‌شود.", rows: [], back: "↩️ بازگشت به ویرایش اطلاعات" },

  crush_post: {
    text: "💌 ثبت پست کراش\n\nاز این بخش وارد راهنمای ثبت پست یا شروع ثبت می‌شوی. دریافت و صف بررسی واقعی در مرحلهٔ مربوط پیاده‌سازی می‌شود.",
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
    text: "✍️ شروع ثبت پست\n\nدریافت متن و رسانه و ارسال به صف بررسی در مرحلهٔ کراش پیاده‌سازی می‌شود.",
    rows: [],
    back: "↩️ بازگشت به منوی کاربر"
  },

  anonymous: {
    text: "🎭 ارتباط ناشناس\n\nبرای جستجوی فرد یا دریافت لینک ناشناس یکی از گزینه‌ها را انتخاب کن.",
    rows: [
      [{ text: "🔍 پیدا کردن فرد" }],
      [{ text: "🔗 لینک ناشناس من" }]
    ],
    back: "↩️ بازگشت به منوی کاربر"
  },
  anonymous_gender: {
    text: "🔍 پیدا کردن فرد\n\nجنسیت فرد موردنظر را انتخاب کن. صف پایدار و چت واقعی در مرحلهٔ ارتباط ناشناس پیاده‌سازی می‌شود.",
    rows: [[{ text: "👧 دختر" }, { text: "👦 پسر" }]],
    back: "↩️ بازگشت به ارتباط ناشناس"
  },
  anonymous_queue_girl: {
    text: "👧 جستجوی فرد\n\nصف جستجو در مرحلهٔ ارتباط ناشناس پیاده‌سازی می‌شود.",
    rows: [],
    back: "↩️ بازگشت به ارتباط ناشناس"
  },
  anonymous_queue_boy: {
    text: "👦 جستجوی فرد\n\nصف جستجو در مرحلهٔ ارتباط ناشناس پیاده‌سازی می‌شود.",
    rows: [],
    back: "↩️ بازگشت به ارتباط ناشناس"
  },
  anonymous_link: {
    text: "🔗 لینک ناشناس من\n\nساخت لینک اختصاصی در مرحلهٔ ارتباط ناشناس پیاده‌سازی می‌شود.",
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
  connection_incoming: { text: "📥 درخواست‌های دریافتی\n\nنمایش و مدیریت درخواست‌ها در مرحلهٔ درخواست ارتباط پیاده‌سازی می‌شود.", rows: [], back: "↩️ بازگشت به درخواست‌ها" },
  connection_outgoing: { text: "📤 درخواست‌های ارسالی\n\nنمایش درخواست‌های ارسالی در مرحلهٔ درخواست ارتباط پیاده‌سازی می‌شود.", rows: [], back: "↩️ بازگشت به درخواست‌ها" },
  connection_active: { text: "💬 ارتباط‌های فعال\n\nفهرست و گفت‌وگوی ارتباط‌های پذیرفته‌شده در مرحلهٔ درخواست ارتباط پیاده‌سازی می‌شود.", rows: [], back: "↩️ بازگشت به درخواست‌ها" },

  advertise: {
    text: "📢 ثبت درخواست تبلیغات\n\nارسال درخواست و مکاتبهٔ اختصاصی در مرحلهٔ تبلیغات پیاده‌سازی می‌شود.",
    rows: [],
    back: "↩️ بازگشت به منوی کاربر"
  },
  help: {
    text: "📖 راهنما و قوانین\n\nمتن ذخیره‌شدهٔ راهنما و قوانین در مرحلهٔ مربوط متصل می‌شود.",
    rows: [],
    back: "↩️ بازگشت به منوی کاربر"
  },

  moderation: {
    text: "🔎 بررسی پیام‌های ناشناس\n\nصف بررسی به ترتیب زمانی و دکمه‌های تأیید و رد در مرحلهٔ مدیریت محتوا پیاده‌سازی می‌شوند.",
    rows: [[{ text: "📨 صف بررسی پیام‌ها" }]],
    back: "↩️ بازگشت به پنل مدیریت"
  },
  message_archive: {
    text: "🗂 آرشیو پیام‌های ناشناس\n\nسال موردنظر را انتخاب کن. اتصال به سوابق واقعی در مرحلهٔ آرشیو انجام می‌شود.",
    rows: [
      [{ text: "📅 سال ۱۴۰۵" }],
      [{ text: "📅 سال ۱۴۰۴" }],
      [{ text: "📅 سال ۱۴۰۳" }]
    ],
    back: "↩️ بازگشت به پنل مدیریت"
  },
  archive_1405: { text: "🗂 آرشیو سال ۱۴۰۵\n\nماه موردنظر را انتخاب کن.", rows: months.reduce((rows, month, i) => { if (i % 3 === 0) rows.push([]); rows[rows.length - 1].push({ text: month }); return rows; }, []), back: "🗓 آرشیو پیام‌ها" },
  archive_1404: { text: "🗂 آرشیو سال ۱۴۰۴\n\nماه موردنظر را انتخاب کن.", rows: months.reduce((rows, month, i) => { if (i % 3 === 0) rows.push([]); rows[rows.length - 1].push({ text: month }); return rows; }, []), back: "🗓 آرشیو پیام‌ها" },
  archive_1403: { text: "🗂 آرشیو سال ۱۴۰۳\n\nماه موردنظر را انتخاب کن.", rows: months.reduce((rows, month, i) => { if (i % 3 === 0) rows.push([]); rows[rows.length - 1].push({ text: month }); return rows; }, []), back: "🗓 آرشیو پیام‌ها" },
  archive_month: { text: "🗂 آرشیو ماه\n\nنمایش پیام‌های این ماه از پایگاه داده در مرحلهٔ آرشیو پیاده‌سازی می‌شود.", rows: [], back: "🗓 آرشیو پیام‌ها" },

  ad_requests: {
    text: "📢 درخواست‌های تبلیغات\n\nفهرست مشتریان و مکالمهٔ اختصاصی هر درخواست در مرحلهٔ تبلیغات متصل می‌شود.",
    rows: [[{ text: "👥 فهرست درخواست‌های تبلیغات" }]],
    back: "↩️ بازگشت به پنل مدیریت"
  },
  chat_archive: {
    text: "💬 آرشیو چت‌های کاربران\n\nاین آرشیو فقط برای مالک است. نمایش گفت‌وگوها در مرحلهٔ آرشیو پیاده‌سازی می‌شود.",
    rows: [[{ text: "🗂 مشاهده آرشیو چت‌ها" }]],
    back: "↩️ بازگشت به پنل مدیریت"
  },
  anonymous_chat_archive: {
    text: "🎭 آرشیو ارتباط ناشناس\n\nاین آرشیو فقط برای مالک است. نمایش پیام‌ها در مرحلهٔ آرشیو پیاده‌سازی می‌شود.",
    rows: [[{ text: "🗂 مشاهده آرشیو ارتباط‌ها" }]],
    back: "↩️ بازگشت به پنل مدیریت"
  },
  broadcast: {
    text: "📣 پیام همگانی\n\nدریافت متن یا رسانه و ارسال به کاربران در مرحلهٔ پیام همگانی پیاده‌سازی می‌شود.",
    rows: [[{ text: "📣 شروع پیام همگانی" }]],
    back: "↩️ بازگشت به پنل مدیریت"
  },
  edit_rules: {
    text: "📖 ویرایش راهنما و قوانین\n\nاین قابلیت فقط برای مالک است. مشاهده، ویرایش و ثبت متن در مرحلهٔ قوانین پیاده‌سازی می‌شود.",
    rows: [[{ text: "📖 مشاهده و ویرایش متن قوانین" }]],
    back: "↩️ بازگشت به پنل مدیریت"
  },
  settings: {
    text: "⚙️ تنظیمات ربات\n\nروشن/خاموش‌کردن ربات و خروجی اکسل در مرحلهٔ تنظیمات پیاده‌سازی می‌شود.",
    rows: [[{ text: "🔘 وضعیت ربات و آمار" }]],
    back: "↩️ بازگشت به پنل مدیریت"
  },
  admin_management: {
    text: "👥 مدیریت ادمین‌ها\n\nفهرست، افزودن و حذف ادمین در مرحلهٔ مدیریت دسترسی‌ها پیاده‌سازی می‌شود.",
    rows: [[{ text: "👥 فهرست ادمین‌ها" }]],
    back: "↩️ بازگشت به پنل مدیریت"
  }
};

export const stage3ScreenIds = Object.keys(screens);

const adminScreens = new Set([
  "moderation", "message_archive", "archive_1405", "archive_1404",
  "archive_1403", "archive_month", "ad_requests", "chat_archive",
  "anonymous_chat_archive", "broadcast", "edit_rules", "settings",
  "admin_management"
]);

export function stage3ScreenText(screen) {
  return screens[screen]?.text ?? "این بخش هنوز در حال آماده‌سازی است.";
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
