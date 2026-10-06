import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
const root = new URL("../", import.meta.url);
const version = JSON.parse(fs.readFileSync(new URL("manifest.json", root), "utf8")).version;
const local = {
  "lsaTab:legacy-epoch:77:imageHistory": {
    "pexels:legacy": { manual: true, updatedAt: 1700000000000, hash: "legacy-hash" },
  },
}, sync = { settings: { rewriteMode: "local", titleLimit: 12, summaryLimit: 50, usageThreshold: 3, usageWindowDays: 90 } };
const noop = () => {};
const getStore = (store) => ({ get: async (key) => key === null ? structuredClone(store) : Object.fromEntries((Array.isArray(key) ? key : [key]).map((name) => [name, structuredClone(store[name])])),
  set: async (patch) => Object.assign(store, structuredClone(patch)) });
const downloads = [];
const downloadRecords = new Map();
let fetches = 0, onDownloadChanged, onStartup;
const chrome = {
  runtime: { onInstalled: { addListener: noop }, onStartup: { addListener: (fn) => { onStartup = fn; } }, onMessage: { addListener: noop } },
  action: { onClicked: { addListener: noop } },
  contextMenus: { onClicked: { addListener: noop } },
  storage: { local: getStore(local), sync: getStore(sync) },
  tabs: { query: async () => [{id:1,index:0,url:'https://lockscreen-admin.mofeeds.com/#/nav/overseasContent?index=5'}, {id:2,index:1,url:'https://lockscreen-admin.mofeeds.com/#/nav/overseasDeliver?index=5&type=editEMPTY&id=2'}],
    sendMessage: async (id) => ({ok:true,items:[{id:String(id)}],pageLabel:`page${id}`}) },
  downloads: { download: async (data) => { downloads.push(data); const id = downloads.length; downloadRecords.set(id, { id, state: "in_progress" }); return id; },
    search: async ({id}) => downloadRecords.has(id) ? [structuredClone(downloadRecords.get(id))] : [],
    onChanged: { addListener: (fn) => { onDownloadChanged = fn; } },
  },
};
const context = vm.createContext({chrome, console, URL, URLSearchParams, TextEncoder, Uint8Array, ArrayBuffer, AbortController,
  setTimeout, clearTimeout, crypto: webcrypto, btoa, atob, importScripts: noop,
  fetch: async (url) => { fetches += 1; return new Response(`image-bytes:${String(url).includes('alias') ? 'same' : new URL(url).pathname}`, {headers:{'content-type':'image/jpeg'}}); },
});
for (const name of ["workflow.js", "background-ai.js", "background-stock.js", "background-downloads.js", "background-locks.js", "background.js"]) vm.runInContext(fs.readFileSync(new URL(name, root), "utf8"), context, {filename:name});
const run = (code) => vm.runInContext(code, context);
const migration = await run("migrateLegacyDuplicateMarks()");
assert.equal(migration.migrated, true);
assert.ok(local.lsaManualDuplicates["pexels:legacy"], "旧标签页手动标记应迁移到全局库");
assert.equal(local["lsaTab:legacy-epoch:77:imageHistory"]["pexels:legacy"].manual, true, "迁移不得删除旧记录");
const beforeRestart = await run("getTabContext(77)");
local[beforeRestart.keys.batchState] = { batchId: "old-session", items: [{ id: "old" }] };
onStartup();
await run("epochPromise");
const afterRestart = await run("getTabContext(77)");
assert.notEqual(afterRestart.keys.batchState, beforeRestart.keys.batchState, "浏览器重启后标签页 epoch 必须失效");
assert.ok(local[beforeRestart.keys.batchState]?.items?.length, "epoch 失效不应破坏旧批次文件");
assert.equal(local[afterRestart.keys.batchState], undefined, "新会话不得误读旧标签页批次");
assert.equal(run('LSAWorkflow.count("á")'), 1);
assert.equal(run('LSAWorkflow.count("🐱 A!")'), 1);
assert.equal(run('LSAWorkflow.count("How to care for cats")'), 5);
assert.equal(run('LSAWorkflow.count("well-known cats don’t fear 2026!")'), 5);
assert.equal(run('LSAWorkflow.localShorten("Internationalization",12)'), 'Internationalization');
assert.equal(run('LSAWorkflow.count("Как ухаживать за кошкой")'),4);
assert.equal(run('LSAWorkflow.count("Cómo cuidar a los gatos")'),5);
assert.equal(run('LSAWorkflow.count("Cách chăm sóc mèo")'),4);
assert.equal(run('LSAWorkflow.count("كيف تعتني بالقطط")'),3);
for (const [label,code] of [['波斯语','fa'],['尼泊尔语','ne'],['僧伽罗语','si'],['缅甸语','my'],['吉尔吉斯语','ky'],['塔吉克语','tg'],['阿塞拜疆语','az'],['孟加拉语','bn'],['印度尼西亚语','id']]) {
  context.languageLabel=label;
  assert.equal(run('LSAWorkflow.normalizeLanguageCode(languageLabel)'),code,`${label} 语言代码缺失`);
}
for (const source of ['Care for cats at home', 'Как ухаживать за котом', 'Cómo cuidar las flores', 'Cách chăm sóc mèo', 'العناية بالقطط']) {
  context.sourceText = source;
  const shortened = run('LSAWorkflow.localShorten(sourceText, 12)');
  assert.ok(run(`LSAWorkflow.count(${JSON.stringify(shortened)})`) <= 12);
  assert.ok(!/[\u3400-\u9fff]/.test(shortened));
}
await assert.rejects(run('generateBatchItemWithAi({item:{originalTitle:"Care for cats",originalSummary:"Keep cats comfortable in a warm quiet home"}})'), /文章正文/);
await run('generateBatchItemWithAi({item:{originalTitle:"Care for cats",originalSummary:"Keep cats comfortable in a warm quiet home",articleText:"Cats need a warm quiet sleeping area and fresh water every day."}})');
await run('generateImageQueryWithAi({title:"cat"})');
assert.equal(fetches, 0, '本地模式必须完全跳过 AI 网络');
for (const level of ['off','low','medium','high','max','provider']) {
  const body = run(`configureThinking({}, 'deepseek-v4-flash','https://api.deepseek.com/chat/completions', '${level}')`);
  assert.equal(body.thinking?.type, level === 'provider' ? undefined : level === 'off' ? 'disabled' : 'enabled');
  assert.equal(body.reasoning_effort, ['off','provider'].includes(level) ? undefined : level);
}
assert.ok(run(`buildAiMessages({originalTitle:'Cat care',originalSummary:'Care for cats',articleText:'Cats need fresh water and a quiet home.',titleLimit:18,summaryLimit:60,rewritePrompt:'Use a calm tone within {titleLimit} and {summaryLimit} characters.'})[0].content`).includes('Use a calm tone within 18 and 60 words.'));
const exported = {version:3,batchId:'test',items:[{id:'1',pageKey:'a',pageLabel:'第1页',originalTitle:'Cat care', title:'Cat care',summary:'Gentle care for cats',imageQueryEn:'cat at home',image:{id:'1',source:'pexels',imageUrl:'https://images.pexels.com/photos/1/a.jpg',width:900,height:1600,safetyStatus:'passed'}}]};
context.exported = exported;
const batch = run('LSAWorkflow.importBatch(exported, {titleLimit:12,summaryLimit:50})');
assert.equal(batch.items[0].status, 'completed');
assert.equal(batch.items[0].pageKey, 'a');
assert.equal(batch.items[0].downloadStatus, '');
exported.items[0].imageQuerySourceTitle='Cat care';
assert.equal(run('LSAWorkflow.importBatch(exported).items[0].imageQuerySourceTitle'),'Cat care');
exported.items[0].titleZh='猫咪护理';
assert.equal(run('LSAWorkflow.importBatch(exported).items[0].titleZh'),'猫咪护理','导入批次必须保留标题中文缓存');
exported.items[0].title = 'A title with far more than twelve written words exceeds the newly configured limit';
assert.equal(run('LSAWorkflow.importBatch(exported, {titleLimit:12,summaryLimit:50}).items[0].status'), 'error');
context.failedImport={version:4,batchId:'failed-import',items:[
  {id:'e1',originalTitle:'One',status:'error',error:'busy',errorType:'SERVER_ERROR',model:'primary',aiAttempts:3,aiDiagnostics:[{httpStatus:503}]},
  {id:'e2',originalTitle:'Two',status:'error',error:'empty',error_type:'EMPTY_RESPONSE',model:'backup',aiAttempts:4,usedFallbackModel:true},
]};
const importedFailures=run('LSAWorkflow.importBatch(failedImport)');
assert.equal(importedFailures.items[0].errorType,'SERVER_ERROR');
assert.equal(importedFailures.items[0].aiModel,'primary');
assert.equal(importedFailures.items[0].aiAttempts,3);
assert.equal(importedFailures.items[1].usedFallbackModel,true);
context.importedFailures=importedFailures;
assert.equal(run('LSAWorkflow.failureTypeCounts(importedFailures.items).SERVER_ERROR'),1);
assert.equal(run('LSAWorkflow.failureTypeCounts(importedFailures.items).EMPTY_RESPONSE'),1);
assert.equal(run("LSAWorkflow.failedItemsByType(importedFailures.items,'EMPTY_RESPONSE').length"),1);
exported.items[0].editUrl = 'javascript:alert(1)';
assert.ok(run('LSAWorkflow.importBatch(exported).items[0].editUrl').startsWith('https://lockscreen-admin.mofeeds.com/'));
assert.throws(() => run('LSAWorkflow.importBatch({items:[{title:"Original only"}]})'));
await run('workLock("acquire", "one", 1)');
await assert.rejects(run('workLock("acquire", "other", 1)'));
await run('workLock("acquire", "two", 2)');
assert.equal((await run('workLock("status", "two", 2)')).owns,true);
await run('workLock("release", "one", 1)');
assert.equal((await run('workLock("status", "two", 2)')).owns,true,'A释放任务不影响B');
await run('workLock("release", "two", 2)');
assert.notEqual((await run('getTabContext(1)')).keys.batchState,(await run('getTabContext(2)')).keys.batchState);
for (let i = 1; i <= 31; i++) {
  const result = await run(`downloadFinalImage({image:{id:'${i}',source:'pexels',imageUrl:'https://images.pexels.com/photos/${i}/image.jpg'},item:{index:${i},title:'Cat',summary:'Resting'}})`);
  assert.equal(result.sequenceNumber, i);
  assert.ok(result.folder.includes(i <= 30 ? '第001组' : '第002组'));
}
assert.equal((await run("downloadFinalImage({image:{id:'1',source:'pexels',imageUrl:'https://images.pexels.com/photos/1/other-size.jpg'}})")).skipped,true);
const pair = await Promise.all([run("downloadFinalImage({image:{id:'a',source:'pixabay',imageUrl:'https://image.test/alias-a.jpg'}})"), run("downloadFinalImage({image:{id:'b',source:'pixabay',imageUrl:'https://image.test/alias-b.jpg'}})")]);
assert.equal(pair.filter((item) => item.skipped).length,1,'并发同内容只允许一个下载');
await run("markDuplicate({image:{id:'55',source:'pexels'},marked:true})");
assert.equal((await run("downloadFinalImage({image:{id:'55',source:'pexels',imageUrl:'https://image.test/new.jpg'}})")).skipped,true);
const forced = await run("downloadFinalImage({image:{id:'55',source:'pexels',imageUrl:'https://image.test/new.jpg'},force:true})");
assert.ok(forced.downloadId, "仍然下载应仅豁免当次");
assert.ok(local.lsaManualDuplicates["pexels:55"], "force 不得清除全局标记");
const pendingId = local.imageHistory['pexels:1'].downloadId;
onDownloadChanged({id:pendingId,state:{current:'interrupted'}});
await run('imageHistoryChain');
assert.equal(local.imageHistory['pexels:1'].status,'interrupted');
assert.equal((await run("downloadFinalImage({image:{id:'1',source:'pexels',imageUrl:'https://images.pexels.com/photos/1/image.jpg'}})")).skipped,undefined);
await run("markDuplicate({image:{id:'1',source:'pexels'},marked:true})");
await run("markDuplicate({image:{id:'1',source:'pexels'},marked:false})");
assert.ok(local.imageHistory['pexels:1'].hash,'解除手动标记不得清除文件 hash');
await run("markDuplicate({image:{id:'shared',source:'pexels'},marked:true}, 1)");
const independent = await run("downloadFinalImage({image:{id:'shared',source:'pexels',imageUrl:'https://image.test/shared.jpg'}}, 2)");
assert.equal(independent.skipped,true,'A标签页的全局手动重复标记必须阻止B下载');
await run("markDuplicate({image:{id:'shared',source:'pexels'},marked:false}, 2)");
assert.equal(local.lsaManualDuplicates['pexels:shared'],undefined,'解除标记应同步清理全局库');
assert.equal(run('LSAWorkflow.batchSize(40)'),40);
assert.equal(run('LSAWorkflow.batchSize("40")'),40);
assert.equal(run('LSAWorkflow.batchSize(50)'),30);
for (let i = 1; i <= 41; i++) {
  const result = await run("reserveFinalImageFolder('40-mode-test',40)");
  assert.equal(result.sequenceNumber,i);
  assert.ok(result.folder.endsWith(i <= 40 ? '第001组_001-040' : '第002组_041-080'));
}
const backTo30 = await run("reserveFinalImageFolder('40-mode-test',30)");
assert.equal(backTo30.sequenceNumber,1,'切换档位的计数互不混淆');
context.mixed={version:4,batchId:'mixed',createdAt:1788508800000,batchLimit:40,items:[
  {...exported.items[0],id:'x1',pageKey:'p1',pageLanguage:'英语',pageCountry:'南非'},
  {...exported.items[0],id:'x2',pageKey:'p2',pageLanguage:'俄语',pageCountry:'白俄罗斯'},
  {...exported.items[0],id:'x3',pageKey:'p2',pageLanguage:'俄语',pageCountry:'白俄罗斯'}]};
const grouped=run('LSAWorkflow.splitBatchFolders(LSAWorkflow.importBatch(mixed))');
assert.equal(grouped.length,2);
assert.equal(grouped[1].items.length,2);
assert.equal(grouped[1].metadata.country,'白俄罗斯');
assert.equal(grouped[1].batchLimit,40);
assert.equal(grouped[1].metadata.capturedAt,context.mixed.createdAt);
const named=run('LSAWorkflow.folderName(LSAWorkflow.splitBatchFolders(LSAWorkflow.importBatch(mixed))[1])');
assert.match(named,/^俄语_白俄罗斯_\d{8}-\d{9}-/);
assert.equal(run(`LSAWorkflow.folderName({batchId:'a',metadata:{language:'../英语',country:'南非/..',capturedAt:1788508800000}})`).includes('/'),false);
const groupedImage = await run(`downloadFinalImage({batchFolder:${JSON.stringify(named)},batchLimit:40,image:{id:'folder-test',source:'pexels',imageUrl:'https://image.test/folder-test.jpg'}},2)`);
assert.ok(groupedImage.path.includes(named+'/第001组_001-040'));
assert.ok(!groupedImage.path.includes('标签页-2-'));
const namedBatch=run('LSAWorkflow.splitBatchFolders(LSAWorkflow.importBatch(mixed))[1]');
context.namedBatch=namedBatch;
const resultName=run("LSAWorkflow.batchFileName(LSAWorkflow.splitBatchFolders(LSAWorkflow.importBatch(mixed))[1],'批次结果')");
assert.match(resultName,/^俄语_白俄罗斯_2条_\d{8}-\d{4}_批次结果_[a-z0-9]+\.json$/);
assert.ok(named.endsWith(`-${run('LSAWorkflow.batchStampSuffix(LSAWorkflow.splitBatchFolders(LSAWorkflow.importBatch(mixed))[1])')}`),'JSON 与文件夹应共用短后缀');
assert.throws(()=>run("LSAWorkflow.batchFileName(namedBatch,'任意类型')"));
const usageDownload=await run("downloadFinalImage({image:{id:'usage',source:'pexels',imageUrl:'https://image.test/usage.jpg'}})");
assert.equal(local.lsaImageUsage?.['pexels:usage'],undefined,'排队时不得计入使用次数');
downloadRecords.set(usageDownload.downloadId,{id:usageDownload.downloadId,state:'complete',endTime:new Date().toISOString()});
onDownloadChanged({id:usageDownload.downloadId,state:{current:'complete'}});
await run('imageHistoryChain');
assert.equal(local.lsaImageUsage['pexels:usage'].events.length,1,'下载完成后应计入一次');
onDownloadChanged({id:usageDownload.downloadId,state:{current:'complete'}});
await run('imageHistoryChain');
assert.equal(local.lsaImageUsage['pexels:usage'].events.length,1,'重复 complete 事件不得重复计数');
local.lsaImageUsage['pexels:cap']={events:Array.from({length:45},(_,index)=>Date.now()-index*1000).concat(Date.now()-400*86400000)};
await run("recordImageUsageUnlocked('pexels:cap')");
assert.equal(local.lsaImageUsage['pexels:cap'].events.length,40,'单图最多保留40次且清理一年外事件');
context.rebuildBatch={version:4,batchId:'rebuild-once',createdAt:Date.now()-1000,items:[
  {image:{id:'rebuilt',source:'pexels'}},{image:{id:'rebuilt',source:'pexels'}},{image:{id:'usage',source:'pexels'}}]};
const rebuilt=await run('rebuildImageUsage({batch:rebuildBatch})');
assert.equal(rebuilt.rebuilt,true);
assert.equal(local.lsaImageUsage['pexels:rebuilt'].events.length,2,'空白图片用量应按批次条目数重建');
assert.equal(local.lsaImageUsage['pexels:usage'].events.length,1,'已有用量不得被导入覆盖');
assert.equal((await run('rebuildImageUsage({batch:rebuildBatch})')).rebuilt,false,'同批次不得重复重建');
const tabOne=await run('getTabContext(1)');
local[tabOne.keys.imageHistory]={"pexels:missing":{status:'queued',downloadId:999999,hash:'keep-me'}};
const reconciled=await run('reconcileImageDownloads(1)');
assert.equal(reconciled.interrupted,1);
assert.equal(local[tabOne.keys.imageHistory]['pexels:missing'].status,'interrupted');
assert.equal(local[tabOne.keys.imageHistory]['pexels:missing'].hash,'keep-me');
await run("markDuplicate({image:{id:'library',source:'pixabay',imageUrl:'https://image.test/library.jpg'},marked:true})");
const library=await run('exportDuplicateLibrary()');
context.library=library;
assert.equal(library.format,'lockscreen-manual-duplicates');
await run("removeDuplicatesBySource('pixabay')");
assert.equal(local.lsaManualDuplicates['pixabay:library'],undefined);
await run('importDuplicateLibrary({library})');
assert.ok(local.lsaManualDuplicates['pixabay:library'],'导出的标记库应可重新导入');
console.log(`${version} 工作流测试通过：词数、17种语言代码、epoch 隔离、翻译缓存、全局去重及 30/40 分组边界`);
