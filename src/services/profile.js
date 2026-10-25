export const PROFILE_FIELDS = [
  "nickname",
  "bio",
  "city",
  "birth_year",
  "birth_month",
  "marital_status",
  "gender",
  "job",
  "religion",
  "religious_sect",
  "field",
  "image_file_id"
];

export const REQUIRED_PROFILE_FIELDS = PROFILE_FIELDS.filter(
  (field) => field !== "image_file_id"
);

export const PERSIAN_MONTHS = [
  "فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور",
  "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"
];

export const INTEREST_CATEGORIES = [
  "خوراکی", "تفریحات", "اسموکینگ", "فیلم و سریال", "بازی",
  "موزیک", "ورزش", "طبیعت", "هنر", "بازیگر", "خواننده", "کشور",
  "مکان‌های دیدنی", "میوه", "حیوان", "رنگ", "وسایل نقلیه",
  "مذهبی", "گل", "کتاب", "مد و استایل", "سلبریتی و ورزشکار",
  "سایر موارد به دلخواه"
];

const profileFieldLimits = {
  nickname: 80,
  bio: 500,
  city: 100,
  job: 120,
  religion: 100,
  religious_sect: 100,
  field: 160
};

const fieldLabels = {
  nickname: "لقب",
  bio: "دربارهٔ من",
  city: "شهر",
  birth_year: "سال تولد شمسی",
  birth_month: "ماه تولد",
  marital_status: "وضعیت تأهل",
  gender: "جنسیت",
  job: "شغل",
  religion: "مذهب",
  religious_sect: "فرقه/مذهب",
  field: "رشتهٔ تحصیلی",
  image_file_id: "عکس پروفایل مخصوص ربات"
};

export function normalizeDigits(value) {
  return String(value).replace(/[۰-۹٠-٩]/g, (digit) => {
    const code = digit.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

export function getPersianYearMonth(date = new Date()) {
  const parts = new Intl.DateTimeFormat(
    "en-US-u-ca-persian-nu-latn",
    { year: "numeric", month: "numeric", timeZone: "Asia/Tehran" }
  ).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const year = Number(values.year);
  const month = Number(values.month);

  if (!Number.isInteger(year) || !Number.isInteger(month)) {
    throw new Error("Could not determine the current Persian calendar date");
  }

  return { year, month };
}

export function parsePersianBirthYear(value, date = new Date()) {
  const normalized = normalizeDigits(value).trim();
  if (!/^\d{4}$/.test(normalized)) return null;

  const year = Number(normalized);
  const current = getPersianYearMonth(date);
  return year >= 1300 && year <= current.year ? year : null;
}

export function calculatePersianAge(birthYear, birthMonth, date = new Date()) {
  if (
    !Number.isInteger(Number(birthYear)) ||
    !Number.isInteger(Number(birthMonth)) ||
    Number(birthMonth) < 1 ||
    Number(birthMonth) > 12
  ) {
    return null;
  }

  const current = getPersianYearMonth(date);
  const age = current.year - Number(birthYear) -
    (Number(birthMonth) > current.month ? 1 : 0);
  return age >= 0 ? age : null;
}

export function profileFieldLabel(field) {
  return fieldLabels[field] ?? field;
}

export async function getProfile(env, userId) {
  return env.CRASH_BOT_DB.prepare(`
    SELECT nickname, bio, city, birth_year, birth_month, marital_status,
           gender, job, religion, religious_sect, field, image_file_id
    FROM profiles
    WHERE user_id = ?
  `).bind(userId).first();
}

export function isProfileComplete(profile) {
  if (!profile) return false;

  return REQUIRED_PROFILE_FIELDS.every((field) => {
    const value = profile[field];
    if (value === null || value === undefined || String(value).trim() === "") {
      return false;
    }
    if (field === "birth_year") return parsePersianBirthYear(value) !== null;
    if (field === "birth_month") return Number(value) >= 1 && Number(value) <= 12;
    if (field === "marital_status") return ["single", "married"].includes(value);
    if (field === "gender") return ["man", "woman"].includes(value);
    return true;
  });
}

export function firstMissingProfileField(profile) {
  return REQUIRED_PROFILE_FIELDS.find((field) => {
    const value = profile?.[field];
    if (value === null || value === undefined || String(value).trim() === "") {
      return true;
    }
    if (field === "birth_year") return parsePersianBirthYear(value) === null;
    if (field === "birth_month") return Number(value) < 1 || Number(value) > 12;
    if (field === "marital_status") return !["single", "married"].includes(value);
    if (field === "gender") return !["man", "woman"].includes(value);
    return false;
  }) ?? null;
}

export function validateProfileField(field, rawValue, date = new Date()) {
  if (!PROFILE_FIELDS.includes(field) || field === "image_file_id") {
    return { ok: false, error: "این فیلد قابل ثبت نیست." };
  }

  if (field === "birth_year") {
    const value = parsePersianBirthYear(rawValue, date);
    return value === null
      ? { ok: false, error: "سال را با چهار رقم معتبر شمسی وارد کن." }
      : { ok: true, value };
  }

  if (field === "birth_month") {
    const normalized = normalizeDigits(rawValue).trim();
    const number = /^\d{1,2}$/.test(normalized)
      ? Number(normalized)
      : PERSIAN_MONTHS.indexOf(String(rawValue).trim()) + 1;
    return number >= 1 && number <= 12
      ? { ok: true, value: number }
      : { ok: false, error: "یکی از ماه‌های نمایش‌داده‌شده را انتخاب کن." };
  }

  if (field === "marital_status") {
    const values = { "مجرد": "single", "متأهل": "married" };
    return values[rawValue]
      ? { ok: true, value: values[rawValue] }
      : { ok: false, error: "وضعیت تأهل را با دکمه‌ها انتخاب کن." };
  }

  if (field === "gender") {
    const values = { "زن": "woman", "مرد": "man" };
    return values[rawValue]
      ? { ok: true, value: values[rawValue] }
      : { ok: false, error: "جنسیت را با دکمه‌ها انتخاب کن." };
  }

  const value = String(rawValue ?? "").trim();
  const maxLength = profileFieldLimits[field];
  if (!value) return { ok: false, error: "این فیلد اجباری است؛ لطفاً یک مقدار وارد کن." };
  if (value.length > maxLength) {
    return { ok: false, error: `حداکثر طول این فیلد ${maxLength} نویسه است.` };
  }

  return { ok: true, value };
}

export async function saveProfileField(env, userId, field, rawValue) {
  if (!PROFILE_FIELDS.includes(field)) {
    throw new Error(`Unsupported profile field: ${field}`);
  }

  const validated = field === "image_file_id"
    ? (rawValue === null
        ? { ok: true, value: null }
        : (typeof rawValue === "string" && rawValue.trim()
            ? { ok: true, value: rawValue.trim() }
            : { ok: false, error: "عکس پروفایل معتبر نیست." }))
    : validateProfileField(field, rawValue);

  if (!validated.ok) return validated;

  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO profiles (user_id, ${field})
    VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      ${field} = excluded.${field},
      updated_at = CURRENT_TIMESTAMP
  `).bind(userId, validated.value).run();

  return { ok: true, value: validated.value };
}

export async function listInterests(env, userId, limit = 8, offset = 0) {
  const result = await env.CRASH_BOT_DB.prepare(`
    SELECT id, category, content, media_type, media_file_id, caption, created_at
    FROM interests
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `).bind(userId, limit, offset).all();

  return result.results ?? [];
}

export async function countInterests(env, userId) {
  const row = await env.CRASH_BOT_DB.prepare(
    "SELECT COUNT(*) AS count FROM interests WHERE user_id = ?"
  ).bind(userId).first();
  return Number(row?.count ?? 0);
}

export async function saveInterest(env, userId, interest) {
  const category = String(interest?.category ?? "").trim();
  const content = String(interest?.content ?? "").trim();
  const caption = String(interest?.caption ?? "").trim();
  const mediaType = interest?.mediaType ?? null;
  const mediaFileId = interest?.mediaFileId ?? null;

  if (!category || category.length > 100) {
    throw new Error("Interest category must contain 1 to 100 characters");
  }
  if (content.length > 1000 || caption.length > 1000) {
    throw new Error("Interest text is too long");
  }
  if (
    (mediaType !== null && !["photo", "video", "document", "audio", "voice", "animation", "video_note", "sticker"].includes(mediaType)) ||
    (mediaFileId !== null && typeof mediaFileId !== "string") ||
    (mediaFileId !== null && !mediaFileId.trim()) ||
    ((mediaType === null) !== (mediaFileId === null))
  ) {
    throw new Error("Unsupported interest media");
  }
  if (!content && !caption && !mediaFileId) {
    throw new Error("An interest must contain text or supported media");
  }

  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO interests (
      user_id, category, content, media_type, media_file_id, caption
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).bind(userId, category, content, mediaType, mediaFileId, caption).run();
}

export async function deleteInterest(env, userId, interestId) {
  const result = await env.CRASH_BOT_DB.prepare(`
    DELETE FROM interests
    WHERE id = ? AND user_id = ?
  `).bind(interestId, userId).run();

  return (result.meta?.changes ?? 0) === 1;
}

export async function getUserWorkflow(env, userId) {
  const row = await env.CRASH_BOT_DB.prepare(`
    SELECT flow_type, stage, payload
    FROM user_workflows
    WHERE user_id = ?
  `).bind(userId).first();

  if (!row) return null;

  let payload;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    throw new Error("Stored user workflow payload is invalid JSON");
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Stored user workflow payload must be an object");
  }

  const stages = {
    profile: ["field", "interests_offer"],
    interests: [
      "list", "category", "smoking_choice", "other_category", "content",
      "smoking_detail"
    ]
  };
  if (!stages[row.flow_type]?.includes(row.stage)) {
    throw new Error("Stored user workflow type or stage is invalid");
  }
  if (
    row.flow_type === "profile" &&
    row.stage === "field" &&
    (!PROFILE_FIELDS.includes(payload.field) || typeof payload.onboarding !== "boolean")
  ) {
    throw new Error("Stored profile workflow field is invalid");
  }
  if (
    row.flow_type === "interests" &&
    ["content", "smoking_choice", "smoking_detail"].includes(row.stage) &&
    (typeof payload.category !== "string" || !payload.category.trim())
  ) {
    throw new Error("Stored interest workflow category is invalid");
  }
  if (
    row.flow_type === "interests" &&
    row.stage === "list" &&
    (!Number.isInteger(payload.page) || payload.page < 0)
  ) {
    throw new Error("Stored interest list page is invalid");
  }

  return { flowType: row.flow_type, stage: row.stage, payload };
}

export async function saveUserWorkflow(env, userId, workflow) {
  await env.CRASH_BOT_DB.prepare(`
    INSERT INTO user_workflows (user_id, flow_type, stage, payload, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      flow_type = excluded.flow_type,
      stage = excluded.stage,
      payload = excluded.payload,
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    userId,
    workflow.flowType,
    workflow.stage,
    JSON.stringify(workflow.payload ?? {})
  ).run();
}

export async function clearUserWorkflow(env, userId) {
  await env.CRASH_BOT_DB.prepare(
    "DELETE FROM user_workflows WHERE user_id = ?"
  ).bind(userId).run();
}
