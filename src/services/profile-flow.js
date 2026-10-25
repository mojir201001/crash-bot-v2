import {
  INTEREST_CATEGORIES,
  PERSIAN_MONTHS,
  calculatePersianAge,
  countInterests,
  clearUserWorkflow,
  deleteInterest,
  firstMissingProfileField,
  getProfile,
  getUserWorkflow,
  isProfileComplete,
  listInterests,
  profileFieldLabel,
  saveInterest,
  saveProfileField,
  saveUserWorkflow,
  validateProfileField
} from "./profile.js";
import { sendTrackedSectionNoticeTelegram } from "../telegram/api.js";
import { adminMenu, stage3Routes, userMenu } from "../telegram/keyboards.js";

const MAIN_MENU_TEXT = "🏠 منوی اصلی";
const INTERESTS_LATER_TEXT = "بعداً تکمیل می‌کنم";
const INTERESTS_PAGE_SIZE = 8;
const interestFlowControls = new Set([
  "➕ افزودن علاقه‌مندی",
  "⬅️ علایق قبلی",
  "➡️ علایق بعدی",
  "↩️ بازگشت به پروفایل",
  "رد کردن جزئیات"
]);

const profileEditFields = [
  ["nickname", "📝 لقب"],
  ["bio", "📝 دربارهٔ من"],
  ["city", "📍 شهر"],
  ["birth_year", "🎂 سال تولد شمسی"],
  ["birth_month", "🗓 ماه تولد"],
  ["marital_status", "💍 وضعیت تأهل"],
  ["gender", "⚧ جنسیت"],
  ["job", "💼 شغل"],
  ["religion", "🕌 مذهب"],
  ["religious_sect", "🕋 فرقه/مذهب"],
  ["field", "🎓 رشتهٔ تحصیلی"],
  ["image_file_id", "🖼 عکس پروفایل مخصوص ربات"]
];

const navigationButtons = new Set([
  "🏠 منوی اصلی",
  "⬅️ بازگشت",
  "/menu",
  ...userMenu(true).flat().map((button) => button.text),
  ...adminMenu(true).flat().map((button) => button.text),
  ...Object.keys(stage3Routes).filter(
    (text) => !INTEREST_CATEGORIES.includes(text) && !PERSIAN_MONTHS.includes(text)
  ),
  ...profileEditFields.map(([, label]) => label)
]);

const prompts = {
  nickname: "یک لقب برای پروفایلت بنویس.",
  bio: "دربارهٔ خودت بنویس.",
  city: "نام شهرت را بنویس.",
  birth_year: "سال تولدت را به شمسی و با چهار رقم وارد کن؛ ارقام فارسی و انگلیسی پذیرفته می‌شوند.",
  birth_month: "ماه تولدت را با انتخاب یکی از دکمه‌ها مشخص کن.",
  marital_status: "وضعیت تأهلت را انتخاب کن.",
  gender: "جنسیتت را انتخاب کن.",
  job: "شغلت را بنویس. اگر شغلی نداری عبارتی مانند «کار ندارم» وارد کن.",
  religion: "مذهب خود را بنویس.",
  religious_sect: "فرقه/مذهب خود را بنویس. اگر موردی نداری، «ندارم» وارد کن.",
  field: "رشتهٔ تحصیلی‌ات را بنویس؛ برای نمونه «علوم آزمایشگاهی».",
  image_file_id: "یک عکس بفرست یا «بدون عکس» را انتخاب کن. این عکس فقط برای پروفایل ربات استفاده می‌شود."
};

function rowsForField(field) {
  if (field === "birth_month") {
    const rows = [];
    for (let index = 0; index < PERSIAN_MONTHS.length; index += 3) {
      rows.push(PERSIAN_MONTHS.slice(index, index + 3).map((text) => ({ text })));
    }
    return rows;
  }
  if (field === "marital_status") {
    return [[{ text: "مجرد" }, { text: "متأهل" }]];
  }
  if (field === "gender") {
    return [[{ text: "زن" }, { text: "مرد" }]];
  }
  if (field === "image_file_id") {
    return [[{ text: "بدون عکس" }]];
  }
  return [];
}

function categoryRows(categories = INTEREST_CATEGORIES) {
  const rows = [];
  for (let index = 0; index < categories.length; index += 2) {
    rows.push(categories.slice(index, index + 2).map((text) => ({ text })));
  }
  return rows;
}

function mediaFromMessage(message) {
  const photo = Array.isArray(message?.photo) ? message.photo.at(-1) : null;
  if (photo?.file_id) return { type: "photo", fileId: photo.file_id };

  for (const type of [
    "video", "document", "audio", "voice", "animation", "video_note", "sticker"
  ]) {
    if (message?.[type]?.file_id) {
      return { type, fileId: message[type].file_id };
    }
  }

  return null;
}

function textFromMessage(message) {
  return String(message?.text ?? message?.caption ?? "").trim();
}

function persianNumber(value) {
  return Number(value).toLocaleString("fa-IR");
}

async function sendScreen(env, chatId, text, keyboard = []) {
  const sent = await sendTrackedSectionNoticeTelegram(env, chatId, text, keyboard);
  if (!sent) throw new Error("Could not send the profile workflow screen");
}

async function showFieldPrompt(env, chatId, userId, field, onboarding) {
  if (field === "birth_month") {
    const profile = await getProfile(env, userId);
    if (!profile?.birth_year) {
      return showFieldPrompt(env, chatId, userId, "birth_year", onboarding);
    }
  }

  await saveUserWorkflow(env, userId, {
    flowType: "profile",
    stage: "field",
    payload: { field, onboarding }
  });

  const prefix = onboarding
    ? `📝 تکمیل پروفایل — ${profileFieldLabel(field)} اجباری است.\n\n`
    : `✏️ ویرایش ${profileFieldLabel(field)}\n\n`;
  await sendScreen(env, chatId, `${prefix}${prompts[field]}`, rowsForField(field));
}

async function showProfile(env, chatId, userId) {
  const profile = await getProfile(env, userId);
  if (!isProfileComplete(profile)) {
    const firstMissing = firstMissingProfileField(profile);
    await showFieldPrompt(env, chatId, userId, firstMissing, true);
    return;
  }

  const age = calculatePersianAge(profile.birth_year, profile.birth_month);
  const maritalStatus = profile.marital_status === "married" ? "متأهل" : "مجرد";
  const gender = profile.gender === "woman" ? "زن" : "مرد";
  const lines = [
    "👤 پروفایل من",
    "",
    `لقب: ${profile.nickname}`,
    `دربارهٔ من: ${profile.bio}`,
    `شهر: ${profile.city}`,
    `سن: ${age === null ? "نامشخص" : persianNumber(age)}`,
    `وضعیت تأهل: ${maritalStatus}`,
    `جنسیت: ${gender}`,
    `شغل: ${profile.job}`,
    `مذهب: ${profile.religion}`,
    `فرقه/مذهب: ${profile.religious_sect}`,
    `رشتهٔ تحصیلی: ${profile.field}`,
    `عکس پروفایل: ${profile.image_file_id ? "ثبت شده" : "ثبت نشده"}`
  ];

  await clearUserWorkflow(env, userId);
  await sendScreen(env, chatId, lines.join("\n"), [
    [{ text: "✏️ ویرایش اطلاعات" }, { text: "❤️ علاقه‌مندی‌های من" }],
    [{ text: MAIN_MENU_TEXT }]
  ]);
}

async function showEditMenu(env, chatId, userId) {
  const rows = [];
  for (let index = 0; index < profileEditFields.length; index += 2) {
    rows.push(profileEditFields.slice(index, index + 2).map(([, text]) => ({ text })));
  }
  rows.push([{ text: "❤️ علاقه‌مندی‌های من" }], [{ text: "↩️ بازگشت به پروفایل" }]);
  await clearUserWorkflow(env, userId);
  await sendScreen(env, chatId, "✏️ فیلدی را برای ویرایش انتخاب کن.", rows);
}

async function showInterests(env, chatId, userId, page = 0) {
  const total = await countInterests(env, userId);
  const pageCount = Math.max(1, Math.ceil(total / INTERESTS_PAGE_SIZE));
  const currentPage = Math.min(Math.max(0, page), pageCount - 1);
  const visible = await listInterests(
    env, userId, INTERESTS_PAGE_SIZE, currentPage * INTERESTS_PAGE_SIZE
  );
  const lines = visible.length
    ? visible.map((interest) => {
        const content = interest.content || interest.caption ||
          (interest.media_file_id ? `رسانهٔ ${interest.media_type ?? "پیوست"}` : "");
        const characters = Array.from(content);
        const preview = characters.slice(0, 200).join("");
        return `#${interest.id} — ${interest.category}: ${preview}${characters.length > 200 ? "…" : ""}`;
      })
    : ["هنوز علاقه‌ای ثبت نشده است."];
  const rows = visible.map((interest) => [{ text: `🗑 حذف علاقه #${interest.id}` }]);
  if (currentPage > 0) rows.push([{ text: "⬅️ علایق قبلی" }]);
  if (currentPage + 1 < pageCount) rows.push([{ text: "➡️ علایق بعدی" }]);
  rows.push([{ text: "➕ افزودن علاقه‌مندی" }], [{ text: "↩️ بازگشت به پروفایل" }]);

  await saveUserWorkflow(env, userId, {
    flowType: "interests",
    stage: "list",
    payload: { page: currentPage }
  });
  await sendScreen(
    env,
    chatId,
    `❤️ علاقه‌مندی‌های من (${persianNumber(total)})\n\n${lines.join("\n")}`,
    rows
  );
}

async function beginInterests(env, chatId, userId) {
  await saveUserWorkflow(env, userId, {
    flowType: "interests",
    stage: "category",
    payload: {}
  });
  await sendScreen(env, chatId, "دستهٔ علاقه‌مندی را انتخاب کن.", categoryRows());
}

async function showInterestsOffer(env, chatId, userId) {
  await saveUserWorkflow(env, userId, {
    flowType: "profile",
    stage: "interests_offer",
    payload: {}
  });
  await sendScreen(env, chatId,
    "✅ اطلاعات اجباری پروفایلت ثبت شد.\n\nمی‌توانی همین حالا علاقه‌مندی‌ها را تکمیل کنی یا بعداً از صفحهٔ پروفایل به آن‌ها برگردی.",
    [[{ text: "➕ ثبت علاقه‌مندی‌ها" }, { text: INTERESTS_LATER_TEXT }]]
  );
}

export async function startProfileFlow(env, chatId, userId) {
  const profile = await getProfile(env, userId);
  if (isProfileComplete(profile)) {
    await showProfile(env, chatId, userId);
    return;
  }
  const workflow = await getUserWorkflow(env, userId);
  if (workflow?.flowType === "profile" && workflow.stage === "field") {
    await showFieldPrompt(
      env, chatId, userId, workflow.payload.field, workflow.payload.onboarding === true
    );
    return;
  }
  await showFieldPrompt(
    env, chatId, userId, firstMissingProfileField(profile), true
  );
}

export async function startInterestList(env, chatId, userId) {
  await showInterests(env, chatId, userId);
}

export async function startProfileEdit(env, chatId, userId) {
  const profile = await getProfile(env, userId);
  if (!isProfileComplete(profile)) {
    await startProfileFlow(env, chatId, userId);
    return;
  }
  await showEditMenu(env, chatId, userId);
}

export async function isProfileReady(env, userId) {
  return isProfileComplete(await getProfile(env, userId));
}

function fieldFromEditButton(text) {
  return profileEditFields.find(([, label]) => label === text)?.[0] ?? null;
}

async function showCurrentPrompt(env, chatId, userId, workflow) {
  if (workflow.flowType === "profile" && workflow.stage === "field") {
    await showFieldPrompt(
      env, chatId, userId, workflow.payload.field, workflow.payload.onboarding === true
    );
  } else if (workflow.flowType === "profile" && workflow.stage === "interests_offer") {
    await showInterestsOffer(env, chatId, userId);
  } else if (workflow.flowType === "interests" && workflow.stage === "category") {
    await beginInterests(env, chatId, userId);
  } else if (workflow.flowType === "interests" && workflow.stage === "list") {
    await showInterests(env, chatId, userId, workflow.payload.page ?? 0);
  }
}

async function advanceOnboarding(env, chatId, userId) {
  const profile = await getProfile(env, userId);
  if (!isProfileComplete(profile)) {
    await showFieldPrompt(env, chatId, userId, firstMissingProfileField(profile), true);
  } else if (!profile.image_file_id) {
    await showFieldPrompt(env, chatId, userId, "image_file_id", true);
  } else {
    await showInterestsOffer(env, chatId, userId);
  }
}

async function handleProfileField(env, message, userId, workflow) {
  const chatId = message.chat.id;
  const { field, onboarding } = workflow.payload;
  const text = textFromMessage(message);

  if (field === "image_file_id") {
    if (text === "بدون عکس") {
      if (onboarding) await showInterestsOffer(env, chatId, userId);
      else {
        await saveProfileField(env, userId, "image_file_id", null);
        await showProfile(env, chatId, userId);
      }
      return true;
    }
    const image = Array.isArray(message.photo) ? message.photo.at(-1) : null;
    const document = message.document?.mime_type?.startsWith("image/")
      ? message.document
      : null;
    const imageFileId = image?.file_id ?? document?.file_id;
    if (!imageFileId) {
      await sendScreen(env, chatId, `${prompts.image_file_id}\n\nفقط عکس یا فایل تصویری پذیرفته می‌شود.`, rowsForField(field));
      return true;
    }
    await saveProfileField(env, userId, "image_file_id", imageFileId);
    if (onboarding) await showInterestsOffer(env, chatId, userId);
    else await showProfile(env, chatId, userId);
    return true;
  }

  if (!text) {
    await sendScreen(env, chatId, `${prompts[field]}\n\nبرای این فیلد، متن یا گزینهٔ مناسب را بفرست.`, rowsForField(field));
    return true;
  }

  const validation = validateProfileField(field, text);
  if (!validation.ok) {
    await sendScreen(env, chatId, `${validation.error}\n\n${prompts[field]}`, rowsForField(field));
    return true;
  }
  await saveProfileField(env, userId, field, text);

  if (field === "birth_year") {
    await showFieldPrompt(env, chatId, userId, "birth_month", onboarding === true);
  } else if (onboarding) {
    await advanceOnboarding(env, chatId, userId);
  } else {
    await showProfile(env, chatId, userId);
  }
  return true;
}

async function handleInterestWorkflow(env, message, userId, workflow) {
  const chatId = message.chat.id;
  const text = textFromMessage(message);
  const media = mediaFromMessage(message);

  const page = Number.isInteger(workflow.payload.page) ? workflow.payload.page : 0;

  if (workflow.stage === "list") {
    if (text === "➕ افزودن علاقه‌مندی") {
      await beginInterests(env, chatId, userId);
      return true;
    }
    if (text === "↩️ بازگشت به پروفایل") {
      await showProfile(env, chatId, userId);
      return true;
    }
    if (text === "➡️ علایق بعدی") {
      await showInterests(env, chatId, userId, page + 1);
      return true;
    }
    if (text === "⬅️ علایق قبلی") {
      await showInterests(env, chatId, userId, page - 1);
      return true;
    }
    const deletion = /^🗑 حذف علاقه #(\d+)$/.exec(text);
    if (deletion) {
      const removed = await deleteInterest(env, userId, Number(deletion[1]));
      if (!removed) {
        await sendScreen(env, chatId, "این علاقه وجود ندارد یا قبلاً حذف شده است.", [
          [{ text: "❤️ علاقه‌مندی‌های من" }]
        ]);
        return true;
      }
      await showInterests(env, chatId, userId, page);
      return true;
    }
    await showInterests(env, chatId, userId, page);
    return true;
  }

  if (workflow.stage === "category") {
    if (text === "↩️ بازگشت به پروفایل") {
      await showProfile(env, chatId, userId);
      return true;
    }
    if (!INTEREST_CATEGORIES.includes(text)) {
      await beginInterests(env, chatId, userId);
      return true;
    }
    if (text === "اسموکینگ") {
      await saveUserWorkflow(env, userId, {
        flowType: "interests",
        stage: "smoking_choice",
        payload: { category: text }
      });
      await sendScreen(env, chatId, "آیا اسموکینگ داری؟", [
        [{ text: "بله" }, { text: "خیر" }],
        [{ text: "↩️ بازگشت به پروفایل" }]
      ]);
      return true;
    }
    if (text === "سایر موارد به دلخواه") {
      await saveUserWorkflow(env, userId, {
        flowType: "interests",
        stage: "other_category",
        payload: {}
      });
      await sendScreen(env, chatId, "نام دستهٔ دلخواهت را بنویس.", [
        [{ text: "↩️ بازگشت به پروفایل" }]
      ]);
      return true;
    }
    await saveUserWorkflow(env, userId, {
      flowType: "interests",
      stage: "content",
      payload: { category: text }
    });
    await sendScreen(env, chatId,
      `متن یا رسانهٔ مربوط به «${text}» را بفرست. کپشن رسانه هم ذخیره می‌شود.`,
      [[{ text: "↩️ بازگشت به پروفایل" }]]
    );
    return true;
  }

  if (workflow.stage === "smoking_choice") {
    if (text === "↩️ بازگشت به پروفایل") {
      await showProfile(env, chatId, userId);
      return true;
    }
    if (text !== "بله" && text !== "خیر") {
      await sendScreen(env, chatId, "ابتدا با «بله» یا «خیر» پاسخ بده.", [
        [{ text: "بله" }, { text: "خیر" }],
        [{ text: "↩️ بازگشت به پروفایل" }]
      ]);
      return true;
    }
    await saveInterest(env, userId, { category: "اسموکینگ", content: text });
    if (text === "خیر") {
      await showInterests(env, chatId, userId);
    } else {
      await saveUserWorkflow(env, userId, {
        flowType: "interests",
        stage: "smoking_detail",
        payload: { category: "اسموکینگ" }
      });
      await sendScreen(env, chatId, "جزئیات اسموکینگ را در صورت تمایل بفرست یا از آن صرف‌نظر کن.", [
        [{ text: "رد کردن جزئیات" }]
      ]);
    }
    return true;
  }

  if (workflow.stage === "other_category") {
    if (text === "↩️ بازگشت به پروفایل") {
      await showProfile(env, chatId, userId);
      return true;
    }
    const category = text;
    if (!category || category.length > 100) {
      await sendScreen(env, chatId, "نام دسته باید بین ۱ تا ۱۰۰ نویسه باشد.", [
        [{ text: "↩️ بازگشت به پروفایل" }]
      ]);
      return true;
    }
    await saveUserWorkflow(env, userId, {
      flowType: "interests",
      stage: "content",
      payload: { category }
    });
    await sendScreen(env, chatId, `متن یا رسانهٔ مربوط به «${category}» را بفرست.`);
    return true;
  }

  if (workflow.stage === "content" || workflow.stage === "smoking_detail") {
    if (text === "↩️ بازگشت به پروفایل") {
      await showInterests(env, chatId, userId);
      return true;
    }
    if (workflow.stage === "smoking_detail" && text === "رد کردن جزئیات") {
      await showInterests(env, chatId, userId);
      return true;
    }
    if (!text && !media) {
      await sendScreen(env, chatId, "متن یا رسانهٔ پشتیبانی‌شده بفرست.", []);
      return true;
    }
    const content = text;
    await saveInterest(env, userId, {
      category: workflow.payload.category,
      content,
      caption: message.caption ?? "",
      mediaType: media?.type ?? null,
      mediaFileId: media?.fileId ?? null
    });
    await showInterests(env, chatId, userId);
    return true;
  }

  await showInterests(env, chatId, userId);
  return true;
}

export async function handleProfileWorkflowMessage(env, message, userId) {
  const workflow = await getUserWorkflow(env, userId);
  if (!workflow) return false;

  const text = textFromMessage(message);
  const chatId = message.chat?.id;
  if (!chatId) return false;

  if (text === "/start" || text === "/menu") {
    await showCurrentPrompt(env, chatId, userId, workflow);
    return true;
  }
  if (
    navigationButtons.has(text) &&
    !interestFlowControls.has(text) &&
    !/^🗑 حذف علاقه #\d+$/.test(text)
  ) {
    await clearUserWorkflow(env, userId);
    return false;
  }
  if (workflow.flowType === "profile" && workflow.stage === "interests_offer") {
    if (text === "➕ ثبت علاقه‌مندی‌ها") {
      await beginInterests(env, chatId, userId);
    } else if (text === INTERESTS_LATER_TEXT) {
      await clearUserWorkflow(env, userId);
      await sendScreen(env, chatId, "پروفایلت آماده است؛ هر زمان خواستی می‌توانی علایق را از پروفایل اضافه کنی.", [
        [{ text: MAIN_MENU_TEXT }, { text: "❤️ علاقه‌مندی‌های من" }]
      ]);
    } else {
      await showInterestsOffer(env, chatId, userId);
    }
    return true;
  }

  if (workflow.flowType === "profile" && workflow.stage === "field") {
    if (text === "↩️ بازگشت به پروفایل" && !workflow.payload.onboarding) {
      await showProfile(env, chatId, userId);
      return true;
    }
    if (text === "↩️ بازگشت به ویرایش اطلاعات" && !workflow.payload.onboarding) {
      await showEditMenu(env, chatId, userId);
      return true;
    }
    return handleProfileField(env, message, userId, workflow);
  }

  if (workflow.flowType === "interests") {
    return handleInterestWorkflow(env, message, userId, workflow);
  }

  await clearUserWorkflow(env, userId);
  return false;
}

export async function handleProfileRoute(env, message, userId, destination, text) {
  const chatId = message.chat?.id;
  if (!chatId) return false;

  if (destination === "profile") {
    await startProfileFlow(env, chatId, userId);
    return true;
  }
  if (destination === "profile_edit") {
    await startProfileEdit(env, chatId, userId);
    return true;
  }
  if (destination === "interests") {
    await startInterestList(env, chatId, userId);
    return true;
  }
  if (destination === "interest_add") {
    await beginInterests(env, chatId, userId);
    return true;
  }

  const fieldFromRoute = {
    field_nickname: "nickname",
    field_birth: "birth_year",
    field_birth_month: "birth_month",
    field_religion: "religion",
    field_sect: "religious_sect",
    field_location: "city",
    field_marital: "marital_status",
    field_gender: "gender",
    field_bio: "bio",
    field_job: "job",
    field_field: "field",
    field_image: "image_file_id"
  }[destination];
  const field = fieldFromRoute ?? fieldFromEditButton(text);
  if (!field) return false;
  if (field === "birth_month") {
    const profile = await getProfile(env, userId);
    if (!profile?.birth_year) {
      await showFieldPrompt(env, chatId, userId, "birth_year", false);
      return true;
    }
  }
  await showFieldPrompt(env, chatId, userId, field, false);
  return true;
}

export function hasSupportedMedia(message) {
  return Boolean(mediaFromMessage(message));
}
