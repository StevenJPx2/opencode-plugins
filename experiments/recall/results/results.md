# Recall experiment results

- Date: 2026-11-27
- Model: `opencode/hy4-flash-free` (context limit not reported), OpenCode v2.4.1
- Transcripts: 5 × 108 messages, seed 1; 12 planted facts each (exact string, constraint, correction, rejected approach at ages ≈10, 50 and 100)
- Compaction: manual, `keep.tokens` = 4000. Compaction kept the newest messages verbatim from age 10–20 onward (median 20); older facts survive only through the summary, a lookup or a pin.

> **Small N.** Each arm is at most 5 runs with 3 facts per kind and age. Differences of a few items are within run-to-run noise of one model at one temperature; nothing here is statistically significant. Read it as a smoke test of the arms, not a ranking.

| Arm | Setup | Runs ok | Exact-string recall | Constraint adherence | Correction (current value) | Rejected approach avoided | Stale overrides | Lookups per run (tools) | Tokens per run | Cost | Wall s per run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | native compaction | 5/5 | 15/15 (100%) | 15/15 (100%) | 15/15 (100%) | 15/15 (100%) | 0 | 0.2 (opencode_list_mcp_resources ×1) | 44,936 (+2,048 cached) | $0.0000 | 66.2 |
| B | A + history_search | 5/5 | 15/15 (100%) | 15/15 (100%) | 15/15 (100%) | 15/15 (100%) | 0 | 3.4 (grep ×5, read ×1, history_search ×9, opencode_list_mcp_resources ×1, glob ×1) | 47,367 (+17,357 cached) | $0.0000 | 64.8 |
| C | B + pinned constraints | 5/5 | 15/15 (100%) | 15/15 (100%) | 15/15 (100%) | 15/15 (100%) | 0 | 2.0 (constraint_list ×1, history_search ×9) | 153,186 (+85,299 cached) | $0.0000 | 102.6 |
| D | full context (oracle) | 5/5 | 15/15 (100%) | 15/15 (100%) | 15/15 (100%) | 15/15 (100%) | 0 | 0.6 (grep ×1, glob ×1, read ×1) | 28,992 (+11,059 cached) | $0.0000 | 16.4 |

Correct answers by age bucket (all four kinds):

| Arm | age ≈10 | age ≈50 | age ≈100 |
| --- | --- | --- | --- |
| A | 20/20 (100%) | 20/20 (100%) | 20/20 (100%) |
| B | 20/20 (100%) | 20/20 (100%) | 20/20 (100%) |
| C | 20/20 (100%) | 20/20 (100%) | 20/20 (100%) |
| D | 20/20 (100%) | 20/20 (100%) | 20/20 (100%) |

- Stale overrides count answers that gave a corrected value's old number, or named a rejected approach without the accepted one.
- Lookups are tool calls made while answering the probe. Tokens are input + output + reasoning for every model call the run made (pin pass, compaction summary, probe), with cache reads listed separately; wall time covers the same span.
- Pin pass tool calls over 5 arm C run(s): constraint_list ×7, constraint_pin ×105.
