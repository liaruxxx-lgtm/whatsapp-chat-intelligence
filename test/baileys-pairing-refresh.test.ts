import { describe, expect, it, vi } from "vitest";
import { Browsers, buildPairingQRData } from "@whiskeysockets/baileys";
import {
  handleCompanionRegRefresh,
  makePairingQRRenderer
} from "../node_modules/@whiskeysockets/baileys/lib/Utils/companion-reg-client-utils.js";

function refreshNode(childTag = "companion_reg_refresh"): never {
  return {
    tag: "notification",
    attrs: { id: "fixture", type: "companion_reg_refresh" },
    content: [{ tag: childTag, attrs: {} }]
  } as never;
}

function qrFields(qr: string): string[] {
  return qr.slice(qr.indexOf("#") + 1).split(",");
}

describe("pinned Baileys pairing refresh patch", () => {
  it("rotates the pending advertisement secret and re-renders the current ref", () => {
    const creds = { advSecretKey: "old-secret" };
    const emittedCreds: Array<{ advSecretKey: string }> = [];
    const log = { level: "silent", warn: vi.fn(), debug: vi.fn(), info: vi.fn() } as never;
    const refs = ["first-ref", "second-ref"];
    const rendered: string[] = [];
    let advertisementSecret = creds.advSecretKey;
    const renderer = makePairingQRRenderer(refs, (ref) => {
      rendered.push(buildPairingQRData(ref, "noise-fixture", "identity-fixture", advertisementSecret, Browsers.macOS("Chrome")));
    });

    expect(renderer.next()).toBe(true);
    const first = qrFields(rendered[0]!);
    expect(first[0]).toBe("first-ref");
    expect(first[4]).toBe("1");

    const outcome = handleCompanionRegRefresh(refreshNode(), {
      creds: creds as never,
      emitCredsUpdate: (update) => {
        emittedCreds.push(update as { advSecretKey: string });
        advertisementSecret = update.advSecretKey;
      },
      refreshQR: () => { renderer.refresh(); },
      logger: log
    });

    expect(outcome).toBe("rotated");
    expect(Buffer.from(creds.advSecretKey, "base64")).toHaveLength(32);
    expect(creds.advSecretKey).not.toBe("old-secret");
    expect(emittedCreds).toEqual([{ advSecretKey: creds.advSecretKey }]);
    expect(rendered).toHaveLength(2);
    const refreshed = qrFields(rendered[1]!);
    expect(refreshed[0]).toBe("first-ref");
    expect(refreshed[3]).toBe(creds.advSecretKey);

    expect(renderer.next()).toBe(true);
    expect(qrFields(rendered[2]!)[0]).toBe("second-ref");
    expect(renderer.next()).toBe(false);
  });

  it("ignores malformed refreshes and never rotates a registered session", () => {
    const malformedCreds = { advSecretKey: "unchanged" };
    const malformedRefresh = vi.fn();
    expect(handleCompanionRegRefresh(
      refreshNode("unexpected-child"),
      {
        creds: malformedCreds as never,
        emitCredsUpdate: vi.fn(),
        refreshQR: malformedRefresh,
        logger: { level: "silent", warn: vi.fn(), debug: vi.fn(), info: vi.fn() } as never
      }
    )).toBe("ignored_malformed");
    expect(malformedCreds.advSecretKey).toBe("unchanged");
    expect(malformedRefresh).not.toHaveBeenCalled();

    const registeredCreds = { advSecretKey: "registered-secret", me: { id: "fixture@s.whatsapp.net" } };
    const registeredRefresh = vi.fn();
    expect(handleCompanionRegRefresh(
      refreshNode(),
      {
        creds: registeredCreds as never,
        emitCredsUpdate: vi.fn(),
        refreshQR: registeredRefresh,
        logger: { level: "silent", warn: vi.fn(), debug: vi.fn(), info: vi.fn() } as never
      }
    )).toBe("ignored_registered");
    expect(registeredCreds.advSecretKey).toBe("registered-secret");
    expect(registeredRefresh).not.toHaveBeenCalled();
  });
});
