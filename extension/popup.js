/* global chrome */

const apiBaseEl = document.getElementById("apiBase");
const pairCodeEl = document.getElementById("pairCode");
const pairBtn = document.getElementById("pairBtn");
const connNameEl = document.getElementById("connName");
const extraHostsEl = document.getElementById("extraHosts");
const captureBtn = document.getElementById("captureBtn");
const msgEl = document.getElementById("msg");

function setMsg(text, cls) {
  msgEl.textContent = text;
  msgEl.className = cls ? `muted ${cls}` : "muted";
}

function normalizeBase(url) {
  return String(url || "")
    .trim()
    .replace(/\/+$/, "");
}

async function loadSettings() {
  const { apiBaseUrl = "", extensionToken = "" } = await chrome.storage.local.get([
    "apiBaseUrl",
    "extensionToken"
  ]);
  apiBaseEl.value = apiBaseUrl;
  captureBtn.disabled = !extensionToken;
  if (extensionToken) {
    setMsg("Paired. You can capture the active tab.", "ok");
  }
}

apiBaseEl.addEventListener("change", async () => {
  await chrome.storage.local.set({ apiBaseUrl: normalizeBase(apiBaseEl.value) });
});

pairBtn.addEventListener("click", async () => {
  const apiBase = normalizeBase(apiBaseEl.value);
  if (!apiBase) {
    setMsg("Set API base URL first.", "err");
    return;
  }
  const code = pairCodeEl.value.trim();
  if (!code) {
    setMsg("Enter the pairing code from the web app.", "err");
    return;
  }
  pairBtn.disabled = true;
  setMsg("Exchanging…");
  try {
    await chrome.storage.local.set({ apiBaseUrl: apiBase });
    const res = await fetch(`${apiBase}/connections/pair/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    await chrome.storage.local.set({ extensionToken: data.extensionToken });
    setMsg("Paired successfully. Capture on a logged-in tab.", "ok");
    captureBtn.disabled = false;
  } catch (e) {
    setMsg(e instanceof Error ? e.message : String(e), "err");
  } finally {
    pairBtn.disabled = false;
  }
});

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

async function collectAllCookies(urls) {
  const map = new Map();
  for (const url of urls) {
    try {
      const list = await chrome.cookies.getAll({ url });
      for (const c of list) {
        const m = mapChromeCookie(c);
        if (!m.domain) continue;
        map.set(cookieKey(m), m);
      }
    } catch {
      /* ignore bad URL */
    }
  }
  return [...map.values()];
}

async function collectPageStorage(tabId) {
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
  return injected?.result ?? { origin: "", localStorage: [] };
}

captureBtn.addEventListener("click", async () => {
  const apiBase = normalizeBase(apiBaseEl.value);
  const { extensionToken } = await chrome.storage.local.get("extensionToken");
  if (!apiBase || !extensionToken) {
    setMsg("Pair first (API URL + code).", "err");
    return;
  }

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id || !tab.url?.startsWith("http")) {
    setMsg("Open a normal http(s) tab to capture.", "err");
    return;
  }

  captureBtn.disabled = true;
  setMsg("Capturing…");

  try {
    const pageUrl = tab.url;
    const u = new URL(pageUrl);
    const primaryHost = u.hostname;
    const extraRaw = extraHostsEl.value.trim();
    const extraHosts = extraRaw
      ? extraRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    const urls = new Set([`${u.origin}/`]);
    for (const h of extraHosts) {
      urls.add(`https://${h}/`);
      urls.add(`http://${h}/`);
    }

    const cookies = await collectAllCookies([...urls]);
    const storage = await collectPageStorage(tab.id);

    const origins = [];
    if (storage.origin && storage.localStorage.length > 0) {
      origins.push({
        origin: storage.origin,
        localStorage: storage.localStorage
      });
    }

    const storageState = { cookies, origins: origins.length ? origins : undefined };

    const name = connNameEl.value.trim() || tab.title || "Imported session";
    const res = await fetch(`${apiBase}/connections/import`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${extensionToken}`
      },
      body: JSON.stringify({
        name,
        startUrl: pageUrl,
        storageState,
        extraHosts
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    setMsg(`Saved connection ${data.connectionId.slice(0, 8)}…`, "ok");
  } catch (e) {
    setMsg(e instanceof Error ? e.message : String(e), "err");
  } finally {
    captureBtn.disabled = false;
  }
});

void loadSettings();
