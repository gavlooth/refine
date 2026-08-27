import { expect, test } from "bun:test";
import { applyDecomposition, applyDensityScores, denseCandidates, surfaceDensityScore, validatePlan, validateScores } from "../bin/decompress.mjs";

function graphFixture() {
  return {
    schemaVersion: "knowledge-graph/v3-cognitive-decompression",
    metadata: {},
    sourceUnits: [{ id: "u1", kind: "prose", text: "Dense source text.", hash: "x" }],
    nodes: [
      { id: "n1", kind: "claim", text: "This source claim contains several independent ideas that require explanation before a later reader can apply it correctly.", sourceUnitIds: ["u1"], defines: [], requires: [], mentions: [], fills: [], origin: "source" },
      { id: "n2", kind: "gap", text: null, need: "Missing context.", gapType: "context", sourceUnitIds: ["u1"], defines: [], requires: [], mentions: [], fills: [], origin: "gap" },
      { id: "n3", kind: "equation", text: "x = y", sourceUnitIds: ["u1"], defines: [], requires: [], mentions: [], fills: [], origin: "source" },
    ],
    edges: [], evidenceFrames: [], concepts: [], unresolvedConcepts: [], validation: null,
  };
}

test("uses model scores for natural language and structural scores elsewhere", () => {
  const graph = graphFixture();
  const scores = validateScores({ scores: [{ id: "n1", score: 0.88, reasons: ["two causal steps"] }] }, [graph.nodes[0]]);
  const applied = applyDensityScores(graph, scores);
  expect(applied.graph.nodes[0]).toMatchObject({ densityScore: 0.88, densitySource: "model", densityReasons: ["two causal steps"] });
  expect(applied.graph.nodes[1]).toMatchObject({ densityScore: 0, densitySource: "structural" });
  expect(applied.graph.nodes[2]).toMatchObject({ densityScore: 1, densitySource: "protected" });
  expect(surfaceDensityScore(graph.nodes[0])).toBeGreaterThan(0);
  expect(denseCandidates(applied.graph).map((node) => node.id)).toEqual(["n1"]);
});

test("adds source splits and explicitly model-derived expansions", () => {
  const graph = graphFixture();
  const scored = applyDensityScores(graph, new Map([["n1", { score: 0.9, reasons: [] }]])).graph;
  const candidates = denseCandidates(scored);
  const plan = validatePlan({ items: [{ parentId: "n1", splits: [{ text: "The source has a first idea.", densityScore: 0.2 }, { text: "The source has a second idea.", densityScore: 0.3 }], expansions: [{ type: "definition", text: "A prerequisite term has a precise meaning.", densityScore: 0.25 }] }] }, candidates);
  const expanded = applyDecomposition(scored, plan, candidates, { modelScoredNodeCount: 1, fallbackScoreCount: 0, densityIssues: [] });
  const split = expanded.nodes.find((node) => node.decompositionRole === "split");
  const expansion = expanded.nodes.find((node) => node.decompositionRole === "knowledge_expansion");
  expect(split).toMatchObject({ origin: "decomposition", derivedFrom: "n1", sourceUnitIds: ["u1"], densityScore: 0.2, densitySource: "model" });
  expect(expansion).toMatchObject({ origin: "expansion", derivedFrom: "n1", sourceUnitIds: [], expansionType: "definition", epistemicStatus: "model_expansion", densityScore: 0.25, densitySource: "model" });
  expect(expanded.metadata.cognitiveDecomposition).toMatchObject({ splitCount: 2, expansionCount: 1, modelScoredNodeCount: 1 });
  expect(expanded.nodes.every((node) => typeof node.densityScore === "number")).toBe(true);
});
