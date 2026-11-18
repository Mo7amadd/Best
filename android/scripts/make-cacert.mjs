// Writes app/src/main/assets/cacert.pem: the Mozilla root certificates that Node.js ships
// (tls.rootCertificates). Xray and sing-box read it (SSL_CERT_FILE) in addition to Android's own
// store, because old Android versions lack newer roots: DNS over HTTPS to 1.1.1.1, for example,
// fails there with "certificate signed by unknown authority". Certificate checks stay on.
// Run again with a newer Node.js to refresh the list.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tls from 'node:tls';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'app', 'src', 'main', 'assets', 'cacert.pem');
const certs = [...tls.rootCertificates];
const head = `# Mozilla root certificates as shipped with Node.js ${process.versions.node} (${certs.length} roots).\n# Made by scripts/make-cacert.mjs.\n\n`;
writeFileSync(out, head + certs.map((c) => c.trim()).join('\n\n') + '\n');
console.log(`${certs.length} roots → ${out}`);
