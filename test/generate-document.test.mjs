import { expect, test } from "bun:test";
import { denseParagraphs, documentPrompt } from "../bin/generate-document.mjs";

test("document prompt enforces graph provenance, research, and rigorous pedagogy", () => {
  const prompt = documentPrompt("/tmp/graph.json", "/tmp/document.md");
  expect(prompt).toContain("Spivak's Calculus");
  expect(prompt).toContain("/tmp/graph.json");
  expect(prompt).toContain("/tmp/document.md");
  expect(prompt).toContain("Use web search");
  expect(prompt).toContain("Any remaining unresolved gaps");
  expect(prompt).toContain("One prose paragraph must develop one primary conceptual move");
  expect(prompt.toLowerCase()).toContain("do not fabricate a citation");
});

test("direct fallback requests Markdown from the attached graph", () => {
  const prompt = documentPrompt("/tmp/graph.json", "/tmp/document.md", true);
  expect(prompt).toContain("attached to this request");
  expect(prompt).toContain("Return only the finished Markdown document");
  expect(prompt).toContain("Preserve unresolved gaps as explicit uncertainty");
});

test("rejects a paragraph that recompresses several technical steps", () => {
  const packed = "A real calculation usually begins from nuclear species and positions and treats the electronic structure with an approximation such as density-functional theory, often in a periodically repeated supercell. Charged defects need careful electrostatic finite-size corrections. Atomic coordinates must relax. Band-gap errors can put defect levels in the wrong place.";
  expect(denseParagraphs(packed)).toEqual([
    expect.objectContaining({ words: expect.any(Number), sentences: 4 }),
  ]);
});

test("accepts the same knowledge as decompressed paragraphs", () => {
  const decompressed = `A calculation starts from the nuclear species and their positions. These are the physical inputs.

The electronic problem is then approximated. Density-functional theory is one common choice.

Periodic supercells make a finite calculation imitate a bulk crystal. Charged defects introduce artificial electrostatic interactions between those repeated copies.

The atomic coordinates must relax before interpreting defect energies.

Approximate band gaps can place defect levels incorrectly. That error must be checked separately.`;
  expect(denseParagraphs(decompressed)).toEqual([]);
});

test("annotated-source prompt requires issue preservation or explicit resolution", () => {
  const prompt = documentPrompt("/tmp/graph.json", "/tmp/document.md", true, "/tmp/annotated.md");
  expect(prompt).toContain("Every refine:issue comment is an active machine-readable instruction");
  expect(prompt).toContain("refine:resolved comment carrying the same id");
});

test("does not classify machine-readable issue comments as prose", () => {
  const comment = `<!-- refine:issue ${JSON.stringify({ id: "g1", need: "word ".repeat(120) })} -->`;
  expect(denseParagraphs(comment)).toEqual([]);
});
