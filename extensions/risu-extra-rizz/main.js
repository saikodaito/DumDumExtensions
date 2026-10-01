// Risu's extra Rizz: wiring and the settings page.
// store.js (library) → vars.js (chat variables) → risum.js (.charx modules) →
// engine.js (RisuAI's CBS and regex, ported) → display.js (messages) →
// importer.js (char.imported) → render.js (chat) → scene.js (background,
// music) → scripts.js (prompt, input, output) → prompt.js (image
// instruction) → editor.js → this file.

const S = dd.shared.store;
const V = dd.shared.vars;
const D = dd.shared.display;
const SC = dd.shared.scene;
const DEFAULTS = { chat: true, cache: true, prompt: 'auto', scripts: true };
dd.shared.cfg = Object.assign({}, DEFAULTS);
const offs = [];
let editorHandle = null;

dd.onActivate(async () => {
    const saved = await dd.store.get('cfg');
    if (saved && typeof saved === 'object') Object.assign(dd.shared.cfg, saved);

    offs.push(dd.on('char.imported', dd.shared.importer.onImported));
    // RisuRealm packages: import, preview and update through the .charx (source.js).
    if (dd.cards && dd.cards.source) offs.push(dd.cards.source('risurealm', dd.shared.source.handler));
    offs.push(dd.on('char.deleted', e => S.forget(e.charId)));      // the app already cleared the folder
    offs.push(dd.on('chat.deleted', e => { V.drop(e.chatId); D.drop(e.chatId); SC.clear(e.chatId); }));
    offs.push(dd.on('data.imported', () => { S.dropAll(); V.clear(); D.reset(); dd.render.refresh(); }));
    offs.push(dd.on('audio.stopped', e => SC.onStopped(e)));
    offs.push(dd.render.text(dd.shared.render.render));
    offs.push(dd.prompt.inject(dd.shared.prompt.inject));
    // The card's scripts on the way to the model (scripts.js). API 2.1: apps
    // without these hooks just skip them.
    const SCR = dd.shared.scripts;
    if (dd.prompt.fields) offs.push(dd.prompt.fields(SCR.fields));
    if (dd.prompt.history) offs.push(dd.prompt.history(SCR.history));
    offs.push(dd.prompt.transform(SCR.output));
    if (dd.input && dd.input.transform) offs.push(dd.input.transform(SCR.input));
    // Triggers (triggers.js): after a reply, and the card's buttons.
    const TR = dd.shared.triggers;
    offs.push(dd.on('reply.end', e => { TR.onReply(e); }));
    offs.push(dd.on('reply.full', e => { TR.onReply(e); }));
    if (dd.render.click) {
        offs.push(dd.render.click('[data-risu-trigger]', TR.onClick));
        offs.push(dd.render.click('[data-risu-btn]', TR.onLuaClick));
    }
    offs.push(D.onSig((chatId, charId) => SC.update(chatId, charId)));
    offs.push(dd.ui.slot('charEditor', {
        render(el, ctx) { editorHandle = dd.shared.editor.render(el, ctx); },
        async onSave(ctx) { if (editorHandle) await editorHandle.save(ctx.charId); },
        onClose() { if (editorHandle) editorHandle.close(); editorHandle = null; },
    }));
    // The open chat, ahead of the first render.
    const chat = dd.state.chat();
    if (chat && chat.charId) opened(chat.id, chat.charId);
    offs.push(dd.on('chat.opened', e => opened(e.chatId, e.charId)));

    dd.ui.settings(renderSettings);
});

/** A chat opened: load what its render needs, then draw it again. */
function opened(chatId, charId) {
    SC.onChat(chatId);
    if (!charId) return;
    // Low level access: asked here, never in the middle of a send (triggers.js).
    dd.shared.triggers.askLowLevel(charId).catch(() => {});
    Promise.all([S.load(charId), S.risuLoad(charId), V.load(chatId)])
        .then(([lib, risu]) => {
            if (lib || risu) dd.render.refresh();
            SC.update(chatId, charId);
        })
        .catch(e => dd.warn('open', e));
}

dd.onDeactivate(() => {
    offs.splice(0).forEach(off => { try { off(); } catch (e) { /* already gone */ } });
    if (editorHandle) editorHandle.close();
    editorHandle = null;
    SC.stop();
    D.stop();
    V.clear();
    S.dropAll();
});

function setCfg(k, v) {
    dd.shared.cfg[k] = v;
    dd.store.set('cfg', Object.assign({}, dd.shared.cfg));
}

async function renderSettings(el) {
    const sec = dd.ui.section({ title: { t: 'settings_title' }, icon: 'images' });
    sec.appendChild(dd.ui.toggle({
        label: { t: 'lbl_scripts' }, desc: { t: 'desc_scripts' }, value: dd.shared.cfg.scripts,
        onChange: v => {
            setCfg('scripts', v);
            D.reset();
            const chat = dd.state.chat();
            if (chat) { if (v) SC.update(chat.id, chat.charId); else SC.stop(); }
            dd.render.refresh();
        },
    }));
    sec.appendChild(dd.ui.toggle({
        label: { t: 'lbl_chat' }, desc: { t: 'desc_chat' }, value: dd.shared.cfg.chat,
        onChange: v => {
            setCfg('chat', v);
            const chat = dd.state.chat();
            if (chat) SC.update(chat.id, chat.charId);
            dd.render.refresh();
        },
    }));
    sec.appendChild(dd.ui.toggle({
        label: { t: 'lbl_cache' }, desc: { t: 'desc_cache' }, value: dd.shared.cfg.cache,
        onChange: v => setCfg('cache', v),
    }));
    sec.appendChild(dd.ui.select({
        label: { t: 'lbl_prompt' }, desc: { t: 'desc_prompt' },
        options: ['auto', 'always', 'off'].map(v => ({ value: v, label: { t: 'opt_prompt_' + v } })),
        value: dd.shared.cfg.prompt,
        onChange: v => setCfg('prompt', v),
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
