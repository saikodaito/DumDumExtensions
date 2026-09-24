// Pre-publish review. Runs from the pre-push hook and on GitHub Actions.
//   node tools/check-publish.mjs
// Refuses (exit 1) when it finds:
//   · anything that looks like a secret (tokens, private keys, the updater marker);
//   · local paths, e-mail addresses or names of private folders;
//   · manifests or index.json out of date (hashes);
//   · files inside an extension folder that the manifest does not declare;
//   · CSS outside the app's token rules;
//   · files over 2 MB.
// This is a safety net, not the review itself: every extension is still read
// by a human before it is published.
import { readFileSync, statSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, filesOf, listExtensions } from './lib.mjs';
import { buildIndex } from './build-index.mjs';

const issues = [];
const add = (file, msg) => issues.push(`${file}: ${msg}`);

// Tracked + new files that are not ignored: exactly what a push would carry.
// A tracked file already deleted on disk is on its way out, so it is skipped.
let files;
try {
    files = execSync('git ls-files -co --exclude-standard', { cwd: ROOT, encoding: 'utf8' })
        .split('\n').map(s => s.trim()).filter(Boolean)
        .filter(f => existsSync(join(ROOT, f)));
} catch (e) {
    console.error('✖ git ls-files failed: ' + e.message);
    process.exit(1);
}

const BINARY = /\.(png|webp|jpe?g|gif|ico|ogg|opus|mp3|wav|webm|m4a|woff2?|zip|dumext)$/i;
const SECRETS = [
    [/gh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub token'],
    [/github_pat_[A-Za-z0-9_]{20,}/, 'GitHub fine-grained token'],
    [/sk-ant-[A-Za-z0-9_-]{20,}/, 'Anthropic key'],
    [/\bsk-[A-Za-z0-9_-]{20,}/, 'API key (sk-)'],
    [/AIza[0-9A-Za-z_-]{35}/, 'Google API key'],
    [/xox[abprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
    [new RegExp('__DD_' + 'GH_TOKEN__'), 'updater token marker'],   // split: this file must not match itself
    [/\b(hf_[A-Za-z0-9]{30,})/, 'Hugging Face token'],
];
const PRIVATE = [
    [/[A-Za-z]:[\\/]+Users[\\/]/i, 'local Windows path'],
    [/\/(home|Users)\/[a-z0-9_.-]+\//i, 'local home path'],
    [/[A-Za-z]:[\\/]+ct[\\/]/i, 'local build path'],
    [/dumdum other/i, 'local folder name'],
    [/Personal \(Dev\) planning|Plans and specs|apollogetic|colab stuff/i, 'private folder name'],
    [/keystore\.properties|updater\.properties|gdrive\.properties|\.keystore\b/i, 'secret file name'],
    [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, 'e-mail address'],
];
const EMAIL_OK = /(noreply|no-reply)@|@(example\.(com|org)|users\.noreply\.github\.com)$/i;
const GRAY_HEX = /#(?:71717a|a1a1aa|e4e4e7|d4d4d8|52525b|3f3f46|27272a|18181b|09090b|6b7280|9ca3af|d1d5db|e5e7eb|4b5563|374151|f4f4f5)\b/i;

for (const file of files) {
    const abs = join(ROOT, file);
    let st;
    try { st = statSync(abs); } catch (e) { continue; }   // removed in the working tree
    if (st.size > 2 * 1024 * 1024) add(file, `over 2 MB (${(st.size / 1048576).toFixed(1)} MB)`);
    if (BINARY.test(file)) continue;
    const txt = readFileSync(abs, 'utf8');
    const lines = txt.split(/\r?\n/);
    lines.forEach((l, i) => {
        for (const [rx, label] of SECRETS) if (rx.test(l)) add(`${file}:${i + 1}`, label);
        for (const [rx, label] of PRIVATE) {
            const m = l.match(rx);
            if (!m) continue;
            if (label === 'e-mail address' && EMAIL_OK.test(m[0])) continue;
            // This file lists the patterns themselves.
            if (file === 'tools/check-publish.mjs') continue;
            add(`${file}:${i + 1}`, label);
        }
    });
    if (/\.css$/i.test(file) && file.startsWith('extensions/')) {
        lines.forEach((l, i) => {
            if (/font-size\s*:\s*\d+(\.\d+)?px/.test(l)) add(`${file}:${i + 1}`, 'raw px font-size: use calc(Npx * var(--dd-fs-ui))');
            if (/rgba\(\s*255\s*,\s*255\s*,\s*255\s*,/.test(l)) add(`${file}:${i + 1}`, 'rgba(255,255,255,…): use rgb(var(--dd-veil) / a)');
            if (GRAY_HEX.test(l)) add(`${file}:${i + 1}`, 'hard-coded gray: use the --dd-* tokens');
        });
    }
}

// Every file inside an extension must be declared (or be docs/tests).
const EXTRAS_OK = new Set(['manifest.json', 'README.md', 'CHANGELOG.md']);
for (const x of listExtensions()) {
    if (!x.manifest) continue;
    const declared = new Set(filesOf(x.manifest));
    const inside = files.filter(a => a.startsWith(`extensions/${x.id}/`)).map(a => a.slice(`extensions/${x.id}/`.length));
    for (const f of inside) {
        if (EXTRAS_OK.has(f) || f.startsWith('test/')) continue;
        if (!declared.has(f)) add(`extensions/${x.id}/${f}`, 'not declared in the manifest (remove it or declare it)');
    }
}

// Commits not pushed yet must use GitHub's anonymous address: a personal
// name or e-mail in a public history cannot be taken back.
try {
    const authors = execSync('git log --format=%ae%n%ce --branches --not --remotes', { cwd: ROOT, encoding: 'utf8' })
        .split('\n').map(s => s.trim()).filter(Boolean);
    for (const email of new Set(authors)) {
        if (!/@users\.noreply\.github\.com$/i.test(email)) add('git', `commit author/committer is not a GitHub noreply address (${email.replace(/^(.).*@/, '$1***@')}); set git config user.email in this repo`);
    }
} catch (e) { /* no remote yet: nothing to compare */ }

// Hashes and index up to date.
const { problems, stale } = buildIndex({ write: false });
problems.forEach(p => add('index', p));
stale.forEach(s => add(s, 'out of date: run node tools/build-index.mjs'));

if (issues.length) {
    console.error(`✖ check-publish: ${issues.length} problem(s)`);
    issues.forEach(e => console.error('  ' + e));
    process.exit(1);
}
console.log(`check-publish OK (${files.length} file(s) reviewed)`);
