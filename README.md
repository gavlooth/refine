# Cognitive Refine

Cognitive Refine turns dense technical HTML or Markdown into:

1. a provenance-grounded knowledge graph;
2. a cognitively decompressed and enriched graph;
3. a rigorous learner-facing Markdown document.

The governing objective is cognitive decompression. The source's layout and order are disposable; its knowledge, qualifications, equations, code, citations, and provenance are not.

## Requirements

- Bun 1.3 or newer
- `omp` configured with an available model/provider
- no package dependencies

Run the local gate:

```bash
bun run check
```

The compatibility entrypoint `/home/christos/refine.mjs` points to `bin/refine.mjs`.

## Core invariants

- `sourceUnits` preserve the raw source and stable IDs.
- Node `text` is semantic extraction, not a byte-matched quotation.
- Code and equation source units are restored from source bytes.
- Missing knowledge remains an empty `gap` node with `text: null`.
- Model expansions and injections are explicitly labeled and never attributed to the source.
- Graph writes are atomic and occur after graph validation.
- Failed semantic extraction never deletes source text: exact-source fallback and issue metadata preserve it.
- Generated documents may resolve an issue with evidence or preserve its `refine:issue` comment; they may not silently omit it.

## Quick start: normal Markdown

```bash
bun run refine -- input.md graph.json
bun run decompose -- graph.json graph.decompressed.json
bun run expand -- graph.decompressed.json graph.expanded.json
bun run resolve-gaps -- graph.expanded.json graph.resolved.json
bun run generate-document -- graph.resolved.json document.md
```

Use explicit run directories when artifacts must be reproducible:

```bash
bun bin/refine.mjs input.md graph.json runs/extraction
```

A run directory contains prompts, raw responses, errors, configuration, source provenance, validated chunk JSON, and a graph copy.

## HTML to Markdown

```bash
bun run html-to-markdown -- input.html source.md
```

`bin/html-to-markdown.mjs` preserves headings, links, images, lists, code blocks, and MathML `alttext` without Pandoc or another dependency.

Always inspect the converted source before extraction:

```bash
bun -e 'const m=await import("./bin/refine.mjs"); const s=await Bun.file("source.md").text(); const u=m.parseSourceUnits(s); console.log({characters:s.length,units:u.length,chunks:m.buildChunks(u).length})'
```

## Large documents: shard first, repair, then merge

Large books should keep one canonical source and stable source-unit IDs. Do not run independent shard graphs and concatenate them; local IDs and topology will collide.

### 1. Initial extraction

```bash
REFINE_MODEL=openrouter/inception/mercury-2 \
REFINE_CONCURRENCY=8 \
REFINE_RETRIES=0 \
REFINE_TIMEOUT_SECONDS=180 \
bun bin/refine.mjs source.md graph.initial.json runs/initial
```

### 2. Repair only failed shards

```bash
REFINE_MODEL=openai-codex/gpt-5.6-luna \
REFINE_THINKING=low \
REFINE_SERVICE_TIER=priority \
REFINE_CONCURRENCY=8 \
REFINE_TIMEOUT_SECONDS=90 \
REFINE_REPAIR_CHUNK_CHARS=4000 \
REFINE_REPAIR_FLAT=1 \
bun bin/repair-sharded-graph.mjs \
  source.md runs/initial graph.repaired.json runs/repair
```

Flat repair behavior:

- reuse every clean original shard;
- split failed shards directly into bounded leaves;
- make one semantic attempt per leaf;
- checkpoint successful leaves and full repaired shards;
- preserve exact source text plus a typed parsing gap when a leaf still fails;
- rebuild one global graph with stable IDs and cross-shard concept reconciliation.

### 3. Merge complementary graph variants

A repaired graph may preserve more source while an earlier graph retains more model topology. Merge both rather than choosing one:

```bash
bun bin/merge-graph-variants.mjs \
  graph.complete.json graph.initial.json graph.repaired.json
```

The merger deduplicates shared nodes and preserves unique edges, evidence frames, annotations, and issue metadata before global validation.

## Graded coverage and invisible issue comments

Create an annotated source after the final graph exists:

```bash
bun run annotate -- source.md graph.complete.json source.annotated.md
```

Each source unit receives a semantic status:

- `extracted`
- `source_fallback`
- `unresolved`

Fallback and unresolved locations receive an adjacent invisible comment:

```markdown
<!-- refine:issue {"id":"g1","type":"parsing_error","status":"open","action":"enrich_or_preserve","sourceUnitIds":["u1"],"need":"Recover the missing explanation."} -->
```

A later author may replace it with supported content plus:

```markdown
<!-- refine:resolved {"id":"g1","status":"resolved","resolution":"Explanation added from cited evidence."} -->
```

Otherwise the original issue comment must remain.

The annotator also writes `source.annotated.md.issues.json` with counts, issue records, and per-unit status.

## Chapter partitioning for books

Partition a repaired book graph into stable-ID top-level sections:

```bash
bun bin/partition-graph-by-chapter.mjs \
  source.md graph.complete.json chapters definition-resolution-overlay.complete.json
```

Each section directory contains:

- `graph.json`
- `source.md`
- `source.annotated.md`
- `issues.json`
- relevant definition-overlay records
- cross-section dependency metadata

The global `chapters/manifest.json` is the assembly authority.

## Phase 2: cognitive decomposition

```bash
bun run decompose -- graph.json graph.decompressed.json
```

`bin/decompress.mjs`:

- asks a model to assign semantic `densityScore` values;
- selects dense natural-language nodes;
- adds source-faithful split nodes;
- adds explicit model-derived knowledge-expansion nodes;
- preserves every prior node and edge.

Split nodes retain source provenance and use `origin: "decomposition"`. Expansion nodes use `origin: "expansion"` and `epistemicStatus: "model_expansion"`.

Iterate by using one decompressed graph as the next input. Stop when generated natural-language nodes fall below the configured threshold.

## Phase 3: graph expansion

```bash
bun run expand -- graph.decompressed.json graph.expanded.json
```

Expansion nodes use:

- `origin: "injection"`
- `injectionType`
- `derivedFrom`
- `epistemicStatus: "model_injected"`
- no source-unit provenance

For a gap-only pass:

```bash
REFINE_EXPAND_GAPS_ONLY=1 bun run expand -- input.json output.json
```

Keep gap-only passes bounded. Generic all-gap prompts can be poor ROI; class-specific resolution is usually better.

## Phase 4: typed gap resolution

```bash
bun run resolve-gaps -- graph.expanded.json graph.resolved.json
```

`bin/resolve-gaps.mjs` distinguishes:

- source recovery for parsing/reference failures;
- explicit model-derived definitions;
- metadata that is not knowledge.

The original empty gap remains visible and records typed resolution provenance.

### Definition-resolution overlays

For books with many definition gaps, keep teaching definitions in a separate overlay rather than rewriting authoritative graph gaps:

```bash
bun bin/build-definition-overlay.mjs graph.json definition-resolution-overlay.json
```

The overlay contains one context-sensitive record per original gap ID, with chapter context, dependents, status, provenance, confidence, citations, and candidate definition.

Related tools:

- `bin/propose-definitions.mjs` — one strict bounded proposal batch
- `bin/propose-definition-overlay.mjs` — all unresolved records in checkpointed waves
- `bin/research-definitions.mjs` — tool-enabled research batches
- `bin/resolve-definition-overlay.mjs` — Wikipedia REST/Search verification
- `bin/resolve-definition-overlay-fallback.mjs` — DuckDuckGo/Wiktionary fallback

Statuses such as `citation_needed` must remain visible. A model-generated URL or confidence value is not verified evidence.

## Phase 5: document generation

Normal graph-to-document generation:

```bash
bun run generate-document -- graph.resolved.json document.md
```

Use annotated source comments during synthesis:

```bash
REFINE_DOCUMENT_SOURCE=source.annotated.md \
REFINE_DOCUMENT_DIRECT=1 \
REFINE_MODEL=openai-codex/gpt-5.6-terra \
REFINE_THINKING=high \
REFINE_SERVICE_TIER=priority \
bun run generate-document -- graph.resolved.json document.md
```

The document agent:

- follows graph dependencies instead of source order;
- separates source claims from model-derived explanations;
- preserves or explicitly resolves every issue comment;
- writes rigorous definitions, derivations, examples, limitations, and exercises;
- rejects unsupported claims and silent gap removal.

## Document density gate

The final author is not allowed to recompress several graph nodes into one paragraph.

A prose paragraph is rejected when it has:

- at least 35 words and at least four sentences; or
- at least 90 words.

Machine comments, tables without prose sentences, fenced code, lists, and display math are excluded from prose-density scoring.

If generation fails the density gate, the output is rejected and the exact issues are written to `document-density-issues.json`.

Lossless deterministic decompression:

```bash
bun bin/decompress-prose.mjs input.md output.md
bun bin/decompress-book.mjs chapters
```

Residual dense paragraphs can be rewritten selectively:

```bash
REFINE_MODEL=openai-codex/gpt-5.6-luna \
REFINE_CONCURRENCY=8 \
bun bin/rewrite-dense-book.mjs chapters
```

Audit all chapter documents:

```bash
bun bin/audit-book.mjs chapters chapters/audit.json
```

Acceptance requires:

- no missing section documents;
- zero dense prose paragraphs;
- zero silently dropped issue IDs.

## Automated book generation

```bash
REFINE_MODEL=openai-codex/gpt-5.6-luna \
REFINE_THINKING=high \
REFINE_SERVICE_TIER=priority \
REFINE_CONCURRENCY=8 \
bun bin/generate-book.mjs chapters document.md
```

The generator reuses completed sections, isolates failures by chapter, assembles in manifest order, and writes `document.md.report.json`.

## Model roles used successfully

These are operational defaults, not hard requirements:

- Mercury 2: initial extraction and inexpensive decomposition
- Luna: high-throughput shard repair, density scoring, and chapter generation
- Terra: high-capability expansion, typed resolution, and difficult document synthesis
- Grok 4.6: alternate diagnostic/rewrite model when a GPT path fails

Always retain bounded external timers and checkpoint files. Do not infer quality from a timeout or malformed transport response.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `REFINE_CHUNK_CHARS` | `24000` | Approximate block-safe extraction chunk size |
| `REFINE_CONCURRENCY` | `4` | Bounded concurrent calls |
| `REFINE_RETRIES` | `2` | Extraction retries; set `0` for bounded experiments |
| `REFINE_TIMEOUT_SECONDS` | `600` | Per-call terminal limit |
| `REFINE_MODEL` | OMP default | Model selector |
| `REFINE_THINKING` | model/default | Model thinking level |
| `REFINE_SERVICE_TIER` | unset | OMP/OpenAI service tier |
| `REFINE_REPAIR_CHUNK_CHARS` | `8000` | Failed-shard leaf size |
| `REFINE_REPAIR_FLAT` | unset | Set `1` to skip recursive parent attempts |
| `REFINE_DECOMPOSE_DENSITY` | `0.75` | Density threshold for decomposition |
| `REFINE_DENSITY_BATCH_SIZE` | `48` | Nodes per density-scoring request |
| `REFINE_EXPAND_GAPS_ONLY` | unset | Set `1` to target unresolved gaps only |
| `REFINE_DOCUMENT_SOURCE` | unset | Annotated Markdown supplied to the author |
| `REFINE_DOCUMENT_DIRECT` | unset | Set `1` for graph/source-attached direct synthesis |
| `REFINE_DOCUMENT_TIMEOUT_SECONDS` | `600` | Document-agent limit |

## Generated artifacts and Git

Root HTML/PDF inputs plus `articles/` and `experiments/` are ignored by Git. They remain on disk but are not pushed. Code, tests, README, plans, and session reports are versioned.

Jujutsu may refuse new files larger than its configured snapshot limit. Do not raise the repository limit automatically; choose an explicit artifact-storage policy.

## Validation

```bash
bun test
bun run check
```

The graph validator checks source-unit references, source coverage, nonempty knowledge nodes, empty typed gaps, edge relations/endpoints, evidence frames, protected bytes, and duplicate topology.

Document validation checks Markdown structure, minimum completeness, issue-comment preservation, and prose density.

## Troubleshooting

### A model call returns malformed JSON

Keep raw stdout/stderr. Do not heuristically reinterpret ambiguous JSON escapes into authoritative data. Reduce batch size or require plain prose without LaTeX.

### A large repair appears stuck

Inspect leaf artifacts. Recursive repair may spend a full timeout before splitting. Prefer `REFINE_REPAIR_FLAT=1` for known failed large shards.

### A graph has 100% source coverage but poor semantics

Coverage only proves source preservation. Check:

- model edge count;
- evidence-frame count;
- `repair_source_fallback` count;
- `repair_parsing_error` count;
- graded coverage metadata.

Merge complementary graph variants instead of discarding one.

### A generated chapter falls back to source

Read its `document-run/` errors. Run deterministic prose decompression first, then target only residual dense paragraphs. Never regenerate already accepted chapters unnecessarily.
