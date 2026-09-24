// Voice Blips: synthesis and text scanning. Pure functions, no app state.
// Exposed as dd.shared.synth for the other scripts (and for the tests).
//
// Each blip is RENDERED in JS into a short buffer (~2-8k samples) and played
// by a BufferSource. Two passes: (1) source + ring + filters while measuring
// the peak, (2) lo-fi / drive / envelope over the NORMALIZED signal. Without
// normalizing first, 4 bits would round a narrow band-pass down to zero.
// Extra parameters for "Flavoring":
//   pitched noise   sample-and-hold at rate 2f (the grain of chip noise channels);
//   chip age        bits + decimation (crush) + drive;
//   narrow pulse    12.5% / 25% duty (the NES nasal);
//   settle          rises fast then relaxes: a "ping", not a siren;
//   formants        two band-passes per vowel (Babble).
// Loudness comes out EQUAL across presets: pass 2 aims at a fixed RMS
// (capped by the peak) and the preset's `g` only adjusts on top of that.
//
// Preset fields: wave (square|saw|tri|sine|bell|noise), f, dur, a d s r curve,
// duty dutySweep, sweep (semitones) settle, vib vibRate, fmRatio fmDepth
// fmDecay, ringF ringMix, noiseMix, filt (lp|hp|bp) cutoff res, bits, crush,
// drive, j (jitter), spread (pitch per letter), g (relative gain),
// semi (pentatonic scale), gate (dry cut), formants, consF (consonant pitch
// multiplier), follow (the filter follows the pitch).

const PRESETS = {
    // Classic pulse, a bit lo-fi, drops pitch slightly.
    default: { wave: 'square', duty: 0.5, f: 440, dur: 0.060, a: 0.001, d: 0.025, s: 0.55, r: 0.02, curve: 1.6,
               sweep: -1, bits: 8, j: 0.05, spread: 0.03, g: 0.9 },
    // 25% pulse (nasal) with a ping that rises and settles.
    high:    { wave: 'square', duty: 0.25, f: 740, dur: 0.050, a: 0.001, d: 0.02, s: 0.5, r: 0.015,
               sweep: 2.5, settle: 0.5, bits: 7, j: 0.07, spread: 0.03, g: 0.85 },
    // Low triangle with breath and drive: a grumble.
    deep:    { wave: 'tri', f: 165, dur: 0.080, a: 0.002, d: 0.04, s: 0.6, r: 0.03, noiseMix: 0.06,
               filt: 'lp', cutoff: 1500, res: 1.2, drive: 0.35, j: 0.05, spread: 0.04, g: 1 },
    // Ring mod + resonant band-pass + 5 decimated bits + fast vibrato.
    robot:   { wave: 'square', duty: 0.4, f: 230, dur: 0.060, a: 0.001, d: 0.03, s: 0.7, r: 0.015,
               ringF: 3.1, ringMix: 0.45, filt: 'bp', cutoff: 1400, res: 3, bits: 5, crush: 3,
               vib: 0.03, vibRate: 28, j: 0, spread: 0.05, g: 0.9 },
    // Sine with a short FM and a ping: sparkle.
    cute:    { wave: 'sine', f: 880, dur: 0.055, a: 0.002, d: 0.03, s: 0.35, r: 0.02,
               fmRatio: 2, fmDepth: 1.2, fmDecay: 0.02, sweep: 3, settle: 0.6, j: 0.1, spread: 0.04, g: 0.95 },
    // Smooth noise through a band-pass that follows the pitch; soft attack.
    whisper: { wave: 'noise', f: 9000, dur: 0.055, a: 0.006, d: 0.03, s: 0.4, r: 0.02,
               filt: 'bp', cutoff: 2600, res: 1.4, follow: true, j: 0.12, spread: 0.05, g: 0.8 },
    // 12.5% pulse in 4 bits, pentatonic notes: chiptune.
    retro:   { wave: 'square', duty: 0.125, f: 520, dur: 0.045, a: 0.0008, d: 0.02, s: 0.6, r: 0.01,
               bits: 4, crush: 2, semi: true, j: 0, g: 0.85 },
    // Bell partials + FM, long tail.
    bell:    { wave: 'bell', f: 660, dur: 0.160, a: 0.0015, d: 0.05, s: 0.2, r: 0.1, curve: 2.2,
               fmRatio: 3.5, fmDepth: 1.5, fmDecay: 0.05, j: 0.03, spread: 0.03, g: 0.9 },
    // Static: the "tch" of Undertale/Deltarune dialogue. Pitched noise
    // (sample-and-hold) in 6 bits, dry 34 ms gate. The letter changes the
    // noise rate (grain) and consonants come out 2.2x brighter: that is what
    // makes the static "talk".
    static:  { wave: 'noise', f: 1400, dur: 0.034, a: 0.0006, d: 0.001, s: 1, r: 0.0015,
               bits: 6, crush: 2, filt: 'hp', cutoff: 300, res: 0.8, gate: true, consF: 2.2,
               j: 0.12, spread: 0.09, g: 0.85 },
    // Babble: sawtooth through two vowel formants (a e i o u sound
    // different); consonants become a high breath. Animal Crossing.
    babble:  { wave: 'saw', f: 170, dur: 0.070, a: 0.004, d: 0.03, s: 0.7, r: 0.025,
               formants: true, vib: 0.015, vibRate: 7, j: 0.06, spread: 0.02, g: 1 },
};
const NARRATION = { wave: 'sine', f: 300, dur: 0.050, a: 0.003, d: 0.03, s: 0.3, r: 0.015, j: 0.03, spread: 0.02, g: 1 };
// F1/F2 of a e i o u (Hz).
const FORMANTS = [[800, 1150], [400, 2000], [300, 2300], [500, 850], [330, 750]];

/** Parameters of ONE blip (plays nothing: testable). seg 'q' speech | 'a' action | 'n' narration. */
function blipSpec(voice, seg, cls, mod, rnd) {
    rnd = rnd || Math.random;
    const narr = seg === 'n', action = seg === 'a';
    const P = narr ? NARRATION : voice.p;
    const s = Object.assign({}, P);
    const cons = !!(cls && cls.c === 'c');
    let f = P.f * (narr ? 1 : voice.pitch);
    if (cls) {
        if (P.semi) f *= Math.pow(2, [0, 2, 4, 7, 9][cls.k % 5] / 12);   // retro: pentatonic
        else {
            const sp = P.spread || 0;
            f *= cons ? 1 + ((cls.k % 7) - 3) * sp : 1 + ((cls.k % 5) - 2) * sp;
        }
        if (cons && P.consF) f *= P.consF;
    }
    f *= 1 + (rnd() * 2 - 1) * (P.j || 0) * (voice.vari * 2);
    f *= (mod && mod.pitch) || 1;
    if (action) f *= 0.8;
    s.f = f;
    if (P.follow && P.cutoff) s.cutoff = P.cutoff * (f / P.f);
    s.dur = P.dur * (cons ? 0.6 : 1);
    // Consonant: a noise click at the start (the "t", the "k"). Noise is
    // already a click: Static and Whisper do not need it.
    if (cons && P.wave !== 'noise') s.click = 0.006;
    if (P.formants) {
        if (cons) { s.wave = 'noise'; s.f = 7000; s.filt = 'hp'; s.cutoff = 2200; s.res = 0.8; s.dur = P.dur * 0.5; s.click = 0; s.formants = null; }
        else s.formants = FORMANTS[((cls ? cls.k : 0) % 5 + 5) % 5];
    }
    if (action) {
        // Action: muffled. A low-pass on top of whatever the preset has.
        if (s.filt === 'lp') s.cutoff = Math.min(s.cutoff, 1200);
        else s.post = 1200;
    }
    s.g = (P.g || 1) * (narr ? 0.45 : 1) * (action ? 0.8 : 1) * ((mod && mod.gain) || 1);
    return s;
}

let bellTable = null;
function getBellTable() {
    if (!bellTable) {
        const T = 6.283185307179586, w = new Float32Array(2049);
        for (let i = 0; i <= 2048; i++) { const x = i / 2048; w[i] = (Math.sin(T * x) + 0.6 * Math.sin(T * 2.76 * x) + 0.4 * Math.sin(T * 5.4 * x) + 0.25 * Math.sin(T * 8.93 * x)) * 0.5; }
        bellTable = w;
    }
    return bellTable;
}

/** Renders a blip into a mono Float32Array. Two passes (see the top). */
function blipRender(p, sr) {
    const TAU = 6.283185307179586;
    const cl = (v, a, b) => v < a ? a : (v > b ? b : v);
    const dur = Math.max(0.008, p.dur);
    const n = Math.max(1, Math.floor(dur * sr));
    const out = new Float32Array(n);
    let a = Math.max(0.0006, p.a || 0.001), d = Math.max(0.0006, p.d || 0.03), r = Math.max(0.0015, p.r || 0.02);
    const need = a + d + r;
    if (need > dur) { const k = dur / need * 0.999; a *= k; d *= k; r *= k; }
    const relStart = dur - r, sus = p.s ?? 0.5, curve = p.curve || 1;
    const svf = (cut, res) => ({ fc: Math.min(0.88, 2 * Math.sin(Math.PI * cl(cut, 30, sr * 0.24) / sr)),
                                 q: cl(1 / Math.max(0.4, res || 0.8), 0.06, 2), lp: 0, bp: 0 });
    const F = p.filt ? svf(p.cutoff || 2000, p.res) : null;
    const PF = p.post ? svf(p.post, 0.9) : null;
    const FM = p.formants ? [Object.assign(svf(p.formants[0], 6), { g: 1 }), Object.assign(svf(p.formants[1], 6), { g: 0.6 })] : null;
    const isNoise = p.wave === 'noise';
    let ph = 0, mph = 0, rph = 0, nph = 0, nval = 0, pk = 0;
    const dt = 1 / sr, PEAK = 0.22, settle = cl(p.settle || 0, 0, 1);
    // Lookup tables keep pow/exp out of the per-sample loop.
    const LT = 256;
    let FRQ = null, ENVC = null;
    if (p.sweep) {
        FRQ = new Float32Array(LT + 1);
        for (let j = 0; j <= LT; j++) {
            const u = j / LT;
            const semis = settle > 0
                ? (u < PEAK ? p.sweep * (u / PEAK) : p.sweep * (1 - settle * (1 - Math.exp(-3.2 * (u - PEAK) / (1 - PEAK)))))
                : p.sweep * u;
            FRQ[j] = Math.pow(2, semis / 12);
        }
    }
    if (curve !== 1) { ENVC = new Float32Array(LT + 1); for (let j = 0; j <= LT; j++) ENVC[j] = Math.pow(j / LT, curve); }
    let FME = null;
    if (p.fmDepth) {
        const fmDec = Math.max(0.003, p.fmDecay || 0.05);
        FME = new Float32Array(LT + 1);
        for (let j = 0; j <= LT; j++) FME[j] = Math.exp(-(j / LT) * dur / fmDec) * p.fmDepth * 0.25;
    }
    // Bell: the 4 partials depend only on the phase, so it is a wavetable (cached).
    const BELL = p.wave === 'bell' ? getBellTable() : null;
    // Pass 1: source + ring + filters.
    for (let i = 0; i < n; i++) {
        const t = i * dt, u = t / dur;
        let f = p.f;
        if (FRQ) f *= FRQ[(u * LT) | 0];
        if (p.vib) f *= 1 + p.vib * Math.sin(TAU * (p.vibRate || 6) * t);
        f = cl(f, 0.5, sr * 0.48);
        let s;
        if (isNoise) {
            // Sample-and-hold: keeps each value for 1/(2f) s. That is what
            // gives the noise its pitch and grain.
            nph += f * 2 / sr;
            if (nph >= 1 || i === 0) { nph -= Math.floor(nph); nval = Math.random() * 2 - 1; }
            s = nval;
        } else {
            let x = ph += f * dt;
            if (FME) { mph += f * (p.fmRatio || 2) * dt; x += Math.sin(TAU * mph) * FME[(u * LT) | 0]; }
            x -= Math.floor(x);
            switch (p.wave) {
                case 'sine': s = Math.sin(TAU * x); break;
                case 'saw':  s = 2 * x - 1; break;
                case 'tri':  s = x < 0.5 ? 4 * x - 1 : 3 - 4 * x; break;
                case 'bell': s = BELL[(x * 2048) | 0]; break;
                default: { const du = p.dutySweep ? cl((p.duty ?? 0.5) + p.dutySweep * u, 0.02, 0.98) : (p.duty ?? 0.5); s = x < du ? 1 : -1; }
            }
        }
        if (p.noiseMix) s = s * (1 - p.noiseMix) + (Math.random() * 2 - 1) * p.noiseMix;
        if (p.click && t < p.click) s = s * 0.4 + (Math.random() * 2 - 1) * (1 - t / p.click);
        if (p.ringMix) { rph += (f * (p.ringF || 2)) / sr; s = s * (1 - p.ringMix) + s * Math.sin(TAU * rph) * p.ringMix; }
        if (FM) {
            let o = 0;
            for (const q of FM) { const hp = s - q.lp - q.q * q.bp; q.bp += q.fc * hp; q.lp += q.fc * q.bp; o += q.bp * q.g; }
            s = o;
        }
        if (F) {
            const hp = s - F.lp - F.q * F.bp; F.bp += F.fc * hp; F.lp += F.fc * F.bp;
            s = p.filt === 'lp' ? F.lp : (p.filt === 'hp' ? hp : F.bp);
        }
        if (PF) { const hp = s - PF.lp - PF.q * PF.bp; PF.bp += PF.fc * hp; PF.lp += PF.fc * PF.bp; s = PF.lp; }
        if (!(s > -4 && s < 4)) s = s > 0 ? 4 : (s < 0 ? -4 : 0);
        out[i] = s;
        const ab = s < 0 ? -s : s;
        if (ab > pk) pk = ab;
    }
    if (pk < 1e-7) return out.fill(0);
    // Pass 2: normalize, lo-fi, drive, envelope.
    const inv = 1 / pk;
    const crushN = Math.max(1, Math.round(p.crush || 1));
    const quant = p.bits && p.bits < 16 ? Math.pow(2, Math.max(2, p.bits) - 1) : 0;
    const driveAmt = 1 + (p.drive || 0) * 24, driveNorm = Math.tanh(driveAmt) || 1;
    const tail = p.gate ? 24 : 48;   // dry gate: cuts in 0.5 ms
    let hold = 0;
    for (let i = 0; i < n; i++) {
        const t = i * dt;
        let s = out[i] * inv;
        if (crushN > 1) { if (i % crushN === 0) hold = s; s = hold; }
        if (quant) s = Math.round(s * quant) / quant;
        if (p.drive) s = Math.tanh(s * driveAmt) / driveNorm;
        let e;
        if (t < a) e = t / a;
        else if (t < a + d) { const u = (t - a) / d; e = 1 + (sus - 1) * (ENVC ? ENVC[(u * LT) | 0] : u); }
        else if (t < relStart) e = sus;
        else { const u = 1 - (t - relStart) / r; e = u <= 0 ? 0 : sus * (ENVC ? ENVC[(u * LT) | 0] : u); }
        if (n - i < tail) e *= (n - i) / tail;
        out[i] = s * e;
    }
    // Loudness: aim at a fixed RMS measured AFTER the whole chain (drive
    // almost squares a triangle) and only over the attack window, the first
    // 25 ms, which is what the ear judges in a short sound. The peak caps the gain.
    const win = Math.min(n, Math.floor(0.025 * sr));
    let sq = 0, pk2 = 0;
    for (let i = 0; i < n; i++) { const v = out[i] < 0 ? -out[i] : out[i]; if (v > pk2) pk2 = v; if (i < win) sq += out[i] * out[i]; }
    const rms = Math.sqrt(sq / win);
    if (rms < 1e-6) return out.fill(0);
    const gain = Math.min(0.1 / rms, 0.9 / pk2) * (p.g || 1);
    for (let i = 0; i < n; i++) out[i] = cl(out[i] * gain, -1, 1);
    return out;
}

// Letter class: vowel or consonant, with a STABLE index per letter (the same
// letter always lands on the same sample: that is what gives the Animal
// Crossing "language" feel). Scripts without that notion (CJK, kana,
// hangul...) count as vowels. Symbols, emoji and punctuation: null (silent).
const VOWELS_LAT = 'aeiou', CONSONANTS_LAT = 'bcdfghjklmnpqrstvwxyz';
const VOWELS_CYR = 'аеёиоуыэюя', CONSONANTS_CYR = 'бвгджзйклмнпрстфхцчшщъь';
function letterClass(ch) {
    if (!ch) return null;
    if (ch >= '0' && ch <= '9') return { c: 'c', k: 21 + (ch.charCodeAt(0) - 48) };
    const low = ch.toLowerCase();
    let k;
    // Cyrillic BEFORE NFD: otherwise й turns into и (a vowel) and ё into е.
    if ((k = VOWELS_CYR.indexOf(low)) >= 0) return { c: 'v', k };
    if ((k = CONSONANTS_CYR.indexOf(low)) >= 0) return { c: 'c', k };
    const b = low.normalize('NFD')[0];
    if ((k = VOWELS_LAT.indexOf(b)) >= 0) return { c: 'v', k };
    if ((k = CONSONANTS_LAT.indexOf(b)) >= 0) return { c: 'c', k };
    if (/\p{L}/u.test(ch)) return { c: 'v', k: ch.codePointAt(0) };
    return null;
}

// Incremental scanner over the RAW text (not the DOM: open quotes and
// asterisks only get their color once they close, so the DOM lies about the
// segment of the last letter). One step per call:
//   null            = wait for more text (or done);
//   {ch:'', seg:''} = consumed something silent (markup, code, reasoning);
//   {ch, seg}       = a visible character; seg 'q' speech | 'a' action | 'n' narration.
// While streaming it never gets closer than st.look characters to the end:
// a '*' at the end may be the start of '**', a '<' may be '<think>'.
function newScan() { return { i: 0, star: false, quote: false, code: 0, fence: '', think: '', look: 8 }; }
function scanStep(st, txt, tags, done) {
    const i = st.i, n = txt.length;
    if (i >= n) return null;
    if (!done && n - i < st.look) return null;
    const SILENT = { ch: '', seg: '' };
    const c = txt[i];
    const at = (a, s) => txt.substr(a, s.length).toLowerCase() === s.toLowerCase();
    if (st.think) {
        if (at(i, st.think)) { st.i += st.think.length; st.think = ''; } else st.i++;
        return SILENT;
    }
    if (st.code === 2) {
        if (txt.startsWith(st.fence, i)) { st.i += st.fence.length; st.code = 0; st.fence = ''; } else st.i++;
        return SILENT;
    }
    if (st.code === 1) { if (c === '`') st.code = 0; st.i++; return SILENT; }
    for (const tg of tags) {
        if (tg && tg.open && tg.close && c.toLowerCase() === tg.open[0].toLowerCase() && at(i, tg.open)) {
            st.i += tg.open.length; st.think = tg.close; return SILENT;
        }
    }
    if ((c === '`' || c === '~') && txt.startsWith(c + c + c, i)) { st.code = 2; st.fence = c + c + c; st.i += 3; return SILENT; }
    if (c === '`') { st.code = 1; st.i++; return SILENT; }
    if (c === '<' && /[a-zA-Z\/!]/.test(txt[i + 1] || '')) {
        // HTML tag from a card: silent up to the '>'.
        const f = txt.indexOf('>', i);
        if (f > 0 && f - i <= 300) { st.i = f + 1; return SILENT; }
        if (f < 0 && !done && n - i <= 300) return null;
    }
    if (c === '[' && /^\[EMO\s*:/i.test(txt.substr(i, 8))) {
        const f = txt.indexOf(']', i);
        if (f > 0 && f - i <= 48) { st.i = f + 1; return SILENT; }
        if (f < 0 && !done && n - i <= 48) return null;
    }
    if ((c === 'h' || c === 'H') && /^https?:\/\//i.test(txt.substr(i, 8))) {
        const m = /[\s)\]>"]/.exec(txt.slice(i));
        if (!m && !done) return null;
        st.i = m ? i + m.index : n; return SILENT;
    }
    if (c === '*') {
        let k = i; while (txt[k] === '*') k++;
        if (k - i !== 2) st.star = !st.star;      // ** is bold, not action
        st.i = k; return SILENT;
    }
    if (c === '"') { st.quote = !st.quote; st.i++; return SILENT; }
    if (c === '“') { st.quote = true;  st.i++; return SILENT; }
    if (c === '”') { st.quote = false; st.i++; return SILENT; }
    st.i++;
    // New paragraph: markdown emphasis does not cross it, and a quote left
    // open by mistake must not turn the rest of the reply into speech.
    if (c === '\n' && txt[i + 1] === '\n') { st.star = false; st.quote = false; }
    return { ch: c, seg: st.quote ? 'q' : (st.star ? 'a' : 'n') };
}

/** Effective voice of a character (null = no blips). `saved` = the character's
 *  stored voice, `cfg` = the extension's global settings. */
function resolveVoice(saved, cfg) {
    const b = (saved && typeof saved === 'object') ? saved : {};
    const g = cfg || {};
    if (b.off) return null;
    const pk = PRESETS[b.preset] ? b.preset : (PRESETS[g.preset] ? g.preset : 'default');
    const num = (v, lo, hi, d) => { const x = Number(v); return (v != null && isFinite(x)) ? Math.min(hi, Math.max(lo, x)) : d; };
    // File voice: only counts with real samples. Without any, the character
    // falls back to the global preset instead of going silent.
    const sm = b.samples && typeof b.samples === 'object' ? b.samples : null;
    const files = (b.preset === 'file' && sm && ((sm.v || []).length || (sm.c || []).length))
        ? { v: Array.isArray(sm.v) ? sm.v : [], c: Array.isArray(sm.c) ? sm.c : [] } : null;
    return {
        preset: files ? 'file' : pk, p: PRESETS[pk],   // p = fallback synthesis (narration, sample still decoding)
        pitch: num(b.pitch, 0.5, 2, 1),
        speed: num(b.speed, 0.5, 2, 1) * num(g.speed, 0.5, 2, 1),
        vari:  num(b.vari, 0, 1, 0.5),
        files,
    };
}

dd.shared.synth = {
    PRESETS, NARRATION, VOWELS_LAT, CONSONANTS_LAT,
    blipSpec, blipRender, letterClass, newScan, scanStep, resolveVoice,
};
