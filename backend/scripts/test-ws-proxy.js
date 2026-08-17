/* Test rapide : WebSocket à travers le proxy HTTP (8080) et HTTPS (8443) du serveur d'app */
const WebSocket = require("C:\\Users\\hp\\Pictures\\gestion de stock\\backend\\node_modules\\ws");

function test(label, url) {
  return new Promise(resolve => {
    let done = false;
    const finish = ok => { if (!done) { done = true; console.log((ok ? "OK  " : "FAIL") + " " + label); resolve(ok); } };
    const t = setTimeout(() => finish(false), 6000);
    try {
      const ws = new WebSocket(url, { rejectUnauthorized: false });
      ws.on("open", () => { clearTimeout(t); ws.close(); finish(true); });
      ws.on("error", e => { clearTimeout(t); finish(false); });
    } catch (e) { clearTimeout(t); finish(false); }
  });
}

(async () => {
  const a = await test("ws://localhost:8080/ws (proxy HTTP)", "ws://localhost:8080/ws");
  const b = await test("wss://localhost:8443/ws (proxy HTTPS)", "wss://localhost:8443/ws");
  console.log(a && b ? "WS_PROXY_TOUT_OK" : "WS_PROXY_ECHEC");
  process.exit(a && b ? 0 : 1);
})();
