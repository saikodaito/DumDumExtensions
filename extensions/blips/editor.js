// Voice Blips: the "Blip voice" section in the character editor.
// Registered as the charEditor slot by main.js (dd.shared.editor).
//
// The fields ARE the state: saving reads them. With no adjustment at all the
// character has no stored voice. Adjustments survive "No blips": turning it
// back on restores the voice. Samples stay in memory while another mode is
// picked, so switching back does not lose the files.

const S = dd.shared.synth;
const C = dd.shared.codec;

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}
function icon(name, cls) {
    const i = document.createElement('i');
    i.setAttribute('data-lucide', name);
    i.className = cls || 'ddb-ico';
    return i;
}
const kb = b => (b / 1024).toFixed(1);

/** Letters that fall on each sample (the fixed map, so the user knows which
 *  file is the "a" and which is the "k"). */
function lettersOf(group, i, n) {
    const list = group === 'v' ? S.VOWELS_LAT : S.CONSONANTS_LAT;
    return list.split('').filter((_, k) => k % n === i).join(' ');
}

function render(root, ctx) {
    const cfg = dd.shared.cfg || {};
    const st = {
        mode: 'synth', before: 'synth',       // 'synth' | 'file' | 'off'; `before` = mode kept under "off"
        samples: { v: [], c: [] }, group: 'v', busy: false,
    };

    const details = el('details', 'ddb ddb-section');
    const summary = el('summary', 'ddb-summary');
    summary.append(icon('chevron-right', 'ddb-ico ddb-chev'), icon('audio-lines', 'ddb-ico ddb-accent'),
        el('span', 'ddb-title', dd.t('editor_title')));
    const summaryNote = el('span', 'ddb-note');
    summary.appendChild(summaryNote);
    details.appendChild(summary);
    details.appendChild(el('p', 'ddb-hint', dd.t('editor_hint')));

    // Modes, side by side, plus the test button.
    const modes = el('div', 'ddb-modes');
    modes.setAttribute('role', 'radiogroup');
    const modeBtns = {};
    for (const [m, ic] of [['synth', 'audio-waveform'], ['file', 'file-audio'], ['off', 'volume-x']]) {
        const b = el('button', 'cs-pill');
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.append(icon(ic), el('span', null, dd.t('mode_' + m)));
        b.addEventListener('click', () => setMode(m));
        modeBtns[m] = b;
        modes.appendChild(b);
    }
    const testBtn = el('button', 'dd-btn dd-btn--sm ddb-push');
    testBtn.type = 'button';
    testBtn.append(icon('play'), el('span', null, dd.t('test')));
    testBtn.addEventListener('click', runTest);
    modes.appendChild(testBtn);
    details.appendChild(modes);

    // Synthesized voice: preset picker.
    const synthBox = el('div', 'ddb-block');
    synthBox.appendChild(el('label', 'ddb-label', dd.t('editor_voice')));
    const select = el('select', 'ddb-select');
    const globalKey = S.PRESETS[cfg.preset] ? cfg.preset : 'default';
    const optGlobal = el('option', null, `${dd.t('opt_global')} (${dd.t('preset_' + globalKey)})`);
    optGlobal.value = 'global';
    select.appendChild(optGlobal);
    for (const k of Object.keys(S.PRESETS)) {
        const o = el('option', null, dd.t('preset_' + k));
        o.value = k;
        select.appendChild(o);
    }
    select.addEventListener('change', () => { ctx.markDirty(); paint(); });
    synthBox.appendChild(select);
    details.appendChild(synthBox);

    // Pitch, speed, variation.
    const sliders = el('div', 'ddb-sliders');
    const mkSlider = (key, min, max, step, value, fmt) => {
        const box = el('div');
        const top = el('div', 'ddb-row');
        top.append(el('label', 'ddb-label', dd.t(key)));
        const val = el('span', 'ddb-mono');
        top.appendChild(val);
        const input = el('input', 'ddb-range');
        input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = value;
        input.addEventListener('input', () => { ctx.markDirty(); paint(); });
        box.append(top, input);
        sliders.appendChild(box);
        return { input, val, fmt };
    };
    const pitch = mkSlider('pitch', 50, 200, 5, 100, v => (v / 100).toFixed(2) + '×');
    const speed = mkSlider('speed', 50, 200, 10, 100, v => (v / 100).toFixed(1) + '×');
    const vari = mkSlider('variation', 0, 100, 5, 50, v => v + '%');
    details.appendChild(sliders);

    // My own sounds: vowels x consonants, up to 8 each, 160 KB total.
    const filesBox = el('div', 'ddb-block ddb-files');
    filesBox.appendChild(el('p', 'ddb-hint', dd.t('files_hint')));
    const grid = el('div', 'ddb-groups');
    const groups = {};
    for (const g of ['v', 'c']) {
        const card = el('div', 'ddb-group');
        const head = el('div', 'ddb-row');
        head.appendChild(el('span', 'ddb-group-title', dd.t(g === 'v' ? 'group_vowels' : 'group_consonants')));
        const count = el('span', 'ddb-mono');
        head.appendChild(count);
        const list = el('div', 'ddb-list');
        const add = el('button', 'dd-btn dd-btn--sm ddb-add');
        add.type = 'button';
        const addLabel = el('span', null, dd.t('add'));
        add.append(icon('plus'), addLabel);
        add.addEventListener('click', () => { if (st.busy) return; st.group = g; fileInput.click(); });
        card.append(head, list, add);
        grid.appendChild(card);
        groups[g] = { list, count, add, addLabel };
    }
    filesBox.appendChild(grid);
    const total = el('p', 'ddb-mono ddb-total');
    filesBox.appendChild(total);
    // accept="*/*": Android greys out extensions it does not know; the real
    // filter is decodeAudioData.
    const fileInput = el('input');
    fileInput.type = 'file'; fileInput.multiple = true; fileInput.accept = '*/*'; fileInput.hidden = true;
    fileInput.addEventListener('change', () => onFiles(fileInput));
    filesBox.appendChild(fileInput);
    details.appendChild(filesBox);
    root.appendChild(details);

    function readFields() {
        const b = {};
        if (st.mode === 'off') b.off = true;
        const mode = st.mode === 'off' ? st.before : st.mode;
        if (mode === 'file') b.preset = 'file';
        else if (S.PRESETS[select.value]) b.preset = select.value;
        const p = Number(pitch.input.value) / 100, sp = Number(speed.input.value) / 100, va = Number(vari.input.value) / 100;
        if (p !== 1) b.pitch = p;
        if (sp !== 1) b.speed = sp;
        if (va !== 0.5) b.vari = va;
        if (st.samples.v.length || st.samples.c.length) b.samples = { v: st.samples.v.slice(), c: st.samples.c.slice() };
        return Object.keys(b).length ? b : null;
    }
    function setMode(m) {
        if (m !== 'off') st.before = m;
        if (m === st.mode) return;
        st.mode = m;
        ctx.markDirty();
        paint();
    }
    function paint() {
        const off = st.mode === 'off';
        for (const [m, b] of Object.entries(modeBtns)) {
            const on = m === st.mode;
            b.classList.toggle('on', on);
            b.setAttribute('aria-checked', on ? 'true' : 'false');
        }
        for (const s of [pitch, speed, vari]) { s.val.textContent = s.fmt(Number(s.input.value)); s.input.disabled = off; }
        sliders.classList.toggle('ddb-dim', off);
        testBtn.disabled = off;
        synthBox.hidden = st.mode !== 'synth';
        filesBox.hidden = st.mode !== 'file';
        const opt = select.options[select.selectedIndex];
        summaryNote.textContent = st.mode === 'synth' ? (opt ? opt.textContent : '') : dd.t('mode_' + st.mode);
        if (st.mode === 'file') paintFiles();
    }
    function paintFiles() {
        for (const g of ['v', 'c']) {
            const arr = st.samples[g], G = groups[g];
            G.list.textContent = '';
            if (!arr.length) G.list.appendChild(el('p', 'ddb-hint', dd.t('files_empty')));
            arr.forEach((u, i) => {
                const row = el('div', 'ddb-item');
                const play = el('button', 'dd-btn dd-btn--sm');
                play.type = 'button'; play.title = dd.t('listen'); play.appendChild(icon('play'));
                play.addEventListener('click', () => listen(g, i));
                const letters = el('span', 'ddb-mono ddb-grow', lettersOf(g, i, arr.length));
                const dur = el('span', 'ddb-mono ddb-dimtext');
                const size = el('span', 'ddb-mono ddb-dimtext', kb(u.length) + ' KB');
                const rm = el('button', 'dd-btn dd-btn--sm');
                rm.type = 'button'; rm.title = dd.t('remove'); rm.appendChild(icon('x'));
                rm.addEventListener('click', () => { if (st.busy) return; st.samples[g].splice(i, 1); ctx.markDirty(); paintFiles(); });
                row.append(play, letters, dur, size, rm);
                G.list.appendChild(row);
                // Duration comes from the decode itself (the same cache as the player).
                Promise.resolve(dd.shared.player.load(u)).then(e => {
                    if (e && e.buf) dur.textContent = Math.round((e.buf.duration - e.off) * 1000) + ' ms';
                }).catch(() => {});
            });
            G.count.textContent = arr.length + '/' + C.MAX_ITEMS;
            G.add.disabled = st.busy || arr.length >= C.MAX_ITEMS;
            G.addLabel.textContent = dd.t(st.busy && st.group === g ? 'compressing' : 'add');
        }
        total.textContent = dd.t('files_total', { kb: kb(C.voiceBytes(st.samples)), max: String(C.MAX_BYTES / 1024) });
        dd.ui.icons(filesBox);
    }
    /** Files picked: one at a time. */
    async function onFiles(input) {
        const files = Array.from(input.files || []);
        input.value = '';
        if (!files.length || st.busy) return;
        const g = st.group;
        st.busy = true;
        paintFiles();
        try {
            for (const f of files) {
                if (st.samples[g].length >= C.MAX_ITEMS) { dd.ui.toast(dd.t('files_full'), 'warning'); break; }
                let r;
                try { r = await C.compress(f); }
                catch (e) { dd.ui.toast(dd.t('files_error', { n: f.name }), 'error'); continue; }
                const left = C.MAX_BYTES - C.voiceBytes(st.samples);
                if (r.bytes > left) {
                    dd.ui.toast(dd.t('files_cap', { kb: kb(Math.max(0, left)), max: String(C.MAX_BYTES / 1024) }), 'warning');
                    continue;
                }
                st.samples[g].push(r.uri);
                ctx.markDirty();
                paintFiles();
            }
        } finally {
            st.busy = false;
            paintFiles();
        }
    }
    /** Test button: plays with the values on screen, not saved yet. */
    async function runTest() {
        const b = readFields() || {};
        if (b.off) return;
        const voice = S.resolveVoice(b, dd.shared.cfg);
        // File voice: wait for the decode, or the start of the test would use
        // the fallback synthesis.
        if (voice.files) { try { await Promise.all([...voice.files.v, ...voice.files.c].map(u => dd.shared.player.load(u))); } catch (e) { /* ignored */ } }
        dd.shared.player.test(voice);
    }
    /** One sample on its own, with the pitch on screen. */
    function listen(g, i) {
        const u = st.samples[g] && st.samples[g][i];
        if (!u) return;
        const b = readFields() || {};
        const voice = S.resolveVoice(Object.assign({}, b, { off: false, preset: 'file', samples: { v: g === 'v' ? [u] : [], c: g === 'c' ? [u] : [] } }), dd.shared.cfg);
        Promise.resolve(dd.shared.player.load(u)).then(() => {
            const ac = dd.shared.player.ctx();
            if (ac) dd.shared.player.playFile(ac, voice, 'q', { c: g, k: 0 }, null);
        });
    }

    // Load what is stored for this character (the fields fill in when it arrives).
    const fill = saved => {
        const b = (saved && typeof saved === 'object') ? saved : {};
        const sm = b.samples && typeof b.samples === 'object' ? b.samples : {};
        st.samples = { v: Array.isArray(sm.v) ? sm.v.slice() : [], c: Array.isArray(sm.c) ? sm.c.slice() : [] };
        st.before = b.preset === 'file' ? 'file' : 'synth';
        st.mode = b.off ? 'off' : st.before;
        select.value = S.PRESETS[b.preset] ? b.preset : 'global';
        const v = S.resolveVoice(Object.assign({}, b, { off: false }), {});
        // resolveVoice multiplies by the global speed: here it is only the character's own.
        const sp = Number(b.speed);
        speed.input.value = Math.round((isFinite(sp) && b.speed != null ? Math.min(2, Math.max(0.5, sp)) : 1) * 100);
        pitch.input.value = Math.round(v.pitch * 100);
        vari.input.value = Math.round(v.vari * 100);
        paint();
    };
    fill(null);
    if (ctx.charId) dd.store.char(ctx.charId).get('voice').then(fill).catch(() => {});

    return { read: readFields };
}

dd.shared.editor = { render };
