import makeWASocket, {
  ALL_WA_PATCH_NAMES,
  Browsers,
  extractMessageContent,
  fetchLatestWaWebVersion,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type BaileysEventEmitter,
  type BaileysEventMap,
  type UserFacingSocketConfig,
  type WAVersion,
  type WAMessage,
  type WAMessageKey,
  type WASocket
} from "@whiskeysockets/baileys";

import type { IncomingMedia, IncomingMessage, MessageKind } from "../domain/types.js";
import type {
  AdapterError,
  AdapterErrorHandler,
  AdapterMessageContext,
  AdapterMessageEventType,
  IncomingMessageHandler,
  MaybePromise,
  NormalizedIncomingMessage,
  ReactionMetadata,
  TimestampProvenance
} from "./types.js";

/**
 * The only socket surface retained by this adapter. Deliberately excluding the
 * Baileys write, receipt, and presence methods makes those operations
 * unavailable to adapter code.
 */
export interface LinkedDeviceSocket {
  readonly ev: BaileysEventEmitter;
  end(error: Error | undefined): Promise<void>;
  /** The only message-retrieval action exposed to the history importer. */
  readonly fetchMessageHistory?: WASocket["fetchMessageHistory"];
  /** Read-only app-state resync used to refresh chat metadata. */
  readonly resyncAppState?: WASocket["resyncAppState"];
}

export type LinkedDeviceSocketFactory = (
  config: UserFacingSocketConfig
) => LinkedDeviceSocket;

/** Keep the real Baileys QR rotation aligned with the local pairing display. */
export const PERSONAL_PAIRING_QR_TIMEOUT_MS = 30_000;

const WA_WEB_VERSION_CACHE_MS = 10 * 60_000;
const WA_WEB_VERSION_FETCH_TIMEOUT_MS = 15_000;
const TEST_SOCKET_WEB_VERSION: WAVersion = [2, 3000, 0];

export interface LinkedDeviceConnectionStatus {
  readonly connection?: "open" | "connecting" | "close";
  /** Numeric Baileys/WhatsApp disconnect code only; raw errors are never surfaced. */
  readonly disconnectStatusCode?: number;
  readonly isNewLogin?: boolean;
  readonly receivedPendingNotifications?: boolean;
  /** Indicates pairing is needed without exposing QR material. */
  readonly hasPairingQr: boolean;
}

/** Ephemeral setup data only; non-allowlisted chats are never persisted. */
export interface AvailableLinkedChat {
  readonly id: string;
  readonly kind: "individual" | "group";
  readonly label?: string;
}

export interface PersonalLinkedDeviceAdapterConfig {
  readonly auth: AuthenticationState;
  /** Must be explicitly true; omitted and false both keep the adapter offline. */
  readonly liveImportEnabled?: boolean;
  /** A second, application-owned authorization gate required before connection. */
  readonly authorizeLiveConnection?: () => MaybePromise<boolean>;
  readonly onIncomingMessage: IncomingMessageHandler;
  /** Persists credentials in a caller-owned location outside the repository. */
  readonly saveAuthState?: (update: Partial<AuthenticationCreds>) => MaybePromise<void>;
  /** Ephemeral local setup hook. QR content is never logged or persisted. */
  readonly onPairingQr?: (qr: string) => void;
  readonly onConnectionStatus?: (status: LinkedDeviceConnectionStatus) => void;
  readonly onAvailableChats?: (chats: readonly AvailableLinkedChat[]) => void;
  readonly onAdapterError?: AdapterErrorHandler;
  /** Test seam; production defaults to the pinned Baileys socket factory. */
  readonly socketFactory?: LinkedDeviceSocketFactory;
  /** Test seam for observed timestamps on operation-only events. */
  readonly now?: () => Date;
  /** Test seam; production uses a bounded wait for the phone's history response. */
  readonly historyResponseTimeoutMs?: number;
}

export type PersonalLinkedDeviceStartReason =
  | "started"
  | "already_started"
  | "live_import_disabled"
  | "missing_live_gate"
  | "live_gate_rejected"
  | "live_gate_failed"
  | "web_version_unavailable"
  | "socket_start_failed";

export interface PersonalLinkedDeviceStartResult {
  readonly started: boolean;
  readonly reason: PersonalLinkedDeviceStartReason;
}

export interface PersonalHistoryImportRequest {
  readonly chatId: string;
  /** A positive upper bound. Omit only when a finite time window is supplied. */
  readonly maxMessages?: number;
  readonly since?: string;
  readonly until?: string;
}

export type PersonalHistoryImportStatus = "completed" | "partial" | "unavailable" | "rejected";

export interface PersonalHistoryImportResult {
  readonly status: PersonalHistoryImportStatus;
  readonly chatId: string;
  readonly imported: number;
  readonly deduplicated: number;
  readonly pages: number;
  readonly reason?:
    | "history_api_unavailable"
    | "history_cursor_unavailable"
    | "history_response_timeout"
    | "history_response_error"
    | "history_empty"
    | "history_bound_reached"
    | "history_bound_invalid"
    | "history_complete"
    | "history_incomplete";
  /** Always true for an unavailable/incomplete Baileys result. */
  readonly manualExportAlternative: boolean;
}

export interface AvailableChatsRefreshResult {
  readonly refreshed: boolean;
  readonly reason?: "not_connected" | "read_only_api_unavailable" | "refresh_failed";
}

const MAX_HISTORY_MESSAGES = 1_000;
const MAX_HISTORY_PAGES = 100;
const DEFAULT_HISTORY_RESPONSE_TIMEOUT_MS = 5_000;
const SAFE_CHAT_DISCOVERY_HISTORY_TYPES = new Set<number>([
  proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
  proto.HistorySync.HistorySyncType.RECENT
]);
const ON_DEMAND_HISTORY_TYPE = proto.HistorySync.HistorySyncType.ON_DEMAND;
const COMPLETE_AND_NO_MORE_MESSAGES = proto.Conversation.EndOfHistoryTransferType.COMPLETE_AND_NO_MORE_MESSAGE_REMAIN_ON_PRIMARY;

/** Structural subset shared by Baileys message and proto key values. */
export interface LinkedDeviceMessageKey {
  readonly remoteJid?: string | null;
  readonly remoteJidAlt?: string;
  readonly participant?: string | null;
  readonly participantAlt?: string;
  readonly id?: string | null;
  readonly fromMe?: boolean | null;
}

export interface BaileysNormalizationOptions {
  readonly eventType: AdapterMessageEventType;
  readonly sourceEvent: string;
  readonly source: "live_notify" | "history_sync";
  readonly isHistorical: boolean;
  readonly upsertType?: "notify" | "append";
  readonly historySyncType?: number;
  readonly historyIsLatest?: boolean;
  /** Operation records sometimes have no original-message timestamp. */
  readonly allowObservedTimestamp?: boolean;
  readonly now?: () => Date;
  readonly targetKey?: LinkedDeviceMessageKey;
  readonly reaction?: ReactionMetadata;
}

interface ListenerSet {
  readonly upsert: (event: BaileysEventMap["messages.upsert"]) => void;
  readonly history: (event: BaileysEventMap["messaging-history.set"]) => void;
  readonly update: (event: BaileysEventMap["messages.update"]) => void;
  readonly deletion: (event: BaileysEventMap["messages.delete"]) => void;
  readonly reaction: (event: BaileysEventMap["messages.reaction"]) => void;
  readonly chats: (event: BaileysEventMap["chats.upsert"]) => void;
  readonly chatsUpdate: (event: BaileysEventMap["chats.update"]) => void;
  readonly connection: (event: BaileysEventMap["connection.update"]) => void;
  readonly credentials: (event: BaileysEventMap["creds.update"]) => void;
}

interface MessageIdentity {
  readonly messageId: string;
  readonly chatId: string;
  readonly senderId: string;
  readonly fromMe: boolean;
}

interface BaileysContent {
  readonly kind: MessageKind;
  readonly text?: string;
  readonly media?: IncomingMedia;
  readonly quotedMessageId?: string;
  readonly reaction?: ReactionMetadata;
  readonly reactionTargetKey?: LinkedDeviceMessageKey;
}

interface TimestampResult {
  readonly timestamp: string;
  readonly provenance: TimestampProvenance;
}

interface HistoryCursor {
  readonly key: WAMessageKey;
  readonly timestampMs: number;
}

interface HistoryPage {
  readonly messages: readonly WAMessage[];
  readonly cursor?: HistoryCursor;
  readonly complete: boolean;
}

interface HistoryPageWaiter {
  readonly resolve: (page: HistoryPage | undefined) => void;
  readonly timer: NodeJS.Timeout;
}

interface ActiveHistoryImport {
  readonly request: PersonalHistoryImportRequest;
  readonly targetChatId: string;
  readonly seenMessageKeys: Set<string>;
  readonly pendingEvents: Array<BaileysEventMap["messaging-history.set"]>;
  expectedSessionId: string | undefined;
  waiter: HistoryPageWaiter | undefined;
  imported: number;
  deduplicated: number;
  pages: number;
}

interface SilentLogger {
  readonly level: string;
  child(bindings: Record<string, unknown>): SilentLogger;
  trace(data: unknown, message?: string): void;
  debug(data: unknown, message?: string): void;
  info(data: unknown, message?: string): void;
  warn(data: unknown, message?: string): void;
  error(data: unknown, message?: string): void;
}

const silentLogger: SilentLogger = {
  level: "silent",
  child: () => silentLogger,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

/**
 * Normalizes one Baileys record without retaining socket state. Callers must
 * choose the operation semantics; malformed identities are rejected rather
 * than turned into synthetic IDs.
 */
export function normalizeBaileysMessage(
  sourceMessage: WAMessage,
  options: BaileysNormalizationOptions
): NormalizedIncomingMessage | undefined {
  const rawContent = sourceMessage.message ?? undefined;
  const eventType = resolveEventType(rawContent, options.eventType);
  const protocolTarget = eventType === "delete"
    ? rawContent?.protocolMessage?.key ?? undefined
    : undefined;
  const resolvedTargetKey = options.targetKey
    ?? protocolTarget
    ?? reactionTargetKey(rawContent);
  const identityKey = eventType === "delete" && protocolTarget !== undefined
    ? mergeKeys(protocolTarget, sourceMessage.key)
    : sourceMessage.key;
  const identity = identityFromKey(identityKey);
  if (identity === undefined) {
    return undefined;
  }

  const timestamp = timestampFor(
    sourceMessage.messageTimestamp,
    options.allowObservedTimestamp === true,
    options.now
  );
  if (timestamp === undefined) {
    return undefined;
  }

  const content = normalizeBaileysContent(rawContent);
  const message: IncomingMessage = {
    messageId: identity.messageId,
    chatId: identity.chatId,
    senderId: identity.senderId,
    fromMe: identity.fromMe,
    timestamp: timestamp.timestamp,
    source: options.source,
    kind: eventType === "delete" ? "unknown" : content.kind,
    isHistorical: options.isHistorical
  };
  if (eventType === "edit") {
    message.isEdit = true;
  }
  if (eventType === "delete") {
    message.isDelete = true;
  }
  if (content.text !== undefined && eventType !== "delete") {
    message.text = content.text;
  }
  if (content.media !== undefined && eventType !== "delete") {
    message.media = content.media;
  }
  if (content.quotedMessageId !== undefined && eventType !== "delete") {
    message.quotedMessageId = content.quotedMessageId;
  }

  const target = targetContext(resolvedTargetKey);
  const reaction = options.reaction ?? content.reaction;
  const context: AdapterMessageContext = {
    transport: "personal_linked_device",
    eventType,
    sourceEvent: options.sourceEvent,
    isHistorical: options.isHistorical,
    timestampProvenance: timestamp.provenance,
    ...(options.upsertType === undefined ? {} : { upsertType: options.upsertType }),
    ...(options.historySyncType === undefined ? {} : { historySyncType: options.historySyncType }),
    ...(options.historyIsLatest === undefined ? {} : { historyIsLatest: options.historyIsLatest }),
    ...target,
    ...(reaction === undefined ? {} : { reaction })
  };

  return { message, context };
}

/**
 * Opt-in-only Baileys adapter. Construction is inert. `start()` checks both an
 * explicit config flag and an application callback before creating a socket.
 */
export class PersonalLinkedDeviceAdapter {
  readonly #config: PersonalLinkedDeviceAdapterConfig;
  #socket: LinkedDeviceSocket | undefined;
  #listeners: ListenerSet | undefined;
  #startInFlight: Promise<PersonalLinkedDeviceStartResult> | undefined;
  #deliveries: Promise<void> = Promise.resolve();
  #credentialWrites: Promise<void> = Promise.resolve();
  #waWebVersion: WAVersion | undefined;
  #waWebVersionFetchedAt = 0;
  /** Ephemeral cursors observed from actual WhatsApp history records. */
  readonly #historyCursors = new Map<string, HistoryCursor>();
  #activeHistoryImport: ActiveHistoryImport | undefined;

  constructor(config: PersonalLinkedDeviceAdapterConfig) {
    this.#config = config;
  }

  get isConnected(): boolean {
    return this.#socket !== undefined;
  }

  async start(): Promise<PersonalLinkedDeviceStartResult> {
    if (this.#socket !== undefined) {
      return { started: true, reason: "already_started" };
    }
    if (this.#startInFlight !== undefined) {
      return this.#startInFlight;
    }

    const start = this.#startInternal();
    this.#startInFlight = start;
    try {
      return await start;
    } finally {
      if (this.#startInFlight === start) {
        this.#startInFlight = undefined;
      }
    }
  }

  async #startInternal(): Promise<PersonalLinkedDeviceStartResult> {
    if (this.#config.liveImportEnabled !== true) {
      return { started: false, reason: "live_import_disabled" };
    }
    if (this.#config.authorizeLiveConnection === undefined) {
      return { started: false, reason: "missing_live_gate" };
    }

    let gateApproved: boolean;
    try {
      gateApproved = await this.#config.authorizeLiveConnection();
    } catch {
      this.#reportError({ code: "live_gate_failed" });
      return { started: false, reason: "live_gate_failed" };
    }
    if (gateApproved !== true) {
      return { started: false, reason: "live_gate_rejected" };
    }

    let waWebVersion: WAVersion;
    try {
      waWebVersion = await this.#resolveWaWebVersion();
    } catch {
      this.#reportError({ code: "web_version_unavailable" });
      return { started: false, reason: "web_version_unavailable" };
    }

    try {
      this.#socket = this.#createSocket(waWebVersion);
      this.#subscribe(this.#socket);
    } catch {
      this.#socket = undefined;
      this.#listeners = undefined;
      this.#reportError({ code: "socket_start_failed" });
      return { started: false, reason: "socket_start_failed" };
    }

    return { started: true, reason: "started" };
  }

  /** Stops local receipt only; it does not log out or modify the WhatsApp account. */
  async stop(): Promise<void> {
    const socket = this.#socket;
    const listeners = this.#listeners;
    this.#socket = undefined;
    this.#listeners = undefined;
    if (this.#activeHistoryImport !== undefined) {
      this.#cancelHistoryPageWait(this.#activeHistoryImport);
      this.#activeHistoryImport = undefined;
    }
    this.#historyCursors.clear();

    if (socket !== undefined && listeners !== undefined) {
      socket.ev.off("messages.upsert", listeners.upsert);
      socket.ev.off("messaging-history.set", listeners.history);
      socket.ev.off("messages.update", listeners.update);
      socket.ev.off("messages.delete", listeners.deletion);
      socket.ev.off("messages.reaction", listeners.reaction);
      socket.ev.off("chats.upsert", listeners.chats);
      socket.ev.off("chats.update", listeners.chatsUpdate);
      socket.ev.off("connection.update", listeners.connection);
      socket.ev.off("creds.update", listeners.credentials);
    }

    await this.waitForIdle();
    if (socket !== undefined) {
      await socket.end(undefined);
    }
  }

  /** Useful for orderly shutdowns and deterministic tests. */
  async waitForIdle(): Promise<void> {
    await this.#deliveries;
    await this.#credentialWrites;
  }

  /** Refreshes only chat metadata through Baileys' app-state read path. */
  async refreshAvailableChats(): Promise<AvailableChatsRefreshResult> {
    const socket = this.#socket;
    if (socket === undefined) return { refreshed: false, reason: "not_connected" };
    if (socket.resyncAppState === undefined) return { refreshed: false, reason: "read_only_api_unavailable" };
    try {
      // `true` only tells Baileys to apply returned app-state mutations with
      // initial-sync conditions. It does not enable history sync or request
      // messages. This lets existing linked sessions surface safe chat IDs
      // from read-only app-state updates after a reconnect.
      await socket.resyncAppState(ALL_WA_PATCH_NAMES, true);
      return { refreshed: true };
    } catch {
      return { refreshed: false, reason: "refresh_failed" };
    }
  }

  /**
   * Requests one bounded, explicitly initiated history transfer. The socket
   * only exposes Baileys' fetchMessageHistory method here; no send, receipt or
   * presence method is available to this importer.
   */
  async importHistory(request: PersonalHistoryImportRequest): Promise<PersonalHistoryImportResult> {
    const validation = validateHistoryImportRequest(request);
    if (!validation.valid) {
      return {
        status: "rejected",
        chatId: request.chatId,
        imported: 0,
        deduplicated: 0,
        pages: 0,
        reason: "history_bound_invalid",
        manualExportAlternative: false
      };
    }

    const socket = this.#socket;
    if (socket === undefined) return unavailableHistoryResult(request.chatId, "history_api_unavailable");
    const fetchMessageHistory = socket.fetchMessageHistory;
    if (fetchMessageHistory === undefined) return unavailableHistoryResult(request.chatId, "history_api_unavailable");
    const cursor = this.#historyCursors.get(request.chatId);
    if (cursor === undefined) return unavailableHistoryResult(request.chatId, "history_cursor_unavailable");
    if (this.#activeHistoryImport !== undefined) {
      return {
        status: "rejected",
        chatId: request.chatId,
        imported: 0,
        deduplicated: 0,
        pages: 0,
        reason: "history_incomplete",
        manualExportAlternative: false
      };
    }

    const active: ActiveHistoryImport = {
      request,
      targetChatId: request.chatId,
      seenMessageKeys: new Set<string>(),
      pendingEvents: [],
      expectedSessionId: undefined,
      waiter: undefined,
      imported: 0,
      deduplicated: 0,
      pages: 0
    };
    this.#activeHistoryImport = active;
    let currentCursor = cursor;
    let status: PersonalHistoryImportStatus = "partial";
    let reason: PersonalHistoryImportResult["reason"] = "history_incomplete";

    try {
      for (let pageNumber = 0; pageNumber < MAX_HISTORY_PAGES; pageNumber += 1) {
        const messageLimit = Math.min(
          100,
          request.maxMessages === undefined ? MAX_HISTORY_MESSAGES : request.maxMessages - active.imported
        );
        if (messageLimit <= 0) {
          status = "partial";
          reason = "history_bound_reached";
          break;
        }

        active.expectedSessionId = undefined;
        active.pendingEvents.length = 0;
        const pagePromise = this.#waitForHistoryPage(active);
        let sessionId: string;
        try {
          sessionId = await fetchMessageHistory(messageLimit, currentCursor.key, currentCursor.timestampMs);
        } catch {
          this.#cancelHistoryPageWait(active);
          status = active.pages === 0 ? "unavailable" : "partial";
          reason = "history_response_error";
          break;
        }
        active.expectedSessionId = nonEmptyString(sessionId);
        this.#flushPendingHistoryEvents(active);
        const page = await pagePromise;
        if (page === undefined) {
          status = active.pages === 0 ? "unavailable" : "partial";
          reason = "history_response_timeout";
          break;
        }
        active.pages += 1;
        if (page.cursor !== undefined) {
          if (sameHistoryCursor(page.cursor, currentCursor)) {
            status = "partial";
            reason = "history_incomplete";
            break;
          }
          currentCursor = page.cursor;
        }
        if (page.messages.length === 0 && page.cursor === undefined) {
          status = active.pages === 1 ? "unavailable" : "partial";
          reason = "history_empty";
          break;
        }
        if (page.complete) {
          status = "completed";
          reason = "history_complete";
          break;
        }
        if (active.imported >= (request.maxMessages ?? MAX_HISTORY_MESSAGES)) {
          status = "partial";
          reason = "history_bound_reached";
          break;
        }
        if (page.cursor === undefined) {
          status = "partial";
          reason = "history_incomplete";
          break;
        }
      }

      if (active.pages >= MAX_HISTORY_PAGES && status === "partial") {
        reason = "history_incomplete";
      }
    } finally {
      this.#cancelHistoryPageWait(active);
      if (this.#activeHistoryImport === active) this.#activeHistoryImport = undefined;
    }
    await this.waitForIdle();

    return {
      status,
      chatId: request.chatId,
      imported: active.imported,
      deduplicated: active.deduplicated,
      pages: active.pages,
      ...(reason === undefined ? {} : { reason }),
      manualExportAlternative: status === "unavailable" || status === "partial"
    };
  }

  #createSocket(version: WAVersion): LinkedDeviceSocket {
    const socketConfig = this.#socketConfig(version);
    return this.#config.socketFactory === undefined
      ? makeWASocket(socketConfig)
      : this.#config.socketFactory(socketConfig);
  }

  async #resolveWaWebVersion(): Promise<WAVersion> {
    // The test socket factory never connects to WhatsApp. Keep its configuration
    // deterministic and offline; production always resolves the current Web
    // revision before opening a socket so it cannot emit a QR with stale defaults.
    if (this.#config.socketFactory !== undefined) return [...TEST_SOCKET_WEB_VERSION];

    const now = Date.now();
    if (this.#waWebVersion !== undefined && now - this.#waWebVersionFetchedAt < WA_WEB_VERSION_CACHE_MS) {
      return [...this.#waWebVersion];
    }

    const result = await fetchLatestWaWebVersion({
      signal: AbortSignal.timeout(WA_WEB_VERSION_FETCH_TIMEOUT_MS)
    });
    if (!result.isLatest || !isValidWaWebVersion(result.version)) {
      throw new Error("WhatsApp Web version is unavailable");
    }
    this.#waWebVersion = [...result.version];
    this.#waWebVersionFetchedAt = now;
    return [...this.#waWebVersion];
  }

  #socketConfig(version: WAVersion): UserFacingSocketConfig {
    return {
      auth: this.#config.auth,
      version,
      // Keep this a protocol browser identifier, not the product name: the
      // browser is embedded in the pairing QR as a WhatsApp companion type.
      browser: Browsers.macOS("Chrome"),
      logger: silentLogger,
      // Explicitly read-only behavior: no online presence, history pull, or
      // events generated by actions from this socket.
      markOnlineOnConnect: false,
      syncFullHistory: false,
      // Keep the initial/recent sync in memory so Baileys can emit real chat
      // metadata. Its messages are discarded by this adapter unless a user
      // explicitly starts a bounded on-demand import for one allowlisted chat.
      shouldSyncHistoryMessage: (historyMessage) => {
        const syncType = numberValue(historyMessage.syncType);
        return syncType !== undefined && (
          SAFE_CHAT_DISCOVERY_HISTORY_TYPES.has(syncType)
          || (syncType === ON_DEMAND_HISTORY_TYPE && this.#activeHistoryImport !== undefined)
        );
      },
      emitOwnEvents: false,
      fireInitQueries: false,
      qrTimeout: PERSONAL_PAIRING_QR_TIMEOUT_MS
    };
  }

  #subscribe(socket: LinkedDeviceSocket): void {
    const listeners: ListenerSet = {
      upsert: (event) => this.#handleUpsert(event),
      history: (event) => this.#handleHistory(event),
      update: (event) => this.#handleUpdate(event),
      deletion: (event) => this.#handleDelete(event),
      reaction: (event) => this.#handleReaction(event),
      chats: (event) => this.#publishAvailableChats(event),
      chatsUpdate: (event) => this.#publishAvailableChats(event),
      connection: (event) => this.#handleConnection(event),
      credentials: (update) => this.#queueCredentialWrite(update)
    };
    this.#listeners = listeners;

    socket.ev.on("messages.upsert", listeners.upsert);
    socket.ev.on("messaging-history.set", listeners.history);
    socket.ev.on("messages.update", listeners.update);
    socket.ev.on("messages.delete", listeners.deletion);
    socket.ev.on("messages.reaction", listeners.reaction);
    socket.ev.on("chats.upsert", listeners.chats);
    socket.ev.on("chats.update", listeners.chatsUpdate);
    socket.ev.on("connection.update", listeners.connection);
    socket.ev.on("creds.update", listeners.credentials);
  }

  #handleUpsert(event: BaileysEventMap["messages.upsert"]): void {
    // Baileys marks phone-resend deliveries with requestId. They are explicitly
    // dropped before application callbacks to avoid replaying unavailable data.
    if (event.requestId !== undefined) {
      return;
    }

    // The protocol notification is only a transport envelope for the history
    // sync. It is not a user chat message and must never enter persistence.
    if (event.messages.some((message) => isHistorySyncNotification(message))) {
      return;
    }

    const isHistorical = event.type === "append";
    if (isHistorical) {
      for (const message of event.messages) this.#rememberHistoryCursor(message);
      // Append records are automatic history/resend material. They remain
      // available only as ephemeral cursor observations; explicit imports are
      // consumed from the correlated messaging-history.set response below.
      return;
    }
    for (const message of event.messages) {
      const normalized = normalizeBaileysMessage(message, {
        eventType: "new",
        sourceEvent: "messages.upsert",
        source: "live_notify",
        isHistorical: false,
        upsertType: event.type,
        now: this.#now
      });
      this.#enqueue(normalized);
    }
  }

  #handleHistory(event: BaileysEventMap["messaging-history.set"]): void {
    this.#publishAvailableChats(event.chats);
    for (const message of event.messages) this.#rememberHistoryCursor(message);

    const active = this.#activeHistoryImport;
    if (active === undefined || numberValue(event.syncType) !== ON_DEMAND_HISTORY_TYPE) return;
    if (active.waiter === undefined) return;
    const eventSessionId = nonEmptyString(event.peerDataRequestSessionId);
    if (active.expectedSessionId === undefined) {
      active.pendingEvents.push(event);
      return;
    }
    if (eventSessionId !== undefined && eventSessionId !== active.expectedSessionId) return;
    this.#resolveHistoryPage(active, this.#historyPageFromEvent(active, event));
  }

  #handleUpdate(event: BaileysEventMap["messages.update"]): void {
    for (const update of event) {
      const message: WAMessage = { ...update.update, key: update.key };
      const normalized = normalizeBaileysMessage(message, {
        eventType: updateEventType(update.update),
        sourceEvent: "messages.update",
        source: "live_notify",
        isHistorical: false,
        allowObservedTimestamp: true,
        now: this.#now
      });
      this.#enqueue(normalized);
    }
  }

  #handleDelete(event: BaileysEventMap["messages.delete"]): void {
    if (!("keys" in event)) {
      // A chat-wide delete has no message ID and cannot be represented safely by
      // IncomingMessage's canonical identity contract.
      return;
    }

    for (const key of event.keys) {
      const message: WAMessage = { key };
      const normalized = normalizeBaileysMessage(message, {
        eventType: "delete",
        sourceEvent: "messages.delete",
        source: "live_notify",
        isHistorical: false,
        allowObservedTimestamp: true,
        now: this.#now,
        targetKey: key
      });
      this.#enqueue(normalized);
    }
  }

  #handleReaction(event: BaileysEventMap["messages.reaction"]): void {
    for (const item of event) {
      const normalized = normalizeBaileysReaction(item.key, item.reaction, this.#now);
      this.#enqueue(normalized);
    }
  }

  #publishAvailableChats(
    chats: readonly {
      readonly id?: string | null;
      readonly name?: string | null;
      readonly displayName?: string | null;
    }[]
  ): void {
    if (this.#config.onAvailableChats === undefined) return;
    const available: AvailableLinkedChat[] = [];
    for (const chat of chats) {
      const id = nonEmptyString(chat.id);
      if (id === undefined) continue;
      const label = nonEmptyString(chat.name) ?? nonEmptyString(chat.displayName);
      available.push({
        id,
        kind: id.endsWith("@g.us") ? "group" : "individual",
        ...(label === undefined ? {} : { label })
      });
    }
    try {
      this.#config.onAvailableChats(available);
    } catch {
      // Setup-list rendering cannot destabilize the receiving adapter.
    }
  }

  #rememberHistoryCursor(message: WAMessage): void {
    const identity = identityFromKey(message.key);
    const timestampSeconds = numberValue(message.messageTimestamp);
    if (identity === undefined || timestampSeconds === undefined || timestampSeconds < 0) return;
    const timestampMs = timestampSeconds * 1_000;
    if (!Number.isSafeInteger(timestampMs)) return;
    const current = this.#historyCursors.get(identity.chatId);
    if (current !== undefined && current.timestampMs <= timestampMs) return;
    this.#historyCursors.set(identity.chatId, {
      key: { ...message.key },
      timestampMs
    });
  }

  #historyPageFromEvent(
    active: ActiveHistoryImport,
    event: BaileysEventMap["messaging-history.set"]
  ): HistoryPage {
    const historySyncType = numberValue(event.syncType);
    const historyIsLatest = typeof event.isLatest === "boolean" ? event.isLatest : undefined;
    const matchingMessages: WAMessage[] = [];
    for (const message of event.messages) {
      const identity = identityFromKey(message.key);
      if (identity?.chatId !== active.targetChatId) continue;
      matchingMessages.push(message);
      const normalized = normalizeBaileysMessage(message, {
        eventType: "history",
        sourceEvent: "messaging-history.set",
        source: "history_sync",
        isHistorical: true,
        ...(historySyncType === undefined ? {} : { historySyncType }),
        ...(historyIsLatest === undefined ? {} : { historyIsLatest }),
        now: this.#now
      });
      this.#acceptHistoricalMessage(active, message, normalized);
    }

    const cursor = oldestCursor(matchingMessages);
    const complete = event.chats.some((chat) => {
      if (chat.id !== active.targetChatId) return false;
      return chat.endOfHistoryTransfer === true
        || chat.endOfHistoryTransferType === COMPLETE_AND_NO_MORE_MESSAGES;
    });
    return { messages: matchingMessages, ...(cursor === undefined ? {} : { cursor }), complete };
  }

  #acceptHistoricalMessage(
    active: ActiveHistoryImport,
    sourceMessage: WAMessage,
    normalized: NormalizedIncomingMessage | undefined
  ): void {
    if (normalized === undefined) return;
    const timestampMs = Date.parse(normalized.message.timestamp);
    if (!withinHistoryBounds(timestampMs, active.request)) return;
    const identity = identityFromKey(sourceMessage.key);
    if (identity === undefined) return;
    const dedupeKey = [identity.chatId, identity.messageId, identity.senderId, identity.fromMe ? "1" : "0"].join("\u0000");
    if (active.seenMessageKeys.has(dedupeKey)) {
      active.deduplicated += 1;
      return;
    }
    if (active.imported >= (active.request.maxMessages ?? MAX_HISTORY_MESSAGES)) return;
    active.seenMessageKeys.add(dedupeKey);
    active.imported += 1;
    this.#enqueue(normalized);
  }

  #waitForHistoryPage(active: ActiveHistoryImport): Promise<HistoryPage | undefined> {
    const timeoutMs = boundedHistoryTimeout(this.#config.historyResponseTimeoutMs);
    return new Promise<HistoryPage | undefined>((resolve) => {
      const timer = setTimeout(() => {
        if (active.waiter?.resolve !== resolve) return;
        active.waiter = undefined;
        resolve(undefined);
      }, timeoutMs);
      active.waiter = { resolve, timer };
    });
  }

  #cancelHistoryPageWait(active: ActiveHistoryImport): void {
    const waiter = active.waiter;
    if (waiter === undefined) return;
    clearTimeout(waiter.timer);
    active.waiter = undefined;
    waiter.resolve(undefined);
  }

  #resolveHistoryPage(active: ActiveHistoryImport, page: HistoryPage): void {
    const waiter = active.waiter;
    if (waiter === undefined) return;
    clearTimeout(waiter.timer);
    active.waiter = undefined;
    waiter.resolve(page);
  }

  #flushPendingHistoryEvents(active: ActiveHistoryImport): void {
    if (active.expectedSessionId === undefined || active.waiter === undefined) return;
    const pending = active.pendingEvents.splice(0);
    for (const event of pending) {
      const eventSessionId = nonEmptyString(event.peerDataRequestSessionId);
      if (eventSessionId !== undefined && eventSessionId !== active.expectedSessionId) continue;
      this.#resolveHistoryPage(active, this.#historyPageFromEvent(active, event));
      if (active.waiter === undefined) break;
    }
  }

  #handleConnection(event: BaileysEventMap["connection.update"]): void {
    if (event.qr !== undefined) {
      try {
        this.#config.onPairingQr?.(event.qr);
      } catch {
        // Pairing-display callbacks are presentation-only and cannot affect the socket.
      }
    }
    // A closed socket cannot be reused. Clear it before notifying the runtime
    // so an explicitly gated reconnect can create a fresh socket instead of
    // receiving `already_started` from stale state.
    if (event.connection === "close") this.#detachClosedSocket();

    // A connection-open event is a safe point for a metadata-only resync. It
    // does not enable ingestion and the result remains ephemeral until the
    // user explicitly adds a chat to the allowlist.
    if (event.connection === "open") void this.refreshAvailableChats();

    if (this.#config.onConnectionStatus === undefined) return;
    const disconnectStatusCode = event.connection === "close"
      ? optionalDisconnectStatusCode(event.lastDisconnect?.error)
      : undefined;
    const status: LinkedDeviceConnectionStatus = {
      ...(event.connection === undefined ? {} : { connection: event.connection }),
      ...(disconnectStatusCode === undefined ? {} : { disconnectStatusCode }),
      ...(event.isNewLogin === undefined ? {} : { isNewLogin: event.isNewLogin }),
      ...(event.receivedPendingNotifications === undefined
        ? {}
        : { receivedPendingNotifications: event.receivedPendingNotifications }),
      hasPairingQr: event.qr !== undefined
    };
    try {
      this.#config.onConnectionStatus(status);
    } catch {
      // Consumer-owned presentation callbacks must not destabilize the socket.
    }
  }

  /** Detach a socket that Baileys has already closed; do not issue account actions. */
  #detachClosedSocket(): void {
    const socket = this.#socket;
    const listeners = this.#listeners;
    this.#socket = undefined;
    this.#listeners = undefined;
    if (this.#activeHistoryImport !== undefined) {
      this.#cancelHistoryPageWait(this.#activeHistoryImport);
      this.#activeHistoryImport = undefined;
    }
    this.#historyCursors.clear();
    if (socket === undefined || listeners === undefined) return;
    socket.ev.off("messages.upsert", listeners.upsert);
    socket.ev.off("messaging-history.set", listeners.history);
    socket.ev.off("messages.update", listeners.update);
    socket.ev.off("messages.delete", listeners.deletion);
    socket.ev.off("messages.reaction", listeners.reaction);
    socket.ev.off("chats.upsert", listeners.chats);
    socket.ev.off("chats.update", listeners.chatsUpdate);
    socket.ev.off("connection.update", listeners.connection);
    socket.ev.off("creds.update", listeners.credentials);
  }

  #queueCredentialWrite(update: Partial<AuthenticationCreds>): void {
    const saveAuthState = this.#config.saveAuthState;
    if (saveAuthState === undefined) {
      return;
    }

    this.#credentialWrites = this.#credentialWrites.then(async () => {
      try {
        await saveAuthState(update);
      } catch {
        this.#reportError({ code: "credentials_persist_failed" });
      }
    });
  }

  #enqueue(normalized: NormalizedIncomingMessage | undefined): void {
    if (normalized === undefined) {
      return;
    }

    this.#deliveries = this.#deliveries.then(async () => {
      try {
        await this.#config.onIncomingMessage(normalized.message, normalized.context);
      } catch {
        this.#reportError({
          code: "incoming_handler_failed",
          eventType: normalized.context.eventType
        });
      }
    });
  }

  #reportError(error: AdapterError): void {
    try {
      this.#config.onAdapterError?.(error);
    } catch {
      // Error reporting is intentionally best-effort and must never leak data.
    }
  }

  #now = (): Date => this.#config.now?.() ?? new Date();
}

/** Normalizes Baileys' separate reaction event without inventing a message ID. */
export function normalizeBaileysReaction(
  targetKey: WAMessageKey,
  reaction: proto.IReaction,
  now: () => Date = () => new Date()
): NormalizedIncomingMessage | undefined {
  const sourceKey = reaction.key;
  if (sourceKey === null || sourceKey === undefined) {
    return undefined;
  }
  const identity = identityFromKey(sourceKey);
  if (identity === undefined) {
    return undefined;
  }

  const sourceTimestamp = millisecondsToIso(reaction.senderTimestampMs);
  const timestamp: TimestampResult = sourceTimestamp === undefined
    ? observedTimestamp(now)
    : { timestamp: sourceTimestamp, provenance: "source" };
  const emoji = nonEmptyString(reaction.text);
  const reactionMetadata: ReactionMetadata = emoji === undefined
    ? { removed: true }
    : { emoji, removed: false };
  const target = targetContext(targetKey);

  const message: IncomingMessage = {
    messageId: identity.messageId,
    chatId: identity.chatId,
    senderId: identity.senderId,
    fromMe: identity.fromMe,
    timestamp: timestamp.timestamp,
    source: "live_notify",
    kind: "reaction",
    ...(emoji === undefined ? {} : { text: emoji }),
    ...(target.targetMessageId === undefined ? {} : { quotedMessageId: target.targetMessageId })
  };
  const context: AdapterMessageContext = {
    transport: "personal_linked_device",
    eventType: "reaction",
    sourceEvent: "messages.reaction",
    isHistorical: false,
    timestampProvenance: timestamp.provenance,
    ...target,
    reaction: reactionMetadata
  };

  return { message, context };
}

function resolveEventType(
  content: WAMessage["message"],
  requested: AdapterMessageEventType
): AdapterMessageEventType {
  if (requested === "delete" || requested === "reaction" || requested === "edit") {
    return requested;
  }
  const protocolType = content?.protocolMessage?.type;
  if (protocolType === proto.Message.ProtocolMessage.Type.REVOKE) {
    return "delete";
  }
  if (
    protocolType === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT
    || (content?.editedMessage !== undefined && content.editedMessage !== null)
  ) {
    return "edit";
  }
  if (content?.reactionMessage !== undefined && content.reactionMessage !== null) {
    return "reaction";
  }
  return requested;
}

function normalizeBaileysContent(content: WAMessage["message"]): BaileysContent {
  const extracted = safelyExtractContent(content);
  if (extracted === undefined) {
    return { kind: "unknown" };
  }

  if (typeof extracted.conversation === "string") {
    return { kind: "text", text: extracted.conversation };
  }
  if (typeof extracted.extendedTextMessage?.text === "string") {
    return withQuotedMessage({ kind: "text", text: extracted.extendedTextMessage.text }, extracted);
  }
  if (extracted.audioMessage !== undefined && extracted.audioMessage !== null) {
    return withQuotedMessage({
      kind: extracted.audioMessage.ptt === true ? "voice" : "audio",
      media: mediaFromContent(extracted.audioMessage)
    }, extracted);
  }
  if (extracted.imageMessage !== undefined && extracted.imageMessage !== null) {
    return mediaMessageContent("image", extracted.imageMessage, extracted.imageMessage.caption, extracted);
  }
  if (extracted.documentMessage !== undefined && extracted.documentMessage !== null) {
    return mediaMessageContent("document", extracted.documentMessage, extracted.documentMessage.caption, extracted);
  }
  if (extracted.videoMessage !== undefined && extracted.videoMessage !== null) {
    return mediaMessageContent("video", extracted.videoMessage, extracted.videoMessage.caption, extracted);
  }
  if (extracted.stickerMessage !== undefined && extracted.stickerMessage !== null) {
    return mediaMessageContent("sticker", extracted.stickerMessage, undefined, extracted);
  }
  if (extracted.locationMessage !== undefined && extracted.locationMessage !== null) {
    return withQuotedMessage({ kind: "location" }, extracted);
  }
  if (
    (extracted.contactMessage !== undefined && extracted.contactMessage !== null)
    || (extracted.contactsArrayMessage !== undefined && extracted.contactsArrayMessage !== null)
  ) {
    return withQuotedMessage({ kind: "contact" }, extracted);
  }
  if (
    (extracted.pollCreationMessage !== undefined && extracted.pollCreationMessage !== null)
    || (extracted.pollCreationMessageV2 !== undefined && extracted.pollCreationMessageV2 !== null)
    || (extracted.pollCreationMessageV3 !== undefined && extracted.pollCreationMessageV3 !== null)
    || (extracted.pollCreationMessageV4 !== undefined && extracted.pollCreationMessageV4 !== null)
    || (extracted.pollCreationMessageV5 !== undefined && extracted.pollCreationMessageV5 !== null)
  ) {
    return withQuotedMessage({ kind: "poll" }, extracted);
  }
  if (extracted.reactionMessage !== undefined && extracted.reactionMessage !== null) {
    const emoji = nonEmptyString(extracted.reactionMessage.text);
    const reaction: ReactionMetadata = emoji === undefined
      ? { removed: true }
      : { emoji, removed: false };
    return {
      kind: "reaction",
      ...(emoji === undefined ? {} : { text: emoji }),
      ...(extracted.reactionMessage.key === undefined || extracted.reactionMessage.key === null
        ? {}
        : { reactionTargetKey: extracted.reactionMessage.key }),
      reaction
    };
  }

  return withQuotedMessage({ kind: "unknown" }, extracted);
}

function mediaMessageContent(
  kind: MessageKind,
  media: { mimetype?: string | null; seconds?: number | null },
  caption: string | null | undefined,
  content: NonNullable<WAMessage["message"]>
): BaileysContent {
  const quotedMessageId = quotedFromContent(content);
  return {
    kind,
    media: mediaFromContent(media),
    ...(typeof caption === "string" ? { text: caption } : {}),
    ...(quotedMessageId === undefined ? {} : { quotedMessageId })
  };
}

function withQuotedMessage(
  content: Omit<BaileysContent, "quotedMessageId">,
  rawContent: NonNullable<WAMessage["message"]>
): BaileysContent {
  const quotedMessageId = quotedFromContent(rawContent);
  return {
    ...content,
    ...(quotedMessageId === undefined ? {} : { quotedMessageId })
  };
}

function mediaFromContent(media: {
  mimetype?: string | null;
  seconds?: number | null;
}): IncomingMedia {
  const mimeType = nonEmptyString(media.mimetype);
  const durationSeconds = nonNegativeFiniteNumber(media.seconds);
  return {
    ...(mimeType === undefined ? {} : { mimeType }),
    ...(durationSeconds === undefined ? {} : { durationSeconds })
  };
}

function quotedFromContent(content: NonNullable<WAMessage["message"]>): string | undefined {
  const contexts = [
    content.extendedTextMessage?.contextInfo,
    content.audioMessage?.contextInfo,
    content.imageMessage?.contextInfo,
    content.documentMessage?.contextInfo,
    content.videoMessage?.contextInfo,
    content.stickerMessage?.contextInfo,
    content.locationMessage?.contextInfo,
    content.contactMessage?.contextInfo,
    content.contactsArrayMessage?.contextInfo
  ];
  for (const context of contexts) {
    const stanzaId = nonEmptyString(context?.stanzaId);
    if (stanzaId !== undefined) {
      return stanzaId;
    }
  }
  return undefined;
}

function reactionTargetKey(content: WAMessage["message"]): LinkedDeviceMessageKey | undefined {
  const target = content?.reactionMessage?.key;
  return target === undefined || target === null ? undefined : target;
}

function safelyExtractContent(
  content: WAMessage["message"]
): NonNullable<WAMessage["message"]> | undefined {
  try {
    return extractMessageContent(content) ?? undefined;
  } catch {
    return undefined;
  }
}

function updateEventType(update: Partial<WAMessage>): AdapterMessageEventType {
  if (update.message === null) {
    return "delete";
  }
  return resolveEventType(update.message, "upsert");
}

function identityFromKey(key: LinkedDeviceMessageKey): MessageIdentity | undefined {
  const messageId = nonEmptyString(key.id);
  const chatId = nonEmptyString(key.remoteJid) ?? nonEmptyString(key.remoteJidAlt);
  const senderId = nonEmptyString(key.participant)
    ?? nonEmptyString(key.participantAlt)
    ?? chatId;
  if (messageId === undefined || chatId === undefined || senderId === undefined) {
    return undefined;
  }
  return {
    messageId,
    chatId,
    senderId,
    fromMe: key.fromMe === true
  };
}

function targetContext(key: LinkedDeviceMessageKey | undefined): {
  readonly targetMessageId?: string;
  readonly targetChatId?: string;
  readonly targetSenderId?: string;
} {
  if (key === undefined) {
    return {};
  }
  const messageId = nonEmptyString(key.id);
  const chatId = nonEmptyString(key.remoteJid) ?? nonEmptyString(key.remoteJidAlt);
  const senderId = nonEmptyString(key.participant)
    ?? nonEmptyString(key.participantAlt)
    ?? chatId;
  return {
    ...(messageId === undefined ? {} : { targetMessageId: messageId }),
    ...(chatId === undefined ? {} : { targetChatId: chatId }),
    ...(senderId === undefined ? {} : { targetSenderId: senderId })
  };
}

function mergeKeys(
  target: LinkedDeviceMessageKey,
  fallback: LinkedDeviceMessageKey
): LinkedDeviceMessageKey {
  return {
    ...(target.remoteJid ?? fallback.remoteJid) === undefined
      ? {}
      : { remoteJid: target.remoteJid ?? fallback.remoteJid },
    ...(target.remoteJidAlt ?? fallback.remoteJidAlt) === undefined
      ? {}
      : { remoteJidAlt: target.remoteJidAlt ?? fallback.remoteJidAlt },
    ...(target.participant ?? fallback.participant) === undefined
      ? {}
      : { participant: target.participant ?? fallback.participant },
    ...(target.participantAlt ?? fallback.participantAlt) === undefined
      ? {}
      : { participantAlt: target.participantAlt ?? fallback.participantAlt },
    ...(target.id ?? fallback.id) === undefined
      ? {}
      : { id: target.id ?? fallback.id },
    ...(target.fromMe ?? fallback.fromMe) === undefined
      ? {}
      : { fromMe: target.fromMe ?? fallback.fromMe }
  };
}

function timestampFor(
  value: unknown,
  allowObservedTimestamp: boolean,
  now: (() => Date) | undefined
): TimestampResult | undefined {
  const sourceTimestamp = secondsToIso(value);
  if (sourceTimestamp !== undefined) {
    return { timestamp: sourceTimestamp, provenance: "source" };
  }
  return allowObservedTimestamp ? observedTimestamp(now ?? (() => new Date())) : undefined;
}

function observedTimestamp(now: () => Date): TimestampResult {
  const date = now();
  return {
    timestamp: Number.isNaN(date.valueOf()) ? new Date(0).toISOString() : date.toISOString(),
    provenance: "observed"
  };
}

function secondsToIso(value: unknown): string | undefined {
  const seconds = numberValue(value);
  if (seconds === undefined || seconds < 0) {
    return undefined;
  }
  const date = new Date(seconds * 1_000);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function millisecondsToIso(value: unknown): string | undefined {
  const milliseconds = numberValue(value);
  if (milliseconds === undefined || milliseconds < 0) {
    return undefined;
  }
  const date = new Date(milliseconds);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (typeof value === "object" && value !== null && "toNumber" in value) {
    const toNumber = value.toNumber;
    if (typeof toNumber === "function") {
      try {
        const parsed = toNumber.call(value);
        return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function validateHistoryImportRequest(request: PersonalHistoryImportRequest): { valid: boolean } {
  if (typeof request.chatId !== "string" || request.chatId.trim().length < 3 || request.chatId.length > 256) {
    return { valid: false };
  }
  if (request.maxMessages === undefined && request.since === undefined && request.until === undefined) {
    return { valid: false };
  }
  if (
    request.maxMessages !== undefined
    && (!Number.isSafeInteger(request.maxMessages) || request.maxMessages < 1 || request.maxMessages > MAX_HISTORY_MESSAGES)
  ) {
    return { valid: false };
  }
  const since = request.since === undefined ? undefined : Date.parse(request.since);
  const until = request.until === undefined ? undefined : Date.parse(request.until);
  if (request.since !== undefined && !Number.isFinite(since)) return { valid: false };
  if (request.until !== undefined && !Number.isFinite(until)) return { valid: false };
  if (since !== undefined && until !== undefined && since > until) return { valid: false };
  return { valid: true };
}

function withinHistoryBounds(timestampMs: number, request: PersonalHistoryImportRequest): boolean {
  if (!Number.isFinite(timestampMs)) return false;
  const since = request.since === undefined ? undefined : Date.parse(request.since);
  const until = request.until === undefined ? undefined : Date.parse(request.until);
  if (since !== undefined && timestampMs < since) return false;
  if (until !== undefined && timestampMs > until) return false;
  return true;
}

function unavailableHistoryResult(
  chatId: string,
  reason: "history_api_unavailable" | "history_cursor_unavailable"
): PersonalHistoryImportResult {
  return {
    status: "unavailable",
    chatId,
    imported: 0,
    deduplicated: 0,
    pages: 0,
    reason,
    manualExportAlternative: true
  };
}

function boundedHistoryTimeout(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || value === undefined) return DEFAULT_HISTORY_RESPONSE_TIMEOUT_MS;
  return Math.max(10, Math.min(60_000, value));
}

function oldestCursor(messages: readonly WAMessage[]): HistoryCursor | undefined {
  let oldest: HistoryCursor | undefined;
  for (const message of messages) {
    const identity = identityFromKey(message.key);
    const timestampSeconds = numberValue(message.messageTimestamp);
    if (identity === undefined || timestampSeconds === undefined || timestampSeconds < 0) continue;
    const timestampMs = timestampSeconds * 1_000;
    if (!Number.isSafeInteger(timestampMs)) continue;
    if (oldest === undefined || timestampMs < oldest.timestampMs) {
      oldest = { key: { ...message.key }, timestampMs };
    }
  }
  return oldest;
}

function sameHistoryCursor(left: HistoryCursor, right: HistoryCursor): boolean {
  return left.timestampMs === right.timestampMs
    && left.key.remoteJid === right.key.remoteJid
    && left.key.remoteJidAlt === right.key.remoteJidAlt
    && left.key.participant === right.key.participant
    && left.key.participantAlt === right.key.participantAlt
    && left.key.id === right.key.id
    && left.key.fromMe === right.key.fromMe;
}

function isHistorySyncNotification(message: WAMessage): boolean {
  const protocol = message.message?.protocolMessage;
  return protocol?.type === proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION
    || protocol?.historySyncNotification !== undefined && protocol.historySyncNotification !== null;
}

function nonNegativeFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isValidWaWebVersion(value: unknown): value is WAVersion {
  return Array.isArray(value)
    && value.length === 3
    && value.every((part) => Number.isSafeInteger(part) && part >= 0);
}

function optionalDisconnectStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("output" in error)) return undefined;
  const output = error.output;
  if (typeof output !== "object" || output === null || !("statusCode" in output)) return undefined;
  const statusCode = output.statusCode;
  return typeof statusCode === "number"
    && Number.isSafeInteger(statusCode)
    && statusCode >= 100
    && statusCode <= 599
    ? statusCode
    : undefined;
}
