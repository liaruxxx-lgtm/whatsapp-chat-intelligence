import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EncryptedAuthState } from "../src/adapters/encrypted-auth-state.js";
import { FieldEncryptor } from "../src/security/crypto.js";

const paths: string[] = [];

afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("EncryptedAuthState", () => {
  it("round-trips credentials and Signal keys without plaintext session material", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wci-auth-"));
    paths.push(directory);
    const path = join(directory, "sessions", "personal-auth-state.enc");
    const encryptor = new FieldEncryptor(Buffer.alloc(32, 9).toString("base64"));

    const first = EncryptedAuthState.open(path, encryptor);
    first.applyCreds({ registered: true });
    await first.state.keys.set({ session: { "peer:1": new Uint8Array([3, 4, 5]) } });

    const raw = readFileSync(path, "utf8");
    expect(raw).toContain('"version":1');
    expect(raw).not.toContain('"registered":true');
    expect(raw).not.toContain("peer:1");

    const resumed = EncryptedAuthState.open(path, encryptor);
    expect(resumed.state.creds.registered).toBe(true);
    const session = await resumed.state.keys.get("session", ["peer:1"]);
    expect([...session["peer:1"]!]).toEqual([3, 4, 5]);

    resumed.wipe();
    expect(existsSync(path)).toBe(false);
  });
});
