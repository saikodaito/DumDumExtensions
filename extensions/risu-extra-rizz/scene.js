// Risu's extra Rizz: the card's background and music.
//
// backgroundHTML: RisuAI draws it behind the chat (BackgroundDom.svelte), with
// the card's CBS and display regex, and its <style> reaches the messages
// (that is how the panels a card's regex makes get their look). Here it goes
// to the app's chat layer (dd.ui.chatLayer): the HTML behind the messages,
// the CSS scoped to this chat's messages. It is drawn again when the chat
// changes (a new message, a variable...), since it may read them.
//
// {{bgm::name}}: background music (dd.audio.music, under the app's Master
// volume, with a stop button). The newest message with a bgm wins; the same
// track is not restarted; a track the user stopped does not come back in
// this chat until it is opened again.

const S = dd.shared.store;
const D = dd.shared.display;
const BGM_VOLUME = 0.5;       // RisuAI's 'auto'

let shown = { chatId: null, key: '' };
let timer = 0;

function update(chatId, charId) {
    clearTimeout(timer);
    timer = setTimeout(() => run(chatId, charId), 80);
}
function layer(chatId, o) {
    if (dd.ui.chatLayer) dd.ui.chatLayer(chatId, o);
}
function clear(chatId) {
    if (shown.chatId === chatId && shown.key) layer(chatId, null);
    if (shown.chatId === chatId) shown = { chatId, key: '' };
}

function run(chatId, charId) {
    if (!chatId || dd.state.activeChatId() !== chatId) return;
    const risu = charId ? S.risuGet(charId) : null;
    const html = risu && dd.shared.cfg.scripts ? D.bgHtml(risu).trim() : '';
    if (!html) { clear(chatId); return; }
    D.background(chatId, charId, risu, out => {
        if (out == null || dd.state.activeChatId() !== chatId) return;
        let s = D.scopeHtml(out);
        const lib = S.get(charId);
        if (lib && dd.shared.cfg.chat) s = dd.shared.render.marks(s, lib, chatId + ':bg', 'back', { chatId, msgIndex: -1 });
        else if (!lib) S.ensure(charId).then(l => { if (l) update(chatId, charId); }).catch(() => {});
        const css = [];
        s = s.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (m, c) => { css.push(c); return ''; });
        const key = s + '\u0000' + css.join('\n');
        if (shown.chatId === chatId && shown.key === key) return;
        shown = { chatId, key };
        layer(chatId, { html: s, css: css.join('\n') });
    });
}

// ── Music ────────────────────────────────────────────────────────────────
let want = null;              // { chatId, idx, url, name }: the newest asked for
let playing = null;           // { chatId, url, handle }
let session = { chatId: null, stopped: new Set() };
let bgmTimer = 0;

function bgm(chatId, idx, url, name) {
    if (!dd.audio || typeof dd.audio.music !== 'function' || !chatId) return;
    if (session.chatId !== chatId) session = { chatId, stopped: new Set() };
    if (!want || want.chatId !== chatId || idx > want.idx) want = { chatId, idx, url, name };
    clearTimeout(bgmTimer);
    bgmTimer = setTimeout(playWanted, 150);
}
function playWanted() {
    const w = want;
    want = null;
    if (!w || dd.state.activeChatId() !== w.chatId || session.stopped.has(w.url)) return;
    const alive = playing && playing.handle && playing.handle.active;
    if (alive && playing.chatId === w.chatId && (playing.url === w.url || playing.idx >= w.idx)) return;
    const handle = dd.audio.music(w.url, { volume: BGM_VOLUME, label: String(w.name || '').replace(/\.[a-z0-9]{2,5}$/i, '') });
    playing = handle ? { chatId: w.chatId, url: w.url, idx: w.idx, handle } : null;
}
function onStopped(e) {
    if (playing && e && e.chatId === playing.chatId) { session.stopped.add(playing.url); playing = null; }
}
function onChat(chatId) {
    if (session.chatId !== chatId) session = { chatId, stopped: new Set() };
    if (playing && playing.chatId !== chatId) playing = null;    // the app stops it on its own
}

dd.shared.scene = {
    update, run, clear, bgm, onStopped, onChat,
    stop() {
        clearTimeout(timer); clearTimeout(bgmTimer);
        if (playing && playing.handle) playing.handle.stop();
        playing = null; want = null;
        if (shown.chatId && shown.key) layer(shown.chatId, null);
        shown = { chatId: null, key: '' };
    },
};
