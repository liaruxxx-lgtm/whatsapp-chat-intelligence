import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

export interface EncryptedValue {
  ciphertext: string;
  iv: string;
  authTag: string;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export class FieldEncryptor {
  private readonly key: Buffer;

  public constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, "base64");
    if (this.key.length !== 32) {
      throw new Error("Encryption key must be exactly 32 bytes");
    }
  }

  public encrypt(plaintext: string): EncryptedValue {
    return this.encryptBytes(Buffer.from(plaintext, "utf8"));
  }

  public encryptBytes(plaintext: Uint8Array): EncryptedValue {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64")
    };
  }

  public decrypt(value: EncryptedValue): string {
    return this.decryptBytes(value).toString("utf8");
  }

  public decryptBytes(value: EncryptedValue): Buffer {
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(value.iv, "base64"));
    decipher.setAuthTag(Buffer.from(value.authTag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(value.ciphertext, "base64")),
      decipher.final()
    ]);
  }

  public stableToken(value: string): string {
    return createHmac("sha256", this.key).update(value, "utf8").digest("hex");
  }
}
