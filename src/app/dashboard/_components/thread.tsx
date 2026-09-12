import type { Message } from "@/generated/prisma/client";
import { fmtDateTime } from "../_lib/format";

type Option = { id: string; title: string };

/**
 * Renders a message log WhatsApp-style. When `replyForm` is given, buttons and
 * list rows on the latest OUT message become clickable (the simulator).
 */
export function Thread({
  messages,
  timezone,
  replyForm,
}: {
  messages: Message[];
  timezone: string;
  replyForm?: (opt: Option) => React.ReactNode;
}) {
  const lastOut = [...messages].reverse().find((m) => m.direction === "OUT");
  return (
    <ol className="space-y-2">
      {messages.length === 0 && <li className="text-sm text-zinc-500">No messages yet.</li>}
      {messages.map((m) => {
        const mine = m.direction === "OUT";
        const payload = (m.payload ?? {}) as {
          buttons?: Option[];
          rows?: Option[];
          button?: string;
          replyId?: string;
        };
        const options = payload.buttons ?? payload.rows ?? [];
        return (
          <li key={m.id} className={`flex ${mine ? "justify-start" : "justify-end"}`}>
            <div
              className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                mine ? "bg-zinc-100 dark:bg-zinc-800" : "bg-emerald-100 dark:bg-emerald-900"
              }`}
            >
              <div className="whitespace-pre-wrap">
                {m.kind === "unsupported" ? <em>[{m.kind}]</em> : m.text}
                {(m.kind === "button_reply" || m.kind === "list_reply") && (
                  <span className="text-zinc-500"> ↩ {payload.replyId}</span>
                )}
              </div>
              {options.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {options.map((o) =>
                    replyForm && m.id === lastOut?.id ? (
                      <span key={o.id}>{replyForm(o)}</span>
                    ) : (
                      <span key={o.id} className="rounded border px-2 py-0.5 text-xs opacity-70">
                        {o.title}
                      </span>
                    ),
                  )}
                </div>
              )}
              <div className="mt-1 text-[10px] text-zinc-500">
                {m.channel} · {fmtDateTime(m.createdAt, timezone)}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
