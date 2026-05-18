import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { build } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = join(root, 'js', 'vendor');
const nodeModulesQrcode = join(root, 'node_modules', 'qrcode');

if (!existsSync(nodeModulesQrcode)) {
    console.warn('sync-vendor-qrcode: qrcode not installed, skip');
    process.exit(0);
}

mkdirSync(vendorDir, { recursive: true });

const tempDir = join(root, '.tmp-qrcode-vendor');
mkdirSync(tempDir, { recursive: true });
const entry = join(tempDir, 'entry.js');
writeFileSync(entry, "import QRCode from 'qrcode'; export default QRCode;\n");

try {
    await build({
        configFile: false,
        root,
        publicDir: false,
        build: {
            lib: {
                entry,
                formats: ['es'],
                fileName: () => 'qrcode.esm.js',
            },
            outDir: vendorDir,
            emptyOutDir: false,
            minify: 'esbuild',
            rollupOptions: {
                external: [],
            },
        },
    });
    console.log('sync-vendor-qrcode: updated js/vendor/qrcode.esm.js');
} finally {
    rmSync(tempDir, { recursive: true, force: true });
}
