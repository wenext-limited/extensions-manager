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

// 使用 archiver 或回退到系统命令
try {
    require.resolve('archiver');
    packWithArchiver();
} catch {
    // archiver 不可用，回退到系统命令
    packWithSystemCmd();
}

function packWithArchiver() {
    const archiver = require('archiver');
    const output = createWriteStream(outZip);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
        const sizeKB = (archive.pointer() / 1024).toFixed(1);
        console.log(`>>> 完成：${outZip} (${sizeKB} KB)`);
    });

    archive.on('error', (err) => { throw err; });
    archive.pipe(output);

    for (const entry of INCLUDE) {
        const fullPath = path.join(ROOT, entry);
        if (!fs.existsSync(fullPath)) {
            console.warn(`  跳过不存在的: ${entry}`);
            continue;
        }
        if (entry.endsWith('/')) {
            archive.directory(fullPath, `extensions-manager/${entry.replace(/\/$/, '')}`);
        } else {
            archive.file(fullPath, { name: `extensions-manager/${entry}` });
        }
    }

    archive.finalize();
}

function packWithSystemCmd() {
    // 使用系统临时目录，避免与项目内残留目录冲突
    const tmpDir = path.join(os.tmpdir(), `em-pack-${Date.now()}`);
    const targetDir = path.join(tmpDir, 'extensions-manager');
    fs.mkdirSync(targetDir, { recursive: true });

    // 复制文件（dist/ 只复制编译产物，跳过 zip 自身）
    for (const entry of INCLUDE) {
        const entryName = entry.replace(/\/$/, '');
        const src = path.join(ROOT, entryName);
        const dest = path.join(targetDir, entryName);
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
    }

    // 删除旧 zip
    if (fs.existsSync(outZip)) fs.unlinkSync(outZip);

    // 压缩
    if (process.platform === 'win32') {
        execSync(
            `powershell -NoProfile -Command "Compress-Archive -Path '${targetDir}' -DestinationPath '${outZip}' -Force"`,
            { stdio: 'inherit' }
        );
    } else {
        execSync(`zip -r "${outZip}" "extensions-manager"`, {
            cwd: tmpDir,
            stdio: 'inherit',
        });
    }

    // 清理临时目录
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

    const sizeKB = (fs.statSync(outZip).size / 1024).toFixed(1);
    console.log(`>>> 完成：${outZip} (${sizeKB} KB)`);
}

/** 非递归删除目录（避免大目录栈溢出） */
function deleteDirSync(dirPath) {
    const stack = [dirPath];
    const toDelete = [];
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
