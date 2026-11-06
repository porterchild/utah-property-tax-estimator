# Utah Property Tax Estimator

A single-file web app that estimates the monthly property tax on a home you are buying,
anywhere in Utah. You give it a street address (or a parcel number); it finds the parcel
in the statewide UGRC parcel layer, reads every taxing entity that covers it, sums the
State Tax Commission's adopted rates, and applies them to the county assessor's recorded
market value — falling back to your purchase price where the county publishes none.

The panel shows the whole equation and says where every term came from: which value it
used, the 55% primary-residence exemption (or 100% for a second home), the combined rate,
the rate year, and what the figure leaves out (assessments, service charges, delinquencies,
relief programs).

## Run it

Open `utah-property-tax-estimator.html` in a browser, or serve it:

```
node tools/serve.mjs 5123        # http://localhost:5123
```

There is no build step and no key: the page talks directly to Utah's public services
(`services1.arcgis.com`, `geocode.arcgis.com`). Lookups need internet access from the browser.

## JSON API

The server exposes the same pipeline as JSON, with permissive CORS, so spreadsheets and
grouping tools can call it directly:

```
curl "http://localhost:5123/api/estimate?address=500 W Center St, Provo&price=605000"
curl "http://localhost:5123/api/estimate?address=08221800110000&primary=false"
curl "http://localhost:5123/api"          # self-describing endpoint index
```

Params: `address` (street address or parcel number, required), `price` (optional),
`primary` (`true` default, `false` for a second home / rental).

The response carries the parcel, the match quality (`exact` / `nearest` / `approximate`,
with `needs_review`, an explanatory `note`, and `candidates` when several parcels plausibly
match one address; a city or ZIP that disagrees with the parcel record sets `needs_review`
even when the street matched exactly — `match.city_check` carries both sides), the county's own record (market value, class, recorded occupancy,
as-of date), the estimate with every equation term, per-entity rates, warnings and notes.
Errors: `400` bad input, `404` no parcel matched, `502` upstream service trouble.
Each call is a handful of live Utah-service requests (a few seconds); keep batch sizes sane.

`node tools/smoke-api.mjs` runs the API cases live against an ephemeral server.

## Verify it

```
node --test tests/logic.test.mjs     # 42 unit tests over the page's own logic
node tools/smoke-live.mjs            # 12 live lookups through the shipped page
node tools/smoke-api.mjs             # 9 live JSON API cases
node tools/validate-match.mjs        # identity integrity: right parcel, never a silent wrong town
node tools/validate-match.mjs --quick   # 30-second version of the above
node tools/validate-taxdistrict.mjs /tmp/r600-2025.json 2   # rates vs Report 600
```

The test harness runs the shipped HTML's scripts against a DOM stand-in and the live
state services, so what the tests see is what ships. `PLAN.md` documents the data
sources, validation results (84/92 parcels matched Report 600's rate for the tax district
recorded on the parcel itself) and the open gaps.

## Status

Estimate only — not a tax bill or a legal determination. Parcel and rate data is fetched
live from State of Utah services on every lookup.
