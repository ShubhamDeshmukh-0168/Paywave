'use strict';

// HTTP server for the Kubernetes deployment (and local development): runs the same handler the
// Lambda uses. In the cluster it runs with ROUTE_MODE=core; payments are served by Lambda.
const http = require('node:http');
const crypto = require('node:crypto');
const { handler } = require('./src/index');
const log = require('./src/log');

const port = Number(process.env.PORT || 3000);
const MAX_BODY = 200 * 1024; // profile photos are the largest request (about 140 KB)

const server = http.createServer((req, res) => {
  const chunks = [];
  let size = 0;
  let tooBig = false;
  req.on('data', (d) => {
    size += d.length;
    if (size > MAX_BODY) tooBig = true;
    else chunks.push(d);
  });
  req.on('end', async () => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const event = {
      httpMethod: req.method,
      path: url.pathname,
      headers: req.headers,
      queryStringParameters: Object.fromEntries(url.searchParams),
      body: tooBig ? 'x'.repeat(MAX_BODY + 1) : chunks.length ? Buffer.concat(chunks).toString('utf8') : null,
      isBase64Encoded: false,
    };
    try {
      const result = await handler(event, { awsRequestId: crypto.randomUUID() });
      res.writeHead(result.statusCode, result.headers);
      res.end(result.body || '');
    } catch (err) {
      log('error', 'server error', { error: err && err.message });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":{"code":"INTERNAL_ERROR","message":"Something went wrong. Please try again."}}');
    }
  });
});

server.keepAliveTimeout = 65_000; // longer than the proxy's idle timeout
server.listen(port, () => log('info', 'PayWave API listening', { port, mode: process.env.ROUTE_MODE || 'all' }));

// Kubernetes sends SIGTERM on rollout: finish in-flight requests, then exit
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log('info', 'shutting down', { sig });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
