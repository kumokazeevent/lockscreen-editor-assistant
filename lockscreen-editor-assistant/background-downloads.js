(function initBackgroundDownloads(global) {
  function imageMimeFromBytes(buffer) {
    const bytes = new Uint8Array(buffer);
    const ascii = (start, length) => String.fromCharCode(...bytes.subarray(start, start + length));
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)) return "image/png";
    if (bytes.length >= 6 && /^(GIF87a|GIF89a)$/.test(ascii(0, 6))) return "image/gif";
    if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
    if (bytes.length >= 16 && ascii(4, 4) === "ftyp") {
      const boxSize = ((bytes[0] * 0x1000000) + (bytes[1] << 16) + (bytes[2] << 8) + bytes[3]);
      const limit = Math.min(bytes.length, boxSize, 256);
      for (let offset = 8; offset + 4 <= limit; offset += 4) {
        if (offset === 12) continue; // Minor version is not a compatible brand.
        if (/^(avif|avis)$/.test(ascii(offset, 4))) return "image/avif";
      }
    }
    return "";
  }

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

  global.LSABackgroundDownloads = Object.freeze({ extensionForMime, fileNameForMime, imageMimeFromBytes });
})(globalThis);
