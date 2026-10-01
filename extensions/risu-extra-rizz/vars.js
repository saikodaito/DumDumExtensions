// Risu's extra Rizz: RisuAI chat variables ({{getvar}}, {{setvar}}, $x in
// {{? }}), one set per chat, in dd.store.chat(chatId) (deleted with the chat).
//
// Kept apart from the app's own chat variables (SillyTavern presets), on
// purpose: a card and a preset may use the same names. The card's
// defaultVariables are not copied in: like RisuAI, a variable that was never
// set reads its default (engine.js, getChatVar).
//
// The chat render is synchronous, so a chat's variables are loaded ahead
// (chat.opened) and kept in memory. Apps without dd.store.chat (older than
// the F3a base) keep them in memory only.

const KEY = 'vars';
const cache = new Map();      // chatId → { vars, v }
const loading = new Map();
let version = 0;              // goes up on every change (part of the display signature)

const scope = chatId => (dd.store && typeof dd.store.chat === 'function') ? dd.store.chat(chatId) : null;

function load(chatId) {
    if (!chatId) return Promise.resolve(null);
    if (cache.has(chatId)) return Promise.resolve(cache.get(chatId).vars);
    if (loading.has(chatId)) return loading.get(chatId);
    const p = (async () => {
        let v = null;
        try { const sc = scope(chatId); v = sc ? await sc.get(KEY) : null; } catch (e) { dd.warn('vars', chatId, e); }
        const vars = v && typeof v === 'object' ? Object.assign({}, v) : {};
        cache.set(chatId, { vars, v: ++version });
        while (cache.size > 6) cache.delete(cache.keys().next().value);
        return vars;
    })().finally(() => loading.delete(chatId));
    loading.set(chatId, p);
    return p;
}

/** Synchronous: the chat's variables ({} while they load; the chat redraws). */
function get(chatId) {
    const e = cache.get(chatId);
    if (e) return e.vars;
    if (chatId && !loading.has(chatId)) load(chatId).then(() => dd.render.refresh()).catch(() => {});
    return {};
}

/** Several at once ({name: value}); saved right away. */
async function setMany(chatId, changes) {
    if (!chatId || !changes) return;
    const vars = Object.assign({}, await load(chatId));
    let changed = false;
    for (const [k, val] of Object.entries(changes)) {
        const s = String(val);
        if (vars[k] !== s) { vars[k] = s; changed = true; }
    }
    if (!changed) return;
    cache.set(chatId, { vars, v: ++version });
    const sc = scope(chatId);
    if (sc) await sc.set(KEY, vars);
}

function drop(chatId) { if (cache.delete(chatId)) version++; }

dd.shared.vars = {
    load, get, setMany, drop,
    get version() { return version; },
    clear() { cache.clear(); version++; },
};
