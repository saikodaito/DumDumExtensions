// Risu's extra Rizz: the "Assets (Risu)" section in the character editor.
// Rename, delete and add wait for the editor's Save, like every other field
// (closing without saving drops them). Downloading remote assets is a cache
// operation and happens right away.

const S = dd.shared.store;
const GROUPS_MAX = 150;
const ASK_BYTES = 50 * 1024 * 1024;
const mb = b => (b / 1048576).toFixed(1);

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}
function icon(name) {
    const i = document.createElement('i');
    i.setAttribute('data-lucide', name);
    i.className = 'drx-ico';
    return i;
}
function button(label, ic, cls) {
    const b = el('button', 'dd-btn dd-btn--sm' + (cls ? ' ' + cls : ''));
    b.type = 'button';
    if (ic) b.appendChild(icon(ic));
    if (label) b.appendChild(el('span', null, label));
    return b;
}
const label = name => String(name).replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_\-\s]*\d+$/, '').replace(/_+/g, ' ').trim() || name;

function render(root, ctx) {
    const st = {
        charId: ctx.charId, idx: null, blobs: new Map(), urls: [], q: '',
        renames: new Map(), deletes: new Set(), adds: [], busy: false,
    };
    const dirty = () => { try { ctx.markDirty(); } catch (e) { /* editor gone */ } };

    const details = el('details', 'drx drx-section');
    const summary = el('summary', 'drx-summary');
    summary.append(icon('chevron-right'), icon('images'), el('span', 'drx-title', dd.t('editor_title')));
    const note = el('span', 'drx-note');
    summary.appendChild(note);
    details.appendChild(summary);
    details.appendChild(el('p', 'drx-hint', dd.t('editor_hint')));

    const bar = el('div', 'drx-bar');
    const search = el('input', 'drx-search');
    search.type = 'text';
    search.placeholder = dd.t('editor_search');
    // Typing a filter is not an edit: keep it from the editor's unsaved-changes listener.
    search.addEventListener('input', ev => { ev.stopPropagation(); st.q = search.value.trim().toLowerCase(); paint(); });
    const addBtn = button(dd.t('editor_add'), 'plus');
    const fileInp = el('input');
    fileInp.type = 'file';
    fileInp.multiple = true;
    fileInp.accept = 'image/*,audio/*,video/*';
    fileInp.hidden = true;
    addBtn.addEventListener('click', () => fileInp.click());
    fileInp.addEventListener('change', () => {
        for (const f of fileInp.files || []) {
            const ext = S.extOf(f.name, '');
            st.adds.push({ name: f.name.replace(/\.[a-z0-9]{2,5}$/i, ''), ext, blob: f, url: URL.createObjectURL(f) });
            st.urls.push(st.adds[st.adds.length - 1].url);
        }
        fileInp.value = '';
        dirty();
        paint();
    });
    const dlBtn = button('', 'download');
    const dlLabel = el('span');
    dlBtn.appendChild(dlLabel);
    dlBtn.addEventListener('click', downloadAll);
    bar.append(search, addBtn, dlBtn, fileInp);
    details.appendChild(bar);
    const status = el('p', 'drx-status');
    details.appendChild(status);
    const list = el('div', 'drx-list');
    details.appendChild(list);
    root.appendChild(details);

    async function load() {
        st.idx = (await S.readIndex(st.charId)) || { v: 1, source: 'manual', t: Date.now(), skipped: 0, items: [] };
        st.blobs = new Map((await dd.files.char(st.charId).entries('a/')).map(e => [e.name.slice(2), e.blob]));
        paint();
    }

    function thumbUrl(it) {
        if (it.url && it.url.startsWith('blob:')) return it.url;                // added, not saved yet
        const b = it.file && st.blobs.get(it.file);
        if (b) { const u = URL.createObjectURL(b); st.urls.push(u); it._u = u; return u; }
        return it.url || '';
    }

    function paint() {
        list.textContent = '';
        const items = st.idx ? st.idx.items : [];
        const remote = items.filter(it => S.canCache(it)).length;
        const stored = items.filter(it => it.file).length;
        note.textContent = items.length || st.adds.length
            ? dd.t('editor_count', { n: items.length + st.adds.length, stored, remote }) : '';
        dlBtn.hidden = !remote || st.busy;
        dlLabel.textContent = dd.t('editor_download', { n: remote });
        if (!items.length && !st.adds.length) {
            list.appendChild(el('p', 'drx-hint', st.idx ? dd.t('editor_empty') : dd.t('loading')));
            dd.ui.icons(details);
            return;
        }
        if (st.adds.length) list.appendChild(groupBox(dd.t('editor_new'), st.adds.map((it, k) => ({ it, key: 'add' + k, add: k })), true));

        const groups = new Map();
        items.forEach((it, i) => {
            if (st.q && !String(st.renames.get(i) || it.name).toLowerCase().includes(st.q)) return;
            const g = dd.assets.group(it.name);
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g).push({ it, key: i, i });
        });
        [...groups.values()].slice(0, GROUPS_MAX).forEach(g => list.appendChild(groupBox(label(g[0].it.name), g, false)));
        if (groups.size > GROUPS_MAX) list.appendChild(el('p', 'drx-hint', dd.t('editor_more', { n: groups.size - GROUPS_MAX })));
        if (st.idx && st.idx.skipped) list.appendChild(el('p', 'drx-hint', dd.t('editor_skipped', { n: st.idx.skipped })));
        dd.ui.icons(details);
    }

    function groupBox(title, rows, open) {
        const box = el('details', 'drx-group');
        if (open) box.open = true;
        const sum = el('summary', 'drx-group-sum');
        const first = rows.find(r => S.kind(r.it.ext) === 'image');
        const th = el('span', 'drx-thumb');
        if (first) {
            const img = el('img');
            img.loading = 'lazy';
            img.alt = '';
            img.src = thumbUrl(first.it);
            th.appendChild(img);
        } else th.appendChild(icon(S.kind(rows[0].it.ext) === 'audio' ? 'music' : 'film'));
        th.addEventListener('click', ev => {
            ev.preventDefault();
            const imgs = rows.filter(r => S.kind(r.it.ext) === 'image').map(r => ({ type: 'image', url: r.it._u || thumbUrl(r.it) })).filter(x => x.url);
            dd.ui.lightbox(imgs, 0);
        });
        sum.append(th, el('span', 'drx-group-title', title), el('span', 'drx-note', '×' + rows.length));
        box.appendChild(sum);
        // Rows only when the group opens: a charx has thousands.
        const fill = () => {
            if (box._filled) return;
            box._filled = true;
            rows.forEach(r => box.appendChild(row(r)));
            dd.ui.icons(box);
        };
        box.addEventListener('toggle', () => { if (box.open) fill(); });
        if (open) fill();
        return box;
    }

    function row(r) {
        const it = r.it;
        const line = el('div', 'drx-row');
        const name = el('input', 'drx-name');
        name.type = 'text';
        name.value = r.add != null ? it.name : (st.renames.get(r.i) || it.name);
        name.addEventListener('change', () => {
            const v = name.value.trim();
            if (!v) { name.value = it.name; return; }
            if (r.add != null) it.name = v;
            else if (v === it.name) st.renames.delete(r.i);
            else st.renames.set(r.i, v);
            dirty();
        });
        const tag = r.add != null ? dd.t('state_new') : it.file ? dd.t('state_stored') : dd.t('state_remote');
        const del = el('button', 'dd-btn dd-btn--icon dd-btn--sm dd-btn--ghost');
        del.type = 'button';
        del.title = dd.t('editor_delete');
        del.appendChild(icon('trash-2'));
        const paintDel = () => line.classList.toggle('drx-gone', r.add == null && st.deletes.has(r.i));
        del.addEventListener('click', () => {
            if (r.add != null) {
                st.adds.splice(r.add, 1);
                dirty();
                paint();
                return;
            }
            if (st.deletes.has(r.i)) st.deletes.delete(r.i); else st.deletes.add(r.i);
            paintDel();
            dirty();
        });
        paintDel();
        line.append(name, el('span', 'drx-tag', `${it.ext} · ${tag}`), del);
        return line;
    }

    async function downloadAll() {
        if (st.busy) return;
        st.busy = true;
        paint();
        let asked = false;
        try {
            const r = await S.downloadAll(st.charId, async (n, total, bytes) => {
                status.textContent = dd.t('editor_downloading', { n, total, mb: mb(bytes) });
                // The size of a remote asset is only known after it arrives:
                // ask once the running total passes 50 MB.
                if (!asked && bytes >= ASK_BYTES && n < total) {
                    asked = true;
                    return dd.ui.confirm(dd.t('ask_continue', { mb: mb(bytes), n, total }));
                }
                return true;
            });
            status.textContent = dd.t('editor_downloaded', { n: r.done, failed: r.failed, mb: mb(r.bytes || 0) });
        } catch (e) {
            status.textContent = String(e && e.message || e);
        } finally {
            st.busy = false;
            await load();
        }
    }

    load().catch(e => { status.textContent = String(e && e.message || e); });

    return {
        async save(charId) {
            if (!st.renames.size && !st.deletes.size && !st.adds.length) return;
            const id = charId || st.charId;
            const folder = dd.files.char(id);
            const idx = (await S.readIndex(id)) || { v: 1, source: 'manual', t: Date.now(), skipped: 0, items: [] };
            st.renames.forEach((v, i) => { if (idx.items[i]) idx.items[i].name = v; });
            const gone = idx.items.filter((it, i) => st.deletes.has(i));
            idx.items = idx.items.filter((it, i) => !st.deletes.has(i));
            const used = new Set(idx.items.filter(x => x.file).map(x => x.file.toLowerCase()));
            const batch = [];
            for (const a of st.adds) {
                const it = { name: a.name, ext: a.ext, type: 'x-risu-asset', url: '', file: '' };
                it.file = S.fileNameFor(it, used);
                batch.push({ name: 'a/' + it.file, data: a.blob, type: S.mimeOf(a.ext) || a.blob.type });
                idx.items.push(it);
            }
            if (batch.length) await folder.putMany(batch);
            await S.writeIndex(id, idx);
            for (const it of gone) if (it.file) await folder.del('a/' + it.file).catch(() => {});
            st.renames.clear(); st.deletes.clear(); st.adds = [];
            await S.invalidate(id);
        },
        close() { st.urls.forEach(u => URL.revokeObjectURL(u)); st.urls = []; },
    };
}

dd.shared.editor = { render };
