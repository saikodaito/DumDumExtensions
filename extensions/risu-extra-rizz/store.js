// Risu's extra Rizz: the asset library of each character, in the extension's
// own storage (dd.files, outside the app backup).
//
// Layout per character (dd.files.char(charId)):
//   index.json   { v: 1, source, t, skipped, items: [{ name, ext, type, url, file }] }
//                  name  the asset name as the card wrote it (may already end in .webp)
//                  url   remote copy (RisuRealm CDN) or ''
//                  file  stored file under a/, '' while it only exists remotely
//   risuai.json  the card's extensions.risuai, raw (regex, HTML: later phases)
//   a/<file>     the bytes
//
// The chat render is synchronous, so a character's library is loaded ahead
// (one cursor over a/, blob: URLs made once) and kept for a few characters.

const CDN = 'https://sv.risuai.xyz/resource/';
const CACHE_HOSTS = new Set(['sv.risuai.xyz']);     // what dd.net.fetch may download (permissions.network)
const IMG = /^(webp|png|jpe?g|gif|avif)$/i;
const AUD = /^(mp3|wav|ogg|opus|m4a)$/i;
const VID = /^(mp4|webm|m4v)$/i;
const MIME = {
    webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', avif: 'image/avif',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4',
    mp4: 'video/mp4', webm: 'video/webm', m4v: 'video/mp4',
};
const MAX_LIBS = 4;

const kind = ext => AUD.test(ext || '') ? 'audio' : VID.test(ext || '') ? 'video' : 'image';
const mimeOf = ext => MIME[String(ext || '').toLowerCase()] || '';

function extOf(name, ext) {
    const e = String(ext || '').toLowerCase().replace(/^\./, '');
    if (e) return e;
    const m = /\.([a-z0-9]{2,5})$/i.exec(String(name || ''));
    return m ? m[1].toLowerCase() : 'png';
}

/** A file name under a/ for an asset, unique among `used`. */
function fileNameFor(it, used) {
    let base = String(it.name).replace(/[\\/\u0000-\u001f]/g, '_').trim() || 'asset';
    if (!base.toLowerCase().endsWith('.' + it.ext)) base += '.' + it.ext;
    let f = base;
    for (let n = 2; used.has(f.toLowerCase()); n++) f = base.replace(/(\.[^.]+)$/, `_${n}$1`);
    used.add(f.toLowerCase());
    return f;
}

function hash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
}

async function readIndex(charId) {
    const b = await dd.files.char(charId).get('index.json');
    if (!b) return null;
    try {
        const j = JSON.parse(await b.text());
        return j && Array.isArray(j.items) ? j : null;
    } catch (e) { return null; }
}
async function writeIndex(charId, idx) {
    await dd.files.char(charId).put('index.json', JSON.stringify(idx), 'application/json');
}

// ── Loaded libraries ─────────────────────────────────────────────────────
const libs = new Map();      // charId → lib (Map order = least recently used first)
const loading = new Map();   // charId → Promise

function build(charId, idx, blobs) {
    const lib = { charId, idx, items: idx.items, urls: new Map(), byNorm: new Map(), byGroup: new Map(), names: [] };
    for (const e of blobs) lib.urls.set(e.name.slice(2), URL.createObjectURL(e.blob));   // 'a/x.webp' → 'x.webp'
    lib.items.forEach((it, i) => {
        lib.names.push(it.name);
        const n = dd.assets.norm(it.name), g = dd.assets.group(it.name);
        if (!lib.byNorm.has(n)) lib.byNorm.set(n, []);
        lib.byNorm.get(n).push(i);
        if (!lib.byGroup.has(g)) lib.byGroup.set(g, []);
        lib.byGroup.get(g).push(i);
    });
    return lib;
}

function drop(charId) {
    const lib = libs.get(charId);
    libs.delete(charId);
    if (lib) lib.urls.forEach(u => URL.revokeObjectURL(u));
}
function dropAll() { [...libs.keys()].forEach(drop); }

/** Loads (or reloads) a character's library. Resolves to the lib, or null when empty. */
function load(charId) {
    if (!charId) return Promise.resolve(null);
    if (loading.has(charId)) return loading.get(charId);
    const p = (async () => {
        const idx = await readIndex(charId);
        const blobs = idx && idx.items.length ? await dd.files.char(charId).entries('a/') : [];
        drop(charId);
        if (!idx || !idx.items.length) return null;
        const lib = build(charId, idx, blobs);
        libs.set(charId, lib);
        while (libs.size > MAX_LIBS) drop(libs.keys().next().value);
        return lib;
    })().finally(() => loading.delete(charId));
    loading.set(charId, p);
    return p;
}

const missing = new Set();   // charIds known to have no library (until something changes)

/** Synchronous: the loaded library, or null. Starts a load and redraws the chat when it lands. */
function get(charId) {
    if (!charId || missing.has(charId)) return null;
    const lib = libs.get(charId);
    if (lib) { libs.delete(charId); libs.set(charId, lib); return lib; }
    if (!loading.has(charId)) {
        load(charId).then(l => {
            if (l) dd.render.refresh(); else missing.add(charId);
        }).catch(e => dd.warn('load', charId, e));
    }
    return null;
}

/** Something changed for this character: forget and reload. */
function invalidate(charId) {
    missing.delete(charId);
    drop(charId);
    return load(charId).then(l => { dd.render.refresh(); return l; });
}

/** Index of the asset for a mark, or -1.
 *  <img="name"> is a card convention matched by exact name and variants only
 *  (a fuzzy match put Hikari's face on Hitori's line); the native {{img::name}}
 *  also takes the closest name within 4 edits, like RisuAI. */
function pick(lib, wanted, native, seed) {
    const q = dd.assets.norm(wanted);
    const c = lib.byNorm.get(q) || lib.byGroup.get(q);
    if (c && c.length) return c.length === 1 ? c[0] : c[hash(seed + '|' + q) % c.length];
    return native ? dd.assets.match(wanted, lib.names, seed, 4) : -1;
}

function urlOf(lib, i) {
    const it = lib.items[i];
    if (!it) return '';
    return (it.file && lib.urls.get(it.file)) || it.url || '';
}

// ── Download cache (remote assets are kept after they show up once) ─────
const queue = [];
const queued = new Set();
let running = 0;
const pendingIndex = new Map();   // charId → timer (index writes are debounced)

function canCache(it) {
    if (!it || it.file || !it.url) return false;
    try { return CACHE_HOSTS.has(new URL(it.url).hostname); } catch (e) { return false; }
}

async function downloadOne(charId, idx, it, used) {
    const r = await dd.net.fetch(it.url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    let b = await r.blob();
    // The app's HTTP fallback returns Blobs without a type.
    const t = mimeOf(it.ext);
    if (t && b.type !== t) b = new Blob([b], { type: t });
    const f = fileNameFor(it, used);
    await dd.files.char(charId).put('a/' + f, b, t);
    it.file = f;
    return b;
}

function usedNames(idx) { return new Set(idx.items.filter(x => x.file).map(x => x.file.toLowerCase())); }

function scheduleIndex(charId, idx) {
    clearTimeout(pendingIndex.get(charId));
    pendingIndex.set(charId, setTimeout(() => {
        pendingIndex.delete(charId);
        writeIndex(charId, idx).catch(e => dd.warn('index', e));
    }, 800));
}

/** The chat showed a remote asset: keep a copy (if caching is on). */
function want(lib, i) {
    if (!dd.shared.cfg.cache) return;
    const it = lib.items[i];
    const key = lib.charId + '|' + i;
    if (!canCache(it) || queued.has(key)) return;
    queued.add(key);
    queue.push({ lib, i, key });
    pump();
}
function pump() {
    while (running < 2 && queue.length) {
        const job = queue.shift();
        running++;
        (async () => {
            const { lib, i } = job;
            const it = lib.items[i];
            if (!canCache(it)) return;
            const b = await downloadOne(lib.charId, lib.idx, it, usedNames(lib.idx));
            if (libs.get(lib.charId) === lib) lib.urls.set(it.file, URL.createObjectURL(b));
            scheduleIndex(lib.charId, lib.idx);
        })().catch(e => dd.warn('cache', e)).finally(() => { running--; pump(); });
    }
}

/** Downloads every remote asset of a character now. onStep(done, total, bytes) → false stops. */
async function downloadAll(charId, onStep) {
    const idx = await readIndex(charId);
    if (!idx) return { done: 0, failed: 0 };
    const todo = idx.items.filter(canCache);
    const used = usedNames(idx);
    let done = 0, failed = 0, bytes = 0;
    for (const it of todo) {
        try { bytes += (await downloadOne(charId, idx, it, used)).size; done++; }
        catch (e) { failed++; dd.warn('download', it.name, e); }
        if ((done + failed) % 20 === 0) await writeIndex(charId, idx);
        if (onStep && (await onStep(done + failed, todo.length, bytes)) === false) break;
    }
    await writeIndex(charId, idx);
    await invalidate(charId);
    return { done, failed, bytes };
}

dd.shared.store = {
    CDN, IMG, AUD, VID, kind, mimeOf, extOf, fileNameFor, hash,
    readIndex, writeIndex, load, get, invalidate, drop, dropAll, pick, urlOf, want, canCache, downloadAll,
    forget: charId => { missing.delete(charId); drop(charId); },
};
