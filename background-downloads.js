(function initBackgroundDownloads(global) {
  function extensionForMime(mime) {
    return ({
      "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp",
      "image/gif": "gif", "image/avif": "avif",
    })[String(mime || "").toLowerCase()] || "jpg";
  }

  function sanitizePathSegment(value, fallback = "未命名") {
    const cleaned = String(value || "")
      .replace(/[<>:\"/\\|?*\u0000-\u001f]/g, "-")
      .replace(/[. ]+$/g, "")
      .replace(/^\.+/g, "")
      .replace(/-{2,}/g, "-")
      .trim();
    return cleaned || fallback;
  }

  function sanitizeFileName(value, fallback = "file.txt") {
    const raw = String(value || fallback).replace(/\\/g, "/").split("/").pop();
    return sanitizePathSegment(raw, fallback).slice(0, 190);
  }

  function fileNameForMime(value, mime, fallback = "lockscreen-image.jpg") {
    const extension = extensionForMime(mime);
    const safe = sanitizeFileName(value || fallback, fallback);
    const stem = safe.replace(/\.[a-z0-9]{1,8}$/i, "") || "lockscreen-image";
    return sanitizeFileName(`${stem}.${extension}`, fallback);
  }

  function sanitizeRelativeFolder(value, fallback) {
    const raw = String(value || fallback || "").trim().replace(/\\/g, "/");
    if (!raw) return "";
    if (raw.startsWith("/") || /^[a-z]:/i.test(raw) || raw.split("/").some((part) => part === "..")) {
      throw new Error("下载目录必须是浏览器“下载”文件夹内的相对子目录，不能使用盘符、绝对路径或 ..");
    }
    return raw.split("/").filter((part) => part && part !== ".")
      .map((part) => sanitizePathSegment(part, "未命名目录")).join("/");
  }

  function joinDownloadPath(folder, fileName) {
    return [folder, fileName].filter(Boolean).join("/");
  }

  function inferImageMime(url, contentType) {
    const normalized = String(contentType || "").split(";")[0].trim().toLowerCase();
    if (/^image\//.test(normalized)) return normalized;
    let pathname = "";
    try { pathname = new URL(url).pathname.toLowerCase(); } catch {}
    if (/\.png$/.test(pathname)) return "image/png";
    if (/\.webp$/.test(pathname)) return "image/webp";
    if (/\.gif$/.test(pathname)) return "image/gif";
    if (/\.avif$/.test(pathname)) return "image/avif";
    return "image/jpeg";
  }

  function chooseDownloadUrl(image = {}, item = {}) {
    const aspectLabel = image.aspectLabel || item.aspectLabel || "9:16";
    return image.selectedUrl || image.uploadUrl || image.downloadUrl || image.originalUrl || image.imageUrl ||
      image.cropUrls?.[aspectLabel] || item.imageUrl || "";
  }

  global.LSABackgroundDownloads = Object.freeze({
    extensionForMime, sanitizePathSegment, sanitizeFileName, fileNameForMime,
    sanitizeRelativeFolder, joinDownloadPath, inferImageMime, chooseDownloadUrl,
  });
})(globalThis);
