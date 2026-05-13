import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { chromium, type BrowserContextOptions, type Locator, type Page } from "playwright";
import { extractJson } from "./json-extract";
import type { LlmProvider } from "./llm-provider";
import type { Plan, PlanStep } from "./types";

const BLOCKED_CLICK_TEXT = /create|delete|submit|send|charge|publish/i;
type StorageState = Exclude<BrowserContextOptions["storageState"], string | undefined>;
const CAPTCHA_HINT_TEXT = /not a robot|unusual traffic|verify you are human|captcha|recaptcha/i;
const SELECTOR_TIMEOUT_MS = 2_500;
const INVISIBLE_RECAPTCHA_FRAME = /google\.com\/recaptcha\/api2\/aframe/i;
const MAX_REPAIR_CANDIDATES = 80;

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
  const phrases = new Set<string>();

  for (const match of selector.matchAll(/["']([^"']{2,120})["']/g)) {
    const phrase = match[1].replace(/^https?:\/\/[^/]+\//i, "").replace(/[/?#].*$/, "");
    if (phrase) phrases.add(phrase);
  }

  for (const raw of Array.from(phrases)) {
    const words = raw
      .replace(/[-_+/]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (words && words !== raw) phrases.add(words.replace(/\b\w/g, (c) => c.toUpperCase()));
  }

  for (const phrase of phrases) {
    const cssText = phrase.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    candidates.push(
      `[aria-label*="${cssText}" i]`,
      `[title*="${cssText}" i]`,
      `[placeholder*="${cssText}" i]`,
      `[role="button"]:has-text("${cssText}")`,
      `[role="link"]:has-text("${cssText}")`,
      `a:has-text("${cssText}")`,
      `button:has-text("${cssText}")`,
      `text=${phrase}`
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

type SelectorRepairOptions = {
  apiKey?: string;
  llmProvider?: LlmProvider;
  taskGoal?: string;
};

type RepairCandidate = {
  index: number;
  tag: string;
  text: string;
  ariaLabel: string | null;
  title: string | null;
  role: string | null;
  href: string | null;
  placeholder: string | null;
  name: string | null;
  id: string | null;
  rect: { x: number; y: number; width: number; height: number };
};

async function collectRepairCandidates(page: Page): Promise<RepairCandidate[]> {
  return page.evaluate((maxCandidates) => {
    const selector = [
      "a",
      "button",
      "input",
      "textarea",
      "select",
      '[role="button"]',
      '[role="link"]',
      '[role="menuitem"]',
      '[contenteditable="true"]',
      "[tabindex]"
    ].join(",");

    const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector));
    const candidates: RepairCandidate[] = [];
    for (const node of nodes) {
      if (node.id === "__gif_agent_cursor" || node.id === "__gif_agent_caption") continue;
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      const visible =
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        Number(style.opacity || "1") > 0;
      if (!visible) continue;

      const index = candidates.length;
      node.setAttribute("data-gif-agent-candidate", String(index));
      candidates.push({
        index,
        tag: node.tagName.toLowerCase(),
        text: (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 140),
        ariaLabel: node.getAttribute("aria-label"),
        title: node.getAttribute("title"),
        role: node.getAttribute("role"),
        href: node.getAttribute("href"),
        placeholder: node.getAttribute("placeholder"),
        name: node.getAttribute("name"),
        id: node.id || null,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      });

      if (candidates.length >= maxCandidates) break;
    }
    return candidates;
  }, MAX_REPAIR_CANDIDATES);
}

function buildRepairPrompt(input: {
  step: Extract<PlanStep, { selector: string }>;
  action: string;
  url: string;
  candidates: RepairCandidate[];
  taskGoal?: string;
}): string {
  return `
You are repairing a browser automation selector using the current screenshot and visible interactive elements.

Overall user request: ${input.taskGoal ?? "unknown"}
Current URL: ${input.url}
Intended action: ${input.action}
Original selector that failed: ${input.step.selector}
Step caption: ${input.step.caption ?? "none"}
${"text" in input.step ? `Text to type: ${input.step.text}` : ""}

Visible candidates:
${JSON.stringify(input.candidates, null, 2)}

Pick the single candidate that best matches the intended action. Understand semantic intent:
- Infer what the user is trying to do from the screenshot, the overall request, the step caption, and candidate labels.
- Choose the visible control that a human would use next for that intent, even if its text is not an exact selector match.
- Prefer controls whose visual position, accessibility label, text, or iconography supports the intended action.

Return JSON only:
{
  "candidateIndex": 0,
  "confidence": 0.0,
  "reason": "brief visual/accessibility evidence"
}

If no candidate matches, return {"candidateIndex": null, "confidence": 0, "reason": "why"}.
`.trim();
}

async function repairSelectorWithOpenAI(
  page: Page,
  step: Extract<PlanStep, { selector: string }>,
  action: string,
  candidates: RepairCandidate[],
  apiKey: string,
  taskGoal?: string
): Promise<number | null> {
  const client = new OpenAI({ apiKey });
  const model = process.env.OPENAI_VISION_MODEL ?? "gpt-4o";
  const screenshot = await page.screenshot({ type: "png", fullPage: false });
  const completion = await client.chat.completions.create({
    model,
    max_tokens: 400,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: buildRepairPrompt({ step, action, url: page.url(), candidates, taskGoal }) },
          { type: "image_url", image_url: { url: `data:image/png;base64,${screenshot.toString("base64")}` } }
        ]
      }
    ]
  });
  const parsed = JSON.parse(extractJson(completion.choices[0]?.message?.content ?? "{}")) as {
    candidateIndex?: number | null;
    confidence?: number;
  };
  return typeof parsed.candidateIndex === "number" && (parsed.confidence ?? 0) >= 0.35
    ? parsed.candidateIndex
    : null;
}

async function repairSelectorWithAnthropic(
  page: Page,
  step: Extract<PlanStep, { selector: string }>,
  action: string,
  candidates: RepairCandidate[],
  apiKey: string,
  taskGoal?: string
): Promise<number | null> {
  const client = new Anthropic({ apiKey });
  const model = process.env.ANTHROPIC_VISION_MODEL ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514";
  const screenshot = await page.screenshot({ type: "png", fullPage: false });
  const response = await client.messages.create({
    model,
    max_tokens: 400,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: buildRepairPrompt({ step, action, url: page.url(), candidates, taskGoal }) },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: screenshot.toString("base64")
            }
          }
        ]
      }
    ]
  });
  const text = response.content.map((block) => ("text" in block ? block.text : "")).join("\n");
  const parsed = JSON.parse(extractJson(text || "{}")) as { candidateIndex?: number | null; confidence?: number };
  return typeof parsed.candidateIndex === "number" && (parsed.confidence ?? 0) >= 0.35
    ? parsed.candidateIndex
    : null;
}

async function repairVisibleLocator(
  page: Page,
  step: Extract<PlanStep, { selector: string }>,
  action: string,
  options: SelectorRepairOptions
): Promise<{ locator: Locator | null; reason: string }> {
  const provider = options.llmProvider ?? "anthropic";
  const apiKey =
    options.apiKey?.trim() ||
    (provider === "openai" ? process.env.OPENAI_API_KEY?.trim() : process.env.ANTHROPIC_API_KEY?.trim());
  if (!apiKey) {
    console.warn(`[selector-repair] no api key for provider=${provider}; skipping vision repair.`);
    return { locator: null, reason: "no api key" };
  }

  const candidates = await collectRepairCandidates(page);
  if (candidates.length === 0) {
    console.warn("[selector-repair] no visible candidates collected from page");
    return { locator: null, reason: "no candidates" };
  }

  let index: number | null = null;
  try {
    index =
      provider === "openai"
        ? await repairSelectorWithOpenAI(page, step, action, candidates, apiKey, options.taskGoal)
        : await repairSelectorWithAnthropic(page, step, action, candidates, apiKey, options.taskGoal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[selector-repair] vision call failed (${provider}): ${message}`);
    return { locator: null, reason: `vision call failed: ${message}` };
  }
  if (index === null) {
    console.warn("[selector-repair] vision did not return a confident candidate");
    return { locator: null, reason: "no confident candidate" };
  }

  const locator = page.locator(`[data-gif-agent-candidate="${index}"]`).first();
  if (!(await locator.isVisible().catch(() => false))) {
    console.warn(`[selector-repair] chosen candidate index=${index} is no longer visible`);
    return { locator: null, reason: "chosen candidate not visible" };
  }
  console.warn(`[selector-repair] vision selected candidate index=${index} for action=${action}`);
  return { locator, reason: `vision picked index=${index}` };
}

async function requireVisibleLocator(
  page: Page,
  step: Extract<PlanStep, { selector: string }>,
  action: string,
  options: SelectorRepairOptions
): Promise<Locator> {
  const direct = await firstVisibleLocator(page, step.selector);
  if (direct) return direct;
  const repair = await repairVisibleLocator(page, step, action, options);
  if (repair.locator) return repair.locator;
  throw new Error(
    `Could not ${action}: no visible element matched ${step.selector} (repair: ${repair.reason})`
  );
}

async function optionalVisibleLocator(
  page: Page,
  step: Extract<PlanStep, { selector: string }>,
  action: string,
  options: SelectorRepairOptions
): Promise<Locator | null> {
  const direct = await firstVisibleLocator(page, step.selector);
  if (direct) return direct;
  const repair = await repairVisibleLocator(page, step, action, options);
  return repair.locator;
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

function canRunHeadedBrowser(): boolean {
  return process.env.ENABLE_HEADFUL_BROWSER === "true";
}

export async function executePlan(input: {
  plan: Plan;
  taskId: string;
  storageState?: StorageState;
  manualAssist?: boolean;
  selectorRepair?: SelectorRepairOptions;
}): Promise<{ recordedVideoPath: string }> {
  const recordingsDir = path.join("files", "recordings", input.taskId);
  fs.mkdirSync(recordingsDir, { recursive: true });

  const canUseManualAssist = Boolean(input.manualAssist) && canRunHeadedBrowser();
  const browser = await chromium.launch({ headless: !canUseManualAssist });
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
  await maybeHandleCaptcha(page, canUseManualAssist);
  await page.waitForTimeout(700);

  for (const step of input.plan.steps) {
    switch (step.action) {
      case "navigate":
        await page.goto(step.url, { waitUntil: "domcontentloaded" });
        await applyCaption(page, step.caption ?? `Navigate to ${step.url}`);
        await maybeHandleCaptcha(page, canUseManualAssist);
        await page.waitForTimeout(700);
        break;
      case "hover":
        {
          const locator = await optionalVisibleLocator(page, step, "hover", input.selectorRepair ?? {});
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
          const locator = await optionalVisibleLocator(page, step, "highlight", input.selectorRepair ?? {});
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
          const locator = await requireVisibleLocator(page, step, "type into", input.selectorRepair ?? {});
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
          const locator = await requireVisibleLocator(page, step, "click", input.selectorRepair ?? {});
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

    await maybeHandleCaptcha(page, canUseManualAssist);
  }

  await context.close();
  const recordedVideoPath = await video?.path();
  await browser.close();

  if (!recordedVideoPath) {
    throw new Error("Playwright did not produce a video recording.");
  }

  return { recordedVideoPath };
}
