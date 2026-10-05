import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ChatExportImportError,
  parseChatExport,
  readLocalChatExportFile
} from "../src/adapters/chat-export.js";
import { loadConfig } from "../src/config.js";
import { MemoryNotificationAdapter } from "../src/notifications/notification-adapter.js";
import { ChatIntelligenceApplication } from "../src/runtime/application.js";
import { MemorySafeLogger } from "../src/security/logger.js";

const encryptionKey = Buffer.alloc(32, 13).toString("base64");
const chatId = "491700000001@s.whatsapp.net";

function tokenize(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parse(content: string, options: Partial<Parameters<typeof parseChatExport>[1]> = {}) {
  return parseChatExport(content, {
    chatId,
    timeZone: "Europe/Berlin",
    tokenize,
    ...options
  });
}

describe("local WhatsApp chat-export importer", () => {
  it("normalizes common Android/iOS records locally with stable pseudonymous IDs", () => {
    const exportText = [
      "12.03.24, 14:15 - Alice Example: Heute um 15 Uhr treffen wir uns.",
      "Bitte am Eingang warten.",
      "12.03.24, 14:16 - Ich: <Medien ausgeschlossen>",
      "12/03/24, 2:17 PM - Alice Example: The meeting is tomorrow at 09:00."
    ].join("\n");

    const first = parse(exportText, { ownSenderLabel: "Ich" });
    const second = parse(exportText, { ownSenderLabel: "Ich" });
    const reexportWithOlderRecord = parse([
      "11.03.24, 14:15 - Alice Example: Eine ältere Nachricht.",
      exportText
    ].join("\n"), { ownSenderLabel: "Ich" });

    expect(first.stats).toEqual({
      parsed: 3,
      unsupported: 1,
      ignoredMalformed: 0,
      ignoredAmbiguousDate: 0,
      ignoredInvalidTimestamp: 0
    });
    expect(first.messages[0]).toMatchObject({
      source: "chat_export",
      chatId,
      timestamp: "2024-03-12T13:15:00Z",
      kind: "text",
      text: "Heute um 15 Uhr treffen wir uns.\nBitte am Eingang warten."
    });
    expect(first.messages[1]).toMatchObject({ source: "chat_export", fromMe: true, kind: "unknown" });
    expect(first.messages[1]?.text).toBeUndefined();
    expect(first.messages[2]).toMatchObject({ timestamp: "2024-12-03T13:17:00Z", kind: "text" });
    expect(first.messages.map((message) => message.messageId)).toEqual(second.messages.map((message) => message.messageId));
    expect(reexportWithOlderRecord.messages[1]?.messageId).toBe(first.messages[0]?.messageId);
    expect(JSON.stringify(first.messages)).not.toContain("Alice Example");
  });

  it("does not silently guess ambiguous numeric dates or normalize a DST-gap source timestamp", () => {
    const result = parse([
      "03/04/24, 14:15 - Alice: This date order is ambiguous.",
      "30.03.25, 02:30 - Alice: This local time does not exist in Berlin."
    ].join("\n"));

    expect(result.messages).toHaveLength(0);
    expect(result.stats).toMatchObject({ ignoredAmbiguousDate: 1, ignoredInvalidTimestamp: 1 });
    expect(JSON.stringify(result.stats)).not.toContain("ambiguous.");
  });

  it("reads only a bounded, local UTF-8 regular file and returns code-only errors", () => {
    const directory = mkdtempSync(join(tmpdir(), "wci-chat-export-read-"));
    const exportPath = join(directory, "chat.txt");
    const invalidUtf8Path = join(directory, "invalid.txt");
    try {
      writeFileSync(exportPath, "12.03.24, 14:15 - Alice: Hallo");
      writeFileSync(invalidUtf8Path, Buffer.from([0xc3, 0x28]));

      expect(readLocalChatExportFile(exportPath, {
        chatId,
        timeZone: "Europe/Berlin",
        tokenize
      }).messages).toHaveLength(1);
      expect(() => readLocalChatExportFile(invalidUtf8Path, {
        chatId,
        timeZone: "Europe/Berlin",
        tokenize
      })).toThrow("chat_export_import_invalid_encoding");
      expect(() => readLocalChatExportFile("relative-export.txt", {
        chatId,
        timeZone: "Europe/Berlin",
        tokenize
      })).toThrow("chat_export_import_invalid_file");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("requires an existing allowlist entry before reading and persists historical exports without notifications", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "wci-chat-export-data-"));
    const sourceDirectory = mkdtempSync(join(tmpdir(), "wci-chat-export-source-"));
    const exportPath = join(sourceDirectory, "chat.txt");
    const secretBody = "Heute um 15 Uhr treffen wir uns.";
    writeFileSync(exportPath, [
      `05.05.30, 10:00 - Ich: ${secretBody}`,
      "05.05.30, 10:01 - Alice: Alles klar."
    ].join("\n"));
    const notifications = new MemoryNotificationAdapter();
    const logger = new MemorySafeLogger();
    const app = new ChatIntelligenceApplication(loadConfig({
      WCI_DATA_DIR: dataDirectory,
      WCI_ENCRYPTION_KEY_BASE64: encryptionKey,
      WCI_ACCOUNT_AUTHORIZED: "true",
      WCI_TIMEZONE: "Europe/Berlin",
      WCI_KILL_SWITCH: "false"
    }), { notificationAdapter: notifications, logger });

    try {
      await expect(app.importChatExport({ filePath: join(sourceDirectory, "not-yet-read.txt"), chatId }))
        .rejects.toMatchObject({ code: "chat_not_allowlisted" } satisfies Partial<ChatExportImportError>);
      app.pipeline.addAllowedChat(chatId);

      const imported = await app.importChatExport({ filePath: exportPath, chatId, ownSenderLabel: "Ich" });
      expect(imported).toMatchObject({ imported: 2, deduplicated: 0, rejected: 0, stats: { parsed: 2 } });
      expect(app.store.count("messages")).toBe(2);
      expect(app.store.listEvents(chatId)).toHaveLength(1);
      expect(app.store.listScheduledReminders()).toHaveLength(0);
      expect(notifications.notifications).toHaveLength(0);
      expect(JSON.stringify(logger.entries)).not.toContain(secretBody);

      const replay = await app.importChatExport({ filePath: exportPath, chatId, ownSenderLabel: "Ich" });
      expect(replay).toMatchObject({ imported: 0, deduplicated: 2, rejected: 0 });
      expect(app.store.count("messages")).toBe(2);
    } finally {
      app.close();
      rmSync(dataDirectory, { recursive: true, force: true });
      rmSync(sourceDirectory, { recursive: true, force: true });
    }
  });
});
