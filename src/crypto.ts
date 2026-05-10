import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function decodeMasterKey(input: string): Buffer {
  const base64 = Buffer.from(input, "base64");
  if (base64.length === 32) return base64;

  const hex = Buffer.from(input, "hex");
  if (hex.length === 32) return hex;

  throw new Error("MASTER_KEY must be 32-byte base64 or hex.");
}

function getMasterKey(): Buffer {
  const raw = process.env.MASTER_KEY;
  if (!raw) {
    throw new Error("MASTER_KEY is required.");
  }
  return decodeMasterKey(raw);
}

export function encryptText(plainText: string): string {
  const key = getMasterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(".");
}

export function decryptText(cipherText: string): string {
  const key = getMasterKey();
  const [ivB64, tagB64, dataB64] = cipherText.split(".");

  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Malformed ciphertext.");
  }

  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));

  const plain = Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final()
  ]);

  return plain.toString("utf8");
}
