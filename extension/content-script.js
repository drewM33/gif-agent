/* global chrome */

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const message = event.data;
  if (!message || message.type !== "gif_agent_auto_pair_request") {
    return;
  }

  const requestId = message.requestId;
  chrome.runtime.sendMessage(
    {
      type: "gif_agent_auto_pair",
      payload: message.payload || {}
    },
    (response) => {
      const runtimeError = chrome.runtime.lastError?.message;
      window.postMessage(
        {
          type: "gif_agent_auto_pair_response",
          requestId,
          ok: Boolean(response?.ok) && !runtimeError,
          error: runtimeError || response?.error || null
        },
        "*"
      );
    }
  );
});
