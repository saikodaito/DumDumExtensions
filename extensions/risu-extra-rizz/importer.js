// Risu's extra Rizz: what a card brings on import.
//
// RisuAI cards do "expressions" with assets of type x-risu-asset (plus a
// lorebook instruction for the model to write <img="Name_emotion"> and a card
// regex that swaps the mark for the image). The app import ignores them; here
// they become the character's library.
//  - RisuRealm JSON cards: assets are risustored:<hash> on the CDN. Only the
//    name → URL map is kept; the images are downloaded when they first show
//    up in the chat (or all at once from the character editor).
//  - .charx and PNG cards: assets are embedded (embeded://path). file() only
//    works during this handler, so the bytes are stored now. From 10 MB on the
//    user is asked first.

const S = dd.shared.store;
const TYPES = new Set(['x-risu-asset', 'emotion']);
const ASK_BYTES = 10 * 1024 * 1024;     // 10 MB (lowered from 50 MB in 0.2.0)
const mb = b => (b / 1048576).toFixed(1);
const MARK = /<img\s*=|\{\{(img|image|asset|emotion)::/i;

/** The card already tells the model how to write the image marks (lorebook,
 *  description, system prompt...). The greeting does not count: a mark there
 *  is an example of the result, not an instruction. */
function hasOwnInstruction(card) {
    const d = card || {};
    const texts = [d.description, d.personality, d.scenario, d.system_prompt, d.post_history_instructions, d.mes_example];
    const book = d.character_book && Array.isArray(d.character_book.entries) ? d.character_book.entries : [];
    book.forEach(e => texts.push(e && e.content));
    return texts.some(t => typeof t === 'string' && MARK.test(t));
}

async function onImported({ charId, source, card, file, done }) {
    const raw = (card && Array.isArray(card.assets) ? card.assets : [])
        .filter(a => a && TYPES.has(String(a.type || '').toLowerCase()));
    const risu = card && card.extensions && card.extensions.risuai;
    if (!raw.length && !risu) return;
    // The import goes on now; file() keeps working while this handler runs.
    done();

    const folder = dd.files.char(charId);
    if (risu && typeof risu === 'object') {
        try { await folder.put('risuai.json', JSON.stringify(risu), 'application/json'); }
        catch (e) { dd.warn('risuai.json', e); }
        S.risuForget(charId);
    }
    if (!raw.length) return;

    const items = [], embedded = [];
    for (const a of raw) {
        const name = String(a.name || '').trim();
        const uri = String(a.uri || '').trim();
        if (!name || !uri) continue;
        const it = { name, ext: S.extOf(name, a.ext), type: String(a.type).toLowerCase(), url: '', file: '' };
        if (/^risustored:/i.test(uri)) it.url = S.CDN + encodeURIComponent(uri.slice('risustored:'.length));
        else if (/^https?:\/\//i.test(uri)) it.url = uri;
        else if (/^embed?ded:\/\//i.test(uri) || /^data:/i.test(uri)) embedded.push({ it, uri });
        else continue;
        items.push(it);
    }
    if (!items.length) return;

    let stored = 0, skipped = 0;
    if (embedded.length) {
        if (embedded.length > 40) dd.ui.toast(dd.t('toast_reading', { n: embedded.length }), 'info');
        const got = [];
        let total = 0;
        let k = 0;
        for (const e of embedded) {
            // Give the screen a turn now and then: thousands of awaited reads in a
            // row never leave the microtask queue, so nothing repaints.
            if (++k % 25 === 0) await new Promise(r => setTimeout(r, 0));
            let b = null;
            try { b = /^data:/i.test(e.uri) ? await (await dd.net.fetch(e.uri)).blob() : await file(e.uri); }
            catch (x) { dd.warn('asset', e.it.name, x); }
            if (b && b.size) { got.push({ it: e.it, b }); total += b.size; }
        }
        let keep = true;
        if (total >= ASK_BYTES) {
            keep = await dd.ui.confirm(dd.t('ask_big', { n: got.length, mb: mb(total), name: card.name || '' }),
                { ok: dd.t('ask_big_ok'), cancel: dd.t('ask_big_no') });
        }
        if (keep) {
            const used = new Set();
            const batch = got.map(({ it, b }) => {
                it.file = S.fileNameFor(it, used);
                const t = S.mimeOf(it.ext);
                return { name: 'a/' + it.file, data: b, type: t || b.type };
            });
            await folder.putMany(batch);
            stored = batch.length;
        } else skipped = got.length;
    }

    // What was not stored and has no URL cannot be shown: out of the index.
    const kept = items.filter(it => it.file || it.url);
    await S.writeIndex(charId, {
        v: 1, source, t: Date.now(), skipped, items: kept,
        ownInstruction: hasOwnInstruction(card),
        prebuilt: !!(risu && risu.prebuiltAssetCommand),
    });
    await S.invalidate(charId);

    const remote = kept.filter(it => !it.file).length;
    if (stored || remote) dd.ui.toast(dd.t('toast_imported', { n: kept.length, stored, remote }), 'success');
    if (skipped) dd.ui.toast(dd.t('toast_skipped', { n: skipped }), 'warning');
}

dd.shared.importer = { onImported };
