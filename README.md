# Extensions Manager

Cocos Creator 编辑器插件，用于可视化管理项目内各扩展的安装状态与版本同步。

## 功能

- 查看所有可用扩展及其安装状态
- 对比注册表版本与已安装版本，识别需要更新的扩展
- 一键安装或更新指定扩展
- 支持按项目清单（`extensions.json`）过滤扩展

## 数据来源

| 文件 | 位置 | 说明 |
|------|------|------|
| `registry.json` | 插件根目录 | 可用扩展的注册表，记录所有扩展的名称、版本、来源等信息 |
| `extensions.json` | 项目根目录 | 项目所需扩展的清单，包含版本要求 |
| `extensions/` | 项目根目录 | 已安装扩展的目录 |

## 扩展状态说明

| 状态 | 说明 |
|------|------|
| `synced` | 已安装且版本与清单一致 |
| `need_update` | 已安装但版本落后，需要更新 |
| `not_installed` | 清单中存在但尚未安装 |
| `not_in_manifest` | 已安装但不在项目清单中 |

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
