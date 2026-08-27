#!/usr/bin/env bun
// Resolve definition-overlay records from reachable Wikipedia sources with atomic checkpoints.
// Usage: ./resolve-definition-overlay.mjs INPUT_OVERLAY.json OUTPUT_OVERLAY.json

import { mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const concurrency = Number(Bun.env.REFINE_RESOLVE_CONCURRENCY ?? 12);
const requestTimeout = Number(Bun.env.REFINE_HTTP_TIMEOUT_SECONDS ?? 15) * 1_000;
const userAgent = "cognitive-refine/0.1 (definition resolution)";

function normalize(value) { return typeof value === "string" ? value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ") : ""; }
function firstSentences(text, limit = 2) { const sentences = (text.match(/[^.!?]+[.!?]+/g) ?? [text]).map((sentence) => sentence.trim()); return sentences.slice(0, limit).join(" ").trim().slice(0, 1_200); }
function pageUrl(title) { return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`; }

async function fetchJson(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { redirect: "follow", headers: { "user-agent": userAgent }, signal: AbortSignal.timeout(requestTimeout) });
      if (response.ok) return response.json();
      if (response.status !== 429 && response.status < 500) return null;
    } catch {}
    await Bun.sleep(500 * (2 ** attempt));
  }
  return null;
}

async function summaryForTitle(title) {
  const value = await fetchJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`);
  if (!value || value.type === "disambiguation" || !value.extract || !value.title) return null;
  return value;
}

async function resolveLabel(label, chapter) {
  let summary = await summaryForTitle(label);
  if (!summary) {
    const query = `${label} ${chapter === "Unscoped" ? "" : chapter.replace(/^Chapter\s+\d+\s+[—-]\s+/i, "")}`.trim();
    const search = await fetchJson(`https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*&srlimit=3&srsearch=${encodeURIComponent(query)}`);
    for (const hit of search?.query?.search ?? []) {
      summary = await summaryForTitle(hit.title);
      if (summary) break;
    }
  }
  if (!summary) return null;
  const excerpt = firstSentences(summary.extract);
  if (!excerpt) return null;
  const labelKey = normalize(label);
  const titleKey = normalize(summary.title);
  const confidence = labelKey === titleKey || labelKey.includes(titleKey) || titleKey.includes(labelKey) ? "high" : "medium";
  return {
    definition: excerpt,
    confidence,
    citation: {
      url: summary.content_urls?.desktop?.page ?? pageUrl(summary.title),
      title: summary.title,
      excerpt,
      claim: `Definition and introductory context for ${label}.`,
      verification: { reachable: true, status: 200, source: "wikipedia_rest" },
    },
  };
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await Bun.write(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

async function mapConcurrent(items, limit, mapper) {
  const results = new Array(items.length); let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) { const index = cursor++; if (index >= items.length) return; results[index] = await mapper(items[index], index); }
  });
  await Promise.all(workers); return results;
}

function applyResolution(record, resolution) {
  if (!resolution) {
    record.status = record.status === "unresolved" ? "citation_needed" : record.status;
    record.reason = record.reason || "No verified external definition source found.";
    return false;
  }
  record.status = "external_definition";
  record.provenance = "verified_external_source";
  record.confidence = resolution.confidence;
  record.candidateDefinition = resolution.definition;
  record.citations = [resolution.citation];
  record.reason = "Definition recovered from a reachable external reference.";
  return true;
}

async function main() {
  const input = Bun.argv[2]; const output = Bun.argv[3];
  if (!input || !output) throw new Error("Usage: ./resolve-definition-overlay.mjs INPUT_OVERLAY.json OUTPUT_OVERLAY.json");
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error("REFINE_RESOLVE_CONCURRENCY must be 1-32");
  const overlay = JSON.parse(await Bun.file(resolve(input)).text());
  const pending = overlay.records.filter((record) => record.status === "unresolved" || record.status === "citation_needed");
  const cache = new Map(); let completed = 0; let resolvedCount = 0;
  await mapConcurrent(pending, concurrency, async (record) => {
    const key = `${record.chapter}\u0000${normalize(record.label)}`;
    let promise = cache.get(key);
    if (!promise) { promise = resolveLabel(record.label, record.chapter).catch(() => null); cache.set(key, promise); }
    const resolved = applyResolution(record, await promise);
    if (resolved) resolvedCount += 1;
    completed += 1;
    if (completed % 50 === 0) {
      overlay.summary.lastExternalCheckpoint = completed;
      overlay.summary.resolvedCount = overlay.records.filter((item) => ["external_definition", "already_defined", "source_recovery"].includes(item.status)).length;
      overlay.summary.unresolvedCount = overlay.records.length - overlay.summary.resolvedCount;
      await writeJsonAtomic(resolve(output), overlay);
      console.error(`resolved ${resolvedCount}/${completed} checked records`);
    }
  });
  overlay.summary.lastExternalCheckpoint = completed;
  overlay.summary.resolvedCount = overlay.records.filter((item) => ["external_definition", "already_defined", "source_recovery"].includes(item.status)).length;
  overlay.summary.unresolvedCount = overlay.records.length - overlay.summary.resolvedCount;
  overlay.summary.statuses = Object.fromEntries(Object.entries(Object.groupBy(overlay.records, (record) => record.status)).map(([status, records]) => [status, records.length]));
  overlay.summary.externalResolver = { source: "Wikipedia REST/Search API", checkedCount: completed, newlyResolvedCount: resolvedCount, concurrency };
  await writeJsonAtomic(resolve(output), overlay);
  console.error(`complete: resolved ${resolvedCount}/${completed}; overlay ${overlay.summary.resolvedCount}/${overlay.records.length}`);
}

if (import.meta.main) await main();

export { normalize, firstSentences, applyResolution };
