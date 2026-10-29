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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP = "utah-property-tax-estimator.html";
const PORT = Number(process.argv[2] || 5123);
// The page is one self-contained file, so nothing else leaves this directory: the project also
// holds notes and test tools, and a readable directory tree on the LAN would be reading my desk
// out loud. Only the estimator answers; everything else is a 404.
const ALIASES = new Set(["", "index.html", APP]);

function addresses() {
  return Object.entries(networkInterfaces()).flatMap(([name, addrs]) =>
    (addrs || []).filter((a) => a.family === "IPv4" && !a.internal).map((a) => ({ name, ip: a.address })));
}

const server = createServer(async (req, res) => {
  const path = decodeURIComponent((req.url || "/").split("?")[0]);
  const wanted = normalize(path).replace(/^[./\\]+/, "");   // "/../x" -> "x": compared against the list below, never opened as a path
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
  console.log(`serving ${APP} from ${ROOT}`);
  addresses().forEach((a) => console.log(`  http://${a.ip}:${PORT}/   (${a.name})`));
  console.log(`  http://127.0.0.1:${PORT}/`);
});
