# Cognitive Refine

Cognitive Refine decomposes dense technical Markdown into a JSON knowledge graph. It exists because direct LLM rewrite prompts often preserve the source's compressed rhetoric, parallel lists, and unexplained jumps even when they change the wording.

This project does not produce a teaching guide yet. Its current job is to break the source apart without losing its knowledge, simplify each idea, and expose the explanations the source omitted.

## Current contract

The only product is a `knowledge-graph/v3-cognitive-decompression` JSON artifact containing:

- small, simplified, source-grounded knowledge nodes;
- exact source-unit provenance and quotations;
- semantic edges retained from extraction;
- cross-chunk concept dependencies;
- empty `text: null` gap nodes for missing definitions and explanatory bridges;
- evidence frames connecting claims, evidence, warrant gaps, and limitations;
- explicit validation and source-coverage results.

Missing knowledge is never filled automatically. A later graph-to-teaching project may fill selected gaps and construct a beginner-to-expert explanation.

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
| `REFINE_RETRIES` | `2` | Retries after an invalid or failed response |
| `REFINE_TIMEOUT_SECONDS` | `600` | Per-call terminal timeout |
| `REFINE_MODEL` | OMP default | Optional model override |

## Validation

```bash
bun test
bun run check
```

The graph validator rejects dangling edges, invalid evidence frames, non-empty gap nodes, uncovered source units, and modified code or display equations.

## Next product gate

Run one representative multi-chunk section containing dense workflows, jargon, causal jumps, and cited evidence. Audit whether its gaps identify real comprehension failures and whether its small nodes preserve all relevant qualifications. Only after that gate passes should the separate graph-to-teaching stage be built.
