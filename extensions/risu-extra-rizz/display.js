// Risu's extra Rizz: the card's macros (CBS) and display regex in the chat.
//
// Each message goes through what RisuAI does before drawing it (engine.js):
// CBS with the chat's variables, then the card's editdisplay regex, each
// replacement parsed again. Then here: RisuAI's escape characters back to
// text, the card's classes renamed to x-risu-* (as RisuAI does, so a card's
// CSS cannot reach the app's own classes) and risu-trigger kept as a data-
// attribute. The asset marks come after (render.js).
//
// The regex are other people's code and a pattern can hang (catastrophic
// backtracking). With editdisplay scripts the work goes to a worker: the
// message is drawn as it is, then redrawn when the result arrives; a script
// that runs over SCRIPT_MS on one message is skipped on that message only.
// A card with no scripts (CBS only) runs on the page: it is linear and fast.

const S = dd.shared.store;
const V = dd.shared.vars;
const SCRIPT_MS = 300;        // one regex of the card, on one message
const CBS_MS = 2000;          // the CBS pass before the first regex
const MEMO_MAX = 800;
const RISU_VER = '2026.8.250';   // RisuAI version the engine was ported from ({{metadata::version}})

const env = () => ({ local: true, mobile: dd.platform === 'mobile', appVer: RISU_VER });

// ── RisuAI's escapes, back to text (parser.svelte.ts risuUnescape) ───────
const UNESC = ['{', '}', '(', ')', '&lt;', '&gt;', ':', ';'];
const unescape = s => s.replace(/[-]/g, c => UNESC[c.charCodeAt(0) - 0xE9B8]);

// ── The card's classes, renamed (RisuAI: x-risu-*) ──────────────────────
// RisuAI puts ".chattext " before every selector, so html, body and :root in a
// card's CSS match nothing there (the message has no such elements). The app
// would turn them into the bubble itself, and a card that styles them
// (Jiyu: body { display: flex }) squeezed the whole message into a row.
// They become :not(*), which matches nothing here too.
function prefixSelector(sel) {
    return sel.replace(/\[[^\]]*\]|"[^"]*"|'[^']*'|\.(-?[A-Za-z_][\w-]*)|(^|[\s>+~,(])(html|body|:root)(?![\w-])/gi,
        (m, cls, pre, root) => {
            if (root !== undefined) return pre + ':not(*)';
            return (cls === undefined || cls.startsWith('x-risu-')) ? m : '.x-risu-' + cls;
        });
}
/** Index of the first of `stops` at i or after, skipping strings and comments. */
function scanTo(s, i, stops) {
    for (; i < s.length; i++) {
        const c = s[i];
        if (c === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); if (e < 0) return -1; i = e + 1; continue; }
        if (c === '"' || c === "'") { for (i++; i < s.length && s[i] !== c; i++) if (s[i] === '\\') i++; continue; }
        if (stops.includes(c)) return i;
    }
    return -1;
}
function closeOf(s, open) {
    let depth = 0;
    for (let i = open; i < s.length; i++) {
        const j = scanTo(s, i, '{}');
        if (j < 0) return s.length;
        if (s[j] === '{') depth++;
        else if (--depth === 0) return j;
        i = j;
    }
    return s.length;
}
/** Class selectors of a style sheet renamed; @media and friends recurse,
 *  @keyframes, @font-face and the declarations are left alone. */
function prefixCss(css) {
    let out = '', i = 0;
    while (i < css.length) {
        const j = scanTo(css, i, '{;}');
        if (j < 0) { out += css.slice(i); break; }
        if (css[j] !== '{') { out += css.slice(i, j + 1); i = j + 1; continue; }
        const prelude = css.slice(i, j), end = closeOf(css, j), inner = css.slice(j + 1, end), p = prelude.trim();
        if (/^@(media|supports|container|layer|document)\b/i.test(p)) out += prelude + '{' + prefixCss(inner) + '}';
        else if (p.startsWith('@')) out += prelude + '{' + inner + '}';
        else out += prefixSelector(prelude) + '{' + inner + '}';
        i = end + 1;
    }
    return out;
}
// vw in a card's CSS: on RisuAI the message is as wide as the window, so
// cards size panels with calc(100vw - 32px). Here it measures the message
// (the app keeps --dd-chat-vw = 1% of a wide message's width).
const VW = /(-?(?:\d+\.?\d*|\.\d+))[dsl]?vw\b/gi;
const chatVw = css => css.replace(VW, (m, n) => 'calc(' + n + ' * var(--dd-chat-vw, 1vw))');

/** HTML from a card: class names renamed, <style> too, risu-* attributes kept
 *  as data-risu-* (the app's sanitizer drops unknown attributes). */
function scopeHtml(html) {
    return html
        .replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, a, css, z) => a + chatVw(prefixCss(css)) + z)
        .replace(/(\sstyle\s*=\s*)("[^"]*"|'[^']*')/gi, (m, a, v) => a + chatVw(v))
        .replace(/(\sclass\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi, (m, a, dq, sq) => {
            const v = (dq != null ? dq : sq).split(/\s+/).filter(Boolean)
                .map(c => (c.startsWith('x-risu-') || c.startsWith('hljs')) ? c : 'x-risu-' + c).join(' ');
            return a + '"' + v + '"';
        })
        .replace(/(\s)(risu-(?:trigger|btn|id))(\s*=)/gi, '$1data-$2$3');
}
/** RisuAI's markdown has no indented code blocks (markdown-it with 'code'
 *  disabled); the app's does. Cards write their regex HTML indented, and from
 *  4 spaces (or a tab) on, after a blank line, the app showed it as code.
 *  So: lines indented 4+ lose the indentation, except inside <pre>,
 *  <textarea> and ``` fences, and list items (nested lists keep working). */
function noIndentCode(s) {
    if (!/\n(?: {4}|\t)/.test(s)) return s;
    let raw = 0, fence = false;
    return s.split('\n').map(line => {
        if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return line; }
        const opens = (line.match(/<(pre|textarea)\b/gi) || []).length;
        const closes = (line.match(/<\/(pre|textarea)>/gi) || []).length;
        const inside = fence || raw > 0;
        raw = Math.max(0, raw + opens - closes);
        if (inside || !/^(?: {4}|\t)/.test(line) || /^\s*(?:[-*+]|\d+[.)])\s/.test(line)) return line;
        return line.replace(/^\s+/, '');
    }).join('\n');
}
const finish = s => scopeHtml(noIndentCode(unescape(s)));

// ── Context: what RisuAI's database would say about this chat ────────────
const hasDisplayScripts = risu => Array.isArray(risu.customScripts)
    && risu.customScripts.some(x => x && x.type === 'editdisplay' && x.in);
// Only a Lua that registers listenEdit('editDisplay') changes the screen; the
// others would pay one Lua call per message at every redraw for nothing.
const hasLua = risu => !!(dd.shared.triggers && dd.shared.triggers.luaListens(risu, 'editdisplay'));
const luaPending = new Set();    // display jobs waiting for the Lua pass

let ctxMemo = null;           // the last context built (reused within 60 ms)
const sigListeners = new Set();

/** { key, sig, ctx, offset, scripts } for the open chat, or null. */
function ctxNow(chatId, charId, risu) {
    const now = Date.now();
    if (ctxMemo && ctxMemo.chatId === chatId && ctxMemo.charId === charId && now - ctxMemo.t < 60) return ctxMemo.x;
    const chat = dd.state.chat();
    if (!chat || chat.id !== chatId) return null;
    const msgs = chat.messages || [];
    const vars = V.get(chatId);
    const p = dd.state.persona() || {};
    let total = 0;
    for (const m of msgs) total += m.text.length;
    const w = Math.round((typeof innerWidth === 'number' ? innerWidth : 0) / 10) * 10;
    const sig = [chatId, charId, S.risuStamp, V.version, msgs.length, total, p.name || '', w].join('|');
    if (ctxMemo && ctxMemo.chatId === chatId && ctxMemo.x.sig === sig) { ctxMemo.t = now; return ctxMemo.x; }
    const c = dd.state.char(charId) || {};
    const off = msgs.length && msgs[0].role === 'assistant' ? 1 : 0;
    const lib = S.get(charId);
    const x = {
        key: chatId, sig, offset: off, scripts: hasDisplayScripts(risu), lua: hasLua(risu),
        ctx: {
            char: {
                name: c.inChatName || c.name || '', desc: c.description || '', personality: c.personality || '',
                scenario: c.scenario || '', exampleMessage: c.exampleDialogue || '',
                firstMessage: off ? msgs[0].text : (c.firstMessage || ''),
                alternateGreetings: c.alternateGreetings || [], chaId: String(charId),
                additionalAssets: lib ? lib.items.map(it => [it.name, '', it.ext]) : [],
                defaultVariables: String(risu.defaultVariables || ''),
                customscript: Array.isArray(risu.customScripts) ? risu.customScripts.filter(s => s && typeof s.in === 'string') : [],
                // triggers.js. Low level access (model, images, Lua) comes later: off.
                triggerscript: Array.isArray(risu.triggerscript) ? risu.triggerscript : [],
                lowLevelAccess: false,
                prebuiltAssetCommand: !!risu.prebuiltAssetCommand,
                prebuiltAssetExclude: Array.isArray(risu.prebuiltAssetExclude) ? risu.prebuiltAssetExclude : [],
            },
            chat: {
                id: chatId, fmIndex: -1,
                message: msgs.slice(off).map(m => ({ role: m.role === 'user' ? 'user' : 'char', data: m.text, time: m.time || 0 })),
            },
            user: { name: p.name || 'User', persona: p.description || '' },
            vars, globals: {},
            db: { language: dd.lang },
            modules: Array.isArray(risu.modules) ? risu.modules : [],
            meta: { w: typeof innerWidth === 'number' ? innerWidth : 0, h: typeof innerHeight === 'number' ? innerHeight : 0 },
        },
    };
    const before = ctxMemo && ctxMemo.chatId === chatId ? ctxMemo.x.sig : null;
    ctxMemo = { chatId, charId, t: now, x };
    if (before !== sig) setTimeout(() => sigListeners.forEach(fn => { try { fn(chatId, charId); } catch (e) { dd.warn('sig', e); } }), 0);
    return x;
}

// ── Engines: the worker, and one on the page ─────────────────────────────
let pageE = null;
const pageSent = new Map();   // key → sig
function onPage(X) {
    if (!pageE) pageE = dd.shared.engine.rizzEngine(env());
    if (pageSent.get(X.key) !== X.sig) { pageE.setCtx(X.key, X.ctx); pageSent.set(X.key, X.sig); }
    return pageE;
}

let workerOk = typeof Worker === 'function' && typeof Blob === 'function';
let W = null;                 // { w, sent: Map(key → sig), job, tm }
let urlMode = 0;              // 0 blob:, 1 data: (file:// has no origin for blob workers)
const queue = [];             // jobs waiting (the newest goes first: the bottom of the chat)
const inflight = new Map();   // job key → job
const warned = new Set();
let seq = 0;

function workerSrc() {
    const E = dd.shared.engine;
    return `(${E.rizzWorkerMain})((${E.rizzEngine})(${JSON.stringify(env())}), self);`;
}
function newWorker() {
    const src = workerSrc();
    const url = urlMode === 0 ? URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))
        : 'data:text/javascript;charset=utf-8,' + encodeURIComponent(src);
    const w = new Worker(url);
    if (urlMode === 0) setTimeout(() => URL.revokeObjectURL(url), 5000);
    const slot = { w, sent: new Map(), job: null, tm: 0, ok: false };
    w.onmessage = e => onMsg(slot, e.data);
    w.onerror = ev => {
        try { ev.preventDefault(); } catch (x) { /* nothing */ }
        if (!slot.ok && urlMode === 0) { urlMode = 1; restart(slot); return; }
        giveUp(ev && ev.message);
    };
    return slot;
}
/** The blob: worker did not start (file://): again with a data: URL. */
function restart(slot) {
    clearTimeout(slot.tm);
    try { slot.w.terminate(); } catch (x) { /* gone */ }
    if (W === slot) W = null;
    if (slot.job) queue.push(slot.job);
    slot.job = null;
    pump();
}
/** No worker here: everything runs on the page from now on (between draws). */
function giveUp(why) {
    if (!workerOk) return;
    workerOk = false;
    dd.warn('worker unavailable, card scripts run on the page:', why || '');
    if (W) { clearTimeout(W.tm); try { W.w.terminate(); } catch (x) { /* gone */ } if (W.job) queue.push(W.job); W = null; }
    pump();
}

function pump() {
    if (!queue.length) return;
    if (!workerOk) {
        // On the page, one job per turn of the event loop.
        setTimeout(() => {
            const job = queue.pop();
            if (!job) return;
            let out = job.text;
            try { out = onPage(job.X)[job.t](job.X.key, job.text, job.o, { skip: new Set(job.skip) }); }
            catch (e) { dd.warn('engine', e); }
            done(job, out);
            pump();
        }, 0);
        return;
    }
    if (W && W.job) return;
    if (!W) {
        try { W = newWorker(); } catch (e) { giveUp(e && e.message); return; }
    }
    const job = queue.pop();
    W.job = job;
    job.id = ++seq;
    job.cur = -1;
    if (W.sent.get(job.X.key) !== job.X.sig) { W.w.postMessage({ t: 'ctx', key: job.X.key, ctx: job.X.ctx }); W.sent.set(job.X.key, job.X.sig); }
    W.w.postMessage({ t: job.t, id: job.id, key: job.X.key, text: job.text, o: job.o, skip: job.skip });
    const slot = W;
    slot.tm = setTimeout(() => overtime(slot), CBS_MS);
}
function onMsg(slot, d) {
    slot.ok = true;
    const job = slot.job;
    if (!job || !d || d.id !== job.id) return;
    clearTimeout(slot.tm);
    if (d.fim) {
        slot.job = null;
        if (d.err) dd.warn('engine', d.err);
        done(job, typeof d.out === 'string' ? d.out : job.text);
        pump();
        return;
    }
    job.cur = d.i;
    slot.tm = setTimeout(() => overtime(slot), SCRIPT_MS);
}
function overtime(slot) {
    const job = slot.job;
    slot.job = null;
    clearTimeout(slot.tm);
    try { slot.w.terminate(); } catch (x) { /* gone */ }
    if (W === slot) W = null;
    if (job && job.cur >= 0) {
        const scripts = job.X.ctx.char.customscript;
        const name = nameOf(scripts, job.cur);
        job.skip.push(job.cur);
        dd.warn(`regex skipped on this message (over ${SCRIPT_MS} ms):`, name);
        if (!warned.has(name)) { warned.add(name); dd.ui.toast(dd.t('toast_script_slow', { name }), 'warning'); }
        queue.push(job);                 // again, without the culprit, before the others
    } else if (job) {
        dd.warn('CBS pass over', CBS_MS, 'ms; message drawn without the card scripts');
        done(job, job.text, true);
    }
    pump();
}
/** The name of script i in the order the engine runs them (by <order N>, as RisuAI). */
function nameOf(scripts, i) {
    const ord = s => { const m = /<[^>]*order\s+(-?\d+)/i.exec(String(s.flag || '')); return s.ableFlag && m ? parseInt(m[1], 10) : 0; };
    const sorted = scripts.some(s => ord(s)) ? scripts.map((s, k) => ({ s, k })).sort((a, b) => ord(b.s) - ord(a.s) || a.k - b.k) : scripts.map((s, k) => ({ s, k }));
    const it = sorted[i];
    return (it && (it.s.comment || ('#' + (it.k + 1)))) || '?';
}
function done(job, out, failed) {
    inflight.delete(job.k);
    try { job.cb(failed ? null : out); } catch (e) { dd.warn('display', e); }
}
/** Queues a job (one per key at a time). t: 'display' | 'background'. */
function request(t, X, text, o, k, cb) {
    if (inflight.has(k)) return;
    const job = { t, X, text, o, k, cb, skip: [] };
    inflight.set(k, job);
    queue.push(job);
    pump();
}

/** RisuAI's BackgroundDom: the card's backgroundHTML, then the module's background embedding. */
const bgHtml = risu => String(risu.backgroundHTML || '') + (risu.moduleBackground ? '\n' + risu.moduleBackground : '');

// ── Messages ──────────────────────────────────────────────────────────────
const memo = new Map();       // chatId|index|role → { text, sig, out }
const seen = new Map();       // chatId|index|role → the last render context and text (rerun)
function memoSet(k, v) {
    memo.delete(k);
    memo.set(k, v);
    while (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
}

/** dd.render.text step: the message with the card's CBS and display regex.
 *  ctx = the app's render context. Returns the text to draw now. */
function text(src, ctx) {
    const risu = S.risuGet(ctx.charId);
    if (!risu) return src;
    const X = ctxNow(ctx.chatId, ctx.charId, risu);
    if (!X) return src;
    const i = ctx.msgIndex | 0, first = i < X.offset;
    const o = { chatID: first ? -1 : i - X.offset, role: ctx.role === 'user' ? 'user' : 'char', firstmsg: first, seed: ctx.chatId + ':' + i };
    const mk = ctx.chatId + '|' + i + '|' + o.role + (ctx.streaming ? '|s' : '');
    if (!ctx.streaming) {
        seen.delete(mk);
        seen.set(mk, { src, ctx: { chatId: ctx.chatId, charId: ctx.charId, msgIndex: i, role: ctx.role, streaming: false } });
        while (seen.size > MEMO_MAX) seen.delete(seen.keys().next().value);
    }
    const m = memo.get(mk);
    if (m && m.text === src && m.sig === X.sig) return m.out;

    // No regex (and no Lua): CBS only, here and now.
    if (!X.scripts && !X.lua) {
        let out = src;
        try { out = finish(onPage(X).display(X.key, src, o)); } catch (e) { dd.warn('engine', e); }
        memoSet(mk, { text: src, sig: X.sig, out });
        return out;
    }
    // While it streams, one job at a time for the message (the next draw, 250 ms
    // later, asks again with the newer text).
    const k = ctx.streaming ? mk : mk + '|' + X.sig + '|' + src.length + '|' + src.slice(-64);
    const done = out => {
        if (out == null) { memoSet(mk, { text: src, sig: X.sig, out: src }); return; }
        const prev = memo.get(mk);
        const fin = finish(out);
        memoSet(mk, { text: src, sig: X.sig, out: fin });
        if (!ctx.streaming && (!prev || prev.out !== fin || prev.text !== src) && dd.render.redraw) dd.render.redraw(ctx.chatId, i);
    };
    if (X.lua && dd.shared.triggers) {
        // RisuAI: the card's Lua listenEdit('editDisplay') runs first (on the
        // page, wasmoon), then the CBS and the regex in the worker.
        if (!luaPending.has(k)) {
            luaPending.add(k);
            dd.shared.triggers.luaEdit(ctx.chatId, ctx.charId, 'editdisplay', src, { index: o.chatID })
                .then(pre => request('display', X, typeof pre === 'string' ? pre : src, o, k, done))
                .finally(() => luaPending.delete(k));
        }
    } else request('display', X, src, o, k, done);
    // Meanwhile: the last result of this message (same text) or, while it
    // streams, the last one drawn (a little shorter, but already with the
    // regex) instead of the raw text flashing at every draw. A reply that just
    // finished takes the stream's last result.
    if (m && (m.text === src || ctx.streaming)) return m.out;
    const st = ctx.streaming ? null : memo.get(mk + '|s');
    if (st && st.text === src) return st.out;
    return src;
}

/** The card's backgroundHTML through the engine (callback with the text, or
 *  null when the engine gave up on it). */
function background(chatId, charId, risu, cb) {
    const X = ctxNow(chatId, charId, risu);
    if (!X) return;
    const html = bgHtml(risu);
    const o = { seed: chatId + ':bg' };
    if (!X.scripts) {
        let out = null;
        try { out = onPage(X).background(X.key, html, o); } catch (e) { dd.warn('engine', e); }
        cb(out == null ? null : unescape(out), X);
        return;
    }
    request('background', X, html, o, chatId + '|bg|' + X.sig, out => cb(out == null ? null : unescape(out), X));
}

/** The variables changed (a card button, a trigger): the messages this chat
 *  drew go through the card's scripts again and only the ones whose result
 *  changed are redrawn. A whole-chat redraw per button was most of a
 *  click's cost (every bubble rebuilt with stale text, then again). */
function rerun(chatId) {
    ctxMemo = null;
    const list = [];
    for (const [k, v] of seen) if (k.startsWith(chatId + '|')) list.push([k, v]);
    if (!list.length || !dd.render.redraw || dd.state.activeChatId() !== chatId) { dd.render.refresh(); return; }
    const chat = dd.state.chat();
    const n = chat && chat.id === chatId ? (chat.messages || []).length : 0;
    for (const [k, v] of list) {
        if (v.ctx.msgIndex >= n) { seen.delete(k); continue; }
        const before = memo.get(k);
        let out;
        try { out = text(v.src, v.ctx); } catch (e) { dd.warn('display', e); continue; }
        // Scripts in the worker redraw on their own when the result lands
        // (done); CBS only answers here and now.
        if (before && out !== before.out && memo.get(k) && memo.get(k).out === out) dd.render.redraw(chatId, v.ctx.msgIndex);
    }
}

function drop(chatId) {
    for (const k of [...memo.keys()]) if (k.startsWith(chatId + '|')) memo.delete(k);
    for (const k of [...seen.keys()]) if (k.startsWith(chatId + '|')) seen.delete(k);
    pageSent.delete(chatId);
    if (pageE) pageE.dropCtx(chatId);
    if (W) { W.sent.delete(chatId); try { W.w.postMessage({ t: 'drop', key: chatId }); } catch (e) { /* gone */ } }
    if (ctxMemo && ctxMemo.chatId === chatId) ctxMemo = null;
}
function stop() {
    queue.splice(0);
    inflight.clear();
    memo.clear();
    seen.clear();
    ctxMemo = null;
    pageSent.clear();
    pageE = null;
    if (W) { clearTimeout(W.tm); try { W.w.terminate(); } catch (e) { /* gone */ } W = null; }
}

let promSeq = 0;
/** A job as a promise (the prompt side): the text, or null when the engine
 *  gave up on it. t: 'display' | 'background' | 'script'. */
function run(t, X, text, o) {
    return new Promise(res => request(t, X, text, o, 'p|' + (++promSeq), out => res(out)));
}

dd.shared.display = {
    text, background, bgHtml, drop, stop, rerun, scopeHtml, prefixCss, unescape, ctxNow, run,
    /** The engine on the page, with X's context (CBS only: linear, safe here). */
    page: X => onPage(X),
    /** The next ctxNow builds a new context (variables just changed). */
    freshCtx() { ctxMemo = null; },
    onSig(fn) { sigListeners.add(fn); return () => sigListeners.delete(fn); },
    /** Forget results (variables or the card changed). */
    reset() { memo.clear(); ctxMemo = null; },
};
