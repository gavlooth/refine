#!/usr/bin/env bun
// Phase 4: resolve graph gaps with class-specific evidence and explicit provenance.
// Usage: ./resolve-gaps.mjs INPUT_GRAPH.json OUTPUT_GRAPH.json [RUN_DIRECTORY]

import { mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { validateGraph } from "./refine.mjs";

const config = {
  batchSize: integerEnv("REFINE_RESOLVE_BATCH_SIZE", 8, { min: 1, max: 64 }),
  timeoutSeconds: integerEnv("REFINE_TIMEOUT_SECONDS", 180, { min: 30, max: 7_200 }),
  model: Bun.env.REFINE_MODEL ?? "",
  thinking: Bun.env.REFINE_THINKING ?? "",
  serviceTier: Bun.env.REFINE_SERVICE_TIER ?? "",
};

const SOURCE_CLASSES = new Set(["parsing_error", "missing_reference"]);
const INJECTION_CLASSES = new Set(["missing_definition"]);

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

function gapClass(gap) {
  if (gap.gapType === "parsing_error") return "parsing_error";
  if (gap.gapType === "missing_definition") return "missing_definition";
  if (gap.gapType === "missing_reference") return "missing_reference";
  return "metadata";
}

function unresolvedGaps(graph) {
  const unitById = new Map(graph.sourceUnits.map((unit) => [unit.id, unit]));
  return graph.nodes
    .filter((node) => node.kind === "gap" && !node.resolutionStatus && !(node.resolvedBy?.length))
    .map((gap) => ({
      id: gap.id,
      gapClass: gapClass(gap),
      need: gap.need,
      gapType: gap.gapType,
      sourceUnitIds: gap.sourceUnitIds ?? [],
      sourceUnits: (gap.sourceUnitIds ?? []).map((id) => unitById.get(id)).filter(Boolean).map((unit) => ({ id: unit.id, kind: unit.kind, text: unit.text.slice(0, 6_000) })),
    }));
}

function sourceRecoveryPrompt(targets) {
  return `Recover source-grounded graph nodes for failed parsing or missing references. Return JSON only:\n{\"items\":[{\"gapId\":\"...\",\"nodes\":[{\"text\":\"one small factual source-grounded idea\",\"densityScore\":0.0}]}]}\n\nRules:\n- Use only information present in that target's source units.\n- Recover equations/references as small textual factual nodes when possible.\n- Do not add outside knowledge or invent missing content.\n- Return no item if the supplied source does not support recovery.\n\nTARGETS:\n${JSON.stringify(targets, null, 2)}`;
}

function definitionPrompt(targets) {
  return `Resolve missing-definition graph gaps with concise, useful model-derived definitions. Return JSON only:\n{\"items\":[{\"gapId\":\"...\",\"nodes\":[{\"text\":\"one small standalone definition\",\"densityScore\":0.0,\"confidence\":\"high|medium|low\"}]}]}\n\nRules:\n- The node is model-derived, never source-grounded.\n- Define exactly the requested concept in a way that helps the local graph.\n- If the request is ambiguous, return an item with confidence low and explain the ambiguity in the node text.\n- Return no item only if you cannot form a useful definition.\n\nTARGETS:\n${JSON.stringify(targets, null, 2)}`;
}

function validatePlan(value, targets, sourceGrounded) {
  if (!value || !Array.isArray(value.items)) throw new Error("resolver response must contain an items array");
  const targetById = new Map(targets.map((target) => [target.id, target]));
  const plan = [];
  for (const item of value.items) {
    const target = targetById.get(item?.gapId);
    if (!target) continue;
    const nodes = (Array.isArray(item.nodes) ? item.nodes : [])
      .filter((node) => node && typeof node.text === "string" && node.text.trim())
      .map((node) => ({ text: node.text.trim(), densityScore: clampScore(node.densityScore), confidence: typeof node.confidence === "string" ? node.confidence : null }));
    if (nodes.length) plan.push({ gapId: target.id, gapClass: target.gapClass, sourceGrounded, sourceUnitIds: target.sourceUnitIds, nodes });
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

function applyResolution(input, plans, targets, metadata) {
  const graph = structuredClone(input);
  const gapById = new Map(graph.nodes.filter((node) => node.kind === "gap").map((node) => [node.id, node]));
  let recoveredNodeCount = 0;
  let injectedNodeCount = 0;
  let resolvedGapCount = 0;
  for (const plan of plans) {
    const gap = gapById.get(plan.gapId);
    if (!gap) continue;
    const resolvedBy = [];
    for (const resolved of plan.nodes) {
      const sourceGrounded = plan.sourceGrounded;
      const node = {
        id: nextId(graph, sourceGrounded ? "recover-" : "resolve-"),
        kind: sourceGrounded ? "claim" : "injection",
        text: resolved.text,
        sourceUnitIds: sourceGrounded ? [...plan.sourceUnitIds] : [],
        defines: [], requires: [], mentions: [], fills: [],
        origin: sourceGrounded ? "recovery" : "injection",
        recoveryClass: plan.gapClass,
        epistemicStatus: sourceGrounded ? "source_recovery" : "model_injected",
        derivedFrom: gap.id,
        densityScore: resolved.densityScore ?? wordScore(resolved.text),
        densitySource: resolved.densityScore === null ? "fallback" : "model",
      };
      if (resolved.confidence) node.confidence = resolved.confidence;
      graph.nodes.push(node);
      graph.edges.push({ from: node.id, to: gap.id, relation: "fills", reason: `${plan.gapClass} resolution`, origin: "resolution" });
      resolvedBy.push(node.id);
      if (sourceGrounded) recoveredNodeCount += 1; else injectedNodeCount += 1;
    }
    if (resolvedBy.length) {
      gap.resolvedBy = uniqueStrings([...(gap.resolvedBy ?? []), ...resolvedBy]);
      gap.resolutionStatus = plan.sourceGrounded ? "source_recovery" : "model_injected";
      resolvedGapCount += 1;
    }
  }
  for (const target of targets.filter((target) => target.gapClass === "metadata")) {
    const gap = gapById.get(target.id);
    if (gap && !gap.resolutionStatus) {
      gap.resolutionStatus = "not_knowledge";
      gap.resolutionReason = "Metadata does not require a knowledge injection.";
    }
  }
  graph.metadata = {
    ...(graph.metadata ?? {}),
    gapResolution: {
      targetCount: targets.length,
      recoveredNodeCount,
      injectedNodeCount,
      resolvedGapCount,
      metadataGapCount: targets.filter((target) => target.gapClass === "metadata").length,
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
  if (!input || !output) throw new Error("Usage: ./resolve-gaps.mjs INPUT_GRAPH.json OUTPUT_GRAPH.json [RUN_DIRECTORY]");
  const inputPath = resolve(input);
  const outputPath = resolve(output);
  const graph = JSON.parse(await Bun.file(inputPath).text());
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDirectory = resolve(Bun.argv[4] ?? `${outputPath}.resolve-${timestamp}`);
  await ensureDirectory(runDirectory);

  const targets = unresolvedGaps(graph);
  await Bun.write(resolve(runDirectory, "targets.json"), `${JSON.stringify(targets, null, 2)}\n`);
  const plans = [];
  const resolutionIssues = [];
  for (const [gapClass, prompt, sourceGrounded] of [["parsing_error", sourceRecoveryPrompt, true], ["missing_reference", sourceRecoveryPrompt, true], ["missing_definition", definitionPrompt, false]]) {
    const classTargets = targets.filter((target) => target.gapClass === gapClass);
    for (const [index, batch] of batches(classTargets, config.batchSize).entries()) {
      try {
        const response = await callModel(prompt(batch), runDirectory, `${gapClass}-${String(index + 1).padStart(4, "0")}`);
        plans.push(...validatePlan(response, batch, sourceGrounded));
      } catch (error) {
        resolutionIssues.push({ category: `${gapClass}_resolution_error`, batch: index + 1, reason: error.message });
      }
    }
  }
  await Bun.write(resolve(runDirectory, "plan.json"), `${JSON.stringify(plans, null, 2)}\n`);
  const resolved = applyResolution(graph, plans, targets, { resolutionIssues });
  await writeJsonAtomic(outputPath, resolved);
  await writeJsonAtomic(resolve(runDirectory, "graph.json"), resolved);
  console.error(`resolved ${resolved.metadata.gapResolution.resolvedGapCount}/${targets.length} gaps; recovered ${resolved.metadata.gapResolution.recoveredNodeCount} source nodes; injected ${resolved.metadata.gapResolution.injectedNodeCount} definitions`);
}

if (import.meta.main) await main();

export { gapClass, unresolvedGaps, validatePlan, applyResolution };
