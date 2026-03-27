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
const https = __importStar(require("https"));
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
function getManifestPath() {
    return path.join(getProjectRoot(), 'extensions.json');
}
function getExtensionsDir() {
    return path.join(getProjectRoot(), 'extensions');
}
function getManagerScript() {
    return path.join(getProjectRoot(), 'extensions_update', 'extensions_manager.js');
}
// ─── 远程注册表 URL ──────────────────────────────────────
const REGISTRY_REMOTE_URL = 'https://raw.githubusercontent.com/wenext-limited/extensions-manager/main/registry.json';
const REGISTRY_API_URL = 'https://api.github.com/repos/wenext-limited/extensions-manager/contents/registry.json?ref=main';
// ─── 工具函数 ────────────────────────────────────────────
function readJSON(filePath) {
    if (!fs.existsSync(filePath))
        return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}
function writeJSON(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 4) + '\n', 'utf-8');
}
function getInstalledVersion(name) {
    const pkgPath = path.join(getExtensionsDir(), name, 'package.json');
    if (!fs.existsSync(pkgPath))
        return null;
    try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        return pkg.version || null;
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
/** 通过 HTTPS GET 获取远程文本内容（支持自定义请求头） */
function httpsGet(url, timeout = 15000, extraHeaders) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const options = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            timeout,
            headers: Object.assign({ 'User-Agent': 'extensions-manager' }, extraHeaders),
        };
        const req = https.get(options, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
                // 必须消费原始响应体，否则连接会挂起
                res.resume();
                const location = res.headers.location;
                if (location) {
                    httpsGet(location, timeout, extraHeaders).then(resolve, reject);
                    return;
                }
                reject(new Error(`Redirect without location header`));
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            let data = '';
            res.setEncoding('utf-8');
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve(data));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}
/** Fallback: 通过 curl / PowerShell 下载文本（兼容各种环境） */
async function httpsGetViaExec(url, authToken) {
    // 验证 token 格式，防止命令注入
    if (authToken && !/^[a-zA-Z0-9_\-]+$/.test(authToken)) {
        throw new Error('Invalid token format');
    }
    const curlAuth = authToken ? `-H "Authorization: token ${authToken}"` : '';
    // 优先尝试 curl（Git for Windows 自带）
    try {
        const { stdout } = await execAsync(`curl -fsSL --max-time 15 ${curlAuth} "${url}"`, { timeout: 20000 });
        if (stdout.trim())
            return stdout.trim();
    }
    catch ( /* fall through */_a) { /* fall through */ }
    // Fallback: PowerShell
    const psAuth = authToken
        ? `$headers = @{ Authorization = "token ${authToken}"; 'User-Agent' = 'extensions-manager' }; `
        : `$headers = @{ 'User-Agent' = 'extensions-manager' }; `;
    const { stdout } = await execAsync(`powershell -NoProfile -Command "${psAuth}(Invoke-WebRequest -Uri '${url}' -UseBasicParsing -Headers $headers).Content"`, { timeout: 20000 });
    return stdout.trim();
}
/** 通过 SSH git clone（浅克隆）读取 registry.json，适用于已配置 SSH 密钥的环境 */
async function fetchRegistryViaSSH() {
    const tmpDir = path.join(os.tmpdir(), `ext-reg-${Date.now()}`);
    const repoSshUrl = 'git@github.com:wenext-limited/extensions-manager.git';
    try {
        await execAsync(`git clone --depth 1 --no-tags "${repoSshUrl}" "${tmpDir}"`, { timeout: 60000 });
        const regPath = path.join(tmpDir, 'registry.json');
        if (!fs.existsSync(regPath))
            throw new Error('registry.json not found in cloned repo');
        return fs.readFileSync(regPath, 'utf-8');
    }
    finally {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
        catch ( /* ignore */_a) { /* ignore */ }
    }
}
/** 从 GitHub 拉取最新 registry.json 并写入本地（多种方式依次尝试） */
async function fetchRemoteRegistry() {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
    const authHeaders = token ? { Authorization: `token ${token}` } : {};
    // 添加时间戳防止 CDN 或本地网络缓存
    const ts = Date.now();
    const apiUrl = `${REGISTRY_API_URL}&t=${ts}`;
    const rawUrl = `${REGISTRY_REMOTE_URL}?t=${ts}`;
    // 构建多级尝试列表
    const attempts = [
        {
            name: 'GitHub API',
            fn: () => httpsGet(apiUrl, 15000, Object.assign(Object.assign({}, authHeaders), { Accept: 'application/vnd.github.v3.raw' })),
        },
        {
            name: 'HTTPS raw.githubusercontent.com',
            fn: () => httpsGet(rawUrl, 15000, Object.assign({}, authHeaders)),
        },
        {
            name: 'GHProxy (China)',
            fn: () => httpsGet(`https://ghproxy.net/${rawUrl}`, 15000),
        },
        {
            name: 'jsDelivr CDN',
            fn: async () => {
                try {
                    // 主动清理 CDN 缓存以确保拉取到最新
                    await httpsGet('https://purge.jsdelivr.net/gh/wenext-limited/extensions-manager@main/registry.json', 5000);
                }
                catch ( /* ignore */_a) { /* ignore */ }
                return httpsGet(`https://cdn.jsdelivr.net/gh/wenext-limited/extensions-manager@main/registry.json?t=${ts}`, 10000);
            },
        },
        {
            name: 'curl / PowerShell',
            fn: () => httpsGetViaExec(rawUrl, token || undefined),
        },
        {
            name: 'SSH git clone',
            fn: () => fetchRegistryViaSSH(),
        },
    ];
    let text = '';
    for (const attempt of attempts) {
        try {
            const result = await attempt.fn();
            if (result && result.trim()) {
                text = result.trim();
                console.log(`[extensions-manager] 通过 ${attempt.name} 拉取 registry 成功`);
                break;
            }
        }
        catch (err) {
            console.warn(`[extensions-manager] ${attempt.name} 拉取失败: ${err.message || err}`);
        }
    }
    if (!text) {
        console.warn('[extensions-manager] 所有远程拉取方式均失败，使用本地 registry.json');
        if (token) {
            console.warn('[extensions-manager] 提示: 已检测到 GITHUB_TOKEN，请确认 token 是否有效');
        }
        else {
            console.warn('[extensions-manager] 提示: 如需访问私有仓库，请设置环境变量 GITHUB_TOKEN');
        }
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
function getExtensionList(all) {
    // 每次读取列表前先从模板同步 manifest
    syncManifestFromTemplate();
    const registry = readJSON(getRegistryPath()) || {};
    const manifest = readJSON(getManifestPath()) || {};
    const result = [];
    if (all) {
        for (const name of Object.keys(registry)) {
            const ext = registry[name];
            const requiredVersion = manifest[name] || null;
            const installedVersion = getInstalledVersion(name);
            let status;
            if (requiredVersion && installedVersion) {
                status = stripV(requiredVersion) === stripV(installedVersion) ? 'synced' : 'need_update';
            }
            else if (requiredVersion && !installedVersion) {
                status = 'not_installed';
            }
            else if (!requiredVersion && installedVersion) {
                status = 'not_in_manifest';
            }
            else {
                status = 'not_installed';
            }
            result.push({ name, description: ext.description || '', git: ext.git || '', requiredVersion, installedVersion, status });
        }
    }
    else {
        const manifestKeys = Object.keys(manifest);
        for (const name of manifestKeys) {
            const ext = registry[name] || {};
            const requiredVersion = manifest[name] || null;
            const installedVersion = getInstalledVersion(name);
            let status;
            if (!installedVersion) {
                status = 'not_installed';
            }
            else if (requiredVersion && stripV(requiredVersion) === stripV(installedVersion)) {
                status = 'synced';
            }
            else if (requiredVersion) {
                status = 'need_update';
            }
            else {
                status = 'synced';
            }
            result.push({ name, description: ext.description || '', git: ext.git || '', requiredVersion, installedVersion, status });
        }
    }
    return result;
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
// ─── 从模板同步 extensions.json ──────────────────────────
/** 以 extensions.template.json 为唯一来源同步 extensions.json。
 *  仅在首次启动且 extensions.json 不存在时生成清单。 */
function syncManifestFromTemplate() {
    const manifestPath = getManifestPath();
    const templatePath = path.join(getPluginDir(), 'extensions.template.json');
    // 如果项目清单已经存在，不再强制覆盖，尊重用户修改
    if (fs.existsSync(manifestPath)) {
        return;
    }
    if (!fs.existsSync(templatePath)) {
        fs.writeFileSync(manifestPath, '{}' + '\n', 'utf-8');
        console.log(`[extensions-manager] 模板不存在，已创建空 extensions.json`);
        return;
    }
    try {
        const template = readJSON(templatePath);
        if (!template || typeof template !== 'object') {
            fs.writeFileSync(manifestPath, '{}' + '\n', 'utf-8');
            return;
        }
        writeJSON(manifestPath, template);
        console.log(`[extensions-manager] 首次启动，已从模板生成 extensions.json（${Object.keys(template).length} 个扩展）`);
    }
    catch (err) {
        console.warn(`[extensions-manager] 模板生成失败: ${err.message}`);
        if (!fs.existsSync(manifestPath)) {
            fs.writeFileSync(manifestPath, '{}' + '\n', 'utf-8');
        }
    }
}
// ─── Tags 缓存（5 分钟有效期）────────────────────────────
const TAGS_CACHE_TTL = 5 * 60 * 1000;
const tagsCache = new Map();
/** 异步获取远程 tags */
async function fetchRemoteTags(gitUrl) {
    try {
        const { stdout } = await execAsync(`git ls-remote --tags --sort=-v:refname "${gitUrl}"`, {
            timeout: 30000,
        });
        const tags = [];
        for (const line of stdout.trim().split('\n')) {
            if (!line || line.includes('^{}'))
                continue;
            const ref = line.split('\t')[1];
            if (ref) {
                tags.push(ref.replace('refs/tags/', ''));
            }
        }
        return tags;
    }
    catch (_a) {
        return [];
    }
}
/** 带缓存的 fetchTags */
async function fetchTagsCached(name, gitUrl) {
    const cached = tagsCache.get(name);
    if (cached && (Date.now() - cached.time) < TAGS_CACHE_TTL) {
        return cached.tags;
    }
    const tags = await fetchRemoteTags(gitUrl);
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
        // 更新 extensions.json
        const installedVer = version || getInstalledVersion(name) || 'latest';
        updateManifest(name, installedVer);
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
        // 从 extensions.json 中移除
        updateManifest(name, null);
        return { success: true, output: `${name} 已卸载` };
    }
    catch (err) {
        return { success: false, output: `卸载失败: ${err.message || String(err)}` };
    }
}
async function fallbackSync() {
    const manifest = readJSON(getManifestPath()) || {};
    const names = Object.keys(manifest);
    if (names.length === 0) {
        return { success: true, output: '无需同步（extensions.json 为空）' };
    }
    const results = [];
    let allOk = true;
    for (const name of names) {
        const version = manifest[name];
        const target = version ? `${name}@${version}` : name;
        const r = await fallbackInstall(target);
        results.push(`${r.success ? '✓' : '✗'} ${target}: ${r.output}`);
        if (!r.success)
            allOk = false;
    }
    return { success: allOk, output: results.join('\n') };
}
/** 更新 extensions.json 中的某个扩展版本。version 为 null 时删除条目 */
function updateManifest(name, version) {
    const manifestPath = getManifestPath();
    const manifest = readJSON(manifestPath) || {};
    if (version === null) {
        delete manifest[name];
    }
    else {
        manifest[name] = version;
    }
    writeJSON(manifestPath, manifest);
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
        return getExtensionList(true);
    },
    async listProject() {
        return getExtensionList(false);
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
            console.log('[extensions-manager] manager 脚本不存在，使用内置 git clone 安装');
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
            console.log('[extensions-manager] manager 脚本不存在，使用内置卸载');
            result = await fallbackUninstall(name);
        }
        console.log(`[extensions-manager] uninstall result:`, result.output);
        return result;
    },
    async syncAll(force = false) {
        const args = force ? 'sync --force' : 'sync';
        console.log(`[extensions-manager] ${args}`);
        let result;
        if (hasManagerScript()) {
            result = await runManagerCommand(args);
            if (!result.success) {
                console.log('[extensions-manager] 外部脚本失败，降级到内置同步');
                result = await fallbackSync();
            }
        }
        else {
            console.log('[extensions-manager] manager 脚本不存在，使用内置同步');
            result = await fallbackSync();
        }
        console.log(`[extensions-manager] sync result:`, result.output);
        return result;
    },
    /** 获取指定扩展的所有可用版本 (git tags)，带缓存 */
    async fetchTags(name) {
        const registry = readJSON(getRegistryPath()) || {};
        const ext = registry[name];
        if (!ext || !ext.git)
            return [];
        console.log(`[extensions-manager] 获取 ${name} 的版本列表...`);
        const tags = await fetchTagsCached(name, ext.git);
        console.log(`[extensions-manager] ${name} 共 ${tags.length} 个版本`);
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
        try {
            syncManifestFromTemplate();
        }
        catch (err) {
            console.warn('[extensions-manager] 初始化出错:', err.message);
        }
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
