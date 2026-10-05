import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { RuntimeConfig } from "../config.js";
import { evaluateLiveGate, evaluatePersonalConnectionGate } from "../config.js";
import type { HealthSnapshot } from "../domain/types.js";
import { ChatPipeline } from "../ingest/chat-pipeline.js";
import { MacOSNotificationAdapter } from "../notifications/notification-adapter.js";
import { ReminderService } from "../notifications/reminder-service.js";
import { FieldEncryptor } from "../security/crypto.js";
import { JsonSafeLogger, type SafeLogger } from "../security/logger.js";
import { SqliteMessageStore } from "../storage/sqlite-store.js";
import { EncryptedMediaStore } from "../storage/encrypted-media-store.js";
import { FixtureLocalTranscriber, type LocalTranscriber } from "../transcription/local-transcriber.js";
import type { NotificationAdapter } from "../notifications/notification-adapter.js";
import { EncryptedAuthState } from "../adapters/encrypted-auth-state.js";
import {
  ChatSummaryProviderError,
  OpenAIChatSummaryProvider,
  type ChatConversationSummary,
  type ChatSummaryProvider,
  type ModelChatSummary,
  type SummarySourceMessage
} from "../summary/openai-chat-summary.js";
import {
  ChatExportImportError,
  readLocalChatExportFile,
  type ChatExportDateOrder,
  type ChatExportParseStats
} from "../adapters/chat-export.js";
import {
  PersonalLinkedDeviceAdapter,
  type AvailableChatsRefreshResult,
  type AvailableLinkedChat,
  type PersonalHistoryImportRequest as AdapterHistoryImportRequest,
  type PersonalHistoryImportResult,
  type PersonalLinkedDeviceAdapterConfig,
  type PersonalLinkedDeviceStartResult
} from "../adapters/personal-linked-device.js";

export interface ApplicationDependencies {
  notificationAdapter?: NotificationAdapter;
  transcriber?: LocalTranscriber;
  logger?: SafeLogger;
  /** Test seam; production uses the pinned Baileys-backed adapter. */
  personalAdapterFactory?: (config: PersonalLinkedDeviceAdapterConfig) => PersonalLinkedDeviceAdapter;
  /** Test seam; production uses the OpenAI Responses API when explicitly enabled. */
  chatSummaryProvider?: ChatSummaryProvider;
}

export class ChatSummaryError extends Error {
  public constructor(
    public readonly code:
      | "chat_summary_disabled"
      | "chat_summary_api_key_missing"
      | "chat_summary_persistent_key_missing"
      | "chat_summary_kill_switch"
      | "chat_summary_chat_not_allowlisted"
      | "chat_summary_limit_invalid"
      | "chat_summary_in_progress"
      | "chat_summary_no_text"
      | "chat_summary_provider_failed"
  ) {
    super(code);
    this.name = "ChatSummaryError";
  }
}

export interface ChatExportImportRequest {
  /** Absolute path to one user-selected local UTF-8 .txt export. */
  readonly filePath: string;
  /** Must already be present in the explicit allowlist; imports never add chats. */
  readonly chatId: string;
  /** Optional exact export label for messages sent by the account owner. */
  readonly ownSenderLabel?: string;
  /** Resolves otherwise ambiguous numeric export dates only when chosen explicitly. */
  readonly dateOrder?: ChatExportDateOrder;
}

export interface ChatExportImportResult {
  readonly imported: number;
  readonly deduplicated: number;
  readonly rejected: number;
  readonly stats: ChatExportParseStats;
}

export interface PersonalHistoryImportRequest {
  readonly chatId: string;
  /** The dashboard confirmation is intentionally explicit and non-defaultable. */
  readonly confirmed: boolean;
  readonly maxMessages?: number;
  readonly since?: string;
  readonly until?: string;
}

export class PersonalHistoryImportError extends Error {
  public constructor(
    public readonly code:
      | "history_confirmation_required"
      | "history_chat_not_allowlisted"
      | "history_live_gate_blocked"
      | "history_bound_required"
      | "history_adapter_not_connected"
      | "history_import_in_progress"
  ) {
    super(code);
    this.name = "PersonalHistoryImportError";
  }
}

/**
 * Ephemeral pairing presentation state. `qr` is sensitive setup material and
 * is intentionally exposed only to the loopback dashboard route; callers must
 * never persist or log it. The timestamps describe local receipt, not a
 * WhatsApp-issued validity guarantee.
 */
export type PairingPresentationState =
  | "not_started"
  | "awaiting_qr"
  | "finishing_login"
  | "connected"
  | "reconnecting";

export interface PairingQrSnapshot {
  readonly qr: string | undefined;
  readonly issuedAt: string | undefined;
  readonly generation: number;
  /** A same-reference security refresh invalidated the image currently shown. */
  readonly requiresImmediateDisplay: boolean;
  /** Safe lifecycle state for the loopback setup presentation. */
  readonly state: PairingPresentationState;
}

function pairingQrReference(qr: string | undefined): string | undefined {
  if (qr === undefined) return undefined;
  const fragmentStart = qr.indexOf("#");
  if (fragmentStart < 0) return undefined;
  const referenceEnd = qr.indexOf(",", fragmentStart + 1);
  if (referenceEnd < 0) return undefined;
  const reference = qr.slice(fragmentStart + 1, referenceEnd);
  return reference.length > 0 ? reference : undefined;
}

export class ChatIntelligenceApplication {
  public readonly store: SqliteMessageStore;
  public readonly mediaStore: EncryptedMediaStore;
  public readonly pipeline: ChatPipeline;
  public readonly logger: SafeLogger;
  private readonly encryptor: FieldEncryptor;
  private lastIngestAt: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private personalAdapter: PersonalLinkedDeviceAdapter | undefined;
  private personalAuthState: EncryptedAuthState | undefined;
  private readonly personalAdapterFactory: (config: PersonalLinkedDeviceAdapterConfig) => PersonalLinkedDeviceAdapter;
  private readonly chatSummaryProvider: ChatSummaryProvider | undefined;
  private readonly summaryChatsInFlight = new Set<string>();
  private personalReconnectTimer: NodeJS.Timeout | undefined;
  private personalLoginRestartInFlight: Promise<void> | undefined;
  private personalReconnectAttempts = 0;
  private shuttingDown = false;
  private lastErrorCode: string | undefined;
  private lastConnectionFailureCode: number | undefined;
  private pairingQr: string | undefined;
  private pairingQrIssuedAt: Date | undefined;
  private pairingQrGeneration = 0;
  private pairingQrRequiresImmediateDisplay = false;
  private pairingPresentationState: PairingPresentationState = "not_started";
  private readonly availableChats = new Map<string, AvailableLinkedChat>();
  private personalHistoryImportChatId: string | undefined;
  private personalHistoryImportInFlight = false;

  public constructor(
    public readonly config: RuntimeConfig,
    dependencies: ApplicationDependencies = {}
  ) {
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    mkdirSync(config.mediaDir, { recursive: true, mode: 0o700 });
    mkdirSync(config.sessionDir, { recursive: true, mode: 0o700 });
    this.logger = dependencies.logger ?? new JsonSafeLogger();
    this.personalAdapterFactory = dependencies.personalAdapterFactory ?? ((options) => new PersonalLinkedDeviceAdapter(options));
    this.chatSummaryProvider = dependencies.chatSummaryProvider ?? (config.openAiApiKey
      ? new OpenAIChatSummaryProvider(config.openAiApiKey, config.openAiSummaryModel)
      : undefined);
    this.encryptor = new FieldEncryptor(config.encryptionKeyBase64);
    this.store = new SqliteMessageStore(config.databasePath, this.encryptor);
    this.mediaStore = new EncryptedMediaStore(config.mediaDir, this.encryptor);
    this.store.initialize();
    const notificationAdapter = dependencies.notificationAdapter ?? new MacOSNotificationAdapter();
    this.pipeline = new ChatPipeline(
      this.store,
      this.mediaStore,
      dependencies.transcriber ?? new FixtureLocalTranscriber(),
      new ReminderService(
        this.store,
        notificationAdapter,
        config.reminderLeadMinutes,
        this.logger,
        (code) => { this.lastErrorCode = code; }
      ),
      this.logger,
      { timezone: config.timezone, killSwitch: config.killSwitch, maxMediaBytes: config.maxMediaBytes }
    );
  }

  public markIngested(): void {
    this.lastIngestAt = new Date().toISOString();
  }

  public health(): HealthSnapshot {
    const liveGate = evaluateLiveGate(this.config, this.store.countAllowlistedChats());
    const liveConnectionExpected = liveGate.allowed && this.personalAdapter !== undefined;
    // A gate denial is a snapshot of an earlier configuration state, not an
    // operational error after the user completes the missing confirmation or
    // selects a chat. Keeping it as lastErrorCode would leave a healthy,
    // connected live worker permanently marked degraded.
    const currentErrorCode = this.lastErrorCode === "live_gate_blocked" && liveGate.allowed
      ? undefined
      : this.lastErrorCode;
    const snapshot: HealthSnapshot = {
      status: this.config.killSwitch
        ? "blocked"
        : currentErrorCode || (liveConnectionExpected && !this.personalAdapter?.isConnected)
          ? "degraded"
          : "ready",
      adapter: this.personalAdapter ? "personal_linked_device" : "synthetic",
      liveImportEnabled: liveGate.allowed,
      allowlistedChatCount: this.store.countAllowlistedChats()
    };
    if (this.lastIngestAt) snapshot.lastIngestAt = this.lastIngestAt;
    if (this.lastConnectionFailureCode !== undefined) {
      snapshot.lastConnectionFailureCode = this.lastConnectionFailureCode;
    }
    if (!liveGate.allowed) snapshot.liveGateReasons = liveGate.reasons;
    if (currentErrorCode) snapshot.lastErrorCode = currentErrorCode;
    else if (!liveGate.allowed && this.config.liveImportEnabled) snapshot.lastErrorCode = "live_gate_blocked";
    return snapshot;
  }

  /** Safe dashboard status; never returns the configured API key. */
  public chatSummaryStatus(): { available: boolean; model: string; reason?: "disabled" | "api_key_missing" | "persistent_key_missing" } {
    if (!this.config.openAiSummariesEnabled) {
      return { available: false, model: this.config.openAiSummaryModel, reason: "disabled" };
    }
    if (this.config.encryptionKeyIsEphemeral) {
      return { available: false, model: this.config.openAiSummaryModel, reason: "persistent_key_missing" };
    }
    if (!this.chatSummaryProvider) {
      return { available: false, model: this.config.openAiSummaryModel, reason: "api_key_missing" };
    }
    return { available: true, model: this.config.openAiSummaryModel };
  }

  /** Returns only the latest encrypted OpenAI snapshot for an allowed chat. */
  public getLatestChatSummary(chatId: string): ReturnType<SqliteMessageStore["getLatestSummarySnapshot"]> {
    if (!this.store.isAllowlisted(chatId)) throw new ChatSummaryError("chat_summary_chat_not_allowlisted");
    return this.store.getLatestSummarySnapshot(chatId);
  }

  /**
   * Summarizes a bounded, explicitly allowlisted chat after the dashboard
   * confirms the external API transfer. Only stored text and transcripts are
   * selected; raw media and sender identifiers never leave this process.
   */
  public async summarizeChat(chatId: string, maxMessages = 100): Promise<{ id: string; summary: ChatConversationSummary }> {
    if (!this.store.isAllowlisted(chatId)) throw new ChatSummaryError("chat_summary_chat_not_allowlisted");
    if (this.config.killSwitch) throw new ChatSummaryError("chat_summary_kill_switch");
    if (!this.config.openAiSummariesEnabled) throw new ChatSummaryError("chat_summary_disabled");
    if (this.config.encryptionKeyIsEphemeral) throw new ChatSummaryError("chat_summary_persistent_key_missing");
    if (!this.chatSummaryProvider) throw new ChatSummaryError("chat_summary_api_key_missing");
    if (!Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > 500) {
      throw new ChatSummaryError("chat_summary_limit_invalid");
    }
    if (this.summaryChatsInFlight.has(chatId)) throw new ChatSummaryError("chat_summary_in_progress");

    this.summaryChatsInFlight.add(chatId);
    try {
      const stored = this.store.listMessagesForSummary(chatId, maxMessages);
      const selected: SummarySourceMessage[] = [];
      let characterCount = 0;
      let truncatedCount = 0;
      let inputBudgetOmitted = 0;
      let uncertainTranscriptCount = 0;
      const newestFirst = [...stored.messages].reverse();
      for (let index = 0; index < newestFirst.length; index += 1) {
        const message = newestFirst[index]!;
        const original = message.content?.trim();
        if (!original) continue;
        const content = original.length > 8_000 ? original.slice(-8_000) : original;
        if (characterCount + content.length > 100_000) {
          inputBudgetOmitted = newestFirst.slice(index).filter((item) => Boolean(item.content?.trim())).length;
          break;
        }
        if (content.length !== original.length) truncatedCount += 1;
        characterCount += content.length;
        if (message.transcriptStatus === "uncertain") uncertainTranscriptCount += 1;
        selected.push({
          canonicalId: message.canonicalId,
          occurredAt: message.occurredAt,
          fromMe: message.fromMe,
          kind: message.kind as SummarySourceMessage["kind"],
          content,
          ...(message.transcriptStatus === undefined ? {} : { transcriptStatus: message.transcriptStatus })
        });
      }
      selected.reverse();
      if (selected.length === 0) throw new ChatSummaryError("chat_summary_no_text");

      let modelSummary: ModelChatSummary;
      if (!this.store.isAllowlisted(chatId)) throw new ChatSummaryError("chat_summary_chat_not_allowlisted");
      try {
        modelSummary = await this.chatSummaryProvider.summarize(selected);
      } catch (error) {
        const code = error instanceof ChatSummaryProviderError ? error.code : "provider_error";
        this.logger.write({ level: "warn", event: "openai_chat_summary_failed", metadata: { code } });
        throw new ChatSummaryError("chat_summary_provider_failed");
      }

      if (!this.store.isAllowlisted(chatId)) throw new ChatSummaryError("chat_summary_chat_not_allowlisted");

      const appointments = this.store.listEvents(chatId)
        .filter((event) => event.status !== "superseded")
        .filter((event) => event.sourceMessageIds.length > 0
          && event.sourceMessageIds.every((id) => {
            const source = this.store.getMessage(id);
            return source !== undefined && source.deletedAt === undefined;
          }))
        .map((event) => ({
          id: event.id,
          title: event.title,
          ...(event.startsAt === undefined ? {} : { startsAt: event.startsAt }),
          status: event.status,
          confidence: event.confidence,
          sourceMessageIds: event.sourceMessageIds
        }));
      const sourceMessageIds = [...new Set([
        ...selected.map((message) => message.canonicalId),
        ...appointments.flatMap((event) => event.sourceMessageIds)
      ])];
      const dataGaps: string[] = [];
      if (stored.totalCount > maxMessages) dataGaps.push(`Es wurden nur die neuesten ${maxMessages} von ${stored.totalCount} gespeicherten Nachrichten betrachtet.`);
      const withoutText = stored.messages.filter((message) => !message.content?.trim()).length;
      if (withoutText > 0) dataGaps.push(`${withoutText} ausgewählte Nachrichten hatten keinen gespeicherten Text oder kein verfügbares Transkript.`);
      if (inputBudgetOmitted > 0) {
        dataGaps.push("Ein Teil der Nachrichten wurde wegen des begrenzten API-Eingabefensters ausgelassen.");
      }
      if (truncatedCount > 0) dataGaps.push(`${truncatedCount} lange Nachricht(en) wurden für diese Anfrage gekürzt.`);
      if (uncertainTranscriptCount > 0) dataGaps.push(`${uncertainTranscriptCount} unsichere Transkription(en) sind als unsicher markiert.`);

      const summary: ChatConversationSummary = {
        ...modelSummary,
        appointments,
        dataGaps,
        sourceMessageIds,
        includedMessageCount: selected.length,
        omittedMessageCount: Math.max(0, stored.totalCount - selected.length),
        modelVersion: this.chatSummaryProvider.modelVersion
      };
      const id = this.store.createSummarySnapshot(chatId, summary, sourceMessageIds, summary.modelVersion);
      return { id, summary };
    } finally {
      this.summaryChatsInFlight.delete(chatId);
    }
  }

  public startReminderLoop(intervalMs = 60_000): void {
    if (this.timer) return;
    this.applyRetention();
    this.timer = setInterval(() => {
      void this.pipeline.deliverDue().catch((error: unknown) => {
        this.logger.write({ level: "error", event: "reminder_loop_failed", metadata: { code: error instanceof Error ? error.name : "unknown" } });
      });
      this.applyRetention();
    }, intervalMs);
  }

  public async recoverAfterWake(): Promise<number> {
    await this.startLivePersonalIngest();
    return this.pipeline.recoverAfterWake();
  }

  /**
   * The browser-independent worker invokes this only after the full live gate
   * (including a non-empty allowlist) is satisfied. Pairing remains a separate
   * dashboard setup action because the allowlist correctly starts empty.
   */
  public async startLivePersonalIngest(): Promise<PersonalLinkedDeviceStartResult | undefined> {
    const gate = evaluateLiveGate(this.config, this.store.countAllowlistedChats());
    if (!gate.allowed || this.shuttingDown) {
      if (this.config.liveImportEnabled && !this.shuttingDown) this.lastErrorCode = "live_gate_blocked";
      return undefined;
    }
    const result = await this.getPersonalLinkedDeviceAdapter().start();
    if (result.started) {
      this.lastErrorCode = undefined;
      return result;
    }
    if (result.reason !== "already_started") {
      this.lastErrorCode = `personal_${result.reason}`;
      this.schedulePersonalReconnect();
    }
    return result;
  }

  /**
   * Creates, but never starts, the gated personal adapter. QR data remains in
   * process memory only and is available solely to the localhost setup route.
   */
  public getPersonalLinkedDeviceAdapter(): PersonalLinkedDeviceAdapter {
    if (this.personalAdapter) return this.personalAdapter;
    const auth = EncryptedAuthState.open(join(this.config.sessionDir, "personal-auth-state.enc"), this.encryptor);
    this.personalAuthState = auth;
    this.personalAdapter = this.personalAdapterFactory({
      auth: auth.state,
      liveImportEnabled: this.config.liveImportEnabled,
      authorizeLiveConnection: () => evaluatePersonalConnectionGate(this.config).allowed,
      onIncomingMessage: async (message, context) => {
        if (context.isHistorical || message.isHistorical === true || message.source === "history_sync") {
          if (this.personalHistoryImportChatId !== message.chatId) return;
          if (!evaluateLiveGate(this.config, this.store.countAllowlistedChats()).allowed) {
            this.lastErrorCode = "live_gate_blocked";
            return;
          }
          await this.pipeline.ingest({ ...message, isHistorical: true });
          this.markIngested();
          return;
        }
        // Pairing deliberately uses the narrower connection gate while the
        // allowlist is still empty. Once an incoming message could be in
        // scope, require the *full* live gate before it reaches persistence.
        // This prevents a setup browser from turning a newly selected chat
        // into live ingestion before timezone, retention, export/deletion and
        // notification confirmations have been explicitly completed.
        if (!evaluateLiveGate(this.config, this.store.countAllowlistedChats()).allowed) {
          this.lastErrorCode = "live_gate_blocked";
          return;
        }
        await this.pipeline.ingest(message);
        this.markIngested();
      },
      saveAuthState: (update) => auth.applyCreds(update),
      onPairingQr: (qr) => {
        // The adapter is the sole QR producer. Keep this only in process
        // memory, and record local receipt metadata without logging QR bytes.
        const previousReference = pairingQrReference(this.pairingQr);
        const nextReference = pairingQrReference(qr);
        this.pairingQrRequiresImmediateDisplay = this.pairingQr !== undefined
          && this.pairingQr !== qr
          && previousReference !== undefined
          && previousReference === nextReference;
        this.pairingQr = qr;
        this.pairingQrIssuedAt = new Date();
        this.pairingQrGeneration += 1;
        this.pairingPresentationState = "awaiting_qr";
      },
      onAvailableChats: (chats) => {
        for (const chat of chats) {
          const existing = this.availableChats.get(chat.id);
          this.availableChats.set(chat.id, {
            ...(existing ?? {}),
            ...chat,
            ...(chat.label === undefined && existing?.label !== undefined ? { label: existing.label } : {})
          });
        }
      },
      onConnectionStatus: (status) => {
        if (status.isNewLogin === true) {
          // Baileys emits this after WhatsApp accepted the scan and explicitly
          // expects a new socket for the authenticated login handshake. The
          // QR must disappear here, but this is not a failed pairing and must
          // not leave the newly accepted session stuck on the old socket.
          this.clearPairingQr();
          this.availableChats.clear();
          this.pairingPresentationState = "finishing_login";
          this.restartAfterSuccessfulPairing();
        }
        if (status.connection === "open") {
          this.clearPairingQr();
          this.pairingPresentationState = "connected";
          this.personalReconnectAttempts = 0;
          this.lastConnectionFailureCode = undefined;
          this.lastErrorCode = undefined;
        }
        if (status.connection === "close") {
          // A closed socket makes the displayed pairing code known-stale. Do
          // not retain it while the existing bounded reconnect waits for the
          // adapter/WhatsApp to supply another one.
          this.clearPairingQr();
          this.availableChats.clear();
          this.pairingPresentationState = "reconnecting";
          this.lastConnectionFailureCode = status.disconnectStatusCode;
          this.lastErrorCode = "personal_connection_closed";
          this.schedulePersonalReconnect();
        }
      },
      onAdapterError: (error) => {
        this.lastErrorCode = `personal_${error.code}`;
        this.logger.write({ level: "warn", event: "personal_adapter_error", metadata: { code: error.code } });
        if (error.code === "web_version_unavailable") this.schedulePersonalReconnect();
      }
    });
    return this.personalAdapter;
  }

  public getPairingQr(): string | undefined {
    return this.pairingQr;
  }

  /**
   * Return the in-memory QR with non-secret local receipt metadata for the
   * localhost setup page. `issuedAt` and `generation` are presentation aids,
   * never a claim about the QR's server-side WhatsApp TTL.
   */
  public getPairingQrSnapshot(): PairingQrSnapshot {
    return {
      qr: this.pairingQr,
      issuedAt: this.pairingQrIssuedAt?.toISOString(),
      generation: this.pairingQrGeneration,
      requiresImmediateDisplay: this.pairingQrRequiresImmediateDisplay,
      state: this.pairingPresentationState
    };
  }

  public getAvailableChats(): AvailableLinkedChat[] {
    return [...this.availableChats.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  public async refreshAvailableChats(): Promise<AvailableChatsRefreshResult> {
    if (this.personalAdapter === undefined) return { refreshed: false, reason: "not_connected" };
    return this.personalAdapter.refreshAvailableChats();
  }

  /**
   * Imports history only after all live safeguards are currently satisfied and
   * only for the chat that is both confirmed and already allowlisted.
   */
  public async importPersonalChatHistory(request: PersonalHistoryImportRequest): Promise<PersonalHistoryImportResult> {
    if (request.confirmed !== true) throw new PersonalHistoryImportError("history_confirmation_required");
    const chatId = request.chatId.trim();
    if (!this.store.isAllowlisted(chatId)) throw new PersonalHistoryImportError("history_chat_not_allowlisted");
    if (!evaluateLiveGate(this.config, this.store.countAllowlistedChats()).allowed) {
      throw new PersonalHistoryImportError("history_live_gate_blocked");
    }
    if (request.maxMessages === undefined && request.since === undefined && request.until === undefined) {
      throw new PersonalHistoryImportError("history_bound_required");
    }
    if (this.personalHistoryImportInFlight) {
      throw new PersonalHistoryImportError("history_import_in_progress");
    }
    const adapter = this.personalAdapter;
    if (adapter === undefined || !adapter.isConnected) {
      throw new PersonalHistoryImportError("history_adapter_not_connected");
    }

    this.personalHistoryImportInFlight = true;
    this.personalHistoryImportChatId = chatId;
    try {
      const adapterRequest: AdapterHistoryImportRequest = {
        chatId,
        ...(request.maxMessages === undefined ? {} : { maxMessages: request.maxMessages }),
        ...(request.since === undefined ? {} : { since: request.since }),
        ...(request.until === undefined ? {} : { until: request.until })
      };
      return await adapter.importHistory(adapterRequest);
    } finally {
      if (this.personalHistoryImportChatId === chatId) this.personalHistoryImportChatId = undefined;
      this.personalHistoryImportInFlight = false;
    }
  }

  public async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.timer) clearInterval(this.timer);
    if (this.personalReconnectTimer) clearTimeout(this.personalReconnectTimer);
    if (this.personalAdapter) await this.personalAdapter.stop();
    this.store.close();
  }

  /** Explicit data-erasure operation scoped to this application's configured instance. */
  public eraseLocalInstance(): void {
    this.assertSafeManagedRoot();
    if (this.personalAdapter?.isConnected) {
      throw new Error("Stop the linked-device adapter before erasing its local instance");
    }
    this.shuttingDown = true;
    if (this.timer) clearInterval(this.timer);
    if (this.personalReconnectTimer) clearTimeout(this.personalReconnectTimer);
    this.store.eraseInstance();
    this.mediaStore.eraseAll();
    this.personalAuthState?.wipe();
    this.removeManagedFile(join(this.config.sessionDir, "personal-auth-state.enc"), "personal-auth-state.enc", "sessions");
    this.removeManagedFile(this.config.runtimeEnvPath, "runtime.env");
    this.removeManagedDirectory(join(this.config.dataDir, "logs"), "logs");
  }

  /** Delete the entire scoped local instance, including its SQLite files. */
  public async destroyLocalInstance(): Promise<void> {
    this.shuttingDown = true;
    if (this.timer) clearInterval(this.timer);
    if (this.personalReconnectTimer) clearTimeout(this.personalReconnectTimer);
    if (this.personalAdapter?.isConnected) await this.personalAdapter.stop();
    this.eraseLocalInstance();
    this.store.close();
    for (const path of [this.config.databasePath, `${this.config.databasePath}-wal`, `${this.config.databasePath}-shm`]) {
      this.removeManagedFile(path, basename(path));
    }
    this.removeManagedDirectory(this.config.mediaDir, "media");
    this.removeManagedDirectory(this.config.sessionDir, "sessions");
  }

  /** Apply configured raw-data retention and remove only orphaned vault files. */
  public applyRetention(now = new Date()): number {
    this.assertSafeManagedRoot();
    const cutoff = new Date(now.getTime() - this.config.retentionDays * 24 * 60 * 60 * 1_000).toISOString();
    this.store.purgeBefore(cutoff);
    return this.mediaStore.removeUnreferenced(this.store.listStoredMediaPaths());
  }

  /** Explicit, scoped deletion for one allowlisted chat and its linked data. */
  public deleteChatData(chatId: string): boolean {
    this.assertSafeManagedRoot();
    const deleted = this.store.deleteChat(chatId);
    this.mediaStore.removeUnreferenced(this.store.listStoredMediaPaths());
    return deleted;
  }

  /**
   * Import one locally selected plaintext WhatsApp export into an existing
   * allowlisted chat. It does not start a socket, scan attachments, download
   * media, or create notifications; `chat_export` is historical by design.
   */
  public async importChatExport(request: ChatExportImportRequest): Promise<ChatExportImportResult> {
    if (!this.config.accountAuthorized) throw new ChatExportImportError("account_not_authorized");
    if (this.config.encryptionKeyIsEphemeral) throw new ChatExportImportError("persistent_key_required");
    if (this.config.killSwitch) throw new ChatExportImportError("kill_switch_active");
    if (!this.store.isAllowlisted(request.chatId)) throw new ChatExportImportError("chat_not_allowlisted");

    const parsed = readLocalChatExportFile(request.filePath, {
      chatId: request.chatId,
      timeZone: this.config.timezone,
      tokenize: (value) => this.encryptor.stableToken(value),
      ...(request.ownSenderLabel === undefined ? {} : { ownSenderLabel: request.ownSenderLabel }),
      ...(request.dateOrder === undefined ? {} : { dateOrder: request.dateOrder })
    });
    let imported = 0;
    let deduplicated = 0;
    let rejected = 0;
    for (const message of parsed.messages) {
      const outcome = await this.pipeline.ingest(message);
      if (!outcome.accepted) {
        rejected += 1;
      } else if (outcome.deduplicated) {
        deduplicated += 1;
      } else {
        imported += 1;
      }
    }
    this.logger.write({
      level: "info",
      event: "chat_export_import_completed",
      metadata: {
        imported,
        deduplicated,
        rejected,
        unsupported: parsed.stats.unsupported,
        ignored: parsed.stats.ignoredMalformed + parsed.stats.ignoredAmbiguousDate + parsed.stats.ignoredInvalidTimestamp
      }
    });
    return { imported, deduplicated, rejected, stats: parsed.stats };
  }

  /**
   * Create a non-overwriting local export of field-encrypted user data. Auth state,
   * runtime configuration, logs, and the encryption key are intentionally not
   * exported; restoration requires the separately managed key.
   */
  public exportLocalData(destination: string): string {
    const root = this.assertSafeManagedRoot();
    const target = resolve(destination);
    const relation = relative(root, target);
    if (target === root || (relation !== "" && !relation.startsWith("..") && !relation.includes("/../"))) {
      throw new Error("Refusing to export inside the application's data directory");
    }
    if (existsSync(target)) throw new Error("Refusing to overwrite an existing export directory");

    this.store.checkpointForBackup();
    mkdirSync(target, { recursive: false, mode: 0o700 });
    const databaseCopy = join(target, "chat-intelligence.sqlite");
    copyFileSync(this.config.databasePath, databaseCopy, 0);
    chmodSync(databaseCopy, 0o600);
    if (existsSync(this.config.mediaDir)) cpSync(this.config.mediaDir, join(target, "media"), { recursive: true, preserveTimestamps: true });
    const manifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      timezone: this.config.timezone,
      includes: ["field_encrypted_sqlite", "encrypted_media"],
      excludes: ["auth_session", "runtime_configuration", "logs", "encryption_key"]
    };
    const manifestPath = join(target, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest), { encoding: "utf8", mode: 0o600 });
    chmodSync(manifestPath, 0o600);
    return target;
  }

  public close(): void {
    this.shuttingDown = true;
    if (this.timer) clearInterval(this.timer);
    if (this.personalReconnectTimer) clearTimeout(this.personalReconnectTimer);
    this.store.close();
  }

  /**
   * Exponential reconnect is local and bounded. Pairing itself is permitted by
   * the narrower connection gate, while the inbound callback independently
   * requires the full live gate before any in-scope data can persist.
   */
  private schedulePersonalReconnect(): void {
    if (this.shuttingDown || this.personalReconnectTimer) return;
    if (!evaluatePersonalConnectionGate(this.config).allowed) return;
    const exponent = Math.min(this.personalReconnectAttempts, 8);
    const delayMs = Math.min(300_000, 1_000 * (2 ** exponent));
    this.personalReconnectAttempts += 1;
    this.personalReconnectTimer = setTimeout(() => {
      this.personalReconnectTimer = undefined;
      void this.restartPersonalConnection().catch((error: unknown) => {
        this.lastErrorCode = "personal_reconnect_failed";
        this.logger.write({
          level: "warn",
          event: "personal_reconnect_failed",
          metadata: { code: error instanceof Error ? error.name : "unknown" }
        });
        this.schedulePersonalReconnect();
      });
    }, delayMs);
  }

  private async restartPersonalConnection(): Promise<void> {
    if (this.shuttingDown || !evaluatePersonalConnectionGate(this.config).allowed) return;
    const result = await this.getPersonalLinkedDeviceAdapter().start();
    if (result.started) {
      this.lastErrorCode = undefined;
      return;
    }
    if (result.reason === "already_started") return;
    this.lastErrorCode = `personal_${result.reason}`;
    this.schedulePersonalReconnect();
  }

  /**
   * WhatsApp accepts a QR scan on the unauthenticated socket, then asks
   * Baileys to reconnect with the freshly written credentials. `stop()` waits
   * for those credential writes before releasing the old socket, so the new
   * connection cannot race a partially saved pairing state.
   */
  private restartAfterSuccessfulPairing(): void {
    if (this.shuttingDown || this.personalLoginRestartInFlight) return;
    const restart = (async () => {
      const adapter = this.personalAdapter;
      if (adapter) await adapter.stop();
      await this.restartPersonalConnection();
    })();
    this.personalLoginRestartInFlight = restart;
    void restart.catch((error: unknown) => {
      this.lastErrorCode = "personal_new_login_restart_failed";
      this.logger.write({
        level: "warn",
        event: "personal_new_login_restart_failed",
        metadata: { code: error instanceof Error ? error.name : "unknown" }
      });
      this.schedulePersonalReconnect();
    }).finally(() => {
      if (this.personalLoginRestartInFlight === restart) this.personalLoginRestartInFlight = undefined;
    });
  }

  private clearPairingQr(): void {
    this.pairingQr = undefined;
    this.pairingQrIssuedAt = undefined;
    this.pairingQrRequiresImmediateDisplay = false;
  }

  private assertSafeManagedRoot(): string {
    const root = resolve(this.config.dataDir);
    if (root === "/" || root === resolve(homedir()) || root === resolve(process.cwd())) {
      throw new Error("Refusing to delete an unsafe configured data directory");
    }
    return root;
  }

  private removeManagedFile(path: string, expectedName: string, parentDirectory?: string): void {
    const root = this.assertSafeManagedRoot();
    const target = resolve(path);
    const parent = parentDirectory === undefined ? root : resolve(root, parentDirectory);
    if (basename(target) !== expectedName || dirname(target) !== parent) {
      throw new Error("Refusing to delete a file outside this app's data directory");
    }
    if (existsSync(target)) unlinkSync(target);
  }

  private removeManagedDirectory(path: string, expectedName: string): void {
    const root = this.assertSafeManagedRoot();
    const target = resolve(path);
    if (basename(target) !== expectedName || dirname(target) !== root) {
      throw new Error("Refusing to delete a directory outside this app's data directory");
    }
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  }
}
