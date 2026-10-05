import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { FieldEncryptor } from "../src/security/crypto.js";
import { SqliteMessageStore } from "../src/storage/sqlite-store.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("legacy transcript segment migration", () => {
  it("encrypts and purges legacy plaintext segment text from SQLite and WAL", () => {
    const directory = mkdtempSync(join(tmpdir(), "wci-legacy-transcript-"));
    directories.push(directory);
    const path = join(directory, "chat-intelligence.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE transcripts (
        id TEXT PRIMARY KEY,
        message_canonical_id TEXT NOT NULL,
        text_ciphertext TEXT NOT NULL,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        language TEXT NOT NULL,
        confidence REAL NOT NULL,
        segments_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    legacy.prepare(`
      INSERT INTO transcripts (id, message_canonical_id, text_ciphertext, iv, auth_tag, language, confidence, segments_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-1",
      "message-1",
      "legacy-ciphertext",
      "legacy-iv",
      "legacy-tag",
      "de",
      0.9,
      JSON.stringify([{ text: "alte private Segmentworte", startSeconds: 0, endSeconds: 1, confidence: 0.9 }]),
      "completed",
      "2026-01-01T00:00:00.000Z"
    );
    legacy.close();

    const store = new SqliteMessageStore(path, new FieldEncryptor(Buffer.alloc(32, 19).toString("base64")));
    store.initialize();
    store.close();

    const migrated = new DatabaseSync(path);
    const row = migrated.prepare("SELECT segments_json, segments_ciphertext FROM transcripts WHERE id = 'legacy-1'")
      .get() as { segments_json: string; segments_ciphertext: string };
    expect(row.segments_json).toBe("[]");
    expect(row.segments_ciphertext).not.toContain("alte private Segmentworte");
    migrated.close();
    for (const artifact of [path, `${path}-wal`]) {
      if (existsSync(artifact)) expect(readFileSync(artifact)).not.toContain(Buffer.from("alte private Segmentworte"));
    }
  });
});
