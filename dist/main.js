"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.unload = exports.load = exports.methods = void 0;
// @ts-ignore
const package_json_1 = __importDefault(require("../package.json"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const child_process_1 = require("child_process");
// ─── 路径工具（延迟获取）───────────────────────────────────
function getPluginDir() {
    return path.resolve(__dirname, '..');
}
function getProjectRoot() {
    return path.resolve(Editor.Project.path);
}
function getRegistryPath() {
    return path.join(getPluginDir(), 'registry.json');
}
function getExtensionsDir() {
    return path.join(getProjectRoot(), 'extensions');
}
function getManagerScript() {
    return path.join(getProjectRoot(), 'extensions_update', 'extensions_manager.js');
}
// ─── 工具函数 ────────────────────────────────────────────
function readJSON(filePath) {
    if (!fs.existsSync(filePath))
        return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}
function writeJSON(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 4) + '\n', 'utf-8');
}
/**
 * 统一 package.json 的 version 字段：字符串原样（trim）；若为数字则视为 v+数字，便于与带 v 的 tag 对比、展示。
 */
function normalizePkgVersion(raw) {
    if (raw === undefined || raw === null)
        return null;
    if (typeof raw === 'number' && Number.isFinite(raw)) {
        return `v${raw}`;
    }
    const s = String(raw).trim();
    return s || null;
}
/** 插件名 = extensions 下文件夹名；仅统计含根目录 package.json 的目录 */
function getInstalledExtensionFolderNames() {
    const root = getExtensionsDir();
    if (!fs.existsSync(root))
        return [];
    const out = [];
    for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
        if (!ent.isDirectory())
            continue;
        const name = ent.name;
        if (name.startsWith('.') || name === 'node_modules')
            continue;
        const pkgPath = path.join(root, name, 'package.json');
        if (fs.existsSync(pkgPath))
            out.push(name);
    }
    out.sort((a, b) => a.localeCompare(b));
    return out;
}
function getInstalledVersion(name) {
    const pkgPath = path.join(getExtensionsDir(), name, 'package.json');
    if (!fs.existsSync(pkgPath))
        return null;
    try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        return normalizePkgVersion(pkg.version);
    }
    catch (_a) {
        return null;
    }
}
function stripV(version) {
    if (!version)
        return '';
    return version.startsWith('v') ? version.slice(1) : version;
}
/** 远程 registry 克隆子进程（可被 cancelFetchRegistry 终止） */
let registryGitCloneChild = null;
/** 合并并发拉取：load() 延迟任务与面板刷新共享同一次远程 registry 拉取 */
let registryFetchInFlight = null;
/** 首包协商 + 克隆主体 */
const REGISTRY_GIT_CLONE_TIMEOUT_MS = 120000;
/** sparse-checkout / checkout 等轻量步骤 */
const REGISTRY_GIT_LIGHT_STEP_TIMEOUT_MS = 60000;
function getRegistryGitEnv() {
    return Object.assign(Object.assign({}, process.env), { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=no' });
}
/** 单条 git 命令（spawn + 可 kill + 超时），供注册表拉取复用 */
function runGitCommand(gitArgs, options = {}) {
    var _a;
    const timeoutMs = (_a = options.timeoutMs) !== null && _a !== void 0 ? _a : REGISTRY_GIT_CLONE_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
        var _a;
        const child = (0, child_process_1.spawn)('git', gitArgs, {
            cwd: options.cwd,
            env: getRegistryGitEnv(),
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        registryGitCloneChild = child;
        let stderr = '';
        (_a = child.stderr) === null || _a === void 0 ? void 0 : _a.on('data', (chunk) => {
            stderr += String(chunk);
        });
        const killTimer = setTimeout(() => {
            try {
                child.kill('SIGTERM');
            }
            catch (_a) {
                /* ignore */
            }
            setTimeout(() => {
                try {
                    child.kill('SIGKILL');
                }
                catch (_a) {
                    /* ignore */
                }
            }, 4000);
        }, timeoutMs);
        const detach = () => {
            clearTimeout(killTimer);
            if (registryGitCloneChild === child) {
                registryGitCloneChild = null;
            }
        };
        child.on('error', (err) => {
            detach();
            reject(err);
        });
        child.on('close', (code, signal) => {
            detach();
            if (code === 0) {
                resolve();
            }
            else {
                const hint = signal ? ` (signal ${signal})` : '';
                reject(new Error((stderr.trim() || `git 退出码 ${code}`) + hint));
            }
        });
    });
}
/** 无 filter 的浅克隆整仓（Git 过旧或不支持部分克隆时回退） */
function gitCloneRegistryShallow(repoUrl, destDir) {
    return runGitCommand(['clone', '--depth', '1', '--no-tags', repoUrl, destDir]);
}
/**
 * 部分克隆 + sparse-checkout 仅检出仓库根目录的 registry.json（需 Git 支持 --filter=blob:none，GitHub SSH 可用）。
 * 相较整仓浅克隆，通常显著减少传输量与耗时。
 */
async function gitSparseFetchRegistryJsonOnly(repoUrl, destDir) {
    await runGitCommand(['clone', '--depth', '1', '--no-tags', '--filter=blob:none', '--no-checkout', repoUrl, destDir], { timeoutMs: REGISTRY_GIT_CLONE_TIMEOUT_MS });
    await runGitCommand(['sparse-checkout', 'init', '--no-cone'], {
        cwd: destDir,
        timeoutMs: REGISTRY_GIT_LIGHT_STEP_TIMEOUT_MS,
    });
    await runGitCommand(['sparse-checkout', 'set', '/registry.json'], {
        cwd: destDir,
        timeoutMs: REGISTRY_GIT_LIGHT_STEP_TIMEOUT_MS,
    });
    await runGitCommand(['checkout'], { cwd: destDir, timeoutMs: REGISTRY_GIT_LIGHT_STEP_TIMEOUT_MS });
}
/** 通过 SSH：优先部分克隆仅拉 registry.json，失败则降级为整仓浅克隆 */
async function fetchRegistryViaSSH() {
    const tmpDir = path.join(os.tmpdir(), `ext-reg-${Date.now()}`);
    const reg = readJSON(getRegistryPath()) || {};
    const selfEntry = reg[package_json_1.default.name];
    const repoSshUrl = (selfEntry === null || selfEntry === void 0 ? void 0 : selfEntry.git) && String(selfEntry.git).trim();
    if (!repoSshUrl) {
        throw new Error('本地 registry.json 中未配置本插件的 git 地址，无法拉取远程注册表');
    }
    try {
        try {
            await gitSparseFetchRegistryJsonOnly(repoSshUrl, tmpDir);
        }
        catch (sparseErr) {
            const msg = String((sparseErr === null || sparseErr === void 0 ? void 0 : sparseErr.message) || sparseErr || '');
            console.warn(`[extensions-manager] 部分克隆 registry 失败，降级整仓浅克隆: ${msg}`);
            try {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
            catch (_a) {
                /* ignore */
            }
            await gitCloneRegistryShallow(repoSshUrl, tmpDir);
        }
        const regPath = path.join(tmpDir, 'registry.json');
        if (!fs.existsSync(regPath))
            throw new Error('registry.json not found in cloned repo');
        return fs.readFileSync(regPath, 'utf-8');
    }
    finally {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
        catch (_b) {
            /* ignore */
        }
    }
}
async function fetchRemoteRegistryOnce() {
    let text = '';
    try {
        text = (await fetchRegistryViaSSH()).trim();
        console.log('[extensions-manager] 通过 SSH 拉取远程 registry.json 成功');
    }
    catch (err) {
        console.warn(`[extensions-manager] SSH 拉取远程 registry 失败: ${err.message || err}`);
        console.warn('[extensions-manager] 已保留本地 registry.json');
        return false;
    }
    try {
        const remote = JSON.parse(text);
        if (!remote || typeof remote !== 'object' || Object.keys(remote).length === 0) {
            console.warn('[extensions-manager] 远程 registry.json 为空或格式异常，跳过更新');
            return false;
        }
        writeJSON(getRegistryPath(), remote);
        console.log(`[extensions-manager] 已从远程更新 registry.json（${Object.keys(remote).length} 个扩展）`);
        return true;
    }
    catch (err) {
        console.warn(`[extensions-manager] 解析远程 registry.json 失败: ${err.message || err}`);
        return false;
    }
}
/** 从远程拉取最新 registry.json 并写入本地（仅 SSH）；并发调用合并为单次克隆 */
async function fetchRemoteRegistry() {
    if (registryFetchInFlight) {
        return registryFetchInFlight;
    }
    const task = fetchRemoteRegistryOnce();
    registryFetchInFlight = task;
    try {
        return await task;
    }
    finally {
        if (registryFetchInFlight === task) {
            registryFetchInFlight = null;
        }
    }
}
function cancelRegistryGitClone() {
    const ch = registryGitCloneChild;
    if (!ch)
        return false;
    try {
        ch.kill('SIGKILL');
    }
    catch (_a) {
        /* ignore */
    }
    registryGitCloneChild = null;
    return true;
}
/** 将 exec 包装为 Promise（异步，不阻塞主进程） */
function execAsync(cmd, options = {}) {
    return new Promise((resolve, reject) => {
        const childEnv = Object.assign(Object.assign(Object.assign({}, process.env), options.env), { 
            // 禁止 git/ssh 在非交互环境下弹出认证提示（会导致永远挂起）
            GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=no' });
        const child = (0, child_process_1.exec)(cmd, {
            encoding: 'utf-8',
            timeout: options.timeout || 120000,
            cwd: options.cwd,
            env: childEnv,
            windowsHide: true,
        }, (error, stdout, stderr) => {
            if (error) {
                const combined = (stdout || '') + (stderr || '');
                reject(new Error(combined.trim() || error.message));
            }
            else {
                resolve({ stdout: stdout || '', stderr: stderr || '' });
            }
        });
        // 关闭 stdin 防止子进程等待输入
        if (child.stdin) {
            child.stdin.end();
        }
    });
}
/**
 * 完整列表：注册表内全部扩展 + 本地有但未在注册表中的目录（not_in_manifest）。
 * 「库」视图用 hasLocalPackage === false 且 git 非空区分远程有而本地未装。
 */
function getExtensionList() {
    const registry = readJSON(getRegistryPath()) || {};
    const installedNames = getInstalledExtensionFolderNames();
    const installedSet = new Set(installedNames);
    const result = [];
    const seen = new Set();
    for (const name of Object.keys(registry)) {
        seen.add(name);
        const ext = registry[name];
        const installedVersion = getInstalledVersion(name);
        let status;
        if (!installedVersion) {
            status = 'not_installed';
        }
        else {
            status = 'synced';
        }
        result.push({
            name,
            description: ext.description || '',
            git: ext.git || '',
            requiredVersion: null,
            installedVersion,
            status,
            hasLocalPackage: installedSet.has(name),
        });
    }
    for (const name of installedNames) {
        if (seen.has(name))
            continue;
        const installedVersion = getInstalledVersion(name);
        let status;
        if (!installedVersion) {
            status = 'not_installed';
        }
        else {
            status = 'not_in_manifest';
        }
        result.push({
            name,
            description: '',
            git: '',
            requiredVersion: null,
            installedVersion,
            status,
            hasLocalPackage: true,
        });
    }
    return result;
}
/** 比较 semver（仅当二者都能解析为 x.y.z / vx.y.z 时严格比较，否则回退字符串） */
function semverCompare(a, b) {
    const ta = parseSemverTuple(a);
    const tb = parseSemverTuple(b);
    if (ta && tb) {
        if (ta[0] !== tb[0])
            return ta[0] - tb[0];
        if (ta[1] !== tb[1])
            return ta[1] - tb[1];
        return ta[2] - tb[2];
    }
    return stripV(a).localeCompare(stripV(b), undefined, { numeric: true, sensitivity: 'base' });
}
/** 在 sortRemoteTags 序中取首个可解析的 semver tag（即当前列表中的最新 semver） */
function pickLatestSemverTag(tags) {
    const sorted = sortRemoteTags(tags);
    for (const t of sorted) {
        if (parseSemverTuple(t))
            return t;
    }
    return null;
}
/**
 * 若远程最新 semver tag 高于已安装版本则返回该 tag。
 * 已安装版本无法解析为 semver 时不做判断（避免误判）。
 */
function remoteSemverNewerThanInstalled(installedVersion, tags) {
    if (!installedVersion || !parseSemverTuple(installedVersion))
        return null;
    const latest = pickLatestSemverTag(tags);
    if (!latest)
        return null;
    return semverCompare(latest, installedVersion) > 0 ? latest : null;
}
async function attachRemoteUpgradeHint(info) {
    var _a;
    if (!info.installedVersion || !info.git)
        return info;
    try {
        const tags = await fetchTagsCached(info.name, info.git);
        const remoteNewer = remoteSemverNewerThanInstalled(info.installedVersion, tags);
        if (!remoteNewer)
            return Object.assign(Object.assign({}, info), { remoteLatestVersion: null });
        let { status } = info;
        if (status === 'synced' || status === 'not_in_manifest') {
            status = 'need_update';
        }
        return Object.assign(Object.assign({}, info), { status, remoteLatestVersion: remoteNewer });
    }
    catch (_b) {
        return Object.assign(Object.assign({}, info), { remoteLatestVersion: (_a = info.remoteLatestVersion) !== null && _a !== void 0 ? _a : null });
    }
}
async function getExtensionListAsync() {
    const base = getExtensionList();
    return Promise.all(base.map((item) => attachRemoteUpgradeHint(item)));
}
// ─── 异步命令执行 ────────────────────────────────────────
/** 调用 extensions_manager.js CLI（异步） */
async function runManagerCommand(args) {
    try {
        const { stdout } = await execAsync(`node "${getManagerScript()}" ${args}`, {
            cwd: getProjectRoot(),
            timeout: 120000,
            env: Object.assign(Object.assign({}, process.env), { FORCE_COLOR: '0' }),
        });
        return { success: true, output: stdout.trim() };
    }
    catch (err) {
        return { success: false, output: err.message || String(err) };
    }
}
// ─── 远程版本引用（仅 ls-remote，无 clone）────────────────
const REMOTE_REFS_CACHE_TTL = 5 * 60 * 1000;
const tagsCache = new Map();
/** 解析 ls-remote 输出中的 refs/tags/*（自动去除 annotated tag 的 ^{}） */
function parseRemoteTagsFromLsRemote(stdout) {
    const tags = [];
    const seen = new Set();
    for (const rawLine of stdout.split('\n')) {
        const line = rawLine.trim();
        if (!line)
            continue;
        // 兼容 tab 或空格分隔：<sha>\t<ref> / <sha> <ref>
        const parts = line.split(/\s+/);
        const ref = parts[parts.length - 1] || '';
        if (!ref.startsWith('refs/tags/'))
            continue;
        let tag = ref.slice('refs/tags/'.length).trim();
        if (tag.endsWith('^{}'))
            tag = tag.slice(0, -3);
        if (!tag || seen.has(tag))
            continue;
        seen.add(tag);
        tags.push(tag);
    }
    return tags;
}
/** 获取远程 tag 列表（git ls-remote --tags），用于版本下拉 */
async function fetchRemoteTags(gitUrl) {
    const tries = [
        `git ls-remote --tags --refs "${gitUrl}"`,
        `git ls-remote "${gitUrl}" "refs/tags/*"`,
    ];
    for (const cmd of tries) {
        try {
            const { stdout } = await execAsync(cmd, { timeout: 90000 });
            const tags = parseRemoteTagsFromLsRemote(stdout);
            if (tags.length > 0)
                return tags;
        }
        catch (err) {
            console.warn(`[extensions-manager] 远程 tag 查询失败: ${cmd} -> ${(err === null || err === void 0 ? void 0 : err.message) || err}`);
        }
    }
    return [];
}
function parseSemverTuple(tag) {
    const m = tag.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
    if (!m)
        return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
}
function sortRemoteTags(tags) {
    return [...tags].sort((a, b) => {
        const sa = parseSemverTuple(a);
        const sb = parseSemverTuple(b);
        if (sa && sb) {
            if (sa[0] !== sb[0])
                return sb[0] - sa[0];
            if (sa[1] !== sb[1])
                return sb[1] - sa[1];
            if (sa[2] !== sb[2])
                return sb[2] - sa[2];
            return a.localeCompare(b);
        }
        if (sa && !sb)
            return -1;
        if (!sa && sb)
            return 1;
        return a.localeCompare(b);
    });
}
/** 带缓存的远程 tag 列表（所有扩展版本下拉的远程选项，含本插件） */
async function fetchTagsCached(name, gitUrl) {
    const cached = tagsCache.get(name);
    if (cached && Date.now() - cached.time < REMOTE_REFS_CACHE_TTL) {
        return cached.tags;
    }
    const tags = sortRemoteTags(await fetchRemoteTags(gitUrl));
    tagsCache.set(name, { tags, time: Date.now() });
    return tags;
}
// ─── 自升级逻辑 ──────────────────────────────────────────
/** 升级 extensions-manager 自身：将升级脚本写入临时目录并以独立进程执行 */
async function selfUpgrade(version) {
    const registry = readJSON(getRegistryPath()) || {};
    const ext = registry[package_json_1.default.name];
    if (!(ext === null || ext === void 0 ? void 0 : ext.git)) {
        return { success: false, output: 'registry.json 中未找到自身配置，无法自升级' };
    }
    const selfDir = getPluginDir();
    const gitUrl = ext.git;
    // 升级脚本：延迟 3 秒（等面板正常响应）后删除旧目录并 clone 新版本
    const scriptContent = `
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const selfDir = ${JSON.stringify(selfDir)};
const gitUrl = ${JSON.stringify(gitUrl)};
const version = ${JSON.stringify(version)};
setTimeout(() => {
    try {
        fs.rmSync(selfDir, { recursive: true, force: true });
        const cloneCmd = version
            ? \`git clone --branch "\${version}" --depth 1 "\${gitUrl}" "\${selfDir}"\`
            : \`git clone --depth 1 "\${gitUrl}" "\${selfDir}"\`;
        execSync(cloneCmd, {
            stdio: 'pipe',
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=no' },
        });
    } catch (e) {
        try {
            fs.writeFileSync(path.join(os.tmpdir(), 'ext-upgrade-error.txt'), String(e), 'utf-8');
        } catch {}
    }
}, 3000);
`;
    const tmpScript = path.join(os.tmpdir(), `ext-self-upgrade-${Date.now()}.js`);
    fs.writeFileSync(tmpScript, scriptContent, 'utf-8');
    // 查找系统 node 可执行文件
    let nodePath = 'node';
    try {
        const whichCmd = process.platform === 'win32' ? 'where node' : 'which node';
        const { stdout } = await execAsync(whichCmd, { timeout: 5000 });
        nodePath = stdout.trim().split('\n')[0].trim();
    }
    catch ( /* 使用默认 'node' */_a) { /* 使用默认 'node' */ }
    // 以 detached + unref 方式启动独立子进程，与编辑器进程解耦
    const child = (0, child_process_1.spawn)(nodePath, [tmpScript], {
        detached: true,
        stdio: 'ignore',
        env: Object.assign(Object.assign({}, process.env), { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=no' }),
    });
    child.unref();
    const verStr = version ? `@${version}` : '（最新版本）';
    return {
        success: true,
        output: `自升级任务已提交${verStr}，正在后台执行...\n升级完成后请手动重新加载扩展（扩展菜单 → 扩展管理器 → 重新加载）`,
    };
}
// ─── Fallback 安装逻辑（内置 git clone/checkout）─────────
function parseNameVersion(nameWithVersion) {
    const atIdx = nameWithVersion.lastIndexOf('@');
    if (atIdx > 0) {
        return { name: nameWithVersion.slice(0, atIdx), version: nameWithVersion.slice(atIdx + 1) };
    }
    return { name: nameWithVersion, version: '' };
}
/** 安全删除目录（Windows 上可能因文件锁需重试） */
async function safeRemoveDir(dirPath, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            fs.rmSync(dirPath, { recursive: true, force: true });
            return;
        }
        catch (err) {
            if (i === retries - 1)
                throw err;
            // 等待一小段时间再重试，给文件锁释放时间
            await new Promise(resolve => setTimeout(resolve, 500 * (i + 1)));
        }
    }
}
async function fallbackInstall(nameWithVersion) {
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
            // 更新前先通知编辑器禁用扩展，释放文件锁
            console.log(`[extensions-manager] ${name} 目录已存在，先禁用扩展再删除`);
            try {
                await Editor.Package.disable(extDir, {});
                await Editor.Package.unregister(extDir);
                console.log(`[extensions-manager] ${name} 已禁用`);
            }
            catch (e) {
                console.warn(`[extensions-manager] 禁用 ${name} 时出错 (继续): ${e.message || e}`);
            }
            // 等待文件锁释放
            await new Promise(resolve => setTimeout(resolve, 800));
            console.log(`[extensions-manager] 删除旧目录: ${extDir}`);
            await safeRemoveDir(extDir);
            console.log(`[extensions-manager] 旧目录已删除`);
        }
        // 新安装 / 更新：clone 指定版本
        const cloneCmd = version
            ? `git clone --branch "${version}" --depth 1 "${gitUrl}" "${extDir}"`
            : `git clone --depth 1 "${gitUrl}" "${extDir}"`;
        console.log(`[extensions-manager] 执行: ${cloneCmd}`);
        await execAsync(cloneCmd, {
            cwd: getProjectRoot(),
            timeout: 120000,
        });
        console.log(`[extensions-manager] git clone 完成`);
        const installedVer = version || getInstalledVersion(name) || 'latest';
        return { success: true, output: `${name}@${installedVer} 安装成功 (git clone)` };
    }
    catch (err) {
        return { success: false, output: `安装失败: ${err.message || String(err)}` };
    }
}
async function fallbackUninstall(name) {
    const extDir = path.join(getExtensionsDir(), name);
    try {
        if (fs.existsSync(extDir)) {
            fs.rmSync(extDir, { recursive: true, force: true });
        }
        return { success: true, output: `${name} 已卸载` };
    }
    catch (err) {
        return { success: false, output: `卸载失败: ${err.message || String(err)}` };
    }
}
/** 判断是否有外部 manager 脚本可用 */
function hasManagerScript() {
    return fs.existsSync(getManagerScript());
}
/** 检查扩展目录是否有 package.json 中声明了 dependencies 但 node_modules 不存在 */
function needsNpmInstall(extDir) {
    const pkgPath = path.join(extDir, 'package.json');
    if (!fs.existsSync(pkgPath))
        return false;
    try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        const deps = pkg.dependencies;
        if (!deps || Object.keys(deps).length === 0)
            return false;
        // 如果 node_modules 目录不存在，则需要 npm install
        if (!fs.existsSync(path.join(extDir, 'node_modules')))
            return true;
        // 检查每个依赖的目录是否存在
        for (const depName of Object.keys(deps)) {
            if (!fs.existsSync(path.join(extDir, 'node_modules', depName)))
                return true;
        }
        return false;
    }
    catch (_a) {
        return false;
    }
}
/** 安装后在编辑器中注册并启用扩展 */
async function activateExtension(extDir, name) {
    const warnings = [];
    // 如果缺少 node_modules，先运行 npm install
    if (needsNpmInstall(extDir)) {
        console.log(`[extensions-manager] ${name} 缺少 node_modules，执行 npm install ...`);
        try {
            await execAsync('npm install --omit=dev', { cwd: extDir, timeout: 120000 });
            console.log(`[extensions-manager] ${name} npm install 完成`);
        }
        catch (err) {
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
    }
    catch (err) {
        console.warn(`[extensions-manager] 启用扩展出错: ${err.message || err}`);
        warnings.push('自动启用失败，请尝试重启编辑器以激活扩展。');
    }
    return warnings.length > 0 ? '\n⚠ ' + warnings.join('\n⚠ ') : '';
}
// ─── 导出 ────────────────────────────────────────────────
exports.methods = {
    async openPanel() {
        Editor.Panel.open(package_json_1.default.name);
    },
    async listAll() {
        return getExtensionListAsync();
    },
    async listProject() {
        return getExtensionListAsync();
    },
    async installExtension(nameWithVersion) {
        console.log(`[extensions-manager] install ${nameWithVersion}`);
        const { name: installName, version: installVersion } = parseNameVersion(nameWithVersion);
        // 自升级：不能 disable 自身，改用独立子进程执行
        if (installName === package_json_1.default.name) {
            return await selfUpgrade(installVersion);
        }
        let result;
        if (hasManagerScript()) {
            result = await runManagerCommand(`install ${nameWithVersion}`);
            if (!result.success) {
                console.log('[extensions-manager] 外部脚本失败，降级到内置 git clone 安装');
                result = await fallbackInstall(nameWithVersion);
            }
        }
        else {
            result = await fallbackInstall(nameWithVersion);
        }
        console.log(`[extensions-manager] install result:`, result.output);
        // 安装成功后，通知编辑器注册并启用扩展，使其面板可用
        if (result.success) {
            const { name } = parseNameVersion(nameWithVersion);
            const extDir = path.join(getExtensionsDir(), name);
            const warn = await activateExtension(extDir, name);
            if (warn)
                result.output += warn;
        }
        return result;
    },
    async uninstallExtension(name) {
        console.log(`[extensions-manager] uninstall ${name}`);
        // 卸载前先通知编辑器禁用并注销扩展
        const extDir = path.join(getExtensionsDir(), name);
        try {
            await Editor.Package.disable(extDir, {});
            await Editor.Package.unregister(extDir);
            console.log(`[extensions-manager] 已在编辑器中禁用扩展 ${name}`);
        }
        catch (err) {
            console.warn(`[extensions-manager] 禁用扩展时出错 (继续卸载): ${err.message || err}`);
        }
        let result;
        if (hasManagerScript()) {
            result = await runManagerCommand(`uninstall ${name}`);
            if (!result.success) {
                console.log('[extensions-manager] 外部脚本失败，降级到内置卸载');
                result = await fallbackUninstall(name);
            }
        }
        else {
            result = await fallbackUninstall(name);
        }
        console.log(`[extensions-manager] uninstall result:`, result.output);
        return result;
    },
    /** 获取指定扩展的远程 tag（仅 ls-remote --tags，无 clone；所有扩展含本仓库一致） */
    async fetchTags(name) {
        const registry = readJSON(getRegistryPath()) || {};
        const ext = registry[name];
        if (!ext || !ext.git)
            return [];
        console.log(`[extensions-manager] 获取 ${name} 的远程 tags 列表...`);
        const tags = await fetchTagsCached(name, ext.git);
        console.log(`[extensions-manager] ${name} 共 ${tags.length} 个 tags`);
        return tags;
    },
    /** 手动刷新远程注册表 */
    async refreshRegistry() {
        const ok = await fetchRemoteRegistry();
        if (ok) {
            const registry = readJSON(getRegistryPath()) || {};
            return { success: true, output: `注册表已更新（${Object.keys(registry).length} 个扩展）` };
        }
        return { success: false, output: '拉取远程注册表失败，使用本地缓存' };
    },
    /** 终止进行中的 registry git 子进程（供面板「取消 / 超时」调用） */
    cancelFetchRegistry() {
        if (cancelRegistryGitClone()) {
            return { success: true, output: '已终止注册表拉取' };
        }
        return { success: false, output: '当前没有进行中的注册表拉取' };
    },
    /** 本插件版本：以 package.json 的 version 为准，并与远程 tag 比较是否有更新 */
    async querySelfInfo() {
        const selfName = package_json_1.default.name;
        const registry = readJSON(getRegistryPath()) || {};
        const ext = registry[selfName] || {};
        const installedVersion = normalizePkgVersion(package_json_1.default.version);
        const base = {
            name: selfName,
            description: ext.description || '',
            git: ext.git || '',
            requiredVersion: null,
            installedVersion,
            status: installedVersion ? 'synced' : 'not_installed',
            hasLocalPackage: true,
        };
        return attachRemoteUpgradeHint(base);
    },
    async openExtensionDir(name) {
        const extDir = path.join(getExtensionsDir(), name);
        if (!fs.existsSync(extDir)) {
            return { success: false, output: `扩展 "${name}" 尚未安装，目录不存在` };
        }
        try {
            if (process.platform === 'darwin') {
                (0, child_process_1.exec)(`open "${extDir}"`);
            }
            else if (process.platform === 'win32') {
                (0, child_process_1.exec)(`start "" "${extDir.replace(/\//g, '\\')}"`, { shell: true });
            }
            else {
                (0, child_process_1.exec)(`xdg-open "${extDir}"`);
            }
            return { success: true, output: `已打开: ${extDir}` };
        }
        catch (err) {
            return { success: false, output: `打开目录失败: ${err.message || err}` };
        }
    },
};
function load() {
    console.log('[extensions-manager] 扩展管理器已加载');
    setTimeout(async () => {
        // 异步拉取远程 registry.json，不阻塞启动
        try {
            await fetchRemoteRegistry();
        }
        catch (err) {
            console.warn('[extensions-manager] 拉取远程注册表失败:', err.message);
        }
    }, 2000);
}
exports.load = load;
function unload() {
    console.log('[extensions-manager] 扩展管理器已卸载');
}
exports.unload = unload;
/** 部分编辑器版本会从 default 合并 methods，与命名 exports 一并提供 */
exports.default = { methods: exports.methods, load, unload };
