#!/usr/bin/env bun
// Produce bounded, unverified definition proposals for a resolution overlay.
// Usage: ./propose-definitions.mjs OVERLAY.json PLAN.json OUTPUT.json [RUN_DIRECTORY]
import { mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const timeout = Number(Bun.env.REFINE_TIMEOUT_SECONDS ?? 120);
const model = Bun.env.REFINE_MODEL ?? "openai-codex/gpt-5.6-terra";
const thinking = Bun.env.REFINE_THINKING ?? "medium";
const tier = Bun.env.REFINE_SERVICE_TIER ?? "priority";
const batchNumber = Number(Bun.env.REFINE_DEFINITION_BATCH ?? 1);

function parseJson(text) { return JSON.parse(text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? text.trim()); }
async function writeAtomic(path, value) { await mkdir(dirname(path), { recursive: true }); const tmp = `${path}.tmp-${process.pid}-${Date.now()}`; await Bun.write(tmp, `${JSON.stringify(value, null, 2)}\n`); await rename(tmp, path); }

async function main() {
  const [overlayPath, planPath, outputPath, runPath] = Bun.argv.slice(2);
  if (!overlayPath || !planPath || !outputPath) throw new Error("Usage: ./propose-definitions.mjs OVERLAY.json PLAN.json OUTPUT.json [RUN_DIRECTORY]");
  const overlay = JSON.parse(await Bun.file(resolve(overlayPath)).text());
  const plan = JSON.parse(await Bun.file(resolve(planPath)).text());
  const batch = plan.batches.find((item) => item.batch === batchNumber);
  if (!batch) throw new Error(`Batch ${batchNumber} does not exist`);
  const runDirectory = resolve(runPath ?? `${outputPath}.run`); await mkdir(runDirectory, { recursive: true });
  const prompt = `Return JSON only: {"items":[{"gapId":"...","definition":"one rigorous standalone plain-prose definition","confidence":"high|medium|low"}]}.\n\nDefine the listed foundational concepts for their exact chapter context. Definitions must be plain Unicode prose: no LaTex, no backslashes, no equations, no dollar signs, and no citations. Do not claim web verification. These are unverified proposals; concise definitions only.\n\n${JSON.stringify(batch.records, null, 2)}`;
  const promptPath = resolve(runDirectory, "prompt.txt"); await Bun.write(promptPath, prompt);
  const args = ["omp", "-p", "--mode", "text", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-rules", "--max-time", `${timeout}s`, "--model", model, "--thinking", thinking, "--service-tier", tier, `@${promptPath}`];
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" }); let expired = false;
  const timer = setTimeout(() => { expired = true; child.kill(); }, (timeout + 5) * 1_000);
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); clearTimeout(timer);
  await Promise.all([Bun.write(resolve(runDirectory, "stdout.log"), stdout), Bun.write(resolve(runDirectory, "stderr.log"), stderr)]);
  if (expired) throw new Error(`Definition proposal timed out after ${timeout}s`);
  if (exitCode !== 0) throw new Error(`Definition proposal exited ${exitCode}: ${stderr.trim()}`);
  const known = new Set(batch.records.map((record) => record.gapId));
  const rawItems = parseJson(stdout).items ?? [];
  if (!Array.isArray(rawItems) || rawItems.length !== known.size) throw new Error("Proposal response must cover every requested gap exactly once");
  const seen = new Set();
  const items = rawItems.map((item) => {
    if (!known.has(item?.gapId) || seen.has(item.gapId) || !["high", "medium", "low"].includes(item.confidence) || typeof item.definition !== "string" || !item.definition.trim() || /[\\$]/.test(item.definition)) throw new Error(`Invalid proposal for ${item?.gapId ?? "unknown gap"}`);
    seen.add(item.gapId);
    return { gapId:item.gapId, definition:item.definition.trim(), confidence:item.confidence, provenance:"model_unverified", status:"citation_needed" };
  });
  if (seen.size !== known.size) throw new Error("Proposal response omitted a requested gap");
  const proposals = { schemaVersion:"definition-proposals/v1", overlay:resolve(overlayPath), batch:batchNumber, requested:batch.records.length, proposed:items.length, items };
  await writeAtomic(resolve(outputPath), proposals);
  console.error(`proposed ${items.length}/${batch.records.length} definitions`);
}
if (import.meta.main) await main();
