/* Serves the estimator on the local network so a phone or laptop on the same Wi-Fi can use it.
   The app is one HTML file and only ever calls Utah's own services from the browser, so there is
   nothing else to proxy and no build step.
   Usage: node tools/serve.mjs [port]        (default 5123)
   Serves the page at / and at its own filename; no index.html is written into the project, so the
   file layout stays deployable into a site that has its own front page. */
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, resolve } from "node:path";
import { estimate, ApiError } from "./pipeline.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP = "utah-property-tax-estimator.html";
const PORT = Number(process.argv[2] || 5123);
// The page is one self-contained file, so the static side serves only the estimator. The JSON
// API at /api/estimate runs the same pipeline server-side for spreadsheets and batch work.
const ALIASES = new Set(["", "index.html", APP]);

/* The upstream Utah services answer in seconds and rate-limit politely; keep at most three
   estimates in flight so one eager spreadsheet cannot hammer them. */
let inFlight = 0;
const waiting = [];
async function guarded(fn) {
  if (inFlight >= 3) await new Promise((res) => waiting.push(res));
  inFlight++;
  try { return await fn(); } finally { inFlight--; waiting.shift()?.(); }
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  const data = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": type, "cache-control": "no-store",
    "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS"
  }).end(data);
  console.log(`${status} ${reqLabel}`);
}
let reqLabel = "";

function addresses() {
  return Object.entries(networkInterfaces()).flatMap(([name, addrs]) =>
    (addrs || []).filter((a) => a.family === "IPv4" && !a.internal).map((a) => ({ name, ip: a.address })));
}

const server = createServer(async (req, res) => {
  const path = decodeURIComponent((req.url || "/").split("?")[0]);
  const wanted = normalize(path).replace(/^[./\\]+/, "");   // "/../x" -> "x": compared against the list below, never opened as a path
  reqLabel = `${req.method} ${req.url} from ${req.socket.remoteAddress}`;

  if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS" }).end(); return; }

  if (path === "/api" || path === "/api/") {
    send(res, 200, {
      endpoint: "/api/estimate",
      params: {
        address: "street address or parcel number (required)",
        price: "purchase price, e.g. 605000 or 605,000 (optional)",
        primary: "true (default) | false — is the buyer occupying it as a primary residence"
      },
      example: "/api/estimate?address=810 S 900 E, Salt Lake City&price=605000",
      returns: "parcel, match quality (with candidates when ambiguous), county record, the equation terms, per-entity rates, warnings and notes",
      note: "live Utah state data per call, a few seconds each; be gentle"
    });
    return;
  }

  if (path === "/api/estimate") {
    const q = new URL(req.url, "http://x").searchParams;
    const started = Date.now();
    try {
      const out = await guarded(() => estimate({
        address: q.get("address") || q.get("q") || "",
        price: q.get("price"),
        primary: (q.get("primary") || "true").toLowerCase()
      }));
      out.api = { ms: Date.now() - started };
      send(res, 200, out);
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 502;
      send(res, status, { error: e.message || "lookup failed", api: { ms: Date.now() - started } });
      if (status >= 500) console.log("  upstream: " + (e.stack || e).toString().split("\n")[0]);
    }
    return;
  }

  if (!ALIASES.has(wanted)) {
    res.writeHead(404, { "content-type": "text/plain", "cache-control": "no-store" })
      .end(`404: ${path} is not the estimator. The page is at /\n`);
    console.log(`404 ${req.method} ${path} (${req.socket.remoteAddress})`);
    return;
  }
  const file = join(ROOT, APP);
  try {
    const body = await readFile(file);
    if (!(await stat(file)).isFile()) throw Object.assign(new Error("not a file"), { code: "EISDIR" });
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      // Never cache: the page is edited in place and reloaded from this server while testing.
      "cache-control": "no-store",
      "content-length": body.length
    }).end(body);
    console.log(`${res.statusCode} ${req.method} ${path} -> ${APP} from ${req.socket.remoteAddress}`);
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain", "cache-control": "no-store" })
      .end(`${e.code || "error"}: could not read ${APP}\n`);
    console.log(`500 ${req.method} ${path} (${e.code || e.message})`);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  const port = server.address().port;   // may differ from PORT when the OS picks one (PORT=0)
  console.log(`serving ${APP} from ${ROOT}`);
  addresses().forEach((a) => console.log(`  http://${a.ip}:${port}/   (${a.name})`));
  console.log(`  http://127.0.0.1:${port}/`);
  console.log(`  api: http://127.0.0.1:${port}/api/estimate?address=...`);
});
