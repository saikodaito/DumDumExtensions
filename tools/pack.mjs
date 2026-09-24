// Packs one extension into dist/<id>-<version>.dumext (a zip).
//   node tools/pack.mjs <id>
//   node tools/pack.mjs --dir <folder>      # any folder with a manifest.json
//
// The manifest must already carry the hashes (run build-index first): the app
// refuses a .dumext without them. Only the declared files go in, plus
// README.md and CHANGELOG.md when present. A .dumext that is byte for byte an
// entry of the official index gets the "official" badge in the app.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { ROOT, EXT_DIR, sha256, filesOf, manifestErrors } from './lib.mjs';

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

/** Minimal zip writer: deflate (or store when that is smaller), UTF-8 names, fixed date. */
export function zip(entries) {
    const localParts = [], central = [];
    let offset = 0;
    const DOS_TIME = 0, DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1;   // fixed: same input, same bytes
    for (const { name, data } of entries) {
        const nameBuf = Buffer.from(name, 'utf8');
        const def = deflateRawSync(data, { level: 9 });
        const useDeflate = def.length < data.length;
        const body = useDeflate ? def : data;
        const crc = crc32(data);
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
        lh.writeUInt16LE(useDeflate ? 8 : 0, 8); lh.writeUInt16LE(DOS_TIME, 10); lh.writeUInt16LE(DOS_DATE, 12);
        lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22);
        lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
        localParts.push(lh, nameBuf, body);
        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
        ch.writeUInt16LE(useDeflate ? 8 : 0, 10); ch.writeUInt16LE(DOS_TIME, 12); ch.writeUInt16LE(DOS_DATE, 14);
        ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24);
        ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
        central.push(ch, nameBuf);
        offset += lh.length + nameBuf.length + body.length;
    }
    const cd = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...localParts, cd, end]);
}

export function pack(dir) {
    const mPath = join(dir, 'manifest.json');
    if (!existsSync(mPath)) throw new Error('no manifest.json in ' + dir);
    const raw = readFileSync(mPath);
    const m = JSON.parse(raw.toString('utf8'));
    const errs = manifestErrors(m);
    if (errs.length) throw new Error('manifest: ' + errs.join('; '));
    if (!m.files) throw new Error('manifest has no hashes: run node tools/build-index.mjs first');
    const entries = [{ name: 'manifest.json', data: raw }];
    for (const p of filesOf(m)) {
        const f = join(dir, p);
        if (!existsSync(f)) throw new Error('declared file not found: ' + p);
        const data = readFileSync(f);
        if (sha256(data) !== m.files[p]) throw new Error(`hash out of date for ${p}: run node tools/build-index.mjs`);
        entries.push({ name: p, data });
    }
    for (const extra of ['README.md', 'CHANGELOG.md']) {
        const f = join(dir, extra);
        if (existsSync(f)) entries.push({ name: extra, data: readFileSync(f) });
    }
    const out = join(ROOT, 'dist');
    mkdirSync(out, { recursive: true });
    const file = join(out, `${m.id}-${m.version}.dumext`);
    writeFileSync(file, zip(entries));
    return { file, count: entries.length };
}

if (process.argv[1].endsWith('pack.mjs')) {
    const i = process.argv.indexOf('--dir');
    const dir = i > 0 ? resolve(process.argv[i + 1]) : process.argv[2] ? join(EXT_DIR, process.argv[2]) : null;
    if (!dir) { console.error('usage: node tools/pack.mjs <id> | --dir <folder>'); process.exit(2); }
    try {
        const { file, count } = pack(dir);
        console.log(`packed ${count} file(s) → ${file}`);
    } catch (e) { console.error('✖ ' + e.message); process.exit(1); }
}
