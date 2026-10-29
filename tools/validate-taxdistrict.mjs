/* Per-parcel rate check that does not rely on the state's tax-area polygons.
   The county's own parcel record carries the tax district number the parcel is billed in
   (TAX_DISTRICT). Report 600 publishes the combined rate for that district. So: read the
   district off the parcel, sum the entity rates the app would sum at that parcel's own
   point, and compare with the published rate for the district the county assigned.
   Usage: node tools/validate-taxdistrict.mjs /tmp/r600-2025.json[,/tmp/r600-2024.json] [per-county] */
import { readFile } from "node:fs/promises";
import { query } from "./arcgis.mjs";
import { loadLogic } from "./logic-loader.mjs";

const L = await loadLogic();
const YEARS = { 2025: "economy_tax_entities_2025", 2024: "TaxEntities2024" };
const mapFiles = (process.argv[2] || "/tmp/r600-2025.json").split(",");
const byYear = {};
for (let i = 0; i < mapFiles.length; i++) byYear[String(2025 - i)] = JSON.parse(await readFile(mapFiles[i], "utf8"));
const perCounty = Number(process.argv[3] || 3);
const COUNTIES = Array.from({ length: 29 }, (_, i) => L.countyFromCode(String(i + 1).padStart(2, "0")));
const FIPS = {};
COUNTIES.slice().sort().forEach((n, i) => { FIPS[String(i + 1).padStart(2, "0")] = n.toUpperCase(); });
const keyOf = (county) => "Parcels_" + L.countyKey(county) + "_LIR";

function candidates(areas, fips, district) {
  const id = String(district).replace(/^0+/, "");
  const out = [];
  for (const k of Object.keys(areas)) {
    const [co, area, sub] = k.split("|");
    if (co !== fips) continue;
    if (String(area).replace(/^0+/, "") !== id) continue;
    out.push({ key: k, sub, total: areas[k].total, adopted: areas[k].totalAdopted, entities: areas[k].entities.length });
  }
  return out;
}

async function rateAtParcel(year, point) {
  const base = {
    geometry: point.join(","), geometryType: "esriGeometryPoint", inSR: "4326",
    spatialRel: "esriSpatialRelIntersects", returnGeometry: "false",
    outFields: "ENT_CO,ENT_NBR,ENT_DESC,ENT_RATE"
  };
  const feats = await query(YEARS[year], base);
  const s = L.summarizeEntities(feats.map((f) => f.attributes));
  return { sum: Math.round(s.total * 1e6) / 1e6, n: s.rows.length };
}

const jobs = [];
for (const county of COUNTIES) {
  for (const year of Object.keys(byYear)) {
    jobs.push({ county, year });
  }
}
const results = [];
const errs = [];
async function run(job) {
  const { county, year } = job;
  const fips = county.toUpperCase();
  let feats;
  try {
    feats = await query(keyOf(county), {
      where: "TAX_DISTRICT IS NOT NULL AND UPPER(PROP_CLASS) LIKE 'RES%' AND TOTAL_MKT_VALUE > 50000",
      outFields: "PARCEL_ID,PARCEL_ADD,TAX_DISTRICT,PARCEL_ACRES,TOTAL_MKT_VALUE,PRIMARY_RES",
      returnGeometry: "true", outSR: "4326", resultRecordCount: String(perCounty)
    });
  } catch (e) {
    errs.push(`${county} ${year} LIR: ${(e.message || "").slice(0, 40)}`);
    return;
  }
  for (const f of feats) {
    const a = f.attributes, rings = f.geometry && f.geometry.rings;
    const district = String(a.TAX_DISTRICT ?? "").trim();
    if (!rings || !rings.length || !district || !/\d/.test(district)) continue;
    const cands = candidates(byYear[year], fips, district);
    if (!cands.length) { results.push({ county, year, state: "no-area-row", district, addr: a.PARCEL_ADD }); continue; }
    let rate;
    try {
      rate = await rateAtParcel(year, L.interiorPoint(rings));
    } catch (e) {
      errs.push(`${county} ${year} entities: ${(e.message || "").slice(0, 40)}`);
      continue;
    }
    const hit = cands.find((c) => Math.abs(c.total - rate.sum) <= 1e-6 || Math.abs(c.adopted - rate.sum) <= 1e-6);
    const near = cands.find((c) => Math.abs(c.total - rate.sum) <= 1e-5);
    results.push({
      county, year, district, addr: a.PARCEL_ADD, sum: rate.sum, n: rate.n,
      state: hit ? "match" : near ? "near" : cands.length > 1 ? "multi-sub" : "diff",
      pdf: Math.max(...cands.map((c) => c.adopted ?? -1)), subs: cands.length,
      delta: +(rate.sum - Math.max(...cands.map((c) => c.adopted ?? 0))).toFixed(6),
      value: a.TOTAL_MKT_VALUE
    });
  }
}
const queue = jobs.slice();
async function worker() { while (queue.length) await run(queue.shift()); }
await Promise.all(Array.from({ length: 3 }, worker));

const stateOf = (s) => results.filter((r) => r.state === s);
const comparable = results.filter((r) => r.sum != null);
console.log(`\nParcel TAX_DISTRICT vs Report 600: ${comparable.length} parcels, ${stateOf("match").length} exact match, ${stateOf("near").length} within 0.00001, ${stateOf("multi-sub").length} ambiguous district (more than one sub-area), ${stateOf("diff").length} differ, ${stateOf("no-area-row").length} with no Report 600 row`);
for (const year of Object.keys(byYear)) {
  const rows = comparable.filter((r) => r.year === year);
  const ok = rows.filter((r) => r.state === "match" || r.state === "near").length;
  console.log(`  ${year}: ${ok}/${rows.length} match or near across ${new Set(rows.map((r) => r.county)).size} counties`);
}
const bad = results.filter((r) => r.state === "diff").sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 12);
if (bad.length) {
  console.log("\n  parcels where the summed rate is not the district rate:");
  for (const r of bad) console.log(`   ${r.county.padEnd(11)} ${r.year} district ${String(r.district).padEnd(6)} sum ${r.sum.toFixed(6)} pdf ${r.pdf.toFixed(6)} Δ ${String(r.delta).padStart(9)} subs ${r.subs} ents ${r.n}  ${String(r.addr).slice(0, 28)}`);
}
if (errs.length) console.log(`\n  errors (${errs.length}): ` + errs.slice(0, 5).join(" | "));
