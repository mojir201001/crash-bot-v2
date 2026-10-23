async function sendTelegram(env, chatId, text, keyboard) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        reply_markup: {
          keyboard,
          resize_keyboard: true,
          is_persistent: true
        }
      })
    }
  );

  if (!response.ok) {
    console.error("Telegram sendMessage failed:", response.status);
    return false;
  }

  const result = await response.json();
  return result.ok === true;
}

function userMenu(isStaff) {
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

function adminMenu(isOwner) {
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "crash-bot-v2"
      });
    }

    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    if (
      !env.TELEGRAM_BOT_TOKEN ||
      !env.WEBHOOK_SECRET ||
      !env.OWNER_TELEGRAM_ID ||
      !env.CRASH_BOT_DB
    ) {
      return Response.json(
        { ok: false, error: "Bot is not configured" },
        { status: 503 }
      );
    }

    const secret = request.headers.get(
      "X-Telegram-Bot-Api-Secret-Token"
    );

    if (secret !== env.WEBHOOK_SECRET) {
      return Response.json({ ok: false }, { status: 401 });
    }

    let update;

    try {
      update = await request.json();
    } catch {
      return Response.json(
        { ok: false, error: "Invalid JSON" },
        { status: 400 }
      );
    }

    const message = update?.message;
    const from = message?.from;
    const chatId = message?.chat?.id;
    const text = message?.text?.trim();

    if (!from?.id || !chatId || !text) {
      return Response.json({ ok: true });
    }

    const userId = from.id;
    const isOwner = String(userId) === String(env.OWNER_TELEGRAM_ID);

    try {
      await env.CRASH_BOT_DB.prepare(`
        INSERT INTO users (telegram_id, username, first_name)
        VALUES (?, ?, ?)
        ON CONFLICT(telegram_id) DO UPDATE SET
          username = excluded.username,
          first_name = excluded.first_name
      `).bind(
        userId,
        from.username ?? null,
        from.first_name ?? null
      ).run();

      const userResult = await env.CRASH_BOT_DB.prepare(`
        SELECT is_blocked, account_status
        FROM users
        WHERE telegram_id = ?
      `).bind(userId).first();

      if (
        userResult?.is_blocked === 1 ||
        (userResult?.account_status &&
          userResult.account_status !== "active")
      ) {
        await sendTelegram(
          env,
          chatId,
          "دسترسی حساب شما در حال حاضر غیرفعال است. برای پیگیری با مدیریت تماس بگیرید.",
          [[{ text: "📖 راهنما و قوانین" }]]
        );
        return Response.json({ ok: true });
      }

      let isAdmin = false;

      if (!isOwner) {
        const adminResult = await env.CRASH_BOT_DB.prepare(`
          SELECT user_id
          FROM admin_roles
          WHERE user_id = ?
        `).bind(userId).first();

        isAdmin = Boolean(adminResult);
      }

      const isStaff = isOwner || isAdmin;

      const sendMenu = async (adminView = false) => {
        const keyboard = adminView && isStaff
          ? adminMenu(isOwner)
          : userMenu(isStaff);

        const menuText = adminView && isStaff
          ? (isOwner
              ? "🛠 پنل مدیریت مالک اصلی\nامکانات مدیریتی از این بخش در دسترس خواهند بود."
              : "🛠 پنل مدیریت ادمین\nاز این بخش می‌توانی پیام‌های ناشناس را بررسی کنی.")
          : "👋 سلام، به کراش‌یاب ادیب خوش اومدی!\n\n💌 از منوی زیر می‌تونی به امکانات ربات دسترسی پیدا کنی.";

        return sendTelegram(env, chatId, menuText, keyboard);
      };

      if (text === "/start" || text === "/menu") {
        await sendMenu(false);
        return Response.json({ ok: true });
      }

      if (text === "🛠 پنل مدیریت" && isStaff) {
        await sendMenu(true);
        return Response.json({ ok: true });
      }

      if (text === "👤 پنل کاربر") {
        await sendMenu(false);
        return Response.json({ ok: true });
      }

      const knownButtons = [
        "👤 پروفایل من",
        "💌 ثبت پست کراش",
        "🎭 ارتباط ناشناس",
        "🤝 درخواست‌های ارتباط از کانال",
        "📢 ثبت درخواست تبلیغات",
        "📖 راهنما و قوانین",
        "🔎 بررسی پیام‌های ناشناس",
        "🗂 آرشیو پیام‌های ناشناس",
        "📢 درخواست‌های تبلیغات",
        "🗃 آرشیو پیام‌های کانال",
        "💬 آرشیو چت‌های کاربران",
        "🎭 آرشیو ارتباط ناشناس",
        "📣 پیام همگانی",
        "📖 ویرایش راهنما و قوانین",
        "🔗 عضویت اجباری",
        "⚙️ تنظیمات ربات",
        "👥 مدیریت ادمین‌ها"
      ];

      if (knownButtons.includes(text)) {
        const ownerOnlyButtons = [
          "🗃 آرشیو پیام‌های کانال",
          "💬 آرشیو چت‌های کاربران",
          "🎭 آرشیو ارتباط ناشناس",
          "📣 پیام همگانی",
          "📖 ویرایش راهنما و قوانین",
          "🔗 عضویت اجباری",
          "⚙️ تنظیمات ربات",
          "👥 مدیریت ادمین‌ها"
        ];

        const adminOnlyButtons = [
          "🔎 بررسی پیام‌های ناشناس",
          "🗂 آرشیو پیام‌های ناشناس",
          "📢 درخواست‌های تبلیغات"
        ];

        if (ownerOnlyButtons.includes(text) && !isOwner) {
          await sendTelegram(
            env,
            chatId,
            "این بخش فقط برای مالک اصلی در دسترس است.",
            userMenu(isStaff)
          );
          return Response.json({ ok: true });
        }

        if (adminOnlyButtons.includes(text) && !isStaff) {
          await sendTelegram(
            env,
            chatId,
            "برای دسترسی به این بخش مجوز مدیریت لازم است.",
            userMenu(false)
          );
          return Response.json({ ok: true });
        }

        await sendTelegram(
          env,
          chatId,
          "این بخش هنوز در حال پیاده‌سازی است. گزینه‌ها به‌ترتیب به قابلیت‌های واقعی متصل خواهند شد.",
          isStaff ? adminMenu(isOwner) : userMenu(false)
        );
      }

      return Response.json({ ok: true });
    } catch (error) {
      console.error("Webhook processing failed:", error);
      return Response.json(
        { ok: false, error: "Internal error" },
        { status: 500 }
      );
    }
  }
};
