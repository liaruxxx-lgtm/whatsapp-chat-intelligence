import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  DetectedEvent,
  EventType,
  IncomingMedia,
  IncomingMessage,
  MessageKind,
  PersistedMessage,
  ProcessingStatus,
  ReminderRecord,
  TranscriptRecord,
  TranscriptSegment
} from "../domain/types.js";
import { FieldEncryptor, sha256 } from "../security/crypto.js";

type ChatKind = "individual" | "group";

export interface SummarizableStoredMessage {
  readonly canonicalId: string;
  readonly occurredAt: string;
  readonly fromMe: boolean;
  readonly kind: MessageKind;
  readonly processingStatus: ProcessingStatus;
  readonly content?: string;
  readonly transcriptStatus?: "completed" | "uncertain";
}

interface SummaryMessageRow {
  canonical_id: string;
  occurred_at: string;
  from_me: number;
  kind: MessageKind;
  processing_status: ProcessingStatus;
  content_ciphertext: string | null;
  content_iv: string | null;
  content_auth_tag: string | null;
  transcript_ciphertext: string | null;
  transcript_iv: string | null;
  transcript_auth_tag: string | null;
  transcript_status: string | null;
}

interface SummarySnapshotRow {
  id: string;
  content_ciphertext: string;
  content_iv: string;
  content_auth_tag: string;
  model_version: string;
  created_at: string;
}

interface StoredEventRow {
  id: string;
  chat_id: string;
  type: EventType;
  title_ciphertext: string;
  title_iv: string;
  title_auth_tag: string;
  starts_at: string | null;
  ends_at: string | null;
  timezone: string;
  location: string | null;
  participants_json: string | null;
  status: DetectedEvent["status"];
  confidence: number;
  source_message_ids_json: string;
  source_transcript_segment_ids_json: string | null;
  supersedes_event_id: string | null;
  created_at: string;
  updated_at: string;
  version: number;
  notification_eligible: number;
  resolution_rationale: string;
}

interface StoredMessageRow {
  canonical_id: string;
  message_id: string;
  chat_id: string;
  sender_id: string;
  from_me: number;
  occurred_at: string;
  received_at: string;
  source: PersistedMessage["source"];
  is_historical: number;
  kind: MessageKind;
  raw_payload_hash: string;
  processing_status: PersistedMessage["processingStatus"];
  media_status: PersistedMessage["mediaStatus"];
  content_ciphertext: string | null;
  content_iv: string | null;
  content_auth_tag: string | null;
  quoted_message_id: string | null;
  deleted_at: string | null;
  revision: number;
}

interface StoredReminderRow {
  id: string;
  event_id: string;
  event_version: number;
  due_at: string;
  kind: ReminderRecord["kind"];
  status: ReminderRecord["status"];
  delivery_key: string;
  created_at: string;
  sent_at: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function chatKind(chatId: string): ChatKind {
  return chatId.endsWith("@g.us") ? "group" : "individual";
}

function canonicalMessageId(input: IncomingMessage, encryptor: FieldEncryptor): string {
  return encryptor.stableToken([input.chatId, input.messageId, input.senderId, input.fromMe ? "1" : "0"].join("\u0000"));
}

function safeRawHash(input: IncomingMessage, encryptor: FieldEncryptor): string {
  const representation = input.rawPayloadHash ?? JSON.stringify({
    messageId: input.messageId,
    chatId: input.chatId,
    senderId: input.senderId,
    fromMe: input.fromMe,
    timestamp: input.timestamp,
    source: input.source,
    isHistorical: input.isHistorical === true || input.source === "history_sync" || input.source === "chat_export",
    kind: input.kind,
    text: input.text,
    quotedMessageId: input.quotedMessageId,
    isEdit: input.isEdit,
    isDelete: input.isDelete,
    media: input.media ? {
      mimeType: input.media.mimeType,
      durationSeconds: input.media.durationSeconds,
      unavailable: input.media.unavailable
    } : undefined
  });
  // A plain SHA-256 of a short message body is vulnerable to offline guessing.
  // Persist a keyed integrity token instead while retaining deterministic replay
  // detection inside this local instance.
  return encryptor.stableToken(representation);
}

function fromJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function optional<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

export class SqliteMessageStore {
  private readonly db: DatabaseSync;
  private closed = false;

  public constructor(
    private readonly databasePath: string,
    private readonly encryptor: FieldEncryptor
  ) {
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
  }

  public initialize(): void {
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 5000;");
    chmodSync(this.databasePath, 0o600);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('individual', 'group')),
        allowlisted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS participants (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        participant_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(chat_id, participant_token)
      );
      CREATE TABLE IF NOT EXISTS messages (
        canonical_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        sender_id TEXT NOT NULL,
        from_me INTEGER NOT NULL,
        occurred_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        source TEXT NOT NULL,
        is_historical INTEGER NOT NULL DEFAULT 0,
        kind TEXT NOT NULL,
        raw_payload_hash TEXT NOT NULL,
        processing_status TEXT NOT NULL,
        media_status TEXT NOT NULL,
        content_ciphertext TEXT,
        content_iv TEXT,
        content_auth_tag TEXT,
        quoted_message_id TEXT,
        deleted_at TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        UNIQUE(chat_id, message_id, sender_id, from_me)
      );
      CREATE TABLE IF NOT EXISTS message_revisions (
        id TEXT PRIMARY KEY,
        message_canonical_id TEXT NOT NULL REFERENCES messages(canonical_id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        content_ciphertext TEXT,
        content_iv TEXT,
        content_auth_tag TEXT,
        changed_at TEXT NOT NULL,
        reason TEXT NOT NULL,
        UNIQUE(message_canonical_id, revision)
      );
      CREATE TABLE IF NOT EXISTS media_assets (
        id TEXT PRIMARY KEY,
        message_canonical_id TEXT NOT NULL REFERENCES messages(canonical_id) ON DELETE CASCADE,
        mime_type TEXT,
        byte_length INTEGER,
        duration_seconds REAL,
        sha256 TEXT,
        local_path_ciphertext TEXT,
        local_path_iv TEXT,
        local_path_auth_tag TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(message_canonical_id)
      );
      CREATE TABLE IF NOT EXISTS transcripts (
        id TEXT PRIMARY KEY,
        message_canonical_id TEXT NOT NULL REFERENCES messages(canonical_id) ON DELETE CASCADE,
        text_ciphertext TEXT NOT NULL,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        language TEXT NOT NULL,
        confidence REAL NOT NULL,
        -- Compatibility placeholder only; it is always the literal empty array
        -- so no transcript segment text can be stored in this column.
        segments_json TEXT NOT NULL DEFAULT '[]',
        segments_ciphertext TEXT NOT NULL,
        segments_iv TEXT NOT NULL,
        segments_auth_tag TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(message_canonical_id)
      );
      CREATE TABLE IF NOT EXISTS summary_snapshots (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        content_ciphertext TEXT NOT NULL,
        content_iv TEXT NOT NULL,
        content_auth_tag TEXT NOT NULL,
        source_message_ids_json TEXT NOT NULL,
        model_version TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS facts (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        value_ciphertext TEXT NOT NULL,
        value_iv TEXT NOT NULL,
        value_auth_tag TEXT NOT NULL,
        source_message_ids_json TEXT NOT NULL,
        confidence REAL NOT NULL,
        status TEXT NOT NULL,
        parser_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        title_ciphertext TEXT NOT NULL,
        title_iv TEXT NOT NULL,
        title_auth_tag TEXT NOT NULL,
        status TEXT NOT NULL,
        due_at TEXT,
        source_message_ids_json TEXT NOT NULL,
        confidence REAL NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS detected_events (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        topic_token TEXT NOT NULL,
        title_ciphertext TEXT NOT NULL,
        title_iv TEXT NOT NULL,
        title_auth_tag TEXT NOT NULL,
        starts_at TEXT,
        ends_at TEXT,
        timezone TEXT NOT NULL,
        location TEXT,
        participants_json TEXT,
        status TEXT NOT NULL,
        confidence REAL NOT NULL,
        source_message_ids_json TEXT NOT NULL,
        source_transcript_segment_ids_json TEXT,
        supersedes_event_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL,
        notification_eligible INTEGER NOT NULL,
        resolution_rationale TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_detected_events_chat_active ON detected_events(chat_id, type, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_detected_events_topic ON detected_events(chat_id, type, topic_token, updated_at DESC);
      CREATE TABLE IF NOT EXISTS event_revisions (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES detected_events(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        snapshot_ciphertext TEXT NOT NULL,
        snapshot_iv TEXT NOT NULL,
        snapshot_auth_tag TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(event_id, version)
      );
      CREATE TABLE IF NOT EXISTS reminders (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES detected_events(id) ON DELETE CASCADE,
        event_version INTEGER NOT NULL,
        due_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        delivery_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        sent_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status, due_at);
      CREATE TABLE IF NOT EXISTS notification_deliveries (
        delivery_key TEXT PRIMARY KEY,
        reminder_id TEXT NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
        sent_at TEXT NOT NULL,
        channel TEXT NOT NULL,
        recovery_reason TEXT
      );
      CREATE TABLE IF NOT EXISTS processing_jobs (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        message_canonical_id TEXT REFERENCES messages(canonical_id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        target_id TEXT,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.ensureMessageHistoricalColumn();
    this.migrateLegacyTranscriptSegments();
    this.secureDatabaseFiles();
  }

  public close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  public addToAllowlist(chatId: string): void {
    const at = nowIso();
    this.db.prepare(`
      INSERT INTO chats (id, kind, allowlisted, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET allowlisted = 1, updated_at = excluded.updated_at
    `).run(chatId, chatKind(chatId), at, at);
    this.writeAudit("allowlist_added", chatId, { kind: chatKind(chatId) });
  }

  public removeFromAllowlist(chatId: string): void {
    this.db.prepare("UPDATE chats SET allowlisted = 0, updated_at = ? WHERE id = ?").run(nowIso(), chatId);
    this.writeAudit("allowlist_removed", chatId, {});
  }

  /** Deletes one chat and all FK-linked private records, never another chat. */
  public deleteChat(chatId: string): boolean {
    const result = this.db.prepare("DELETE FROM chats WHERE id = ?").run(chatId) as { changes?: number };
    if ((result.changes ?? 0) > 0) this.writeAudit("chat_deleted", chatId, {});
    return (result.changes ?? 0) > 0;
  }

  public isAllowlisted(chatId: string): boolean {
    const row = this.db.prepare("SELECT allowlisted FROM chats WHERE id = ?").get(chatId) as { allowlisted?: number } | undefined;
    return row?.allowlisted === 1;
  }

  public countAllowlistedChats(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM chats WHERE allowlisted = 1").get() as { count: number };
    return row.count;
  }

  public listAllowlistedChats(): Array<{ id: string; kind: ChatKind }> {
    return this.db.prepare("SELECT id, kind FROM chats WHERE allowlisted = 1 ORDER BY id").all() as Array<{ id: string; kind: ChatKind }>;
  }

  public persistIncoming(input: IncomingMessage): { inserted: boolean; message: PersistedMessage } {
    const canonicalId = canonicalMessageId(input, this.encryptor);
    const existing = this.db.prepare("SELECT * FROM messages WHERE canonical_id = ?").get(canonicalId) as StoredMessageRow | undefined;
    if (existing) return { inserted: false, message: this.toPersistedMessage(existing) };

    const at = nowIso();
    const text = input.text === undefined ? undefined : this.encryptor.encrypt(input.text);
    const mediaStatus: PersistedMessage["mediaStatus"] = input.media
      ? input.media.unavailable ? "unavailable" : "pending"
      : input.kind === "text" ? "none" : "unsupported";
    const isHistorical = input.isHistorical === true || input.source === "history_sync" || input.source === "chat_export";
    const status: PersistedMessage["processingStatus"] = input.isDelete ? "processed" : "pending";

    this.db.prepare(`
      INSERT INTO chats (id, kind, allowlisted, created_at, updated_at)
      VALUES (?, ?, 0, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(input.chatId, chatKind(input.chatId), at, at);
    this.db.prepare("INSERT OR IGNORE INTO participants (id, chat_id, participant_token, created_at) VALUES (?, ?, ?, ?)")
      .run(randomUUID(), input.chatId, this.encryptor.stableToken(input.senderId), at);
    this.db.prepare(`
      INSERT INTO messages (
        canonical_id, message_id, chat_id, sender_id, from_me, occurred_at, received_at,
        source, is_historical, kind, raw_payload_hash, processing_status, media_status,
        content_ciphertext, content_iv, content_auth_tag, quoted_message_id, deleted_at, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      canonicalId,
      input.messageId,
      input.chatId,
      this.encryptor.stableToken(input.senderId),
      input.fromMe ? 1 : 0,
      input.timestamp,
      at,
      input.source,
      isHistorical ? 1 : 0,
      input.kind,
      safeRawHash(input, this.encryptor),
      status,
      mediaStatus,
      text?.ciphertext ?? null,
      text?.iv ?? null,
      text?.authTag ?? null,
      input.quotedMessageId ?? null,
      input.isDelete ? at : null
    );

    const row = this.db.prepare("SELECT * FROM messages WHERE canonical_id = ?").get(canonicalId) as unknown as StoredMessageRow;
    this.writeAudit("message_persisted", canonicalId, { source: input.source, kind: input.kind });
    return { inserted: true, message: this.toPersistedMessage(row) };
  }

  public getMessage(canonicalId: string): PersistedMessage | undefined {
    const row = this.db.prepare("SELECT * FROM messages WHERE canonical_id = ?").get(canonicalId) as StoredMessageRow | undefined;
    return row ? this.toPersistedMessage(row) : undefined;
  }

  public getMessageText(canonicalId: string): string | undefined {
    const row = this.db.prepare("SELECT content_ciphertext, content_iv, content_auth_tag FROM messages WHERE canonical_id = ?").get(canonicalId) as {
      content_ciphertext: string | null;
      content_iv: string | null;
      content_auth_tag: string | null;
    } | undefined;
    if (!row?.content_ciphertext || !row.content_iv || !row.content_auth_tag) return undefined;
    return this.encryptor.decrypt({ ciphertext: row.content_ciphertext, iv: row.content_iv, authTag: row.content_auth_tag });
  }

  /**
   * Reads only the newest bounded set of non-deleted messages for one chat.
   * Text and successful/uncertain transcripts are decrypted in memory; media
   * bytes, sender identifiers, and attachment paths are never returned.
   */
  public listMessagesForSummary(chatId: string, limit: number): { messages: SummarizableStoredMessage[]; totalCount: number } {
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const totalRow = this.db.prepare("SELECT COUNT(*) AS count FROM messages WHERE chat_id = ? AND deleted_at IS NULL")
      .get(chatId) as { count: number };
    const rows = this.db.prepare(`
      SELECT
        m.canonical_id, m.occurred_at, m.from_me, m.kind, m.processing_status,
        m.content_ciphertext, m.content_iv, m.content_auth_tag,
        t.text_ciphertext AS transcript_ciphertext, t.iv AS transcript_iv,
        t.auth_tag AS transcript_auth_tag, t.status AS transcript_status
      FROM messages m
      LEFT JOIN transcripts t ON t.message_canonical_id = m.canonical_id
      WHERE m.chat_id = ? AND m.deleted_at IS NULL
      ORDER BY m.occurred_at DESC, m.canonical_id DESC
      LIMIT ?
    `).all(chatId, boundedLimit) as unknown as SummaryMessageRow[];

    const messages = rows.reverse().map((row): SummarizableStoredMessage => {
      let content: string | undefined;
      let transcriptStatus: SummarizableStoredMessage["transcriptStatus"];
      if (row.kind === "text" && row.content_ciphertext && row.content_iv && row.content_auth_tag) {
        content = this.encryptor.decrypt({ ciphertext: row.content_ciphertext, iv: row.content_iv, authTag: row.content_auth_tag });
      } else if ((row.kind === "voice" || row.kind === "audio")
        && row.transcript_ciphertext && row.transcript_iv && row.transcript_auth_tag
        && (row.transcript_status === "completed" || row.transcript_status === "uncertain")) {
        content = this.encryptor.decrypt({ ciphertext: row.transcript_ciphertext, iv: row.transcript_iv, authTag: row.transcript_auth_tag });
        transcriptStatus = row.transcript_status;
      }
      return {
        canonicalId: row.canonical_id,
        occurredAt: row.occurred_at,
        fromMe: row.from_me === 1,
        kind: row.kind,
        processingStatus: row.processing_status,
        ...(content === undefined ? {} : { content }),
        ...(transcriptStatus === undefined ? {} : { transcriptStatus })
      };
    });

    return { messages, totalCount: totalRow.count };
  }

  public markMessageStatus(canonicalId: string, status: PersistedMessage["processingStatus"], mediaStatus?: PersistedMessage["mediaStatus"]): void {
    if (mediaStatus) {
      this.db.prepare("UPDATE messages SET processing_status = ?, media_status = ? WHERE canonical_id = ?").run(status, mediaStatus, canonicalId);
    } else {
      this.db.prepare("UPDATE messages SET processing_status = ? WHERE canonical_id = ?").run(status, canonicalId);
    }
  }

  public applyEdit(canonicalId: string, replacementText: string): boolean {
    const existing = this.db.prepare("SELECT revision FROM messages WHERE canonical_id = ?").get(canonicalId) as { revision: number } | undefined;
    if (!existing) return false;
    const encrypted = this.encryptor.encrypt(replacementText);
    const revision = existing.revision + 1;
    const at = nowIso();
    this.db.prepare(`
      INSERT INTO message_revisions (id, message_canonical_id, revision, content_ciphertext, content_iv, content_auth_tag, changed_at, reason)
      SELECT ?, canonical_id, revision, content_ciphertext, content_iv, content_auth_tag, ?, 'edited'
      FROM messages WHERE canonical_id = ?
    `).run(randomUUID(), at, canonicalId);
    this.db.prepare(`
      UPDATE messages SET content_ciphertext = ?, content_iv = ?, content_auth_tag = ?, revision = ?, processing_status = 'pending'
      WHERE canonical_id = ?
    `).run(encrypted.ciphertext, encrypted.iv, encrypted.authTag, revision, canonicalId);
    this.writeAudit("message_edited", canonicalId, { revision });
    return true;
  }

  public markDeleted(canonicalId: string): boolean {
    const result = this.db.prepare("UPDATE messages SET deleted_at = ?, processing_status = 'processed' WHERE canonical_id = ? AND deleted_at IS NULL")
      .run(nowIso(), canonicalId) as { changes?: number };
    if ((result.changes ?? 0) > 0) this.writeAudit("message_deleted", canonicalId, {});
    return (result.changes ?? 0) > 0;
  }

  public saveMedia(
    messageCanonicalId: string,
    media: IncomingMedia,
    status: "available" | "unavailable" | "unsupported",
    sha?: string,
    localPath?: string
  ): void {
    const at = nowIso();
    const encryptedPath = localPath ? this.encryptor.encrypt(localPath) : undefined;
    this.db.prepare(`
      INSERT INTO media_assets (
        id, message_canonical_id, mime_type, byte_length, duration_seconds, sha256,
        local_path_ciphertext, local_path_iv, local_path_auth_tag, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_canonical_id) DO UPDATE SET
        mime_type = excluded.mime_type,
        byte_length = excluded.byte_length,
        duration_seconds = excluded.duration_seconds,
        sha256 = excluded.sha256,
        local_path_ciphertext = excluded.local_path_ciphertext,
        local_path_iv = excluded.local_path_iv,
        local_path_auth_tag = excluded.local_path_auth_tag,
        status = excluded.status,
        updated_at = excluded.updated_at
    `).run(
      randomUUID(),
      messageCanonicalId,
      media.mimeType ?? null,
      media.bytes?.byteLength ?? null,
      media.durationSeconds ?? null,
      sha ?? (media.bytes ? sha256(media.bytes) : null),
      encryptedPath?.ciphertext ?? null,
      encryptedPath?.iv ?? null,
      encryptedPath?.authTag ?? null,
      status,
      at,
      at
    );
  }

  public saveTranscript(
    messageCanonicalId: string,
    transcript: { text: string; language: TranscriptRecord["language"]; confidence: number; segments: TranscriptSegment[]; status: TranscriptRecord["status"] }
  ): TranscriptRecord {
    const encrypted = this.encryptor.encrypt(transcript.text);
    // Segment text is private transcript content too. Keep the entire segment
    // array in a separate authenticated envelope rather than a JSON column.
    const encryptedSegments = this.encryptor.encrypt(JSON.stringify(transcript.segments));
    const record: TranscriptRecord = {
      id: randomUUID(),
      messageCanonicalId,
      textCiphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      language: transcript.language,
      confidence: transcript.confidence,
      segments: transcript.segments,
      status: transcript.status,
      createdAt: nowIso()
    };
    this.db.prepare(`
      INSERT INTO transcripts (
        id, message_canonical_id, text_ciphertext, iv, auth_tag, language, confidence,
        segments_json, segments_ciphertext, segments_iv, segments_auth_tag, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_canonical_id) DO UPDATE SET
        text_ciphertext = excluded.text_ciphertext,
        iv = excluded.iv,
        auth_tag = excluded.auth_tag,
        language = excluded.language,
        confidence = excluded.confidence,
        segments_json = '[]',
        segments_ciphertext = excluded.segments_ciphertext,
        segments_iv = excluded.segments_iv,
        segments_auth_tag = excluded.segments_auth_tag,
        status = excluded.status,
        created_at = excluded.created_at
    `).run(
      record.id,
      record.messageCanonicalId,
      record.textCiphertext,
      record.iv,
      record.authTag,
      record.language,
      record.confidence,
      "[]",
      encryptedSegments.ciphertext,
      encryptedSegments.iv,
      encryptedSegments.authTag,
      record.status,
      record.createdAt
    );
    this.writeAudit("transcript_saved", messageCanonicalId, { status: record.status, confidence: record.confidence });
    return record;
  }

  public getTranscriptText(messageCanonicalId: string): string | undefined {
    const row = this.db.prepare("SELECT text_ciphertext, iv, auth_tag FROM transcripts WHERE message_canonical_id = ?").get(messageCanonicalId) as {
      text_ciphertext: string;
      iv: string;
      auth_tag: string;
    } | undefined;
    return row ? this.encryptor.decrypt({ ciphertext: row.text_ciphertext, iv: row.iv, authTag: row.auth_tag }) : undefined;
  }

  public getLatestResolvableEvent(chatId: string, type: EventType = "appointment"): DetectedEvent | undefined {
    const row = this.db.prepare(`
      SELECT * FROM detected_events
      WHERE chat_id = ? AND type = ? AND status NOT IN ('cancelled', 'completed', 'superseded')
      ORDER BY updated_at DESC LIMIT 1
    `).get(chatId, type) as StoredEventRow | undefined;
    return row ? this.toDetectedEvent(row) : undefined;
  }

  /** Active logical events only; callers must resolve ambiguity rather than pick by recency. */
  public listResolvableEvents(chatId: string, type: EventType = "appointment"): DetectedEvent[] {
    const rows = this.db.prepare(`
      SELECT * FROM detected_events
      WHERE chat_id = ? AND type = ? AND status NOT IN ('cancelled', 'completed', 'superseded')
      ORDER BY updated_at DESC
    `).all(chatId, type) as unknown as StoredEventRow[];
    return rows.map((row) => this.toDetectedEvent(row));
  }

  public getLatestResolvableEventByTopic(chatId: string, type: EventType, title: string): DetectedEvent | undefined {
    const token = this.encryptor.stableToken(title.trim().toLocaleLowerCase("de-DE"));
    const row = this.db.prepare(`
      SELECT * FROM detected_events
      WHERE chat_id = ? AND type = ? AND topic_token = ? AND status NOT IN ('cancelled', 'completed', 'superseded')
      ORDER BY updated_at DESC LIMIT 1
    `).get(chatId, type, token) as StoredEventRow | undefined;
    return row ? this.toDetectedEvent(row) : undefined;
  }

  /** Used only for a clearly matching reactivation after an explicit cancellation. */
  public getLatestEventByTopic(chatId: string, type: EventType, title: string): DetectedEvent | undefined {
    const token = this.encryptor.stableToken(title.trim().toLocaleLowerCase("de-DE"));
    const row = this.db.prepare(`
      SELECT * FROM detected_events
      WHERE chat_id = ? AND type = ? AND topic_token = ?
      ORDER BY updated_at DESC LIMIT 1
    `).get(chatId, type, token) as StoredEventRow | undefined;
    return row ? this.toDetectedEvent(row) : undefined;
  }

  public getEvent(eventId: string): DetectedEvent | undefined {
    const row = this.db.prepare("SELECT * FROM detected_events WHERE id = ?").get(eventId) as StoredEventRow | undefined;
    return row ? this.toDetectedEvent(row) : undefined;
  }

  public listEvents(chatId?: string): DetectedEvent[] {
    const rows = chatId
      ? this.db.prepare("SELECT * FROM detected_events WHERE chat_id = ? ORDER BY updated_at").all(chatId) as unknown as StoredEventRow[]
      : this.db.prepare("SELECT * FROM detected_events ORDER BY updated_at").all() as unknown as StoredEventRow[];
    return rows.map((row) => this.toDetectedEvent(row));
  }

  public saveEvent(event: DetectedEvent): void {
    const encryptedTitle = this.encryptor.encrypt(event.title);
    const snapshot = this.encryptor.encrypt(JSON.stringify(event));
    this.db.prepare(`
      INSERT INTO detected_events (
        id, chat_id, type, topic_token, title_ciphertext, title_iv, title_auth_tag, starts_at, ends_at, timezone, location,
        participants_json, status, confidence, source_message_ids_json, source_transcript_segment_ids_json,
        supersedes_event_id, created_at, updated_at, version, notification_eligible, resolution_rationale
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        topic_token = excluded.topic_token,
        title_ciphertext = excluded.title_ciphertext,
        title_iv = excluded.title_iv,
        title_auth_tag = excluded.title_auth_tag,
        starts_at = excluded.starts_at,
        ends_at = excluded.ends_at,
        timezone = excluded.timezone,
        location = excluded.location,
        participants_json = excluded.participants_json,
        status = excluded.status,
        confidence = excluded.confidence,
        source_message_ids_json = excluded.source_message_ids_json,
        source_transcript_segment_ids_json = excluded.source_transcript_segment_ids_json,
        supersedes_event_id = excluded.supersedes_event_id,
        updated_at = excluded.updated_at,
        version = excluded.version,
        notification_eligible = excluded.notification_eligible,
        resolution_rationale = excluded.resolution_rationale
    `).run(
      event.id,
      event.chatId,
      event.type,
      this.encryptor.stableToken(event.title.trim().toLocaleLowerCase("de-DE")),
      encryptedTitle.ciphertext,
      encryptedTitle.iv,
      encryptedTitle.authTag,
      event.startsAt ?? null,
      event.endsAt ?? null,
      event.timezone,
      event.location ?? null,
      event.participants ? JSON.stringify(event.participants) : null,
      event.status,
      event.confidence,
      JSON.stringify(event.sourceMessageIds),
      event.sourceTranscriptSegmentIds ? JSON.stringify(event.sourceTranscriptSegmentIds) : null,
      event.supersedesEventId ?? null,
      event.createdAt,
      event.updatedAt,
      event.version,
      event.notificationEligible ? 1 : 0,
      event.resolutionRationale
    );
    this.db.prepare(`
      INSERT INTO event_revisions (id, event_id, version, snapshot_ciphertext, snapshot_iv, snapshot_auth_tag, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id, version) DO NOTHING
    `).run(randomUUID(), event.id, event.version, snapshot.ciphertext, snapshot.iv, snapshot.authTag, event.updatedAt);
    this.writeAudit("event_saved", event.id, { type: event.type, status: event.status, version: event.version });
  }

  public scheduleReminder(reminder: ReminderRecord): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO reminders (id, event_id, event_version, due_at, kind, status, delivery_key, created_at, sent_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      reminder.id,
      reminder.eventId,
      reminder.eventVersion,
      reminder.dueAt,
      reminder.kind,
      reminder.status,
      reminder.deliveryKey,
      reminder.createdAt,
      reminder.sentAt ?? null
    ) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }

  public cancelRemindersForEvent(eventId: string, exceptVersion?: number): void {
    if (exceptVersion === undefined) {
      this.db.prepare("UPDATE reminders SET status = 'cancelled' WHERE event_id = ? AND status = 'scheduled'").run(eventId);
    } else {
      this.db.prepare("UPDATE reminders SET status = 'cancelled' WHERE event_id = ? AND event_version != ? AND status = 'scheduled'")
        .run(eventId, exceptVersion);
    }
  }

  public listDueReminders(now: string): ReminderRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM reminders WHERE status = 'scheduled' AND due_at <= ? ORDER BY due_at, id
    `).all(now) as unknown as StoredReminderRow[];
    return rows.map((row) => this.toReminder(row));
  }

  public listScheduledReminders(eventId?: string): ReminderRecord[] {
    const rows = eventId
      ? this.db.prepare("SELECT * FROM reminders WHERE event_id = ? AND status = 'scheduled' ORDER BY due_at").all(eventId) as unknown as StoredReminderRow[]
      : this.db.prepare("SELECT * FROM reminders WHERE status = 'scheduled' ORDER BY due_at").all() as unknown as StoredReminderRow[];
    return rows.map((row) => this.toReminder(row));
  }

  public hasDelivered(deliveryKey: string): boolean {
    return Boolean(this.db.prepare("SELECT delivery_key FROM notification_deliveries WHERE delivery_key = ?").get(deliveryKey));
  }

  /**
   * Reserve a due notification before invoking the external macOS bridge. A
   * failed bridge releases the reservation; a restart requeues it below.
   */
  public claimReminderForDelivery(reminderId: string): boolean {
    const result = this.db.prepare("UPDATE reminders SET status = 'sending' WHERE id = ? AND status = 'scheduled'")
      .run(reminderId) as { changes?: number };
    return (result.changes ?? 0) === 1;
  }

  public releaseReminderDeliveryClaim(reminderId: string): void {
    this.db.prepare("UPDATE reminders SET status = 'scheduled' WHERE id = ? AND status = 'sending'").run(reminderId);
  }

  /** A process may have stopped after claiming but before invoking macOS. */
  public requeueInFlightReminderClaims(): void {
    this.db.prepare("UPDATE reminders SET status = 'scheduled' WHERE status = 'sending'").run();
  }

  public markReminderDelivered(reminder: ReminderRecord, channel: string, recoveryReason?: string): boolean {
    const at = nowIso();
    let recorded = false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const record = this.db.prepare(`
        INSERT OR IGNORE INTO notification_deliveries (delivery_key, reminder_id, sent_at, channel, recovery_reason)
        VALUES (?, ?, ?, ?, ?)
      `).run(reminder.deliveryKey, reminder.id, at, channel, recoveryReason ?? null) as { changes?: number };
      const marked = this.db.prepare("UPDATE reminders SET status = 'sent', sent_at = ? WHERE id = ? AND status = 'sending'")
        .run(at, reminder.id) as { changes?: number };
      this.db.exec("COMMIT");
      recorded = (record.changes ?? 0) === 1 && (marked.changes ?? 0) === 1;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (!recorded) return false;
    this.writeAudit("notification_delivered", reminder.eventId, { kind: reminder.kind, version: reminder.eventVersion });
    return true;
  }

  public markReminderSkipped(reminderId: string): void {
    this.db.prepare("UPDATE reminders SET status = 'skipped' WHERE id = ? AND status = 'scheduled'").run(reminderId);
  }

  public createSummarySnapshot(chatId: string, summary: object, sourceMessageIds: string[], modelVersion = "deterministic-v1"): string {
    const encrypted = this.encryptor.encrypt(JSON.stringify(summary));
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO summary_snapshots (id, chat_id, content_ciphertext, content_iv, content_auth_tag, source_message_ids_json, model_version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, chatId, encrypted.ciphertext, encrypted.iv, encrypted.authTag, JSON.stringify(sourceMessageIds), modelVersion, nowIso());
    return id;
  }

  public getLatestSummarySnapshot(chatId: string, modelVersionPrefix = "openai:"): {
    id: string;
    summary: unknown;
    modelVersion: string;
    createdAt: string;
  } | undefined {
    const row = this.db.prepare(`
      SELECT id, content_ciphertext, content_iv, content_auth_tag, model_version, created_at
      FROM summary_snapshots
      WHERE chat_id = ? AND model_version LIKE ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(chatId, `${modelVersionPrefix.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`) as SummarySnapshotRow | undefined;
    if (!row) return undefined;
    const decoded = this.encryptor.decrypt({ ciphertext: row.content_ciphertext, iv: row.content_iv, authTag: row.content_auth_tag });
    let summary: unknown;
    try {
      summary = JSON.parse(decoded) as unknown;
    } catch {
      return undefined;
    }
    return { id: row.id, summary, modelVersion: row.model_version, createdAt: row.created_at };
  }

  public enqueueJob(chatId: string, messageCanonicalId: string | undefined, kind: string, availableAt = nowIso()): string {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO processing_jobs (id, chat_id, message_canonical_id, kind, status, attempts, available_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?)
    `).run(id, chatId, messageCanonicalId ?? null, kind, availableAt, nowIso(), nowIso());
    return id;
  }

  public failJob(id: string, errorCode: string, retryAt: string): void {
    this.db.prepare(`
      UPDATE processing_jobs SET attempts = attempts + 1, status = 'retry', available_at = ?, last_error_code = ?, updated_at = ? WHERE id = ?
    `).run(retryAt, errorCode, nowIso(), id);
  }

  public completeJob(id: string): void {
    this.db.prepare("UPDATE processing_jobs SET status = 'completed', updated_at = ? WHERE id = ?").run(nowIso(), id);
  }

  public purgeBefore(cutoff: string): void {
    this.db.prepare("DELETE FROM messages WHERE occurred_at < ?").run(cutoff);
    this.db.prepare("DELETE FROM summary_snapshots WHERE created_at < ?").run(cutoff);
    this.db.prepare("DELETE FROM audit_log WHERE created_at < ?").run(cutoff);
    this.writeAudit("retention_purged", null, { cutoff });
  }

  /** Flush WAL state before a read-only encrypted-data backup is copied. */
  public checkpointForBackup(): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    this.secureDatabaseFiles();
  }

  /** Decrypts only internal vault paths; callers must not expose these externally. */
  public listStoredMediaPaths(): string[] {
    const rows = this.db.prepare(`
      SELECT local_path_ciphertext, local_path_iv, local_path_auth_tag
      FROM media_assets
      WHERE local_path_ciphertext IS NOT NULL AND local_path_iv IS NOT NULL AND local_path_auth_tag IS NOT NULL
    `).all() as Array<{ local_path_ciphertext: string; local_path_iv: string; local_path_auth_tag: string }>;
    const paths: string[] = [];
    for (const row of rows) {
      try {
        paths.push(this.encryptor.decrypt({
          ciphertext: row.local_path_ciphertext,
          iv: row.local_path_iv,
          authTag: row.local_path_auth_tag
        }));
      } catch {
        // A damaged path envelope cannot authorize deletion of any vault file.
      }
    }
    return paths;
  }

  public eraseInstance(): void {
    this.db.exec(`
      DELETE FROM notification_deliveries;
      DELETE FROM reminders;
      DELETE FROM event_revisions;
      DELETE FROM detected_events;
      DELETE FROM transcripts;
      DELETE FROM media_assets;
      DELETE FROM message_revisions;
      DELETE FROM messages;
      DELETE FROM participants;
      DELETE FROM facts;
      DELETE FROM tasks;
      DELETE FROM summary_snapshots;
      DELETE FROM processing_jobs;
      DELETE FROM chats;
      DELETE FROM audit_log;
      VACUUM;
    `);
  }

  public count(table: "messages" | "transcripts" | "summary_snapshots" | "detected_events" | "reminders" | "audit_log"): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    return row.count;
  }

  private toPersistedMessage(row: StoredMessageRow): PersistedMessage {
    const result: PersistedMessage = {
      canonicalId: row.canonical_id,
      messageId: row.message_id,
      chatId: row.chat_id,
      senderId: row.sender_id,
      fromMe: row.from_me === 1,
      occurredAt: row.occurred_at,
      receivedAt: row.received_at,
      source: row.source,
      isHistorical: row.is_historical === 1,
      kind: row.kind,
      rawPayloadHash: row.raw_payload_hash,
      processingStatus: row.processing_status,
      mediaStatus: row.media_status,
      revision: row.revision
    };
    if (row.content_ciphertext) result.contentCiphertext = row.content_ciphertext;
    if (row.content_iv) result.contentIv = row.content_iv;
    if (row.content_auth_tag) result.contentAuthTag = row.content_auth_tag;
    if (row.quoted_message_id) result.quotedMessageId = row.quoted_message_id;
    if (row.deleted_at) result.deletedAt = row.deleted_at;
    return result;
  }

  private toDetectedEvent(row: StoredEventRow): DetectedEvent {
    const result: DetectedEvent = {
      id: row.id,
      chatId: row.chat_id,
      type: row.type,
      title: this.encryptor.decrypt({ ciphertext: row.title_ciphertext, iv: row.title_iv, authTag: row.title_auth_tag }),
      timezone: row.timezone,
      status: row.status,
      confidence: row.confidence,
      sourceMessageIds: fromJson<string[]>(row.source_message_ids_json, []),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      version: row.version,
      notificationEligible: row.notification_eligible === 1,
      resolutionRationale: row.resolution_rationale
    };
    const startsAt = optional(row.starts_at);
    const endsAt = optional(row.ends_at);
    const location = optional(row.location);
    const participants = fromJson<string[] | undefined>(row.participants_json, undefined);
    const transcriptSegments = fromJson<string[] | undefined>(row.source_transcript_segment_ids_json, undefined);
    const supersedesEventId = optional(row.supersedes_event_id);
    if (startsAt) result.startsAt = startsAt;
    if (endsAt) result.endsAt = endsAt;
    if (location) result.location = location;
    if (participants) result.participants = participants;
    if (transcriptSegments) result.sourceTranscriptSegmentIds = transcriptSegments;
    if (supersedesEventId) result.supersedesEventId = supersedesEventId;
    return result;
  }

  private toReminder(row: StoredReminderRow): ReminderRecord {
    const result: ReminderRecord = {
      id: row.id,
      eventId: row.event_id,
      eventVersion: row.event_version,
      dueAt: row.due_at,
      kind: row.kind,
      status: row.status,
      deliveryKey: row.delivery_key,
      createdAt: row.created_at
    };
    if (row.sent_at) result.sentAt = row.sent_at;
    return result;
  }

  private writeAudit(action: string, targetId: string | null, metadata: Record<string, string | number | boolean>): void {
    this.db.prepare("INSERT INTO audit_log (id, action, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), action, targetId, JSON.stringify(metadata), nowIso());
  }

  private ensureMessageHistoricalColumn(): void {
    const columns = this.db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "is_historical")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN is_historical INTEGER NOT NULL DEFAULT 0");
    }
  }

  /**
   * Version-one development databases stored segment arrays in `segments_json`.
   * The arrays include transcript words, so migrate them once and overwrite the
   * legacy cleartext value. New databases retain only an empty compatibility
   * placeholder in that column; segment content is always encrypted.
   */
  private migrateLegacyTranscriptSegments(): void {
    const columns = this.db.prepare("PRAGMA table_info(transcripts)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    const hasLegacySegments = names.has("segments_json");

    for (const column of ["segments_ciphertext", "segments_iv", "segments_auth_tag"]) {
      if (!names.has(column)) {
        this.db.exec(`ALTER TABLE transcripts ADD COLUMN ${column} TEXT`);
      }
    }

    if (!hasLegacySegments) return;
    const rows = this.db.prepare(`
      SELECT message_canonical_id, segments_json
      FROM transcripts
      WHERE segments_ciphertext IS NULL OR segments_iv IS NULL OR segments_auth_tag IS NULL
    `).all() as Array<{ message_canonical_id: string; segments_json: string | null }>;

    const update = this.db.prepare(`
      UPDATE transcripts
      SET segments_ciphertext = ?, segments_iv = ?, segments_auth_tag = ?, segments_json = '[]'
      WHERE message_canonical_id = ?
    `);
    for (const row of rows) {
      let safeSegments = "[]";
      if (row.segments_json) {
        try {
          const parsed = JSON.parse(row.segments_json);
          if (Array.isArray(parsed)) safeSegments = JSON.stringify(parsed);
        } catch {
          // Corrupted legacy metadata is not treated as a transcript source.
        }
      }
      const encrypted = this.encryptor.encrypt(safeSegments);
      update.run(encrypted.ciphertext, encrypted.iv, encrypted.authTag, row.message_canonical_id);
    }
    if (rows.length > 0) {
      // Rebuild the database and truncate WAL so retired plaintext pages from
      // the legacy column are not retained as recoverable slack space.
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;");
    }
  }

  private secureDatabaseFiles(): void {
    for (const path of [this.databasePath, `${this.databasePath}-wal`, `${this.databasePath}-shm`]) {
      if (existsSync(path)) chmodSync(path, 0o600);
    }
  }
}
