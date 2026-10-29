import { query } from "./arcgis.mjs";
const CNT = JSON.stringify([{ statisticType: "count", onStatisticField: "OBJECTID", outStatisticFieldName: "n" }]);
const svc = await (await fetch("https://services1.arcgis.com/99lidPhWCzftIe9K/ArcGIS/rest/services?f=json")).json();
const names = [...new Set(svc.services.map((s) => s.name))].filter((n) => /^Parcels_.*_LIR$/.test(n)).sort();
console.log("LIR layers:", names.length, names.join(" "));
for (const L of names) {
  const c = async (w) => {
    try { const f = await query(L, { where: w, outStatistics: CNT, returnGeometry: "false", groupByFieldsForStatistics: "COUNTY_ID" }); return f[0].attributes; }
    catch (e) { return { err: e.message.slice(0, 40) }; }
  };
  const all = await c("1=1");
  const addr = await c("PARCEL_ADD IS NOT NULL");
  const ac = await c("PARCEL_ACRES IS NOT NULL");
  const mv = await c("TOTAL_MKT_VALUE IS NOT NULL");
  console.log(L.padEnd(26), "total", String(all.n).padStart(7), "addr", String(addr.n).padStart(7),
    "acres", String(ac.n).padStart(7), "value", String(mv.n).padStart(7), "countyid", all.COUNTY_ID, all.err || (addr.err ? "ADDRERR" : ""));
}
