import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BaileysEventEmitter, BaileysEventMap, WAMessage } from "@whiskeysockets/baileys";
import { proto } from "@whiskeysockets/baileys";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PersonalLinkedDeviceAdapter, type LinkedDeviceSocket } from "../src/adapters/personal-linked-device.js";
import { loadConfig } from "../src/config.js";
import { MemoryNotificationAdapter } from "../src/notifications/notification-adapter.js";
import { ChatIntelligenceApplication, PersonalHistoryImportError } from "../src/runtime/application.js";
import { MemorySafeLogger } from "../src/security/logger.js";

class FakeEmitter {
  readonly #listeners = new Map<string, Array<(event: unknown) => void>>();

  on<T extends keyof BaileysEventMap>(event: T, listener: (payload: BaileysEventMap[T]) => void): void {
    const listeners = this.#listeners.get(event) ?? [];
    listeners.push(listener as (event: unknown) => void);
    this.#listeners.set(event, listeners);
  }

  off<T extends keyof BaileysEventMap>(event: T, listener: (payload: BaileysEventMap[T]) => void): void {
    const listeners = this.#listeners.get(event);
    const index = listeners?.indexOf(listener as (event: unknown) => void) ?? -1;
    if (index >= 0) listeners?.splice(index, 1);
  }

  emit<T extends keyof BaileysEventMap>(event: T, payload: BaileysEventMap[T]): void {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) listener(payload);
  }
}

type HistoryFetcher = NonNullable<LinkedDeviceSocket["fetchMessageHistory"]>;
type AppStateResync = NonNullable<LinkedDeviceSocket["resyncAppState"]>;

function fakeSocket(options: {
  readonly fetchMessageHistory?: HistoryFetcher;
  readonly resyncAppState?: AppStateResync;
} = {}): { socket: LinkedDeviceSocket; events: FakeEmitter; endCallCount(): number } {
  const events = new FakeEmitter();
  let endCallCount = 0;
  return {
    events,
    endCallCount: () => endCallCount,
    socket: {
      ev: events as unknown as BaileysEventEmitter,
      async end(): Promise<void> { endCallCount += 1; },
      ...(options.fetchMessageHistory === undefined ? {} : { fetchMessageHistory: options.fetchMessageHistory }),
      ...(options.resyncAppState === undefined ? {} : { resyncAppState: options.resyncAppState })
    }
  };
}

const directories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("browser-independent personal worker", () => {
  it("starts a fully gated linked-device adapter and reconnects with bounded backoff after close", async () => {
    vi.useFakeTimers();
    const directory = mkdtempSync(join(tmpdir(), "wci-live-worker-"));
    directories.push(directory);
    const config = loadConfig({
      WCI_DATA_DIR: directory,
      WCI_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 17).toString("base64"),
      WCI_LIVE_IMPORT_ENABLED: "true",
      WCI_ACCOUNT_AUTHORIZED: "true",
      WCI_SETUP_CONFIRMED: "true",
      WCI_TIMEZONE_CONFIRMED: "true",
      WCI_RETENTION_CONFIRMED: "true",
      WCI_EXPORT_DELETION_CONFIRMED: "true",
      WCI_NOTIFICATIONS_CONFIRMED: "true",
      WCI_KILL_SWITCH: "false"
    });
    const first = fakeSocket();
    const second = fakeSocket();
    const sockets = [first, second];
    let factoryCalls = 0;
    const app = new ChatIntelligenceApplication(config, {
      notificationAdapter: new MemoryNotificationAdapter(),
      logger: new MemorySafeLogger(),
      personalAdapterFactory: (options) => new PersonalLinkedDeviceAdapter({
        ...options,
        socketFactory: () => {
          factoryCalls += 1;
          const next = sockets.shift();
          if (!next) throw new Error("unexpected reconnect");
          return next.socket;
        }
      })
    });
    app.pipeline.addAllowedChat("491700000001@s.whatsapp.net");

    await expect(app.startLivePersonalIngest()).resolves.toMatchObject({ started: true, reason: "started" });
    expect(factoryCalls).toBe(1);
    expect(app.health()).toMatchObject({ adapter: "personal_linked_device", status: "ready", liveImportEnabled: true });

    first.events.emit("connection.update", { connection: "close" });
    expect(app.health()).toMatchObject({ status: "degraded", lastErrorCode: "personal_connection_closed" });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(factoryCalls).toBe(2);
    expect(app.health()).toMatchObject({ status: "ready", liveImportEnabled: true });
    await app.shutdown();
  });

  it("permits setup pairing but never persists an allowlisted message before the full live checklist is confirmed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wci-pairing-scope-gate-"));
    directories.push(directory);
    const config = loadConfig({
      WCI_DATA_DIR: directory,
      WCI_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 21).toString("base64"),
      WCI_LIVE_IMPORT_ENABLED: "true",
      WCI_ACCOUNT_AUTHORIZED: "true",
      WCI_SETUP_CONFIRMED: "true",
      WCI_KILL_SWITCH: "false"
    });
    const linked = fakeSocket();
    const app = new ChatIntelligenceApplication(config, {
      notificationAdapter: new MemoryNotificationAdapter(),
      logger: new MemorySafeLogger(),
      personalAdapterFactory: (options) => new PersonalLinkedDeviceAdapter({
        ...options,
        socketFactory: () => linked.socket
      })
    });
    const chatId = "491700000001@s.whatsapp.net";
    app.pipeline.addAllowedChat(chatId);
    const adapter = app.getPersonalLinkedDeviceAdapter();
    await expect(adapter.start()).resolves.toMatchObject({ started: true });
    const incoming: WAMessage = {
      key: { remoteJid: chatId, participant: chatId, id: "premature-live-message", fromMe: false },
      messageTimestamp: 1_893_456_000,
      message: { conversation: "must remain out of storage" }
    };
    linked.events.emit("messages.upsert", { type: "notify", messages: [incoming] });
    await adapter.waitForIdle();

    expect(app.store.count("messages")).toBe(0);
    expect(app.health()).toMatchObject({ liveImportEnabled: false, lastErrorCode: "live_gate_blocked" });
    await app.shutdown();
  });

  it("clears a stale live-gate error from health after a paired user selects a chat", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wci-live-gate-health-"));
    directories.push(directory);
    const config = loadConfig({
      WCI_DATA_DIR: directory,
      WCI_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 22).toString("base64"),
      WCI_LIVE_IMPORT_ENABLED: "true",
      WCI_ACCOUNT_AUTHORIZED: "true",
      WCI_SETUP_CONFIRMED: "true",
      WCI_TIMEZONE_CONFIRMED: "true",
      WCI_RETENTION_CONFIRMED: "true",
      WCI_EXPORT_DELETION_CONFIRMED: "true",
      WCI_NOTIFICATIONS_CONFIRMED: "true",
      WCI_KILL_SWITCH: "false"
    });
    const linked = fakeSocket();
    const app = new ChatIntelligenceApplication(config, {
      notificationAdapter: new MemoryNotificationAdapter(),
      logger: new MemorySafeLogger(),
      personalAdapterFactory: (options) => new PersonalLinkedDeviceAdapter({
        ...options,
        socketFactory: () => linked.socket
      })
    });
    const chatId = "491700000002@s.whatsapp.net";

    await expect(app.startLivePersonalIngest()).resolves.toBeUndefined();
    expect(app.health()).toMatchObject({ status: "degraded", lastErrorCode: "live_gate_blocked" });

    const adapter = app.getPersonalLinkedDeviceAdapter();
    await expect(adapter.start()).resolves.toMatchObject({ started: true });
    linked.events.emit("connection.update", { connection: "open" });
    linked.events.emit("messages.upsert", {
      type: "notify",
      messages: [{
        key: { remoteJid: chatId, participant: chatId, id: "before-chat-selection", fromMe: false },
        messageTimestamp: 1_893_456_000,
        message: { conversation: "must stay out of storage until the gate opens" }
      }]
    });
    await adapter.waitForIdle();
    expect(app.health()).toMatchObject({ status: "degraded", lastErrorCode: "live_gate_blocked" });

    app.pipeline.addAllowedChat(chatId);

    expect(app.health()).toMatchObject({
      status: "ready",
      liveImportEnabled: true,
      allowlistedChatCount: 1
    });
    expect(app.health()).not.toHaveProperty("lastErrorCode");
    await app.shutdown();
  });

  it("imports only an allowlisted chat after confirmation and a bound, gate-approved history request", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wci-history-import-"));
    directories.push(directory);
    const targetChatId = "120363000000000001@g.us";
    const otherChatId = "491700000009@s.whatsapp.net";
    const config = loadConfig({
      WCI_DATA_DIR: directory,
      WCI_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 23).toString("base64"),
      WCI_LIVE_IMPORT_ENABLED: "true",
      WCI_ACCOUNT_AUTHORIZED: "true",
      WCI_SETUP_CONFIRMED: "true",
      WCI_TIMEZONE_CONFIRMED: "true",
      WCI_RETENTION_CONFIRMED: "true",
      WCI_EXPORT_DELETION_CONFIRMED: "true",
      WCI_NOTIFICATIONS_CONFIRMED: "true",
      WCI_KILL_SWITCH: "false"
    });
    const seed: WAMessage = {
      key: { remoteJid: targetChatId, participant: "491700000002@s.whatsapp.net", id: "cursor", fromMe: false },
      messageTimestamp: 1_704_067_200,
      message: { conversation: "seed" }
    };
    const historical: WAMessage = {
      key: { remoteJid: targetChatId, participant: "491700000002@s.whatsapp.net", id: "historical-1", fromMe: false },
      messageTimestamp: 1_704_067_100,
      message: { conversation: "historical content" }
    };
    const nonSelected: WAMessage = {
      key: { remoteJid: otherChatId, participant: otherChatId, id: "other-1", fromMe: false },
      messageTimestamp: 1_704_067_100,
      message: { conversation: "must not be stored" }
    };
    let events: FakeEmitter;
    const linked = fakeSocket({
      fetchMessageHistory: async () => {
        events.emit("messaging-history.set", {
          chats: [{
            id: targetChatId,
            endOfHistoryTransfer: true,
            endOfHistoryTransferType: proto.Conversation.EndOfHistoryTransferType.COMPLETE_AND_NO_MORE_MESSAGE_REMAIN_ON_PRIMARY
          }],
          contacts: [],
          messages: [historical, nonSelected],
          syncType: proto.HistorySync.HistorySyncType.ON_DEMAND,
          peerDataRequestSessionId: "history-session"
        });
        return "history-session";
      }
    });
    events = linked.events;
    const notifications = new MemoryNotificationAdapter();
    const app = new ChatIntelligenceApplication(config, {
      notificationAdapter: notifications,
      logger: new MemorySafeLogger(),
      personalAdapterFactory: (options) => new PersonalLinkedDeviceAdapter({
        ...options,
        historyResponseTimeoutMs: 50,
        socketFactory: () => linked.socket
      })
    });
    app.pipeline.addAllowedChat(targetChatId);
    const adapter = app.getPersonalLinkedDeviceAdapter();
    await expect(adapter.start()).resolves.toMatchObject({ started: true });

    events.emit("messaging-history.set", {
      chats: [{ id: targetChatId, name: "Gruppe" }],
      contacts: [],
      messages: [seed],
      syncType: proto.HistorySync.HistorySyncType.RECENT
    });
    await adapter.waitForIdle();
    expect(app.store.count("messages")).toBe(0);

    const result = await app.importPersonalChatHistory({ chatId: targetChatId, confirmed: true, maxMessages: 10 });
    expect(result).toMatchObject({ status: "completed", imported: 1, pages: 1 });
    expect(app.store.count("messages")).toBe(1);
    expect(app.store.listScheduledReminders()).toHaveLength(0);
    expect(notifications.notifications).toHaveLength(0);
    expect(linked.socket).not.toHaveProperty("sendMessage");
    expect(linked.socket).not.toHaveProperty("sendReadReceipt");
    expect(linked.socket).not.toHaveProperty("sendPresenceUpdate");

    await expect(app.importPersonalChatHistory({ chatId: otherChatId, confirmed: true, maxMessages: 10 }))
      .rejects.toMatchObject({ code: "history_chat_not_allowlisted" });
    await expect(app.importPersonalChatHistory({ chatId: targetChatId, confirmed: false, maxMessages: 10 }))
      .rejects.toBeInstanceOf(PersonalHistoryImportError);
    await app.shutdown();
  });

  it("rejects historical import while the kill switch is active", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wci-history-kill-switch-"));
    directories.push(directory);
    const config = loadConfig({
      WCI_DATA_DIR: directory,
      WCI_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 29).toString("base64"),
      WCI_LIVE_IMPORT_ENABLED: "true",
      WCI_ACCOUNT_AUTHORIZED: "true",
      WCI_SETUP_CONFIRMED: "true",
      WCI_TIMEZONE_CONFIRMED: "true",
      WCI_RETENTION_CONFIRMED: "true",
      WCI_EXPORT_DELETION_CONFIRMED: "true",
      WCI_NOTIFICATIONS_CONFIRMED: "true",
      WCI_KILL_SWITCH: "true"
    });
    const app = new ChatIntelligenceApplication(config, {
      notificationAdapter: new MemoryNotificationAdapter(),
      logger: new MemorySafeLogger()
    });
    app.pipeline.addAllowedChat("491700000001@s.whatsapp.net");
    await expect(app.importPersonalChatHistory({
      chatId: "491700000001@s.whatsapp.net",
      confirmed: true,
      maxMessages: 10
    })).rejects.toMatchObject({ code: "history_live_gate_blocked" });
    app.close();
  });

  it("reconnects an expired pairing socket under the narrow setup gate without enabling live ingestion", async () => {
    vi.useFakeTimers();
    const directory = mkdtempSync(join(tmpdir(), "wci-pairing-reconnect-"));
    directories.push(directory);
    const config = loadConfig({
      WCI_DATA_DIR: directory,
      WCI_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 31).toString("base64"),
      WCI_LIVE_IMPORT_ENABLED: "true",
      WCI_ACCOUNT_AUTHORIZED: "true",
      WCI_SETUP_CONFIRMED: "true",
      WCI_KILL_SWITCH: "false"
    });
    const first = fakeSocket();
    const second = fakeSocket();
    const sockets = [first, second];
    let factoryCalls = 0;
    const app = new ChatIntelligenceApplication(config, {
      notificationAdapter: new MemoryNotificationAdapter(),
      logger: new MemorySafeLogger(),
      personalAdapterFactory: (options) => new PersonalLinkedDeviceAdapter({
        ...options,
        socketFactory: () => {
          factoryCalls += 1;
          const socket = sockets.shift();
          if (!socket) throw new Error("unexpected pairing reconnect");
          return socket.socket;
        }
      })
    });
    await expect(app.getPersonalLinkedDeviceAdapter().start()).resolves.toMatchObject({ started: true });
    first.events.emit("connection.update", { connection: "close" });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(factoryCalls).toBe(2);
    expect(app.health().liveImportEnabled).toBe(false);
    await app.shutdown();
  });

  it("restarts after WhatsApp accepts a QR scan so the authenticated login can finish", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wci-pairing-new-login-"));
    directories.push(directory);
    const config = loadConfig({
      WCI_DATA_DIR: directory,
      WCI_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 33).toString("base64"),
      WCI_LIVE_IMPORT_ENABLED: "true",
      WCI_ACCOUNT_AUTHORIZED: "true",
      WCI_SETUP_CONFIRMED: "true",
      WCI_KILL_SWITCH: "false"
    });
    const first = fakeSocket();
    const second = fakeSocket();
    const sockets = [first, second];
    let factoryCalls = 0;
    const app = new ChatIntelligenceApplication(config, {
      notificationAdapter: new MemoryNotificationAdapter(),
      logger: new MemorySafeLogger(),
      personalAdapterFactory: (options) => new PersonalLinkedDeviceAdapter({
        ...options,
        socketFactory: () => {
          factoryCalls += 1;
          const socket = sockets.shift();
          if (!socket) throw new Error("unexpected post-pairing restart");
          return socket.socket;
        }
      })
    });

    await expect(app.getPersonalLinkedDeviceAdapter().start()).resolves.toMatchObject({ started: true });
    first.events.emit("connection.update", { isNewLogin: true });

    await vi.waitFor(() => expect(factoryCalls).toBe(2));
    expect(first.endCallCount()).toBe(1);
    expect(app.getPairingQrSnapshot()).toMatchObject({ state: "finishing_login" });
    second.events.emit("connection.update", { connection: "open" });
    expect(app.getPairingQrSnapshot()).toMatchObject({ state: "connected" });
    expect(app.health()).toMatchObject({ status: "ready", liveImportEnabled: false });
    await app.shutdown();
  });

  it("tracks ephemeral QR receipt metadata by generation and clears a known-stale code on close", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T20:00:00.000Z"));
    const directory = mkdtempSync(join(tmpdir(), "wci-pairing-freshness-"));
    directories.push(directory);
    const config = loadConfig({
      WCI_DATA_DIR: directory,
      WCI_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 37).toString("base64"),
      WCI_LIVE_IMPORT_ENABLED: "true",
      WCI_ACCOUNT_AUTHORIZED: "true",
      WCI_SETUP_CONFIRMED: "true",
      WCI_KILL_SWITCH: "false"
    });
    const linked = fakeSocket();
    const logger = new MemorySafeLogger();
    const app = new ChatIntelligenceApplication(config, {
      notificationAdapter: new MemoryNotificationAdapter(),
      logger,
      personalAdapterFactory: (options) => new PersonalLinkedDeviceAdapter({
        ...options,
        socketFactory: () => linked.socket
      })
    });
    const adapter = app.getPersonalLinkedDeviceAdapter();
    await expect(adapter.start()).resolves.toMatchObject({ started: true });

    const firstQr = "https://wa.me/settings/linked_devices#ref-one,noise-one,identity,adv-one,1";
    linked.events.emit("connection.update", { qr: firstQr });
    expect(app.getPairingQrSnapshot()).toEqual({
      qr: firstQr,
      issuedAt: "2026-09-21T20:00:00.000Z",
      generation: 1,
      requiresImmediateDisplay: false,
      state: "awaiting_qr"
    });

    vi.setSystemTime(new Date("2026-09-21T20:00:11.000Z"));
    const secondQr = "https://wa.me/settings/linked_devices#ref-two,noise-two,identity,adv-two,1";
    linked.events.emit("connection.update", { qr: secondQr });
    expect(app.getPairingQrSnapshot()).toEqual({
      qr: secondQr,
      issuedAt: "2026-09-21T20:00:11.000Z",
      generation: 2,
      requiresImmediateDisplay: false,
      state: "awaiting_qr"
    });

    vi.setSystemTime(new Date("2026-09-21T20:00:22.000Z"));
    const refreshedQr = "https://wa.me/settings/linked_devices#ref-two,noise-two,identity,adv-refreshed,1";
    linked.events.emit("connection.update", { qr: refreshedQr });
    expect(app.getPairingQrSnapshot()).toEqual({
      qr: refreshedQr,
      issuedAt: "2026-09-21T20:00:22.000Z",
      generation: 3,
      requiresImmediateDisplay: true,
      state: "awaiting_qr"
    });
    expect(JSON.stringify(logger.entries)).not.toContain(firstQr);
    expect(JSON.stringify(logger.entries)).not.toContain(secondQr);
    expect(JSON.stringify(logger.entries)).not.toContain(refreshedQr);

    linked.events.emit("connection.update", { connection: "close" });
    expect(app.getPairingQrSnapshot()).toEqual({
      qr: undefined,
      issuedAt: undefined,
      generation: 3,
      requiresImmediateDisplay: false,
      state: "reconnecting"
    });
    await app.shutdown();
  });
});
