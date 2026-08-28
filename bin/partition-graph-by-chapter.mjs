#!/usr/bin/env bun
// Partition one global graph and source into stable-ID top-level section artifacts.
// Usage: ./partition-graph-by-chapter.mjs SOURCE.md GRAPH.json OUTPUT_DIR [DEFINITION_OVERLAY.json]

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { annotateMarkdown } from "./annotate-markdown.mjs";
import { validateGraph, writeJsonAtomic } from "./refine.mjs";

function slug(value) { return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "section"; }

function sectionsFromUnits(units) {
  const sections = []; let current = null;
  for (const unit of [...units].sort((a, b) => a.startLine - b.startLine)) {
    if (unit.kind === "heading" && /^#\s+/.test(unit.text)) {
      if (current) sections.push(current);
      current = { title: unit.text.replace(/^#\s+/, "").trim(), startLine: unit.startLine, units: [] };
    }
    if (current) current.units.push(unit);
  }
  if (current) sections.push(current);
  return sections.map((section, index) => ({ ...section, index: index + 1, endLine: Math.max(...section.units.map((unit) => unit.endLine)) }));
}

function sectionGraph(globalGraph, section, overlayRecords = []) {
  const unitIds = new Set(section.units.map((unit) => unit.id));
  const nodes = globalGraph.nodes.map((node) => ({ ...structuredClone(node), sourceUnitIds: (node.sourceUnitIds ?? []).filter((id) => unitIds.has(id)) })).filter((node) => node.sourceUnitIds.length || (node.kind !== "gap" && node.derivedFrom && globalGraph.nodes.some((parent) => parent.id === node.derivedFrom && (parent.sourceUnitIds ?? []).some((id) => unitIds.has(id)))));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = globalGraph.edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to)).map(structuredClone);
  const evidenceFrames = (globalGraph.evidenceFrames ?? []).filter((frame) => nodeIds.has(frame.claim) && frame.evidence.every((id) => nodeIds.has(id)) && (frame.warrantGap === null || nodeIds.has(frame.warrantGap)) && frame.limitations.every((id) => nodeIds.has(id))).map(structuredClone);
  const sourceUnits = section.units.map((unit) => ({ ...structuredClone(unit), startLine: unit.startLine - section.startLine + 1, endLine: unit.endLine - section.startLine + 1 }));
  const local = {
    schemaVersion: globalGraph.schemaVersion,
    metadata: { ...structuredClone(globalGraph.metadata), section: { index: section.index, title: section.title, startLine: section.startLine, endLine: section.endLine }, sourceUnits: sourceUnits.length },
    sourceUnits, nodes, edges, evidenceFrames,
    concepts: (globalGraph.concepts ?? []).filter((concept) => [...(concept.definedBy ?? []), ...(concept.requiredBy ?? []), ...(concept.mentionedBy ?? []), ...(concept.gapNodes ?? [])].some((id) => nodeIds.has(id))).map(structuredClone),
    unresolvedConcepts: (globalGraph.unresolvedConcepts ?? []).filter((concept) => nodeIds.has(concept.gapNodeId) || (concept.requiredBy ?? []).some((id) => nodeIds.has(id))).map(structuredClone),
    definitionOverlay: overlayRecords.filter((record) => nodeIds.has(record.gapId)).map(structuredClone),
    validation: null,
  };
  const crossChapterDependencies = globalGraph.edges.filter((edge) => nodeIds.has(edge.from) !== nodeIds.has(edge.to)).map((edge) => ({ ...structuredClone(edge), direction: nodeIds.has(edge.from) ? "outgoing" : "incoming" }));
  local.metadata.section.crossChapterDependencies = crossChapterDependencies;
  validateGraph(local);
  return local;
}

async function main() {
  const [sourceArg, graphArg, outputArg, overlayArg] = Bun.argv.slice(2);
  if (!sourceArg || !graphArg || !outputArg) throw new Error("Usage: ./partition-graph-by-chapter.mjs SOURCE.md GRAPH.json OUTPUT_DIR [DEFINITION_OVERLAY.json]");
  const source = await Bun.file(resolve(sourceArg)).text();
  const graph = JSON.parse(await Bun.file(resolve(graphArg)).text());
  const overlay = overlayArg ? JSON.parse(await Bun.file(resolve(overlayArg)).text()) : { records: [] };
  const sections = sectionsFromUnits(graph.sourceUnits); const lines = source.replace(/\r\n?/g, "\n").split("\n"); const outputDirectory = resolve(outputArg);
  await mkdir(outputDirectory, { recursive: true }); const manifest = [];
  for (const section of sections) {
    const directory = resolve(outputDirectory, `${String(section.index).padStart(3, "0")}-${slug(section.title)}`); await mkdir(directory, { recursive: true });
    const localGraph = sectionGraph(graph, section, overlay.records ?? []);
    const localSource = `${lines.slice(section.startLine - 1, section.endLine).join("\n").trim()}\n`;
    const annotated = annotateMarkdown(localSource, localGraph);
    await Promise.all([
      writeJsonAtomic(resolve(directory, "graph.json"), localGraph),
      Bun.write(resolve(directory, "source.md"), localSource),
      Bun.write(resolve(directory, "source.annotated.md"), annotated.markdown),
      writeJsonAtomic(resolve(directory, "issues.json"), { summary: annotated.summary, issues: annotated.issues, statusByUnitId: annotated.statusByUnitId }),
    ]);
    manifest.push({ index: section.index, title: section.title, directory, nodeCount: localGraph.nodes.length, edgeCount: localGraph.edges.length, issueCount: annotated.summary.issueCount, definitionCount: localGraph.definitionOverlay.length, validation: localGraph.validation.status });
  }
  await writeJsonAtomic(resolve(outputDirectory, "manifest.json"), { schemaVersion: "chapter-partitions/v1", source: resolve(sourceArg), graph: resolve(graphArg), sectionCount: manifest.length, sections: manifest });
  console.error(`partitioned ${manifest.length} sections`);
}

if (import.meta.main) await main();

export { sectionGraph, sectionsFromUnits, slug };
