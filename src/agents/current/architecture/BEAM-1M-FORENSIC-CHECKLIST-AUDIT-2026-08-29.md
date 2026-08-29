# BEAM-1M forensic checklist audit

Date: 2026-08-29

## Decision summary

The old diagnosis understated K=81 retrieval because it used an invalid BEAM source-session oracle.
Rejoining the frozen K=81 bags to the later recertified evidence-atom oracle changes complete-story
preservation from the provisional `58/78 = 74.36%` to **`65/75 = 86.67%`** on certified cases. That
clears the previously locked 85% retrieval gate, although three questions remain quarantined.

The most important measured split is now:

| Retrieval/answer outcome | Certified cases | Interpretation |
|---|---:|---|
| Complete story, perfect answer | 44 | End-to-end success |
| **Complete story, imperfect answer** | **21** | **Answer use, reasoning, exactness, or answer contract failed despite complete evidence** |
| Incomplete story, perfect answer | 3 | The oracle story was not strictly necessary for the judged answer |
| Incomplete story, imperfect answer | 7 | Retrieval plausibly limited the answer |

Among the 28 imperfect certified answers, **21/28 = 75%** already had every certified evidence atom
represented by at least one source session in K=81. A simple per-question gap-to-perfect calculation
assigns 78.67% of the observed gap to retrieval-complete cases and 21.33% to retrieval-incomplete
cases. This is diagnostic attribution, not an exact decomposition of the official BEAM macro score,
which averages within ability and conversation.

The exception is broad-history retrieval. Recertified summarization performance is only **35/55
atoms = 63.64%** and **1/7 complete stories = 14.29%**. K=81 has enough numerical capacity—the
largest certified story needs 16 sessions, while the bag allows 81—but its ranking does not cover
rare story branches.

The scored **74.10% pipeline did not use event cards**. It sent all raw turns from an average of
76.13 selected sessions directly to Luna-high. Atomic ingestion v0 and structured-event ingestion v1
were later, unscored successor experiments and must not be used to explain the 74.10% result.

## Scope and evidence hierarchy

This audit separates three systems:

1. **K=81 raw → Luna-high:** the only one with a 100-question official BEAM score, 74.098%.
2. **Atomic ingestion v0:** full one-conversation ingestion experiment; no downstream BEAM score.
3. **Structured-event ingestion v1:** one difficult-session L2 representation gate; no downstream
   retrieval or answer score.

Status legend:

- **CLEARED:** logs directly show this was working and it is not a current priority.
- **FAIL:** logs directly show the defect.
- **MIXED:** some relevant behavior works, but a narrower or architecture-specific defect remains.
- **UNVERIFIED:** retained artifacts cannot prove or disprove the hypothesis.

Authoritative sources:

- [K=81 result summary](../../../runs/beam-1m-k81-downstream-20260806/RESULTS.md)
- [Official K=81 score](../../../runs/beam-1m-k81-downstream-20260806/beam-official-summary-raw.json)
- [Frozen K=81 bags](../../../runs/beam-1m-k81-downstream-20260806/retrieval/k81-mmr085-focused-answerable78.json)
- [K=81 captured predictions and trace](../../../runs/beam-1m-k81-downstream-20260806/downstream/beam-k81-raw-focused78-r2-20260806-4/predictions.jsonl)
- [Recertified oracle](../../../runs/beam-1m-compression-oracle-recertification-20260808/oracle-recertified-v1.json)
- [Oracle audit summary](../../../runs/beam-1m-compression-oracle-recertification-20260808/audit-summary.json)
- [Atomic ingestion v0 result](./BEAM-1M-ATOMIC-INGESTION-V0-RESULTS-2026-08-09.md)
- [Structured-event v1 L2 result](../../../runs/local-archive/backbone/beam-structured-event-v1/l2-2026-08-13-occurrence-repair-15/typed-evaluation-result.json)

## Reproduced layer metrics

### K=81 retrieval, recertified

The join contract is the same permissive source contract used by the recertification work: an
evidence atom is covered when **any** certified source session for that atom is in the frozen K=81
bag. A story is complete only when every atom is covered.

| Ability | Certified cases | Covered atoms | Atom recall | Complete stories | Perfect final answers |
|---|---:|---:|---:|---:|---:|
| Contradiction resolution | 10 | 31/31 | 100.00% | 10/10 | 2/10 |
| Information extraction | 10 | 27/27 | 100.00% | 10/10 | 7/10 |
| Instruction following | 10 | 26/29 | 89.66% | 9/10 | 8/10 |
| Knowledge update | 9 | 17/17 | 100.00% | 9/9 | 9/9 |
| Multi-session reasoning | 10 | 38/41 | 92.68% | 7/10 | 7/10 |
| Preference following | 9 | 27/27 | 100.00% | 9/9 | 8/9 |
| **Summarization** | **7** | **35/55** | **63.64%** | **1/7** | **2/7** |
| Temporal reasoning | 10 | 30/30 | 100.00% | 10/10 | 4/10 |
| **Total** | **75** | **231/257** | **89.88%** | **65/75** | **47/75** |

The average certified story needs 2.63 source sessions; median 2, p90 5, maximum 16. K=81 sends
76.13 sessions, 209.90 raw turns, and 110,458 estimated package tokens on average. There were 78/78
predictions, zero recorded error lines, zero missing hydrated bag sessions, and zero package warnings.

### Answer provenance contract

In 9/78 predictions, Luna emitted **52 invalid session/turn evidence references**. The host filtered
them, but all nine predictions still retained the model-declared `support_status: supported`; eight
were left with zero valid evidence references. This is a concrete answer-contract and validation
defect, not a retrieval miss.

### Ingestion successors

Atomic v0 processed 929 sessions, 2,612 turns, and 1.221M raw tokens. The audited arm mechanically
represented all 41/41 oracle source turns, but semantically preserved only **25/41 atoms**, completed
**5/12 stories**, and produced 29,978 cards. Even normalized card text was 39.91% of raw; compact
text plus routing/provenance was 135.64%.

Structured-event v1 repair-15 materially fixed index size on one difficult session: 520 searchable
projection tokens from 4,515 raw tokens (**11.52%**), 341/341 compact targets discoverable, direct
USER semantics 2/2, assistant routes 3/3, and semantic story 1/1. It still failed: one of two required
USER source occurrences was missing and precision was only **208/219 = 94.98%**, with 11 critical
errors. Ten of those 11 critical errors were unsupported or reversed links; the other changed a
first-person proposal into an instruction. `resolutionAssertions.jsonl` is empty. Repair-16 has no
semantic freeze or evaluation result, so it is unverified rather than a pass.

## A. Source ingestion

| ID | Checklist hypothesis | Status | Reasoning and proof |
|---|---|---|---|
| A1 | Missing USER or ASSISTANT source text | **CLEARED** | Atomic v0 ingested the complete chat-18 chronology and represented the certified source turns 41/41 after audit. Structured v1 retained all six raw turns and reports `rawRecoverableTurnCount: 6`. K=81 is retrieval, not ingestion; within each selected session Arm 4 copies all turns. |
| A2 | Bad session boundaries | **UNVERIFIED** | No run reports a boundary mismatch, but no dedicated conversation/session-boundary oracle was evaluated. Absence of warnings is not a boundary proof. |
| A3 | Dates, role, session order, or turn numbers lost | **CLEARED** | K=81 context items contain date, role, opaque session ID, and turn index, and are assembled chronologically. Atomic v0 accepted zero cards without exact provenance. Structured v1 retains the raw archive plus exact selectors. |
| A4 | Tables, lists, code, or long responses parsed incorrectly | **MIXED** | Atomic v0 exploded assistant lists into many weak cards. Structured v1's assistant-block route recovered all 3/3 long-list obligations and indexed 341/341 targets, but that evidence is one session and does not cover arbitrary tables or code. |

## B. Event-card creation

| ID | Checklist hypothesis | Status | Reasoning and proof |
|---|---|---|---|
| B1 | Important facts never become cards | **FAIL** | Atomic v0 preserved only 25/41 atoms and 5/12 complete stories. Eleven of 16 misses were direct ingestion losses. Structured v1 passes 2/2 direct semantic obligations on one session only; this does not overturn the full v0 failure. |
| B2 | Card granularity is too broad or too fragmented | **FAIL** | Atomic v0 produced 29,978 audited cards, 32.3/session, including assistant-list card explosion, yet still lost semantics. Structured v1's block design is promising but has not been tested beyond one session. |
| B3 | Assistant evidence omitted | **MIXED** | V0 mechanically represented assistant source turns but did not preserve all meanings. Structured v1 explicitly stores assistant blocks and passed 3/3 assistant long-list obligations, so the specific "assistant omitted" bug is repaired locally, not generally certified. |
| B4 | User intent, preference, or requirement omitted | **FAIL** | V0 lists wrong actual/planned stance and missing entity/relation binding among direct losses. V1 missed one required USER occurrence and misclassified “Let's…” from proposal/intention to instruction. |
| B5 | Compression changes numbers, qualifiers, names, or intent | **FAIL** | V0's 16 misses include omitted qualifiers, incomplete lists, wrong stance, and broken binding. V1 has 11 critical unsupported fields/links, including reversed 5:30/5:00 and 8:00/7:00 relations. |
| B6 | Hallucinated or unsupported cards | **FAIL** | V0 found 17 unsupported unique cards among 450 relevant judged cards, 96.22% support versus a 99% target. V1 precision is 208/219, also below 99%, with 11 critical errors. |
| B7 | Duplicate cards crowd out distinct evidence | **MIXED** | V0's 32.3 cards/session and card explosion show semantic redundancy pressure. V1 uses content-addressed IDs and exact canonical deduplication, but no semantic-redundancy metric was run. |
| B8 | Missing provenance | **CLEARED** | V0 accepted zero cards without exact provenance. V1 retains raw archive, support bindings, selectors, and recoverable raw turns. The provenance mechanism itself is sound. |
| B9 | Context-dependent cards remain unresolved | **FAIL** | V0 explicitly lost coreference and entity/relation binding. V1's `resolutionAssertions.jsonl` is empty, while two active links were rejected because candidate coreference had no confirmed resolution assertion. |

## C. Entities and references

| ID | Checklist hypothesis | Status | Reasoning and proof |
|---|---|---|---|
| C1 | Pronouns, aliases, or “that project” are not resolved | **FAIL** | V0 records broken coreference as a direct loss. V1 produced zero resolution assertions and independent evaluation rejected two coreference links for lacking confirmation. |
| C2 | Different entities are incorrectly merged | **UNVERIFIED** | No retained evaluation provides an entity-merging confusion matrix or explicit false-merge denominator. |
| C3 | Aliases for the same entity remain split | **UNVERIFIED** | No alias-equivalence gate was executed. Empty resolution assertions make this a risk, not a measured failure. |
| C4 | Attribute/value attached to the wrong entity or relation | **FAIL** | V0 reports missing entity/relation binding. V1 support judgments reject links with unsupported target endpoints and a speech-act attachment that changes the user's commitment. |

## D. Time and evolving information

| ID | Checklist hypothesis | Status | Reasoning and proof |
|---|---|---|---|
| D1 | Dates are wrong or missing | **FAIL** | V0 misses three arithmetic/date-derived atoms. V1 created links whose declared order contradicted explicit 5:30/5:00, 7:00/5:30, and 8:00/7:00 endpoint times. |
| D2 | Assertion time is confused with event time | **FAIL** | The v1 schema separates them, but evaluation rejected several links because structural/turn order was used without valid event-time support. Correct schema did not prevent incorrect active links. |
| D3 | Newer updates are not connected to older states | **MIXED** | Raw K=81 retrieval is strong here: 9/9 recertified knowledge-update stories are complete and all nine final answers are perfect. The event-card graph has no evaluated update-link denominator, so reusable ingestion remains unverified. |
| D4 | Contradictions are flattened | **MIXED** | K=81 retrieved 10/10 contradiction stories completely, but only 2/10 certified questions received a perfect official answer and the full canary ability score was 62.5%. Retrieval preserves both states; downstream reconciliation remains weak. |
| D5 | Repeated occurrences collapse into one | **FAIL** | V1 recovers only 1/2 required USER preferred occurrences even though semantic coverage is 2/2. This is direct evidence that occurrence identity is not reliable enough. |
| D6 | Chronological relationship is lost | **MIXED** | K=81 raw packing preserves chronological order, but v1's link layer creates unsupported/reversed BEFORE/AFTER relationships. Raw chronology is sound; structured chronology is not. |

## E. Card linking and story structure

| ID | Checklist hypothesis | Status | Reasoning and proof |
|---|---|---|---|
| E1 | Related cards are not linked | **UNVERIFIED** | Repair-15 evaluates no required link story (`linkStories.total: 0`) and has zero resolution assertions. There is no positive cross-event link-recall denominator. |
| E2 | Incorrect links connect unrelated events | **FAIL** | Ten of repair-15's 11 critical errors are links. Evaluators reject reversed directions, unsupported endpoints, and temporal relations without evidence. |
| E3 | Links are too generic or topic-based | **FAIL** | Several rejected links infer BEFORE/AFTER from structural order or thematic association without endpoint temporal facts. This is precisely over-broad link creation. |
| E4 | Missing causal links | **UNVERIFIED** | No causal-link obligations were evaluated. |
| E5 | Missing update/supersession links | **UNVERIFIED** | No update-link denominator was evaluated in repair-15, and ingestion v1 has no downstream update retrieval score. |
| E6 | Missing cross-session links | **UNVERIFIED** | The latest completed L2 contains one session; it cannot establish cross-session linkage quality. |
| E7 | Graph traversal stops before completing the story | **UNVERIFIED** | Structured v1 was never connected to a retrieval or answer gate. There is no graph-traversal trace to audit. |

## F. Card indexing and discovery

| ID | Checklist hypothesis | Status | Reasoning and proof |
|---|---|---|---|
| F1 | Cards have poor searchable language | **MIXED** | Structured v1 indexes 341/341 compact targets and finds all 3/3 assistant routes in its one-session census. Atomic v0 never received a downstream retrieval gate, so general searchability is still unproved. |
| F2 | Embeddings represent topic rather than precise claim | **MIXED** | The preserved K=81 behavior repeatedly concentrated on central story evidence while broad summaries missed rare branches. This is consistent with topic concentration, but exact Voyage-only precision was not recertified against the new atom oracle. |
| F3 | BM25 requires words absent from the representation | **UNVERIFIED** | No retained BM25-only recertified atom-recall breakdown exists for the K=81 run or the event-card index. |
| F4 | Answer-shaped queries do not match card wording | **UNVERIFIED** | K=81 queried raw/session views rather than the later structured cards. Structured v1 never received a question-time retrieval test. |
| F5 | Sparse and dense retrieval return the same redundant region | **FAIL** | The phase-1 trace diagnosis reports roughly 50 query executions/case and repeatedly rediscovered central evidence instead of new branches; summary candidate pools were large without complete story coverage. Detailed support labels came from the old oracle, but the repeated-query behavior is directly in the traces. |
| F6 | Important evidence ranks below similar junk | **FAIL** | Recertified K=81 summary coverage is only 35/55 atoms and 1/7 complete stories despite 81 slots and a maximum certified story size of 16 sessions. The issue is ranking/coverage, not bag capacity. |

## G. Query planning

| ID | Checklist hypothesis | Status | Reasoning and proof |
|---|---|---|---|
| G1 | Queries merely repeat or paraphrase the question | **FAIL** | Phase-1 traces show many query executions but repeated central evidence. The planner generated volume without enough novel story branches. |
| G2 | Planner does not predict answer-shaped evidence | **MIXED** | The retrieval lineage includes answer-shaped/facet queries, and point abilities reach high recertified recall. The planner still lacks a reliable mechanism to turn broad answer obligations into exhaustive branch coverage. |
| G3 | Only one interpretation of an ambiguous question is searched | **UNVERIFIED** | No ambiguity-labelled subset or interpretation-coverage audit exists. |
| G4 | Broad-history questions are treated like point lookups | **FAIL** | Summarization is the clear outlier: 14.29% complete stories versus 90–100% in most point-style abilities. Fixed ranked retrieval is not behaving like a coverage search. |
| G5 | Temporal queries fail to seek both endpoints/states | **CLEARED** | Recertified K=81 covers 30/30 temporal atoms and 10/10 complete temporal stories. The remaining temporal loss is downstream answer exactness, not endpoint retrieval. |
| G6 | Follow-up queries do not target missing evidence | **FAIL** | K=81 has no explicit global obligation ledger or iterative missing-evidence audit. Coverage Explorer added exactly that behavior and retained 25/25 atoms on its four microcases, demonstrating the missing capability, although at excessive context size. |

## H. Candidate retrieval and story completion

| ID | Checklist hypothesis | Status | Reasoning and proof |
|---|---|---|---|
| H1 | The first retrieval pool lacks the complete story | **MIXED** | The final K=81 pool is complete for 65/75 certified cases and incomplete for 10. The earlier pre-fusion discovery union was scored with the invalid oracle and is not reconstructable from the frozen K=81 bag file, so its recertified completeness is unknown. |
| H2 | Correct card is found but supporting raw session is absent | **UNVERIFIED** | The 74.10% run retrieves raw sessions directly; the structured-card successor never ran question-time retrieval. No card-to-session hydration failure can be measured. |
| H3 | One story part is found and completion is assumed | **FAIL** | Six of seven summarization stories are incomplete at K=81, yet the system proceeds directly to answer. There is no story-completeness gate. |
| H4 | No explicit “what is still missing?” check | **FAIL** | K=81 performs fixed fusion and packaging. It has no post-retrieval coverage ledger. Coverage Explorer's success on the microgate is evidence that this missing step can matter. |
| H5 | Fixed K is numerically too small | **CLEARED** | Maximum certified evidence need is 16 sessions, p90 is 5, while K permits 81. The failure is which sessions are selected, not insufficient numerical capacity. |
| H6 | Early stopping favors confidence over completeness | **CLEARED** | The K=81 route does not use a confidence-based early stop; it deterministically fills the fused bag. This is not a cause of the 74.10% run's misses. |

## I. Compression and final context construction

| ID | Checklist hypothesis | Status | Reasoning and proof |
|---|---|---|---|
| I1 | Retrieved correct evidence is later discarded | **MIXED** | The old diagnosis found fusion discarded discovered evidence, but those exact gold labels are invalid. After K=81 selection, Arm 4 discards no selected session or turn. Event ingestion v0 does lose semantics during compression. |
| I2 | Session selection removes a necessary turn inside a selected session | **CLEARED** | `buildFullRawPackage` copies every turn from every frozen K=81 session. Trace text explicitly says no downstream session or turn was deleted. |
| I3 | Cards reach the answerer without enough raw evidence | **UNVERIFIED** | The 74.10% run uses raw turns, not cards. Neither event-card ingestion system reached an answer gate. |
| I4 | Too much junk distracts the final model | **MIXED** | Luna sees 76.13 sessions and 110,458 package tokens on average for stories needing 2.63 sessions on average. That creates strong distraction risk, but the experiment did not causally isolate attention dilution; raw still outperformed Nano claims. |
| I5 | Chronological order is destroyed while packing | **CLEARED** | Arm 4 sorts by date/session/turn and preserves role/date metadata. No package warnings were recorded. |
| I6 | Final package lacks inclusion rationale | **FAIL** | Each raw item is labelled only as “raw turn retained from the complete K=81 candidate reservoir.” It does not state the obligation, query, branch, or expected use of that session. |
| I7 | Context limits silently truncate the package | **CLEARED** | Actual packages reached 306 turns and 180,827 estimated tokens despite smaller generic config fields; traces show zero package warnings and zero missing hydrated sessions. No silent package truncation is recorded. |

## J. Final answerer

| ID | Checklist hypothesis | Status | Reasoning and proof |
|---|---|---|---|
| J1 | Answerer overlooks evidence that is present | **FAIL** | 21/65 retrieval-complete certified cases still received imperfect answers. This is the largest directly measured failure group. |
| J2 | It selects one plausible fact instead of reconciling all facts | **FAIL** | Contradiction retrieval is 10/10 complete but only 2/10 certified answers are perfect; full-canary contradiction score is 62.5%. Official examples penalize omission of one side or one scheduling fact. |
| J3 | It fails exact formatting, count, or wording requirements | **FAIL** | Official temporal examples award partial/zero credit for giving 14 days without the requested date range and for returning 47 instead of 46. The answerer is often directionally right but rubric-incomplete. |
| J4 | It uses unsupported prior knowledge | **UNVERIFIED** | Invalid citations prove provenance hallucination, not necessarily use of outside knowledge. No dedicated closed-book attribution audit exists. |
| J5 | It cannot identify the latest state | **MIXED** | Knowledge update is excellent—9/9 recertified complete and perfect—but contradiction resolution remains weak. Latest-state handling works for clean updates, not consistently for dual-state reconciliation. |
| J6 | Large-context attention dilution causes failure | **UNVERIFIED** | The 110K-token mean context is a plausible cause, but no controlled raw-context-length ablation holds evidence constant. Claim compression reduced context and also deleted evidence, so it does not isolate attention. |

## K. Evaluation and harness

| ID | Checklist hypothesis | Status | Reasoning and proof |
|---|---|---|---|
| K1 | Gold evidence definitions are incomplete or wrong | **FAIL — partly repaired** | Recertification changed 62/78 questions, found 32 reviewer disagreements, required 53 adjudications, certified 75, and left 3 `needs_review`. The old 58/78 layer metric is not trustworthy. |
| K2 | Session IDs or opaque handles are mapped incorrectly | **CLEARED** | K=81 traces report `opaque_per_case_v1`, zero missing bag session IDs, and valid hydration for all 78 cases. No raw-ID leakage or mapping loss is recorded. |
| K3 | Benchmark judge is unstable between reruns | **MIXED** | The results record small score changes even for 22 byte-identical fixed predictions. The paired-control score 72.69% is therefore more causal than the independent 74.10% full rerun. Official scoring is still the benchmark-required measure. |
| K4 | Mixed reused/regenerated predictions create unfair comparison | **MIXED** | The experiment intentionally regenerated 78 cases and reused 22. It correctly reports both full rerun and paired-control scores; quoting only 74.10% without 72.69% overstates causal certainty. |
| K5 | Reporting mixes retrieval recall and answer quality | **FAIL — corrected here** | Earlier reports treated provisional 58/78 retrieval as the gating explanation for a 74.10% answer score. Recertified attribution shows 65/75 complete and 21 complete-but-imperfect answers, so the two metrics must remain separate. |
| K6 | Failed calls or partial outputs counted as architecture failures | **CLEARED** | The K=81 answer run completed 78/78 predictions with zero error lines. The official merged file contained all 100 predictions. |

## What is genuinely good and can be taken off the active checklist

These controls have enough evidence to stop treating them as primary hypotheses for the 74.10% run:

1. **Raw-source recoverability and exact provenance.** Both ingestion lines preserve recoverable raw
   source; atomic v0 had zero accepted cards without exact provenance.
2. **K=81 post-selection packaging.** It hydrates every selected session, keeps every turn, preserves
   chronology, and records no truncation warning.
3. **Opaque IDs.** The scored run uses per-case opaque handles without recorded mapping failure.
4. **K=81 numerical capacity.** Eighty-one slots are far above the largest certified story's 16
   source sessions.
5. **Point-style retrieval.** Contradiction, information extraction, knowledge update, preference,
   and temporal evidence are all 100% atom-covered after recertification; instruction and
   multi-session are near 90% or better.
6. **Structured v1 searchable size and assistant-list routing, locally.** Repair-15 reaches 11.52%
   projection size and 341/341 discoverability on its one-session L2. These are local passes, not
   generalization evidence.

## Highest-leverage improvements

### Priority 1 — repair answer use before adding more general retrieval

This is now the largest measured loss. On the 75 certified cases, 21 have complete evidence but an
imperfect answer. The next test should target those 21 without changing retrieval:

- make Luna produce an explicit obligation checklist before the final prose;
- require every requested number/date/item to be covered;
- add a single bounded answer repair when evidence references are invalid, empty despite
  `supported`, or checklist obligations are uncovered;
- explicitly reconcile both old and new states for contradictions;
- independently verify arithmetic/date deltas and exact item counts before submission.

This should be a frozen-context A/B: identical K=81 packages, current answer prompt versus the new
answer contract. It isolates the answer layer and avoids another ingestion spend.

### Priority 2 — make broad summarization retrieval coverage-driven

Do not disturb the point-retrieval path that is already strong. Route only broad-history questions
to a coverage workflow:

- plan expected subtopics, phases, or branches;
- retrieve each branch independently;
- maintain a global “covered / missing / uncertain” ledger;
- issue follow-up searches only for missing branches;
- stop on evidence saturation rather than fixed query count.

Coverage Explorer already supplies directional evidence—25/25 atoms on four microcases—but its 340K
average final context is not acceptable. The goal is to borrow its coverage control, not its large
context package.

### Priority 3 — do not scale structured-event v1 yet

The ingestion successor is still a research branch. Before any full ingestion or downstream test:

- separate structural sequence from actual event chronology;
- prohibit active coreference links without a confirmed resolution assertion;
- preserve proposal/intention/instruction distinctions;
- evaluate positive and negative link obligations across multiple unseen sessions;
- require the same <=25% projection and >=99% precision gates before advancement.

Repair-16 has no completed semantic result. It must not be described as having fixed repair-15.

### Priority 4 — close measurement debt

- adjudicate or quarantine the remaining three oracle questions permanently;
- persist a versioned recertified K=81 layer diagnostic rather than relying on the old file;
- persist the exact fusion implementation/formula used to create K=81;
- report official full rerun and paired-control scores together;
- downgrade or repair any answer that claims `supported` after all cited evidence is filtered out.

## Recommended next experiment

The cleanest next step is **not** another large ingestion run. Freeze the same 75 certified K=81
contexts and run an answer-only A/B on the 21 retrieval-complete imperfect cases plus a sealed set of
retrieval-complete perfect controls. The pass criteria should be:

1. improve official score on the failure cohort;
2. no regression on the perfect controls;
3. zero invalid evidence references;
4. zero `supported` answers with an empty validated evidence set;
5. record obligation-level completeness before and after answer repair.

In parallel but as a separate test, run a retrieval-only summarization gate on the seven certified
summary cases and an unseen sealed summary cohort. Promotion requires at least 85% complete stories
without increasing the final answer context above the current 110K-token average.

## Limitations

- Only 75/78 focused answerable questions have certified evidence atoms; three remain under review.
- The official 74.10% score covers 100 questions, while recertified layer attribution covers 75
  focused answerable cases. Abstention and event-ordering are not in the recertified join.
- The official conversation-level 95% interval is wide: 65.99% to 82.20% across five
  conversations.
- The 78.67% gap attribution uses simple question-level scores and should not be interpreted as the
  exact contribution to BEAM's macro score.
- Atomic v0 has one full-conversation ingestion test. Structured v1 repair-15 has only one-session
  L2 evidence and no end-to-end answer score.
