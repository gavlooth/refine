# Active Plan — Representative cognitive-decompression experiment

- Active hypothesis: decomposing dense source prose into small grounded knowledge nodes plus explicit empty gaps will break rewrite imitation and provide a better substrate for later teaching synthesis than direct rewriting.
- Current approach: freeze `knowledge-graph/v3-cognitive-decompression`, run one representative multi-chunk source containing workflows, jargon, causal jumps, and evidence, and audit the resulting graph before changing the schema again.
- Validation path: require complete source provenance, retained semantic edges, valid evidence frames, empty linked gaps, no generated teaching content, and a manual classification of sampled gaps as useful, redundant, or wrong. Then compare one later graph-mediated teaching output against a direct rewrite of the same source.
- Next checkpoint: representative multi-chunk graph and gap audit.
- Negative-memory constraints: do not evaluate Markdown structure as the product; do not auto-fill gaps; do not encode a dense workflow as one frame; do not optimize node length or gap count as surrogate ship gates.
- Assignment: primary agent owns integration and validation; no delegation requested.
