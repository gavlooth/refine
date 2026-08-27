#!/usr/bin/env bun
// Phase 2: model-score semantic density, split dense nodes, and add explicit expansions.
// Usage: ./decompress.mjs INPUT_GRAPH.json OUTPUT_GRAPH.json [RUN_DIRECTORY]

import { mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { validateGraph } from "./refine.mjs";

const config = {
  densityThreshold: numberEnv("REFINE_DECOMPOSE_DENSITY", 0.75, { min: 0, max: 1 }),
  densityBatchSize: integerEnv("REFINE_DENSITY_BATCH_SIZE", 48, { min: 1, max: 200 }),
  timeoutSeconds: integerEnv("REFINE_TIMEOUT_SECONDS", 180, { min: 30, max: 7_200 }),
  model: Bun.env.REFINE_MODEL ?? "",
  serviceTier: Bun.env.REFINE_SERVICE_TIER ?? "",
};

const EXPANSION_TYPES = new Set(["definition", "mechanism", "context", "interpretation", "example"]);
const PROTECTED_KINDS = new Set(["code", "equation"]);

function numberEnv(name, fallback, { min, max }) {
  const value = Number(Bun.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return value;
}

function integerEnv(name, fallback, bounds) {
  const value = numberEnv(name, fallback, bounds);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function words(text) {
  return typeof text === "string" ? text.match(/[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu)?.length ?? 0 : 0;
}

// Only used if model scoring failed; never presented as a model score.
function surfaceDensityScore(node) {
  if (!node || node.kind === "gap" || typeof node.text !== "string") return 0;
  return Number(Math.min(1, words(node.text) / 32).toFixed(3));
}

function scorableNodes(graph) {
  return graph.nodes.filter((node) =>
    node.kind !== "gap" &&
    !PROTECTED_KINDS.has(node.kind) &&
    typeof node.text === "string" &&
    node.text.trim(),
  );
}

function denseCandidates(graph, threshold = config.densityThreshold) {
  return graph.nodes.filter((node) =>
    node.kind !== "gap" &&
    !PROTECTED_KINDS.has(node.kind) &&
    typeof node.text === "string" &&
    !node.text.trimStart().startsWith("|") &&
    !node.text.includes("<!-- MathML:") &&
    node.densityScore >= threshold,
  );
}

function parseJson(text) {
  const trimmed = text.trim();
  const unfenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? trimmed;
  return JSON.parse(unfenced);
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter((value) => typeof value === "string").map((value) => value.trim()).filter(Boolean))];
}

function clampScore(value) {
  return typeof value === "number" && Number.isFinite(value) ? Number(Math.min(1, Math.max(0, value)).toFixed(3)) : null;
}

function batches(items, size) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
}

function densityPrompt(nodes) {
  return `You assess semantic information density for knowledge-graph nodes. Return JSON only:\n{\"scores\":[{\"id\":\"node id\",\"score\":0.0,\"reasons\":[\"brief reason\"]}]}\n\nScore 0 means one simple standalone idea. Score 1 means several ideas, prerequisites, causal steps, notation, evidence, or qualifications are compressed together. Score semantic compression, not raw word count.\n\nNODES:\n${JSON.stringify(nodes.map((node) => ({ id: node.id, kind: node.kind, text: node.text })), null, 2)}`;
}

function decompositionPrompt(candidates) {
  return `You perform phase-two cognitive decompression on a knowledge graph. Return JSON only:\n{\"items\":[{\"parentId\":\"...\",\"splits\":[{\"text\":\"small source-faithful idea\",\"densityScore\":0.0}],\"expansions\":[{\"type\":\"definition|mechanism|context|interpretation|example\",\"text\":\"small standalone explanatory idea\",\"densityScore\":0.0}]}]}\n\nRules:\n- Split only independently meaningful ideas already compressed in the parent.\n- Expansions explain prerequisites, mechanism, or interpretation that make the parent easier to understand. They are model-derived knowledge, not source claims.\n- Keep each returned text one small standalone idea.\n- Do not repeat the parent or produce prose summaries.\n- Return an item only when it improves cognitive decompression.\n\nDENSE NODES:\n${JSON.stringify(candidates.map((node) => ({ id: node.id, kind: node.kind, densityScore: node.densityScore, text: node.text, sourceUnitIds: node.sourceUnitIds })), null, 2)}`;
}

function validateScores(value, nodes) {
  if (!value || !Array.isArray(value.scores)) throw new Error("density response must contain a scores array");
  const known = new Set(nodes.map((node) => node.id));
  const scores = new Map();
  for (const item of value.scores) {
    const score = clampScore(item?.score);
    if (known.has(item?.id) && score !== null) scores.set(item.id, { score, reasons: uniqueStrings(item.reasons) });
  }
  return scores;
}

function applyDensityScores(input, modelScores) {
  const graph = structuredClone(input);
  let modelScoredNodeCount = 0;
  let fallbackScoreCount = 0;
  for (const node of graph.nodes) {
    if (node.kind === "gap") {
      node.densityScore = 0;
      node.densitySource = "structural";
      continue;
    }
    if (PROTECTED_KINDS.has(node.kind)) {
      node.densityScore = 1;
      node.densitySource = "protected";
      continue;
    }
    const modelScore = modelScores.get(node.id);
    if (modelScore) {
      node.densityScore = modelScore.score;
      node.densitySource = "model";
      node.densityReasons = modelScore.reasons;
      modelScoredNodeCount += 1;
      continue;
    }
    node.densityScore = surfaceDensityScore(node);
    node.densitySource = "fallback";
    node.annotations = uniqueStrings([...(node.annotations ?? []), "density_unscored"]);
    fallbackScoreCount += 1;
  }
  return { graph, modelScoredNodeCount, fallbackScoreCount };
}

function validatePlan(value, candidates) {
  if (!value || !Array.isArray(value.items)) throw new Error("decomposition response must contain an items array");
  const candidateIds = new Set(candidates.map((node) => node.id));
  const items = [];
  for (const item of value.items) {
    if (!item || !candidateIds.has(item.parentId)) continue;
    const splits = (Array.isArray(item.splits) ? item.splits : [])
      .filter((split) => split && typeof split.text === "string" && split.text.trim())
      .map((split) => ({ text: split.text.trim(), densityScore: clampScore(split.densityScore) }));
    const expansions = (Array.isArray(item.expansions) ? item.expansions : [])
      .filter((expansion) => expansion && EXPANSION_TYPES.has(expansion.type) && typeof expansion.text === "string" && expansion.text.trim())
      .map((expansion) => ({ type: expansion.type, text: expansion.text.trim(), densityScore: clampScore(expansion.densityScore) }));
    if (splits.length || expansions.length) items.push({ parentId: item.parentId, splits, expansions });
  }
  return items;
}

function nextId(graph, prefix) {
  let sequence = 1;
  const ids = new Set(graph.nodes.map((node) => node.id));
  while (ids.has(`${prefix}${String(sequence).padStart(6, "0")}`)) sequence += 1;
  return `${prefix}${String(sequence).padStart(6, "0")}`;
}

function childScore(item, node) {
  const score = clampScore(item.densityScore);
  if (score !== null) return { score, source: "model" };
  return { score: surfaceDensityScore(node), source: "fallback" };
}

function applyDecomposition(input, plan, candidates, densityMetadata) {
  const graph = structuredClone(input);
  const parentById = new Map(graph.nodes.map((node) => [node.id, node]));
  let splitCount = 0;
  let expansionCount = 0;
  for (const item of plan) {
    const parent = parentById.get(item.parentId);
    if (!parent) continue;
    for (const split of item.splits) {
      const node = {
        id: nextId(graph, "split-"),
        kind: "claim",
        text: split.text,
        sourceUnitIds: [...(parent.sourceUnitIds ?? [])],
        defines: [], requires: [], mentions: [], fills: [],
        origin: "decomposition",
        decompositionRole: "split",
        derivedFrom: parent.id,
      };
      const density = childScore(split, node);
      node.densityScore = density.score;
      node.densitySource = density.source;
      graph.nodes.push(node);
      graph.edges.push({ from: node.id, to: parent.id, relation: "elaborates", reason: "split from dense source node", origin: "decomposition" });
      splitCount += 1;
    }
    for (const expansion of item.expansions) {
      const node = {
        id: nextId(graph, "expand-"),
        kind: "expansion",
        text: expansion.text,
        sourceUnitIds: [],
        defines: [], requires: [], mentions: [], fills: [],
        origin: "expansion",
        decompositionRole: "knowledge_expansion",
        expansionType: expansion.type,
        epistemicStatus: "model_expansion",
        derivedFrom: parent.id,
      };
      const density = childScore(expansion, node);
      node.densityScore = density.score;
      node.densitySource = density.source;
      graph.nodes.push(node);
      graph.edges.push({ from: node.id, to: parent.id, relation: "elaborates", reason: `${expansion.type} expansion`, origin: "decomposition" });
      expansionCount += 1;
    }
  }
  graph.metadata = {
    ...(graph.metadata ?? {}),
    cognitiveDecomposition: {
      densityThreshold: config.densityThreshold,
      denseCandidateCount: candidates.length,
      decomposedParentCount: new Set(plan.map((item) => item.parentId)).size,
      splitCount,
      expansionCount,
      model: config.model || null,
      ...densityMetadata,
    },
  };
  validateGraph(graph);
  return graph;
}

async function ensureDirectory(path) { await mkdir(path, { recursive: true }); }

async function writeJsonAtomic(path, value) {
  await ensureDirectory(dirname(path));
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await Bun.write(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

async function callModel(prompt, runDirectory, stem) {
  const promptPath = resolve(runDirectory, `${stem}.prompt.txt`);
  await Bun.write(promptPath, prompt);
  const args = ["omp", "-p", "--mode", "text", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-rules", "--max-time", `${config.timeoutSeconds}s`];
  if (config.model) args.push("--model", config.model);
  if (config.serviceTier) args.push("--service-tier", config.serviceTier);
  args.push(`@${promptPath}`);
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  await Promise.all([Bun.write(resolve(runDirectory, `${stem}.stdout.log`), stdout), Bun.write(resolve(runDirectory, `${stem}.stderr.log`), stderr)]);
  if (exitCode !== 0) throw new Error(`OMP exited ${exitCode}: ${stderr.trim()}`);
  return parseJson(stdout);
}

async function main() {
  const input = Bun.argv[2];
  const output = Bun.argv[3];
  if (!input || !output) throw new Error("Usage: ./decompress.mjs INPUT_GRAPH.json OUTPUT_GRAPH.json [RUN_DIRECTORY]");
  const inputPath = resolve(input);
  const outputPath = resolve(output);
  const initialGraph = JSON.parse(await Bun.file(inputPath).text());
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDirectory = resolve(Bun.argv[4] ?? `${outputPath}.decompose-${timestamp}`);
  await ensureDirectory(runDirectory);

  const scoreInputs = scorableNodes(initialGraph);
  const modelScores = new Map();
  const densityIssues = [];
  for (const [index, batch] of batches(scoreInputs, config.densityBatchSize).entries()) {
    try {
      const response = await callModel(densityPrompt(batch), runDirectory, `density-${String(index + 1).padStart(4, "0")}`);
      for (const [id, score] of validateScores(response, batch)) modelScores.set(id, score);
    } catch (error) {
      densityIssues.push({ category: "density_scoring_error", batch: index + 1, reason: error.message });
    }
  }
  const density = applyDensityScores(initialGraph, modelScores);
  const candidates = denseCandidates(density.graph);
  await Bun.write(resolve(runDirectory, "candidates.json"), `${JSON.stringify(candidates, null, 2)}\n`);

  let plan = [];
  try {
    const response = candidates.length ? await callModel(decompositionPrompt(candidates), runDirectory, "decomposition") : { items: [] };
    plan = validatePlan(response, candidates);
  } catch (error) {
    densityIssues.push({ category: "decomposition_error", reason: error.message });
  }
  await Bun.write(resolve(runDirectory, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  const expanded = applyDecomposition(density.graph, plan, candidates, {
    modelScoredNodeCount: density.modelScoredNodeCount,
    fallbackScoreCount: density.fallbackScoreCount,
    densityIssues,
  });
  await writeJsonAtomic(outputPath, expanded);
  await writeJsonAtomic(resolve(runDirectory, "graph.json"), expanded);
  console.error(`scored ${density.modelScoredNodeCount}/${scoreInputs.length} natural-language nodes; decomposed ${plan.length}/${candidates.length} dense nodes; added ${expanded.metadata.cognitiveDecomposition.splitCount} splits and ${expanded.metadata.cognitiveDecomposition.expansionCount} expansions`);
}

if (import.meta.main) await main();

export { surfaceDensityScore, scorableNodes, denseCandidates, validateScores, applyDensityScores, validatePlan, applyDecomposition };
