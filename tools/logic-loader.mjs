// Loads the pure-logic block out of the shipped HTML file, so tests exercise exactly what the page runs.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
export const HTML_PATH = path.join(here, "..", "utah-property-tax-estimator.html");

export async function loadLogic(htmlPath = HTML_PATH) {
  const html = await readFile(htmlPath, "utf8");
  const m = html.match(/<script id="logic">([\s\S]*?)<\/script>/);
  if (!m) throw new Error("no <script id=\"logic\"> block found in " + htmlPath);
  const src = m[1]
    .replace(/if \(typeof module !== "undefined"\)[\s\S]*$/m, "")
    .trim();
  const names = [...src.matchAll(/^function\s+([A-Za-z0-9_]+)/gm)].map((x) => x[1]);
  const consts = [...src.matchAll(/^(?:var|const|let)\s+([A-Za-z0-9_]+)/gm)].map((x) => x[1]);
  const body = src + "\nreturn {" + [...new Set([...names, ...consts])].join(", ") + "};" ;
  return new Function("module", body)({ exports: {} });
}
