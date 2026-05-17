/**
 * Thin proxy that forwards everything to Metro on :8081
 * and injects Cross-Origin-Isolation headers on every response.
 * SharedArrayBuffer (needed by expo-sqlite wa-sqlite) requires these.
 *
 * Usage: node dev-proxy.js
 * Then open http://localhost:8082
 */
const http = require('http');

const METRO_PORT = 8081;
const PROXY_PORT = 8082;

const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

const server = http.createServer((clientReq, clientRes) => {
  const options = {
    hostname: 'localhost',
    port: METRO_PORT,
    path: clientReq.url,
    method: clientReq.method,
    headers: { ...clientReq.headers, host: `localhost:${METRO_PORT}` },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    const headers = { ...proxyRes.headers, ...ISOLATION_HEADERS };
    clientRes.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(clientRes, { end: true });
  });

  proxyReq.on('error', (err) => {
    clientRes.writeHead(502);
    clientRes.end(`Metro not reachable: ${err.message}`);
  });

  clientReq.pipe(proxyReq, { end: true });
});

// Also proxy WebSocket upgrades (Metro hot-reload)
server.on('upgrade', (clientReq, clientSocket, head) => {
  const options = {
    hostname: 'localhost',
    port: METRO_PORT,
    path: clientReq.url,
    method: clientReq.method,
    headers: clientReq.headers,
  };

  const proxyReq = http.request(options);
  proxyReq.on('upgrade', (proxyRes, proxySocket) => {
    clientSocket.write(
      `HTTP/1.1 101 Switching Protocols\r\n` +
        Object.entries(proxyRes.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\r\n') +
        '\r\n\r\n'
    );
    proxySocket.pipe(clientSocket);
    clientSocket.pipe(proxySocket);
  });
  proxyReq.end();
});

server.listen(PROXY_PORT, () => {
  console.log(`\n  Proxy running at http://localhost:${PROXY_PORT}`);
  console.log(`  Forwarding to Metro at http://localhost:${METRO_PORT}`);
  console.log(`  COOP + COEP headers injected on every response.\n`);
});
