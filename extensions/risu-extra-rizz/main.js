// Risu's extra Rizz: wiring and the settings page.
// store.js (library) → importer.js (char.imported) → render.js (chat) →
// editor.js (character editor) → this file.

const S = dd.shared.store;
const DEFAULTS = { chat: true, cache: true };
dd.shared.cfg = Object.assign({}, DEFAULTS);
const offs = [];
let editorHandle = null;

dd.onActivate(async () => {
    const saved = await dd.store.get('cfg');
    if (saved && typeof saved === 'object') Object.assign(dd.shared.cfg, saved);

    offs.push(dd.on('char.imported', dd.shared.importer.onImported));
    offs.push(dd.on('char.deleted', e => S.forget(e.charId)));      // the app already cleared the folder
    offs.push(dd.on('data.imported', () => { S.dropAll(); dd.render.refresh(); }));
    offs.push(dd.render.text(dd.shared.render.render));
    offs.push(dd.ui.slot('charEditor', {
        render(el, ctx) { editorHandle = dd.shared.editor.render(el, ctx); },
        async onSave(ctx) { if (editorHandle) await editorHandle.save(ctx.charId); },
        onClose() { if (editorHandle) editorHandle.close(); editorHandle = null; },
    }));
    // The open chat's character, ahead of the first render.
    const chat = dd.state.chat();
    if (chat && chat.charId) S.load(chat.charId).then(l => { if (l) dd.render.refresh(); }).catch(() => {});
    offs.push(dd.on('chat.opened', e => { if (e.charId) S.get(e.charId); }));

    dd.ui.settings(renderSettings);
});

dd.onDeactivate(() => {
    offs.splice(0).forEach(off => { try { off(); } catch (e) { /* already gone */ } });
    if (editorHandle) editorHandle.close();
    editorHandle = null;
    S.dropAll();
});

function setCfg(k, v) {
    dd.shared.cfg[k] = v;
    dd.store.set('cfg', Object.assign({}, dd.shared.cfg));
}

async function renderSettings(el) {
    const sec = dd.ui.section({ title: { t: 'settings_title' }, icon: 'images' });
    sec.appendChild(dd.ui.toggle({
        label: { t: 'lbl_chat' }, desc: { t: 'desc_chat' }, value: dd.shared.cfg.chat,
        onChange: v => { setCfg('chat', v); dd.render.refresh(); },
    }));
    sec.appendChild(dd.ui.toggle({
        label: { t: 'lbl_cache' }, desc: { t: 'desc_cache' }, value: dd.shared.cfg.cache,
        onChange: v => setCfg('cache', v),
    }));
    el.appendChild(sec);

    const use = dd.ui.section({ title: { t: 'usage_title' }, icon: 'hard-drive' });
    const line = dd.ui.hint('');
    use.appendChild(line);
    use.appendChild(dd.ui.hint({ t: 'usage_hint' }));
    el.appendChild(use);
    const u = await dd.files.usage();
    line.textContent = dd.t('usage', { f: u.files, n: u.chars, mb: (u.bytes / 1048576).toFixed(1) });
}
