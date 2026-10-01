// Risu's extra Rizz: the card's triggers (RisuAI triggerscript), without Lua.
//
// When they run, as in RisuAI:
//   start   each send, regenerate and continue, before the prompt (scripts.js);
//           their extra system prompt goes in through prompt.js
//   input   the user's message, before it is saved (scripts.js)
//   output  after the reply is saved (reply.end / reply.full), right after the
//           {{setvar}}s of the messages run (RisuAI's runCurrentChatFunction)
//   manual  a button of the card (risu-trigger, {{button::label::name}}) and
//           runtrigger effects
// The engine (engine.js, runTrigger ported) works on a copy of the chat; what
// changed comes back here: variables to vars.js, messages to dd.chat.
// Lua triggers (triggerlua) run on wasmoon like in RisuAI: onStart, onInput,
// onOutput, functions named after a button, onButtonClick (risu-btn) and
// listenEdit hooks. Low level access (calling the model) is asked once per
// character; image generation and similarity search are not available.

const S = dd.shared.store;
const V = dd.shared.vars;
const D = dd.shared.display;

let T = null;                  // the trigger engine (its own instance: awaits keep its context)
let chain = Promise.resolve(); // one run at a time
const warned = new Set();
let pendingSys = null;         // { chatId, sys } from the start triggers of this send
let inRun = 0;                 // a trigger or Lua button is running (host.reload waits for settle)

const host = {
    warn(what) {
        if (warned.has(what)) return;
        warned.add(what);
        dd.warn('trigger effect not available here:', what);
        if (['image', 'similarity'].includes(what)) dd.ui.toast(dd.t('toast_trigger_low'), 'info');
    },
    alert(text, kind) { return message(text, kind === 'error'); },
    input(text) { return ask(text); },
    select(options, display) { return choose(options, display); },
    confirm(text) { return dd.ui.confirm(String(text)); },
    // Lua's reloadDisplay. Inside a run the variables are not saved yet
    // (settle does it, and redraws after): nothing to do then.
    reload() { if (!inRun) { const id = dd.state.activeChatId(); if (id) D.rerun(id); } },
    // Lua (F3d): wasmoon, the engine RisuAI uses (lua-vendor.js), with
    // RisuAI's json.lua mounted.
    luaFactory: () => luaFactory(),
    // The model, for Lua's LLM() and the llm trigger effects (only reached
    // with low level access, which the user allowed for this character).
    llm: (msgs) => dd.llm.ask((msgs || []).map(m => ({ role: m.role, content: m.content }))),
};

let factoryP = null;
function luaFactory() {
    if (!factoryP) {
        factoryP = (async () => {
            const W = dd.shared.wasmoon;
            if (!W || !W.LuaFactory) throw new Error('wasmoon missing');
            const wasm = await dd.asset('lua/glue.wasm');
            const f = new W.LuaFactory(wasm);
            const json = await (await dd.net.fetch(await dd.asset('lua/json.lua'))).text();
            await f.mountFile('json.lua', json);
            return f;
        })();
        factoryP.catch(() => { factoryP = null; });
    }
    return factoryP;
}

// ── Low level access (RisuAI's lowLevelAccess) ───────────────────────────
// A card that asks for it (its own flag or its module's) can call the model
// and wait on timers from Lua. Asked once per character; the answer is kept
// in dd.store.char (the character editor section can clear it).
const asking = new Map();
/** The answer for this character; no answer yet = no access. Never asks: a
 *  question in the middle of a send would hold the prompt hooks past the
 *  app's 3 s (they would go without the card's scripts). */
async function lowLevelFor(charId, risu) {
    if (!risu || !risu.lowLevelAccess || !charId) return false;
    return (await dd.store.char(charId).get('lowLevel')) === true;
}
/** main.js, when the chat opens: asks once if the card wants it and there is
 *  no answer yet. Nothing waits for this. */
async function askLowLevel(charId) {
    if (!charId || asking.has(charId) || !dd.shared.cfg.scripts) return;
    const risu = await S.risuEnsure(charId);
    if (!risu || !risu.lowLevelAccess) return;
    const st = dd.store.char(charId);
    const v = await st.get('lowLevel');
    if (v === true || v === false) return;
    const c = dd.state.char(charId) || {};
    const p = dd.ui.confirm(dd.t('ask_low_level', { name: c.name || '?' }), { ok: dd.t('ask_low_ok'), cancel: dd.t('ask_low_no') })
        .then(ok => st.set('lowLevel', !!ok))
        .finally(() => asking.delete(charId));
    asking.set(charId, p);
}

function engine() {
    if (!T) { T = dd.shared.engine.rizzEngine({ local: true, mobile: dd.platform === 'mobile' }); T.setHost(host); }
    return T;
}

// ── Alerts (RisuAI's alertNormal / alertInput / alertSelect) ─────────────
function message(text, isError) {
    return new Promise(res => {
        dd.ui.modal({
            title: { t: isError ? 'trigger_error_title' : 'trigger_alert_title' }, size: 'sm',
            render(el, h) {
                const p = document.createElement('p');
                p.className = 'drx-alert-text';
                p.textContent = String(text);
                el.appendChild(p);
                el.appendChild(dd.ui.button({ label: 'OK', variant: 'primary', onClick: () => h.close() }));
            },
            onClose: () => res(),
        });
    });
}
function ask(text) {
    return new Promise(res => {
        let value = '', done = false;
        dd.ui.modal({
            title: { t: 'trigger_input_title' }, size: 'sm', dismissable: false,
            render(el, h) {
                const p = document.createElement('p');
                p.className = 'drx-alert-text';
                p.textContent = String(text);
                const inp = document.createElement('input');
                inp.type = 'text';
                inp.className = 'drx-search drx-alert-input';
                const ok = () => { value = inp.value; done = true; h.close(); };
                inp.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
                el.append(p, inp, dd.ui.button({ label: 'OK', variant: 'primary', onClick: ok }));
                setTimeout(() => inp.focus(), 50);
            },
            onClose: () => res(done ? value : ''),
        });
    });
}
/** RisuAI's alertSelect answers with the INDEX of the option ("0", "1"...),
 *  not its text: cards compare with that (Cheongwon's role buttons). */
function choose(options, display) {
    const list = Array.isArray(options) ? options : (options && typeof options === 'object' ? Object.values(options) : []);
    return new Promise(res => {
        let value = '';
        dd.ui.modal({
            title: { t: 'trigger_select_title' }, size: 'sm', dismissable: false,
            render(el, h) {
                if (display) {
                    const p = document.createElement('p');
                    p.className = 'drx-alert-text';
                    p.textContent = String(display);
                    el.appendChild(p);
                }
                const box = document.createElement('div');
                box.className = 'drx-alert-options';
                list.forEach((o, i) => box.appendChild(dd.ui.button({ label: String(o), onClick: () => { value = String(i); h.close(); } })));
                el.appendChild(box);
            },
            onClose: () => res(value),
        });
    });
}

// ── Running ──────────────────────────────────────────────────────────────
/** The chat after the triggers → dd.chat (only what changed). */
function applyChat(chatId, X, msgs) {
    if (!msgs) return;
    const orig = X.ctx.chat.message || [];
    const same = msgs.length === orig.length && msgs.every((m, i) => m.data === orig[i].data);
    if (same) return;
    if (!dd.chat || !dd.chat.edit) { host.warn('chat'); return; }
    const off = X.offset;
    const n = Math.min(orig.length, msgs.length);
    for (let i = 0; i < n; i++) if (msgs[i].data !== orig[i].data) dd.chat.edit(chatId, off + i, msgs[i].data);
    for (let i = orig.length; i < msgs.length; i++) dd.chat.add(chatId, { role: msgs[i].role === 'user' ? 'user' : 'assistant', text: msgs[i].data });
    if (msgs.length < orig.length) dd.chat.remove(chatId, off + msgs.length, orig.length - msgs.length);
}

/** The context for the trigger engine, with the low level access answer. */
async function prepare(chatId, charId, withLow = true) {
    if (!dd.shared.cfg.scripts || !chatId || !charId) return null;
    const risu = await S.risuEnsure(charId);
    if (!risu || !Array.isArray(risu.triggerscript) || !risu.triggerscript.length) return null;
    await V.load(chatId);
    D.freshCtx();
    const X = D.ctxNow(chatId, charId, risu);
    if (!X) return null;
    // Edit hooks never get low level access in RisuAI.
    const low = withLow ? await lowLevelFor(charId, risu) : false;
    const E = engine();
    E.setCtx(X.key, Object.assign({}, X.ctx, { char: Object.assign({}, X.ctx.char, { lowLevelAccess: low }) }));
    return { X, E, risu };
}
/** Variables and chat changes of a run → vars.js and dd.chat, then redraw. */
async function settle(chatId, X, r) {
    const before = X.ctx.vars || {};
    const changed = {};
    for (const [k, v] of Object.entries(r.vars || {})) if (before[k] !== v) changed[k] = v;
    if (Object.keys(changed).length) await V.setMany(chatId, changed);
    applyChat(chatId, X, r.messages);
    D.freshCtx();
    D.rerun(chatId);
}

async function runNow(chatId, charId, mode, o) {
    const p = await prepare(chatId, charId);
    if (!p) return null;
    const { X, E } = p;
    let r;
    inRun++;
    try { r = await E.trigger(X.key, mode, o || {}); } finally { inRun--; }
    if (!r) return null;
    await settle(chatId, X, r);
    if (r.stop) host.warn('stop');
    return r;
}
/** Queues a run (triggers never overlap). Resolves with the result or null. */
function run(chatId, charId, mode, o) {
    const p = chain.then(() => runNow(chatId, charId, mode, o));
    chain = p.catch(e => { dd.warn('trigger', mode, e); return null; });
    return chain;
}

// ── Hooks ────────────────────────────────────────────────────────────────
/** scripts.js, before the prompt: start triggers; their system prompt waits
 *  for prompt.js. */
async function onStart(ctx) {
    const r = await run(ctx.chatId, ctx.charId, 'start');
    pendingSys = r && r.sys ? { chatId: ctx.chatId, sys: r.sys } : null;
}
/** prompt.js: the start triggers' system prompt (once). */
function takeSys(chatId) {
    const p = pendingSys;
    pendingSys = null;
    return p && p.chatId === chatId ? p.sys : null;
}
const onInput = (ctx) => run(ctx.chatId, ctx.charId, 'input');

/** A reply was saved: the {{setvar}}s, then the output triggers. Waits for
 *  the app to finish the reply (the chat cannot be written while it streams). */
async function onReply(e) {
    const chatId = e && e.chatId;
    if (!chatId || (e && e.aborted)) return;
    for (let i = 0; i < 50 && dd.state.streamingChatId() === chatId; i++) await new Promise(r => setTimeout(r, 100));
    const chat = dd.state.chat();
    if (!chat || chat.id !== chatId) return;
    const msgs = chat.messages || [];
    const last = msgs[msgs.length - 1];
    const charId = (last && last.charId) || e.charId || chat.charId;
    await dd.shared.scripts.runVarsNow({ chatId, charId, kind: 'send' });
    await run(chatId, charId, 'output');
}

function charOf(chatId, msgIndex) {
    const chat = dd.state.chat();
    if (!chat || chat.id !== chatId) return null;
    const m = (chat.messages || [])[msgIndex];
    return (m && m.charId) || chat.charId;
}
/** A card button: data-risu-trigger (+ data-risu-id, read by {{trigger_id}}). */
function onClick({ chatId, msgIndex, el }) {
    const name = el.getAttribute('data-risu-trigger');
    const charId = name && charOf(chatId, msgIndex);
    if (!charId) return;
    return run(chatId, charId, 'manual', { manualName: name, triggerId: el.getAttribute('data-risu-id') || undefined });
}
/** A Lua button: data-risu-btn → the card's onButtonClick(id, data). */
function onLuaClick({ chatId, msgIndex, el }) {
    const data = el.getAttribute('data-risu-btn');
    const charId = data != null && charOf(chatId, msgIndex);
    if (!charId) return;
    const p = chain.then(async () => {
        const q = await prepare(chatId, charId);
        if (!q) return null;
        let r;
        inRun++;
        try { r = await q.E.luaButton(q.X.key, data); } finally { inRun--; }
        if (r) await settle(chatId, q.X, r);
        return r;
    });
    chain = p.catch(e => { dd.warn('lua button', e); return null; });
    return chain;
}

const LISTEN = { editinput: 'editInput', editoutput: 'editOutput', editdisplay: 'editDisplay', editRequest: 'editRequest' };
/** The card's Lua can answer this edit mode: some triggerlua code names the
 *  listener (listenEdit('editDisplay', ...)). RisuAI calls the Lua anyway and
 *  the wrapper finds no listener; here that call (once per message on every
 *  redraw) is skipped. */
function luaListens(risu, mode) {
    const name = LISTEN[mode];
    if (!risu || !Array.isArray(risu.triggerscript) || !name) return false;
    return risu.triggerscript.some(t => t && t.effect && t.effect[0] && t.effect[0].type === 'triggerlua'
        && String(t.effect[0].code || '').includes(name));
}

/** The card's Lua listenEdit functions on a text (scripts.js, display.js).
 *  mode 'editinput' | 'editoutput' | 'editdisplay' | 'editRequest'. Returns
 *  the new data, or the same when the card has no Lua. Variables a display
 *  hook sets are not kept (the screen redraws often). */
function luaEdit(chatId, charId, mode, data, meta) {
    const risu = S.risuGet(charId);
    if (risu && !luaListens(risu, mode)) return Promise.resolve(data);
    const p = chain.then(async () => {
        const q = await prepare(chatId, charId, false);
        if (!q || !q.E.hasLua(q.X.key)) return data;
        const r = await q.E.luaEdit(q.X.key, mode, data, meta || {});
        if (!r) return data;
        if (mode !== 'editdisplay') {
            const before = q.X.ctx.vars || {};
            const changed = {};
            for (const [k, v] of Object.entries(r.vars || {})) if (before[k] !== v) changed[k] = v;
            if (Object.keys(changed).length) { await V.setMany(chatId, changed); D.freshCtx(); }
        }
        return r.data == null ? data : r.data;
    });
    chain = p.catch(e => { dd.warn('lua edit', mode, e); return data; });
    return chain;
}

dd.shared.triggers = { run, onStart, onInput, onReply, onClick, onLuaClick, luaEdit, luaListens, takeSys, askLowLevel };
