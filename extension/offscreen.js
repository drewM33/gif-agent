/* global chrome, MediaRecorder */

let recorder = null;
let stream = null;
let chunks = [];
let mimeType = "video/webm";

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Failed to read recorded video."));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(blob);
  });
}

function pickMimeType() {
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm"
  ];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || "";
}

async function startRecording(streamId) {
  if (recorder && recorder.state !== "inactive") {
    throw new Error("A tab recording is already in progress.");
  }

  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    }
  });

  chunks = [];
  mimeType = pickMimeType();
  recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      chunks.push(event.data);
    }
  };
  recorder.start(250);
  return { mimeType: recorder.mimeType || mimeType || "video/webm" };
}

async function stopRecording() {
  if (!recorder || recorder.state === "inactive") {
    throw new Error("No tab recording is in progress.");
  }

  const stopped = new Promise((resolve) => {
    recorder.addEventListener("stop", resolve, { once: true });
  });
  recorder.stop();
  await stopped;

  const type = recorder.mimeType || mimeType || "video/webm";
  const blob = new Blob(chunks, { type });
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  recorder = null;
  chunks = [];

  if (blob.size === 0) {
    throw new Error("Recorded tab video was empty.");
  }

  return {
    mimeType: type,
    dataUrl: await blobToDataUrl(blob),
    byteLength: blob.size
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || (message.type !== "gif_agent_offscreen_start" && message.type !== "gif_agent_offscreen_stop")) {
    return undefined;
  }

  (async () => {
    try {
      if (message.type === "gif_agent_offscreen_start") {
        const result = await startRecording(String(message.streamId || ""));
        sendResponse({ ok: true, ...result });
        return;
      }
      const result = await stopRecording();
      sendResponse({ ok: true, ...result });
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  })();

  return true;
});
