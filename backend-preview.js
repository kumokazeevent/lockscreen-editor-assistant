(() => {
  "use strict";

  const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

  function validId(value) {
    return typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
  }

  function imageUrl(value, base = "https://lockscreen-admin.mofeeds.com") {
    const raw = clean(value);
    if (!raw) return "";
    const url = new URL(raw, base);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
      throw new Error("后台右侧图片地址必须是 HTTP/HTTPS 图片链接");
    }
    return url.href;
  }

  function detailFromResponse(payload, expectedId) {
    if (!validId(expectedId)) throw new Error("条目 ID 无效，请重新读取列表");
    if (payload?.code != null && String(payload.code) !== "0") {
      throw new Error(clean(payload.message || payload.msg) || `后台读取失败（${payload.code}）`);
    }
    const detail = payload?.data;
    if (!detail || String(detail.id ?? "") !== expectedId) {
      throw new Error("后台详情 ID 与当前条目不一致");
    }
    return detail;
  }

  function previewFromDetail(detail) {
    // Overseas edit page renders this field to the right of the uploader.
    // originImage is the left-hand upload image; content/images are unrelated.
    const raw = detail?.originImageWebp;
    if (!raw?.url) return null;
    return {
      sourceField: "originImageWebp",
      url: imageUrl(raw.url),
      width: Math.max(0, Number(raw.width) || 0),
      height: Math.max(0, Number(raw.height) || 0),
      size: Math.max(0, Number(raw.size) || 0),
    };
  }

  function fileName(record, extension = "jpg") {
    if (!validId(String(record?.id || ""))) throw new Error("图片文件缺少有效条目 ID");
    const index = Math.max(1, Math.round(Number(record.index) || 1));
    const title = clean(record.title || record.originalTitle || "无标题")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
      .replace(/[. ]+$/g, "").slice(0, 95) || "无标题";
    const suffix = extension === "png" ? "png" : "jpg";
    return `${String(index).padStart(2, "0")}-${record.id}-${title}.${suffix}`;
  }

  globalThis.LSABackendPreview = Object.freeze({ validId, imageUrl, detailFromResponse, previewFromDetail, fileName });
})();
