// Risu's extra Rizz: RisuRealm cards through their package (.charx).
//
// RisuRealm's search index says 'normal' for cards that are packages, and the
// JSON it serves for them (json-v3) is an old version without module.risum,
// where the card's regex and triggers live: THE MORTAL REALM came as 0.8 by
// JSON and 2.02 by package. With this extension on, the app imports and
// previews those through the package (dd.cards.source format).
//
// Update check (dd.cards.source update): a card that came as a package is
// compared with the package. The server has no Range and no ETag, so the
// package size (Content-Length) says whether it changed; only then the whole
// package is downloaded. A new module or risuai block (regex, triggers, Lua,
// background) is offered as one more change of the update; it is staged in
// the character's folder and goes live when the user accepts it (apply).

const S = dd.shared.store;
const R = dd.shared.risum;
const typeMemo = new Map();          // RisuRealm id → 'charx' | 'normal' (this session)

async function realType(id) {
    if (typeMemo.has(id)) return typeMemo.get(id);
    let t = '';
    try { const i = await dd.cards.info('risurealm', id); t = (i && i.type) || ''; }
    catch (e) { dd.warn('realm type', id, e); }
    if (t) typeMemo.set(id, t);
    return t;
}

/** The app's description: description + personality, without repeats. */
function join(...parts) {
    const seen = new Set();
    return parts.map(x => String(x || '').trim()).filter(x => x && !seen.has(x) && seen.add(x)).join('\n\n');
}
/** What the update check compares (the app's fields). */
function fieldsOf(d) {
    d = d || {};
    return {
        description: join(d.description, d.personality),
        firstMessage: String(d.first_mes || ''),
        scenario: String(d.scenario || ''),
        mesExample: String(d.mes_example || ''),
        systemPrompt: String(d.system_prompt || ''),
        altGreetings: Array.isArray(d.alternate_greetings) ? d.alternate_greetings.filter(Boolean).map(String) : [],
        characterBook: d.character_book || null,
    };
}

/** The scripts of a package as the files this extension keeps. */
async function scriptsOf(card, file) {
    const risu = card && card.extensions && card.extensions.risuai;
    let mod = null;
    try {
        const b = await file('module.risum');
        if (b && b.size) mod = R.moduleData(R.readRisum(await b.arrayBuffer()));
    } catch (e) { dd.warn('module.risum', e); }
    return {
        risu: risu && typeof risu === 'object' ? JSON.stringify(risu) : '',
        module: mod ? JSON.stringify(mod) : '',
        info: mod ? { regex: mod.regex.length, triggers: mod.trigger.length,
            lua: mod.trigger.some(t => t && t.effect && t.effect[0] && t.effect[0].type === 'triggerlua') } : null,
    };
}

async function readText(folder, name) {
    const b = await folder.get(name);
    return b ? await b.text() : '';
}

/** importer.js: a card that came as a package remembers its size and fields
 *  (the first update check then needs no download when nothing changed). */
async function rememberPackage(charId, source, originId, size, card) {
    if (source !== 'risurealm' || !size) return;
    await dd.store.char(charId).set('pkg', { size, fields: fieldsOf(card), t: Date.now() });
}

const EXTRA_KEY = 'scripts';
function extraOf(staged) {
    if (!staged) return [];
    const i = staged.info || {};
    return [{
        key: EXTRA_KEY,
        label: dd.t('upd_scripts_label'),
        info: i.regex != null ? dd.t('upd_scripts_info', { regex: i.regex, triggers: i.triggers }) : '',
        preview: dd.t(i.lua ? 'upd_scripts_preview_lua' : 'upd_scripts_preview'),
    }];
}

const handler = {
    async format(id) {
        return (await realType(id)) === 'charx' ? 'package' : null;
    },

    async update(char) {
        const id = char.originId;
        if (!id) return null;
        const st = dd.store.char(char.id);
        const pkg = await st.get('pkg');
        if (!pkg && (await realType(id)) !== 'charx') return null;      // a JSON card: the app's path
        const staged = await st.get('staged');
        let size = null;
        try { size = await dd.cards.packageSize('risurealm', id); } catch (e) { dd.warn('package size', e); }
        if (pkg && pkg.fields && size && size === pkg.size) return Object.assign({}, pkg.fields, { extra: extraOf(staged) });

        const p = await dd.cards.package('risurealm', id, { progress: true });
        const fields = fieldsOf(p.card);
        await st.set('pkg', { size: size || p.bytes, fields, t: Date.now() });

        const folder = dd.files.char(char.id);
        const now = await scriptsOf(p.card, p.file);
        const [risuNow, modNow] = await Promise.all([readText(folder, 'risuai.json'), readText(folder, 'module.json')]);
        const changed = (now.risu && now.risu !== risuNow) || (now.module && now.module !== modNow);
        let next = null;
        if (changed) {
            await folder.putMany([
                ...(now.risu ? [{ name: 'staged/risuai.json', data: now.risu, type: 'application/json' }] : []),
                ...(now.module ? [{ name: 'staged/module.json', data: now.module, type: 'application/json' }] : []),
            ]);
            next = { info: now.info, t: Date.now() };
        }
        await st.set('staged', next);
        return Object.assign({}, fields, { extra: extraOf(next) });
    },

    async apply(char, key) {
        if (key !== EXTRA_KEY) return;
        const st = dd.store.char(char.id);
        const folder = dd.files.char(char.id);
        const [risu, mod] = await Promise.all([readText(folder, 'staged/risuai.json'), readText(folder, 'staged/module.json')]);
        if (!risu && !mod) throw new Error(dd.t('upd_scripts_gone'));
        if (risu) await folder.put('risuai.json', risu, 'application/json');
        if (mod) await folder.put('module.json', mod, 'application/json');
        for (const n of ['staged/risuai.json', 'staged/module.json']) { try { await folder.del(n); } catch (e) { /* not there */ } }
        await st.set('staged', null);
        S.risuForget(char.id);
        dd.shared.display.reset();
        dd.render.refresh();
        dd.ui.toast(dd.t('toast_scripts_updated', { name: char.name }), 'success');
    },
};

dd.shared.source = { handler, rememberPackage };
