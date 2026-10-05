import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  BusinessCloudAdapter,
  hashBusinessCloudPayload,
  normalizeBusinessCloudWebhook,
  verifyBusinessCloudSignature
} from "../src/adapters/business-cloud.js";
import type { IncomingMessage } from "../src/domain/types.js";
import type { AdapterMessageContext } from "../src/adapters/types.js";

const secret = "business-cloud-test-secret";

function signedPayload(payload: unknown): { readonly body: string; readonly signature: string } {
  const body = JSON.stringify(payload);
  return {
    body,
    signature: `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`
  };
}

describe("BusinessCloudAdapter", () => {
  it("verifies the exact request bytes before normalizing them", () => {
    const { body, signature } = signedPayload({ entry: [] });

    expect(verifyBusinessCloudSignature(body, signature, secret)).toBe(true);
    expect(verifyBusinessCloudSignature(`${body} `, signature, secret)).toBe(false);
    expect(verifyBusinessCloudSignature(body, "sha256=bad", secret)).toBe(false);
    expect(verifyBusinessCloudSignature(body, signature, "")).toBe(false);
  });

  it("normalizes text, media, and reactions without retaining a media URL", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [{
        changes: [{
          field: "messages",
          value: {
            metadata: { phone_number_id: "phone-id" },
            messages: [
              { id: "text-1", from: "491701234", timestamp: "1704067200", type: "text", text: { body: "Hallo" } },
              { id: "audio-1", from: "491701234", timestamp: "1704067201", type: "audio", audio: { id: "media-1", mime_type: "audio/ogg", voice: true, url: "https://never-forward.example" } },
              { id: "reaction-1", from: "491701234", timestamp: "1704067202", type: "reaction", reaction: { message_id: "text-1", emoji: "👍" } }
            ]
          }
        }]
      }]
    };

    const normalized = normalizeBusinessCloudWebhook(payload, "payload-hash");

    expect(normalized).toHaveLength(3);
    expect(normalized[0]).toMatchObject({
      message: { messageId: "text-1", kind: "text", text: "Hallo", source: "business_webhook" },
      context: { eventType: "new", rawPayloadHash: "payload-hash", businessPhoneNumberId: "phone-id" }
    });
    expect(normalized[1]).toMatchObject({
      message: { messageId: "audio-1", kind: "voice", media: { mimeType: "audio/ogg" } },
      context: { mediaId: "media-1" }
    });
    expect(normalized[1]?.message.media?.downloadUrl).toBeUndefined();
    expect(normalized[2]).toMatchObject({
      message: { messageId: "reaction-1", kind: "reaction", text: "👍", quotedMessageId: "text-1" },
      context: { eventType: "reaction", targetMessageId: "text-1", reaction: { emoji: "👍", removed: false } }
    });
  });

  it("leaves duplicate delivery handling to the receiving callback", async () => {
    const deliveries: Array<{ readonly message: IncomingMessage; readonly context: AdapterMessageContext }> = [];
    const adapter = new BusinessCloudAdapter({
      appSecret: secret,
      onIncomingMessage: (message, context) => {
        deliveries.push({ message, context });
      }
    });
    const payload = {
      entry: [{
        changes: [{
          field: "messages",
          value: {
            messages: [{ id: "repeatable", from: "49170", timestamp: "1704067200", type: "text", text: { body: "Einmal" } }]
          }
        }]
      }]
    };
    const { body, signature } = signedPayload(payload);

    const first = await adapter.handleWebhook(body, signature);
    const second = await adapter.handleWebhook(body, signature);

    expect(first).toMatchObject({ accepted: true, delivered: 1, ignored: 0 });
    expect(second).toMatchObject({ accepted: true, delivered: 1, ignored: 0 });
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]?.message.rawPayloadHash).toBe(hashBusinessCloudPayload(body));
  });

  it("does not parse or invoke the callback for an invalid signature", async () => {
    let deliveries = 0;
    const adapter = new BusinessCloudAdapter({
      appSecret: secret,
      onIncomingMessage: () => {
        deliveries += 1;
      }
    });

    const result = await adapter.handleWebhook("not-json", "sha256=0000000000000000000000000000000000000000000000000000000000000000");

    expect(result).toEqual({
      accepted: false,
      signatureValid: false,
      received: 0,
      delivered: 0,
      ignored: 0,
      reason: "invalid_signature"
    });
    expect(deliveries).toBe(0);
  });
});
