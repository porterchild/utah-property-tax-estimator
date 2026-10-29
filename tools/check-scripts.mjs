/* Parse check for the shipped page: every <script> block must compile, and the file must be
   free of control characters left behind by patching it from Python.
   node tools/check-scripts.mjs [file] */
import { readFileSync } from "node:fs";

const file = process.argv[2] || "utah-property-tax-estimator.html";
const html = readFileSync(file, "utf8");

const bad = [];
[...html.matchAll(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g)].forEach((m) =>
  bad.push("control character " + JSON.stringify(m[0]) + " at offset " + m.index)
);

const blocks = [...html.matchAll(/<script(?:\s+id="([^"]*)")?\s*>([\s\S]*?)<\/script>/g)];
let failures = 0;
for (const [i, [, id, body]] of blocks.entries()) {
  const name = id || "script #" + (i + 1);
  try {
    new Function(body);
    console.log("ok    " + name + " (" + body.length + " chars)");
  } catch (e) {
    failures++;
    console.log("FAIL  " + name + ": " + e.message);
    const line = /anonymous_script>?\s*:(\d+)/.exec(e.stack || "");
    if (line) {
      const src = body.split("\n");
      const n = Number(line[1]);
      for (let k = Math.max(0, n - 3); k < Math.min(src.length, n + 2); k++) {
        console.log(String(k + 1).padStart(5) + " | " + src[k]);
      }
    }
  }
}
bad.forEach((b) => console.log("FAIL  " + b));
console.log(failures || bad.length ? "FAILED" : "clean: " + blocks.length + " script blocks parse, no control characters");
process.exit(failures || bad.length ? 1 : 0);
