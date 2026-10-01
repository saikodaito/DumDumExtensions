// Asset Probe: a small example of the API 2 hooks.
//  - char.imported: keeps the images a card carries (Character Card V3 `assets`,
//    the way RisuRealm cards ship their expressions) in the extension's own
//    storage (dd.files, needs "storage": "own" in the manifest).
//  - dd.render.text: shows them in the chat where a message writes
//    <img="name"> or {{img::name}}.
// It is NOT full Risu support (that is Risu's extra Rizz): the limits below are
// small on purpose, and nothing goes into the prompt.

const MAX_FILES = 40;                       // per character
const MAX_BYTES = 20 * 1024 * 1024;         // per character
const TYPES = new Set(['x-risu-asset', 'emotion']);
const CDN = 'https://sv.risuai.xyz/resource/';
const MIME = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', avif: 'image/avif' };
const SHOW = new Set(['img', 'image', 'asset', 'emotion']);

let urls = new Map();     // file name → blob: URL, for the character of the open chat
let names = [];
let loadedFor = null;

dd.onActivate(() => {
    dd.on('char.imported', onImported);
    dd.on('chat.opened', e => load(e.charId));
    dd.on('char.deleted', e => { if (e.charId === loadedFor) clear(); });
    // Import or wipe from the extension's data window (Settings > Extensions).
    dd.on('data.imported', () => { const c = loadedFor; clear(); load(c); });
    // Synchronous and cheap: everything it needs is loaded in load().
    dd.render.text(render);
    dd.ui.settings(renderSettings);
    const chat = dd.state.chat();
    if (chat) load(chat.charId);
});

dd.onDeactivate(clear);

async function onImported({ charId, source, card, file }) {
    const list = (card && Array.isArray(card.assets) ? card.assets : [])
        .filter(a => a && TYPES.has(String(a.type || '').toLowerCase()));
    if (!list.length) return;
    const folder = dd.files.char(charId);
    let n = 0, bytes = 0;
    for (const a of list) {
        if (n >= MAX_FILES || bytes >= MAX_BYTES) break;
        const name = String(a.name || '').trim();
        if (!name) continue;
        const ext = String(a.ext || 'png').toLowerCase();
        const blob = await fetchAsset(a, file, MIME[ext] || '');
        if (!blob || !blob.size) continue;
        // Risu cards often have the extension in the name already ('Hikari_angry_1.webp').
        await folder.put(name.toLowerCase().endsWith('.' + ext) ? name : name + '.' + ext, blob);
        n++;
        bytes += blob.size;
    }
    dd.log(`kept ${n} of ${list.length} assets (${source})`);
    if (n) dd.ui.toast(dd.t('toast_kept', { n, total: list.length }), 'success');
}

async function fetchAsset(a, file, type) {
    let uri = String(a.uri || '');
    try {
        let b = null;
        if (/^embed?ded:\/\//i.test(uri)) b = await file(uri);              // inside the .charx or the PNG
        else {
            if (/^risustored:/i.test(uri)) uri = CDN + encodeURIComponent(uri.slice('risustored:'.length));
            // Hosts outside permissions.network are refused by dd.net.fetch.
            if (/^https:\/\//i.test(uri)) { const r = await dd.net.fetch(uri); if (r.ok) b = await r.blob(); }
        }
        // The app's HTTP fallback returns Blobs without a type.
        return b && type && b.type !== type ? new Blob([b], { type }) : b;
    } catch (e) {
        dd.warn('asset', a.name, e);
        return null;
    }
}

async function load(charId) {
    clear();
    if (!charId) return;
    loadedFor = charId;
    const folder = dd.files.char(charId);
    const next = new Map();
    for (const f of await folder.list()) {
        const b = await folder.get(f.name);
        if (b) next.set(f.name, URL.createObjectURL(b));
    }
    if (loadedFor !== charId) { next.forEach(u => URL.revokeObjectURL(u)); return; }
    urls = next;
    names = [...urls.keys()];
    if (names.length) dd.render.refresh();
}

function clear() {
    urls.forEach(u => URL.revokeObjectURL(u));
    urls = new Map();
    names = [];
    loadedFor = null;
}

function render(text, ctx) {
    if (!names.length || ctx.charId !== loadedFor) return text;
    return dd.assets.replace(text, (type, name, mark, native) => {
        if (!SHOW.has(type)) return null;
        // Same message, same variant on every redraw. Fuzzy names only for the
        // native {{img::name}}: <img="name"> is a card convention matched by
        // prefix, and a fuzzy match would put one character's face on another.
        const i = dd.assets.match(name, names, ctx.chatId + ':' + ctx.msgIndex, native ? 4 : 0);
        if (i < 0) return null;
        return '<img src="' + urls.get(names[i]) + '" alt="" class="dd-ap-img">';
    });
}

async function renderSettings(el) {
    const section = dd.ui.section({ title: { t: 'sec_probe' }, icon: 'images' });
    const line = dd.ui.hint('');
    section.appendChild(line);
    section.appendChild(dd.ui.hint({ t: 'hint_how' }));
    section.appendChild(dd.ui.hint({ t: 'hint_backup' }));
    el.appendChild(section);
    const u = await dd.files.usage();
    line.textContent = dd.t('usage', { f: u.files, n: u.chars, mb: (u.bytes / 1048576).toFixed(1) });
}
