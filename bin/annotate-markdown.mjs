#!/usr/bin/env bun
// Add invisible graded-coverage metadata beside source units for later document agents.
// Usage: ./annotate-markdown.mjs SOURCE.md GRAPH.json OUTPUT.md

import { mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const DEFAULT_ISSUE_TYPES = new Set(["parsing_error", "truncated_source", "missing_context", "context_missing", "missing_evidence", "missing_derivation", "missing_parameters", "missing_measurement", "unresolved_context", "empty_source_unit"]);

function cleanCommentValue(value) {
  return JSON.parse(JSON.stringify(value).replace(/--/g, "—"));
}

function issueComment(issue) {
  return `<!-- refine:issue ${JSON.stringify(cleanCommentValue(issue))} -->`;
}

function coverageComment(summary) {
  return `<!-- refine:coverage ${JSON.stringify(summary)} -->`;
}

function buildIssueAnnotations(graph) {
  const unitById = new Map(graph.sourceUnits.map((unit) => [unit.id, unit]));
  const fallbackIds = new Set();
  const extractedIds = new Set();
  const issues = [];
  const issueKeys = new Set();

  for (const node of graph.nodes) {
    if (node.kind !== "gap") {
      for (const id of node.sourceUnitIds ?? []) extractedIds.add(id);
      if ((node.annotations ?? []).includes("repair_source_fallback")) for (const id of node.sourceUnitIds ?? []) fallbackIds.add(id);
      continue;
    }
    if (node.resolutionStatus || node.resolvedBy?.length || !DEFAULT_ISSUE_TYPES.has(node.gapType)) continue;
    const sourceUnitIds = (node.sourceUnitIds ?? []).filter((id) => unitById.has(id));
    if (!sourceUnitIds.length) continue;
    const key = `${node.gapType}\u0000${sourceUnitIds.join("\u0000")}`;
    if (issueKeys.has(key)) continue;
    issueKeys.add(key);
    issues.push({
      id: node.id,
      version: 1,
      type: node.gapType,
      status: "open",
      action: "enrich_or_preserve",
      need: node.need,
      sourceUnitIds,
      annotations: node.annotations ?? [],
    });
  }

  for (const id of fallbackIds) {
    if (issues.some((issue) => issue.sourceUnitIds.includes(id))) continue;
    issues.push({ id: `fallback-${id}`, version: 1, type: "source_fallback", status: "open", action: "enrich_or_preserve", need: "Exact source text was preserved because semantic extraction did not complete.", sourceUnitIds: [id], annotations: ["repair_source_fallback"] });
  }

  const unresolvedIds = new Set(issues.flatMap((issue) => issue.sourceUnitIds));
  const statusByUnitId = Object.fromEntries(graph.sourceUnits.map((unit) => [unit.id, unresolvedIds.has(unit.id) ? "unresolved" : fallbackIds.has(unit.id) ? "source_fallback" : extractedIds.has(unit.id) ? "extracted" : "source_fallback"]));
  const counts = Object.values(statusByUnitId).reduce((result, status) => { result[status] = (result[status] ?? 0) + 1; return result; }, { extracted: 0, source_fallback: 0, unresolved: 0 });
  return { issues, statusByUnitId, summary: { version: 1, sourceUnitCount: graph.sourceUnits.length, issueCount: issues.length, ...counts } };
}

function annotateMarkdown(source, graph) {
  const annotations = buildIssueAnnotations(graph);
  const unitById = new Map(graph.sourceUnits.map((unit) => [unit.id, unit]));
  const commentsAfterLine = new Map();
  for (const issue of annotations.issues) {
    const endLine = Math.max(...issue.sourceUnitIds.map((id) => unitById.get(id)?.endLine ?? 1));
    const comments = commentsAfterLine.get(endLine) ?? [];
    comments.push(issueComment(issue));
    commentsAfterLine.set(endLine, comments);
  }
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const output = [];
  for (let index = 0; index < lines.length; index++) {
    output.push(lines[index]);
    if (index === 0) output.push("", coverageComment(annotations.summary));
    const comments = commentsAfterLine.get(index + 1);
    if (comments?.length) output.push("", ...comments);
  }
  return { markdown: `${output.join("\n").replace(/\n{4,}/g, "\n\n\n").trim()}\n`, ...annotations };
}

function issueIds(markdown) {
  const ids = [];
  for (const match of markdown.matchAll(/<!--\s*refine:(?:issue|resolved)\s+(\{[^]*?\})\s*-->/g)) {
    try { const value = JSON.parse(match[1]); if (typeof value.id === "string") ids.push(value.id); } catch {}
  }
  return [...new Set(ids)];
}

async function writeTextAtomic(path, text) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await Bun.write(temporary, text);
  await rename(temporary, path);
}

async function main() {
  const [sourceArg, graphArg, outputArg] = Bun.argv.slice(2);
  if (!sourceArg || !graphArg || !outputArg) throw new Error("Usage: ./annotate-markdown.mjs SOURCE.md GRAPH.json OUTPUT.md");
  const source = await Bun.file(resolve(sourceArg)).text();
  const graph = JSON.parse(await Bun.file(resolve(graphArg)).text());
  const annotated = annotateMarkdown(source, graph);
  await writeTextAtomic(resolve(outputArg), annotated.markdown);
  await writeTextAtomic(resolve(`${outputArg}.issues.json`), `${JSON.stringify({ summary: annotated.summary, issues: annotated.issues, statusByUnitId: annotated.statusByUnitId }, null, 2)}\n`);
  console.error(`annotated ${annotated.summary.issueCount} issues; ${annotated.summary.extracted} extracted, ${annotated.summary.source_fallback} fallback, ${annotated.summary.unresolved} unresolved`);
}

if (import.meta.main) await main();

export { annotateMarkdown, buildIssueAnnotations, issueComment, issueIds };
