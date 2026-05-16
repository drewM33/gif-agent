/* global chrome */

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const message = event.data;
  if (
    !message ||
    (message.type !== "gif_agent_auto_pair_request" &&
      message.type !== "gif_agent_attention_request" &&
      message.type !== "gif_agent_execute_plan_request")
  ) {
    return;
  }

  const requestId = message.requestId;
  const requestType =
    message.type === "gif_agent_attention_request"
      ? "gif_agent_attention"
      : message.type === "gif_agent_execute_plan_request"
        ? "gif_agent_execute_plan"
        : "gif_agent_auto_pair";
  const responseType =
    message.type === "gif_agent_attention_request"
      ? "gif_agent_attention_response"
      : message.type === "gif_agent_execute_plan_request"
        ? "gif_agent_execute_plan_response"
        : "gif_agent_auto_pair_response";
  chrome.runtime.sendMessage(
    {
      type: requestType,
      payload: message.payload || {}
    },
    (response) => {
      const runtimeError = chrome.runtime.lastError?.message;
      window.postMessage(
        {
          type: responseType,
          requestId,
          ok: Boolean(response?.ok) && !runtimeError,
          error: runtimeError || response?.error || null,
          capture: response?.capture || null,
          available: Boolean(response?.available),
          paired: Boolean(response?.paired),
          started: Boolean(response?.started),
          frameCount: Number(response?.frameCount || 0),
          opened: Boolean(response?.opened),
          monitoring: Boolean(response?.monitoring)
        },
        "*"
      );
    }
  );
});
