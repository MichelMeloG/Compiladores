// LAN access for the ESP32 only. Operator endpoints stay on loopback.
import http from 'node:http';

const allowed = new Set(['POST /device/hello', 'POST /device/events', 'GET /device/poll']);
const port = Number(process.env.DEVICE_LOCAL_PORT || 8081);
const backendPort = Number(process.env.LOCAL_BACKEND_PORT || 8080);
const forwardedHeaders = ['content-type', 'x-device-id', 'x-session-id', 'x-timestamp', 'x-sequence', 'x-signature'];

const server = http.createServer({ requestTimeout: 10000, headersTimeout: 5000 }, (req, res) => {
  const pathname = (req.url || '').split('?')[0];
  if (!allowed.has(`${req.method} ${pathname}`)) {
    res.writeHead(404).end();
    req.resume();
    return;
  }
  let bytes = 0;
  const chunks = [];
  req.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > 4096) {
      if (!res.writableEnded) res.writeHead(413).end();
      return;
    }
    chunks.push(chunk);
  });
  req.on('error', () => res.destroy());
  req.on('end', () => {
    if (res.writableEnded) return;
    const headers = { 'content-length': String(bytes) };
    for (const key of forwardedHeaders) {
      if (req.headers[key] !== undefined) headers[key] = req.headers[key];
    }
    const upstream = http.request({
      hostname: '127.0.0.1', port: backendPort,
      path: req.url, method: req.method, headers,
    }, reply => {
      if (reply.headers['content-type']) res.setHeader('content-type', reply.headers['content-type']);
      res.writeHead(reply.statusCode || 502);
      reply.pipe(res);
      reply.on('error', () => res.destroy());
    });
    upstream.setTimeout(10000, () => upstream.destroy());
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    res.on('close', () => upstream.destroy());
    upstream.end(Buffer.concat(chunks));
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`ESP32: http://IP_LOCAL_DO_PC:${server.address().port}; somente /device/hello, /device/events e /device/poll.`);
  console.log(`HMAC validado pelo backend em 127.0.0.1:${backendPort}. A API de operador nao e exposta na LAN.`);
});
