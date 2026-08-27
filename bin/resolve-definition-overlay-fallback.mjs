#!/usr/bin/env bun
// Resolve remaining definition records from sourced DuckDuckGo abstracts or Wiktionary summaries.
// Usage: ./resolve-definition-overlay-fallback.mjs INPUT_OVERLAY.json OUTPUT_OVERLAY.json
import { mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const concurrency = Number(Bun.env.REFINE_RESOLVE_CONCURRENCY ?? 4);
const timeoutMs = Number(Bun.env.REFINE_HTTP_TIMEOUT_SECONDS ?? 15) * 1_000;
const userAgent = "cognitive-refine/0.1 (definition fallback)";

function firstSentences(text, limit = 2) { const values = (text.match(/[^.!?]+[.!?]+/g) ?? [text]).map((value) => value.trim()); return values.slice(0, limit).join(" ").slice(0, 1_200); }
async function fetchJson(url) { for (let attempt = 0; attempt < 3; attempt++) { try { const response = await fetch(url, { redirect: "follow", headers: { "user-agent": userAgent }, signal: AbortSignal.timeout(timeoutMs) }); if (response.ok) return response.json(); if (response.status !== 429 && response.status < 500) return null; } catch {} await Bun.sleep(500 * (2 ** attempt)); } return null; }
async function writeAtomic(path, value) { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.tmp-${process.pid}-${Date.now()}`; await Bun.write(temporary, `${JSON.stringify(value, null, 2)}\n`); await rename(temporary, path); }
async function mapConcurrent(items, limit, mapper) { let cursor = 0; const workers = Array.from({ length: Math.min(limit, items.length) }, async () => { while (true) { const index = cursor++; if (index >= items.length) return; await mapper(items[index], index); } }); await Promise.all(workers); }

async function duckDefinition(record) {
  const query = `${record.label} ${record.chapter === "Unscoped" ? "" : record.chapter.replace(/^Chapter\s+\d+\s+[—-]\s+/i, "")}`.trim();
  const result = await fetchJson(`https://api.duckduckgo.com/?format=json&no_html=1&no_redirect=1&skip_disambig=1&q=${encodeURIComponent(query)}`);
  if (!result?.AbstractText || !result?.AbstractURL) return null;
  const excerpt = firstSentences(result.AbstractText);
  return { definition: excerpt, title: result.Heading || record.label, url: result.AbstractURL, excerpt, source: "duckduckgo_abstract" };
}

async function wiktionaryDefinition(record) {
  const result = await fetchJson(`https://en.wiktionary.org/api/rest_v1/page/summary/${encodeURIComponent(record.label.replace(/ /g, "_"))}`);
  if (!result?.extract || !result?.title || result.type === "disambiguation") return null;
  const excerpt = firstSentences(result.extract);
  return { definition: excerpt, title: `${result.title} — Wiktionary`, url: result.content_urls?.desktop?.page ?? `https://en.wiktionary.org/wiki/${encodeURIComponent(result.title.replace(/ /g, "_"))}`, excerpt, source: "wiktionary_rest" };
}

async function main() {
  const input = Bun.argv[2]; const output = Bun.argv[3];
  if (!input || !output) throw new Error("Usage: ./resolve-definition-overlay-fallback.mjs INPUT_OVERLAY.json OUTPUT_OVERLAY.json");
  const overlay = JSON.parse(await Bun.file(resolve(input)).text());
  const pending = overlay.records.filter((record) => record.status === "citation_needed" || record.status === "unresolved");
  let completed = 0; let resolvedCount = 0;
  await mapConcurrent(pending, concurrency, async (record) => {
    const result = await duckDefinition(record).catch(() => null) ?? await wiktionaryDefinition(record).catch(() => null);
    if (result) {
      record.status = "external_definition";
      record.provenance = "verified_external_source";
      record.confidence = "medium";
      record.candidateDefinition = result.definition;
      record.citations = [{ url: result.url, title: result.title, excerpt: result.excerpt, claim: `Definition and introductory context for ${record.label}.`, verification: { reachable: true, status: 200, source: result.source } }];
      record.reason = "Definition recovered from a reachable external reference.";
      resolvedCount += 1;
    } else {
      record.status = "unresolved";
      record.reason = "No definition found in Wikipedia, DuckDuckGo sourced abstracts, or Wiktionary.";
    }
    completed += 1;
    if (completed % 50 === 0) { overlay.summary.lastFallbackCheckpoint = completed; await writeAtomic(resolve(output), overlay); console.error(`resolved ${resolvedCount}/${completed} fallback records`); }
  });
  overlay.summary.resolvedCount = overlay.records.filter((record) => ["external_definition", "already_defined", "source_recovery"].includes(record.status)).length;
  overlay.summary.unresolvedCount = overlay.records.length - overlay.summary.resolvedCount;
  overlay.summary.statuses = Object.fromEntries(Object.entries(Object.groupBy(overlay.records, (record) => record.status)).map(([status, records]) => [status, records.length]));
  overlay.summary.fallbackResolver = { sources: ["DuckDuckGo Instant Answer", "Wiktionary REST"], checkedCount: completed, newlyResolvedCount: resolvedCount, concurrency };
  await writeAtomic(resolve(output), overlay);
  console.error(`complete: resolved ${resolvedCount}/${completed}; overlay ${overlay.summary.resolvedCount}/${overlay.records.length}`);
}
if (import.meta.main) await main();
