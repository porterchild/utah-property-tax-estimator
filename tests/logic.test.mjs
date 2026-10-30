import { test } from "node:test";
import assert from "node:assert/strict";
import { loadLogic } from "../tools/logic-loader.mjs";
import { parseParams, shapeResult, idMatches, ApiError } from "../tools/pipeline.mjs";

const L = await loadLogic();
const {
  parsePrice, looksLikeParcelId, parseAddress, normalizeAddress, splitUnit, addressSimilarity,
  buildAddressWhere, parcelIdVariants, buildParcelIdWhere, rankParcels, rankGeocodeCandidates,
  pointInRings, interiorPoint, distanceMeters, entityKind, countyFromCode, countyLabel, countyKey,
  summarizeEntities, computeTax, MATCH_MIN, MAYBE_MIN,
  money, rateStr, pct, taxScenario, estimateSet, basisLabel, equationTerms, formulaLines, estimateNotes,
  asOfDate, parcelSignals, parcelClassWarnings, equationStrip, diffPhrase, splitNotes
} = L;

test("parsePrice accepts the shapes people type", () => {
  assert.equal(parsePrice("550,000"), 550000);
  assert.equal(parsePrice("$1,250,000.00"), 1250000);
  assert.equal(parsePrice("550k"), 550000);
  assert.equal(parsePrice("1.2M"), 1200000);
  assert.equal(parsePrice("abc"), null);
  assert.equal(parsePrice(""), null);
  assert.equal(parsePrice("0"), null);
  assert.equal(parsePrice("-5"), null);
});

test("looksLikeParcelId separates ids from addresses", () => {
  assert.equal(looksLikeParcelId("15112540240000"), true);
  assert.equal(looksLikeParcelId("45:866:0128"), true);
  assert.equal(looksLikeParcelId("02-031-0-0041"), true);
  assert.equal(looksLikeParcelId("C123-4567-001"), true);
  assert.equal(looksLikeParcelId("810 S 900 E"), false);
  assert.equal(looksLikeParcelId("1000 N 400 E, Bountiful"), false);
  assert.equal(looksLikeParcelId("500 W Center St"), false);
});

test("parseAddress handles Utah grid addresses", () => {
  const p = parseAddress("810 S 900 E, Salt Lake City, UT 84102");
  assert.equal(p.house, "810");
  assert.deepEqual(p.dirs, ["S", "E"]);
  assert.deepEqual(p.numbers, ["900"]);
  assert.deepEqual(p.keys, []);
  assert.equal(p.city, "SALT LAKE CITY");
  assert.equal(p.zip, "84102");
});

test("parseAddress handles named streets, units and missing city", () => {
  const p = parseAddress("1921 north first love drive");
  assert.equal(p.house, "1921");
  assert.deepEqual(p.dirs, ["N"]);
  assert.deepEqual(p.keys, ["FIRST", "LOVE"]);
  assert.equal(p.city, null);

  const u = parseAddress("185 N Main St Ste 701, Tooele");
  assert.equal(u.house, "185");
  assert.equal(u.unit, "701");
  assert.deepEqual(u.keys, ["MAIN"]);

  const a = parseAddress("1000 N 400 E, Bountiful");
  assert.equal(a.house, "1000");
  assert.deepEqual(a.numbers, ["400"]);
});

test("normalizeAddress collapses the words Utah records differ on", () => {
  assert.equal(normalizeAddress("1425 north 1100 east"), "1425 N 1100 E");
  assert.equal(normalizeAddress("500 W. Center Street"), "500 W CENTER ST");
  assert.equal(normalizeAddress("2100 s. w. 300 West st"), "2100 S W 300 W ST");
  assert.equal(normalizeAddress("500 W Center St"), "500 W CENTER ST", "CENTER is a street name, not CTR");
});

test("splitUnit pulls units out without eating the street", () => {
  assert.deepEqual(splitUnit("185 N MAIN ST STE 701"), { street: "185 N MAIN ST", unit: "701" });
  assert.deepEqual(splitUnit("2389 WASHINGTON BLVD"), { street: "2389 WASHINGTON BLVD", unit: null });
  assert.deepEqual(splitUnit("2404 WASHINGTON BLVD UNIT C4").unit, "C4");
  assert.deepEqual(splitUnit("APT 204").unit, "204");
});

test("addressSimilarity is strict about what makes a different property in Utah", () => {
  const grid = parseAddress("810 S 900 E");
  assert.equal(addressSimilarity(grid, "810 S 900 E"), 1);
  assert.equal(addressSimilarity(grid, "810 SOUTH 900 EAST"), 1);
  // Same numbers, opposite corner: two miles away, must never be accepted.
  assert.ok(addressSimilarity(grid, "810 W 900 S") < L.MAYBE_MIN, "corner swap must not match");
  assert.equal(addressSimilarity(grid, "1900 S 900 E"), 0);
  // Geocoders interpolate, so a house number a few off on the same street is only a maybe.
  const near = addressSimilarity(grid, "809 S 900 E");
  assert.ok(near >= L.MAYBE_MIN && near < MATCH_MIN, "off-by-one is a maybe, not a match: " + near);

  const street = parseAddress("1921 N First Love Dr");
  assert.equal(addressSimilarity(street, "1921 N FIRST LOVE DR"), 1);
  assert.ok(addressSimilarity(street, "1921 N SECOND LOVE DR") < L.MAYBE_MIN, "a different street");
  assert.equal(addressSimilarity(street, "1921 S FIRST LOVE DR") < MATCH_MIN, true);

  const unit = parseAddress("185 N Main St #701");
  assert.ok(addressSimilarity(unit, "185 N MAIN ST STE 701") >= MATCH_MIN);
  assert.ok(addressSimilarity(unit, "185 N MAIN ST STE 702") < MATCH_MIN, "wrong unit");
  assert.ok(addressSimilarity(parseAddress("185 N Main St"), "185 N MAIN STE 701") <= 1);
});

test("buildAddressWhere requires the house number as a prefix", () => {
  const w = buildAddressWhere(parseAddress("810 S 900 E"));
  assert.match(w, /^UPPER\(PARCEL_ADD\) LIKE '810 %'/);
  assert.match(w, /LIKE '% 900 %'/);
  // A loose '%900%' would match 1900, 2900 and every other hundred.
  assert.equal(/LIKE '%900%'/.test(w), false);
  assert.equal(buildAddressWhere(parseAddress("Salt Lake City")), null);
  assert.match(buildAddressWhere(parseAddress("500 W Orem Ave")), /LIKE '%OREM%' OR|LIKE '% OREM %'/);
});

test("parcel id variants and WHERE clauses stay quoted", () => {
  assert.deepEqual(parcelIdVariants("45:866:0128"), ["45:866:0128", "458660128"]);
  assert.deepEqual(parcelIdVariants(" 02-031-0-0041 ").slice(0, 2), ["02-031-0-0041", "0203100041"]);
  assert.deepEqual(parcelIdVariants("0004586601").indexOf("4586601") > 0, true);
  const exact = buildParcelIdWhere("15112540240000", "exact");
  assert.match(exact, /PARCEL_ID = '15112540240000'/);
  assert.equal(/LIKE/.test(exact), false);
  assert.match(buildParcelIdWhere("1511254024", "prefix"), /PARCEL_ID LIKE '1511254024%'/);
  // Quotes in the input have to be escaped, not interpolated raw.
  assert.match(buildParcelIdWhere("O'BRIEN 12345", "exact"), /'O''BRIEN 12345'/);
});

test("rankGeocodeCandidates keeps only usable Utah street matches", () => {
  const ok = { address: "810 S 900 E, Salt Lake City, Utah, 84102", score: 100, location: { x: -111.86, y: 40.75 }, attributes: { Addr_type: "StreetAddress" } };
  const foreign = { address: "Guanacaste, Abangares, Las Juntas, San Antonio", score: 74, location: { x: -84.9, y: 10.2 }, attributes: { Addr_type: "Locality" } };
  const cityOnly = { address: "Ogden, Utah", score: 90, location: { x: -111.97, y: 41.22 }, attributes: { Addr_type: "Locality" } };
  const wrongHouse = { address: "900 E, Salt Lake City, Utah", score: 95, location: { x: -111.86, y: 40.75 }, attributes: { Addr_type: "StreetName" } };
  const out = rankGeocodeCandidates({ candidates: [foreign, cityOnly, wrongHouse, ok] }, parseAddress("810 S 900 E, Salt Lake City"));
  assert.equal(out.length, 1);
  assert.equal(out[0].label, ok.address);
  assert.equal(rankGeocodeCandidates({}, null).length, 0);
  assert.equal(rankGeocodeCandidates(null, null).length, 0);
});

const square = [[[-111.9, 40.7], [-111.89, 40.7], [-111.89, 40.701], [-111.9, 40.701], [-111.9, 40.7]]];
const uShape = [
  [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
  [[2, 3], [8, 3], [8, 10], [2, 10], [2, 3]]
];

test("pointInRings and interiorPoint stay inside the parcel", () => {
  assert.equal(pointInRings(-111.895, 40.7005, square), true);
  assert.equal(pointInRings(-111.88, 40.7005, square), false);
  const pt = interiorPoint(uShape);
  assert.equal(pointInRings(pt[0], pt[1], uShape), true, "interior point of a U-shape must be inside: " + pt);
});

test("a corner swap in a grid address is not a match", () => {
  const q = parseAddress("810 S 900 E, Salt Lake City");
  assert.equal(addressSimilarity(q, "810 S 900 E"), 1);
  assert.ok(addressSimilarity(q, "810 E 900 S") < MAYBE_MIN, "swapped corner must not match");
  assert.ok(addressSimilarity(q, "810 S 900") >= MATCH_MIN, "a record missing the cross direction is still the block");
  assert.ok(addressSimilarity(parseAddress("1250 S MAIN ST"), "1250 MAIN ST") >= MATCH_MIN);
});

test("distanceMeters is roughly right", () => {
  assert.ok(Math.abs(distanceMeters([-111.9, 40.7], [-111.9, 40.71]) - 1113) < 30);
});

test("rankParcels prefers the parcel whose address matches over a closer wrong one", () => {
  const parsed = parseAddress("810 S 900 E");
  // Both parcels sit near the geocoded point; only one of them is 810 S 900 E.
  const addressMatch = { attributes: { PARCEL_ID: "addressMatch", PARCEL_ADD: "810 S 900 E" }, geometry: { rings: [[[-111.8599, 40.7499], [-111.8589, 40.7499], [-111.8589, 40.7509], [-111.8599, 40.7509], [-111.8599, 40.7499]]] } };
  const closerButDifferent = { attributes: { PARCEL_ID: "closerButDifferent", PARCEL_ADD: "1234 MAIN ST" }, geometry: { rings: [[[-111.8602, 40.7499], [-111.8601, 40.7499], [-111.8601, 40.75], [-111.8602, 40.75], [-111.8602, 40.7499]]] } };
  const point = [-111.86, 40.75];
  const ranked = rankParcels([closerButDifferent, addressMatch], parsed, point);
  assert.equal(ranked[0].c.PARCEL_ID, "addressMatch");
  assert.equal(ranked[0].bucket, 2);
  // With no address match anywhere, the parcel that actually contains the point wins.
  const containsPoint = { attributes: { PARCEL_ID: "containsPoint", PARCEL_ADD: "99 W SOMETHING" }, geometry: { rings: [[[-111.8605, 40.7495], [-111.8595, 40.7495], [-111.8595, 40.7505], [-111.8605, 40.7505], [-111.8605, 40.7495]]] } };
  const noSignal = rankParcels([addressMatch, containsPoint], parseAddress("404 NOWHERE LN"), point);
  assert.equal(noSignal[0].c.PARCEL_ID, "containsPoint");
  assert.equal(noSignal[0].inside, true);
  assert.equal(rankParcels([], parsed, null).length, 0);
  assert.equal(rankParcels([{ attributes: {} }], parsed, null).length, 0);
});

test("a street or right-of-way parcel loses a nearest-parcel tie", () => {
  const row = (id, own, addr) => ({
    attributes: { PARCEL_ID: id, PARCEL_ADD: addr, OWN_TYPE: own },
    geometry: { rings: [[[-111.8601, 40.7499], [-111.86, 40.7499], [-111.86, 40.75], [-111.8601, 40.75], [-111.8601, 40.7499]]] }
  });
  const privateLot = row("privateLot", "Private", null);
  const rowWay = row("YARD-A-1AM-UDOT-X", "Private", null);
  const gov = row("stateParcel", "Government", null);
  const point = [-111.86005, 40.74995];
  const ranked = rankParcels([gov, rowWay, privateLot], parseAddress("1299 KEARNY BLVD"), point);
  assert.equal(ranked[0].c.PARCEL_ID, "privateLot");
  assert.ok(ranked.indexOf(ranked.find((r) => r.c.PARCEL_ID === "stateParcel")) < 0 ||
    ranked.findIndex((r) => r.c.PARCEL_ID === "stateParcel") > 0);
  // An exact recorded address still beats the ownership preference.
  const govWithAddress = row("stateParcel", "Government", "1299 KEARNY BLVD");
  assert.equal(rankParcels([govWithAddress, privateLot], parseAddress("1299 Kearny Blvd"), point)[0].c.PARCEL_ID, "stateParcel");
});

test("entityKind reads Utah entity numbers and names", () => {
  assert.equal(entityKind(1010, "UTAH COUNTY"), "County levy");
  assert.equal(entityKind(2045, "ALPINE SCHOOL DISTRICT"), "School district");
  assert.equal(entityKind(3010, "SALT LAKE CITY"), "City or town");
  assert.equal(entityKind(3071, "SALT LAKE CITY LIBRARY FOUNDATION"), "Library");
  assert.equal(entityKind(4030, "SALT LAKE CITY MOSQUITO ABATEMENT DISTRICT"), "Vector control");
  assert.equal(entityKind(4020, "SALT LAKE METROPOLITAN WATER DISTRICT"), "Metropolitan district");
  assert.equal(entityKind(4100, "PROVO RIVER WASTEWATER DISTRICT"), "Sewer district");
  assert.equal(entityKind(4200, "HIDEOUT WATER COMPANY"), "Water district");
  assert.equal(entityKind(6010, "SOUTH UTAH VALLEY ANIMAL SPECIAL SERVICE DISTRICT"), "Special service district");
  assert.equal(entityKind(6020, "WASATCH BEHAVIORAL HEALTH SPECIAL SERVICE DISTRICT"), "Special service district");
  assert.equal(entityKind(5005, "SOUTHEAST UTAH PUBLIC INFRASTRUCTURE DISTRICT"), "Infrastructure district");
  assert.equal(entityKind(5005, "TUALTY PUBLIC INFRASTRUCTURE DISTRICT 3"), "Infrastructure district");
  assert.equal(entityKind(8001, "STATE STREET COMMUNITY REINVESTMENT AREA"), "Tax-increment area");
  assert.equal(entityKind(6050, "OGDEN CITY FIRE DEPARTMENT"), "Fire district");
});

test("county codes decode the way the Tax Commission numbers them", () => {
  assert.equal(countyFromCode("18"), "Salt Lake");
  assert.equal(countyFromCode("06"), "Davis");
  assert.equal(countyFromCode("29"), "Weber");
  assert.equal(countyFromCode(1), "Beaver");
  assert.equal(countyFromCode("99"), null);
  assert.equal(countyLabel("SaltLake"), "Salt Lake");
  assert.equal(countyLabel("BoxElder"), "Box Elder");
  assert.equal(countyKey("SaltLake"), "SaltLake");
  assert.equal(countyKey("SALT LAKE"), "SaltLake");
  assert.equal(countyKey("box elder"), "BoxElder");
  assert.equal("Parcels_" + countyKey("Tooele") + "_LIR", "Parcels_Tooele_LIR");
});

test("summarizeEntities dedupes polygons, sums rates and warns on gaps", () => {
  const rows = [
    { ENT_YR: 2025, ENT_CO: "18", ENT_NBR: 1010, ENT_DESC: "SALT LAKE COUNTY", ENT_RATE: 0.001 },
    { ENT_YR: 2025, ENT_CO: "18", ENT_NBR: 1010, ENT_DESC: "SALT LAKE COUNTY", ENT_RATE: 0.001 },
    { ENT_YR: 2025, ENT_CO: "18", ENT_NBR: 2010, ENT_DESC: "SALT LAKE CITY SCHOOL DISTRICT", ENT_RATE: 0.003 },
    { ENT_YR: 2025, ENT_CO: "18", ENT_NBR: 3010, ENT_DESC: "SALT LAKE CITY", ENT_RATE: 0.002 },
    { ENT_YR: 2025, ENT_CO: "18", ENT_NBR: 3011, ENT_DESC: "MILLCREEK HEIGHTS", ENT_RATE: 0.0005 },
    { ENT_YR: 2025, ENT_CO: "18", ENT_NBR: 8001, ENT_DESC: "STATE STREET CREATION", ENT_RATE: 0 }
  ];
  const s = summarizeEntities(rows);
  assert.equal(s.rows.length, 5);
  assert.equal(s.total, 0.0065);
  assert.equal(s.year, 2025);
  assert.equal(s.rows[0].rate, 0.003);
  assert.match(s.warnings.find((w) => /more than one city/.test(w)), /more than one city/);
  assert.equal(summarizeEntities([]).total, 0);
  assert.equal(summarizeEntities([{ ENT_YR: 2025, ENT_CO: "18", ENT_NBR: 3010, ENT_DESC: "PROVO CITY", ENT_RATE: 0.002 }]).warnings.length, 2, "missing school + county levies warned");
});

test("computeTax applies the residential exemption", () => {
  const primary = computeTax(550000, true, 0.00924);
  assert.equal(primary.taxable, 302500);
  assert.ok(Math.abs(primary.annual - 2795.1) < 0.01);
  assert.ok(Math.abs(primary.monthly - 232.925) < 0.01);
  const other = computeTax(550000, false, 0.00924);
  assert.ok(Math.abs(other.annual / primary.annual - 1 / 0.55) < 1e-9);
});

test("money, rateStr and pct render the terms the way the panel shows them", () => {
  assert.equal(money(293500), "$293,500");
  assert.equal(money(2795.1, 2), "$2,795.10");
  assert.equal(money(null), "$0");
  assert.equal(rateStr(0.00924), "0.009240");
  assert.equal(pct(0.55), "55%");
  assert.equal(pct(0.0625, 1), "6.3%");
});

test("estimateSet leads with the assessor's value and keeps the price as a comparison", () => {
  const s = estimateSet({ price: 605000, countyValue: 577000, primary: true, rate: 0.009940 });
  assert.equal(s.list.length, 2);
  assert.equal(s.preferred.basis, "county");
  assert.equal(s.comparison.basis, "price");
  assert.equal(s.preferred.taxable, 577000 * 0.55);
  assert.ok(s.diff.annual > 0 && s.diff.monthly > 0);
  assert.ok(Math.abs(s.preferred.monthly * 12 - s.preferred.annual) < 1e-9);
  assert.equal(s.preferred.perThousand, 9.94);
});

test("estimateSet falls back to the price, and to nothing at all, honestly", () => {
  const price = estimateSet({ price: 550000, countyValue: 0, primary: true, rate: 0.00924 });
  assert.equal(price.list.length, 1);
  assert.equal(price.preferred.basis, "price");
  assert.equal(price.comparison, null);
  assert.equal(price.diff, null);
  assert.equal(estimateSet({ price: 0, countyValue: 0, primary: true, rate: 0.009 }).preferred, null);
  assert.equal(basisLabel("county"), "the county assessor's value on record");
});

test("the occupancy switch is the biggest lever in the equation", () => {
  const args = { price: 550000, countyValue: 0, rate: 0.00924 };
  const primary = estimateSet(Object.assign({ primary: true }, args)).preferred;
  const other = estimateSet(Object.assign({ primary: false }, args)).preferred;
  assert.equal(primary.share, 0.55);
  assert.equal(other.share, 1);
  assert.ok(Math.abs(other.annual / primary.annual - 1 / 0.55) < 1e-9);
});

test("every term of the equation is named, valued and explained", () => {
  const sc = estimateSet({ price: 0, countyValue: 293500, primary: true, rate: 0.009940 }).preferred;
  const terms = equationTerms(sc, { year: 2025, count: 10, paying: 8, asOf: "September 30, 2026" });
  assert.equal(terms.length, 6);
  terms.forEach((t) => {
    assert.ok(t.term && t.amount, "term and amount present");
    assert.ok(t.why.length > 40, "term explained: " + t.term);
    assert.doesNotMatch(t.amount + t.why, /NaN|undefined|\$\{/);
  });
  const by = Object.fromEntries(terms.map((t) => [t.term, t]));
  assert.equal(by["Market value used"].amount, "$293,500");
  assert.match(by["Market value used"].why, /current as of September 30, 2026/);
  assert.match(by["Market value used"].why, /does not move just because the home sold/);
  assert.equal(by["× Taxable share"].amount, "55%");
  assert.match(by["× Taxable share"].why, /45% exemption/);
  assert.equal(by["= Taxable value"].amount, "$161,425");
  assert.equal(by["× Combined rate"].amount, "0.009940");
  assert.match(by["× Combined rate"].why, /the 10 taxing bodies covering this parcel \(8 levy a rate/);
  assert.match(by["× Combined rate"].why, /\$9\.94 per \$1,000/);
  assert.match(by["= Annual tax"].amount, /^\$/);
});

test("the price basis admits it is standing in for the assessor", () => {
  const sc = estimateSet({ price: 605000, countyValue: 0, primary: false, rate: 0.00924 }).preferred;
  const terms = equationTerms(sc, { year: 2025, count: 9 });
  assert.match(terms[0].why, /assessment-to-sales ratio study/);
  assert.match(terms[1].why, /100% of market value is taxable/);
  assert.doesNotMatch(terms[3].why, /levy a rate, the rest/);
});

test("formulaLines prints the whole chain including where the value came from", () => {
  const sc = estimateSet({ price: 550000, countyValue: 0, primary: true, rate: 0.00924 }).preferred;
  const text = formulaLines(sc, { year: 2025, primary: true });
  assert.match(text, /Market value\s+= \$550,000\s+\(the purchase price you entered\)/);
  assert.match(text, /Taxable value .*55% .*primary residence.* = \$302,500/);
  assert.match(text, /Combined rate  = 0\.009240 = \$9\.24 per \$1,000, tax year 2025/);
  assert.match(text, /Annual tax     = \$302,500 × 0\.009240 = \$2,795\.10/);
  assert.match(text, /Monthly tax    = /);
});

test("the notes flag occupancy and timing risk and say what is excluded", () => {
  const sc = estimateSet({ price: 550000, countyValue: 0, primary: true, rate: 0.00924 }).preferred;
  const both = estimateNotes(sc, { countyValueMissing: false }).join(" ");
  assert.match(both, /seller's own occupancy/);
  assert.match(both, /close to half/);
  assert.match(both, /January 1/);
  assert.match(both, /Not in this number: special assessments/);
  assert.equal(estimateNotes(sc, { countyValueMissing: false }).length, 3);
  assert.match(estimateNotes(sc, { countyValueMissing: true }).join(" "), /does not publish a market value/);
  assert.equal(estimateNotes(sc, { countyValueMissing: true }).length, 4);
});

test("the county's own record is read for class, occupancy and date", () => {
  const home = parcelSignals({
    PROP_CLASS: "Residential", PRIMARY_RES: "Y", TOTAL_MKT_VALUE: 293500,
    CURRENT_ASOF: Date.UTC(2026, 8, 29)
  });
  assert.equal(home.klass, "Residential");
  assert.equal(home.residential, true);
  assert.equal(home.primaryRes, "Y");
  assert.equal(home.value, 293500);
  assert.equal(home.asOf, "September 29, 2026");
  const empty = parcelSignals(null);
  assert.equal(empty.klass, "");
  assert.equal(empty.residential, false);
  assert.equal(empty.primaryRes, "");
  assert.equal(empty.asOf, "");
  assert.equal(asOfDate("nonsense"), "");
  assert.equal(parcelSignals({ PROP_CLASS: "Single Family" }).residential, true);
});

test("a parcel the county does not classify as a home is called out", () => {
  const greenbelt = parcelSignals({ PROP_CLASS: "Greenbelt", TAXEXEMPT_TYPE: "Other" });
  const w = parcelClassWarnings(greenbelt, { selectedPrimary: true }).join(" ");
  assert.match(w, /classifies this parcel as Greenbelt, not as a residence/);
  assert.match(w, /tax exempt \(Other\)/);
  assert.match(w, /if the parcel were taxable/);
  assert.equal(parcelClassWarnings(parcelSignals({ PROP_CLASS: "Residential" }), { selectedPrimary: true }).length, 0);
  assert.match(parcelClassWarnings(parcelSignals({ PROP_CLASS: "Tax Exempt - Government" }), {}).join(" "), /not as a residence/);
});

test("the county's recorded occupancy is surfaced, never silently obeyed", () => {
  const rental = parcelSignals({ PROP_CLASS: "Residential", PRIMARY_RES: "N" });
  assert.match(parcelClassWarnings(rental, { selectedPrimary: true }).join(" "), /not a primary residence, so today it is taxed on 100%/);
  assert.equal(parcelClassWarnings(rental, { selectedPrimary: false }).length, 0, "no warning when the choice already matches the record");
  assert.match(parcelClassWarnings(parcelSignals({ PRIMARY_RES: "Y" }), { selectedPrimary: false }).join(" "), /follows your selection/);
  assert.equal(parcelClassWarnings(parcelSignals({ PRIMARY_RES: "Y" }), {}).length, 0);
});

test("the one-line strip compresses the arithmetic without losing a term", () => {
  const p = estimateSet({ price: 0, countyValue: 568900, primary: true, rate: 0.00924 }).preferred;
  assert.equal(equationStrip(p), "55% of $568,900 → $312,895 taxable × 0.009240 = $2,891.15/yr · $240.93/mo");
  const o = estimateSet({ price: 0, countyValue: 568900, primary: false, rate: 0.00924 }).preferred;
  assert.equal(equationStrip(o), "$568,900 taxable × 0.009240 = $5,256.64/yr · $438.05/mo");
});

test("the price-vs-county phrase reads like a sentence, sign included", () => {
  assert.match(diffPhrase({ monthly: 15.29, annual: 183.5, pct: 0.063 }), /would add \$15\.29\/mo \(\+6\.3%\)/);
  assert.match(diffPhrase({ monthly: -8.1, annual: -97.2, pct: -0.051 }), /would trim \$8\.10\/mo \(−5\.1%\)/);
  assert.equal(diffPhrase(null), "");
});

test("notes split into what stays up and what folds away", () => {
  const s = splitNotes([
    "No parcel in the state file carries exactly 810 S 900 E. This is the parcel recorded as 876 E 800 S, about 115 m from the spot that address geocoded to.",
    "The county classifies this parcel as Commercial, not as a residence, so the value and rate here describe that use.",
    "The county records this parcel as not a primary residence, so today it is taxed on 100% of its value.",
    "This parcel falls inside more than one city. It likely sits on a boundary the state data does not draw exactly, so check the city on the tax notice.",
    "This lot is 2.40 acres. The primary residence exemption covers the home and up to one acre, so the estimate runs slightly low.",
    "Enter a purchase price to calculate the tax."
  ]);
  assert.equal(s.top.length, 3, "identity + data-gap + input notes stay visible");
  assert.equal(s.fine.length, 3, "class/occupancy/acreage caveats fold away");
  assert.match(s.top[0], /^No parcel in the state file/);
  assert.match(s.top[2], /^Enter a purchase price/);
  assert.match(s.fine[0], /classifies this parcel as Commercial/);
  assert.match(s.fine[2], /slightly low/);
  assert.deepEqual(splitNotes([]), { top: [], fine: [] });
});

/* ---------- API layer: the response shape, without touching the network ---------- */

const RING = [[[-111.667, 40.233], [-111.666, 40.233], [-111.666, 40.234], [-111.667, 40.234], [-111.667, 40.233]]];
const parcel = (over = {}) => Object.assign({
  PARCEL_ID: "040660009", PARCEL_ADD: "500 W CENTER ST", PARCEL_CITY: "Provo", County: "Utah"
}, over);
const cand = (over = {}) => Object.assign({ c: parcel(), rings: RING, bucket: 0, a: 0.9, s: 0.9, inside: true, m: 5 }, over);
const ents = (over = {}) => Object.assign({
  rows: [
    { name: "PROVO CITY SCHOOL DISTRICT", kind: "School district", county: "Utah", rate: 0.006922 },
    { name: "PROVO", kind: "City or town", county: "Utah", rate: 0.001599 },
    { name: "CENTRAL UTAH WATER CONSERVANCY", kind: "Water district", county: "Utah", rate: 0 }
  ],
  total: 0.008521, year: 2025, warnings: [], count: 3, service: "economy_tax_entities_2025"
}, over);
const roll = (over = {}) => Object.assign({
  TOTAL_MKT_VALUE: 293500, PROP_CLASS: "Residential", PRIMARY_RES: "Y",
  CURRENT_ASOF: Date.UTC(2026, 8, 29), PARCEL_ACRES: 0.25
}, over);
const shape = (over = {}) => shapeResult({
  input: Object.assign({ address: "500 W Center St, Provo", price: 400000, primary: true }, over.input || {}),
  found: Object.assign({ ranked: [cand()], how: "geocoded location", point: [-111.6667, 40.2334] }, over.found || {}),
  ent: ents(over.ent || {}),
  detail: "detail" in over ? over.detail : roll()
});

test("api params: primary defaults to true, the synonyms say false, price parses like the page's", () => {
  assert.deepEqual(
    { a: parseParams({ address: " x " }).address, p: parseParams({ address: "x" }).primary },
    { a: "x", p: true }
  );
  for (const v of ["false", "0", "other", "second"]) assert.equal(parseParams({ address: "x", primary: v }).primary, false, v);
  for (const v of [undefined, "true", "1", "yes"]) assert.equal(parseParams({ address: "x", primary: v }).primary, true, String(v));
  assert.equal(parseParams({ address: "x", price: "605,000" }).price, 605000);
  assert.equal(parseParams({ address: "x", price: "" }).price, null);
  assert.throws(() => parseParams({}), (e) => e instanceof ApiError && e.status === 400);
});

test("api match semantics: exact, nearest, approximate, ambiguous", () => {
  const exact = shape({ found: { ranked: [cand({ bucket: 2, a: 1, s: 1e6 + 1 })], how: "recorded address", point: null } });
  assert.equal(exact.match.quality, "exact");
  assert.equal(exact.match.needs_review, false);
  assert.equal(exact.match.note, null);
  assert.equal(exact.match.candidates.length, 0);

  const near = shape({});
  assert.equal(near.match.quality, "nearest");
  assert.equal(near.match.needs_review, true);
  assert.match(near.match.note, /No parcel in the state file carries exactly/);
  assert.match(near.match.note, /Confirm the parcel number/);
  assert.equal(near.match.geocoded.lat, 40.2334);

  const far = shape({ found: { ranked: [cand({ inside: false, m: 350, a: 0.62 })], how: "geocoded location", point: [-111.6667, 40.2334] } });
  assert.equal(far.match.quality, "approximate");
  assert.match(far.match.note, /about 350 m/);

  const amb = shape({
    found: {
      ranked: [cand({ inside: false, m: 30, a: 0.8 }), cand({ c: parcel({ PARCEL_ID: "040660010" }), inside: false, m: 60, a: 0.6 })],
      how: "geocoded location", point: [-111.6667, 40.2334]
    }
  });
  assert.equal(amb.match.ambiguous, true);
  assert.equal(amb.match.candidates.length, 2);
  assert.equal(amb.match.candidates[0].distance_m, 30);
  assert.equal(amb.match.candidates[1].parcel_id, "040660010");
  assert.equal(amb.match.needs_review, true, "an ambiguous api answer always asks for review");
});

test("api estimate: county value leads, price compares, per-entity dollars add up", () => {
  const r = shape({});
  assert.equal(r.estimate.basis, "county");
  assert.equal(r.estimate.market_value, 293500);
  assert.equal(r.estimate.taxable_share, 0.55);
  assert.equal(r.estimate.taxable_value, 161425);
  assert.equal(r.comparison.basis, "price");
  assert.equal(r.comparison.market_value, 400000);
  assert.ok(r.difference.monthly > 0 && Math.abs(r.difference.monthly - (r.comparison.monthly - r.estimate.monthly)) < 0.01);
  assert.ok(r.difference.pct > 30 && r.difference.pct < 40, "price sits well above the county roll here");
  const set = estimateSet({ price: 400000, countyValue: 293500, primary: true, rate: 0.008521 });
  assert.equal(r.estimate.equation, equationStrip(set.preferred));
  const school = r.entities.find((e) => e.kind === "School district");
  assert.equal(school.annual, Math.round(set.preferred.taxable * 0.006922 * 100) / 100);
  const water = r.entities.find((e) => e.rate === 0);
  assert.equal(water.annual, 0);
  assert.equal(r.levy_summary.bodies, 3);
  assert.equal(r.levy_summary.levying, 2);
  assert.equal(r.county_record.value_as_of, "2026-09-29");
  assert.match(r.sources.entities, /economy_tax_entities_2025/);
});

test("api occupancy: second home taxes 100%, and the seller's recorded status is surfaced", () => {
  const r = shape({ input: { address: "500 W Center St, Provo", price: 400000, primary: false } });
  assert.equal(r.estimate.taxable_share, 1);
  assert.equal(r.estimate.basis, "county");
  const fine = r.warnings.fine.join(" ");
  assert.match(fine, /records this parcel as a primary residence/);
  assert.match(fine, /follows your selection/);
});

test("api honesty rules: no value, missing roll, oversized lot", () => {
  const none = shape({ detail: null });
  assert.match(none.county_record.note, /publishes no value/);
  assert.equal(none.estimate.basis, "price");
  assert.ok(none.notes.some((n) => /does not publish a market value/.test(n)));
  assert.throws(() => shape({ detail: null, input: { address: "x", price: 0, primary: true } }),
    (e) => e instanceof ApiError && e.status === 400, "nothing to tax must be a 400, not a zero bill");
  const big = shape({ detail: roll({ PARCEL_ACRES: 2.4 }) });
  assert.ok(big.warnings.fine.some((w) => /2\.40 acres/.test(w) && /slightly low/.test(w)));
  assert.equal(big.parcel.acres, 2.4);
});

test("idMatches tolerates formatting, not coincidence", () => {
  assert.equal(idMatches("040660009", "040660009"), true);
  assert.equal(idMatches("40-660-009", "040660009"), true);
  assert.equal(idMatches("40660009", "040660009"), true, "leading zero dropped");
  assert.equal(idMatches("040660009", "040660019"), false);
  assert.equal(idMatches("", "040660009"), false);
});
