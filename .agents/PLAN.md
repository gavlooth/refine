# Active Plan — Representative cognitive-decompression experiment

- Active hypothesis: decomposing dense source prose into small grounded knowledge nodes plus explicit empty gaps will break rewrite imitation and provide a better substrate for later teaching synthesis than direct rewriting.
- Current approach: `graph.json` is always written after an extraction attempt. Strict extraction accepts complete chunks. A separately typed salvage pass keeps parseable node data from failed chunks, annotates node-level defects, retains omitted structural records as `metadata.salvageIssues`, emits `parsing_error` gaps only when no node survives, and covers every source unit locally.
- Validation path: require complete source provenance, retained semantic edges, valid evidence frames, explicit empty gaps, node annotations, and `metadata.salvageIssues`. A later pass may interpret annotations but must not turn them into factual claims without evidence.
- Current checkpoint: Chapter 10 graph at `experiments/chapter-10/graph.json` is `complete_with_gaps`; no remote call is running.
- Negative-memory constraints: do not abandon an extraction because a chunk has recoverable node-level errors; retain raw model artifacts, annotate rather than silently discard invalid topology, preserve source coverage, and do not auto-fill gaps.
- Assignment: primary agent owns integration and validation; no delegation requested.
