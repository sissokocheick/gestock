/* GSV - Serveur de l'application
   - fichiers statiques de la PWA
   - proxy /api/*  et /ws vers le backend (même origin : plus de CORS ni de config gs_api)
   - HTTPS local (certs/gsv.pem) pour scanner caméra + impression WebUSB sur téléphone
   Aucune dépendance externe. */
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const net = require("net");
const zlib = require("zlib");

/* Compression gzip pour les fichiers statiques (aucune dépendance externe) */
const COMPRESS_TYPES = new Set([".html", ".js", ".css", ".json", ".svg", ".webmanifest"]);
function compressResponse(req, res, filePath, data) {
  const ext = path.extname(filePath).toLowerCase();
  const accept = req.headers["accept-encoding"] || "";
  if (COMPRESS_TYPES.has(ext) && accept.includes("gzip") && data.length > 256) {
    zlib.gzip(data, (err, compressed) => {
      if (err) { res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-cache" }); res.end(data); return; }
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Content-Encoding": "gzip", "Cache-Control": "no-cache" });
      res.end(compressed);
    });
  } else {
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(data);
  }
}

const ROOT = __dirname;
const HTTP_PORT = Number(process.env.PORT || 8080);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 8443);
const API_TARGET = process.env.API_TARGET || "http://localhost:4000";
const CERTS_DIR = process.env.CERTS_DIR || path.join(ROOT, "..", "certs");
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json",
  ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json"
};
/* Extensions jamais servies : sauvegardes, docs de travail, env */
const DENIED_EXT = new Set([".bak", ".docx", ".doc", ".backup", ".env", ".log", ".md", ".sql"]);

function handle(req, res) {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/api/")) return proxyApi(req, res, url);
  let p = decodeURIComponent(url.pathname);
  if (p === "/") p = "/index.html";
  if (DENIED_EXT.has(path.extname(p).toLowerCase())) { res.writeHead(404); res.end("Not found"); return; }
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end("Forbidden"); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    compressResponse(req, res, file, data);
  });
}

function proxyApi(req, res, url) {
  const t = new URL(API_TARGET);
  const headers = { ...req.headers, host: t.host };
  const preq = http.request({ host: t.hostname, port: t.port, method: req.method, path: url.pathname + url.search, headers }, pres => {
    res.writeHead(pres.statusCode, pres.headers);
    pres.pipe(res);
  });
  preq.on("error", () => { if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Backend indisponible — démarrez le backend" })); });
  req.pipe(preq);
}

/* Tunnel WebSocket brut vers le backend (aucune dépendance) */
function handleUpgrade(req, socket, head) {
  if (new URL(req.url, "http://x").pathname !== "/ws") { socket.destroy(); return; }
  const t = new URL(API_TARGET);
  const ps = net.connect(t.port, t.hostname, () => {
    ps.write("GET /ws HTTP/1.1\r\n" +
      "Host: " + t.host + "\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Key: " + (req.headers["sec-websocket-key"] || "") + "\r\n" +
      "Sec-WebSocket-Version: " + (req.headers["sec-websocket-version"] || "13") + "\r\n" +
      (req.headers["sec-websocket-protocol"] ? "Sec-WebSocket-Protocol: " + req.headers["sec-websocket-protocol"] + "\r\n" : "") +
      "\r\n");
    ps.write(head);
  });
  ps.on("error", () => socket.destroy());
  socket.on("error", () => ps.destroy());
  socket.pipe(ps);
  ps.pipe(socket);
}

const httpServer = http.createServer(handle);
httpServer.on("upgrade", handleUpgrade);
httpServer.listen(HTTP_PORT, "0.0.0.0", () => console.log("✅ App GSV : http://localhost:" + HTTP_PORT));

try {
  const httpsServer = https.createServer({
    key: fs.readFileSync(path.join(CERTS_DIR, "gsv-key.pem")),
    cert: fs.readFileSync(path.join(CERTS_DIR, "gsv.pem"))
  }, handle);
  httpsServer.on("upgrade", handleUpgrade);
  httpsServer.listen(HTTPS_PORT, "0.0.0.0", () => console.log("🔒 App GSV sécurisée : https://localhost:" + HTTPS_PORT + " (et https://<ip-du-pc>:" + HTTPS_PORT + ")"));
} catch (e) {
  console.log("ℹ️ HTTPS désactivé (certificats absents dans " + CERTS_DIR + ") : " + e.message);
}
