#!/usr/bin/env bun
// Merge graph variants over the same source without losing unique nodes or topology.
// Usage: ./merge-graph-variants.mjs OUTPUT.json GRAPH_A.json GRAPH_B.json [...]

import { resolve } from "node:path";
import { reconcileConcepts, serializableGraph, validateGraph, writeJsonAtomic } from "./refine.mjs";

function unique(values) { return [...new Set((values ?? []).filter(Boolean))]; }
function nodeKey(node) {
  const units = [...(node.sourceUnitIds ?? [])].sort();
  return JSON.stringify(node.kind === "gap"
    ? ["gap", node.gapType ?? null, node.need ?? "", units]
    : [node.kind, node.text ?? null, units]);
}

function mergeGraphs(graphs) {
  if (!graphs.length) throw new Error("At least one graph is required");
  const sourceHash = graphs[0].metadata?.sourceSha256;
  if (graphs.some((graph) => graph.metadata?.sourceSha256 !== sourceHash)) throw new Error("Graph variants do not share a source hash");
  const graph = {
    schemaVersion: graphs[0].schemaVersion,
    metadata: {
      ...graphs[0].metadata,
      generatedAt: new Date().toISOString(),
      mergedVariants: graphs.map((variant) => ({ model: variant.metadata?.model ?? null, nodes: variant.nodes.length, edges: variant.edges.length, validation: variant.validation?.status ?? null })),
      salvageIssues: unique(graphs.flatMap((variant) => variant.metadata?.salvageIssues ?? []).map((issue) => JSON.stringify(issue))).map((issue) => JSON.parse(issue)),
    },
    sourceUnits: graphs[0].sourceUnits,
    nodes: [], edges: [], evidenceFrames: [], concepts: [], unresolvedConcepts: [], validation: null,
    _nextNode: 1, _edgeKeys: new Set(),
  };
  const nodeByKey = new Map();
  const maps = [];
  for (const variant of graphs) {
    const idMap = new Map();
    for (const node of variant.nodes) {
      const key = nodeKey(node);
      let merged = nodeByKey.get(key);
      if (!merged) {
        merged = { ...structuredClone(node), id: `n${String(graph._nextNode++).padStart(7, "0")}` };
        graph.nodes.push(merged); nodeByKey.set(key, merged);
      } else {
        for (const field of ["defines", "requires", "mentions", "fills", "annotations"]) merged[field] = unique([...(merged[field] ?? []), ...(node[field] ?? [])]);
        if (node.coverageFallback) merged.coverageFallback = true;
      }
      idMap.set(node.id, merged.id);
    }
    maps.push(idMap);
  }
  const edgeKeys = new Set();
  graphs.forEach((variant, graphIndex) => {
    const idMap = maps[graphIndex];
    for (const edge of variant.edges) {
      const from = idMap.get(edge.from); const to = idMap.get(edge.to);
      if (!from || !to || from === to) continue;
      const key = `${from}\u0000${to}\u0000${edge.relation}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key); graph._edgeKeys.add(key); graph.edges.push({ ...structuredClone(edge), from, to });
    }
    for (const frame of variant.evidenceFrames ?? []) {
      const claim = idMap.get(frame.claim); const evidence = (frame.evidence ?? []).map((id) => idMap.get(id)).filter(Boolean);
      if (!claim || !evidence.length) continue;
      const warrantGap = frame.warrantGap === null ? null : idMap.get(frame.warrantGap) ?? null;
      const limitations = (frame.limitations ?? []).map((id) => idMap.get(id)).filter(Boolean);
      const key = JSON.stringify([claim, evidence, warrantGap, limitations]);
      if (graph.evidenceFrames.some((item) => item._key === key)) continue;
      graph.evidenceFrames.push({ ...structuredClone(frame), id: `ef${String(graph.evidenceFrames.length + 1).padStart(6, "0")}`, claim, evidence, warrantGap, limitations, _key: key });
    }
  });
  for (const frame of graph.evidenceFrames) delete frame._key;
  reconcileConcepts(graph);
  validateGraph(graph);
  return graph;
}

async function main() {
  const output = Bun.argv[2]; const inputs = Bun.argv.slice(3);
  if (!output || inputs.length < 2) throw new Error("Usage: ./merge-graph-variants.mjs OUTPUT.json GRAPH_A.json GRAPH_B.json [...]");
  const graphs = await Promise.all(inputs.map(async (path) => JSON.parse(await Bun.file(resolve(path)).text())));
  const merged = mergeGraphs(graphs); await writeJsonAtomic(resolve(output), serializableGraph(merged));
  console.error(`merged ${inputs.length} variants: ${merged.nodes.length} nodes, ${merged.edges.length} edges, ${merged.evidenceFrames.length} evidence frames`);
}
if (import.meta.main) await main();

export { mergeGraphs, nodeKey };
