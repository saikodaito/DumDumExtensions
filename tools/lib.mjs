// Shared helpers for the repo tools. No dependencies: plain Node 18+.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const EXT_DIR = join(ROOT, 'extensions');
export const REPO = 'saikodaito/DumDumExtensions';
export const ID_RX = /^[a-z0-9-]{2,32}$/;

export const sha256 = buf => createHash('sha256').update(buf).digest('hex');

/** Every file the app downloads for an extension (same rule as the app's arquivosDe). */
export function filesOf(m) {
    const s = new Set();
    const add = v => { if (typeof v === 'string' && v) s.add(v); };
    (m.scripts || []).forEach(add);
    (m.styles || []).forEach(add);
    (m.assets || []).forEach(add);
    Object.values(m.i18n || {}).forEach(add);
    add(m.banner);
    add(m.icon);
    return [...s];
}

const pathOk = p => typeof p === 'string' && p.length > 0 && p.length < 200 && !/^[\/\\]|\.\.|:|\\/.test(p);

/** Shape errors of a manifest (empty list = ok). Mirrors the app's validaManifesto. */
export function manifestErrors(m, folder) {
    if (!m || typeof m !== 'object') return ['manifest is not an object'];
    const e = [];
    if (!ID_RX.test(String(m.id || ''))) e.push('id must match ' + ID_RX);
    if (folder && m.id !== folder) e.push(`id "${m.id}" differs from the folder "${folder}"`);
    if (!m.version || typeof m.version !== 'string' || !/^\d+\.\d+\.\d+/.test(m.version)) e.push('version must be semver (x.y.z)');
    if (!Number.isInteger(m.api)) e.push('api must be an integer');
    if (!Array.isArray(m.scripts) || !m.scripts.length) e.push('scripts must be a non-empty list');
    if (m.platforms && !(Array.isArray(m.platforms) && m.platforms.every(p => p === 'desktop' || p === 'mobile'))) e.push('platforms: only "desktop" and "mobile"');
    for (const p of filesOf(m)) if (!pathOk(p)) e.push('bad path: ' + p);
    return e;
}

/** [{ id, dir, manifest, raw }] for every extensions/<id>/manifest.json. */
export function listExtensions() {
    if (!existsSync(EXT_DIR)) return [];
    return readdirSync(EXT_DIR)
        .filter(d => statSync(join(EXT_DIR, d)).isDirectory())
        .sort()
        .map(d => {
            const f = join(EXT_DIR, d, 'manifest.json');
            if (!existsSync(f)) return { id: d, dir: join(EXT_DIR, d), manifest: null, raw: null };
            const raw = readFileSync(f);
            let manifest = null;
            try { manifest = JSON.parse(raw.toString('utf8')); } catch (e) { /* reported by the caller */ }
            return { id: d, dir: join(EXT_DIR, d), manifest, raw };
        });
}

export const tagOf = m => `${m.id}-v${m.version}`;
export const json = o => JSON.stringify(o, null, 2) + '\n';
