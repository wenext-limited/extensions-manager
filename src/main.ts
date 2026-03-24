// @ts-ignore
import packageJSON from '../package.json';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

// ─── 路径工具（延迟获取）───────────────────────────────────

/** 插件自身所在目录 */
function getPluginDir(): string {
    return path.resolve(__dirname, '..');
}

function getProjectRoot(): string {
    return path.resolve(Editor.Project.path);
}

/** registry.json 位于插件根目录 */
function getRegistryPath(): string {
    return path.join(getPluginDir(), 'registry.json');
}

/** extensions.json 位于项目根目录 */
function getManifestPath(): string {
    return path.join(getProjectRoot(), 'extensions.json');
}

function getExtensionsDir(): string {
    return path.join(getProjectRoot(), 'extensions');
}

function getManagerScript(): string {
    return path.join(getProjectRoot(), 'extensions_update', 'extensions_manager.js');
}

// ─── 工具函数 ────────────────────────────────────────────

function readJSON(filePath: string): any {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function getInstalledVersion(name: string): string | null {
    const pkgPath = path.join(getExtensionsDir(), name, 'package.json');
    if (!fs.existsSync(pkgPath)) return null;
    try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        return pkg.version || null;
    } catch {
        return null;
    }
}

function stripV(version: string): string {
    if (!version) return '';
    return version.startsWith('v') ? version.slice(1) : version;
}

interface ExtensionInfo {
    name: string;
    description: string;
    git: string;
    requiredVersion: string | null;
    installedVersion: string | null;
    status: 'synced' | 'need_update' | 'not_installed' | 'not_in_manifest';
}

function getExtensionList(all: boolean): ExtensionInfo[] {
    const registry = readJSON(getRegistryPath()) || {};
    const manifest = readJSON(getManifestPath()) || {};
    const result: ExtensionInfo[] = [];

    if (all) {
        for (const name of Object.keys(registry)) {
            const ext = registry[name];
            const requiredVersion = manifest[name] || null;
            const installedVersion = getInstalledVersion(name);

            let status: ExtensionInfo['status'];
            if (requiredVersion && installedVersion) {
                status = stripV(requiredVersion) === stripV(installedVersion) ? 'synced' : 'need_update';
            } else if (requiredVersion && !installedVersion) {
                status = 'not_installed';
            } else if (!requiredVersion && installedVersion) {
                status = 'not_in_manifest';
            } else {
                status = 'not_installed';
            }

            result.push({ name, description: ext.description || '', git: ext.git || '', requiredVersion, installedVersion, status });
        }
    } else {
        for (const name of Object.keys(manifest)) {
            const ext = registry[name] || {};
            const requiredVersion = manifest[name];
            const installedVersion = getInstalledVersion(name);

            let status: ExtensionInfo['status'];
            if (!installedVersion) {
                status = 'not_installed';
            } else if (stripV(requiredVersion) === stripV(installedVersion)) {
                status = 'synced';
            } else {
                status = 'need_update';
            }

            result.push({ name, description: ext.description || '', git: ext.git || '', requiredVersion, installedVersion, status });
        }
    }

    return result;
}

/** 调用 extensions_manager.js CLI */
function runManagerCommand(args: string): { success: boolean; output: string } {
    try {
        const output = execSync(`node "${getManagerScript()}" ${args}`, {
            cwd: getProjectRoot(),
            encoding: 'utf-8',
            timeout: 120000,
            env: { ...process.env, FORCE_COLOR: '0' },
        });
        return { success: true, output: output.trim() };
    } catch (err: any) {
        const output = (err.stdout || '') + (err.stderr || '');
        return { success: false, output: output.trim() || err.message };
    }
}

// ─── git 自更新：拉取插件仓库最新代码 ────────────────────

function syncPluginSelf(): void {
    const pluginDir = getPluginDir();
    const gitDir = path.join(pluginDir, '.git');
    if (!fs.existsSync(gitDir)) {
        console.log('[extensions-manager] 插件目录不是 git 仓库，跳过自更新');
        return;
    }
    try {
        console.log('[extensions-manager] 正在同步插件仓库最新数据...');
        execSync('git pull --ff-only', {
            cwd: pluginDir,
            encoding: 'utf-8',
            timeout: 30000,
            stdio: 'pipe',
        });
        console.log('[extensions-manager] 插件仓库同步完成');
    } catch (err: any) {
        console.warn('[extensions-manager] 插件仓库同步失败（不影响使用）:', err.message);
    }
}

// ─── 确保项目有 extensions.json ──────────────────────────

function ensureManifest(): void {
    const manifestPath = getManifestPath();
    if (fs.existsSync(manifestPath)) return;

    const templatePath = path.join(getPluginDir(), 'extensions.template.json');
    if (fs.existsSync(templatePath)) {
        fs.copyFileSync(templatePath, manifestPath);
        console.log(`[extensions-manager] 已创建 extensions.json (从模板拷贝)`);
    } else {
        fs.writeFileSync(manifestPath, '{}\n', 'utf-8');
        console.log(`[extensions-manager] 已创建空 extensions.json`);
    }
}

// ─── 从远程仓库获取所有 tags ─────────────────────────────

function fetchRemoteTags(gitUrl: string): string[] {
    try {
        const output = execSync(`git ls-remote --tags --sort=-v:refname "${gitUrl}"`, {
            encoding: 'utf-8',
            timeout: 30000,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const tags: string[] = [];
        for (const line of output.trim().split('\n')) {
            if (!line || line.includes('^{}')) continue;
            const ref = line.split('\t')[1];
            if (ref) {
                tags.push(ref.replace('refs/tags/', ''));
            }
        }
        return tags;
    } catch {
        return [];
    }
}

// ─── 导出 ────────────────────────────────────────────────

export const methods: { [key: string]: (...args: any) => any } = {

    async openPanel() {
        Editor.Panel.open(packageJSON.name);
    },

    async listAll(): Promise<ExtensionInfo[]> {
        return getExtensionList(true);
    },

    async listProject(): Promise<ExtensionInfo[]> {
        return getExtensionList(false);
    },

    async installExtension(nameWithVersion: string): Promise<{ success: boolean; output: string }> {
        console.log(`[extensions-manager] install ${nameWithVersion}`);
        const result = runManagerCommand(`install ${nameWithVersion}`);
        console.log(`[extensions-manager] install result:`, result.output);
        return result;
    },

    async uninstallExtension(name: string): Promise<{ success: boolean; output: string }> {
        console.log(`[extensions-manager] uninstall ${name}`);
        const result = runManagerCommand(`uninstall ${name}`);
        console.log(`[extensions-manager] uninstall result:`, result.output);
        return result;
    },

    async syncAll(force: boolean = false): Promise<{ success: boolean; output: string }> {
        const args = force ? 'sync --force' : 'sync';
        console.log(`[extensions-manager] ${args}`);
        const result = runManagerCommand(args);
        console.log(`[extensions-manager] sync result:`, result.output);
        return result;
    },

    /** 获取指定扩展的所有可用版本 (git tags) */
    async fetchTags(name: string): Promise<string[]> {
        const registry = readJSON(getRegistryPath()) || {};
        const ext = registry[name];
        if (!ext || !ext.git) return [];
        console.log(`[extensions-manager] 获取 ${name} 的版本列表...`);
        const tags = fetchRemoteTags(ext.git);
        console.log(`[extensions-manager] ${name} 共 ${tags.length} 个版本`);
        return tags;
    },
};

export function load() {
    console.log('[extensions-manager] 扩展管理器已加载');
    // 自动同步插件仓库（异步，不阻塞编辑器启动）
    setTimeout(() => {
        try {
            syncPluginSelf();
            ensureManifest();
        } catch (err: any) {
            console.warn('[extensions-manager] 初始化出错:', err.message);
        }
    }, 2000);
}

export function unload() {
    console.log('[extensions-manager] 扩展管理器已卸载');
}
