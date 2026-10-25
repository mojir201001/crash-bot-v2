import { sendTelegram, deleteTelegramMessage, clearTrackedSectionMessage, answerCallbackQuery } from "./telegram/api.js";
import { userMenu, adminMenu, sectionMenu, stage3Menu, stage3Routes, stage3ScreenText, stage3ScreenIds, stage3Permissions } from "./telegram/keyboards.js";
import { getUserRole, canAccess } from "./services/permissions.js";
import {
  getRequiredChannels,
  saveRequiredChannels,
  checkRequiredMembership
} from "./services/forced-membership.js";
import {
  showForcedMembershipPanel,
  handleForcedMembershipCallback,
  handleForcedMembershipMessage,
  handleForcedMembershipChatUpdate
} from "./services/forced-membership-panel.js";
import {
  handleProfileRoute,
  handleProfileWorkflowMessage,
  hasSupportedMedia,
  isProfileReady,
  startProfileFlow
} from "./services/profile-flow.js";

const VERIFY_BUTTON = "🔄 بررسی عضویت";
const MEMBERSHIP_BUTTON = "🔗 عضویت اجباری";

const UI_TAP_TEXTS = new Set([
  "/menu",
  "🏠 منوی اصلی",
  "⬅️ بازگشت",
  "🛠 پنل مدیریت",
  "👤 پنل کاربر",
  "🔄 بررسی عضویت",
  "👤 پروفایل من",
  "✏️ ویرایش اطلاعات",
  "❤️ علاقه‌مندی‌های من",
  "➕ افزودن علاقه‌مندی",
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
  "⚙️ تنظیمات ربات",
  "👥 مدیریت ادمین‌ها",
  "💘 کراش زدن",
  "👻 وصل شدن به ناشناس",
  "💌 درخواست‌های ارتباط",
  "📣 ثبت درخواست تبلیغ",
  "🏫 خرید ربات برای دانشگاه",
  "📜 قوانین ربات",
  "⚙️ اطلاعات حساب",
  "❓ راهنما"
,
  "🎂 سال تولد شمسی",
  "🗓 ماه تولد",
  "📍 شهر",
  "🕌 مذهب",
  "🕋 فرقه/مذهب",
  "🎓 رشتهٔ تحصیلی",
  "🖼 عکس پروفایل مخصوص ربات",
  "📝 لقب",
  "📝 دربارهٔ من",
  "بدون عکس",
  "↩️ بازگشت به پروفایل"
,
  "?? ??? ??????"
,
  "?? ??? ?????"
,
  "?? ???? ????"
,
  "?? ??????"
]);

function validChannelId(value) {
  return /^@[A-Za-z0-9_]{5,32}$/.test(value) ||
    /^-100\d+$/.test(value);
}

function validInviteUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      ["t.me", "www.t.me"].includes(url.hostname);
  } catch {
    return false;
  }
}

function channelListText(channels) {
  if (!channels.length) {
    return "هنوز هیچ کانال عضویت اجباری تنظیم نشده است.";
  }

  return channels.map((channel, index) =>
    `${index + 1}. ${channel.chatId}\n${channel.inviteUrl}`
  ).join("\n\n");
}

function permissionForButton(text) {
  const permissionByButton = {
    "🔎 بررسی پیام‌های ناشناس": "moderation",
    "🗂 آرشیو پیام‌های ناشناس": "message_archive",
    "📢 درخواست‌های تبلیغات": "ad_requests",
    "🗃 آرشیو پیام‌های کانال": "channel_archive",
    "💬 آرشیو چت‌های کاربران": "chat_archive",
    "🎭 آرشیو ارتباط ناشناس": "anonymous_chat_archive",
    "📣 پیام همگانی": "broadcast",
    "📖 ویرایش راهنما و قوانین": "edit_rules",
    [MEMBERSHIP_BUTTON]: "forced_membership",
    "⚙️ تنظیمات ربات": "settings",
    "👥 مدیریت ادمین‌ها": "admin_management"
  };

  return permissionByButton[text] ?? stage3Permissions[stage3Routes[text]];
}

function membershipPrompt(channels, verificationError = false) {
  const intro = verificationError
    ? "⚠️ در حال حاضر تلگرام نتوانست عضویت شما را تأیید کند. دسترسی تا بررسی موفق فعال نمی‌شود."
    : "🔒 برای استفاده از ربات، ابتدا در تمام کانال‌های زیر عضو شو.";

  return `${intro}\n\n${channelListText(channels)}\n\nپس از عضویت، دکمهٔ «${VERIFY_BUTTON}» را بزن.`;
}

function isUiMenuTap(text) {
  if (!text) return false;

  try {
    const keyboards = [
      userMenu(false),
      userMenu(true),
      adminMenu(false),
      adminMenu(true),
      ...stage3ScreenIds.map((screen) => stage3Menu(screen, false, false)),
      ...stage3ScreenIds.map((screen) => stage3Menu(screen, false, true)),
      ...stage3ScreenIds.map((screen) => stage3Menu(screen, true, true))
    ];

    return keyboards.some((rows) =>
      Array.isArray(rows) &&
      rows.some((row) =>
        Array.isArray(row) &&
        row.some((button) => button?.text === text)
      )
    );
  } catch (error) {
    console.error("Could not inspect menu keyboard:", error);
    return false;
  }
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

    const secret = request.headers.get(
      "X-Telegram-Bot-Api-Secret-Token"
    );

    if (!env.WEBHOOK_SECRET || secret !== env.WEBHOOK_SECRET) {
      return Response.json({ ok: false }, { status: 401 });
    }

    if (
      !env.TELEGRAM_BOT_TOKEN ||
      !env.OWNER_TELEGRAM_ID ||
      !env.CRASH_BOT_DB
    ) {
      return Response.json(
        { ok: false, error: "Bot is not configured" },
        { status: 503 }
      );
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

    if (update?.callback_query) {
      try {
        const handled = await handleForcedMembershipCallback(
          env,
          update.callback_query
        );
        if (handled) return Response.json({ ok: true });
      } catch (error) {
        console.error("Callback processing failed:", error);
      }
      try {
        await answerCallbackQuery(
          env,
          update.callback_query.id,
          "این گزینه معتبر یا فعال نیست."
        );
      } catch (error) {
        console.error("Could not dismiss invalid callback:", error);
      }
      return Response.json({ ok: true });
    }

    if (update?.my_chat_member) {
      try {
        await handleForcedMembershipChatUpdate(env, update);
      } catch (error) {
        console.error("Chat membership update failed:", error);
      }
      return Response.json({ ok: true });
    }

    const message = update?.message;
    const from = message?.from;
    const chatId = message?.chat?.id;
    const text = message?.text?.trim() ?? message?.caption?.trim() ?? "";
    let menuTapDeleteAttempted = false;

    if (!from?.id || !chatId || (!text && !hasSupportedMedia(message))) {
      return Response.json({ ok: true });
    }

    const sectionNavigationTexts = [
      "/start", "/menu",
      "🏠 منوی اصلی", "⬅️ بازگشت",
      "🛠 پنل مدیریت", "👤 پنل کاربر",
      "👤 پروفایل من", "💌 ثبت پست کراش",
      "✏️ ویرایش اطلاعات", "❤️ علاقه‌مندی‌های من",
      "➕ افزودن علاقه‌مندی",
      "🎭 ارتباط ناشناس", "🤝 درخواست‌های ارتباط از کانال",
      "📢 ثبت درخواست تبلیغات", "📖 راهنما و قوانین",
      "🔎 بررسی پیام‌های ناشناس", "🗂 آرشیو پیام‌های ناشناس",
      "📢 درخواست‌های تبلیغات", "🗃 آرشیو پیام‌های کانال",
      "💬 آرشیو چت‌های کاربران", "🎭 آرشیو ارتباط ناشناس",
      "📣 پیام همگانی", "📖 ویرایش راهنما و قوانین",
      "🔗 عضویت اجباری", "⚙️ تنظیمات ربات", "👥 مدیریت ادمین‌ها"
    ];

    if (
      message.chat?.type === "private" &&
      (sectionNavigationTexts.includes(text) || isUiMenuTap(text))
    ) {
      await clearTrackedSectionMessage(env, chatId);
    }

    if (
      message.chat?.type === "private" &&
      message.message_id &&
      !/^\/start(?:@\w+)?(?:\s|$)/.test(message.text?.trim() ?? "") &&
      (
        UI_TAP_TEXTS.has(text) ||
        isUiMenuTap(text) ||
        /^\/menu(?:@\w+)?(?:\s|$)/.test(text)
      )
    ) {
      menuTapDeleteAttempted = true;
      try {
        await deleteTelegramMessage(env, chatId, message.message_id);
      } catch (error) {
        console.error("Could not delete menu tap:", error);
      }
    }

    // Handle normal bot commands and user flows only in private chats.
    if (message.chat?.type !== "private") {
      return Response.json({ ok: true });
    }

    const userId = from.id;
    const isOwner = String(userId) === String(env.OWNER_TELEGRAM_ID);
    const deleteProcessedInput = async () => {
      if (
        !menuTapDeleteAttempted &&
        message.message_id &&
        !/^\/start(?:@\w+)?(?:\s|$)/.test(message.text?.trim() ?? "")
      ) {
        try {
          await deleteTelegramMessage(env, chatId, message.message_id);
        } catch (error) {
          console.error("Could not delete processed form input:", error);
        }
      }
    };

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

      const role = await getUserRole(env, userId);
      const isStaff = role === "owner" || role === "admin";

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

      if (isOwner) {
        const handled = await handleForcedMembershipMessage(env, message);
        if (handled) return Response.json({ ok: true });
      }

      // Staff can manage the bot even when forced membership is enabled.
      // Ordinary users must pass the membership check before using the bot.
      if (!isStaff) {
        let membership;

        try {
          membership = await checkRequiredMembership(env, userId);
        } catch (error) {
          console.error("Forced membership configuration error:", error);

          await sendTelegram(
            env,
            chatId,
            "⚠️ بررسی عضویت فعلاً امکان‌پذیر نیست. لطفاً بعداً دوباره تلاش کن.",
            [[{ text: VERIFY_BUTTON }]]
          );

          return Response.json({ ok: true });
        }

        if (!membership.passed) {
          let channelsToShow = membership.missing;

          if (membership.error || !channelsToShow.length) {
            try {
              channelsToShow = await getRequiredChannels(env);
            } catch {
              channelsToShow = [];
            }
          }

          await sendTelegram(
            env,
            chatId,
            membershipPrompt(channelsToShow, membership.error),
            [[{ text: VERIFY_BUTTON }]]
          );

          return Response.json({ ok: true });
        }

      }

      const workflowHandled = await handleProfileWorkflowMessage(env, message, userId);
      if (workflowHandled) {
        await deleteProcessedInput();
        return Response.json({ ok: true });
      }

      const requestedPermission = permissionForButton(text);
      const userWasDeniedManagementRoute =
        (requestedPermission && !canAccess(role, requestedPermission)) ||
        text === "↩️ بازگشت به پنل مدیریت" ||
        text.startsWith("/forced_");

      if (
        !isStaff &&
        !userWasDeniedManagementRoute &&
        !(await isProfileReady(env, userId))
      ) {
        if (text === VERIFY_BUTTON) {
          await startProfileFlow(env, chatId, userId);
        } else {
          await startProfileFlow(env, chatId, userId);
          await deleteProcessedInput();
        }
        return Response.json({ ok: true });
      }

      if (text === VERIFY_BUTTON) {
        await sendMenu(false);
        return Response.json({ ok: true });
      }

      const profileDestination = stage3Routes[text];
      const profileRouteHandled = await handleProfileRoute(
        env, message, userId, profileDestination, text
      );
      if (profileRouteHandled) {
        await deleteProcessedInput();
        return Response.json({ ok: true });
      }

      if (text === "🏠 منوی اصلی" || text === "⬅️ بازگشت") {
        await sendMenu(false);
        return Response.json({ ok: true });
      }

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

      // Owner-only forced-membership commands.
      if (text.startsWith("/forced_add")) {
        if (role !== "owner") {
          await sendTelegram(
            env,
            chatId,
            "این دستور فقط برای مالک اصلی در دسترس است.",
            userMenu(isStaff)
          );
          return Response.json({ ok: true });
        }

        const parts = text.split(/\s+/);
        const channelId = parts[1];
        const inviteUrl = parts[2];

        if (
          parts.length !== 3 ||
          !validChannelId(channelId) ||
          !validInviteUrl(inviteUrl)
        ) {
          await sendTelegram(
            env,
            chatId,
            "فرمت دستور صحیح نیست.\n\nکانال عمومی:\n/forced_add @channelusername https://t.me/channelusername\n\nکانال خصوصی:\n/forced_add -1001234567890 https://t.me/+InviteCode",
            adminMenu(true)
          );
          return Response.json({ ok: true });
        }

        try {
          const channels = await getRequiredChannels(env);
          const existing = channels.find(
            (channel) => channel.chatId === channelId
          );

          const updated = existing
            ? channels.map((channel) =>
                channel.chatId === channelId
                  ? { chatId: channelId, inviteUrl }
                  : channel
              )
            : [...channels, { chatId: channelId, inviteUrl }];

          await saveRequiredChannels(env, updated);

          await sendTelegram(
            env,
            chatId,
            existing
              ? `لینک کانال ${channelId} به‌روزرسانی شد.`
              : `کانال ${channelId} به فهرست عضویت اجباری اضافه شد.`,
            adminMenu(true)
          );
        } catch (error) {
          console.error("Could not save forced membership channels:", error);
          await sendTelegram(
            env,
            chatId,
            "⚠️ ذخیره تنظیمات انجام نشد؛ تنظیمات قبلی حفظ شدند.",
            adminMenu(true)
          );
        }

        return Response.json({ ok: true });
      }

      if (text === "/forced_list") {
        if (role !== "owner") {
          await sendTelegram(
            env,
            chatId,
            "این دستور فقط برای مالک اصلی در دسترس است.",
            userMenu(isStaff)
          );
          return Response.json({ ok: true });
        }

        try {
          const channels = await getRequiredChannels(env);
          await sendTelegram(
            env,
            chatId,
            `📋 کانال‌های عضویت اجباری:\n\n${channelListText(channels)}`,
            adminMenu(true)
          );
        } catch (error) {
          console.error("Could not read forced membership channels:", error);
          await sendTelegram(
            env,
            chatId,
            "⚠️ خواندن تنظیمات ممکن نشد. قبل از هر تغییری، وضعیت پایگاه داده را بررسی کن.",
            adminMenu(true)
          );
        }

        return Response.json({ ok: true });
      }

      if (text === "/forced_clear") {
        if (role !== "owner") {
          await sendTelegram(
            env,
            chatId,
            "این دستور فقط برای مالک اصلی در دسترس است.",
            userMenu(isStaff)
          );
          return Response.json({ ok: true });
        }

        try {
          await saveRequiredChannels(env, []);
          await sendTelegram(
            env,
            chatId,
            "تمام کانال‌های عضویت اجباری حذف شدند.",
            adminMenu(true)
          );
        } catch (error) {
          console.error("Could not clear forced membership channels:", error);
          await sendTelegram(
            env,
            chatId,
            "⚠️ حذف تنظیمات انجام نشد.",
            adminMenu(true)
          );
        }

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
        MEMBERSHIP_BUTTON,
        "⚙️ تنظیمات ربات",
        "👥 مدیریت ادمین‌ها",
        ...Object.keys(stage3Routes)
      ];

      if (knownButtons.includes(text)) {
        const requiredPermission = permissionForButton(text);

        if (requiredPermission && !canAccess(role, requiredPermission)) {
          await sendTelegram(
            env,
            chatId,
            role === "user"
              ? "برای دسترسی به این بخش مجوز مدیریت لازم است."
              : "این بخش فقط برای مالک اصلی در دسترس است.",
            userMenu(isStaff)
          );
          return Response.json({ ok: true });
        }

        if (text === MEMBERSHIP_BUTTON && role === "owner") {
          try {
            await showForcedMembershipPanel(env, chatId);
          } catch (error) {
            console.error("Could not show forced membership panel:", error);
            await sendTelegram(
              env,
              chatId,
              "⚠️ پنل عضویت اجباری باز نشد. تنظیمات قبلی حفظ شده‌اند.",
              adminMenu(true)
            );
          }

          return Response.json({ ok: true });
        }

        const destination = stage3Routes[text];

        if (destination === "admin_home") {
          if (!isStaff) {
            await sendTelegram(env, chatId, "⛔️ دسترسی به پنل مدیریت ندارید.", userMenu(false));
            return Response.json({ ok: true });
          }
          await sendMenu(true);
          return Response.json({ ok: true });
        }

        if (destination === "user_home") {
          await sendMenu(false);
          return Response.json({ ok: true });
        }

        if (destination) {
          await sendTrackedSectionNoticeTelegram(
            env,
            chatId,
            stage3ScreenText(destination),
            stage3Menu(destination, isOwner, isStaff)
          );
          return Response.json({ ok: true });
        }

        await sendTrackedSectionNoticeTelegram(
          env,
          chatId,
          "این بخش هنوز در حال پیاده‌سازی است. گزینه‌ها به‌ترتیب به قابلیت‌های واقعی متصل خواهند شد.",
          sectionMenu(isStaff, Boolean(requiredPermission))
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
