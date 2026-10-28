# 01 — Composition and architecture

Read this before you design a workflow, split one, or write its DTOs. The flow grammar itself is in
`02-flow-dsl-all-combinations.md`; component classes in `03-components-di-and-lifecycle.md`.

## Pick the primitive

| The step must…                                                         | Use                                                                             | Not                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------- |
| understand or write language, decide on meaning, use tools in a loop   | `@Agent` — a model, a prompt, `tools`, an `output` DTO                          | an action that calls a model by hand           |
| run deterministic code on the path: save, charge, compute, call an API | `@Action` — `execute(input)`, no model, cost 0 unless it records spend          | a tool nobody but the flow calls               |
| be callable by an agent zero, one or many times inside its turn        | `@Tool` in the agent's `tools`                                                  | an action (the flow calls it exactly once)     |
| choose the next step **by data** (a number, a flag, a lookup)          | `@Router({ decidedBy: DecidedBy.Code })` + `route(input)`                       | a model router asked "is total > 1000?"        |
| choose the next step **by meaning** of text it has not produced        | `@Router({ decidedBy: DecidedBy.Model, model: "typesafe/jev-1.13" })`           | a chat agent whose only job is to pick         |
| let the agent that did the work say which outcome it is                | `output: oneOf(ADto, BDto)` + `.returns(oneOf(…)).switch(caseOf(…)…)`           | a second model call through a router after it  |
| repeat a sub-process per item, give it its own branches and failures   | a child `@Workflow` (`.toWorkflow(W)`, `.toParallelWorkflows(W, { maxItems })`) | one giant flow with copied paths               |
| ask several agents and combine their answers                           | `.toParallelAgents(…)` + `.join()` / `.joinQuorum(…)` (reference 02)            | one agent prompted to "think as three experts" |
| wait for a person or a system before a side effect                     | a `@Tool({ channel })` (reference 05)                                           | an action that polls                           |
| stop unsafe input or output                                            | `@InputGuardrail` / `@OutputGuardrail` (reference 07)                           | an agent prompt that says "refuse if …"        |
| check an answer's quality and retry it                                 | `@Judge` in the agent's `judges` (reference 03)                                 | a reviewer agent for a yes / no check          |

Rules of thumb:

- **One model call per decision.** If an agent already knows the outcome, return `oneOf(…)` from it
  and `switch` on it; add a model router only where nothing has read the input yet (the first step
  of a desk) or where the choice is between many agents.
- **A code router or a `switch` costs nothing**; a model router costs a call and can fail
  (`RouterFailedError`, `RouterDecisionError`). Decide by data whenever the data exist.
- **Extract a child workflow** when the same sub-process is reached from two workflows, runs once
  per item of a list, needs its own failure finish (a per-item child that fails soft), or calls
  itself (`ThisWorkflow`, `maxDepth`). A child gets only its start's input as its scope — pass it
  what it needs through that DTO.
- **Every loop is bounded**: a node on a cycle has `maxVisits`, the workflow has `maxSteps`, money
  is the application's `@Budget`s.

## A worked example: a job shortlist

One agent screens the request and answers either a shortlist or a "no match" marker; a code router
decides by size whether the shortlist is saved; an action saves it. One class per file in a project —
here the DTOs and the finishes share a file for brevity (budgets share `config/budget.config.ts` by
convention).

```ts file=src/shortlist/dtos/shortlist.dto.ts
// dtos/shortlist.dto.ts — narrow DTOs, one per step's result; each field's prompt is its schema text
import { Integer, ListOf, Nested, Text, Url } from "@agboss/core/dto";

export class JobDto {
  @Text({ prompt: "the job title as posted", maxLength: 200 })
  title!: string;

  @Url({ prompt: "the posting's link" })
  url!: string;

  @Text({ prompt: "the hiring company" })
  company!: string;
}

export class ShortlistDto {
  @ListOf(JobDto, { prompt: "the jobs that match the request, best first", minItems: 1 })
  jobs!: JobDto[];

  @Text({ prompt: "one sentence: why these jobs", optional: true })
  reason?: string;
}

// a marker: the outcome is the class itself — no fields, no "found: false" flag
export class NoMatchDto {}

export class ShortlistSavedDto {
  @Text({ prompt: "the saved shortlist's id" })
  shortlistId!: string;

  @Integer({ prompt: "how many jobs were saved", min: 1 })
  count!: number;

  @Nested(JobDto, { prompt: "the best job", optional: true })
  top?: JobDto;
}
```

```ts file=src/shortlist/agents/screening.agent.ts
// agents/screening.agent.ts — the agent that does the work also says which outcome it is
import { Agent, oneOf } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { NoMatchDto, ShortlistDto } from "../dtos/shortlist.dto.js";

@Agent({
  name: "screening-agent",
  description: "Turns a job request into a shortlist, or says nothing matches",
  prompt: "Pick the jobs that match the request. If none does, answer that nothing matches.",
  model: "moonshotai/kimi-k2.6",
  input: { request: WorkflowStartTextDto },
  output: oneOf(ShortlistDto, NoMatchDto), // two answer tools: answer-shortlist-dto, answer-no-match-dto
})
export class ScreeningAgent {}
```

```ts file=src/shortlist/services/shortlist-store.service.ts
// services/shortlist-store.service.ts — the I/O lives in a service, created by the container
import { Injectable } from "@agboss/core";
import type { JobDto } from "../dtos/shortlist.dto.js";

@Injectable()
export class ShortlistStoreService {
  save(jobs: readonly JobDto[], idempotencyKey: string): Promise<string> {
    return Promise.resolve(`shortlist-${idempotencyKey}-${String(jobs.length)}`);
  }
}
```

```ts file=src/shortlist/actions/save-shortlist.action.ts
// actions/save-shortlist.action.ts — code on the path: reads its input from the scope
import { Action, ExecutionContext, type ActionHandler, type InputOf, type OutputOf } from "@agboss/core";
import { ShortlistDto, ShortlistSavedDto } from "../dtos/shortlist.dto.js";
import { ShortlistStoreService } from "../services/shortlist-store.service.js";

@Action({
  name: "save-shortlist-action",
  description: "Saves the shortlist",
  input: { shortlist: ShortlistDto },
  output: ShortlistSavedDto,
  deps: [ExecutionContext, ShortlistStoreService],
})
export class SaveShortlistAction implements ActionHandler<SaveShortlistAction> {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly shortlistStoreService: ShortlistStoreService,
  ) {}

  async execute(input: InputOf<SaveShortlistAction>): Promise<OutputOf<SaveShortlistAction>> {
    const { jobs } = input.shortlist.value; // a field of the scope: { producer, value }
    const key: string = this.executionContext.step.idempotencyKey; // the same on a retried step
    const shortlistId: string = await this.shortlistStoreService.save(jobs, key);
    return { shortlistId, count: jobs.length, top: jobs[0] }; // a plain object, never `new`
  }
}
```

```ts file=src/shortlist/workflow-finishes/shortlist.workflow-finishes.ts
// workflow-finishes/*.workflow-finish.ts — each finish names the class it hands back
import { WorkflowFinish } from "@agboss/core";
import { NoMatchDto, ShortlistDto, ShortlistSavedDto } from "../dtos/shortlist.dto.js";

@WorkflowFinish({
  name: "shortlist-saved-workflow-finish",
  description: "The saved shortlist",
  output: ShortlistSavedDto,
})
export class ShortlistSavedWorkflowFinish {}

@WorkflowFinish({
  name: "too-many-jobs-workflow-finish",
  description: "A shortlist too long to save, for a person to trim",
  output: ShortlistDto,
})
export class TooManyJobsWorkflowFinish {}

@WorkflowFinish({
  name: "no-match-workflow-finish",
  description: "Nothing matched the request",
  output: NoMatchDto,
})
export class NoMatchWorkflowFinish {}
```

```ts file=src/shortlist/routers/shortlist-size.router.ts
// routers/shortlist-size.router.ts — decided by data: no model, cost 0, targets typed by `routes`
import { DecidedBy, Router, type InputOf, type Route, type RouterHandler } from "@agboss/core";
import { SaveShortlistAction } from "../actions/save-shortlist.action.js";
import { ShortlistDto } from "../dtos/shortlist.dto.js";
import { TooManyJobsWorkflowFinish } from "../workflow-finishes/shortlist.workflow-finishes.js";

const MAX_SAVED_JOBS = 10;

@Router({
  name: "shortlist-size-router",
  description: "Saves a short list, hands a long one to a person",
  decidedBy: DecidedBy.Code,
  input: { shortlist: ShortlistDto },
  routes: [{ target: SaveShortlistAction }, { target: TooManyJobsWorkflowFinish }],
})
export class ShortlistSizeRouter implements RouterHandler<ShortlistSizeRouter> {
  route(input: InputOf<ShortlistSizeRouter>): Route<ShortlistSizeRouter> {
    return input.shortlist.value.jobs.length > MAX_SAVED_JOBS
      ? TooManyJobsWorkflowFinish
      : SaveShortlistAction;
  }
}
```

```ts file=src/shortlist/workflow-starts/job-search.workflow-start.ts
import { WorkflowStart } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";

@WorkflowStart({
  name: "job-search-workflow-start",
  description: "A person's job request",
  input: WorkflowStartTextDto,
})
export class JobSearchWorkflowStart {}
```

```ts file=src/shortlist/shortlist.workflow.ts
// shortlist.workflow.ts — the paths: one call per line, a `.returns` after every producing step
import { Workflow, caseOf, oneOf, route, start } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { SaveShortlistAction } from "./actions/save-shortlist.action.js";
import { ScreeningAgent } from "./agents/screening.agent.js";
import { NoMatchDto, ShortlistDto, ShortlistSavedDto } from "./dtos/shortlist.dto.js";
import { ShortlistSizeRouter } from "./routers/shortlist-size.router.js";
import { ShortlistStoreService } from "./services/shortlist-store.service.js";
import {
  NoMatchWorkflowFinish,
  ShortlistSavedWorkflowFinish,
  TooManyJobsWorkflowFinish,
} from "./workflow-finishes/shortlist.workflow-finishes.js";
import { JobSearchWorkflowStart } from "./workflow-starts/job-search.workflow-start.js";

@Workflow({
  name: "shortlist-workflow",
  version: "1.0.0",
  flow: [
    start(JobSearchWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(ScreeningAgent)
      .returns(oneOf(ShortlistDto, NoMatchDto))
      .switch(
        caseOf(ShortlistDto)
          .toRouter(ShortlistSizeRouter)
          .chooseOne(
            route(SaveShortlistAction)
              .returns(ShortlistSavedDto)
              .toFinish(ShortlistSavedWorkflowFinish),
            route(TooManyJobsWorkflowFinish),
          ),
        caseOf(NoMatchDto)
          .toFinish(NoMatchWorkflowFinish),
      ),
  ],
  maxSteps: 3,
  providers: [ShortlistStoreService],
})
export class ShortlistWorkflow {}
```

```ts file=src/shortlist/config/budget.config.ts
// config/budget.config.ts — every budget of the application: one per scope at least
import { Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";

@Budget({ name: "application-daily-budget", scope: BudgetScope.Application, period: BudgetPeriod.Day })
export class ApplicationDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(5);
  }
}

@Budget({ name: "tenant-daily-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
export class TenantDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

@Budget({ name: "execution-budget", scope: BudgetScope.Execution })
export class ExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.05);
  }
}
```

```ts file=src/shortlist/shortlist.application.ts
// shortlist.application.ts — what createApp, testWith and the CLI take
import { Application, EmptyEnvironment } from "@agboss/core";
import { ApplicationDailyBudget, ExecutionBudget, TenantDailyBudget } from "./config/budget.config.js";
import { ShortlistWorkflow } from "./shortlist.workflow.js";

@Application({
  name: "shortlist-application",
  version: "1.0.0",
  environment: EmptyEnvironment, // no settings; see reference 03 for an environment contract
  workflows: [ShortlistWorkflow],
  budgets: [ApplicationDailyBudget, TenantDailyBudget, ExecutionBudget],
})
export class ShortlistApplication {}
```

What this shows:

- **The scope, not arguments.** `SaveShortlistAction` and `ShortlistSizeRouter` read `shortlist`
  because `.returns(oneOf(ShortlistDto, NoMatchDto))` and `caseOf(ShortlistDto)` put a `ShortlistDto`
  on that path; a field no path brings is `[input.missing-on-path]`. Each input field arrives as
  `{ producer, value }` — `input.shortlist.value.jobs`.
- **A marker class for an outcome.** `NoMatchDto` has no fields: the class is the answer, and the
  `switch` routes on it. `oneOf` outputs become one answer tool per class for the model.
- **Pass-through finishes.** A finish without a `finish()` method hands back the value of its
  `output` class from the path (`TooManyJobsWorkflowFinish` returns the `ShortlistDto`).
- **Names end with their kind — the class too.** Every `name` is kebab-case with its kind last
  (`shortlist-size-router`, `tenant-daily-budget`), the class the same name in PascalCase
  (`ShortlistSizeRouter`, `TenantDailyBudget`). `[name.kind-suffix]` checks the `name` of every
  component and, for the `@Application` and each `@Budget`, the class name as well: an application
  class `ShortlistApp` or a budget class `DailyLimit` fails assembly
  (`class DailyLimit — name it DailyLimitBudget`).

## DTOs: what the model sees and what the code gets

- One field decorator per field (`[dto.undecorated-field]` otherwise): `@Text`, `@Integer`,
  `@Decimal`, `@Flag`, `@OneOf({ values: ["a", "b"] })`, `@ListOf(ItemDto | Text, { minItems })`,
  `@Nested(OtherDto)`, formats `@Email`, `@Url`, `@Uuid`, `@Date`, `@DateTime`, `@PhoneNumber`, ….
  Options: `prompt` (the field's description in the JSON Schema the model reads), `optional: true`,
  `default`, limits (`minLength`, `maxLength`, `pattern`, `min`, `max`), `example`, `sensitive`
  (a PII action, reference 07).
- **Plain data**: no methods, no getters, no constructor logic (`[dto.not-plain-data]`). Values are
  object literals; the framework validates every value that crosses a boundary — a start's input,
  a tool's arguments and result, an agent's answer, an action's output, a resume's decision — and
  throws `DtoValidationError` (`dto`, `issues: [{ path, reason }]`) naming the field, never the value.
- **An agent's invalid answer is retried for you.** Its answer tool's arguments are validated against
  the DTO; the model reads what was wrong and answers again, up to 3 attempts, then
  `AgentAnswerInvalidError` (a `StepFailedError`, so an `.onError` can take it).
- **Narrow DTOs per step.** One class per result (`ShortlistDto`, `ShortlistSavedDto`), named by what
  it is, ending with `Dto`; DTO names are unique in the application (`[dto.duplicate-name]`).
- **Standard DTOs** (`@agboss/core/dto`): `WorkflowStartTextDto` (`text`, `author?`),
  `WorkflowFinishTextDto` (`text`), `PlainTextDto` (`text` — a text agent's reply to a judge),
  `AttachmentDto`, `MoneyDto`, `AddressDto`, `DateRangeDto`, `ToolCallApprovalDecisionDto`, ….

Anti-pattern — the "God DTO":

<!-- snippet-context
import { Flag, Integer, Text } from "@agboss/core/dto";
-->

```ts
// ✗ one class for every outcome: optional fields nobody can rely on, a flag the code must re-check
export class ScreeningResultDto {
  @Flag({ prompt: "whether anything matched" })
  found!: boolean;

  @Text({ prompt: "the shortlist id, when saved", optional: true })
  shortlistId?: string;

  @Integer({ prompt: "the job count, when found", optional: true })
  count?: number;

  @Text({ prompt: "why nothing matched, when nothing did", optional: true })
  noMatchReason?: string;
}
// ✓ instead: ShortlistDto | NoMatchDto as `oneOf(…)`, ShortlistSavedDto after the save
```

A God DTO hides the branches from the flow (no `switch`, no `[flow.switch-not-exhaustive]`),
forces `if (x.found)` checks in every reader, and makes `about` / outdating (reference 02) useless.

## Files, images and large blobs

- **What a chat agent reads is text**: its input message renders each input field as JSON. Pass a
  file as a reference — an `AttachmentDto` with `url` (or a storage key in your own DTO) — and let a
  tool or an action fetch, extract or summarise it. Never put base64 content of a large file into a
  DTO on the path: every value in the scope is kept in the checkpoint (`BaseCheckpointSaver`), on
  every step, for the whole thread.
- A tool result a model reads is bounded by `maxResultSize` (default `kilobytes(128)`; longer is cut
  with a `[result truncated: …]` marker) — extract the part the model needs inside the tool.
- **Images for a decision**: a judge, guardrail or reply interpreter on a decision model can read an
  image as `Decision.image("data:image/png;base64,…", ImageDetail.Low)` in its `state` — png, jpeg or
  webp data URLs only.

<!-- snippet-context
import { Injectable, Tool, type ToolHandler } from "@agboss/core";
import { Text } from "@agboss/core/dto";
@Injectable()
export class DocumentStoreService {
  textOf(url: string, signal: AbortSignal): Promise<string> {
    return Promise.resolve(`${url}:${String(signal.aborted)}`);
  }
}
export class DocumentTextDto {
  @Text({ prompt: "the document's text, extracted" })
  text!: string;
}
// @snippet
-->

```ts
import { ExecutionContext } from "@agboss/core";
import { AttachmentDto } from "@agboss/core/dto";
import { kilobytes, seconds } from "@agboss/core/units";

@Tool({
  name: "read-document-tool",
  description: "Reads the text of an attached document by its link",
  input: AttachmentDto, // { name, mediaType, url } — the model passes the link, not the bytes
  output: DocumentTextDto,
  timeout: seconds(20),
  maxResultSize: kilobytes(64),
  deps: [ExecutionContext, DocumentStoreService],
})
export class ReadDocumentTool implements ToolHandler<AttachmentDto, DocumentTextDto> {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly documentStoreService: DocumentStoreService,
  ) {}

  async run({ url }: AttachmentDto): Promise<DocumentTextDto> {
    const text: string = await this.documentStoreService.textOf(
      url ?? "",
      this.executionContext.signal, // the call's: aborted at the timeout or on cancel
    );
    return { text };
  }
}
```

## Pitfalls

- `new ShortlistDto()` or `Object.assign(new X(), …)` in project code — values are object literals.
- Reading an input by position or as the bare value: it is `input.<field>.value`.
- A model router directly after an agent that already knows the outcome: an extra call, an extra
  failure mode — return `oneOf(…)` and `switch`.
- One workflow per "screen" of a UI: a workflow is a process; a conversation continues it with the
  same `threadId` (reference 03).
- Putting I/O in an agent's prompt ("call the API with …"): I/O is a tool, an action or a service.
- `zod` schemas or JSON Schema objects in project code: the DTO class is the schema.
- Mixing non-service files into `services/`: `services/` holds **only** `*.service.ts`. Put custom
  `AGBossError` subclasses in `errors/<name>.error.ts`, direct database access in
  `repositories/<name>.repository.ts` using a typed ORM (such as Drizzle ORM), ORM table schemas in
  `schemas/<name>.schema.ts`, and SQL DDL migrations in `sql/<name>.sql` (never inline SQL strings or
  string-interpolated queries in `.ts`).
