import type {
  AuthenticationState,
  BaileysEventEmitter,
  BaileysEventMap,
  UserFacingSocketConfig,
  WAMessage
} from "@whiskeysockets/baileys";
import { getCompanionPlatformId, proto } from "@whiskeysockets/baileys";
import { describe, expect, it } from "vitest";

import {
  PERSONAL_PAIRING_QR_TIMEOUT_MS,
  PersonalLinkedDeviceAdapter,
  type LinkedDeviceSocket
} from "../src/adapters/personal-linked-device.js";
import type { IncomingMessage } from "../src/domain/types.js";
import type { AdapterMessageContext } from "../src/adapters/types.js";

class FakeBaileysEmitter {
  readonly #listeners = new Map<string, Array<(event: unknown) => void>>();

  on<T extends keyof BaileysEventMap>(event: T, listener: (payload: BaileysEventMap[T]) => void): void {
    const listeners = this.#listeners.get(event) ?? [];
    listeners.push(listener as (payload: unknown) => void);
    this.#listeners.set(event, listeners);
  }

  off<T extends keyof BaileysEventMap>(event: T, listener: (payload: BaileysEventMap[T]) => void): void {
    const listeners = this.#listeners.get(event);
    if (listeners === undefined) {
      return;
    }
    const index = listeners.indexOf(listener as (payload: unknown) => void);
    if (index >= 0) {
      listeners.splice(index, 1);
    }
  }

  emit<T extends keyof BaileysEventMap>(event: T, payload: BaileysEventMap[T]): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      listener(payload);
    }
  }
}

type HistoryFetcher = NonNullable<LinkedDeviceSocket["fetchMessageHistory"]>;
type AppStateResync = NonNullable<LinkedDeviceSocket["resyncAppState"]>;

function testSocket(options: {
  readonly fetchMessageHistory?: HistoryFetcher;
  readonly resyncAppState?: AppStateResync;
} = {}): { readonly socket: LinkedDeviceSocket; readonly events: FakeBaileysEmitter; readonly ended: () => boolean } {
  const events = new FakeBaileysEmitter();
  let didEnd = false;
  return {
    events,
    socket: {
      ev: events as unknown as BaileysEventEmitter,
      async end(): Promise<void> {
        didEnd = true;
      },
      ...(options.fetchMessageHistory === undefined ? {} : { fetchMessageHistory: options.fetchMessageHistory }),
      ...(options.resyncAppState === undefined ? {} : { resyncAppState: options.resyncAppState })
    },
    ended: () => didEnd
  };
}

const auth = {} as AuthenticationState;
const fixedNow = (): Date => new Date("2024-01-01T12:00:00.000Z");

function textMessage(id: string, text: string): WAMessage {
  return {
    key: { remoteJid: "491701234@s.whatsapp.net", participant: "491701234@s.whatsapp.net", id, fromMe: false },
    messageTimestamp: 1_704_067_200,
    message: { conversation: text }
  };
}

describe("PersonalLinkedDeviceAdapter", () => {
  it("is inert by default and requires both explicit live gates", async () => {
    let factoryCalls = 0;
    const inert = new PersonalLinkedDeviceAdapter({
      auth,
      onIncomingMessage: () => undefined,
      socketFactory: () => {
        factoryCalls += 1;
        return testSocket().socket;
      }
    });
    const missingGate = new PersonalLinkedDeviceAdapter({
      auth,
      liveImportEnabled: true,
      onIncomingMessage: () => undefined,
      socketFactory: () => {
        factoryCalls += 1;
        return testSocket().socket;
      }
    });
    const rejectedGate = new PersonalLinkedDeviceAdapter({
      auth,
      liveImportEnabled: true,
      authorizeLiveConnection: () => false,
      onIncomingMessage: () => undefined,
      socketFactory: () => {
        factoryCalls += 1;
        return testSocket().socket;
      }
    });

    await expect(inert.start()).resolves.toEqual({ started: false, reason: "live_import_disabled" });
    await expect(missingGate.start()).resolves.toEqual({ started: false, reason: "missing_live_gate" });
    await expect(rejectedGate.start()).resolves.toEqual({ started: false, reason: "live_gate_rejected" });
    expect(factoryCalls).toBe(0);
  });

  it("uses rc14's safe socket settings and never forwards requestId upserts", async () => {
    const { socket, events } = testSocket();
    const deliveries: Array<{ readonly message: IncomingMessage; readonly context: AdapterMessageContext }> = [];
    let socketConfig: UserFacingSocketConfig | undefined;
    const adapter = new PersonalLinkedDeviceAdapter({
      auth,
      liveImportEnabled: true,
      authorizeLiveConnection: () => true,
      onIncomingMessage: (message, context) => {
        deliveries.push({ message, context });
      },
      socketFactory: (config) => {
        socketConfig = config;
        return socket;
      }
    });

    await expect(adapter.start()).resolves.toEqual({ started: true, reason: "started" });
    expect(socketConfig).toMatchObject({
      browser: ["Mac OS", "Chrome", expect.any(String)],
      markOnlineOnConnect: false,
      shouldSyncHistoryMessage: expect.any(Function),
      syncFullHistory: false,
      emitOwnEvents: false,
      fireInitQueries: false,
      qrTimeout: PERSONAL_PAIRING_QR_TIMEOUT_MS
    });
    expect(getCompanionPlatformId(socketConfig!.browser)).toBe("1");
    expect(socketConfig?.shouldSyncHistoryMessage({})).toBe(false);
    expect(socketConfig?.shouldSyncHistoryMessage({ syncType: proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP })).toBe(true);
    expect(socketConfig?.shouldSyncHistoryMessage({ syncType: proto.HistorySync.HistorySyncType.RECENT })).toBe(true);
    expect(socketConfig?.shouldSyncHistoryMessage({ syncType: proto.HistorySync.HistorySyncType.FULL })).toBe(false);
    expect(socketConfig?.shouldSyncHistoryMessage({ syncType: proto.HistorySync.HistorySyncType.ON_DEMAND })).toBe(false);

    events.emit("messages.upsert", { type: "notify", messages: [textMessage("live-1", "Live")], requestId: "replay" });
    await adapter.waitForIdle();
    expect(deliveries).toHaveLength(0);
  });

  it("discovers real individual/group chats while dropping automatic history messages", async () => {
    const { socket, events } = testSocket();
    const deliveries: Array<{ readonly message: IncomingMessage; readonly context: AdapterMessageContext }> = [];
    const chats: Array<{ readonly id: string; readonly kind: "individual" | "group"; readonly label?: string }> = [];
    const adapter = new PersonalLinkedDeviceAdapter({
      auth,
      liveImportEnabled: true,
      authorizeLiveConnection: () => true,
      onIncomingMessage: (message, context) => {
        deliveries.push({ message, context });
      },
      onAvailableChats: (available) => {
        chats.push(...available);
      },
      socketFactory: () => socket
    });
    await adapter.start();

    events.emit("messages.upsert", { type: "notify", messages: [textMessage("live-1", "Live")] });
    events.emit("messages.upsert", { type: "append", messages: [textMessage("history-1", "History")] });
    events.emit("messaging-history.set", {
      chats: [
        { id: "491701234@s.whatsapp.net", name: "Einzelchat" },
        { id: "120363000000000001@g.us", name: "Familiengruppe" }
      ],
      contacts: [],
      messages: [textMessage("history-2", "History set")],
      isLatest: true,
      syncType: proto.HistorySync.HistorySyncType.RECENT
    });
    await adapter.waitForIdle();

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      message: { source: "live_notify", messageId: "live-1" },
      context: { eventType: "new", isHistorical: false, upsertType: "notify" }
    });
    expect(chats).toEqual([
      { id: "491701234@s.whatsapp.net", kind: "individual", label: "Einzelchat" },
      { id: "120363000000000001@g.us", kind: "group", label: "Familiengruppe" }
    ]);
  });

  it("imports only one allowlisted chat through the bounded on-demand history API and deduplicates", async () => {
    const targetChatId = "120363000000000001@g.us";
    const automaticCursorMessage = textMessage("cursor-1", "Cursor");
    automaticCursorMessage.key = { ...automaticCursorMessage.key, remoteJid: targetChatId, participant: "491701234@s.whatsapp.net" };
    const older = textMessage("history-1", "History");
    older.key = { ...older.key, remoteJid: targetChatId, participant: "491701234@s.whatsapp.net" };
    const duplicate = textMessage("history-1", "History duplicate");
    duplicate.key = { ...duplicate.key, remoteJid: targetChatId, participant: "491701234@s.whatsapp.net" };
    const newest = textMessage("history-2", "History second");
    newest.key = { ...newest.key, remoteJid: targetChatId, participant: "491701234@s.whatsapp.net" };
    let requestedCount = 0;
    let requestedCursor: string | undefined;
    let events: FakeBaileysEmitter;
    const socketParts = testSocket({
      fetchMessageHistory: async (count, oldestKey) => {
        requestedCount = count;
        requestedCursor = oldestKey.id;
        events.emit("messaging-history.set", {
          chats: [{ id: targetChatId, endOfHistoryTransfer: true, endOfHistoryTransferType: proto.Conversation.EndOfHistoryTransferType.COMPLETE_AND_NO_MORE_MESSAGE_REMAIN_ON_PRIMARY }],
          contacts: [],
          messages: [older, duplicate, newest],
          syncType: proto.HistorySync.HistorySyncType.ON_DEMAND,
          peerDataRequestSessionId: "history-session"
        });
        return "history-session";
      }
    });
    events = socketParts.events;
    const deliveries: Array<{ readonly message: IncomingMessage; readonly context: AdapterMessageContext }> = [];
    const adapter = new PersonalLinkedDeviceAdapter({
      auth,
      liveImportEnabled: true,
      authorizeLiveConnection: () => true,
      historyResponseTimeoutMs: 50,
      onIncomingMessage: (message, context) => {
        deliveries.push({ message, context });
      },
      socketFactory: () => socketParts.socket
    });
    await adapter.start();

    events.emit("messaging-history.set", {
      chats: [{ id: targetChatId, name: "Familiengruppe" }],
      contacts: [],
      messages: [automaticCursorMessage],
      syncType: proto.HistorySync.HistorySyncType.RECENT,
      isLatest: true
    });
    await adapter.waitForIdle();
    expect(deliveries).toHaveLength(0);

    const result = await adapter.importHistory({ chatId: targetChatId, maxMessages: 10 });
    await adapter.waitForIdle();
    expect(result).toMatchObject({
      status: "completed",
      chatId: targetChatId,
      imported: 2,
      deduplicated: 1,
      pages: 1,
      manualExportAlternative: false
    });
    expect(requestedCount).toBe(10);
    expect(requestedCursor).toBe("cursor-1");
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]).toMatchObject({
      message: { messageId: "history-1", source: "history_sync", isHistorical: true },
      context: { eventType: "history", isHistorical: true, historySyncType: proto.HistorySync.HistorySyncType.ON_DEMAND }
    });
    expect(deliveries[1].message.isHistorical).toBe(true);
  });

  it("rejects history without a real cursor and exposes only read-only adapter actions", async () => {
    const parts = testSocket({ fetchMessageHistory: async () => "unused-session" });
    const adapter = new PersonalLinkedDeviceAdapter({
      auth,
      liveImportEnabled: true,
      authorizeLiveConnection: () => true,
      onIncomingMessage: () => undefined,
      socketFactory: () => parts.socket
    });
    await adapter.start();

    await expect(adapter.importHistory({ chatId: "491701234@s.whatsapp.net", maxMessages: 10 })).resolves.toMatchObject({
      status: "unavailable",
      reason: "history_cursor_unavailable",
      manualExportAlternative: true
    });
    expect(parts.socket).not.toHaveProperty("sendMessage");
    expect(parts.socket).not.toHaveProperty("sendReadReceipt");
    expect(parts.socket).not.toHaveProperty("sendPresenceUpdate");
  });

  it("honors a finite historical time window in addition to the page bound", async () => {
    const targetChatId = "491701234@s.whatsapp.net";
    const seed = textMessage("cursor-window", "Seed");
    const inside = textMessage("inside-window", "Inside");
    const outside = textMessage("outside-window", "Outside");
    seed.messageTimestamp = 1_704_067_200;
    inside.messageTimestamp = 1_704_067_190;
    outside.messageTimestamp = 1_704_000_000;
    let events: FakeBaileysEmitter;
    const parts = testSocket({
      fetchMessageHistory: async () => {
        events.emit("messaging-history.set", {
          chats: [{ id: targetChatId, endOfHistoryTransfer: true }],
          contacts: [],
          messages: [inside, outside],
          syncType: proto.HistorySync.HistorySyncType.ON_DEMAND,
          peerDataRequestSessionId: "window-session"
        });
        return "window-session";
      }
    });
    events = parts.events;
    const deliveries: IncomingMessage[] = [];
    const adapter = new PersonalLinkedDeviceAdapter({
      auth,
      liveImportEnabled: true,
      authorizeLiveConnection: () => true,
      historyResponseTimeoutMs: 50,
      onIncomingMessage: (message) => {
        deliveries.push(message);
      },
      socketFactory: () => parts.socket
    });
    await adapter.start();
    events.emit("messaging-history.set", {
      chats: [],
      contacts: [],
      messages: [seed],
      syncType: proto.HistorySync.HistorySyncType.RECENT
    });
    await adapter.waitForIdle();

    const result = await adapter.importHistory({
      chatId: targetChatId,
      maxMessages: 10,
      since: "2023-12-31T23:59:45.000Z",
      until: "2024-01-01T00:00:00.000Z"
    });
    expect(result).toMatchObject({ status: "completed", imported: 1, pages: 1 });
    expect(deliveries.map((message) => message.messageId)).toEqual(["inside-window"]);
  });

  it("refreshes chat metadata through the installed rc14 read-only app-state API", async () => {
    let refreshCalls = 0;
    let initialSync: boolean | undefined;
    const parts = testSocket({
      resyncAppState: async (_collections, isInitialSync) => {
        refreshCalls += 1;
        initialSync = isInitialSync;
      }
    });
    const adapter = new PersonalLinkedDeviceAdapter({
      auth,
      liveImportEnabled: true,
      authorizeLiveConnection: () => true,
      onIncomingMessage: () => undefined,
      socketFactory: () => parts.socket
    });
    await adapter.start();

    await expect(adapter.refreshAvailableChats()).resolves.toEqual({ refreshed: true });
    expect(refreshCalls).toBe(1);
    expect(initialSync).toBe(true);
  });

  it("releases a closed socket so the gated runtime can reconnect with a fresh socket", async () => {
    const first = testSocket();
    const second = testSocket();
    const sockets = [first, second];
    const statuses: string[] = [];
    const adapter = new PersonalLinkedDeviceAdapter({
      auth,
      liveImportEnabled: true,
      authorizeLiveConnection: () => true,
      onIncomingMessage: () => undefined,
      onConnectionStatus: (status) => {
        if (status.connection) statuses.push(status.connection);
      },
      socketFactory: () => {
        const next = sockets.shift();
        if (!next) throw new Error("unexpected socket creation");
        return next.socket;
      }
    });

    await expect(adapter.start()).resolves.toEqual({ started: true, reason: "started" });
    expect(adapter.isConnected).toBe(true);
    first.events.emit("connection.update", { connection: "close" });
    expect(adapter.isConnected).toBe(false);
    expect(statuses).toEqual(["close"]);

    await expect(adapter.start()).resolves.toEqual({ started: true, reason: "started" });
    expect(adapter.isConnected).toBe(true);
    await adapter.stop();
    expect(second.ended()).toBe(true);
  });

  it("normalizes generic upserts, edits, individual deletes, and reactions with operation metadata", async () => {
    const { socket, events, ended } = testSocket();
    const deliveries: Array<{ readonly message: IncomingMessage; readonly context: AdapterMessageContext }> = [];
    const adapter = new PersonalLinkedDeviceAdapter({
      auth,
      liveImportEnabled: true,
      authorizeLiveConnection: () => true,
      now: fixedNow,
      onIncomingMessage: (message, context) => {
        deliveries.push({ message, context });
      },
      socketFactory: () => socket
    });
    await adapter.start();

    const targetKey = { remoteJid: "491701234@s.whatsapp.net", participant: "491701234@s.whatsapp.net", id: "target-1", fromMe: false };
    events.emit("messages.update", [{
      key: { ...targetKey, id: "upsert-1" },
      update: { message: { conversation: "Aktualisiert" } }
    }]);
    events.emit("messages.update", [{
      key: targetKey,
      update: { message: { editedMessage: { message: { conversation: "Korrigiert" } } } }
    }]);
    events.emit("messages.delete", { keys: [targetKey] });
    events.emit("messages.reaction", [{
      key: targetKey,
      reaction: {
        key: { remoteJid: "491701234@s.whatsapp.net", participant: "491701234@s.whatsapp.net", id: "reaction-1", fromMe: false },
        text: "👍",
        senderTimestampMs: 1_704_067_205_000
      }
    }]);
    await adapter.waitForIdle();

    expect(deliveries).toHaveLength(4);
    expect(deliveries[0]).toMatchObject({
      message: { messageId: "upsert-1", kind: "text", text: "Aktualisiert", timestamp: "2024-01-01T12:00:00.000Z" },
      context: { eventType: "upsert", timestampProvenance: "observed" }
    });
    expect(deliveries[1]).toMatchObject({
      message: { messageId: "target-1", kind: "text", text: "Korrigiert", isEdit: true, timestamp: "2024-01-01T12:00:00.000Z" },
      context: { eventType: "edit", timestampProvenance: "observed" }
    });
    expect(deliveries[2]).toMatchObject({
      message: { messageId: "target-1", isDelete: true, kind: "unknown", timestamp: "2024-01-01T12:00:00.000Z" },
      context: { eventType: "delete", targetMessageId: "target-1", timestampProvenance: "observed" }
    });
    expect(deliveries[3]).toMatchObject({
      message: { messageId: "reaction-1", kind: "reaction", text: "👍", quotedMessageId: "target-1" },
      context: { eventType: "reaction", targetMessageId: "target-1", reaction: { emoji: "👍", removed: false } }
    });

    await adapter.stop();
    expect(ended()).toBe(true);
  });
});
