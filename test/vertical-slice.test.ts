import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type RuntimeConfig } from "../src/config.js";
import type { IncomingMessage } from "../src/domain/types.js";
import { MemoryNotificationAdapter } from "../src/notifications/notification-adapter.js";
import { ChatIntelligenceApplication } from "../src/runtime/application.js";
import { MemorySafeLogger } from "../src/security/logger.js";
import { DeterministicSummaryService, type StructuredSummaryProvider } from "../src/summary/deterministic-summary.js";
import type { LocalTranscriber, TranscriptionResult } from "../src/transcription/local-transcriber.js";

const encryptionKey = Buffer.alloc(32, 7).toString("base64");
const disposers: Array<() => void> = [];

class FailOnceNotificationAdapter extends MemoryNotificationAdapter {
  public attempts = 0;

  public override async send(payload: Parameters<MemoryNotificationAdapter["send"]>[0]): Promise<void> {
    this.attempts += 1;
    if (this.attempts === 1) throw new Error("notification bridge unavailable");
    await super.send(payload);
  }
}

class DeferredTranscriber implements LocalTranscriber {
  private releaseGate: (() => void) | undefined;
  private readonly gate = new Promise<void>((resolve) => { this.releaseGate = resolve; });

  public release(): void {
    this.releaseGate?.();
  }

  public async transcribe(): Promise<TranscriptionResult> {
    await this.gate;
    return {
      status: "completed",
      text: "Heute um 15 Uhr treffen wir uns.",
      language: "de",
      confidence: 0.95,
      segments: [{ id: "delayed-segment", startSeconds: 0, endSeconds: 1, text: "Heute um 15 Uhr treffen wir uns.", confidence: 0.95 }]
    };
  }
}

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
});

function fixture(): {
  app: ChatIntelligenceApplication;
  adapter: MemoryNotificationAdapter;
  logger: MemorySafeLogger;
  config: RuntimeConfig;
  directory: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "wci-vertical-slice-"));
  const config = loadConfig({
    WCI_DATA_DIR: directory,
    WCI_ENCRYPTION_KEY_BASE64: encryptionKey,
    WCI_TIMEZONE: "Europe/Berlin",
    WCI_REMINDER_LEAD_MINUTES: "30",
    WCI_LIVE_IMPORT_ENABLED: "false",
    WCI_KILL_SWITCH: "false"
  });
  const adapter = new MemoryNotificationAdapter();
  const logger = new MemorySafeLogger();
  const app = new ChatIntelligenceApplication(config, { notificationAdapter: adapter, logger });
  disposers.push(() => {
    app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { app, adapter, logger, config, directory };
}

function fixtureWithAdapter(adapter: MemoryNotificationAdapter): {
  app: ChatIntelligenceApplication;
  adapter: MemoryNotificationAdapter;
  logger: MemorySafeLogger;
  config: RuntimeConfig;
  directory: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "wci-vertical-slice-"));
  const config = loadConfig({
    WCI_DATA_DIR: directory,
    WCI_ENCRYPTION_KEY_BASE64: encryptionKey,
    WCI_TIMEZONE: "Europe/Berlin",
    WCI_REMINDER_LEAD_MINUTES: "30",
    WCI_LIVE_IMPORT_ENABLED: "false",
    WCI_KILL_SWITCH: "false"
  });
  const logger = new MemorySafeLogger();
  const app = new ChatIntelligenceApplication(config, { notificationAdapter: adapter, logger });
  disposers.push(() => {
    app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { app, adapter, logger, config, directory };
}

function message(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: "message-1",
    chatId: "491700000001@s.whatsapp.net",
    senderId: "491700000001@s.whatsapp.net",
    fromMe: false,
    timestamp: "2030-05-05T10:00:00.000Z",
    source: "synthetic",
    kind: "text",
    text: "Heute um 15 Uhr treffen wir uns.",
    ...overrides
  };
}

describe("synthetic vertical slice", () => {
  it("starts from an empty DB, gates unallowed chats before persistence, and idempotently stores allowed text", async () => {
    const { app, logger } = fixture();
    expect(app.store.count("messages")).toBe(0);

    const rejected = await app.pipeline.ingest(message({ text: "geheimer nicht erlaubter Inhalt" }));
    expect(rejected).toMatchObject({ accepted: false, reason: "not_allowlisted" });
    expect(app.store.count("messages")).toBe(0);

    app.pipeline.addAllowedChat("491700000001@s.whatsapp.net");
    app.pipeline.addAllowedChat("123456@g.us");
    const accepted = await app.pipeline.ingest(message());
    const replay = await app.pipeline.ingest(message());

    expect(accepted.accepted).toBe(true);
    expect(replay).toMatchObject({ accepted: true, deduplicated: true, reason: "duplicate" });
    expect(app.store.count("messages")).toBe(1);
    expect(app.store.getMessageText(accepted.canonicalId!)).toBe("Heute um 15 Uhr treffen wir uns.");
    expect(JSON.stringify(logger.entries)).not.toContain("geheimer nicht erlaubter Inhalt");
  });

  it("consolidates two source messages that state the same appointment", async () => {
    const { app } = fixture();
    app.pipeline.addAllowedChat("491700000001@s.whatsapp.net");
    const first = await app.pipeline.ingest(message());
    const repeated = await app.pipeline.ingest(message({
      messageId: "same-appointment-second-source",
      timestamp: "2030-05-05T10:01:00.000Z"
    }));

    expect(repeated.event?.id).toBe(first.event?.id);
    expect(app.store.listEvents("491700000001@s.whatsapp.net")).toHaveLength(1);
    expect(repeated.event?.sourceMessageIds).toHaveLength(2);
  });

  it("processes a voice fixture locally and records media-unavailable and transcription-failed states without guessing", async () => {
    const { app, directory } = fixture();
    app.pipeline.addAllowedChat("491700000001@s.whatsapp.net");

    const voiced = await app.pipeline.ingest(message({
      messageId: "voice-1",
      kind: "voice",
      text: undefined,
      media: {
        mimeType: "audio/ogg",
        bytes: new Uint8Array([1, 2, 3]),
        fixtureTranscript: {
          text: "Morgen um 9 Uhr ist das Meeting.",
          language: "de",
          confidence: 0.96,
          segments: [{ startSeconds: 0, endSeconds: 2, text: "Morgen um 9 Uhr ist das Meeting.", confidence: 0.96 }]
        }
      }
    }));
    expect(voiced.event?.startsAt).toBeDefined();
    expect(app.store.count("transcripts")).toBe(1);
    expect(app.store.getTranscriptText(voiced.canonicalId!)).toContain("Morgen um 9 Uhr");
    // Segment words are transcript content as well; SQLite must not retain
    // either aggregate or segment text in cleartext.
    for (const sqliteArtifact of [join(directory, "chat-intelligence.sqlite"), join(directory, "chat-intelligence.sqlite-wal")]) {
      if (existsSync(sqliteArtifact)) {
        expect(readFileSync(sqliteArtifact)).not.toContain(Buffer.from("Morgen um 9 Uhr ist das Meeting."));
      }
    }
    const mediaFile = readdirSync(app.config.mediaDir).find((name) => name.endsWith(".media.enc"));
    expect(mediaFile).toBeDefined();
    expect(readFileSync(join(app.config.mediaDir, mediaFile!))).not.toContain(Buffer.from([1, 2, 3]));
    expect([...app.mediaStore.read(join(app.config.mediaDir, mediaFile!))]).toEqual([1, 2, 3]);

    const unavailable = await app.pipeline.ingest(message({
      messageId: "voice-unavailable",
      kind: "voice",
      text: undefined,
      media: { unavailable: true }
    }));
    expect(app.store.getMessage(unavailable.canonicalId!)?.processingStatus).toBe("media_unavailable");

    const failed = await app.pipeline.ingest(message({
      messageId: "voice-failed",
      kind: "voice",
      text: undefined,
      media: { mimeType: "audio/ogg", bytes: new Uint8Array([4, 5, 6]) }
    }));
    expect(app.store.getMessage(failed.canonicalId!)?.processingStatus).toBe("transcription_failed");
    expect(app.store.getTranscriptText(failed.canonicalId!)).toBeUndefined();

    app.eraseLocalInstance();
    expect(app.store.count("messages")).toBe(0);
    expect(readdirSync(app.config.mediaDir)).toEqual([]);
  });

  it("rejects oversized or non-audio voice bytes before the media vault and transcriber", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wci-media-limit-"));
    const config = loadConfig({
      WCI_DATA_DIR: directory,
      WCI_ENCRYPTION_KEY_BASE64: encryptionKey,
      WCI_MAX_MEDIA_BYTES: "2"
    });
    const app = new ChatIntelligenceApplication(config, { notificationAdapter: new MemoryNotificationAdapter(), logger: new MemorySafeLogger() });
    disposers.push(() => {
      app.close();
      rmSync(directory, { recursive: true, force: true });
    });
    app.pipeline.addAllowedChat("491700000001@s.whatsapp.net");

    const oversized = await app.pipeline.ingest(message({
      messageId: "oversized-audio",
      kind: "voice",
      text: undefined,
      media: { mimeType: "audio/ogg", bytes: new Uint8Array([1, 2, 3]) }
    }));
    expect(oversized).toMatchObject({ reason: "unsupported" });
    expect(app.store.getMessage(oversized.canonicalId!)?.processingStatus).toBe("unsupported");
    expect(readdirSync(app.config.mediaDir)).toEqual([]);
  });

  it("keeps one logical event through a time change, emits the immediate change once, and cancels its reminder", async () => {
    const { app, adapter } = fixture();
    app.pipeline.addAllowedChat("491700000001@s.whatsapp.net");
    const created = await app.pipeline.ingest(message());
    const changed = await app.pipeline.ingest(message({
      messageId: "message-2",
      timestamp: "2030-05-05T10:01:00.000Z",
      text: "Das Treffen ist auf 16 Uhr verschoben."
    }));

    expect(created.event?.id).toBe(changed.event?.id);
    expect(changed.event).toMatchObject({ status: "changed", version: 2 });
    expect(changed.event?.startsAt).not.toBe(created.event?.startsAt);
    expect(await app.pipeline.deliverDue()).toBe(1);
    expect(await app.pipeline.deliverDue()).toBe(0);
    expect(adapter.notifications).toHaveLength(1);
    expect(adapter.notifications[0]?.kind).toBe("event_changed");

    const cancelled = await app.pipeline.ingest(message({
      messageId: "message-3",
      timestamp: "2030-05-05T10:02:00.000Z",
      text: "Das Treffen fällt aus."
    }));
    expect(cancelled.event).toMatchObject({ id: created.event?.id, status: "cancelled", version: 3 });
    expect(app.store.listScheduledReminders(created.event?.id)).toHaveLength(1); // immediate cancellation only
  });

  it("retries a failed local notification instead of permanently marking it delivered", async () => {
    const failingAdapter = new FailOnceNotificationAdapter();
    const { app } = fixtureWithAdapter(failingAdapter);
    app.pipeline.addAllowedChat("491700000001@s.whatsapp.net");
    const created = await app.pipeline.ingest(message());

    expect(await app.pipeline.deliverDue("2030-05-05T13:00:00.000Z")).toBe(0);
    expect(app.store.listScheduledReminders(created.event?.id)).toHaveLength(1);
    expect(await app.pipeline.deliverDue("2030-05-05T13:00:00.000Z")).toBe(1);
    expect(failingAdapter.attempts).toBe(2);
    expect(failingAdapter.notifications).toHaveLength(1);
  });

  it("changes or cancels only a uniquely matching subject when several appointments are active", async () => {
    const { app } = fixture();
    app.pipeline.addAllowedChat("491700000001@s.whatsapp.net");
    const doctor = await app.pipeline.ingest(message({
      messageId: "doctor-1",
      text: "Der Arzttermin ist heute um 15 Uhr."
    }));
    const project = await app.pipeline.ingest(message({
      messageId: "project-1",
      timestamp: "2030-05-05T10:01:00.000Z",
      text: "Das Projektmeeting ist heute um 16 Uhr."
    }));

    const ambiguous = await app.pipeline.ingest(message({
      messageId: "ambiguous-cancel",
      timestamp: "2030-05-05T10:02:00.000Z",
      text: "Der Termin fällt aus."
    }));
    expect(ambiguous.event).toMatchObject({ status: "uncertain" });
    expect(app.store.getEvent(project.event!.id)).toMatchObject({ status: "confirmed" });

    const cancellation = await app.pipeline.ingest(message({
      messageId: "doctor-cancel",
      timestamp: "2030-05-05T10:03:00.000Z",
      text: "Der Arzttermin fällt aus."
    }));
    expect(cancellation.event).toMatchObject({ id: doctor.event?.id, status: "cancelled" });
    expect(app.store.getEvent(project.event!.id)).toMatchObject({ status: "confirmed" });
  });

  it("does not rewrite a sole but specifically different appointment subject", async () => {
    const { app } = fixture();
    app.pipeline.addAllowedChat("491700000001@s.whatsapp.net");
    const doctor = await app.pipeline.ingest(message({ text: "Der Arzttermin ist heute um 15 Uhr." }));
    const unrelated = await app.pipeline.ingest(message({
      messageId: "unrelated-change",
      timestamp: "2030-05-05T10:01:00.000Z",
      text: "Das Projektmeeting ist auf 16 Uhr verschoben."
    }));

    expect(unrelated.event).toMatchObject({ status: "pending_resolution" });
    expect(unrelated.event?.id).not.toBe(doctor.event?.id);
    expect(app.store.getEvent(doctor.event!.id)).toMatchObject({ status: "confirmed" });
  });

  it("does not notify history imports, keeps group/from-me/reply metadata, and handles edits and deletes", async () => {
    const { app } = fixture();
    app.pipeline.addAllowedChat("123456@g.us");
    const historical = await app.pipeline.ingest(message({
      messageId: "history-1",
      chatId: "123456@g.us",
      senderId: "491700000002@s.whatsapp.net",
      fromMe: true,
      source: "history_sync",
      isHistorical: true,
      quotedMessageId: "quoted-1",
      text: "Morgen um 9 Uhr treffen wir uns."
    }));
    expect(historical.event?.status).toBe("confirmed");
    expect(app.store.listScheduledReminders()).toHaveLength(0);
    expect(app.store.getMessage(historical.canonicalId!)?.fromMe).toBe(true);
    expect(app.store.getMessage(historical.canonicalId!)?.isHistorical).toBe(true);
    expect(app.store.getMessage(historical.canonicalId!)?.quotedMessageId).toBe("quoted-1");

    await app.pipeline.ingest(message({
      messageId: "history-1",
      chatId: "123456@g.us",
      senderId: "491700000002@s.whatsapp.net",
      fromMe: true,
      source: "history_sync",
      isEdit: true,
      text: "Morgen um 10 Uhr treffen wir uns."
    }));
    expect(app.store.getMessageText(historical.canonicalId!)).toContain("10 Uhr");

    await app.pipeline.ingest(message({
      messageId: "history-1",
      chatId: "123456@g.us",
      senderId: "491700000002@s.whatsapp.net",
      fromMe: true,
      source: "history_sync",
      isDelete: true,
      text: undefined
    }));
    expect(app.store.getMessage(historical.canonicalId!)?.deletedAt).toBeDefined();
  });

  it("runs independently of a dashboard and recovery sends at most one current notification after restart", async () => {
    const first = fixture();
    first.app.pipeline.addAllowedChat("491700000001@s.whatsapp.net");
    await first.app.pipeline.ingest(message({ text: "Morgen um 9 Uhr treffen wir uns." }));
    first.app.close();

    const secondAdapter = new MemoryNotificationAdapter();
    const resumed = new ChatIntelligenceApplication(first.config, { notificationAdapter: secondAdapter, logger: new MemorySafeLogger() });
    disposers.push(() => resumed.close());
    const count = await resumed.recoverAfterWake("2030-05-07T12:00:00.000Z");
    expect(count).toBeLessThanOrEqual(1);
    expect(secondAdapter.notifications).toHaveLength(count);
  });

  it("marks low-confidence audio output uncertain and retains only encrypted message content in SQLite", async () => {
    const { app, directory } = fixture();
    app.pipeline.addAllowedChat("491700000001@s.whatsapp.net");
    const result = await app.pipeline.ingest(message({
      messageId: "low-confidence",
      kind: "voice",
      text: undefined,
      media: {
        bytes: new Uint8Array([7, 8, 9]),
        fixtureTranscript: {
          text: "Heute um 15 Uhr treffen wir uns.",
          language: "de",
          confidence: 0.4,
          segments: [{ startSeconds: 0, endSeconds: 1, text: "Heute um 15 Uhr treffen wir uns.", confidence: 0.4 }]
        }
      }
    }));
    expect(result.event?.notificationEligible).toBe(false);
    expect(result.event?.confidence).toBeLessThan(0.7);
    expect(readFileSync(join(directory, "chat-intelligence.sqlite"))).not.toContain(Buffer.from("Heute um 15 Uhr treffen wir uns."));
  });

  it("retains and deletes only scoped chat data, media, session state, and database artifacts", async () => {
    const { app } = fixture();
    const firstChat = "491700000001@s.whatsapp.net";
    const secondChat = "123456@g.us";
    app.pipeline.addAllowedChat(firstChat);
    app.pipeline.addAllowedChat(secondChat);

    await app.pipeline.ingest(message({
      messageId: "retention-a",
      chatId: firstChat,
      timestamp: "2030-01-01T10:00:00.000Z",
      kind: "voice",
      text: undefined,
      media: {
        bytes: new Uint8Array([11, 12, 13]),
        fixtureTranscript: { text: "kein Termin", language: "de", confidence: 0.9, segments: [{ startSeconds: 0, endSeconds: 1, text: "kein Termin", confidence: 0.9 }] }
      }
    }));
    await app.pipeline.ingest(message({
      messageId: "retention-b",
      chatId: secondChat,
      timestamp: "2030-01-02T10:00:00.000Z",
      kind: "voice",
      text: undefined,
      media: {
        bytes: new Uint8Array([21, 22, 23]),
        fixtureTranscript: { text: "kein Termin", language: "de", confidence: 0.9, segments: [{ startSeconds: 0, endSeconds: 1, text: "kein Termin", confidence: 0.9 }] }
      }
    }));
    expect(readdirSync(app.config.mediaDir).filter((name) => name.endsWith(".media.enc"))).toHaveLength(2);

    expect(app.deleteChatData(firstChat)).toBe(true);
    expect(app.store.count("messages")).toBe(1);
    expect(readdirSync(app.config.mediaDir).filter((name) => name.endsWith(".media.enc"))).toHaveLength(1);

    const exportDirectory = `${app.config.dataDir}-export`;
    expect(app.exportLocalData(exportDirectory)).toBe(exportDirectory);
    expect(existsSync(join(exportDirectory, "chat-intelligence.sqlite"))).toBe(true);
    expect(readdirSync(join(exportDirectory, "media")).filter((name) => name.endsWith(".media.enc"))).toHaveLength(1);
    expect(existsSync(join(exportDirectory, "sessions"))).toBe(false);
    rmSync(exportDirectory, { recursive: true, force: true });

    app.applyRetention(new Date("2031-01-01T00:00:00.000Z"));
    expect(app.store.count("messages")).toBe(0);
    expect(readdirSync(app.config.mediaDir).filter((name) => name.endsWith(".media.enc"))).toHaveLength(0);

    app.getPersonalLinkedDeviceAdapter();
    const authPath = join(app.config.sessionDir, "personal-auth-state.enc");
    expect(existsSync(authPath)).toBe(true);
    await app.destroyLocalInstance();
    expect(existsSync(app.config.databasePath)).toBe(false);
    expect(existsSync(authPath)).toBe(false);
    expect(existsSync(app.config.mediaDir)).toBe(false);
  });

  it("creates a source-bound structured snapshot without inventing free-text facts", async () => {
    const { app } = fixture();
    app.pipeline.addAllowedChat("491700000001@s.whatsapp.net");
    await app.pipeline.ingest(message());
    const snapshot = new DeterministicSummaryService(app.store).snapshot("491700000001@s.whatsapp.net");
    expect(snapshot.summary.modelVersion).toBe("deterministic-v1");
    expect(snapshot.summary.appointments).toHaveLength(1);
    expect(snapshot.summary.sourceMessageIds).toHaveLength(1);
    expect(snapshot.id).toBeTruthy();
  });

  it("writes one incremental structured snapshot for a meaningful event transition, not a duplicate replay", async () => {
    const { app } = fixture();
    app.pipeline.addAllowedChat("491700000001@s.whatsapp.net");

    await app.pipeline.ingest(message());
    await app.pipeline.ingest(message());

    expect(app.store.count("summary_snapshots")).toBe(1);
  });

  it("rejects a provider output that claims a source outside the allowlisted event evidence", async () => {
    const { app } = fixture();
    app.pipeline.addAllowedChat("491700000001@s.whatsapp.net");
    await app.pipeline.ingest(message());
    const unsafeProvider: StructuredSummaryProvider = {
      modelVersion: "test-provider",
      summarize: () => ({
        shortSummary: "Unbelegte Behauptung",
        newPoints: [], decisions: [], openQuestions: [], tasks: [], appointments: [], changes: [], unresolvedContradictions: [], dataGaps: [],
        sourceMessageIds: ["not-a-known-source"],
        modelVersion: "test-provider"
      })
    };

    expect(() => new DeterministicSummaryService(app.store, unsafeProvider).snapshot("491700000001@s.whatsapp.net"))
      .toThrow("summary_provider_returned_unbound_sources");
  });

  it("serializes concurrent deliveries per chat so a change cannot outrun an earlier audio event", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wci-per-chat-order-"));
    const delayed = new DeferredTranscriber();
    const config = loadConfig({ WCI_DATA_DIR: directory, WCI_ENCRYPTION_KEY_BASE64: encryptionKey });
    const app = new ChatIntelligenceApplication(config, {
      transcriber: delayed,
      notificationAdapter: new MemoryNotificationAdapter(),
      logger: new MemorySafeLogger()
    });
    disposers.push(() => {
      app.close();
      rmSync(directory, { recursive: true, force: true });
    });
    app.pipeline.addAllowedChat("491700000001@s.whatsapp.net");

    const first = app.pipeline.ingest(message({
      messageId: "ordered-audio",
      kind: "voice",
      text: undefined,
      media: { mimeType: "audio/ogg", bytes: new Uint8Array([1]) }
    }));
    const second = app.pipeline.ingest(message({
      messageId: "ordered-change",
      timestamp: "2030-05-05T10:01:00.000Z",
      text: "Das Treffen ist auf 16 Uhr verschoben."
    }));
    delayed.release();
    const [created, changed] = await Promise.all([first, second]);

    expect(changed.event).toMatchObject({ id: created.event?.id, status: "changed" });
  });
});
