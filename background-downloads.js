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

  global.LSABackgroundDownloads = Object.freeze({ extensionForMime, fileNameForMime });
})(globalThis);
