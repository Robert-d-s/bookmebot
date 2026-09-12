import { STATUS_STYLE } from "../_lib/format";

export function Flash({ ok, error }: { ok?: string; error?: string }) {
  if (!ok && !error) return null;
  return (
    <p
      className={`rounded px-3 py-2 text-sm ${
        error
          ? "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200"
          : "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
      }`}
    >
      {error ?? ok}
    </p>
  );
}

export function Badge({ status }: { status: string }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_STYLE[status] ?? ""}`}>
      {status}
    </span>
  );
}

export const input = "rounded border bg-transparent px-2 py-1 text-sm";
export const button =
  "rounded bg-zinc-900 px-3 py-1.5 text-sm text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900";
export const buttonSecondary =
  "rounded border px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800";
export const card = "rounded-lg border p-4";
