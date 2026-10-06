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
    "sourceUrl", "articleUrl", "contentUrl", "targetUrl", "linkUrl", "sourceLink", "viewUrl", "link",
  ];
  const EDIT_KEYS = ["editUrl", "editorUrl", "deliverUrl", "manageUrl"];

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

  function remember(object) {
    if (!object || typeof object !== "object" || Array.isArray(object)) return;
    const title = primitiveFromKeys(object, TITLE_KEYS);
    const id = primitiveFromKeys(object, ID_KEYS);
    if (!title || !id || title.length < 2 || title.length > 240 || id.length > 100) return;
    const sourceUrl = safeUrl(primitiveFromKeys(object, SOURCE_KEYS));
    const editUrl = safeUrl(primitiveFromKeys(object, EDIT_KEYS));
    const key = `${id}\u0000${title}`;
    const previous = captured.get(key) || {};
    captured.set(key, { id, title, sourceUrl: sourceUrl || previous.sourceUrl || "", editUrl: editUrl || previous.editUrl || "" });
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
