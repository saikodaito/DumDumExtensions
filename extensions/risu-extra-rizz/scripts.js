// Risu's extra Rizz: the card's scripts on the way to the model, as RisuAI
// does them (src/ts/process/index.svelte.ts, sendChat):
//   fields  (each send, before the app's lorebook and macros)
//           1. runCurrentChatFunction: {{setvar}}, {{addvar}}... in the chat's
//              messages run once, in order (RisuAI removes them from the
//              message; here the message stays and vars.js remembers which ran);
//           2. CBS in the description, personality, scenario, examples, system
//              prompt, persona and every lorebook entry, with fresh draws
//              ({{roll}} rolls again each send), and the entry's @@ decorators
//              (@@depth N and @@role become the app's "in chat" position).
//   history the copy of the history that goes to the model: CBS, then the
//           card's editprocess regex (the saved messages do not change).
//   input   the user's message before it is saved: CBS + editinput regex.
//   output  the reply before it is saved: CBS + editoutput regex.
// Regex run in the worker (display.js); CBS alone runs on the page.

const S = dd.shared.store;
const V = dd.shared.vars;
const D = dd.shared.display;
const HISTORY_MS = 2500;       // under the app's 3 s for a prompt hook

const FIELDS = ['description', 'personality', 'scenario', 'exampleDialogue', 'systemPrompt', 'persona'];
const hasCbs = s => typeof s === 'string' && (s.includes('{{') || /<(?:user|char|bot)>/i.test(s));
const hasMode = (risu, mode) => Array.isArray(risu.customScripts) && risu.customScripts.some(x => x && x.type === mode && x.in);
/** RisuAI's escape characters, for text that goes to the model (not HTML). */
const PROMPT_ESC = ['{', '}', '(', ')', '<', '>', ':', ';'];
const toModel = s => String(s).replace(/[-]/g, c => PROMPT_ESC[c.charCodeAt(0) - 0xE9B8]);

async function setup(ctx) {
    if (!dd.shared.cfg.scripts || !ctx || !ctx.charId || !ctx.chatId) return null;
    const risu = await S.risuEnsure(ctx.charId);
    if (!risu) return null;
    await V.load(ctx.chatId);
    const X = D.ctxNow(ctx.chatId, ctx.charId, risu);
    return X ? { risu, X } : null;
}

// ── 1. Variables from the messages (runCurrentChatFunction) ────────────────
const SETS = /\{\{\s*(?:setvar|addvar|setdefaultvar)\s*::/i;
async function runPendingVars(ctx, risu, X) {
    const chat = dd.state.chat();
    if (!chat || chat.id !== ctx.chatId) return X;
    const msgs = chat.messages || [];
    const done = await V.done(ctx.chatId);
    const list = [], marks = {};
    // Regenerate: the reply being replaced is about to go (RisuAI deletes it
    // before sending), so its {{setvar}}s do not run.
    const end = ctx.kind === 'regen' ? msgs.length - 1 : msgs.length;
    for (let i = X.offset; i < end; i++) {
        const t = msgs[i].text;
        const h = String(S.hash(t));
        const prev = done[i];              // { h, n }: hash and length of what ran
        if (prev && prev.h === h) continue;
        // A message that only grew (continue) runs just the new part.
        const grew = prev && prev.n < t.length && String(S.hash(t.slice(0, prev.n))) === prev.h;
        const part = grew ? t.slice(prev.n) : t;
        marks[i] = { h, n: t.length };
        if (SETS.test(part)) list.push({ text: part, chatID: i - X.offset });
    }
    if (!list.length) { await V.markDone(ctx.chatId, marks); return X; }
    const vars = D.page(X).runVars(X.key, list);
    if (vars) await V.setMany(ctx.chatId, vars);
    await V.markDone(ctx.chatId, marks);
    D.freshCtx();
    return D.ctxNow(ctx.chatId, ctx.charId, risu) || X;
}

// ── 2. Fields and lorebook ───────────────────────────────────────────────
/** Leading @@ lines of an entry (RisuAI decorators) → the entry's changes. */
function decorators(content) {
    const lines = String(content).split('\n');
    const mud = {};
    let i = 0;
    for (; i < lines.length; i++) {
        const m = /^@@@?([a-z_]+)\s*(.*)$/i.exec(lines[i].trim());
        if (!m) break;
        const name = m[1].toLowerCase(), arg = m[2].trim();
        if (name === 'depth') { const n = parseInt(arg, 10); if (Number.isFinite(n) && n >= 0) { mud.position = 'depth'; mud.depth = n; } }
        else if (name === 'end') { mud.position = 'depth'; mud.depth = 0; }
        else if (name === 'role') { if (['system', 'user', 'assistant'].includes(arg)) mud.role = arg; }
        else if (name === 'dont_activate') mud.enabled = false;
        else if (name === 'activate') mud.constant = true;
        // The rest (scan depth, probability, inject_*...) only leaves the text.
    }
    if (mud.position === 'depth' && !mud.role) mud.role = 'system';
    return { text: lines.slice(i).join('\n'), mud, had: i > 0 };
}

async function fields(f, ctx) {
    const s = await setup(ctx);
    if (!s) return null;
    let X = await runPendingVars(ctx, s.risu, s.X);
    // RisuAI runs the start triggers here too (triggers.js), then builds the prompt.
    if (dd.shared.triggers) {
        await dd.shared.triggers.onStart(ctx);
        D.freshCtx();
        X = D.ctxNow(ctx.chatId, ctx.charId, s.risu) || X;
    }
    const E = D.page(X);
    const parse = t => toModel(E.parse(X.key, t, { chatID: -1 }));
    const out = {};
    for (const k of FIELDS) if (hasCbs(f[k])) { const v = parse(f[k]); if (v !== f[k]) out[k] = v; }
    const lore = {};
    for (const e of f.lore || []) {
        let c = String(e.content || '');
        let mud = {};
        if (c.startsWith('@@')) { const d = decorators(c); c = d.text; mud = d.mud; if (d.had) mud.content = c; }
        if (hasCbs(c)) { const v = parse(c); if (v !== e.content) mud.content = v; }
        if (Object.keys(mud).length) lore[e.id] = mud;
    }
    if (Object.keys(lore).length) out.lore = lore;
    return Object.keys(out).length ? out : null;
}

// ── 3. The history copy ─────────────────────────────────────────────────
async function history(msgs, ctx) {
    const s = await setup(ctx);
    if (!s) return null;
    const { risu, X } = s;
    const proc = hasMode(risu, 'editprocess');
    const E = D.page(X);
    const optsOf = m => {
        const first = m.index < X.offset;
        return { mode: 'editprocess', chatID: first ? -1 : m.index - X.offset, role: m.role === 'user' ? 'user' : 'char', pre: 'history', rmVar: true };
    };
    // CBS alone, on the page: the answer when there is no regex, or the
    // fallback for a message the worker did not finish in time.
    const cbsOnly = (m) => {
        if (!hasCbs(m.text)) return m.text;
        try { return toModel(E.parse(X.key, m.text, { chatID: optsOf(m).chatID })); } catch (e) { return m.text; }
    };
    if (!proc) return luaRequest(ctx, X, msgs, msgs.map(m => (m.role === 'system' ? m.text : cbsOnly(m))));
    const out = msgs.map(m => m.text);
    const jobs = msgs.map((m, i) => m.role === 'system' ? null
        : D.run('script', X, m.text, optsOf(m)).then(r => { out[i] = r == null ? cbsOnly(m) : toModel(r); jobs[i] = null; }));
    let timer;
    await Promise.race([
        Promise.all(jobs.filter(Boolean)),
        new Promise(r => { timer = setTimeout(r, HISTORY_MS); }),
    ]);
    clearTimeout(timer);
    // What did not come back in time goes with CBS only (never raw macros).
    jobs.forEach((j, i) => { if (j) out[i] = cbsOnly(msgs[i]); });
    return luaRequest(ctx, X, msgs, out);
}
/** The card's Lua listenEdit('editRequest') on the history copy: RisuAI gives
 *  it the whole request; here the history, and only a same-length answer is
 *  taken (the app builds the rest of the prompt). */
async function luaRequest(ctx, X, msgs, texts) {
    if (!dd.shared.triggers || !D.page(X).hasLua(X.key)) return texts;
    const req = msgs.map((m, i) => ({ role: m.role === 'user' ? 'user' : m.role === 'system' ? 'system' : 'assistant', content: texts[i] }));
    const r = await dd.shared.triggers.luaEdit(ctx.chatId, ctx.charId, 'editRequest', req, {});
    if (!Array.isArray(r) || r.length !== texts.length) return texts;
    return r.map((x, i) => (x && typeof x.content === 'string') ? x.content : texts[i]);
}

// ── 4. Input and output ─────────────────────────────────────────────────
async function scriptPass(text, ctx, mode, role, index) {
    const s = await setup(ctx);
    if (!s || typeof text !== 'string' || !text) return text;
    const { risu } = s;
    // RisuAI's processScriptFull: the card's Lua listenEdit first.
    if (dd.shared.triggers && s.X && D.page(s.X).hasLua(s.X.key)) {
        const t = await dd.shared.triggers.luaEdit(ctx.chatId, ctx.charId, mode, text, { index: index - s.X.offset });
        if (typeof t === 'string') text = t;
    }
    const X = D.ctxNow(ctx.chatId, ctx.charId, risu) || s.X;
    const chatID = Math.max(-1, index - X.offset);
    if (!hasMode(risu, mode)) {
        if (!hasCbs(text)) return text;
        return toModel(D.page(X).script(X.key, text, { mode, chatID, role }));
    }
    const r = await D.run('script', X, text, { mode, chatID, role });
    return r == null ? text : toModel(r);
}
function chatLength() {
    const chat = dd.state.chat();
    return chat ? (chat.messages || []).length : 0;
}
/** dd.input.transform: the user's message about to be saved (index = the end). */
const input = async (text, ctx) => {
    // RisuAI: the input triggers first, then editinput on the message.
    if (dd.shared.triggers) await dd.shared.triggers.onInput(ctx);
    return scriptPass(text, ctx, 'editinput', 'user', chatLength());
};
/** dd.prompt.transform: the reply about to be saved. On send it will be the
 *  next message; on regenerate and continue, the last one. */
const output = (text, ctx) => scriptPass(text, ctx, 'editoutput', 'char', chatLength() - (ctx && ctx.kind !== 'send' ? 1 : 0));

/** The {{setvar}}s of the messages now (triggers.js, after a reply: RisuAI
 *  runs runCurrentChatFunction before the output triggers). */
async function runVarsNow(ctx) {
    const s = await setup(ctx);
    if (s) await runPendingVars(ctx, s.risu, s.X);
}

dd.shared.scripts = { fields, history, input, output, decorators, runVarsNow };
