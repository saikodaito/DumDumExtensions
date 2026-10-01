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

// RisuAI does not contain a message: a card's position: fixed (Cheongwon's
// side panels and their buttons) sits on the screen. The app keeps it fixed,
// held by the chat area, when asked (needs "chatLayer" in permissions.ui).
const FIXED = /position\s*:\s*fixed/i;
// A message the card turned into a page of its own (panels, tables, styles)
// takes the chat's width, as on RisuAI; plain prose keeps the app's bubble.
const BLOCK = /<(div|table|section|style|details|ul|ol)\b/i;

function render(text, ctx) {
    if (!ctx.charId) return text;
    let s = text, card = false;
    if (dd.shared.cfg.scripts) {
        try { const t = D.text(s, ctx); card = t !== s; s = t; } catch (e) { dd.warn('display', e); }
    }
    const lib = dd.shared.cfg.chat ? S.get(ctx.charId) : null;    // null while it loads: the chat redraws when it lands
    if (lib) s = marks(s, lib, ctx.chatId + ':' + ctx.msgIndex, 'chat', ctx);
    if (!card || ctx.streaming) return s;
    const keepFixed = FIXED.test(s), wide = BLOCK.test(s);
    return keepFixed || wide ? { text: s, keepFixed, wide } : s;
}

dd.shared.render = { render, marks };
