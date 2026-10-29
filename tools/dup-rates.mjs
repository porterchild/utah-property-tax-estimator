import { query } from "./arcgis.mjs";
const fs = await query("economy_tax_entities_2025", { where: "1=1", outFields: "ENT_ID,ENT_CO,ENT_NBR,ENT_DESC,ENT_RATE", returnGeometry: "false", resultRecordCount: "2000" });
const m = new Map();
for (const f of fs) { const a = f.attributes; const k = a.ENT_CO + "|" + a.ENT_NBR; (m.get(k) || m.set(k, []).get(k)).push(a.ENT_RATE); }
let dups = 0;
for (const [k, v] of m) if (new Set(v).size > 1) { dups++; if (dups < 12) console.log("DIFFERENT RATES for same entity:", k, v); }
console.log("entities", m.size, "with >1 distinct rate", dups);
console.log("ENT_ID unique?", new Set(fs.map(f=>f.attributes.ENT_ID)).size, "of", fs.length);
