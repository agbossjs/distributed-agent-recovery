# 11 — The CLI, Studio and the error catalog

Read this when you run an `npx agboss …` command, open LangGraph Studio, or meet a `[rule.code]`.
The catalog below lists **every** assembly rule code with what it means and a before → after fix,
then the warnings, the other codes the CLI prints, and the runtime error codes.

<!-- agboss-skills-catalog: complete -->

## The commands

Every command takes `--json` (one JSON envelope on stdout, nothing else), `--debug` (stack traces)
and `--help` / `-h`. `npx agboss help <command> --json` describes one command for a machine — read it
instead of guessing a flag. The application is set once in `package.json`
(`"agboss": { "application": "src/<name>.application.ts" }`) or given with `--application <path>`;
there is no `--workflow <path>`.

| Command                                                                                                                                                                                                                                                                                  | What it does                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx agboss create <name> [--agents …] [--tools …] [--mcp …] [--rag …] [--yes] [--skip-install] [--dry-run]`                                                                                                                                                                             | a new project: the application `<name>-application`, its first workflow `<name>-workflow`, `AGENTS.md`, `CLAUDE.md`, these skills (alias `c`)                                                                                                                                                                                                                                      |
| `npx agboss generate <kind> <full name> [--workflow <name>] [--agent <name>] [--description <text>] [--force] [--reset] [--dry-run]`                                                                                                                                                     | adds a `workflow` (`w`), `agent` (`a`), `router` (`r`), `arbiter` (`ar`), `tool` (`t`), `mcp` (`m`), `rag` or `openapi` (`oa`) part and wires it (alias `g`), or an `eval-case` (`ec`) drafted from a kept execution; more flags: `--dir`, `--command`, `--tool` (mcp), `--folder` (rag), `--url`, `--operations` (openapi), `--suite`, `--from-execution`, `--tenant` (eval-case) |
| `npx agboss check [--models] [--cassettes] [--federation <snapshot…>] [--strict] [--prompts] [--profile <name>] [--env <name>]`                                                                                                                                                          | writes `.agboss/types.d.ts`, syncs these skills, assembles the whole application (every rule at once), checks the environment and the prompts, prints the worst-case report; `--cassettes`: the VCR cassettes too; `--federation`: the declared contracts against the neighbours' `describe --json` snapshots                                                                      |
| `npx agboss describe [--profile <name>] [--env <name>]`                                                                                                                                                                                                                                  | the application's tree, implementations, model providers, channels, budgets; then every workflow: flow, inputs and producers, limits, `model → provider`, undo actions                                                                                                                                                                                                             |
| `npx agboss dev [--strict] [--env <name>]`                                                                                                                                                                                                                                               | watch mode: `check` rerun in a short-lived child on every change of the application's `src/`                                                                                                                                                                                                                                                                                       |
| `npx agboss studio [--port N] [--env <name>]`                                                                                                                                                                                                                                            | LangGraph Studio on every workflow (port 2024 by default)                                                                                                                                                                                                                                                                                                                          |
| `npx agboss run [--start <name>] ("<task>" \| --input <json> \| --input-file <file>) [--thread <id>] [--profile <name>] [--env <name>]`                                                                                                                                                  | one execution of a start, the reply to stdout                                                                                                                                                                                                                                                                                                                                      |
| `npx agboss chat [--start <name>] [--thread <id>] [--profile <name>] [--env <name>]`                                                                                                                                                                                                     | an interactive chat with a workflow; asks in the terminal about each pause the thread's owner answers                                                                                                                                                                                                                                                                              |
| `npx agboss records export (--tenant <id> \| --all-tenants) --out <file.jsonl> [--since <date>] [--until <date>] [--env <name>]`                                                                                                                                                         | the application's kept execution records (`executionRecordRetention`) as masked JSON Lines, read from its store without running anything (reference 09)                                                                                                                                                                                                                            |
| `npx agboss hub show <path…> [--html <file>]`                                                                                                                                                                                                                                            | the agent mesh of many applications from their files — describe snapshots, eval runs, exported executions — with `--html` one self-contained page — the graph, trees, radar, declared contracts and `check --federation`'s problems with their blast radius; no project, nothing runs (reference 09)                                                                               |
| `npx agboss hub ui <path…> [--port N]`                                                                                                                                                                                                                                                   | the same files served on 127.0.0.1 behind a printed token (the `eval ui` server and rules, read-only): the mesh page, a search of the kept executions, a JSON API (reference 09)                                                                                                                                                                                                   |
| `npx agboss eval run [--suite <name>] [--runs <k>] [--report <run.json>] [--save-baseline <baseline.json>] [--html <file>] [--baseline <run.json> [--fail-on-regression]] [--chaos <rate> --chaos-seed <n> [--chaos-failures <list>]] [--metamorphic] [--profile <name>] [--env <name>]` | runs an `@EvalSuite` on the application: every case `--runs` times (default 1), pass@k / pass^k per case, the run artifact and/or compact baseline snapshot; each case against a baseline; failures injected into its model calls; each case's variants checked for the same tools                                                                                                 |
| `npx agboss eval show <run.json> [--html <file>]`                                                                                                                                                                                                                                        | a saved run artifact: its table, and with `--html` its self-contained HTML report; runs nothing                                                                                                                                                                                                                                                                                    |
| `npx agboss eval ui [--dir <folder>] [--port N] [--labels-dir <folder>] [--taxonomy <file>] [--labeler <name>] [--application <path>] [--env <name>]`                                                                                                                                    | a folder of run artifacts served on 127.0.0.1 behind a printed token, its runs labelled into `eval/labels/<suite>.jsonl` and saved as golden cases of their suites; Ctrl+C stops it                                                                                                                                                                                                |
| `npx agboss eval calibrate --report <run.json> [--labels <labels.jsonl>]`                                                                                                                                                                                                                | a saved run's judges against people's labels (`eval/labels/<suite>.jsonl`): Cohen's κ, confusion, disagreements by the judge's metrics; runs nothing                                                                                                                                                                                                                               |
| `npx agboss eval score [--start <name>] [--version <v>] [--limit N] [--profile <name>]`                                                                                                                                                                                                  | scores recent runs of a start's workflow with Jev (`--limit` default 100); the bare `npx agboss eval` lists both                                                                                                                                                                                                                                                                   |
| `npx agboss replay [--start <name>] --version <v> [--limit N] [--profile <name>]`                                                                                                                                                                                                        | re-runs a prompt version on recent tasks                                                                                                                                                                                                                                                                                                                                           |
| `npx agboss golden add [--start <name>] --name <name> [--from-last N]`                                                                                                                                                                                                                   | saves recent real tasks as a golden set (`golden/<workflow>/<name>.yaml`, default 20)                                                                                                                                                                                                                                                                                              |
| `npx agboss compare [--start <name>] --profiles base,<p> [--golden <name> \| --last N]`                                                                                                                                                                                                  | profiles side by side on the same tasks; the first is the baseline; each pair judged in both orders (a flip is a tie, `flips`)                                                                                                                                                                                                                                                     |
| `npx agboss rag index [--rag <name>] [--env <name>]`                                                                                                                                                                                                                                     | builds / updates the application's knowledge bases (one by its full name)                                                                                                                                                                                                                                                                                                          |
| `npx agboss migrate imports [<path>…] [--dry-run]`                                                                                                                                                                                                                                       | rewrites imports of the deprecated entries (`@agboss/core/core`, `/graph`, `/router`, `/tool`, `/channels`)                                                                                                                                                                                                                                                                        |
| `npx agboss help [<command>] [--json]`                                                                                                                                                                                                                                                   | the list, or one command's options                                                                                                                                                                                                                                                                                                                                                 |

- **Full names everywhere**: `--start chat-workflow-start`, `--workflow desk-workflow`,
  `npx agboss generate agent billing-agent --workflow desk-workflow` — the same string as `name`,
  traces and records. A name without its kind suffix is rejected with `Did you mean "billing-agent"?`
  (exit 2); nothing is completed or guessed.
- `--start` is optional when the application has one start; with several and none given, exit 2 with
  the starts listed. `run` checks `--input` against the start's `InputOf` field by field before
  anything starts.
- `check --models` connects to the providers (the chosen environment's secrets must be set) and checks
  every model setting against what its model supports, and OpenRouter's pinned hosts and
  quantizations against each served model's endpoints (`[model.no-matching-endpoint]`, #395); plain
  `check` needs no key.
- `check --strict` makes the analyser's and the application's warnings errors (below).
- `check` also assembles the application's eval suites (`eval-suites/*.eval-suite.ts` whose start is
  one of its starts): `eval-suites` in `result.checks`, each problem on the suite's file.
- `eval` is made of subcommands (#396): `eval run`, `eval score`, `eval show` (#397) and `eval calibrate`, each with its own options
  (`npx agboss help eval run`); the bare `npx agboss eval` prints both and exits 2
  (`usage.missing-argument`), an unknown one is `usage.unknown-command`. `eval run` exits 0 when the
  suite ran — whatever its pass rates; 2 for `--runs` below 1 or `eval.unknown-suite` (several suites
  and no `--suite`, or a name none has — the suites listed); 3 when the suite does not assemble
  (`graph.rules`) or its cases' values do not fit (`eval.case-invalid`). `eval show <run.json>` exits 2
  for a missing file (`eval.run-not-found`) or one that is not a run artifact this version reads
  (`eval.run-invalid`: another `kind`, an unknown `schemaVersion` — 1 and 2 are read —, a field missing); `--html` on
  either exits 2 with `eval.report-too-large` for a page above 16 MB even without timelines (`eval run` writes its artifact
  first); 2 for a `--baseline`
  that is no run artifact of this suite (`eval.run-invalid` / `eval.run-not-found`, before anything
  runs) or `--fail-on-regression` without one; 5 (`eval.regressed`) with `--fail-on-regression` when
  a case regressed — a case that flapped on the baseline is quarantined and never fails.
  `--chaos <rate>` and `--chaos-seed <n>` come together (`usage.missing-option`); a rate outside
  (0, 1], a seed that is not a whole number or an unknown `--chaos-failures` name is
  `usage.option-value` (the names listed: `rate-limited`, `timeout`, `truncated-response`).
  `eval calibrate --report <run.json>` (required) exits 2 for the artifact as `eval show` does, for no
  labels file (`eval.labels-not-found`) or one that is not one (`eval.labels-invalid`: the first bad
  line named, a second label of one run by one labeler for one judge, or a `runId` that is not its
  execution's run in this artifact); labels of other runs are counted, never an error.
- `records export` (#401) exits 2 without exactly one of `--tenant <id>` / `--all-tenants`
  (`records.tenant-required`), for a `--since` / `--until` that is no ISO 8601 date or time
  (`usage.option-value`) or without `--out` (`usage.missing-option`); 3 when the application keeps
  no records (`records.not-kept`: no `@Application({ executionRecordRetention })`).
- `hub show <path…>` (#401) exits 2 without a path; 3 for a missing path (`hub.input-not-found`), a
  file that is no describe envelope, run artifact or export, or a newer schema (`hub.input-schema`,
  the file and the line named), two snapshots of one application version
  (`hub.duplicate-application`); 2 for a page above 16 MB (`hub.report-too-large`).
- `hub ui <path…>` (#401) exits 2 without a path or for a `--port` outside 0–65535
  (`usage.option-value`), 3 for a file it cannot read (the codes of `hub show`, checked before it
  listens), 0 on Ctrl+C; while it serves, a file that stops reading is a 422 naming its code.
- `generate eval-case <name> --from-execution <executionId>` (#396) exits 2 without
  `--from-execution` (`usage.missing-option`), for an id two tenants kept without `--tenant`
  (`records.ambiguous-execution`, the tenants listed), for an unknown `--suite` (its suites listed,
  `Did you mean "…"?`) or a suite whose start is not the execution's (`[eval.case-start-mismatch]`);
  3 for an unknown execution (`records.not-found`) or an application that keeps none
  (`records.not-kept`); 4 when the suite already has a case of that name.
- `--profile <name>` applies `profiles/<workflow>/<name>.yaml`; `--env <name>` picks
  `environments/<name>.environment.ts` (default `dev`).

### Exit codes and the JSON envelope

| Exit | Meaning                                                                                                                          |
| ---- | -------------------------------------------------------------------------------------------------------------------------------- |
| 0    | ok (warnings included — the skills sync never changes it)                                                                        |
| 1    | internal error; also `check --models` when a model setting does not fit                                                          |
| 2    | usage: an unknown option, start, knowledge base or name; an input that does not fit; a missing `--application` file              |
| 3    | invalid project: no application path, a module without exactly one `@Application`, an assembly problem, a types file not written |
| 4    | conflict: a file or a name that already exists (`create`, `generate`)                                                            |
| 5    | quality: `eval run --fail-on-regression` — a case stable on the baseline regressed (`eval.regressed`)                            |

`--json` prints one object: `{ schema: 1, ok, command, result?, created?, modified?, warnings,
error?: { code, message } }`. `check --json` has `result.application`, `result.checks`,
`result.problems` (each `{ file, code, message }`), `result.types`, `result.report` (the worst case
of one call of each start, the environment's variables) and `result.skills` (`status`: `current`,
`installed`, `updated`, `repaired`, `off`, `failed`). `describe --json` is each workflow's
declarative snapshot: `configHash` (the join key of records and traces), `starts`, `finishes`,
`nodes` (with `promptHash`, `schemaHash`, input and output), `edges`, `onError`, `launches`,
`modelComponents` (the judges, guardrails, arbiters, compactions, reply interpreters and model PII
detection that call a model, each `{ name, kind, promptHash, schemaHash }`), `schemas`. The envelope's `error.code` names the failure class: `graph.rules` (assembly rules),
`application.load`, `workflow.load`, `workflow.assembly`, `model.configuration`, `profile.invalid`,
`usage.unknown-option`, `usage.missing-argument`, `start.not-found`, `workflow.not-found`,
`eval.unknown-suite`, `eval.case-invalid`, `eval.run-not-found`, `eval.run-invalid`,
`eval.report-too-large`, `eval.regressed`, `eval.labels-not-found`, `eval.labels-invalid`,
`records.tenant-required`, `records.not-kept`, `records.not-found`, `records.ambiguous-execution`,
`hub.input-schema`, `hub.input-not-found`, `hub.duplicate-application`, `hub.report-too-large`, …

### Reading `check`

```
$ npx agboss check
types: .agboss/types.d.ts
src/flow-patterns.application.ts graph.cycle-without-max-visits offer-workflow: the cycle through editor-agent, reviewer-agent has no maxVisits — set maxVisits on one of its agents or routers
```

Each problem is one line — the file, the code, the message (`warning: …` before a warning) — then
a count of the problems on stderr and exit 3; a clean
run ends with `ok: src/<app>.application.ts — assembly, …, types`. In messages and in thrown errors a
code is written in brackets, `[graph.cycle-without-max-visits]`.

All violations come at once. Fix every problem line, then run `npx agboss check` again; a fix can
reveal a rule the first error hid. In code, the same problems are a `GraphRuleError`:

```ts
import { GraphRuleError, type RuleCode, type RuleViolation } from "@agboss/core";

/** The codes of an assembly failure — every rule broken at once, before any model call. */
export function codesOf(error: unknown): readonly RuleCode[] {
  return error instanceof GraphRuleError
    ? error.violations.map((found: RuleViolation) => found.code)
    : [];
}
```

A path that cannot even be built — a launch right after a join, a `.join()` after
`.acceptedBy(…)` — fails when the module loads with `FlowSyntaxError` (`flow.syntax`), naming the
call; most of these are compile errors first.

## Studio

`npx agboss studio [--port N] [--env <name>]` builds every workflow of the application — the listed
ones and the child workflows they launch — on the chosen environment, writes the git-ignored
`.agboss/studio.ts` and `.agboss/langgraph.json` (one graph per workflow, named by its full name) and
starts LangGraph's dev server on them. A project has **no** `studio.ts` or `langgraph.json` of its
own, and there is no `xray` option.

- An assembly problem or a missing variable stops it with exit 3 before any server starts.
- A child workflow is drawn as a **subgraph inside its parent** (its steps as
  `vendor-check-workflow:vendor-checker-agent`) and also as a graph of its own.
- `ThisWorkflow` is the plain node `this-workflow` — Studio shows no recursion mark.
- Studio's own runs are limited by `maxSteps` and `maxVisits`; budgets are opened per execution by the
  app, so they do not cap Studio's runs. Traces go to Langfuse when its keys are set (reference 08).

## The catalog: assembly rule codes

Every code below is a `RuleCode`, reported by `npx agboss check`, `createApp` and `testWith` before
any model call. "→" separates the code that fails from the code that passes.

`[name.kind-suffix]` checks every component's `name` (`"support"` on `@Agent` — name it
`"support-agent"`) and, for the `@Application` and each `@Budget`, its class name as well
(`class DailyLimit — name it DailyLimitBudget`, `class Desk — name it DeskApplication`); other
classes follow the same convention (`SupportAgent`) without a check.

### Nodes, names and the graph

| Code                                 | Means                                                                 | Before → after                                                                                                                    |
| ------------------------------------ | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `[graph.not-a-node]`                 | a class on a path (or the workflow itself) has no component decorator | `.toAgent(Helper)` on a plain class → decorate it `@Agent({ … })`                                                                 |
| `[graph.wrong-kind]`                 | a step names a class of another kind                                  | `.toAgent(SaveAction)` → `.toAction(SaveAction)`                                                                                  |
| `[graph.duplicate-node-name]`        | two classes share one `name` in the application                       | two `"review-agent"` → `"draft-review-agent"`, `"final-review-agent"`                                                             |
| `[graph.no-workflow-start]`          | the flow has no `start(…)`                                            | `flow: [agent(X)…]` only → begin a path with `start(MyWorkflowStart)`                                                             |
| `[graph.unreachable-node]`           | a node no start leads to                                              | an `action(A)…` path nothing enters → lead a path to `A`, or delete its path                                                      |
| `[graph.dead-end]`                   | a path, case, group or side path stops before a finish                | `.toAgent(X)` as the last call → `.toAgent(X)` `.returns(XDto)` `.toFinish(F)`                                                    |
| `[graph.next-after-workflow-finish]` | something follows a finish                                            | `.toFinish(F)` `.toAction(A)` → end at the finish; move `A` before it                                                             |
| `[graph.choose-from-non-router]`     | `.chooseOne(…)` after a step that is not a router                     | `.toAgent(X).chooseOne(…)` → `.toRouter(R).chooseOne(…)`, or `oneOf` + `.switch(…)`                                               |
| `[graph.cycle-without-max-visits]`   | a cycle where no agent or router has `maxVisits`                      | a review loop → `@Agent({ …, maxVisits: 3 })` on one node of the cycle                                                            |
| `[name.kind-suffix]`                 | a component's `name` (or its class name) does not end with its kind   | `@Agent({ name: "support" })` → `name: "support-agent"` (`-tool`, `-router`, `-rag`, `-model-provider`, …)                        |
| `[dto.name]`                         | a DTO class on a path does not end with `Dto`                         | `class Ticket` → `class TicketDto`                                                                                                |
| `[dto.duplicate-name]`               | two DTO classes share a name across the project's workflows           | two `BookingDto` in two folders → `FlightBookingDto`, `HotelBookingDto`                                                           |
| `[types.unexported-class]`           | a class the generated types need is not exported                      | `class ReviewAgent {}` → `export class ReviewAgent {}`                                                                            |
| `[agent.dynamic-options]`            | an agent spreads options built at run time                            | `@Agent({ ...optionsFor(model) })` → a static literal in `*.options.ts` (`satisfies Omit<AgentOptions, "name" \| "description">`) |
| `[model.no-tool-calling]`            | an agent with `output` uses a model that cannot call tools            | an `output` agent on a text-only model → a model that calls tools                                                                 |
| `[tool.name-too-long]`               | a tool name a model sees has more than 64 characters                  | a long DTO class name in `answer-<dto>` → a shorter class or tool name                                                            |
| `[tool.name-invalid]`                | a tool name has characters a model API refuses                        | `name: "order status"` → `name: "order-status-tool"` (`[a-zA-Z0-9_-]`)                                                            |
| `[tools.max-result-size-invalid]`    | `maxResultSize` is not a whole number of bytes from 1                 | `maxResultSize: kilobytes(0)` → `kilobytes(64)`                                                                                   |

### Path placement, `.returns`, branches

| Code                             | Means                                                               | Before → after                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `[flow.shared-node-inline]`      | a node reached from two paths is continued inline                   | `….toAgent(R).returns(…)…` twice → `.toAgent(R)` in both, then its own path `agent(R).returns(…)…`                      |
| `[flow.single-entry-own-path]`   | a node reached from one place has its own path                      | `….toAgent(R)` + `agent(R)…` → continue it inline after `.toAgent(R)`                                                   |
| `[flow.continuation-twice]`      | one class continued in two places (two stages, one class)           | `ReviewAgent` as first and final review → a second class sharing an options const, its own `name`                       |
| `[flow.returns-mismatch]`        | `.returns(…)` does not say what the step (or join) gives            | `.toAgent(Triage).returns(TicketDto)` → `.returns(TriageDto)`; a step without `output` → no `.returns`                  |
| `[flow.unused-output]`           | a returned value no node reads                                      | `.returns(ApprovalDto)` nobody reads → read it (`approval: optional(ApprovalDto)`) or drop the output                   |
| `[flow.switch-not-exhaustive]`   | a `.switch(…)` misses a variant                                     | `oneOf(A, B)` with `caseOf(A)` only → add `caseOf(B)…`                                                                  |
| `[flow.switch-unknown-case]`     | a case the step does not give, or a switch after a non-`oneOf` step | `caseOf(C)` → remove it; a single output → `.returns(XDto)` instead of `.switch`                                        |
| `[flow.duplicate-error-handler]` | two handlers for one class on one step (or join)                    | `.onError(E, …).onError(E, …)` → one `.onError(E, …)`                                                                   |
| `[flow.text-agent-target]`       | a text agent (no `output`) leads anywhere but a text finish         | `route(TextAgent).toAction(A)` → give it `output`, or `route(TextAgent).toFinish(TextFinish)` (`WorkflowFinishTextDto`) |
| `[flow.ambiguous-field]`         | two fields of one node read the same class                          | `{ draft: DraftDto, oldDraft: DraftDto }` → `{ draft: historyOf(DraftDto, { limit: 1 }) }`                              |
| `[flow.path-too-deep]`           | a warning: a path nests more than four branches                     | a `switch` in a `chooseOne` in a `switch` … → move a branch into a child workflow                                       |
| `[flow.analysis-too-large]`      | a node is reached with too many path scopes                         | many optional values multiplying → move a branch into a child workflow                                                  |

### What a node reads: inputs, outdating, `about`

| Code                       | Means                                                               | Before → after                                                                                                     |
| -------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `[input.missing-on-path]`  | a required input field is not produced on some path into the node   | `input: { order: OrderDto }` with no `.returns(OrderDto)` before → return it on that path, or `optional(OrderDto)` |
| `[input.never-produced]`   | an `optional` field no path into the node ever produces             | `refund: optional(RefundDto)` never returned → return it somewhere, or remove the field                            |
| `[input.several-on-path]`  | a single field reads a class that is several values there           | `check: CheckDto` after a launch of two checkers → `checks: listOf(CheckDto)`                                      |
| `[input.history-limit]`    | `historyOf(…, { limit })` is not a positive integer                 | `{ limit: 0 }` → `{ limit: 2 }`, or no `limit` for every version                                                   |
| `[input.outdated-on-path]` | the field's latest value is outdated on some path                   | reading `CritiqueDto` after the draft was rewritten → renew it on that path, or read it earlier                    |
| `[io.ambiguous-cycle]`     | classes built from each other in a cycle: the direction is not said | `caseOf(ChangesDto)` → `caseOf(ChangesDto, { about: DraftDto })`                                                   |
| `[io.ambiguous-about]`     | a node reads a class twice and a value is `{ about }` it            | two `DraftDto` fields → one `historyOf(DraftDto)` field                                                            |
| `[io.about-on-start]`      | `{ about }` on a start's input                                      | `start(S).returns(XDto, { about: YDto })` → `.returns(XDto)`                                                       |

### Routers

| Code                              | Means                                                                     | Before → after                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `[router.routes-mismatch]`        | the flow's `route(…)` list differs from `@Router({ routes })`             | a route for `BillingAgent` with no `route(BillingAgent)` → add `route(BillingAgent)…` to `chooseOne` |
| `[router.duplicate-route]`        | a target listed twice in `routes` or in the flow                          | `route(X)` twice → once                                                                              |
| `[router.empty-input]`            | a router with `input: {}`                                                 | `input: {}` → `input: { message: WorkflowStartTextDto }`                                             |
| `[router.no-model]`               | a `DecidedBy.Model` router with no `model` and no `defaults.router.model` | add `model: "typesafe/jev-1.13"` or `defaults: { router: { model } }` on the application             |
| `[router.no-prompt]`              | an `OnDemand` route before a launch has no prompt                         | `{ target: X, spawn: SpawnPolicy.OnDemand }` → add `prompt: "The message is about …"`                |
| `[router.prompt-on-always]`       | an `Always` route has a prompt no model reads                             | `{ spawn: SpawnPolicy.Always, prompt: "…" }` → remove the `prompt`                                   |
| `[router.spawn-required]`         | a model router's route before a launch does not state `spawn`             | `{ target: X, prompt: "…" }` → `{ target: X, spawn: SpawnPolicy.OnDemand, prompt: "…" }`             |
| `[router.all-routes-always]`      | before a launch every route is `Always`: the router decides nothing       | set `SpawnPolicy.OnDemand` on the routes it chooses, or drop the router and launch directly          |
| `[router.policy-with-choose-one]` | `spawn` / `failure` on routes of a `.chooseOne(…)` router                 | `{ target: X, failure: FailurePolicy.Skip }` with `chooseOne` → remove the policy                    |

### Parallel launches and quorums

| Code                                | Means                                                                     | Before → after                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `[launch.join-required]`            | a launch not followed by a join                                           | `.toParallelAgents(A, B).toAgent(C)` → `.toParallelAgents(A, B)` `.join()` `.returns(…)` `.toAgent(C)` |
| `[launch.max-items-required]`       | a per-item launch without `maxItems`                                      | `.toParallelAgents(X)` after `listOf(…)` → `.toParallelAgents(X, { maxItems: 20 })`                    |
| `[launch.max-items-without-list]`   | `maxItems` on a launch that is not per item                               | `.toParallelAgents(A, B, { maxItems: 5 })` → remove `maxItems`                                         |
| `[launch.item-not-read]`            | the per-item target reads no field of the item's class                    | `input: { request: RequestDto }` → add `company: CompanyDto` for `listOf(CompanyDto)`                  |
| `[launch.branch-continued]`         | a launched class is continued somewhere else too                          | `CheckAgent` launched and also `.toAgent(CheckAgent)` → a second class, or a child workflow per item   |
| `[launch.branch-outdates-sibling]`  | a branch renews a value a sibling of the same launch read                 | a branch returning a new `DraftDto` while another reads `DraftDto` → move the rewrite after the join   |
| `[flow.quorum-impossible]`          | `min` above what can run, or a group that can never complete              | `.joinQuorum({ min: 4 })` over three agents → `min: 2`, or launch more                                 |
| `[flow.quorum-return-not-optional]` | after `joinQuorum({ min })` below the agents, a single answer is required | `.returns(LegalDto)` → `.returns(optional(LegalDto))`, or `min` = every agent                          |
| `[arbiter.not-an-arbiter]`          | `.acceptedBy(X)` with an undecorated `X`                                  | decorate it `@Arbiter({ name: "x-arbiter", decidedBy })`                                               |
| `[arbiter.unhandled-agent]`         | a code arbiter has no method (a model arbiter no criterion) for an agent  | add `@OnAnswer(RiskAgent) fromRisk(answer): boolean` / a `criteria` entry                              |
| `[arbiter.unknown-agent]`           | a method or criterion for an agent the launch does not run                | remove the `@OnAnswer(OldAgent)` method                                                                |
| `[arbiter.duplicate-agent]`         | two methods or criteria for one agent class                               | keep one; share a rule through a private method                                                        |
| `[arbiter.answer-method-on-model]`  | `@OnAnswer` methods on a `DecidedBy.Model` arbiter                        | remove the methods, or make it `DecidedBy.Code`                                                        |
| `[arbiter.method-name]`             | an `@OnAnswer(XAgent)` method not named `fromX`                           | `@OnAnswer(SkillsAgent) check(…)` → `fromSkills(…)`                                                    |

### Child workflows, recursion, concurrency

| Code                                         | Means                                                                                 | Before → after                                                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `[graph.no-matching-start]`                  | no start of the child takes the value the edge carries                                | `.returns(OrderDto).toWorkflow(W)` and `W` takes `VendorDto` → return a value a start takes, or add a start            |
| `[graph.ambiguous-start]`                    | two starts of the child take that value                                               | two starts taking `VendorDto` → `class QuickVendorDto extends VendorDto {}` as one start's input                       |
| `[graph.child-without-failure-finish]`       | a warning: a per-item child cannot fail softly                                        | the child's agent with no `.onError` → `.onError(StepFailedError, toAction(MarkFailedAction)….toFinish(FailedFinish))` |
| `[graph.limit-handler-uses-model]`           | a side path that can catch a limit reaches an agent, router or child                  | `.onError(LimitExceededError, toAgent(Apology))` → `toAction(Notify)` `.toFinish(F)`, or catch a narrower class        |
| `[graph.recursion-without-depth]`            | a workflow launches `ThisWorkflow` without `maxDepth`                                 | add `@Workflow({ …, maxDepth: 3 })`                                                                                    |
| `[graph.recursion-without-exit]`             | every way on from a branch recurses                                                   | `switch` whose cases both launch `ThisWorkflow` → one case that finishes                                               |
| `[graph.mutual-recursion]`                   | two workflows launch each other, or a flow names its own class                        | `.toWorkflow(TopicWorkflow)` inside `TopicWorkflow` → `.toWorkflow(ThisWorkflow)`; merge A ↔ B into one                |
| `[flow.conflicting-placement]`               | one child class launched with two placements                                          | give every mention the same `{ placement }` (one class is one node)                                                    |
| `[limits.max-concurrent-executions-invalid]` | `maxConcurrentExecutions` is not a whole number from 1                                | `maxConcurrentExecutions: 0` → `6`                                                                                     |
| `[limits.child-concurrency-above-parent]`    | a warning: a child's own cap is above its parent's (never reached)                    | child 20, parent 10 → lower the child's, or raise the parent's                                                         |
| `[limits.max-concurrent-steps-invalid]`      | `@Application({ maxConcurrentSteps })` is not a whole number from 1                   | `maxConcurrentSteps: 2.5` → `32`, or leave it unset (no cap)                                                           |
| `[limits.max-mesh-hops-invalid]`             | `@Application({ maxMeshHops })` is not a whole number from 1                          | `maxMeshHops: 0` → `6`, or leave it unset (8)                                                                          |
| `[mesh.signing-key-missing]`                 | `@Application({ mesh: { signingKey } })` names a field the environment contract lacks | declare it: `meshSigningKey!: Secret`                                                                                  |
| `[mesh.unknown-peer-key]`                    | a `mesh.peers` entry's `verifyKey` is not a field of the contract                     | declare it: `ordersPublicKey!: string`                                                                                 |
| `[mesh.duplicate-peer]`                      | one peer listed twice in `mesh.peers`                                                 | one entry per peer application                                                                                         |
| `[mesh.invalid-key]`                         | a mesh key field holds no Ed25519 key in PEM (at start)                               | PKCS #8 for the signing key, SPKI for a peer's                                                                         |
| `[a2a.target-required]`                      | an `@A2AAgent` without `target: { application, start }`                               | name the receiving application and its exported start                                                                  |
| `[application.not-an-expose]`                | a class in `@Application({ exposes })` is no `@A2AExpose` / `@McpExpose`              | list only exposes                                                                                                      |
| `[application.duplicate-expose]`             | two exposes of one name                                                               | one name per contract                                                                                                  |
| `[application.expose-unknown-start]`         | an `@A2AExpose` exports a class that is no start of the application's workflows       | export a `@WorkflowStart` of a listed workflow                                                                         |

### Steps

| Code                                | Means                                                                          | Before → after                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `[limits.max-steps-too-low]`        | no finish fits in `maxSteps`, or the default cannot hold a launch's worst case | `maxSteps: 2` on a three-step path → `maxSteps: 3`; a per-item launch → set `maxSteps` |
| `[limits.branch-exceeds-max-steps]` | every path through a node is longer than `maxSteps`                            | raise `maxSteps`, or shorten that branch                                               |
| `[limits.max-steps-unused]`         | `maxSteps` on a workflow without agents or routers                             | remove `maxSteps`                                                                      |

### Compensation

| Code                                     | Means                                                                       | Before → after                                                                                |
| ---------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `[action.compensator-not-an-action]`     | `compensateWith` names a class that is not an `@Action`                     | `compensateWith: RefundAgent` → `compensateWith: RefundCardAction`                            |
| `[action.committer-not-an-action]`       | `committedBy` names a class that is not an `@Action`                        | `committedBy: ConfirmAgent` → an `@Action`, or leave it out (a finish commits)                |
| `[action.self-compensation]`             | an action names itself as its undo                                          | `ChargeAction { compensateWith: ChargeAction }` → `compensateWith: RefundAction`              |
| `[action.compensator-compensates]`       | an undo action declares its own `compensateWith`                            | remove `compensateWith` from the undo (no chains)                                             |
| `[action.invalid-compensator-input]`     | the undo reads a field not on the path right after its action               | `RefundAction` reads `InvoiceDto` made later → read what the action returned (`PaymentDto`)   |
| `[action.committer-without-compensator]` | `committedBy` without `compensateWith`                                      | add `compensateWith`, or remove `committedBy`                                                 |
| `[flow.uncompensated-action]`            | a side path after an undoable action reaches a finish without its undo      | `.onError(E, toFinish(Failed))` → `.onError(E, toAction(RefundCardAction).toFinish(Failed))`  |
| `[flow.compensation-out-of-order]`       | a side path undoes the older action first                                   | `toAction(ReleaseStock).toAction(RefundCard)` → `toAction(RefundCard).toAction(ReleaseStock)` |
| `[flow.uncommitted-action]`              | with `committedBy`, a path reaches a finish with neither committer nor undo | add the committer (or the undo) to that path, or leave `committedBy` out                      |
| `[flow.committer-unreachable]`           | a warning: no path from the action reaches its committer                    | add the committer after the action, or leave `committedBy` out                                |

### The application, budgets, environment, DI

| Code                                          | Means                                                                                            | Before → after                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `[application.no-workflows]`                  | `@Application` lists no workflows                                                                | `workflows: []` → `workflows: [DeskWorkflow]`                                                |
| `[application.not-a-workflow]`                | a class in `workflows` is not a `@Workflow`                                                      | `workflows: [DeskService]` → the workflow class                                              |
| `[application.duplicate-workflow]`            | two workflows with one name                                                                      | rename one (`"desk-v2-workflow"`)                                                            |
| `[application.ambiguous-start]`               | one start class in two workflows                                                                 | give each workflow its own `@WorkflowStart` class                                            |
| `[budget.not-a-budget]`                       | a class in `budgets` without `@Budget`                                                           | decorate it `@Budget({ name, scope, … })`                                                    |
| `[budget.execution-budget-required]`          | a workflow without its own execution budget and no default                                       | add `@Budget({ name: "execution-budget", scope: BudgetScope.Execution })`                    |
| `[budget.duplicate-execution-budget]`         | two execution budgets with `workflow: X`                                                         | keep one                                                                                     |
| `[budget.duplicate-default-execution-budget]` | two execution budgets without `workflow`                                                         | keep one                                                                                     |
| `[budget.tenant-budget-required]`             | no `BudgetScope.Tenant` budget                                                                   | add one with `period: BudgetPeriod.Day` (a single-tenant app has the tenant `"default"`)     |
| `[budget.application-budget-required]`        | no `BudgetScope.Application` budget                                                              | add one with a `period`                                                                      |
| `[health.not-a-health-check]`                 | a class in `healthChecks` without `@HealthCheck`                                                 | decorate it `@HealthCheck({ name: "crm-health-check", timeout: seconds(2) })`                |
| `[health.duplicate-name]`                     | two health checks with one name                                                                  | rename one                                                                                   |
| `[di.infrastructure-in-workflow]`             | a store, `Clock`, `IdGenerator`, `Logger`, channel or model provider in a workflow's `providers` | move it to `@Application({ providers })`                                                     |
| `[di.missing-implementation]`                 | a channel role with no `@Channel` that extends it in the application                             | list `class SlackApprovalChannel extends ApprovalRole` in `@Application({ providers })`      |
| `[di.ambiguous-implementation]`               | two listed classes extend one contract or role                                                   | keep one (one question to several places is one channel that sends to each)                  |
| `[environment.contract-value]`                | a value in the environment contract class                                                        | `retries = 3` → `retries!: number`, the value in `<name>.environment.ts`                     |
| `[environment.missing-field]`                 | a listed implementation (or `pseudonymKey`) reads a field the contract lacks                     | a `Sqlite…` store listed → declare `sqlitePath!: string` in the contract                     |
| `[context.prompt-unused]`                     | a context field has a `prompt` no model reads                                                    | `@Text({ prompt: "…" }) userId` → `@Text() userId`                                           |
| `[model.unserved]`                            | no listed model provider serves a model                                                          | list a `@ModelProvider` that `serves` it (with one listed, the built-ins are not added)      |
| `[model.ambiguous-provider]`                  | two listed providers serve one model                                                             | one model string per provider: narrow one `serves`                                           |
| `[model-provider.both-modes]`                 | a `@ModelProvider` is HTTP and a transport at once (or neither)                                  | `complete(request)` with `baseUrl` → drop `baseUrl` / `apiKey`; HTTP with `deps` → drop them |

### Guardrails, PII, compaction, channels, judges, eval suites

| Code                                       | Means                                                                         | Before → after                                                                                   |
| ------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `[guardrail.no-model]`                     | a guardrail with no `model` and no `defaults.guardrail.model`                 | add `model: "typesafe/jev-1.13"` or `defaults: { guardrail: { model } }` (never the router's)    |
| `[guardrail.not-a-guardrail]`              | a class in `guardrails` that is not an input / output guardrail               | decorate it `@InputGuardrail({ … })` / `@OutputGuardrail({ … })`                                 |
| `[guardrail.exclude-not-inherited]`        | `excludeGuardrails` names one no level above lists                            | remove it from `excludeGuardrails`                                                               |
| `[guardrail.missing-refusal]`              | no refusal text and no `refusal()`                                            | add `refusal: "I can't help with that."` or `implements GuardrailRefusal`                        |
| `[guardrail.refusal-twice]`                | both a `refusal` text and a `refusal()` method                                | keep one                                                                                         |
| `[guardrail.no-prompt]`                    | no question to ask                                                            | add `prompt: "Does the message ask for …?"` or `promptUrls`                                      |
| `[guardrail.threshold-invalid]`            | `threshold` not in (0, 1]                                                     | `threshold: 80` → `threshold: 0.8`                                                               |
| `[guardrail.output-on-router]`             | an `@OutputGuardrail` on a router (it gives no answer)                        | list it on an agent                                                                              |
| `[guardrail.no-model-call]`                | guardrails on a code router (no model reads anything)                         | list them on the agents or model routers                                                         |
| `[guardrail.missing-handler]`              | a `decidedBy: DecidedBy.Code` guardrail whose class has no `check(text)`      | `implements GuardrailHandler` — `check(text)` returns `GuardrailVerdict.passed()` / `.blocked()` |
| `[tool-interceptor.not-an-interceptor]`    | a class in `toolInterceptors` without `@ToolInterceptor`                      | decorate it `@ToolInterceptor({ name, description })`                                            |
| `[tool-interceptor.exclude-not-inherited]` | `excludeToolInterceptors` names one no level above lists                      | remove it from `excludeToolInterceptors`                                                         |
| `[tool-interceptor.missing-handler]`       | a `@ToolInterceptor` class with neither `beforeToolCall` nor `afterToolCall`  | `implements BeforeToolCall` and / or `AfterToolCall`                                             |
| `[pii.not-a-policy]`                       | a class in `piiPolicies` without `@PiiPolicy`                                 | decorate it                                                                                      |
| `[pii.exclude-not-inherited]`              | `excludePiiPolicies` names one no level above lists                           | remove it                                                                                        |
| `[pii.conflicting-rules]`                  | two actions for one kind                                                      | keep one `pii(PiiKind.Email, …)` rule                                                            |
| `[pii.missing-refusal]`                    | `blockWithRefusal()` without text and no `refusal(kind)`                      | `blockWithRefusal({ refusal: "…" })`, or `implements PiiRefusal`                                 |
| `[pii.unused-refusal]`                     | `refusal(kind)` that no rule uses                                             | remove the method, or use `blockWithRefusal()` without text                                      |
| `[pii.kind-needs-model]`                   | a kind with no format (names, addresses) without `detectWithModel`            | add `detectWithModel: true` (or a model)                                                         |
| `[compaction.not-a-compaction]`            | `compaction:` names a class without `@Compaction`                             | decorate it                                                                                      |
| `[compaction.invalid-setting]`             | `turnsBetweenCompactions`, `summaryQueueLength` or `summaryMaxTokens` invalid | `turnsBetweenCompactions: 0` → `5`                                                               |
| `[compaction.decision-model]`              | a compaction on a decision model                                              | `model: "typesafe/jev-1.13"` → a chat model (`"moonshotai/kimi-k2.6"`)                           |
| `[compaction.uncompacted-turns-invalid]`   | `uncompactedTurns` not a whole number from 0 nor `TurnLimit.ALL`              | `uncompactedTurns: 2.5` → `5`                                                                    |
| `[compaction.missing-handler]`             | a `CompactionStrategy.Custom` class without `compact(input)`                  | `implements CompactionHandler` with `compact(input)`                                             |
| `[channel.wrong-tool]`                     | a tool names a role whose `approves` is not the tool's input                  | a role approving `RefundDto` on a tool taking `ChargeDto` → a role that approves `ChargeDto`     |
| `[channel.shared-interpreter]`             | one reply interpreter used by two roles                                       | give each role its own `@ReplyInterpreter`                                                       |
| `[reply-interpreter.not-an-interpreter]`   | `replyInterpreter:` names an undecorated class                                | decorate it `@ReplyInterpreter({ … })`                                                           |
| `[reply-interpreter.decision-model]`       | a question role's interpreter on a decision model                             | a chat model (a decision model reads approvals only)                                             |
| `[reply-interpreter.no-interpret-method]`  | a `DecidedBy.Code` interpreter without `interpret`                            | add `interpret(input): ReplyInterpretation`                                                      |
| `[judge.wrong-reply]`                      | the judge's `reply` is not the agent's `output` shape                         | `reply: DraftDto` on a `oneOf(DraftDto, NoteDto)` agent → `reply: oneOf(DraftDto, NoteDto)`      |
| `[judge.no-model]`                         | a model judge (the default `decidedBy`) without `model`                       | add `model: "typesafe/jev-1.13"`, or `decidedBy: DecidedBy.Code` for a judge decided by code     |
| `[judge.model-on-code-judge]`              | a `DecidedBy.Code` judge that names a `model` or injects `JudgeModel`         | remove `model` / `JudgeModel` from `deps`, or decide by the model (`DecidedBy.Model`)            |
| `[eval.unknown-start]`                     | an `@EvalSuite`'s `start` is not a start of the application it runs on        | the start of one of the application's workflows                                                  |
| `[eval.duplicate-case]`                    | two cases of one suite share a `name`                                         | rename one: a case name keys reports and baselines                                               |
| `[eval.judge-wrong-reply]`                 | a suite's judge judges no finish output its start reaches, or a list          | `reply` = a reached finish's `output` (`oneOf(…)` for several)                                   |

## Warnings

Printed as `warning: …` lines (exit 0); errors under `npx agboss check --strict`:

| Code                                        | When                                                                                                                             | Fix                                                                              |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `[flow.path-too-deep]`                      | a path nests more than four branches                                                                                             | a child workflow                                                                 |
| `[graph.child-without-failure-finish]`      | a per-item child cannot fail softly                                                                                              | an `.onError` side path in the child that ends at a finish                       |
| `[limits.child-concurrency-above-parent]`   | a child's cap above its parent's                                                                                                 | lower it                                                                         |
| `[flow.committer-unreachable]`              | a committer no path reaches                                                                                                      | add it, or drop `committedBy`                                                    |
| `[judge.same-model-family]`                 | a model judge of its judged agent's vendor (`openai/…` judging `openai/…`); a suite's judge vs any agent of its start's workflow | a judge model of another vendor (`typesafe/jev-1.13`, a code judge)              |
| `[application.in-memory-cost-ledger]`       | tenant or application budgets on the built-in in-memory ledger                                                                   | list `SqliteCostLedgerRepository` (or your own) in `@Application({ providers })` |
| `[application.in-memory-pauses]`            | a workflow can pause on in-memory paused executions or checkpoints                                                               | list `SqlitePausedExecutionRepository` and `SqliteCheckpointSaver`               |
| `[application.in-memory-child-queue]`       | a child launched with `ChildPlacement.AnyInstance` on the built-in in-memory child queue                                         | list `SqliteChildExecutionQueueRepository`                                       |
| `[application.in-memory-execution-history]` | `executionRecordRetention` set on the in-memory execution history                                                                | list `SqliteExecutionHistoryRepository`                                          |
| `[application.pii-instance-key]`            | PII tokens on a per-execution key: no `@Application({ pseudonymKey })`                                                           | `pseudonymKey: "piiPseudonymKey"` naming a `Secret` field of the environment     |
| `[federation.version-not-bumped]`           | `check --federation` with the project's own earlier snapshot: an export's schema changed, its expose's `version` did not         | raise the `@A2AExpose` / `@McpExpose` `version`                                  |

## Other codes the CLI prints

| Code                                 | Where                                                                                           | Fix                                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `[types.not-written]`                | `check`: the types file failed to write                                                         | fix the reason it names; `check` exits 3, never `ok`                                               |
| `[types.no-flow]`                    | `check`: no workflow found to type                                                              | keep the application in `src/` beside its `*.workflow.ts`, or export its workflows                 |
| `[di.undecorated-provider]`          | assembly: a class in `providers` without a decorator                                            | add `@Injectable()`                                                                                |
| `[di.instance-provider]`             | assembly: `provide(SomeClass, …)`                                                               | list the class; `provide` is for `InjectionToken` values                                           |
| `[di.conflicting-values]`            | assembly: one token with two values                                                             | keep one `provide(TOKEN, value)`                                                                   |
| `[observer.no-hooks]`                | assembly: an observer with no hook                                                              | implement at least one (`OnExecutionEnd`, …)                                                       |
| `[observer.unknown-hook]`            | assembly: a misspelled hook                                                                     | the name it suggests (`onToolEnd`)                                                                 |
| `[prompt.unknown-variable]`          | assembly: `{{x}}` without `promptVariables.x`                                                   | add the variable                                                                                   |
| `[prompt.input-in-instructions]`     | assembly: `{{input.…}}` in a prompt                                                             | delete it — the input message carries every field                                                  |
| `[context.not-declared]`             | assembly: a context subclass injected, not declared                                             | `@Application({ tenantContext, executionContext })`                                                |
| `[tool.duplicate-name]`              | assembly: two tools a model sees share a name                                                   | rename one                                                                                         |
| `[skills.local-edit]`                | the skills sync: a managed file edited                                                          | put project rules in `AGENTS.md`; the file is restored                                             |
| `[skills.unmanaged-file]`            | the skills sync: a file no manifest listed                                                      | kept — move it out of `.claude/skills/agboss/`                                                     |
| `[skills.sync-failed]`               | the skills sync: the folder could not be written                                                | check permissions; the check goes on                                                               |
| `[skills.no-framework]`              | the skills sync: no `agboss` in `node_modules`                                                  | `npm install`                                                                                      |
| `[skills.setting-invalid]`           | `"agboss": { "skills" }` is not a boolean (exit 3)                                              | `"skills": false` or remove it                                                                     |
| `[spend.outside-step]`               | run time: `spendRecorder.record` outside a step                                                 | record inside `run` / `execute`                                                                    |
| `[a2a.caller-resolver-not-listed]`   | `a2aHttpListener(app, …)`: its resolver is listed nowhere                                       | list it in `@Application({ providers })` or a `@Workflow({ providers })`                           |
| `[a2a.no-url]`                       | an `A2AClient` subclass without `@A2AAgent({ url })`                                            | add `@A2AAgent({ url })` or pass `url`                                                             |
| `[a2a.no-contract]`                  | `execute` on an `A2AClient` without `@A2AAgent({ target, input, output })` or `contract`        | declare the contract, or call `send`                                                               |
| `[application.expose-unlisted]`      | `a2aHttpListener(app, { expose })`: the expose is not in `@Application({ exposes })`            | list it there                                                                                      |
| `[model.no-matching-endpoint]`       | `check --models`: no endpoint serves a pinned host or quantization                              | pin a host its endpoints list, or another quantization                                             |
| `[vcr.stale-cassette]`               | `check --cassettes`: a component changed since recorded                                         | `AGBOSS_VCR_MODE=RECORD_STALE npm test`, never a hand edit; then run the evals                     |
| `[federation.incompatible-schema]`   | `check --federation`: an export no longer accepts what a consumer sends, or gives what it reads | change the export compatibly, or ship a new start and move the consumers named in the blast radius |
| `[federation.missing-target]`        | `check --federation`: a consumer's `target` is not exported by that snapshot                    | export the start / tool again, or update the consumers in the blast radius                         |
| `[federation.snapshot-schema]`       | `check --federation`: a file that is not an `agboss describe --json` output                     | save the neighbour's snapshot with `npx agboss describe --json > <app>.json`                       |
| `[federation.duplicate-application]` | `check --federation`: two snapshots of one application                                          | keep one per application                                                                           |

## Runtime error codes

Every error the framework throws is an `AGBossError` with a stable `code`; `.onError` takes the
classes of a step's failures (reference 02, section 9). `expect(run).rejects.toFailWith(ErrorClass,
{ …fields })` matches them in tests (reference 10).

| Code                                                                                                 | Class                                                                                                  | Meaning                                                                                                                 |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `step`, `step.failed`                                                                                | `PaidStepError`, `StepFailedError`                                                                     | a step's failure (the parents)                                                                                          |
| `step.agent`, `step.agent.invalid-answer`, `step.agent.quality-gate`                                 | `AgentFailedError`, `AgentAnswerInvalidError`, `QualityGateError`                                      | an agent failed; invalid answers; judges rejected it                                                                    |
| `step.action`, `step.guard`, `step.router`, `step.router.invalid-decision`                           | `ActionFailedError`, `GuardFailedError`, `RouterFailedError`, `RouterDecisionError`                    | as named                                                                                                                |
| `step.tool-blocked`                                                                                  | `ToolBlockedError`                                                                                     | a tool interceptor's `block({ reason })` (`agent`, `tool`, `interceptor`, `reason`)                                     |
| `step.arbiter`, `step.quorum`, `step.child`                                                          | `ArbiterError`, `QuorumNotReachedError`, `ChildExecutionFailedError`                                   | a launch's failures                                                                                                     |
| `limit`, `limit.steps`, `limit.visits`, `limit.budget`, `limit.depth`                                | `LimitExceededError` and its subclasses                                                                | a limit                                                                                                                 |
| `limit.mesh-loop`, `limit.hops`                                                                      | `MeshLoopDetectedError`, `HopsLimitExceededError`                                                      | a mesh call chain came back or grew too long (`entry`, `chain`, #398)                                                   |
| `limit.deadline`                                                                                     | `DeadlineExceededError`                                                                                | an execution ran past `app.execute(…, { deadline })` or its trusted mesh caller's (#398)                                |
| `mesh.audience-mismatch`, `a2a.unknown-start`                                                        | — (wire codes: `401`, `400`)                                                                           | an envelope meant for another application; a start the listener does not export, or none named with several (#398 PR 3) |
| `guardrail.blocked`, `pii.refused`, `pii.detection-failed`                                           | `GuardrailBlockedError`, `PiiRefusedError`, `PiiDetectionFailedError`                                  | safety                                                                                                                  |
| `compensation.failed`                                                                                | `CompensationFailedError`                                                                              | an automatic undo failed (`failures`, `cause`)                                                                          |
| `compaction`                                                                                         | `CompactionError`                                                                                      | a compaction could not summarise                                                                                        |
| `execution.cancelled`, `execution.lease-lost`, `app.stopping`                                        | `ExecutionCancelledError`, `ExecutionLeaseLostError`, `ApplicationStoppingError`                       | the execution was stopped from outside                                                                                  |
| `run.thread-owner`, `run.unknown-thread`, `run.not-paused`, `run.invalid-thread-id`                  | `ThreadOwnerError`, `UnknownThreadError`, `NotPausedError`, `InvalidThreadIdError`                     | a request refused                                                                                                       |
| `pause.unknown`, `pause.wrong-answerer`, `pause.uninterpretable-reply`, `pause.no-reply-interpreter` | `UnknownPauseError`, `PauseAnswererError`, `UninterpretableReplyError`, `ReplyInterpreterMissingError` | a resume refused                                                                                                        |
| `resume.incompatible`                                                                                | `IncompatibleResumeError`                                                                              | paused under another config hash                                                                                        |
| `dto.invalid`                                                                                        | `DtoValidationError`                                                                                   | a value does not fit its DTO (the field named, never the value)                                                         |
| `eval.case-invalid`                                                                                  | `EvalCaseInvalidError`                                                                                 | an eval suite's case values do not fit (`issues`, no values)                                                            |
| `context.unavailable`                                                                                | `ExecutionContextUnavailableError`                                                                     | a frame token read outside a step                                                                                       |
| `tool.timeout`                                                                                       | `ToolTimeoutError`                                                                                     | a tool call past its `timeout` (the model reads it; `ToolCallStatus.TimedOut`)                                          |
| `test.cassette-missing`, `vcr.stale-cassette`                                                        | `CassetteMissingError`, `StaleCassetteError` (`@agboss/core/testing`)                                  | a VCR replay: no recording; a component changed since recorded (`component`, `changes`)                                 |
| `model`, `model.wrong-kind`, `model.decision`                                                        | `ModelCallError`, `ModelKindError`, `DecisionError`                                                    | a model call failed; `invoke` / `decide` on the wrong kind                                                              |
| `model.provider-failure`                                                                             | `ModelProviderFailureError`                                                                            | a transport's `complete()` said why it failed (retried, paused)                                                         |
| `flow.syntax`, `workflow.not-a-start`                                                                | `FlowSyntaxError`, `NotAWorkflowStartError`                                                            | a path that cannot be built; `app.execute` with a non-start                                                             |
| `a2a.caller-rejected` (its `wireCode`: `a2a.caller-unauthenticated`, `a2a.caller-forbidden`)         | `A2ACallerRejectedError`                                                                               | `A2AClient.send`: the server's resolver refused the caller (`httpStatus` 401 / 403)                                     |

On the wire `a2aHttpListener` answers a refused caller with `{ code, error }` and a real status:
`a2a.caller-unauthenticated` (`401`, with `WWW-Authenticate` when the resolver gives a challenge),
`a2a.caller-forbidden` (`403`), `a2a.caller-resolution-failed` (`500`: the resolver threw — its text
never sent). None of them ran anything: no observer event, no record (reference 04).

## Pitfalls

- Fixing the first error and stopping: `check` reports every violation; run it again until `ok:`.
- Silencing a warning: none has a flag; fix it, and expect `--strict` in CI.
- Editing `.agboss/types.d.ts` or `.agboss/studio.ts`: both are regenerated.
- Running a command from a folder whose nearest `package.json` has no `"agboss"` field: the CLI cannot
  find the application (exit 3) — run it from the project, or pass `--application`.
