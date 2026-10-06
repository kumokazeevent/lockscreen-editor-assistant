# ADR 0001：采用 Manifest V3 模块型后台

状态：已实施；历史决策日期待确认。

## 上下文

扩展需要监听工具栏、页面消息和下载状态，并在受支持的 Chrome/Edge 中运行。`manifest.json` 当前声明 MV3、`background-entry.js` 为模块型 service worker。

## 考虑的选项

1. Manifest V3 + 模块型 service worker：符合当前扩展结构，可通过 ES module 拆分后台逻辑；代价是后台会被挂起，不能依赖长驻内存状态。
2. Manifest V2 + 常驻背景页：长任务状态较直观；但不符合当前代码与浏览器扩展方向，迁移成本高。

## 决策

保持 MV3；`background-entry.js` 导入后台辅助模块与 `background.js`，任务状态主要持久化到 `chrome.storage`。

## 原因

原因待确认：由前代 Agent 决策。就现有实现而言，MV3 与目标浏览器的当前扩展模型一致；模块入口允许保留 `background.js` 的消息路由并拆出错误、素材、下载和锁逻辑。持久化状态及浏览器重启 epoch 机制也与 service worker 可能重启的行为相配。

## 影响

- 正面：模块边界清晰，可分别测试辅助逻辑，真实 MV3 加载已有烟雾测试。
- 负面：长任务不能仅靠内存；跨重启恢复和正在进行中的请求仍需要额外处理与验证。
