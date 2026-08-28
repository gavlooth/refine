#!/usr/bin/env bun
// Remove graph-variant duplicates and navigation while preserving reachable outward prerequisites.
// Usage: ./prune-teaching-records.mjs GRAPH.json RECORDS.json OUTPUT.json [CONTENT_START_HEADING]
import { resolve } from "node:path";
import { writeJsonAtomic } from "./refine.mjs";

function isNavigationUnit(unit) {
  const text = (unit.text ?? "").trim();
  return /^-\s*\[[^\]]+\]\(#[^)]+\)\s*$/m.test(text) || /^\[(?:about|work|notebook|contact|skip to|christos chatzifountas)[^\]]*\]\(/i.test(text) || /^(?:reader-first technical explainer|reading size|appearance|dark mode|in this guide)$/i.test(text) || /^A\s+A\+\s+A\+\+$/i.test(text) || /^☾\s*dark mode$/i.test(text);
}

function retainedSourceRecordIds(graph, file, startHeading = "") {
  let startLine = 1;
  if (startHeading) {
    const heading = graph.sourceUnits.find((unit) => unit.kind === "heading" && unit.text.toLocaleLowerCase("en-US").includes(startHeading.toLocaleLowerCase("en-US")));
    if (heading) startLine = heading.startLine;
  }
  const allowedUnits = new Set(graph.sourceUnits.filter((unit) => unit.startLine >= startLine && !isNavigationUnit(unit)).map((unit) => unit.id));
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const semanticNodes = graph.nodes.filter((node) => node.kind !== "gap" && node.kind !== "source" && !node.coverageFallback && !(node.annotations ?? []).includes("repair_source_fallback") && (node.sourceUnitIds ?? []).some((id) => allowedUnits.has(id)));
  const covered = new Set(semanticNodes.flatMap((node) => node.sourceUnitIds ?? []).filter((id) => allowedUnits.has(id)));
  const keep = new Set(semanticNodes.map((node) => `teach-${node.id}`));
  const fallbackByUnit = new Map();
  for (const record of file.records) {
    if (!record.sourceNodeId) continue;
    const node = nodeById.get(record.sourceNodeId);
    if (!node || node.kind !== "source") continue;
    for (const id of record.sourceUnitIds ?? []) if (allowedUnits.has(id) && !covered.has(id) && !fallbackByUnit.has(id)) fallbackByUnit.set(id, record.id);
  }
  for (const id of fallbackByUnit.values()) keep.add(id);
  return { keep, allowedUnitCount: allowedUnits.size, semanticNodeCount: semanticNodes.length, fallbackRecordCount: fallbackByUnit.size };
}

function pruneTeachingRecords(graph, file, startHeading = "") {
  const selection = retainedSourceRecordIds(graph, file, startHeading); const keep = new Set(selection.keep);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of file.dependencies) if (keep.has(edge.to) && !keep.has(edge.from)) { keep.add(edge.from); changed = true; }
  }
  const records = file.records.filter((record) => keep.has(record.id)); const recordIds = new Set(records.map((record) => record.id));
  const dependencies = file.dependencies.filter((edge) => recordIds.has(edge.from) && recordIds.has(edge.to));
  const pruned = { ...structuredClone(file), records, dependencies };
  pruned.summary = { ...pruned.summary, prePruneRecordCount: file.records.length, recordCount: records.length, sourceRecordCount: records.filter((record) => record.sourceNodeId).length, generatedPrerequisiteCount: records.filter((record) => record.generated).length, teachingUnitCount: records.reduce((sum, record) => sum + (record.teachingUnits?.length ?? 0), 0), pendingRecordCount: records.filter((record) => record.status === "expansion_required").length, unresolvedPrerequisiteCount: records.filter((record) => record.status === "unresolved_prerequisite").length, prunedRecordCount: file.records.length - records.length, ...selection };
  return pruned;
}

async function main() {
  const [graphArg, recordsArg, outputArg, startHeading = ""] = Bun.argv.slice(2);
  if (!graphArg || !recordsArg || !outputArg) throw new Error("Usage: ./prune-teaching-records.mjs GRAPH.json RECORDS.json OUTPUT.json [CONTENT_START_HEADING]");
  const graph = JSON.parse(await Bun.file(resolve(graphArg)).text()); const records = JSON.parse(await Bun.file(resolve(recordsArg)).text()); const output = pruneTeachingRecords(graph, records, startHeading); await writeJsonAtomic(resolve(outputArg), output); console.error(JSON.stringify(output.summary));
}
if (import.meta.main) await main();
export { isNavigationUnit, pruneTeachingRecords, retainedSourceRecordIds };
