import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { Pool } from "pg";
import type { ConnectionRecord, TaskRecord, TaskStatus } from "./types";

let sqliteDb: Database.Database | null = null;
let pgPool: Pool | null = null;

export function usePostgres(): boolean {
  return pgPool !== null;
}

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  start_url TEXT NOT NULL,
  encrypted_state TEXT NOT NULL,
  user_id TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS connection_pairings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS extension_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_id TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  connection_id TEXT NULL,
  status TEXT NOT NULL,
  plan_json TEXT NULL,
  output_url TEXT NULL,
  error TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (connection_id) REFERENCES connections(id)
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  encrypted_api_key TEXT NULL,
  llm_provider TEXT NOT NULL DEFAULT 'anthropic',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS magic_links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
`;

export type PersistedUserRow = {
  id: string;
  email: string;
  created_at: string;
  encrypted_api_key: string | null;
  llm_provider: string | null;
};

export async function initDatabase(): Promise<void> {
  const url =
    process.env.DATABASE_URL?.trim() ||
    process.env.SUPABASE_DATABASE_URL?.trim();

  if (url) {
    const hostish = url.toLowerCase();
    const useSsl =
      /[?&]sslmode=require/i.test(url) ||
      /supabase\.(co|com)/i.test(hostish) ||
      process.env.DATABASE_SSL === "true";

    pgPool = new Pool({
      connectionString: url,
      max: 10,
      idleTimeoutMillis: 20_000,
      connectionTimeoutMillis: 30_000,
      ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {})
    });
    await pgPool.query("SELECT 1");
    await migratePostgresAuthTunnel(pgPool);
    return;
  }

  const dataDir = process.env.DATA_DIR ?? "./data";
  const dbPath = path.join(dataDir, "gif-agent.sqlite");
  fs.mkdirSync(dataDir, { recursive: true });
  sqliteDb = new Database(dbPath);
  sqliteDb.pragma("journal_mode = WAL");
  sqliteDb.exec(SQLITE_SCHEMA);
  migrateSqliteAuthTunnel(sqliteDb);

  const cols = sqliteDb.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "llm_provider")) {
    sqliteDb.exec("ALTER TABLE users ADD COLUMN llm_provider TEXT NOT NULL DEFAULT 'anthropic'");
  }
}

function migrateSqliteAuthTunnel(db: Database.Database): void {
  const connCols = db.prepare("PRAGMA table_info(connections)").all() as { name: string }[];
  if (!connCols.some((c) => c.name === "user_id")) {
    db.exec("ALTER TABLE connections ADD COLUMN user_id TEXT NULL REFERENCES users(id)");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS connection_pairings (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS extension_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_id TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      revoked_at TEXT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_connection_pairings_code_hash ON connection_pairings(code_hash);
  `);
}

async function migratePostgresAuthTunnel(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE connections ADD COLUMN IF NOT EXISTS user_id text NULL REFERENCES users(id) ON DELETE SET NULL;
    CREATE TABLE IF NOT EXISTS connection_pairings (
      id text PRIMARY KEY,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash text NOT NULL,
      expires_at text NOT NULL,
      consumed_at text NULL,
      created_at text NOT NULL
    );
    CREATE TABLE IF NOT EXISTS extension_tokens (
      id text PRIMARY KEY,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_id text NOT NULL UNIQUE,
      expires_at text NOT NULL,
      revoked_at text NULL,
      created_at text NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_connection_pairings_code_hash ON connection_pairings(code_hash);
  `);
}

function requireSqlite(): Database.Database {
  if (!sqliteDb) {
    throw new Error("Database not initialized. Call initDatabase() before handling requests.");
  }
  return sqliteDb;
}

function mapConnectionRow(row: {
  id: string;
  name: string;
  domain: string;
  start_url: string;
  encrypted_state: string;
  user_id?: string | null;
  created_at: string;
  updated_at: string;
}): ConnectionRecord {
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    startUrl: row.start_url,
    encryptedState: row.encrypted_state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    userId: row.user_id ?? null
  };
}

function mapTaskRow(row: {
  id: string;
  question: string;
  connection_id: string | null;
  status: TaskStatus;
  plan_json: string | null;
  output_url: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}): TaskRecord {
  return {
    id: row.id,
    question: row.question,
    connectionId: row.connection_id,
    status: row.status,
    planJson: row.plan_json,
    outputUrl: row.output_url,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function insertConnection(input: {
  id: string;
  name: string;
  domain: string;
  startUrl: string;
  encryptedState: string;
  userId?: string | null;
}): Promise<void> {
  const now = new Date().toISOString();
  const userId = input.userId ?? null;
  if (pgPool) {
    await pgPool.query(
      `INSERT INTO connections (id, name, domain, start_url, encrypted_state, user_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
      [input.id, input.name, input.domain, input.startUrl, input.encryptedState, userId, now]
    );
    return;
  }
  requireSqlite()
    .prepare(
      `INSERT INTO connections (id, name, domain, start_url, encrypted_state, user_id, created_at, updated_at)
       VALUES (@id, @name, @domain, @startUrl, @encryptedState, @userId, @now, @now)`
    )
    .run({ ...input, userId, now });
}

export async function getConnection(id: string): Promise<ConnectionRecord | null> {
  if (pgPool) {
    const { rows } = await pgPool.query(
      "SELECT * FROM connections WHERE id = $1",
      [id]
    );
    const row = rows[0] as
      | {
          id: string;
          name: string;
          domain: string;
          start_url: string;
          encrypted_state: string;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    return row ? mapConnectionRow(row) : null;
  }
  const row = requireSqlite()
    .prepare("SELECT * FROM connections WHERE id = ?")
    .get(id) as
    | {
        id: string;
        name: string;
        domain: string;
        start_url: string;
        encrypted_state: string;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  return row ? mapConnectionRow(row) : null;
}

export async function insertTask(input: {
  id: string;
  question: string;
  connectionId: string | null;
}): Promise<void> {
  const now = new Date().toISOString();
  if (pgPool) {
    await pgPool.query(
      `INSERT INTO tasks (id, question, connection_id, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'queued', $4, $4)`,
      [input.id, input.question, input.connectionId, now]
    );
    return;
  }
  requireSqlite()
    .prepare(
      `INSERT INTO tasks (id, question, connection_id, status, created_at, updated_at)
       VALUES (@id, @question, @connectionId, 'queued', @now, @now)`
    )
    .run({ ...input, now });
}

export async function updateTask(
  id: string,
  updates: Partial<Pick<TaskRecord, "status" | "planJson" | "outputUrl" | "error">>
): Promise<void> {
  const current = await getTask(id);
  if (!current) return;

  const now = new Date().toISOString();
  const status = updates.status ?? current.status;
  const planJson = updates.planJson ?? current.planJson;
  const outputUrl = updates.outputUrl ?? current.outputUrl;
  const error = updates.error ?? current.error;

  if (pgPool) {
    await pgPool.query(
      `UPDATE tasks
       SET status = $2, plan_json = $3, output_url = $4, error = $5, updated_at = $6
       WHERE id = $1`,
      [id, status, planJson, outputUrl, error, now]
    );
    return;
  }

  requireSqlite()
    .prepare(
      `UPDATE tasks
       SET status = @status,
           plan_json = @planJson,
           output_url = @outputUrl,
           error = @error,
           updated_at = @now
       WHERE id = @id`
    )
    .run({ id, status, planJson, outputUrl, error, now });
}

export async function getTask(id: string): Promise<TaskRecord | null> {
  if (pgPool) {
    const { rows } = await pgPool.query("SELECT * FROM tasks WHERE id = $1", [id]);
    const row = rows[0] as
      | {
          id: string;
          question: string;
          connection_id: string | null;
          status: TaskStatus;
          plan_json: string | null;
          output_url: string | null;
          error: string | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    return row ? mapTaskRow(row) : null;
  }
  const row = requireSqlite()
    .prepare("SELECT * FROM tasks WHERE id = ?")
    .get(id) as
    | {
        id: string;
        question: string;
        connection_id: string | null;
        status: TaskStatus;
        plan_json: string | null;
        output_url: string | null;
        error: string | null;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  return row ? mapTaskRow(row) : null;
}

export async function setTaskStatus(id: string, status: TaskStatus): Promise<void> {
  await updateTask(id, { status });
}

export async function getOrCreateUserByEmail(email: string): Promise<PersistedUserRow> {
  const normalized = email.trim().toLowerCase();
  if (pgPool) {
    const found = await pgPool.query("SELECT * FROM users WHERE email = $1", [normalized]);
    if (found.rows[0]) {
      return found.rows[0] as PersistedUserRow;
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const ins = await pgPool.query(
      `INSERT INTO users (id, email, encrypted_api_key, llm_provider, created_at, updated_at)
       VALUES ($1, $2, NULL, 'anthropic', $3, $3)
       RETURNING *`,
      [id, normalized, now]
    );
    return ins.rows[0] as PersistedUserRow;
  }

  const db = requireSqlite();
  const existing = db.prepare("SELECT * FROM users WHERE email = ?").get(normalized) as PersistedUserRow | undefined;
  if (existing) return existing;

  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, encrypted_api_key, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?)`
  ).run(id, normalized, now, now);

  return {
    id,
    email: normalized,
    created_at: now,
    encrypted_api_key: null,
    llm_provider: "anthropic"
  };
}

export async function insertMagicLink(input: {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
}): Promise<void> {
  if (pgPool) {
    await pgPool.query(
      `INSERT INTO magic_links (id, user_id, token_hash, expires_at, used_at, created_at)
       VALUES ($1, $2, $3, $4, NULL, $5)`,
      [input.id, input.userId, input.tokenHash, input.expiresAt, input.createdAt]
    );
    return;
  }
  requireSqlite()
    .prepare(
      `INSERT INTO magic_links (id, user_id, token_hash, expires_at, used_at, created_at)
       VALUES (?, ?, ?, ?, NULL, ?)`
    )
    .run(input.id, input.userId, input.tokenHash, input.expiresAt, input.createdAt);
}

export type MagicLinkJoinUserRow = PersistedUserRow & { magic_link_id: string };

export async function findActiveMagicLinkWithUser(
  tokenHash: string,
  nowIso: string
): Promise<MagicLinkJoinUserRow | null> {
  if (pgPool) {
    const { rows } = await pgPool.query(
      `SELECT ml.id AS magic_link_id, u.*
       FROM magic_links ml
       JOIN users u ON u.id = ml.user_id
       WHERE ml.token_hash = $1
         AND ml.used_at IS NULL
         AND ml.expires_at > $2`,
      [tokenHash, nowIso]
    );
    return (rows[0] as MagicLinkJoinUserRow | undefined) ?? null;
  }
  const row = requireSqlite()
    .prepare(
      `SELECT ml.id AS magic_link_id, u.*
       FROM magic_links ml
       JOIN users u ON u.id = ml.user_id
       WHERE ml.token_hash = ?
         AND ml.used_at IS NULL
         AND ml.expires_at > ?`
    )
    .get(tokenHash, nowIso) as MagicLinkJoinUserRow | undefined;
  return row ?? null;
}

export async function markMagicLinkUsed(magicLinkId: string, usedAt: string): Promise<void> {
  if (pgPool) {
    await pgPool.query("UPDATE magic_links SET used_at = $1 WHERE id = $2", [usedAt, magicLinkId]);
    return;
  }
  requireSqlite().prepare("UPDATE magic_links SET used_at = ? WHERE id = ?").run(usedAt, magicLinkId);
}

export async function insertSession(input: {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
}): Promise<void> {
  if (pgPool) {
    await pgPool.query(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at, revoked_at, created_at)
       VALUES ($1, $2, $3, $4, NULL, $5)`,
      [input.id, input.userId, input.tokenHash, input.expiresAt, input.createdAt]
    );
    return;
  }
  requireSqlite()
    .prepare(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at, revoked_at, created_at)
       VALUES (?, ?, ?, ?, NULL, ?)`
    )
    .run(input.id, input.userId, input.tokenHash, input.expiresAt, input.createdAt);
}

export async function findUserBySessionToken(tokenHash: string, nowIso: string): Promise<PersistedUserRow | null> {
  if (pgPool) {
    const { rows } = await pgPool.query(
      `SELECT u.*
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1
         AND s.revoked_at IS NULL
         AND s.expires_at > $2`,
      [tokenHash, nowIso]
    );
    return (rows[0] as PersistedUserRow | undefined) ?? null;
  }
  const row = requireSqlite()
    .prepare(
      `SELECT u.*
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?
         AND s.revoked_at IS NULL
         AND s.expires_at > ?`
    )
    .get(tokenHash, nowIso) as PersistedUserRow | undefined;
  return row ?? null;
}

export async function revokeSessionByTokenHash(tokenHash: string, revokedAt: string): Promise<void> {
  if (pgPool) {
    await pgPool.query(
      "UPDATE sessions SET revoked_at = $1 WHERE token_hash = $2 AND revoked_at IS NULL",
      [revokedAt, tokenHash]
    );
    return;
  }
  requireSqlite()
    .prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
    .run(revokedAt, tokenHash);
}

export async function updateUserApiKey(
  userId: string,
  encryptedApiKey: string | null,
  llmProvider: string,
  updatedAt: string
): Promise<void> {
  if (pgPool) {
    await pgPool.query(
      "UPDATE users SET encrypted_api_key = $1, llm_provider = $2, updated_at = $3 WHERE id = $4",
      [encryptedApiKey, llmProvider, updatedAt, userId]
    );
    return;
  }
  requireSqlite()
    .prepare("UPDATE users SET encrypted_api_key = ?, llm_provider = ?, updated_at = ? WHERE id = ?")
    .run(encryptedApiKey, llmProvider, updatedAt, userId);
}

export async function selectUserEncryptedApiKey(userId: string): Promise<string | null> {
  if (pgPool) {
    const { rows } = await pgPool.query("SELECT encrypted_api_key FROM users WHERE id = $1", [userId]);
    const v = rows[0] as { encrypted_api_key: string | null } | undefined;
    return v?.encrypted_api_key ?? null;
  }
  const row = requireSqlite()
    .prepare("SELECT encrypted_api_key FROM users WHERE id = ?")
    .get(userId) as { encrypted_api_key: string | null } | undefined;
  return row?.encrypted_api_key ?? null;
}

export async function listConnectionsByUserId(userId: string): Promise<ConnectionRecord[]> {
  type Row = {
    id: string;
    name: string;
    domain: string;
    start_url: string;
    encrypted_state: string;
    user_id?: string | null;
    created_at: string;
    updated_at: string;
  };
  if (pgPool) {
    const { rows } = await pgPool.query(
      `SELECT * FROM connections WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
    return (rows as Row[]).map(mapConnectionRow);
  }
  const rows = requireSqlite()
    .prepare("SELECT * FROM connections WHERE user_id = ? ORDER BY created_at DESC")
    .all(userId) as Row[];
  return rows.map(mapConnectionRow);
}

export async function insertConnectionPairing(input: {
  id: string;
  userId: string;
  codeHash: string;
  expiresAt: string;
  createdAt: string;
}): Promise<void> {
  if (pgPool) {
    await pgPool.query(
      `INSERT INTO connection_pairings (id, user_id, code_hash, expires_at, consumed_at, created_at)
       VALUES ($1, $2, $3, $4, NULL, $5)`,
      [input.id, input.userId, input.codeHash, input.expiresAt, input.createdAt]
    );
    return;
  }
  requireSqlite()
    .prepare(
      `INSERT INTO connection_pairings (id, user_id, code_hash, expires_at, consumed_at, created_at)
       VALUES (?, ?, ?, ?, NULL, ?)`
    )
    .run(input.id, input.userId, input.codeHash, input.expiresAt, input.createdAt);
}

export async function findActivePairingByCodeHash(
  codeHash: string,
  nowIso: string
): Promise<{ id: string; userId: string } | null> {
  if (pgPool) {
    const { rows } = await pgPool.query(
      `SELECT id, user_id AS "userId"
       FROM connection_pairings
       WHERE code_hash = $1
         AND consumed_at IS NULL
         AND expires_at > $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [codeHash, nowIso]
    );
    return (rows[0] as { id: string; userId: string } | undefined) ?? null;
  }
  const row = requireSqlite()
    .prepare(
      `SELECT id, user_id AS userId
       FROM connection_pairings
       WHERE code_hash = ?
         AND consumed_at IS NULL
         AND expires_at > ?
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(codeHash, nowIso) as { id: string; userId: string } | undefined;
  return row ?? null;
}

export async function consumePairing(id: string, consumedAt: string): Promise<void> {
  if (pgPool) {
    await pgPool.query("UPDATE connection_pairings SET consumed_at = $1 WHERE id = $2", [consumedAt, id]);
    return;
  }
  requireSqlite().prepare("UPDATE connection_pairings SET consumed_at = ? WHERE id = ?").run(consumedAt, id);
}

export async function insertExtensionToken(input: {
  id: string;
  userId: string;
  tokenId: string;
  expiresAt: string;
  createdAt: string;
}): Promise<void> {
  if (pgPool) {
    await pgPool.query(
      `INSERT INTO extension_tokens (id, user_id, token_id, expires_at, revoked_at, created_at)
       VALUES ($1, $2, $3, $4, NULL, $5)`,
      [input.id, input.userId, input.tokenId, input.expiresAt, input.createdAt]
    );
    return;
  }
  requireSqlite()
    .prepare(
      `INSERT INTO extension_tokens (id, user_id, token_id, expires_at, revoked_at, created_at)
       VALUES (?, ?, ?, ?, NULL, ?)`
    )
    .run(input.id, input.userId, input.tokenId, input.expiresAt, input.createdAt);
}

export type ExtensionTokenRow = {
  id: string;
  userId: string;
  tokenId: string;
  expiresAt: string;
  revokedAt: string | null;
};

export async function getExtensionTokenRow(tokenId: string, nowIso: string): Promise<ExtensionTokenRow | null> {
  if (pgPool) {
    const { rows } = await pgPool.query(
      `SELECT id, user_id AS "userId", token_id AS "tokenId", expires_at AS "expiresAt", revoked_at AS "revokedAt"
       FROM extension_tokens
       WHERE token_id = $1
         AND revoked_at IS NULL
         AND expires_at > $2`,
      [tokenId, nowIso]
    );
    return (rows[0] as ExtensionTokenRow | undefined) ?? null;
  }
  const row = requireSqlite()
    .prepare(
      `SELECT id, user_id AS userId, token_id AS tokenId, expires_at AS expiresAt, revoked_at AS revokedAt
       FROM extension_tokens
       WHERE token_id = ?
         AND revoked_at IS NULL
         AND expires_at > ?`
    )
    .get(tokenId, nowIso) as ExtensionTokenRow | undefined;
  return row ?? null;
}

export async function revokeExtensionTokensForUserId(userId: string, revokedAt: string): Promise<void> {
  if (pgPool) {
    await pgPool.query(
      "UPDATE extension_tokens SET revoked_at = $1 WHERE user_id = $2 AND revoked_at IS NULL",
      [revokedAt, userId]
    );
    return;
  }
  requireSqlite()
    .prepare("UPDATE extension_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
    .run(revokedAt, userId);
}
