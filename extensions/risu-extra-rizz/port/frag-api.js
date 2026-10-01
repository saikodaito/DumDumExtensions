
    // ── Entry points ─────────────────────────────────────────────────────
    const ctxs = new Map();     // key → view
    const withCtx = (key, seed, fn) => {
        const c = ctxs.get(key);
        if (!c) return null;
        CUR = c;
        c.vars0 = c.vars;
        c.vars = Object.assign({}, c.vars);      // a job never changes the stored variables
        _rng = seed ? seeded(String(seed)) : Math.random;
        try { return fn(c); }
        finally { c.vars = c.vars0; _rng = Math.random; CUR = null; }
    };

    return {
        setCtx(key, c) { ctxs.set(key, view(c)); },
        dropCtx(key) { ctxs.delete(key); },
        /** Plain CBS (what RisuAI does to a text without a message index). */
        parse(key, text, o) {
            o = o || {};
            const r = withCtx(key, o.seed, () => risuChatParser(String(text), { chatID: o.chatID == null ? -1 : o.chatID, cbsConditions: o.cbs || {} }));
            return r == null ? String(text) : r;
        },
        /** A message on screen: Chat.svelte's displaya() (CBS with rmVar and
         *  visualize), then ParseMarkdown's editdisplay pass. o = {chatID,
         *  role, firstmsg, seed}; hooks = {skip: Set, onScript(i, name)}. */
        display(key, text, o, hooks) {
            o = o || {};
            const r = withCtx(key, o.seed, () => {
                const cbsConditions = { firstmsg: !!o.firstmsg, chatRole: o.role || null };
                const chatID = o.chatID == null ? -1 : o.chatID;
                let data = risuChatParser(String(text), { chatID, rmVar: true, visualize: true, cbsConditions });
                return processScriptFull(data, 'editdisplay', chatID, cbsConditions, hooks).data;
            });
            return r == null ? String(text) : r;
        },
        /** A script pass that is not the screen: o.mode 'editinput' |
         *  'editoutput' | 'editprocess'. processScriptFull parses CBS first;
         *  o.pre ('history') is the extra parse RisuAI does on each history
         *  message before editprocess (risuChatParser with the character and the
         *  role); o.rmVar drops {{setvar}} and friends (they already ran). */
        script(key, text, o, hooks) {
            o = o || {};
            const r = withCtx(key, o.seed, (c) => {
                const chatID = o.chatID == null ? -1 : o.chatID;
                let data = String(text);
                if (o.pre === 'history') data = risuChatParser(data, { chara: c.char, role: o.role, rmVar: !!o.rmVar });
                return processScriptFull(data, o.mode, chatID, { chatRole: o.role || null }, hooks).data;
            });
            return r == null ? String(text) : r;
        },
        /** RisuAI's runCurrentChatFunction: CBS with runVar over messages, in
         *  order, so {{setvar}}/{{addvar}} change the variables. list =
         *  [{text, chatID}]. Returns the variables after the last one. */
        runVars(key, list) {
            const c = ctxs.get(key);
            if (!c) return null;
            CUR = c;
            const vars = Object.assign({}, c.vars);
            const keep = c.vars;
            c.vars = vars;
            try {
                for (const it of list || []) {
                    try { risuChatParser(String(it.text), { chara: c.char, chatID: it.chatID == null ? -1 : it.chatID, runVar: true }); }
                    catch (e) { /* one message does not stop the others */ }
                }
                return Object.assign({}, vars);
            } finally { c.vars = keep; CUR = null; }
        },
        /** Page side of the triggers: alerts, warn(what), reload(). */
        setHost(h) { HOST = h || {}; },
        /** RisuAI's runTrigger on this context (mode 'start' | 'input' |
         *  'output' | 'manual'; o = { manualName, triggerId }). The chat it
         *  sees is a copy: returns { messages, vars, sys, stop } (messages =
         *  the chat after the triggers, RisuAI's roles), or null without
         *  triggers. Run one at a time: the context stays set across awaits. */
        async trigger(key, mode, o) {
            o = o || {};
            const c = ctxs.get(key);
            if (!c || !Array.isArray(c.char.triggerscript) || !c.char.triggerscript.length) return null;
            const scriptstate = {};
            for (const [k, v] of Object.entries(c.vars)) scriptstate['$' + k] = v;
            const chat = {
                message: c.chat.message.map(m => Object.assign({}, m)), scriptstate,
                fmIndex: c.chat.fmIndex, localLore: [], note: c.chat.note || '',
            };
            const keep = c.vars;
            CUR = c;
            CURCHAT = { scriptstate };
            // CBS inside a trigger reads the variables the trigger is changing.
            c.vars = new Proxy({}, {
                get: (_, k) => (typeof k === 'string' ? CURCHAT.scriptstate['$' + k] : undefined),
                set: (_, k, v) => { CURCHAT.scriptstate['$' + String(k)] = v; return true; },
            });
            c.triggerId = o.triggerId || null;
            try {
                const r = await runTrigger(c.char, mode, { chat, manualName: o.manualName, triggerId: o.triggerId });
                const ss = (CURCHAT && CURCHAT.scriptstate) || scriptstate;
                const vars = {};
                for (const [k, v] of Object.entries(ss)) if (k[0] === '$') vars[k.slice(1)] = v == null ? 'null' : String(v);
                return {
                    messages: r && r.chat && Array.isArray(r.chat.message) ? r.chat.message.map(m => ({ role: m.role, data: String(m.data == null ? '' : m.data) })) : null,
                    vars, sys: r ? r.additonalSysPrompt : null, stop: !!(r && r.stopSending),
                };
            } finally { c.vars = keep; c.triggerId = null; CURCHAT = null; CUR = null; }
        },
        /** The card has Lua triggers (triggerlua). */
        hasLua(key) {
            const c = ctxs.get(key);
            return !!(c && (c.char.triggerscript || []).some(t => t && t.effect && t.effect[0] && t.effect[0].type === 'triggerlua'));
        },
        /** RisuAI's runLuaEditTrigger: the card's listenEdit functions on a text
         *  (mode 'editinput' | 'editoutput' | 'editdisplay') or on a request
         *  ('editRequest', data = [{role, content}]). Returns { data, vars }. */
        async luaEdit(key, mode, data, meta) {
            const c = ctxs.get(key);
            if (!c) return null;
            CUR = c;
            const keep = c.vars;
            c.vars = Object.assign({}, keep);
            try {
                let out;
                if (mode === 'editRequest') {
                    // runLuaEditTrigger has no case for it; RisuAI calls it straight.
                    out = data;
                    for (const t of (c.char.triggerscript || [])) {
                        if (t && t.effect && t.effect[0] && t.effect[0].type === 'triggerlua') {
                            const r = await runScripted(t.effect[0].code, { char: c.char, lowLevelAccess: false, mode: 'editRequest', data: out, meta });
                            out = (r && r.res) ?? out;
                        }
                    }
                } else out = await runLuaEditTrigger(c.char, mode, data, meta);
                return { data: out, vars: Object.assign({}, c.vars) };
            } finally { c.vars = keep; CUR = null; }
        },
        /** RisuAI's runLuaButtonTrigger (risu-btn="data"). Returns
         *  { messages, vars } like trigger(). */
        async luaButton(key, data) {
            const c = ctxs.get(key);
            if (!c) return null;
            CUR = c;
            const keepVars = c.vars, keepChat = c.chat;
            c.vars = Object.assign({}, keepVars);
            c.chat = Object.assign({}, keepChat, { message: keepChat.message.map(m => Object.assign({}, m)) });
            c.char.chats = [c.chat];
            try {
                const r = await runLuaButtonTrigger(c.char, String(data));
                const chat = (r && r.chat) || c.chat;
                return {
                    messages: Array.isArray(chat.message) ? chat.message.map(m => ({ role: m.role, data: String(m.data == null ? '' : m.data) })) : null,
                    vars: Object.assign({}, c.vars),
                };
            } finally { c.vars = keepVars; c.chat = keepChat; c.char.chats = [keepChat]; CUR = null; }
        },
        /** The card's backgroundHTML: BackgroundDom.svelte (CBS with the
         *  character) then ParseMarkdown's editdisplay pass, without a message. */
        background(key, html, o, hooks) {
            o = o || {};
            const r = withCtx(key, o.seed, (c) => {
                const data = risuChatParser(String(html), { chara: c.char });
                return processScriptFull(data, 'editdisplay', -1, {}, hooks).data;
            });
            return r == null ? String(html) : r;
        },
    };
}

/** Worker side: one job at a time, a message before each script so the page
 *  can stop a script that hangs (RisuAI cards are other people's regex). */
function rizzWorkerMain(E, self) {
    self.onmessage = (e) => {
        const d = e.data || {};
        if (d.t === 'ctx') { E.setCtx(d.key, d.ctx); return; }
        if (d.t === 'drop') { E.dropCtx(d.key); return; }
        const hooks = { skip: new Set(d.skip || []), onScript: (i) => self.postMessage({ id: d.id, i }) };
        let out = d.text, err = '';
        try {
            if (d.t === 'display') out = E.display(d.key, d.text, d.o, hooks);
            else if (d.t === 'background') out = E.background(d.key, d.text, d.o, hooks);
            else if (d.t === 'script') out = E.script(d.key, d.text, d.o, hooks);
            else if (d.t === 'parse') out = E.parse(d.key, d.text, d.o);
        } catch (x) { err = String((x && x.message) || x); }
        self.postMessage({ id: d.id, fim: true, out, err });
    };
}

dd.shared.engine = { rizzEngine, rizzWorkerMain };
