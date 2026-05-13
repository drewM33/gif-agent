/* global chrome */

function normalizeBase(url) {
  return String(url || "")
    .trim()
    .replace(/\/+$/, "");
}

async function exchangePairingCode({ apiBaseUrl, code }) {
  const apiBase = normalizeBase(apiBaseUrl);
  const pairingCode = String(code || "").trim();
  if (!apiBase) {
    throw new Error("Missing API base URL.");
  }
  if (!pairingCode) {
    throw new Error("Missing pairing code.");
  }

  const res = await fetch(`${apiBase}/connections/pair/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: pairingCode })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  if (!data.extensionToken) {
    throw new Error("Missing extensionToken in response.");
  }

  await chrome.storage.local.set({
    apiBaseUrl: apiBase,
    extensionToken: data.extensionToken,
    pairedAt: Date.now()
  });

  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "gif_agent_auto_pair") {
    return undefined;
  }

  exchangePairingCode(message.payload || {})
    .then(() => sendResponse({ ok: true }))
    .catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      sendResponse({ ok: false, error: detail });
    });

  return true;
});
