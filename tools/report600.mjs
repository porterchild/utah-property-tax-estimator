// Parses the STC "Tax Rates by Tax Area" PDF into a lookup of certified combined rates.
// Usage: node tools/report600.mjs <pdf> [out.json]
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const [pdf, out] = process.argv.slice(2);
const txt = execFileSync("pdftotext", ["-layout", pdf, "-"], { encoding: "utf8", maxBuffer: 1 << 28 });
const lines = txt.split(/\r?\n/);
const map = {};          // "SALT LAKE|01V|0000" -> { total, entities: [[nbr,name,rate]] }
const countyTotals = {}; // county -> { min, max, sum, n }
let county = null, area = null, cur = null, stats = null, pending = null;
const isRate = (t) => /^-?\d\.\d{6}$/.test(t);
// Trailing rate columns, then the descriptive remainder.
function splitRow(toks) {
  const nums = [];
  let i = toks.length - 1;
  while (i > 0 && isRate(toks[i])) { nums.unshift(toks[i]); i--; }
  return { nums: nums.map(Number), rest: toks.slice(1, i + 1) };
}
function pushEntity(cur, nbr, name, nums) {
  const adopted = nums[nums.length - 1];
  cur.entities.push({ nbr, name, certified: nums.length >= 3 ? nums[0] : adopted, proposed: nums.length >= 3 ? nums[1] : adopted, adopted });
}
for (const ln of lines) {
  const cm = ln.match(/^\s*([A-Z][A-Z .'-]+?)\s+COUNTY\s*$/);
  if (cm && !/Tax Area/i.test(ln)) { county = cm[1].trim(); stats = countyTotals[county] || (countyTotals[county] = { n: 0, min: Infinity, max: 0, sum: 0 }); continue; }
  const am = ln.match(/^Tax Area\s+(\S+)\s*-\s*(\S+)\s*$/);
  if (am) { area = am[1] + "|" + am[2]; pending = null; cur = map[county + "|" + area] = { county, area, entities: [] }; continue; }
  // Entity rows look like "1010  BEAVER  0.001462 0.001462 0.001462", but a long name wraps onto the
  // next line, leaving the rates alone on that continuation line.
  const toks = ln.trim().split(/\s+/);
  if (cur && toks.length > 1 && /^\d{3,6}$/.test(toks[0])) {
    const { nums, rest } = splitRow(toks);
    if (rest.length && /^[A-Z&]/.test(rest.join(" "))) {
      if (nums.length) { pushEntity(cur, +toks[0], rest.join(" "), nums); pending = null; }
      else pending = { nbr: +toks[0], name: rest.join(" ") };
      continue;
    }
  }
  if (cur && pending) {
    // Continuation line: rate columns, optionally preceded by the tail of a wrapped name.
    const nums = [];
    let i = toks.length - 1;
    while (i >= 0 && isRate(toks[i])) { nums.unshift(+toks[i]); i--; }
    const rest = toks.slice(0, i + 1);
    if (nums.length && !rest.some(isRate)) {
      pushEntity(cur, pending.nbr, (pending.name + " " + rest.join(" ")).replace(/\s+/g, " ").trim(), nums);
      pending = null;
      continue;
    }
  }
  const tm = ln.match(/^Total for Tax Area\s+(\S+)\s*-\s*(\S+)\s+(-?\d\.\d{6})\s+(-?\d\.\d{6})\s+(-?\d\.\d{6})\s*$/);
  if (tm && cur) {
    cur.total = +tm[3];
    cur.totalAdopted = +tm[5];
    cur.sumOfEntities = Math.round(cur.entities.reduce((s, e) => s + e.adopted, 0) * 1e6) / 1e6;
    if (stats) { stats.n++; stats.sum += cur.total; stats.min = Math.min(stats.min, cur.total); stats.max = Math.max(stats.max, cur.total); }
    area = null; cur = null; pending = null;
  }
}
const byCounty = Object.keys(countyTotals).sort((a, b) => countyTotals[b].n - countyTotals[a].n);
console.log("counties", byCounty.length, "tax areas", Object.keys(map).length);
for (const c of byCounty) { const s = countyTotals[c]; console.log(" ", c.padEnd(18), "areas", String(s.n).padStart(4), "rate range", s.min.toFixed(6), "-", s.max.toFixed(6), "avg", (s.sum / s.n).toFixed(6)); }
if (out) { await writeFile(out, JSON.stringify(map)); console.log("wrote", out); }
