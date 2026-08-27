import { expect, test } from "bun:test";
import { applyResolution, firstSentences, normalize } from "../bin/resolve-definition-overlay.mjs";

test("normalizes labels and bounds source excerpts", () => {
  expect(normalize("  Fusion–Rule ")).toBe("fusion rule");
  expect(firstSentences("First fact. Second fact. Third fact.")).toBe("First fact. Second fact.");
});

test("applies only explicit verified external resolution", () => {
  const record = { status: "unresolved", citations: [] };
  expect(applyResolution(record, { definition: "A fusion rule describes allowed combinations.", confidence: "high", citation: { url: "https://example.test", title: "Fusion", excerpt: "A fusion rule describes allowed combinations.", claim: "Defines fusion rule.", verification: { reachable: true, status: 200 } } })).toBe(true);
  expect(record).toMatchObject({ status: "external_definition", provenance: "verified_external_source", confidence: "high" });
});
