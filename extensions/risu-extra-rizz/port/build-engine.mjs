// Rebuilds ../engine.js from a RisuAI checkout (not downloaded by the app).
//
//   node port/build-engine.mjs <RisuAI checkout> <path to the sucrase package>
//
// The TypeScript types are stripped with sucrase (line numbers are kept, so
// the slices below can be checked against the source), then the slices are
// patched where they reach RisuAI's stores and joined with the frag-*.js
// files of this folder. Every patch must match exactly once: when RisuAI
// changes, this stops instead of producing a broken engine.
// After a rebuild: node test/engine.test.mjs [cards dir].
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [risu, sucrasePath] = process.argv.slice(2);
if (!risu || !sucrasePath) { console.log('usage: node port/build-engine.mjs <RisuAI checkout> <sucrase package path>'); process.exit(1); }
const { transform } = createRequire(import.meta.url)(path.resolve(sucrasePath));
const OUT = path.join(HERE, '..', 'engine.js');

const strip = f => transform(fs.readFileSync(path.join(risu, f), 'utf8'), { transforms: ['typescript'], disableESTransforms: true }).code;
const frag = f => fs.readFileSync(path.join(HERE, f), 'utf8');
const slice = (arr, a, b) => arr.slice(a - 1, b).join('\n');   // 1-based, inclusive

function patch(s, from, to, n = 1) {
    const c = s.split(from).length - 1;
    if (c !== n) throw new Error(`patch: expected ${n}, found ${c}: ${from.slice(0, 80)}`);
    return s.split(from).join(to);
}
// sucrase leaves blank lines where types were; join "let x\n\n\n = y".
const tidy = s => s.replace(/\n(?:[ \t]*\n)+[ \t]*(?==[^=>])/g, ' ').replace(/\n{3,}/g, '\n\n');
const indent = s => s.split('\n').map(l => (l.trim() ? '    ' + l : '')).join('\n');

// ── calcString ───────────────────────────────────────────────────────────
let calc = strip('src/ts/process/infunctions.ts');
calc = patch(calc, "import { getChatVar, getGlobalChatVar } from '../parser/chatVar.svelte';", '');
calc = patch(calc, 'export function calcString', 'function calcString');

// ── registerCBS ──────────────────────────────────────────────────────────
const cbsL = strip('src/ts/cbs.ts').split('\n');
const iReg = cbsL.findIndex(l => l.startsWith('export function registerCBS'));
let cbs = cbsL.slice(iReg).join('\n');
cbs = patch(cbs, 'export function registerCBS', 'function registerCBS');
cbs = cbs.replace(/Math\.random\(\)/g, '_rand()');
cbs = patch(cbs, 'return window.innerWidth.toString()', 'return String(CUR.meta.w || 0)');
cbs = patch(cbs, 'return window.innerHeight.toString()', 'return String(CUR.meta.h || 0)');
if (/\bwindow\./.test(cbs)) throw new Error('window. left in cbs');

// ── parser.svelte.ts ─────────────────────────────────────────────────────
const P = strip('src/ts/parser/parser.svelte.ts').split('\n');
const at = start => { const i = P.findIndex(l => l.startsWith(start)); if (i < 0) throw new Error('parser: ' + start); return i + 1; };
const L = {
    repl: at('const replacements'), unesc: at('export function risuEscape'),
    matcher: at('function matcher'),
    parseArray: at('function parseArray'), trimLines: at('function trimLines'),
    parser: at('export function risuChatParser'), after: at('export function applyMarkdownToNode'),
};
// risuEscape ends with the first "}" at column 0 after it.
const escEnd = P.findIndex((l, i) => i >= L.unesc && l === '}') + 1;
let parser = [
    slice(P, L.repl, escEnd),
    slice(P, L.matcher, L.parseArray - 1),
    slice(P, L.parseArray, L.trimLines - 1),
    slice(P, L.trimLines, L.parser - 1),
    slice(P, L.parser, L.after - 1),
].join('\n\n');
parser = patch(parser, 'export function risuEscape', 'function risuEscape');
parser = patch(parser, 'export function risuUnescape', 'function risuUnescape');
parser = patch(parser, 'export function risuChatParser', 'function risuChatParser');
{
    const a = parser.indexOf('    const db = arg.db ?? DBState.db');
    const b = parser.indexOf('    let pointer = 0;');
    if (a < 0 || b < 0 || b < a) throw new Error('risuChatParser header');
    parser = parser.slice(0, a) + [
        '    const db = arg.db ?? CUR.db',
        '    const aChara = arg.chara',
        '    let chara = null',
        '',
        '    if(aChara){',
        '        chara = aChara',
        '    }',
        '    if(arg.tokenizeAccurate){',
        '        const selchar = chara ?? db.characters[0]',
        '        if(!selchar){',
        "            chara = 'bot'",
        '        }',
        '    }',
        '',
        '',
    ].join('\n') + parser.slice(b);
}
parser = patch(parser, '                            console.log(matchResult)\n', '');
parser = patch(parser, '                    console.log(func)\n', '');
if (/DBState|selectedCharID|findCharacterbyId|export /.test(parser)) throw new Error('store or export left in parser');

// ── scripts.ts: processScriptFull, the regex part ────────────────────────
const S = strip('src/ts/process/scripts.ts').split('\n');
const iExec = S.findIndex(l => l.startsWith('    function executeScript('));
const iLoop = S.findIndex(l => l.startsWith('    for (const script of parsedScripts){'));
if (iExec < 0 || iLoop < 0) throw new Error('scripts.ts anchors');
let exec = S.slice(iExec, iLoop).join('\n');
exec = patch(exec, 'let charemotions = get(CharEmotion)', 'let charemotions = {}');
exec = patch(exec, 'CharEmotion.set(charemotions)', 'void 0');
exec = patch(exec, `                        const selchar = db.characters[get(selectedCharID)]
                        selchar.chats[selchar.chatPage].message[chatID].data = data
`, `                        // DumDum: the screen never writes to the chat (later phases).
`);
exec = patch(exec, 'const selchar = db.characters[get(selectedCharID)]', 'const selchar = db.characters[0]');
if (/get\(|CharEmotion|selectedCharID/.test(exec)) throw new Error('store left in scripts');
const scripts = `
    // ── src/ts/process/scripts.ts: processScriptFull, the regex part ─────
    // hooks.skip: indexes of scripts left out of this run (one that hung);
    // hooks.onScript(i): called before each script of this mode runs.
    const dreg = /{{data}}/g
    function processScriptFull(data, mode, chatID = -1, cbsConditions = {}, hooks = {}){
        const db = CUR.db
        const char = CUR.char
        let emoChanged = false
        data = risuChatParser(data, { chatID: chatID, cbsConditions })
        const scripts = (char.customscript || []).concat(CUR.moduleScripts || [])
        if(scripts.length === 0){
            return {data, emoChanged}
        }
${exec}
        for (let i = 0; i < parsedScripts.length; i++){
            const script = parsedScripts[i]
            if(script.script.type !== mode || !script.script.in) continue
            if(hooks.skip && hooks.skip.has(i)) continue
            if(hooks.onScript) hooks.onScript(i)
            try {
                executeScript(script)
            } catch (error) {}
        }
        return {data, emoChanged}
    }
`;

// ── triggers.ts: runTrigger (F3c) ────────────────────────────────────────
const T = strip('src/ts/process/triggers.ts').split('\n');
const iSafe = T.findIndex(l => l.startsWith('const safeSubset'));
if (iSafe < 0) throw new Error('triggers.ts: safeSubset');
let trig = T.slice(iSafe).join('\n');
trig = patch(trig, 'export const displayAllowList', 'const displayAllowList');
trig = patch(trig, 'export const requestAllowList', 'const requestAllowList');
trig = patch(trig, 'export async function runTrigger', 'async function runTrigger');
if (/^\s*(import|export)\b/m.test(trig)) throw new Error('import/export left in triggers');

// ── scriptings.ts: Lua (F3d) ─────────────────────────────────────────────
const LS = strip('src/ts/process/scriptings.ts').split('\n');
const iLua = LS.findIndex(l => l.startsWith('let luaFactory'));
const iPy = LS.findIndex(l => l.startsWith('class PyodideContext'));
if (iLua < 0 || iPy < 0) throw new Error('scriptings.ts anchors');
let lua = LS.slice(iLua, iPy).join('\n');
lua = patch(lua, 'export async function runScripted', 'async function runScripted');
lua = patch(lua, 'export async function runLuaEditTrigger', 'async function runLuaEditTrigger');
lua = patch(lua, 'export async function runLuaButtonTrigger', 'async function runLuaButtonTrigger');
{
    const a = lua.indexOf('async function makeLuaFactory(){');
    const b = lua.indexOf('async function ensureLuaFactory()');
    if (a < 0 || b < 0 || b < a) throw new Error('makeLuaFactory');
    lua = lua.slice(0, a) + [
        '// DumDum: the page builds the factory (wasmoon + RisuAI\'s json.lua).',
        'async function makeLuaFactory(){',
        '    luaFactory = await HOST.luaFactory()',
        '}',
        '',
        '',
    ].join('\n') + lua.slice(b);
}
lua = patch(lua, "                console.log('Creating new Lua engine for mode:', mode)\n", '');
lua = patch(lua, "            console.log('Running Lua code:', code)\n", '');
if (/^\s*(import|export)\b/m.test(lua)) throw new Error('import/export left in scriptings');

const body = [
    frag('frag-runtime.js'),
    '\n    // ── src/ts/process/infunctions.ts ────────────────────────────────────',
    indent(tidy(calc).trim()),
    '\n    // ── src/ts/cbs.ts: registerCBS ───────────────────────────────────────',
    indent(tidy(cbs).trim()),
    '\n    // ── src/ts/parser/parser.svelte.ts ───────────────────────────────────',
    indent(tidy(parser).trim()),
    frag('frag-matcher.js'),
    tidy(scripts),
    frag('frag-triggers.js'),
    '\n    // ── src/ts/process/triggers.ts: runTrigger ───────────────────────────',
    indent(tidy(trig).trim()),
    '\n    // ── src/ts/process/scriptings.ts: Lua (runScripted and its API) ──────',
    indent(tidy(lua).trim()),
    frag('frag-api.js'),
].join('\n');
fs.writeFileSync(OUT, frag('frag-head.js') + body.replace(/[ \t]+$/gm, ''));
console.log('engine.js', fs.statSync(OUT).size, 'bytes');
