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
import { createRequire } from 'module';

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

// Prompt side (F3b): script passes and {{setvar}} runs.
ctx({ n: '1' }, {
    char: {
        name: 'P', customscript: [
            { type: 'editinput', in: 'secret', out: '[x]', flag: 'g', ableFlag: false },
            { type: 'editprocess', in: 'STATUS:.*', out: '', flag: 'g', ableFlag: false },
        ],
    },
    chat: { message: [{ role: 'user', data: 'a' }] },
});
eq(E.script('t', 'my secret {{getvar::n}}', { mode: 'editinput', chatID: 1, role: 'user' }), 'my [x] 1', 'script editinput + CBS');
eq(E.script('t', 'hi {{setvar::n::2}}STATUS: ok', { mode: 'editprocess', chatID: 0, role: 'char', pre: 'history', rmVar: true }), 'hi ', 'script editprocess, setvar dropped');
eq(E.script('t', 'hi {{setvar::n::2}}', { mode: 'editoutput', chatID: 0, role: 'char' }), 'hi {{setvar::n::2}}', 'editoutput keeps setvar for later');
{
    const v = E.runVars('t', [{ text: '{{setvar::n::5}}', chatID: 0 }, { text: '{{addvar::n::2}} {{setvar::m::{{getvar::n}}}}', chatID: 1 }]);
    eq(JSON.stringify(v), JSON.stringify({ n: '7', m: '7' }), 'runVars in order');
    eq(E.parse('t', '{{getvar::n}}'), '1', 'runVars does not change the stored context');
}

// Triggers (F3c): v1 setvar with a condition, v2 loop/if/else, alert input, impersonate.
{
    E.setHost({ input: async t => 'typed ' + t, alert: () => {}, warn: () => {} });
    const trig = [
        { comment: 's', type: 'start', conditions: [{ type: 'var', var: 'c', value: '', operator: 'null' }],
            effect: [{ type: 'setvar', var: 'c', value: '10', operator: '=' }] },
        { comment: 'go', type: 'manual', conditions: [], effect: [
            { type: 'v2SetVar', var: 'n', value: '0', valueType: 'value', operator: '=', indent: 0 },
            { type: 'v2LoopNTimes', value: '3', valueType: 'value', indent: 0 },
            { type: 'v2SetVar', var: 'n', value: '2', valueType: 'value', operator: '+=', indent: 1 },
            { type: 'v2EndIndent', indent: 1, endOfLoop: true },
            { type: 'v2If', source: 'n', target: '6', targetType: 'value', condition: '=', indent: 0 },
            { type: 'v2SetVar', var: 'ok', value: 'yes {{getvar::n}}', valueType: 'value', operator: '=', indent: 1 },
            { type: 'v2EndIndent', indent: 1 },
            { type: 'v2Else', indent: 0 },
            { type: 'v2SetVar', var: 'ok', value: 'no', valueType: 'value', operator: '=', indent: 1 },
            { type: 'v2EndIndent', indent: 1 },
            { type: 'v2GetAlertInput', display: 'Name?', displayType: 'value', outputVar: 'nm', indent: 0 },
            { type: 'v2Impersonate', value: 'I am {{getvar::nm}}', valueType: 'value', role: 'user', indent: 0 },
        ] },
    ];
    E.setCtx('tr', { char: { name: 'T', triggerscript: trig }, chat: { message: [{ role: 'char', data: 'hi' }] }, vars: {} });
    const a = await E.trigger('tr', 'start', {});
    eq(a.vars.c, '10', 'start trigger, null condition');
    const b = await E.trigger('tr', 'manual', { manualName: 'go' });
    eq(`${b.vars.n}|${b.vars.ok}|${b.vars.nm}`, '6|yes 6|typed Name?', 'v2 loop, if/else, alert input');
    eq(JSON.stringify(b.messages), JSON.stringify([{ role: 'char', data: 'hi' }, { role: 'user', data: 'I am typed Name?' }]), 'v2Impersonate on the copy');
}

// Lua (F3d): the extension's own wasmoon (lua-vendor.js + lua/glue.wasm).
{
    // In Node the CommonJS branch of wasmoon reads the .wasm with require('fs').
    new Function('dd', 'require', '__filename', fs.readFileSync(path.join(HERE, '..', 'lua-vendor.js'), 'utf8'))(dd, createRequire(import.meta.url), path.join(HERE, '..', 'lua-vendor.js'));
    const json = fs.readFileSync(path.join(HERE, '..', 'lua', 'json.lua'), 'utf8');
    E.setHost({
        luaFactory: async () => { const f = new dd.shared.wasmoon.LuaFactory(path.join(HERE, '..', 'lua', 'glue.wasm')); await f.mountFile('json.lua', json); return f; },
        input: async () => 'Ana', alert: () => {}, warn: () => {}, llm: async (m) => 'model:' + m.map(x => x.content).join('|'),
    });
    const code = [
        "function onStart(id) setChatVar(id, 'started', tostring(getChatLength(id))) end",
        "function lang_ko(id) setChatVar(id, 'lang', 'ko') end",
        "onButtonClick = async(function(id, data)",
        "  local name = alertInput(id, 'Name?'):await()",
        "  addChat(id, 'char', 'Hi ' .. name .. ' (' .. data .. ')')",
        "end)",
        "ask = async(function(id) local r = LLM(id, {{role='user', content='q'}}) setChatVar(id, 'llm', r.result) end)",
        "listenEdit('editOutput', function(id, v) return v .. '!' end)",
        "listenEdit('editDisplay', function(id, v) return (string.gsub(v, 'cat', 'dog')) end)",
    ].join('\n');
    const trig = [{ comment: '', type: 'start', conditions: [], effect: [{ type: 'triggerlua', code }] }];
    E.setCtx('lua', { char: { name: 'L', triggerscript: trig, lowLevelAccess: true }, chat: { message: [{ role: 'user', data: 'x' }] }, vars: {} });
    eq((await E.trigger('lua', 'start', {})).vars.started, '1', 'lua onStart');
    eq((await E.trigger('lua', 'manual', { manualName: 'lang_ko' })).vars.lang, 'ko', 'lua function named after a button');
    const b = await E.luaButton('lua', 'menu');
    eq(b.messages[1] && b.messages[1].data, 'Hi Ana (menu)', 'lua onButtonClick with alertInput:await and addChat');
    eq((await E.trigger('lua', 'manual', { manualName: 'ask' })).vars.llm, 'model:q', 'lua LLM() with low level access');
    eq((await E.luaEdit('lua', 'editoutput', 'reply', {})).data, 'reply!', 'lua listenEdit editOutput');
    eq((await E.luaEdit('lua', 'editdisplay', 'a cat', {})).data, 'a dog', 'lua listenEdit editDisplay');
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
