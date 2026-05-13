import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { extractJson } from "./json-extract";
import type { LlmProvider } from "./llm-provider";
import type { Plan } from "./types";

type PlannerInput = {
  question: string;
  startUrlHint?: string;
};

type PlannerOptions = {
  apiKey?: string;
  llmProvider?: LlmProvider;
};

type SupportedMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

const SITE_HINTS: Array<{ tokens: string[]; url: string }> = [
  { tokens: ["google"], url: "https://www.google.com/" },
  { tokens: ["github"], url: "https://github.com/login" },
  { tokens: ["vercel"], url: "https://vercel.com/docs" },
  { tokens: ["stripe"], url: "https://dashboard.stripe.com/login" },
  { tokens: ["openai"], url: "https://platform.openai.com/docs" },
  { tokens: ["notion"], url: "https://www.notion.so/login" },
  { tokens: ["slack"], url: "https://slack.com/signin" },
  { tokens: ["figma"], url: "https://www.figma.com/login" }
];

function cleanQuestion(question: string): string {
  return question
    .replace(/Uploaded screenshot:\s*\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function mediaTypeFromFile(filePath: string): SupportedMediaType | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return null;
}

function inferStartUrl(input: PlannerInput): string {
  if (input.startUrlHint) {
    return input.startUrlHint;
  }

  const text = input.question.toLowerCase();
  const urlMatch = text.match(/https?:\/\/[^\s"')]+/);
  if (urlMatch?.[0]) {
    return urlMatch[0];
  }

  for (const hint of SITE_HINTS) {
    if (hint.tokens.some((token) => text.includes(token))) {
      return hint.url;
    }
  }

  return `https://duckduckgo.com/?q=${encodeURIComponent(cleanQuestion(input.question))}`;
}

function fallbackPlan(input: PlannerInput): Plan {
  const startUrl = inferStartUrl(input);
  const cleanedQuestion = cleanQuestion(input.question);
  const isGoogleSignIn =
    /^https:\/\/(www\.)?google\./i.test(startUrl) && /sign\s*in|log\s*in/i.test(cleanedQuestion);

  if (isGoogleSignIn) {
    return {
      startUrl: "https://www.google.com/",
      steps: [
        { action: "navigate", url: "https://www.google.com/", caption: "Open the Google homepage." },
        {
          action: "highlight",
          selector: 'a[href*="ServiceLogin"], a[aria-label*="Sign in"], a:has-text("Sign in")',
          caption: "Use the Sign in button in the top-right corner."
        },
        {
          action: "wait",
          ms: 1800,
          caption: "Click Sign in to start the Google account login flow."
        }
      ]
    };
  }

  return {
    startUrl,
    steps: [
      { action: "navigate", url: startUrl, caption: "Open the best-matching page for this issue." },
      {
        action: "highlight",
        selector: "body",
        caption: `Working through: ${cleanedQuestion || "requested issue"}`
      },
      { action: "wait", ms: 1600, caption: "Pause to keep the walkthrough readable." }
    ]
  };
}

function buildPlannerPrompt(input: PlannerInput): string {
  return `
You are a browser walkthrough planner that creates safe, read-only demonstrations.
Question: "${input.question}"
Start URL hint: "${input.startUrlHint ?? "none"}"

Return strict JSON only with this shape:
{
  "startUrl": "https://...",
  "steps": [
    { "action": "navigate", "url": "https://...", "caption": "..." },
    { "action": "click", "selector": "...", "caption": "..." },
    { "action": "hover", "selector": "...", "caption": "..." },
    { "action": "highlight", "selector": "...", "caption": "..." },
    { "action": "type", "selector": "...", "text": "...", "caption": "..." },
    { "action": "wait", "ms": 1000, "caption": "..." }
  ]
}

Rules:
- Keep it read-only by default. Avoid destructive clicks.
- For a sign-in walkthrough, clicking a public "Sign in" link/button is allowed; do not type credentials.
- If a Start URL hint is supplied, use that page as the source of truth. Do not replace it with a search engine.
- If the question says "here", interpret "here" as the page identified by the screenshot/start URL hint.
- Use visible selectors and short captions.
- Include 3 to 8 steps.
`.trim();
}

function buildVisualPlannerPrompt(input: PlannerInput): string {
  return `
You are a multimodal browser walkthrough planner.

Look at the uploaded screenshot directly. Identify the website/app/page from visual evidence: logos, browser UI, address/search bars, buttons, visible text, navigation, layout, and brand styling. Then create a safe browser walkthrough plan for the user's question.

Question: "${input.question}"
Optional start URL hint: "${input.startUrlHint ?? "none"}"

Return strict JSON only with this shape:
{
  "startUrl": "https://...",
  "steps": [
    { "action": "navigate", "url": "https://...", "caption": "..." },
    { "action": "click", "selector": "...", "caption": "..." },
    { "action": "hover", "selector": "...", "caption": "..." },
    { "action": "highlight", "selector": "...", "caption": "..." },
    { "action": "type", "selector": "...", "text": "...", "caption": "..." },
    { "action": "wait", "ms": 1000, "caption": "..." }
  ]
}

Rules:
- The screenshot is the source of truth. If the question says "here", "this page", or "this site", it means the page visible in the screenshot.
- If the optional start URL hint is supplied and the screenshot appears to show that same app/page, use the hint as the startUrl. Do not invent a new domain from branding text.
- Do not route to a generic search engine unless the screenshot itself is a search engine page.
- If you recognize a canonical public page, use its canonical URL. Example: Google homepage -> https://www.google.com/.
- Keep it read-only by default. Do not submit credentials or perform destructive actions.
- For a sign-in walkthrough, click the visible public "Sign in" link/button to show the next page; stop before credentials are entered.
- Prefer selectors that are likely to exist in the real page, including accessible labels, href fragments, visible text, and stable attributes.
- Include 3 to 8 short, visible steps.
- If the screenshot does not provide enough evidence to identify a start URL, still choose the best canonical URL for the recognized app instead of searching the user's question.
`.trim();
}

function parsePlanJson(text: string): Plan {
  const parsed = JSON.parse(extractJson(text)) as Plan;
  if (!parsed.startUrl || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    throw new Error("Invalid plan shape.");
  }
  return parsed;
}

async function buildPlanAnthropic(input: PlannerInput, apiKey: string): Promise<Plan> {
  const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514";
  const client = new Anthropic({ apiKey });
  const prompt = buildPlannerPrompt(input);

  const response = await client.messages.create({
    model,
    max_tokens: 900,
    messages: [{ role: "user", content: prompt }]
  });

  const text = response.content.map((block) => ("text" in block ? block.text : "")).join("\n");
  return parsePlanJson(text);
}

async function buildPlanOpenAI(input: PlannerInput, apiKey: string): Promise<Plan> {
  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const client = new OpenAI({ apiKey });
  const prompt = buildPlannerPrompt(input);

  const completion = await client.chat.completions.create({
    model,
    max_tokens: 1000,
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: prompt }]
  });

  const text = completion.choices[0]?.message?.content ?? "";
  if (!text) {
    throw new Error("OpenAI returned empty planner content.");
  }
  return parsePlanJson(text);
}

async function buildVisualPlanAnthropic(
  input: PlannerInput,
  screenshotFilePath: string,
  mediaType: SupportedMediaType,
  apiKey: string
): Promise<Plan> {
  const model = process.env.ANTHROPIC_VISION_MODEL ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514";
  const client = new Anthropic({ apiKey });
  const prompt = buildVisualPlannerPrompt(input);
  const imageBytes = fs.readFileSync(screenshotFilePath);

  const response = await client.messages.create({
    model,
    max_tokens: 1200,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType,
              data: imageBytes.toString("base64")
            }
          }
        ]
      }
    ]
  });

  const text = response.content.map((block) => ("text" in block ? block.text : "")).join("\n");
  return parsePlanJson(text);
}

async function buildVisualPlanOpenAI(
  input: PlannerInput,
  screenshotFilePath: string,
  mediaType: SupportedMediaType,
  apiKey: string
): Promise<Plan> {
  const model = process.env.OPENAI_VISION_MODEL ?? "gpt-4o";
  const client = new OpenAI({ apiKey });
  const prompt = buildVisualPlannerPrompt(input);
  const dataUrl = `data:${mediaType};base64,${fs.readFileSync(screenshotFilePath).toString("base64")}`;

  const responseErrors: string[] = [];
  try {
    const response = await client.responses.create({
      model,
      max_output_tokens: 2400,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: dataUrl, detail: "high" }
          ]
        }
      ],
      text: {
        format: { type: "json_object" }
      }
    });

    const text = response.output_text?.trim() ?? "";
    if (text) {
      return parsePlanJson(text);
    }

    const error = response.error?.message ? ` Error: ${response.error.message}` : "";
    const status = response.status ? ` Status: ${response.status}.` : "";
    const incomplete = response.incomplete_details?.reason
      ? ` Incomplete: ${response.incomplete_details.reason}.`
      : "";
    responseErrors.push(`Responses API returned empty content.${status}${incomplete}${error}`);
  } catch (error) {
    responseErrors.push(error instanceof Error ? error.message : "Responses API failed.");
  }

  const completion = await client.chat.completions.create({
    model,
    max_tokens: 1800,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: `${prompt}\n\nReturn only the JSON object. No markdown.` },
          { type: "image_url", image_url: { url: dataUrl, detail: "high" } }
        ]
      }
    ]
  });

  const text = completion.choices[0]?.message?.content?.trim() ?? "";
  if (!text) {
    throw new Error(
      `OpenAI returned empty visual planner content. ${responseErrors.join(" ")} Chat Completions also returned empty content.`
    );
  }
  return parsePlanJson(text);
}

export async function buildPlan(input: PlannerInput, options: PlannerOptions = {}): Promise<Plan> {
  const provider = options.llmProvider ?? "anthropic";
  const explicitKey = options.apiKey?.trim();

  let apiKey: string | undefined;
  if (explicitKey) {
    apiKey = explicitKey;
  } else if (provider === "openai") {
    apiKey = process.env.OPENAI_API_KEY?.trim();
  } else {
    apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  }

  if (!apiKey) {
    return fallbackPlan(input);
  }

  try {
    if (provider === "openai") {
      const plan = await buildPlanOpenAI(input, apiKey);
      return plan;
    }
    const plan = await buildPlanAnthropic(input, apiKey);
    return plan;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown planner error.";
    if (apiKey) {
      throw new Error(`Planner failed for ${provider}: ${message}`);
    }
    return fallbackPlan(input);
  }
}

export async function buildPlanFromScreenshot(
  input: PlannerInput,
  screenshotFilePath: string,
  options: PlannerOptions = {}
): Promise<Plan> {
  const provider = options.llmProvider ?? "anthropic";
  const apiKey =
    options.apiKey?.trim() ||
    (provider === "openai" ? process.env.OPENAI_API_KEY?.trim() : process.env.ANTHROPIC_API_KEY?.trim());

  if (!apiKey) {
    throw new Error("A vision-capable API key is required to plan from an uploaded screenshot.");
  }

  if (!fs.existsSync(screenshotFilePath)) {
    throw new Error("Uploaded screenshot file is missing.");
  }

  const mediaType = mediaTypeFromFile(screenshotFilePath);
  if (!mediaType) {
    throw new Error("Uploaded screenshot type is not supported for visual planning.");
  }

  try {
    if (provider === "openai") {
      return await buildVisualPlanOpenAI(input, screenshotFilePath, mediaType, apiKey);
    }
    return await buildVisualPlanAnthropic(input, screenshotFilePath, mediaType, apiKey);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown visual planner error.";
    throw new Error(`Visual planner failed for ${provider}: ${message}`);
  }
}
