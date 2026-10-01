
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
            else if (d.t === 'parse') out = E.parse(d.key, d.text, d.o);
        } catch (x) { err = String((x && x.message) || x); }
        self.postMessage({ id: d.id, fim: true, out, err });
    };
}

dd.shared.engine = { rizzEngine, rizzWorkerMain };
