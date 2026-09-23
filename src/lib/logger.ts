import pino from "pino";

/**
 * Logger terstruktur (JSON ke stdout). Redaksi field sensitif; jangan log PII/secret.
 * Level dari LOG_LEVEL (divalidasi di env.ts); default info.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: process.env.SERVICE_NAME ?? "control-plane" },
  redact: {
    paths: [
      "password",
      "*.password",
      "secret",
      "*.secret",
      "token",
      "*.token",
      "authorization",
      "*.authorization",
      "headers.cookie",
      "req.headers.cookie",
      "req.headers.authorization",
      "email",
      "*.email",
    ],
    censor: "[REDACTED]",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});
