export type LlmProvider = "anthropic" | "openai";

export function parseLlmProvider(value: unknown, fallback: LlmProvider = "anthropic"): LlmProvider {
  const s = String(value ?? "")
    .trim()
    .toLowerCase();
  if (s === "openai" || s === "chatgpt") return "openai";
  return fallback;
}
