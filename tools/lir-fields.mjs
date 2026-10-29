/* Asks every county parcel layer for one row and prints the value/class fields it publishes.
   A county that omits a column makes a query naming it fail, so ask for everything. */
import { loadLogic } from "./logic-loader.mjs";

const L = await loadLogic();
const COUNTIES = Array.from({ length: 29 }, (_, i) => L.countyFromCode(String(i + 1).padStart(2, "0")));

const BASE = "https://services1.arcgis.com/99lidPhWCzftIe9K/ArcGIS/rest/services/";
const key = (s) => s.replace(/[^A-Za-z]/g, "").replace(/^(.)(.*)$/, (m, a, b) => a.toUpperCase() + b);
const only = process.argv.slice(2);

async function one(county) {
  const svc = `Parcels_${key(county)}_LIR`;
  const body = new URLSearchParams({ where: "1=1", outFields: "*", returnGeometry: "false", resultRecordCount: "1", f: "json" });
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(`${BASE}${svc}/FeatureServer/0/query`, { method: "POST", body, signal: ctl.signal });
    const j = await r.json();
    if (j.error) return { county, err: j.error.message || String(j.error.code) };
    const a = (j.features || [])[0]?.attributes;
    if (!a) return { county, err: "empty" };
    const fields = Object.keys(a).filter((k) => /VALUE|CLASS|RES|ACRES|DISTRICT|EXEMPT|TAXABLE/i.test(k));
    return { county, fields: fields.map((k) => `${k}=${a[k] ?? "null"}`).join(" ") };
  } catch (e) {
    return { county, err: String(e.message || e).slice(0, 40) };
  } finally { clearTimeout(t); }
}

const list = only.length ? COUNTIES.filter((c) => only.includes(c)) : COUNTIES;
const queue = list.slice();
async function worker() { while (queue.length) console.log(JSON.stringify(await one(queue.shift()))); }
await Promise.all(Array.from({ length: 4 }, worker));
