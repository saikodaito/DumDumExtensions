// Voice Blips: wiring. Settings page, reply events and the character editor slot.
// Loaded last (see manifest.scripts): synth, codec, engine and editor are in dd.shared.

const S = dd.shared.synth;
const player = dd.shared.player;

const DEFAULTS = { enabled: true, preset: 'default', speed: 1, narration: false, volume: 60 };
const cfg = dd.shared.cfg = Object.assign({}, DEFAULTS);
const voices = new Map();   // charId → stored voice (null = none), filled on demand
const offs = [];
let editorHandle = null;
let replySeq = 0;

async function voiceFor(charId) {
    if (!charId) return S.resolveVoice(null, cfg);
    if (!voices.has(charId)) {
        let saved = null;
        try { saved = await dd.store.char(charId).get('voice'); } catch (e) { /* no voice */ }
        voices.set(charId, saved);
    }
    return S.resolveVoice(voices.get(charId), cfg);
}
function applyVolume() {
    dd.audio.output('voice').gain.value = Math.max(0, Math.min(1, (Number(cfg.volume) || 0) / 100));
}
function saveCfg(key, value) {
    cfg[key] = value;
    return dd.store.set('cfg', Object.assign({}, cfg));
}
const testDefault = () => player.test(S.resolveVoice(null, cfg));

dd.onActivate(async () => {
    Object.assign(cfg, DEFAULTS, (await dd.store.get('cfg')) || {});
    applyVolume();

    // Streamed reply.
    offs.push(dd.on('reply.start', async d => {
        const mine = ++replySeq;
        player.stop();
        // TTS wins: a reply the automatic TTS is going to read has no blips.
        if (!cfg.enabled || d.ttsWillRead) return;
        const voice = await voiceFor(d.charId);
        // The reply may have ended (or another started) while the voice loaded.
        if (mine !== replySeq || !voice) return;
        player.start({ voice, text: d.text, since: d.since, chatId: d.chatId });
    }));
    offs.push(dd.on('reply.end', d => {
        replySeq++;
        player.end({ aborted: !!d.aborted });
    }));
    // Streaming off.
    offs.push(dd.on('reply.full', async d => {
        if (!cfg.enabled || d.ttsWillRead) return;
        const voice = await voiceFor(d.charId);
        if (voice) player.burst(d.text, voice, { chatId: d.chatId });
    }));
    offs.push(dd.on('char.deleted', d => { voices.delete(d.charId); }));

    // The character's custom voice, in the character editor.
    offs.push(dd.ui.slot('charEditor', {
        render(el, ctx) { editorHandle = dd.shared.editor.render(el, ctx); },
        async onSave(ctx) {
            if (!editorHandle || !ctx.charId) return;
            const v = editorHandle.read();
            voices.set(ctx.charId, v);
            if (v) await dd.store.char(ctx.charId).set('voice', v);
            else await dd.store.char(ctx.charId).del('voice');
        },
        onClose() { editorHandle = null; },
    }));

    dd.ui.settings(renderSettings);
});

// Turning it off without a restart makes every listener go away.
dd.onDeactivate(() => {
    offs.splice(0).forEach(off => { try { off(); } catch (e) { /* already gone */ } });
    player.stop();
    editorHandle = null;
});

function renderSettings(el) {
    const sec = dd.ui.section({ title: { t: 'settings_title' }, icon: 'audio-lines' });
    sec.appendChild(dd.ui.toggle({
        label: { t: 'lbl_enabled' }, desc: { t: 'desc_enabled' }, value: cfg.enabled,
        onChange: v => { saveCfg('enabled', v); if (!v) player.stop(); },
    }));
    const voiceRow = dd.ui.select({
        label: { t: 'lbl_default_voice' }, desc: { t: 'desc_default_voice' },
        options: Object.keys(S.PRESETS).map(k => ({ value: k, label: { t: 'preset_' + k } })),
        value: S.PRESETS[cfg.preset] ? cfg.preset : 'default',
        onChange: v => { saveCfg('preset', v); testDefault(); },
    });
    // The test button sits next to the picker.
    const pickWrap = document.createElement('div');
    pickWrap.style.cssText = 'display:flex;align-items:center;gap:.5rem;flex-shrink:0';
    pickWrap.append(voiceRow.input, dd.ui.button({ icon: 'play', size: 'sm', onClick: testDefault }));
    voiceRow.appendChild(pickWrap);
    sec.appendChild(voiceRow);
    sec.appendChild(dd.ui.slider({
        label: { t: 'lbl_volume' }, min: 0, max: 100, value: cfg.volume, format: v => v + '%',
        onInput: v => { cfg.volume = v; applyVolume(); },
        onChange: v => { saveCfg('volume', v); testDefault(); },
    }));
    sec.appendChild(dd.ui.slider({
        label: { t: 'lbl_speed' }, min: 50, max: 200, step: 10, value: Math.round((Number(cfg.speed) || 1) * 100),
        format: v => (v / 100).toFixed(1) + '×',
        onChange: v => { saveCfg('speed', v / 100); testDefault(); },
    }));
    sec.appendChild(dd.ui.toggle({
        label: { t: 'lbl_narration' }, desc: { t: 'desc_narration' }, value: cfg.narration,
        onChange: v => saveCfg('narration', v),
    }));
    sec.appendChild(dd.ui.hint({ t: 'hint_per_char' }));
    el.appendChild(sec);
}
