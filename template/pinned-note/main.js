// Pinned Note: a fixed note added to every prompt, plus an optional cleanup of
// the reply. A small example of the prompt hooks (dd.prompt, API 1).
// The manifest must declare "prompt": true, or dd.prompt refuses to register.

const POSITIONS = ['system:end', 'beforeHistory', 'depth'];

let note = '';
let position = 'system:end';
let depth = 4;
let tidy = false;
let offInject = null;
let offTransform = null;

dd.onActivate(async () => {
    note = (await dd.store.get('note')) || '';
    const p = await dd.store.get('position');
    if (POSITIONS.includes(p)) position = p;
    const d = await dd.store.get('depth');
    if (Number.isInteger(d)) depth = d;
    tidy = !!(await dd.store.get('tidy'));

    // Runs once per reply (send, regenerate, continue), before the prompt is
    // assembled. Return nothing to add nothing. {{char}} and {{user}} work.
    offInject = dd.prompt.inject(ctx => {
        if (!note.trim()) return null;
        return {
            text: '[Note: ' + note.trim() + ']',
            position: position === 'depth' ? 'depth:' + depth : position,
            label: dd.t('label'),
        };
    });

    // Runs on the final text of the reply, before it is saved (not while it
    // streams). ctx.partial is true when the reply was stopped or cut off.
    offTransform = dd.prompt.transform(text => tidy ? text.replace(/\n{3,}/g, '\n\n').trim() : text);

    dd.ui.settings(renderSettings);
});

dd.onDeactivate(() => {
    if (offInject) offInject();
    if (offTransform) offTransform();
});

function renderSettings(el) {
    const section = dd.ui.section({ title: { t: 'sec_note' }, icon: 'pin' });

    const box = document.createElement('textarea');
    box.className = 'dd-pn-text';
    box.rows = 4;
    box.value = note;
    box.placeholder = dd.t('ph_note');
    box.addEventListener('change', () => { note = box.value; dd.store.set('note', note); });
    section.appendChild(box);
    section.appendChild(dd.ui.hint({ t: 'hint_note' }));

    const depthSlot = document.createElement('div');
    const paintDepth = () => { depthSlot.style.display = position === 'depth' ? '' : 'none'; };
    section.appendChild(dd.ui.select({
        label: { t: 'lbl_position' },
        options: [
            { value: 'system:end', label: { t: 'opt_system' } },
            { value: 'beforeHistory', label: { t: 'opt_before' } },
            { value: 'depth', label: { t: 'opt_depth' } },
        ],
        value: position,
        onChange: v => { position = v; dd.store.set('position', v); paintDepth(); },
    }));
    depthSlot.appendChild(dd.ui.slider({
        label: { t: 'lbl_depth' }, min: 0, max: 20, value: depth,
        format: v => dd.t('fmt_depth', { n: v }),
        onChange: v => { depth = v; dd.store.set('depth', v); },
    }));
    paintDepth();
    section.appendChild(depthSlot);

    section.appendChild(dd.ui.toggle({
        label: { t: 'lbl_tidy' }, desc: { t: 'desc_tidy' }, value: tidy,
        onChange: v => { tidy = v; dd.store.set('tidy', v); },
    }));
    el.appendChild(section);
}
