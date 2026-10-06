# 锁屏编辑助手 · Agent 交接指南

## 项目概述

| 项目 | 实际情况 |
| --- | --- |
| 名称 | 锁屏编辑助手，当前 `manifest.json` 版本为 0.14.3 |
| 用途 | 辅助 `lockscreen-admin.mofeeds.com` 海外锁屏内容审核：从列表读取原稿及正文、生成同语种简介和由简介浓缩的标题、搜索竖屏素材、导出批次并在编辑页填写文案。图片上传及后台最终保存由人操作。 |
| 技术栈 | Chrome/Edge Manifest V3 扩展；原生 JavaScript、HTML、CSS；模块型 service worker；`chrome.storage`、`chrome.downloads`、内容脚本；Node.js 内置测试工具与 Playwright 浏览器测试。无 npm 构建流程或前端框架。 |
| 当前状态 | 0.14.3 源码可直接作为“已解压的扩展程序”加载。静态、逻辑、MV3 后台加载及模拟界面测试通过；新增后台右侧图片的批量读取和本地保存，已用实站详情及一张真实图片验证字段与转码，整批真实下载和后续手动上传仍需用户验收。 |
| 已知问题或限制 | 页面接口结构和后台 DOM 变化会影响正文捕获、卡片扫描和字段填写；后台可能在同一 ID 内保存互不相符的标题、简介和正文，而当前插件不做语义冲突拦截；内容缺失时可能退回原简介或原标题，必须核对 `summarySource`；图片元数据过滤不能保证没有正脸、裸露、版权或商标风险；真实 Pexels/Pixabay、各 AI 服务商及离线 Translator 语言包未逐项验证。 |

## 目录结构

本文件所在目录同时是扩展和 GitHub main 分支的仓库根目录。GitHub 已归档从 0.1.0 开始的 39 份源码快照，见 docs/VERSIONS.md 和版本标签。codex/original-handoff 分支保留迁移前真实 Git 提交及旧子目录布局。原本地工作区仍位于本仓库外，包含旧快照与其他项目，不要误纳入本仓库。

```text
lockscreen-editor-assistant/
├─ AGENTS.md                 # 本交接指南
├─ README.md                 # 安装、使用及版本说明
├─ agent.md                  # 0.12.3—0.14.3 的迭代笔记
├─ manifest.json             # MV3 入口、权限与注入范围
├─ background-entry.js       # 模块型 service worker 入口
├─ background.js             # 消息路由、AI、素材搜索、下载和状态处理
├─ background-ai.js          # AI 错误分类与重试时间辅助函数
├─ background-stock.js       # 图片元数据安全初筛与查询词约束
├─ background-downloads.js   # 下载文件名与 MIME 辅助函数
├─ backend-preview.js        # 后台右侧图字段、详情 ID 校验与文件名
├─ background-locks.js       # 串行任务锁辅助函数
├─ page-bridge.js            # 页面主世界中观察列表 JSON 的 fetch/XHR 桥
├─ workflow.js               # 词数、批次命名、导入、局部改写等纯逻辑
├─ content.js                # 后台列表/编辑页适配器与字段填写
├─ content.css               # 内容脚本样式
├─ assistant.js              # 悬浮窗、批处理流程与编辑页交互
├─ assistant-engine.js       # 进度摘要辅助函数
├─ assistant-ui.js           # 批次卡片局部更新辅助函数
├─ assistant.css             # 悬浮窗样式
├─ options.html              # 设置页结构
├─ options.js                # 设置、密钥和去重库管理
├─ options.css               # 设置页样式
├─ tests/                    # Node 逻辑测试、Playwright 模拟浏览器测试
│  └─ artifacts/             # 既有界面截图
└─ docs/
   ├─ VERSIONS.md            # 39 份历史源码标签、功能变化及归档边界
   ├─ iterations/           # 基于现有证据重建的历史迭代记录
   ├─ decisions/            # 技术决策记录
   └─ HANDOFF.md             # 可直接转交下一位 Agent 的摘要
```

## 关键数据与边界

- `page-bridge.js` 在目标站点的 `MAIN` world、`document_start` 注入，观察页面已有 JSON 响应中的内容 ID、标题、简介和正文，再通过同源 `postMessage` 交给 `content.js`；它不应该修改站点响应。
- `assistant.js` 以标签页上下文隔离批次、运行状态与设置；通用设置在 `chrome.storage.sync`，密钥在 `chrome.storage.local`。导出 JSON 不应包含密钥。
- AI 模式以正文、原简介、原标题顺序选择简介来源，标题根据生成的简介浓缩；原标题用于语言判断及自动英文搜图词。词数默认标题 12、简介 50，可配置。无可用 AI 时的本地模式只是词语候选，需要人工复核。
- 搜图以 Pexels 为主、Pixabay 为备选；另外手动素材搜索可用 Openverse。所有图源均需竖图筛选；最终图片只下载，用户手动上传和保存。
- 后台右侧图下载独立于 AI 批次：内容脚本以当前登录态逐条 GET 详情，只读 `originImageWebp.url`；不替换成 `originImage` 或正文图。每条保留编号与 ID，可重复保存同素材以供分别上传，下载结果不混入图库去重／用量记录。
- 不要把测试中的模拟接口结果表述为真实后台验收，也不要自动点击后台最终保存。

## 海外内容管理页：只读实站勘察

以下是使用 Chrome DevTools MCP 在已登录页面观察到的**当前页面行为**，并对照网页前端脚本核查；不是服务端接口文档。调查期间没有发送保存、上传或投递请求。后台部署或权限变化后须重新验证。

| 环节 | 已观察到的实现 |
| --- | --- |
| 列表路由 | `#/nav/overseasContent?index=5`。页面呈现 Vue/Element 风格组件；卡片包含标题、原图、文章链接、投递状态及“编辑”等按钮。 |
| 列表查询 | `POST /api/OverseasLockScreen/search/list`。请求体含 `languageCode`、`countryCode`、`auditStatus`、`pageNumber`、`pageSize`、`id`、`isGenerate`、`isUsed` 等筛选字段；一次实测阿语／叙利亚／未投递请求分别为 `ar`、`SY`、`WAITING`，页大小为 30。这些是观察值，不代表所有筛选组合。 |
| 列表响应 | 外层含 `code`、`message`、`data`；`data` 内含 `pageIndex`、`pageSize`、`pageCount`、`totalCount` 和记录数组 `data`。记录中可读到 `id`、`title`、`summary`、HTML `content` 等字段。`page-bridge.js` 捕获页面已经收到的 JSON；并不直接调用列表接口。 |
| 编辑路由与详情 | 点击“编辑”进入 `#/nav/overseasDeliver?index=5&type=editEMPTY&id=...`；页面以 `GET /api/OverseasLockScreen/get?id=...` 读取详情。详情含 `id`、`title`、`summary`、`content`、`url`、`languageCode`、`countryCodeList`、`originImage`、`auditStatus`、`updateTime` 等字段。正文在富文本编辑器 iframe 中显示。 |
| 图片字段（2026-10-05 核查） | 海外编辑页上传框左侧渲染 `originImage.url`，右侧渲染 `originImageWebp.url`；列表“请添加图片”检查 `originImage`。实测详情中前者为 null、后者有 JPEG 后缀链接，因此列表缺图不代表右侧无图。右侧字段名和 URL 后缀均不能保证文件格式：一张样本响应头为 image/jpeg，文件头为 RIFF/WEBP，经正式转码函数生成真正 JPEG 且保持尺寸。 |
| 字段与字数 | 编辑页有标题、简介输入框和图片上传控件；页面明确提示标题最多 12 个词、简介最多 50 个词。其前端保存函数以空白分词计数，和插件的多语种计词器不完全相同；实际服务端边界仍需验证。 |
| 下拉选项 | 页面还请求 `getLanguageList`、`getCountryList`、`getCpList`、`getChannelList`、`getCategoryList` 等接口。 |

一次正常记录的编辑页标题、简介与按 ID 捕获的列表记录相同；正文去掉空白后也完全一致。另一次在阿语／叙利亚／未投递列表可见的 10 月 14 日记录中，当前页有 26 条该日期记录，26 条都能按 ID 匹配到正文且标题与各自卡片一致，但多条**同一 ID 内**的原标题与简介/正文主题明显不符。抽取其中一条详情接口后，标题、简介和正文都与列表缓存一致，说明该样本的错配已存在于后台记录；造成错配的更早环节待确认。不要把这类情况误判为插件把不同 ID 的正文配错，也不要让“插件处理完成”代替人工审核。

当前插件在正文存在时优先据正文生成简介与新标题，但自动图片关键词仍取自**原标题**；原题错位时可能得到“新文案讲正文、图片却讲错误原题”的结果。当前词数/语言校验不能识别语义冲突，自动初筛通过后仍可能标记完成。下一次迭代应先加入冲突提示、来源展示和人工复核拦截；同页重扫也应比较已保存的原稿与最新后台字段，避免复用旧正文或旧文案。

### 列表页一键批量写回的可行性边界

网页前端脚本显示：编辑页先调用上述详情接口装载完整记录；普通“保存”将完整记录对象提交到 `POST /api/OverseasLockScreen/saveOrUpdate`，成功后返回上一页。前端保存前检查日期、标题/简介词数、CP 来源、文章链接或正文、语言/国家、分类，并设置 `lastEditor`；普通“保存”不主动把审核状态改为 `PENDING`，而“重新投递”走另一种状态与图片检查。**没有实际发送写请求，服务端是否接受插件直接写回、是否允许不上传图片、完整对象会覆盖哪些字段均未验证。**

当前网页可见的批量接口主要是批量复制和批量改日期；未在本次前端脚本中发现标题/简介的专用批量更新接口。另有 Excel 导入接口，但格式及是否覆盖旧记录待确认，不可视为安全的批量编辑方案。理论上可在列表页提供一个按钮，按 ID 对每条先 `GET` 最新详情、只改 `title`/`summary`、再逐条 `POST saveOrUpdate`，但这是**用户一次点击、服务端多次单条更新**，并非单次批量 API。

未经用户针对写入试验的明确批准，不要执行上述 `POST`。若将来实现，必须先做可恢复的单条验证，再提供逐条差异预览与人工勾选、最新记录/`updateTime` 核对、原始详情备份、低并发及暂停重试、逐条保存状态和 `GET` 读回校验；默认排除原稿错配、未复核或缺 ID 的条目，不改变图片、审核状态与投递状态。现有 `assistant.js` 的 `completed` 只表示自动处理完成，不代表已人工审核或已在后台保存。直接新开编辑深链曾回到登录页；当前标签页 `sessionStorage` 有 `user` 键、请求也携带 Cookie，但完整鉴权机制未确认，不得复制会话值到插件或文档。

## 已集成的外部服务

| 服务 / 地址 | 用途 | 代码位置与说明 |
| --- | --- | --- |
| 锁屏后台 `https://lockscreen-admin.mofeeds.com/*` | 唯一注入站点；观察列表 JSON、填写标题/简介；0.14.3 硬编码只读详情 GET 以取得右侧预览图。保存路径仅从网页前端代码确认，尚未写入验证。 | `manifest.json`、`page-bridge.js`、`content.js`、`workflow.js`、`backend-preview.js` |
| 独立 AI Chat Completions 端点，默认 `https://api.deepseek.com/chat/completions` | 多语文案改写、搜图词、可选标题翻译；用户可填其他兼容端点和模型；可选第二审核 AI 使用独立端点。 | `options.js` 设置默认值；`background.js` 中的 `normalizeAiEndpoint`、`generateBatchItemWithAi`、`reviewAiCandidate`、`generateImageQueryWithAi`、`translateTextWithAi` |
| Pexels `https://api.pexels.com/v1/search` | 竖屏商用素材主图源；需要用户配置 API Key。 | `options.js`、`background.js` 的 `searchPexels` |
| Pixabay `https://pixabay.com/api/` | 竖屏图库备选；需要用户配置 API Key。 | `options.js`、`background.js` 的 `searchPixabay` |
| Openverse `https://api.openverse.org/v1/images/` | 手动图库搜索中的另一来源，使用商业许可与竖图参数；许可仍须人工核验。 | `background.js` 的 `searchStockImages` |
| Chrome 内置 Translator API（无固定网络地址） | 编辑页原标题的可选离线中文对照；不可用时不自动改用付费 AI。 | `assistant.js` 的 `createOfflineTitleTranslator`、`requestOfflineTitleTranslation` |

AI、Pexels 和 Pixabay 的端点可在设置页更改；上表地址是代码中的默认值或固定地址，不保证外部服务当前可用。用户密钥存于本机扩展存储，不要写进文档、测试或提交。

## 构建与测试

没有 `package.json`、`npm run build` 或编译产物。保存源码后，浏览器从包含 `manifest.json` 的本目录直接加载；更新已安装扩展时在 `chrome://extensions` 重新加载，并刷新已打开的后台页。

在本目录运行以下命令。要求 Node.js；后三项还要求本机可用的 Chrome 与 Playwright。浏览器测试脚本会从 `LSA_NODE_MODULES` 指定路径或其内置 Codex 运行时路径加载 Playwright，换机后可能需要配置。

```powershell
node tests/validate-extension.mjs
node tests/background-logic.mjs
node tests/workflow-logic.mjs
node tests/ai-recovery-logic.mjs
node tests/backend-preview-logic.mjs
node tests/extension-load-smoke.mjs
node tests/tab-isolation-ui.mjs
node tests/backend-preview-ui.mjs
```

`validate-extension.mjs` 同时对主要扩展脚本执行 `node --check`。这些测试使用模拟数据，不会调用用户的付费 AI，也不会在真实后台提交内容。若需重新打包，可对本目录内容建立 ZIP；本项目没有独立打包脚本。

## 历史变更摘要

迁移前的真实 Git 历史从交接整理阶段开始，已保存在 codex/original-handoff 分支。main 于 2026-10-06 按 39 份现存快照重建版本提交与标签；这些日期是迁移时间，不能还原早期开发日期。下列功能节点据原说明重建，详情见 docs/VERSIONS.md 和 docs/iterations/README.md。

| 阶段 | 主要实现 |
| --- | --- |
| 初期至 0.10.x | MV3 扩展、后台列表/编辑页适配、批处理悬浮窗、词数限制、多标签页独立运行与 JSON 导入导出。具体引入版本和日期待确认。 |
| 0.11.x—0.12.3 | 30/40 条批次、语言国家目录、图片下载格式修复、竖图搜索、下载去重与用量记忆。 |
| 0.12.4—0.12.7 | AI 错误分类重试、原标题自适应搜图、标题中文对照、孟加拉模式。 |
| 0.13.0 | service worker 与悬浮窗辅助逻辑模块化、局部进度刷新和稳定性测试。 |
| 0.14.1—0.14.2 | 正文→简介→标题来源链；0.14.2 从后台列表已有 JSON 直读正文并将主改写合并为单次请求。 |
| 0.14.3 | 按条目详情批量读取右侧预览图并保存本地；ID／编号命名、30/40 分组、进度停止与失败重试；文件头识别及伪 JPEG 的 WebP/AVIF 转码。 |

## 待办事项

1. 已在当前真实页面抽查列表与详情的 ID、标题、简介和正文匹配；继续做不同日期/语言/分页的回归，并对同一 ID 内标题、简介、正文语义冲突添加显式复核与停用自动选图的保护。
2. 用用户自己的 AI 端点和模型验证一次完整改写、可选审核、空响应/限流恢复及词数和语言一致性；测试中不要记录 API Key。
3. 用真实 Pexels/Pixabay 搜图并逐图审查许可、人物姿态、皮肤裸露、商标和 9:16/9:20 比例；自动元数据筛选不能替代人工审核。
4. 在目标 Chrome/Edge 版本与负责语种下检查离线 Translator 可用性，以及刷新扩展后旧批次导入、下载对账和编辑页填写。
5. 后续可为页面 JSON 桥、DOM 适配和真实下载流程增加隔离集成测试；若引入依赖，再明确安装、构建与锁文件策略。
6. 若要做列表页一键批量写回，先取得用户对一条可恢复测试记录的批准并验证 `saveOrUpdate` 的服务端行为，再设计预览、原始备份、并发限制、逐条读回与失败恢复；不得从 `completed` 状态直接推断可自动保存。
