/* Server-side mirror of the shipped page's lookup, for the JSON API in tools/serve.mjs.
   Same steps, same pure logic from <script id="logic">: geocode -> nearby parcels -> rank
   (with the recorded-address fallback and the parcel-number branch), then the taxing
   entities at a point inside the parcel, then the county's own parcel record for the
   market value. Returns plain JSON-ready data; no DOM anywhere. */
import { loadLogic } from "./logic-loader.mjs";
import { query, ARCGIS } from "./arcgis.mjs";

const L = await loadLogic();
const PARCELS = "UtahStatewideParcels";
const APP_FIELDS = "PARCEL_ID,PARCEL_ADD,PARCEL_CITY,PARCEL_ZIP,County,OWN_TYPE,CoParcel_URL,ACCOUNT_NUM";
const ENTITY_LAYERS = [["2026", "economy_tax_entities_2026"], ["2025", "economy_tax_entities_2025"]];
const GEOCODE_URL = "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates";

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function geocode(line) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(GEOCODE_URL, {
      method: "POST", signal: ctl.signal,
      body: new URLSearchParams({ SingleLine: line, OutFields: "Addr_type", MaxLocations: "3", countryCode: "USA", f: "json" })
    }).then((x) => x.json());
    return r.candidates || [];
  } catch { return []; } finally { clearTimeout(t); }
}

const usable = (fs) => (fs || []).filter((f) => { const a = L.attrs(f); return a.PARCEL_ID || a.PARCEL_ADD; });

/* The app's box growth: ~22 m, ~90 m, ~330 m, and only parcels we can actually name. */
async function parcelsNear(pt, radii = [0.0002, 0.0008, 0.003]) {
  for (const r of radii) {
    const box = `${pt[0] - r},${pt[1] - r},${pt[0] + r},${pt[1] + r}`;
    let fs = [];
    try {
      fs = await query(PARCELS, {
        geometry: box, geometryType: "esriGeometryEnvelope", inSR: "4326", spatialRel: "esriSpatialRelIntersects",
        outFields: APP_FIELDS, returnGeometry: "true", outSR: "4326", resultRecordCount: "12"
      });
    } catch { /* one bad box is not a failed lookup */ }
    if (usable(fs).length) return usable(fs);
  }
  return [];
}

/* Recorded-address fallback: box around the point first (the address column is not indexed,
   the spatial one is), growing to a statewide scan only if the boxes come back empty. */
async function parcelsByWhere(where, pt) {
  if (!where) return [];
  for (const r of (pt ? [0.02, 0.25] : [null])) {
    const params = { where, outFields: APP_FIELDS, returnGeometry: "true", outSR: "4326", resultRecordCount: "25", orderByFields: "PARCEL_ADD" };
    if (r != null) Object.assign(params, {
      geometry: `${pt[0] - r},${pt[1] - r},${pt[0] + r},${pt[1] + r}`,
      geometryType: "esriGeometryEnvelope", inSR: "4326", spatialRel: "esriSpatialRelIntersects"
    });
    let fs = [];
    try { fs = await query(PARCELS, params); } catch { /* keep growing */ }
    if (fs.length) return fs;
  }
  return [];
}

/* From the shipped page: a parcel-number hit is stronger evidence than any address text. */
export function idMatches(raw, pid) {
  const canon = (v) => String(v == null ? "" : v).toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/^0+(?=\d)/, "");
  const a = canon(raw), b = canon(pid);
  return !!a && !!b && (a === b || (a.length >= 6 && (b.indexOf(a) === 0 || a.indexOf(b) === 0)));
}

function parcelsById(raw) {
  const attempt = (mode) => query(PARCELS, {
    where: L.buildParcelIdWhere(raw, mode), outFields: APP_FIELDS,
    returnGeometry: "true", outSR: "4326", resultRecordCount: "20"
  });
  return attempt("exact").then((fs) => fs.length ? fs : attempt("prefix"));
}

/* The app's findParcel(), step for step, in promise form. */
async function findParcel(input) {
  if (L.looksLikeParcelId(input)) {
    const fs = await parcelsById(input);
    const ranked = L.rankParcels(fs, null, null);
    ranked.forEach((r) => { if (idMatches(input, r.c.PARCEL_ID)) { r.bucket = 2; r.a = 1; r.s += 1e6; } });
    return { ranked, how: "parcel number", point: null };
  }
  const parsed = L.parseAddress(input);
  if (!parsed.house) throw new ApiError(400, "Include the house or lot number, for example 810 S 900 E, Salt Lake City — or send a parcel number.");
  const line = /\butah\b|,\s*ut\b/i.test(input) ? input : input + ", Utah, USA";
  let best = null;
  const picks = L.rankGeocodeCandidates({ candidates: await geocode(line) }, parsed).slice(0, 2);
  for (const c of picks) {
    const ranked = L.rankParcels(await parcelsNear([c.x, c.y]), parsed, [c.x, c.y]);
    if (ranked.length && (!best || ranked[0].s > best.ranked[0].s)) best = { ranked, how: "geocoded location", point: [c.x, c.y] };
    if (best && best.ranked[0].bucket === 2) break; // exact address match: no more questions
  }
  if (best && best.ranked[0].bucket === 2) return best;
  const point = best ? best.point : null;
  try {
    const byAddr = L.rankParcels(await parcelsByWhere(L.buildAddressWhere(parsed), point), parsed, point);
    if (byAddr.length && (!best || byAddr[0].s > best.ranked[0].s)) return { ranked: byAddr, how: "recorded address", point };
  } catch { /* the geocoded result stands */ }
  if (best) return best;
  throw new ApiError(404, "No parcel matched that address in the state parcel layer. Try adding the city or ZIP, or send the parcel number.");
}

/* The rate layers, newest first; an unpublished year answers HTTP 200 with an error body,
   which query() turns into a throw, so the fallback is a plain loop. */
async function entitiesAt(pt) {
  const base = {
    geometry: pt.join(","), geometryType: "esriGeometryPoint", inSR: "4326",
    spatialRel: "esriSpatialRelIntersects", outFields: "ENT_YR,ENT_CO,ENT_NBR,ENT_DESC,ENT_RATE", returnGeometry: "false"
  };
  let last = null;
  for (const [year, svc] of ENTITY_LAYERS) {
    try {
      const fs = await query(svc, base);
      const s = L.summarizeEntities(fs.map((f) => f.attributes));
      if (s.rows.length) return Object.assign(s, { service: svc, label: year });
    } catch (e) { last = e; }
  }
  throw new ApiError(502, "No tax entity service answered for this parcel" + (last ? ` (${String(last.message).slice(0, 80)})` : "") + ".");
}

/* The county's own record: market value, class, recorded occupancy, as-of date. outFields=*
   because naming one column a county layer lacks fails the whole request. */
async function parcelDetail(parcel) {
  if (!parcel.County || !parcel.PARCEL_ID) return null;
  const svc = "Parcels_" + L.countyKey(parcel.County) + "_LIR";
  const pid = String(parcel.PARCEL_ID);
  try {
    const fs = await query(svc, {
      where: `PARCEL_ID = ${JSON.stringify(pid.toUpperCase()).replace(/"/g, "'")} OR PARCEL_ID = ${JSON.stringify(pid).replace(/"/g, "'")}`,
      outFields: "*", returnGeometry: "false", resultRecordCount: "2"
    });
    const a = fs.length ? L.attrs(fs[0]) : null;
    return a && (a.TOTAL_MKT_VALUE || a.PARCEL_ACRES || a.PROP_CLASS) ? a : null;
  } catch { return null; } // detail is enrichment, never a failed estimate
}

const isoDay = (ms) => { const n = Number(ms); return isFinite(n) && n > 0 ? new Date(n).toISOString().slice(0, 10) : null; };
const round2 = (x) => Math.round(Number(x) * 100) / 100;

function scenarioJson(s) {
  return {
    basis: s.basis, market_value: Math.round(s.value), taxable_share: s.share,
    taxable_value: Math.round(s.taxable), combined_rate: s.rate, per_1000: round2(s.perThousand),
    annual: round2(s.annual), monthly: round2(s.monthly),
    value_source: s.basis === "county" ? "county recorded market value" : "typed purchase price"
  };
}

/* Query params, parsed and validated once, so the server and the tests share the rules. */
export function parseParams(input) {
  const address = String(input.address || "").trim();
  if (!address) throw new ApiError(400, "Send ?address= a street address or parcel number.");
  return {
    address,
    price: L.parsePrice(input.price == null ? "" : String(input.price)),
    primary: !(input.primary === "false" || input.primary === "0" || input.primary === "other" || input.primary === "second"),
    parsed: L.parseAddress(address)
  };
}

/* Everything the API returns, built only from data a caller can fabricate. Pure on purpose:
   the response shape is unit-tested without touching the network. */
export function shapeResult({ input, found, ent, detail }) {
  const top = (found.ranked || [])[0];
  if (!top) throw new ApiError(404, "No parcel matched that address in the state parcel layer.");
  const c = top.c;
  const rings = top.rings || c._rings;
  if (!rings || !rings.length) throw new ApiError(502, "The matched parcel has no boundary in the state file, so its districts cannot be read.");
  const address = input.address, price = input.price || 0, primary = input.primary;
  const countyValue = Number(detail && detail.TOTAL_MKT_VALUE) || 0;
  const set = L.estimateSet({ price: price || 0, countyValue, primary, rate: ent.total });
  const t = set.preferred;
  if (!t) throw new ApiError(400, "Send ?price= (or a county value would be needed) — there is no value to tax yet.");
  const sig = L.parcelSignals(detail);

  const exact = top.bucket === 2;
  const near = top.inside || (top.m != null && top.m <= 40);
  /* The typed city/ZIP is evidence: "15 N Main St" exists in a dozen towns, and the recorded-address
     fallback searches statewide, so an exact street string can still name the wrong town. */
  const place = L.placeCheck(input.parsed || L.parseAddress(address), c);
  const quality = exact ? "exact" : near ? "nearest" : "approximate";
  const note = exact ? null
    : `No parcel in the state file carries exactly “${address}”. This is ${c.PARCEL_ADD ? `the parcel recorded as ${c.PARCEL_ADD}` : "the nearest parcel on record"}` +
      `${top.inside ? ", covering the spot the address geocoded to" : top.m != null ? `, about ${Math.round(top.m)} m from the spot the address geocoded to` : ""}. Confirm the parcel number on the tax notice or title report.`;
  const ambiguous = !exact && found.ranked.length > 1 && top.a >= L.MAYBE_MIN;
  const typedCity = (input.parsed && input.parsed.city) || null;
  const typedZip = (input.parsed && input.parsed.zip) || null;

  const warns = L.parcelClassWarnings(sig, { selectedPrimary: primary }).concat(ent.warnings);
  if (primary && Number(detail && detail.PARCEL_ACRES) > 1) {
    warns.push(`This lot is ${Number(detail.PARCEL_ACRES).toFixed(2)} acres. The primary residence exemption covers the home and up to one acre, so the estimate runs slightly low.`);
  }
  const split = L.splitNotes(warns);
  const paying = ent.rows.filter((r) => r.rate > 0);

  return {
    query: { address, price: price, primary },
    parcel: {
      id: c.PARCEL_ID, county: L.countyLabel(c.County || "") || c.County || null,
      recorded_address: c.PARCEL_ADD || null, city: c.PARCEL_CITY || null, zip: c.PARCEL_ZIP || null,
      acres: Number(detail && detail.PARCEL_ACRES) || null,
      county_link: c.CoParcel_URL || null
    },
    match: {
      how: found.how, quality,
      note: [place.ok ? null : place.note, note].filter(Boolean).join(" ") || null,
      city_check: { typed_city: typedCity, parcel_city: c.PARCEL_CITY || null, typed_zip: typedZip, parcel_zip: c.PARCEL_ZIP || null, ok: place.ok },
      geocoded: found.point ? { lon: +found.point[0].toFixed(6), lat: +found.point[1].toFixed(6) } : null,
      needs_review: !exact || !place.ok,
      ambiguous,
      candidates: ambiguous ? found.ranked.slice(0, 8).map((r) => ({
        parcel_id: r.c.PARCEL_ID, recorded_address: r.c.PARCEL_ADD || null, city: r.c.PARCEL_CITY || null,
        similarity: +Number(r.a).toFixed(2), distance_m: r.m != null ? Math.round(r.m) : null
      })) : []
    },
    county_record: detail ? {
      market_value: countyValue || null, prop_class: sig.klass || null,
      primary_res: sig.primaryRes || null, tax_exempt_type: sig.exempt || null,
      value_as_of: isoDay(detail.CURRENT_ASOF)
    } : { market_value: null, note: "this county publishes no value on the parcel record" },
    estimate: Object.assign(scenarioJson(t), { rate_year: ent.year || null, equation: L.equationStrip(t) }),
    comparison: set.comparison ? Object.assign(scenarioJson(set.comparison), { rate_year: ent.year || null }) : null,
    difference: set.diff ? { annual: round2(set.diff.annual), monthly: round2(set.diff.monthly), pct: + (set.diff.pct * 100).toFixed(1) } : null,
    entities: ent.rows.map((r) => ({
      name: r.name, kind: r.kind, county: r.county || null, rate: r.rate,
      annual: t ? round2(t.taxable * r.rate) : null, monthly: t ? round2(t.taxable * r.rate / 12) : null
    })),
    levy_summary: { bodies: ent.rows.length, levying: paying.length, total_rate: ent.total },
    warnings: { top: split.top, fine: split.fine },
    notes: L.estimateNotes(t, { countyValueMissing: !countyValue }),
    sources: {
      parcels: ARCGIS + PARCELS + "/FeatureServer/0",
      entities: ARCGIS + ent.service + "/FeatureServer/0",
      county_record: detail ? ARCGIS + "Parcels_" + L.countyKey(c.County || "") + "_LIR/FeatureServer/0" : null,
      rates_checked_against: "Utah State Tax Commission Report 600 (certified and adopted rates by tax area)"
    },
    disclaimer: "Estimate only, not a tax bill or legal determination. Excludes special assessments, service charges, delinquencies and relief programs."
  };
}

/* One full estimate: the network steps in sequence, then the pure shaping above. */
export async function estimate(input) {
  const q = parseParams(input);
  const found = await findParcel(q.address);
  const top = (found.ranked || [])[0];
  if (!top) throw new ApiError(404, "No parcel matched that address in the state parcel layer.");
  const rings = top.rings || top.c._rings;
  if (!rings || !rings.length) throw new ApiError(502, "The matched parcel has no boundary in the state file, so its districts cannot be read.");
  const ent = await entitiesAt(L.interiorPoint(rings));
  const detail = await parcelDetail(top.c);
  return shapeResult({ input: q, found, ent, detail });
}
