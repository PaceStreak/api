/**
 * Structured logs for Workers Logs: one JSON object per line. Never log bodies, emails, codes or tokens
 * (the console mailer in dev/test is the single exception, by design).
 */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, err?: unknown, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

function line(level: string, msg: string, base: LogFields, fields: LogFields | undefined): string {
  return JSON.stringify({ level, msg, ...base, ...fields });
}

export function createLogger(base: LogFields = {}): Logger {
  return {
    info: (msg, fields) => console.log(line("info", msg, base, fields)),
    warn: (msg, fields) => console.warn(line("warn", msg, base, fields)),
    error: (msg, err, fields) => {
      const extra: LogFields =
        err === undefined
          ? {}
          : err instanceof Error
            ? { error: err.name, message: err.message, stack: err.stack }
            : { error: String(err) };
      console.error(line("error", msg, base, { ...fields, ...extra }));
    },
    child: (fields) => createLogger({ ...base, ...fields }),
  };
}
