import { describe, expect, test } from "bun:test";
import {
  GRAPH_SCHEMA_VERSION,
  addCoverageFallbacks,
  assembleGraph,
  buildChunks,
  normalizeConcept,
  parseJsonValue,
  parseSourceUnits,
  reconcileConcepts,
  serializableGraph,
  validateExtraction,
  validateGraph,
} from "../bin/refine.mjs";

function sourceNode(unit, overrides = {}) {
  return {
    kind: "claim",
    text: unit.text,
    sourceUnitIds: [unit.id],
    sourceQuote: "",
    defines: [],
    requires: [],
    mentions: [],
    fills: [],
    need: "",
    gapType: null,
    origin: "source",
    chunkId: "c0001",
    ...overrides,
  };
}

describe("source units and chunks", () => {
  test("keeps code, equations, and one-line details as independent units", () => {
    const source = `# Topic

Before.

\`\`\`js
const value = 1;
\`\`\`

$$
x^2
$$

<details><summary>Answer</summary>Done.</details>

After.`;
    const units = parseSourceUnits(source);
    expect(units.map((unit) => unit.kind)).toEqual(["heading", "prose", "code", "equation", "details", "prose"]);
    expect(units.at(-1).text).toBe("After.");
    expect(units.find((unit) => unit.kind === "code").text).toContain("const value = 1;");
  });

  test("never slices an oversized source unit", () => {
    const units = parseSourceUnits(`\`\`\`text\n${"x".repeat(500)}\n\`\`\``);
    const chunks = buildChunks(units, 50);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].units).toHaveLength(1);
    expect(chunks[0].units[0].text).toBe(units[0].text);
  });
});

describe("extraction validation", () => {
  test("retains model concepts and semantic edges", () => {
    const units = parseSourceUnits("A spectral operator is defined.\n\nIts spectrum controls the solution.");
    const chunk = { id: "c0001", context: [], units };
    const extraction = validateExtraction({
      nodes: [
        { kind: "definition", text: "A spectral operator is defined.", sourceUnitIds: [units[0].id], sourceQuote: "A spectral operator", defines: ["Spectral Operator"], requires: [], mentions: [], origin: "source" },
        { kind: "claim", text: "Its spectrum controls the solution.", sourceUnitIds: [units[1].id], sourceQuote: "Its spectrum", defines: [], requires: ["spectral operator"], mentions: ["spectrum"], origin: "source" },
      ],
      edges: [{ from: 0, to: 1, relation: "enables", reason: "definition before use" }],
      evidenceFrames: [],
    }, chunk);
    expect(extraction.nodes[1].requires).toEqual(["spectral operator"]);
    expect(extraction.edges).toEqual([{ from: 0, to: 1, relation: "enables", reason: "definition before use" }]);
  });

  test("rejects ungrounded source quotes", () => {
    const units = parseSourceUnits("Grounded text.");
    const chunk = { id: "c0001", context: [], units };
    expect(() => validateExtraction({
      nodes: [{ kind: "claim", text: "Claim.", sourceUnitIds: [units[0].id], sourceQuote: "invented quote", defines: [], requires: [], mentions: [], origin: "source" }],
      edges: [],
      evidenceFrames: [],
    }, chunk)).toThrow("sourceQuote is not present");
  });

  test("accepts empty typed gaps and evidence frames", () => {
    const units = parseSourceUnits("The measurement supports the claim.");
    const chunk = { id: "c0001", context: [], units };
    const extraction = validateExtraction({
      nodes: [
        { kind: "evidence", text: "A measurement was observed.", sourceUnitIds: [units[0].id], sourceQuote: "measurement", defines: [], requires: [], mentions: [], fills: [], need: "", gapType: null, origin: "source" },
        { kind: "gap", text: null, sourceUnitIds: [units[0].id], sourceQuote: "", defines: [], requires: [], mentions: [], fills: [], need: "Explain why the measurement supports the claim.", gapType: "Evidence warrant", origin: "gap" },
        { kind: "claim", text: "The claim follows from the measurement.", sourceUnitIds: [units[0].id], sourceQuote: "supports the claim", defines: [], requires: [], mentions: [], fills: [], need: "", gapType: null, origin: "source" },
      ],
      edges: [{ from: 0, to: 2, relation: "supports", reason: "reported support" }],
      evidenceFrames: [{ claim: 2, evidence: [0], warrantGap: 1, limitations: [] }],
    }, chunk);
    expect(extraction.nodes[1]).toMatchObject({ kind: "gap", text: null, gapType: "evidence_warrant", origin: "gap" });
    expect(extraction.evidenceFrames[0]).toEqual({ claim: 2, evidence: [0], warrantGap: 1, limitations: [] });
  });
});

describe("global knowledge graph", () => {
  test("connects a definition and requirement from different chunks", () => {
    const source = "A spectral operator is defined.\n\nIts spectrum controls the solution.";
    const units = parseSourceUnits(source);
    const chunks = [
      { id: "c0001", context: [], units: [units[0]] },
      { id: "c0002", context: [], units: [units[1]] },
    ];
    const extractions = [
      { nodes: [sourceNode(units[0], { kind: "definition", defines: ["spectral operator"], chunkId: "c0001" })], edges: [] },
      { nodes: [sourceNode(units[1], { requires: ["spectral operator"], chunkId: "c0002" })], edges: [] },
    ];
    const graph = assembleGraph(source, "/tmp/source.md", units, chunks, extractions);
    reconcileConcepts(graph);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({ from: "n0000001", to: "n0000002", relation: "enables", origin: "concept-reconciliation" });
    expect(graph.unresolvedConcepts).toEqual([]);
    expect(validateGraph(graph).status).toBe("complete");
  });

  test("keeps model edges instead of replacing them during reconciliation", () => {
    const source = "Definition.\n\nDependent claim.";
    const units = parseSourceUnits(source);
    const chunks = [{ id: "c0001", context: [], units }];
    const extractions = [{
      nodes: [
        sourceNode(units[0], { kind: "definition", defines: ["concept"] }),
        sourceNode(units[1], { requires: ["concept"] }),
      ],
      edges: [{ from: 0, to: 1, relation: "enables", reason: "model relation" }],
    }];
    const graph = assembleGraph(source, "/tmp/source.md", units, chunks, extractions);
    reconcileConcepts(graph);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({ origin: "model", reason: "model relation" });
  });

  test("materializes an unresolved prerequisite as an empty linked gap", () => {
    const source = "The correction removes the artificial interaction.";
    const units = parseSourceUnits(source);
    const chunks = [{ id: "c0001", context: [], units }];
    const graph = assembleGraph(source, "/tmp/source.md", units, chunks, [{
      nodes: [sourceNode(units[0], { requires: ["periodic charge interaction"] })],
      edges: [],
    }]);
    reconcileConcepts(graph);
    const gap = graph.nodes.find((node) => node.kind === "gap");
    expect(gap).toMatchObject({ text: null, gapType: "definition", fills: ["periodic charge interaction"], origin: "gap" });
    expect(graph.edges).toContainEqual(expect.objectContaining({ from: gap.id, to: "n0000001", relation: "enables", origin: "gap-reconciliation" }));
    expect(graph.unresolvedConcepts[0].gapNodeId).toBe(gap.id);
    expect(validateGraph(graph).status).toBe("complete_with_gaps");
  });

  test("maps evidence-frame indexes to stable graph node ids", () => {
    const source = "A line was measured.\n\nThe line supports the assignment.";
    const units = parseSourceUnits(source);
    const chunks = [{ id: "c0001", context: [], units }];
    const graph = assembleGraph(source, "/tmp/source.md", units, chunks, [{
      nodes: [sourceNode(units[0], { kind: "evidence" }), sourceNode(units[1])],
      edges: [{ from: 0, to: 1, relation: "supports", reason: "measurement supports assignment" }],
      evidenceFrames: [{ claim: 1, evidence: [0], warrantGap: null, limitations: [] }],
    }]);
    reconcileConcepts(graph);
    expect(graph.evidenceFrames[0]).toMatchObject({ claim: "n0000002", evidence: ["n0000001"], warrantGap: null });
    expect(validateGraph(graph).evidenceFrameCount).toBe(1);
  });

  test("adds grounded fallbacks for uncovered and non-verbatim protected units", () => {
    const source = "Claim.\n\n```js\nrun();\n```";
    const units = parseSourceUnits(source);
    const chunk = { id: "c0001", context: [], units };
    const extraction = { nodes: [sourceNode(units[0])], edges: [] };
    const counts = addCoverageFallbacks(extraction, chunk);
    expect(counts).toEqual({ fallbackCount: 1, protectedFallbackCount: 1 });
    expect(extraction.nodes[1]).toMatchObject({ kind: "code", text: units[1].text, coverageFallback: true });
  });

  test("serializes only valid public graph fields", () => {
    const source = "Claim.";
    const units = parseSourceUnits(source);
    const chunks = [{ id: "c0001", context: [], units }];
    const graph = assembleGraph(source, "/tmp/source.md", units, chunks, [{ nodes: [sourceNode(units[0])], edges: [] }]);
    reconcileConcepts(graph);
    validateGraph(graph);
    const output = serializableGraph(graph);
    expect(output.schemaVersion).toBe(GRAPH_SCHEMA_VERSION);
    expect(output.validation.sourceUnitCoverage).toBe(1);
    expect(output._edgeKeys).toBeUndefined();
    expect(output._nextNode).toBeUndefined();
  });
});

describe("helpers", () => {
  test("normalizes Unicode concepts without deleting symbols", () => {
    expect(normalizeConcept(" **Σ-algebra** ")).toBe("σ-algebra");
  });

  test("accepts plain and fenced JSON", () => {
    expect(parseJsonValue('{"nodes":[]}')).toEqual({ nodes: [] });
    expect(parseJsonValue('```json\n{"nodes":[]}\n```')).toEqual({ nodes: [] });
  });
});
