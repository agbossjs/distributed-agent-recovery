# 03 — Components, DI and lifecycle

Read this when you write a component class, a service, a provider or a lifecycle hook, read the
execution or the environment, or run the application (`createApp`, `app.execute`, `app.cancel`).
Which primitive to pick: `01-composition-and-architecture.md`; the flow: `02-flow-dsl-all-combinations.md`.

## The decorators

| Decorator (file)                                                                                | Its contract                                                | Key options                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@Application` (`<app>.application.ts`)                                                         | —                                                           | `name`, `version`, `environment` (required), `workflows`, `budgets`, `providers` (infrastructure), `observers`, `defaults`, `guardrails`, `toolInterceptors`, `piiPolicies`, `healthChecks`, `tenantContext`, `executionContext`, `pseudonymKey`, `shutdownTimeout`, `pauseRecordRetention`, `compensationTimeout`, `maxConcurrentSteps`, `uncompactedTurns`, `compaction` |
| `@Workflow` (`workflows/<workflow-name>/<workflow-name>.workflow.ts`)                           | —                                                           | `name` (`-workflow`), `version`, `flow`, `providers` (services), `defaults`, `maxSteps`, `maxDepth`, `maxConcurrentExecutions`, `mcp`, `guardrails`, `toolInterceptors`, `piiPolicies`, `uncompactedTurns`, `compaction`, `promptVariables`                                                                                                                                |
| `@WorkflowStart` / `@WorkflowFinish` (`workflows/<workflow-name>/*.workflow-{start,finish}.ts`) | a finish may have `finish(input)` (`FinishHandler<Self>`)   | `name`, `description`, `input` (start) / `output` (finish), `deps`                                                                                                                                                                                                                                                                                                         |
| `@Agent` (`agents/<name>/<name>.agent.ts` + `<name>.prompt.md`)                                 | none: the framework runs its loop                           | `model`, `prompt` / `promptUrls` (+ `promptVariables`), `input`, `output`, `tools`, `maxToolCalls`, `maxVisits`, `maxTokens`, `reasoning`, `temperature`, `cache`, `rag`, `judges` + `maxRetries`, `uncompactedTurns`, `compaction`, `memoryStrategy`, `guardrails`, `toolInterceptors`, `piiPolicies`                                                                     |
| `@Tool` (`tools/<name>.tool.ts`, DTOs in `dto/<name>.dto.ts`)                                   | `ToolHandler<In, Out>`: `run(input)`                        | `input`, `output`, `timeout: seconds(…)` (default 30 s), `maxResultSize: kilobytes(…)`, `channel`, `toolInterceptors`, `deps`                                                                                                                                                                                                                                              |
| `@Action` (`actions/<name>.action.ts`)                                                          | `ActionHandler<Self>`: `execute(input)`                     | `input` (fields from the scope), `output`, `compensateWith`, `committedBy`, `deps`                                                                                                                                                                                                                                                                                         |
| `@Router` (`routers/<name>/<name>.router.ts` (+ `<name>.prompt.md`))                            | code: `RouterHandler<Self>`: `route(input)`                 | `decidedBy`, `input`, `routes`, `maxVisits`; model: `model`, `prompt`; code: `deps`                                                                                                                                                                                                                                                                                        |
| `@Arbiter` (`arbiters/<name>/<name>.arbiter.ts` (+ `<name>.prompt.md`))                         | code: one `@OnAnswer(Agent)` method per agent of the launch | `decidedBy`; model: `model`, `prompt`, `criteria`; code: `deps`                                                                                                                                                                                                                                                                                                            |
| `@Judge` (`judges/<name>/<name>.judge.ts` (+ `<name>.prompt.md`))                               | `JudgeHandler<TReply>`: `judge(input)`                      | `name`, `model`, `reply` (the answer's shape), `deps`                                                                                                                                                                                                                                                                                                                      |
| `@Rag` (`rag/<name>.rag.ts`, `@agboss/core/rag`)                                                | `RagConnector`: `retrieve(query, { topK, signal })`         | `name` (`-rag`), `description`, `topK`, `deps`                                                                                                                                                                                                                                                                                                                             |
| `@Compaction` (`compactions/<name>/<name>.compaction.ts` (+ `<name>.prompt.md`))                | none; `Custom`: `CompactionHandler`: `compact(input)`       | `strategy`, `model`, `prompt`, `turnsBetweenCompactions`, `summaryQueueLength`, `summaryMaxTokens`; `Custom`: `turnsBetweenCompactions`, `deps`                                                                                                                                                                                                                            |
| `@InputGuardrail` / `@OutputGuardrail` (`guardrails/<name>/<name>.guardrail.ts`)                | code: `InputGuardrailHandler` / `OutputGuardrailHandler`    | `name`, `description`, `decidedBy`; model: `model`, `prompt`, `refusalMessage`; code: `deps`                                                                                                                                                                                                                                                                               |
| `@ReplyInterpreter` (`reply-interpreters/<name>/<name>.reply-interpreter.ts`)                   | —                                                           | `name` (`-reply-interpreter`), `model`, `prompt` / `promptUrls`, `decision`                                                                                                                                                                                                                                                                                                |
| `@Budget` (`budgets/<name>.budget.ts`)                                                          | `BudgetHandler`: `maxSpend()`                               | `name` (`-budget`), `scope`, `period`, `deps`                                                                                                                                                                                                                                                                                                                              |
| `@HealthCheck` (`health-checks/<name>.health-check.ts`)                                         | `HealthCheckHandler`: `check()`                             | `name` (`-health-check`), `timeout`, `deps`                                                                                                                                                                                                                                                                                                                                |
| `@ToolInterceptor` (`interceptors/<name>.interceptor.ts`)                                       | `BeforeToolCall` and / or `AfterToolCall`                   | `name` (`-tool-interceptor`), `description`, `deps`                                                                                                                                                                                                                                                                                                                        |
| `@Injectable` service (`services/<name>.service.ts`)                                            | domain / API / filesystem orchestration (no direct DB/SQL)  | `deps` (`services/` holds **only** `*.service.ts`)                                                                                                                                                                                                                                                                                                                         |
| `@Injectable` repository (`repositories/<name>.repository.ts`)                                  | direct DB access via typed ORM (e.g. Drizzle) or store impl | `deps` (uses `schemas/<name>.schema.ts` & `sql/<name>.sql`, zero string-interpolated SQL)                                                                                                                                                                                                                                                                                  |
| `@Injectable` observer (`observers/<name>.observer.ts`)                                         | `ExecutionObserver` hooks                                   | `deps`                                                                                                                                                                                                                                                                                                                                                                     |
| `AGBossError` subclass (`errors/<name>.error.ts`)                                               | `static override readonly code = "…"`                       | caught in flows via `.onError(MyError, …)`                                                                                                                                                                                                                                                                                                                                 |

`npx agboss generate` (alias `g`) writes workflows (`w`), agents (`a`), routers (`r`), arbiters (`ar`),
tools (`t`), MCP servers (`m`), knowledge bases (`rag`), OpenAPI clients (`oa`) and eval cases (`ec`);
write the others by hand in the same grammar (`judges/<name>/<name>.judge.ts`,
`health-checks/<name>.health-check.ts`, `compactions/<name>/<name>.compaction.ts`).

Every component: `name` in kebab-case ending with its kind (`[name.kind-suffix]`), unique in the
application (`[graph.duplicate-node-name]`); `description` where the type asks for it; `deps` that
match the constructor exactly, in order — a wrong list does not compile. `implements` documents the
contract; the check is on the decorator line.

## A worked example: a support desk's components

One class per file in a project; here a few small classes share a file for brevity.

```ts file=src/desk/environments/app.environment.ts
// environments/app.environment.ts — the contract: declared fields only, never a value
import type { Secret } from "@agboss/core";

export class AppEnvironment {
  openRouterApiKey?: Secret; // read by the built-in model providers; tests leave it out
  crmUrl!: string;
  crmApiKey?: Secret; // prints as ***; only .reveal() gives the value; optional: tests leave it out
  crmRetries!: number;
}
```

```ts file=src/desk/environments/dev.environment.ts
// environments/dev.environment.ts — one file per environment; `--env dev` (the default) picks it
import { env, secret } from "@agboss/core";
import type { AppEnvironment } from "./app.environment.js";

export const environment: AppEnvironment = {
  openRouterApiKey: secret("OPENROUTER_API_KEY"),
  crmUrl: env("CRM_URL", { default: "http://localhost:4000" }),
  crmApiKey: secret("CRM_API_KEY"), // no default: a literal secret does not compile
  crmRetries: env.integer("CRM_RETRIES", { default: 2 }), // also env.flag, env.optional, env.integer.optional
};
```

```ts file=src/desk/environments/test.environment.ts
// environments/test.environment.ts — what testWith runs on; without it tests fail to start.
// A secret() whose variable is unset fails the start, so a test environment leaves secrets out.
import type { AppEnvironment } from "./app.environment.js";

export const environment: AppEnvironment = { crmUrl: "http://crm.test", crmRetries: 0 };
```

```ts file=src/desk/dtos/desk.dto.ts
import { Flag, Text } from "@agboss/core/dto";

export class CustomerQueryDto {
  @Text({ prompt: "the customer's email" })
  email!: string;
}

export class CustomerDto {
  @Text({ prompt: "the customer's plan" })
  plan!: string;

  @Flag({ prompt: "whether the customer has an open ticket" })
  hasOpenTicket!: boolean;
}

export class DeskAnswerDto {
  @Text({ prompt: "the answer to send, citing [source]s" })
  text!: string;
}
```

```ts file=src/desk/services/crm-client.service.ts
// services/crm-client.service.ts — a service with lifecycle hooks; config from ApplicationContext
import { ApplicationContext, Injectable, type OnDestroy, type OnStart } from "@agboss/core";

@Injectable({ deps: [ApplicationContext] })
export class CrmClientService implements OnStart, OnDestroy {
  constructor(private readonly applicationContext: ApplicationContext) {}

  async onStart(): Promise<void> {
    await this.ping(); // a failure stops the start, naming this class and the hook
  }

  onDestroy(): Promise<void> {
    return Promise.resolve(); // close pools here: after every execution ended, dependants first
  }

  ping(): Promise<boolean> {
    return Promise.resolve(this.applicationContext.environment.crmUrl.length > 0);
  }

  lookUp(email: string, signal: AbortSignal): Promise<{ plan: string; hasOpenTicket: boolean }> {
    const { crmUrl, crmApiKey } = this.applicationContext.environment; // typed by AppEnvironment
    signal.throwIfAborted();
    const isAuthorised: boolean = crmApiKey !== undefined && crmApiKey.reveal() !== "";
    return Promise.resolve({ plan: `${crmUrl}/${email}`, hasOpenTicket: !isAuthorised });
  }
}
```

```ts file=src/desk/tools/customer-lookup.tool.ts
// tools/customer-lookup.tool.ts — the execution and the spend come through the constructor
import { ExecutionContext, SpendRecorder, Tool, type ToolHandler } from "@agboss/core";
import { kilobytes, seconds, usd } from "@agboss/core/units";
import { CustomerDto, CustomerQueryDto } from "../dtos/desk.dto.js";
import { CrmClientService } from "../services/crm-client.service.js";

@Tool({
  name: "customer-lookup-tool",
  description: "Looks a customer up in the CRM by email",
  input: CustomerQueryDto,
  output: CustomerDto,
  timeout: seconds(5), // there is no timeoutMs
  maxResultSize: kilobytes(16),
  deps: [ExecutionContext, SpendRecorder, CrmClientService],
})
export class CustomerLookupTool implements ToolHandler<CustomerQueryDto, CustomerDto> {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly spendRecorder: SpendRecorder,
    private readonly crmClientService: CrmClientService,
  ) {}

  async run({ email }: CustomerQueryDto): Promise<CustomerDto> {
    const customer = await this.crmClientService.lookUp(email, this.executionContext.signal);
    this.spendRecorder.record({ service: "crm-api", cost: usd(0.001) }); // counted in the budgets
    return customer;
  }
}
```

```ts file=src/desk/rag/help-center.rag.ts
// rag/help-center.rag.ts — a knowledge base: any class implementing RagConnector
import { Rag, type RagConnector, type RagRetrieval } from "@agboss/core/rag";

@Rag({ name: "help-center-rag", description: "Help-center articles", topK: 3 })
export class HelpCenterRag implements RagConnector {
  retrieve(query: string, options: { readonly topK: number }): Promise<RagRetrieval> {
    const results = [{ text: `Refunds take 5 days (${query}).`, source: "help/refunds.md" }];
    return Promise.resolve({ results: results.slice(0, options.topK) });
  }
}
```

```ts file=src/desk/compactions/conversation.compaction.ts
// compactions/conversation.compaction.ts — what happens to turns older than the window
import { Compaction, CompactionStrategy } from "@agboss/core";

@Compaction({
  name: "conversation-compaction",
  description: "Summarises old turns of the conversation",
  prompt: "Summarise the turns under `Turns to compact`: what was asked, decided and is still open.",
  model: "moonshotai/kimi-k2.6",
  strategy: CompactionStrategy.SummaryQueue,
  turnsBetweenCompactions: 5,
  summaryQueueLength: 10,
  summaryMaxTokens: 400,
})
export class ConversationCompaction {}
```

A custom compaction (`CompactionStrategy.Custom`) writes the summaries itself: its class implements
`CompactionHandler` (`compact(input)` — `previousSummaries`, the readers' summaries now, and
`turnsToCompact`, each a `CompactionTurn`: `startName`, `input`, `finishName`, `output`, masked by
the PII policies) and returns the summaries readers see from now on; its services come through
`deps`. No `model`, `prompt`, `summaryQueueLength` or `summaryMaxTokens` (they do not compile;
`agboss check` reports them too); a class without `compact` is `[compaction.missing-handler]`. It
runs when a model's would — every `turnsBetweenCompactions` turns older than the window, before the
next turn reads its thread; a `compact()` that throws or gives no summary is `CompactionError`.

<!-- snippet-context
import { Injectable, type CompactionTurn } from "@agboss/core";
@Injectable()
export class KnowledgeGraphService {
  saveFactsAndSummarize(
    _threadId: string,
    turns: readonly CompactionTurn[],
    previous: readonly string[],
  ): Promise<readonly string[]> {
    return Promise.resolve([...previous, `${String(turns.length)} turns saved`]);
  }
}
// @snippet
-->

```ts file=src/desk/compactions/graph-memory.compaction.ts
// compactions/graph-memory.compaction.ts — the facts go to a knowledge graph, its summary to readers
import {
  Compaction,
  CompactionStrategy,
  ExecutionContext,
  type CompactionHandler,
  type CompactionInput,
} from "@agboss/core";

@Compaction({
  name: "graph-memory-compaction",
  description: "Keeps the facts of old turns in a knowledge graph",
  strategy: CompactionStrategy.Custom,
  turnsBetweenCompactions: 4,
  deps: [KnowledgeGraphService, ExecutionContext], // KnowledgeGraphService in the workflow's providers
})
export class GraphMemoryCompaction implements CompactionHandler {
  constructor(
    private readonly knowledgeGraphService: KnowledgeGraphService,
    private readonly executionContext: ExecutionContext,
  ) {}

  async compact(input: CompactionInput): Promise<readonly string[]> {
    return this.knowledgeGraphService.saveFactsAndSummarize(
      this.executionContext.threadId,
      input.turnsToCompact,
      input.previousSummaries,
    );
  }
}
```

```ts file=src/desk/judges/cites-source.judge.ts
// judges/cites-source.judge.ts — runs on the agent's answer, as its DTO
import { Decision, Judge, JudgeModel, JudgeVerdict, type JudgeHandler, type JudgeInput } from "@agboss/core";
import { DeskAnswerDto } from "../dtos/desk.dto.js";

@Judge({
  name: "cites-source-judge",
  model: "typesafe/jev-1.13", // a decision model: judgeModel.decide; a chat model: judgeModel.invoke
  reply: DeskAnswerDto, // the agent's output shape: a DTO, oneOf(A, B), listOf(X) or PlainTextDto
  deps: [JudgeModel],
})
export class CitesSourceJudge implements JudgeHandler<DeskAnswerDto> {
  constructor(private readonly judgeModel: JudgeModel) {}

  async judge({ reply, task }: JudgeInput<DeskAnswerDto>): Promise<JudgeVerdict> {
    const answers = await this.judgeModel.decide({
      state: { task, answer: reply.text },
      questions: { cites: Decision.noul("Does every claim of the answer cite a [source]?") },
    });
    return answers.cites.noul >= 0.5
      ? JudgeVerdict.passed({ metrics: { cites: answers.cites.noul } })
      : JudgeVerdict.failed({ reason: "cite a [source] for every claim" }); // read by the retry
  }
}
```

```ts file=src/desk/agents/support.agent.ts
// agents/support.agent.ts — every model setting in one place; the prompt in a file next to it
import { Agent, RagMode, TokenLimit } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { Reasoning, ReasoningEffort } from "@agboss/core/models";
import { ConversationCompaction } from "../compactions/conversation.compaction.js";
import { DeskAnswerDto } from "../dtos/desk.dto.js";
import { CitesSourceJudge } from "../judges/cites-source.judge.js";
import { HelpCenterRag } from "../rag/help-center.rag.js";
import { CustomerLookupTool } from "../tools/customer-lookup.tool.js";

@Agent({
  name: "support-agent",
  description: "Answers a customer from the CRM and the help center",
  promptUrls: ["./support.prompt.md"],
  model: "moonshotai/kimi-k2.6",
  input: { message: WorkflowStartTextDto },
  output: DeskAnswerDto,
  tools: [CustomerLookupTool],
  maxToolCalls: 4, // per visit; over it → the step fails
  rag: [{ use: HelpCenterRag, mode: RagMode.Tool }], // the tool search-help-center-rag-tool
  reasoning: Reasoning.on({ effort: ReasoningEffort.Low }), // not `thinking`
  maxTokens: TokenLimit.MODEL_MAX, // the only way to say "no output cap"
  judges: [CitesSourceJudge],
  maxRetries: 1, // a failed verdict's reason goes back to the agent once; then QualityGateError
  uncompactedTurns: 8, // the last 8 turns in full (TurnLimit.ALL: every turn)
  compaction: ConversationCompaction, // what is older is summarised
})
export class SupportAgent {}
```

```md file=src/desk/agents/support.prompt.md
You answer customers. Look the customer up with customer-lookup-tool, search the help center with
search-help-center-rag-tool, and cite every claim as [source].
```

```ts file=src/desk/health/crm.health-check.ts
// health/crm.health-check.ts — a readiness component of the project
import { HealthCheck, HealthCheckResult, type HealthCheckHandler } from "@agboss/core";
import { seconds } from "@agboss/core/units";
import { CrmClientService } from "../services/crm-client.service.js";

@HealthCheck({ name: "crm-health-check", timeout: seconds(2), deps: [CrmClientService] })
export class CrmHealthCheck implements HealthCheckHandler {
  constructor(private readonly crmClientService: CrmClientService) {}

  async check(): Promise<HealthCheckResult> {
    const isReachable: boolean = await this.crmClientService.ping();
    return isReachable
      ? HealthCheckResult.healthy()
      : HealthCheckResult.unhealthy({ reason: "CRM is unreachable" });
  }
}
```

```ts file=src/desk/infrastructure/prefixed-id-generator.ts
// infrastructure/prefixed-id-generator.ts — replaced by inheritance: list it in the application
import { IdGenerator, Injectable } from "@agboss/core";

@Injectable()
export class PrefixedIdGenerator extends IdGenerator {
  newThreadId(): string {
    return `thr_${crypto.randomUUID()}`;
  }

  newExecutionId(): string {
    return `exe_${crypto.randomUUID()}`;
  }
}
```

```ts file=src/desk/desk.workflow.ts
import { Workflow, start } from "@agboss/core";
import { WorkflowFinish, WorkflowStart } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { SupportAgent } from "./agents/support.agent.js";
import { DeskAnswerDto } from "./dtos/desk.dto.js";
import { CrmClientService } from "./services/crm-client.service.js";

@WorkflowStart({ name: "desk-workflow-start", description: "A customer's message", input: WorkflowStartTextDto })
export class DeskWorkflowStart {}

@WorkflowFinish({ name: "desk-workflow-finish", description: "The answer", output: DeskAnswerDto })
export class DeskWorkflowFinish {}

@Workflow({
  name: "desk-workflow",
  version: "1.0.0",
  flow: [
    start(DeskWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(SupportAgent)
      .returns(DeskAnswerDto)
      .toFinish(DeskWorkflowFinish),
  ],
  defaults: { tools: { maxToolCalls: 6 } }, // over the application's, under the agent's own
  maxSteps: 2,
  providers: [CrmClientService], // services only — never infrastructure
})
export class DeskWorkflow {}
```

```ts file=src/desk/desk.application.ts
import { Application, Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";
import { DeskWorkflow } from "./desk.workflow.js";
import { AppEnvironment } from "./environments/app.environment.js";
import { CrmHealthCheck } from "./health/crm.health-check.js";
import { PrefixedIdGenerator } from "./infrastructure/prefixed-id-generator.js";

@Budget({ name: "application-daily-budget", scope: BudgetScope.Application, period: BudgetPeriod.Day })
export class ApplicationDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(10);
  }
}

@Budget({ name: "tenant-daily-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
export class TenantDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(2);
  }
}

@Budget({ name: "execution-budget", scope: BudgetScope.Execution })
export class ExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.1);
  }
}

@Application({
  name: "desk-application",
  version: "1.0.0",
  environment: AppEnvironment,
  workflows: [DeskWorkflow],
  budgets: [ApplicationDailyBudget, TenantDailyBudget, ExecutionBudget],
  providers: [PrefixedIdGenerator], // infrastructure: stores, Clock, IdGenerator, Logger, channels
  healthChecks: [CrmHealthCheck],
  defaults: {
    models: { temperature: 0 },
    router: { model: "typesafe/jev-1.13" }, // model routers without their own
    guardrail: { model: "typesafe/jev-1.13" }, // guardrails without their own, never the router's
  },
})
export class DeskApplication {}
```

## Dependency injection

- **One container per application instance, one instance per class**, created at start. A class
  listed by two workflows is one instance. There are no request scopes: what differs per execution
  is read from `ExecutionContext`.
- **A token** is a class or an `InjectionToken<T>` (a constant made once at module level, the one
  place a `new` is written); a value goes in with `provide(TOKEN, value)` in `providers`.
  `provide(SomeClass, instance)` is `[di.instance-provider]` — no instances, the container makes them.
- **Replacement by inheritance**: a dependency on a contract (`Clock`, `IdGenerator`, `Logger`, a
  store, a channel role, a base service) gets the one listed class that `extends` it; two →
  `[di.ambiguous-implementation]`, none for a role → `[di.missing-implementation]`. Infrastructure
  in a workflow's `providers` → `[di.infrastructure-in-workflow]`; a class in `providers` without a
  decorator → `[di.undecorated-provider]`.
- **In tests** a class is replaced by a class, never by an instance:
  `testWith(App, { overrides: [override(CrmClientService, FakeCrmClientService)] })` or the same
  option of a unit runner, where `FakeCrmClientService extends CrmClientService` (reference 10).
- **The four hooks**, each optional, `implements OnInit, OnStart, OnStop, OnDestroy`:
  `onInit()` (dependencies first) → `onStart()` at start (a failure stops the start, naming the
  component and the hook); `app.close()` → `onStop()` (no new executions) → the running executions
  awaited up to `shutdownTimeout` → `onDestroy()` (dependants first; failures collected into one
  error). Open pools and subscriptions in `onStart`, close them in `onDestroy`.
- **No component state**: fields are `private readonly` constructor parameters; `this.cache = …`
  fails lint (`agboss/no-component-state`). A cache or a dedup set is a service over external storage.

## The frame-bound tokens

Injected like any dependency, read only while a step runs (outside → `ExecutionContextUnavailableError`,
`context.unavailable`):

| Token                                  | Gives                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ExecutionContext`                     | `executionId`, `threadId`, `ownerId`, `tenant` (`tenantId`, `weight`, `.application`), `signal` (the execution's, and in a tool call the call's timeout too), `workflow` (`name`, `version`, `configHash`), `step` (`nodeId`, `visitNumber`, `itemIndex`, `copyNumber`, `callId`, `idempotencyKey`), the tree (`parent`, `root`, `depth`, `executionOf(W)`) |
| `SpendRecorder`                        | `record({ service, cost: usd(…) })` — a non-model cost of a tool or action, counted in the budgets (`[spend.outside-step]` outside a step)                                                                                                                                                                                                                  |
| `JudgeModel`                           | a judge's own model: `invoke(text)` on a chat model, `decide({ state, questions })` on a decision model (else `ModelKindError`)                                                                                                                                                                                                                             |
| `ApplicationContext` / `TenantContext` | the levels above: `environment`, `environmentName`, `instanceId`, `startedAt`; the tenant's `tenantId`, `weight` and the project's fields                                                                                                                                                                                                                   |

- **`step.idempotencyKey`** = `${executionId}:${nodeId}:${visitNumber}[:${itemIndex}][:${callId}]`
  — the same when a step runs again after a crash. Pass it to every external side effect.
- **The tree**: `executionContext.root.executionId` is the root execution's id,
  `executionContext.parent?.executionId` the parent's (a child workflow), `depth` is 1 at the root.
- **Your own context fields**: subclass `TenantContext` / `ExecutionContext` with DTO field
  decorators, declare them once in `@Application({ tenantContext, executionContext })` and inject the
  subclass; the values come per call (`tenant: { tenantId, plan }`, `execution: { userId }`).
  Identity only — never a secret.

## Judges in short

- `@Judge({ reply })` must match the agent's `output` (`[judge.wrong-reply]` otherwise): a DTO,
  `oneOf(A, B)`, `listOf(X)`, `listOf(oneOf(A, B))`, or `PlainTextDto` for a text agent.
- `JudgeInput<TReply>` is `{ variant, reply, task, attempt }`; for a `oneOf` reply narrow with
  `isVariant(input, OfferDto)` (`input.variant` is the class the answer validated as); a
  `listOf(oneOf(…))` reply's items are `VariantOf<A | B>` (`{ variant, value }`, narrowed with
  `isVariant(item, A)`).
- Verdicts only through `JudgeVerdict.passed({ metrics? })` / `JudgeVerdict.failed({ reason })`; when
  `maxRetries` are spent the step fails with `QualityGateError` (`rejections: [{ judge, reason }]`).

<!-- snippet-context
import { Judge, JudgeVerdict, isVariant, oneOf, type JudgeHandler, type JudgeInput } from "@agboss/core";
import { Integer, Text } from "@agboss/core/dto";
export class OfferDto {
  @Integer({ prompt: "the salary offered" })
  salary!: number;
}
export class RefusalDto {
  @Text({ prompt: "why no offer is made" })
  reason!: string;
}
-->

```ts
@Judge({ name: "offer-range-judge", model: "moonshotai/kimi-k2.6", reply: oneOf(OfferDto, RefusalDto) })
export class OfferRangeJudge implements JudgeHandler<OfferDto | RefusalDto> {
  judge(input: JudgeInput<OfferDto | RefusalDto>): Promise<JudgeVerdict> {
    if (!isVariant(input, OfferDto)) return Promise.resolve(JudgeVerdict.passed());
    return Promise.resolve(
      input.reply.salary > 0 // narrowed: input.reply is an OfferDto here
        ? JudgeVerdict.passed()
        : JudgeVerdict.failed({ reason: "the salary must be positive" }),
    );
  }
}
```

## Arbiters in short

An arbiter decides whether one branch's answer of a parallel launch counts toward a quorum
(`.acceptedBy(X)`, reference 02). By code: one `@OnAnswer(Agent)` method per agent of the launch,
typed by that agent's output (`[arbiter.unhandled-agent]`, `[arbiter.unknown-agent]`,
`[arbiter.duplicate-agent]`); by model: `model`, `prompt` and one `criteria` entry per agent.

<!-- snippet-context
import { SupportAgent } from "./src/desk/agents/support.agent.js";
import { DeskAnswerDto } from "./src/desk/dtos/desk.dto.js";
-->

```ts
import { Arbiter, DecidedBy, OnAnswer } from "@agboss/core";

@Arbiter({ name: "has-answer-arbiter", decidedBy: DecidedBy.Code })
export class HasAnswerArbiter {
  @OnAnswer(SupportAgent)
  fromSupport(answer: DeskAnswerDto): boolean {
    return answer.text.trim().length > 0;
  }
}
```

## Tool interceptors

A `@ToolInterceptor` (#384) wraps an agent's calls to its `@Tool`s and `@McpTool`s — a tenant's
scope, an audit, a rewrite of a result. Its class implements `BeforeToolCall`, `AfterToolCall` or
both (neither does not compile, `[tool-interceptor.missing-handler]`); the name ends with
`-tool-interceptor`. It is listed in `toolInterceptors: [...]` of `@Application` → `@Workflow` →
`@Agent` → `@Tool` / `@McpTool` — lists add up, outer first; `excludeToolInterceptors` on an agent
or a tool removes an inherited one (`[tool-interceptor.exclude-not-inherited]`; a class that is not
one is `[tool-interceptor.not-an-interceptor]`).

<!-- snippet-context
import { TenantContext } from "@agboss/core";
import { ListOf, Text } from "@agboss/core/dto";
export class JobScoutTenantContext extends TenantContext {
  @ListOf(Text)
  allowedCities!: string[];
}
-->

```ts
import {
  ToolCallDecision,
  ToolInterceptor,
  type AfterToolCall,
  type BeforeToolCall,
  type ToolCallContext,
  type ToolCallResultContext,
} from "@agboss/core";

@ToolInterceptor({
  name: "tenant-scope-tool-interceptor",
  description: "Checks that tool arguments respect the tenant's allowed cities",
  deps: [JobScoutTenantContext],
})
export class TenantScopeToolInterceptor implements BeforeToolCall {
  constructor(private readonly jobScoutTenantContext: JobScoutTenantContext) {}

  beforeToolCall(call: ToolCallContext): ToolCallDecision {
    if (
      typeof call.input === "object" &&
      call.input !== null &&
      "city" in call.input &&
      typeof call.input.city === "string" &&
      !this.jobScoutTenantContext.allowedCities.includes(call.input.city)
    ) {
      return ToolCallDecision.replyToModel({
        message: `City "${call.input.city}" is not allowed for this tenant.`,
      });
    }
    return ToolCallDecision.allow();
  }
}

@ToolInterceptor({ name: "audit-tool-interceptor", description: "Logs every tool result" })
export class AuditToolInterceptor implements AfterToolCall {
  afterToolCall(call: ToolCallResultContext): unknown {
    console.info(`${call.tool.name} answered`); // a real one writes to its audit service
    return call.output; // the result the model reads: the tool's, or a replacement
  }
}

// @Application({ …, toolInterceptors: [AuditToolInterceptor] }) — every agent's tool calls;
// @Workflow({ …, toolInterceptors: [TenantScopeToolInterceptor] }) — its agents' calls
```

- **`beforeToolCall` decides**, outer first: `ToolCallDecision.allow()` — the next one decides,
  then the tool runs; `ToolCallDecision.replyToModel({ message })` — the tool is not called, the
  model reads `message` as the call's result and may try again (the step goes on);
  `ToolCallDecision.block({ reason })` — the tool is not called and the agent's step fails with
  `ToolBlockedError` (`step.tool-blocked`, a `StepFailedError`: `agent`, `tool`, `interceptor`,
  `reason`; `.onError(ToolBlockedError, …)` after the agent takes it).
- **`afterToolCall` replaces the result**, inner first, on a successful call only (a tool error goes
  to the model as it is); each output is validated against the tool's output DTO.
- **The order**: PII block rules on the arguments → `beforeToolCall`s (arguments with PII tokens
  revealed, not validated yet) → the tool → `afterToolCall`s → `maxResultSize` → PII masking. A
  `replyToModel` message is bounded and masked the same way.
- **In the call's frame**: an injected `ExecutionContext` reads the tool call
  (`step.callId`, `step.idempotencyKey` with the call id, the call's `signal`).
- An interceptor that throws, returns no `ToolCallDecision` or an output its tool does not give
  fails the step — `AgentFailedError`, its error as the `cause` (`.onError(DomainError, …)` takes it
  through the cause).
- Only the project's own `@Tool` / `@McpTool` calls are intercepted — never an answer tool, a
  knowledge base's search tool or a tool called on its own (over MCP).
- `agboss describe` prints `tool interceptors` (each one's methods and the agents' tools it
  intercepts), `describe --json` each agent's `toolInterceptors` by tool; `configHash` covers them.
  Tests: `testToolInterceptor` (reference 10).

## Settings and their units

- **Defaults cascade** `@Application({ defaults })` → `@Workflow({ defaults })` → the component's own
  field, field by field — the most specific set value wins: `defaults.models` (`temperature`,
  `maxTokens`, `reasoning`, `cache`), `defaults.router.model`, `defaults.guardrail.model`,
  `defaults.tools` (`maxToolCalls`, `maxResultSize`). `npx agboss describe` prints where each value came from.
- **Reasoning** is `Reasoning.modelDecides()`, `Reasoning.on({ effort: ReasoningEffort.High })`,
  `Reasoning.on({ budget: { tokens: 2000 } })` or `Reasoning.off()` (`@agboss/core/models`); there is no
  `thinking` option.
- **Units** (`@agboss/core/units`): `seconds()`, `minutes()`, `hours()` for every timeout, deadline and
  retention; `usd()` for money (`Usd`); `kilobytes()` for sizes. A bare number does not compile.
- **Prompts**: `prompt` inline or `promptUrls` (files next to the component), `{{variables}}` from
  `promptVariables` checked at assembly (`[prompt.unknown-variable]`). What a node reads arrives in its
  input message (`### message (from desk-workflow-start)`) — never write `{{input.…}}` in a prompt
  (`[prompt.input-in-instructions]`).
- **Memory**: each agent and model router sees the thread's last `uncompactedTurns` turns in full
  (default 5, `TurnLimit.ALL` = all); older ones are its `compaction`'s summaries
  (`CompactionStrategy.SummaryQueue` / `SingleSummary` / `None`, or `Custom` — your class's
  `compact()`; `agboss describe`: `strategy: custom (GraphMemoryCompaction.compact())`). Both cascade application →
  workflow → component; a code router has neither (it does not compile).

## Running the application

<!-- snippet-context
import { createApp } from "@agboss/core";
import { DeskApplication } from "./src/desk/desk.application.js";
import { DeskWorkflowStart } from "./src/desk/desk.workflow.js";
-->

```ts
const app = await createApp(DeskApplication, { env: "prod" }); // closes itself on SIGTERM / SIGINT

const controller = new AbortController(); // a caller's cancel, e.g. the client disconnected
const first = await app.execute(
  DeskWorkflowStart,
  { text: "Where is my refund?" }, // typed by the start's input DTO
  {
    tenant: { tenantId: "acme" },
    threadId: "ticket-4821", // the caller's own id: the next turn of the same conversation
    ownerId: "customer-17", // another owner on this thread → ThreadOwnerError
    signal: controller.signal,
    onStream: (event) => {
      if (event.kind === "textDelta") process.stdout.write(event.delta); // also "toolCall"
    },
  },
);
console.log(first.executionId, first.threadId, first.output?.text, first.spend.totalUsd);

// a second turn: same threadId → the agent sees the earlier turns (uncompactedTurns, compaction)
await app.execute(DeskWorkflowStart, { text: "And the second order?" }, {
  tenant: { tenantId: "acme" },
  threadId: first.threadId,
  ownerId: "customer-17",
});

await app.cancel("ticket-4821", { tenantId: "acme", ownerId: "customer-17" }); // by thread
const readiness = await app.checkReadiness(); // HealthReport: stores, providers, crm-health-check
console.log(readiness.status);
await app.close(); // onStop → running executions awaited → onDestroy
```

- **`executionId` vs `threadId`**: an execution is one pass of `app.execute` (or a resume); a thread
  is the conversation of many executions, keyed by `tenantId` + `threadId`. Without a `threadId` a
  new thread is made (its id in the result); an id the tenant does not have yet creates it.
- **Cancel** by `app.cancel(threadId, { tenantId, ownerId })` (a running execution fails with
  `ExecutionCancelledError`, a paused one is dropped) or by the `signal` you passed.
- After `app.close()` every `execute` / `resume` rejects with `ApplicationStoppingError`.

## Undoable actions: `compensateWith`, `committedBy`

An action with a side effect the flow may have to take back names its undo — another `@Action`, code,
never a model call — and optionally the action after which nothing undoes it any more. Where the flow
goes after a failure is reference 02, section 8; the tests reference 10.

<!-- snippet-context
import { Workflow, WorkflowFinish, WorkflowStart, start } from "@agboss/core";
import { Text } from "@agboss/core/dto";
export class SeatRequestDto {
  @Text({ prompt: "the flight and the passenger" })
  request!: string;
}
export class SeatHoldDto {
  @Text({ prompt: "the hold's id" })
  holdId!: string;
}
export class TicketIssuedDto {
  @Text({ prompt: "the ticket number" })
  ticketNumber!: string;
}
@WorkflowStart({ name: "seat-workflow-start", description: "A seat to book", input: SeatRequestDto })
export class SeatWorkflowStart {}
@WorkflowFinish({ name: "ticket-issued-workflow-finish", description: "The ticket", output: TicketIssuedDto })
export class TicketIssuedWorkflowFinish {}
// @snippet
-->

```ts
import { Action, ExecutionContext, Injectable, type ActionHandler, type InputOf, type OutputOf } from "@agboss/core";

@Injectable()
export class AirlineService {
  hold(request: string, idempotencyKey: string): Promise<string> {
    return Promise.resolve(`${request}:${idempotencyKey}`);
  }

  release(holdId: string, idempotencyKey: string): Promise<void> {
    void holdId;
    void idempotencyKey; // an undo runs again after a crash: make it safe twice by this key
    return Promise.resolve();
  }
}

// the undo: reads only what the path holds right after the action it undoes
@Action({
  name: "release-seat-action",
  description: "Releases a held seat",
  input: { hold: SeatHoldDto },
  deps: [AirlineService, ExecutionContext],
})
export class ReleaseSeatAction implements ActionHandler<ReleaseSeatAction> {
  constructor(
    private readonly airlineService: AirlineService,
    private readonly executionContext: ExecutionContext,
  ) {}

  async execute(input: InputOf<ReleaseSeatAction>): Promise<void> {
    // on a side path its own step's key; automatic: the undone step's key + ":compensation"
    await this.airlineService.release(input.hold.value.holdId, this.executionContext.step.idempotencyKey);
  }
}

// the commit point: once it succeeds, nothing undoes the hold
@Action({ name: "issue-ticket-action", description: "Issues the ticket", input: { hold: SeatHoldDto }, output: TicketIssuedDto })
export class IssueTicketAction implements ActionHandler<IssueTicketAction> {
  execute(input: InputOf<IssueTicketAction>): Promise<OutputOf<IssueTicketAction>> {
    return Promise.resolve({ ticketNumber: `T-${input.hold.value.holdId}` });
  }
}

@Action({
  name: "hold-seat-action",
  description: "Holds a seat",
  input: { request: SeatRequestDto },
  output: SeatHoldDto,
  compensateWith: ReleaseSeatAction, // an @Action: [action.compensator-not-an-action] otherwise
  committedBy: IssueTicketAction, // without it, a finish commits the hold
  deps: [AirlineService, ExecutionContext],
})
export class HoldSeatAction implements ActionHandler<HoldSeatAction> {
  constructor(
    private readonly airlineService: AirlineService,
    private readonly executionContext: ExecutionContext,
  ) {}

  async execute(input: InputOf<HoldSeatAction>): Promise<OutputOf<HoldSeatAction>> {
    const key: string = this.executionContext.step.idempotencyKey;
    return { holdId: await this.airlineService.hold(input.request.value.request, key) };
  }
}

@Workflow({
  name: "seat-workflow",
  version: "1.0.0",
  flow: [
    start(SeatWorkflowStart)
      .returns(SeatRequestDto)
      .toAction(HoldSeatAction)
      .returns(SeatHoldDto)
      .toAction(IssueTicketAction) // commits the hold: no side path after it owes the release
      .returns(TicketIssuedDto)
      .toFinish(TicketIssuedWorkflowFinish),
  ],
  providers: [AirlineService],
})
export class SeatWorkflow {}
```

- **The automatic undo** (a failed join's finished branches; an execution that ends without a
  finish — an uncaught failure or limit, a cancel) runs each undo in its own frame: its
  `executionContext.signal` is a clean-up signal, aborted after
  `@Application({ compensationTimeout })` (default `seconds(15)`), when the lease is lost or the
  instance stops; no budget refuses it; what its services cost (`SpendRecorder`) is spend under
  `action:<undo name>`. An undo that fails does not stop the others; then the execution fails with
  `CompensationFailedError` (`compensation.failed`: `failures`, `cause`).
- **Observers** see the automatic ones through `OnCompensationStart` / `OnCompensationEnd`
  (`CompensationStartEvent`: `step`, `compensated`, `reason`; `CompensationEndEvent` adds `status`,
  `error`), around the undo action's own `onActionStart` / `onActionEnd`; `onExecutionError`'s
  `compensations` lists what ran (reference 08). Every run's `result.compensations` lists them all.
- An undo action declares no `compensateWith` of its own (`[action.compensator-compensates]`), never
  undoes itself (`[action.self-compensation]`), and `committedBy` without `compensateWith` is
  `[action.committer-without-compensator]`.

## Rule codes you will meet here

| Code                                       | Cause → fix                                                                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `[name.kind-suffix]`                       | `name: "support"` → `name: "support-agent"` (tools end with `-tool`, knowledge bases `-rag`, …)                                     |
| `[di.instance-provider]`                   | `provide(CrmClientService, new CrmClientService(…))` → list the class; values only for tokens                                       |
| `[di.infrastructure-in-workflow]`          | a store, `Clock`, `IdGenerator`, channel or model provider in `@Workflow({ providers })` → move it to `@Application({ providers })` |
| `[di.ambiguous-implementation]`            | two listed classes `extends` one contract → keep one                                                                                |
| `[environment.contract-value]`             | a default value in the contract class → move it to `<name>.environment.ts`                                                          |
| `[environment.missing-field]`              | a listed implementation reads a field the contract lacks (`sqlitePath`) → declare it                                                |
| `[prompt.input-in-instructions]`           | `{{input.message}}` in a prompt → delete it: the input message carries the field                                                    |
| `[prompt.unknown-variable]`                | `{{tone}}` without `promptVariables: { tone }` → add it                                                                             |
| `[judge.wrong-reply]`                      | the judge's `reply` is not the agent's `output` shape → make them the same                                                          |
| `[compaction.uncompacted-turns-invalid]`   | `uncompactedTurns: 0` or a fraction → a whole number from 1, or `TurnLimit.ALL`                                                     |
| `[compaction.missing-handler]`             | a `CompactionStrategy.Custom` class without `compact(input)` → `implements CompactionHandler`                                       |
| `[health.not-a-health-check]`              | a class in `healthChecks` without `@HealthCheck` → decorate it                                                                      |
| `[context.not-declared]`                   | a `TenantContext` subclass injected but not declared → `@Application({ tenantContext })`                                            |
| `[tool-interceptor.missing-handler]`       | a `@ToolInterceptor` class with neither method → `implements BeforeToolCall` and / or `AfterToolCall`                               |
| `[tool-interceptor.exclude-not-inherited]` | `excludeToolInterceptors` names one no level above lists → drop it                                                                  |
| `[action.invalid-compensator-input]`       | the undo reads a field not on the path right after its action → read what the action returned (`SeatHoldDto`)                       |

## Pitfalls

- `new SomeService()` / `new SomeTool()` anywhere in project code — list classes, inject them.
- `process.env.X` in a component — read `applicationContext.environment.x` (typed, per environment).
- A `ctx` parameter on `run` / `execute` — there is none; inject `ExecutionContext`.
- `Date.now()` / `setTimeout` — inject `Clock` (`clock.now()`, `clock.sleep(seconds(1), signal)`).
- Ignoring `executionContext.signal` in a slow call: pass it to `fetch` and SDK clients so a cancel,
  a timeout or a lost lease stops the call.
- An `onStart` that waits for a slow service with no timeout blocks the start — bound it.
