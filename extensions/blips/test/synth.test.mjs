// Synthesis and scanner tests. Loads synth.js with a fake `dd` (no app needed).
//   node test/synth.test.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.join(here, '..', 'synth.js'), 'utf8');
const ctx = { dd: { shared: {} }, Math, Object, Float32Array, performance: { now: () => 0 } };
vm.createContext(ctx);
vm.runInContext(code, ctx);
const S = ctx.dd.shared.synth;
const voice = (b) => S.resolveVoice(b, {});

let ok = 0, failed = 0;
const check = (name, cond, info) => { if (cond) ok++; else { failed++; console.log('FAIL', name, info ?? ''); } };
const SR = 48000;
const measure = (x) => {
    let pk = 0, s = 0, zc = 0;
    for (let i = 0; i < x.length; i++) { const v = Math.abs(x[i]); if (v > pk) pk = v; s += x[i] * x[i]; if (i && (x[i] >= 0) !== (x[i - 1] >= 0)) zc++; }
    return { pk, rms: Math.sqrt(s / x.length), zcr: zc / x.length, n: x.length };
};
// Average of several renders (noise and jitter are random).
function average(pk, seg, ch, reps = 12) {
    const v = voice({ preset: pk });
    const acc = { pk: 0, rms: 0, zcr: 0, n: 0 };
    for (let i = 0; i < reps; i++) {
        const m = measure(S.blipRender(S.blipSpec(v, seg, S.letterClass(ch), { pitch: 1, gain: 1 }), SR));
        for (const k in acc) acc[k] += m[k] / reps;
    }
    return acc;
}

// ── Render ──────────────────────────────────────────────────────────────
const table = [];
for (const pk of Object.keys(S.PRESETS)) {
    for (const seg of ['q', 'a', 'n']) for (const ch of ['a', 'i', 'k', 's']) {
        const v = voice({ preset: pk });
        const x = S.blipRender(S.blipSpec(v, seg, S.letterClass(ch), { pitch: 1.2, gain: 1.3 }), SR);
        const m = measure(x);
        check(`${pk}/${seg}/${ch} no NaN`, x.every(Number.isFinite));
        check(`${pk}/${seg}/${ch} peak <= 1`, m.pk <= 1, m.pk);
        check(`${pk}/${seg}/${ch} audible`, m.rms > 0.01, m.rms);
    }
    const vq = average(pk, 'q', 'a');
    table.push({ preset: pk, ms: +(vq.n / 48).toFixed(1), peak: +vq.pk.toFixed(2), rms: +vq.rms.toFixed(3), zcr: +vq.zcr.toFixed(3) });
}
console.table(table);
const rmss = table.map(t => t.rms);
check('balanced loudness', Math.max(...rmss) / Math.min(...rmss) < 2.5, rmss.join(' '));

{
    const v = voice({ preset: 'default' });
    const vowel = S.blipRender(S.blipSpec(v, 'q', S.letterClass('a'), null), SR).length;
    const cons = S.blipRender(S.blipSpec(v, 'q', S.letterClass('k'), null), SR).length;
    check('consonant is shorter', cons < vowel, `${cons} vs ${vowel}`);
}
{
    const vo = average('static', 'q', 'a', 30), co = average('static', 'q', 's', 30);
    check('static: brighter consonant', co.zcr > vo.zcr * 1.3, `${co.zcr.toFixed(3)} vs ${vo.zcr.toFixed(3)}`);
    const v = voice({ preset: 'static' });
    let sT = 0, sA = 0, x;
    for (let k = 0; k < 20; k++) {
        x = S.blipRender(S.blipSpec(v, 'q', S.letterClass('a'), null), SR);
        const tr = x.slice(x.length - 144, x.length - 96);
        sT += tr.reduce((s, y) => s + y * y, 0) / tr.length;
        sA += x.reduce((s, y) => s + y * y, 0) / x.length;
    }
    check('static: dry gate (signal until the end)', Math.sqrt(sT / 20) > 0.6 * Math.sqrt(sA / 20));
    check('static: ends at zero', Math.abs(x[x.length - 1]) < 0.02, x[x.length - 1]);
    const z = ['a', 'e', 'i', 'o', 'u'].map(ch => average('static', 'q', ch, 30).zcr);
    check('static: vowels with distinct grain', Math.max(...z) / Math.min(...z) > 1.15, z.map(v2 => v2.toFixed(3)).join(' '));
}
{
    const zi = average('babble', 'q', 'i', 8).zcr, zu = average('babble', 'q', 'u', 8).zcr;
    check('babble: i brighter than u', zi > zu * 1.3, `i ${zi.toFixed(3)} u ${zu.toFixed(3)}`);
    check('babble: consonant is a breath', average('babble', 'q', 't', 8).zcr > zi);
}
{
    const q = average('default', 'q', 'a', 8).zcr, a = average('default', 'a', 'a', 8).zcr;
    check('action is muffled', a < q, `${a.toFixed(3)} vs ${q.toFixed(3)}`);
}
{
    const v = voice({ preset: 'retro' });
    const semis = ['a', 'e', 'i', 'o', 'u'].map(ch => Math.round(12 * Math.log2(S.blipSpec(v, 'q', S.letterClass(ch), null, () => 0.5).f / 520) * 100) / 100);
    check('retro pentatonic', JSON.stringify(semis) === JSON.stringify([0, 2, 4, 7, 9]), semis);
}
{
    const v = voice({ preset: 'cute', pitch: 1.5 });
    const s1 = S.blipSpec(v, 'q', S.letterClass('a'), null, () => 0.5);
    check('deterministic spec', s1.f === 880 * 1.5 * (1 + (0 - 2) * 0.04), s1.f);
}

// ── Letter class ────────────────────────────────────────────────────────
check('a is vowel 0', JSON.stringify(S.letterClass('a')) === '{"c":"v","k":0}');
check('á keeps the a', JSON.stringify(S.letterClass('á')) === '{"c":"v","k":0}');
check('k is consonant', S.letterClass('k').c === 'c');
check('й stays a consonant', S.letterClass('й').c === 'c');
check('kana counts as vowel', S.letterClass('あ').c === 'v');
check('punctuation is silent', S.letterClass('!') === null && S.letterClass('🙂') === null);

// ── Scanner ─────────────────────────────────────────────────────────────
function scanAll(txt, tags = []) {
    const st = S.newScan(); const out = [];
    let r;
    while ((r = S.scanStep(st, txt, tags, true))) if (r.ch) out.push(r.seg);
    return out.join('');
}
check('speech in quotes', scanAll('"ab"') === 'qq');
check('action in asterisks', scanAll('*ab*') === 'aa');
check('bold is not action', scanAll('**ab**') === 'nn');
check('narration outside', scanAll('ab') === 'nn');
check('code is silent', scanAll('a`xyz`b') === 'nn');
check('fence is silent', scanAll('a\n```\nxyz\n```\nb').replace(/n/g, '').length === 0);
check('reasoning tag is silent', scanAll('<think>zzz</think>"ab"', [{ open: '<think>', close: '</think>' }]) === 'qq');
check('emotion tag is silent', scanAll('[EMO:joy]"ab"') === 'qq');
check('url is silent', scanAll('https://x.io "ab"') === 'nqq');
check('paragraph closes a quote', scanAll('"ab\n\ncd').endsWith('nn'));
{
    // While streaming it waits near the end (a trailing '*' may become '**').
    const st = S.newScan();
    let n = 0;
    while (S.scanStep(st, '"hello*', [], false)) n++;
    check('streaming keeps a look-ahead', st.i < 7, st.i);
}

// ── Voice resolution ────────────────────────────────────────────────────
check('no voice → global preset', voice(null).preset === 'default');
check('off → null', voice({ off: true }) === null);
check('file without samples → synthesis', voice({ preset: 'file', samples: { v: [], c: [] } }).preset === 'default');
check('file with samples → file', voice({ preset: 'file', samples: { v: ['data:x'], c: [] } }).preset === 'file');
check('speed multiplies the global', S.resolveVoice({ speed: 2 }, { speed: 0.5 }).speed === 1);

console.log(`\n${ok} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
