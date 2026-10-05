import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  BufferJSON,
  initAuthCreds,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
  type SignalKeyStore
} from "@whiskeysockets/baileys";
import { FieldEncryptor } from "../security/crypto.js";

interface AuthSnapshot {
  creds: AuthenticationCreds;
  keys: SignalDataSet;
}

interface EncryptedAuthFile {
  version: 1;
  ciphertext: string;
  iv: string;
  authTag: string;
}

/**
 * A single encrypted auth-state file, deliberately replacing Baileys'
 * convenience multi-file store. The file contains long-lived credentials and
 * must stay in WCI_SESSION_DIR outside the repository.
 */
export class EncryptedAuthState {
  public readonly state: AuthenticationState;
  private readonly snapshot: AuthSnapshot;

  private constructor(
    private readonly path: string,
    private readonly encryptor: FieldEncryptor,
    snapshot: AuthSnapshot
  ) {
    this.snapshot = snapshot;
    const keys: SignalKeyStore = {
      get: <T extends keyof SignalDataTypeMap>(type: T, ids: string[]): { [id: string]: SignalDataTypeMap[T] } => {
        const bucket = this.snapshot.keys[type] as Record<string, SignalDataTypeMap[T] | null> | undefined;
        const selected: { [id: string]: SignalDataTypeMap[T] } = {};
        for (const id of ids) {
          const value = bucket?.[id];
          if (value !== undefined && value !== null) selected[id] = value;
        }
        return selected;
      },
      set: async (changes: SignalDataSet): Promise<void> => {
        for (const [type, values] of Object.entries(changes) as Array<[keyof SignalDataTypeMap, Record<string, unknown> | undefined]>) {
          if (!values) continue;
          const bucket = (this.snapshot.keys[type] ??= {}) as Record<string, unknown>;
          for (const [id, value] of Object.entries(values)) {
            if (value === null) delete bucket[id];
            else bucket[id] = value;
          }
        }
        this.save();
      },
      clear: async (): Promise<void> => {
        for (const key of Object.keys(this.snapshot.keys)) delete this.snapshot.keys[key as keyof SignalDataSet];
        this.save();
      }
    };
    this.state = { creds: this.snapshot.creds, keys };
  }

  public static open(path: string, encryptor: FieldEncryptor): EncryptedAuthState {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const snapshot = existsSync(path) ? this.readSnapshot(path, encryptor) : { creds: initAuthCreds(), keys: {} };
    const instance = new EncryptedAuthState(path, encryptor, snapshot);
    if (!existsSync(path)) instance.save();
    return instance;
  }

  public applyCreds(update: Partial<AuthenticationCreds>): void {
    Object.assign(this.snapshot.creds, update);
    this.save();
  }

  public save(): void {
    const encrypted = this.encryptor.encrypt(JSON.stringify(this.snapshot, BufferJSON.replacer));
    const payload: EncryptedAuthFile = { version: 1, ...encrypted };
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.path);
    chmodSync(this.path, 0o600);
  }

  /** Explicit setup/deletion operation; never invoked automatically on errors. */
  public wipe(): void {
    if (existsSync(this.path)) unlinkSync(this.path);
  }

  private static readSnapshot(path: string, encryptor: FieldEncryptor): AuthSnapshot {
    let envelope: EncryptedAuthFile;
    try {
      envelope = JSON.parse(readFileSync(path, "utf8")) as EncryptedAuthFile;
    } catch {
      throw new Error("Encrypted auth state cannot be read");
    }
    if (envelope.version !== 1 || !envelope.ciphertext || !envelope.iv || !envelope.authTag) {
      throw new Error("Encrypted auth state has an unsupported format");
    }
    try {
      const decoded = encryptor.decrypt(envelope);
      const snapshot = JSON.parse(decoded, BufferJSON.reviver) as Partial<AuthSnapshot>;
      if (!snapshot.creds || !snapshot.keys) throw new Error("missing auth state fields");
      return { creds: snapshot.creds, keys: snapshot.keys };
    } catch {
      throw new Error("Encrypted auth state cannot be decrypted with the configured key");
    }
  }
}
