import { expect, test } from "bun:test";
import { buildOverlay, triageSourceDefinitions } from "../bin/build-definition-overlay.mjs";

test("builds one context-sensitive record per definition gap", () => {
  const graph = {
    metadata: { sourcePath: "book.md" }, validation: { status: "complete_with_gaps" },
    sourceUnits: [{ id: "u1", text: "A fusion rule is defined as a constraint on how charges combine.", context: ["Chapter 1 — Start"] }, { id: "u2", text: "Second use.", context: ["Chapter 2 — Next"] }],
    nodes: [
      { id: "g1", kind: "gap", gapType: "definition", fills: ["Fusion Rule"], need: "Define fusion rule", sourceUnitIds: ["u1"] },
      { id: "g2", kind: "gap", gapType: "definition", fills: ["Fusion Rule"], need: "Define fusion rule", sourceUnitIds: ["u2"] },
    ],
    concepts: [{ label: "Fusion Rule", gapNodes: ["g1", "g2"], requiredBy: ["n1", "n2"] }],
  };
  const overlay = triageSourceDefinitions(graph, buildOverlay(graph));
  expect(overlay.summary).toMatchObject({ definitionGapCount: 2, canonicalGroupCount: 2, unresolvedCount: 1, alreadyDefinedCount: 1 });
  expect(overlay.records.map((record) => record.gapId)).toEqual(["g1", "g2"]);
  expect(overlay.records.find((record) => record.gapId === "g1")).toMatchObject({ status: "already_defined", provenance: "source_definition_match", candidateSourceUnitIds: ["u1"] });
  expect(overlay.records.find((record) => record.gapId === "g2")).toMatchObject({ status: "unresolved", citations: [] });
});
