// Ad-hoc probe helper: node tools/probe.mjs <layer> <where> [extra params as k=v]
import { query } from "./arcgis.mjs";

const [layer, where, ...rest] = process.argv.slice(2);
const params = { where: where || "1=1", returnGeometry: "false", resultRecordCount: "20" };
for (const kv of rest) {
  const i = kv.indexOf("=");
  params[kv.slice(0, i)] = kv.slice(i + 1);
}
const fs = await query(layer, params);
for (const f of fs) console.log(JSON.stringify(f.attributes));
console.error("(" + fs.length + " features)");
