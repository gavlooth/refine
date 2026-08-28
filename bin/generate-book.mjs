#!/usr/bin/env bun
// Generate section documents concurrently, preserve issue comments, and assemble one book.
// Usage: ./generate-book.mjs CHAPTER_DIRECTORY OUTPUT.md

import { mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { denseParagraphs } from "./generate-document.mjs";
import { issueIds } from "./annotate-markdown.mjs";

const concurrency = Number(Bun.env.REFINE_CONCURRENCY ?? 8);
const model = Bun.env.REFINE_MODEL ?? "openai-codex/gpt-5.6-luna";
const thinking = Bun.env.REFINE_THINKING ?? "high";
const tier = Bun.env.REFINE_SERVICE_TIER ?? "priority";
const timeout = Number(Bun.env.REFINE_DOCUMENT_TIMEOUT_SECONDS ?? 300);

async function writeAtomic(path, text) { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.tmp-${process.pid}-${Date.now()}`; await Bun.write(temporary, text); await rename(temporary, path); }
async function mapConcurrent(items, limit, mapper) { const results = new Array(items.length); let cursor = 0; const workers = Array.from({ length: Math.min(limit, items.length) }, async () => { while (true) { const index = cursor++; if (index >= items.length) return; results[index] = await mapper(items[index], index); } }); await Promise.all(workers); return results; }

async function generateSection(section) {
  const directory = section.directory;
  const output = resolve(directory, "document.md");
  const source = await Bun.file(resolve(directory, "source.annotated.md")).text();
  if (await Bun.file(output).exists() && Bun.env.REFINE_OVERWRITE !== "1") return { ...section, status: "reused", output };
  if (/^(?:Part\s+[IVXLCDM]+|Mathematical appendices|Global evidence table|Glossary|Annotated bibliography)/i.test(section.title) || source.length < 2_000) {
    await writeAtomic(output, source);
    return { ...section, status: "source_transition", output };
  }
  const runDirectory = resolve(directory, "document-run"); await mkdir(runDirectory, { recursive: true });
  const args = ["bin/generate-document.mjs", resolve(directory, "graph.json"), output, runDirectory];
  const child = Bun.spawn(["bun", ...args], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe", env: { ...Bun.env, REFINE_MODEL: model, REFINE_THINKING: thinking, REFINE_SERVICE_TIER: tier, REFINE_DOCUMENT_TIMEOUT_SECONDS: String(timeout), REFINE_DOCUMENT_DIRECT: "1", REFINE_DOCUMENT_SOURCE: resolve(directory, "source.annotated.md") } });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  await Promise.all([Bun.write(resolve(runDirectory, "runner.stdout.log"), stdout), Bun.write(resolve(runDirectory, "runner.stderr.log"), stderr)]);
  if (exitCode === 0 && await Bun.file(output).exists()) return { ...section, status: "generated", output };
  await writeAtomic(output, source);
  return { ...section, status: "source_fallback", output, failure: stderr.trim() || `generator exited ${exitCode}` };
}

async function main() {
  const chapterArg = Bun.argv[2]; const outputArg = Bun.argv[3];
  if (!chapterArg || !outputArg) throw new Error("Usage: ./generate-book.mjs CHAPTER_DIRECTORY OUTPUT.md");
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("REFINE_CONCURRENCY must be 1-8");
  const chapterDirectory = resolve(chapterArg); const output = resolve(outputArg);
  const manifest = JSON.parse(await Bun.file(resolve(chapterDirectory, "manifest.json")).text());
  const results = await mapConcurrent(manifest.sections, concurrency, async (section) => { const result = await generateSection(section); console.error(`${String(section.index).padStart(3, "0")}: ${result.status} — ${section.title}`); return result; });
  const documents = await Promise.all(results.sort((a, b) => a.index - b.index).map(async (result) => (await Bun.file(result.output).text()).trim()));
  const book = `${documents.join("\n\n---\n\n")}\n`;
  const expectedIssues = new Set();
  for (const section of manifest.sections) for (const id of issueIds(await Bun.file(resolve(section.directory, "source.annotated.md")).text())) expectedIssues.add(id);
  const actualIssues = new Set(issueIds(book));
  const missingIssueIds = [...expectedIssues].filter((id) => !actualIssues.has(id));
  const densityIssues = denseParagraphs(book);
  const report = { schemaVersion: "book-generation-report/v1", model, sectionCount: results.length, statuses: Object.fromEntries(Object.entries(Object.groupBy(results, (result) => result.status)).map(([status, values]) => [status, values.length])), expectedIssueCount: expectedIssues.size, retainedOrResolvedIssueCount: actualIssues.size, missingIssueIds, denseParagraphCount: densityIssues.length, densityIssues, sections: results };
  await writeAtomic(output, book);
  await writeAtomic(`${output}.report.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.error(`book: ${output}; ${results.length} sections; ${missingIssueIds.length} missing issues; ${densityIssues.length} dense paragraphs`);
}
if (import.meta.main) await main();
