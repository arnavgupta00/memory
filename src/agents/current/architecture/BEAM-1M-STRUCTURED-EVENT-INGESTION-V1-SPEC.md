# BEAM-1M structured-event ingestion v1 specification

**Status:** selective conformance repair implemented in code; repaired `L0`/`L1` remain unapproved and unrun
**Scope:** reusable, query-blind ingestion only
**Supersedes:** the implementation contract in `BEAM-1M-ATOMIC-INGESTION-V0-PLAN-2026-08-09.md`
**Change control:** after user approval, any material deviation requires an explicit specification
amendment and renewed approval before testing

**Selective-repair amendment, 2026-08-10:** the earlier symbol-presence L0 result is retained as an
audit artifact but is not accepted as behavioral evidence. The repair preserves model ownership of
semantic interpretation while adding mechanical enforcement for target-session support, separate
base/enriched projections, explicit default projection membership, active-versus-historical repair
outputs, adaptive host pagination, source-supported positive evaluation, canonical approval ledgers,
and mandatory evaluation denominators. The new fixtures and repaired L0 have not been executed.

## 1. Purpose

Convert a long chronological conversation into a reusable memory representation that:

1. preserves answer-bearing facts, events, states, preferences, corrections, and chronology;
2. keeps every semantic record traceable to immutable raw evidence;
3. remains domain-agnostic and append-only;
4. avoids flattening long ASSISTANT advice into thousands of equal-weight text cards;
5. supports later retrieval without putting the full history into the answering model.

This specification is both the architecture plan and the implementation-verification contract. A
feature is not considered implemented merely because a prompt mentions it. It must exist in the
schema, production code, automated tests, and a runtime artifact.

## 2. What v0 got wrong

V0 is retained as negative evidence. V1 must not repeat these failures:

- The plan described structured events, but the schema stored mostly `normalizedText` plus broad
  labels.
- USER turns were included, but 26,948/29,978 accepted cards came from ASSISTANT turns because every
  advice-list item was atomized.
- A deterministic validator rejected unambiguous exact quotations when model-authored prefix or
  suffix text was malformed.
- The Luna “auditor” independently re-extracted the entire session, doubled work, and expanded the
  index rather than performing targeted repair.
- Reference resolution could use preceding sessions, but the resulting cards could not record those
  resolution sources.
- The evaluator hid valid evidence outside one certified source turn and counted derived arithmetic
  as ingestion loss.
- Chronological/link abilities were scored before the link representation existed.

## 3. Non-negotiable requirements

### 3.0 Semantic-reasoning boundary

This architecture is context-agnostic only if semantic interpretation remains model-driven. The
host may enforce lossless mechanical invariants—raw custody, exact selectors, referential integrity,
field-support accounting, immutable lineage, projection membership, page completeness, freeze
ordering, and evaluation denominators—but it must not replace semantic interpretation with a
BEAM-specific rules engine.

The mapper/linker and independent semantic judges remain responsible for deciding what constitutes a
fact or event, discourse commitment, arbitrary ASSISTANT structure, adoption, correction,
coreference, temporal/update relations, and whether evidence supports a semantic claim. Regexes and
fixed deterministic ontologies may identify structural boundaries or create diagnostics; they may
not certify semantic absence, semantic completeness, or relationship truth. Behavioral confidence
comes from adversarial falsification fixtures and independent model judgments, not from hard-coding
benchmark formats.

Every requirement has a stable ID. The post-implementation conformance audit must map each ID to
code, tests, and runtime evidence.

| ID | Requirement |
|---|---|
| `RAW-001` | The semantic ingestion boundary accepts a Unicode scalar sequence and archives its strict UTF-8 bytes with length, SHA-256, host conversation/session/turn identity, role, raw timestamp metadata, and opaque handle. Preserve the upstream transport artifact/hash separately. Invalid Unicode blocks completion; no normalization, newline conversion, trimming, or lossy decoding is permitted. |
| `RAW-002` | Never delete or overwrite raw history because extraction, validation, linking, or deduplication failed. |
| `RAW-003` | UTF-8 byte offsets are authoritative. Every span must be within bounds, begin/end at Unicode scalar boundaries, hash to its declared span hash, and strictly decode to its declared exact text. UTF-16/code-point offsets are optional derived fields only. |
| `SEM-001` | Represent each retained proposition with structured predicate and typed participant/value arguments; standalone text is a rendering, not the canonical semantics. |
| `SEM-002` | Preserve source speaker, reported speaker, speech act, polarity, modal force, event status, source-expressed certainty, extraction confidence, and adoption status separately. |
| `SEM-003` | Preserve unresolved entity mentions exactly and assign only local mention IDs during extraction. Entity merging is a reversible overlay. |
| `SEM-004` | Store authoritative session/turn order and assertion time separately from zero or more event-valid temporal expressions, including recurrence, duration, relative time, raw text, normalized bounds when supported, precision, uncertainty, and resolution basis. |
| `SEM-005` | Preserve old and new values as separate observations. Corrections and updates never mutate an earlier observation. |
| `SEM-006` | Questions, suggestions, instructions, intentions, adopted plans, attempts, and completed actions must remain distinguishable. |
| `SEM-007` | The schema must support events with more than a subject/object pair, grouped arguments, comparisons, conditions, alternatives, collections, and proposition-valued arguments/references. |
| `SEM-008` | Every record carries discourse scope distinguishing actual report, direct quote, hypothetical, counterfactual, example, template, script, and role-play, including parent scope and top-level commitment. Invented dialogue and examples cannot become episodic facts. |
| `SEM-009` | Source-faithful mention surfaces remain immutable. Cross-session identity, omitted arguments, and resolved referents exist only as append-only assertions over mention IDs or field paths. |
| `SRC-001` | Every semantic proposition must have one or more exact claim-source spans from the turn that expresses it. |
| `SRC-002` | Any context used to resolve a pronoun, identity, omitted referent, or relative time must be stored separately as resolution provenance. |
| `SRC-003` | A base rendering may contain only the supported immutable core. An enriched rendering may not add an identity, value, date, or relation without listing confirmed resolution assertions that support it. |
| `SRC-004` | Every claim selector records selector ID, raw-turn ID, content hash, authoritative byte start/end, span hash, and exact UTF-8 text. Claim spans for a target mapping belong only to the target session. |
| `SRC-005` | Every non-host-derived semantic-core field—including kind, discourse, predicate, argument role/group/type/value, speaker/act, polarity, modal force, event status, adoption, certainty, and temporal type—needs a support binding naming its target path, method, source selectors, and confidence. Host-derived assertion/order fields need immutable metadata bindings. |
| `SRC-006` | Resolution evidence may cite exact content or immutable metadata such as timestamp, role, or structural order. Resolution never rewrites the immutable semantic core. |
| `VAL-001` | Deterministic code may locate, hash, validate shape, assemble, and report ambiguity. It may not judge importance or silently discard semantic evidence. |
| `VAL-002` | If an exact quote occurs once in its declared turn, it is accepted regardless of malformed optional prefix/suffix context; the mismatch is logged as a warning. |
| `VAL-003` | For multiple exact occurrences, supplied adjacent context may select a location only by exact byte matching. Zero or multiple survivors are quarantined; fuzzy, normalized, first/last, or confidence-based tie-breaking is forbidden. |
| `VAL-004` | A multi-source record materializes atomically. Failure of any required selector or field binding quarantines the complete draft; partial materialization is forbidden. |
| `VAL-005` | Parse failure, provider truncation, output-limit finish reason, missing/duplicate page, array overflow, unknown target, or missing expected segment marks the run incomplete rather than empty/no-content. |
| `VAL-006` | Deterministic deduplication may coalesce only byte-identical canonical payloads while retaining every proposal/derivation occurrence. Same ID with different canonical bytes is fatal. |
| `ROLE-001` | USER and ASSISTANT content are both preserved, but they use distinct indexing policies based on source role and speech act. |
| `ROLE-002` | Every identified concrete USER fact, experience, preference, decision, correction, or adopted action must route to one or more accepted structured records or an explicit quarantine; `raw_only` is not successful semantic preservation. |
| `ROLE-003` | ASSISTANT-origin suggestions and enumerated advice are retained as compact advice blocks with raw provenance, not atomized item-by-item into the primary episodic index unless later adopted or referred to as an event. |
| `ROLE-004` | Concrete information introduced or reported by an ASSISTANT remains retrievable with explicit assistant attribution; it must not become a USER fact. |
| `ROLE-005` | Every explicit ASSISTANT list item has a stable item ID and source boundaries. Complete raw block text contributes deterministic lexical postings so a detail omitted by lossy routing text can still discover and reopen the block. |
| `LINK-001` | Corrections, updates, supersession, contradiction, duplicate-report, and explicit temporal-order relations are separate typed link records. |
| `LINK-002` | A link never deletes, rewrites, or makes its endpoint records inaccessible. |
| `LINK-003` | Link confidence and provenance basis are mandatory. The basis may be an exact span, immutable metadata/structural order, or a declared temporal parse; uncertain entity/event merges remain candidate links. |
| `LINK-004` | Update links specify direction, affected predicate/argument slot, mandatory effective-time value (explicit `unknown` allowed), explicit/inferred status, and whether the relation is merely a candidate. |
| `LINK-005` | Links may target records, unresolved mentions, compact blocks, or explicit block items. Adoption/reference relations include `REFERS_TO`, `ADOPTS`, `REJECTS`, and `IMPLEMENTS`. |
| `ID-001` | All content-addressed IDs use domain-separated, versioned SHA-256 over RFC-8785 canonical JSON with exact Unicode preserved and identifier arrays sorted by ASCII byte order. |
| `ID-002` | Raw-turn, span, mention, semantic-record, compact-block, block-item, attempt, quarantine, resolution-assertion, lifecycle-event, and link-generation identity inputs are explicitly frozen. |
| `ID-003` | Semantic record identity includes its immutable source-faithful semantic core and sorted claim spans, but excludes rendering, model/run, extraction confidence, resolution overlays, and link generations. A semantic repair creates a new ID; an identical proposal appends derivation. |
| `ID-004` | Derivations are append-only one-to-many relations from attempts to records/blocks/links rather than a singular mutable object field. |
| `RES-001` | Identity, coreference, omitted-argument, normalized-value, and temporal resolutions use a first-class append-only resolution-assertion schema targeting a mention ID or semantic field path. |
| `RES-002` | Resolution assertions store proposed typed value, content/metadata evidence, method/version, confidence, and candidate/confirmed/rejected status. They never change the immutable record core. |
| `RES-003` | Only confirmed resolution assertions enter a separately versioned enriched retrieval projection. Base source-faithful projection and record identity remain unchanged. |
| `REP-001` | Every mapper/repair output produces an immutable attempt containing target/page, complete input-context manifest, raw output/hash, schema, parent attempts, trigger, parsed drafts, diagnostics, finish reason, and call-time warnings, plus an immutable content-addressed attempt-materialization result containing materialized objects, quarantines, completion errors, and materialization warnings. |
| `REP-002` | Quarantine is append-only and retains the draft, valid selectors, candidate offsets, failures, derivation, and repair lineage. Repair creates a new attempt and never edits the quarantine. |
| `REP-003` | Models may only append `challenged`. Exclusion from the default projection requires deterministic invalidity or two independent semantic judgments plus adjudication, and an accepted replacement or an explicit projection gap that blocks completion. Lifecycle events are monotonic and audit-visible. |
| `COV-001` | Stage A assigns stable byte intervals to structural segments. Every expected segment has exactly one structural-accounting row with zero or more record/block/quarantine IDs or explicit no-semantic-content outcome. |
| `COV-002` | Structural coverage is not proof of semantic exhaustiveness. Missing/duplicate/dangling/out-of-range rows, critical quarantine/raw-only, truncation, or parse failure block completion; semantic completeness is measured separately by proposition fixtures/oracle obligations. |
| `COV-003` | Fixed arrays/output limits may not truncate a target. The host splits inputs or reconciles numbered continuation pages before completion. |
| `INC-001` | New sessions append raw turns and new records while existing immutable IDs remain byte-identical. No live incremental-ingestion runtime is required in v1. |
| `INC-002` | Reingestion is idempotent. A reused host-turn key with different immutable bytes is a version conflict, never an overwrite. Resolution assertions, lifecycle events, and link generations are append-only. |
| `INC-003` | Opaque model-visible handles are persisted stable mappings or deterministic keyed handles; appending sessions cannot renumber existing handles. |
| `EVAL-001` | Evaluation reports source-occurrence extraction and global-story availability as different metrics. |
| `EVAL-002` | Global-story evaluation may use semantically matching records from anywhere in the frozen index, not only the oracle’s preferred occurrence. |
| `EVAL-003` | Derived arithmetic and date differences pass ingestion when all necessary operands, units, dates, and ordering evidence are available. The derived answer itself is not required as a stored card. |
| `EVAL-004` | A chronological relation is scored only after the query-blind typed-link artifact is frozen. Semantic and link story-completeness denominators remain separate. |
| `EVAL-005` | Certification inputs/oracle/questions/answers remain custodian-sealed until both semantic and query-blind link artifacts are frozen. Open development evaluation data never enters mapper/linker context and cannot certify query blindness. |
| `EVAL-006` | Every oracle obligation declares its stage/type, eligible plane, satisfaction rule, and denominator. Direct semantics, compact routes, operands, asserted/derived relations, typed links, and answer-only synthesis are never merged into one ingestion-recall number. |
| `EVAL-007` | A positive global match may establish semantic availability; a negative counts only after exhaustive scanning of every eligible record/block or a separately validated discovery method with a frozen recall bound. Raw archive and quarantine cannot satisfy semantic availability. |
| `EVAL-008` | Record-entails-obligation judging sees records without source text. Record-supported-by-source judging is a separate task with provenance. Source text cannot fill details omitted from the record. |
| `EVAL-009` | Store-wide precision uses an independent stratified sample/census, not only records retrieved for positive oracle atoms. Zero denominators are `not_evaluable`, never passes. |
| `GOV-001` | No test rung may run without showing the user its inputs, objective, expected spend/time, pass/fail gates, and receiving explicit approval. |
| `GOV-002` | Scope controls cost; output truncation must not be used to force a run under budget. A cost guard pauses before dispatch rather than corrupting an in-progress output. |
| `GOV-003` | A larger rung cannot start when a smaller rung fails. Failure produces diagnosis and a revised plan, not automatic escalation. |
| `GOV-004` | No full-conversation ingestion run may start until all cheaper rungs pass and the user separately approves the full run. |
| `GOV-005` | Supported runners require a control-plane-issued authenticated one-run receipt binding rung nonce, cohort/prerequisite hashes, code/prompt/schema/config, model/reasoning/concurrency, conservative spend reservation, output directory, timestamp, and user identity. Signature/MAC is verified before opening rung inputs or dispatch; nonce consumption is atomic and append-only. |
| `GOV-006` | Approval state is `planned → approved → running → passed → user_accepted`; `running → failed` is terminal for advancement, though it may be `user_acknowledged`. A revision requires a new nonce and rerun. The runner prevents accidental/agent dispatch but cannot stop a shell owner bypass. |

## 4. Canonical storage planes

### 4.1 Immutable raw plane

The raw archive is authoritative. It contains the original sessions and turns, stable host IDs,
timestamps, roles, exact content, and hashes. Every semantic record and link points back to this
plane. A later retriever must always be able to reopen the exact source.

### 4.2 Structured semantic plane

The canonical record is structured. `canonical_text` is generated for lexical/vector retrieval but
does not replace its fields.

```yaml
source_selector:
  selector_id: hash of selector identity
  raw_turn_id: immutable turn reference
  content_sha256: hash of the complete turn bytes
  byte_start: authoritative inclusive UTF-8 byte offset
  byte_end: authoritative exclusive UTF-8 byte offset
  span_sha256: hash of the selected bytes
  exact_utf8: strict decoding of the selected bytes

mention:
  mention_id: hash of selector_id + mention type
  selector_id: exact surface selector
  mention_type: person | organization | place | object | event | time | quantity | concept | unknown
  surface: exact source surface

semantic_record:
  schema_version: 2
  record_id: ID-003 content-addressed hash
  record_kind: claim | event | state | preference | decision | intention | action | outcome | measurement | correction | question
  discourse_context:
    frame: actual_report | direct_quote | hypothetical | counterfactual | example | template | script | roleplay
    commitment: asserted | suggested | not_committed | unknown
    parent_scope_selector_id: optional exact selector for the containing discourse frame
  predicate:
    surface: exact or minimally normalized predicate
    normalized: optional domain-agnostic relation label
  arguments:
    - argument_id: local stable identifier
      role: actor | experiencer | subject | object | recipient | location | instrument | topic | value | unit | cause | outcome | condition | alternative | comparison_basis | member | other
      custom_role: required source-faithful label when role=other
      group_id: optional grouping for paired quantities, comparisons, alternatives, or collections
      value_type: entity_mention | text | number | quantity | money | boolean | time | duration | location | record_ref | collection
      surface: source-faithful text
      source_typed_value: optional value parsed directly from the claim source
      mention_id: optional local unresolved mention ID
      record_id: optional proposition-valued argument
  stance:
    source_speaker_role: user | assistant
    source_speaker_surface: optional exact name
    reported_speaker_mention_id: optional unresolved mention
    speech_act: assertion | report | denial | question | request | instruction | recommendation | intention | plan | hypothetical | counterfactual
    polarity: positive | negative
    modal_force: actual | planned | possible | required | permitted | unknown
    event_status: proposed | attempted | ongoing | completed | cancelled | failed | unknown | not_applicable
    adoption: proposed | adopted | rejected | not_applicable | unknown
    speaker_certainty: certain | probable | possible | uncertain | unknown
  temporal:
    assertion_time: immutable session timestamp metadata plus precision
    session_ordinal: authoritative chronological session position
    turn_ordinal: authoritative turn position
    valid_times:
      - temporal_type: instant | interval | recurrence | duration | relative
        raw: exact temporal phrase or null
        source_precision: exact | time | day | week | month | year | interval | relative | unknown
        source_certainty: certain | uncertain | ambiguous | absent
  claim_sources: exact source selectors from the target session

support_binding:
  binding_id: content-addressed identity over the complete binding
  record_id: supported immutable record core
  target_field_path_or_mention_id: exact target
  purpose: semantic_classification | attribution | argument_role | discourse_scope | temporal_type | other
  method: declared transformation/version
  evidence: content selector IDs or immutable metadata selector IDs
  confidence: high | medium | low

resolution_assertion:
  resolution_id: content-addressed identity over the complete assertion
  target_record_id: immutable record core
  target_field_path_or_mention_id: exact target
  kind: identity | coreference | omitted_argument | value_normalization | temporal_resolution
  proposed_value: typed JSON value
  evidence: content selector IDs or immutable metadata selector IDs
  method: declared transformation/version
  confidence: high | medium | low
  status: candidate | confirmed | rejected

semantic_projection:
  projection_id: hash of complete projection payload
  record_id: immutable record core
  renderer_version: frozen deterministic renderer
  confirmed_resolution_ids: ordered IDs used by enriched projection
  canonical_text: deterministic retrieval rendering
```

Required invariants:

- Base `canonical_text` is deterministically reproducible from an allowlisted source-faithful core and
  a versioned renderer. An enriched projection may use only confirmed resolution assertions and must
  list their IDs. Projection bytes and extraction confidence are excluded from `record_id` because
  they live in separate content-addressed objects.
- A model may emit draft quote strings, but the host assigns offsets and IDs.
- Mention IDs derive only from immutable source coordinates. Cross-session identity, resolved
  referents, and relative-time interpretations are append-only resolution assertions; they never
  replace source-faithful mention surfaces in the record core.
- A record may have multiple claim sources only when one proposition genuinely depends on multiple
  spans.
- Claim sources and every required field binding materialize atomically.
- Every non-host-derived semantic-core field has a complete support-binding set before the record is
  accepted. Host-derived fields have immutable metadata bindings. Extraction confidence belongs to
  the attempt/derivation occurrence, not the record core.
- Proposition-valued references are acyclic: only the containing/outer record may reference an
  already-materialized inner record. The inner record uses `parent_scope_selector_id`, never a parent
  record ID. Cross-record condition/comparison/causal relations may instead use typed links.
- Model/run/prompt provenance is stored through append-only attempt-to-object derivation relations,
  not embedded as singular mutable provenance inside the semantic object.

### 4.3 Compact ASSISTANT-content plane

ASSISTANT advice, explanations, templates, and long enumerations remain accessible without flooding
the episodic index. The executable schema is:

```yaml
assistant_block:
  block_id: stable ID derived from source block span and block kind
  block_kind: advice | explanation | template | procedure | generated_content | other
  discourse_context: same frame/commitment contract as semantic records
  source_selector_id: exact selector covering the complete block

assistant_block_item:
  item_id: stable hash of block ID and exact item source selector
  block_id: parent block
  ordinal: source order within the block
  heading: optional exact heading surface
  source_selector_id: mandatory exact item boundary

assistant_block_projection:
  projection_id: hash of the complete projection payload
  block_id: immutable block core
  renderer_version: frozen projection method
  routing_text: concise lossy topic description
  routing_terms: source-present entities, dates, quantities, headings, and named concepts
  item_routing_terms: complete deterministic lexical terms keyed by item ID
```

The block is a retrieval route, not a replacement for raw content. If a later USER turn adopts or
reports one item, that USER event receives its own structured record and an `ADOPTS`, `REJECTS`,
`IMPLEMENTS`, or `REFERS_TO` link to the stable item ID. Complete raw block/item text contributes a
deterministic lexical index; a lossy routing summary is never the only discovery path.

### 4.4 Rebuildable typed-link plane

Links are independent, generation-versioned records:

```yaml
typed_link:
  link_id: hash of the complete immutable link core
  type: relation enum
  source_endpoint: record | mention | block | item ID
  target_endpoint: record | mention | block | item ID
  direction: source_to_target | symmetric
  affected_field_path: optional predicate/argument slot changed by an update
  effective_time: temporal value; explicit unknown required when not source-resolvable
  assertion: explicit | inferred
  status: candidate | confirmed
  confidence: high | medium | low
  provenance_basis:
    - basis_kind: source_span | structural_order | immutable_timestamp | temporal_parse
      selector_ids: exact supporting selectors when applicable
      metadata_selector_ids: immutable order/time metadata when applicable
      parsed_value: exact parsed relation/time value when applicable
      method_version: validator/parser/linker version

link_generation_membership:
  generation_id: append-only generation manifest
  link_ids: ASCII-byte-sorted immutable link IDs
```

Supported relation types include:

- `UPDATES`
- `SUPERSEDES`
- `CORRECTS`
- `CONTRADICTS`
- `DUPLICATE_REPORT_OF`
- `BEFORE`
- `AFTER`
- `SAME_EVENT_CANDIDATE`
- `SAME_EVENT`
- `SAME_ENTITY_CANDIDATE`
- `SAME_ENTITY`
- `REFERS_TO`
- `ADOPTS`
- `REJECTS`
- `IMPLEMENTS`
- `EMBEDDED_IN`
- `CONDITION_OF`
- `ALTERNATIVE_TO`
- `COMPARES`
- `CAUSES`

Links may be regenerated only by appending a new generation. Prior generations and hashes remain
available. A semantic link never deletes or hides an observational endpoint. Extraction lifecycle
status may exclude an invalid extraction from the default projection while retaining it for audit;
that is not a semantic `SUPERSEDES` link.

### 4.5 Immutable extraction lifecycle

Every model call or deterministic import creates an immutable attempt with a complete input-context
manifest, page/target IDs, parent attempts, trigger, raw provider output/hash, finish reason, parsed
drafts, diagnostics, and call-time warnings. An immutable content-addressed
`attempt_materialization_result` then records that attempt's materialized object IDs, quarantines,
completion errors, and materialization warnings. The split avoids a circular identity between an
attempt and quarantines that themselves cite the attempt. Each proposal occurrence is retained even
when its canonical semantic object already exists.

Quarantines retain their draft, valid selectors, all candidate offsets, failures, derivation, and
repair lineage. Repair appends a new attempt. A model may only append `challenged`. Exclusion from
the default semantic projection requires either deterministic structural invalidity or two
independent semantic judgments plus adjudication. It also requires an accepted replacement; without
one, an explicit projection gap is recorded and completion is blocked. Lifecycle transitions are
monotonic and append-only; no historical artifact is mutated.

### 4.6 Stable identity and append contract

All IDs are `sha256(domain_separator || schema_version || RFC-8785(payload))`. Exact Unicode is
preserved; identifier arrays are sorted by ASCII bytes; locale sorting, output order, ingestion time,
and implicit object-key order are forbidden.

- `raw_turn_id` hashes archive identity, immutable host turn identity, role, raw timestamp metadata,
  and content hash.
- `selector_id` hashes raw-turn ID, authoritative byte start/end, and span hash.
- `mention_id` hashes selector ID and mention type.
- `record_id` hashes every byte of the immutable source-faithful semantic core and sorted claim
  selector IDs. Rendering/projection, support bindings, model/prompt/run, extraction confidence,
  resolution assertions, lifecycle events, and link generations are separate objects.
- `block_id` hashes every byte of the immutable block core; `item_id` hashes every byte of the
  immutable item core. Routing projections are separate objects.
- `link_id` hashes every byte of the immutable link core. Generation membership is separate.
- attempt, quarantine, resolution, lifecycle, and link-generation IDs each use their own frozen
  domain separator and identity payload.

Reingestion of identical canonical objects is idempotent. An identical semantic core reuses its
record ID and appends another derivation occurrence. A semantically changed repair creates a new
record ID. A host-turn key reused with different bytes is a version conflict. Opaque handles are
persisted or deterministically keyed; collection-order numbering is forbidden.

## 5. Ingestion workflow

### Stage A — raw archive and structural segmentation

Code stores exact turns, calculates hashes, assigns opaque handles, and identifies only structural
boundaries such as turns and explicit list sections. It assigns immutable UTF-8 byte intervals and
expected segment IDs. No semantic deletion occurs.

### Stage B — source-role-aware semantic mapping

The mapper processes one target session with a bounded context package selected only for reference
resolution. It produces:

1. structured episodic records;
2. compact ASSISTANT-content blocks;
3. unresolved mention records;
4. claim and resolution quote anchors;
5. one structural-accounting row for every expected segment, naming zero or more record/block/
   quarantine IDs or an explicit no-semantic-content outcome.

Provider truncation, parse failure, output-limit finish reason, array overflow, and missing/duplicate
continuation pages are incomplete attempts. The host must split or page large targets and reconcile
every expected structural segment. These rows prove processing/accounting only, not semantic
exhaustiveness. Semantic completeness is measured independently by proposition-level fixtures and
typed oracle obligations; no-semantic-content outcomes are sampled as a high-risk stratum.

The first implementation must compare at least two mapper configurations on the same tiny fixtures;
the specification does not preselect a winner before evidence.

### Stage C — lossless mechanical materialization

Code encodes the proposed quote as strict UTF-8 without normalization and enumerates overlapping byte
occurrences in the declared turn. Zero occurrences quarantine as `quote_not_found`; one occurrence
is accepted and any prefix/suffix mismatch becomes a warning; multiple occurrences use exact adjacent
prefix/suffix bytes and accept only one survivor. It assigns hashes, materializes multi-source records
atomically, reports every warning, and never deletes raw evidence.

### Stage D — targeted semantic repair

There is no unconditional second full extraction. A repair model receives only:

- the affected raw turn plus necessary resolution context;
- the specific failed or suspicious record;
- deterministic diagnostics;
- the exact missing invariant.

Triggers are predeclared: unresolved ambiguous anchor, missing required schema field/binding,
uncovered segment, or a question-independent sampled semantic-fidelity failure. Repairs pass through
the same materializer and append immutable attempt, derivation, quarantine, and lifecycle lineage.
An opened benchmark failure may inform a later development revision, but the same cohort cannot
certify that revision.

### Stage E — mention resolution and typed links

A separate pass proposes reversible entity/event candidates and typed temporal/update links. It may
use broader chronological context than the mapper. Link provenance may be exact source spans,
immutable timestamp/order metadata, or a declared temporal parse. Low-confidence merges remain
candidates and cannot rewrite records.

### Stage F — freeze and evaluate

First freeze and hash raw, attempts, records, compact blocks, mentions, prompts, schema, code
configuration, call traces, quarantines, coverage, projections, and token metrics. Without opening
any development or certification evaluation data, build and independently freeze a versioned link
overlay. Only after both freezes exist does the evaluator recompute every artifact hash, refuse
mutable/incomplete input, and open its rung-scoped evaluation data. Semantic and link stages are
scored separately; link failures cannot retroactively change semantic-ingestion metrics.

## 6. Evaluation model

### 6.1 Typed evaluation obligations

The oracle may not mix facts, computations, links, and answer synthesis inside one denominator. Every
obligation declares `obligation_id`, type, eligible storage plane/stage, exact source basis, satisfaction
rule, criticality, and scoring denominator.

| Obligation type | Eligible plane | Satisfied when |
|---|---|---|
| `direct_semantic` | accepted semantic records | A record entails the directly stated proposition and provenance supports it. |
| `compact_route` | accepted compact block/item index | Searchable routing metadata or complete item lexical postings discover the exact relevant block/item. Merely enclosing the fact in a large raw span is insufficient. |
| `operand` | accepted semantic records or compact items | The source-backed value/date/unit and its role are available for later computation. |
| `asserted_relation` | accepted semantic record only | The source explicitly states the relation and a semantic record preserves it. |
| `derived_relation` | none for ingestion recall | Required operands/basis are scored; the derived result belongs to later reasoning. |
| `typed_link` | frozen link generation | A supported link of the required type, direction, endpoints, field slot, and time exists. |
| `answer_only` | answer stage only | Excluded from ingestion and linking denominators. |

### 6.2 Separate metrics

The evaluator must report all of the following rather than one ambiguous recall number:

1. **Occurrence fidelity:** did the representation preserve what a particular certified source span
   says?
2. **Global evidence availability:** does any supported record in the complete frozen store preserve
   each required fact?
3. **Operand availability:** for derived answers, are every required value, unit, date, and temporal
   relation available?
4. **Link availability:** when the link stage is enabled, are required update/chronology relations
   present and supported?
5. **Unsupported-record precision:** does each judged record mean only what its claim plus resolution
   provenance supports?
6. **Index size:** tokens for the actual searchable projection, separately from raw archive and full
   provenance storage.
7. **Role distribution:** record and searchable-token counts split by USER/ASSISTANT, speech act, and
   storage plane.
8. **Raw recoverability, compact-block discoverability, quarantine backlog, and raw-only coverage:**
   reported separately; raw/quarantine never satisfy accepted-semantic availability.
9. **Stage-qualified story completeness:** report `semantic_story_complete` and
   `link_story_complete` separately. A combined readiness conjunction is allowed only after both
   verdicts exist; neither denominator substitutes for the other.

### 6.3 Discovery and semantic judgment

An oracle-assisted search over the complete frozen eligible representation is a diagnostic discovery
method, not future retrieval performance and not automatically ingestion recall. A positive semantic
match may establish availability. A negative counts as ingestion loss only after an exhaustive
batched scan of every eligible record/block in the bounded evaluation store or after a separately
validated discovery method with a frozen recall bound. Candidate discovery and semantic coverage are
reported separately.

Two blinded judgments are separate:

1. `record_entails_obligation` receives only the representation; exact source text cannot fill a
   detail omitted from the record.
2. `record_supported_by_source` receives the record and bound claim/resolution provenance and judges
   whether the representation added or changed meaning.

Supported-record precision uses a question-independent stratified sample across source role, plane,
speech act, discourse frame, resolution use, confidence, list length, and record kind. All declared
critical/high-risk records are a census. Zero denominators are `not_evaluable`.
For bounded development rungs, the manifest freezes a full-cohort census, a minimum supported ratio
of 99%, and the requirement that every critical record be supported. The integer denominator is
derived from the verified frozen active population after ingestion; it is never guessed beforehand.

### 6.4 Searchable projection and compression accounting

The semantic searchable projection is a versioned serialization of these allowlisted fields only:
`record_kind`, discourse frame/commitment, predicate surface/normalized label, argument role/group/
source surfaces/normalized values, stance fields, raw/normalized temporal values, and generated
`canonical_text`. IDs, hashes, provenance bytes, attempts, diagnostics, and derivations are excluded
from this projection and reported separately.

For compact blocks, routing text/terms and item routing terms are counted in the semantic projection.
The deterministic lexical postings over complete raw ASSISTANT block/item text are reported as a
separate raw lexical index, because they affect storage/search cost but are not prompt-token
compression. Every report freezes tokenizer name/version, serialization, field allowlist, and
deduplication policy.

### 6.5 Holdout lifecycle

Existing `micro4`, `smoke12`, chats 18/3, and the plaintext recertified oracle are development data;
they cannot certify v1. A certification holdout must be maintained outside the implementation
workspace by a custodian mechanism. Before approval, the repository contains only cohort-selection
method and committed hashes, not plaintext questions/oracle/answers.

The evaluator must:

- maintain an append-only access log;
- recompute every raw/store/link/prompt/schema/code/config hash before unsealing;
- reject incomplete or mutated freezes;
- allow one opening only—after opening, the cohort becomes development data;
- consume the certification result after any prompt/schema/code/repair change.

The protection boundary prevents accidental or agent-driven access through supported runners. It
does not claim to stop a human shell owner with unrestricted filesystem access.

### 6.6 Statistical and advancement rules

Every rung manifest freezes exact integer numerators/denominators per obligation type and risk
stratum before execution. Percentages are secondary displays. Question, turn, and conversation
clustering is reported; atom rows are not treated as independent samples. Development rungs falsify
designs but do not estimate population generalization.

| Metric | Minimum to advance |
|---|---:|
| Schema and provenance invariants on deterministic fixtures | 100% |
| Unique exact quote accepted despite bad optional context | 100% |
| Critical entity/value/date/polarity swaps | 0 |
| Direct-semantic and compact-route obligations | exact numerator frozen per rung; displayed target at least 95% |
| Semantic evidence stories | exact semantic-only numerator frozen per rung; displayed target at least 85% |
| Link evidence stories | exact link-only numerator frozen per applicable rung; no substitution from semantic records |
| Operand availability for derived questions | 100% |
| Critical supported-record precision | 100% |
| Overall supported-record precision on judged sample | at least 99% |
| USER factual fixture preservation | 100% |
| ASSISTANT concrete-fact fixture preservation | 100% |
| ASSISTANT 20-item advice fixture | compact block plus raw route; no 20-card explosion |
| Searchable semantic projection | at most 25% of raw tokens before retrieval-time packing |

For a 4-story development screen, the 85% display target means 4/4. For 12 stories it means at least
11/12. Certification of at least 99% supported-record precision requires an independently sampled
population large enough for its declared one-sided confidence bound; with zero failures and
independent observations, roughly 299 records are needed for a 95% lower bound of 99%, and clustered
sampling may require more. Micro-rung precision therefore uses a census of its bounded output and is
not presented as a population estimate.

The eventual retrieval/answer context target remains approximately 20–30k tokens for a one-million-
token history, but that is a later retrieval gate and is not falsely reported as an ingestion-index
metric.

## 7. Mandatory test ladder

Every rung ends with a written result and user decision. Cost estimates are forecasts, not output
caps. No rung starts automatically.

| Rung | Scope | Paid model calls | Purpose | Advancement rule |
|---|---|---:|---|---|
| `L0` | Static plan-to-schema/code conformance | 0 | Prove required fields and stages actually exist before behavior testing. | 100% requirement mapping; zero missing non-negotiables. |
| `L1` | Deterministic adversarial fixtures | 0 | Test unique/repeated anchors, bad prefix/suffix, Unicode offsets, append-only IDs, role routing, and evaluator candidate scope. | All fixtures pass; no evidence silently discarded. |
| `L2` | One deliberately difficult session | Small, forecast before approval | Detect card explosion, schema misuse, bad stance, malformed provenance, and repair behavior. | All session-specific gates pass; otherwise stop. |
| `L3` | Three heterogeneous session bundles | Small, forecast before approval | Cover USER facts, ASSISTANT facts/advice, corrections, coreference, dates, lists, and long-range references. | No critical loss; compression and role-distribution gates pass. |
| `L4` | Development 4-question/source falsification screen | Small, forecast before approval | Validate typed obligations, exhaustive-negative handling, operands, and separate link scoring. | Exact frozen counts; all four semantic stories complete; applicable link stories reported separately; no critical error. |
| `L5` | Development 12-case bounded-history screen | Forecast before approval | Broaden failure-shape coverage without claiming generalization. | Exact frozen counts; at least 11/12 semantic stories plus separately frozen link-story gate and all other rung gates. |
| `L6` | One complete BEAM-1M development conversation | Explicit separate approval required | Scale/engineering confirmation only after every cheaper falsification attempt passes. | Predeclared full-run gates; certification holdout remains sealed. |
| `L7` | Custodian-sealed replication cohort | Explicit separate approval required | One-shot replication without prompt/schema/code changes. | Confirms only the declared cohort; failure blocks retrieval integration. |

Any population-generalization claim requires a later multi-conversation cohort sized from a declared
uncertainty target; it is not authorized by this ingestion specification.

Mandatory adversarial fixtures are predeclared by shape before implementation:

- every model-facing response schema is converted to the provider JSON-Schema
  dialect and rejected locally if it contains unsupported dynamic-key keywords;
  arbitrary JSON values cross the model boundary through a lossless fixed-entry
  encoding and are decoded before semantic materialization;
- unique exact quote with wrong prefix/suffix; repeated quote with one/zero/multiple exact context
  survivors; empty and boundary context;
- emoji, astral characters, combining marks, mixed newlines, right-to-left text, and byte offsets that
  would split a UTF-8 scalar;
- one failed selector in a multi-source record; same ID/different bytes; prefix ingest followed by
  append proving all earlier raw/selector/mention/record/block/item IDs remain byte-identical;
- truncated provider output, schema overflow, missing/duplicate continuation page, parse failure, and
  an apparently empty output for a fact-rich segment;
- scripted dialogue, role-play, nested reported speech, hypothetical/template text, and invented
  ASSISTANT examples that name people but must not become committed episodic facts;
- USER fact/adoption, ASSISTANT concrete report, a 20-item ASSISTANT list with the query term only in
  an item omitted from the summary, and later reference to “the third option”;
- grouped offers/prices, comparison and selected alternative, recurrence under coarse identical
  session dates, partial correction, old/new value, and long-distance coreference.
- missing support binding for discourse/argument/stance/time fields; candidate versus confirmed
  resolution projection; challenged record with failed replacement; same core ID with differing
  attempt confidence/routing projection; and link provenance with exact metadata/parser basis.
- authenticated receipt replay, local receipt mutation, failed-rung acknowledgment, prerequisite hash
  mismatch, and attempted link construction after evaluation data access.

The approval packet before each rung must show:

- exact fixtures/sessions for development rungs, or only hashes and selection method for sealed rungs;
- which code and prompt versions will run;
- model, reasoning, concurrency, input/output forecast, expected cost range, and expected wall time;
- metrics, thresholds, and stop conditions;
- proof that larger or forbidden datasets will not be opened;
- the exact output directory and artifacts that will be retained.

The approval is represented by a control-plane-issued, authenticated one-run receipt. Its successful
state is `planned → approved → running → passed → user_accepted`; `running → failed` is terminal for
advancement and may only become `user_acknowledged`. It binds a nonce, cohort/prerequisite hashes,
code/prompt/schema/config hashes, model/reasoning/concurrency, conservative reservations for
extraction/repair/judge/retry/adjudication calls, output directory, timestamp, and user identity. The
runner verifies its signature/MAC before opening rung-scoped inputs or dispatching calls and consumes
the nonce atomically in an append-only ledger. Replay, local edits, price-table changes, or forecast
increases invalidate approval. Output ceilings derive from schema completeness, not affordability;
cost guards stop before dispatch rather than truncating responses.

## 8. Implementation traceability matrix

This table is deliberately incomplete until implementation. Cold conformance reviewers fill and
independently verify it. A requirement with any blank required cell is not implemented.

| Requirement | Schema field(s) | Production code | Automated test | Runtime artifact | Reviewer verdict |
|---|---|---|---|---|---|
| `RAW-001..003` | `RawTurnSchema`, `SourceSelectorSchema`, `StructuralSegmentSchema` | raw materialization, strict UTF-8 selector resolution, transport reference | `structuredEventMaterializerV1.test.ts` | raw archive, transport reference, selectors | selective repair implemented; repaired `L0` not run |
| `SEM-001..009` | semantic core, discourse, arguments, stance, temporal schemas | mapper materialization + source-faithful/enriched projection | `structuredEventMaterializerV1.test.ts` | records, mentions, semantic projections | implemented; `L0` not run |
| `SRC-001..006` | source/metadata selectors, support bindings, resolutions | atomic anchors, field bindings, metadata and resolution provenance | `structuredEventMaterializerV1.test.ts` | selectors, bindings, resolutions | implemented; `L0` not run |
| `VAL-001..006` | issues, quarantine, mapper page, attempt-result schemas | exact byte resolver, pagination reconciliation, canonical dedupe | `structuredEventMaterializerV1.test.ts` | warnings, quarantines, attempt results | implemented; `L0` not run |
| `ROLE-001..005` | stance, assistant block/item/projection schemas | role checks, compact block materialization, full-item lexical postings | `structuredEventRoleRoutingV1.test.ts` | assistant blocks/items/projections | implemented; `L0` not run |
| `LINK-001..005` | typed-link core/provenance/generation schemas | multi-view query-blind candidate batches, link materialization, custody ordering | `structuredEventLinkV1.test.ts` | links, generation, link freeze, custody ledger | implemented; `L0` not run |
| `ID-001..004` | canonical JSON, ID schemas, derivation schema | domain-separated content addressing, ASCII ID sorting, occurrence derivations | `structuredEventIdentityV1.test.ts` | semantic/link derivation ledgers | implemented; `L0` not run |
| `RES-001..003` | resolution assertion + semantic projection schemas | candidate/confirmed/rejected assertions and confirmed-only rendering | `structuredEventMaterializerV1.test.ts` | resolutions and projections | implemented; `L0` not run |
| `REP-001..003` | attempt, attempt-result, quarantine, lifecycle schemas | immutable attempts/results, targeted repair lineage, lifecycle guards | `structuredEventLifecycleV1.test.ts` | calls, attempts/results, quarantines, lifecycle | implemented; `L0` not run |
| `COV-001..003` | segment, coverage, page schemas | Unicode-safe chunking, page manifests, exact coverage reconciliation | `structuredEventMaterializerV1.test.ts` | coverage rows and semantic freeze | implemented; `L0` not run |
| `INC-001..003` | immutable raw/resolution/lifecycle/generation schemas | append compatibility, keyed opaque handles, idempotent materialization | `structuredEventIdentityV1.test.ts` | raw archive, opaque map, generations | implemented; live incremental runtime remains out of scope |
| `EVAL-001..009` | typed obligations/discovery/freezes/precision schemas | exhaustive negatives, separate story denominators, blind entailment/support judges | `structuredEventEvaluationV1.test.ts` | two freezes, typed result, precision sample | implemented; `L0` not run |
| `GOV-001..006` | authenticated receipt, execution binding, ledger schemas | approval packets, signer separation, nonce consumption, terminal state machine, cost guard | `structuredEventApprovalV1.test.ts` | receipt, binding, ledgers, rung result | implemented; `L0` not run |

## 9. Required cold reviews

### Before implementation

Three independent reviewers receive this specification without prior chat conclusions:

1. **Representation reviewer:** look for cases the schema cannot faithfully express.
2. **Losslessness reviewer:** attack deterministic validation, provenance, append-only behavior, and
   repair boundaries.
3. **Evaluation reviewer:** identify metrics that confuse ingestion, retrieval, linking, reasoning,
   or answering.

Every finding receives `accept`, `modify`, or `reject` with rationale in a review-disposition section
before this document becomes frozen.

### After implementation

Three new cold reviewers independently inspect the frozen specification, code, prompts, tests, and
generated `L0` conformance report:

1. plan-to-schema conformance;
2. plan-to-runtime-flow conformance;
3. test/evaluator conformance and leakage audit.

They may not infer that a requirement exists from comments or prompt prose. Only executable schema,
code, passing tests, and retained artifacts count. Any material disagreement blocks `L1`.

## 10. Review disposition

Three cold reviewers independently returned `BLOCK`/`reject for implementation` on the first draft.
Every blocking finding was accepted; none was waived. After two amendment/recheck loops, the
representation, losslessness, and evaluation/governance reviewers each returned `PASS for
implementation planning`. The specification remains unapproved until the user decision.

| Finding | Reviewer | Decision | Specification change |
|---|---|---|---|
| Examples, scripts, role-play, and invented dialogue could become facts | representation | accept | Added `SEM-008` and explicit discourse/commitment scope. |
| Entity resolution lacked a first-class reversible mention contract | representation + losslessness | accept | Added mention schema, field-level provenance, append-only resolution assertions, and mention/entity endpoints. |
| ASSISTANT compact blocks could not support omitted-item search or later adoption | representation + losslessness | accept | Added stable block/item schemas, complete-item lexical postings, and adoption/reference links. |
| Temporal/update model could not express recurrence, grouped time, or directed field changes | representation | accept | Added `valid_times[]`, structural order, grouped arguments, rich update-link direction/slot/time/basis. |
| Predicate arguments could not express comparisons, conditions, alternatives, or embedded propositions | representation | accept | Added grouping, custom roles, collections, record references, money, and duration values. |
| Unicode/span semantics and unique-quote algorithm were unspecified | losslessness | accept | Made strict UTF-8 bytes authoritative and specified zero/one/multiple occurrence behavior. |
| Record-level provenance could not prove individual normalized fields | losslessness | accept | Added field/mention-level bindings with content or immutable-metadata evidence. |
| Quarantine, repair, invalidation, and derivation could mutate or lose lineage | losslessness | accept | Added immutable attempts, quarantines, lifecycle events, append-only derivations, and atomic materialization. |
| Stable IDs and append behavior were untestable | representation + losslessness | accept | Added domain-separated RFC-8785 identity algorithms and prefix-append/idempotence fixtures. |
| Turn dispositions and output limits could hide partial extraction | losslessness | accept | Added structural segment census, pagination reconciliation, explicit incomplete states, and freeze blockers. |
| Oracle mixed direct facts, operands, links, derivations, and answers | evaluation | accept | Added typed obligations with eligible planes and separate denominators. |
| Global availability still conflated retrieval with ingestion | evaluation | accept | Positive discovery may establish availability; negative requires exhaustive eligible-plane scan or validated recall bound. |
| Source-visible judging could fill omissions and precision sampling was positively conditioned | evaluation | accept | Split entailment/support judges and required independent store-wide stratified precision sampling/census. |
| Existing “sealed” cohorts were visible development artifacts | evaluation | accept | Declared existing cohorts development-only and added external custodian, one-shot access, hash verification, and access log. |
| Four/12-case percentage gates implied unsupported generalization | evaluation | accept | Added exact denominators, clustering, development-only labels, integer interpretations, and separate future population study. |
| User approval existed only as prose | evaluation | accept | Added bound one-run receipt, enforced state machine, prerequisite hashes, reservation renewal, and honest bypass boundary. |
| Resolution overlays were promised but still embedded in immutable records | representation recheck | accept | Added executable resolution assertions and separate base/enriched projections; removed resolved identity/time from the core. |
| Parent/child record references created a content-hash cycle | representation recheck | accept | Replaced parent record ID with source-scope selector and required one-way acyclic proposition references. |
| Record/block/link IDs excluded bytes stored in their canonical objects | representation + losslessness recheck | accept | Split immutable identity cores from support, confidence, routing/rendering, resolution, derivation, and generation-membership objects. |
| Link provenance named only a basis category | representation recheck | accept | Added exact selector/metadata IDs, parsed values, method version, and mandatory update effective-time value. |
| Structural coverage still claimed semantic exhaustiveness | losslessness recheck | accept | Made coverage rows zero-to-many structural accounting only; semantic completeness uses proposition obligations and USER propositions cannot silently route raw-only. |
| Lifecycle invalidation could hide valid evidence | losslessness recheck | accept | Models can only challenge; exclusion requires deterministic invalidity or independent dual judgment plus adjudication and replacement/gap blocking. |
| Raw encoding contract allowed non-UTF-8 bytes that selectors could not address | losslessness recheck | accept | Made strict UTF-8 the semantic boundary and retained upstream transport separately. |
| Link generation could occur after evaluation unsealing | evaluation recheck | accept | Required semantic freeze → query-blind link build/freeze → hash verification → unseal → separate scoring. |
| Failed rung could become accepted and receipts could be replayed | evaluation recheck | accept | Made failure terminal, added acknowledgment-only state, authenticated control-plane receipt verification, and atomic nonce consumption. |
| Relation/story denominators still crossed semantic and link stages | evaluation recheck | accept | Bound asserted relations to semantic records and split semantic/link story gates. |
| `mention_id` had two incompatible hash-input definitions | representation final recheck | accept | Standardized identity to `selector_id + mention_type`, matching the stable-identity contract. |
