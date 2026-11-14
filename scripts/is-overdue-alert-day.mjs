import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflows = JSON.parse(
  readFileSync(join(root, "config", "assistant-workflows.json"), "utf8"),
);
const calendar = JSON.parse(
  readFileSync(join(root, workflows.overdue_alert.holiday_calendar), "utf8"),
);

const dateIndex = process.argv.indexOf("--date");
const requestedDate = dateIndex >= 0 ? process.argv[dateIndex + 1] : "";
const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: workflows.overdue_alert.timezone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "long",
});
const parts = Object.fromEntries(
  formatter.formatToParts(new Date()).map((part) => [part.type, part.value]),
);
const today = requestedDate || `${parts.year}-${parts.month}-${parts.day}`;
const date = new Date(`${today}T00:00:00+08:00`);
if (Number.isNaN(date.getTime())) {
  process.stdout.write(
    `${JSON.stringify({ ok: false, error: "invalid --date; expected YYYY-MM-DD" })}\n`,
  );
  process.exit(2);
}

const weekday = new Intl.DateTimeFormat("en-US", {
  timeZone: workflows.overdue_alert.timezone,
  weekday: "long",
}).format(date);
const year = Number(today.slice(0, 4));
const weekend = !workflows.overdue_alert.weekdays.includes(weekday);
const holiday = calendar.holiday_dates.includes(today);
const calendarMissing = calendar.year !== year;
const shouldRun = !weekend && !holiday && !calendarMissing;
const reason = calendarMissing
  ? "holiday_calendar_missing_for_year"
  : weekend
    ? "weekend"
    : holiday
      ? "statutory_holiday"
      : "workday";

process.stdout.write(
  `${JSON.stringify(
    {
      ok: !calendarMissing,
      date: today,
      weekday,
      should_run: shouldRun,
      reason,
      holiday_source: calendar.source,
    },
    null,
    2,
  )}\n`,
);
if (calendarMissing) process.exit(1);
