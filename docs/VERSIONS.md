# 从首版开始的源码归档

迁移时间：2026-10-06（Asia/Shanghai）。目标为私有仓库 [kumokazeevent/lockscreen-editor-assistant](https://github.com/kumokazeevent/lockscreen-editor-assistant)。

本次将 39 份现存源码快照逐版导入 Git，每一版有独立提交和带说明的标签；所有文件按 Git blob 校验，与对应本地快照一致。提交时间是迁移时间，不是原来的开发或发布日期。主分支按原文件夹版本号排序，表示归档顺序，不证明当时存在连续的继承关系。

main 的扩展源码位于仓库根目录，当前版本为 0.14.3。安装时直接加载包含 manifest.json 的仓库根目录。各版本的改动、实现方式与目的发布在 Releases；通过 Tags 可以查看和下载源码，通过 GitHub Compare 可以对比两版。Release 说明的本地副本保存在 docs/release-notes.json。

## 版本索引

每版沿用的功能不重复列出；下表重点列出主要增量和替换。实现目的综合原说明与用户反馈，有些属于基于变更的推断，不能当成开发时留下的正式决策记录。

| 归档版本 | manifest 版本 | Release / 标签 | 文件数 | 本版主要功能／变化 | 实现目的或历史说明 |
| --- | --- | --- | --- | --- | --- |
| 0.1.0 | 0.1.0 | [v0.1.0](https://github.com/kumokazeevent/lockscreen-editor-assistant/releases/tag/v0.1.0) | 11 | 首版：字段读取与绑定、12/50 字符截断、本地关键词、外部搜图和页面换图预览。 | 先减少复制粘贴，验证单条审核工作流。 |
| 0.2.0 | 0.2.0 | [v0.2.0](https://github.com/kumokazeevent/lockscreen-editor-assistant/releases/tag/v0.2.0) | 10 | 常驻悬浮窗、本地语义精简、可选 AI、Openverse/Pexels 搜索。 | 持续操作更方便，并减少直接截断造成的语义破坏。 |
| 0.3.0 | 0.3.0 | [v0.3.0](https://github.com/kumokazeevent/lockscreen-editor-assistant/releases/tag/v0.3.0) | 10 | 保留原稿生成英文搜图词；绑定文件上传控件并写入素材文件。 | 改写结果不适合准确搜图；预览替换不足以完成真实上传。 |
| 0.4.0 | 0.4.0 | [v0.4.0](https://github.com/kumokazeevent/lockscreen-editor-assistant/releases/tag/v0.4.0) | 10 | 多语种识别和改写语言校验。 | 外语原稿应保持原语言，不统一改写成中文。 |
| 0.4.1 | 0.4.1 | [v0.4.1](https://github.com/kumokazeevent/lockscreen-editor-assistant/releases/tag/v0.4.1) | 10 | Pexels/Openverse 强制竖图筛选。 | 适配手机锁屏版式。 |
| 0.4.2 | 0.4.2 | [v0.4.2](https://github.com/kumokazeevent/lockscreen-editor-assistant/releases/tag/v0.4.2) | 10 | GLM 5.x 关闭思考，缩短提示词与输出。 | 减少短文案任务的等待时间。 |
| 0.4.3 | 0.4.3 | [v0.4.3](https://github.com/kumokazeevent/lockscreen-editor-assistant/releases/tag/v0.4.3) | 10 | 明确 45 秒超时并转本地精简。 | 处理不明确的 aborted 错误。 |
| 0.5.0 | 0.5.0 | [v0.5.0](https://github.com/kumokazeevent/lockscreen-editor-assistant/releases/tag/v0.5.0) | 10 | 增加 Pixabay 备用，所有图库实行竖图筛选。 | 扩大可用素材范围并保持方向一致。 |
| 0.5.1 | 0.5.1 | [v0.5.1](https://github.com/kumokazeevent/lockscreen-editor-assistant/releases/tag/v0.5.1) | 10 | 方法类标题提取具体核心，避免只保留数字/方法；保留有事实含量的吸引点。 | 避免空泛标题与图文不符。 |
| 0.5.2 | 0.6.1 | [snapshot-v0.5.2](https://github.com/kumokazeevent/lockscreen-editor-assistant/releases/tag/snapshot-v0.5.2) | 10 | 归档目录名为 0.5.2，实际 manifest/README 为 0.6.1；自动读稿、自动英文搜图、可缩放窗和素材下载。 | 编号与先后关系不确定；原样保留，以专门标签记录差异。 |
| 0.5.3 | 0.5.3 | [v0.5.3](https://github.com/kumokazeevent/lockscreen-editor-assistant/releases/tag/v0.5.3) | 10 | AI 标题精简强调原意、专有名词、吸引力及同语种；素材仅预览。 | 提高标题质量并保留人工图片操作。 |
| 0.6.0 | 0.6.0 | [v0.6.0](https://github.com/kumokazeevent/lockscreen-editor-assistant/releases/tag/v0.6.0) | 10 | 实验版：中外文逐词对齐，点中文词选择外语原词组标题；简介继续精简。 | 帮助人工选取外语标题词；用户后来明确取消此方案。 |
| 0.7.0 | 0.7.0 | [v0.7.0](https://github.com/kumokazeevent/lockscreen-editor-assistant/releases/tag/v0.7.0) | 12 | 实际后台列表/编辑页批处理、读文章、AI 改写、竖图搜索、分目录导出、填表与尝试上传。 | 把单条辅助扩展为最多 30 条的真实后台工作流。 |
| 0.7.1 | 0.7.1 | [v0.7.1](https://github.com/kumokazeevent/lockscreen-editor-assistant/releases/tag/v0.7.1) | 13 | OpenCode 端点/模型简称处理，致命错误停止批次，超时不连续重复。 | 降低 404 和连续等待的损耗。 |
| 0.7.2 | 0.7.2 | [v0.7.2](https://github.com/kumokazeevent/lockscreen-editor-assistant/releases/tag/v0.7.2) | 13 | 逐条读文/AI/搜图阶段与总进度。 | 让批次进展和故障位置可见。 |
| 0.7.3 | 0.7.3 | [v0.7.3](https://github.com/kumokazeevent/lockscreen-editor-assistant/releases/tag/v0.7.3) | 13 | 扫描标题排除未投递等徽标。 | 修复把状态识别为标题。 |
| 0.7.4 | 0.7.4 | [v0.7.4](https://github.com/kumokazeevent/lockscreen-editor-assistant/releases/tag/v0.7.4) | 13 | DeepSeek 官方端点及明确关闭当时的模型思考。 | 避免预算被思考占满而没有最终正文。 |
| 0.7.5 | 0.7.5 | [v0.7.5](https://github.com/kumokazeevent/lockscreen-editor-assistant/releases/tag/v0.7.5) | 13 | 取消默认模型/别名改写，原样发送模型 ID；列出接口配置并增强空响应诊断。 | 避免提供商模型名称被错误替换。 |
| 0.7.6 | 0.7.6 | [v0.7.6](https://github.com/kumokazeevent/lockscreen-editor-assistant/releases/tag/v0.7.6) | 13 | 严格字符复核，重试携带上次具体超限原因。 | 减少超长文案反复返回。 |
| 0.7.7 | 0.7.7 | [v0.7.7](https://github.com/kumokazeevent/lockscreen-editor-assistant/releases/tag/v0.7.7) | 13 | 中等思考、可选第二审核 AI、编号状态与编辑页导航。 | 改善文案约束遵守和失败条目定位。 |
| 0.7.8 | 0.7.8 | [v0.7.8](https://github.com/kumokazeevent/lockscreen-editor-assistant/releases/tag/v0.7.8) | 13 | 思考截断时扩大 4096→8192 输出预算。 | 解决只返回思考没有正文的 length 响应。 |
| 0.7.9 | 0.7.9 | [v0.7.9](https://github.com/kumokazeevent/lockscreen-editor-assistant/releases/tag/v0.7.9) | 13 | 审核 AI 无思考；主结果通过校验时可保留并标记审核跳过。 | 避免可选审核服务临时不可用阻断合格结果。 |
| 0.7.10 | 0.7.10 | [v0.7.10](https://github.com/kumokazeevent/lockscreen-editor-assistant/releases/tag/v0.7.10) | 13 | 路由挂载锁和旧悬浮窗清理。 | 解决切换列表/编辑页后残留窗口。 |
| 0.8.0 | 0.8.0 | [v0.8.0](https://github.com/kumokazeevent/lockscreen-editor-assistant/releases/tag/v0.8.0) | 13 | 编辑页只填文案，人工上传图片；成品图每 30 张分组。 | 匹配人工上传工作流，避免不稳定的自动上传。 |
| 0.9.0 | 0.9.0 | [v0.9.0](https://github.com/kumokazeevent/lockscreen-editor-assistant/releases/tag/v0.9.0) | 16 | 多页读取、JSON 导入导出、可调字符上限/思考/提示词、本地模式、搜图翻页与下载重复检查。 | 扩展批处理并支持恢复与规则调整。 |
| 0.10.0 | 0.10.0 | [v0.10.0](https://github.com/kumokazeevent/lockscreen-editor-assistant/releases/tag/v0.10.0) | 16 | 改为多标签页独立并行，取消后台自动翻页；由字符限制改为可调词数。 | 按用户明确的多标签工作方式与后台词数要求实现。 |
| 0.11.0 | 0.11.0 | [v0.11.0](https://github.com/kumokazeevent/lockscreen-editor-assistant/releases/tag/v0.11.0) | 16 | 导入不再堆积；语言_国家_时间目录；30/40 切换。 | 隔离批次并适配各国每日条目数。 |
| 0.11.1 | 0.11.1 | [v0.11.1](https://github.com/kumokazeevent/lockscreen-editor-assistant/releases/tag/v0.11.1) | 16 | AVIF/WebP/GIF 实际转换 JPEG，JPEG/PNG 不重复压缩。 | 处理后台不支持 AVIF 上传的问题。 |
| 0.12.0 | 0.12.0 | [v0.12.0](https://github.com/kumokazeevent/lockscreen-editor-assistant/releases/tag/v0.12.0) | 16 | 区块重排和折叠，最多 4 路下载并固定目标目录。 | 减少遮挡并提高下载速度，避免切换文件夹写错路径。 |
| 0.12.1 | 0.12.1 | [v0.12.1](https://github.com/kumokazeevent/lockscreen-editor-assistant/releases/tag/v0.12.1) | 16 | 自动通过图下载不再依赖整条文案状态，增加数量和下载反馈。 | 修复按钮无响应或被错误禁用。 |
| 0.12.2 | 0.12.2 | [v0.12.2](https://github.com/kumokazeevent/lockscreen-editor-assistant/releases/tag/v0.12.2) | 16 | 自动/换图搜索统一从原标题生成词，旧结果导入重建来源。 | 防止搜图词被其他文案带偏；人工搜索限制后来放宽。 |
| 0.13.0 | 0.13.0 | [v0.13.0](https://github.com/kumokazeevent/lockscreen-editor-assistant/releases/tag/v0.13.0) | 33 | 模块型后台、局部进度刷新、任务锁、重启隔离与回归验证。 | 减少界面跳动并改善复杂任务的可维护性。 |
| 0.13.1 | 0.13.1 | [v0.13.1](https://github.com/kumokazeevent/lockscreen-editor-assistant/releases/tag/v0.13.1) | 33 | 编辑页批次记录默认折叠并调整区块顺序。 | 优先显示常用填入操作。 |
| 0.13.2 | 0.13.2 | [v0.13.2](https://github.com/kumokazeevent/lockscreen-editor-assistant/releases/tag/v0.13.2) | 33 | 恢复自定义英文搜图/原标题切换，继续局部刷新和模块拆分。 | 满足原标题偶尔不适合搜索时的人工修正。 |
| 0.13.3 | 0.13.3 | [v0.13.3](https://github.com/kumokazeevent/lockscreen-editor-assistant/releases/tag/v0.13.3) | 33 | 正文作为文案来源，正文为空则失败，取消原题/原简介兜底。 | 减少原稿错配造成的内容错误，代价是抓取失败时无法处理。 |
| 0.14.0 | 0.14.0 | [v0.14.0](https://github.com/kumokazeevent/lockscreen-editor-assistant/releases/tag/v0.14.0) | 33 | 基于 0.13.0 采用正文→简介→标题链，缺正文仍失败。 | 使标题与新生成的简介一致；这是回到旧基座的分支方案。 |
| 0.14.1 | 0.14.1 | [v0.14.1](https://github.com/kumokazeevent/lockscreen-editor-assistant/releases/tag/v0.14.1) | 33 | 恢复正文→原简介→原标题兜底，先完成简介再独立请求标题，记录来源。 | 兼顾正文读取失败时的可用性与来源核对。 |
| 0.14.2 | 0.14.2 | [v0.14.2](https://github.com/kumokazeevent/lockscreen-editor-assistant/releases/tag/v0.14.2) | 33 | 列表已有 JSON 按 ID 直读正文、过滤版权页脚，正常单次主 AI 请求。 | 减少逐条落地页请求，提高读取速度并防止页脚冒充正文。 |
| 0.14.3 | 0.14.3 | [v0.14.3](https://github.com/kumokazeevent/lockscreen-editor-assistant/releases/tag/v0.14.3) | 55 | 批量读取右侧 originImageWebp 图并保存；ID/编号命名、30/40 分组、进度/重试、文件头识别。 | 取回列表缺图但编辑右侧有图的素材，并修复 WebP 被声明为 JPEG 的问题。 |

## 历史边界

- 0.12.3—0.12.7 没有独立源码快照，因此不生成这些版本的源码提交或标签。功能说明保留在 agent.md、README.md 和 docs/iterations 中；其合并后的实现可在 0.13.0 快照中看到。
- 名为 v0.5.2 的文件夹，其 manifest 和 README 实际声明 0.6.1。同一提交同时标为 snapshot-v0.5.2 和 v0.6.1，不修改原文件，不伪造 v0.5.2 的 manifest。它的实际发布时间和分支关系不确定。
- 0.6.0 是已取消的词语对齐实验版；保留供追溯，不表示推荐使用。
- 0.14.0/0.14.1 曾以 0.13.0 作为技术基座。归档顺序不能证明它们继承了前一标签的全部功能。
- 原工作区已有的 3 次真实 Git 提交另存于 codex/original-handoff 分支，保留原 SHA、作者和日期，其中包括 e37c5ef 的 0.14.3 提交。该分支采用原来的 lockscreen-editor-assistant 子目录布局；main 使用仓库根目录布局。
- 历史 ZIP 与重复的版本目录不放进 main 的工作区；同样的源代码可从对应标签下载。原工作区全部保留，没有删除或移动旧快照。

