/**
 * Vite hashes linked JSON/assets; PWA manifests must stay at stable /player/*.json paths (copy-static).
 */
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function fix(file, manifestHref) {
    const p = join(root, file);
    let html = readFileSync(p, 'utf8');
    html = html.replace(
        /<link rel="manifest" href="\/player\/assets\/manifest[^"]+\.json"/,
        `<link rel="manifest" href="${manifestHref}"`
    );
    writeFileSync(p, html);
}

fix('dist/index.html', '/player/manifest.json');
fix('dist/desktop.html', '/player/manifest-desktop.json');
