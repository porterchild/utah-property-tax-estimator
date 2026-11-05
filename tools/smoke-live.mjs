/* Live smoke test: drives the real app script (from the shipped HTML) through a set of lookups and
   asserts the panel it renders is sane. Usage: node tools/smoke-live.mjs */
import { runApp, lookup, readout } from "./app-runner.mjs";

const CASES = [
  { address: "500 W Center St, Provo, UT", price: "600,000", why: "named street, county seat" },
  { address: "175 N Main St, Tooele", price: "450,000", why: "downtown lot, exact address not on record", expect: "ambiguous" },
  { address: "810 S 900 E, Salt Lake City", price: "1,200,000", primary: false, why: "grid address, no parcel on the corner", expect: "ambiguous" },
  { address: "458660128", price: "700,000", why: "Utah County parcel number" },
  { address: "2389 Washington Blvd, Ogden, UT", price: "380,000", why: "Weber, building with units" },
  { address: "1330 W Sunset Blvd, St. George", price: "525,000", why: "Washington County, dashed ids" },
  { address: "1000 N 400 E, Bountiful", price: "475,000", why: "Davis, grid with city" },
  { address: "1300 Kearns Blvd, Park City, UT", price: "1,750,000", why: "Summit, condo-style ids" },
  { address: "1299 Kearny Blvd, Park City", price: "1,750,000", why: "misspelt street degrades gracefully", expect: "ambiguous" },
  { address: "15 N Main St, Garland, UT", price: "400,000", why: "wrong-town exact match must shout", expect: "place" },
  { address: "9999 Nowhere Zz Rd, Monticello", price: "200,000", why: "address that does not exist", expect: "miss" },
  { address: "12345678901234", price: "200,000", why: "parcel number that does not exist", expect: "miss" }
];

const dom = await runApp();
let fails = 0;
const head = (s) => console.log("\n" + s + "\n" + "-".repeat(s.length));
head("live lookups through the shipped app script");
console.log("address                                  what we are checking        parcel              county        rate     year  bodies  monthly  value used");

for (const c of CASES) {
  const r = await lookup(dom, c);
  const o = readout(r.text || "");
  let bad;
  if (c.expect === "place") {
    // The bug a real user found: an exact street string in a neighbouring town, typed city Garland.
    // Either the picker opens (cities are visible on each choice) or the answer carries the place
    // warning at top level. A silent exact match is a regression.
    const shouts = r.kind === "ambiguous" || /place on the parcel record does not match/.test(r.text || "");
    console.log((shouts ? "ok  " : "FAIL") + "  " + c.address.padEnd(40) + " " + c.why.padEnd(27) + (r.kind === "ambiguous" ? "picker with " + r.candidates + " options" : "auto-picked, " + (shouts ? "place warning shown" : "NO WARNING — silent wrong town")));
    if (!shouts) { fails++; console.log("       ↳ problem: exact street string across towns passed without review"); }
    continue;
  }
  if (c.expect === "miss") {
    bad = r.kind === "result" && Number(o.rate) > 0 ? "expected no match, got rate " + o.rate : null;
    if (r.kind === "ambiguous") bad = "expected no match, got " + r.candidates + " candidates";
    console.log((bad ? "FAIL" : "ok  ") + "  " + c.address.padEnd(40) + " " + (r.kind === "error" ? "no match, said: " + r.status.slice(0, 46) : r.kind));
  } else {
    const rate = Number(o.rate);
    bad = r.kind === "ambiguous" && c.expect !== "ambiguous" ? "asked the user to choose from " + r.candidates + " parcels"
      : r.kind === "ambiguous" ? null
      : r.kind !== "result" ? r.kind + (r.status ? ": " + r.status : "")
      : !(rate > 0.002 && rate < 0.03) ? "combined rate out of range: " + o.rate
      : !(Number(o.entities) >= 3) ? "too few taxing bodies: " + o.entities
      : o.year !== "2025" ? "unexpected rate year: " + o.year
      : !o.parcel ? "no parcel id in the panel"
      : !/How each term works/.test(r.text) ? "the equation is not shown"
      : o.terms < 6 ? "equation terms missing (" + o.terms + " of 6)"
      : !o.basis ? "the panel does not say which value the figure uses"
      : !o.excluded ? "no note about what the figure leaves out"
      : !o.occupancyNote ? "no note about occupancy changing between seller and buyer" : null;
    const used = o.valueUsed ? "$" + o.valueUsed + (o.countyValue ? " (county $" + o.countyValue + ")" : " (price)") : "-";
    console.log((bad ? "FAIL" : "ok  ") + "  " + c.address.padEnd(40) + " " + c.why.padEnd(27) +
      String(o.parcel || "-").padEnd(20) + String(o.county || "-").slice(0, 12).padEnd(14) +
      String(o.rate || "-").padEnd(9) + String(o.year || "-").padEnd(6) + String(o.entities || "-").padEnd(7) +
      ("$" + (o.monthly || "?")).padEnd(10) + used);
    if (r.kind === "ambiguous") console.log("       ↳ asked the user to choose among " + r.candidates + " parcels, none recorded that exact address");
    if (o.warns) {
      const notes = r.text.match(/(No parcel in the state file|This parcel|This is the parcel|You picked|Check the parcel|slightly low|Enter a purchase|before believing|classifies this parcel|records this parcel as)[^.]*\./g);
      console.log("       ↳ " + (notes ? notes.join(" ").replace(/^\s+/, "") : "warnings shown"));
    }
  }
  if (bad) { fails++; console.log("       ↳ problem: " + bad); }
}

head(fails ? fails + " of " + CASES.length + " cases failed" : "all " + CASES.length + " cases produced a sane panel");
process.exit(fails ? 1 : 0);
