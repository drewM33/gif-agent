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
import { framesToGif } from "./encoder";
import {
  getConnection,
  getTask,
  initDatabase,
  insertTask,
  listConnectionsByUserId,
  revokeExtensionTokensForUserId,
  updateTask,
  usePostgres
} from "./db";
import { importConnectionFromStorageState, parseExtraHostsField, type PlaywrightStorageState } from "./connection-import";
import { exchangePairingCode, startExtensionPairing, verifyExtensionBearer } from "./extension-tokens";
import { parseLlmProvider, type LlmProvider } from "./llm-provider";
import { buildPlan, buildPlanFromScreenshot } from "./planner";
import { runTask } from "./task-runner";
import type { Plan } from "./types";

const SAVED_KEY_PROVIDER_MISMATCH_MSG =
  "Your saved API key is registered for the other provider (Claude vs ChatGPT). Match the toggle to that provider, paste a key for the provider you selected, or click Save BYOK again after choosing the correct provider.";

const app = express();
const port = Number(process.env.PORT ?? 3000);
const publicDir = path.resolve("public");
const uploadsDir = path.resolve("files", "uploads");
app.set("trust proxy", 1);
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? process.env.FRONTEND_ORIGIN ?? "")
  .split(",")
  .map((origin) => origin.trim().replace(/\/+$/, ""))
  .filter(Boolean);

const importRateBuckets = new Map<string, { n: number; resetAt: number }>();
const IMPORT_RATE_LIMIT = 30;
const IMPORT_RATE_WINDOW_MS = 60_000;

type CachedPlan = {
  plan: Plan;
  expiresAt: number;
  userId: string | null;
  description: string;
  manualAssist: boolean;
  screenshotPath: string | null;
  screenshotFilePath: string | null;
  apiKey?: string;
  llmProvider: LlmProvider;
};

const planCache = new Map<string, CachedPlan>();
const PLAN_CACHE_TTL_MS = 10 * 60_000;
const PLAN_CACHE_MAX = 200;

function pruneExpiredPlans(): void {
  const now = Date.now();
  for (const [id, row] of planCache) {
    if (row.expiresAt <= now) planCache.delete(id);
  }
  while (planCache.size > PLAN_CACHE_MAX) {
    const oldest = planCache.keys().next().value;
    if (!oldest) break;
    planCache.delete(oldest);
  }
}

function takeCachedPlan(planId: string | null, userId: string | null): CachedPlan | null {
  if (!planId) return null;
  pruneExpiredPlans();
  const row = planCache.get(planId);
  if (!row) return null;
  if (row.expiresAt <= Date.now()) {
    planCache.delete(planId);
    return null;
  }
  if (row.userId && row.userId !== userId) return null;
  planCache.delete(planId);
  return row;
}

function allowImportForUser(userId: string): boolean {
  const now = Date.now();
  const row = importRateBuckets.get(userId);
  if (!row || now > row.resetAt) {
    importRateBuckets.set(userId, { n: 1, resetAt: now + IMPORT_RATE_WINDOW_MS });
    return true;
  }
  if (row.n >= IMPORT_RATE_LIMIT) {
    return false;
  }
  row.n += 1;
  return true;
}

async function assertConnectionUsable(user: AuthUser | null, connectionId: string | null): Promise<void> {
  if (!connectionId) return;
  const conn = await getConnection(connectionId);
  if (!conn) {
    throw Object.assign(new Error("Connection not found."), { status: 404 });
  }
  if (conn.userId) {
    if (!user || user.id !== conn.userId) {
      throw Object.assign(
        new Error("That connection belongs to another account. Sign in as the owner or pick a different connection."),
        { status: 403 }
      );
    }
  }
}

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

function parseOptionalHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
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

function getFrontendOrigin(): string | null {
  return process.env.FRONTEND_ORIGIN?.trim().replace(/\/+$/, "") || null;
}

function sessionCookieOptions(expires: string): express.CookieOptions {
  const crossOriginFrontend = Boolean(getFrontendOrigin());
  return {
    httpOnly: true,
    sameSite: crossOriginFrontend ? "none" : "lax",
    secure: crossOriginFrontend || process.env.NODE_ENV === "production",
    expires: new Date(expires)
  };
}

app.use((req, res, next) => {
  const origin = req.get("origin")?.replace(/\/+$/, "") ?? "";
  const allowChromeExt = origin.startsWith("chrome-extension://");
  if (origin && (allowedOrigins.includes(origin) || allowChromeExt)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});
app.use(express.json({ limit: "50mb" }));
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

  res.cookie("gif_agent_session", session.sessionToken, sessionCookieOptions(session.sessionExpiresAt));
  res.redirect(getFrontendOrigin() ?? "/");
});

app.get("/extension/version", (_req, res) => {
  res.json({
    version: process.env.EXTENSION_VERSION ?? "1.2.0",
    minSupportedVersion: "1.2.0",
    reloadHint: "If your installed version is below minSupportedVersion, call chrome.runtime.reload()."
  });
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
  const user = await getSessionUser(req.cookies?.gif_agent_session);
  await revokeSession(req.cookies?.gif_agent_session);
  if (user) {
    await revokeExtensionTokensForUserId(user.id, new Date().toISOString());
  }
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
    const status = message.includes("Headed browser login is disabled") ? 403 : 500;
    res.status(status).json({ error: message });
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

app.get("/connections", async (req, res) => {
  try {
    const user = await getSessionUser(req.cookies?.gif_agent_session);
    if (!user) {
      res.status(401).json({ error: "Not authenticated." });
      return;
    }
    const rows = await listConnectionsByUserId(user.id);
    res.json({
      connections: rows.map((c) => ({
        id: c.id,
        name: c.name,
        domain: c.domain,
        startUrl: c.startUrl,
        createdAt: c.createdAt
      }))
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

app.post("/connections/pair/start", async (req, res) => {
  try {
    const user = await getSessionUser(req.cookies?.gif_agent_session);
    if (!user) {
      res.status(401).json({ error: "Not authenticated." });
      return;
    }
    const out = await startExtensionPairing(user.id);
    res.json(out);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

app.post("/connections/pair/exchange", async (req, res) => {
  try {
    const code = String(req.body?.code ?? "").trim();
    if (!code) {
      res.status(400).json({ error: "code is required." });
      return;
    }
    const out = await exchangePairingCode(code);
    res.json(out);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message.includes("Invalid") || message.includes("expired") ? 400 : 500;
    res.status(status).json({ error: message });
  }
});

app.post("/connections/import", async (req, res) => {
  try {
    const bearerUserId = await verifyExtensionBearer(req.get("authorization"));
    const sessionUser = await getSessionUser(req.cookies?.gif_agent_session);
    const userId = bearerUserId ?? (sessionUser ? sessionUser.id : null);
    if (!userId) {
      res.status(401).json({ error: "Authenticate with a Bearer extension token or sign in to the web app." });
      return;
    }

    const name = String(req.body?.name ?? "").trim();
    const startUrl = String(req.body?.startUrl ?? "").trim();
    const storageState = req.body?.storageState as PlaywrightStorageState | undefined;
    const extraHosts = parseExtraHostsField(
      typeof req.body?.extraHosts === "string"
        ? req.body.extraHosts
        : Array.isArray(req.body?.extraHosts)
          ? (req.body.extraHosts as string[]).join(",")
          : undefined
    );

    if (!storageState || typeof storageState !== "object") {
      res.status(400).json({ error: "storageState object is required." });
      return;
    }
    if (!startUrl) {
      res.status(400).json({ error: "startUrl is required (current page URL)." });
      return;
    }
    if (!allowImportForUser(userId)) {
      res.status(429).json({ error: "Too many imports. Try again in a minute." });
      return;
    }

    const result = await importConnectionFromStorageState({
      userId,
      name: name || "Imported session",
      startUrl,
      storageState,
      extraHosts
    });
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(400).json({ error: message });
  }
});

app.post("/tasks", async (req, res) => {
  try {
    const user = await getSessionUser(req.cookies?.gif_agent_session);
    const question = String(req.body?.question ?? "").trim();
    const manualAssist = parseBoolean(req.body?.manualAssist);
    const startUrlHint = parseOptionalHttpUrl(req.body?.startUrlHint ?? req.body?.pageUrl);
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

    await assertConnectionUsable(user, connectionId);

    const id = randomUUID();
    await insertTask({ id, question, connectionId });

    void runTask(id, { manualAssist, apiKey, llmProvider, startUrlHint });

    res.status(202).json({
      id,
      status: "queued",
      statusUrl: `/tasks/${id}`
    });
  } catch (error) {
    const status =
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      typeof (error as { status: unknown }).status === "number"
        ? (error as { status: number }).status
        : 500;
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(status).json({ error: message });
  }
});

function isGifAgentHostingHostname(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().includes("gif-agent");
  } catch {
    return false;
  }
}

function isBrowserExecutableUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function unsupportedPlanUrl(plan: Plan): string | null {
  if (!isBrowserExecutableUrl(plan.startUrl)) {
    return plan.startUrl;
  }
  for (const step of plan.steps) {
    if (step.action === "navigate" && !isBrowserExecutableUrl(step.url)) {
      return step.url;
    }
  }
  return null;
}

/**
 * Plan-only endpoint. Returns the plan (and a planId that can be reused by
 * /ui/tasks) without running the executor. Enables the frontend to auto-detect
 * the target site URL before triggering the auto-pairing flow.
 */
app.post("/plan/preview", upload.single("screenshot"), async (req, res) => {
  try {
    const user = await getSessionUser(req.cookies?.gif_agent_session);
    const description = String(req.body?.description ?? "").trim();
    if (!description) {
      res.status(400).json({ error: "description is required." });
      return;
    }
    const resolved = await resolveTaskLlm(user, req.body);
    if (resolved.savedKeyProviderMismatch) {
      res.status(400).json({ error: SAVED_KEY_PROVIDER_MISMATCH_MSG });
      return;
    }
    if (!resolved.apiKey) {
      res.status(400).json({
        error: "A vision-capable API key is required to preview the plan. Sign in and save BYOK, or paste a key in the UI."
      });
      return;
    }
    const startUrlHint = parseOptionalHttpUrl(req.body?.startUrlHint ?? req.body?.pageUrl);
    const manualAssist = parseBoolean(req.body?.manualAssist);
    const screenshotPath = req.file ? `/files/uploads/${req.file.filename}` : null;
    const screenshotFilePath = req.file?.path ?? null;
    const question = screenshotPath
      ? `${description}\n\nUploaded screenshot: ${screenshotPath}`
      : description;
    const hint =
      screenshotFilePath && startUrlHint && isGifAgentHostingHostname(startUrlHint) ? undefined : startUrlHint;
    const plannerOptions = { apiKey: resolved.apiKey, llmProvider: resolved.llmProvider };
    const plan = screenshotFilePath
      ? await buildPlanFromScreenshot({ question, startUrlHint: hint }, screenshotFilePath, plannerOptions)
      : await buildPlan({ question, startUrlHint: hint }, plannerOptions);

    pruneExpiredPlans();
    const planId = randomUUID();
    planCache.set(planId, {
      plan,
      expiresAt: Date.now() + PLAN_CACHE_TTL_MS,
      userId: user?.id ?? null,
      description,
      manualAssist,
      screenshotPath,
      screenshotFilePath,
      apiKey: resolved.apiKey,
      llmProvider: resolved.llmProvider
    });

    res.status(200).json({
      planId,
      expiresInSec: Math.floor(PLAN_CACHE_TTL_MS / 1000),
      plan: {
        startUrl: plan.startUrl,
        stepCount: Array.isArray(plan.steps) ? plan.steps.length : 0
      }
    });
  } catch (error) {
    const status =
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      typeof (error as { status: unknown }).status === "number"
        ? (error as { status: number }).status
        : 500;
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(status).json({ error: message });
  }
});

app.post("/ui/tasks", upload.single("screenshot"), async (req, res) => {
  try {
    const user = await getSessionUser(req.cookies?.gif_agent_session);
    const description = String(req.body?.description ?? "").trim();
    const manualAssist = parseBoolean(req.body?.manualAssist);
    const startUrlHint = parseOptionalHttpUrl(req.body?.startUrlHint ?? req.body?.pageUrl);
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
    const executionMode = req.body?.executionMode === "extension_tab" ? "extension_tab" : "server_browser";

    if (!description) {
      res.status(400).json({ error: "description is required." });
      return;
    }

    await assertConnectionUsable(user, connectionId);

    const planIdInput =
      typeof req.body?.planId === "string" && req.body.planId.trim() ? req.body.planId.trim() : null;
    const cached = takeCachedPlan(planIdInput, user?.id ?? null);

    const screenshotPath = req.file
      ? `/files/uploads/${req.file.filename}`
      : cached?.screenshotPath ?? null;
    const question = screenshotPath
      ? `${description}\n\nUploaded screenshot: ${screenshotPath}`
      : description;

    const id = randomUUID();
    await insertTask({ id, question, connectionId });
    if (executionMode === "extension_tab") {
      const screenshotFilePath = req.file?.path ?? cached?.screenshotFilePath ?? undefined;
      const plannerInput = {
        question,
        startUrlHint:
          screenshotFilePath && startUrlHint && isGifAgentHostingHostname(startUrlHint) ? undefined : startUrlHint
      };
      const plannerOptions = { apiKey, llmProvider };
      const plan = cached?.plan
        ? cached.plan
        : screenshotFilePath
          ? await buildPlanFromScreenshot(plannerInput, screenshotFilePath, plannerOptions)
          : await buildPlan(plannerInput, plannerOptions);
      const unsupportedUrl = unsupportedPlanUrl(plan);
      if (unsupportedUrl) {
        const message =
          `Chrome blocks extensions and web apps from automating browser-internal pages like ${unsupportedUrl}. ` +
          "Open chrome://extensions manually, turn on Developer mode, then click Load unpacked.";
        await updateTask(id, { status: "error", planJson: JSON.stringify(plan, null, 2), error: message });
        res.status(400).json({ error: message, statusUrl: `/tasks/${id}` });
        return;
      }
      await updateTask(id, { status: "running", planJson: JSON.stringify(plan, null, 2), error: null });
      res.status(202).json({
        id,
        status: "running",
        screenshotPath,
        manualAssist,
        reusedPlan: Boolean(cached),
        statusUrl: `/tasks/${id}`,
        extensionExecution: {
          taskId: id,
          plan
        }
      });
      return;
    }

    void runTask(id, {
      manualAssist,
      screenshotFilePath: req.file?.path ?? cached?.screenshotFilePath ?? undefined,
      apiKey,
      llmProvider,
      startUrlHint,
      prebuiltPlan: cached?.plan
    });

    res.status(202).json({
      id,
      status: "queued",
      screenshotPath,
      manualAssist,
      reusedPlan: Boolean(cached),
      statusUrl: `/tasks/${id}`
    });
  } catch (error) {
    const status =
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      typeof (error as { status: unknown }).status === "number"
        ? (error as { status: number }).status
        : 500;
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(status).json({ error: message });
  }
});

app.post("/tasks/:id/extension-result", async (req, res) => {
  try {
    const bearerUserId = await verifyExtensionBearer(req.get("authorization"));
    if (!bearerUserId) {
      res.status(401).json({ error: "Valid extension Bearer token required." });
      return;
    }

    const task = await getTask(req.params.id);
    if (!task) {
      res.status(404).json({ error: "Task not found." });
      return;
    }

    if (String(req.body?.status || "") === "error") {
      const message = String(req.body?.error || "Extension execution failed.");
      await updateTask(req.params.id, { status: "error", error: message });
      res.json({ ok: true, status: "error" });
      return;
    }

    const frames = Array.isArray(req.body?.frames)
      ? req.body.frames.filter((v: unknown): v is string => typeof v === "string")
      : [];
    if (frames.length === 0) {
      res.status(400).json({ error: "frames array is required." });
      return;
    }
    if (frames.length > 120) {
      res.status(400).json({ error: "Too many frames." });
      return;
    }

    const recordingsDir = path.join("files", "recordings", req.params.id);
    const framesDir = path.join(recordingsDir, "frames");
    fs.mkdirSync(framesDir, { recursive: true });
    let writtenFrames = 0;
    let frameExtension: "jpg" | "png" = "png";
    for (const frame of frames) {
      const match = frame.match(/^data:image\/(png|jpe?g);base64,([\s\S]+)$/i);
      if (!match) continue;
      const nextExtension = /^jpe?g$/i.test(match[1]) ? "jpg" : "png";
      if (writtenFrames === 0) {
        frameExtension = nextExtension;
      }
      if (nextExtension !== frameExtension) continue;
      writtenFrames += 1;
      const output = path.join(framesDir, `frame-${String(writtenFrames).padStart(4, "0")}.${frameExtension}`);
      fs.writeFileSync(output, Buffer.from(match[2], "base64"));
    }
    if (writtenFrames === 0) {
      res.status(400).json({ error: "No valid image frames were uploaded." });
      return;
    }

    const gifPath = path.join("files", "recordings", req.params.id, "video.gif");
    await framesToGif({
      framesDir,
      outputGifPath: gifPath,
      frameExtension
    });
    await updateTask(req.params.id, {
      status: "done",
      outputUrl: `/files/recordings/${req.params.id}/video.gif`,
      error: null
    });
    res.json({ ok: true, status: "done" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: message });
  }
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
