export enum LogLevel {
  DEBUG = "DEBUG",
  INFO = "INFO",
  WARN = "WARN",
  ERROR = "ERROR",
}

const currentLevel = process.env.LOG_LEVEL ?? "INFO";

const levelOrder: Record<string, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

function shouldLog(level: LogLevel): boolean {
  return (levelOrder[level] ?? 0) >= (levelOrder[currentLevel] ?? 1);
}

function sanitize(obj: unknown): unknown {
  if (typeof obj !== "object" || obj === null) return obj;
  const sanitized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const lk = k.toLowerCase();
    if (
      lk.includes("password") ||
      lk.includes("secret") ||
      lk.includes("token") ||
      lk.includes("credential")
    ) {
      sanitized[k] = "[REDACTED]";
    } else {
      sanitized[k] = sanitize(v);
    }
  }
  return sanitized;
}

export function log(
  level: LogLevel,
  message: string,
  context?: Record<string, unknown>,
): void {
  if (!shouldLog(level)) return;
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    message,
  };
  if (context) {
    entry.context = sanitize(context);
  }
  if (level === LogLevel.ERROR || level === LogLevel.WARN) {
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  }
}

export const logger = {
  debug: (msg: string, ctx?: Record<string, unknown>) =>
    log(LogLevel.DEBUG, msg, ctx),
  info: (msg: string, ctx?: Record<string, unknown>) =>
    log(LogLevel.INFO, msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) =>
    log(LogLevel.WARN, msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) =>
    log(LogLevel.ERROR, msg, ctx),
};
