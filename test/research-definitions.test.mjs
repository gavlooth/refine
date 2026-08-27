import { expect, test } from "bun:test";
import { validateBatchResponse } from "../bin/research-definitions.mjs";

const records = [{ gapId: "g1" }, { gapId: "g2" }];
const source = { url: "https://example.test/source", title: "Source", excerpt: "A definition excerpt.", claim: "Defines the term." };

test("accepts exact evidence-backed batch coverage", () => {
  const items = validateBatchResponse({ items: [
    { gapId: "g1", status: "external_definition", definition: "A plain definition.", confidence: "high", evidence: [source], reason: "Supported." },
    { gapId: "g2", status: "unresolved", definition: "", confidence: "low", evidence: [], reason: "Ambiguous." },
  ] }, records);
  expect(items).toHaveLength(2);
});

test("rejects missing, duplicate, and malformed records", () => {
  expect(() => validateBatchResponse({ items: [{ gapId: "g1", status: "unresolved", definition: "", confidence: "low", evidence: [] }] }, records)).toThrow();
  expect(() => validateBatchResponse({ items: [
    { gapId: "g1", status: "unresolved", definition: "", confidence: "low", evidence: [] },
    { gapId: "g1", status: "unresolved", definition: "", confidence: "low", evidence: [] },
  ] }, records)).toThrow();
  expect(() => validateBatchResponse({ items: [
    { gapId: "g1", status: "external_definition", definition: "Bad $ math.", confidence: "high", evidence: [source] },
    { gapId: "g2", status: "unresolved", definition: "", confidence: "invalid", evidence: [] },
  ] }, records)).toThrow();
});
