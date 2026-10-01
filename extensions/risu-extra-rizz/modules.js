// Risu's extra Rizz: RisuAI modules (.risum) added to a character by hand.
//
// Some cards ship their images apart, as a module the user downloads and
// enables in RisuAI (Cheongwon High School: the "CWHA" module, linked from the
// creator notes; without it the card shows "Asset Error: Could not find ...").
// Added here, a module's images join the character's library (marked with the
// module) and its namespace answers {{module_assetlist::NS}} and
// {{moduleenabled::NS}}; its regex, triggers and background run after the
// card's, as RisuAI concatenates enabled modules (store.js risuLoad).
//
// Layout in the character's folder:
//   modules.json         [{ key, name, namespace, assets, regex, triggers }]
//   modules/<key>.json   the module data (risum.js moduleData) + assetNames

const S = dd.shared.store;
const R = dd.shared.risum;
const LIST = 'modules.json';
const safe = s => String(s || '').replace(/[^\w.-]+/g, '_').slice(0, 80) || 'module';

async function list(charId) {
    try {
        const b = await dd.files.char(charId).get(LIST);
        const j = b ? JSON.parse(await b.text()) : [];
        return Array.isArray(j) ? j : [];
    } catch (e) { return []; }
}

async function read(charId, key) {
    try {
        const b = await dd.files.char(charId).get('modules/' + key + '.json');
        return b ? JSON.parse(await b.text()) : null;
    } catch (e) { return null; }
}

/** Drops a module's images from the library (index and files). */
async function dropAssets(charId, key) {
    const idx = await S.readIndex(charId);
    if (!idx) return;
    const gone = idx.items.filter(it => it.module === key);
    if (!gone.length) return;
    idx.items = idx.items.filter(it => it.module !== key);
    await S.writeIndex(charId, idx);
    const folder = dd.files.char(charId);
    for (const it of gone) if (it.file) await folder.del('a/' + it.file).catch(() => {});
}

function done(charId) {
    S.risuForget(charId);
    dd.shared.display.reset();
    return S.invalidate(charId);
}

/** A module's images into the character's library, marked with `key`. */
async function storeAssets(charId, key, assets) {
    if (!assets || !assets.length) return;
    const folder = dd.files.char(charId);
    const idx = (await S.readIndex(charId)) || { v: 1, source: 'module', t: Date.now(), skipped: 0, items: [] };
    const used = new Set(idx.items.filter(x => x.file).map(x => x.file.toLowerCase()));
    const batch = [];
    for (const a of assets) {
        const it = { name: a.name, ext: S.extOf(a.name, a.ext), type: 'x-risu-asset', url: '', file: '', module: key };
        it.file = S.fileNameFor(it, used);
        batch.push({ name: 'a/' + it.file, data: new Blob([a.bytes]), type: S.mimeOf(it.ext) });
        idx.items.push(it);
    }
    await folder.putMany(batch);
    await S.writeIndex(charId, idx);
}

/** Adds (or replaces) a module from the bytes of a .risum. Returns its entry. */
async function add(charId, bytes) {
    const mod = R.readRisum(bytes);
    const data = R.moduleData(mod);
    const assets = R.readRisumAssets(bytes, mod);
    const key = safe(data.id || data.namespace || data.name);
    await dropAssets(charId, key);
    await storeAssets(charId, key, assets);
    const folder = dd.files.char(charId);

    data.assetNames = assets.map(a => [a.name, '', a.ext]);
    await folder.put('modules/' + key + '.json', JSON.stringify(data), 'application/json');
    const entry = { key, name: data.name, namespace: data.namespace, assets: assets.length, regex: data.regex.length, triggers: data.trigger.length };
    const mods = (await list(charId)).filter(m => m.key !== key).concat([entry]);
    await folder.put(LIST, JSON.stringify(mods), 'application/json');
    await done(charId);
    return entry;
}

async function remove(charId, key) {
    await dropAssets(charId, key);
    const folder = dd.files.char(charId);
    await folder.del('modules/' + key + '.json').catch(() => {});
    await folder.put(LIST, JSON.stringify((await list(charId)).filter(m => m.key !== key)), 'application/json');
    await done(charId);
}

dd.shared.modules = { list, read, add, remove, storeAssets };
