#!/usr/bin/env node
/**
 * End-to-end proof: Playwright records a short walkthrough -> ffmpeg -> GIF.
 * No API keys required. Writes demo-walkthrough-proof.gif in repo root.
 */
const path = require("node:path");
const fs = require("node:fs");
const { executePlan } = require("../dist/executor.js");
const { videoToGif } = require("../dist/encoder.js");

const taskId = "demo-local-proof";
const outGif = path.join(__dirname, "..", "demo-walkthrough-proof.gif");

const plan = {
  startUrl: "https://example.com/",
  steps: [
    {
      action: "highlight",
      selector: "h1",
      caption: "Demo: gif-agent executor + GIF export is working."
    },
    { action: "wait", ms: 1200, caption: "Pause so the walkthrough is readable." },
    {
      action: "highlight",
      selector: "p a",
      caption: "Next step: highlight the documentation link (demo only)."
    },
    { action: "wait", ms: 800, caption: "Done." }
  ]
};

async function main() {
  const { recordedVideoPath } = await executePlan({
    plan,
    taskId,
    manualAssist: false
  });
  await videoToGif({
    videoPath: recordedVideoPath,
    outputGifPath: outGif
  });
  const st = fs.statSync(outGif);
  console.log(JSON.stringify({ ok: true, gifPath: outGif, bytes: st.size }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
