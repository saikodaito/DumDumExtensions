// Writes the hashes into every extensions/<id>/manifest.json and rebuilds
// index.json from them.
//   node tools/build-index.mjs           # write
//   node tools/build-index.mjs --check   # exit 1 if anything is out of date
//
// The index points every entry at the tag <id>-v<version>. Release order:
// bump the version, run this, commit, tag <id>-v<version>, push main + tag.
// The app downloads the files from the TAG and checks each hash twice
// (manifest.files and index.files), so a tag must never be moved.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, REPO, sha256, filesOf, manifestErrors, listExtensions, tagOf, json } from './lib.mjs';

const CHECK = process.argv.includes('--check');

export function buildIndex({ write }) {
    const problems = [];
    const stale = [];
    const entries = [];
    for (const x of listExtensions()) {
        if (!x.manifest) { problems.push(`${x.id}: manifest.json missing or not valid JSON`); continue; }
        const m = x.manifest;
        const errs = manifestErrors(m, x.id);
        if (errs.length) { problems.push(...errs.map(e => `${x.id}: ${e}`)); continue; }
        const files = {};
        for (const p of filesOf(m).sort()) {
            const f = join(x.dir, p);
            if (!existsSync(f)) { problems.push(`${x.id}: declared file not found: ${p}`); continue; }
            files[p] = sha256(readFileSync(f));
        }
        const updated = Object.assign({}, m, { files });
        const text = json(updated);
        if (text !== x.raw.toString('utf8')) {
            stale.push(`${x.id}/manifest.json`);
            if (write) writeFileSync(join(x.dir, 'manifest.json'), text);
        }
        const mHash = sha256(Buffer.from(text, 'utf8'));
        entries.push({
            id: m.id,
            name: m.name,
            summary: m.summary || '',
            version: m.version,
            tag: tagOf(m),
            api: m.api,
            minApp: m.minApp || null,
            platforms: m.platforms || ['desktop', 'mobile'],
            author: m.author || '',
            defaultLang: m.defaultLang || 'en',
            icon: m.icon || null,
            banner: m.banner || null,
            restart: m.restart || { enable: false, disable: false },
            permissions: m.permissions || {},
            files: Object.assign({ 'manifest.json': mHash }, files),
        });
    }
    const index = { schema: 1, repo: REPO, extensions: entries };
    const idxPath = join(ROOT, 'index.json');
    const idxText = json(index);
    const current = existsSync(idxPath) ? readFileSync(idxPath, 'utf8') : '';
    if (idxText !== current) {
        stale.push('index.json');
        if (write) writeFileSync(idxPath, idxText);
    }
    return { problems, stale, entries };
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('build-index.mjs')) {
    const { problems, stale, entries } = buildIndex({ write: !CHECK });
    problems.forEach(p => console.error('✖ ' + p));
    if (CHECK) {
        stale.forEach(s => console.error('✖ out of date: ' + s + ' (run node tools/build-index.mjs)'));
        if (problems.length || stale.length) process.exit(1);
        console.log(`index OK (${entries.length} extension(s))`);
    } else {
        if (problems.length) process.exit(1);
        console.log(stale.length ? 'updated: ' + stale.join(', ') : 'nothing to update');
        entries.forEach(e => console.log(`  ${e.id} ${e.version} → tag ${e.tag}`));
    }
}
