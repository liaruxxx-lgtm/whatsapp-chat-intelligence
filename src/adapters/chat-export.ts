import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Temporal } from "@js-temporal/polyfill";

import type { IncomingMessage } from "../domain/types.js";

/** A deliberately bounded local-only import surface for exported chat text. */
export const MAX_CHAT_EXPORT_BYTES = 32 * 1024 * 1024;
export const MAX_CHAT_EXPORT_MESSAGES = 100_000;
export const MAX_CHAT_EXPORT_MESSAGE_CHARACTERS = 64 * 1024;

export type ChatExportDateOrder = "auto" | "dmy" | "mdy";

export interface ChatExportParseOptions {
  /** The already-selected local allowlist chat identifier; it is never inferred from an export. */
  readonly chatId: string;
  /** The configured IANA zone used by the device that produced the export. */
  readonly timeZone: string;
  /** Caller-owned keyed tokenization; raw labels never become message identities. */
  readonly tokenize: (value: string) => string;
  /** Optional exact export label for messages authored by the account owner. */
  readonly ownSenderLabel?: string;
  /** Required only for otherwise ambiguous numeric slash/hyphen dates. */
  readonly dateOrder?: ChatExportDateOrder;
  readonly maxMessages?: number;
  readonly maxMessageCharacters?: number;
}

export interface ChatExportParseStats {
  readonly parsed: number;
  readonly unsupported: number;
  readonly ignoredMalformed: number;
  readonly ignoredAmbiguousDate: number;
  readonly ignoredInvalidTimestamp: number;
}

export interface ChatExportParseResult {
  readonly messages: readonly IncomingMessage[];
  readonly stats: ChatExportParseStats;
}

export type ChatExportImportErrorCode =
  | "invalid_file"
  | "unreadable_file"
  | "file_too_large"
  | "invalid_encoding"
  | "message_limit_exceeded"
  | "message_too_large"
  | "invalid_chat_id"
  | "invalid_time_zone"
  | "chat_not_allowlisted"
  | "account_not_authorized"
  | "persistent_key_required"
  | "kill_switch_active";

/** Error text is intentionally code-only: the source path and chat contents never reach logs/stdout. */
export class ChatExportImportError extends Error {
  public constructor(public readonly code: ChatExportImportErrorCode) {
    super(`chat_export_import_${code}`);
    this.name = "ChatExportImportError";
  }
}

interface ParsedHeader {
  readonly senderLabel: string;
  readonly body: string;
  readonly timestamp: string;
}

type HeaderResult =
  | { readonly kind: "record"; readonly header: ParsedHeader }
  | { readonly kind: "not_header" }
  | { readonly kind: "malformed" }
  | { readonly kind: "ambiguous_date" }
  | { readonly kind: "invalid_timestamp" };

interface PendingRecord {
  readonly senderLabel: string;
  readonly timestamp: string;
  body: string;
  tooLarge: boolean;
}

const datePrefixPattern = /^\s*\[?\d{1,4}[./-]\d{1,2}[./-]\d{1,4}[,\s]/u;
const headerPattern = /^\s*(?:\[(?<bracketDate>\d{1,4}[./-]\d{1,2}[./-]\d{1,4})\s*,\s*(?<bracketTime>\d{1,2}:\d{2}(?::\d{2})?)\s*(?<bracketMeridiem>AM|PM|am|pm)?\]\s*-?\s*|(?<plainDate>\d{1,4}[./-]\d{1,2}[./-]\d{1,4})\s*,\s*(?<plainTime>\d{1,2}:\d{2}(?::\d{2})?)\s*(?<plainMeridiem>AM|PM|am|pm)?\s*[-–—]\s*)(?<sender>[^:\r\n]{1,512}):\s?(?<body>.*)$/u;
const invisibleFormatCharacters = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

/**
 * Parse WhatsApp's common Android/iOS plaintext export lines. The parser does
 * not inspect directories, archives, attachments, accounts, or the network.
 * Unsupported/system records are reported as counts, never copied into errors.
 */
export function parseChatExport(content: string, options: ChatExportParseOptions): ChatExportParseResult {
  if (!options.chatId.trim()) throw new ChatExportImportError("invalid_chat_id");
  if (Buffer.byteLength(content, "utf8") > MAX_CHAT_EXPORT_BYTES) throw new ChatExportImportError("file_too_large");
  const maxMessages = options.maxMessages ?? MAX_CHAT_EXPORT_MESSAGES;
  const maxMessageCharacters = options.maxMessageCharacters ?? MAX_CHAT_EXPORT_MESSAGE_CHARACTERS;
  if (!Number.isSafeInteger(maxMessages) || maxMessages <= 0) throw new ChatExportImportError("message_limit_exceeded");
  if (!Number.isSafeInteger(maxMessageCharacters) || maxMessageCharacters <= 0) throw new ChatExportImportError("message_too_large");
  validateTimeZone(options.timeZone);

  const messages: IncomingMessage[] = [];
  const stats = {
    parsed: 0,
    unsupported: 0,
    ignoredMalformed: 0,
    ignoredAmbiguousDate: 0,
    ignoredInvalidTimestamp: 0
  };
  const ownSenderLabel = options.ownSenderLabel === undefined ? undefined : normalizedLabel(options.ownSenderLabel);
  // Only exact duplicate records need an ordinal. A global line number would
  // turn a later re-export with older messages prepended into duplicates.
  const duplicateOccurrences = new Map<string, number>();
  let pending: PendingRecord | undefined;

  const flush = (): void => {
    if (!pending) return;
    const record = pending;
    pending = undefined;
    if (record.tooLarge) throw new ChatExportImportError("message_too_large");
    if (messages.length >= maxMessages) throw new ChatExportImportError("message_limit_exceeded");

    const body = record.body;
    const unsupported = body.length === 0 || isMediaPlaceholder(body);
    const senderToken = options.tokenize(`chat-export-sender-v1\u0000${record.senderLabel}`);
    const duplicateKey = `${record.timestamp}\u0000${senderToken}\u0000${body}`;
    const occurrence = duplicateOccurrences.get(duplicateKey) ?? 0;
    duplicateOccurrences.set(duplicateKey, occurrence + 1);
    const messageToken = options.tokenize(
      `chat-export-message-v1\u0000${record.timestamp}\u0000${senderToken}\u0000${body}\u0000${occurrence}`
    );
    const message: IncomingMessage = {
      messageId: `chat_export:${messageToken}`,
      chatId: options.chatId,
      senderId: `chat_export:${senderToken}`,
      fromMe: ownSenderLabel !== undefined && normalizedLabel(record.senderLabel) === ownSenderLabel,
      timestamp: record.timestamp,
      source: "chat_export",
      kind: unsupported ? "unknown" : "text"
    };
    if (!unsupported) message.text = body;
    messages.push(message);
    stats.parsed += 1;
    if (unsupported) stats.unsupported += 1;
  };

  const lines = content.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").split("\n");
  for (const line of lines) {
    const parsed = parseHeader(line, options.timeZone, options.dateOrder ?? "auto");
    if (parsed.kind === "record") {
      flush();
      pending = {
        senderLabel: parsed.header.senderLabel,
        timestamp: parsed.header.timestamp,
        body: parsed.header.body,
        tooLarge: parsed.header.body.length > maxMessageCharacters
      };
      continue;
    }

    if (parsed.kind === "not_header") {
      if (pending) {
        if (!pending.tooLarge) {
          const candidate = `${pending.body}\n${line}`;
          pending.body = candidate;
          pending.tooLarge = candidate.length > maxMessageCharacters;
        }
      }
      continue;
    }

    // A date-prefixed record is a new export item even if unsupported or
    // malformed; it must never become text belonging to the prior message.
    flush();
    if (parsed.kind === "ambiguous_date") stats.ignoredAmbiguousDate += 1;
    else if (parsed.kind === "invalid_timestamp") stats.ignoredInvalidTimestamp += 1;
    else stats.ignoredMalformed += 1;
  }
  flush();

  return { messages, stats };
}

/**
 * Reads only one local, regular, non-symlink UTF-8 text file. The fixed byte
 * bound rejects archives and accidentally selected large files before parsing.
 */
export function readLocalChatExportFile(path: string, options: ChatExportParseOptions): ChatExportParseResult {
  if (!isAbsolute(path)) throw new ChatExportImportError("invalid_file");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const details = fstatSync(descriptor);
    if (!details.isFile()) throw new ChatExportImportError("invalid_file");
    if (details.size > MAX_CHAT_EXPORT_BYTES) throw new ChatExportImportError("file_too_large");
    const bytes = readFileSync(descriptor);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ChatExportImportError("invalid_encoding");
    }
    return parseChatExport(content, options);
  } catch (error) {
    if (error instanceof ChatExportImportError) throw error;
    throw new ChatExportImportError("unreadable_file");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseHeader(line: string, timeZone: string, dateOrder: ChatExportDateOrder): HeaderResult {
  const match = headerPattern.exec(line);
  if (!match?.groups) {
    return datePrefixPattern.test(line) ? { kind: "malformed" } : { kind: "not_header" };
  }
  const date = match.groups.bracketDate ?? match.groups.plainDate;
  const time = match.groups.bracketTime ?? match.groups.plainTime;
  const meridiem = match.groups.bracketMeridiem ?? match.groups.plainMeridiem;
  const senderLabel = match.groups.sender;
  const body = match.groups.body;
  if (!date || !time || !senderLabel || body === undefined) return { kind: "malformed" };

  const dateParts = parseDate(date, meridiem, dateOrder);
  if (dateParts === "ambiguous") return { kind: "ambiguous_date" };
  if (dateParts === undefined) return { kind: "invalid_timestamp" };
  const timestamp = resolveTimestamp(dateParts, time, meridiem, timeZone);
  if (!timestamp) return { kind: "invalid_timestamp" };
  return { kind: "record", header: { senderLabel, body, timestamp } };
}

function parseDate(
  rawDate: string,
  meridiem: string | undefined,
  dateOrder: ChatExportDateOrder
): { readonly year: number; readonly month: number; readonly day: number } | "ambiguous" | undefined {
  const match = /^(\d{1,4})([./-])(\d{1,2})\2(\d{1,4})$/u.exec(rawDate);
  if (!match) return undefined;
  const first = Number(match[1]);
  const separator = match[2];
  const second = Number(match[3]);
  const third = Number(match[4]);
  if (![first, second, third].every(Number.isSafeInteger)) return undefined;

  if (match[1]?.length === 4) return { year: first, month: second, day: third };
  const year = normalizeTwoDigitYear(third, match[4]?.length ?? 0);
  if (year === undefined) return undefined;

  let order: Exclude<ChatExportDateOrder, "auto"> | undefined;
  if (dateOrder !== "auto") order = dateOrder;
  else if (separator === ".") order = "dmy";
  else if (meridiem !== undefined) order = "mdy";
  else if (first > 12 && second <= 12) order = "dmy";
  else if (second > 12 && first <= 12) order = "mdy";
  else return "ambiguous";

  return order === "dmy"
    ? { year, month: second, day: first }
    : { year, month: first, day: second };
}

function normalizeTwoDigitYear(value: number, width: number): number | undefined {
  if (width === 4) return value;
  if (width !== 2 || value < 0 || value > 99) return undefined;
  // WhatsApp was not available in the 1900s. Keeping export years in this
  // product's possible lifetime avoids a silent 19xx fallback.
  return 2000 + value;
}

function resolveTimestamp(
  date: { readonly year: number; readonly month: number; readonly day: number },
  rawTime: string,
  rawMeridiem: string | undefined,
  timeZone: string
): string | undefined {
  const time = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/u.exec(rawTime);
  if (!time) return undefined;
  let hour = Number(time[1]);
  const minute = Number(time[2]);
  const second = Number(time[3] ?? "0");
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || !Number.isInteger(second) || minute > 59 || second > 59) return undefined;
  if (rawMeridiem !== undefined) {
    if (hour < 1 || hour > 12) return undefined;
    const meridiem = rawMeridiem.toLocaleUpperCase("en-US");
    hour = hour === 12 ? 0 : hour;
    if (meridiem === "PM") hour += 12;
  } else if (hour > 23) {
    return undefined;
  }

  try {
    const plain = Temporal.PlainDateTime.from({ ...date, hour, minute, second }, { overflow: "reject" });
    const earlier = plain.toZonedDateTime(timeZone, { disambiguation: "earlier" });
    const later = plain.toZonedDateTime(timeZone, { disambiguation: "later" });
    // A local source timestamp cannot be normalized across a skipped DST hour.
    if (!samePlainDateTime(plain, earlier) || !samePlainDateTime(plain, later)) return undefined;
    return earlier.toInstant().toString();
  } catch {
    return undefined;
  }
}

function samePlainDateTime(plain: Temporal.PlainDateTime, zoned: Temporal.ZonedDateTime): boolean {
  const resolved = zoned.toPlainDateTime();
  return (
    resolved.year === plain.year
    && resolved.month === plain.month
    && resolved.day === plain.day
    && resolved.hour === plain.hour
    && resolved.minute === plain.minute
    && resolved.second === plain.second
  );
}

function validateTimeZone(timeZone: string): void {
  try {
    Temporal.Now.zonedDateTimeISO(timeZone);
  } catch {
    throw new ChatExportImportError("invalid_time_zone");
  }
}

function normalizedLabel(value: string): string {
  return value.replace(invisibleFormatCharacters, "").normalize("NFKC").trim();
}

function isMediaPlaceholder(value: string): boolean {
  const normalized = normalizedLabel(value).toLocaleLowerCase("de-DE");
  return /^(?:<\s*(?:media|image|video|audio|sticker|gif|document)\s+omitted\s*>|<\s*(?:medien|anhang|bild|video|audio|sprachnachricht)\s+(?:ausgeschlossen|weggelassen|nicht enthalten)\s*>)$/u.test(normalized);
}
