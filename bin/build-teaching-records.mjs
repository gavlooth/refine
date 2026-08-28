#!/usr/bin/env bun
// Build deterministic source-node teaching records before any model expansion.
// Usage: ./build-teaching-records.mjs GRAPH.json OUTPUT.json
import { resolve } from "node:path";
import { writeJsonAtomic } from "./refine.mjs";

const DENSE_THRESHOLD = Number(Bun.env.REFINE_DECOMPOSE_DENSITY ?? 0.75);
const FALLBACK_DENSITY_WORDS = Number(Bun.env.REFINE_DENSITY_FALLBACK_WORDS ?? 32);
const PROTECTED = new Set(["code", "equation"]);
function chapterFor(node, unitById) {
  for (const id of node.sourceUnitIds ?? []) {
    const context = unitById.get(id)?.context ?? [];
    const chapter = context.find((item) => /^Chapter\s+\d+|^Appendix\s+|^Part\s+/i.test(item));
    if (chapter) return chapter;
    if (context.length) return context.at(-1);
  }
  return "Unscoped";
}

function wordCount(text) {
  return typeof text === "string" ? text.match(/[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu)?.length ?? 0 : 0;
}

function buildTeachingRecords(graph, definitionOverlay = null) {
  const unitById = new Map(graph.sourceUnits.map((unit) => [unit.id, unit]));
  let teachingUnitSequence = 0;
  const records = graph.nodes.filter((node) => node.kind !== "gap" && (node.sourceUnitIds?.length ?? 0) > 0).map((node) => {
    const densityScore = typeof node.densityScore === "number" ? node.densityScore : Math.min(1, wordCount(node.text) / FALLBACK_DENSITY_WORDS);
    const dense = !PROTECTED.has(node.kind) && densityScore >= DENSE_THRESHOLD;
    return {
      id: `teach-${node.id}`,
      sourceNodeId: node.id,
      sourceUnitIds: [...node.sourceUnitIds],
      chapter: chapterFor(node, unitById),
      kind: node.kind,
      sourceAnchor: node.text,
      sourceDefines: node.defines ?? [],
      sourceRequires: node.requires ?? [],
      densityScore,
      densitySource: typeof node.densityScore === "number" ? "graph" : "word_count_fallback",
      dense,
      status: dense ? "expansion_required" : "source_ready",
      minimumTeachingUnits: dense ? 2 : 1,
      teachingUnits: dense ? [] : [{ id: `teaching-unit-${String(++teachingUnitSequence).padStart(7, "0")}`, role: "source_statement", text: node.text, provenance: "source", epistemicStatus: "source_grounded", citations: [], derivedFrom: `teach-${node.id}`, expansionDepth: 0, requires: node.requires ?? [] }],
    };
  });
  const recordByNode = new Map(records.map((record) => [record.sourceNodeId, record.id]));
  const dependencies = graph.edges.map((edge) => ({ from: recordByNode.get(edge.from), to: recordByNode.get(edge.to), relation: edge.relation, reason: edge.reason ?? "" })).filter((edge) => edge.from && edge.to);
  let overlayDefinitionCount = 0;
  for (const definition of definitionOverlay?.records ?? []) {
    if (!definition.candidateDefinition) continue;
    const id = `teach-definition-${definition.gapId}`;
    const epistemicStatus = definition.status === "external_definition" ? "externally_verified" : definition.status === "source_recovery" || definition.status === "already_defined" ? "source_grounded" : "citation_needed";
    records.push({
      id, sourceNodeId: null, sourceUnitIds: definition.candidateSourceUnitIds ?? [], chapter: definition.chapter ?? "Definitions", kind: "definition_overlay", sourceAnchor: definition.label,
      sourceDefines: [definition.label], sourceRequires: [], densityScore: Math.min(1, wordCount(definition.candidateDefinition) / FALLBACK_DENSITY_WORDS), densitySource: "overlay",
      dense: false, status: "source_ready", minimumTeachingUnits: 1, generated: true, definitionGapId: definition.gapId,
      teachingUnits: [{ id: `teaching-unit-${String(++teachingUnitSequence).padStart(7, "0")}`, role: "definition", text: definition.candidateDefinition, provenance: definition.provenance ?? definition.proposalProvenance ?? "model_unverified", epistemicStatus, citations: definition.citations ?? [], derivedFrom: id, expansionDepth: 0, requires: [] }],
    });
    for (const dependent of definition.dependents ?? []) if (recordByNode.has(dependent)) dependencies.push({ from: id, to: recordByNode.get(dependent), relation: "enables", reason: `${dependent} requires ${definition.label}` });
    overlayDefinitionCount += 1;
  }
  const gaps = graph.nodes.filter((node) => node.kind === "gap").map((node) => ({ gapId: node.id, chapter: chapterFor(node, unitById), gapType: node.gapType, need: node.need, sourceUnitIds: node.sourceUnitIds ?? [], resolvedBy: node.resolvedBy ?? [], resolutionStatus: node.resolutionStatus ?? null }));
  return { schemaVersion: "teaching-records/v1", graphSource: graph.metadata?.sourcePath ?? null, denseThreshold: DENSE_THRESHOLD, records, dependencies, gaps, summary: { recordCount: records.length, denseRecordCount: records.filter((record) => record.dense).length, readyRecordCount: records.filter((record) => record.status === "source_ready").length, pendingRecordCount: records.filter((record) => record.status === "expansion_required").length, gapCount: gaps.length, teachingUnitCount: teachingUnitSequence, overlayDefinitionCount } };
}

async function main() { const input = Bun.argv[2]; const output = Bun.argv[3]; const overlayPath = Bun.argv[4]; if (!input || !output) throw new Error("Usage: ./build-teaching-records.mjs GRAPH.json OUTPUT.json [DEFINITION_OVERLAY.json]"); const graph = JSON.parse(await Bun.file(resolve(input)).text()); const overlay = overlayPath ? JSON.parse(await Bun.file(resolve(overlayPath)).text()) : null; const records = buildTeachingRecords(graph, overlay); await writeJsonAtomic(resolve(output), records); console.error(JSON.stringify(records.summary)); }
if (import.meta.main) await main();

export { buildTeachingRecords, chapterFor };
