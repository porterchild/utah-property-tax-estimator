/* Live smoke test for the JSON API: boots tools/serve.mjs on an ephemeral port and calls
   /api/estimate the way a spreadsheet would. Usage: node tools/smoke-api.mjs */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const child = spawn(process.execPath, ["tools/serve.mjs", "0"], { stdio: ["ignore", "pipe", "pipe"] });
let base = null;
child.stdout.on("data", (d) => {
  const m = String(d).match(/http:\/\/127\.0\.0\.1:(\d+)\//);
  if (m) base = `http://127.0.0.1:${m[1]}`;
});
child.stderr.on("data", (d) => console.error("server:", String(d).trim()));
const die = setTimeout(() => { console.error("server did not start"); process.exit(1); }, 8000);
while (!base) await sleep(100);
clearTimeout(die);

const CASES = [
  { qs: "address=500 W Center St, Provo&price=605000", expect: 200, why: "address with city, price only basis" },
  { qs: "address=08221800110000&price=605000&primary=false", expect: 200, why: "parcel number, county value basis, second home" },
  { qs: "address=175 N Main St, Tooele", expect: 200, why: "location-only match -> needs_review + no price (county value carries it)" },
  { qs: "address=9999 Nowhere Zz Rd, Monticello", expect: 404, why: "address that does not exist" },
  { qs: "address=", expect: 400, why: "missing address" },
  { qs: "address=810 S 900&price=400000", expect: 200, why: "grid input without the cross street still finds the parcel" }
];

let fails = 0;
for (const c of CASES) {
  let res, body;
  try {
    res = await fetch(`${base}/api/estimate?${c.qs}`, { headers: { accept: "application/json" } });
    body = await res.json();
  } catch (e) { console.log(`FAIL ${c.qs}\n       transport error: ${e.message}`); fails++; continue; }
  const problems = [];
  if (res.status !== c.expect) problems.push(`status ${res.status}, wanted ${c.expect}`);
  if (res.status === 200) {
    const e = body.estimate || {};
    if (!(e.combined_rate > 0.002 && e.combined_rate < 0.03)) problems.push("rate out of range: " + e.combined_rate);
    if (!(e.monthly > 0)) problems.push("monthly not positive");
    if (!body.levy_summary || body.levy_summary.bodies < 3) problems.push("too few entities");
    if (!e.rate_year) problems.push("no rate year");
    if (!e.equation) problems.push("no equation strip");
    if (body.match.needs_review === undefined) problems.push("no needs_review flag");
    const hasValue = e.market_value > 0 || (body.comparison && body.comparison.market_value > 0);
    if (!hasValue) problems.push("no value on any basis");
    if (c.qs.startsWith("address=175")) {
      if (!body.match.needs_review) problems.push("location-only match should need review");
      if (!body.match.note) problems.push("location-only match should carry a note");
    }
    if (c.qs.includes("primary=false") && e.taxable_share !== 1) problems.push("second home share should be 1, got " + e.taxable_share);
    if (c.qs.startsWith("address=0822") && body.estimate.basis !== "county") problems.push("county value should lead: " + body.estimate.basis);
  } else {
    if (!body.error) problems.push("error body missing");
  }
  console.log(`${problems.length ? "FAIL" : "ok  "} [${res.status}] ${c.qs}`);
  console.log(`       ${c.why}`);
  if (res.status === 200) console.log(`       ${body.match.quality} · ${body.parcel.id} ${body.parcel.county} · ${body.estimate.equation}`);
  else console.log(`       ${body.error}`);
  if (problems.length) { fails++; console.log("       ↳ " + problems.join("; ")); }
}

// CORS must let other origins call the API.
const cors = await fetch(`${base}/api/estimate?address=500 W Center St, Provo`);
if (cors.headers.get("access-control-allow-origin") !== "*") { console.log("FAIL  CORS: no access-control-allow-origin on API"); fails++; }
else console.log("ok    CORS: access-control-allow-origin: *");

child.kill();
console.log(fails ? `\n${fails} api case(s) failed` : `\nall api cases passed at ${base}`);
process.exit(fails ? 1 : 0);
