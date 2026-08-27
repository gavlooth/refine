#!/usr/bin/env bun
// Research and resolve definition-overlay batches with cited web evidence.
// Usage: ./research-definitions.mjs OVERLAY.json PLAN.json OUTPUT_OVERLAY.json [RUN_DIRECTORY]

import { mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const config = {
  timeoutSeconds: integerEnv("REFINE_TIMEOUT_SECONDS", 180, 30, 900),
  startBatch: integerEnv("REFINE_START_BATCH", 1, 1, 10_000),
  endBatch: integerEnv("REFINE_END_BATCH", 10_000, 1, 10_000),
  subBatchSize: integerEnv("REFINE_RESEARCH_SUB_BATCH_SIZE", 3, 1, 32),
  model: Bun.env.REFINE_MODEL ?? "openai-codex/gpt-5.6-terra",
  thinking: Bun.env.REFINE_THINKING ?? "medium",
  serviceTier: Bun.env.REFINE_SERVICE_TIER ?? "priority",
};

function integerEnv(name, fallback, min, max) {
  const value = Number(Bun.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

function chunkRecords(records, size) {
  return Array.from({ length: Math.ceil(records.length / size) }, (_, index) => records.slice(index * size, (index + 1) * size));
}

function parseJson(text) {
  const value = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? text.trim();
  return JSON.parse(value);
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await Bun.write(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

function priorProposal(runRoot, batchNumber) {
  const padded = String(batchNumber).padStart(3, "0");
  return resolve(runRoot, `../definition-proposals-batch-${padded}-strict.json`);
}

function researchPrompt(records, candidates) {
  return `Research concise definitions for these context-sensitive knowledge gaps. Use web search. Return JSON only in this exact shape:
{"items":[{"gapId":"...","status":"external_definition|unresolved","definition":"plain Unicode prose or empty","confidence":"high|medium|low","evidence":[{"url":"https://...","title":"source title","excerpt":"short exact supporting excerpt","claim":"what this source supports"}],"reason":"brief explanation"}]}

Rules:
- Return exactly one item for every requested gapId, with no duplicates or unknown IDs.
- For external_definition, provide one small standalone plain-prose definition and at least one primary or authoritative source.
- Evidence requires a reachable HTTP(S) URL, page title, quoted supporting excerpt, and claim-to-source mapping.
- Do not use LaTeX, backslashes, equations, or dollar signs in definitions.
- Prefer original papers, textbooks, standards, or official documentation; avoid SEO summaries.
- If evidence is insufficient or the label is ambiguous in its chapter context, return status unresolved and explain why.
- Candidate definitions are unverified drafts; use them only as hints and correct them from sources.

TARGETS:
${JSON.stringify(records.map((record) => ({ gapId: record.gapId, label: record.label, canonicalConcept: record.canonicalConcept, chapter: record.chapter, dependentCount: record.dependentCount, firstUseContext: record.firstUseContext, candidateDefinition: candidates.get(record.gapId) ?? null })), null, 2)}`;
}

function validateBatchResponse(value, records) {
  if (!value || !Array.isArray(value.items)) throw new Error("Research response must contain an items array");
  const requested = new Set(records.map((record) => record.gapId));
  if (requested.size !== records.length) throw new Error("Plan batch contains duplicate gap IDs");
  if (value.items.length !== records.length) throw new Error(`Research response returned ${value.items.length}/${records.length} items`);
  const seen = new Set();
  return value.items.map((item) => {
    if (!requested.has(item?.gapId) || seen.has(item.gapId)) throw new Error(`Unknown or duplicate gap ID ${item?.gapId}`);
    seen.add(item.gapId);
    if (!new Set(["external_definition", "unresolved"]).has(item.status)) throw new Error(`Invalid status for ${item.gapId}`);
    if (!new Set(["high", "medium", "low"]).has(item.confidence)) throw new Error(`Invalid confidence for ${item.gapId}`);
    const definition = typeof item.definition === "string" ? item.definition.trim() : "";
    if (item.status === "external_definition" && (!definition || /[\\$]/.test(definition))) throw new Error(`Invalid definition for ${item.gapId}`);
    const evidence = Array.isArray(item.evidence) ? item.evidence.map((source) => ({
      url: typeof source?.url === "string" ? source.url.trim() : "",
      title: typeof source?.title === "string" ? source.title.trim() : "",
      excerpt: typeof source?.excerpt === "string" ? source.excerpt.trim() : "",
      claim: typeof source?.claim === "string" ? source.claim.trim() : "",
    })) : [];
    if (item.status === "external_definition") {
      if (!evidence.length || evidence.some((source) => !/^https?:\/\//.test(source.url) || !source.title || !source.excerpt || !source.claim)) throw new Error(`Incomplete evidence for ${item.gapId}`);
    }
    return { gapId: item.gapId, status: item.status, definition, confidence: item.confidence, evidence, reason: typeof item.reason === "string" ? item.reason.trim() : "" };
  });
}

async function checkEvidence(items) {
  const checked = new Map();
  for (const item of items) {
    if (item.status !== "external_definition") continue;
    for (const source of item.evidence) {
      if (checked.has(source.url)) continue;
      try {
        const response = await fetch(source.url, { redirect: "follow", signal: AbortSignal.timeout(20_000), headers: { "user-agent": "cognitive-refine/0.1" } });
        checked.set(source.url, { reachable: response.ok, status: response.status, finalUrl: response.url });
      } catch (error) {
        checked.set(source.url, { reachable: false, status: null, error: error.message });
      }
    }
  }
  return items.map((item) => ({ ...item, evidence: item.evidence.map((source) => ({ ...source, verification: checked.get(source.url) ?? null })) }));
}

async function callResearch(prompt, runDirectory, stem) {
  const promptPath = resolve(runDirectory, `${stem}.prompt.txt`);
  await Bun.write(promptPath, prompt);
  const args = ["omp", "-p", "--mode", "text", "--no-session", "--tools", "web_search,read", "--no-extensions", "--no-skills", "--no-rules", "--auto-approve", "--approval-mode", "yolo", "--max-time", `${config.timeoutSeconds}s`, "--model", config.model, "--thinking", config.thinking];
  if (config.serviceTier) args.push("--service-tier", config.serviceTier);
  args.push(`@${promptPath}`);
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, (config.timeoutSeconds + 10) * 1_000);
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  await Promise.all([Bun.write(resolve(runDirectory, `${stem}.stdout.log`), stdout), Bun.write(resolve(runDirectory, `${stem}.stderr.log`), stderr)]);
  if (timedOut) throw new Error(`Research batch timed out after ${config.timeoutSeconds}s`);
  if (exitCode !== 0) throw new Error(`Research batch exited ${exitCode}: ${stderr.trim()}`);
  return parseJson(stdout);
}

async function main() {
  const [overlayArg, planArg, outputArg, runArg] = Bun.argv.slice(2);
  if (!overlayArg || !planArg || !outputArg) throw new Error("Usage: ./research-definitions.mjs OVERLAY.json PLAN.json OUTPUT_OVERLAY.json [RUN_DIRECTORY]");
  const overlayPath = resolve(overlayArg);
  const planPath = resolve(planArg);
  const outputPath = resolve(outputArg);
  const runDirectory = resolve(runArg ?? `${outputArg}.research`);
  await mkdir(runDirectory, { recursive: true });
  const overlay = JSON.parse(await Bun.file(overlayPath).text());
  const plan = JSON.parse(await Bun.file(planPath).text());
  const recordById = new Map(overlay.records.map((record) => [record.gapId, record]));
  const researchIssues = [];

  for (const batch of plan.batches.filter((entry) => entry.batch >= config.startBatch && entry.batch <= config.endBatch)) {
    const records = batch.records.map((entry) => ({ ...entry, ...(recordById.get(entry.gapId) ?? {}) }));
    if (records.some((record) => !record.gapId)) throw new Error(`Batch ${batch.batch} references an unknown overlay record`);
    const candidates = new Map();
    for (const variant of ["strict", ""]) {
      const suffix = variant ? `-${variant}` : "";
      const candidatePath = resolve(dirname(overlayPath), `definition-proposals-batch-${String(batch.batch).padStart(3, "0")}${suffix}.json`);
      if (!(await Bun.file(candidatePath).exists())) continue;
      const proposals = JSON.parse(await Bun.file(candidatePath).text());
      for (const proposal of proposals.items ?? []) candidates.set(proposal.gapId, proposal.definition);
      break;
    }
    for (const [subIndex, subBatch] of chunkRecords(records, config.subBatchSize).entries()) {
      const stem = `research-${String(batch.batch).padStart(3, "0")}-${String(subIndex + 1).padStart(2, "0")}`;
      try {
        const raw = await callResearch(researchPrompt(subBatch, candidates), runDirectory, stem);
        const checked = await checkEvidence(validateBatchResponse(raw, subBatch));
        await writeJsonAtomic(resolve(runDirectory, `${stem}.checked.json`), { batch: batch.batch, subBatch: subIndex + 1, items: checked });
        for (const item of checked) {
          const record = recordById.get(item.gapId);
          if (!record) continue;
          const verified = item.status === "external_definition" && item.evidence.length && item.evidence.every((source) => source.verification?.reachable);
          record.status = verified ? "external_definition" : item.status === "unresolved" ? "unresolved" : "citation_needed";
          record.provenance = verified ? "verified_external_source" : item.status === "external_definition" ? "model_citation_unverified" : null;
          record.confidence = item.confidence;
          record.candidateDefinition = item.definition || null;
          record.citations = item.evidence;
          record.reason = verified ? item.reason : item.status === "external_definition" ? "Definition proposed, but at least one cited URL was unreachable." : item.reason;
        }
        overlay.summary.resolvedCount = overlay.records.filter((record) => record.status === "external_definition" || record.status === "already_defined" || record.status === "source_recovery").length;
        overlay.summary.unresolvedCount = overlay.records.length - overlay.summary.resolvedCount;
        overlay.summary.lastCompletedResearchBatch = `${batch.batch}.${subIndex + 1}`;
        overlay.summary.researchIssues = researchIssues;
        await writeJsonAtomic(outputPath, overlay);
        console.error(`batch ${batch.batch}.${subIndex + 1}: researched ${checked.length} records; resolved ${overlay.summary.resolvedCount}/${overlay.records.length}`);
      } catch (error) {
        researchIssues.push({ batch: batch.batch, subBatch: subIndex + 1, reason: error.message });
        overlay.summary.researchIssues = researchIssues;
        await writeJsonAtomic(outputPath, overlay);
        console.error(`batch ${batch.batch}.${subIndex + 1} failed: ${error.message}`);
      }
    }
  }
}

if (import.meta.main) await main();

export { validateBatchResponse };
