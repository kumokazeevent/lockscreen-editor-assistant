(function initBackgroundAi(global) {
  function parseRetryAfter(value, now = Date.now()) {
    const raw = String(value || "").trim();
    if (!raw) return 0;
    const seconds = Number(raw);
    const duration = Number.isFinite(seconds) ? seconds * 1000 : new Date(raw).getTime() - now;
    return Number.isFinite(duration) && duration > 0 ? Math.min(60000, Math.ceil(duration)) : 0;
  }

  function retryDelayMs(retryIndex, retryAfterMs = 0) {
    if (Number(retryAfterMs) > 0) return Math.min(60000, Math.max(0, Math.ceil(Number(retryAfterMs))));
    return [5000, 15000, 30000][Math.max(0, Math.min(2, Number(retryIndex) || 0))];
  }

  function classifyAiError({ status = 0, code = "", responseKind = "" } = {}) {
    if (code === "OUTPUT_LENGTH") return "OUTPUT_LENGTH";
    if (code === "TIMEOUT") return "TIMEOUT";
    if (Number(status) === 429) return "RATE_LIMIT";
    if ([400, 401, 403, 404, 422].includes(Number(status)) || ["AI_NOT_CONFIGURED", "AI_ENDPOINT_INVALID"].includes(code)) return "AUTH_ERROR";
    if (Number(status) >= 500 || ["NETWORK_ERROR", "SERVER_ERROR"].includes(code)) return "SERVER_ERROR";
    if (/EMPTY|ERROR_JSON|EMPTY_CHOICES|EMPTY_CONTENT/.test(responseKind) || ["AI_EMPTY", "EMPTY_RESPONSE"].includes(code)) return "EMPTY_RESPONSE";
    return code === "AI_INVALID" ? "AI_INVALID" : "SERVER_ERROR";
  }

  function supportsThinkingControl(model, endpoint = "") {
    const value = String(model || "").trim();
    let hostname = "";
    try { hostname = new URL(endpoint).hostname; } catch {}
    return /(^|\.)api\.deepseek\.com$/i.test(hostname) ||
      /^glm[-_.\s]?5(?:\D|$)/i.test(value) || /^deepseek-v4(?:[-_.]|$)/i.test(value);
  }

  function enableMediumThinking(requestBody, model, endpoint = "") {
    if (!supportsThinkingControl(model, endpoint)) return requestBody;
    requestBody.thinking = { type: "enabled" };
    requestBody.reasoning_effort = "medium";
    return requestBody;
  }

  function disableThinking(requestBody, model, endpoint = "") {
    if (!supportsThinkingControl(model, endpoint)) return requestBody;
    requestBody.thinking = { type: "disabled" };
    delete requestBody.reasoning_effort;
    return requestBody;
  }

  function configureThinking(body, model, endpoint, level = "medium") {
    if (level === "provider") return body;
    if (level === "off") return disableThinking(body, model, endpoint);
    if (supportsThinkingControl(model, endpoint)) {
      body.thinking = { type: "enabled" };
      body.reasoning_effort = ["low", "medium", "high", "max"].includes(level) ? level : "medium";
    }
    return body;
  }

  function normalizeAiContent(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map((part) => typeof part === "string" ? part : part?.text || part?.content || "").join("");
    }
    return content?.text || "";
  }

  function getAiResponseText(data) {
    const chatContent = data?.choices?.[0]?.message?.content;
    if (chatContent != null) return normalizeAiContent(chatContent);
    if (typeof data?.output_text === "string") return data.output_text;
    if (Array.isArray(data?.output)) {
      return data.output.flatMap((item) => item?.content || [])
        .map((part) => part?.text || part?.content || "").join("");
    }
    return "";
  }

  function describeEmptyAiResponse(data) {
    const choice = data?.choices?.[0];
    const reasoning = normalizeAiContent(choice?.message?.reasoning_content).trim();
    let reason = "AI 返回内容为空";
    if (reasoning) reason = "模型只返回了思考内容，没有生成最终正文";
    else if (choice?.finish_reason === "length") reason = "模型输出达到 token 上限，没有生成最终正文";
    else if (choice?.finish_reason === "content_filter") reason = "模型输出被内容安全策略过滤";
    else if (choice?.finish_reason === "insufficient_system_resource") reason = "上游当前推理资源不足";
    const details = [
      `model=${String(data?.model || "未返回")}`,
      `choices=${Array.isArray(data?.choices) ? data.choices.length : "无"}`,
      `finish_reason=${String(choice?.finish_reason || "无")}`,
      `reasoning_chars=${Array.from(reasoning).length}`,
      `top_fields=${Object.keys(data || {}).slice(0, 8).join(",") || "无"}`,
    ];
    return `${reason}（${details.join("；")}）`;
  }

  function isReasoningTruncated(data) {
    return data?.choices?.[0]?.finish_reason === "length";
  }

  global.LSABackgroundAi = Object.freeze({
    parseRetryAfter, retryDelayMs, classifyAiError,
    supportsThinkingControl, enableMediumThinking, disableThinking, configureThinking,
    normalizeAiContent, getAiResponseText, describeEmptyAiResponse,
    isReasoningTruncated, isOutputTruncated: isReasoningTruncated,
  });
})(globalThis);
