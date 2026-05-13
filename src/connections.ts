import { randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from "playwright";
import { decryptText, encryptText } from "./crypto";
import { getConnection, insertConnection } from "./db";

type StorageState = Exclude<BrowserContextOptions["storageState"], string | undefined>;

type PendingLogin = {
  loginId: string;
  name: string;
  startUrl: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
};

const pendingLogins = new Map<string, PendingLogin>();

function toDomain(urlString: string): string {
  const url = new URL(urlString);
  return url.hostname;
}

export async function startConnectionLogin(input: {
  name: string;
  startUrl: string;
}): Promise<{ loginId: string; message: string }> {
  if (process.env.ENABLE_HEADFUL_BROWSER !== "true") {
    throw new Error(
      "Headed browser login is disabled on this server. Use the Chrome extension to capture your session, or set ENABLE_HEADFUL_BROWSER=true for local headed login."
    );
  }
  const loginId = randomUUID();
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(input.startUrl, { waitUntil: "domcontentloaded" });

  pendingLogins.set(loginId, {
    loginId,
    name: input.name,
    startUrl: input.startUrl,
    browser,
    context,
    page
  });

  return {
    loginId,
    message: "A browser opened. Complete login, then call /connections/login/:loginId/finish."
  };
}

export async function finishConnectionLogin(loginId: string): Promise<{
  id: string;
  name: string;
  domain: string;
  startUrl: string;
  createdAt: string;
}> {
  const pending = pendingLogins.get(loginId);
  if (!pending) {
    throw new Error("Unknown loginId.");
  }

  const state = await pending.context.storageState();
  const encryptedState = encryptText(JSON.stringify(state));

  const id = randomUUID();
  const domain = toDomain(pending.startUrl);
  await insertConnection({
    id,
    name: pending.name,
    domain,
    startUrl: pending.startUrl,
    encryptedState
  });

  pendingLogins.delete(loginId);
  await pending.browser.close();

  return {
    id,
    name: pending.name,
    domain,
    startUrl: pending.startUrl,
    createdAt: new Date().toISOString()
  };
}

export async function getConnectionState(connectionId: string): Promise<StorageState> {
  const connection = await getConnection(connectionId);
  if (!connection) {
    throw new Error("Connection not found.");
  }

  const decoded = decryptText(connection.encryptedState);
  return JSON.parse(decoded) as StorageState;
}
