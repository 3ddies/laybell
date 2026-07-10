// Minimal zero-dependency static server for the Laybell moderation console.
// Run:  node admin-console/serve.mjs   → http://localhost:5599
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 5599;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/' || p === '') p = '/index.html';
    const file = normalize(join(__dirname, p));
    if (!file.startsWith(__dirname)) { res.writeHead(403); return res.end('forbidden'); }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}).listen(PORT, () => console.log(`Laybell moderation console → http://localhost:${PORT}`));
