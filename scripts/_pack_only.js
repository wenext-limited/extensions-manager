/**
 * 仅打包（不编译），用于调试或 dist/ 已是最新时快速出包
 * 用法: node scripts/_pack_only.js
 *
 * 使用纯 Node.js + zlib 生成标准 ZIP（正斜杠路径），兼容 Cocos Editor。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

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
}

// 收集所有要打包的文件（绝对路径 → zip 内相对路径，均用正斜杠）
/** @type {{ absPath: string; zipEntry: string }[]} */
const files = [];

for (const entry of INCLUDE) {
    const src = path.join(ROOT, entry);
    if (!fs.existsSync(src)) {
        console.warn(`  跳过不存在的: ${entry}`);
        continue;
    }
    if (fs.statSync(src).isDirectory()) {
        collectFiles(src, `extensions-manager/${entry}`);
    } else {
        files.push({ absPath: src, zipEntry: `extensions-manager/${entry}` });
    }
}

console.log(`[打包] 收集到 ${files.length} 个文件，正在写入 ${zipName} ...`);
writeZip(outZip, files);

const sizeKB = (fs.statSync(outZip).size / 1024).toFixed(1);
console.log(`\n✅ 完成！输出: ${outZip} (${sizeKB} KB)`);
console.log('把此 zip 拖入 Cocos Creator 编辑器即可安装。');

// ─── 工具函数 ─────────────────────────────────────────────────

/** 递归收集目录中的所有文件 */
function collectFiles(dirAbs, zipBase) {
    for (const child of fs.readdirSync(dirAbs, { withFileTypes: true })) {
        // 跳过旧 zip 本身及临时目录
        if (child.name === '_pack_tmp') continue;
        if (child.name === zipName && dirAbs === distDir) continue;
        const childAbs = path.join(dirAbs, child.name);
        const childZip = `${zipBase}/${child.name}`;
        if (child.isDirectory()) {
            collectFiles(childAbs, childZip);
        } else {
            files.push({ absPath: childAbs, zipEntry: childZip });
        }
    }
}

/**
 * 用纯 Node.js 写出标准 ZIP 文件（DEFLATE 压缩，正斜杠路径）。
 * ZIP 格式参考: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
 * @param {string} outPath
 * @param {{ absPath: string; zipEntry: string }[]} entries
 */
function writeZip(outPath, entries) {
    /** @type {{ localHeaderOffset: number; entry: string; crc: number; compressedSize: number; uncompressedSize: number; data: Buffer }[]} */
    const records = [];
    const parts = [];
    let offset = 0;

    for (const { absPath, zipEntry } of entries) {
        const raw = fs.readFileSync(absPath);
        const compressed = zlib.deflateRawSync(raw);
        // 如果压缩后更大，则用 STORE 方式
        const useStore = compressed.length >= raw.length;
        const data = useStore ? raw : compressed;
        const method = useStore ? 0 : 8;
        const crc = crc32(raw);

        const nameBytes = Buffer.from(zipEntry, 'utf8');
        const localHeader = makeLocalHeader(nameBytes, method, crc, data.length, raw.length);

        records.push({
            localHeaderOffset: offset,
            entry: zipEntry,
            nameBytes,
            crc,
            compressedSize: data.length,
            uncompressedSize: raw.length,
            method,
        });

        parts.push(localHeader, data);
        offset += localHeader.length + data.length;
    }

    // 中央目录
    const cdParts = [];
    let cdSize = 0;
    for (const r of records) {
        const cd = makeCentralDir(r.nameBytes, r.method, r.crc, r.compressedSize, r.uncompressedSize, r.localHeaderOffset);
        cdParts.push(cd);
        cdSize += cd.length;
    }

    // 中央目录结束记录
    const eocd = makeEOCD(records.length, cdSize, offset);

    const allBuffers = [...parts, ...cdParts, eocd];
    fs.writeFileSync(outPath, Buffer.concat(allBuffers));
}

function makeLocalHeader(nameBytes, method, crc, compressedSize, uncompressedSize) {
    const buf = Buffer.alloc(30 + nameBytes.length);
    buf.writeUInt32LE(0x04034b50, 0);  // Local file header signature
    buf.writeUInt16LE(20, 4);           // Version needed
    buf.writeUInt16LE(0, 6);            // General purpose bit flag
    buf.writeUInt16LE(method, 8);       // Compression method
    buf.writeUInt16LE(0, 10);           // Last mod time
    buf.writeUInt16LE(0, 12);           // Last mod date
    buf.writeUInt32LE(crc >>> 0, 14);   // CRC-32
    buf.writeUInt32LE(compressedSize, 18);
    buf.writeUInt32LE(uncompressedSize, 22);
    buf.writeUInt16LE(nameBytes.length, 26);
    buf.writeUInt16LE(0, 28);           // Extra field length
    nameBytes.copy(buf, 30);
    return buf;
}

function makeCentralDir(nameBytes, method, crc, compressedSize, uncompressedSize, localOffset) {
    const buf = Buffer.alloc(46 + nameBytes.length);
    buf.writeUInt32LE(0x02014b50, 0);  // Central directory signature
    buf.writeUInt16LE(20, 4);           // Version made by
    buf.writeUInt16LE(20, 6);           // Version needed
    buf.writeUInt16LE(0, 8);            // General purpose bit flag
    buf.writeUInt16LE(method, 10);      // Compression method
    buf.writeUInt16LE(0, 12);           // Last mod time
    buf.writeUInt16LE(0, 14);           // Last mod date
    buf.writeUInt32LE(crc >>> 0, 16);   // CRC-32
    buf.writeUInt32LE(compressedSize, 20);
    buf.writeUInt32LE(uncompressedSize, 24);
    buf.writeUInt16LE(nameBytes.length, 28);
    buf.writeUInt16LE(0, 30);           // Extra field length
    buf.writeUInt16LE(0, 32);           // File comment length
    buf.writeUInt16LE(0, 34);           // Disk number start
    buf.writeUInt16LE(0, 36);           // Internal file attributes
    buf.writeUInt32LE(0, 38);           // External file attributes
    buf.writeUInt32LE(localOffset, 42); // Offset of local header
    nameBytes.copy(buf, 46);
    return buf;
}

function makeEOCD(numEntries, cdSize, cdOffset) {
    const buf = Buffer.alloc(22);
    buf.writeUInt32LE(0x06054b50, 0);  // EOCD signature
    buf.writeUInt16LE(0, 4);            // Disk number
    buf.writeUInt16LE(0, 6);            // Start disk number
    buf.writeUInt16LE(numEntries, 8);   // Entries on this disk
    buf.writeUInt16LE(numEntries, 10);  // Total entries
    buf.writeUInt32LE(cdSize, 12);      // Central directory size
    buf.writeUInt32LE(cdOffset, 16);    // Central directory offset
    buf.writeUInt16LE(0, 20);           // Comment length
    return buf;
}

/** CRC-32 实现 */
function crc32(buf) {
    // 构造查找表（仅第一次调用时）
    if (!crc32._table) {
        const t = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
            t[i] = c;
        }
        crc32._table = t;
    }
    const table = crc32._table;
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}
