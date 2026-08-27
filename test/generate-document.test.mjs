import { expect, test } from "bun:test";
import { documentPrompt } from "../bin/generate-document.mjs";

test("document prompt enforces graph provenance, research, and rigorous pedagogy", () => {
  const prompt = documentPrompt("/tmp/graph.json", "/tmp/document.md");
  expect(prompt).toContain("Spivak's Calculus");
  expect(prompt).toContain("/tmp/graph.json");
  expect(prompt).toContain("/tmp/document.md");
  expect(prompt).toContain("Use web search");
  expect(prompt).toContain("Four remaining unresolved gaps");
  expect(prompt.toLowerCase()).toContain("do not fabricate a citation");
});

test("direct fallback requests Markdown from the attached graph", () => {
  const prompt = documentPrompt("/tmp/graph.json", "/tmp/document.md", true);
  expect(prompt).toContain("attached to this request");
  expect(prompt).toContain("Return only the finished Markdown document");
  expect(prompt).toContain("preserve them as explicit uncertainty");
});
