export const messageKinds = [
  "text",
  "voice",
  "audio",
  "image",
  "document",
  "video",
  "sticker",
  "location",
  "contact",
  "poll",
  "reaction",
  "unknown"
] as const;

export type MessageKind = (typeof messageKinds)[number];

export const messageSources = [
  "synthetic",
  "live_notify",
  "history_sync",
  "chat_export",
  "business_webhook"
] as const;

export type MessageSource = (typeof messageSources)[number];

export const processingStatuses = [
  "pending",
  "processed",
  "unsupported",
  "media_unavailable",
  "transcription_failed",
  "transcription_uncertain",
  "blocked"
] as const;

export type ProcessingStatus = (typeof processingStatuses)[number];

export const eventStatuses = [
  "proposed",
  "tentative",
  "confirmed",
  "changed",
  "cancelled",
  "completed",
  "uncertain",
  "pending_resolution",
  "superseded"
] as const;

export type EventStatus = (typeof eventStatuses)[number];

export type EventType = "appointment" | "deadline" | "task" | "reminder";

export interface IncomingMedia {
  mimeType?: string;
  bytes?: Uint8Array;
  durationSeconds?: number;
  downloadUrl?: string;
  unavailable?: boolean;
  fixtureTranscript?: FixtureTranscript;
}

export interface FixtureTranscript {
  text: string;
  language: "de" | "en" | "unknown";
  confidence: number;
  segments: TranscriptSegment[];
}

export interface TranscriptSegment {
  id?: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
  confidence: number;
}

export interface IncomingMessage {
  messageId: string;
  chatId: string;
  senderId: string;
  fromMe: boolean;
  timestamp: string;
  source: MessageSource;
  /** Explicit provenance flag for history and local export imports. */
  isHistorical?: boolean;
  kind: MessageKind;
  text?: string;
  media?: IncomingMedia;
  quotedMessageId?: string;
  isEdit?: boolean;
  isDelete?: boolean;
  rawPayloadHash?: string;
}

export interface PersistedMessage {
  canonicalId: string;
  messageId: string;
  chatId: string;
  senderId: string;
  fromMe: boolean;
  occurredAt: string;
  receivedAt: string;
  source: MessageSource;
  isHistorical: boolean;
  kind: MessageKind;
  rawPayloadHash: string;
  processingStatus: ProcessingStatus;
  mediaStatus: "none" | "pending" | "available" | "unavailable" | "unsupported";
  contentCiphertext?: string;
  contentIv?: string;
  contentAuthTag?: string;
  quotedMessageId?: string;
  deletedAt?: string;
  revision: number;
}

export interface TranscriptRecord {
  id: string;
  messageCanonicalId: string;
  textCiphertext: string;
  iv: string;
  authTag: string;
  language: "de" | "en" | "unknown";
  confidence: number;
  segments: TranscriptSegment[];
  status: "completed" | "failed" | "uncertain";
  createdAt: string;
}

export interface TimeResolution {
  startsAt?: string;
  timezone: string;
  confidence: number;
  rationale: string;
  language: "de" | "en" | "unknown";
}

export interface EventCandidate {
  type: EventType;
  title: string;
  status: EventStatus;
  time: TimeResolution;
  participants?: string[];
  location?: string;
  sourceMessageIds: string[];
  sourceTranscriptSegmentIds?: string[];
}

export interface DetectedEvent {
  id: string;
  chatId: string;
  type: EventType;
  title: string;
  startsAt?: string;
  endsAt?: string;
  timezone: string;
  location?: string;
  participants?: string[];
  status: EventStatus;
  confidence: number;
  sourceMessageIds: string[];
  sourceTranscriptSegmentIds?: string[];
  supersedesEventId?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  notificationEligible: boolean;
  resolutionRationale: string;
}

export interface ReminderRecord {
  id: string;
  eventId: string;
  eventVersion: number;
  dueAt: string;
  kind: "event_created" | "event_changed" | "event_cancelled" | "event_due" | "recovery";
  status: "scheduled" | "sending" | "sent" | "cancelled" | "skipped";
  deliveryKey: string;
  createdAt: string;
  sentAt?: string;
}

export interface NotificationPayload {
  title: string;
  body: string;
  eventId: string;
  eventVersion: number;
  kind: ReminderRecord["kind"];
  deliveryKey: string;
}

export interface ProcessResult {
  accepted: boolean;
  deduplicated: boolean;
  canonicalId?: string;
  event?: DetectedEvent;
  reason?: "not_allowlisted" | "duplicate" | "kill_switch" | "unsupported" | "invalid";
}

export interface HealthSnapshot {
  status: "ready" | "blocked" | "degraded";
  adapter: "synthetic" | "personal_linked_device" | "business_cloud";
  liveImportEnabled: boolean;
  allowlistedChatCount: number;
  liveGateReasons?: string[];
  lastIngestAt?: string;
  lastErrorCode?: string;
  lastConnectionFailureCode?: number;
}
