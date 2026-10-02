/**
 * Pengirim email SMTP (ADR 0018 D8) — HANYA dipakai worker (tidak diimpor kode web). Pola sama dengan
 * web-expomedia `src/lib/mailer.ts`: password dibaca dari SMTP_PASSWORD_FILE saat kirim (secret mount, tidak pernah dari
 * env/log); TLS wajib (465 → TLS implisit, lainnya → STARTTLS wajib) kecuali SMTP_TLS=off yang hanya lolos validasi env
 * untuk instance staging (Mailpit internal). Teks polos saja (tanpa HTML).
 */
import { readFile } from "node:fs/promises";
import nodemailer from "nodemailer";

export interface MailMessage {
  to: readonly string[];
  cc: readonly string[];
  subject: string;
  text: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

export interface SmtpConfig {
  host: string;
  port: number;
  user?: string | undefined;
  passwordFile?: string | undefined;
  from: string;
  tls: "required" | "off";
}

/** Kode error aman untuk log/notification_log (tanpa alamat/isi respons server). */
export function mailErrorCode(err: unknown): string {
  const e = err as { code?: unknown; responseCode?: unknown } | null;
  const code = typeof e?.code === "string" && /^[A-Z_]{2,32}$/.test(e.code) ? e.code : "ESEND";
  const rc = typeof e?.responseCode === "number" ? ` ${e.responseCode}` : "";
  return `${code}${rc}`;
}

export function createSmtpMailer(cfg: SmtpConfig): Mailer {
  return {
    async send(msg) {
      const auth =
        cfg.user && cfg.passwordFile ? { user: cfg.user, pass: (await readFile(cfg.passwordFile, "utf8")).trim() } : undefined;
      const secure = cfg.tls === "required" && cfg.port === 465;
      const transport = nodemailer.createTransport({
        host: cfg.host,
        port: cfg.port,
        secure,
        requireTLS: cfg.tls === "required" && !secure,
        ignoreTLS: cfg.tls === "off",
        ...(auth ? { auth } : {}),
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
      });
      try {
        await transport.sendMail({
          from: cfg.from,
          to: [...msg.to],
          ...(msg.cc.length > 0 ? { cc: [...msg.cc] } : {}),
          subject: msg.subject,
          text: msg.text,
        });
      } finally {
        transport.close();
      }
    },
  };
}
