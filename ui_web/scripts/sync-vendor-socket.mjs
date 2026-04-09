import { copyFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules/socket.io-client/dist/socket.io.esm.min.js');
const dest = join(root, 'js/vendor/socket.io-client.esm.min.js');
if (!existsSync(src)) {
    console.warn('sync-vendor-socket: socket.io-client not installed, skip');
    process.exit(0);
}
copyFileSync(src, dest);
console.log('sync-vendor-socket: updated js/vendor/socket.io-client.esm.min.js');
