/* global chrome */

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const message = event.data;
  if (
    !message ||
    (message.type !== "gif_agent_auto_pair_request" &&
      message.type !== "gif_agent_attention_request")
  ) {
    return;
  }

  const requestId = message.requestId;
  chrome.runtime.sendMessage(
    {
      type:
        message.type === "gif_agent_attention_request"
          ? "gif_agent_attention"
          : "gif_agent_auto_pair",
      payload: message.payload || {}
    },
    (response) => {
      const runtimeError = chrome.runtime.lastError?.message;
      window.postMessage(
        {
          type:
            message.type === "gif_agent_attention_request"
              ? "gif_agent_attention_response"
              : "gif_agent_auto_pair_response",
          requestId,
          ok: Boolean(response?.ok) && !runtimeError,
          error: runtimeError || response?.error || null,
          capture: response?.capture || null,
          opened: Boolean(response?.opened),
          monitoring: Boolean(response?.monitoring)
        },
        "*"
      );
    }
  );
});
