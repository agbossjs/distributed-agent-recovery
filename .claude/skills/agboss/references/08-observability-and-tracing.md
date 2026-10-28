# 08 — Observability and tracing

Read this when you read what an execution did (`result`, `result.record`), write an observer (metrics,
audit, your own tracer), replace the framework's log, or send traces to Langfuse or another backend.

| You want                                          | Use                                                                                           |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| what one execution did, in code or a test         | the `ExecutionOutput` of `app.execute` / `app.resume`; `{ record: true }` for the full record |
| metrics, audit, alerts, your own tracer           | an observer class in `@Application({ observers })`                                            |
| a trace of every step, model call and tool call   | Langfuse: set `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`               |
| the framework's own problems (recovery, failures) | its log through the application's `Logger`                                                    |
| the declarative spec the records join on          | `npx agboss describe --json` (`configHash`, each node's `promptHash` / `schemaHash`)          |

## What an execution returns

`ExecutionOutput` — every call of `app.execute` / `app.resume` returns it:

| Field                                 | What                                                                                                                                |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `status`                              | `ExecutionStatus.Finished` or `Paused`                                                                                              |
| `output`, `finish`                    | the finish's DTO and its `ComponentRecord` (`{ name, kind, promptHash, schemaHash }`)                                               |
| `path`                                | the visited nodes in order (`critic-agent#2` for a copy)                                                                            |
| `spend`                               | `CostReport`: `totalUsd`, `calls`, `byCategory`, `byModel`, `byCaller`, `trace` (every call in order)                               |
| `executionId`, `threadId`, `tenantId` | the keys                                                                                                                            |
| `pending`                             | every waiting pause (`PendingPause`), when paused                                                                                   |
| `launches`                            | one `LaunchRecord` per joined launch: `items`, `taken`, each branch's `BranchStatus` and, under a quorum, `BranchVerdict`           |
| `children`                            | the child executions' records (`ChildExecutionRecord`: `ChildExecutionStatus`, start, finish, path, spend, own children and pauses) |
| `handledErrors`                       | the failures a side path took — `{ at, by, error }`                                                                                 |
| `compensations`                       | every undo that ran — `CompensationRecord` (reference 02, section 8)                                                                |
| `compacted`                           | what each compaction did before the execution                                                                                       |
| `traceUrl`                            | the Langfuse session, when tracing is on and `LANGFUSE_PROJECT_ID` is set                                                           |
| `record`                              | with `{ record: true }`: the `ExecutionRecord` below                                                                                |

`ExecutionRecord` — `path`, `scope` (every current value of the path scope: `ScopeValueRecord` with
`valueId`, `slot`, `producer`, `builtFrom`, `about`, the value), `outdatedValues`
(`OutdatedValueRecord`, each with its `OutdatedReason`), `lastError` (an `ErrorRecord`: `name`,
`code`, `message`, `lineage`, `cause`), `spend`, `children`, `compensations` and `pauses` — who
answered each resolved pause of the tree (`PauseAnswerRecord`: `pauseId`, `role`, `answeredBy`,
`responder`, `resolution: PauseResolution.Decided | Replied | Withdrawn | Cancelled`, `askedAt`,
`resolvedAt`, the masked `decision`). The record, events, logs and traces are masked by the
application's and the workflow's PII policies.

## The worked example: metrics, audit and a log

```ts file=src/desk/desk.workflow.ts
import { Action, Agent, ExecutionContext, Workflow, WorkflowFinish, WorkflowStart, start } from "@agboss/core";
import type { ActionHandler, InputOf, OutputOf } from "@agboss/core";
import { Text, WorkflowStartTextDto } from "@agboss/core/dto";

export class DeskAnswerDto {
  @Text({ prompt: "the answer to send" })
  text!: string;
}

export class DeskTicketDto {
  @Text({ prompt: "the ticket's id" })
  ticketId!: string;
}

@WorkflowStart({ name: "desk-workflow-start", description: "A customer's message", input: WorkflowStartTextDto })
export class DeskWorkflowStart {}

@Agent({
  name: "desk-agent",
  description: "Answers the customer",
  prompt: "Answer the customer in two sentences.",
  model: "moonshotai/kimi-k2.6",
  input: { message: WorkflowStartTextDto },
  output: DeskAnswerDto,
})
export class DeskAgent {}

@Action({
  name: "open-ticket-action",
  description: "Opens a ticket for the answer",
  input: { answer: DeskAnswerDto },
  output: DeskTicketDto,
  deps: [ExecutionContext],
})
export class OpenTicketAction implements ActionHandler<OpenTicketAction> {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute(input: InputOf<OpenTicketAction>): Promise<OutputOf<OpenTicketAction>> {
    const key: string = this.executionContext.step.idempotencyKey;
    return Promise.resolve({ ticketId: `${String(input.answer.value.text.length)}:${key}` });
  }
}

@WorkflowFinish({ name: "desk-workflow-finish", description: "The ticket", output: DeskTicketDto })
export class DeskWorkflowFinish {}

@Workflow({
  name: "desk-workflow",
  version: "1.0.0",
  flow: [
    start(DeskWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(DeskAgent)
      .returns(DeskAnswerDto)
      .toAction(OpenTicketAction)
      .returns(DeskTicketDto)
      .toFinish(DeskWorkflowFinish),
  ],
  maxSteps: 2,
})
export class DeskWorkflow {}
```

```ts file=src/desk/services/metrics.service.ts
// services/metrics.service.ts — your metrics client (Prometheus, StatsD, …) behind a service
import { Injectable } from "@agboss/core";

@Injectable()
export class MetricsService {
  increment(metric: string, labels: Readonly<Record<string, string>>): void {
    void metric;
    void labels;
  }

  observe(metric: string, value: number, labels: Readonly<Record<string, string>>): void {
    void metric;
    void value;
    void labels;
  }
}
```

```ts file=src/desk/observers/execution-metrics.observer.ts
// observers/execution-metrics.observer.ts — one instance, every execution of the application
import {
  Injectable,
  ResumeReason,
  nameOf,
  type ExecutionEndEvent,
  type ExecutionErrorEvent,
  type ExecutionRejectedEvent,
  type ExecutionResumeEvent,
  type ModelEndEvent,
  type OnExecutionEnd,
  type OnExecutionError,
  type OnExecutionRejected,
  type OnExecutionResume,
  type OnModelEnd,
} from "@agboss/core";
import { DeskAgent } from "../desk.workflow.js";
import { MetricsService } from "../services/metrics.service.js";

@Injectable({ deps: [MetricsService] })
export class ExecutionMetricsObserver
  implements OnExecutionEnd, OnExecutionError, OnExecutionRejected, OnExecutionResume, OnModelEnd
{
  constructor(private readonly metricsService: MetricsService) {}

  onExecutionEnd(event: ExecutionEndEvent): void {
    const labels = { workflow: event.workflow.name, finish: event.finish.name, tenant: event.tenantId };
    this.metricsService.observe("execution_spend_usd", event.spend.totalUsd, labels);
  }

  onExecutionError(event: ExecutionErrorEvent): void {
    const code: string = event.error instanceof Error ? event.error.name : "unknown";
    this.metricsService.increment("execution_failed", { workflow: event.workflow.name, code });
    // the undo actions that ran for it, side paths' first, then the automatic ones
    for (const undo of event.compensations)
      this.metricsService.increment("execution_undo", { action: undo.compensator.name, status: undo.status });
  }

  onExecutionRejected(event: ExecutionRejectedEvent): void {
    // refused before an execution started: no executionId, a message without input values
    this.metricsService.increment("execution_rejected", { operation: event.operation, code: event.code });
  }

  onExecutionResume(event: ExecutionResumeEvent): void {
    if (event.reason === ResumeReason.Recovered)
      this.metricsService.increment("execution_recovered", { workflow: event.workflow.name });
  }

  onModelEnd(event: ModelEndEvent): void {
    if (event.step.component.name !== nameOf(DeskAgent)) return; // filter by name, never by nodeId
    this.metricsService.observe("model_tokens", event.usage.totalTokens, { model: event.model });
  }
}
```

```ts file=src/desk/observers/compensation-audit.observer.ts
// observers/compensation-audit.observer.ts — the automatic undo, around the undo action's own events
import {
  CompensationStatus,
  Injectable,
  type CompensationEndEvent,
  type CompensationStartEvent,
  type OnCompensationEnd,
  type OnCompensationStart,
} from "@agboss/core";

@Injectable()
export class CompensationAuditObserver implements OnCompensationStart, OnCompensationEnd {
  onCompensationStart(event: CompensationStartEvent): void {
    // event.step is the undo action's step (its key: the undone step's key + ":compensation")
    console.info(`undoing ${event.compensated.component.name} (${event.reason})`, event.step.idempotencyKey);
  }

  onCompensationEnd(event: CompensationEndEvent): void {
    if (event.status === CompensationStatus.Failed)
      console.warn(`${event.compensated.component.name} not undone: ${event.error?.message ?? ""}`);
  }
}
```

```ts file=src/desk/infrastructure/json.logger.ts
// infrastructure/json.logger.ts — the framework's own log, one JSON line per entry
import { Injectable, LogLevel, Logger, type LogEntry } from "@agboss/core";

@Injectable()
export class JsonLogger extends Logger {
  write(entry: LogEntry): void {
    const line: string = JSON.stringify({
      time: entry.time.toISOString(),
      level: entry.level,
      code: entry.code, // stable: execution.recovered, observer.failed, app.step-still-running, …
      message: entry.message,
      executionId: entry.executionId,
      tenantId: entry.tenantId,
    });
    if (entry.level === LogLevel.Error) process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }
}
```

```ts file=src/desk/config/budget.config.ts
import { Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";

@Budget({ name: "application-daily-budget", scope: BudgetScope.Application, period: BudgetPeriod.Day })
export class ApplicationDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(10);
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

```ts file=src/desk/desk.application.ts
import { Application, EmptyEnvironment } from "@agboss/core";
import { ApplicationDailyBudget, ExecutionBudget, TenantDailyBudget } from "./config/budget.config.js";
import { DeskWorkflow } from "./desk.workflow.js";
import { JsonLogger } from "./infrastructure/json.logger.js";
import { CompensationAuditObserver } from "./observers/compensation-audit.observer.js";
import { ExecutionMetricsObserver } from "./observers/execution-metrics.observer.js";
import { MetricsService } from "./services/metrics.service.js";

@Application({
  name: "desk-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [DeskWorkflow],
  budgets: [ApplicationDailyBudget, TenantDailyBudget, ExecutionBudget],
  observers: [ExecutionMetricsObserver, CompensationAuditObserver], // the only place observers go
  providers: [JsonLogger, MetricsService], // a Logger is infrastructure: listed in the application
})
export class DeskApplication {}
```

## Observers

- **Registered, not discovered**: only classes in `@Application({ observers })` are called — never in
  `@Workflow`. One instance each (created by the container, `@Injectable` with `deps`), called for
  every execution of the application, child executions included.
- **One interface per hook**, each with a typed, plain-data event (no class, no internal state):

| Hooks                                                                                                                              | Event                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `OnExecutionStart`                                                                                                                 | once per execution — a resume does not start it again                                                    |
| `OnExecutionPause` / `OnExecutionResume`                                                                                           | `pending` / `reason: ResumeReason.Answered \| Recovered`, `decision`, `answeredBy`                       |
| `OnExecutionEnd`                                                                                                                   | once, at a finish: `finish`, `spend`                                                                     |
| `OnExecutionError`                                                                                                                 | a failure (a cancelled paused one: `ExecutionCancelledError`): `error`, `compensations`                  |
| `OnExecutionRejected`                                                                                                              | refused before an execution: `operation: ExecutionOperation`, `threadId?`, `tenantId`, `code`, `message` |
| `OnAgentStart` / `OnAgentEnd`, `OnRouterStart` / `OnRouterEnd`, `OnActionStart` / `OnActionEnd`                                    | a node's visit                                                                                           |
| `OnToolStart` / `OnToolEnd`                                                                                                        | `toolName`, `agentName`, `arguments` / `update`, `isResultTruncated`                                     |
| `OnModelStart` / `OnModelEnd`                                                                                                      | an agent's model call: `model`, `callerName`, `usage`, `calculatedCost`                                  |
| `OnRagStart` / `OnRagEnd`, `OnGuardrailStart` / `OnGuardrailEnd`, `OnChannelStart` / `OnChannelEnd`, `OnJudgeStart` / `OnJudgeEnd` | as named                                                                                                 |
| `OnValuesOutdated`                                                                                                                 | one per outdating cascade: `trigger`, `outdated` (no DTO values)                                         |
| `OnLaunchItemsTruncated`                                                                                                           | a per-item launch dropped items: `launch`, `items`, `maxItems`                                           |
| `OnQuorumDecided`                                                                                                                  | once per quorum: `launch`, `isReached`, `branches`, `group`                                              |
| `OnCompensationStart` / `OnCompensationEnd`                                                                                        | an automatic undo: `compensated`, `reason` / `status`, `error`                                           |

- **Every event** (`ExecutionEvent`) has `executionId`, `parentExecutionId` (a child's parent),
  `rootExecutionId`, `threadId`, `tenantId` and `workflow` (`WorkflowRecord`: `name`, `version`,
  `startedVersion`, `configHash`). A **node event** (`NodeEvent`) adds `step` (`StepRecord`:
  `component`, `nodeId`, `visitNumber`, `copyNumber`, `itemIndex`, `idempotencyKey`, `callId`,
  `toolLoopIteration`, `validationAttempts`, `compensates`).
- **Filter by name** with `nameOf(Class)`: `event.workflow.name === nameOf(DeskWorkflow)`,
  `event.step.component.name === nameOf(DeskAgent)`.
- An observer with no hook or a misspelled one fails assembly (`[observer.no-hooks]`,
  `[observer.unknown-hook]` — the names are `OBSERVER_HOOKS`); one that throws is a warning in the log
  (`observer.failed`) and never fails the execution.
- Not model calls of an agent (no `onModelStart` / `onModelEnd`): a model arbiter's, a reply
  interpreter's, a guardrail's, a compaction's — their cost is in `spend` under `arbiter:<name>`,
  `reply-interpreter:<name>`, `guardrail:<name>`, `compaction:<name>`.

## Join keys

Every event, record and trace joins the declarative snapshot of `npx agboss describe --json`:
`workflow.configHash` (the workflow's fingerprint — config, flow and every text its models read; also
in `executionContext.workflow`), `step.component.kind` / `promptHash` / `schemaHash` (one entry of
`nodes[]`), `nodeId` + `copyNumber` + `itemIndex` (a branch in `result.launches`). Store them with
your metrics to tell which version of a prompt produced what.

## The framework's log

The framework writes through the application's `Logger` — infrastructure like `Clock`: the built-in
`ConsoleLogger` (one line per entry on stderr) unless `@Application({ providers })` lists a class
that `extends Logger` (`write(entry: LogEntry)`; `LogEntry`: `level: LogLevel`, `code`, `message`,
`time`, `executionId?`, `tenantId?`). In tests it is silent unless listed.

- **At start, once**: what started and the worst case of one call of each start — only what the
  decorators say (no `maxSpend()`), then the assembly warnings (`[application.in-memory-cost-ledger]`,
  `[application.in-memory-pauses]`, `[application.pii-instance-key]`; also in `app.warnings`).
- **While running, only problems**: `LogLevel.Warn` — `execution.recovered`, `recovery.incompatible`,
  `observer.failed`, `compensation.step-still-running`, `channel.withdraw-failed`; `LogLevel.Error` —
  `recovery.failed`, `app.close-failed`, `compensation.late-undo-failed`. One execution's details are
  its trace, a tenant's spend the cost ledger.

## Tracing

- **Langfuse** is built in: set `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and `LANGFUSE_BASE_URL`
  in the process environment (optionally `LANGFUSE_PROJECT_ID` for `result.traceUrl` links). Without
  all three nothing is traced and nothing changes. One trace per execution pass, named after the
  workflow, its session the thread; one span per node, named by its kind and name, the agent's
  model requests and tool calls inside; a child workflow is a nested run under its parent's step;
  every trace is tagged `tenant:<id>` and masked by the PII policies. Decision-model calls (Jev) are
  not LangChain calls: their cost is in `spend`, not in the trace.
- **OpenTelemetry**: tracing uses its own isolated tracer provider — the framework never registers a
  global one and is flushed when the app closes. To send spans to another backend, write an observer
  over your own tracer (start a span in `onAgentStart`, end it in `onAgentEnd`, keyed by
  `step.idempotencyKey`), registered like `ExecutionMetricsObserver` above.

## Reading it in a test

```ts file=tests/desk/record.test.ts
import { expect } from "vitest";
import { ExecutionStatus } from "@agboss/core";
import { replyWith, testWith } from "@agboss/core/testing";
import { DeskApplication } from "../../src/desk/desk.application.js";
import {
  DeskAgent,
  DeskAnswerDto,
  DeskWorkflowFinish,
  DeskWorkflowStart,
  OpenTicketAction,
} from "../../src/desk/desk.workflow.js";

const test = testWith(DeskApplication);

test("the record shows the path, the scope and the spend", async ({ app, mockLlm }) => {
  mockLlm(DeskAgent).thenReturn(replyWith(DeskAnswerDto, { text: "We are on it." }));

  const result = await app.execute(DeskWorkflowStart, { text: "my order is late" }, { record: true });

  expect(result.status).toBe(ExecutionStatus.Finished);
  expect(result).toFollowPath([DeskWorkflowStart, DeskAgent, OpenTicketAction, DeskWorkflowFinish]);
  expect(result.record?.scope.map((value) => value.slot)).toContain("DeskAnswerDto");
  expect(result.spend.calls).toBe(1);
  expect(result.compensations).toEqual([]);
});
```

## Pitfalls

- An observer in `@Workflow` or found by a decorator scan — list it in `@Application({ observers })`.
- Parsing `nodeId` (`critic-agent#2`) to find a component — use `step.component.name`, `copyNumber`,
  `itemIndex`.
- Doing slow I/O in a hook — it runs on the execution's path; buffer it in a service.
- Logging DTO values from `scope`: they are the real values; events, logs and traces are masked, the
  scope is not.
- Expecting traces from `testWith`: tests run offline, the `LANGFUSE_*` variables are ignored there.
