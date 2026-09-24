// Voice Blips: the player. Exposed as dd.shared.player.
//
// THE TEXT DOES NOT CHANGE PACE. A voice cursor of its own walks the raw text
// at the voice speed, one blip every STEP letters, and catches up by skipping
// when it falls more than ~1 s behind. setTimeout loop, not
// requestAnimationFrame: rAF stops while the window is hidden.
// Speech ("...") = the character's voice; action (*...*) = the same voice,
// lower and muffled; silent by default.

const S = dd.shared.synth;
const STEP = 2;      // one blip every 2 letters
const CPS = 30;      // letters per second at 1x speed

const player = {
    session: null, timer: 0,
    buffers: new Map(),       // decoded samples, keyed by the data URI itself
    lastFile: null,           // the file sample playing now (they are monophonic)

    cfg() { return dd.shared.cfg || {}; },

    /** The shared AudioContext, or null while the page has not been touched yet. */
    ctx() {
        const ac = dd.audio.context();
        return ac && ac.state === 'running' ? ac : null;
    },

    /** One blip. seg 'q' | 'a' | 'n'; cls = letterClass(); mod = {pitch, gain} of the phrase. */
    play(voice, seg, cls, mod) {
        const ac = this.ctx();
        // Context still suspended: schedule nothing (it would pile up on the
        // stopped timeline and come out all at once later).
        if (!ac) return;
        if ((this.cfg().volume ?? 60) <= 0) return;
        // File voice (narration stays synthesized: it is the neutral tone).
        // Sample still decoding: this blip uses the fallback synthesis.
        if (voice.files && seg !== 'n' && this.playFile(ac, voice, seg, cls, mod)) return;
        const data = S.blipRender(S.blipSpec(voice, seg, cls, mod), ac.sampleRate);
        dd.audio.play(data, { output: 'voice', when: ac.currentTime + 0.005 });
    },

    load(uri) {
        const e = this.buffers.get(uri);
        if (e) return e;
        const ac = dd.audio.context();
        if (!ac) return null;
        if (this.buffers.size > 64) this.buffers.clear();
        const p = (async () => {
            const buf = await ac.decodeAudioData(dd.shared.codec.uriBytes(uri).buffer);
            // Some encoders start with a few ms of silence: skip to the first
            // sound, or the blip comes out late.
            const d = buf.getChannelData(0);
            let pk = 0; for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > pk) pk = v; }
            let i0 = 0; const thr = pk * 0.02; while (i0 < d.length && Math.abs(d[i0]) < thr) i0++;
            const entry = { buf, off: Math.max(0, i0 - 48) / buf.sampleRate };
            this.buffers.set(uri, entry);
            return entry;
        })().catch(() => { this.buffers.set(uri, 'error'); return null; });
        this.buffers.set(uri, p);
        return p;
    },
    preload(voice) {
        if (voice && voice.files) [...voice.files.v, ...voice.files.c].forEach(u => { try { this.load(u); } catch (e) { /* ignored */ } });
    },

    /** FIXED sample per letter: the letter's stable index modulo the group
     *  size; an empty group falls back to the other one. false = did not play
     *  (still decoding or failed): the caller uses the synthesis. */
    playFile(ac, voice, seg, cls, mod) {
        const F = voice.files, cons = !!(cls && cls.c === 'c');
        let pool = cons ? F.c : F.v;
        if (!pool || !pool.length) pool = cons ? F.v : F.c;
        if (!pool || !pool.length) return false;
        const k = cls ? cls.k : 0;
        const uri = pool[((k % pool.length) + pool.length) % pool.length];
        const entry = this.buffers.get(uri);
        if (!entry || entry === 'error' || typeof entry.then === 'function') { if (!entry) this.load(uri); return false; }
        const action = seg === 'a';
        const src = ac.createBufferSource();
        src.buffer = entry.buf;
        const rate = voice.pitch * (1 + (Math.random() * 2 - 1) * 0.05 * (voice.vari * 2)) * ((mod && mod.pitch) || 1) * (action ? 0.85 : 1);
        src.playbackRate.value = Math.min(4, Math.max(0.25, rate));
        const g = ac.createGain();
        g.gain.value = ((mod && mod.gain) || 1) * (action ? 0.8 : 1);
        src.connect(g);
        let last = g;
        if (action) { const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1200; g.connect(lp); last = lp; }
        last.connect(dd.audio.output('voice'));
        const t0 = ac.currentTime + 0.005;
        // Monophonic: samples of up to 0.5 s would pile up. The previous one
        // leaves with a ~5 ms fade (a hard cut clicks).
        const prev = this.lastFile;
        if (prev) { try { prev.g.gain.setTargetAtTime(0, t0, 0.0015); prev.src.stop(t0 + 0.01); } catch (e) { /* already stopped */ } }
        this.lastFile = { src, g };
        src.start(t0, entry.off);
        return true;
    },

    /** Starts speaking a growing text. o = {voice, text: () => string, since,
     *  chatId, force, noCatchUp}. `since` = what already existed (prefill,
     *  continued message): scanned silently, only to inherit the state of
     *  quotes and asterisks. */
    start(o) {
        this.stop();
        if (!o || typeof o.text !== 'function' || !o.voice) return;
        if (!o.force && !this.cfg().enabled) return;
        this.preload(o.voice);
        let tags = [];
        try { tags = (dd.state.reasoningTags() || []).filter(x => x && x.open && x.close); } catch (e) { /* none */ }
        const st = S.newScan();
        st.look = Math.max(8, ...tags.map(x => x.open.length + 1));
        const since = Math.max(0, o.since | 0);
        if (since) {
            const txt = String(o.text() || '');
            while (st.i < since && S.scanStep(st, txt, tags, true)) { /* silent catch-up */ }
        }
        this.session = {
            voice: o.voice, st, tags, text: o.text,
            chatId: o.chatId !== undefined ? o.chatId : dd.state.activeChatId(),
            force: !!o.force, noCatchUp: !!o.noCatchUp,
            done: false, doneUntil: 0, last: '', count: 0, phrase: '', phraseIdx: -1,
        };
        this.schedule(0);
    },
    /** End of the stream: drains for up to ~1 s, then stops. aborted = stops now. */
    end(o) {
        const s = this.session; if (!s) return;
        if (o && o.aborted) { this.stop(); return; }
        if (!s.done) { s.done = true; s.doneUntil = performance.now() + 1000; }
    },
    stop() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = 0; this.session = null;
    },
    /** A reply that arrived whole: speaks only the start, at most 1.5 s. */
    burst(text, voice, o) {
        const txt = String(text || '');
        this.start(Object.assign({}, o || {}, { voice, text: () => txt, noCatchUp: true }));
        if (this.session) { this.session.done = true; this.session.doneUntil = performance.now() + 1500; }
    },
    /** Test button: plays even with blips off, outside any chat. */
    test(voice, text) {
        const txt = String(text || dd.t('test_line'));
        this.start({ voice, text: () => txt, force: true, noCatchUp: true, chatId: null });
        if (this.session) { this.session.done = true; this.session.doneUntil = performance.now() + 5000; }
    },

    schedule(ms) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.tick(), Math.max(0, ms));
    },
    canSound(s) {
        if (s.force) return true;
        if (!this.cfg().enabled) return false;
        if (dd.state.hidden()) return false;
        if (s.chatId !== dd.state.activeChatId()) return false;   // stream of another chat
        if (dd.state.ttsSpeaking()) return false;                 // TTS wins: no blips over the voice
        return true;
    },
    /** Pitch and strength of the phrase: rises before '?', stronger with '!'. */
    phraseMod(s, txt) {
        if (s.phraseIdx < s.st.i) {
            const rx = /[.!?…\n]/g; rx.lastIndex = s.st.i;
            const m = rx.exec(txt);
            s.phraseIdx = m ? m.index : -1; s.phrase = m ? m[0] : '';
        }
        const dist = s.phraseIdx - s.st.i;
        let pitch = 1, gain = 1;
        if (s.phrase === '?' && dist >= 0 && dist < 12) pitch = 1 + (12 - dist) / 12 * 0.25;
        if (s.phrase === '!') gain = 1.3;
        return { pitch, gain };
    },
    tick() {
        this.timer = 0;
        const s = this.session; if (!s) return;
        let txt = '';
        try { txt = String(s.text() || ''); } catch (e) { this.stop(); return; }
        if (s.done && performance.now() > s.doneUntil) { this.stop(); return; }
        const cps = CPS * s.voice.speed;
        // Catch-up: more than ~1 s behind, skip silently to ~0.3 s from the end.
        if (!s.noCatchUp) {
            const tail = s.done ? txt.length : txt.length - s.st.look;
            if (tail - s.st.i > cps) {
                const target = tail - Math.round(cps * 0.3);
                while (s.st.i < target && S.scanStep(s.st, txt, s.tags, s.done)) { /* skip */ }
                s.phraseIdx = -1; s.count = 0; s.last = '';
            }
        }
        const interval = 1000 * STEP / cps;
        let r;
        while ((r = S.scanStep(s.st, txt, s.tags, s.done))) {
            const ch = r.ch;
            if (!ch) continue;
            if (/\s/.test(ch)) {
                s.count = 0;
                if (s.last === 'l') { s.last = 's'; this.schedule(interval * 0.6); return; }
                continue;
            }
            if (/[.!?…,;:]/.test(ch)) {
                const long = ch !== ',' && ch !== ';' && ch !== ':';
                if (long) s.phraseIdx = -1;
                s.count = 0;
                if (s.last === 'l') { s.last = 'p'; this.schedule(long ? 250 : 120); return; }
                continue;
            }
            const cls = S.letterClass(ch);
            if (!cls) continue;
            // Silent narration walks without time, so the next speech comes
            // out together with the text that appears.
            if (r.seg === 'n' && !this.cfg().narration) { s.last = 'n'; s.count = 0; continue; }
            const nth = s.count++;
            s.last = 'l';
            if (nth % STEP !== 0) continue;
            if (this.canSound(s)) { try { this.play(s.voice, r.seg, cls, this.phraseMod(s, txt)); } catch (e) { /* one lost blip */ } }
            this.schedule(interval);
            return;
        }
        if (s.done && s.st.i >= txt.length) { this.stop(); return; }
        this.schedule(40);
    },
};

dd.shared.player = player;
