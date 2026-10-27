import http from 'node:http';
import { createHandler, log } from './handler.js';
import { validateTarget } from './logic.js';

const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

/** Token da service account do Cloud Run via servidor de metadados (sem dependências). */
async function getToken() {
  const res = await fetch(METADATA_TOKEN_URL, { headers: { 'Metadata-Flavor': 'Google' } });
  if (!res.ok) throw new Error(`metadata ${res.status}`);
  const json = await res.json();
  return json.access_token;
}

const target = validateTarget(process.env.TARGET_SERVICE);
const dryRun = process.env.DRY_RUN === 'true';
const port = Number(process.env.PORT || 8080);

const handle = createHandler({ target, dryRun, fetchFn: fetch, getToken });

const MAX_BODY = 64 * 1024;

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200).end('ok');
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }

  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) {
      res.writeHead(413).end();
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', async () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      log('ERROR', 'corpo não é JSON');
      res.writeHead(204).end();
      return;
    }
    const { status } = await handle(body);
    res.writeHead(status).end();
  });
});

server.listen(port, () => log('INFO', 'budget-killswitch iniciado', { port, target, dryRun }));
