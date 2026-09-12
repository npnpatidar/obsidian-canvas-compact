import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { dagcolaLayout } from "../src/dagcola";
import { cleanLayout, DEFAULT_CLEAN_OPTIONS, verifyCleanLayout, bboxArea } from "../src/clean";
import type { CleanReport } from "../src/clean";

type AnyNode = Record<string, unknown>;
type AnyEdge = Record<string, unknown>;
interface Canvas {
  nodes: AnyNode[];
  edges: AnyEdge[];
}
type Result = { nodes: AnyNode[]; edges: AnyEdge[]; report: CleanReport };

const root = process.argv[2]!;
const DIRS = ["top-to-bottom", "left-to-right", "balanced"] as const;
/** The Clean engine runs dozens of trials; skip it on very large canvases. */
const CLEAN_NODE_LIMIT = Number(process.env.CLEAN_LIMIT ?? 120);

function findCanvases(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === ".obsidian" || entry === ".trash" || entry === "node_modules") continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...findCanvases(p));
    else if (entry.endsWith(".canvas")) out.push(p);
  }
  return out;
}

function defects(r: CleanReport): number {
  return r.cardOverlaps + r.edgeCardHits + r.edgeCrossings + r.labelCardOverlaps + r.labelLabelOverlaps + r.labelEdgeHits;
}

/** Hard guarantees only: overlaps and hidden connections. Crossings are best-effort. */
function cleanLevel(r: CleanReport): string {
  if (r.cardOverlaps || r.edgeCardHits || r.labelCardOverlaps || r.labelLabelOverlaps || r.labelEdgeHits) {
    const bad: string[] = [];
    if (r.cardOverlaps) bad.push(`${r.cardOverlaps} overlap`);
    if (r.edgeCardHits) bad.push(`${r.edgeCardHits} hidden`);
    if (r.labelCardOverlaps) bad.push(`${r.labelCardOverlaps} lbl/card`);
    if (r.labelLabelOverlaps) bad.push(`${r.labelLabelOverlaps} lbl/lbl`);
    if (r.labelEdgeHits) bad.push(`${r.labelEdgeHits} lbl/edge`);
    return `NOT CLEAN (${bad.join(", ")})`;
  }
  return r.edgeCrossings ? `clean, ${r.edgeCrossings} crossing` : "perfect";
}

function verify(label: string, out: Result, input: Canvas): string[] {
  const problems: string[] = [];
  const ind = verifyCleanLayout(out.nodes as never[], out.edges as never[]);
  for (const k of ["cardOverlaps", "edgeCrossings", "edgeCardHits", "labelCardOverlaps", "labelLabelOverlaps", "labelEdgeHits"] as const) {
    if (ind[k] !== out.report[k]) problems.push(`${label}: report ${k} ${out.report[k]} != verified ${ind[k]}`);
  }
  const ids = new Set(input.nodes.map((n) => n.id));
  if (out.nodes.length !== input.nodes.length) problems.push(`${label}: node count ${out.nodes.length} != ${input.nodes.length}`);
  if (out.edges.length !== input.edges.length) problems.push(`${label}: edge count ${out.edges.length} != ${input.edges.length}`);
  for (const n of out.nodes) if (!ids.has(n.id)) problems.push(`${label}: unknown node ${String(n.id)}`);
  return problems;
}

const files = findCanvases(root).sort();
const problems: string[] = [];
const summary = {
  total: 0,
  alreadyClean: 0,
  dagcolaPerfect: 0,
  dagcolaHardClean: 0,
  cleanHardClean: 0,
  dagcolaBeatsCleanOnCrossings: 0,
  dagcolaBeatsCleanOnArea: 0,
  colaWon: 0,
  colaLost: 0,
};

for (const file of files) {
  const rel = file.slice(root.length + 1);
  let input: Canvas;
  try {
    input = JSON.parse(readFileSync(file, "utf8")) as Canvas;
  } catch (e) {
    problems.push(`${rel}: unreadable (${(e as Error).message})`);
    continue;
  }
  const cards = input.nodes.filter((n) => n.type !== "group").length;
  const groups = input.nodes.filter((n) => n.type === "group").length;
  console.log(`\n=== ${rel}  (${cards} cards, ${groups} groups, ${input.edges.length} connections)`);
  summary.total++;

  const before: CleanReport = {
    nodes: input.nodes.length,
    edges: input.edges.length,
    components: 0,
    crossingFreeComponents: 0,
    groups,
    ...verifyCleanLayout(input.nodes as never[], input.edges as never[]),
  };
  console.log(`  as authored      ${cleanLevel(before)}`);
  if (before.cardOverlaps === 0 && before.edgeCardHits === 0) summary.alreadyClean++;

  // DagCola in every orientation, refinement on.
  const dagResults: { dir: string; out: Result }[] = [];
  for (const direction of DIRS) {
    const t0 = Date.now();
    let out: Result;
    try {
      out = dagcolaLayout(input.nodes as never[], input.edges as never[], {
        ...DEFAULT_CLEAN_OPTIONS,
        direction,
        useColaRefinement: true,
      });
    } catch (e) {
      problems.push(`${rel} [${direction}]: THREW ${(e as Error).message}`);
      console.log(`  dagcola ${direction.padEnd(14)} THREW ${(e as Error).message}`);
      continue;
    }
    problems.push(...verify(`dagcola ${direction}`, out, input));
    console.log(
      `  dagcola ${direction.padEnd(14)} ${cleanLevel(out.report).padEnd(28)} area=${String(Math.round(bboxArea(out.nodes as never[]))).padStart(9)} ${Date.now() - t0}ms`
    );
    dagResults.push({ dir: direction, out });
  }

  const best = dagResults.reduce<(typeof dagResults)[number] | null>(
    (a, b) => (!a ? b : b.out.report.edgeCardHits < a.out.report.edgeCardHits ||
      (b.out.report.edgeCardHits === a.out.report.edgeCardHits && b.out.report.edgeCrossings < a.out.report.edgeCrossings)
      ? b : a),
    null
  );
  if (best) {
    if (best.out.report.edgeCrossings === 0 && defects(best.out.report) === 0) summary.dagcolaPerfect++;
    if (defects(best.out.report) === 0 || (best.out.report.cardOverlaps === 0 && best.out.report.edgeCardHits === 0 && best.out.report.labelCardOverlaps === 0 && best.out.report.labelLabelOverlaps === 0 && best.out.report.labelEdgeHits === 0)) summary.dagcolaHardClean++;
  }

  // webcola's contribution on the default orientation.
  try {
    const off = dagcolaLayout(input.nodes as never[], input.edges as never[], {
      ...DEFAULT_CLEAN_OPTIONS,
      direction: "top-to-bottom",
      useColaRefinement: false,
    });
    const on = dagResults.find((d) => d.dir === "top-to-bottom")?.out;
    if (on) {
      const aOn = bboxArea(on.nodes as never[]);
      const aOff = bboxArea(off.nodes as never[]);
      const better = defects(on.report) < defects(off.report) || (defects(on.report) === defects(off.report) && aOn < aOff);
      if (better) summary.colaWon++;
      else if (defects(on.report) > defects(off.report) || aOn > aOff) summary.colaLost++;
      console.log(
        `  webcola on/off   refin ${aOff === aOn ? "same" : `${aOn < aOff ? "smaller" : "larger"} ${Math.round(aOff)}->${Math.round(aOn)}`}, defects ${defects(off.report)}->${defects(on.report)}`
      );
    }
  } catch (e) {
    problems.push(`${rel} [webcola off]: THREW ${(e as Error).message}`);
  }

  // Clean engine baseline.
  if (cards <= CLEAN_NODE_LIMIT) {
    const t0 = Date.now();
    try {
      const cl = cleanLayout(input.nodes as never[], input.edges as never[], DEFAULT_CLEAN_OPTIONS);
      problems.push(...verify("clean", cl, input));
      const hardClean = cl.report.cardOverlaps === 0 && cl.report.edgeCardHits === 0 &&
        cl.report.labelCardOverlaps === 0 && cl.report.labelLabelOverlaps === 0 && cl.report.labelEdgeHits === 0;
      if (hardClean) summary.cleanHardClean++;
      console.log(
        `  clean engine     ${cleanLevel(cl.report).padEnd(28)} area=${String(Math.round(bboxArea(cl.nodes as never[]))).padStart(9)} ${Date.now() - t0}ms`
      );
      if (best) {
        if (best.out.report.edgeCrossings < cl.report.edgeCrossings) summary.dagcolaBeatsCleanOnCrossings++;
        if (bboxArea(best.out.nodes as never[]) < bboxArea(cl.nodes as never[])) summary.dagcolaBeatsCleanOnArea++;
      }
    } catch (e) {
      problems.push(`${rel} [clean]: THREW ${(e as Error).message}`);
    }
  } else {
    console.log(`  clean engine     skipped (${cards} cards > ${CLEAN_NODE_LIMIT})`);
  }
}

console.log("\n================ SUMMARY ================");
console.log(JSON.stringify(summary, null, 2));
if (problems.length) {
  console.log(`\n${problems.length} PROBLEM(S):`);
  for (const p of problems) console.log(`  ✗ ${p}`);
} else {
  console.log("\nno verification, identity, or crash problems");
}
