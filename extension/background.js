/* global chrome */

const EXTENSION_VERSION = (chrome.runtime.getManifest?.()?.version) || "1.2.0";
const pendingAttentionCaptures = new Map();

function compareSemver(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai !== bi) return ai < bi ? -1 : 1;
  }
  return 0;
}

async function checkForExtensionUpdate(apiBaseUrl) {
  const apiBase = normalizeBase(apiBaseUrl);
  if (!apiBase) return;
  try {
    const res = await fetch(`${apiBase}/extension/version`, { method: "GET" });
    if (!res.ok) return;
    const data = await res.json().catch(() => ({}));
    const minRequired = String(data?.minSupportedVersion || "").trim();
    if (!minRequired) return;
    if (compareSemver(EXTENSION_VERSION, minRequired) < 0) {
      chrome.runtime.reload();
    }
  } catch {
    /* ignore */
  }
}

function scheduleVersionCheck() {
  try {
    chrome.alarms?.create?.("gif-agent-version-check", { periodInMinutes: 60 });
  } catch {
    /* ignore */
  }
}

chrome.runtime.onInstalled?.addListener?.(() => {
  scheduleVersionCheck();
});

chrome.runtime.onStartup?.addListener?.(() => {
  scheduleVersionCheck();
});

chrome.alarms?.onAlarm?.addListener?.(async (alarm) => {
  if (alarm?.name !== "gif-agent-version-check") return;
  const stored = await chrome.storage.local.get(["apiBaseUrl"]);
  if (stored?.apiBaseUrl) {
    await checkForExtensionUpdate(stored.apiBaseUrl);
  }
});

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

function hasLikelyAuthCookies(targetUrl, cookies) {
  const host = safeHostname(targetUrl);
  const names = new Set(cookies.map((c) => String(c.name || "").toLowerCase()));
  if (host.endsWith("x.com") || host.endsWith("twitter.com")) {
    return names.has("auth_token") && names.has("ct0");
  }
  if (host.endsWith("google.com")) {
    return ["sid", "hsid", "ssid", "apisid", "sapisid", "__secure-1psid", "__secure-3psid"].some((n) =>
      names.has(n)
    );
  }
  if (host.endsWith("github.com")) {
    return names.has("user_session") || names.has("dotcom_user");
  }
  return [...names].some((name) => /auth|session|token|sid|logged|login|user/i.test(name));
}

async function openOrFocusTargetTab(targetUrl) {
  const existing = await findTabForTarget(targetUrl);
  if (existing?.id) {
    await chrome.tabs.update(existing.id, { active: true, url: existing.url || targetUrl });
    if (existing.windowId !== undefined) {
      await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
    }
    return existing.id;
  }
  const created = await chrome.tabs.create({ url: targetUrl, active: true });
  return created.id;
}

async function captureWhenLikelyAuthenticated({ apiBase, extensionToken, targetUrl, name, tabId }) {
  const key = `${tabId || "any"}:${targetUrl}`;
  const startedAt = Date.now();
  pendingAttentionCaptures.set(key, true);

  const attempt = async () => {
    if (!pendingAttentionCaptures.has(key)) return;
    const cookies = await collectCookiesForTarget(targetUrl);
    if (!hasLikelyAuthCookies(targetUrl, cookies)) {
      if (Date.now() - startedAt < 5 * 60 * 1000) {
        setTimeout(attempt, 5000);
      } else {
        pendingAttentionCaptures.delete(key);
      }
      return;
    }
    const capture = await autoCaptureForTarget({ apiBase, extensionToken, targetUrl, name });
    if (!capture?.captured && Date.now() - startedAt < 5 * 60 * 1000) {
      setTimeout(attempt, 5000);
      return;
    }
    pendingAttentionCaptures.delete(key);
  };

  setTimeout(attempt, 3000);
}

async function startAttentionHandoff(payload) {
  let apiBase = normalizeBase(payload.apiBaseUrl);
  let extensionToken = "";
  if (payload.code) {
    const exchanged = await exchangePairingCode(payload);
    apiBase = exchanged.apiBase;
    extensionToken = exchanged.extensionToken;
  } else {
    const stored = await chrome.storage.local.get(["apiBaseUrl", "extensionToken"]);
    apiBase = apiBase || normalizeBase(stored?.apiBaseUrl);
    extensionToken = stored?.extensionToken || "";
  }

  const targetUrl = String(payload.targetUrl || "").trim();
  if (!apiBase) throw new Error("Missing API base URL.");
  if (!extensionToken) throw new Error("Extension is not paired yet.");
  if (!targetUrl) throw new Error("Missing target URL.");

  const tabId = await openOrFocusTargetTab(targetUrl);
  await captureWhenLikelyAuthenticated({
    apiBase,
    extensionToken,
    targetUrl,
    name: typeof payload.name === "string" ? payload.name.trim() : "",
    tabId
  });
  return { ok: true, opened: true, monitoring: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || (message.type !== "gif_agent_auto_pair" && message.type !== "gif_agent_attention")) {
    return undefined;
  }

  (async () => {
    try {
      const payload = message.payload || {};
      if (message.type === "gif_agent_attention") {
        const result = await startAttentionHandoff(payload);
        sendResponse(result);
        return;
      }

      const { apiBase, extensionToken } = await exchangePairingCode(payload);
      checkForExtensionUpdate(apiBase).catch(() => {});

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
