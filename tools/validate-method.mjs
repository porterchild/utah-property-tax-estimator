// Does the sum of entity rates at a point equal the published combined tax-area rate for the same year?
import { query } from "./arcgis.mjs";
import { loadLogic } from "./logic-loader.mjs";
const L = await loadLogic();

const yr = await query("TaxAreas2024", { where: "1=1", outFields: "TXAREA_YR", returnGeometry: "false", resultRecordCount: "1", groupByFieldsForStatistics: "TXAREA_YR", outStatistics: JSON.stringify([{ statisticType: "count", onStatisticField: "OBJECTID", outStatisticFieldName: "n" }]) });
console.log("TaxAreas2024 TXAREA_YR:", yr.map(f => f.attributes.TXAREA_YR).join(","));

const point = process.argv[2] || "-111.891,40.760";
const base = { geometry: point, geometryType: "esriGeometryPoint", inSR: "4326", spatialRel: "esriSpatialRelIntersects", returnGeometry: "false" };
const ents = await query("TaxEntities2024", Object.assign({ outFields: "ENT_CO,ENT_NBR,ENT_DESC,ENT_RATE" }, base));
const areas = await query("TaxAreas2024", Object.assign({ outFields: "TXAREA_YR,TXAREA_CO,TXAREA_ID,TXAREA_SUB,Rate" }, base));
let sum = 0;
const seen = new Set();
for (const f of ents) { const a = f.attributes; const k = a.ENT_CO + "|" + a.ENT_NBR; if (seen.has(k)) continue; seen.add(k); sum += a.ENT_RATE || 0; }
sum = Math.round(sum * 1e6) / 1e6;
console.log("entities", seen.size, "sum", sum.toFixed(6));
for (const f of areas) { const a = f.attributes; console.log("taxarea", a.TXAREA_YR, a.TXAREA_CO, a.TXAREA_ID, a.TXAREA_SUB, "Rate", a.Rate, "| diff", Math.round(((a.Rate || 0) - sum) * 1e6) / 1e6); }
