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

## Verify it

```
node --test tests/logic.test.mjs     # 33 unit tests over the page's own logic
node tools/smoke-live.mjs            # 11 live lookups through the shipped page
node tools/validate-taxdistrict.mjs /tmp/r600-2025.json 2   # rates vs Report 600
```

The test harness runs the shipped HTML's scripts against a DOM stand-in and the live
state services, so what the tests see is what ships. `PLAN.md` documents the data
sources, validation results (84/92 parcels matched Report 600's rate for the tax district
recorded on the parcel itself) and the open gaps.

## Status

Estimate only — not a tax bill or a legal determination. Parcel and rate data is fetched
live from State of Utah services on every lookup.
