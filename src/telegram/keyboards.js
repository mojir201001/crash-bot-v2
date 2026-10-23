export function userMenu(isStaff) {
  const keyboard = [
    [{ text: "👤 پروفایل من" }, { text: "💌 ثبت پست کراش" }],
    [{ text: "🎭 ارتباط ناشناس" }, { text: "🤝 درخواست‌های ارتباط از کانال" }],
    [{ text: "📢 ثبت درخواست تبلیغات" }, { text: "📖 راهنما و قوانین" }]
  ];

  if (isStaff) {
    keyboard.push([{ text: "🛠 پنل مدیریت" }]);
  }

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

  return keyboard;
}
