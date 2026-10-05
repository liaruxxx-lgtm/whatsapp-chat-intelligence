import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { FieldEncryptor, sha256, type EncryptedValue } from "../security/crypto.js";

interface EncryptedMediaFile extends EncryptedValue {
  version: 1;
  sha256: string;
  byteLength: number;
}

export interface StoredMedia {
  path: string;
  sha256: string;
  byteLength: number;
}

/**
 * Local raw-media vault. Filenames derive only from hashes, payloads are
 * AES-256-GCM encrypted, and no remote filename/URL is ever used as a path.
 */
export class EncryptedMediaStore {
  public constructor(
    private readonly mediaDir: string,
    private readonly encryptor: FieldEncryptor
  ) {
    mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
  }

  public put(messageCanonicalId: string, bytes: Uint8Array): StoredMedia {
    const hash = sha256(bytes);
    const name = `${sha256(messageCanonicalId).slice(0, 24)}-${hash.slice(0, 24)}.media.enc`;
    const path = join(this.mediaDir, name);
    if (!existsSync(path)) {
      const encrypted = this.encryptor.encryptBytes(bytes);
      const payload: EncryptedMediaFile = { version: 1, sha256: hash, byteLength: bytes.byteLength, ...encrypted };
      const temporary = `${path}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, path);
      chmodSync(path, 0o600);
    }
    return { path, sha256: hash, byteLength: bytes.byteLength };
  }

  public read(path: string): Buffer {
    this.assertMediaPath(path);
    const envelope = JSON.parse(readFileSync(path, "utf8")) as EncryptedMediaFile;
    if (envelope.version !== 1 || !envelope.ciphertext || !envelope.iv || !envelope.authTag) {
      throw new Error("Encrypted media file has an unsupported format");
    }
    const bytes = this.encryptor.decryptBytes(envelope);
    if (sha256(bytes) !== envelope.sha256) throw new Error("Encrypted media file integrity mismatch");
    return bytes;
  }

  /** Explicit deletion only; validates the exact configured media directory. */
  public eraseAll(): void {
    const root = resolve(this.mediaDir);
    if (basename(root) !== "media" || dirname(root) === "/") {
      throw new Error("Refusing to erase an unexpected media directory");
    }
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  /** Remove only direct, hash-named vault files no longer referenced by SQLite. */
  public removeUnreferenced(referencedPaths: readonly string[]): number {
    const root = resolve(this.mediaDir);
    const references = new Set<string>();
    for (const path of referencedPaths) {
      try {
        this.assertMediaPath(path);
        references.add(resolve(path));
      } catch {
        // A corrupt database value never broadens the deletion scope.
      }
    }
    let removed = 0;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".media.enc")) continue;
      const path = join(root, entry.name);
      if (references.has(path)) continue;
      unlinkSync(path);
      removed += 1;
    }
    return removed;
  }

  private assertMediaPath(path: string): void {
    const root = resolve(this.mediaDir);
    const target = resolve(path);
    if (dirname(target) !== root || !target.endsWith(".media.enc")) {
      throw new Error("Refusing to read media outside the configured vault");
    }
  }
}
