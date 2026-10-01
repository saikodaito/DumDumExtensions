// Risu's extra Rizz: the marks in the chat become the images.
//   <img="name">, {{img|image|asset|emotion::name}}  → <img>
//   {{raw::name}}, {{path::name}}                    → the URL itself (for the card's HTML)
//   {{video::name}}, {{video-img::name}}             → <video>
//   {{audio::name}}                                  → <audio>
//   {{bg::}} / {{bgm::}}                             → not handled yet, left as written
// A mark with no matching asset stays as written, on purpose: it tells the
// user the card (or the model) asked for something this character does not
// have. Clicking an image opens the app's viewer (the app does that for any
// image in a reply).

const S = dd.shared.store;
const IMG_MARKS = new Set(['img', 'image', 'asset', 'emotion']);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function render(text, ctx) {
    if (!dd.shared.cfg.chat || !ctx.charId) return text;
    const lib = S.get(ctx.charId);             // null while it loads: the chat redraws when it lands
    if (!lib) return text;
    const seed = ctx.chatId + ':' + ctx.msgIndex;
    return dd.assets.replace(text, (type, name, mark, native) => {
        if (type === 'bg' || type === 'bgm') return null;
        const i = S.pick(lib, name, native, seed);
        if (i < 0) return null;
        const it = lib.items[i];
        const u = S.urlOf(lib, i);
        if (!u) return null;
        S.want(lib, i);                        // remote: keep a copy for next time
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

dd.shared.render = { render };
