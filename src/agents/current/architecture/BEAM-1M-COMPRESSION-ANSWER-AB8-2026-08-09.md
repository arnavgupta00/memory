# BEAM-1M Coverage Explorer answer A/B

On an eight-question frozen development stress test, Coverage Explorer improved the official BEAM score from **53.87% to 73.51%**. It won four paired cases, tied four, and lost none.

The final Luna-high answer call received an average of **340,025 input tokens** with Explorer instead of **540,719** from the raw discovery union, a 37.12% reduction. The context remained lossless: Explorer supplied selected raw source turns, not generated summaries or synthetic evidence.

This is evidence for further testing, not a promotion result. The cohort contains four summarization and four multi-session-reasoning questions, was deliberately difficult, and did not touch the sealed holdout. See the [complete result record](../../../../runs/beam-1m-compression-answer-ab8-20260809/RESULTS.md) for costs, per-case pack sizes, official scores, and caveats.
