export const fmtTime = (d: Date, tz: string) =>
  new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz }).format(d);

export const fmtDate = (d: Date, tz: string) =>
  new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: tz,
  }).format(d);

export const fmtDateTime = (d: Date, tz: string) => `${fmtDate(d, tz)} ${fmtTime(d, tz)}`;

export const money = (cents: number, currency: string) =>
  new Intl.NumberFormat("ro-RO", { style: "currency", currency }).format(cents / 100);

export const minutesToHHMM = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export const hhmmToMinutes = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};

export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export const STATUS_STYLE: Record<string, string> = {
  CONFIRMED: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100",
  PENDING: "bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100",
  CANCELLED: "bg-zinc-100 text-zinc-500 line-through dark:bg-zinc-800",
  COMPLETED: "bg-sky-100 text-sky-900 dark:bg-sky-900 dark:text-sky-100",
  NO_SHOW: "bg-red-100 text-red-900 dark:bg-red-900 dark:text-red-100",
  PROCESSED: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100",
  RECEIVED: "bg-zinc-100 dark:bg-zinc-800",
  PROCESSING: "bg-sky-100 dark:bg-sky-900",
  SKIPPED: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800",
  FAILED: "bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100",
  DEFERRED: "bg-violet-100 text-violet-900 dark:bg-violet-900 dark:text-violet-100",
  DEAD: "bg-red-100 text-red-900 dark:bg-red-900 dark:text-red-100",
};
