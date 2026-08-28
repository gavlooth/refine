#!/usr/bin/env bun
// Repair failed extraction shards and rebuild one globally reconciled graph.
// Usage: ./repair-sharded-graph.mjs SOURCE.md PREVIOUS_RUN OUTPUT_GRAPH.json REPAIR_RUN

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  GRAPH_SYSTEM_PROMPT, extractionTask, parseSourceUnits, buildChunks, parseJsonValue,
  validateExtraction, assembleGraph, reconcileConcepts, validateGraph, serializableGraph,
  mapConcurrent, writeJsonAtomic,
} from "./refine.mjs";

const config = {
  concurrency: integerEnv("REFINE_CONCURRENCY", 4, 1, 8),
  timeoutSeconds: integerEnv("REFINE_TIMEOUT_SECONDS", 180, 30, 900),
  repairChars: integerEnv("REFINE_REPAIR_CHUNK_CHARS", 8_000, 2_000, 24_000),
  maxSplitDepth: integerEnv("REFINE_REPAIR_SPLIT_DEPTH", 3, 0, 6),
  flatRepair: Bun.env.REFINE_REPAIR_FLAT === "1",
  model: Bun.env.REFINE_MODEL ?? "openrouter/inception/mercury-2",
  thinking: Bun.env.REFINE_THINKING ?? "medium",
  serviceTier: Bun.env.REFINE_SERVICE_TIER ?? "",
};

function integerEnv(name, fallback, min, max) {
  const value = Number(Bun.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

function combineExtractions(extractions) {
  const combined = { nodes: [], edges: [], evidenceFrames: [] };
  for (const extraction of extractions) {
    const offset = combined.nodes.length;
    combined.nodes.push(...extraction.nodes);
    combined.edges.push(...extraction.edges.map((edge) => ({ ...edge, from: edge.from + offset, to: edge.to + offset })));
    combined.evidenceFrames.push(...extraction.evidenceFrames.map((frame) => ({
      ...frame,
      claim: frame.claim + offset,
      evidence: frame.evidence.map((index) => index + offset),
      warrantGap: frame.warrantGap === null ? null : frame.warrantGap + offset,
      limitations: frame.limitations.map((index) => index + offset),
    })));
  }
  return combined;
}

function sourceNodeKind(kind) {
  if (kind === "heading") return "topic";
  if (kind === "details") return "example";
  if (kind === "table") return "evidence";
  if (kind === "code" || kind === "equation") return kind;
  return "source";
}

function fallbackExtraction(chunk, error) {
  const nodes = chunk.units.map((unit) => ({
    kind: sourceNodeKind(unit.kind), text: unit.text, sourceUnitIds: [unit.id],
    defines: [], requires: [], mentions: [], fills: [], need: "", gapType: null,
    origin: "source", chunkId: chunk.id, annotations: ["repair_source_fallback"],
  }));
  nodes.push({
    kind: "gap", text: null, sourceUnitIds: chunk.units.map((unit) => unit.id),
    defines: [], requires: [], mentions: [], fills: [],
    need: `Semantic shard repair failed: ${error?.message ?? error}`,
    gapType: "parsing_error", origin: "gap", chunkId: chunk.id,
    annotations: ["repair_parsing_error"],
  });
  return { nodes, edges: [], evidenceFrames: [] };
}

async function callOmp(chunk, extractionDirectory, stem) {
  const promptPath = resolve(extractionDirectory, `${stem}.prompt.txt`);
  await Bun.write(promptPath, extractionTask(chunk));
  const args = ["omp", "-p", "--mode", "text", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-rules", "--max-time", `${config.timeoutSeconds}s`, "--system-prompt", GRAPH_SYSTEM_PROMPT, "--model", config.model, "--thinking", config.thinking];
  if (config.serviceTier) args.push("--service-tier", config.serviceTier);
  args.push(`@${promptPath}`);
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" }); let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, (config.timeoutSeconds + 5) * 1_000);
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); clearTimeout(timer);
  await Promise.all([Bun.write(resolve(extractionDirectory, `${stem}.stdout.log`), stdout), Bun.write(resolve(extractionDirectory, `${stem}.stderr.log`), stderr)]);
  if (timedOut) throw new Error(`${stem} timed out after ${config.timeoutSeconds}s`);
  if (exitCode !== 0) throw new Error(`${stem} exited ${exitCode}: ${stderr.trim()}`);
  const validated = validateExtraction(parseJsonValue(stdout), chunk);
  await writeJsonAtomic(resolve(extractionDirectory, `${stem}.json`), validated);
  return validated;
}

function splitChunk(chunk, depth) {
  const approximate = Math.max(2_000, Math.floor(config.repairChars / (2 ** depth)));
  let parts = buildChunks(chunk.units, approximate);
  if (parts.length === 1 && chunk.units.length > 1) {
    const middle = Math.ceil(chunk.units.length / 2);
    parts = [{ ...chunk, units: chunk.units.slice(0, middle) }, { ...chunk, units: chunk.units.slice(middle) }];
  }
  return parts.map((part, index) => ({ ...part, id: `${chunk.id}-repair-${depth}-${String(index + 1).padStart(2, "0")}` }));
}

async function repairChunk(chunk, extractionDirectory, stem, depth = 0) {
  const cachedPath = resolve(extractionDirectory, `${stem}-d${depth}.json`);
  if (await Bun.file(cachedPath).exists()) {
    try { return validateExtraction(JSON.parse(await Bun.file(cachedPath).text()), chunk); } catch {}
  }
  try {
    return await callOmp(chunk, extractionDirectory, `${stem}-d${depth}`);
  } catch (error) {
    await Bun.write(resolve(extractionDirectory, `${stem}-d${depth}.error.txt`), `${error.stack ?? error}\n`);
    if (depth >= config.maxSplitDepth || chunk.units.length <= 1) return fallbackExtraction(chunk, error);
    const parts = splitChunk(chunk, depth + 1);
    if (parts.length <= 1) return fallbackExtraction(chunk, error);
    const repaired = [];
    for (const [index, part] of parts.entries()) repaired.push(await repairChunk(part, extractionDirectory, `${stem}-p${String(index + 1).padStart(2, "0")}`, depth + 1));
    return combineExtractions(repaired);
  }
}

async function repairFlatChunk(chunk, extractionDirectory, stem) {
  const parts = buildChunks(chunk.units, config.repairChars).map((part, index) => ({ ...part, id: `${chunk.id}-flat-${String(index + 1).padStart(2, "0")}` }));
  const repaired = [];
  for (const [index, part] of parts.entries()) {
    const partStem = `${stem}-flat-${String(index + 1).padStart(2, "0")}`;
    const cachedPath = resolve(extractionDirectory, `${partStem}.json`);
    if (await Bun.file(cachedPath).exists()) {
      try { repaired.push(validateExtraction(JSON.parse(await Bun.file(cachedPath).text()), part)); continue; } catch {}
    }
    try {
      const extraction = await callOmp(part, extractionDirectory, partStem);
      await writeJsonAtomic(cachedPath, extraction);
      repaired.push(extraction);
    } catch (error) {
      await Bun.write(resolve(extractionDirectory, `${partStem}.error.txt`), `${error.stack ?? error}\n`);
      const fallback = fallbackExtraction(part, error);
      await writeJsonAtomic(cachedPath, fallback);
      repaired.push(fallback);
    }
  }
  return combineExtractions(repaired);
}

async function main() {
  const [sourceArg, previousArg, outputArg, repairArg] = Bun.argv.slice(2);
  if (!sourceArg || !previousArg || !outputArg || !repairArg) throw new Error("Usage: ./repair-sharded-graph.mjs SOURCE.md PREVIOUS_RUN OUTPUT_GRAPH.json REPAIR_RUN");
  const sourcePath = resolve(sourceArg); const previousRun = resolve(previousArg); const outputPath = resolve(outputArg); const repairRun = resolve(repairArg);
  const previousConfig = JSON.parse(await Bun.file(resolve(previousRun, "config.json")).text());
  const source = await Bun.file(sourcePath).text(); const units = parseSourceUnits(source); const chunks = buildChunks(units, previousConfig.chunkChars);
  const extractionDirectory = resolve(repairRun, "extraction"); await mkdir(extractionDirectory, { recursive: true });
  await writeJsonAtomic(resolve(repairRun, "config.json"), { ...config, sourcePath, previousRun, outputPath, originalChunkChars: previousConfig.chunkChars, chunkCount: chunks.length });
  let reusedCount = 0; let repairedCount = 0;
  const extractions = await mapConcurrent(chunks, config.concurrency, async (chunk, index) => {
    const number = String(index + 1).padStart(4, "0");
    const repairPath = resolve(extractionDirectory, `extract-${number}.json`);
    if (await Bun.file(repairPath).exists()) { reusedCount += 1; return validateExtraction(JSON.parse(await Bun.file(repairPath).text()), chunk); }
    const originalPath = resolve(previousRun, "extraction", `extract-${number}.json`);
    if (await Bun.file(originalPath).exists()) { reusedCount += 1; return validateExtraction(JSON.parse(await Bun.file(originalPath).text()), chunk); }
    const extraction = config.flatRepair ? await repairFlatChunk(chunk, extractionDirectory, `extract-${number}`) : await repairChunk(chunk, extractionDirectory, `extract-${number}`);
    await writeJsonAtomic(repairPath, extraction); repairedCount += 1;
    console.error(`repaired shard ${number}: ${extraction.nodes.length} nodes, ${extraction.edges.length} edges`);
    return extraction;
  });
  const graph = assembleGraph(source, sourcePath, units, chunks, extractions);
  const modelEdges = graph.edges.length; reconcileConcepts(graph); validateGraph(graph);
  graph.metadata.shardRepair = { previousRun, originalChunkCount: chunks.length, reusedCount, repairedCount, model: config.model, retainedModelEdges: modelEdges };
  const output = serializableGraph(graph); await writeJsonAtomic(outputPath, output); await writeJsonAtomic(resolve(repairRun, "graph.json"), output);
  console.error(`graph: ${outputPath}; ${graph.nodes.length} nodes; ${graph.edges.length} edges; repaired ${repairedCount}/${chunks.length} shards`);
}

if (import.meta.main) await main();

export { combineExtractions, fallbackExtraction };
