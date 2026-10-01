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

async function inject(ctx) {
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
