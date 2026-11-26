import { appendFileSync } from 'node:fs';

type LogValue = string | number | boolean | null | undefined;

export interface Logger {
  info(event: string, fields?: Readonly<Record<string, LogValue>>): void;
  warn(event: string, fields?: Readonly<Record<string, LogValue>>): void;
  error(event: string, fields?: Readonly<Record<string, LogValue>>): void;
}

const SENSITIVE_KEY = /(key|token|secret|password|authorization|cookie)/i;

function sanitizeFields(
  fields: Readonly<Record<string, LogValue>> | undefined,
): Record<string, LogValue> {
  if (!fields) return {};
  const sanitized: Record<string, LogValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_KEY.test(key)) continue;
    if (typeof value === 'string') {
      sanitized[key] = value.length > 500 ? `${value.slice(0, 500)}…` : value;
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * Small append-only JSON-lines logger. It must never be used for message
 * contents, prompts, keys or other user data.
 */
export class FileLogger implements Logger {
  readonly logFilePath: string;
  private readonly mirrorToConsole: boolean;
  private writeFailureReported = false;

  constructor(logFilePath: string, mirrorToConsole: boolean) {
    this.logFilePath = logFilePath;
    this.mirrorToConsole = mirrorToConsole;
  }

  info(event: string, fields?: Readonly<Record<string, LogValue>>): void {
    this.write('info', event, fields);
  }

  warn(event: string, fields?: Readonly<Record<string, LogValue>>): void {
    this.write('warn', event, fields);
  }

  error(event: string, fields?: Readonly<Record<string, LogValue>>): void {
    this.write('error', event, fields);
  }

  private write(
    level: 'info' | 'warn' | 'error',
    event: string,
    fields: Readonly<Record<string, LogValue>> | undefined,
  ): void {
    const record = {
      time: new Date().toISOString(),
      pid: process.pid,
      level,
      event,
      ...sanitizeFields(fields),
    };
    const line = `${JSON.stringify(record)}\n`;
    try {
      appendFileSync(this.logFilePath, line, 'utf8');
    } catch (error) {
      if (!this.writeFailureReported) {
        this.writeFailureReported = true;
        const message =
          error instanceof Error ? error.message : String(error);
        console.error(`ChatFGM log write failed: ${message}`);
      }
    }
    if (this.mirrorToConsole) {
      const suffix =
        fields && Object.keys(fields).length > 0
          ? ` ${JSON.stringify(sanitizeFields(fields))}`
          : '';
      console.log(`[chatfgm:${level}] ${event}${suffix}`);
    }
  }
}
