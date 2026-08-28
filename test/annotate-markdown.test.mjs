import { expect, test } from "bun:test";
import { annotateMarkdown, buildIssueAnnotations, issueIds } from "../bin/annotate-markdown.mjs";

function fixture() {
  return {
    sourceUnits: [
      { id: "u1", kind: "heading", text: "# Title", startLine: 1, endLine: 1 },
      { id: "u2", kind: "prose", text: "Dense source.", startLine: 3, endLine: 3 },
    ],
    nodes: [
      { id: "n1", kind: "topic", text: "Title", sourceUnitIds: ["u1"] },
      { id: "n2", kind: "source", text: "Dense source.", sourceUnitIds: ["u2"], annotations: ["repair_source_fallback"] },
      { id: "g1", kind: "gap", text: null, gapType: "parsing_error", need: "Recover the explanation.", sourceUnitIds: ["u2"], annotations: ["repair_parsing_error"] },
    ],
  };
}

test("grades source-unit coverage and inserts adjacent invisible issues", () => {
  const graph = fixture();
  const result = annotateMarkdown("# Title\n\nDense source.\n", graph);
  expect(result.summary).toMatchObject({ sourceUnitCount: 2, issueCount: 1, extracted: 1, unresolved: 1 });
  expect(result.markdown).toContain("<!-- refine:coverage");
  expect(result.markdown).toContain("<!-- refine:issue");
  expect(result.markdown.indexOf("Dense source.")).toBeLessThan(result.markdown.indexOf("refine:issue"));
  expect(issueIds(result.markdown)).toEqual(["g1"]);
});

test("does not annotate resolved gaps", () => {
  const graph = fixture();
  graph.nodes[2].resolutionStatus = "source_recovery";
  const annotations = buildIssueAnnotations(graph);
  expect(annotations.issues[0]).toMatchObject({ id: "fallback-u2", type: "source_fallback" });
});
