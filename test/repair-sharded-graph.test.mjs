import { expect, test } from "bun:test";
import { combineExtractions, fallbackExtraction } from "../bin/repair-sharded-graph.mjs";

test("combines shard-local indexes without collisions", () => {
  const first = { nodes: [{ text: "a" }, { text: "b" }], edges: [{ from: 0, to: 1, relation: "enables" }], evidenceFrames: [{ claim: 1, evidence: [0], warrantGap: null, limitations: [] }] };
  const second = { nodes: [{ text: "c" }, { text: "d" }], edges: [{ from: 0, to: 1, relation: "supports" }], evidenceFrames: [{ claim: 1, evidence: [0], warrantGap: null, limitations: [0] }] };
  const combined = combineExtractions([first, second]);
  expect(combined.nodes).toHaveLength(4);
  expect(combined.edges[1]).toMatchObject({ from: 2, to: 3 });
  expect(combined.evidenceFrames[1]).toMatchObject({ claim: 3, evidence: [2], limitations: [2] });
});

test("preserves exact source text when semantic repair cannot split further", () => {
  const fallback = fallbackExtraction({ id: "c1", units: [{ id: "u1", kind: "prose", text: "Exact source text." }] }, new Error("timeout"));
  expect(fallback.nodes[0]).toMatchObject({ text: "Exact source text.", sourceUnitIds: ["u1"], annotations: ["repair_source_fallback"] });
  expect(fallback.nodes[1]).toMatchObject({ kind: "gap", text: null, gapType: "parsing_error", annotations: ["repair_parsing_error"] });
});
