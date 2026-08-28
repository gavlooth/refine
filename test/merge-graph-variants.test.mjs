import { expect, test } from "bun:test";
import { mergeGraphs } from "../bin/merge-graph-variants.mjs";

function variant(nodes, edges = []) {
  return { schemaVersion: "knowledge-graph/v3-cognitive-decompression", metadata: { sourceSha256: "same", salvageIssues: [] }, sourceUnits: [{ id: "u1", text: "Source." }], nodes, edges, evidenceFrames: [], concepts: [], unresolvedConcepts: [], validation: { status: "complete_with_gaps" } };
}

test("deduplicates shared nodes while retaining unique topology", () => {
  const first = variant([{ id: "a", kind: "claim", text: "Shared.", sourceUnitIds: ["u1"], defines: [], requires: [], mentions: [], fills: [] }, { id: "b", kind: "claim", text: "First.", sourceUnitIds: ["u1"], defines: [], requires: [], mentions: [], fills: [] }], [{ from: "a", to: "b", relation: "enables" }]);
  const second = variant([{ id: "x", kind: "claim", text: "Shared.", sourceUnitIds: ["u1"], defines: [], requires: [], mentions: [], fills: [] }, { id: "y", kind: "claim", text: "Second.", sourceUnitIds: ["u1"], defines: [], requires: [], mentions: [], fills: [] }], [{ from: "x", to: "y", relation: "supports" }]);
  const merged = mergeGraphs([first, second]);
  expect(merged.nodes.filter((node) => node.text === "Shared.")).toHaveLength(1);
  expect(merged.edges).toHaveLength(2);
  expect(merged.validation.errors).toEqual([]);
});
