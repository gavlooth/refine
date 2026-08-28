#!/usr/bin/env bun
// Apply lossless sentence-boundary decompression to every generated section.
// Usage: ./decompress-book.mjs CHAPTER_DIRECTORY
import { resolve } from "node:path";
import { splitDenseProse } from "./decompress-prose.mjs";
import { denseParagraphs } from "./generate-document.mjs";
import { writeJsonAtomic } from "./refine.mjs";

async function main() {
  const directory = resolve(Bun.argv[2] ?? ""); if (!Bun.argv[2]) throw new Error("Usage: ./decompress-book.mjs CHAPTER_DIRECTORY");
  const manifest = JSON.parse(await Bun.file(resolve(directory, "manifest.json")).text()); const sections = []; let splitCount = 0;
  for (const section of manifest.sections) {
    const path = resolve(section.directory, "document.md"); const source = await Bun.file(path).text(); const result = splitDenseProse(source);
    await Bun.write(path, result.markdown); splitCount += result.splitCount;
    sections.push({ index: section.index, title: section.title, splitCount: result.splitCount, remainingDense: denseParagraphs(result.markdown).length });
  }
  const report = { schemaVersion: "book-prose-decompression/v1", splitCount, remainingDense: sections.reduce((sum, section) => sum + section.remainingDense, 0), sections };
  await writeJsonAtomic(resolve(directory, "prose-decompression-report.json"), report); console.error(JSON.stringify({ splitCount: report.splitCount, remainingDense: report.remainingDense }));
}
if (import.meta.main) await main();
