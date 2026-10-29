// Shared ArcGIS helper for the live smoke tests.
export const ARCGIS = "https://services1.arcgis.com/99lidPhWCzftIe9K/ArcGIS/rest/services/";

export async function query(service, params, { tries = 3 } = {}) {
  const qs = new URLSearchParams(Object.assign({ f: "json" }, params));
  const url = ARCGIS + service + "/FeatureServer/0/query?" + qs.toString();
  let lastErr;
  for (let t = 0; t < tries; t++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": "taxEstimator-smoke/1.0" } });
      const text = await r.text();
      let j;
      try { j = JSON.parse(text); } catch (e) { throw new Error("non-JSON (" + r.status + "): " + text.slice(0, 120)); }
      if (j.error) throw new Error((j.error.message || "service error") + " " + JSON.stringify(j.error.details || []));
      return j.features || [];
    } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 400 * (t + 1))); }
  }
  throw lastErr;
}

export const P = (o) => JSON.stringify(o);
