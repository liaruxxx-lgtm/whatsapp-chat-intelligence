import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface RuntimeConfig {
  dataDir: string;
  databasePath: string;
  mediaDir: string;
  sessionDir: string;
  runtimeEnvPath: string;
  timezone: string;
  locale: "de" | "en";
  reminderLeadMinutes: number;
  liveImportEnabled: boolean;
  externalTranscriptionEnabled: boolean;
  openAiSummariesEnabled: boolean;
  openAiApiKey: string | undefined;
  openAiSummaryModel: string;
  killSwitch: boolean;
  accountAuthorized: boolean;
  retentionDays: number;
  maxMediaBytes: number;
  setupConfirmed: boolean;
  timezoneConfirmed: boolean;
  retentionConfirmed: boolean;
  exportDeletionConfirmed: boolean;
  notificationsConfirmed: boolean;
  encryptionKeyBase64: string;
  encryptionKeyIsEphemeral: boolean;
}

export interface LiveGateStatus {
  allowed: boolean;
  reasons: string[];
}

type Environment = Record<string, string | undefined>;

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return value.trim().toLowerCase() === "true";
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function modelName(value: string | undefined): string {
  const selected = value?.trim() || "gpt-6-astra";
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(selected)) {
    throw new Error("WCI_OPENAI_SUMMARY_MODEL must be a model name containing only letters, numbers, dots, underscores, or hyphens");
  }
  return selected;
}

function validTimezone(timezone: string): string {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return timezone;
  } catch {
    return "Europe/Berlin";
  }
}

function getEncryptionKey(value: string | undefined): { key: string; ephemeral: boolean } {
  if (value) {
    const decoded = Buffer.from(value, "base64");
    if (decoded.length !== 32) {
      throw new Error("WCI_ENCRYPTION_KEY_BASE64 must decode to exactly 32 bytes");
    }
    return { key: value, ephemeral: false };
  }

  return { key: randomBytes(32).toString("base64"), ephemeral: true };
}

export function loadConfig(env: Environment = process.env): RuntimeConfig {
  const dataDir = env.WCI_DATA_DIR?.trim() || join(homedir(), "Library", "Application Support", "WhatsAppChatIntelligence");
  const key = getEncryptionKey(env.WCI_ENCRYPTION_KEY_BASE64);
  const locale = env.WCI_LOCALE?.trim().toLowerCase() === "en" ? "en" : "de";

  return {
    dataDir,
    databasePath: join(dataDir, "chat-intelligence.sqlite"),
    mediaDir: join(dataDir, "media"),
    sessionDir: join(dataDir, "sessions"),
    runtimeEnvPath: join(dataDir, "runtime.env"),
    timezone: validTimezone(env.WCI_TIMEZONE?.trim() || "Europe/Berlin"),
    locale,
    reminderLeadMinutes: positiveInt(env.WCI_REMINDER_LEAD_MINUTES, 30),
    liveImportEnabled: bool(env.WCI_LIVE_IMPORT_ENABLED),
    externalTranscriptionEnabled: bool(env.WCI_EXTERNAL_TRANSCRIPTION_ENABLED),
    openAiSummariesEnabled: bool(env.WCI_OPENAI_SUMMARIES_ENABLED),
    openAiApiKey: env.WCI_OPENAI_API_KEY?.trim() || undefined,
    openAiSummaryModel: modelName(env.WCI_OPENAI_SUMMARY_MODEL),
    killSwitch: bool(env.WCI_KILL_SWITCH),
    accountAuthorized: bool(env.WCI_ACCOUNT_AUTHORIZED),
    retentionDays: positiveInt(env.WCI_RETENTION_DAYS, 30),
    maxMediaBytes: positiveInt(env.WCI_MAX_MEDIA_BYTES, 64 * 1024 * 1024),
    setupConfirmed: bool(env.WCI_SETUP_CONFIRMED),
    timezoneConfirmed: bool(env.WCI_TIMEZONE_CONFIRMED),
    retentionConfirmed: bool(env.WCI_RETENTION_CONFIRMED),
    exportDeletionConfirmed: bool(env.WCI_EXPORT_DELETION_CONFIRMED),
    notificationsConfirmed: bool(env.WCI_NOTIFICATIONS_CONFIRMED),
    encryptionKeyBase64: key.key,
    encryptionKeyIsEphemeral: key.ephemeral
  };
}

export function evaluateLiveGate(config: RuntimeConfig, allowlistedChatCount: number): LiveGateStatus {
  const reasons: string[] = [];
  if (!config.liveImportEnabled) reasons.push("LIVE_IMPORT_ENABLED is not true");
  if (!config.accountAuthorized) reasons.push("account authorization is not confirmed");
  if (!config.setupConfirmed) reasons.push("setup confirmation is missing");
  if (!config.timezoneConfirmed) reasons.push("timezone confirmation is missing");
  if (!config.retentionConfirmed) reasons.push("retention confirmation is missing");
  if (!config.exportDeletionConfirmed) reasons.push("export/deletion confirmation is missing");
  if (!config.notificationsConfirmed) reasons.push("local notification confirmation is missing");
  if (config.encryptionKeyIsEphemeral) reasons.push("a persistent 32-byte encryption key is required");
  if (allowlistedChatCount === 0) reasons.push("the allowlist is empty");
  if (config.killSwitch) reasons.push("the kill switch is active");
  return { allowed: reasons.length === 0, reasons };
}

/**
 * Pairing may occur while the allowlist is intentionally still empty. Incoming
 * messages nevertheless remain blocked by the pipeline until selection is
 * complete; this gate only authorizes a local linked-device connection.
 */
export function evaluatePersonalConnectionGate(config: RuntimeConfig): LiveGateStatus {
  const reasons: string[] = [];
  if (!config.liveImportEnabled) reasons.push("LIVE_IMPORT_ENABLED is not true");
  if (!config.accountAuthorized) reasons.push("account authorization is not confirmed");
  if (!config.setupConfirmed) reasons.push("setup confirmation is missing");
  if (config.encryptionKeyIsEphemeral) reasons.push("a persistent 32-byte encryption key is required");
  if (config.killSwitch) reasons.push("the kill switch is active");
  return { allowed: reasons.length === 0, reasons };
}
