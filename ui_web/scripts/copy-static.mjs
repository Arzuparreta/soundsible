/**
 * After Vite build, copy files referenced by HTML but not bundled (manifests, icons, SW, compiled CSS fallback).
 */
import { cpSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

const copyIfExists = (rel) => {
    const src = join(root, rel);
    if (!existsSync(src)) return;
    const dest = join(dist, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true });
};

for (const p of [
    'manifest.json',
    'manifest-alt.json',
    'manifest-desktop.json',
    'sw.js',
    'assets',
]) {
    copyIfExists(p);
}
