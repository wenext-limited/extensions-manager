/**
 * 打包脚本：构建并生成发布用 zip 包
 *
 * 用法：npm run pack
 *
 * 输出：dist/extensions-manager-v{version}.zip
 * 解压后目录结构：extensions-manager/（直接放入项目 extensions/ 目录即可）
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createWriteStream } = require('fs');

const ROOT = path.resolve(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const version = pkg.version || '0.0.0';
const zipName = `extensions-manager-v${version}.zip`;
const distDir = path.join(ROOT, 'dist');
const outZip = path.join(distDir, zipName);

// 需要打包进 zip 的文件/目录（相对于项目根）
// @types/ 仅用于开发编译，运行时不需要，不打入包
const INCLUDE = [
    'dist/',
    'i18n/',
    'static/',
    'registry.json',
    'extensions.template.json',
    'package.json',
    'README.md',
];

// ─── 步骤 1：编译 TypeScript ─────────────────────────────
console.log('>>> 编译 TypeScript ...');
const tscJs = path.join(ROOT, 'node_modules', 'typescript', 'lib', 'tsc.js');
try {
    execSync(
        `node "${tscJs}" --project "${path.join(ROOT, 'tsconfig.json')}"`,
        { cwd: ROOT, stdio: 'inherit' }
    );
} catch (buildErr) {
    // 若编译有错误但 dist/main.js 已存在，发出警告后继续打包
    if (fs.existsSync(path.join(ROOT, 'dist', 'main.js'))) {
        console.warn('>>> 警告：TypeScript 编译报错，使用现有 dist/ 继续打包...');
    } else {
        console.error('>>> 编译失败且 dist/main.js 不存在，请先修复编译错误。');
        process.exit(1);
    }
}

// ─── 步骤 2：清理 dist/ 内可能残留的 _pack_tmp ───────────────
const staleInDist = path.join(distDir, '_pack_tmp');
if (fs.existsSync(staleInDist)) {
    fs.rmSync(staleInDist, { recursive: true, force: true });
    console.log('[清理] 已删除 dist/_pack_tmp/');
}

// ─── 步骤 3：生成 zip ──────────────────────────────────
console.log(`>>> 打包 ${zipName} ...`);

// 调用 _pack_only.js 生成正确的纯 Node.js ZIP，避免平台兼容性问题
try {
    execSync(`node "${path.join(__dirname, '_pack_only.js')}"`, {
        cwd: ROOT,
        stdio: 'inherit'
    });
} catch (err) {
    console.error('>>> 打包失败。');
    process.exit(1);
}
    while (stack.length > 0) {
        const cur = stack.pop();
        toDelete.push(cur);
        if (fs.existsSync(cur) && fs.statSync(cur).isDirectory()) {
            for (const child of fs.readdirSync(cur)) {
                stack.push(path.join(cur, child));
            }
        }
    }
    // 逆序删除（先删叶子）
    for (let i = toDelete.length - 1; i >= 0; i--) {
        const p = toDelete[i];
        if (!fs.existsSync(p)) continue;
        if (fs.statSync(p).isDirectory()) {
            fs.rmdirSync(p);
        } else {
            fs.unlinkSync(p);
        }
    }
}

/** 递归复制目录，skip 列表中的路径不复制 */
function copyDirSync(src, dest, skip = []) {
    fs.mkdirSync(dest, { recursive: true });
    for (const child of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path.join(src, child.name);
        const destPath = path.join(dest, child.name);
        if (skip.includes(srcPath)) continue;
        if (child.name === '_pack_tmp') continue;
        if (child.isDirectory()) {
            copyDirSync(srcPath, destPath, skip);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}
