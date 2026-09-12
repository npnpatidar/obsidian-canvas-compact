import { readFileSync } from "node:fs";
import { cleanLayout, DEFAULT_CLEAN_OPTIONS, bboxArea } from "../src/clean";

const c = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as { nodes: never[]; edges: never[] };
const t0 = Date.now();
const out = cleanLayout(c.nodes, c.edges, DEFAULT_CLEAN_OPTIONS);
console.log(
  `clean engine finished in ${((Date.now() - t0) / 1000).toFixed(1)}s — crossings=${out.report.edgeCrossings} hidden=${out.report.edgeCardHits} overlaps=${out.report.cardOverlaps} area=${Math.round(bboxArea(out.nodes))}`
);
