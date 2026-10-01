
    // ── src/ts/process/triggers.ts: what runTrigger reaches (DumDum side) ──
    // Triggers run on the page (alerts wait for the user), in an engine of
    // their own, one at a time. HOST is set by the page (triggers.js): alerts,
    // the "not supported here" note, the redraw request.
    let HOST = {};
    let CURCHAT = null;                 // RisuAI's "current chat" while a trigger runs
    const unsupported = (what) => { if (HOST.warn) HOST.warn(what); };
    const selectedCharID = { get: () => 0 };
    const ReloadGUIPointer = { n: 0, get() { return this.n; }, set(v) { this.n = v; if (HOST.reload) HOST.reload(); } };
    const ReloadChatPointer = { v: {}, update(f) { this.v = f(this.v) || {}; if (HOST.reload) HOST.reload(); } };
    const DBState = { get db() { return CUR.db; } };
    const getDatabase = () => CUR.db;
    const setDatabase = () => unsupported('database');
    const getCurrentCharacter = () => CUR.char;
    // Writes to the character (lorebook, description, notes) are not kept yet.
    const setCurrentCharacter = () => unsupported('character');
    // Inside a trigger run, the chat the trigger works on; outside (a Lua edit
    // hook, a Lua button), the context's own chat.
    const getCurrentChat = () => CURCHAT || (CUR && CUR.chat);
    const getModuleTriggers = () => [];          // the module's are already in triggerscript (store.js)
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const tokenize = async (s) => Math.ceil(String(s || '').length / 4);
    const parseChatML = () => null;
    const alertNormal = (t) => { if (HOST.alert) HOST.alert(String(t), 'info'); };
    const alertError = (t) => { if (HOST.alert) HOST.alert(String(t), 'error'); };
    const alertInput = async (t) => HOST.input ? String((await HOST.input(String(t))) ?? '') : '';
    const alertSelect = async (opts, display) => HOST.select ? String((await HOST.select(opts, display)) ?? '') : '';
    const processMultiCommand = async () => unsupported('command');
    // Low level access: the model goes through the page (dd.llm); image
    // generation and similarity search are not available here.
    const requestChatData = async (arg) => {
        if (!HOST.llm) { unsupported('llm'); return { type: 'fail', result: 'not available' }; }
        try { return { type: 'success', result: String(await HOST.llm((arg && arg.formated) || [])) }; }
        catch (e) { return { type: 'fail', result: String((e && e.message) || e) }; }
    };
    const generateAIImage = async () => { unsupported('image'); return null; };
    const writeInlayImage = async () => '';
    const getInlayAsset = async () => null;
    class HypaProcesser { async addText() {} async similaritySearch() { unsupported('similarity'); return []; } }

    // ── src/ts/process/scriptings.ts: what the Lua side reaches ──────────
    // Lua runs on wasmoon (RisuAI's engine): HOST.luaFactory() gives a
    // LuaFactory with RisuAI's json.lua mounted.
    const confirmShim = async (t) => HOST.confirm ? !!(await HOST.confirm(String(t))) : false;
    const alertConfirm = confirmShim;
    // Lua's request() reaches any https host in RisuAI; here the network is
    // limited to the extension's hosts, so it answers as refused.
    const fetchNative = async () => ({ status: 403, text: async () => 'request() is not available in DumDum' });
    const readImage = async () => null;
    const asBuffer = (x) => x;
    const getUserIcon = () => '';
    const getUserName = () => (CUR && CUR.user.name) || 'User';
    const getPersonaPrompt = () => (CUR && CUR.user.persona) || '';
    const getModuleLorebooks = () => [];
    const loadLoreBookV3Prompt = async () => ({ actives: [] });
    const v4 = () => (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now();
    async function hasher(data) {
        const d = await crypto.subtle.digest('SHA-256', data);
        return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
    }
    class Mutex {
        constructor() { this.p = Promise.resolve(); }
        runExclusive(fn) { const r = this.p.then(() => fn()); this.p = r.catch(() => {}); return r; }
    }
    class PyodideContext { constructor() { throw new Error('Python triggers are not supported'); } }
