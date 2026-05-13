/* global chrome */

function normalizeBase(url) {
  return String(url || "")
    .trim()
    .replace(/\/+$/, "");
}

function safeHostname(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function hostnameMatches(host, target) {
  if (!host || !target) return false;
  if (host === target) return true;
  return host.endsWith(`.${target}`);
}

function parentRegistrableDomain(hostname) {
  const parts = hostname.split(".").filter(Boolean);
  if (parts.length < 2) return hostname;
  return parts.slice(-2).join(".");
}

function mapSameSite(ss) {
  if (ss === "strict") return "Strict";
  if (ss === "lax") return "Lax";
  if (ss === "no_restriction") return "None";
  return "Lax";
}

function mapChromeCookie(c) {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain || "",
    path: c.path || "/",
    expires: typeof c.expirationDate === "number" ? c.expirationDate : -1,
    httpOnly: Boolean(c.httpOnly),
    secure: Boolean(c.secure),
    sameSite: mapSameSite(c.sameSite)
  };
}

function cookieKey(c) {
  return `${c.domain}|${c.path}|${c.name}`;
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

  return { apiBase, extensionToken: data.extensionToken };
}

async function collectCookiesForTarget(targetUrl) {
  const map = new Map();
  try {
    const list = await chrome.cookies.getAll({ url: targetUrl });
    for (const c of list) {
      const m = mapChromeCookie(c);
      if (m.domain) map.set(cookieKey(m), m);
    }
  } catch {
    /* ignore */
  }
  const host = safeHostname(targetUrl);
  const registrable = host ? parentRegistrableDomain(host) : "";
  if (registrable) {
    try {
      const list = await chrome.cookies.getAll({ domain: registrable });
      for (const c of list) {
        const m = mapChromeCookie(c);
        if (m.domain) map.set(cookieKey(m), m);
      }
    } catch {
      /* ignore */
    }
  }
  return [...map.values()];
}

async function findTabForTarget(targetUrl) {
  const target = safeHostname(targetUrl);
  if (!target) return null;
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.url || !tab.url.startsWith("http")) continue;
    const host = safeHostname(tab.url);
    if (hostnameMatches(host, target) || hostnameMatches(target, host)) {
      return tab;
    }
  }
  return null;
}

async function findBestCandidateTab({ apiBase, requestingTabId }) {
  const apiHost = safeHostname(apiBase);
  const tabs = await chrome.tabs.query({});
  const candidates = tabs.filter((tab) => {
    if (!tab.id || tab.id === requestingTabId) return false;
    if (!tab.url || !tab.url.startsWith("http")) return false;
    if (tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) return false;
    const host = safeHostname(tab.url);
    if (host.includes("gif-agent")) return false;
    if (apiHost && (host === apiHost || host.endsWith(`.${apiHost}`))) return false;
    return true;
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const aLast = a.lastAccessed ?? 0;
    const bLast = b.lastAccessed ?? 0;
    if (bLast !== aLast) return bLast - aLast;
    return (b.active ? 1 : 0) - (a.active ? 1 : 0);
  });
  return candidates[0] ?? null;
}

async function collectPageStorage(tabId) {
  try {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const read = (store) => {
          const out = [];
          for (let i = 0; i < store.length; i += 1) {
            const name = store.key(i);
            out.push({ name, value: String(store.getItem(name) ?? "") });
          }
          return out;
        };
        return {
          origin: window.location.origin,
          localStorage: read(window.localStorage)
        };
      }
    });
    return injected?.result ?? null;
  } catch {
    return null;
  }
}

async function autoCaptureForTarget({ apiBase, extensionToken, targetUrl, name }) {
  if (!targetUrl) {
    return { captured: false, reason: "No target site to capture (open a logged-in tab and try again)." };
  }
  const cookies = await collectCookiesForTarget(targetUrl);
  let origins;
  const matchingTab = await findTabForTarget(targetUrl);
  if (matchingTab?.id) {
    const storage = await collectPageStorage(matchingTab.id);
    if (storage?.origin && Array.isArray(storage.localStorage) && storage.localStorage.length > 0) {
      origins = [{ origin: storage.origin, localStorage: storage.localStorage }];
    }
  }

  if (cookies.length === 0 && !origins) {
    return {
      captured: false,
      reason: `No cookies found for ${safeHostname(targetUrl) || targetUrl}. Sign in on that site first, then re-run.`
    };
  }

  const storageState = { cookies, origins };
  const res = await fetch(`${apiBase}/connections/import`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${extensionToken}`
    },
    body: JSON.stringify({
      name: name || matchingTab?.title || safeHostname(targetUrl) || "Imported session",
      startUrl: targetUrl,
      storageState
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { captured: false, reason: data.error || `Import HTTP ${res.status}` };
  }
  return {
    captured: true,
    connectionId: data.connectionId,
    targetUrl,
    matchedTab: Boolean(matchingTab)
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "gif_agent_auto_pair") {
    return undefined;
  }

  (async () => {
    try {
      const payload = message.payload || {};
      const { apiBase, extensionToken } = await exchangePairingCode(payload);

      let targetUrl = typeof payload.targetUrl === "string" ? payload.targetUrl.trim() : "";
      let candidateTab = null;
      if (!targetUrl) {
        candidateTab = await findBestCandidateTab({
          apiBase,
          requestingTabId: sender?.tab?.id
        });
        if (candidateTab?.url) {
          targetUrl = candidateTab.url;
        }
      }

      const capture = await autoCaptureForTarget({
        apiBase,
        extensionToken,
        targetUrl,
        name: typeof payload.name === "string" ? payload.name.trim() : ""
      });

      sendResponse({
        ok: true,
        paired: true,
        capture
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      sendResponse({ ok: false, error: detail });
    }
  })();

  return true;
});
