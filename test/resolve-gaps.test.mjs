import { expect, test } from "bun:test";
import { applyResolution, gapClass, unresolvedGaps, validatePlan } from "../bin/resolve-gaps.mjs";

function graphFixture() {
  return {
    schemaVersion: "knowledge-graph/v3-cognitive-decompression",
    metadata: {},
    sourceUnits: [{ id: "u1", kind: "prose", text: "A source statement defines the mechanism.", hash: "x" }],
    nodes: [
      { id: "g1", kind: "gap", text: null, need: "Recover the missing source statement.", gapType: "parsing_error", sourceUnitIds: ["u1"], defines: [], requires: [], mentions: [], fills: [], origin: "gap", densityScore: 0 },
      { id: "g2", kind: "gap", text: null, need: "Define the mechanism.", gapType: "missing_definition", sourceUnitIds: ["u1"], defines: [], requires: [], mentions: [], fills: [], origin: "gap", densityScore: 0 },
      { id: "g3", kind: "gap", text: null, need: "artifact storage metadata", gapType: "metadata", sourceUnitIds: [], defines: [], requires: [], mentions: [], fills: [], origin: "gap", densityScore: 0 },
    ],
    edges: [], evidenceFrames: [], concepts: [], unresolvedConcepts: [], validation: null,
  };
}

test("classifies unresolved gaps by resolution evidence", () => {
  expect(gapClass({ gapType: "parsing_error" })).toBe("parsing_error");
  expect(gapClass({ gapType: "missing_definition" })).toBe("missing_definition");
  expect(gapClass({ gapType: "missing_reference" })).toBe("missing_reference");
  expect(unresolvedGaps(graphFixture()).map((target) => target.gapClass)).toEqual(["parsing_error", "missing_definition", "metadata"]);
});

test("keeps source recovery distinct from model-derived definitions", () => {
  const graph = graphFixture();
  const targets = unresolvedGaps(graph);
  const recoveryTargets = targets.filter((target) => target.gapClass === "parsing_error");
  const definitionTargets = targets.filter((target) => target.gapClass === "missing_definition");
  const recovery = validatePlan({ items: [{ gapId: "g1", nodes: [{ text: "The source defines the mechanism.", densityScore: 0.2 }] }] }, recoveryTargets, true);
  const definitions = validatePlan({ items: [{ gapId: "g2", nodes: [{ text: "A mechanism explains how one process produces another.", densityScore: 0.25, confidence: "high" }] }] }, definitionTargets, false);
  const resolved = applyResolution(graph, [...recovery, ...definitions], targets, { resolutionIssues: [] });
  const sourceRecovery = resolved.nodes.find((node) => node.origin === "recovery");
  const injection = resolved.nodes.find((node) => node.origin === "injection");
  expect(sourceRecovery).toMatchObject({ sourceUnitIds: ["u1"], epistemicStatus: "source_recovery", recoveryClass: "parsing_error" });
  expect(injection).toMatchObject({ sourceUnitIds: [], epistemicStatus: "model_injected", recoveryClass: "missing_definition", confidence: "high" });
  expect(resolved.nodes.find((node) => node.id === "g1")).toMatchObject({ resolutionStatus: "source_recovery" });
  expect(resolved.nodes.find((node) => node.id === "g2")).toMatchObject({ resolutionStatus: "model_injected" });
  expect(resolved.nodes.find((node) => node.id === "g3")).toMatchObject({ resolutionStatus: "not_knowledge" });
  expect(resolved.edges.filter((edge) => edge.relation === "fills")).toHaveLength(2);
});
