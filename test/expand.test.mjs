import { expect, test } from "bun:test";
import { applyExpansion, expansionTargets, validatePlan } from "../bin/expand.mjs";

function graphFixture() {
  return {
    schemaVersion: "knowledge-graph/v3-cognitive-decompression",
    metadata: {},
    sourceUnits: [{ id: "u1", kind: "prose", text: "A source claim.", hash: "x" }],
    nodes: [
      { id: "n1", kind: "claim", text: "A source claim needs additional context to be understood by a later reader.", sourceUnitIds: ["u1"], defines: [], requires: [], mentions: [], fills: [], origin: "source", densityScore: 0.7 },
      { id: "n2", kind: "gap", text: null, need: "Explain the missing mechanism.", gapType: "mechanism", sourceUnitIds: ["u1"], defines: [], requires: [], mentions: [], fills: [], origin: "gap", densityScore: 0 },
    ],
    edges: [], evidenceFrames: [], concepts: [], unresolvedConcepts: [], validation: null,
  };
}

test("selects unresolved gaps and detail candidates", () => {
  const graph = graphFixture();
  expect(expansionTargets(graph).map((node) => node.id)).toEqual(["n2", "n1"]);
  expect(expansionTargets(graph, { gapsOnly: true }).map((node) => node.id)).toEqual(["n2"]);
});

test("injects knowledge, fills gaps, and preserves provenance boundaries", () => {
  const graph = graphFixture();
  const targets = expansionTargets(graph);
  const plan = validatePlan({ items: [
    { targetId: "n2", injections: [{ type: "mechanism", text: "The mechanism connects the first process to the observed effect.", densityScore: 0.25, relation: "fills", reason: "answers the missing mechanism" }] },
    { targetId: "n1", injections: [{ type: "context", text: "The context states when the source claim is useful.", densityScore: 0.2, relation: "elaborates", reason: "adds application context" }] },
  ] }, targets);
  const expanded = applyExpansion(graph, plan, targets, { expansionIssues: [] });
  const gap = expanded.nodes.find((node) => node.id === "n2");
  const injected = expanded.nodes.filter((node) => node.origin === "injection");
  expect(injected).toHaveLength(2);
  expect(injected[0]).toMatchObject({ kind: "injection", sourceUnitIds: [], epistemicStatus: "model_injected", densitySource: "model" });
  expect(gap).toMatchObject({ resolutionStatus: "model_injected" });
  expect(gap.resolvedBy).toHaveLength(1);
  expect(expanded.edges).toContainEqual(expect.objectContaining({ to: "n2", relation: "fills", origin: "injection" }));
  expect(expanded.metadata.graphExpansion).toMatchObject({ injectionCount: 2, resolvedGapCount: 1 });
});
