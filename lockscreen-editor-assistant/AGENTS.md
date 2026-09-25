# 锁屏编辑助手 · Agent 交接指南

## 项目概述

| 项目 | 实际情况 |
| --- | --- |
| 名称 | 锁屏编辑助手，当前 `manifest.json` 版本为 0.14.2 |
| 用途 | 辅助 `lockscreen-admin.mofeeds.com` 海外锁屏内容审核：从列表读取原稿及正文、生成同语种简介和由简介浓缩的标题、搜索竖屏素材、导出批次并在编辑页填写文案。图片上传及后台最终保存由人操作。 |
| 技术栈 | Chrome/Edge Manifest V3 扩展；原生 JavaScript、HTML、CSS；模块型 service worker；`chrome.storage`、`chrome.downloads`、内容脚本；Node.js 内置测试工具与 Playwright 浏览器测试。无 npm 构建流程或前端框架。 |
| 当前状态 | 0.14.2 源码可直接作为“已解压的扩展程序”加载。静态、逻辑、MV3 后台加载和模拟浏览器界面测试通过；真实后台和付费 API 的端到端验收待确认。 |
| 已知问题或限制 | 页面接口结构和后台 DOM 变化会影响正文捕获、卡片扫描和字段填写；内容缺失时可能退回原简介或原标题，必须核对 `summarySource`；图片元数据过滤不能保证没有正脸、裸露、版权或商标风险；真实 Pexels/Pixabay、各 AI 服务商及离线 Translator 语言包未逐项验证。 |

## 目录结构

本文件所在目录是扩展根目录；其父目录是当前 Git 仓库根目录，父目录还包含多份历史快照和其他文件，提交时不要误纳入。

```text
lockscreen-editor-assistant/
├─ AGENTS.md                 # 本交接指南
├─ README.md                 # 安装、使用及版本说明
├─ agent.md                  # 0.12.3—0.14.2 的既有迭代笔记
├─ manifest.json             # MV3 入口、权限与注入范围
├─ background-entry.js       # 模块型 service worker 入口
├─ background.js             # 消息路由、AI、素材搜索、下载和状态处理
├─ background-ai.js          # AI 错误分类与重试时间辅助函数
├─ background-stock.js       # 图片元数据安全初筛与查询词约束
├─ background-downloads.js   # 下载文件名与 MIME 辅助函数
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
   ├─ iterations/           # 基于现有证据重建的历史迭代记录
   ├─ decisions/            # 技术决策记录
   └─ HANDOFF.md             # 可直接转交下一位 Agent 的摘要
```

## 关键数据与边界

- `page-bridge.js` 在目标站点的 `MAIN` world、`document_start` 注入，观察页面已有 JSON 响应中的内容 ID、标题、简介和正文，再通过同源 `postMessage` 交给 `content.js`；它不应该修改站点响应。
- `assistant.js` 以标签页上下文隔离批次、运行状态与设置；通用设置在 `chrome.storage.sync`，密钥在 `chrome.storage.local`。导出 JSON 不应包含密钥。
- AI 模式以正文、原简介、原标题顺序选择简介来源，标题根据生成的简介浓缩；原标题用于语言判断及自动英文搜图词。词数默认标题 12、简介 50，可配置。无可用 AI 时的本地模式只是词语候选，需要人工复核。
- 搜图以 Pexels 为主、Pixabay 为备选；另外手动素材搜索可用 Openverse。所有图源均需竖图筛选；最终图片只下载，用户手动上传和保存。
- 不要把测试中的模拟接口结果表述为真实后台验收，也不要自动点击后台最终保存。

## 已集成的外部服务

| 服务 / 地址 | 用途 | 代码位置与说明 |
| --- | --- | --- |
| 锁屏后台 `https://lockscreen-admin.mofeeds.com/*` | 唯一注入站点；读取列表和编辑页、观察站点已有 JSON 并填写标题/简介。具体列表 API 路径未硬编码，待现场确认。 | `manifest.json`、`page-bridge.js`、`content.js`、`workflow.js` |
| 独立 AI Chat Completions 端点，默认 `https://api.deepseek.com/chat/completions` | 多语文案改写、搜图词、可选标题翻译；用户可填其他兼容端点和模型；可选第二审核 AI 使用独立端点。 | `options.js` 设置默认值；`background.js` 中的 `normalizeAiEndpoint`、`generateBatchItemWithAi`、`reviewAiCandidate`、`generateImageQueryWithAi`、`translateTextWithAi` |
| Pexels `https://api.pexels.com/v1/search` | 竖屏商用素材主图源；需要用户配置 API Key。 | `options.js`、`background.js` 的 `searchPexels` |
| Pixabay `https://pixabay.com/api/` | 竖屏图库备选；需要用户配置 API Key。 | `options.js`、`background.js` 的 `searchPixabay` |
| Openverse `https://api.openverse.org/v1/images/` | 手动图库搜索中的另一来源，使用商业许可与竖图参数；许可仍须人工核验。 | `background.js` 的 `searchStockImages` |
| Chrome 内置 Translator API（无固定网络地址） | 编辑页原标题的可选离线中文对照；不可用时不自动改用付费 AI。 | `assistant.js` 的 `createOfflineTitleTranslator`、`requestOfflineTitleTranslation` |

AI、Pexels 和 Pixabay 的端点可在设置页更改；上表地址是代码中的默认值或固定地址，不保证外部服务当前可用。用户密钥存于本机扩展存储，不要写进文档、测试或提交。

## 构建与测试

没有 `package.json`、`npm run build` 或编译产物。保存源码后，浏览器从包含 `manifest.json` 的本目录直接加载；更新已安装扩展时在 `chrome://extensions` 重新加载，并刷新已打开的后台页。

在本目录运行以下命令。要求 Node.js；后两项还要求本机可用的 Chrome 与 Playwright。浏览器测试脚本会从 `LSA_NODE_MODULES` 指定路径或其内置 Codex 运行时路径加载 Playwright，换机后可能需要配置。

```powershell
node tests/validate-extension.mjs
node tests/background-logic.mjs
node tests/workflow-logic.mjs
node tests/ai-recovery-logic.mjs
node tests/extension-load-smoke.mjs
node tests/tab-isolation-ui.mjs
```

`validate-extension.mjs` 同时对主要扩展脚本执行 `node --check`。这些测试使用模拟数据，不会调用用户的付费 AI，也不会在真实后台提交内容。若需重新打包，可对本目录内容建立 ZIP；本项目没有独立打包脚本。

## 历史变更摘要

当前仓库在建立本交接文档前没有 Git 提交。下列版本节点据 `README.md`、`agent.md`、现存版本快照及代码整理，日期无法从 Git 还原；详情见 `docs/iterations/README.md`。

| 阶段 | 主要实现 |
| --- | --- |
| 初期至 0.10.x | MV3 扩展、后台列表/编辑页适配、批处理悬浮窗、词数限制、多标签页独立运行与 JSON 导入导出。具体引入版本和日期待确认。 |
| 0.11.x—0.12.3 | 30/40 条批次、语言国家目录、图片下载格式修复、竖图搜索、下载去重与用量记忆。 |
| 0.12.4—0.12.7 | AI 错误分类重试、原标题自适应搜图、标题中文对照、孟加拉模式。 |
| 0.13.0 | service worker 与悬浮窗辅助逻辑模块化、局部进度刷新和稳定性测试。 |
| 0.14.1—0.14.2 | 正文→简介→标题来源链；0.14.2 从后台列表已有 JSON 直读正文并将主改写合并为单次请求。 |

## 待办事项

1. 在真实锁屏后台核验列表 JSON 的 `content`、内容 ID、标题和编辑页字段仍与适配器匹配；检查错位记录及正文缺失时的来源标记。
2. 用用户自己的 AI 端点和模型验证一次完整改写、可选审核、空响应/限流恢复及词数和语言一致性；测试中不要记录 API Key。
3. 用真实 Pexels/Pixabay 搜图并逐图审查许可、人物姿态、皮肤裸露、商标和 9:16/9:20 比例；自动元数据筛选不能替代人工审核。
4. 在目标 Chrome/Edge 版本与负责语种下检查离线 Translator 可用性，以及刷新扩展后旧批次导入、下载对账和编辑页填写。
5. 后续可为页面 JSON 桥、DOM 适配和真实下载流程增加隔离集成测试；若引入依赖，再明确安装、构建与锁文件策略。
