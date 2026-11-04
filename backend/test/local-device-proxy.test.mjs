import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

test('LAN proxy isolates operator routes and preserves signed device requests', { timeout: 15000 }, async () => {
  const received = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"success":true}');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const proxy = spawn(process.execPath, [fileURLToPath(new URL('../tools/local-device-proxy.mjs', import.meta.url))], {
    env: { ...process.env, DEVICE_LOCAL_PORT: '0', LOCAL_BACKEND_PORT: String(upstream.address().port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const port = await new Promise((resolve, reject) => {
      let output = '';
      proxy.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/IP_LOCAL_DO_PC:(\d+)/);
        if (match) resolve(Number(match[1]));
      });
      proxy.on('error', reject);
      proxy.on('exit', code => reject(new Error(`Proxy exited: ${code}`)));
    });
    const base = `http://127.0.0.1:${port}`;
    for (const route of ['/api/robots', '/api/health', '/internal/offline-check', '/device/sensors']) {
      assert.equal((await fetch(base + route)).status, 404);
    }
    assert.equal(received.length, 0);
    const body = '{ "events": [] }';
    const response = await fetch(base + '/device/events?check=1', {
      method: 'POST', body,
      headers: { 'content-type': 'application/json', 'x-signature': 'test-signature', 'x-device-id': 'RB-01', 'x-dev-role': 'admin' },
    });
    assert.equal(response.status, 200);
    assert.equal(received[0].body, body);
    assert.equal(received[0].url, '/device/events?check=1');
    assert.equal(received[0].headers['x-signature'], 'test-signature');
    assert.equal(received[0].headers['x-dev-role'], undefined);
    assert.equal((await fetch(base + '/device/events', { method: 'POST', body: 'x'.repeat(4097) })).status, 413);
    assert.equal(received.length, 1);
    await new Promise(resolve => upstream.close(resolve));
    assert.equal((await fetch(base + '/device/poll')).status, 502);
  } finally {
    proxy.kill();
    upstream.closeAllConnections();
    upstream.close();
  }
});
