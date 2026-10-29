/* End-to-end lookup validation against live Utah services.
   For each sampled parcel we take its own recorded address and run it through the same steps the
   web app runs (geocode -> nearby parcels -> rank, with the recorded-address query as fallback),
   then check we land back on the same PARCEL_ID.
   Mirrors findParcel() in utah-property-tax-estimator.html; the app itself is DOM-bound.
   Usage: node tools/validate-lookup.mjs [perCount=6] */
import { loadLogic } from "./logic-loader.mjs";
import { query } from "./arcgis.mjs";

const L = await loadLogic();
const { parseAddress, rankGeocodeCandidates, rankParcels, buildAddressWhere } = L;
const perCount = Number(process.argv[2] || 6);
const COUNTIES = (process.argv[3] || "SaltLake,Utah,Davis,Weber,Washington,Cache,Tooele,Summit").split(",");
const FIELDS = "PARCEL_ID,PARCEL_ADD,PARCEL_CITY,PARCEL_ZIP,County";

async function geocode(line) {
  const r = await fetch("https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates", {
    method: "POST",
    body: new URLSearchParams({ SingleLine: line, OutFields: "Addr_type", MaxLocations: "3", countryCode: "USA", f: "json" })
  }).then((x) => x.json()).catch(() => ({ candidates: [] }));
  return r.candidates || [];
}

const APP_FIELDS = "PARCEL_ID,PARCEL_ADD,PARCEL_CITY,PARCEL_ZIP,County,OWN_TYPE,CoParcel_URL,ACCOUNT_NUM";
const usable = (fs) => (fs || []).filter((f) => { const a = L.attrs(f); return a.PARCEL_ID || a.PARCEL_ADD; });

// Same radii the app tries: ~22 m, ~90 m, ~330 m, and only parcels we can actually name.
async function parcelsNear(pt, radii = [0.0002, 0.0008, 0.003]) {
  for (const r of radii) {
    const box = `${pt[0] - r},${pt[1] - r},${pt[0] + r},${pt[1] + r}`;
    let fs = [];
    try {
      fs = await query("UtahStatewideParcels", {
        geometry: box, geometryType: "esriGeometryEnvelope", inSR: "4326", spatialRel: "esriSpatialRelIntersects",
        outFields: APP_FIELDS, returnGeometry: "true", outSR: "4326", resultRecordCount: "12"
      });
    } catch { /* one bad box is not a failed lookup */ }
    if (usable(fs).length) return usable(fs);
    if (r === radii[radii.length - 1]) break; // the app grows the box rather than re-asking it
  }
  return [];
}

/* The app's recorded-address fallback: a box around the geocoded point first (the address column is
   not indexed, the spatial one is), growing to a statewide scan only if the boxes come back empty. */
async function parcelsByWhere(where, pt) {
  if (!where) return [];
  const boxes = pt ? [0.02, 0.25] : [null]; // same bounds the app uses
  for (const r of boxes) {
    const params = {
      where, outFields: APP_FIELDS, returnGeometry: "true", outSR: "4326", resultRecordCount: "25", orderByFields: "PARCEL_ADD"
    };
    if (r != null) Object.assign(params, {
      geometry: `${pt[0] - r},${pt[1] - r},${pt[0] + r},${pt[1] + r}`,
      geometryType: "esriGeometryEnvelope", inSR: "4326", spatialRel: "esriSpatialRelIntersects"
    });
    let fs = [];
    try { fs = await query("UtahStatewideParcels", params); } catch { /* keep growing */ }
    if (fs.length) return fs;
  }
  return [];
}

/* The app's findParcel(), step for step. */
async function findParcel(input) {
  const parsed = parseAddress(input);
  if (!parsed.house) return { ranked: [], how: "unparseable" };
  const picks = rankGeocodeCandidates({ candidates: await geocode(input) }, parsed).slice(0, 2);
  let best = null;
  for (const c of picks) {
    const ranked = rankParcels(await parcelsNear([c.x, c.y]), parsed, [c.x, c.y]);
    if (ranked.length && (!best || ranked[0].s > best.ranked[0].s)) best = { ranked, how: "geocode", point: [c.x, c.y] };
    if (best && best.ranked[0].bucket === 2) break;
  }
  if (best && best.ranked[0].bucket === 2) return best;
  const byAddr = rankParcels(await parcelsByWhere(buildAddressWhere(parsed), best && best.point), parsed, best && best.point);
  if (byAddr.length && (!best || byAddr[0].s > best.ranked[0].s)) return { ranked: byAddr, how: "address" };
  return best || { ranked: [], how: "none" };
}

const rows = [];
for (const county of COUNTIES) {
  const sample = await query("UtahStatewideParcels", {
    where: `County='${county}' AND PARCEL_ADD IS NOT NULL AND PARCEL_ADD <> ' ' AND MOD(OBJECTID, ${process.argv[4] || 499}) = 7`,
    outFields: FIELDS, returnGeometry: "false", resultRecordCount: String(perCount)
  });
  for (const f of sample) {
    const a = f.attributes;
    const line = `${String(a.PARCEL_ADD).trim()}, Utah`;
    let res = { id: null, why: "" };
    try {
      const out = await findParcel(line);
      const top = (out.ranked || [])[0];
      if (top) {
        res.id = top.c.PARCEL_ID;
        res.why = `${out.how} a=${top.a}${top.m != null ? " " + top.m + "m" : ""} n=${out.ranked.length} top="${(top.c.PARCEL_ADD || "").trim()}"`;
      } else res.why = "nothing found";
    } catch (e) { res.why = "ERR " + String(e.message).slice(0, 60); }
    const ok = res.id === a.PARCEL_ID;
    rows.push({ county, ok, miss: ok ? null : a.PARCEL_ADD, want: ok ? null : a.PARCEL_ID, why: res.why });
    console.log(`${ok ? "OK  " : "MISS"} ${county.padEnd(10)} ${String(a.PARCEL_ADD).padEnd(28)} -> ${String(res.id || "—").padEnd(15)} ${res.why}`);
  }
}
const hit = rows.filter((r) => r.ok).length;
console.log(`\nexact parcel id match: ${hit}/${rows.length} (${((100 * hit) / rows.length).toFixed(0)}%)`);
const byCounty = {};
for (const r of rows) (byCounty[r.county] = byCounty[r.county] || { ok: 0, n: 0 }, byCounty[r.county].n++, r.ok && byCounty[r.county].ok++);
for (const k in byCounty) console.log("  " + k.padEnd(11) + byCounty[k].ok + "/" + byCounty[k].n);
const misses = rows.filter((r) => !r.ok);
if (misses.length) console.log("\nmisses:\n" + misses.map((m) => `  ${m.county} "${m.miss}" want=${m.want} got=${String(m.why).split(" ")[0]} :: ${m.why}`).join("\n"));
