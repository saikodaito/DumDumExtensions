// Risu's extra Rizz: the image instruction in the prompt.
//
// Most RisuRealm cards bring their own (a lorebook entry telling the model to
// write <img="Name_emotion"> and listing the names). Cards that do not, or
// that relied on RisuAI's built-in one (prebuiltAssetCommand), get this one,
// with the real list of the character's images.
// Modes: 'auto' (only when the card brings none), 'always', 'off'.
// Shown in the prompt inspector under the extension's name; it counts against
// the app's extension token budget.

const S = dd.shared.store;
const MAX_NAMES = 200;

/** 'Hikari_angry_2.webp' → 'Hikari_angry', once per group, images only. */
function namesOf(lib) {
    const seen = new Set(), out = [];
    for (const it of lib.items) {
        if (S.kind(it.ext) !== 'image') continue;
        const g = dd.assets.group(it.name);
        if (!g || seen.has(g)) continue;
        seen.add(g);
        out.push(String(it.name).replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_\-\s]*\d+$/, '').trim() || it.name);
    }
    return out;
}

/** The start triggers' system prompt (triggers.js): RisuAI puts 'start' at
 *  the beginning of the prompt, 'historyend' after the history and
 *  'promptend' at the very end; the closest places here. */
function triggerSys(ctx) {
    const sys = dd.shared.triggers ? dd.shared.triggers.takeSys(ctx.chatId) : null;
    if (!sys) return [];
    const out = [];
    const add = (text, position) => { if (text && String(text).trim()) out.push({ text: String(text).trim(), position, label: dd.t('prompt_label_trigger') }); };
    add(sys.start, 'system:end');
    add(sys.historyend, 'depth:0');
    add(sys.promptend, 'depth:0');
    return out;
}

async function inject(ctx) {
    const extra = triggerSys(ctx);
    const img = await imageInstruction(ctx);
    const all = (img ? [img] : []).concat(extra);
    return all.length ? all : null;
}

async function imageInstruction(ctx) {
    const mode = dd.shared.cfg.prompt || 'auto';
    if (mode === 'off' || !ctx.charId) return null;
    const lib = await S.ensure(ctx.charId);
    if (!lib) return null;
    if (mode === 'auto' && lib.idx.ownInstruction && !lib.idx.prebuilt) return null;
    const names = namesOf(lib).slice(0, MAX_NAMES);
    if (!names.length) return null;
    // Model-facing text: English, like the rest of the app's prompts.
    return {
        text: '[Images: {{char}} has pictures that can be shown in the story. When one fits the moment, '
            + 'put it on its own line between paragraphs, written exactly as <img="name">. '
            + 'Use only these names: ' + names.join(', ') + '. Never invent a name that is not on this list.]',
        position: 'system:end',
        label: dd.t('prompt_label'),
    };
}

dd.shared.prompt = { inject, namesOf };
