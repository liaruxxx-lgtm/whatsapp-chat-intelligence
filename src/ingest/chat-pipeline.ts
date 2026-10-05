import type { IncomingMessage, ProcessResult } from "../domain/types.js";
import { parseEventMessage } from "../events/time-parser.js";
import { EventResolver } from "../events/event-resolver.js";
import { ReminderService } from "../notifications/reminder-service.js";
import type { SafeLogger } from "../security/logger.js";
import { SqliteMessageStore } from "../storage/sqlite-store.js";
import { EncryptedMediaStore } from "../storage/encrypted-media-store.js";
import { DeterministicSummaryService } from "../summary/deterministic-summary.js";
import type { LocalTranscriber } from "../transcription/local-transcriber.js";

export interface PipelineOptions {
  timezone: string;
  killSwitch: boolean;
  maxMediaBytes: number;
}

export class ChatPipeline {
  private readonly resolver: EventResolver;
  private readonly summaries: DeterministicSummaryService;
  /** One serial tail per chat preserves causal order without blocking another chat. */
  private readonly chatTails = new Map<string, Promise<void>>();

  public constructor(
    private readonly store: SqliteMessageStore,
    private readonly mediaStore: EncryptedMediaStore,
    private readonly transcriber: LocalTranscriber,
    private readonly reminders: ReminderService,
    private readonly logger: SafeLogger,
    private readonly options: PipelineOptions
  ) {
    this.resolver = new EventResolver(store);
    this.summaries = new DeterministicSummaryService(store);
  }

  public addAllowedChat(chatId: string): void {
    this.store.addToAllowlist(chatId);
  }

  /**
   * Persisted upstream deliveries can arrive concurrently (notably media and
   * text updates). Serialize each chat locally so a correction never resolves
   * before the earlier event it modifies; independent chats still run in
   * parallel. The adapter/storage idempotency guards remain the durable layer
   * across a process restart.
   */
  public ingest(message: IncomingMessage): Promise<ProcessResult> {
    const previous = this.chatTails.get(message.chatId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => this.ingestSerial(message));
    const tail = operation.then(() => undefined, () => undefined);
    this.chatTails.set(message.chatId, tail);
    void tail.then(() => {
      if (this.chatTails.get(message.chatId) === tail) this.chatTails.delete(message.chatId);
    });
    return operation;
  }

  private async ingestSerial(message: IncomingMessage): Promise<ProcessResult> {
    if (this.options.killSwitch) return { accepted: false, deduplicated: false, reason: "kill_switch" };
    if (!this.store.isAllowlisted(message.chatId)) {
      this.logger.write({ level: "info", event: "message_rejected_not_allowlisted", metadata: { source: message.source, kind: message.kind } });
      return { accepted: false, deduplicated: false, reason: "not_allowlisted" };
    }
    if (!Number.isFinite(Date.parse(message.timestamp))) {
      this.logger.write({ level: "warn", event: "message_rejected_invalid_timestamp", metadata: { source: message.source } });
      return { accepted: false, deduplicated: false, reason: "invalid" };
    }

    const persisted = this.store.persistIncoming(message);
    if (!persisted.inserted && !message.isEdit && !message.isDelete) {
      return { accepted: true, deduplicated: true, canonicalId: persisted.message.canonicalId, reason: "duplicate" };
    }

    if (message.isDelete) {
      this.store.markDeleted(persisted.message.canonicalId);
      return { accepted: true, deduplicated: !persisted.inserted, canonicalId: persisted.message.canonicalId };
    }

    if (message.isEdit && message.text !== undefined) {
      this.store.applyEdit(persisted.message.canonicalId, message.text);
    }

    if (message.kind === "voice" || message.kind === "audio") {
      return this.processAudio(message, persisted.message.canonicalId, persisted.inserted);
    }
    if (message.kind !== "text") {
      if (message.media) this.store.saveMedia(persisted.message.canonicalId, message.media, "unsupported");
      this.store.markMessageStatus(persisted.message.canonicalId, "unsupported", "unsupported");
      return { accepted: true, deduplicated: !persisted.inserted, canonicalId: persisted.message.canonicalId, reason: "unsupported" };
    }

    const text = message.text ?? this.store.getMessageText(persisted.message.canonicalId);
    this.store.markMessageStatus(persisted.message.canonicalId, "processed");
    const messageForResolution = text === undefined ? message : { ...message, text };
    return this.resolveText(messageForResolution, persisted.message.canonicalId, persisted.inserted);
  }

  public async deliverDue(now?: string): Promise<number> {
    return this.reminders.deliverDue(now);
  }

  public async recoverAfterWake(now?: string): Promise<number> {
    return this.reminders.recoverAfterWake(now);
  }

  private async processAudio(message: IncomingMessage, canonicalId: string, inserted: boolean): Promise<ProcessResult> {
    if (!message.media) {
      this.store.markMessageStatus(canonicalId, "transcription_failed", "unavailable");
      return { accepted: true, deduplicated: !inserted, canonicalId };
    }
    if (message.media.unavailable) {
      this.store.saveMedia(canonicalId, message.media, "unavailable");
      this.store.markMessageStatus(canonicalId, "media_unavailable", "unavailable");
      return { accepted: true, deduplicated: !inserted, canonicalId };
    }
    if (!message.media.bytes) {
      this.store.saveMedia(canonicalId, message.media, "unavailable");
      this.store.markMessageStatus(canonicalId, "media_unavailable", "unavailable");
      this.logger.write({ level: "warn", event: "media_bytes_unavailable", metadata: { kind: message.kind } });
      return { accepted: true, deduplicated: !inserted, canonicalId };
    }
    const mimeType = message.media.mimeType?.toLocaleLowerCase("en-US");
    if (mimeType !== undefined && !mimeType.startsWith("audio/")) {
      this.store.saveMedia(canonicalId, message.media, "unsupported");
      this.store.markMessageStatus(canonicalId, "unsupported", "unsupported");
      this.logger.write({ level: "warn", event: "media_rejected_mime", metadata: { kind: message.kind } });
      return { accepted: true, deduplicated: !inserted, canonicalId, reason: "unsupported" };
    }
    if (message.media.bytes.byteLength > this.options.maxMediaBytes) {
      this.store.saveMedia(canonicalId, message.media, "unsupported");
      this.store.markMessageStatus(canonicalId, "unsupported", "unsupported");
      this.logger.write({ level: "warn", event: "media_rejected_size", metadata: { kind: message.kind } });
      return { accepted: true, deduplicated: !inserted, canonicalId, reason: "unsupported" };
    }
    const storedMedia = this.mediaStore.put(canonicalId, message.media.bytes);
    this.store.saveMedia(canonicalId, message.media, "available", storedMedia.sha256, storedMedia.path);
    const transcript = await this.transcriber.transcribe(message.media);
    if ("errorCode" in transcript) {
      if (transcript.status === "unavailable") {
        this.store.markMessageStatus(canonicalId, "media_unavailable", "unavailable");
      } else {
        this.store.markMessageStatus(canonicalId, "transcription_failed", "available");
        this.logger.write({ level: "warn", event: "transcription_failed", metadata: { code: transcript.errorCode } });
      }
      return { accepted: true, deduplicated: !inserted, canonicalId };
    }
    const successfulTranscript = transcript;
    const record = this.store.saveTranscript(canonicalId, successfulTranscript);
    this.store.markMessageStatus(canonicalId, successfulTranscript.status === "completed" ? "processed" : "transcription_uncertain", "available");
    const result = this.resolveText(
      { ...message, text: successfulTranscript.text },
      canonicalId,
      inserted,
      successfulTranscript.status === "uncertain" ? successfulTranscript.confidence : undefined
    );
    if (result.event) {
      result.event.sourceTranscriptSegmentIds = record.segments.map((segment) => segment.id).filter((id): id is string => Boolean(id));
      this.store.saveEvent(result.event);
    }
    return result;
  }

  private resolveText(
    message: Pick<IncomingMessage, "messageId" | "chatId" | "timestamp" | "source" | "text">,
    canonicalId: string,
    inserted: boolean,
    confidenceCap?: number
  ): ProcessResult {
    if (!message.text?.trim()) return { accepted: true, deduplicated: !inserted, canonicalId };
    const parsed = parseEventMessage(message, { timeZone: this.options.timezone });
    if (!parsed) return { accepted: true, deduplicated: !inserted, canonicalId };
    parsed.candidate.sourceMessageIds = [canonicalId];
    if (confidenceCap !== undefined) parsed.candidate.time.confidence = Math.min(parsed.candidate.time.confidence, confidenceCap);
    const resolution = this.resolver.resolve(parsed, message);
    if (resolution.event) {
      this.reminders.scheduleFromEvent(resolution.event, resolution.effect, message.source);
      // Snapshots are derived only after the versioned event was committed. A
      // snapshot failure is visible in safe logs but cannot undo or duplicate a
      // committed message/event transition.
      if (resolution.effect !== "none") {
        try {
          this.summaries.snapshot(message.chatId, [resolution.event]);
        } catch (error) {
          this.logger.write({
            level: "warn",
            event: "summary_snapshot_failed",
            metadata: { code: error instanceof Error ? error.name : "unknown" }
          });
        }
      }
    }
    const result: ProcessResult = {
      accepted: true,
      deduplicated: !inserted,
      canonicalId
    };
    if (resolution.event) result.event = resolution.event;
    return result;
  }
}
