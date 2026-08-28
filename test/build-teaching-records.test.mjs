import { expect, test } from "bun:test";
import { buildTeachingRecords } from "../bin/build-teaching-records.mjs";

test("creates one immutable record per source node and requires expansion for dense nodes", () => {
  const graph = { metadata: { sourcePath: "source.md" }, sourceUnits: [{ id: "u1", context: ["Chapter 1 — Start"] }], nodes: [
    { id: "n1", kind: "claim", text: "Atomic idea.", sourceUnitIds: ["u1"], densityScore: 0.2, defines: [], requires: [] },
    { id: "n2", kind: "claim", text: "Several compressed ideas.", sourceUnitIds: ["u1"], densityScore: 0.9, defines: [], requires: [] },
    { id: "g1", kind: "gap", text: null, gapType: "definition", need: "Define it.", sourceUnitIds: ["u1"] },
  ], edges: [{ from: "n1", to: "n2", relation: "enables" }] };
  const output = buildTeachingRecords(graph);
  expect(output.summary).toMatchObject({ recordCount: 2, denseRecordCount: 1, pendingRecordCount: 1, gapCount: 1 });
  expect(output.records[0]).toMatchObject({ sourceAnchor: "Atomic idea.", status: "source_ready", minimumTeachingUnits: 1 });
  expect(output.records[1]).toMatchObject({ sourceAnchor: "Several compressed ideas.", status: "expansion_required", minimumTeachingUnits: 2, teachingUnits: [] });
  expect(output.dependencies).toEqual([expect.objectContaining({ from: "teach-n1", to: "teach-n2" })]);
});
