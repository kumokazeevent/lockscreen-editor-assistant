import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")).version;
const require = createRequire(path.join(
  process.env.LSA_NODE_MODULES || "C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules",
  "package.json",
));
const { chromium } = require("playwright");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "lsa-extension-smoke-"));
let context;

try {
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  });
  let workers = context.serviceWorkers();
  if (!workers.length) workers = [await context.waitForEvent("serviceworker", { timeout: 15000 })];
  const worker = workers.find((item) => item.url().endsWith("/background-entry.js"));
  if (!worker) throw new Error("没有启动 background-entry.js 模块 service worker");
  const loaded = await worker.evaluate(() => Boolean(
    globalThis.LSAWorkflow
      && globalThis.LSABackgroundAi
      && globalThis.LSABackgroundStock
      && globalThis.LSABackgroundDownloads
      && globalThis.LSABackgroundLocks,
  ));
  if (!loaded) throw new Error("后台模块未全部载入");
  console.log(`${version} MV3 模块后台加载通过`);
} finally {
  await context?.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
