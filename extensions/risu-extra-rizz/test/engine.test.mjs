// Risu's extra Rizz: engine checks (node test/engine.test.mjs [cards dir]).
//
// 1. Cases taken from RisuAI's own CBS tests (src/ts/parser/tests/cbs/*.test.ts,
//    the example-based ones), run against the port.
// 2. Optional: a folder of RisuRealm card JSONs ({nome, card}); every greeting
//    goes through the display pipeline of its card (CBS + editdisplay regex)
//    and must not throw or take long.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dd = { shared: {} };
new Function('dd', fs.readFileSync(path.join(HERE, '..', 'engine.js'), 'utf8'))(dd);
const E = dd.shared.engine.rizzEngine({ appVer: '1234.5.67' });

let fails = 0, n = 0;
function eq(got, want, what) {
    n++;
    if (got !== want) { fails++; console.log('FAIL', what, '\n  got: ', JSON.stringify(got), '\n  want:', JSON.stringify(want)); }
}
function ctx(vars, extra) { E.setCtx('t', Object.assign({ vars: vars || {} }, extra || {})); }
const parse = (s, o) => E.parse('t', s, o);
const template = (op, body) => `0 {{${op}}}${body}{{/}} 9`;
const quick = (op, body) => parse(template(op, body));
const indentedBody = '\n  C  \n  B  \n  S  \n';

ctx();
// conditionals.test.ts
eq(quick('#if 1', 'CBS'), '0 CBS 9', '#if 1');
eq(quick('#if true', 'CBS'), '0 CBS 9', '#if true');
eq(quick('#if 0', 'CBS'), '0  9', '#if 0');
eq(quick('#if  1', 'CBS'), '0  9', '#if  1 (two spaces)');
eq(quick('#if 1', indentedBody), '0 C  \nB  \nS 9', '#if trims');
eq(quick('#if 1', template('#if 0', 'CBS')), '0 0  9 9', '#if nested');
eq(quick('#if_pure 1', indentedBody), `0 ${indentedBody} 9`, '#if_pure keeps whitespace');
eq(quick('#when::1', 'CBS'), '0 CBS 9', '#when::1');
eq(quick('#when::false', 'CBS'), '0  9', '#when::false');
eq(quick('#when::1', indentedBody), `0 ${indentedBody.replace(/(^\n+|\n+$)/g, '')} 9`, '#when line breaks');
eq(quick('#when 1', template('#when 0', 'CBS')), '0 0  9 9', '#when nested');
eq(quick('#when::a::is::a', 'CBS'), '0 CBS 9', '::is');
eq(quick('#when::a::isnot::a', 'CBS'), '0  9', '::isnot');
eq(quick('#when::5::>::3', 'CBS'), '0 CBS 9', '::>');
eq(quick('#when::3::>=::5', 'CBS'), '0  9', '::>=');
eq(quick('#when::1::and::not::true', 'CBS'), '0  9', '::and not');
eq(quick('#when::0::or::not::false', 'CBS'), '0 CBS 9', '::or not');
eq(quick('#when::1::or::0::and::0', 'CBS'), '0 CBS 9', 'right to left 1');
eq(quick('#when::0::or::1::and::0', 'CBS'), '0  9', 'right to left 2');
eq(quick('#when::keep::1', indentedBody), `0 ${indentedBody} 9`, '::keep');
eq(quick('#when::legacy::1', indentedBody), '0 C  \nB  \nS 9', '::legacy');
eq(quick('#when::1', 'CBS{{:else}}SBC'), '0 CBS 9', 'else single 1');
eq(quick('#when::0', 'CBS{{:else}}SBC'), '0 SBC 9', 'else single 0');
eq(quick('#when::0', 'CBS\n{{:else}}\nSBC'), '0 SBC 9', 'else multiline');
{
    const nt = (a, b) => `{{#when ${a}}}\n{{#when ${b}}}CBS{{:else}}SBC{{/}}\n{{:else}}\nABC\n{{/}}`;
    eq(parse(nt('1', '1')), 'CBS', 'nested else 11');
    eq(parse(nt('1', '0')), 'SBC', 'nested else 10');
    eq(parse(nt('0', '1')), 'ABC', 'nested else 01');
    eq(parse(`{{#each [1, 2, 3] as n}}\n{{#when::n::is::2}}\nCBS{{slot::n}}\n{{:else}}\nSBC{{slot::n}}\n{{/}}\n{{/}}`), 'SBC1SBC2SBC3', 'else in #each');
}
ctx({ x: 'abc', t: 'true' });
eq(quick('#when::var::t', 'CBS'), '0 CBS 9', '::var');
eq(quick('#when::x::vis::abc', 'CBS'), '0 CBS 9', '::vis');
eq(quick('#when::x::visnot::abc', 'CBS'), '0  9', '::visnot');
// loop.test.ts
const qe = (op, body) => parse(`{{${op}}}${body}{{/}}`);
ctx({ arr: '[1, 2, 3]' });
eq(qe('#each [1, 2, 3] as n', '{{slot::n}} '), '123', '#each literal');
eq(qe('#each {{getvar::arr}} as n', '{{slot::n}} '), '123', '#each variable');
eq(qe('#each [] as n', '{{slot::n}} '), '', '#each empty');
eq(qe('#each {{getvar::aa}} as n', '{{slot::n}} '), 'null', '#each null');
eq(qe('#each [1, 2, 3] as n', ' \n - {{slot::n}}\n  '), '- 1- 2- 3', '#each trims');
eq(qe('#each [1, 2, 3] n', '{{slot::n}} '), '123', '#each without as');
eq(qe('#each::keep [1, 2, 3] as n', '  - {{slot::n}}\n'), '  - 1\n  - 2\n  - 3\n', '#each::keep');
// escapes.test.ts
eq(parse('{{bo}}'), '', '{{bo}} (escaped braces, unescaped by the renderer)');
eq(parse('{{br}}'), '\n', '{{br}}');
eq(parse('{{cbr}}'), '\\n', '{{cbr}}');
eq(parse('{{#pure}} {{user}} {{/}}'), '{{user}}', '#pure');
// strings.test.ts
const qs = (op, ...a) => parse(`{{${op}${a.length ? '::' : ''}${a.join('::')}}}`);
eq(qs('startswith', 'Hello World', 'Hello'), '1', 'startswith');
eq(qs('contains', 'Hello World', 'lo Wo'), '1', 'contains');
eq(qs('replace', 'Hello World', 'o', '0'), 'Hell0 W0rld', 'replace');
eq(qs('split', 'apple,banana,cherry', ','), JSON.stringify(['apple', 'banana', 'cherry']), 'split');
eq(qs('trim', '  hello  \n  world  '), 'hello  \n  world', 'trim');
eq(qs('capitalize', 'hello world'), 'Hello world', 'capitalize');
eq(qs('reverse', 'Hello World'), 'dlroW olleH', 'reverse');
// DumDum-side checks: math, variables, defaults, messages, seeded random.
ctx({ hp: '7' }, {
    char: { name: 'Hikari', defaultVariables: 'mood=calm\nlevel=3' },
    chat: { message: [{ role: 'char', data: 'a' }, { role: 'user', data: 'b' }, { role: 'char', data: 'c' }] },
    user: { name: 'Ana' },
});
eq(parse('{{? 1+2*3}}'), '7', '{{? }}');
eq(parse('{{calc::$hp*2}}'), '14', 'calc with $var');
eq(parse('{{getvar::hp}}/{{getvar::mood}}/{{getvar::none}}'), '7/calm/null', 'getvar + defaultVariables');
eq(parse('{{lastmessageid}}|{{lastmessage}}'), '2|c', 'lastmessage');
eq(parse('{{char}} and {{user}}'), 'Hikari and Ana', 'names');
eq(parse('{{greater_equal::{{chat_index}}::{{? {{lastmessageid}}-5}}}}', { chatID: 1 }), '1', 'chat_index window');
eq(parse('{{setvar::hp::9}}{{getvar::hp}}'), '{{setvar::hp::9}}7', 'setvar does not run without runVar');
eq(parse('{{button::Go::next}}'), '<button class="button-default" risu-trigger="next">Go</button>', 'button');
{
    const a = parse('{{random::a,b,c,d,e,f,g}}{{roll::100}}', { seed: 's1' });
    const b = parse('{{random::a,b,c,d,e,f,g}}{{roll::100}}', { seed: 's1' });
    eq(a, b, 'seeded random is stable');
}
// Display: the editdisplay regex, with CBS in the replacement and <order N>.
ctx({ mood: 'happy' }, {
    char: {
        customscript: [
            { type: 'editdisplay', in: '\\[mood\\]', out: '<b>{{getvar::mood}}</b>', flag: 'g<order 10>', ableFlag: true },
            { type: 'editdisplay', in: 'HAPPY', out: 'joy', flag: 'g<order 5>', ableFlag: true },
            { type: 'editdisplay', in: 'happy', out: 'HAPPY', flag: 'g<order 9>', ableFlag: true },
            { type: 'editinput', in: 'x', out: 'y' },
            { type: 'editdisplay', in: '(a+)+$', out: '!', flag: 'g', ableFlag: false },
        ],
    },
});
eq(E.display('t', 'Mood: [mood]', { chatID: 0 }), 'Mood: <b>joy</b>\n', 'display regex, order, CBS in output, end newline');
{
    const seen = [];
    E.display('t', 'x', { chatID: 0 }, { skip: new Set([2]), onScript: i => seen.push(i) });
    eq(seen.join(','), '0,1,4', 'hooks: editdisplay scripts only, skip honored');
}

console.log(`engine: ${n - fails}/${n} ok`);

// ── Cards ───────────────────────────────────────────────────────────────
const dir = process.argv[2];
if (dir && fs.existsSync(dir)) {
    let cards = 0, greetings = 0, slow = 0, errors = 0, changed = 0, worst = 0;
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const d = j.card || {}, r = (d.extensions && d.extensions.risuai) || {};
        cards++;
        const scripts = Array.isArray(r.customScripts) ? r.customScripts : [];
        E.setCtx('c', {
            char: { name: d.name || '', desc: d.description || '', personality: d.personality || '', scenario: d.scenario || '',
                firstMessage: d.first_mes || '', alternateGreetings: d.alternate_greetings || [], customscript: scripts,
                defaultVariables: r.defaultVariables || '', chaId: f },
            chat: { message: [] }, user: { name: 'User' }, meta: { w: 1280, h: 800 },
        });
        for (const g of [d.first_mes, ...(d.alternate_greetings || [])].filter(x => typeof x === 'string' && x)) {
            greetings++;
            const t0 = performance.now();
            let out = g;
            try { out = E.display('c', g, { chatID: -1, firstmsg: true, role: 'char', seed: f }); }
            catch (e) { errors++; console.log('ERROR', j.nome, e.message); }
            const ms = performance.now() - t0;
            worst = Math.max(worst, ms);
            if (ms > 200) { slow++; console.log('SLOW', j.nome, Math.round(ms), 'ms'); }
            if (out !== g) changed++;
        }
        if (r.backgroundHTML) {
            try { E.background('c', r.backgroundHTML, { seed: f }); } catch (e) { errors++; console.log('ERROR bg', j.nome, e.message); }
        }
    }
    console.log(`cards: ${cards}, greetings: ${greetings} (changed by CBS/regex: ${changed}), errors: ${errors}, slow: ${slow}, worst ${Math.round(worst)} ms`);
    if (errors) fails++;
}
process.exit(fails ? 1 : 0);
