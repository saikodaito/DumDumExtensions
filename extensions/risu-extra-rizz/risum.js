// Risu's extra Rizz: RisuAI modules (.risum). In a .charx package the card's
// regex and triggers live only in module.risum (card.json has none).
//
// Format (RisuAI src/ts/process/modules.ts, readModule): byte 111 (magic),
// byte 0 (version), u32 LE length + the module JSON encoded with rpack, then
// asset blocks [1][u32 length][rpack bytes] ending with a 0.
// rpack is a byte substitution: RisuAI's rpack_map.bin, whose bytes 256-511
// are the decode map (copied below). Rpack.js is MIT inside RisuAI and
// AGPL-3.0 elsewhere; this extension is AGPL-3.0 (see LICENSE).

const RPACK_DECODE = Uint8Array.from(atob(
    'LPeEi8ll+7afrrMDLQFpdB/ko+zuXDQhk0oPauJiAp4inP08/HHHxq1ZZwVwbYpEEvokhl+v0XpHzv5QY91RBm8Y4FKoCZ1Wc0y4U2zDoA4Zzz4NfgcyaEbqSPmZLqukSSBeVTU4DLzTsVgWeSgKGuHyzcQ526K6YHJ2fZXvf8jA3jeUv7UUgZIlRazn9WanKzZawRPjSzrojYMbfCewmkLrh6rcVI54JtJXKdS3+C+PiXXwQXfCHv/YFRHlBJcX8zHQmwDXyrRPKjvZsmvaXaE/MGG9kT1O5t++TYKMHSMQmGT0hTN7kEO7qYjx1qUc9sxuuVsLlu3V6cXLCKaAQA=='
), c => c.charCodeAt(0));

function rpackDecode(u8) {
    const out = new Uint8Array(u8.length);
    for (let i = 0; i < u8.length; i++) out[i] = RPACK_DECODE[u8[i]];
    return out;
}

/** bytes (ArrayBuffer | Uint8Array) → the module object ({ name, description,
 *  id, regex, trigger, lorebook, assets, lowLevelAccess... }). Assets inside
 *  the module are not read (none in the RisuRealm sample; a .charx keeps them
 *  in the ZIP). Throws on anything that is not a module. */
function readRisum(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (u8.length < 6 || u8[0] !== 111) throw new Error('not a RisuAI module (magic)');
    if (u8[1] !== 0) throw new Error('RisuAI module version ' + u8[1]);
    const len = new DataView(u8.buffer, u8.byteOffset + 2, 4).getUint32(0, true);
    if (6 + len > u8.length) throw new Error('RisuAI module cut short');
    const main = JSON.parse(new TextDecoder().decode(rpackDecode(u8.subarray(6, 6 + len))));
    if (!main || main.type !== 'risuModule' || !main.module) throw new Error('not a RisuAI module (type)');
    return main.module;
}

/** The asset blocks after the module JSON, in the order of module.assets
 *  ([name, path, ext]): [{ name, ext, bytes }]. Asset modules (a card's
 *  images shipped apart, like Cheongwon's "CWHA") carry them here. */
function readRisumAssets(bytes, mod) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const list = Array.isArray(mod && mod.assets) ? mod.assets : [];
    const out = [];
    let pos = 6 + dv.getUint32(2, true);
    for (let i = 0; pos < u8.length; i++) {
        const mark = u8[pos++];
        if (mark === 0) break;
        if (mark !== 1 || pos + 4 > u8.length) throw new Error('RisuAI module: bad asset block');
        const len = dv.getUint32(pos, true);
        pos += 4;
        if (pos + len > u8.length) throw new Error('RisuAI module cut short');
        const a = list[i];
        if (a && a[0]) out.push({ name: String(a[0]), ext: String(a[2] || ''), bytes: rpackDecode(u8.subarray(pos, pos + len)) });
        pos += len;
    }
    return out;
}

/** The part of a module this extension uses, small enough to keep as JSON. */
function moduleData(m) {
    return {
        name: String(m.name || ''), id: String(m.id || ''), namespace: String(m.namespace || ''),
        regex: Array.isArray(m.regex) ? m.regex : [],
        trigger: Array.isArray(m.trigger) ? m.trigger : [],
        lowLevelAccess: !!m.lowLevelAccess,
        backgroundEmbedding: typeof m.backgroundEmbedding === 'string' ? m.backgroundEmbedding : '',
        lorebookCount: Array.isArray(m.lorebook) ? m.lorebook.length : 0,
    };
}

dd.shared.risum = { readRisum, readRisumAssets, moduleData };
