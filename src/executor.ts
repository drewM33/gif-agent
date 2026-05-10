import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { chromium, type BrowserContextOptions, type Locator, type Page } from "playwright";
import type { Plan, PlanStep } from "./types";

const BLOCKED_CLICK_TEXT = /create|delete|submit|send|charge|publish/i;
type StorageState = Exclude<BrowserContextOptions["storageState"], string | undefined>;
const CAPTCHA_HINT_TEXT = /not a robot|unusual traffic|verify you are human|captcha|recaptcha/i;
const SELECTOR_TIMEOUT_MS = 2_500;
const INVISIBLE_RECAPTCHA_FRAME = /google\.com\/recaptcha\/api2\/aframe/i;

const CURSOR_ID = "__gif_agent_cursor";

async function ensureCursor(page: Page): Promise<void> {
  await page.evaluate((cursorId) => {
    if (document.getElementById(cursorId)) return;
    const parent = document.body ?? document.documentElement;
    if (!parent) return;
    const cursor = document.createElement("div");
    cursor.id = cursorId;
    Object.assign(cursor.style, {
      position: "fixed",
      width: "34px",
      height: "34px",
      borderRadius: "999px 999px 999px 6px",
      background: "linear-gradient(135deg, #8b5cf6, #ec4899)",
      border: "3px solid rgba(255,255,255,0.95)",
      boxShadow: "0 6px 18px rgba(0,0,0,0.45), 0 0 0 4px rgba(139,92,246,0.25)",
      zIndex: "2147483647",
      pointerEvents: "none",
      left: "20px",
      top: "20px",
      transform: "translate(-50%, -50%) rotate(-45deg)",
      transition: "left 0.35s ease, top 0.35s ease"
    } as Partial<CSSStyleDeclaration>);
    const shine = document.createElement("div");
    Object.assign(shine.style, {
      position: "absolute",
      width: "9px",
      height: "9px",
      borderRadius: "999px",
      background: "rgba(255,255,255,0.85)",
      left: "8px",
      top: "7px"
    } as Partial<CSSStyleDeclaration>);
    cursor.appendChild(shine);
    parent.appendChild(cursor);
  }, CURSOR_ID);
}

async function moveCursor(page: Page, x: number, y: number): Promise<void> {
  await ensureCursor(page);
  await page.evaluate(
    ({ cursorId, xPos, yPos }) => {
      const cursor = document.getElementById(cursorId);
      if (!cursor) return;
      cursor.style.left = `${xPos}px`;
      cursor.style.top = `${yPos}px`;
    },
    { cursorId: CURSOR_ID, xPos: x, yPos: y }
  );
  await page.waitForTimeout(360);
}

function selectorCandidates(selector: string): string[] {
  const candidates = [selector];
  const normalized = selector.replace(/\s+/g, "").toLowerCase();
  const signInLike =
    normalized.includes("servicelogin") ||
    normalized.includes("accounts.google.com") ||
    normalized.includes("signin") ||
    normalized.includes("sign-in") ||
    normalized.includes("sign_in") ||
    normalized.includes("sign in");
  const predictionMarketsLike =
    normalized.includes("prediction-markets") || normalized.includes("predictionmarkets");

  if (normalized === "input[name='q']" || normalized === 'input[name="q"]') {
    candidates.push(
      'textarea[name="q"]',
      '[name="q"]',
      'textarea[aria-label="Search"]',
      'input[aria-label="Search"]'
    );
  }

  if (signInLike) {
    candidates.push(
      'a[href*="ServiceLogin"]',
      'a[href*="accounts.google.com"]',
      'a[aria-label*="Sign in" i]',
      'button[aria-label*="Sign in" i]',
      'a:has-text("Sign in")',
      'button:has-text("Sign in")',
      'text=Sign in'
    );
  }

  if (predictionMarketsLike) {
    candidates.push(
      'a[href*="prediction-markets"]',
      'a:has-text("Prediction Markets")',
      'button:has-text("Prediction Markets")',
      'text=Prediction Markets'
    );
  }

  return [...new Set(candidates)];
}

async function firstVisibleLocator(page: Page, selector: string): Promise<Locator | null> {
  for (const candidate of selectorCandidates(selector)) {
    try {
      const matches = page.locator(candidate);
      await matches.first().waitFor({ state: "attached", timeout: SELECTOR_TIMEOUT_MS }).catch(() => undefined);
      const count = Math.min(await matches.count(), 25);
      for (let i = 0; i < count; i += 1) {
        const locator = matches.nth(i);
        if (await locator.isVisible().catch(() => false)) {
          return locator;
        }
      }
    } catch {
      // Try the next selector candidate.
    }
  }
  return null;
}

async function requireVisibleLocator(page: Page, selector: string, action: string): Promise<Locator> {
  const locator = await firstVisibleLocator(page, selector);
  if (!locator) {
    throw new Error(`Could not ${action}: no visible element matched ${selector}`);
  }
  return locator;
}

async function moveCursorToLocator(locator: Locator): Promise<void> {
  const box = await locator.boundingBox({ timeout: SELECTOR_TIMEOUT_MS });
  if (!box) return;
  await moveCursor(locator.page(), box.x + box.width / 2, box.y + box.height / 2);
}

async function applyCaption(page: Page, caption: string): Promise<void> {
  // This function body is injected in the browser context.
  const fn = (text: string) => {
    const id = "__gif_agent_caption";
    let el = document.getElementById(id);
    if (!el) {
      const parent = document.body ?? document.documentElement;
      if (!parent) return;
      el = document.createElement("div");
      el.id = id;
      Object.assign(el.style, {
        position: "fixed",
        left: "16px",
        bottom: "16px",
        zIndex: "2147483647",
        background: "rgba(0, 0, 0, 0.75)",
        color: "white",
        fontFamily: "Inter, Arial, sans-serif",
        fontSize: "16px",
        lineHeight: "1.4",
        borderRadius: "10px",
        padding: "10px 12px",
        maxWidth: "65vw",
        pointerEvents: "none"
      } as Partial<CSSStyleDeclaration>);
      parent.appendChild(el);
    }
    el.textContent = text;
  };

  await page.evaluate(fn, caption);
}

async function notifyCaptchaNeeded(page: Page): Promise<void> {
  await page.bringToFront().catch(() => undefined);

  if (process.platform !== "darwin") {
    process.stdout.write("\u0007");
    return;
  }

  await new Promise<void>((resolve) => {
    execFile(
      "osascript",
      [
        "-e",
        `display notification "A captcha needs your attention in the browser window." with title "gif-agent"`
      ],
      () => resolve()
    );
  });
}

async function isCaptchaChallenge(page: Page): Promise<boolean> {
  const url = page.url().toLowerCase();
  if (url.includes("google.com/sorry") || url.includes("recaptcha")) {
    return true;
  }

  const blockingCaptchaFrames = page
    .frames()
    .filter((frame) => {
      const frameUrl = frame.url();
      return /recaptcha|turnstile|challenge/i.test(frameUrl) && !INVISIBLE_RECAPTCHA_FRAME.test(frameUrl);
    });
  if (blockingCaptchaFrames.length > 0) {
    return true;
  }

  const textContent = await page.evaluate(() => document.body?.innerText ?? "");
  return CAPTCHA_HINT_TEXT.test(textContent);
}

async function maybeHandleCaptcha(page: Page, manualAssist: boolean): Promise<void> {
  const challenged = await isCaptchaChallenge(page);
  if (!challenged) return;

  if (!manualAssist) {
    throw new Error(
      "Captcha challenge detected. Re-run with manual assist enabled or use an authenticated connectionId."
    );
  }

  await applyCaption(
    page,
    "Captcha detected. Please solve it in the browser window now. Recording resumes automatically."
  );
  await notifyCaptchaNeeded(page);

  const timeoutMs = 120000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(2000);
    if (!(await isCaptchaChallenge(page))) {
      await applyCaption(page, "Captcha solved. Continuing walkthrough.");
      await page.waitForTimeout(700);
      return;
    }
  }

  throw new Error("Timed out waiting for manual captcha solve.");
}

function shouldBlockClick(step: Extract<PlanStep, { action: "click" }>): boolean {
  return BLOCKED_CLICK_TEXT.test(step.selector);
}

export async function executePlan(input: {
  plan: Plan;
  taskId: string;
  storageState?: StorageState;
  manualAssist?: boolean;
}): Promise<{ recordedVideoPath: string }> {
  const recordingsDir = path.join("files", "recordings", input.taskId);
  fs.mkdirSync(recordingsDir, { recursive: true });

  const browser = await chromium.launch({ headless: !(input.manualAssist ?? false) });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    storageState: input.storageState,
    recordVideo: {
      dir: recordingsDir,
      size: { width: 1440, height: 900 }
    }
  });
  const page = await context.newPage();
  const video = page.video();

  await page.goto(input.plan.startUrl, { waitUntil: "domcontentloaded" });
  await ensureCursor(page);
  await applyCaption(page, "Opened start URL");
  await maybeHandleCaptcha(page, input.manualAssist ?? false);
  await page.waitForTimeout(700);

  for (const step of input.plan.steps) {
    switch (step.action) {
      case "navigate":
        await page.goto(step.url, { waitUntil: "domcontentloaded" });
        await applyCaption(page, step.caption ?? `Navigate to ${step.url}`);
        await maybeHandleCaptcha(page, input.manualAssist ?? false);
        await page.waitForTimeout(700);
        break;
      case "hover":
        {
          const locator = await firstVisibleLocator(page, step.selector);
          if (!locator) {
            await applyCaption(page, `Could not find ${step.selector}; continuing.`);
            await page.waitForTimeout(700);
            break;
          }
          await moveCursorToLocator(locator);
          await locator.hover();
        }
        await applyCaption(page, step.caption ?? `Hover ${step.selector}`);
        await page.waitForTimeout(700);
        break;
      case "highlight":
        {
          const locator = await firstVisibleLocator(page, step.selector);
          if (!locator) {
            await applyCaption(page, `Could not find ${step.selector}; continuing.`);
            await page.waitForTimeout(700);
            break;
          }
          await moveCursorToLocator(locator);
          await locator.evaluate((node) => {
            (node as HTMLElement).style.outline = "3px solid #22c55e";
            (node as HTMLElement).style.outlineOffset = "2px";
          });
        }
        await applyCaption(page, step.caption ?? `Highlight ${step.selector}`);
        await page.waitForTimeout(1000);
        break;
      case "type":
        {
          const locator = await requireVisibleLocator(page, step.selector, "type into");
          await moveCursorToLocator(locator);
          await locator.fill(step.text);
        }
        await applyCaption(page, step.caption ?? `Type into ${step.selector}`);
        await page.waitForTimeout(700);
        break;
      case "wait":
        await applyCaption(page, step.caption ?? `Wait ${step.ms}ms`);
        await page.waitForTimeout(step.ms);
        break;
      case "click":
        {
          const locator = await requireVisibleLocator(page, step.selector, "click");
          await moveCursorToLocator(locator);
        if (shouldBlockClick(step)) {
          await locator.hover();
          await applyCaption(
            page,
            step.caption ?? `Blocked potentially destructive click: ${step.selector}`
          );
          await page.waitForTimeout(900);
        } else {
          await locator.click({ timeout: 8_000 });
          await applyCaption(page, step.caption ?? `Click ${step.selector}`);
          await page.waitForTimeout(900);
        }
        }
        break;
      default:
        break;
    }

    await maybeHandleCaptcha(page, input.manualAssist ?? false);
  }

  await context.close();
  const recordedVideoPath = await video?.path();
  await browser.close();

  if (!recordedVideoPath) {
    throw new Error("Playwright did not produce a video recording.");
  }

  return { recordedVideoPath };
}
