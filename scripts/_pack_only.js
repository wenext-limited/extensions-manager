/**
 * 仅打包（不编译），用于调试或 dist/ 已是最新时快速出包
 * 用法: node scripts/_pack_only.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const version = pkg.version || '0.0.0';
const zipName = `extensions-manager-v${version}.zip`;
const distDir = path.join(ROOT, 'dist');
const outZip = path.join(distDir, zipName);

// 需要打包进 zip 的文件/目录（相对于项目根）
const INCLUDE = [
    'dist',
    'i18n',
    'static',
    'registry.json',
    'extensions.template.json',
    'package.json',
    'README.md',
];

// 检查 dist/main.js 存在
if (!fs.existsSync(path.join(distDir, 'main.js'))) {
    console.error('错误：dist/main.js 不存在，请先运行 npm run build');
    process.exit(1);
}

// 删除旧 zip
if (fs.existsSync(outZip)) {
    fs.unlinkSync(outZip);
    console.log(`[清理] 已删除旧 zip: ${outZip}`);
}

// 使用系统临时目录，避免与项目内残留目录冲突
const tmpDir = path.join(os.tmpdir(), `em-pack-${Date.now()}`);
const TARGET = path.join(tmpDir, 'extensions-manager');
fs.mkdirSync(TARGET, { recursive: true });

console.log(`[复制] 开始复制文件到临时目录...`);
for (const entry of INCLUDE) {
    const src = path.join(ROOT, entry);
    const dest = path.join(TARGET, entry);
    if (!fs.existsSync(src)) {
        console.warn(`  跳过不存在的: ${entry}`);
        continue;
    }
    if (fs.statSync(src).isDirectory()) {
        copyDirSync(src, dest, [outZip]);
    } else {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
    }
    console.log(`  ✓ ${entry}`);
}

console.log(`[压缩] 正在生成 ${zipName} ...`);
const cmd = `powershell -NoProfile -NonInteractive -Command "Compress-Archive -Path '${TARGET}' -DestinationPath '${outZip}' -Force"`;
execSync(cmd, { stdio: 'inherit' });

// 清理临时目录
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

const sizeKB = (fs.statSync(outZip).size / 1024).toFixed(1);
console.log(`\n✅ 完成！输出: ${outZip} (${sizeKB} KB)`);
console.log('把此 zip 拖入 Cocos Creator 编辑器即可安装。');

// ─── 工具函数 ─────────────────────────────────────────────────

/** 使用系统命令删除目录，可处理 Windows 超长路径 */
function forceDeleteDir(dirPath) {
    if (!fs.existsSync(dirPath)) return;
    try {
        fs.rmSync(dirPath, { recursive: true, force: true });
    } catch {
        try {
            execSync(`cmd /c rd /s /q "${dirPath}"`, { stdio: 'ignore' });
        } catch { /* best-effort */ }
    }
}

function copyDirSync(src, dest, skip = []) {
    fs.mkdirSync(dest, { recursive: true });
    for (const child of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path.join(src, child.name);
        const destPath = path.join(dest, child.name);
        // 跳过明确排除的路径及临时工作目录
        if (skip.includes(srcPath)) continue;
        if (child.name === '_pack_tmp') continue;
        if (child.isDirectory()) {
            copyDirSync(srcPath, destPath, skip);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}
