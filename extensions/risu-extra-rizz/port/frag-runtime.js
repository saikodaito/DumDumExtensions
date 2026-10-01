
    // ── Runtime (DumDum side) ────────────────────────────────────────────
    // CUR is the context of the job that is running. Jobs are synchronous and
    // run one at a time, so a module variable is enough.
    let CUR = null;
    let _rng = Math.random;
    const _rand = () => _rng();

    // svelte/store `get` + the store of the clicked element's risu-id (trigger_id).
    const CurrentTriggerIdStore = null;
    const get = () => (CUR && CUR.triggerId) || null;

    // The Buffer calls of cbs.ts (base64 and utf-8 only).
    const Buffer = {
        from(v, enc) {
            let u8;
            if (typeof v === 'string') {
                if (enc === 'base64') {
                    const b = atob(v.replace(/[^A-Za-z0-9+/=]/g, ''));
                    u8 = new Uint8Array(b.length);
                    for (let i = 0; i < b.length; i++) u8[i] = b.charCodeAt(i);
                } else u8 = new TextEncoder().encode(v);
            } else u8 = new Uint8Array(v);
            u8.toString = function (e) {
                if (e === 'base64') {
                    let s = '';
                    for (let i = 0; i < this.length; i++) s += String.fromCharCode(this[i]);
                    return btoa(s);
                }
                return new TextDecoder().decode(this);
            };
            return u8;
        },
    };
    const safeStructuredClone = o => {
        try { return structuredClone(o); } catch (e) { return JSON.parse(JSON.stringify(o)); }
    };

    // ── src/ts/util.ts ───────────────────────────────────────────────────
    function sfc32(a, b, c, d) {
        return function () {
            a |= 0; b |= 0; c |= 0; d |= 0;
            let t = (a + b | 0) + d | 0;
            d = d + 1 | 0;
            a = b ^ b >>> 9;
            b = c + (c << 3) | 0;
            c = (c << 21 | c >>> 11);
            c = c + t | 0;
            return (t >>> 0) / 4294967296;
        };
    }
    function pickHashRand(cid, word) {
        let hashAddress = 5515;
        const rand = (word) => {
            for (let counter = 0; counter < word.length; counter++) {
                hashAddress = ((hashAddress << 5) + hashAddress) + word.charCodeAt(counter);
            }
            return hashAddress;
        };
        const randF = sfc32(rand(word), rand(word), rand(word), rand(word));
        const v = cid % 1000;
        for (let i = 0; i < v; i++) {
            randF();
        }
        return randF();
    }
    function parseKeyValue(template) {
        try {
            if (!template) {
                return [];
            }
            const keyValue = [];
            for (const line of template.split('\n')) {
                const [key, value] = line.split('=');
                if (key && value) {
                    keyValue.push([key, value]);
                }
            }
            return keyValue;
        } catch (error) {
            return [];
        }
    }
    /** A per-message seed for _rand (DumDum: stable draws on screen). */
    function seeded(s) {
        let h = 5381;
        for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
        return sfc32(h, h ^ 0x9e3779b9, h ^ 0x85ebca6b, h ^ 0xc2b2ae35);
    }

    // ── src/ts/parser/chatVar.svelte.ts (adapted) ────────────────────────
    // RisuAI keeps chat variables in chat.scriptstate['$' + key]; here they
    // are CUR.vars[key], kept per chat by the extension.
    function getChatVar(key) {
        const state = CUR.vars[key];
        if (state === undefined || state === null) {
            const defaultVariables = parseKeyValue(CUR.char.defaultVariables).concat(parseKeyValue(CUR.db.templateDefaultVariables));
            const findResult = defaultVariables.find((f) => {
                return f[0] === key;
            });
            if (findResult) {
                return findResult[1];
            }
            return 'null';
        }
        return state.toString();
    }
    function setChatVar(key, value) {
        if (CUR.vars[key] === value) {
            return false;
        }
        CUR.vars[key] = value;
        CUR.varsChanged = true;
        return true;
    }
    function getGlobalChatVar(key) {
        const v = CUR.globals[key];
        return (v !== undefined && v !== null && v !== 'null') ? String(v) : 'null';
    }

    // ── The context: RisuAI's database, seen from one chat ───────────────
    // c = { char, chat, user, vars, globals, db, meta } (see display.js).
    function view(c) {
        c = c || {};
        const chat = Object.assign({ id: '', fmIndex: -1, message: [], note: '', localLore: [] }, c.chat || {});
        if (!Array.isArray(chat.message)) chat.message = [];
        const char = Object.assign({
            type: 'character', name: '', nickname: '', desc: '', personality: '', scenario: '',
            exampleMessage: '', firstMessage: '', alternateGreetings: [], chaId: '', additionalAssets: [],
            emotionImages: [], defaultVariables: '', customscript: [], globalLore: [],
            prebuiltAssetCommand: false, prebuiltAssetExclude: [],
        }, c.char || {});
        char.chats = [chat];
        char.chatPage = 0;
        const db = Object.assign({
            aiModel: '', subModel: '', mainPrompt: '', jailbreak: '', globalNote: '', maxContext: 0,
            language: 'en', jailbreakToggle: false, templateDefaultVariables: '', globalChatVariables: {},
            promptTemplate: null,
        }, c.db || {});
        db.characters = [char];
        return {
            char, chat, db,
            vars: Object.assign({}, c.vars || {}),
            globals: Object.assign({}, c.globals || {}),
            user: Object.assign({ name: 'User', persona: '' }, c.user || {}),
            meta: Object.assign({ w: 0, h: 0 }, c.meta || {}),
            triggerId: null, varsChanged: false,
        };
    }
