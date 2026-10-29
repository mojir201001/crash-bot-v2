export const ARCHIVE_TIME_ZONE = "Asia/Tehran";

const persianDateFormatter = new Intl.DateTimeFormat(
  "en-US-u-ca-persian-nu-latn",
  {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    timeZone: ARCHIVE_TIME_ZONE
  }
);
const tehranDateFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  hourCycle: "h23",
  timeZone: ARCHIVE_TIME_ZONE
});
const monthStartCache = new Map();

function parts(formatter, date) {
  return Object.fromEntries(
    formatter.formatToParts(date).map(({ type, value }) => [type, Number(value)])
  );
}

function persianMonthOrdinal(date) {
  const dateParts = parts(persianDateFormatter, date);
  return dateParts.year * 12 + dateParts.month;
}

function sqlTimestamp(milliseconds) {
  return new Date(milliseconds).toISOString().replace("T", " ").slice(0, 19);
}

export function getCurrentPersianYear(date = new Date()) {
  return parts(persianDateFormatter, date).year;
}

export function getPersianMonthRange(year, month) {
  if (!Number.isInteger(year) || year < 1300 || year > 1600 ||
      !Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError("Invalid Persian archive year or month");
  }

  const start = persianMonthStart(year, month);
  const nextMonth = month === 12
    ? persianMonthStart(year + 1, 1)
    : persianMonthStart(year, month + 1);
  return { start, end: nextMonth };
}

function persianMonthStart(year, month) {
  const cacheKey = `${year}:${month}`;
  if (monthStartCache.has(cacheKey)) return monthStartCache.get(cacheKey);

  const targetOrdinal = year * 12 + month;
  let low = Date.UTC(year + 621, 1, 1);
  let high = Date.UTC(year + 622, 4, 1);

  if (persianMonthOrdinal(new Date(low + 12 * 60 * 60 * 1000)) >= targetOrdinal ||
      persianMonthOrdinal(new Date(high + 12 * 60 * 60 * 1000)) < targetOrdinal) {
    throw new RangeError("Persian archive date is outside the supported calendar range");
  }

  let lowDay = Math.floor(low / 86400000);
  let highDay = Math.floor(high / 86400000);
  while (lowDay + 1 < highDay) {
    const middleDay = Math.floor((lowDay + highDay) / 2);
    const middleDate = new Date(middleDay * 86400000 + 12 * 60 * 60 * 1000);
    if (persianMonthOrdinal(middleDate) >= targetOrdinal) highDay = middleDay;
    else lowDay = middleDay;
  }

  const utcNoon = new Date(highDay * 86400000 + 12 * 60 * 60 * 1000);
  const local = parts(tehranDateFormatter, utcNoon);
  const offset = Date.UTC(
    local.year, local.month - 1, local.day, local.hour, local.minute
  ) - Date.UTC(
    utcNoon.getUTCFullYear(), utcNoon.getUTCMonth(), utcNoon.getUTCDate(),
    utcNoon.getUTCHours(), utcNoon.getUTCMinutes()
  );
  const localMidnightUtc = Date.UTC(local.year, local.month - 1, local.day) - offset;
  const timestamp = sqlTimestamp(localMidnightUtc);
  monthStartCache.set(cacheKey, timestamp);
  return timestamp;
}
