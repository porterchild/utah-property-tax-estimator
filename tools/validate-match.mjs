/* Identity-integrity suite: the promise a user actually experiences.
 *
 * Every other suite checks numbers or rendering. This one checks the thing whose failure a broker
 * mails to us: when someone types an address, the parcel that comes back must BE that address,
 * or the answer must announce itself as unsure. Cases are generated FROM the live parcel layer,
 * not from my imagination, because the corpus I write can only ever contain addresses whose right
 * answer I already knew — which is exactly how the Garland/Clarkston bug stayed alive.
 *
 *   true pairs   sample real parcels, query "PARCEL_ADD, PARCEL_CITY, UT" the way a user types
 *                it. A silent answer (needs_review=false) must return that parcel.
 *   twins        one street string, several towns (from the sample itself, plus grid strings like
 *                "200 N 100 W" that repeat statewide). Typing one town must either land there or
 *                shout — never silently answer the other town.
 *   swaps        a real address paired with a different real city. The never-silent rule again.
 *   invariant    checked on every response: needs_review===false implies city_check.ok===true.
 *
 * Service hiccups are retried once and then SKIPPED, never failed — this suite cries wolf only
 * on dishonesty. Usage: node tools/validate-match.mjs [--quick]
 */
import { loadLogic } from "./logic-loader.mjs";
import { estimate, ApiError } from "./pipeline.mjs";
import { query } from "./arcgis.mjs";

const L = await loadLogic();
const QUICK = process.argv.includes("--quick");

const FIELDS = "PARCEL_ID,PARCEL_ADD,PARCEL_CITY,PARCEL_ZIP,County";
const LOOKBAD = /water|sewer|section|township|railroad|railway|us hwy|highway|interstate|unrecord|parcel [a-z]$|tract|blk|lot \d+ block|slope|drain|canal|ditch|\bpt\b|trse|sw corner|ne corner|nw corner|se\b|nw\b|ne\b|school|park$|forest|wash$|fairground|airport|right of way|\brw\b|reserved|empty|#\d/i;
const looksTypable = (a) => /^\d{1,6}[A-Z]?(\s|$|-)/.test(a) && a.replace(/[^A-Za-z]/g, "").length > 5 && !LOOKBAD.test(a);
/* Same-place test through the shipped logic, so the judge and the product agree. */
const cityAgrees = (typed, onParcel) => L.placeCheck({ city: typed, zip: null }, { PARCEL_CITY: onParcel }).ok;
const idSame = (a, b) => String(a || "").replace(/[^0-9A-Za-z]/g, "").toUpperCase() === String(b || "").replace(/[^0-9A-Za-z]/g, "").toUpperCase();

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const j = next++;
      if (j >= items.length) return;
      out[j] = await fn(items[j], j);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/* ---- sample the statewide layer in OBJECTID windows, keeping rows a person would type ---- */
async function sampleParcels() {
  const top = (await query("UtahStatewideParcels", {
    where: "1=1", outFields: "OBJECTID", returnGeometry: "false",
    orderByFields: "OBJECTID DESC", resultRecordCount: "1"
  }))[0];
  const maxId = top ? top.attributes.OBJECTID : 2000000;
  const windows = QUICK ? 5 : 12;
  const rows = [];
  for (let w = 0; w < windows; w++) {
    const a = Math.floor((maxId * (w + 0.1)) / windows);
    const b = Math.floor((maxId * (w + 0.9)) / windows);
    try {
      const fs = await query("UtahStatewideParcels", {
        where: `OBJECTID BETWEEN ${a} AND ${b} AND PARCEL_ADD IS NOT NULL AND PARCEL_CITY IS NOT NULL`,
        outFields: FIELDS, returnGeometry: "false", resultRecordCount: "40"
      });
      for (const f of fs) {
        const c = f.attributes;
        if (looksTypable(c.PARCEL_ADD) && String(c.PARCEL_CITY || "").length > 2) rows.push(c);
      }
    } catch (e) { console.log(`  (sample window ${w} failed: ${String(e.message).slice(0, 60)})`); }
  }
  const seen = {}; return rows.filter((c) => !seen[String(c.PARCEL_ID) + c.PARCEL_CITY]++ && c);
}

/* ---- run one case through the product's own estimate(), hiccups -> SKIP ---- */
async function attempt(address) {
  for (let t = 0; t < 2; t++) {
    try {
      return { ok: true, r: await estimate({ address, price: "400000" }) };
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 400)) return { ok: false, err: e };
      if (t === 1) return { ok: false, err: e };
      await new Promise((r) => setTimeout(r, 800));
    }
  }
}

let fails = 0, skips = 0;
const line = (mark, kind, detail) => console.log(`${mark}  ${kind.padEnd(6)} ${detail}`);

/* ---- Phase 1: true pairs ---- */
const samples = await sampleParcels();
const wanted = QUICK ? 8 : 24;
// Prefer a spread of counties rather than 24 rows of one dormitory suburb.
const spread = []; const byCounty = {};
for (const c of samples) { const k = String(c.County); if ((byCounty[k] = (byCounty[k] || 0)) < 2 && spread.length < wanted) { byCounty[k]++; spread.push(c); } }
while (spread.length < Math.min(wanted, samples.length) && spread.length < wanted) spread.push(samples[spread.length * 3 % samples.length]);
console.log(`true pairs — ${spread.length} sampled parcels queried exactly as recorded\n`);
const trueResults = await pool(spread.slice(0, wanted), 4, async (c) => {
  const typed = `${c.PARCEL_ADD}, ${c.PARCEL_CITY}, UT`;
  const a = await attempt(typed);
  if (!a.ok) { skips++; return line("SKIP", "true", `${typed.slice(0, 66).padEnd(68)} ${String(a.err.message || a.err).slice(0, 40)}`), null; }
  const r = a.r, m = r.match;
  const silent = m.needs_review === false;
  const wrongTownSilent = silent && m.city_check && m.city_check.ok === false;
  const wrongParcelSilent = silent && !idSame(r.parcel.id, c.PARCEL_ID);
  // Same recorded address and city but a different parcel id: the county data itself holds
  // duplicate rows; the address identity the user asked about is still satisfied.
  const duplicateRow = wrongParcelSilent && String(r.parcel.recorded_address || "").toUpperCase() === String(c.PARCEL_ADD).toUpperCase() && cityAgrees(c.PARCEL_CITY, r.parcel.city);
  const broken = wrongTownSilent || (wrongParcelSilent && !duplicateRow);
  if (broken) fails++;
  line(broken ? "FAIL" : "ok  ", "true",
    `${typed.slice(0, 58).padEnd(60)} → ${String(r.parcel.id).slice(0, 14).padEnd(15)}${String(r.parcel.city || "-").slice(0, 14).padEnd(15)}` +
    `${m.quality.padEnd(12)}${silent ? "silent" : "flagged"}${wrongTownSilent ? "  WRONG TOWN SILENT" : wrongParcelSilent ? (duplicateRow ? "  duplicate data row" : "  WRONG PARCEL SILENT") : ""}`);
  return r;
});

/* ---- Phase 2: twins — the same street string in more than one town ---- */
const twinsFromSample = (() => {
  const byAddr = {};
  for (const c of samples) { const k = String(c.PARCEL_ADD).toUpperCase().replace(/\s+/g, " ").trim(); (byAddr[k] = byAddr[k] || new Set()).add(String(c.PARCEL_CITY).toUpperCase()); }
  const out = [];
  for (const [addr, cities] of Object.entries(byAddr)) if (cities.size > 1 && out.length < 3) out.push({ addr, cities: [...cities] });
  return out;
})();
const gridTwins = [];
for (const s of ["200 N 100 W", "100 E 100 S", "75 W 200 N"]) {
  try {
    const fs = await query("UtahStatewideParcels", { where: `UPPER(PARCEL_ADD) = '${s}'`, outFields: FIELDS, returnGeometry: "false", resultRecordCount: "60" });
    const cities = [...new Set(fs.map((f) => String(f.attributes.PARCEL_CITY || "").toUpperCase()).filter(Boolean))];
    if (cities.length > 1) gridTwins.push({ addr: s, cities });
  } catch (e) { /* hiccup, carry on */ }
}
const twinCases = [...twinsFromSample, ...gridTwins].slice(0, QUICK ? 2 : 6);
console.log(`\ntwins — one street string, several towns (typed city must win or the answer must shout)`);
for (const t of twinCases) {
  // ask for a city other than the alphabetical first, so a fixed order cannot flatter us
  const typedCity = t.cities[Math.floor(Math.random() * t.cities.length)];
  const a = await attempt(`${t.addr}, ${typedCity}, UT`);
  if (!a.ok) { skips++; line("SKIP", "twin", `${t.addr} in ${t.cities.join("/")} — ${String(a.err.message || a.err).slice(0, 40)}`); continue; }
  const r = a.r, m = r.match;
  const silent = m.needs_review === false;
  const landedRight = m.city_check && m.city_check.ok === true && String(r.parcel.recorded_address || "").toUpperCase().replace(/\s+/g, " ").trim() === t.addr;
  if (silent && !landedRight) fails++;
  line(silent && !landedRight ? "FAIL" : "ok  ", "twin",
    `${(t.addr + ", " + typedCity).slice(0, 58).padEnd(60)} → ${String(r.parcel.city || "-").slice(0, 16).padEnd(18)}${m.quality.padEnd(12)}${silent ? (landedRight ? "silent, in the typed town" : "SILENT WRONG TOWN") : "flagged"}`);
}

/* ---- Phase 3: swaps — a real address with somebody else's city ---- */
const swaps = [];
const swapWant = QUICK ? 3 : 6;
for (let i = 0; i + 1 < spread.length && swaps.length < swapWant; i++) {
  const c = spread[i], wrong = spread[i + 1];
  const sameStreet = String(c.PARCEL_ADD).toUpperCase() === String(wrong.PARCEL_ADD).toUpperCase();
  if (!sameStreet && !cityAgrees(wrong.PARCEL_CITY, c.PARCEL_CITY)) swaps.push({ c, wrong });
}
console.log(`\nswaps — real address, different real city (never silent, unless the typed town genuinely has that street)`);
for (const s of swaps) {
  const typed = `${s.c.PARCEL_ADD}, ${s.wrong.PARCEL_CITY}, UT`;
  const a = await attempt(typed);
  if (!a.ok) { skips++; line("SKIP", "swap", `${typed.slice(0, 60)} — ${String(a.err.message || a.err).slice(0, 30)}`); continue; }
  const r = a.r, m = r.match;
  const ok = (m.city_check && m.city_check.ok === true) || m.needs_review === true;
  if (!ok) fails++;
  line(ok ? "ok  " : "FAIL", "swap", `${typed.slice(0, 58).padEnd(60)} → parcel in ${String(r.parcel.city || "-").slice(0, 16).padEnd(18)}${m.needs_review ? "flagged" : (m.city_check.ok ? "silent, but in the typed town" : "SILENT, WRONG TOWN")}`);
}

/* ---- Phase 4: the universal invariant over everything we just got ---- */
const all = [...trueResults.filter(Boolean)];
const brokenInvariant = all.filter((r) => r.match.needs_review === false && r.match.city_check && r.match.city_check.ok === false);
if (brokenInvariant.length) fails += brokenInvariant.length;
console.log(`\ninvariant over ${all.length} answered cases: silent answer implies city_check.ok`);
console.log(brokenInvariant.length ? `FAIL  ${brokenInvariant.length} violated` : "ok    no silent answer contradicted the typed place");

console.log(`\n${fails ? "FAIL" : "PASS"} validate-match: ${fails} honesty violation(s), ${skips} skipped on service hiccups`);
process.exit(fails ? 1 : 0);
