#!/usr/bin/env bun
// Audit chapter documents for density and issue-comment preservation.
// Usage: ./audit-book.mjs CHAPTER_DIRECTORY OUTPUT_REPORT.json
import { resolve } from "node:path";
import { denseParagraphs } from "./generate-document.mjs";
import { issueIds } from "./annotate-markdown.mjs";
import { writeJsonAtomic } from "./refine.mjs";

async function main() {
  const directory = resolve(Bun.argv[2] ?? ""); const output = resolve(Bun.argv[3] ?? "");
  if (!Bun.argv[2] || !Bun.argv[3]) throw new Error("Usage: ./audit-book.mjs CHAPTER_DIRECTORY OUTPUT_REPORT.json");
  const manifest = JSON.parse(await Bun.file(resolve(directory, "manifest.json")).text()); const sections = [];
  for (const section of manifest.sections) {
    const documentPath = resolve(section.directory, "document.md");
    if (!(await Bun.file(documentPath).exists())) { sections.push({ index: section.index, title: section.title, status: "missing" }); continue; }
    const document = await Bun.file(documentPath).text(); const annotated = await Bun.file(resolve(section.directory, "source.annotated.md")).text();
    const expected = new Set(issueIds(annotated)); const actual = new Set(issueIds(document));
    sections.push({ index: section.index, title: section.title, status: "present", words: document.split(/\s+/).filter(Boolean).length, denseParagraphs: denseParagraphs(document).length, expectedIssues: expected.size, missingIssueIds: [...expected].filter((id) => !actual.has(id)) });
  }
  const summary = { sectionCount: sections.length, passing: sections.filter((section) => section.status === "present" && section.denseParagraphs === 0 && !section.missingIssueIds.length).length, dense: sections.filter((section) => section.denseParagraphs > 0).length, missingIssues: sections.filter((section) => section.missingIssueIds?.length).length, missingDocuments: sections.filter((section) => section.status === "missing").length };
  await writeJsonAtomic(output, { schemaVersion: "book-audit/v1", summary, sections }); console.error(JSON.stringify(summary));
}
if (import.meta.main) await main();
