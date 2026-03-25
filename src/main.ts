// @ts-ignore
import packageJSON from '../package.json';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';

// ─── 路径工具（延迟获取）───────────────────────────────────

function getPluginDir(): string {
    return path.resolve(__dirname, '..');
}

function getProjectRoot(): string {
    return path.resolve(Editor.Project.path);
}

function getRegistryPath(): string {
    return path.join(getPluginDir(), 'registry.json');
}

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

function writeJSON(filePath: string, data: any): void {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 4) + '\n', 'utf-8');
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

/** 将 exec 包装为 Promise（异步，不阻塞主进程） */
function execAsync(cmd: string, options: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv } = {}): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        exec(cmd, {
            encoding: 'utf-8',
            timeout: options.timeout || 120000,
            cwd: options.cwd,
            env: options.env,
        }, (error, stdout, stderr) => {
            if (error) {
                const combined = (stdout || '') + (stderr || '');
                reject(new Error(combined.trim() || error.message));
            } else {
                resolve({ stdout: stdout || '', stderr: stderr || '' });
            }
        });
    });
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
        const manifestKeys = Object.keys(manifest);
        // 如果 manifest 为空，回退显示 registry 中的全部扩展（均标记为未安装）
        const names = manifestKeys.length > 0 ? manifestKeys : Object.keys(registry);
        for (const name of names) {
            const ext = registry[name] || {};
            const requiredVersion = manifest[name] || null;
            const installedVersion = getInstalledVersion(name);

            let status: ExtensionInfo['status'];
            if (!installedVersion) {
                status = 'not_installed';
            } else if (requiredVersion && stripV(requiredVersion) === stripV(installedVersion)) {
                status = 'synced';
            } else if (requiredVersion) {
                status = 'need_update';
            } else {
                status = 'synced';
            }

            result.push({ name, description: ext.description || '', git: ext.git || '', requiredVersion, installedVersion, status });
        }
    }

    return result;
}

// ─── 异步命令执行 ────────────────────────────────────────

/** 调用 extensions_manager.js CLI（异步） */
async function runManagerCommand(args: string): Promise<{ success: boolean; output: string }> {
    try {
        const { stdout } = await execAsync(`node "${getManagerScript()}" ${args}`, {
            cwd: getProjectRoot(),
            timeout: 120000,
            env: { ...process.env, FORCE_COLOR: '0' },
        });
        return { success: true, output: stdout.trim() };
    } catch (err: any) {
        return { success: false, output: err.message || String(err) };
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

// ─── Tags 缓存（5 分钟有效期）────────────────────────────

const TAGS_CACHE_TTL = 5 * 60 * 1000;
const tagsCache = new Map<string, { tags: string[]; time: number }>();

/** 异步获取远程 tags */
async function fetchRemoteTags(gitUrl: string): Promise<string[]> {
    try {
        const { stdout } = await execAsync(`git ls-remote --tags --sort=-v:refname "${gitUrl}"`, {
            timeout: 30000,
        });
        const tags: string[] = [];
        for (const line of stdout.trim().split('\n')) {
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

/** 带缓存的 fetchTags */
async function fetchTagsCached(name: string, gitUrl: string): Promise<string[]> {
    const cached = tagsCache.get(name);
    if (cached && (Date.now() - cached.time) < TAGS_CACHE_TTL) {
        return cached.tags;
    }
    const tags = await fetchRemoteTags(gitUrl);
    tagsCache.set(name, { tags, time: Date.now() });
    return tags;
}

// ─── Fallback 安装逻辑（内置 git clone/checkout）─────────

function parseNameVersion(nameWithVersion: string): { name: string; version: string } {
    const atIdx = nameWithVersion.lastIndexOf('@');
    if (atIdx > 0) {
        return { name: nameWithVersion.slice(0, atIdx), version: nameWithVersion.slice(atIdx + 1) };
    }
    return { name: nameWithVersion, version: '' };
}

async function fallbackInstall(nameWithVersion: string): Promise<{ success: boolean; output: string }> {
    const { name, version } = parseNameVersion(nameWithVersion);
    const registry = readJSON(getRegistryPath()) || {};
    const ext = registry[name];
    if (!ext || !ext.git) {
        return { success: false, output: `扩展 "${name}" 未在 registry.json 中注册` };
    }

    const extDir = path.join(getExtensionsDir(), name);
    const gitUrl = ext.git;

    try {
        // 确保 extensions 目录存在
        if (!fs.existsSync(getExtensionsDir())) {
            fs.mkdirSync(getExtensionsDir(), { recursive: true });
        }

        if (fs.existsSync(extDir)) {
            // 已有目录：先尝试 unshallow fetch 获取全部 tags 及对应 commits
            try {
                await execAsync('git fetch --tags --unshallow', { cwd: extDir, timeout: 60000 });
            } catch {
                // 如果已经是完整仓库，--unshallow 会报错，退回普通 fetch
                await execAsync('git fetch --tags', { cwd: extDir, timeout: 60000 });
            }
            if (version) {
                try {
                    await execAsync(`git checkout "${version}"`, { cwd: extDir, timeout: 30000 });
                } catch {
                    // checkout 仍然失败，删除目录后重新 clone
                    fs.rmSync(extDir, { recursive: true, force: true });
                    await execAsync(
                        `git clone --branch "${version}" --depth 1 "${gitUrl}" "${extDir}"`,
                        { cwd: getProjectRoot(), timeout: 120000 },
                    );
                }
            }
        } else {
            // 新安装：clone
            if (version) {
                await execAsync(`git clone --branch "${version}" --depth 1 "${gitUrl}" "${extDir}"`, {
                    cwd: getProjectRoot(),
                    timeout: 120000,
                });
            } else {
                await execAsync(`git clone --depth 1 "${gitUrl}" "${extDir}"`, {
                    cwd: getProjectRoot(),
                    timeout: 120000,
                });
            }
        }

        // 更新 extensions.json
        const installedVer = version || getInstalledVersion(name) || 'latest';
        updateManifest(name, installedVer);

        return { success: true, output: `${name}@${installedVer} 安装成功 (git clone)` };
    } catch (err: any) {
        return { success: false, output: `安装失败: ${err.message || String(err)}` };
    }
}

async function fallbackUninstall(name: string): Promise<{ success: boolean; output: string }> {
    const extDir = path.join(getExtensionsDir(), name);

    try {
        if (fs.existsSync(extDir)) {
            fs.rmSync(extDir, { recursive: true, force: true });
        }
        // 从 extensions.json 中移除
        updateManifest(name, null);
        return { success: true, output: `${name} 已卸载` };
    } catch (err: any) {
        return { success: false, output: `卸载失败: ${err.message || String(err)}` };
    }
}

async function fallbackSync(): Promise<{ success: boolean; output: string }> {
    const manifest = readJSON(getManifestPath()) || {};
    const names = Object.keys(manifest);
    if (names.length === 0) {
        return { success: true, output: '无需同步（extensions.json 为空）' };
    }

    const results: string[] = [];
    let allOk = true;

    for (const name of names) {
        const version = manifest[name];
        const target = version ? `${name}@${version}` : name;
        const r = await fallbackInstall(target);
        results.push(`${r.success ? '✓' : '✗'} ${target}: ${r.output}`);
        if (!r.success) allOk = false;
    }

    return { success: allOk, output: results.join('\n') };
}

/** 更新 extensions.json 中的某个扩展版本。version 为 null 时删除条目 */
function updateManifest(name: string, version: string | null): void {
    const manifestPath = getManifestPath();
    const manifest = readJSON(manifestPath) || {};
    if (version === null) {
        delete manifest[name];
    } else {
        manifest[name] = version;
    }
    writeJSON(manifestPath, manifest);
}

/** 判断是否有外部 manager 脚本可用 */
function hasManagerScript(): boolean {
    return fs.existsSync(getManagerScript());
}

/** 检查扩展目录是否有 package.json 中声明了 dependencies 但 node_modules 不存在 */
function needsNpmInstall(extDir: string): boolean {
    const pkgPath = path.join(extDir, 'package.json');
    if (!fs.existsSync(pkgPath)) return false;
    try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        const deps = pkg.dependencies;
        if (!deps || Object.keys(deps).length === 0) return false;
        // 如果 node_modules 目录不存在，则需要 npm install
        if (!fs.existsSync(path.join(extDir, 'node_modules'))) return true;
        // 检查每个依赖的目录是否存在
        for (const depName of Object.keys(deps)) {
            if (!fs.existsSync(path.join(extDir, 'node_modules', depName))) return true;
        }
        return false;
    } catch {
        return false;
    }
}

/** 安装后在编辑器中注册并启用扩展 */
async function activateExtension(extDir: string, name: string): Promise<string> {
    const warnings: string[] = [];

    // 如果缺少 node_modules，先运行 npm install
    if (needsNpmInstall(extDir)) {
        console.log(`[extensions-manager] ${name} 缺少 node_modules，执行 npm install ...`);
        try {
            await execAsync('npm install --omit=dev', { cwd: extDir, timeout: 120000 });
            console.log(`[extensions-manager] ${name} npm install 完成`);
        } catch (err: any) {
            const msg = `npm install 失败: ${err.message || err}`;
            console.warn(`[extensions-manager] ${name} ${msg}`);
            warnings.push(msg);
        }
    }

    // 注册并启用扩展
    try {
        await Editor.Package.register(extDir);
        // 给编辑器一点时间处理注册
        await new Promise(resolve => setTimeout(resolve, 500));
        await Editor.Package.enable(extDir);
        console.log(`[extensions-manager] 已在编辑器中启用扩展 ${name}`);
    } catch (err: any) {
        console.warn(`[extensions-manager] 启用扩展出错: ${err.message || err}`);
        warnings.push('自动启用失败，请尝试重启编辑器以激活扩展。');
    }

    return warnings.length > 0 ? '\n⚠ ' + warnings.join('\n⚠ ') : '';
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
        let result: { success: boolean; output: string };
        if (hasManagerScript()) {
            result = await runManagerCommand(`install ${nameWithVersion}`);
            if (!result.success) {
                console.log('[extensions-manager] 外部脚本失败，降级到内置 git clone 安装');
                result = await fallbackInstall(nameWithVersion);
            }
        } else {
            console.log('[extensions-manager] manager 脚本不存在，使用内置 git clone 安装');
            result = await fallbackInstall(nameWithVersion);
        }
        console.log(`[extensions-manager] install result:`, result.output);

        // 安装成功后，通知编辑器注册并启用扩展，使其面板可用
        if (result.success) {
            const { name } = parseNameVersion(nameWithVersion);
            const extDir = path.join(getExtensionsDir(), name);
            const warn = await activateExtension(extDir, name);
            if (warn) result.output += warn;
        }

        return result;
    },

    async uninstallExtension(name: string): Promise<{ success: boolean; output: string }> {
        console.log(`[extensions-manager] uninstall ${name}`);

        // 卸载前先通知编辑器禁用并注销扩展
        const extDir = path.join(getExtensionsDir(), name);
        try {
            await Editor.Package.disable(extDir, {});
            await Editor.Package.unregister(extDir);
            console.log(`[extensions-manager] 已在编辑器中禁用扩展 ${name}`);
        } catch (err: any) {
            console.warn(`[extensions-manager] 禁用扩展时出错 (继续卸载): ${err.message || err}`);
        }

        let result: { success: boolean; output: string };
        if (hasManagerScript()) {
            result = await runManagerCommand(`uninstall ${name}`);
            if (!result.success) {
                console.log('[extensions-manager] 外部脚本失败，降级到内置卸载');
                result = await fallbackUninstall(name);
            }
        } else {
            console.log('[extensions-manager] manager 脚本不存在，使用内置卸载');
            result = await fallbackUninstall(name);
        }
        console.log(`[extensions-manager] uninstall result:`, result.output);
        return result;
    },

    async syncAll(force: boolean = false): Promise<{ success: boolean; output: string }> {
        const args = force ? 'sync --force' : 'sync';
        console.log(`[extensions-manager] ${args}`);
        let result: { success: boolean; output: string };
        if (hasManagerScript()) {
            result = await runManagerCommand(args);
            if (!result.success) {
                console.log('[extensions-manager] 外部脚本失败，降级到内置同步');
                result = await fallbackSync();
            }
        } else {
            console.log('[extensions-manager] manager 脚本不存在，使用内置同步');
            result = await fallbackSync();
        }
        console.log(`[extensions-manager] sync result:`, result.output);
        return result;
    },

    /** 获取指定扩展的所有可用版本 (git tags)，带缓存 */
    async fetchTags(name: string): Promise<string[]> {
        const registry = readJSON(getRegistryPath()) || {};
        const ext = registry[name];
        if (!ext || !ext.git) return [];
        console.log(`[extensions-manager] 获取 ${name} 的版本列表...`);
        const tags = await fetchTagsCached(name, ext.git);
        console.log(`[extensions-manager] ${name} 共 ${tags.length} 个版本`);
        return tags;
    },
};

export function load() {
    console.log('[extensions-manager] 扩展管理器已加载');
    setTimeout(() => {
        try {
            ensureManifest();
        } catch (err: any) {
            console.warn('[extensions-manager] 初始化出错:', err.message);
        }
    }, 2000);
}

export function unload() {
    console.log('[extensions-manager] 扩展管理器已卸载');
}
