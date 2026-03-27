# Extensions Manager

Cocos Creator 编辑器插件，用于可视化管理项目内各扩展的安装状态与版本同步。

## 功能

- 查看所有可用扩展及其安装状态
- 对比远程版本与已安装版本，识别需要更新的扩展
- 一键安装或更新指定扩展，支持选择版本
- 搜索过滤扩展列表
- 主题切换（深色/浅色）与字体大小调整
- 操作日志记录与复制

## 界面说明

### 侧边栏导航

| Tab | 说明 |
|-----|------|
| **扩展** | 显示所有扩展（已安装、未安装、可更新） |
| **更新** | 仅显示本地可更新的扩展 |
| **库** | 显示远程注册表中尚未安装的扩展 |
| **设置** | 外观与偏好设置 |

### 顶部工具栏

- **搜索框**：按扩展名过滤列表
- **同步最新配置**：从远程拉取最新 `registry.json` 并刷新列表

### 扩展卡片操作

- **安装/更新**：选择目标版本后点击按钮执行
- **卸载**：移除本地扩展目录
- **右键菜单**：打开插件目录

### 设置页面

- **主题模式**：深色/浅色切换
- **基础字体大小**：调整 UI 文本缩放（11px - 16px）

### 日志面板

点击侧边栏底部「显示日志」展开操作日志区域，支持复制和清空。

## 数据来源

| 文件 | 位置 | 说明 |
|------|------|------|
| `registry.json` | 插件根目录 | 可用扩展的注册表，记录所有扩展的名称、Git 仓库等信息 |
| `extensions.json` | 项目根目录 | 项目所需扩展的清单 |
| `extensions/` | 项目根目录 | 已安装扩展的目录 |

## 扩展状态说明

| 状态 | 说明 |
|------|------|
| `synced` | 已安装且为最新版本 |
| `need_update` | 已安装但版本落后，可更新 |
| `not_installed` | 远程存在但尚未安装 |
| `not_in_manifest` | 已安装但不在远程注册表中 |

## 安装方式

1. 从 [Releases](https://github.com/wenext-limited/extensions-manager/releases) 下载最新的 `extensions-manager-vX.X.X.zip`
2. 解压 zip 包，将 `extensions-manager/` 目录放入 Cocos Creator 项目的 `extensions/` 目录下
3. 重启编辑器或刷新扩展
4. 在编辑器菜单中选择 **扩展 → wenext → 扩展管理器** 打开面板
5. 在面板中查看各扩展状态，按需安装或更新

## 开发

### 环境要求

- Cocos Creator 3.x
- Node.js

### 构建

```bash
npm install
npm run build
```

### 发布打包

```bash
npm run pack
```

会在 `dist/` 目录下生成 `extensions-manager-vX.X.X.zip`，可直接上传到 GitHub Releases 供用户下载。

### 目录结构

```
extensions-manager/
├── src/
│   ├── main.ts          # 插件主逻辑
│   └── panels/
│       └── default/     # 面板 UI
├── static/
│   ├── style/           # 样式文件
│   └── template/        # HTML 模板
├── i18n/                # 国际化文件
├── registry.json        # 扩展注册表
├── package.json
└── tsconfig.json
```

## License

Internal use only — Wenext Limited
