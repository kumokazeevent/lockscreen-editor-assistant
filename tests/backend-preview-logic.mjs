import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const noop = () => {};
const downloads = [];
const urls = [];
let imageMime = "image/jpeg", interrupted = false;
let imageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const sandbox = vm.createContext({
  URL, URLSearchParams, Blob, Response, Uint8Array, ArrayBuffer, TextEncoder, AbortController, setTimeout, clearTimeout,
  btoa, atob, console, importScripts: noop,
  chrome: {
    runtime: { onMessage: { addListener: noop }, onInstalled: { addListener: noop } },
    action: { onClicked: { addListener: noop } }, contextMenus: { onClicked: { addListener: noop } },
    storage: { sync: { get: async () => ({ settings: {} }) }, local: { get: async () => ({}), set: async () => {} } },
    downloads: { onChanged: { addListener: noop }, download: async (data) => { downloads.push(data); return downloads.length; },
      search: async () => [{ state: interrupted ? "interrupted" : "complete", error: "FILE_FAILED" }] },
  },
  fetch: async (url) => { urls.push(String(url)); return new Response(imageBytes, { headers: { "content-type": imageMime } }); },
  createImageBitmap: async () => ({ width: 1000, height: 1800, close: noop }),
  OffscreenCanvas: class { getContext() { return { fillRect: noop, drawImage: noop }; } async convertToBlob() { return new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" }); } },
});
for (const file of ["workflow.js", "backend-preview.js", "background-ai.js", "background-stock.js", "background-downloads.js", "background-locks.js", "background.js"]) {
  vm.runInContext(fs.readFileSync(`${root}/${file}`, "utf8"), sandbox, { filename: file });
}
const run = (code) => vm.runInContext(code, sandbox);

assert.equal(run("LSABackendPreview.previewFromDetail({originImage:{url:'https://img.test/left.jpg'},content:'<img src=\"https://img.test/body.jpg\" />'})"), null);
assert.throws(() => run("LSABackendPreview.detailFromResponse({code:0,data:{id:'ls_other'}},'ls_a')"), /ID/);
assert.throws(() => run("LSABackendPreview.detailFromResponse({code:401,data:{id:'ls_a'}},'ls_a')"), /401/);
assert.throws(() => run("LSABackendPreview.previewFromDetail({originImageWebp:{url:'javascript:alert(1)'}})"), /HTTP/);
assert.throws(() => run("LSABackendPreview.fileName({id:'../bad'})"), /ID/);

const payload = {
  record: { index: 31, id: "ls_a", title: 'Clouds / sea: morning?' },
  image: { sourceField: "originImageWebp", url: "https://images.pexels.com/photos/42/pexels-photo-42.jpeg?auto=compress&cs=tinysrgb&w=2400" },
  folder: "锁屏批次/成品图片", batchFolder: "英语_美国_时间", batchLimit: 30,
};
sandbox.payload = payload;
const jpeg = await run("downloadBackendPreview(payload)");
assert.equal(jpeg.status, "completed");
assert.equal(urls[0], payload.image.url, "应使用右侧图的完整地址，不追加列表页压缩参数");
assert.ok(jpeg.path.includes("后台预览图/第02组/31-ls_a-"));
assert.ok(jpeg.path.endsWith(".jpg"));
assert.ok(downloads[0].url.startsWith("data:image/jpeg;base64,"));
assert.equal(downloads[0].saveAs, false);
await run("downloadBackendPreview(payload)");
assert.equal(downloads.length, 2, "不同条目的本地上传文件不得被图库重复规则跳过");

payload.batchLimit = 40;
imageMime = "image/avif";
imageBytes = new Uint8Array([0, 0, 0, 24, ...Buffer.from("ftypavif"), 0, 0, 0, 0, ...Buffer.from("avifmif1")]);
const avif = await run("downloadBackendPreview(payload)");
assert.equal(avif.converted, true);
assert.equal(avif.mime, "image/jpeg");
assert.ok(avif.path.includes("第01组") && avif.path.endsWith(".jpg"));
imageMime = "image/png";
imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = await run("downloadBackendPreview(payload)");
assert.equal(png.converted, false);
assert.ok(png.path.endsWith(".png"));
imageMime = "image/jpeg";
imageBytes = new Uint8Array([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP")]);
const mislabeledWebp = await run("downloadBackendPreview(payload)");
assert.equal(mislabeledWebp.converted, true, "响应头伪称 JPEG 时也必须按文件内容把 WebP 转成真正 JPEG");
assert.equal(mislabeledWebp.mime, "image/jpeg");
assert.ok(downloads.at(-1).url.startsWith("data:image/jpeg;base64,/9j/"));
imageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
imageMime = "text/html";
await assert.rejects(run("downloadBackendPreview(payload)"), /不是图片/);
imageMime = "image/jpeg";
imageBytes = new TextEncoder().encode("<html>Expired image link</html>");
await assert.rejects(run("downloadBackendPreview(payload)"), /不是可识别的图片/);
imageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
interrupted = true;
await assert.rejects(run("downloadBackendPreview(payload)"), /保存中断/);
await assert.rejects(run("downloadBackendPreview({...payload,image:{sourceField:'originImage',url:'https://img.test/left.jpg'}})"), /右侧/);
console.log("后台右侧图片：字段区分、ID 配对、30/40 分组、JPEG/PNG/AVIF、失效链接和下载中断测试通过");
