#!/usr/bin/env node
/**
 * Demo: vision planner -> first actionable step from a screenshot.
 * Usage:
 *   OPENAI_API_KEY=... node scripts/next-step-from-screenshot.cjs [image.png] ["optional prompt"]
 * Or add OPENAI_API_KEY to .env in repo root.
 */
const path = require("node:path");
const { config } = require("dotenv");
const { buildPlanFromScreenshot } = require("../dist/planner.js");

config({ path: path.join(__dirname, "..", ".env") });

const imagePath = path.resolve(process.argv[2] ?? path.join(__dirname, "..", "demo-hn-screenshot.png"));
const prompt =
  process.argv.slice(3).join(" ").trim() ||
  "Based on this screenshot, what is the single best next click to submit a new story on this site?";

const openaiKey = process.env.OPENAI_API_KEY?.trim();
const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
const llmProvider = openaiKey ? "openai" : anthropicKey ? "anthropic" : null;
const apiKey = openaiKey || anthropicKey;
if (!llmProvider || !apiKey) {
  console.error("Set OPENAI_API_KEY or ANTHROPIC_API_KEY (or add one to .env) to run the vision planner.");
  process.exit(1);
}

const startUrlHint = "https://news.ycombinator.com/";

buildPlanFromScreenshot({ question: prompt, startUrlHint }, imagePath, { apiKey, llmProvider })
  .then((plan) => {
    const first = plan.steps[0];
    const nextClick = plan.steps.find((s) => s.action === "click") ?? null;
    console.log(
      JSON.stringify(
        { startUrl: plan.startUrl, firstStep: first, firstClickStep: nextClick, allSteps: plan.steps },
        null,
        2
      )
    );
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
