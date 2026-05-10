import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { extractJson } from "./json-extract";
import type { LlmProvider } from "./llm-provider";

type ScreenshotAnalysis = {
  startUrlHint: string | null;
  contextSummary: string | null;
  confidence: number | null;
  evidence: string | null;
};

type ImageAnalyzerOptions = {
  apiKey?: string;
  llmProvider?: LlmProvider;
};

type AnalysisPayload = {
  likely_domain?: string | null;
  likely_url?: string | null;
  app_name?: string | null;
  confidence?: number | null;
  evidence?: string | null;
};

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
type SupportedMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

function mediaTypeFromFile(filePath: string): SupportedMediaType | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return null;
}

function normalizeUrlFromPayload(payload: AnalysisPayload): string | null {
  const rawUrl = payload.likely_url?.trim();
  if (rawUrl) {
    try {
      return new URL(rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`).toString();
    } catch {
      // ignore invalid url
    }
  }

  const rawDomain = payload.likely_domain?.trim();
  if (rawDomain) {
    const normalizedDomain = rawDomain.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    if (normalizedDomain) {
      return `https://${normalizedDomain}`;
    }
  }

  return null;
}

function safeParseJson(text: string): AnalysisPayload | null {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as AnalysisPayload;
  } catch {
    // ignore, attempt fenced content parse
  }

  const fenced = trimmed.match(/```json\s*([\s\S]*?)\s*```/i);
  if (!fenced?.[1]) return null;
  try {
    return JSON.parse(fenced[1]) as AnalysisPayload;
  } catch {
    return null;
  }
}

function analysisPromptText(): string {
  return `Analyze this screenshot visually and identify the exact website/app/page shown.
Use the pixels in the screenshot: logos, browser chrome, address/search bars, visible navigation, buttons, text, layout, and any page-specific UI.

Return JSON only:
{
  "likely_domain": "domain.tld or null",
  "likely_url": "https://domain.tld/path or null",
  "app_name": "App/site name",
  "confidence": 0.0,
  "evidence": "brief reason"
}
Rules:
- If unsure, use null for domain/url.
- If the screenshot clearly shows a well-known homepage, use its canonical URL (for example Google homepage -> https://www.google.com/).
- Do not invent a random search engine result page from the user's question.
- Put the visual evidence you used in "evidence".
- Do not include markdown or extra text.
`;
}

function payloadToAnalysis(parsed: AnalysisPayload | null): ScreenshotAnalysis {
  if (!parsed) {
    return { startUrlHint: null, contextSummary: null, confidence: null, evidence: null };
  }

  const startUrlHint = normalizeUrlFromPayload(parsed);
  const contextSummary =
    parsed.app_name || parsed.evidence
      ? `${parsed.app_name ?? "Unknown app"}${parsed.evidence ? ` (${parsed.evidence})` : ""}`
      : null;

  return {
    startUrlHint,
    contextSummary,
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : null,
    evidence: parsed.evidence?.trim() || null
  };
}

async function analyzeAnthropic(
  _filePath: string,
  mediaType: SupportedMediaType,
  imageBytes: Buffer,
  apiKey: string
): Promise<ScreenshotAnalysis> {
  const client = new Anthropic({ apiKey });
  const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514";

  const response = await client.messages.create({
    model,
    max_tokens: 400,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: analysisPromptText() },
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
  return payloadToAnalysis(safeParseJson(text));
}

async function analyzeOpenAI(
  _filePath: string,
  mediaType: SupportedMediaType,
  imageBytes: Buffer,
  apiKey: string
): Promise<ScreenshotAnalysis> {
  const client = new OpenAI({ apiKey });
  const model = process.env.OPENAI_VISION_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const dataUrl = `data:${mediaType};base64,${imageBytes.toString("base64")}`;

  const completion = await client.chat.completions.create({
    model,
    max_tokens: 400,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: analysisPromptText() },
          { type: "image_url", image_url: { url: dataUrl } }
        ]
      }
    ]
  });

  const text = completion.choices[0]?.message?.content ?? "";
  let parsed: AnalysisPayload | null = null;
  try {
    parsed = JSON.parse(text) as AnalysisPayload;
  } catch {
    try {
      parsed = JSON.parse(extractJson(text)) as AnalysisPayload;
    } catch {
      parsed = null;
    }
  }
  return payloadToAnalysis(parsed);
}

export async function analyzeScreenshotSource(
  screenshotFilePath: string | undefined,
  options: ImageAnalyzerOptions = {}
): Promise<ScreenshotAnalysis> {
  if (!screenshotFilePath) {
    return { startUrlHint: null, contextSummary: null, confidence: null, evidence: null };
  }

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
    return { startUrlHint: null, contextSummary: null, confidence: null, evidence: null };
  }

  if (!fs.existsSync(screenshotFilePath)) {
    return { startUrlHint: null, contextSummary: null, confidence: null, evidence: null };
  }

  const mediaType = mediaTypeFromFile(screenshotFilePath);
  if (!mediaType) {
    return { startUrlHint: null, contextSummary: null, confidence: null, evidence: null };
  }

  const imageBytes = fs.readFileSync(screenshotFilePath);
  if (imageBytes.length > MAX_IMAGE_BYTES) {
    return { startUrlHint: null, contextSummary: null, confidence: null, evidence: null };
  }

  try {
    if (provider === "openai") {
      return await analyzeOpenAI(screenshotFilePath, mediaType, imageBytes, apiKey);
    }
    return await analyzeAnthropic(screenshotFilePath, mediaType, imageBytes, apiKey);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown screenshot analysis error.";
    throw new Error(`Screenshot analysis failed for ${provider}: ${message}`);
  }
}
