import { Resend } from "resend";
import { env } from "@/env";

/**
 * Outbound email behind a two-method interface. Resend when RESEND_API_KEY is
 * set (free tier: 3,000/month; without a verified domain, only to the inbox
 * that owns the account, from onboarding@resend.dev). Otherwise a logging
 * sender, which is also what tests capture.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailSender {
  readonly name: string;
  send(message: EmailMessage): Promise<{ id: string | null }>;
}

export class ResendSender implements EmailSender {
  readonly name = "resend";
  constructor(private readonly client = new Resend(env.RESEND_API_KEY)) {}
  async send(m: EmailMessage) {
    const { data, error } = await this.client.emails.send({
      from: env.EMAIL_FROM,
      to: m.to,
      subject: m.subject,
      text: m.text,
      html: m.html,
    });
    if (error) throw new Error(`Resend: ${error.name} ${error.message}`);
    return { id: data?.id ?? null };
  }
}

/** Logs instead of sending; keeps what it saw so tests and the dashboard can look. */
export class LoggingSender implements EmailSender {
  readonly name = "log";
  readonly sent: EmailMessage[] = [];
  async send(m: EmailMessage) {
    this.sent.push(m);
    if (env.NODE_ENV !== "test")
      console.log(`[email] to=${m.to} subject=${JSON.stringify(m.subject)}`);
    return { id: null };
  }
}

let override: EmailSender | undefined;
let cached: EmailSender | undefined;

export function getEmailSender(): EmailSender {
  if (override) return override;
  return (cached ??= env.RESEND_API_KEY ? new ResendSender() : new LoggingSender());
}

export function setEmailSender(s: EmailSender | undefined) {
  override = s;
}

export const emailConfigured = () => Boolean(env.RESEND_API_KEY);
