// Risu's extra Rizz: a message on screen.
//  1. The card's macros and display regex (display.js), for cards with
//     RisuAI data (risuai.json), when "Run the card's scripts" is on.
//  2. The asset marks become the files:
//     <img="name">, {{img|image|asset|emotion::name}}  → <img>
//     {{raw::name}}, {{path::name}}                    → the URL itself (for the card's HTML)
//     {{video::name}}, {{video-img::name}}             → <video>
//     {{audio::name}}                                  → <audio>
//     {{bg::name}}    → in a message, nothing (RisuAI draws it only in the
//                       card's background, scene.js); in the background, the image
//     {{bgm::name}}   → nothing on screen; the music plays (scene.js)
// A mark with no matching asset stays as written, on purpose: it tells the
// user the card (or the model) asked for something this character does not
// have. Clicking an image opens the app's viewer (the app does that for any
// image in a reply).

const S = dd.shared.store;
const D = dd.shared.display;
const IMG_MARKS = new Set(['img', 'image', 'asset', 'emotion']);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The marks of `text` with the library `lib`. where: 'chat' | 'back'. */
function marks(text, lib, seed, where, ctx) {
    return dd.assets.replace(text, (type, name, mark, native) => {
        const i = S.pick(lib, name, native, seed);
        if (i < 0) return null;
        const it = lib.items[i];
        const u = S.urlOf(lib, i);
        if (!u) return null;
        S.want(lib, i);                        // remote: keep a copy for next time
        if (type === 'bg') {
            // RisuAI's 'back' mode: the image under a dark veil, filling the layer.
            return where === 'back'
                ? `<div style="width:100%;height:100%;background: linear-gradient(rgba(0, 0, 0, 0.8), rgba(0, 0, 0, 0.8)),url('${esc(u)}'); background-size: cover;"></div>`
                : '';
        }
        if (type === 'bgm') {
            if (!ctx.streaming && dd.shared.scene) dd.shared.scene.bgm(ctx.chatId, where === 'back' ? -1 : ctx.msgIndex, u, it.name);
            return '';
        }
        if (type === 'raw' || type === 'path') return esc(u);
        const k = S.kind(it.ext);
        if (type === 'audio' || k === 'audio') return `<audio controls preload="none" src="${esc(u)}"></audio>`;
        if (type === 'video' || type === 'video-img' || k === 'video') {
            return `<video class="drx-media" controls loop preload="metadata" src="${esc(u)}"></video>`;
        }
        if (!IMG_MARKS.has(type) && type !== 'source') return null;
        return `<img class="drx-img" src="${esc(u)}" alt="${esc(it.name)}" loading="lazy">`;
    });
}

function render(text, ctx) {
    if (!ctx.charId) return text;
    let s = text;
    if (dd.shared.cfg.scripts) {
        try { s = D.text(s, ctx); } catch (e) { dd.warn('display', e); }
    }
    if (!dd.shared.cfg.chat) return s;
    const lib = S.get(ctx.charId);             // null while it loads: the chat redraws when it lands
    if (!lib) return s;
    return marks(s, lib, ctx.chatId + ':' + ctx.msgIndex, 'chat', ctx);
}

dd.shared.render = { render, marks };
