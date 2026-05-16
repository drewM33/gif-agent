/* global chrome */

const EXTENSION_VERSION = (chrome.runtime.getManifest?.()?.version) || "1.2.0";
const pendingAttentionCaptures = new Map();
const RECORDER_FPS = 4;
const RECORDER_INTERVAL_MS = Math.round(1000 / RECORDER_FPS);
const MAX_RECORDED_FRAMES = 110;

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTabComplete(tabId, timeoutMs = 12000) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => finish(), timeoutMs);
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === "complete") {
        finish();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((tab) => {
      if (!tab || tab.status === "complete") {
        finish();
      }
    }).catch(() => finish());
  });
}

function isTransientFrameError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return (
    message.includes("Frame with ID 0 was removed") ||
    message.includes("No frame with id") ||
    message.includes("Extension context invalidated") ||
    message.includes("The tab was closed")
  );
}

async function startFrameRecorder(tabId) {
  const target = { tabId };
  const frames = [];
  let attached = false;
  let stopped = false;
  let inFlight = false;

  await chrome.debugger.attach(target, "1.3");
  attached = true;

  const capture = async () => {
    if (stopped || inFlight || frames.length >= MAX_RECORDED_FRAMES) return;
    inFlight = true;
    try {
      const result = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", {
        format: "jpeg",
        quality: 62,
        fromSurface: true
      });
      if (result?.data) {
        frames.push(`data:image/jpeg;base64,${result.data}`);
        if (frames.length >= MAX_RECORDED_FRAMES) {
          stopped = true;
          clearInterval(timer);
        }
      }
    } catch (error) {
      console.warn("[gif-agent] debugger frame capture skipped", error);
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => {
    capture().catch((error) => console.warn("[gif-agent] frame capture loop failed", error));
  }, RECORDER_INTERVAL_MS);
  await capture();

  return {
    frames,
    fps: RECORDER_FPS,
    async stop() {
      stopped = true;
      clearInterval(timer);
      while (inFlight) {
        await sleep(50);
      }
      if (attached) {
        attached = false;
        await chrome.debugger.detach(target).catch(() => {});
      }
      return frames;
    }
  };
}

async function runTabStep(tabId, step) {
  const execute = () =>
    chrome.scripting.executeScript({
      target: { tabId },
      func: (inputStep) => {
      const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const query = (selector) => {
        const direct = document.querySelector(selector);
        if (direct) return direct;
        const quoted = selector.match(/["']([^"']+)["']/)?.[1] || "";
        if (quoted) {
          const lowered = quoted.toLowerCase();
          const candidates = Array.from(
            document.querySelectorAll("a,button,input,textarea,select,[role='button'],[role='link']")
          );
          return (
            candidates.find((el) => {
              const text = (el.textContent || "").toLowerCase();
              const aria = (el.getAttribute("aria-label") || "").toLowerCase();
              const title = (el.getAttribute("title") || "").toLowerCase();
              return text.includes(lowered) || aria.includes(lowered) || title.includes(lowered);
            }) || null
          );
        }
        return null;
      };
      const caption = (text) => {
        const id = "__gif_agent_caption";
        let el = document.getElementById(id);
        if (!el) {
          el = document.createElement("div");
          el.id = id;
          Object.assign(el.style, {
            position: "fixed",
            left: "16px",
            bottom: "16px",
            zIndex: "2147483647",
            background: "rgba(0,0,0,0.75)",
            color: "#fff",
            fontFamily: "Inter, Arial, sans-serif",
            fontSize: "15px",
            borderRadius: "10px",
            padding: "10px 12px",
            maxWidth: "65vw",
            pointerEvents: "none"
          });
          (document.body || document.documentElement).appendChild(el);
        }
        el.textContent = text || "";
      };

      const perform = async () => {
        if (inputStep.action === "wait") {
          caption(inputStep.caption || `Wait ${inputStep.ms}ms`);
          await sleepMs(Math.max(200, Number(inputStep.ms) || 600));
          return { ok: true };
        }
        if (inputStep.action === "highlight" || inputStep.action === "hover" || inputStep.action === "click" || inputStep.action === "type") {
          const el = query(inputStep.selector);
          if (!el) {
            caption(`Could not find ${inputStep.selector}; continuing.`);
            return { ok: false, reason: "not_found" };
          }
          const node = el;
          node.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
          await sleepMs(280);
          const box = node.getBoundingClientRect();
          let cursor = document.getElementById("__gif_agent_cursor");
          if (!cursor) {
            cursor = document.createElement("div");
            cursor.id = "__gif_agent_cursor";
            Object.assign(cursor.style, {
              position: "fixed",
              width: "30px",
              height: "30px",
              borderRadius: "999px 999px 999px 6px",
              background: "linear-gradient(135deg, #8b5cf6, #ec4899)",
              border: "3px solid rgba(255,255,255,0.95)",
              boxShadow: "0 6px 18px rgba(0,0,0,0.45)",
              zIndex: "2147483647",
              pointerEvents: "none",
              transform: "translate(-50%, -50%) rotate(-45deg)",
              transition: "left 0.35s ease, top 0.35s ease"
            });
            (document.body || document.documentElement).appendChild(cursor);
          }
          cursor.style.left = `${box.left + box.width / 2}px`;
          cursor.style.top = `${box.top + box.height / 2}px`;
          await sleepMs(450);
          if (inputStep.action === "highlight" || inputStep.action === "hover") {
            node.style.outline = "3px solid #22c55e";
            node.style.outlineOffset = "2px";
          }
          if (inputStep.action === "click") {
            node.click();
          }
          if (inputStep.action === "type") {
            node.focus();
            if ("value" in node) {
              node.value = inputStep.text || "";
              node.dispatchEvent(new Event("input", { bubbles: true }));
              node.dispatchEvent(new Event("change", { bubbles: true }));
            }
          }
          caption(inputStep.caption || `${inputStep.action} ${inputStep.selector}`);
          await sleepMs(650);
          return { ok: true };
        }
        return { ok: true };
      };

      return perform();
    },
      args: [step]
    });

  try {
    await execute();
  } catch (error) {
    if (!isTransientFrameError(error)) throw error;
    await waitForTabComplete(tabId, 10000);
    await sleep(500);
    await execute();
  }
}

async function captureTabFrame(tab) {
  if (!tab?.id) return null;
  const windowId = tab.windowId;
  const focusTab = async () => {
    await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    if (windowId !== undefined) {
      await chrome.windows.update(windowId, { focused: true }).catch(() => {});
    }
    await sleep(250);
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await focusTab();
      const captured = await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 58 });
      if (captured) return captured;
    } catch (error) {
      console.warn(`[gif-agent] captureVisibleTab failed attempt=${attempt + 1}`, error);
      await sleep(350);
    }
  }

  try {
    const target = { tabId: tab.id };
    await chrome.debugger.attach(target, "1.3");
    const result = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 58,
      fromSurface: true
    });
    await chrome.debugger.detach(target).catch(() => {});
    if (result?.data) {
      return `data:image/jpeg;base64,${result.data}`;
    }
  } catch (error) {
    console.warn("[gif-agent] debugger screenshot fallback failed", error);
    if (tab?.id) {
      await chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
    }
  }

  return null;
}

function isExtensionExecutableUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function assertExtensionExecutablePlan(plan) {
  if (!isExtensionExecutableUrl(plan.startUrl)) {
    throw new Error(
      `Chrome blocks extensions from automating browser-internal pages like ${plan.startUrl}. Open chrome://extensions manually, turn on Developer mode, then click Load unpacked.`
    );
  }
  for (const step of plan.steps || []) {
    if (step?.action === "navigate" && !isExtensionExecutableUrl(step.url)) {
      throw new Error(
        `Chrome blocks extensions from navigating to browser-internal pages like ${step.url}. Open that page manually.`
      );
    }
  }
}

async function startExtensionPlanExecution(payload) {
  const taskId = String(payload?.taskId || "").trim();
  const plan = payload?.plan;
  if (!taskId) throw new Error("Missing taskId.");
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.steps) || !plan.startUrl) {
    throw new Error("Missing plan payload.");
  }
  assertExtensionExecutablePlan(plan);

  const stored = await chrome.storage.local.get(["apiBaseUrl", "extensionToken"]);
  const apiBase = normalizeBase(payload.apiBaseUrl || stored?.apiBaseUrl);
  const extensionToken = String(stored?.extensionToken || "");
  if (!apiBase) throw new Error("Missing API base URL.");
  if (!extensionToken) throw new Error("Extension is not paired yet.");

  let tabId = Number(payload.tabId) || 0;
  if (!tabId && payload.targetUrl) {
    const found = await findTabForTarget(String(payload.targetUrl));
    tabId = Number(found?.id || 0);
  }
  if (!tabId) {
    const opened = await openOrFocusTargetTab(String(plan.startUrl));
    tabId = Number(opened || 0);
  }
  if (!tabId) throw new Error("Could not open a target tab for execution.");

  let tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  if (tab.windowId !== undefined) {
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }

  let recorder = null;

  try {
    recorder = await startFrameRecorder(tabId);
    await chrome.tabs.update(tabId, { url: String(plan.startUrl) });
    await waitForTabComplete(tabId, 15000);
    await sleep(900);

    for (const step of plan.steps) {
      if (step.action === "navigate" && step.url) {
        await chrome.tabs.update(tabId, { url: String(step.url) });
        await waitForTabComplete(tabId, 15000);
        await sleep(900);
      } else {
        await runTabStep(tabId, step);
        await waitForTabComplete(tabId, 5000);
        await sleep(650);
      }
    }

    await sleep(900);
    const frames = await recorder.stop();
    recorder = null;
    if (frames.length === 0) {
      throw new Error("The extension did not capture any tutorial frames.");
    }

    const doneRes = await fetch(`${apiBase}/tasks/${taskId}/extension-result`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${extensionToken}`
      },
      body: JSON.stringify({
        status: "done",
        frames,
        frameFps: recorder.fps
      })
    });
    const doneData = await doneRes.json().catch(() => ({}));
    if (!doneRes.ok) {
      throw new Error(doneData.error || `Upload HTTP ${doneRes.status}`);
    }
    return { ok: true, frameCount: frames.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (recorder) {
      await recorder.stop().catch(() => {});
    }
    await fetch(`${apiBase}/tasks/${taskId}/extension-result`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${extensionToken}`
      },
      body: JSON.stringify({ status: "error", error: message })
    }).catch(() => {});
    throw error;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (
    !message ||
    (message.type !== "gif_agent_auto_pair" &&
      message.type !== "gif_agent_attention" &&
      message.type !== "gif_agent_execute_plan")
  ) {
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
      if (message.type === "gif_agent_execute_plan") {
        if (payload?.probe) {
          const stored = await chrome.storage.local.get(["apiBaseUrl", "extensionToken"]);
          sendResponse({
            ok: Boolean(stored?.extensionToken),
            available: true,
            paired: Boolean(stored?.extensionToken),
            error: stored?.extensionToken ? null : "Extension is installed but not paired yet."
          });
          return;
        }
        startExtensionPlanExecution(payload).catch((error) => {
          console.error("[gif-agent] extension execution failed", error);
        });
        sendResponse({ ok: true, started: true });
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
