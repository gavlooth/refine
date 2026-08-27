# Project Instructions

## Product authority

- `graph.json` is the product. Markdown structure and linear order are disposable source packaging.
- The governing objective is cognitive decompression, not prose rewriting and not ontology completeness.
- Preserve source knowledge, qualifications, citations, code, equations, provenance, and model-produced semantic edges.
- Knowledge nodes must contain one small, accurate, standalone idea.
- Missing definitions, causes, warrants, motivations, interpretations, context, or intermediate steps must remain first-class gap nodes with `text: null`.
- Never fill gap nodes in this project. Teaching synthesis is a separate later stage.
- Evidence frames are important. Dense workflow frames are not: represent workflows as sparse step nodes and local edges.

## Implementation

- Use Bun-native runtime, file, process, hashing, and test capabilities. Do not add dependencies unless the existing runtime cannot satisfy the contract.
- Keep extraction fail-closed: invalid or timed-out model responses do not produce an output graph.
- Keep graph writes atomic and write them only after validation passes.
- Do not reintroduce refined Markdown, Mermaid, sentence-length optimization, per-node rewrite loops, or generated scaffold definitions.
- Keep `/home/christos/refine.mjs` as a compatibility symlink to `bin/refine.mjs` unless explicitly retiring it.

## Verification

- Smallest gate: `bun test`
- Full local gate: `bun run check`
- For prompt/schema changes, replay a captured real response and run one real representative OMP extraction.
- Report graph evidence: knowledge-node count and size distribution, gap count and usefulness, retained model edges, evidence-frame count, source coverage, and unresolved cross-chunk concepts.

## Version control and checkpoints

- Use `jj status`, `jj diff`, and `jj describe` as the primary workflow; the repository is colocated with Git for interoperability.
- Keep the current experiment in `.agents/PLAN.md` and technical checkpoints in `.agents/SESSION_REPORT.md`.
