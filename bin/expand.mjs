#!/usr/bin/env bun
// Phase 3: inject useful model-derived knowledge and resolve graph gaps transparently.
// Usage: ./expand.mjs INPUT_GRAPH.json OUTPUT_GRAPH.json [RUN_DIRECTORY]

import { mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { validateGraph } from "./refine.mjs";

const config = {
  batchSize: integerEnv("REFINE_EXPAND_BATCH_SIZE", 48, { min: 1, max: 200 }),
  detailDensity: numberEnv("REFINE_EXPAND_DETAIL_DENSITY", 0.5, { min: 0, max: 1 }),
  gapsOnly: Bun.env.REFINE_EXPAND_GAPS_ONLY === "1",
  timeoutSeconds: integerEnv("REFINE_TIMEOUT_SECONDS", 180, { min: 30, max: 7_200 }),
  model: Bun.env.REFINE_MODEL ?? "",
  thinking: Bun.env.REFINE_THINKING ?? "",
  serviceTier: Bun.env.REFINE_SERVICE_TIER ?? "",
};

const INJECTION_TYPES = new Set(["definition", "mechanism", "context", "warrant", "transition", "interpretation", "example", "citation_needed", "uncertainty"]);
const GAP_RELATIONS = new Set(["fills", "supports", "enables"]);
const NODE_RELATIONS = new Set(["elaborates", "enables", "supports"]);
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

function expansionTargets(graph, { gapsOnly = config.gapsOnly, detailDensity = config.detailDensity } = {}) {
  const unresolvedGaps = graph.nodes.filter((node) => node.kind === "gap" && !(node.resolvedBy?.length));
  if (gapsOnly) return unresolvedGaps;
  const detailNodes = graph.nodes.filter((node) =>
    node.kind !== "gap" &&
    !PROTECTED_KINDS.has(node.kind) &&
    (node.origin === "source" || node.origin === "decomposition") &&
    node.densityScore >= detailDensity &&
    typeof node.text === "string" &&
    !node.text.trimStart().startsWith("|") &&
    !node.text.includes("<!-- MathML:"),
  );
  return [...unresolvedGaps, ...detailNodes];
}

function targetPayload(node) {
  return node.kind === "gap"
    ? { id: node.id, targetType: "gap", need: node.need, gapType: node.gapType, sourceUnitIds: node.sourceUnitIds }
    : { id: node.id, targetType: "node", kind: node.kind, densityScore: node.densityScore, text: node.text.slice(0, 3_000), sourceUnitIds: node.sourceUnitIds };
}

function expansionPrompt(targets) {
  return `You improve a knowledge graph by injecting useful, explicitly model-derived information. Return JSON only:\n{\"items\":[{\"targetId\":\"...\",\"injections\":[{\"type\":\"definition|mechanism|context|warrant|transition|interpretation|example|citation_needed|uncertainty\",\"text\":\"one small standalone idea\",\"densityScore\":0.0,\"relation\":\"fills|elaborates|enables|supports\",\"reason\":\"brief graph-flow reason\"}]}]}\n\nRules:\n- Fill a gap only when the injected text directly answers its stated need. Keep the original gap node; do not erase it.\n- For a node, inject only information that materially improves understanding, causal flow, warrant, context, or a missing prerequisite.\n- Mark uncertain, unsupported, or citation-dependent material with type uncertainty or citation_needed.\n- Injection text is model-derived, not source-grounded. Do not claim it appeared in the source.\n- Use one small idea per injection and return no item where no useful addition exists.\n\nTARGETS:\n${JSON.stringify(targets.map(targetPayload), null, 2)}`;
}

function validatePlan(value, targets) {
  if (!value || !Array.isArray(value.items)) throw new Error("expansion response must contain an items array");
  const targetById = new Map(targets.map((target) => [target.id, target]));
  const plan = [];
  for (const item of value.items) {
    const target = targetById.get(item?.targetId);
    if (!target) continue;
    const allowedRelations = target.kind === "gap" ? GAP_RELATIONS : NODE_RELATIONS;
    const injections = (Array.isArray(item.injections) ? item.injections : [])
      .filter((injection) => injection && INJECTION_TYPES.has(injection.type) && typeof injection.text === "string" && injection.text.trim() && allowedRelations.has(injection.relation))
      .map((injection) => ({
        type: injection.type,
        text: injection.text.trim(),
        densityScore: clampScore(injection.densityScore),
        relation: injection.relation,
        reason: typeof injection.reason === "string" ? injection.reason.trim() : "",
      }));
    if (injections.length) plan.push({ targetId: target.id, injections });
  }
  return plan;
}

function nextId(graph, prefix) {
  let sequence = 1;
  const ids = new Set(graph.nodes.map((node) => node.id));
  while (ids.has(`${prefix}${String(sequence).padStart(6, "0")}`)) sequence += 1;
  return `${prefix}${String(sequence).padStart(6, "0")}`;
}

function wordScore(text) {
  const count = typeof text === "string" ? text.match(/[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu)?.length ?? 0 : 0;
  return Number(Math.min(1, count / 32).toFixed(3));
}

function applyExpansion(input, plan, targets, metadata) {
  const graph = structuredClone(input);
  const targetById = new Map(graph.nodes.map((node) => [node.id, node]));
  let injectionCount = 0;
  let resolvedGapCount = 0;
  for (const item of plan) {
    const target = targetById.get(item.targetId);
    if (!target) continue;
    const injectedIds = [];
    for (const injection of item.injections) {
      const node = {
        id: nextId(graph, "inject-"),
        kind: "injection",
        text: injection.text,
        sourceUnitIds: [],
        defines: [], requires: [], mentions: [], fills: [],
        origin: "injection",
        injectionType: injection.type,
        epistemicStatus: "model_injected",
        derivedFrom: target.id,
        densityScore: injection.densityScore ?? wordScore(injection.text),
        densitySource: injection.densityScore === null ? "fallback" : "model",
      };
      graph.nodes.push(node);
      graph.edges.push({ from: node.id, to: target.id, relation: injection.relation, reason: injection.reason, origin: "injection" });
      injectedIds.push(node.id);
      injectionCount += 1;
    }
    if (target.kind === "gap" && injectedIds.length) {
      target.resolvedBy = uniqueStrings([...(target.resolvedBy ?? []), ...injectedIds]);
      target.resolutionStatus = "model_injected";
      resolvedGapCount += 1;
    }
  }
  graph.metadata = {
    ...(graph.metadata ?? {}),
    graphExpansion: {
      targetCount: targets.length,
      expandedTargetCount: new Set(plan.map((item) => item.targetId)).size,
      injectionCount,
      resolvedGapCount,
      model: config.model || null,
      ...metadata,
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
  if (config.thinking) args.push("--thinking", config.thinking);
  if (config.serviceTier) args.push("--service-tier", config.serviceTier);
  args.push(`@${promptPath}`);
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, (config.timeoutSeconds + 5) * 1_000);
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  await Promise.all([Bun.write(resolve(runDirectory, `${stem}.stdout.log`), stdout), Bun.write(resolve(runDirectory, `${stem}.stderr.log`), stderr)]);
  if (timedOut) throw new Error(`OMP timed out after ${config.timeoutSeconds}s`);
  if (exitCode !== 0) throw new Error(`OMP exited ${exitCode}: ${stderr.trim()}`);
  return parseJson(stdout);
}

async function main() {
  const input = Bun.argv[2];
  const output = Bun.argv[3];
  if (!input || !output) throw new Error("Usage: ./expand.mjs INPUT_GRAPH.json OUTPUT_GRAPH.json [RUN_DIRECTORY]");
  const inputPath = resolve(input);
  const outputPath = resolve(output);
  const graph = JSON.parse(await Bun.file(inputPath).text());
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDirectory = resolve(Bun.argv[4] ?? `${outputPath}.expand-${timestamp}`);
  await ensureDirectory(runDirectory);

  const targets = expansionTargets(graph);
  await Bun.write(resolve(runDirectory, "targets.json"), `${JSON.stringify(targets, null, 2)}\n`);
  const plans = [];
  const expansionIssues = [];
  for (const [index, batch] of batches(targets, config.batchSize).entries()) {
    try {
      const response = await callModel(expansionPrompt(batch), runDirectory, `expand-${String(index + 1).padStart(4, "0")}`);
      plans.push(...validatePlan(response, batch));
    } catch (error) {
      expansionIssues.push({ category: "expansion_error", batch: index + 1, reason: error.message });
    }
  }
  await Bun.write(resolve(runDirectory, "plan.json"), `${JSON.stringify(plans, null, 2)}\n`);
  const expanded = applyExpansion(graph, plans, targets, { expansionIssues });
  await writeJsonAtomic(outputPath, expanded);
  await writeJsonAtomic(resolve(runDirectory, "graph.json"), expanded);
  console.error(`expanded ${new Set(plans.map((item) => item.targetId)).size}/${targets.length} targets; added ${expanded.metadata.graphExpansion.injectionCount} injections; resolved ${expanded.metadata.graphExpansion.resolvedGapCount} gaps`);
}

if (import.meta.main) await main();

export { expansionTargets, validatePlan, applyExpansion };
