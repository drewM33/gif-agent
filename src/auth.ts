import { createHash, randomBytes, randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import { decryptText, encryptText } from "./crypto";
import {
  findActiveMagicLinkWithUser,
  findUserBySessionToken,
  getOrCreateUserByEmail,
  insertMagicLink,
  insertSession,
  markMagicLinkUsed,
  revokeSessionByTokenHash,
  selectUserEncryptedApiKey,
  updateUserApiKey
} from "./persistence";
import { parseLlmProvider, type LlmProvider } from "./llm-provider";

export type AuthUser = {
  id: string;
  email: string;
  createdAt: string;
  hasSavedApiKey: boolean;
  llmProvider: LlmProvider;
};

type SessionUser = AuthUser & {
  sessionToken: string;
  sessionExpiresAt: string;
};

type MagicLinkResult = {
  delivery: "smtp" | "console";
  linkUrl?: string;
};

const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function nowIso(): string {
  return new Date().toISOString();
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function mapUserRow(row: {
  id: string;
  email: string;
  created_at: string;
  encrypted_api_key: string | null;
  llm_provider?: string | null;
}): AuthUser {
  return {
    id: row.id,
    email: row.email,
    createdAt: row.created_at,
    hasSavedApiKey: Boolean(row.encrypted_api_key),
    llmProvider: parseLlmProvider(row.llm_provider)
  };
}

async function deliverMagicLink(email: string, linkUrl: string): Promise<MagicLinkResult> {
  const smtpHost = process.env.SMTP_HOST?.trim();
  const smtpPort = Number(process.env.SMTP_PORT ?? 587);
  const smtpUser = process.env.SMTP_USER?.trim();
  const smtpPass = process.env.SMTP_PASS?.trim();
  const from = process.env.MAGIC_LINK_FROM?.trim() || smtpUser || "no-reply@gif-agent.local";

  if (!smtpHost) {
    process.stdout.write(`Magic link for ${email}: ${linkUrl}\n`);
    return { delivery: "console", linkUrl };
  }

  if (!smtpPass) {
    throw new Error(
      "SMTP_HOST is set but SMTP_PASS is empty. Set SMTP_PASS to your provider API key (e.g. Resend re_… key)."
    );
  }
  if (!smtpUser) {
    throw new Error("SMTP_USER is required when SMTP_HOST is set (Resend: resend).");
  }

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    requireTLS: smtpPort === 587,
    auth: { user: smtpUser, pass: smtpPass }
  });

  await transporter.sendMail({
    from,
    to: email,
    subject: "Your gif-agent sign-in link",
    text: `Click to sign in:\n\n${linkUrl}\n\nThis link expires in 15 minutes.`,
    html: `<p>Click to sign in:</p><p><a href="${linkUrl}">${linkUrl}</a></p><p>This link expires in 15 minutes.</p>`
  });

  return { delivery: "smtp" };
}

export async function requestMagicLink(email: string, appOrigin: string): Promise<MagicLinkResult> {
  const row = await getOrCreateUserByEmail(email);
  const user = mapUserRow(row);

  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const now = nowIso();
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS).toISOString();

  await insertMagicLink({
    id: randomUUID(),
    userId: user.id,
    tokenHash,
    expiresAt,
    createdAt: now
  });

  const linkUrl = `${appOrigin.replace(/\/+$/, "")}/auth/verify?token=${encodeURIComponent(token)}`;
  return deliverMagicLink(user.email, linkUrl);
}

export async function consumeMagicLink(token: string): Promise<SessionUser | null> {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const now = nowIso();

  const record = await findActiveMagicLinkWithUser(tokenHash, now);
  if (!record) return null;

  await markMagicLinkUsed(record.magic_link_id, now);

  const sessionToken = randomBytes(32).toString("base64url");
  const sessionHash = hashToken(sessionToken);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await insertSession({
    id: randomUUID(),
    userId: record.id,
    tokenHash: sessionHash,
    expiresAt,
    createdAt: now
  });

  const user = mapUserRow({
    id: record.id,
    email: record.email,
    created_at: record.created_at,
    encrypted_api_key: record.encrypted_api_key,
    llm_provider: record.llm_provider
  });

  return {
    ...user,
    sessionToken,
    sessionExpiresAt: expiresAt
  };
}

export async function getSessionUser(sessionToken: string | undefined): Promise<AuthUser | null> {
  if (!sessionToken) return null;
  const tokenHash = hashToken(sessionToken);
  const now = nowIso();

  const row = await findUserBySessionToken(tokenHash, now);
  if (!row) return null;
  return mapUserRow(row);
}

export async function revokeSession(sessionToken: string | undefined): Promise<void> {
  if (!sessionToken) return;
  const tokenHash = hashToken(sessionToken);
  await revokeSessionByTokenHash(tokenHash, nowIso());
}

export async function saveUserApiKey(
  userId: string,
  apiKey: string,
  provider: LlmProvider = "anthropic"
): Promise<void> {
  const now = nowIso();
  const trimmed = apiKey.trim();
  const encrypted = trimmed ? encryptText(trimmed) : null;
  const storedProvider = trimmed ? provider : "anthropic";
  await updateUserApiKey(userId, encrypted, storedProvider, now);
}

export async function getUserApiKey(userId: string): Promise<string | null> {
  const enc = await selectUserEncryptedApiKey(userId);
  if (!enc) return null;
  return decryptText(enc);
}
