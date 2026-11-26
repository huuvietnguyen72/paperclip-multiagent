#!/usr/bin/env node
// Webhook gate for Paperclip chat channels.
//
// Paperclip runs in local_trusted mode: anyone who can reach port 3100 has full control. A public tunnel must
// therefore never point at Paperclip itself. This gate is the only thing the tunnel reaches. It forwards exactly
// one kind of request — POST /api/chat-webhooks/<publicId>/<provider>, the chat-provider ingress that Paperclip
// authenticates itself — and answers 404 to everything else.
//
// Usage: node webhook-gate.mjs   (GATE_PORT, default 3190; PAPERCLIP_ORIGIN, default http://127.0.0.1:3100)
import http from "node:http";

const PORT = Number(process.env.GATE_PORT ?? 3190);
const TARGET = new URL(process.env.PAPERCLIP_ORIGIN ?? "http://127.0.0.1:3100");
const ALLOWED = /^\/api\/chat-webhooks\/[A-Za-z0-9_-]{1,128}\/[a-z0-9-]{1,40}$/;
const MAX_BODY = 1024 * 1024; // Paperclip's own chat webhook body limit
const HOP_BY_HOP = new Set(["x-forwarded-host", "x-forwarded-proto", "x-forwarded-for", "forwarded", "connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-authorization", "te", "trailer"]);

const log = (...parts) => console.log(new Date().toISOString(), ...parts);

const server = http.createServer((req, res) => {
  const path = (req.url ?? "").split("?")[0];
  if (req.method !== "POST" || !ALLOWED.test(path)) {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
    log("blocked", req.method, path.slice(0, 80));
    return;
  }
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_BODY) {
    res.writeHead(413).end();
    return;
  }
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(name) && name !== "host") headers[name] = value;
  }
  const upstream = http.request(
    { host: TARGET.hostname, port: TARGET.port, path: req.url, method: "POST", headers: { ...headers, host: TARGET.host } },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
      log("forwarded", path.replace(/\/[^/]+\/([^/]+)$/, "/…/$1"), upstreamRes.statusCode);
    },
  );
  upstream.on("error", (error) => {
    if (!res.headersSent) res.writeHead(502).end();
    log("upstream error", error.message);
  });
  let received = 0;
  req.on("data", (chunk) => {
    received += chunk.length;
    if (received > MAX_BODY) {
      upstream.destroy();
      if (!res.headersSent) res.writeHead(413).end();
      req.destroy();
    }
  });
  req.pipe(upstream);
});

server.listen(PORT, "0.0.0.0", () => log(`webhook gate listening on ${PORT} -> ${TARGET.origin} (POST /api/chat-webhooks/* only)`));
