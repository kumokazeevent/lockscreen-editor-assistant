(() => {
  "use strict";

  if (window.__lsaPageBridgeInstalled) return;
  window.__lsaPageBridgeInstalled = true;

  const captured = new Map();
  const TITLE_KEYS = [
    "originalTitle", "originTitle", "articleTitle", "contentTitle", "lockscreenTitle",
    "lockTitle", "titleText", "oriTitle", "title", "name",
  ];
  const ID_KEYS = [
    "contentId", "contentID", "content_id", "articleId", "articleID", "article_id",
    "lockscreenId", "lockScreenId", "materialId", "itemId", "newsId", "dataId", "id", "_id",
  ];
  const SOURCE_KEYS = [
    "sourceUrl", "articleUrl", "contentUrl", "targetUrl", "linkUrl", "sourceLink", "viewUrl", "link", "url",
  ];
  const EDIT_KEYS = ["editUrl", "editorUrl", "deliverUrl", "manageUrl"];
  const MAX_CAPTURED_ARTICLE_CHARS = 12000;

  function clean(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function primitiveFromKeys(object, keys) {
    for (const key of keys) {
      const value = object?.[key];
      if (["string", "number"].includes(typeof value) && clean(value)) return clean(value);
    }
    return "";
  }

  function safeUrl(value) {
    const raw = clean(value);
    if (!raw || (!/^https?:\/\//i.test(raw) && !/^#\//.test(raw))) return "";
    try { return new URL(raw, location.href).href; } catch { return ""; }
  }

  function readableArticleText(value) {
    if (typeof value !== "string" || !value.trim()) return "";
    let text = value;
    if (/<\s*[a-z][^>]*>/i.test(value)) {
      const doc = new DOMParser().parseFromString(value, "text/html");
      doc.querySelectorAll("script,style,noscript,template,svg,canvas,iframe,nav,footer,form").forEach((node) => node.remove());
      text = doc.body?.textContent || "";
    }
    text = text.replace(/\u00a0/g, " ").replace(/[\u200b-\u200d\ufeff]/g, "")
      .replace(/\s+/g, " ").trim().slice(0, MAX_CAPTURED_ARTICLE_CHARS);
    if (text.length < 320 && /copyright|all rights reserved|版权所有|保留所有权利/i.test(text)) return "";
    return text;
  }

  function remember(object) {
    if (!object || typeof object !== "object" || Array.isArray(object)) return;
    const title = primitiveFromKeys(object, TITLE_KEYS);
    const id = primitiveFromKeys(object, ID_KEYS);
    if (!title || !id || title.length < 2 || title.length > 240 || id.length > 100) return;
    const sourceUrl = safeUrl(primitiveFromKeys(object, SOURCE_KEYS));
    const editUrl = safeUrl(primitiveFromKeys(object, EDIT_KEYS));
    const key = `${id}\u0000${title}`;
    const previous = captured.get(key) || {};
    const summary = primitiveFromKeys(object, ["originalSummary", "summary", "description", "intro", "contentDesc"]);
    const articleText = readableArticleText(object.content || object.articleContent || object.body || "");
    captured.set(key, {
      id, title,
      summary: summary || previous.summary || "",
      sourceUrl: sourceUrl || previous.sourceUrl || "",
      editUrl: editUrl || previous.editUrl || "",
      articleText: articleText || previous.articleText || "",
    });
    while (captured.size > 300) captured.delete(captured.keys().next().value);
  }

  function inspectPayload(root) {
    const queue = [{ value: root, depth: 0 }];
    const seen = new WeakSet();
    let inspected = 0;
    while (queue.length && inspected < 12000) {
      const { value, depth } = queue.shift();
      if (!value || typeof value !== "object" || seen.has(value)) continue;
      seen.add(value);
      inspected += 1;
      if (!Array.isArray(value)) remember(value);
      if (depth >= 8) continue;
      const children = Array.isArray(value) ? value.slice(0, 500) : Object.values(value).slice(0, 160);
      for (const child of children) {
        if (child && typeof child === "object") queue.push({ value: child, depth: depth + 1 });
      }
    }
    publish();
  }

  function publish() {
    window.postMessage({
      source: "lsa-page-bridge",
      type: "records",
      records: [...captured.values()].slice(-300),
    }, location.origin);
  }

  async function inspectFetchResponse(response) {
    try {
      const contentType = response.headers.get("content-type") || "";
      if (!/json/i.test(contentType)) return;
      inspectPayload(await response.clone().json());
    } catch {
      // A failed clone/parser must never affect the site's own response.
    }
  }

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === "function") {
    window.fetch = function lsaObservedFetch(...args) {
      const result = nativeFetch.apply(this, args);
      result.then(inspectFetchResponse).catch(() => {});
      return result;
    };
  }

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function lsaObservedOpen(method, url, ...rest) {
    this.__lsaRequestUrl = clean(url);
    return nativeOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function lsaObservedSend(...args) {
    this.addEventListener("load", () => {
      try {
        const contentType = this.getResponseHeader("content-type") || "";
        if (this.responseType === "json" && this.response) inspectPayload(this.response);
        else if (/json/i.test(contentType) && typeof this.responseText === "string") inspectPayload(JSON.parse(this.responseText));
      } catch {
        // Observation is best effort and never changes the site's XHR result.
      }
    }, { once: true });
    return nativeSend.apply(this, args);
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "lsa-extension") return;
    if (event.data.type === "request-records") publish();
  });
})();
