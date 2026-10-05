export type LogLevel = "debug" | "info" | "warn" | "error";

export interface SafeLogEntry {
  level: LogLevel;
  event: string;
  metadata?: Record<string, string | number | boolean | undefined>;
}

export interface SafeLogger {
  write(entry: SafeLogEntry): void;
}

const forbiddenMetadataKeys = new Set([
  "body",
  "text",
  "message",
  "content",
  "transcript",
  "token",
  "qr",
  "auth",
  "session",
  "ciphertext"
]);

function redactMetadata(metadata: SafeLogEntry["metadata"]): SafeLogEntry["metadata"] {
  if (!metadata) return undefined;
  const clean: Record<string, string | number | boolean | undefined> = {};
  for (const [key, value] of Object.entries(metadata)) {
    clean[key] = forbiddenMetadataKeys.has(key.toLowerCase()) ? "[REDACTED]" : value;
  }
  return clean;
}

export class JsonSafeLogger implements SafeLogger {
  public constructor(private readonly sink: (line: string) => void = console.log) {}

  public write(entry: SafeLogEntry): void {
    this.sink(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: entry.level,
      event: entry.event,
      metadata: redactMetadata(entry.metadata)
    }));
  }
}

export class MemorySafeLogger implements SafeLogger {
  public readonly entries: SafeLogEntry[] = [];

  public write(entry: SafeLogEntry): void {
    const metadata = redactMetadata(entry.metadata);
    this.entries.push(metadata === undefined ? { level: entry.level, event: entry.event } : {
      level: entry.level,
      event: entry.event,
      metadata
    });
  }
}
