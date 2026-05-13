import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { deriveExtensionTokenSigningKey } from "./crypto";
import {
  consumePairing,
  findActivePairingByCodeHash,
  getExtensionTokenRow,
  insertConnectionPairing,
  insertExtensionToken
} from "./persistence";

const PAIR_TTL_MS = 5 * 60 * 1000;
const EXTENSION_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function nowIso(): string {
  return new Date().toISOString();
}

function hashPairingCode(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase(), "utf8").digest("hex");
}

function generatePairingCode(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 6; i += 1) {
    out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return out;
}

type TokenPayload = { uid: string; tid: string; exp: number };

function signPayloadV1(payload: TokenPayload): string {
  const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", deriveExtensionTokenSigningKey())
    .update(`v1|${b64}`)
    .digest("base64url");
  return `v1.${b64}.${sig}`;
}

function parseBearer(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return m?.[1]?.trim() || null;
}

export async function startExtensionPairing(userId: string): Promise<{ code: string; expiresInSec: number }> {
  const code = generatePairingCode();
  const codeHash = hashPairingCode(code);
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + PAIR_TTL_MS).toISOString();
  await insertConnectionPairing({
    id: randomUUID(),
    userId,
    codeHash,
    expiresAt,
    createdAt
  });
  return { code, expiresInSec: Math.floor(PAIR_TTL_MS / 1000) };
}

export async function exchangePairingCode(code: string): Promise<{ extensionToken: string }> {
  const normalized = code.trim().toUpperCase();
  if (normalized.length < 4 || normalized.length > 12) {
    throw new Error("Invalid pairing code.");
  }
  const codeHash = hashPairingCode(normalized);
  const now = nowIso();
  const pairing = await findActivePairingByCodeHash(codeHash, now);
  if (!pairing) {
    throw new Error("Pairing code is invalid or expired.");
  }

  await consumePairing(pairing.id, now);

  const tokenId = randomUUID();
  const expMs = Date.now() + EXTENSION_TOKEN_TTL_MS;
  const expiresAt = new Date(expMs).toISOString();
  await insertExtensionToken({
    id: randomUUID(),
    userId: pairing.userId,
    tokenId,
    expiresAt,
    createdAt: now
  });

  const payload: TokenPayload = { uid: pairing.userId, tid: tokenId, exp: expMs };
  return { extensionToken: signPayloadV1(payload) };
}

export async function verifyExtensionBearer(authorizationHeader: string | undefined): Promise<string | null> {
  const raw = parseBearer(authorizationHeader);
  if (!raw) return null;

  const parts = raw.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") {
    return null;
  }
  const [, b64, sig] = parts;
  if (!b64 || !sig) return null;

  const expected = createHmac("sha256", deriveExtensionTokenSigningKey())
    .update(`v1|${b64}`)
    .digest("base64url");
  if (!timingSafeEqualString(expected, sig)) {
    return null;
  }

  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(b64, "base64url").toString("utf8")) as TokenPayload;
  } catch {
    return null;
  }
  if (!payload?.uid || !payload?.tid || typeof payload.exp !== "number") {
    return null;
  }
  if (payload.exp < Date.now()) {
    return null;
  }

  const now = nowIso();
  const row = await getExtensionTokenRow(payload.tid, now);
  if (!row || row.userId !== payload.uid) {
    return null;
  }

  return row.userId;
}

function timingSafeEqualString(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, "utf8");
    const bb = Buffer.from(b, "utf8");
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}
