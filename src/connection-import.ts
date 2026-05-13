import { randomUUID } from "node:crypto";
import { encryptText } from "./crypto";
import { insertConnection } from "./persistence";

const MAX_JSON_BYTES = 256 * 1024;
const MAX_COOKIES = 800;
const MAX_LOCAL_STORAGE_ENTRIES = 500;

type SameSitePlaywright = "Strict" | "Lax" | "None";

type StorageCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: SameSitePlaywright;
};

type StorageOrigin = {
  origin: string;
  localStorage: { name: string; value: string }[];
};

export type PlaywrightStorageState = {
  cookies: StorageCookie[];
  origins?: StorageOrigin[];
};

function normalizeHostname(input: string): string {
  return input.trim().toLowerCase().replace(/^\./, "");
}

function toDomain(startUrl: string): string {
  return new URL(startUrl).hostname;
}

function collectAllowedHosts(startUrl: string, extraHosts?: string[]): string[] {
  const primary = normalizeHostname(toDomain(startUrl));
  const set = new Set<string>([primary]);
  for (const raw of extraHosts ?? []) {
    const h = normalizeHostname(raw.split("/")[0] ?? "");
    if (h && /^[a-z0-9.-]+$/i.test(h)) {
      set.add(h);
    }
  }
  return [...set];
}

function cookieDomainMatchesHost(cookieDomain: string, host: string): boolean {
  const d = normalizeHostname(cookieDomain);
  const h = normalizeHostname(host);
  if (!d || !h) return false;
  if (d === h) return true;
  return h.endsWith(`.${d}`);
}

function cookieAllowedForHosts(cookie: StorageCookie, allowedHosts: string[]): boolean {
  return allowedHosts.some((h) => cookieDomainMatchesHost(cookie.domain, h));
}

function normalizeSameSite(raw: unknown): SameSitePlaywright | undefined {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).toLowerCase();
  if (s === "strict" || s === "lax" || s === "none") {
    return (s.charAt(0).toUpperCase() + s.slice(1)) as SameSitePlaywright;
  }
  if (s === "no_restriction" || s === "unspecified") return "None";
  return undefined;
}

export function parseExtraHostsField(field: string | undefined): string[] {
  if (!field) return [];
  return field
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function validateStorageStateJson(
  rawJson: string,
  allowedHosts: string[]
): PlaywrightStorageState {
  if (Buffer.byteLength(rawJson, "utf8") > MAX_JSON_BYTES) {
    throw new Error(`storageState exceeds ${MAX_JSON_BYTES} bytes.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson) as unknown;
  } catch {
    throw new Error("storageState is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || !("cookies" in parsed)) {
    throw new Error("storageState must be an object with a cookies array.");
  }
  const obj = parsed as { cookies?: unknown; origins?: unknown };
  if (!Array.isArray(obj.cookies)) {
    throw new Error("storageState.cookies must be an array.");
  }
  if (obj.cookies.length > MAX_COOKIES) {
    throw new Error(`Too many cookies (max ${MAX_COOKIES}).`);
  }

  const cookies: StorageCookie[] = [];
  for (const c of obj.cookies) {
    if (!c || typeof c !== "object") continue;
    const row = c as Record<string, unknown>;
    const name = String(row.name ?? "");
    const value = String(row.value ?? "");
    const domain = String(row.domain ?? "");
    const path = String(row.path ?? "/");
    if (!name || !domain) continue;
    const expires = typeof row.expires === "number" && Number.isFinite(row.expires) ? row.expires : -1;
    const httpOnly = Boolean(row.httpOnly);
    const secure = Boolean(row.secure);
    const sameSite = normalizeSameSite(row.sameSite);
    const sc: StorageCookie = { name, value, domain, path, expires, httpOnly, secure, sameSite };
    if (!cookieAllowedForHosts(sc, allowedHosts)) {
      continue;
    }
    cookies.push(sc);
  }

  let origins: StorageOrigin[] | undefined;
  if (Array.isArray(obj.origins)) {
    origins = [];
    for (const o of obj.origins) {
      if (!o || typeof o !== "object") continue;
      const or = o as { origin?: unknown; localStorage?: unknown };
      const origin = String(or.origin ?? "");
      if (!origin.startsWith("http://") && !origin.startsWith("https://")) continue;
      let originHost: string;
      try {
        originHost = normalizeHostname(new URL(origin).hostname);
      } catch {
        continue;
      }
      if (
        !allowedHosts.some(
          (h) => originHost === normalizeHostname(h) || cookieDomainMatchesHost(h, originHost)
        )
      ) {
        continue;
      }
      const ls: { name: string; value: string }[] = [];
      if (Array.isArray(or.localStorage)) {
        for (const entry of or.localStorage) {
          if (!entry || typeof entry !== "object") continue;
          const e = entry as { name?: unknown; value?: unknown };
          const n = String(e.name ?? "");
          const v = String(e.value ?? "");
          if (!n) continue;
          ls.push({ name: n, value: v });
          if (ls.length >= MAX_LOCAL_STORAGE_ENTRIES) break;
        }
      }
      origins.push({ origin, localStorage: ls });
    }
    if (origins.length === 0) origins = undefined;
  }

  return { cookies, origins };
}

export async function importConnectionFromStorageState(input: {
  userId: string;
  name: string;
  startUrl: string;
  storageState: PlaywrightStorageState;
  extraHosts?: string[];
}): Promise<{ connectionId: string }> {
  const name = input.name.trim();
  const startUrl = input.startUrl.trim();
  if (!name) {
    throw new Error("name is required.");
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(startUrl);
  } catch {
    throw new Error("startUrl must be a valid http(s) URL.");
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("startUrl must be http(s).");
  }

  const allowedHosts = collectAllowedHosts(startUrl, input.extraHosts);
  const raw = JSON.stringify(input.storageState);
  const validated = validateStorageStateJson(raw, allowedHosts);

  if (validated.cookies.length === 0 && (!validated.origins || validated.origins.length === 0)) {
    throw new Error("No cookies or origin storage matched the allowed hosts for this import.");
  }

  const domain = toDomain(startUrl);
  const encryptedState = encryptText(JSON.stringify(validated));
  const id = randomUUID();
  await insertConnection({
    id,
    name,
    domain,
    startUrl,
    encryptedState,
    userId: input.userId
  });
  return { connectionId: id };
}
