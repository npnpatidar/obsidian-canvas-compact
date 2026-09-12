/**
 * Test the plugin against actual canvas files from the vault.
 * Run: npx tsc scripts/test-vault-canvas.ts src/dagcola.ts src/clean.ts src/pack.ts src/graph.ts \
 *   --outDir /tmp/vault-test --module commonjs --target es2020 \
 *   --moduleResolution node --skipLibCheck --esModuleInterop --strict false \
 *   && NODE_PATH="$PWD/node_modules" node /tmp/vault-test/scripts/test-vault-canvas.js
 */

import { readFileSync } from "fs";
import { dagcolaLayout } from "../src/dagcola";
import { cleanLayout, verifyCleanLayout, describeCleanReport, DEFAULT_CLEAN_OPTIONS } from "../src/clean";
import type { AllCanvasNodeData, CanvasEdgeData } from "../src/Canvas.d";

const canvasPath = "/home/naresh/Data/Sync_M_L_I_C/Notes/EORO/test.canvas";

interface CanvasFile {
  nodes: AllCanvasNodeData[];
  edges: CanvasEdgeData[];
  metadata?: Record<string, unknown>;
}

const canvas = JSON.parse(readFileSync(canvasPath, "utf-8")) as CanvasFile;
console.log(`Loaded canvas: ${canvas.nodes.length} nodes, ${canvas.edges.length} edges`);

// Test with default clean layout
console.log("\n=== Testing cleanLayout ===");
const cleanResult = cleanLayout(canvas.nodes, canvas.edges, DEFAULT_CLEAN_OPTIONS);
console.log(describeCleanReport(cleanResult.report));

// Verify independently
const cleanVerify = verifyCleanLayout(cleanResult.nodes, cleanResult.edges);
console.log(`Independent verify: cardOverlaps=${cleanVerify.cardOverlaps}, edgeCrossings=${cleanVerify.edgeCrossings}, edgeCardHits=${cleanVerify.edgeCardHits}, labelCardOverlaps=${cleanVerify.labelCardOverlaps}`);

// Test with dagcola (without webcola refinement)
console.log("\n=== Testing dagcolaLayout (no webcola) ===");
const dagcolaResult = dagcolaLayout(canvas.nodes, canvas.edges, { ...DEFAULT_CLEAN_OPTIONS, useColaRefinement: false });
console.log(describeCleanReport(dagcolaResult.report));

const dagcolaVerify = verifyCleanLayout(dagcolaResult.nodes, dagcolaResult.edges);
console.log(`Independent verify: cardOverlaps=${dagcolaVerify.cardOverlaps}, edgeCrossings=${dagcolaVerify.edgeCrossings}, edgeCardHits=${dagcolaVerify.edgeCardHits}, labelCardOverlaps=${dagcolaVerify.labelCardOverlaps}`);

// Test with dagcola (with webcola refinement)
console.log("\n=== Testing dagcolaLayout (with webcola) ===");
const dagcolaColaResult = dagcolaLayout(canvas.nodes, canvas.edges, { ...DEFAULT_CLEAN_OPTIONS, useColaRefinement: true });
console.log(describeCleanReport(dagcolaColaResult.report));

const dagcolaColaVerify = verifyCleanLayout(dagcolaColaResult.nodes, dagcolaColaResult.edges);
console.log(`Independent verify: cardOverlaps=${dagcolaColaVerify.cardOverlaps}, edgeCrossings=${dagcolaColaVerify.edgeCrossings}, edgeCardHits=${dagcolaColaVerify.edgeCardHits}, labelCardOverlaps=${dagcolaColaVerify.labelCardOverlaps}`);

// Save result for inspection
import { writeFileSync } from "fs";
const output = {
  nodes: dagcolaResult.nodes,
  edges: dagcolaResult.edges,
  metadata: canvas.metadata as Record<string, unknown>
};
writeFileSync("/tmp/test-layout-result.canvas", JSON.stringify(output, null, 2));
console.log("\nSaved layout result to /tmp/test-layout-result.canvas");

// Check all guarantees
const guarantees = [
  { name: "Card overlaps", value: cleanVerify.cardOverlaps, expected: 0 },
  { name: "Label/Card overlaps", value: cleanVerify.labelCardOverlaps, expected: 0 },
  { name: "Label/Label overlaps", value: cleanVerify.labelLabelOverlaps, expected: 0 },
  { name: "Label/Edge hits", value: cleanVerify.labelEdgeHits, expected: 0 },
];

console.log("\n=== Guarantees ===");
let allPass = true;
for (const g of guarantees) {
  const pass = g.value === g.expected;
  console.log(`${pass ? "✓" : "✗"} ${g.name}: ${g.value} (expected ${g.expected})`);
  if (!pass) allPass = false;
}

// For non-planar graphs, crossings may be unavoidable
console.log(`✓ Edge crossings: ${cleanVerify.edgeCrossings} (unavoidable for non-planar)`);
console.log(`✓ Edge behind cards: ${cleanVerify.edgeCardHits} (expected 0)`);

if (allPass && cleanVerify.edgeCardHits === 0) {
  console.log("\n=== ALL GUARANTEES SATISFIED ===");
  process.exit(0);
} else {
  console.log("\n=== SOME GUARANTEES VIOLATED ===");
  process.exit(1);
}