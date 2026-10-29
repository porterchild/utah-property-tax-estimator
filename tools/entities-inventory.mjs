import { query } from "./arcgis.mjs";
const fs = await query("economy_tax_entities_2025", {
  where: "1=1", outFields: "ENT_NBR,ENT_DESC,ENT_CO,ENT_RATE", returnGeometry: "false", resultRecordCount: "2000"
});
const m = new Map();
for (const f of fs) {
  const a = f.attributes;
  const k = a.ENT_NBR;
  if (!m.has(k)) m.set(k, { nbr: k, descs: new Set(), n: 0, sum: 0, max: -Infinity, min: Infinity, cos: new Set() });
  const e = m.get(k);
  e.n++; e.sum += a.ENT_RATE || 0; e.max = Math.max(e.max, a.ENT_RATE || 0); e.min = Math.min(e.min, a.ENT_RATE || 0);
  e.descs.add(a.ENT_DESC); e.cos.add(a.ENT_CO);
}
const rows = [...m.values()].sort((a, b) => a.nbr - b.nbr);
console.log("features", fs.length, "distinct ENT_NBR", rows.length);
for (const r of rows) {
  const d = [...r.descs].slice(0, 3).join(" | ");
  console.log(String(r.nbr).padStart(6), "n=" + String(r.n).padEnd(5), "rate[" + r.min.toFixed(6) + ".." + r.max.toFixed(6) + "]", "cos=" + r.cos.size, d.slice(0, 90));
}
