#!/usr/bin/env node
/**
 * Demo: vision planner -> first actionable step from a screenshot.
 *
 * Usage:
 *   npm run demo:next-step
 *     (with OPENAI_API_KEY or ANTHROPIC_API_KEY in .env — calls live vision)
 *   node scripts/next-step-from-screenshot.cjs --fixture
 *     (no API key; prints the same JSON shape from a saved fixture)
 *   OPENAI_API_KEY=... node scripts/next-step-from-screenshot.cjs [image.png] ["optional prompt"]
 */
const fs = require("node:fs");
const path = require("node:path");
const { config } = require("dotenv");
const { buildPlanFromScreenshot } = require("../dist/planner.js");

config({ path: path.join(__dirname, "..", ".env") });

function printPlanSummary(plan) {
  const first = plan.steps[0];
  const nextClick = plan.steps.find((s) => s.action === "click") ?? null;
  console.log(
    JSON.stringify(
      { startUrl: plan.startUrl, firstStep: first, firstClickStep: nextClick, allSteps: plan.steps },
      null,
      2
    )
  );
}

function loadFixture() {
  const p = path.join(__dirname, "fixtures", "hn-demo-plan.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

const args = process.argv.slice(2);
const useFixture = args.includes("--fixture");
const filtered = args.filter((a) => a !== "--fixture");
const imageArg = filtered.find((f) => /\.(png|jpe?g|webp|gif)$/i.test(f));
const imagePath = path.resolve(
  imageArg ?? path.join(__dirname, "..", "demo-hn-screenshot.png")
);
const prompt =
  filtered
    .filter((f) => f !== imageArg)
    .join(" ")
    .trim() ||
  "Based on this screenshot, what is the single best next click to submit a new story on this site?";

if (useFixture) {
  printPlanSummary(loadFixture());
  process.exit(0);
}

const openaiKey = process.env.OPENAI_API_KEY?.trim();
const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
const llmProvider = openaiKey ? "openai" : anthropicKey ? "anthropic" : null;
const apiKey = openaiKey || anthropicKey;

if (!llmProvider || !apiKey) {
  console.warn(
    "No OPENAI_API_KEY or ANTHROPIC_API_KEY in environment — printing fixture output (same JSON shape as live vision).\n" +
      "Add a key to .env and re-run for a real model response.\n"
  );
  printPlanSummary(loadFixture());
  process.exit(0);
}

const startUrlHint = "https://news.ycombinator.com/";

buildPlanFromScreenshot({ question: prompt, startUrlHint }, imagePath, { apiKey, llmProvider })
  .then(printPlanSummary)
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
