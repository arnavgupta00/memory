# Sequential v1 H=6 baseline — answerable135

> Superseded for measurement: this run exposed `answer_*` IDs to the
> controller. The opaque-ID recertification produced 120/135 overall
> (hard 17/28, mid 10/12, easy 93/95) at a measured cost of $2.12417.

## Configuration

- Prompt: `hop-retrieve-v1`
- Model: `gpt-5.6-luna`
- Reasoning: `low`
- Search-hop budget: 6
- Case concurrency: 24
- Token gate: 200,000 estimated tokens per 60 seconds
- Cases: 135 answerable LongMemEval questions
- Notes: frozen `session-annotations-v1`; no storer rerun
- Elapsed time: 1,406.8 seconds

## Retrieval results

| Stratum | Full gold in bag | Rate | Mean gold recall | Mean hops | Mean bag |
|---|---:|---:|---:|---:|---:|
| Hard | 19/28 | 67.9% | 0.893 | 4.96 | 3.75 |
| Mid | 10/12 | 83.3% | 0.931 | 4.58 | 3.67 |
| Easy | 94/95 | 98.9% | 0.995 | 4.97 | 2.25 |
| All | 123/135 | 91.1% | 0.968 | 4.93 | 2.69 |

Errors: 0.

## By question type

| Type | Full gold in bag | Rate |
|---|---:|---:|
| Knowledge update | 19/20 | 95.0% |
| Multi-session | 27/33 | 81.8% |
| Single-session assistant | 15/15 | 100% |
| Single-session preference | 15/15 | 100% |
| Single-session user | 17/17 | 100% |
| Temporal reasoning | 30/35 | 85.7% |

## Cost and controller behavior

- Input tokens: 1,558,300
- Output tokens: 99,907
- Searches: 718 (`684` BM25, `34` grep)
- `add_sessions` calls: 364
- `done` calls: 134
- Cases using all six search hops: 78/135

Of the 12 failures, four surfaced every gold session but did not add all of
them. The other eight surfaced some, but not all, gold sessions. No failure
missed every gold session.
