#!/usr/bin/env bun
// Rewrite only residual dense prose paragraphs across chapter documents.
// Usage: ./rewrite-dense-book.mjs CHAPTER_DIRECTORY
import { mkdir, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { denseParagraphs } from "./generate-document.mjs";
import { writeJsonAtomic } from "./refine.mjs";

const config = { concurrency: Number(Bun.env.REFINE_CONCURRENCY ?? 8), timeout: Number(Bun.env.REFINE_TIMEOUT_SECONDS ?? 180), model: Bun.env.REFINE_MODEL ?? "openai-codex/gpt-5.6-luna", thinking: Bun.env.REFINE_THINKING ?? "high", tier: Bun.env.REFINE_SERVICE_TIER ?? "priority" };
async function writeAtomic(path, text) { const temporary = `${path}.tmp-${process.pid}-${Date.now()}`; await Bun.write(temporary, text); await rename(temporary, path); }
async function mapConcurrent(items, limit, mapper) { let cursor = 0; const results = new Array(items.length); const workers = Array.from({ length: Math.min(limit, items.length) }, async () => { while (true) { const index = cursor++; if (index >= items.length) return; results[index] = await mapper(items[index], index); } }); await Promise.all(workers); return results; }
function parseJson(text) { return JSON.parse(text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? text.trim()); }
function applyReplacements(document, items) { const blocks = document.split(/\n\s*\n/); for (const item of [...items].sort((a, b) => b.index - a.index)) blocks[item.index] = item.paragraphs.join("\n\n"); return `${blocks.join("\n\n").trim()}\n`; }

async function rewriteSection(section) {
  const path = resolve(section.directory, "document.md"); const document = await Bun.file(path).text(); const issues = denseParagraphs(document);
  if (!issues.length) return { index: section.index, title: section.title, status: "clean", rewritten: 0 };
  const run = resolve(section.directory, "density-rewrite"); await mkdir(run, { recursive: true });
  const prompt = `Return JSON only: {"items":[{"index":0,"paragraphs":["focused paragraph","next focused paragraph"]}]}.

Rewrite every supplied dense prose block into two or more focused paragraphs. Preserve every factual claim, qualification, citation label, inline mathematical expression, and uncertainty. Do not summarize, delete, add facts, add headings, or mention this task. Each output paragraph must contain one conceptual move, at most three sentences, and fewer than 90 words. Return exactly one item per supplied index.

${JSON.stringify(issues, null, 2)}`;
  const promptPath = resolve(run, "prompt.txt"); await Bun.write(promptPath, prompt);
  const args = ["omp", "-p", "--mode", "text", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-rules", "--max-time", `${config.timeout}s`, "--model", config.model, "--thinking", config.thinking, "--service-tier", config.tier, `@${promptPath}`];
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" }); let timedOut = false; const timer = setTimeout(() => { timedOut = true; child.kill(); }, (config.timeout + 5) * 1_000);
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); clearTimeout(timer);
  await Promise.all([Bun.write(resolve(run, "stdout.log"), stdout), Bun.write(resolve(run, "stderr.log"), stderr)]);
  if (timedOut || exitCode !== 0) return { index: section.index, title: section.title, status: "failed", rewritten: 0, reason: timedOut ? "timeout" : stderr.trim() };
  try {
    const value = parseJson(stdout); if (!Array.isArray(value.items) || value.items.length !== issues.length) throw new Error("incomplete replacement set");
    const expected = new Set(issues.map((issue) => issue.index)); const seen = new Set();
    for (const item of value.items) { if (!expected.has(item?.index) || seen.has(item.index) || !Array.isArray(item.paragraphs) || item.paragraphs.length < 2 || item.paragraphs.some((paragraph) => typeof paragraph !== "string" || !paragraph.trim() || denseParagraphs(paragraph).length)) throw new Error(`invalid replacement ${item?.index}`); seen.add(item.index); }
    const rewritten = applyReplacements(document, value.items); if (denseParagraphs(rewritten).length >= issues.length) throw new Error("rewrite did not reduce density");
    await writeAtomic(path, rewritten); await writeJsonAtomic(resolve(run, "replacements.json"), value);
    return { index: section.index, title: section.title, status: "rewritten", rewritten: issues.length, remaining: denseParagraphs(rewritten).length };
  } catch (error) { return { index: section.index, title: section.title, status: "invalid", rewritten: 0, reason: error.message }; }
}

async function main() {
  const directory = resolve(Bun.argv[2] ?? ""); if (!Bun.argv[2]) throw new Error("Usage: ./rewrite-dense-book.mjs CHAPTER_DIRECTORY");
  if (!Number.isSafeInteger(config.concurrency) || config.concurrency < 1 || config.concurrency > 8) throw new Error("REFINE_CONCURRENCY must be 1-8");
  const manifest = JSON.parse(await Bun.file(resolve(directory, "manifest.json")).text()); const targets = [];
  for (const section of manifest.sections) { const document = await Bun.file(resolve(section.directory, "document.md")).text(); if (denseParagraphs(document).length) targets.push(section); }
  const results = await mapConcurrent(targets, config.concurrency, async (section) => { const result = await rewriteSection(section); console.error(`${String(section.index).padStart(3, "0")}: ${result.status}`); return result; });
  await writeJsonAtomic(resolve(directory, "density-rewrite-report.json"), { schemaVersion: "density-rewrite-report/v1", model: config.model, targetCount: targets.length, results });
  console.error(`rewrote ${results.filter((result) => result.status === "rewritten").length}/${targets.length} sections`);
}
if (import.meta.main) await main();

export { applyReplacements };
