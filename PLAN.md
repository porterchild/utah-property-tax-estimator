# Utah Property Tax Estimator: Plan and Handoff

Status as of 2026-10-21 (place-check pass): `utah-property-tax-estimator.html` is a working **statewide** draft, with a JSON API on the same logic (§12). Address and parcel-number lookups run against live Utah services, 44 unit tests pass, 12 live smoke lookups produce sane panels, and a typed city or ZIP that disagrees with the parcel record always comes back flagged for review (§12), and the rate sum matches the Tax Commission's Report 600 both for sampled points (§10) and, parcel by parcel, against the tax district the county recorded on the parcel itself — 84 of 92 exact (§12). The result panel now spells out every term of the equation and says whether the figure rests on the county assessor's value or the typed price (§12). The remaining gaps are the ones listed in §6.

## 1. Goal

A fast tool for **mortgage brokers** that returns the **estimated monthly property tax** for a Utah purchase.

- **Inputs:** property address (or parcel/serial number), purchase price, occupancy (primary residence vs. not).
- **Output:** monthly tax, which brokers paste into their own payment spreadsheet. Annual tax, taxable value, combined rate, rate year, matched parcel, and a per-entity breakdown are shown alongside it.
- **Not in scope:** full PITI. Brokers' spreadsheets already handle principal and interest, insurance, PMI/MIP and HOA.
- **Must include:** a collapsible "How this estimate works" explainer, so the estimate isn't a black box.

## 2. Key decisions (made with the user)

| Decision | Choice | Why |
|---|---|---|
| Estimate vs. exact current bill | **Estimate (Option A)** | The current bill reflects the *seller's* occupancy, the stale assessed value and the seller's personal exemptions. An estimate from the buyer's price and occupancy predicts the *buyer's* tax better. An exact bill would mean scraping 29 county treasurer sites. |
| Value used | **Purchase price, entered by the broker** | Brokers have already settled on the price. The assessor's value lags the sale, and the parcel layer's value field is incomplete in some counties. |
| Occupancy | **Toggle: primary vs. other** | A primary residence is taxed on 55% of value; anything else on 100%. That's close to a 2× difference, and it maps to loan occupancy type. |
| Rollout | **Start with the 3 largest counties** (Salt Lake, Utah, Davis), then expand | Requested by the user. The rate data is already statewide; only the parcel/address lookup is per county. |
| Delivery | **One self-contained HTML file** | A claude.ai published artifact can't be used: its sandbox blocks every outside fetch, so it can't reach the state ArcGIS services. Host the file anywhere (static hosting, a company site), or open it locally. |

### Possible later addition
Show the seller's **last billed amount** as a reference where easy to get. Some lenders and title companies use the title report's current bill for initial escrow. This needs per-county treasurer scraping, so it isn't in v1.

## 3. Assumptions

1. **Formula:** `monthly = price × (primary ? 0.55 : 1.00) × combined_rate ÷ 12`.
2. **Residential exemption:** 45% of fair market value for primary residential property, covering the home and up to **one acre** of land per unit (Utah Code 59-2-103). Land beyond one acre is taxed at 100%, so the tool under-estimates on large lots and **flags lots over 1 acre** using `PARCEL_ACRES`.
3. **Combined rate:** the sum of `ENT_RATE` for every tax entity polygon containing a point inside the parcel. Utah rates are decimals of taxable value (0.009240 = 0.924%).
4. **Zero-rate entities:** redevelopment, community development and community reinvestment areas (RDA/CDA/CRA) appear with rate 0. They redirect tax increment and don't add tax for the owner. Listed, but they don't change the total.
5. **Rate year:** use the newest year with populated rates. The page tries `economy_tax_entities_2026` first, then falls back to `_2025`. Rates for a year are finalized in the fall, after truth-in-taxation hearings.
6. **Excluded:** special assessments (SAA/SID), city fees billed on the notice (stormwater, lighting), personal exemptions (veteran, blind, active duty, circuit breaker), delinquencies and greenbelt rollback.
7. **Inexact boundaries:** the state says its tax entity boundaries are **not exact legal boundaries**. The tool warns if a point hits more than one city or school district, or if no county or school levy is found.
8. **Point selection:** use a point **inside the parcel polygon**, not a street-centerline geocode. A geocoded point on the street can fall in the wrong district at a boundary.

## 4. Architecture (as built)

All in the browser, no API keys. Two hosts: `services1.arcgis.com` (UGRC layers, CORS enabled) and `geocode.arcgis.com` (ESRI World Geocoder).

1. **Parse input** (`parseAddress`). Either a parcel/serial number, or an address split into house number, directionals, street tokens, unit and city. Utah grid addresses look like `810 S 900 E #304`. SOUTH→S, STREET→ST, but `CENTER` is **not** shortened to `CTR` (parcel records write `CENTER ST`), and unit prefixes are matched on word boundaries only (otherwise `NORTH` reads as unit `NO` + street `RTH`).
2. **Find the parcel** in `UtahStatewideParcels` (all 29 counties, 1.6M rows):
   - Parcel number path: `PARCEL_ID = …` exactly, then a prefix form that tolerates dashes/colons and leading zeros.
   - Address path: geocode → keep only candidates that are Utah street addresses for the house number asked (`rankGeocodeCandidates`) → query parcels in a box around the best point, growing the box (~22 m, ~90 m, ~330 m) until it holds a parcel with an ID or an address. A second geocoded point is asked only when the first turned up nothing at all — at these latencies each extra question costs seconds.
   - Recorded-address fallback: `UPPER(PARCEL_ADD) LIKE '810 %' AND (… '% 900 %' …)`. Always spatially boxed (~2 km, then ~27 km) around the geocoded point first; an unboxed LIKE over 1.6M rows takes ~16 s, while the spatial filter uses the index.
   - Ranking (`rankParcels`) is multiplicative and address-first: exact house number, then street tokens, then directionals, then unit; distance only breaks ties inside an address bucket. Street/right-of-way and government parcels lose a bare "nearest parcel" tie (an address that really matches still wins).
   - Auto-select only a clear winner: a recorded-address match (`a ≥ 0.75`) with no runner-up also matching, **or** a parcel covering / within 25 m of the geocoded point when nothing in the list carries address signal. Anything looser goes to a picker — including a lone candidate that neither matches the typed address nor covers the point. Two plausible parcels (e.g. `809` vs `811 S 900 E`, or a duplex) always go to the picker. When nothing carries the typed address the picker says exactly that rather than implying a match; when the app does take the parcel covering the geocoded point it **says so**, with the distance and the recorded address.
3. **Find an interior point** of the chosen parcel's polygon and use **that** point for entity lookup, never the street geocode.
4. **Query tax entities** (`esriGeometryPoint` intersect): try `economy_tax_entities_2026`, then `_2025`; remember the service that answered in `localStorage` so a missing year isn't re-tried on every click. Dedupe by `ENT_CO|ENT_NBR`, sum `ENT_RATE`, classify by description keywords first and `ENT_NBR` ranges second.
5. **Optional county enrichment**: one extra request to `Parcels_<County>_LIR` for `TOTAL_MKT_VALUE` / `PARCEL_ACRES`, shown as "county market value on record". Failure is ignored; nothing depends on it.
6. **Compute and render**: monthly tax, annual tax, taxable value, combined rate, rate year, entity count, the parcel line (county · parcel · account, acres, county link), warnings, the per-entity table, the live formula, and the copy button.

The pure logic lives in `<script id="logic">`. `tools/logic-loader.mjs` pulls that exact block out of the shipped HTML, so `node --test tests/logic.test.mjs` and the live harnesses test what the page actually runs (it does not use `module.exports`; the loader wraps the block and exports its top-level names).

## 5. Data sources and research

### 5.1 Used by the tool
- **Statewide parcel polygons** (the lookup anchor; covers all 29 counties). 1,599,208 rows, polygons, fields `PARCEL_ID, PARCEL_ADD, PARCEL_CITY, PARCEL_ZIP, OWN_TYPE, RECORDER, ParcelsCur, ParcelNotes, County, CoParcel_URL, ACCOUNT_NUM`. `County` is CamelCase (`SaltLake`, `BoxElder`, `Tooele`), which is what the per-county service names need.
  https://services1.arcgis.com/99lidPhWCzftIe9K/ArcGIS/rest/services/UtahStatewideParcels/FeatureServer/0
  Caveats found: `PARCEL_ADD` can be null (Park City condos, right-of-way), `PARCEL_CITY` is unreliable, units are stored as `APT 204` / `STE 701`, and identical recorded addresses appear on more than one parcel (duplexes, condos, duplicated records).
- **ESRI World Geocoder** (address → point). No token needed today; `MaxLocations=3`, `countryCode=USA`. It corrects misspellings (`Kearny Blvd` → `Kearns Blvd`) but also answers with foreign countries for Utah-sounding names, so candidates are filtered hard. The UGRC geocoder (`ge-api.ugrc.utah.gov`, `geocode.utah.gov`) was unreachable from the build environment; if it is reachable from the deployed host it is a drop-in improvement, since it returns the parsed address parts the app already builds itself.
  https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates
- **Tax entities with rates (statewide, tax year 2025).** Fields: `ENT_ID, ENT_YR, ENT_CO, ENT_NBR, ENT_DESC, ENT_CODE, ENT_RATE`.
  https://services1.arcgis.com/99lidPhWCzftIe9K/ArcGIS/rest/services/economy_tax_entities_2025/FeatureServer/0
  Product page: https://gis.utah.gov/products/sgid/economy/tax-entities/ (last updated October 2025). Open data: https://opendata.gis.utah.gov/datasets/utah-tax-entities-2025/about
  `ENT_NBR` ranges, per the product page: 1010 = county, 2000s = school districts, 3000s = cities and towns, 8000–9000 = RDA/CDA areas. The 4000–7000 special district ranges are **inferred**, so verify them.
- **County tax parcel layers (LIR, "Land Information Records").** Fields used: `PARCEL_ID, SERIAL_NUM, PARCEL_ADD, PARCEL_CITY, COUNTY_NAME, PARCEL_ACRES, PROP_CLASS, TOTAL_MKT_VALUE`. Other fields include `PRIMARY_RES, TAX_DISTRICT, LAND_MKT_VALUE, CURRENT_ASOF, ASSESSOR_SRC, BOUNDARY_SRC`. The layers are polygons in Web Mercator (3857), with a 2,000-record maximum per request.
  Schema reference: https://services1.arcgis.com/99lidPhWCzftIe9K/ArcGIS/rest/services/Parcels_Utah_LIR/FeatureServer/0
  **Naming trap:** `Parcels_Utah_LIR` is **Utah County**, not statewide. An earlier note in the chat misread it as statewide.
  Cadastre index: https://gis.utah.gov/data/sgid-cadastre/ (contact listed in the layer metadata: UGRC Cadastral Manager).

### 5.2 Considered and set aside
- **Tax Areas** (one polygon per tax area with a combined `Rate`). `TaxAreas2024` is 2023/2024-vintage and its `Rate` field was empty for the sampled points; too stale for runtime display. It is still a useful cross-check of which tax area a parcel sits in.
  https://services1.arcgis.com/99lidPhWCzftIe9K/ArcGIS/rest/services/TaxAreas2024/FeatureServer/0 · product page: https://gis.utah.gov/products/sgid/economy/taxing-areas/ · older: `TaxAreas2022`, `TaxEntities2024`, `TaxEntities2021` in the same folder. `TaxEntities2024` was kept as the validation year (§10).
- **State Tax Commission Report 600, "Tax Rates by Tax Area"** (PDF, ~476 pages). The authoritative rate list, and what the app's sums are validated against. `propertytax.utah.gov` paths now redirect or 403; the PDFs are served from `files.tax.utah.gov`: `https://files.tax.utah.gov/propertytax/tax-rates/area-rates/taxarearates2025.pdf` (and `…2024.pdf`). `tools/report600.mjs` parses it into `COUNTY|areaID|sub` → per-entity certified/proposed/adopted rates plus area totals; see §10.
- **Certified Tax Rate system:** https://taxrates.utah.gov (entity-level certified and proposed rates). Guide: https://propertytax.utah.gov/tax-rates/ctr-guide.pdf. Annual data calendar: https://files.tax.utah.gov/propertytax/tax-rates/data-collection.pdf
- **State Auditor Property Values Tool:** https://propertyvalues.utah.gov. Look up an address for assessed values, but not tax. Release: https://auditor.at.utah.gov/wp-content/uploads/2024/08/News-Release-Office-of-the-State-Auditor-Updates-Property-Valuation-Tool.pdf
- **Commercial sources** (PropertyShark, AssessorSearch, propertytaxbyzip): paid or median-level figures; not used.
- **County treasurer sites** have the exact bill, but each county runs a different system. Examples found: Wasatch https://wasatchcounty.gov/property-tax-online-lookup-service · Utah County https://www.utahcounty.gov/LandRecords/TaxForm.asp · Uintah https://www.uintah.gov/departments/q_-_z_departments/treasurer/pay_taxes.php. Each LIR layer's `ASSESSOR_SRC` field gives that county's assessor URL.
- **Overviews confirming there's no statewide lookup:** https://propertytaxusa.org/utah-property-tax/

### 5.3 Verified facts
- The user ran this query in a browser and got 10 entities, all `ENT_YR = 2025`, summing to **0.009240**:
  `…/economy_tax_entities_2025/FeatureServer/0/query?where=1%3D1&geometry=-111.891,40.760&geometryType=esriGeometryPoint&inSR=4326&outFields=ENT_YR,ENT_DESC,ENT_RATE&returnGeometry=false&f=pjson`
  The point is in downtown Salt Lake City. Entities: Salt Lake County 0.001253, SLC School District 0.003767, Salt Lake City 0.003180, Central Utah Water 0.000400, SL Metro Water 0.000327, SLC Mosquito Abatement 0.000163, County Assessing & Collecting 0.000136, Multicounty Assessing & Collecting 0.000014, Salt Lake Library 0, State Street CRA 0.
- At a $550,000 primary residence, that gives $232.93/month; non-primary gives $423.50/month.

## 6. What's verified vs. not

| Item | Status |
|---|---|
| Entity layer has populated 2025 rates | ✅ Verified (Salt Lake City point) |
| Entity sum = Report 600 **final adopted** area rate | ✅ 2025: exact on 73/75 sampled points; `TaxEntities2024`: exact on 75/75 (§10). So `ENT_RATE` is the final-adopted rate, not auditor-certified |
| Pure logic (parsing, ranking, interior point, sums, math, equation terms) | ✅ 30 node tests pass (`node --test tests/logic.test.mjs`) |
| Parcel's **own** `TAX_DISTRICT` vs Report 600 area rate | ✅ 84 of 92 sampled residential parcels in 23 counties sum to exactly the published rate for the district the county recorded on the parcel; 4 districts have several sub-areas, 4 differ (Duchesne 4: +0.000228, Cache 106: −0.000046), 4 have no Report 600 row (§12) |
| County-published market value reaches the panel | ✅ `tools/lir-fields.mjs` documents what each county layer publishes; the detail query now asks `outFields=*` because naming one absent field (`TAXABLE_VALUE`) made ArcGIS reject the whole request, so no county value ever loaded before (§12) |
| Page compiles and is free of stray control characters | ✅ `node tools/check-scripts.mjs` |
| Live lookups through the shipped page | ✅ 11/11 smoke cases produce a sane panel, and the location-based ones print their confirmation note (`node tools/smoke-live.mjs`) |
| Recorded address → same parcel back | ✅ 21/24 (88%) over 8 counties, and 11/12 (92%) on the re-run after the corner-swap fix; both runs' only misses are parcels that share an address with another record, or unit lines filed under a parent parcel (§10) |
| Coverage beyond Salt Lake / Utah / Davis | ✅ Statewide via `UtahStatewideParcels`; tested lookups returned parcels in Weber, Washington, Cache, Tooele, Summit, Davis, Salt Lake, Utah |
| `economy_tax_entities_2026` exists or has rates | ❌ Not published: the service answers HTTP 200 with an ArcGIS `Invalid URL` body, so the page falls back to 2025 (and remembers the service that worked) |
| `PARCEL_ADD` format quirks per county | ⚠️ Partially known (§10). Blank addresses and duplicate addresses are handled by ranking + a picker, not by guessing |
| `ENT_NBR` values for assessing levies and special districts | ⚠️ Seen only in the SLC example and in Report 600 rows; classification is keyword-first |
| Does the school district rate include the state basic levy? | ⚠️ Indirectly yes: the whole sum equals Report 600's area total, which includes the education base levies |
| End-to-end tax **dollars** against a real bill | ❌ Still open. The Utah County treasurer summary works (`TaxSummary.asp?av_serial=458660128`, and it names `Tax Area 110 - PROVO CITY`) but that parcel bills `$0.00`. Need a nonzero residential parcel, or a county portal exposing tax area/value/rate |
| UGRC geocoder as the primary geocoder | ❌ Unreachable from this environment (`curl` status 000), so ESRI World Geocoder is used |

## 7. Next steps for the coding agent

Done since the last handoff: live smoke tests (§10), Report 600 validation, statewide lookup path, geocoder fallback, all 29 counties in scope.

1. **Finish the dollar validation.** One nonzero residential bill, checked against the tool's monthly figure, is the only remaining correctness question that data alone can't answer. Salt Lake County's assessor/treasurer hosts are unreachable from this environment (`000`) and Utah County's is a JS-only Next.js app, so the bill has to come from a browser session or a county that publishes tax detail as data. The per-parcel *rate* check (§12) now covers everything except the arithmetic a bill performs on the county's own taxable value.
2. **Widen the validation runs.** `node tools/validate-lookup.mjs <perCounty> "<counties>"` is the mirror of the app's lookup; run it over more counties (especially the rural 21) and record exact-match rates per county.
3. **Re-check `economy_tax_entities_2026`** in the fall, after truth-in-taxation. Nothing to change in the code — the page tries it first and the year label comes from `ENT_YR`.
4. **Watch the two open UI behaviours**: the picker shown when two parcels share one recorded address, and "nearest parcel" auto-selection, which must keep printing the confirmation note.
5. ~~Choose hosting~~ The JSON endpoint exists: `tools/serve.mjs` now answers `/api/estimate?address=…&price=…&primary=…` (and a self-describing `/api`) by running the same pipeline server-side through `tools/pipeline.mjs` (§12). A server-side version is also the place to add a keyed UGRC geocoder later.
6. Optional: report the app's own misses. The two known miss shapes (duplicate recorded addresses, and an address that exists only as a neighbour) are invisible to us today.

## 8. All 29 counties: parcel layers

Base URL: `https://services1.arcgis.com/99lidPhWCzftIe9K/ArcGIS/rest/services/<Layer>/FeatureServer/0`

County IDs are numbered alphabetically (Beaver = 1 … Weber = 29), per the LIR schema notes. The full numbering is inferred from that pattern, so confirm it with `COUNTY_ID`.

| # | County | LIR layer | In v1 |
|---|---|---|---|
| 1 | Beaver | Parcels_Beaver_LIR | |
| 2 | Box Elder | Parcels_BoxElder_LIR | |
| 3 | Cache | Parcels_Cache_LIR | |
| 4 | Carbon | Parcels_Carbon_LIR | |
| 5 | Daggett | Parcels_Daggett_LIR | |
| 6 | Davis | Parcels_Davis_LIR | ✅ |
| 7 | Duchesne | Parcels_Duchesne_LIR | |
| 8 | Emery | Parcels_Emery_LIR | |
| 9 | Garfield | Parcels_Garfield_LIR | |
| 10 | Grand | Parcels_Grand_LIR | |
| 11 | Iron | Parcels_Iron_LIR | |
| 12 | Juab | Parcels_Juab_LIR | |
| 13 | Kane | Parcels_Kane_LIR | |
| 14 | Millard | Parcels_Millard_LIR | |
| 15 | Morgan | Parcels_Morgan_LIR | |
| 16 | Piute | Parcels_Piute_LIR | |
| 17 | Rich | Parcels_Rich_LIR | |
| 18 | Salt Lake | Parcels_SaltLake_LIR | ✅ |
| 19 | San Juan | Parcels_SanJuan_LIR | |
| 20 | Sanpete | Parcels_Sanpete_LIR | |
| 21 | Sevier | Parcels_Sevier_LIR | |
| 22 | Summit | Parcels_Summit_LIR | |
| 23 | Tooele | Parcels_Tooele_LIR | |
| 24 | Uintah | Parcels_Uintah_LIR | |
| 25 | Utah | Parcels_Utah_LIR | ✅ |
| 26 | Wasatch | Parcels_Wasatch_LIR | |
| 27 | Washington | Parcels_Washington_LIR | |
| 28 | Wayne | Parcels_Wayne_LIR | |
| 29 | Weber | Parcels_Weber_LIR | |

Each county also has a basic (non-LIR) `Parcels_<County>` layer with the boundary, ID and address only. The app does not use the per-county LIR layers for lookup: it looks every parcel up in `UtahStatewideParcels` (§5.1), which covers all 29 rows of this table, and only touches `Parcels_<County>_LIR` for the optional value/acreage line. County values in that layer (`SaltLake`, `BoxElder`, `Tooele`) map straight onto these service names, which is why `countyKey()` preserves the CamelCase instead of lower-casing the first letter.

LIR value coverage (share of rows with a non-null `TOTAL_MKT_VALUE` / `PARCEL_ACRES`), which is why those fields stay optional: Utah 79%/91%, Salt Lake 99%/99%, Weber 92%/99%, Washington 90%/87%, Cache 92%/96%, Davis 53%/57%.

## 9. Tools in this repo

| Tool | What it does |
|---|---|
| `tools/logic-loader.mjs` | Extracts `<script id="logic">` from the shipped HTML and evaluates it with its top-level names exported. Everything below tests the real page logic, not a copy. |
| `tools/arcgis.mjs` | Small `query(service, params)` POST helper for the UGRC FeatureServer endpoints. |
| `tests/logic.test.mjs` | 30 unit tests: parsing, address similarity, WHERE builders, geocode candidate filtering, geometry, entity classification, rate summing, tax math, and the explained-equation terms and notes.  `node --test tests/logic.test.mjs`. |
| `tools/check-scripts.mjs` | Compiles both `<script>` blocks of the shipped page and scans for stray control characters (patching HTML from Python can turn `\b`/`\d` into backspace bytes). Run after any HTML edit. |
| `tools/dom-stub.mjs` + `tools/app-runner.mjs` | A minimal DOM stand-in plus a harness that evaluates the *shipped* logic and app scripts together, fires the form, and reads back the rendered panel. This is what makes live testing of the page (not a mirror) possible. |
| `tools/dump-panel.mjs` | Prints the panel the app renders for one lookup, plus the explainer's formula, for eyeballing. `node tools/dump-panel.mjs ["500 W Center St, Provo"]`. |
| `tools/smoke-live.mjs` | 12 live lookups through the shipped app script: named street, Utah grid, misspelt street, dashed parcel ids, condo ids, a parcel number, and two no-match inputs. Prints parcel, county, rate, rate year, body count, monthly amount. |
| `tools/validate-match.mjs` | Identity-integrity suite over live data: true pairs, multi-town twins, city swaps, and the never-silent invariant. `--quick` for 30 s. Cries wolf only on dishonesty; skips on hiccups. |
| `tools/validate-lookup.mjs` | Mirrors the app's `findParcel`. Samples real `PARCEL_ADD` values out of `UtahStatewideParcels` per county, runs them through the pipeline, and checks the original `PARCEL_ID` comes back. Usage: `node tools/validate-lookup.mjs <perCounty> "<counties>" [modulus]`. |
| `tools/report600.mjs` | Parses a Report 600 PDF into `COUNTY|areaID|sub` rows of certified/proposed/adopted entity rates and area totals. |
| `tools/validate-rates.mjs` | Compares the entity-layer sum at sampled points against parsed Report 600 totals. |
| `tools/validate-taxdistrict.mjs` | Per-parcel rate check that skips the state's tax-area polygons: reads `TAX_DISTRICT` off the county parcel record, sums the entity rates at that parcel's own interior point, compares with Report 600 for that district. `node tools/validate-taxdistrict.mjs /tmp/r600-2025.json,/tmp/r600-2024.json 2`. |
| `tools/pipeline.mjs` | The page's lookup mirrored for the server: `estimate({address, price, primary})` returns JSON-ready parcel, match quality, county record, entity rows and the estimate. Shared by the API and `tools/smoke-api.mjs`. |
| `tools/serve.mjs` | Static server for the page on the LAN plus the JSON API (`/api/estimate`, self-describing `/api`), CORS-enabled, max 3 estimates in flight, serves nothing but the estimator. `node tools/serve.mjs [port]`. |
| `tools/smoke-api.mjs` | Boots the server on an ephemeral port and runs live API cases: 200 paths (address, parcel number, second home, location-only match, wrong-town city_check), 404, 400, and the CORS header. |
| `tools/lir-fields.mjs` | Asks all 29 county parcel layers for one row with `outFields=*` and prints the value/class/occupancy field names. Cheap, and the only safe way to learn what each county publishes. |
| `tools/probe.mjs`, `tools/coverage.mjs`, `tools/entities-inventory.mjs`, `tools/dup-rates.mjs` | One-off probes: layer/field discovery, `PARCEL_ADD` and value coverage per county, entity description inventory, duplicate-rate checks. |

## 10. Build log: what was learned this pass

**Rates.** `ENT_RATE` in `economy_tax_entities_2025` equals the Report 600 **final adopted** tax-area rate: exact on 73 of 75 sampled points, and the 2 differences were boundary-edge points. The same test on `TaxEntities2024` was exact on 75/75 for the 2024 report. The 2026 entity service is not published: it returns HTTP 200 with an ArcGIS body saying `Invalid URL`, which is why the app treats "HTTP 200 + error body" as a missing service and caches the first service that answers.

**Geography.** `UtahStatewideParcels` replaced the per-county lookup entirely: one layer, all 29 counties, `County` on every row. The lookup run sampled 3 parcels in each of 8 counties and returned the parcel's own `PARCEL_ID` in **21 of 24 (88%)**; the re-run after the corner-swap and query-budget changes sampled 2 per county in 6 counties and got **11 of 12 (92%)**. Every miss was a data ambiguity, not a code failure:
- Salt Lake `3495 N 3200 W` and Tooele `1162 N MAIN ST`: two records, one identical address (duplex/condo or duplicated records). The app shows a picker rather than guessing.
- Summit `2311 W HIGH MOUNTAIN RD # 5-369`: the geocode box returned the parent parcel, not the unit line.

**Things that were wrong and are now fixed** (each cost a real bug, keep them in mind when touching the logic):
- `arcQuery`'s option names meant the opposite of what the call sites assumed: `allowEmpty: false` set `tries = 1` (no retry), so the *tight* geocode boxes were the ones retrying empties three times (35 s for one 22 m box in Salt Lake County) while the widest box got a single attempt. The tight boxes now go once and grow, the widest box and the parcel-number search get the retries, and an ID search never falls through to geocoding a bare number.
- A parcel found by its own `PARCEL_ID` scored `a = 0` (there is no address text to match against a number), so once the auto-select rule got stricter, typing a parcel number opened a one-button parcel picker. The ID branch now marks records whose number matches as exact.
- The geocode-candidate loop resolved `null` when it ran out of candidates, throwing away the parcel it had already found. That is why misspelt streets used to report "no parcel matched" even though nearby parcels were fetched.
- The tightest query box (~7 m) comes back empty more often than not; the first radius is now ~22 m, and boxes are only accepted once they hold a parcel with an ID or an address.
- An unindexed `LIKE` on `PARCEL_ADD` over the statewide layer takes ~16 s. Boxing the same query by the geocoded point made it fast, so the address fallback is always spatially boxed (~2 km, then ~27 km); the unindexed scan is reserved for lookups where geocoding failed outright.
- **Latency, not query count, is the binding constraint.** At peak a *single* parcel query in dense Salt Lake County has taken 10-35 s — a 22 m box that returns one feature. So the near search grows its box instead of re-asking the same tiny one (only the widest box keeps the empty-response retry, because that answer is worth believing), and only the first productive geocoded point is explored. Typical lookups are 3 requests; the slowest observed path through the shipped page is ~17 s.
- These services intermittently return empty bodies or 5xx. `arcQuery` now retries empties *and* transient errors, and never lets one failed box kill the lookup.
- `addressSimilarity` had to become multiplicative: additive scoring let `FIRST`/`SECOND` look-alikes score as matches. Opposite directionals multiply by 0.3; a conflicting unit scores 0. The corner swap `810 S 900 E` vs `810 E 900 S` survived even that, because directionals were compared as a *set* — it still scored a clean 1.00 and read a tax bill off the wrong corner. Direction-and-number tokens are now compared in order, and same-pieces-in-a-different-order multiplies by 0.35 (below `MAYBE_MIN`, so it can never be auto-picked). A record that simply omits the cross direction (`810 S 900`) stays a match.
- Park City's right-of-way and condo records have blank addresses and ids like `YARD-A-1AM-UDOT-X`; a bare nearest-parcel pick lands on state land, so government/ROW parcels lose that tie.
- `SALT LAKE CITY` and friends are matched by description keywords before `ENT_NBR` ranges; `ENT_CODE` turned out to hold junk like `(IP-1)` and `(%)` and is not an entity type.

**Test harness gotchas:** the DOM stub now serializes appended children (otherwise a picker's buttons are invisible to the tests) and seeds inputs from the markup's own `value`/`checked` attributes (otherwise the shipped example renders against a $0 price); `readout()` only sees *panel text*, so its warning detection keys on the note wording rather than class names. When patching this HTML from Python, write regexes as raw strings - `"\b"` in an ordinary string is a backspace byte, and two of them once landed inside the UDOT/ROW test.

**Deliberate behaviour to preserve:** never silently pick between two plausible parcels, and never silently pick a parcel that neither matches the typed address nor covers the geocoded point; always print the confirmation note when the parcel was chosen by location rather than by its recorded address; keep the rate year label from `ENT_YR` so a stale fallback is visible.

## 11. Environment notes
- Published claude.ai artifacts **cannot** fetch outside hosts, which is why the tool is a standalone file.
- The original build sandbox couldn't reach `services1.arcgis.com` or `propertytax.utah.gov`. A local coding agent with normal web access can test live.
- Every ArcGIS query here is read-only, public and keyless.
## 12. This pass: where the value comes from, and a per-parcel rate check

### The panel now shows the whole equation
The result panel no longer ends at a bold monthly figure. It shows every term of the calculation with its source, so a broker can defend the number:

| Term | Where it comes from |
|---|---|
| Market value used | the county's recorded `TOTAL_MKT_VALUE` when the county publishes one, otherwise the typed price. The panel names which one, and quotes `CURRENT_ASOF` when the county stamps a date |
| × Taxable share | 55% for a primary residence (45% exemption, one per household, home plus up to one acre, Utah Code 59-2-1035), 100% for anything else |
| = Taxable value | what the rate actually applies to; neither the market value nor the price |
| × Combined rate | the sum of the rates of the *N* taxing bodies covering the parcel, stated as "*X* levy a rate, the rest sit at zero", for the year read from `ENT_YR`, plus the same figure as $/per $1,000 |
| = Annual tax, ÷ 12 = Monthly | monthly is the escrow tax piece only |

Under it: a **Both ways of reading the value** table (assessor's value vs price: market, taxable, per year, per month, and the difference), and a **Read the number this way** note block. All of it is produced by pure functions in `<script id="logic">` (`taxScenario`, `estimateSet`, `equationTerms`, `formulaLines`, `estimateNotes`, `parcelSignals`, `parcelClassWarnings`), so the wording is under test, not just under review.

Entity counts are stated honestly now. At the downtown Salt Lake City point the layer returns 10 rows, 8 of them nonzero, summing to 0.009240 — the honest phrasing is "seven to ten overlapping bodies, some at zero", not the "17–19 local governments" figure that was floating around.

### Why the county value leads the answer
- The tax bill is built on the assessor's market value, not the sale price, and the value is fixed as of **January 1** each year; a sale does not re-set it on its own and Utah has no supplemental assessment bill at closing.
- The Tax Commission's **2023 assessment-to-sales ratio study** measures county values against real sales and expects the typical ratio inside 90–110%. Median residential ratios: Salt Lake 95.5%, Utah 95.4%, Davis 95.8%, Weber 97.5%, Washington 94.9%, Cache 99.8%, Tooele 100.0%, Summit 98.3%. The study also condemns "sales chasing" (appraising a parcel at its sale price), so county values are modelled market values, not stamped sale prices. So the earlier ±20–40% caution on typed prices was too pessimistic for an ordinary arm's-length purchase of an existing home: **±5–10% is more honest**, and the price usually sits a few percent high.
- The wide caution still stands for: new construction (often land-only on the roll until the next January 1, which is what blows up first-year escrow), second homes, large acreage, commercial or exempt parcels, purchase-year timing, and exemptions or charges the model does not carry.

### Occupancy is the single biggest error source
The tax on a listing sheet or a seller's notice is the tax under the **seller's** occupancy. A house the seller rented is taxed on 100% of value; the same house lived in by its owner is taxed on 55%. Occupancy flipping at purchase moves the tax by close to half, either way, which is larger than anything else on the page. The panel now says this outright, and when the county record carries `PRIMARY_RES` it prints what the county records ("not a primary residence") and notes that the estimate follows the user's selection rather than the seller's. It never silently flips the choice.

### What the county parcel layers actually publish (`tools/lir-fields.mjs`)
`outFields=*` is the only safe request shape: **naming a field one county layer lacks makes ArcGIS reject the whole query**, and `parcelDetail` had `TAXABLE_VALUE` in its field list, so every county-detail request was failing with HTTP 200 + `'outFields' parameter is invalid` and no county value ever reached the panel. Fields worth reading (varies by county and parcel): `TOTAL_MKT_VALUE`, `LAND_MKT_VALUE`, `PROP_CLASS` (`Residential`, `Vacant`, `Land`, `Commercial`, `Commercial - Apartment & Condo`, `Greenbelt`, `Vacant - Agricultural`, `Tax Exempt - Government`, `Unknown`), `PRIMARY_RES` (`Y`/`N`), `TAX_DISTRICT`, `TAXEXEMPT_TYPE`, `PARCEL_ACRES`, `CURRENT_ASOF` (epoch ms). Coverage is per parcel, not per county: sample rows from Davis, Duchesne, Sanpete, Utah and Washington came back empty while Beaver, Cache, Grand, Iron, Sevier, Summit, Tooele, Wayne and Weber came back populated. Non-residential `PROP_CLASS` and `TAXEXEMPT_TYPE` now produce loud warnings instead of a quiet residential calculation. Two smoke fixtures turn out to be exempt on the county's own record (`2389 Washington Blvd, Ogden` and Park City `PCA-110-X`), which is a reminder that the class flag has to be read from the parcel, not assumed from the address.

### New and stronger rate validation: the parcel's own tax district
`tools/validate-taxdistrict.mjs` is a better test than the sampled-point version, because it never asks the state's tax-area polygons a question: the county's parcel record carries the **tax district number the parcel is billed in**, and Report 600 publishes the combined rate for that district. Result over 2 parcels per county, both rate years: **84 of 92 parcels matched the published district rate exactly** (`0.000000` difference), 0 merely near, 4 ambiguous (district with several sub-areas), 4 different, 4 with no Report 600 row. 43/46 for 2024 and 41/46 for 2025, across 23 counties. The known differences: Duchesne district 4 sums 0.000228 above the report, Cache district 106 sums 0.000046 below it.

### Where this sits next to a broker's real workflow
- Utah MLS listing sheets commonly print `Annual Tax Amount` and `Tax ID`, so for a listed purchase the number is often already in hand. For a refinance the borrower's own notice is authoritative.
- Otherwise the fallback is one of 29 county portals, each with its own UI; the Salt Lake and Utah County hosts are, respectively, unreachable from this environment and a JS-only app, so no portal data is integrated here.
- Larger lenders buy LOS-integrated tax feeds (Cotality/CoreLogic "Property Tax Basic" / "Property Tax Estimator" style products) that answer statewide in seconds.
- So the honest pitch is not "faster than the listing sheet". It is: **one statewide parcel + entity + rate interface** for the cases where there is no listing sheet and no working portal answer — off-market parcels, new construction with no tax history, rural counties, and (later) batches.
- Batch throughput is the real broker feature and it is not built: 20–50 addresses needs nearest-match plus a `needs_review=Y` column, and must never pop the address picker.

### The wrong-town bug a real user found (and why the tests missed it)
Feedback: `15 N Main St, Garland, UT` answered with a parcel recorded at 15 N Main St in **Clarkston** — same street string, different town, about a third less tax — labelled an exact match with no review flag. Reproduced: there is no parcel recorded as "15 N Main ST" in Garland, the recorded-address fallback queries statewide, and address similarity is computed on **street tokens only**, so the Clarkston parcel scored a perfect match. The typed city had been parsed and used only as a geocoder hint; it was never checked against the answer. Fixed in the shipped logic block:
- `placeCheck(parsed, parcel)` compares the typed city/ZIP against `PARCEL_CITY`/`PARCEL_ZIP`. Place words match by rule, not word list: equality, prefix, **contraction anchored on first letter + last letter + letters-in-order** (ST←SAINT, HTS←HEIGHTS, and ST does *not* match STATE — the last-letter anchor fails), one edit in a five-letter word (KEARNY/KEARNEY), and spaced-vs-smashed phrases (FRUIT HTS/FRUITHEIGHTS). Phrases decide by containment of the shorter side's words. Silent when either side is missing or the city agrees but the ZIP drifts. A mismatch prints "The place on the parcel record does not match what you typed…" and belongs at top level in `splitNotes` — identity, not fine print.
- `parseAddress` also takes a comma-less trailing ZIP (`100 Main St 84401`) as a claimed place. The guard is the 84 prefix: a bare five-digit tail is just as likely a grid number ("810 S 12000 E"), and every Utah ZIP is 840xx-847xx. It is stripped from the street line so it pollutes no query.
- `rankParcels` now gives the named town a **+100k boost** among same-address candidates (boost only, never a penalty: a stale `PARCEL_CITY` must not demote the honest candidate).
- The page composes the place note into the match note; the API sets `needs_review: true` **even for `quality: exact`** and returns `match.city_check` with both sides.
- Why the suite missed it: every fixture I wrote paired a correct city with a near-unique street — because that is how I knew the right answer, the corpus could not contain "right street, wrong town." `validate-lookup.mjs` scored the app's choice against the same recorded-address string, which is circular for exactly this bug. The correction is policy, not just cases: **every match test must include an adversarial pair — same street, different place** — and the live suites now do: `smoke-live.mjs` has a `place` case type (Garland: picker or loud warning, never silent), and `smoke-api.mjs` asserts `city_check.ok === false` and `needs_review` for the exact reported address.

### Reconsidering the suite after the Garland bug (what each layer proves)
The Garland/Clarkston bug was not a missing case; it was a missing layer. Audit:
- **Unit tests (42)** prove the pure functions do what they were *designed* to do. Blind by design to whether the design answers the user's question.
- **smoke-live / smoke-api** prove the page and the API render a sane panel for *addresses I chose*. Blind to whether the chosen parcel is the parcel asked about — and my fixtures always paired a street with its correct city, so the corpus *could not contain* "right street, wrong town."
- **validate-rates / validate-taxdistrict** prove the *numbers* are right. Blind to whether they describe the right property.
- **validate-lookup** scored the pick against the same recorded string the engine searches — circular for exactly this bug class.
New layer, `tools/validate-match.mjs`, asserts the promise a user actually experiences, with cases generated **from the live layer**, not from my imagination:
- **true pairs** — sample real parcels across the state, query `PARCEL_ADD, PARCEL_CITY, UT` exactly as recorded; a silent answer (`needs_review=false`) must return *that parcel*.
- **twins** — one street string recorded in several towns (found in the sample itself, plus statewide grid strings like "200 N 100 W"); typing a town must land there or shout.
- **swaps** — a real address paired with a different real city; never silent unless the typed town genuinely has that street.
- **the invariant, checked on every answered case** (also inside `smoke-api.mjs`): `needs_review===false` implies `city_check.ok===true`. That one line is the anti-Garland rule.
Service hiccups are retried once and skipped, never failed — this suite cries wolf only on dishonesty. Full run ~1 minute, `--quick` ~30 s.
**Residual blind spots, stated honestly:** (1) when the user types no city and no ZIP, the answer is "the parcel at whatever place the geocoder chose" — that is a product decision the invariants do not and should not police; (2) sampling skews to populated OBJECTID windows, so rare county formats are hit by chance; (3) the page-vs-API split is covered only because both run the *same extracted pure logic* — a divergence in `findParcel`-only code (page) or `estimate`-only code (API) would be caught by its own suite, not the other's; the unit tests on the shared functions are what bind the two halves together.

### JSON API for spreadsheets and batch work
`tools/pipeline.mjs` is the shipped page's lookup mirrored server-side (geocode → box-ranked parcels, recorded-address fallback, parcel-number branch, entities at an interior point with the 2026→2025 fallback, county record for the market value), ending in the same pure estimate functions. `tools/serve.mjs` serves it at `/api/estimate` with permissive CORS and a 3-request concurrency guard, alongside the static page. Honest ambiguity semantics carry over: a location-only or approximate match returns the best candidate **plus** `needs_review: true`, the explanation note, and `candidates[]` — the API never silently picks, and never blocks the way the browser picker does. Verified by `tools/smoke-api.mjs` (8 live cases: address, parcel number, second-home share, location-only match, wrong-town exact match, 404, 400, CORS header). The response itself is built by the pure, exported `shapeResult()`/`parseParams()`, so the API's shape and match semantics are unit-tested with fabricated fixtures (42 tests total) — the live suite only has to prove the plumbing.

### The panel was restructured for progressive disclosure
First pass at the same information was a wall of text: every term explained inline, both value tables, four note paragraphs, and the full entity table all open at once. The panel now reads in three levels:

- **Level 1, always visible:** the monthly figure and what it rests on (`on the county assessor's value on record of $568,900`), a one-line mono strip with the whole arithmetic (`55% of $568,900 \u2192 $312,895 taxable \u00d7 0.009240 = $2,891.15/yr \u00b7 $240.93/mo \u00b7 tax year 2025`), the parcel block, identity notes (which parcel this is, input problems, state-data gaps), and the entity table with only the rate-levying bodies (`8 of 9 bodies levy a rate`).
- **Level 2, one click each:** `Price vs the county's value \u00b7 your price would add $15.29/mo (+6.3%)` (both readings + the bracketing hint), `How each term works` (the full six-term table), `Fine print` (class/occupancy/acreage caveats + the occupancy, timing and exclusions notes), and `N more bodies cover this parcel at zero rate`.
- **Level 3:** the page-bottom `How this estimate works` explainer, unchanged.

The visible/collapsed split is a pure, tested function (`splitNotes`): identity notes and state-data gaps stay up, method caveats fold away. `equationStrip` and `diffPhrase` build the one-liners. The top-of-page subtitle and form hints were shortened to single sentences. Smoke assertions were updated for the new labels (`tax year`, `How each term works`, `N of M bodies levy`); 33 unit tests and 11/11 live cases pass.

### Live smoke run after these changes
`node tools/smoke-live.mjs`: **11/11 cases sane**, now also asserting the equation block is rendered (6 of 6 terms), that the panel names which value it used, and that the exclusions and occupancy notes are present. Fixtures in Tooele, Salt Lake, Weber, Washington and Summit picked up county values of $1.47M, $11.39M, $629k, $2.97M and $4.05M respectively, and four of them correctly drew a "the county classifies this parcel as Commercial / Tax Exempt, not as a residence" warning, because those smoke addresses are commercial buildings.
