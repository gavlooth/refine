# Cognitive Refine

Cognitive Refine decomposes dense technical Markdown into a JSON knowledge graph. It exists because direct LLM rewrite prompts often preserve the source's compressed rhetoric, parallel lists, and unexplained jumps even when they change the wording.

This project does not produce a teaching guide yet. Its current job is to break the source apart without losing its knowledge, simplify each idea, and expose the explanations the source omitted.

## Graph contract

`knowledge-graph/v3-cognitive-decompression` is a JSON artifact containing:

- source-grounded knowledge nodes with `sourceUnitIds` pointing to verbatim raw `sourceUnits`;
- semantic edges, evidence frames, cross-chunk prerequisites, and explicit empty gaps;
- node annotations and bounded `metadata.salvageIssues` for extraction defects;
- graph validation and complete source-coverage results.

Node text is semantic extraction, not a quotation. Raw provenance remains in `sourceUnits`; no lexical quote-matching field is used.

## Phase 2: cognitive decomposition

`decompress.mjs` scores natural-language node density with a model, then splits dense source nodes and adds explicitly model-derived expansion nodes. It never overwrites extracted nodes:

- split nodes retain their parent’s `sourceUnitIds`, `derivedFrom`, and `origin: "decomposition"`;
- expansion nodes use `origin: "expansion"`, `derivedFrom`, `expansionType`, and `epistemicStatus: "model_expansion"`;
- every node receives `densityScore` and a source (`model`, `fallback`, `structural`, or `protected`).

```bash
bun run decompose -- INPUT_GRAPH.json OUTPUT_GRAPH.json
```

## Phase 3: graph expansion

`expand.mjs` injects useful model-derived knowledge into unresolved gaps and high-detail nodes. It retains every prior node and makes the boundary explicit:

- injected nodes use `origin: "injection"`, `injectionType`, `derivedFrom`, and `epistemicStatus: "model_injected"`;
- gap nodes stay visible and record `resolvedBy` plus `resolutionStatus: "model_injected"`;
- `fills`/`elaborates`/`enables` edges expose the resulting knowledge flow;
- failed expansion batches remain in `metadata.graphExpansion.expansionIssues`.

```bash
bun run expand -- INPUT_GRAPH.json OUTPUT_GRAPH.json
```

## Phase 4: typed gap resolution

`resolve-gaps.mjs` handles each unresolved class with its matching evidence:

- `parsing_error` and `missing_reference` recover source-grounded nodes from the affected source units;
- `missing_definition` produces explicitly model-derived definitions;
- `metadata` is marked `not_knowledge`, not padded with fabricated content.

Resolved gaps retain the original empty node, a `resolvedBy` link, and a typed resolution status.

```bash
bun run resolve-gaps -- INPUT_GRAPH.json OUTPUT_GRAPH.json
```

## Phase 5: document synthesis

`generate-document.mjs` launches a tool-enabled document agent. The agent uses the resolved graph as a syllabus, researches remaining gaps with web search, preserves graph provenance boundaries, and writes a rigorous cited Markdown document.

```bash
bun run generate-document -- INPUT_GRAPH.json OUTPUT_DOCUMENT.md
```

## Requirements

- Bun 1.3 or newer
- `omp` configured with an available model/provider

No package dependencies are required.

## Usage

```bash
./bin/refine.mjs INPUT.md OUTPUT_GRAPH.json [RUN_DIRECTORY]
```

Or through Bun:

```bash
bun run refine -- INPUT.md OUTPUT_GRAPH.json
```

Existing calls to `/home/christos/refine.mjs` continue to work through a compatibility symlink.

The output path is not overwritten unless `REFINE_OVERWRITE=1` is set. The run directory keeps prompts, raw model responses, errors, configuration, provenance, and a copy of the validated graph.

Configuration:

| Variable | Default | Purpose |
|---|---:|---|
| `REFINE_CHUNK_CHARS` | `24000` | Approximate block-safe chunk size |
| `REFINE_CONCURRENCY` | `4` | Maximum concurrent extraction calls |
| `REFINE_RETRIES` | `2` | Retries after failed extraction calls |
| `REFINE_TIMEOUT_SECONDS` | `600` | Per-call terminal timeout |
| `REFINE_MODEL` | OMP default | Optional model override |
| `REFINE_DECOMPOSE_DENSITY` | `0.75` | Model-score threshold for source-node decomposition |
| `REFINE_DENSITY_BATCH_SIZE` | `48` | Natural-language nodes per density-scoring request |
| `REFINE_EXPAND_GAPS_ONLY` | unset | Set `1` to target unresolved gaps only; avoids re-expanding detailed nodes. |

## Validation

```bash
bun test
bun run check
```

The graph validator rejects dangling edges, invalid evidence frames, non-empty gap nodes, uncovered source units, and modified code or display equations.

## Next product gate

Run one representative multi-chunk section containing dense workflows, jargon, causal jumps, and cited evidence. Audit whether its gaps identify real comprehension failures and whether its small nodes preserve all relevant qualifications. Only after that gate passes should the separate graph-to-teaching stage be built.
