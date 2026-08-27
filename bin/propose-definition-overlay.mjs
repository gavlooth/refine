#!/usr/bin/env bun
// Generate strict plain-prose candidate definitions for every unresolved overlay record.
// Usage: ./propose-definition-overlay.mjs INPUT_OVERLAY.json OUTPUT_OVERLAY.json [RUN_DIRECTORY]
import { mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const batchSize = Number(Bun.env.REFINE_DEFINITION_BATCH_SIZE ?? 12);
const concurrency = Number(Bun.env.REFINE_CONCURRENCY ?? 2);
const timeout = Number(Bun.env.REFINE_TIMEOUT_SECONDS ?? 120);
const model = Bun.env.REFINE_MODEL ?? "openai-codex/gpt-5.6-terra";
const thinking = Bun.env.REFINE_THINKING ?? "medium";
const tier = Bun.env.REFINE_SERVICE_TIER ?? "priority";

function parseJson(text) { return JSON.parse(text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? text.trim()); }
function chunks(items, size) { return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size)); }
async function writeAtomic(path, value) { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.tmp-${process.pid}-${Date.now()}`; await Bun.write(temporary, `${JSON.stringify(value, null, 2)}\n`); await rename(temporary, path); }

function validate(value, records) {
  if (!value || !Array.isArray(value.items) || value.items.length !== records.length) throw new Error(`Expected ${records.length} proposal items`);
  const expected = new Set(records.map((record) => record.gapId));
  if (expected.size !== records.length) throw new Error("Duplicate requested gap IDs");
  const seen = new Set();
  return value.items.map((item) => {
    if (!expected.has(item?.gapId) || seen.has(item.gapId) || !["high", "medium", "low"].includes(item.confidence) || typeof item.definition !== "string" || !item.definition.trim() || /[\\$]/.test(item.definition)) throw new Error(`Invalid proposal for ${item?.gapId}`);
    seen.add(item.gapId); return { gapId: item.gapId, definition: item.definition.trim(), confidence: item.confidence };
  });
}

async function call(records, runDirectory, index) {
  const stem = `batch-${String(index + 1).padStart(4, "0")}`;
  const prompt = `Return JSON only: {"items":[{"gapId":"...","definition":"one rigorous standalone plain-prose definition","confidence":"high|medium|low"}]}.

Define every listed concept for its exact chapter context. Plain Unicode prose only: no LaTeX, backslashes, equations, dollar signs, citations, or workflow commentary. Return exactly one item per gapId.

${JSON.stringify(records.map((record) => ({ gapId: record.gapId, label: record.label, chapter: record.chapter, firstUseContext: record.firstUseContext })), null, 2)}`;
  const promptPath = resolve(runDirectory, `${stem}.prompt.txt`); await Bun.write(promptPath, prompt);
  const args = ["omp", "-p", "--mode", "text", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-rules", "--max-time", `${timeout}s`, "--model", model, "--thinking", thinking, "--service-tier", tier, `@${promptPath}`];
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" }); let expired = false;
  const timer = setTimeout(() => { expired = true; child.kill(); }, (timeout + 5) * 1_000);
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); clearTimeout(timer);
  await Promise.all([Bun.write(resolve(runDirectory, `${stem}.stdout.log`), stdout), Bun.write(resolve(runDirectory, `${stem}.stderr.log`), stderr)]);
  if (expired) throw new Error(`Timed out after ${timeout}s`);
  if (exitCode !== 0) throw new Error(`Exited ${exitCode}: ${stderr.trim()}`);
  const items = validate(parseJson(stdout), records);
  await writeAtomic(resolve(runDirectory, `${stem}.json`), { batch: index + 1, items });
  return items;
}

async function main() {
  const [inputArg, outputArg, runArg] = Bun.argv.slice(2);
  if (!inputArg || !outputArg) throw new Error("Usage: ./propose-definition-overlay.mjs INPUT_OVERLAY.json OUTPUT_OVERLAY.json [RUN_DIRECTORY]");
  if (![batchSize, concurrency, timeout].every(Number.isSafeInteger) || batchSize < 1 || concurrency < 1 || concurrency > 2 || timeout < 30) throw new Error("Invalid batch/concurrency/timeout configuration");
  const overlay = JSON.parse(await Bun.file(resolve(inputArg)).text());
  const pending = overlay.records.filter((record) => !["external_definition", "source_recovery", "already_defined"].includes(record.status) && !record.candidateDefinition);
  const work = chunks(pending, batchSize); const runDirectory = resolve(runArg ?? `${outputArg}.proposals`); await mkdir(runDirectory, { recursive: true });
  const issues = [];
  for (let start = 0; start < work.length; start += concurrency) {
    const wave = work.slice(start, start + concurrency);
    const results = await Promise.all(wave.map((records, offset) => call(records, runDirectory, start + offset).then((items) => ({ records, items })).catch((error) => ({ records, error }))));
    for (const result of results) {
      if (result.error) { issues.push({ gapIds: result.records.map((record) => record.gapId), reason: result.error.message }); continue; }
      const recordById = new Map(result.records.map((record) => [record.gapId, record]));
      for (const item of result.items) { const record = recordById.get(item.gapId); record.status = "citation_needed"; record.candidateDefinition = item.definition; record.proposalConfidence = item.confidence; record.proposalProvenance = "model_unverified"; record.reason = "Candidate definition generated; source verification remains pending."; }
    }
    overlay.summary.longTailProposalCheckpoint = Math.min(start + concurrency, work.length);
    overlay.summary.longTailProposalIssues = issues;
    await writeAtomic(resolve(outputArg), overlay);
    console.error(`wave ${Math.floor(start / concurrency) + 1}/${Math.ceil(work.length / concurrency)} complete`);
  }
  overlay.summary.candidateDefinitionCount = overlay.records.filter((record) => record.candidateDefinition).length;
  overlay.summary.unresolvedWithoutCandidateCount = overlay.records.filter((record) => !["external_definition", "source_recovery", "already_defined"].includes(record.status) && !record.candidateDefinition).length;
  await writeAtomic(resolve(outputArg), overlay);
  console.error(`complete: ${overlay.summary.candidateDefinitionCount} candidates; ${overlay.summary.unresolvedWithoutCandidateCount} unresolved without candidate`);
}
if (import.meta.main) await main();
