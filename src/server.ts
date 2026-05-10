import "dotenv/config";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import cookieParser from "cookie-parser";
import express from "express";
import multer from "multer";
import {
  consumeMagicLink,
  getSessionUser,
  getUserApiKey,
  requestMagicLink,
  revokeSession,
  saveUserApiKey,
  type AuthUser
} from "./auth";
import { finishConnectionLogin, startConnectionLogin } from "./connections";
import { getTask, initDatabase, insertTask, usePostgres } from "./db";
import { parseLlmProvider, type LlmProvider } from "./llm-provider";
import { runTask } from "./task-runner";

const SAVED_KEY_PROVIDER_MISMATCH_MSG =
  "Your saved API key is registered for the other provider (Claude vs ChatGPT). Match the toggle to that provider, paste a key for the provider you selected, or click Save BYOK again after choosing the correct provider.";

const app = express();
const port = Number(process.env.PORT ?? 3000);
const publicDir = path.resolve("public");
const uploadsDir = path.resolve("files", "uploads");
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? process.env.FRONTEND_ORIGIN ?? "")
  .split(",")
  .map((origin) => origin.trim().replace(/\/+$/, ""))
  .filter(Boolean);

fs.mkdirSync(path.join("files", "recordings"), { recursive: true });
fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
      const extension = path.extname(file.originalname) || ".png";
      cb(null, `${Date.now()}-${randomUUID()}${extension}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 }
});

function parseBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
  }
  return false;
}

function parseApiKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, 512);
}

type ResolvedTaskLlm = {
  apiKey?: string;
  llmProvider: LlmProvider;
  /** Saved BYOK exists but belongs to the other provider than the UI toggle. */
  savedKeyProviderMismatch?: true;
};

async function resolveTaskLlm(
  user: AuthUser | null,
  body: { apiKey?: unknown; llmProvider?: unknown }
): Promise<ResolvedTaskLlm> {
  const bodyKey = parseApiKey(body.apiKey);
  const bodyProv = parseLlmProvider(body.llmProvider);
  if (bodyKey) {
    return { apiKey: bodyKey, llmProvider: bodyProv };
  }
  if (user) {
    const saved = await getUserApiKey(user.id);
    if (saved) {
      if (user.llmProvider === bodyProv) {
        return { apiKey: saved, llmProvider: bodyProv };
      }
      return { apiKey: undefined, llmProvider: bodyProv, savedKeyProviderMismatch: true };
    }
  }
  return { apiKey: undefined, llmProvider: bodyProv };
}

function getAppOrigin(req: express.Request): string {
  const configured = process.env.APP_ORIGIN?.trim();
  if (configured) return configured;
  const protocol = req.protocol || "http";
  return `${protocol}://${req.get("host")}`;
}

app.use((req, res, next) => {
  const origin = req.get("origin")?.replace(/\/+$/, "");
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});
app.use(express.json());
app.use(cookieParser());
app.use("/files", express.static(path.resolve("files")));
app.use(express.static(publicDir));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/auth/request-link", async (req, res) => {
  try {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: "Valid email is required." });
      return;
    }

    const delivery = await requestMagicLink(email, getAppOrigin(req));
    res.json({
      ok: true,
      message: "If that email is valid, a sign-in link has been sent.",
      delivery: delivery.delivery,
      consoleLink: delivery.linkUrl ?? null
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

app.get("/auth/verify", async (req, res) => {
  const token = String(req.query?.token ?? "");
  const session = await consumeMagicLink(token);
  if (!session) {
    res.status(400).send("Magic link is invalid or expired.");
    return;
  }

  const secure = req.protocol === "https";
  res.cookie("gif_agent_session", session.sessionToken, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    expires: new Date(session.sessionExpiresAt)
  });
  res.redirect("/");
});

app.get("/auth/me", async (req, res) => {
  const user = await getSessionUser(req.cookies?.gif_agent_session);
  res.json({
    authenticated: Boolean(user),
    user: user
      ? {
          id: user.id,
          email: user.email,
          createdAt: user.createdAt,
          hasSavedApiKey: user.hasSavedApiKey,
          llmProvider: user.llmProvider
        }
      : null
  });
});

app.post("/auth/logout", async (req, res) => {
  await revokeSession(req.cookies?.gif_agent_session);
  res.clearCookie("gif_agent_session");
  res.json({ ok: true });
});

app.post("/auth/api-key", async (req, res) => {
  const user = await getSessionUser(req.cookies?.gif_agent_session);
  if (!user) {
    res.status(401).json({ error: "Not authenticated." });
    return;
  }

  const key = parseApiKey(req.body?.apiKey) ?? "";
  const llmProvider = parseLlmProvider(req.body?.llmProvider);
  await saveUserApiKey(user.id, key, llmProvider);
  res.json({ ok: true, hasSavedApiKey: Boolean(key), llmProvider });
});

app.post("/connections/login", async (req, res) => {
  try {
    const name = String(req.body?.name ?? "").trim();
    const startUrl = String(req.body?.startUrl ?? "").trim();
    if (!name || !startUrl) {
      res.status(400).json({ error: "name and startUrl are required." });
      return;
    }

    const result = await startConnectionLogin({ name, startUrl });
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

app.post("/connections/login/:loginId/finish", async (req, res) => {
  try {
    const result = await finishConnectionLogin(req.params.loginId);
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(400).json({ error: message });
  }
});

app.post("/tasks", async (req, res) => {
  const user = await getSessionUser(req.cookies?.gif_agent_session);
  const question = String(req.body?.question ?? "").trim();
  const manualAssist = parseBoolean(req.body?.manualAssist);
  const resolved = await resolveTaskLlm(user, req.body);
  if (resolved.savedKeyProviderMismatch) {
    res.status(400).json({ error: SAVED_KEY_PROVIDER_MISMATCH_MSG });
    return;
  }
  const { apiKey, llmProvider } = resolved;
  const connectionId =
    req.body?.connectionId === null || req.body?.connectionId === undefined
      ? null
      : String(req.body.connectionId);

  if (!question) {
    res.status(400).json({ error: "question is required." });
    return;
  }

  const id = randomUUID();
  await insertTask({ id, question, connectionId });

  void runTask(id, { manualAssist, apiKey, llmProvider });

  res.status(202).json({
    id,
    status: "queued",
    statusUrl: `/tasks/${id}`
  });
});

app.post("/ui/tasks", upload.single("screenshot"), async (req, res) => {
  const user = await getSessionUser(req.cookies?.gif_agent_session);
  const description = String(req.body?.description ?? "").trim();
  const manualAssist = parseBoolean(req.body?.manualAssist);
  const resolved = await resolveTaskLlm(user, req.body);
  if (resolved.savedKeyProviderMismatch) {
    res.status(400).json({ error: SAVED_KEY_PROVIDER_MISMATCH_MSG });
    return;
  }
  const { apiKey, llmProvider } = resolved;
  const connectionId =
    req.body?.connectionId === null ||
    req.body?.connectionId === undefined ||
    String(req.body?.connectionId).trim() === ""
      ? null
      : String(req.body.connectionId).trim();

  if (!description) {
    res.status(400).json({ error: "description is required." });
    return;
  }

  const screenshotPath = req.file ? `/files/uploads/${req.file.filename}` : null;
  const question = screenshotPath
    ? `${description}\n\nUploaded screenshot: ${screenshotPath}`
    : description;

  const id = randomUUID();
  await insertTask({ id, question, connectionId });
  void runTask(id, { manualAssist, screenshotFilePath: req.file?.path, apiKey, llmProvider });

  res.status(202).json({
    id,
    status: "queued",
    screenshotPath,
    manualAssist,
    statusUrl: `/tasks/${id}`
  });
});

app.get("/tasks/:id", async (req, res) => {
  const task = await getTask(req.params.id);
  if (!task) {
    res.status(404).json({ error: "Task not found." });
    return;
  }

  res.json({
    id: task.id,
    status: task.status,
    outputUrl: task.outputUrl,
    error: task.error,
    plan: task.planJson ? JSON.parse(task.planJson) : null
  });
});

async function main(): Promise<void> {
  await initDatabase();
  const store = usePostgres() ? "postgres (Supabase/DATABASE_URL)" : "sqlite";
  process.stdout.write(`gif-agent data store: ${store}\n`);

  app.listen(port, () => {
    process.stdout.write(`gif-agent listening on http://localhost:${port}\n`);
  });
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
