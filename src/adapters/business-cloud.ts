import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { IncomingMedia, IncomingMessage, MessageKind } from "../domain/types.js";
import type {
  AdapterMessageContext,
  IncomingMessageHandler,
  NormalizedIncomingMessage,
  ReactionMetadata
} from "./types.js";

export type WebhookBody = string | Uint8Array;
export type WebhookSignatureHeader = string | readonly string[] | undefined;

export interface BusinessCloudAdapterConfig {
  /** The Meta app secret. Keep it outside source control. */
  readonly appSecret: string | Uint8Array;
  /**
   * Receives every valid normalized delivery. This adapter intentionally keeps
   * no seen-ID cache: persistence owns idempotency and transactional retries.
   */
  readonly onIncomingMessage: IncomingMessageHandler;
}

export interface BusinessCloudWebhookResult {
  readonly accepted: boolean;
  readonly signatureValid: boolean;
  readonly received: number;
  readonly delivered: number;
  readonly ignored: number;
  readonly reason?: "invalid_signature" | "invalid_payload";
}

interface BusinessCloudMessageOptions {
  readonly rawPayloadHash?: string;
  readonly businessPhoneNumberId?: string;
}

type JsonObject = Record<string, unknown>;

/**
 * Verifies the `X-Hub-Signature-256` value against the exact, unparsed request
 * bytes. JSON must only be parsed after this returns true.
 */
export function verifyBusinessCloudSignature(
  rawBody: WebhookBody,
  signatureHeader: WebhookSignatureHeader,
  appSecret: string | Uint8Array
): boolean {
  const signature = signatureFromHeader(signatureHeader);
  const secret = toBuffer(appSecret);

  if (signature === undefined || secret.byteLength === 0) {
    return false;
  }

  const expected = createHmac("sha256", secret).update(toBuffer(rawBody)).digest();
  const supplied = Buffer.from(signature, "hex");

  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
}

/** SHA-256 of request bytes for traceability without retaining request content. */
export function hashBusinessCloudPayload(rawBody: WebhookBody): string {
  return createHash("sha256").update(toBuffer(rawBody)).digest("hex");
}

/**
 * Pure normalizer for verified Business Cloud webhook bodies. Unknown records
 * are ignored rather than coerced into fabricated messages.
 */
export function normalizeBusinessCloudWebhook(
  payload: unknown,
  rawPayloadHash?: string
): NormalizedIncomingMessage[] {
  const webhook = asObject(payload);
  if (webhook === undefined) {
    return [];
  }

  const normalized: NormalizedIncomingMessage[] = [];

  for (const entry of readArray(webhook, "entry")) {
    const entryObject = asObject(entry);
    if (entryObject === undefined) {
      continue;
    }

    for (const change of readArray(entryObject, "changes")) {
      const changeObject = asObject(change);
      if (changeObject === undefined || changeObject.field !== "messages") {
        continue;
      }

      const value = asObject(changeObject.value);
      if (value === undefined) {
        continue;
      }

      const metadata = asObject(value.metadata);
      const businessPhoneNumberId = metadata === undefined
        ? undefined
        : nonEmptyString(metadata.phone_number_id);

      for (const candidate of readArray(value, "messages")) {
        const message = normalizeBusinessCloudMessage(candidate, {
          ...(rawPayloadHash === undefined ? {} : { rawPayloadHash }),
          ...(businessPhoneNumberId === undefined ? {} : { businessPhoneNumberId })
        });
        if (message !== undefined) {
          normalized.push(message);
        }
      }
    }
  }

  return normalized;
}

/** Normalizes one verified Business Cloud inbound message. */
export function normalizeBusinessCloudMessage(
  candidate: unknown,
  options: BusinessCloudMessageOptions = {}
): NormalizedIncomingMessage | undefined {
  const rawMessage = asObject(candidate);
  if (rawMessage === undefined) {
    return undefined;
  }

  const messageId = nonEmptyString(rawMessage.id);
  const senderId = nonEmptyString(rawMessage.from);
  const timestamp = unixSecondsToIso(rawMessage.timestamp);
  if (messageId === undefined || senderId === undefined || timestamp === undefined) {
    return undefined;
  }

  const messageType = stringValue(rawMessage.type);
  const content = cloudContent(rawMessage, messageType);
  const quotedMessageId = quotedMessageIdFromCloud(rawMessage, content.targetMessageId);
  const eventType = messageType === "reaction" ? "reaction" : "new";

  const message: IncomingMessage = {
    messageId,
    chatId: senderId,
    senderId,
    fromMe: false,
    timestamp,
    source: "business_webhook",
    kind: content.kind
  };
  if (content.text !== undefined) {
    message.text = content.text;
  }
  if (content.media !== undefined) {
    message.media = content.media;
  }
  if (quotedMessageId !== undefined) {
    message.quotedMessageId = quotedMessageId;
  }
  if (options.rawPayloadHash !== undefined) {
    message.rawPayloadHash = options.rawPayloadHash;
  }

  const context: AdapterMessageContext = {
    transport: "business_cloud",
    eventType,
    sourceEvent: "messages",
    isHistorical: false,
    timestampProvenance: "source",
    ...(options.rawPayloadHash === undefined ? {} : { rawPayloadHash: options.rawPayloadHash }),
    ...(content.targetMessageId === undefined ? {} : { targetMessageId: content.targetMessageId }),
    ...(content.reaction === undefined ? {} : { reaction: content.reaction }),
    ...(content.mediaId === undefined ? {} : { mediaId: content.mediaId }),
    ...(options.businessPhoneNumberId === undefined
      ? {}
      : { businessPhoneNumberId: options.businessPhoneNumberId })
  };

  return { message, context };
}

/**
 * A stateless boundary around Meta's webhook. A repeat delivery intentionally
 * invokes `onIncomingMessage` again; the downstream canonical-ID constraint is
 * the only source of truth for idempotency.
 */
export class BusinessCloudAdapter {
  readonly #config: BusinessCloudAdapterConfig;

  constructor(config: BusinessCloudAdapterConfig) {
    this.#config = config;
  }

  async handleWebhook(
    rawBody: WebhookBody,
    signatureHeader: WebhookSignatureHeader
  ): Promise<BusinessCloudWebhookResult> {
    if (!verifyBusinessCloudSignature(rawBody, signatureHeader, this.#config.appSecret)) {
      return {
        accepted: false,
        signatureValid: false,
        received: 0,
        delivered: 0,
        ignored: 0,
        reason: "invalid_signature"
      };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(toBuffer(rawBody).toString("utf8"));
    } catch {
      return {
        accepted: false,
        signatureValid: true,
        received: 0,
        delivered: 0,
        ignored: 0,
        reason: "invalid_payload"
      };
    }

    if (asObject(payload) === undefined) {
      return {
        accepted: false,
        signatureValid: true,
        received: 0,
        delivered: 0,
        ignored: 0,
        reason: "invalid_payload"
      };
    }

    const rawPayloadHash = hashBusinessCloudPayload(rawBody);
    const normalized = normalizeBusinessCloudWebhook(payload, rawPayloadHash);
    for (const delivery of normalized) {
      await this.#config.onIncomingMessage(delivery.message, delivery.context);
    }

    return {
      accepted: true,
      signatureValid: true,
      received: countBusinessCloudMessageCandidates(payload),
      delivered: normalized.length,
      ignored: countBusinessCloudMessageCandidates(payload) - normalized.length
    };
  }
}

interface CloudContent {
  readonly kind: MessageKind;
  readonly text?: string;
  readonly media?: IncomingMedia;
  readonly mediaId?: string;
  readonly targetMessageId?: string;
  readonly reaction?: ReactionMetadata;
}

function cloudContent(rawMessage: JsonObject, type: string | undefined): CloudContent {
  switch (type) {
    case "text": {
      const text = stringAt(rawMessage, "text", "body");
      return { kind: "text", ...(text === undefined ? {} : { text }) };
    }
    case "audio":
      return cloudMediaContent(rawMessage, "audio", booleanAt(rawMessage, "audio", "voice") ? "voice" : "audio");
    case "image":
      return cloudMediaContent(rawMessage, "image", "image");
    case "document":
      return cloudMediaContent(rawMessage, "document", "document");
    case "video":
      return cloudMediaContent(rawMessage, "video", "video");
    case "sticker":
      return cloudMediaContent(rawMessage, "sticker", "sticker");
    case "location":
      return { kind: "location" };
    case "contacts":
      return { kind: "contact" };
    case "poll":
      return { kind: "poll" };
    case "reaction": {
      const targetMessageId = nonEmptyString(objectAt(rawMessage, "reaction")?.message_id);
      const emoji = stringAt(rawMessage, "reaction", "emoji");
      const reaction: ReactionMetadata = emoji === undefined || emoji.length === 0
        ? { removed: true }
        : { emoji, removed: false };
      return {
        kind: "reaction",
        ...(emoji === undefined || emoji.length === 0 ? {} : { text: emoji }),
        ...(targetMessageId === undefined ? {} : { targetMessageId }),
        reaction
      };
    }
    default:
      return { kind: "unknown" };
  }
}

function cloudMediaContent(
  rawMessage: JsonObject,
  field: string,
  kind: MessageKind
): CloudContent {
  const mediaPayload = objectAt(rawMessage, field);
  const mediaId = nonEmptyString(mediaPayload?.id);
  const mimeType = nonEmptyString(mediaPayload?.mime_type);
  const media: IncomingMedia = {
    ...(mimeType === undefined ? {} : { mimeType }),
    ...(mediaId === undefined ? { unavailable: true } : {})
  };

  return {
    kind,
    media,
    ...(mediaId === undefined ? {} : { mediaId })
  };
}

function quotedMessageIdFromCloud(
  rawMessage: JsonObject,
  reactionTargetMessageId: string | undefined
): string | undefined {
  return reactionTargetMessageId ?? nonEmptyString(objectAt(rawMessage, "context")?.id);
}

function countBusinessCloudMessageCandidates(payload: unknown): number {
  const webhook = asObject(payload);
  if (webhook === undefined) {
    return 0;
  }

  let count = 0;
  for (const entry of readArray(webhook, "entry")) {
    const entryObject = asObject(entry);
    if (entryObject === undefined) {
      continue;
    }
    for (const change of readArray(entryObject, "changes")) {
      const changeObject = asObject(change);
      if (changeObject?.field !== "messages") {
        continue;
      }
      const value = asObject(changeObject.value);
      if (value !== undefined) {
        count += readArray(value, "messages").length;
      }
    }
  }
  return count;
}

function signatureFromHeader(header: WebhookSignatureHeader): string | undefined {
  const value = Array.isArray(header)
    ? header.length === 1 ? header[0] : undefined
    : header;
  if (typeof value !== "string") {
    return undefined;
  }

  const match = /^sha256=([a-f0-9]{64})$/i.exec(value);
  return match?.[1];
}

function toBuffer(value: string | Uint8Array): Buffer {
  return typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
}

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function readArray(object: JsonObject, key: string): readonly unknown[] {
  const value = object[key];
  return Array.isArray(value) ? value : [];
}

function objectAt(object: JsonObject, key: string): JsonObject | undefined {
  return asObject(object[key]);
}

function stringAt(object: JsonObject, parent: string, key: string): string | undefined {
  return stringValue(objectAt(object, parent)?.[key]);
}

function booleanAt(object: JsonObject, parent: string, key: string): boolean {
  return objectAt(object, parent)?.[key] === true;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function unixSecondsToIso(value: unknown): string | undefined {
  const seconds = typeof value === "string" && /^\d+$/.test(value)
    ? Number(value)
    : typeof value === "number" ? value : Number.NaN;
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    return undefined;
  }

  const date = new Date(seconds * 1_000);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}
