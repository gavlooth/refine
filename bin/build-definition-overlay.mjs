#!/usr/bin/env bun
// Build one context-sensitive resolution record per definition gap.
// Usage: ./build-definition-overlay.mjs INPUT_GRAPH.json OUTPUT_OVERLAY.json

import { mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function normalize(value) {
  return typeof value === "string" ? value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ") : "";
}

function chapterFor(gap, unitById) {
  for (const id of gap.sourceUnitIds ?? []) {
    const context = unitById.get(id)?.context ?? [];
    const chapter = context.find((item) => /^Chapter\s+\d+/i.test(item));
    if (chapter) return chapter;
  }
  return "Unscoped";
}

function buildOverlay(graph) {
  const unitById = new Map(graph.sourceUnits.map((unit) => [unit.id, unit]));
  const conceptByGapId = new Map();
  for (const concept of graph.concepts ?? []) for (const gapId of concept.gapNodes ?? []) conceptByGapId.set(gapId, concept);
  const records = graph.nodes.filter((node) => node.kind === "gap" && node.gapType === "definition").map((gap) => {
    const concept = conceptByGapId.get(gap.id);
    const label = concept?.label ?? gap.fills?.[0] ?? gap.need;
    const chapter = chapterFor(gap, unitById);
    const canonicalConcept = normalize(label);
    return {
      gapId: gap.id,
      canonicalConcept,
      label,
      chapter,
      sourceUnitIds: gap.sourceUnitIds ?? [],
      dependents: concept?.requiredBy ?? [],
      firstUseContext: (gap.sourceUnitIds ?? []).map((id) => unitById.get(id)?.text ?? "").filter(Boolean).slice(0, 2),
      groupKey: `${chapter}\u0000${canonicalConcept}`,
      status: "unresolved",
      provenance: null,
      confidence: null,
      citations: [],
      resolutionNodeId: null,
      reason: "Awaiting source recovery or cited external definition.",
    };
  });
  const groups = Object.values(Object.groupBy(records, (record) => record.groupKey)).map((members) => ({
    groupKey: members[0].groupKey,
    canonicalConcept: members[0].canonicalConcept,
    chapter: members[0].chapter,
    label: members[0].label,
    gapIds: members.map((record) => record.gapId),
    dependentCount: Math.max(...members.map((record) => record.dependents.length)),
    status: "pending",
  })).sort((a, b) => b.dependentCount - a.dependentCount || a.chapter.localeCompare(b.chapter) || a.canonicalConcept.localeCompare(b.canonicalConcept));
  return {
    schemaVersion: "definition-resolution-overlay/v1",
    graphSource: graph.metadata?.sourcePath ?? null,
    graphValidation: graph.validation?.status ?? null,
    records,
    groups,
    summary: {
      definitionGapCount: records.length,
      canonicalGroupCount: groups.length,
      resolvedCount: 0,
      unresolvedCount: records.length,
    },
  };
}

function triageSourceDefinitions(graph, overlay) {
  const unitsByChapter = new Map();
  for (const unit of graph.sourceUnits) {
    const chapter = (unit.context ?? []).find((item) => /^Chapter\s+\d+/i.test(item)) ?? "Unscoped";
    const units = unitsByChapter.get(chapter) ?? [];
    units.push(unit);
    unitsByChapter.set(chapter, units);
  }
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let alreadyDefinedCount = 0;
  for (const record of overlay.records) {
    if (!record.label || record.label.length > 80) continue;
    const term = escape(record.label);
    const definition = new RegExp(`\\b${term}\\b\\s+(?:is defined as|is called|denotes|refers to)\\b|\\b(?:we|this text)\\s+(?:define|call)\\b[^.]{0,120}\\b${term}\\b`, "i");
    const matches = (unitsByChapter.get(record.chapter) ?? []).filter((unit) => definition.test(unit.text)).slice(0, 2);
    if (!matches.length) continue;
    record.status = "already_defined";
    record.provenance = "source_definition_match";
    record.confidence = "high";
    record.candidateSourceUnitIds = matches.map((unit) => unit.id);
    record.reason = "Explicit local definition pattern found in the same chapter.";
    alreadyDefinedCount += 1;
  }
  overlay.summary.alreadyDefinedCount = alreadyDefinedCount;
  overlay.summary.unresolvedCount = overlay.records.filter((record) => record.status === "unresolved").length;
  overlay.summary.statuses = Object.fromEntries(Object.entries(Object.groupBy(overlay.records, (record) => record.status)).map(([status, records]) => [status, records.length]));
  return overlay;
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await Bun.write(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

async function main() {
  const input = Bun.argv[2];
  const output = Bun.argv[3];
  if (!input || !output) throw new Error("Usage: ./build-definition-overlay.mjs INPUT_GRAPH.json OUTPUT_OVERLAY.json");
  const graph = JSON.parse(await Bun.file(resolve(input)).text());
  const overlay = triageSourceDefinitions(graph, buildOverlay(graph));
  await writeJsonAtomic(resolve(output), overlay);
  console.error(`overlay: ${overlay.summary.definitionGapCount} definition gaps in ${overlay.summary.canonicalGroupCount} context-sensitive groups`);
}

if (import.meta.main) await main();

export { buildOverlay, triageSourceDefinitions };
