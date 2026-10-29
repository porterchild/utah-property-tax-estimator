// Runs the app script exactly as the shipped HTML does, in a stand-in DOM, against the live services.
import { readFile } from "node:fs/promises";
import { HTML_PATH } from "./logic-loader.mjs";
import { createDom } from "./dom-stub.mjs";

export async function runApp(htmlPath = HTML_PATH) {
  const html = await readFile(htmlPath, "utf8");
  const logic = html.match(/<script id="logic">([\s\S]*?)<\/script>/);
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (!logic || !blocks.length) throw new Error("no <script id=\"logic\"> and app <script> blocks in " + htmlPath);
  const dom = createDom();
  // The stub never parses the page body, so give the inputs the values the markup gives them.
  for (const tag of html.match(/<input\b[^>]*>/g) || []) {
    const id = (tag.match(/\bid="([^"]+)"/) || [])[1];
    if (!id) continue;
    const value = (tag.match(/\bvalue="([^"]*)"/) || [])[1];
    if (value != null) dom.el(id).value = value;
    dom.el(id).checked = /\bchecked\b/.test(tag);
  }
  const fn = new Function("document", "window", "navigator", "fetch", "URLSearchParams", "setTimeout", "Promise",
    logic[1] + "\n" + blocks[blocks.length - 1]);
  fn(dom.document, dom.window, dom.navigator, globalThis.fetch, globalThis.URLSearchParams, globalThis.setTimeout, globalThis.Promise);
  return dom;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Waits until a lookup settles. Any in-progress status keeps us polling; an error status or a
   repainted result panel ends it. */
const IN_PROGRESS = /loading|finding|reading|searching/i;
const FAILED = /no parcel|could not|no tax rates|try again|^enter |include the house|cannot be read/i;
export async function settle(dom, { timeoutMs = 60000 } = {}) {
  const start = Date.now();
  const mark = dom.el("result").innerHTML;
  let last = null, stable = 0;
  while (Date.now() - start < timeoutMs) {
    const status = dom.el("status").textContent;
    if (status && FAILED.test(status)) return { kind: "error", status };
    if (!status) {
      const html = dom.el("result").innerHTML;
      if (!dom.el("candidates").hidden && html === mark) return { kind: "ambiguous" };
      if (html !== mark && /Where the tax goes/.test(html)) {
        stable = html === last ? stable + 1 : 0;
        last = html;
        if (stable >= 2) return { kind: "result" };
      }
    }
    await sleep(150);
  }
  return { kind: "timeout" };
}

export function strip(html) { return String(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }

export async function lookup(dom, { address, price = "600,000", primary = true } = {}) {
  // Clear any repaint still in flight from the previous lookup so the panel we read is this one's.
  await sleep(600);
  dom.el("result").innerHTML = "";
  dom.el("status").textContent = "";
  dom.el("candidates").innerHTML = "";
  dom.el("candidates").hidden = true;
  const before = dom.el("result").innerHTML;
  dom.el("addr").value = address;
  dom.el("price").value = price;
  dom.el("occ-primary").checked = primary;
  dom.el("occ-other").checked = !primary;
  dom.fire("form", "submit");
  const t0 = Date.now();
  const done = await settle(dom, { timeoutMs: 90000 });
  /* The county's own parcel record (market value, class, recorded occupancy) arrives in a
     second request after the rates, so wait for it before handing the panel back. */
  const detailStart = Date.now();
  while (Date.now() - detailStart < 8000 && !/County record/.test(dom.el("result").innerHTML)) {
    await sleep(400);
  }
  done.detailWaitMs = Date.now() - detailStart;
  done.ms = Date.now() - t0;
  done.status = dom.el("status").textContent || done.status || "";
  done.text = strip(dom.el("result").innerHTML);
  done.html = dom.el("result").innerHTML;
  done.changed = dom.el("result").innerHTML !== before;
  done.ambiguous = !dom.el("candidates").hidden;
  done.candidates = dom.el("candidates").children.length;
  return done;
}

/* Pulls the numbers out of the rendered panel so a smoke test can assert on what a user sees. */
export function readout(text) {
  const grab = (re) => (text.match(re) || [])[1] || null;
  return {
    monthly: grab(/\$([\d,]+\.\d\d)\s*\/\s*mo/),
    annual: grab(/Annual tax \$([\d,]+\.\d\d)/),
    taxable: grab(/Taxable value \$([\d,]+)/),
    rate: grab(/Combined rate ([\d.]+)/),
    year: grab(/tax year (\d{4}|unknown)/),
    entities: grab(/(\d+) of \d+ bodies levy/),
    entitiesHere: grab(/of (\d+) bodies levy/),
    basis: grab(/on (the county assessor's value on record|the purchase price you entered) of/),
    valueUsed: grab(/Market value used\s+\$([\d,]+)/),
    countyValue: grab(/County record: market value \$([\d,]+)/),
    countyClass: grab(/County record:[^·]*· classified ([^·]+?)(?: · |$)/),
    recordedOcc: /County record:[^\n]*not a primary residence/.test(text) ? "not primary" : (/County record:[^\n]*primary residence/.test(text) ? "primary" : null),
    terms: ["Market value used", "Taxable share", "Taxable value", "Combined rate", "Annual tax", "Monthly"]
      .filter((label) => text.indexOf(label) >= 0).length,
    parcel: grab(/Parcel ([\w:-]+)/),
    county: grab(/([A-Z][a-z]+(?: [A-Z][a-z]+)*) County/),
    rows: (text.match(/· (School district|City or town|County levy|Library|Water district|Sewer district|Fire district|Vector control|Special service district|Infrastructure district|Metropolitan district|Tax-increment area|Other local levy|Special district|Statewide or multi-county levy)/g) || []).length,
    warns: (text.match(/This parcel|This is the parcel|No parcel in the state file|That is unusual|No school|No county|Enter a purchase|slightly low|closest|You picked|before believing|classifies this parcel|records this parcel as|does not publish a market value/g) || []).length,
    excluded: /Not in this number:/.test(text),
    occupancyNote: /seller's own occupancy/.test(text)
  };
}
