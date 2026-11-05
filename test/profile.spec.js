import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import * as telegramApi from "../src/telegram/api.js";
import {
  INTEREST_CATEGORIES,
  PERSIAN_MONTHS,
  calculatePersianAge,
  countInterests,
  deleteInterest,
  getPersianYearMonth,
  getProfile,
  getUserWorkflow,
  isProfileComplete,
  normalizeDigits,
  parsePersianBirthYear,
  saveInterest,
  saveProfileField,
  saveUserWorkflow,
  validateProfileField
} from "../src/services/profile.js";
import {
  handleProfileWorkflowMessage,
  handleProfileRoute,
  isProfileReady,
  startProfileFlow
} from "../src/services/profile-flow.js";
import { userMenu } from "../src/telegram/keyboards.js";

const fixtureUsers = new Set();
const fixtureSettings = new Set();

async function createUser() {
  const userId = 700000000 + Math.floor(Math.random() * 100000000);
  fixtureUsers.add(userId);
  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO users (telegram_id, username, first_name)
    VALUES (?, ?, ?)
  `).bind(userId, null, "Profile test").run();
  return userId;
}

async function saveCompleteProfile(userId) {
  const current = getPersianYearMonth();
  const fields = [
    ["nickname", "آزمایشی"],
    ["bio", "دربارهٔ من"],
    ["city", "تهران"],
    ["birth_year", String(current.year - 25)],
    ["birth_month", "فروردین"],
    ["marital_status", "مجرد"],
    ["gender", "زن"],
    ["job", "کار ندارم"],
    ["religion", "ندارم"],
    ["religious_sect", "ندارم"],
    ["field", "علوم آزمایشگاهی"]
  ];
  for (const [field, value] of fields) {
    const result = await saveProfileField(env, userId, field, value);
    expect(result.ok).toBe(true);
  }
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const userId of fixtureUsers) {
    await env.CRASH_BOT_DB.prepare(
      "DELETE FROM users WHERE telegram_id = ?"
    ).bind(userId).run();
  }
  fixtureUsers.clear();
  for (const key of fixtureSettings) {
    await env.CRASH_BOT_DB.prepare(
      "DELETE FROM bot_settings WHERE key = ?"
    ).bind(key).run();
  }
  fixtureSettings.clear();
});

describe("Profile validation and age", () => {
  it("normalizes Persian and Arabic digits and validates Persian birth years", () => {
    expect(normalizeDigits("۱۴۰۵")).toBe("1405");
    expect(normalizeDigits("١٤٠٥")).toBe("1405");
    expect(parsePersianBirthYear("۱۴۰۰")).toBe(1400);
    expect(parsePersianBirthYear("1400")).toBe(1400);
    expect(parsePersianBirthYear("۱۴")).toBeNull();
    expect(validateProfileField("birth_month", "۱۲")).toEqual({
      ok: true,
      value: 12
    });
  });

  it("shows all twelve Persian month choices", () => {
    expect(PERSIAN_MONTHS).toHaveLength(12);
    expect(PERSIAN_MONTHS[0]).toBe("فروردین");
    expect(PERSIAN_MONTHS[11]).toBe("اسفند");
  });

  it("calculates age from the current Persian year and month", () => {
    const current = getPersianYearMonth(new Date("2025-06-21T12:00:00Z"));
    const year = current.year - 20;
    expect(calculatePersianAge(year, current.month, new Date("2025-06-21T12:00:00Z")))
      .toBe(20);
    const previousMonth = current.month === 1 ? 12 : current.month - 1;
    const nextMonth = current.month === 12 ? 1 : current.month + 1;
    const priorYear = current.year - 20;
    expect(calculatePersianAge(priorYear, nextMonth, new Date("2025-06-21T12:00:00Z")))
      .toBe(19);
    expect(calculatePersianAge(priorYear, previousMonth, new Date("2025-06-21T12:00:00Z")))
      .toBe(20);
  });

  it("requires the specified profile fields but not the optional profile image", async () => {
    const userId = await createUser();
    expect(isProfileComplete(await getProfile(env, userId))).toBe(false);
    await saveCompleteProfile(userId);
    expect(isProfileComplete(await getProfile(env, userId))).toBe(true);
  });

  it("rejects invalid field choices and missing required text", () => {
    expect(validateProfileField("job", "  ").ok).toBe(false);
    expect(validateProfileField("gender", "زن")).toEqual({ ok: true, value: "woman" });
    expect(validateProfileField("marital_status", "مجرد"))
      .toEqual({ ok: true, value: "single" });
    expect(validateProfileField("birth_year", "2099").ok).toBe(false);
  });
});

describe("Profile and interest persistence", () => {
  it("stores and edits profile fields without overwriting the rest", async () => {
    const userId = await createUser();
    await saveCompleteProfile(userId);
    await saveProfileField(env, userId, "city", "شیراز");
    const profile = await getProfile(env, userId);

    expect(profile.city).toBe("شیراز");
    expect(profile.nickname).toBe("آزمایشی");
    expect(profile.birth_year).toBeTruthy();
  });

  it("displays the stored profile photo and interest media", async () => {
    const userId = await createUser();
    await saveCompleteProfile(userId);
    await saveProfileField(env, userId, "image_file_id", "profile-photo-id");
    await saveInterest(env, userId, {
      category: "هنر",
      content: "عکس هنری",
      mediaType: "photo",
      mediaFileId: "interest-photo-id",
      caption: "اثر هنری"
    });
    vi.spyOn(telegramApi, "sendTrackedSectionNoticeTelegram").mockResolvedValue(true);
    const mediaSpy = vi.spyOn(telegramApi, "sendMediaTelegramDetailed")
      .mockResolvedValue({ outcome: "sent", messageId: 1 });

    await startProfileFlow(env, userId, userId);
    await handleProfileRoute(env, { chat: { id: userId } }, userId, "interests");

    expect(mediaSpy).toHaveBeenCalledWith(env, "sendPhoto", expect.objectContaining({
      chat_id: userId,
      photo: "profile-photo-id"
    }));
    expect(mediaSpy).toHaveBeenCalledWith(env, "sendPhoto", expect.objectContaining({
      chat_id: userId,
      photo: "interest-photo-id",
      caption: expect.stringContaining("اثر هنری")
    }));
  });

  it("shows a Persian month keyboard and does not render the birth year", async () => {
    const userId = await createUser();
    await saveCompleteProfile(userId);
    const screenSpy = vi.spyOn(telegramApi, "sendTrackedSectionNoticeTelegram")
      .mockResolvedValue(true);
    vi.spyOn(telegramApi, "sendMediaTelegramDetailed")
      .mockResolvedValue({ outcome: "sent", messageId: 1 });

    await startProfileFlow(env, userId, userId);
    const profileText = screenSpy.mock.calls.at(-1)[2];
    expect(profileText).toContain("سن:");
    expect(profileText).not.toContain(String((await getProfile(env, userId)).birth_year));

    await handleProfileRoute(env, {
      chat: { id: userId }
    }, userId, "field_birth_month", "🗓 ماه تولد");
    const monthKeyboard = screenSpy.mock.calls.at(-1)[3];
    expect(monthKeyboard.flat().map((button) => button.text)
      .filter((text) => PERSIAN_MONTHS.includes(text))).toEqual(PERSIAN_MONTHS);
    expect(monthKeyboard.flat().map((button) => button.text))
      .toContain("🏠 منوی اصلی");
  });

  it("keeps home and profile-editor navigation available on edit forms", async () => {
    const userId = await createUser();
    await saveCompleteProfile(userId);
    const screenSpy = vi.spyOn(telegramApi, "sendTrackedSectionNoticeTelegram")
      .mockResolvedValue(true);

    await handleProfileRoute(env, { chat: { id: userId } }, userId, "profile_edit");
    expect(screenSpy.mock.calls.at(-1)[3].flat().map((button) => button.text))
      .toContain("🏠 منوی اصلی");

    await handleProfileRoute(env, { chat: { id: userId } }, userId, "field_bio");
    expect(screenSpy.mock.calls.at(-1)[3].flat().map((button) => button.text))
      .toEqual(["↩️ بازگشت به ویرایش اطلاعات", "🏠 منوی اصلی"]);

    await handleProfileRoute(env, { chat: { id: userId } }, userId, "field_image");
    expect(screenSpy.mock.calls.at(-1)[3].flat().map((button) => button.text))
      .toEqual(["بدون عکس", "↩️ بازگشت به پروفایل", "🏠 منوی اصلی"]);
  });

  it("stores dynamic text/media interests and restricts deletion to the owner", async () => {
    const ownerId = await createUser();
    const otherUserId = await createUser();
    await saveInterest(env, ownerId, {
      category: "سفرهای دلخواه",
      content: "کوهستان",
      mediaType: "photo",
      mediaFileId: "photo-file-id",
      caption: "عکس سفر"
    });

    const rows = await env.CRASH_BOT_DB.prepare(
      "SELECT id, category, content, media_type, media_file_id, caption FROM interests WHERE user_id = ?"
    ).bind(ownerId).all();
    const interest = rows.results[0];
    expect(INTEREST_CATEGORIES).toContain("سایر موارد به دلخواه");
    expect(interest.category).toBe("سفرهای دلخواه");
    expect(interest.media_file_id).toBe("photo-file-id");
    expect(await countInterests(env, ownerId)).toBe(1);
    expect(await deleteInterest(env, otherUserId, interest.id)).toBe(false);
    expect(await deleteInterest(env, ownerId, interest.id)).toBe(true);
    expect(await countInterests(env, ownerId)).toBe(0);
  });

  it("enforces interest integrity in D1", async () => {
    const userId = await createUser();
    await expect(env.CRASH_BOT_DB.prepare(`
      INSERT INTO interests (user_id, category, content)
      VALUES (?, '', '')
    `).bind(userId).run()).rejects.toThrow();
  });

  it("persists workflow state and reports D1 failures instead of hiding them", async () => {
    const userId = await createUser();
    await saveUserWorkflow(env, userId, {
      flowType: "profile",
      stage: "field",
      payload: { field: "nickname", onboarding: true }
    });
    await expect(getUserWorkflow(env, userId)).resolves.toEqual({
      flowType: "profile",
      stage: "field",
      payload: { field: "nickname", onboarding: true }
    });

    const brokenDb = { prepare: () => { throw new Error("D1 unavailable"); } };
    await expect(getProfile({ CRASH_BOT_DB: brokenDb }, userId))
      .rejects.toThrow("D1 unavailable");
  });

  it("processes textless Telegram photos as interest form input", async () => {
    const userId = await createUser();
    await saveUserWorkflow(env, userId, {
      flowType: "interests",
      stage: "content",
      payload: { category: "خوراکی" }
    });
    const screenSpy = vi.spyOn(telegramApi, "sendTrackedSectionNoticeTelegram")
      .mockResolvedValue(true);

    await handleProfileWorkflowMessage(env, {
      chat: { id: userId },
      photo: [{ file_id: "small" }, { file_id: "largest" }],
      caption: "غذای محبوب"
    }, userId);

    const row = await env.CRASH_BOT_DB.prepare(`
      SELECT category, content, media_type, media_file_id, caption
      FROM interests
      WHERE user_id = ?
    `).bind(userId).first();
    expect(row).toEqual({
      category: "خوراکی",
      content: "غذای محبوب",
      media_type: "photo",
      media_file_id: "largest",
      caption: "غذای محبوب"
    });
    expect(screenSpy).toHaveBeenCalled();
  });

  it("does not treat a user-menu tap as interest content", async () => {
    const userId = await createUser();
    await saveUserWorkflow(env, userId, {
      flowType: "interests",
      stage: "content",
      payload: { category: "کتاب" }
    });

    await expect(handleProfileWorkflowMessage(env, {
      chat: { id: userId }, text: "💌 ثبت پست کراش"
    }, userId)).resolves.toBe(false);
    expect(await countInterests(env, userId)).toBe(0);
    await expect(getUserWorkflow(env, userId)).resolves.toBeNull();
  });

  it("asks smoking yes/no first and allows skipping optional details", async () => {
    const userId = await createUser();
    const screenSpy = vi.spyOn(telegramApi, "sendTrackedSectionNoticeTelegram")
      .mockResolvedValue(true);
    await saveUserWorkflow(env, userId, {
      flowType: "interests",
      stage: "category",
      payload: {}
    });
    await handleProfileWorkflowMessage(env, {
      chat: { id: userId }, text: "اسموکینگ"
    }, userId);
    expect(screenSpy.mock.calls.at(-1)[2]).toContain("آیا اسموکینگ داری؟");
    expect(screenSpy.mock.calls.at(-1)[3].flat().map((button) => button.text))
      .toEqual(["بله", "خیر", "↩️ بازگشت به پروفایل", "🏠 منوی اصلی"]);

    await handleProfileWorkflowMessage(env, {
      chat: { id: userId }, text: "بله"
    }, userId);
    expect((await getUserWorkflow(env, userId)).stage).toBe("smoking_detail");
    await handleProfileWorkflowMessage(env, {
      chat: { id: userId }, text: "رد کردن جزئیات"
    }, userId);
    expect(await countInterests(env, userId)).toBe(1);
  });
});

describe("Webhook profile gate and message cleanup", () => {
  it("preserves, replaces, and removes reply keyboards without deleting prior screens", async () => {
    const chatId = 800000000 + Math.floor(Math.random() * 100000000);
    const settingKey = `ui_section_message:${chatId}`;
    fixtureSettings.add(settingKey);
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return {
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 700 + calls.length } })
      };
    }));

    const keyboard = [[{ text: "🏠 منوی اصلی" }]];
    await telegramApi.sendTrackedSectionNoticeTelegram(env, chatId, "صفحهٔ منو", keyboard);
    await telegramApi.sendTrackedSectionNoticeTelegram(env, chatId, "متن آزاد");
    await telegramApi.sendTrackedSectionNoticeTelegram(env, chatId, "حذف صریح", []);

    expect(calls.map(({ body }) => body.reply_markup)).toEqual([
      { keyboard, resize_keyboard: true, is_persistent: false },
      undefined,
      { remove_keyboard: true }
    ]);
    expect(calls.some(({ url }) => url.endsWith("/deleteMessage"))).toBe(false);
  });

  it("clears tracked inline screens without deleting the reply-keyboard screen", async () => {
    const chatId = 800000000 + Math.floor(Math.random() * 100000000);
    const replyKey = `ui_section_message:${chatId}`;
    const inlineKey = `ui_inline_section_message:${chatId}`;
    fixtureSettings.add(replyKey);
    fixtureSettings.add(inlineKey);
    await env.CRASH_BOT_DB.prepare(`
      INSERT INTO bot_settings (key, value) VALUES (?, ?), (?, ?)
    `).bind(replyKey, "701", inlineKey, "702").run();

    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return {
        ok: true,
        json: async () => ({ ok: true, result: true })
      };
    }));

    await telegramApi.clearTrackedSectionMessage(env, chatId);

    expect(calls.map(({ body }) => body.message_id)).toEqual([702]);
    await expect(env.CRASH_BOT_DB.prepare(
      "SELECT value FROM bot_settings WHERE key = ?"
    ).bind(replyKey).first()).resolves.toEqual({ value: "701" });
  });

  it("requires profile completion after membership and preserves /start", async () => {
    const userId = await createUser();
    const telegramCalls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      telegramCalls.push({ url: String(url), body: JSON.parse(init.body) });
      return {
        ok: true,
        json: async () => ({
          ok: true,
          result: { message_id: 500 }
        })
      };
    }));
    const request = new Request("https://example.test/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": env.WEBHOOK_SECRET
      },
      body: JSON.stringify({
        update_id: userId,
        message: {
          message_id: 91,
          from: { id: userId, first_name: "Incomplete" },
          chat: { id: userId, type: "private" },
          text: "/start"
        }
      })
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(telegramCalls.some(({ url }) => url.endsWith("/sendMessage"))).toBe(true);
    expect(telegramCalls.some(({ url, body }) =>
      url.endsWith("/deleteMessage") && body.message_id === 91
    )).toBe(false);
    await expect(getUserWorkflow(env, userId)).resolves.toMatchObject({
      flowType: "profile",
      stage: "field",
      payload: { field: "nickname", onboarding: true }
    });
  });

  it("allows an incomplete user to return to the menu without bypassing the profile gate", async () => {
    const userId = await createUser();
    fixtureSettings.add(`ui_section_message:${userId}`);
    fixtureSettings.add(`ui_main_screen_message:${userId}`);
    const telegramCalls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      telegramCalls.push({ url: String(url), body: JSON.parse(init.body) });
      return {
        ok: true,
        json: async () => ({ ok: true, result: { message_id: telegramCalls.length } })
      };
    }));

    await startProfileFlow(env, userId, userId);
    const request = new Request("https://example.test/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": env.WEBHOOK_SECRET
      },
      body: JSON.stringify({
        update_id: userId,
        message: {
          message_id: 93,
          from: { id: userId, first_name: "Incomplete" },
          chat: { id: userId, type: "private" },
          text: "🏠 منوی اصلی"
        }
      })
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(await isProfileReady(env, userId)).toBe(false);
    const menuCall = telegramCalls.find(({ body }) =>
      body.text?.includes("به کراش‌یاب ادیب خوش اومدی")
    );
    expect(menuCall.body.reply_markup.keyboard).toEqual(userMenu(false));

    const featureRequest = new Request("https://example.test/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": env.WEBHOOK_SECRET
      },
      body: JSON.stringify({
        update_id: userId + 1,
        message: {
          message_id: 94,
          from: { id: userId, first_name: "Incomplete" },
          chat: { id: userId, type: "private" },
          text: "💌 ثبت پست کراش"
        }
      })
    });
    const featureCtx = createExecutionContext();
    const featureResponse = await worker.fetch(featureRequest, env, featureCtx);
    await waitOnExecutionContext(featureCtx);
    expect(featureResponse.status).toBe(200);
    expect(telegramCalls.some(({ body }) =>
      body.text?.includes("تکمیل پروفایل")
    )).toBe(true);
  });

  it("routes media-only webhook updates through an active interest form and deletes the input", async () => {
    const userId = await createUser();
    await saveUserWorkflow(env, userId, {
      flowType: "interests",
      stage: "content",
      payload: { category: "هنر" }
    });
    const telegramCalls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      telegramCalls.push({ url: String(url), body: JSON.parse(init.body) });
      return {
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 600 } })
      };
    }));
    const request = new Request("https://example.test/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": env.WEBHOOK_SECRET
      },
      body: JSON.stringify({
        update_id: userId + 1,
        message: {
          message_id: 92,
          from: { id: userId, first_name: "Media" },
          chat: { id: userId, type: "private" },
          document: {
            file_id: "document-777",
            mime_type: "application/pdf"
          }
        }
      })
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const interest = await env.CRASH_BOT_DB.prepare(`
      SELECT media_type, media_file_id FROM interests WHERE user_id = ?
    `).bind(userId).first();
    expect(interest).toEqual({
      media_type: "document",
      media_file_id: "document-777"
    });
    expect(telegramCalls.some(({ url, body }) =>
      url.endsWith("/deleteMessage") && body.message_id === 92
    )).toBe(true);
  });
});
