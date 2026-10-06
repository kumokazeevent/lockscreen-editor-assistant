import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8')).version;
const require = createRequire(path.join(process.env.LSA_NODE_MODULES || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules','package.json'));
const { chromium } = require('playwright');
const browser = await chromium.launch({channel:'chrome',headless:true});
const store = {local:{localSecrets:{aiApiKey:'test-key',pexelsApiKey:'test-key'}},sync:{settings:{aiEndpoint:'https://api.test/chat/completions',aiModel:'exact-test-model',titleLimit:12,summaryLimit:50,rewriteMode:'ai',autoSearch:false}}};
const pages = new Map(), messages = [], savedExports = [], savedPaths = [];
let handler, startup, activeAi = 0, peakAi = 0;
const gates = new Map(), imageGates = new Map();
const noop = () => {};
const event = () => ({addListener:noop});
const storageArea = (area) => ({
  get:async(keys) => structuredClone(keys===null ? store[area] : Object.fromEntries((Array.isArray(keys)?keys:[keys]).map((key)=>[key,store[area][key]]))),
  set:async(patch) => {
    const changes={};
    for(const [key,value] of Object.entries(patch)) {changes[key]={oldValue:store[area][key],newValue:structuredClone(value)};store[area][key]=structuredClone(value);}
    await Promise.all([...pages.keys()].map((page)=>page.evaluate(({changes,area})=>window.storageListeners?.forEach((fn)=>fn(changes,area)),{changes,area}).catch(()=>{})));
  },
});
const chrome={
  storage:{local:storageArea('local'),sync:storageArea('sync')},
  runtime:{onMessage:{addListener:(fn)=>handler=fn},onInstalled:event(),onStartup:{addListener:(fn)=>startup=fn}},
  action:{onClicked:event()},contextMenus:{onClicked:event()},
  downloads:{onChanged:event(),download:async(data)=>{savedPaths.push(data.filename);if(data.url.startsWith('data:application/json'))savedExports.push(JSON.parse(Buffer.from(data.url.split(',')[1],'base64').toString()));return savedPaths.length;}},
};
const sandbox=vm.createContext({chrome,console,crypto:webcrypto,URL,URLSearchParams,TextEncoder,Uint8Array,ArrayBuffer,AbortController,setTimeout,clearTimeout,btoa,atob,importScripts:noop,
  fetch:async(url,options={})=>{
    if(String(url).includes('api.test')) {
      const body=JSON.parse(options.body);
      if(body.messages?.[0]?.content?.includes('Translate the supplied article title')) {
        return new Response(JSON.stringify({model:body.model,choices:[{message:{content:JSON.stringify({translation:'AI 中文标题'})},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}});
      }
      if(body.messages?.[0]?.content?.includes('title only after the summary has been completed')) {
        return new Response(JSON.stringify({model:body.model,choices:[{message:{content:JSON.stringify({title:'A calm guide to caring for cats at home'})},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}});
      }
      const tag=body.messages.at(-1).content.includes('Room A')?'A':'B';
      activeAi++;peakAi=Math.max(peakAi,activeAi);
      if(gates.has(tag))await gates.get(tag).promise;
      activeAi--;
      return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({title:'A calm guide to caring for cats at home',summary:'Keep cats comfortable and give them a quiet place to rest.',image_query_en:'cat sleeping at home room '+tag,language:'en'})},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}});
    }
    if(String(url).includes('article.test')) {
      const tag=String(url).includes('/101')?'A':'B';
      return new Response(`<article><h1>Cat care in Room ${tag}</h1><p>Cats need a warm quiet room, fresh water, gentle daily care and a clean place to rest.</p></article>`,{headers:{'content-type':'text/html; charset=utf-8'}});
    }
    if(String(url).includes('api.pexels.com')) {
      const query=new URL(String(url)).searchParams.get('query') || '';
      const tag=query.includes('room A')?'A':query.includes('room B')?'B':'';
      if(tag && imageGates.has(tag))await imageGates.get(tag).promise;
      return new Response(JSON.stringify({page:1,total_results:1,photos:[{id:501,width:900,height:1600,alt:'Cat resting at home',src:{original:'https://image.test/cat.jpg',medium:'https://image.test/cat.jpg'}}]}),{headers:{'content-type':'application/json'}});
    }
    return new Response('image bytes',{headers:{'content-type':'image/jpeg'}});
  },
});
for(const file of ['workflow.js','backend-preview.js','background-ai.js','background-stock.js','background-downloads.js','background-locks.js','background.js'])vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),sandbox);
const run=(text)=>vm.runInContext(text,sandbox);
const keys=async(id)=>(await run(`getTabContext(${id})`)).keys;
const gate=(tag)=>{let release;const promise=new Promise((resolve)=>release=resolve);gates.set(tag,{promise,release});};
const imageGate=(tag)=>{let release;const promise=new Promise((resolve)=>release=resolve);imageGates.set(tag,{promise,release});};
gate('A');gate('B');imageGate('A');imageGate('B');
try {
  const context=await browser.newContext({viewport:{width:1366,height:940}});
  await context.route('**/*',(route)=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><meta charset="utf-8"><h1>模拟锁屏后台</h1><main id="fixture"></main>'}));
  await context.exposeBinding('lsaTestRpc',async({page},data)=>{
    if(data.kind==='get')return chrome.storage[data.area].get(data.keys);
    if(data.kind==='set')return chrome.storage[data.area].set(data.patch);
    const tabId=pages.get(page);messages.push({tabId,...data.message});
    return new Promise((resolve)=>{if(!handler(data.message,{tab:{id:tabId}},resolve))resolve({ok:false,error:'Unexpected message'});});
  });
  const inject=async(page,id)=>{
    await page.evaluate(({id})=>{
      window.storageListeners=[];
      const area=(name)=>({get:(keys)=>window.lsaTestRpc({kind:'get',area:name,keys}),set:(patch)=>window.lsaTestRpc({kind:'set',area:name,patch})});
      window.chrome={storage:{local:area('local'),sync:area('sync'),onChanged:{addListener:(fn)=>window.storageListeners.push(fn)}},runtime:{onMessage:{addListener:()=>{}},sendMessage:(message)=>window.lsaTestRpc({kind:'message',message})}};
      window.Translator={
        availability:async()=> 'available',
        create:async()=>({translate:async(text)=>'离线中文：'+text,destroy:()=>{}}),
      };
      window.fixtureId=id;
    },{id});
    await page.addStyleTag({path:path.join(root,'assistant.css')});
    for(const file of ['workflow.js','backend-preview.js','content.js','assistant-engine.js','assistant-ui.js'])await page.addScriptTag({path:path.join(root,file)});
    await page.evaluate(()=>{
      window.realPageSnapshot = window.__lsaPageTools.scanPageSnapshot;
      window.__lsaPageTools.scanPageSnapshot=async()=>({ok:true,pageLabel:'当前页',sourcePage:location.href,items:[{id:String(window.fixtureId),originalTitle:'How to care for cats in Room '+(window.fixtureId===101?'A':'B'),originalSummary:'Give your cats a comfortable home',sourceUrl:'https://article.test/'+window.fixtureId,editUrl:'https://lockscreen-admin.mofeeds.com/#/nav/overseasDeliver?index=5&type=editEMPTY&id='+window.fixtureId}]});
    });
    await page.addScriptTag({path:path.join(root,'assistant.js')});
    await page.locator('.lsa-assistant').waitFor();
  };
  const create=async(id)=>{
    const page=await context.newPage();pages.set(page,id);
    await page.goto('https://lockscreen-admin.mofeeds.com/#/nav/overseasContent?index=5');
    await inject(page,id);return page;
  };
  const a=await create(101), b=await create(202);
  const ka=await keys(101),kb=await keys(202);
  assert.notEqual(ka.batchState,kb.batchState);
  await a.locator('.lsa-scan-batch').click();
  await b.locator('.lsa-scan-batch').click();
  await a.locator('.lsa-start-batch').click();
  await b.locator('.lsa-start-batch').click();
  await a.waitForFunction(()=>document.querySelector('.lsa-item-status')?.textContent==='AI 改写');
  await b.waitForFunction(()=>document.querySelector('.lsa-item-status')?.textContent==='AI 改写');
  for(let attempt=0;attempt<100&&peakAi<2;attempt++)await new Promise((resolve)=>setTimeout(resolve,20));
  assert.equal(peakAi,2,'两个标签页必须同时有AI请求在运行');
  await a.locator('.lsa-pause-batch').click();
  assert.equal(store.local[kb.batchState].status,'running');
  await b.evaluate(()=>window.__runtimeCard=document.querySelector('.lsa-batch-card'));
  gates.get('A').release();gates.get('B').release();
  await b.waitForFunction(()=>document.querySelector('.lsa-item-status')?.textContent==='搜索配图');
  assert.equal(await b.evaluate(()=>window.__runtimeCard===document.querySelector('.lsa-batch-card')),true,'步骤推进时必须保留卡片 DOM，不得整批重绘');
  imageGates.get('A').release();imageGates.get('B').release();
  await a.waitForFunction(()=>document.querySelector('.lsa-batch-status').textContent.includes('已暂停'));
  await b.waitForFunction(()=>document.querySelector('.lsa-batch-status').textContent.includes('处理完成'));
  assert.equal(store.local[ka.batchState].items[0].id,'101');
  assert.equal(store.local[kb.batchState].items[0].id,'202');
  assert.equal(store.local[kb.batchState].items[0].title,'A calm guide to caring for cats at home');
  assert.equal(store.local[kb.batchState].items[0].imageQuerySourceTitle,'How to care for cats in Room B','自动搜图应记录原标题来源');
  const beforeManualQueries=messages.filter((message)=>message.action==='GENERATE_IMAGE_QUERY').length;
  await b.getByRole('button',{name:'换图 / 翻页'}).click();
  for(let attempt=0;attempt<100&&messages.filter((message)=>message.action==='GENERATE_IMAGE_QUERY').length===beforeManualQueries;attempt++)await new Promise((resolve)=>setTimeout(resolve,20));
  const manualQueryMessage=messages.filter((message)=>message.action==='GENERATE_IMAGE_QUERY').at(-1);
  assert.equal(manualQueryMessage.title,'How to care for cats in Room B','手动换图必须重新读取该记录原标题');
  assert.equal('summary' in manualQueryMessage,false,'手动换图请求不应携带简介');
  await b.waitForFunction(()=>document.querySelector('.lsa-image-status')?.textContent.includes('第 1 页'));
  await b.locator('.lsa-stock-query').fill('quiet cat by window');
  const beforeDirectEnglish=messages.filter((message)=>message.action==='GENERATE_IMAGE_QUERY').length;
  const beforeDirectSearch=messages.filter((message)=>message.action==='SEARCH_PEXELS_BATCH').length;
  await b.locator('.lsa-search-images').click();
  for(let attempt=0;attempt<100&&messages.filter((message)=>message.action==='SEARCH_PEXELS_BATCH').length===beforeDirectSearch;attempt++)await new Promise((resolve)=>setTimeout(resolve,20));
  assert.equal(messages.filter((message)=>message.action==='GENERATE_IMAGE_QUERY').length,beforeDirectEnglish,'人工英文词不得调用 AI');
  const directSearch=messages.filter((message)=>message.action==='SEARCH_PEXELS_BATCH').at(-1);
  assert.equal(directSearch.query,'quiet cat by window','人工英文词必须原样交给安全搜索链');
  await b.waitForFunction(()=>document.querySelector('.lsa-image-status')?.textContent.includes('第 1 页'));
  const persistedQueryBefore=store.local[kb.batchState].items[0].imageQueryEn;
  await b.getByRole('button',{name:'选为第 1 条配图'}).first().click();
  await b.waitForFunction(()=>document.querySelector('.lsa-image-status')?.textContent.includes('已替换第 1 条'));
  assert.equal(store.local[kb.batchState].items[0].imageQueryEn,persistedQueryBefore,'人工英文词选图不得覆盖持久化搜图词');
  await b.locator('.lsa-stock-query').fill('кот у окна');
  const beforeRejectedSearch=messages.filter((message)=>message.action==='SEARCH_PEXELS_BATCH').length;
  await b.locator('.lsa-search-images').click();
  await b.waitForFunction(()=>document.querySelector('.lsa-image-status')?.textContent.includes('请输入英文'));
  assert.equal(messages.filter((message)=>message.action==='SEARCH_PEXELS_BATCH').length,beforeRejectedSearch,'非 ASCII 人工词不得发起素材请求');
  await b.locator('[data-tab="batch"]').click();
  const reviewCopy=structuredClone(store.local[kb.batchState]);
  reviewCopy.items[0].status='needs_review';reviewCopy.updatedAt=Date.now()+1000;
  await chrome.storage.local.set({[kb.batchState]:reviewCopy});
  await b.waitForFunction(()=>document.querySelector('.lsa-download-all')?.textContent.includes('（1）'));
  assert.equal(await b.locator('.lsa-download-all').isEnabled(),true,'文案需复核但图片已通过时，批量下载按钮必须可用');
  const beforeDownloads=messages.filter((message)=>message.action==='DOWNLOAD_FINAL_IMAGE').length;
  await b.locator('.lsa-download-all').click();
  await b.waitForFunction(()=>document.querySelector('.lsa-batch-status').textContent.includes('下载结束'));
  assert.equal(messages.filter((message)=>message.action==='DOWNLOAD_FINAL_IMAGE').length,beforeDownloads+1,'批量下载按钮必须发送图片下载请求');
  assert.ok((await b.locator('.lsa-batch-status').textContent()).includes('1 张加入下载'));
  const bSnapshot=structuredClone(store.local[kb.batchState]);
  await a.locator('.lsa-quick-settings summary').click();
  await a.locator('[data-setting="titleLimit"]').fill('5');
  await a.locator('[data-setting="titleLimit"]').dispatchEvent('change');
  assert.equal(store.local[ka.settings].titleLimit,5);
  assert.equal(store.local[kb.settings].titleLimit,12);
  await a.locator('.lsa-quick-settings summary').click();
  await a.locator('.lsa-transfer > summary').click();
  await a.locator('.lsa-new-batch').click();
  await a.waitForFunction(()=>document.querySelector('.lsa-transfer-status').textContent.includes('旧批次已导出'));
  assert.equal(store.local[ka.batchState],null);
  assert.deepEqual(store.local[kb.batchState],bSnapshot);
  await a.locator('.lsa-import-file').setInputFiles({name:'a.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(savedExports.find((batch)=>batch.items?.some((item)=>item.id==='101') && batch.version)))});
  await a.waitForFunction(()=>document.querySelector('.lsa-transfer-status').textContent.includes('已导入'));
  assert.equal(store.local[ka.batchState].items[0].status,'error','导入按当前标签页的5词限制重检');
  assert.deepEqual(store.local[kb.batchState],bSnapshot);
  await a.locator('.lsa-minimize').click();
  assert.equal(await b.locator('.lsa-assistant.is-minimized').count(),0);
  await b.reload();await inject(b,202);
  assert.equal(await b.locator('.lsa-batch-card').count(),1,'刷新恢复当前标签页');
  const c=await create(303);
  assert.equal(await c.locator('.lsa-batch-card').count(),0,'同一个URL的新标签页不继承其他批次');
  const kc=await keys(303);
  assert.equal(await c.locator('.lsa-transfer').evaluate((node)=>node.open),false,'当前文件夹默认折叠');
  assert.equal(await c.locator('.lsa-quick-settings').evaluate((node)=>node.open),false,'当前标签页设置默认折叠');
  assert.ok(await c.locator('[data-panel="batch"] > .lsa-section-card').first().evaluate((main)=>main.compareDocumentPosition(document.querySelector('.lsa-transfer'))&Node.DOCUMENT_POSITION_FOLLOWING),'列表页文件夹设置应位于处理功能下面');
  await c.locator('.lsa-transfer > summary').click();
  await c.evaluate(()=>{
    document.querySelector('#fixture').innerHTML='<div><label>语言：<select><option>俄语</option></select></label><label>国家：<select><option>白俄罗斯</option></select></label></div><section id="cards"></section>';
    for(let i=1;i<=45;i++) {
      const article=document.createElement('article');article.style.cssText='width:260px;height:100px';
      article.innerHTML=`<h3>Care for cats at home ${i}</h3><a href="https://article.test/${i}">查看链接</a><a href="https://lockscreen-admin.mofeeds.com/#/nav/overseasDeliver?index=5&type=editEMPTY&id=${i+1000}">编辑</a>`;
      document.querySelector('#cards').append(article);
    }
    window.__lsaPageTools.scanPageSnapshot=window.realPageSnapshot;
  });
  await c.locator('[data-setting="batchLimit"]').selectOption('40');
  await c.locator('.lsa-scan-batch').click();
  await c.waitForFunction(()=>document.querySelectorAll('.lsa-batch-card').length===40);
  assert.equal(store.local[kc.batchState].items.length,40,'实际 content.js 必须突破旧30条上限');
  assert.equal(store.local[kc.batchState].metadata.language,'俄语');
  assert.equal(store.local[kc.batchState].metadata.country,'白俄罗斯');
  assert.equal(store.local[kc.batchState].batchLimit,40);
  assert.match(await c.locator('.lsa-current-folder').textContent(),/^俄语_白俄罗斯_\d{8}-/);
  const cOriginal=structuredClone(store.local[kc.batchState]);
  await c.locator('.lsa-scan-batch').click();
  await c.waitForFunction(()=>document.querySelector('.lsa-batch-status').textContent.includes('相同页面保留'));
  assert.equal(store.local[kc.batchState].batchId,cOriginal.batchId,'重读相同页面不新建或追加');
  const mixed={version:4,batchId:'import-mixed-71',createdAt:1788508800000,batchLimit:40,items:Array.from({length:71},(_,i)=>({
    ...bSnapshot.items[0],id:'import-'+i,pageKey:i<30?'page1':i<60?'page2':'page3',
    pageLabel:'列表第 '+(Math.floor(i/30)+1)+' 页',pageLanguage:i<30?'英语':'俄语',pageCountry:i<30?'南非':'白俄罗斯'
  }))};
  const uploadMixed=async()=>{
    await c.locator('.lsa-import-file').setInputFiles({name:'mixed.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(mixed))});
    await c.waitForFunction(()=>document.querySelector('.lsa-transfer-status').textContent.includes('分为 3 个文件夹'));
  };
  await uploadMixed();
  assert.equal(store.local[kc.batchState].items.length,30,'71条导入不追加到原40条');
  assert.equal(await c.locator('.lsa-page-result').count(),1,'界面只显示一个文件夹的页面进度');
  const folderCount=()=>Object.keys(store.local).filter(key=>key.startsWith(kc.batchState+':folder:')).length;
  const countBefore=folderCount();
  await uploadMixed();
  assert.equal(store.local[kc.batchState].items.length,30,'重复导入不叠加');
  assert.equal(folderCount(),countBefore,'重复导入不无限创建归档');
  await c.locator('.lsa-restore summary').click();
  await c.locator('.lsa-list-saved').click();
  const oldFolderKey=Object.keys(store.local).find(key=>key.startsWith(kc.batchState+':folder:')&&store.local[key].batchId===cOriginal.batchId);
  assert.ok(oldFolderKey,'旧40条批次应保留');
  await c.locator('.lsa-saved-batches').selectOption(oldFolderKey);
  await c.locator('.lsa-restore-saved').click();
  await c.waitForFunction(()=>document.querySelector('.lsa-transfer-status').textContent.includes('已导入 40 条'));
  assert.equal(await c.locator('.lsa-batch-card').count(),40);
  assert.equal(store.local[kc.batchState].batchId,cOriginal.batchId,'可以切回旧文件夹');
  await c.locator('.lsa-save-batch-json').click();
  await c.waitForFunction(()=>document.querySelector('.lsa-batch-status').textContent.includes('已保存'));
  assert.ok(savedPaths.some(name=>/^锁屏批次\/原始内容\/俄语_白俄罗斯_.*\/俄语_白俄罗斯_40条_\d{8}-\d{4}_批次结果_[a-z0-9]+\.json$/.test(name)),'JSON 保存到语言国家时间目录，并使用直观文件名');
  await c.locator('[data-setting="batchLimit"]').selectOption('30');
  await c.waitForFunction(async(key)=>(await window.chrome.storage.local.get(key))[key]?.batchLimit===30,kc.batchState);
  assert.equal(store.local[kc.batchState].items.length,40,'切换30档不删除已有记录');
  assert.equal(store.local[kc.batchState].batchLimit,30);
  await c.evaluate(()=>{
    const filters=document.querySelectorAll('#fixture select');
    filters[0].selectedOptions[0].textContent='英语';filters[1].selectedOptions[0].textContent='南非';
  });
  await c.locator('.lsa-scan-batch').click();
  await c.waitForFunction(()=>document.querySelector('.lsa-batch-status').textContent.includes('已读取 30 / 30'));
  assert.equal(store.local[kc.batchState].items.length,30,'切换后台语言国家后读取建立新文件夹，不追加');
  assert.equal(await c.locator('.lsa-page-result').count(),1);
  assert.equal(store.local[kc.batchState].metadata.country,'南非');
  assert.deepEqual(store.local[kb.batchState],bSnapshot,'C的扫描导入切换不影响B');
  const d=await create(404),kd=await keys(404);
  const legacyBatch={version:4,countUnit:'words',format:'lockscreen-results',batchId:'legacy-query',createdAt:Date.now(),updatedAt:Date.now(),status:'ready',batchLimit:30,items:[{
    index:1,id:'404',originalTitle:'Legacy original mountain title',originalSummary:'A summary that must not affect image search',title:'Short mountain guide',summary:'A valid summary',
    articleText:'Mountain trails cross a quiet valley beneath high rocky peaks.',imageQueryEn:'old summary derived beach query',imageQuerySourceTitle:'',sourceUrl:'',editUrl:'https://lockscreen-admin.mofeeds.com/#/nav/overseasDeliver?index=5&type=editEMPTY&id=404',
    pageKey:'legacy',pageLabel:'旧批次',status:'pending',stages:{article:'done',ai:'done',image:'pending'},rewriteMode:'ai'
  }]};
  const beforeLegacyRewrite=messages.filter((message)=>message.tabId===404&&message.action==='AI_PROCESS_ITEM').length;
  await chrome.storage.local.set({[kd.batchState]:legacyBatch});
  await d.waitForFunction(()=>document.querySelectorAll('.lsa-batch-card').length===1);
  await d.locator('.lsa-start-batch').click();
  await d.waitForFunction(()=>document.querySelector('.lsa-batch-status').textContent.includes('处理完成'));
  const legacyRewrite=messages.filter((message)=>message.tabId===404&&message.action==='AI_PROCESS_ITEM').at(-1);
  const legacySearch=messages.filter((message)=>message.tabId===404&&message.action==='SEARCH_PEXELS_BATCH').at(-1);
  assert.equal(messages.filter((message)=>message.tabId===404&&message.action==='AI_PROCESS_ITEM').length,beforeLegacyRewrite+1,'旧文案缺少来源标记时必须按正文重新生成');
  assert.equal(legacyRewrite.item.originalTitle,'Legacy original mountain title');
  assert.equal(legacyRewrite.item.summarySource,'article_body');
  assert.ok(legacyRewrite.item.sourceText.includes('Mountain trails'));
  assert.notEqual(legacySearch.query,'old summary derived beach query','自动处理不得复用旧版非原标题查询');
  assert.equal(store.local[kd.batchState].items[0].imageQuerySourceTitle,'Legacy original mountain title');
  assert.equal(store.local[kd.batchState].items[0].summarySource,'article_body');
  assert.equal(store.local[kd.batchState].items[0].titleSource,'generated_summary');
  const e=await create(505),ke=await keys(505);
  const occupiedBatch={version:4,countUnit:'words',format:'lockscreen-results',batchId:'occupied-fallback',createdAt:Date.now(),updatedAt:Date.now(),status:'ready',batchLimit:30,metadata:{language:'英语',country:'南非',capturedAt:Date.now()},items:[
    {index:1,id:'505-a',originalTitle:'First cat room',originalSummary:'A comfortable room',title:'First cat room',summary:'A comfortable room',imageQueryEn:'cat room',imageQuerySourceTitle:'First cat room',image:{id:'pexels-501',source:'pexels',imageUrl:'https://image.test/cat.jpg',previewUrl:'https://image.test/cat.jpg',width:900,height:1600,safetyStatus:'passed'},pageKey:'occupied',pageLabel:'占用测试',status:'completed',stages:{article:'done',ai:'done',image:'done'},rewriteMode:'ai'},
    {index:2,id:'505-b',originalTitle:'How to care for cats in Room B',originalSummary:'Give cats a comfortable home',articleText:'Cats need a warm quiet room, fresh water and a clean place to rest.',sourceUrl:'',editUrl:'',pageKey:'occupied',pageLabel:'占用测试',status:'pending',stages:{article:'pending',ai:'pending',image:'pending'},rewriteMode:'ai'}
  ]};
  await chrome.storage.local.set({[ke.batchState]:occupiedBatch});
  await e.waitForFunction(()=>document.querySelectorAll('.lsa-batch-card').length===2);
  await e.locator('.lsa-start-batch').click();
  await e.waitForFunction(()=>document.querySelector('.lsa-batch-status').textContent.includes('处理完成'));
  assert.equal(store.local[ke.batchState].items[1].status,'needs_review','候选全部被批次占用时必须降为需复核');
  assert.ok(store.local[ke.batchState].items[1].reviewWarning.includes('候选全部重复/占用'),'占用兜底必须写入固定警告');
  await e.locator('.lsa-batch-card').nth(1).getByRole('button',{name:'换图 / 翻页'}).click();
  await e.waitForFunction(()=>document.querySelector('.lsa-image-status')?.textContent.includes('第 1 页'));
  assert.ok((await e.locator('.lsa-stock-card .lsa-item-error').first().textContent()).includes('第 1 条占用'),'手动搜图卡片应显示占用者');
  e.once('dialog',(dialog)=>dialog.dismiss());
  await e.getByRole('button',{name:'选为第 2 条配图'}).first().click();
  await e.waitForFunction(()=>document.querySelector('.lsa-image-status')?.textContent.includes('未替换'));
  const f=await create(606),kf=await keys(606);
  const bangladeshBatch={version:4,countUnit:'words',format:'lockscreen-results',batchId:'bangladesh-mode',createdAt:Date.now(),updatedAt:Date.now(),status:'ready',batchLimit:30,metadata:{language:'孟加拉语',country:'孟加拉',capturedAt:Date.now()},items:[{
    index:1,id:'606',originalTitle:'বাড়ির জন্য সহজ ধারণা',originalSummary:'সহজ সাজসজ্জার ধারণা',articleText:'ঘর সাজানোর জন্য আলো, গাছপালা এবং সহজ রঙ ব্যবহার করা যায়।',pageLanguage:'孟加拉语',pageCountry:'孟加拉',pageKey:'bn-page',pageLabel:'孟加拉测试',status:'pending',stages:{article:'pending',ai:'pending',image:'pending'},rewriteMode:'ai'
  }]};
  await chrome.storage.local.set({[kf.batchState]:bangladeshBatch});
  await f.waitForFunction(()=>document.querySelectorAll('.lsa-batch-card').length===1);
  assert.equal(await f.locator('.lsa-bangladesh-badge').textContent(),'建议开启','双条件匹配后应提示人工开启');
  await f.locator('.lsa-bangladesh-toggle').check();
  await f.locator('.lsa-bangladesh-warning').waitFor();
  assert.ok((await f.locator('.lsa-bangladesh-warning').textContent()).includes('必须逐条人工审核'));
  assert.equal(await f.locator('.lsa-bangladesh-card-warning').count(),1,'孟加拉记录卡片必须显示人工审核警告');
  assert.equal(store.local[kf.settings].bangladeshMode,true,'孟加拉模式开关必须按标签页保存');
  assert.notEqual(store.local[kb.settings]?.bangladeshMode,true,'孟加拉模式不得影响其他标签页');
  fs.mkdirSync(path.join(root,'tests','artifacts'),{recursive:true});
  await c.locator('.lsa-restore summary').click();
  await c.evaluate(()=>document.querySelector('.lsa-assistant-body').scrollTop=0);
  await c.screenshot({path:path.join(root,'tests','artifacts','folders-0.11.png')});
  await b.evaluate(()=>{
    document.querySelector('#fixture').innerHTML='<label>标题<input id="title" value="Original title"></label><label>简介<textarea id="summary">Original summary</textarea></label><input id="picture" type="file">';
    location.hash='#/nav/overseasDeliver?index=5&type=editEMPTY&id=202';
  });
  await chrome.storage.sync.set({settings:{...store.sync.settings,siteRules:{'lockscreen-admin.mofeeds.com':{titleSelector:'#title',summarySelector:'#summary'}}}});
  await b.locator('.lsa-title-zh').waitFor();
  assert.ok((await b.locator('.lsa-title-zh').textContent()).includes('离线中文：How to care for cats in Room B'),'编辑页应自动显示 Chrome 离线标题翻译');
  const beforeAiTranslation=messages.filter((message)=>message.action==='TRANSLATE_TEXT').length;
  await b.locator('.lsa-ai-translate-title').click();
  await b.waitForFunction(()=>document.querySelector('.lsa-title-zh')?.textContent.includes('AI 中文标题'));
  const translationMessage=messages.filter((message)=>message.action==='TRANSLATE_TEXT').at(-1);
  assert.equal(messages.filter((message)=>message.action==='TRANSLATE_TEXT').length,beforeAiTranslation+1,'AI 翻译必须仅在手动点击后调用');
  assert.equal(translationMessage.text,'How to care for cats in Room B');
  assert.equal('summary' in translationMessage,false,'标题翻译不得携带简介');
  assert.equal(store.local[kb.batchState].items[0].titleZh,'AI 中文标题','标题中文翻译应缓存到批次');
  await b.locator('.lsa-apply-record').click();
  assert.equal(await b.locator('#title').inputValue(),bSnapshot.items[0].title,'超过12字符但只有10词的标题应能填写');
  assert.equal(await b.locator('#picture').evaluate((input)=>input.files.length),0);
  assert.ok(await b.locator('[data-panel="record"] > .lsa-section-card').first().evaluate((main)=>main.compareDocumentPosition(document.querySelector('.lsa-transfer'))&Node.DOCUMENT_POSITION_FOLLOWING),'编辑页文件夹与设置应位于批次填入下面');
  assert.equal(await b.locator('.lsa-record-fold').evaluate((node)=>node.open),true,'有批次记录时列表默认展开');
  await b.screenshot({path:path.join(root,'tests','artifacts','edit-layout-0.12.png')});
  await b.locator('.lsa-record-fold > summary').click();
  assert.equal(await b.locator('.lsa-record-fold').evaluate((node)=>node.open),false,'批次记录应可折叠');
  await b.locator('[data-tab="manual"]').click();
  await b.locator('.lsa-draft-copy').fill('one two three four five six seven eight nine ten eleven twelve thirteen\nA valid summary');
  await b.locator('.lsa-apply-draft').click();
  assert.ok((await b.locator('.lsa-manual-status').textContent()).includes('超过限制'));
  assert.equal(await b.locator('#title').inputValue(),bSnapshot.items[0].title,'13词拒绝后不能覆盖旧值');
  await b.locator('.lsa-draft-copy').fill('How to care for cats\nA valid summary');
  assert.equal(await b.locator('.lsa-title-count').textContent(),'标题 5 / 12 词');
  assert.ok(!messages.some((message)=>['NEXT_LIST_PAGE','SCAN_OPEN_PAGES'].includes(message.action)));
  fs.mkdirSync(path.join(root,'tests','artifacts'),{recursive:true});
  await b.screenshot({path:path.join(root,'tests','artifacts','word-count-0.10.png')});
  const before=await run('getTabContext(202)');startup();const after=await run('getTabContext(202)');
  assert.notEqual(before.keys.batchState,after.keys.batchState,'浏览器重启后不误认复用的标签ID');
  assert.ok((await run('savedBatches()')).batches.some((batch)=>batch.key===before.keys.batchState),'旧批次保留可恢复');
  console.log(`${version} 浏览器测试通过：局部进度刷新、全局去重、自适应搜图、标题翻译、孟加拉模式与多标签并行`);
  await context.close();
} finally { await browser.close(); }
