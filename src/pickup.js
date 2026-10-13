// One server-owned calendar for new reservations. Existing order appointments
// are stored snapshots and must never be recomputed when reading/sending them.
const TIME_ZONE = "Europe/Vienna";
const FIRST_ALLOWED_DAY = "2026-11-06";
const LEAD_DAYS = Number(process.env.ORDER_LEAD_DAYS || 2);
const configuredFirstDay = process.env.PICKUP_FIRST_DAY || FIRST_ALLOWED_DAY;
const PICKUP_FIRST_DAY = configuredFirstDay < FIRST_ALLOWED_DAY ? FIRST_ALLOWED_DAY : configuredFirstDay;
const PICKUP_LAST_DAY = process.env.PICKUP_LAST_DAY || "2026-12-31";
const PICKUP_DAILY_FROM = process.env.PICKUP_DAILY_FROM || "2026-12-27";
const PICKUP_DAILY_UNTIL = process.env.PICKUP_DAILY_UNTIL || "2026-12-31";
const PICKUP_CLOSED = (process.env.PICKUP_CLOSED || "2026-12-24,2026-12-25,2026-12-26")
  .split(",").map(value => value.trim()).filter(Boolean);
const SLOT_FRIDAY = "13:00–16:00 Uhr";
const SLOT_SATURDAY = "09:00–12:00 Uhr";
const SLOT_DAILY = "08:00–12:00 Uhr";

function calendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.valueOf()) && isoDay(date) === value ? date : null;
}
if (!Number.isInteger(LEAD_DAYS) || LEAD_DAYS < 0 || LEAD_DAYS > 365
  || ![configuredFirstDay, PICKUP_LAST_DAY, PICKUP_DAILY_FROM, PICKUP_DAILY_UNTIL, ...PICKUP_CLOSED].every(calendarDate)) {
  throw new Error("invalid_pickup_configuration");
}
function isoDay(date) { return date.toISOString().slice(0, 10); }
function viennaDateOnly(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const part = type => parts.find(value => value.type === type).value;
  return calendarDate(`${part("year")}-${part("month")}-${part("day")}`);
}
function formatGermanDate(date) {
  return date.toLocaleDateString("de-AT", {
    weekday: "long", day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC",
  });
}
function isDaily(date) {
  const day = isoDay(date);
  return day >= PICKUP_DAILY_FROM && day <= PICKUP_DAILY_UNTIL;
}
function slotForDay(date) {
  const day = isoDay(date);
  if (day < PICKUP_FIRST_DAY || day > PICKUP_LAST_DAY || PICKUP_CLOSED.includes(day)) return null;
  if (isDaily(date)) return SLOT_DAILY;
  if (date.getUTCDay() === 5) return SLOT_FRIDAY;
  if (date.getUTCDay() === 6) return SLOT_SATURDAY;
  return null;
}
function addDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}
function pickupOptions(now = new Date()) {
  const today = viennaDateOnly(now);
  // Monday=0 ... Sunday=6. Thursday through Sunday move to next week.
  const weekday = (today.getUTCDay() + 6) % 7;
  const regularFriday = addDays(today, 4 - weekday + (weekday >= 3 ? 7 : 0));
  const dailyEarliest = addDays(today, LEAD_DAYS);
  const options = [];
  for (let date = calendarDate(PICKUP_FIRST_DAY), last = calendarDate(PICKUP_LAST_DAY);
    date <= last; date = addDays(date, 1)) {
    const timeWindow = slotForDay(date);
    if (!timeWindow || date < (isDaily(date) ? dailyEarliest : regularFriday)) continue;
    options.push({ date: isoDay(date), timeWindow,
      label: `${formatGermanDate(date)}, ${timeWindow}`, kind: isDaily(date) ? "daily" : "regular" });
  }
  return options;
}
function computeAbholzeit(now = new Date()) { return pickupOptions(now)[0]?.label || null; }
function abholzeitText(value) { return value || "Wir vereinbaren den Termin mit dir per E-Mail"; }
module.exports = { TIME_ZONE, LEAD_DAYS, PICKUP_FIRST_DAY, PICKUP_LAST_DAY, PICKUP_DAILY_FROM,
  PICKUP_DAILY_UNTIL, PICKUP_CLOSED, calendarDate, viennaDateOnly, isoDay,
  slotForDay, formatGermanDate, pickupOptions, computeAbholzeit, abholzeitText };
