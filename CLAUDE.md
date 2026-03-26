# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

这是一个 **Cocos Creator 3.x 编辑器插件**（扩展管理器），由 Wenext Limited 开发。它在 Cocos Creator 编辑器内提供一个 GUI 面板，用于管理 Wenext 各项目中内部 Cocos 扩展的安装、版本追踪和同步。

## 构建命令

```bash
npm run build   # 编译 src/ → dist/（通过 tsc）
npm run watch   # 增量监听模式
```

项目未定义 lint、测试或格式化脚本。TypeScript 编译目标为 ES2017，模块格式为 CommonJS（`rootDir: ./src`，`outDir: ./dist`）。

## 架构说明

插件遵循 Cocos Creator 的**主进程 / 渲染进程**分离模式：

### 主进程 — `src/main.ts`
运行在 Node.js（编辑器后端）中，所有业务逻辑以 Cocos 消息处理器的形式暴露，并在 `package.json` 的 `contributions` 中注册：
- `list-all`、`list-project` — 交叉比对 `registry.json`、项目的 `extensions.json` 与实际 `extensions/` 目录，计算每个扩展的状态：`synced`、`need_update`、`not_installed`、`not_in_manifest`
- `install-extension`、`uninstall-extension`、`sync-all` — 优先调用项目中存在的外部脚本 `extensions_update/extensions_manager.js`，否则直接执行 `git clone` / `fs.rmSync`
- `fetch-tags` — 执行 `git ls-remote --tags`，结果缓存 5 分钟
- `refresh-registry` — 从 GitHub 重新拉取 `registry.json`，采用六级降级策略（GitHub API → raw.githubusercontent.com → GHProxy → jsDelivr → curl/PowerShell → SSH git clone）

`load()` 时：延迟 2 秒初始化并拉取远程注册表；若项目根目录缺少 `extensions.json`，则从 `extensions.template.json` 复制生成。

### 面板 UI — `src/panels/default/index.ts`
运行在渲染进程（类浏览器环境）中，使用 `Editor.Panel.define()` 声明可停靠面板。HTML/CSS 在构建时通过 `readFileSync` 从 `static/` 加载。所有与主进程的通信均通过 `Editor.Message.request(...)` 完成。DOM 更新采用基于 `DocumentFragment` 的无闪烁策略，刷新操作防抖 300ms。

### 数据文件
- `registry.json` — 扩展名 → `{ description, git }` 的映射，包含 6 个内部扩展（均为 `git@github.com:wenext-limited/` 下的私有 SSH 仓库）
- `extensions.template.json` — 首次加载时复制到项目根目录作为 `extensions.json` 的种子模板
- `static/template/default/index.html` + `static/style/default/index.css` — 面板 UI 资源
- `i18n/en.js` + `i18n/zh.js` — 编辑器国际化字符串

## Cocos Creator 插件规范

- `package.json` 同时作为 Cocos Creator 插件清单：`contributions.messages` 声明所有 IPC 消息处理器，`contributions.panels` 声明面板入口。
- 消息处理器必须作为默认导出对象的方法从 `main.ts` 中导出。
- 插件面向 Cocos Creator 3.x，编辑器 API 通过全局 `Editor` 对象访问（`Editor.Panel`、`Editor.Message`、`Editor.Package`、`Editor.Project`）。
- 测试改动需将插件安装到 Cocos Creator 项目的 `extensions/` 目录，并在编辑器中重新加载（扩展 > 扩展管理器 > 重新加载）。
