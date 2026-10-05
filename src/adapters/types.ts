import type { IncomingMessage } from "../domain/types.js";

/**
 * The semantic operation represented by an adapter callback. The message itself
 * remains the domain's `IncomingMessage`; operation-specific facts live here so
 * consumers cannot mistake an edit, deletion, or history record for new chat
 * content.
 */
export type AdapterMessageEventType =
  | "new"
  | "history"
  | "upsert"
  | "edit"
  | "delete"
  | "reaction";

export type AdapterTransport = "business_cloud" | "personal_linked_device";

export type TimestampProvenance = "source" | "observed";

export interface ReactionMetadata {
  /** Undefined when WhatsApp reports a removed reaction. */
  readonly emoji?: string;
  readonly removed: boolean;
}

/**
 * Metadata accompanying every normalized message. It intentionally contains no
 * credential, QR, or raw payload material. Idempotency is deliberately left to
 * the receiving persistence callback, where a canonical message identity exists.
 */
export interface AdapterMessageContext {
  readonly transport: AdapterTransport;
  readonly eventType: AdapterMessageEventType;
  readonly sourceEvent: string;
  readonly isHistorical: boolean;
  readonly timestampProvenance: TimestampProvenance;
  readonly rawPayloadHash?: string;
  readonly upsertType?: "notify" | "append";
  readonly historySyncType?: number;
  readonly historyIsLatest?: boolean;
  readonly requestId?: string;
  readonly targetMessageId?: string;
  readonly targetChatId?: string;
  readonly targetSenderId?: string;
  readonly reaction?: ReactionMetadata;
  /** A Business Cloud media identifier, not a download URL or bearer token. */
  readonly mediaId?: string;
  readonly businessPhoneNumberId?: string;
}

export interface NormalizedIncomingMessage {
  readonly message: IncomingMessage;
  readonly context: AdapterMessageContext;
}

export type MaybePromise<T> = T | Promise<T>;

/**
 * The callback boundary deliberately preserves the canonical domain message
 * type. Storage can apply its own transaction and deduplication policy here.
 */
export type IncomingMessageHandler = (
  message: IncomingMessage,
  context: AdapterMessageContext
) => MaybePromise<void>;

export type AdapterErrorCode =
  | "incoming_handler_failed"
  | "credentials_persist_failed"
  | "live_gate_failed"
  | "web_version_unavailable"
  | "socket_start_failed";

/** Safe-to-log adapter error information; no exception or payload is exposed. */
export interface AdapterError {
  readonly code: AdapterErrorCode;
  readonly eventType?: AdapterMessageEventType;
}

export type AdapterErrorHandler = (error: AdapterError) => void;
