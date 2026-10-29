/* Prints the panel the shipped app renders for one lookup, so a human can eyeball the wording.
   Usage: node tools/dump-panel.mjs ["500 W Center St, Provo"] [price] [other] */
import { runApp, lookup, strip } from "./app-runner.mjs";

const address = process.argv[2] || "500 W Center St, Provo, UT";
const price = process.argv[3] || "605,000";
const primary = !(process.argv[4] === "other" || process.argv[4] === "secondary");

const dom = await runApp();
const res = await lookup(dom, { address, price, primary });
console.log(strip(res.html || dom.el("result").innerHTML));
if (res.ambiguous) console.log("\n[picker shown, " + (res.candidates) + " parcels to choose from]\n" + strip(dom.el("candidates").innerHTML));
console.log("\n--- formula ---\n" + dom.el("formula").textContent);
console.log("--- status:", JSON.stringify(res.status), "kind:", res.kind, "in", (res.ms / 1000).toFixed(1) + "s");
