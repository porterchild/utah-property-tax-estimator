// Compares the sum of entity rates from the ArcGIS layer against Report 600 (the STC's certified
// combined rate per tax area) for points taken from real parcels.
// Usage: node tools/validate-rates.mjs /tmp/r600-2025.json [points...]
import { readFile } from "node:fs/promises";
import { query } from "./arcgis.mjs";
import { loadLogic } from "./logic-loader.mjs";

const mapFiles = process.argv[2].split(",");
const byYear = {};
for (let i = 0; i < mapFiles.length; i++) byYear[String(2024 + i)] = JSON.parse(await readFile(mapFiles[i], "utf8"));
const ALPH = ["BEAVER", "BOX ELDER", "CACHE", "CARBON", "DAGGETT", "DAVIS", "DUCHESNE", "EMERY", "GARFIELD", "GRAND", "IRON", "JUAB", "KANE", "MILLARD", "MORGAN", "PIUTE", "RICH", "SALT LAKE", "SAN JUAN", "SANPETE", "SEVIER", "SUMMIT", "TOOELE", "UINTAH", "UTAH", "WASATCH", "WASHINGTON", "WAYNE", "WEBER"];
const FIPS = {}; ALPH.forEach((n, i) => { FIPS[String(i + 1).padStart(2, "0")] = n; });

const points = process.argv.slice(3);
if (!points.length) {
  // Sample points from Salt Lake, Utah and Davis county parcel layers (interior-ish: use the layer's own centroid via returnCentroid).
  for (const svc of ["Parcels_SaltLake_LIR", "Parcels_Utah_LIR", "Parcels_Davis_LIR"]) {
    const L = await loadLogic();
    const fs = await query(svc, { where: "1=1 AND PARCEL_ADD IS NOT NULL", returnGeometry: "true", outSR: "4326", outFields: "PARCEL_ADD", resultRecordCount: "25" });
    for (const f of fs) { const r = f.geometry && f.geometry.rings; if (r && r.length) { const pt = L.interiorPoint(r); points.push(pt[0] + "," + pt[1]); } }
  }
}
const LAYERS = { 2024: "TaxEntities2024", 2025: "economy_tax_entities_2025" };
function summarize(rows, label) {
  const d = rows.map((r) => Math.abs(r.cert - r.layer)).sort((a, b) => a - b);
  if (!d.length) return console.log(label, "no comparable points");
  const at = (q) => d[Math.min(d.length - 1, Math.floor(q * d.length))];
  console.log(`${label}: n=${d.length} exact ${rows.filter((r) => r.cert === r.layer).length} within0.00001 ${rows.filter((r) => Math.abs(r.cert - r.layer) <= 1e-5).length} ` +
    `|abs diff| p50 ${at(0.5).toFixed(6)} p90 ${at(0.9).toFixed(6)} p99 ${at(0.99).toFixed(6)} max ${d[d.length - 1].toFixed(6)}`);
}
for (const [year, areas] of Object.entries(byYear)) { void areas;
  const rows = [];
  let noarea = 0, unknown = 0, err = 0;
  for (const p of points) {
    const base = { geometry: p, geometryType: "esriGeometryPoint", inSR: "4326", spatialRel: "esriSpatialRelIntersects", returnGeometry: "false" };
    let ents, ar;
    try {
      ents = await query(LAYERS[year], Object.assign({ outFields: "ENT_CO,ENT_NBR,ENT_DESC,ENT_RATE" }, base));
      ar = await query("TaxAreas2024", Object.assign({ outFields: "TXAREA_YR,TXAREA_CO,TXAREA_ID,TXAREA_SUB" }, base));
    } catch (e) { err++; if (err < 4) console.log(year, p, "ERR", e.message); continue; }
    const seen = new Map(); let sum = 0;
    for (const f of ents) { const a = f.attributes; const k = a.ENT_CO + "|" + a.ENT_NBR; if (seen.has(k)) continue; seen.set(k, a); sum += a.ENT_RATE || 0; }
    sum = Math.round(sum * 1e6) / 1e6;
    const at = ar[0]?.attributes;
    if (!at) { noarea++; continue; }
    const key = FIPS[at.TXAREA_CO] + "|" + at.TXAREA_ID + "|" + at.TXAREA_SUB;
    const area = areas[key];
    if (!area || area.total === undefined) { unknown++; continue; }
    rows.push({ key, layer: sum, cert: area.total, adopted: area.totalAdopted, nPdf: area.entities.length, nLayer: seen.size, sample: seen, p });
  }
  console.log(`\n=== tax year ${year} (${LAYERS[year]}) vs Report 600 ${year}: ${points.length} points, no-area ${noarea}, unknown-area ${unknown}, errors ${err}`);
  summarize(rows, `  vs auditor-certified`);
  summarize(rows.map((r) => ({ layer: r.layer, cert: r.adopted })), `  vs final-adopted  `);
  const worst = rows.filter((r) => r.cert !== r.layer).sort((a, b) => Math.abs(b.cert - b.layer) - Math.abs(a.cert - a.layer)).slice(0, 6);
  for (const r of worst) {
    console.log(`   ${r.key} layer ${r.layer.toFixed(6)} pdf ${r.cert.toFixed(6)} diff ${(r.layer - r.cert).toFixed(6)} (pdf ${r.nPdf} ents / layer ${r.nLayer} ents) ${r.p}`);
    if (r.sample && process.env.SHOW_ENTS === "1") {
      const inPdf = new Set((byYear[year][r.key]?.entities || []).map((e) => e.nbr));
      for (const [k, a] of r.sample) if (!byYear[year][r.key]?.entities.some((e) => e.nbr === a.ENT_NBR && Math.abs(e.adopted - a.ENT_RATE) < 5e-7)) console.log(`      layer-only ${a.ENT_CO} ${String(a.ENT_NBR).padEnd(5)} ${String(a.ENT_DESC).slice(0, 46).padEnd(48)} ${a.ENT_RATE.toFixed(6)}`);
      void inPdf;
    }
  }
}
