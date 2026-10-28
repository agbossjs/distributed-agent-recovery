# 06 — FinOps, model providers and queues

Read this when you set or change what an application may spend (`@Budget`), which server answers a
model (`@ModelProvider`), how calls are retried, rate-limited, queued between tenants or cut off by a
circuit breaker, or what a non-model service costs (`SpendRecorder`). Counts (`maxSteps`,
`maxVisits`, `maxConcurrentExecutions`) are in reference 02; the stores that share the counters
between instances in reference 09.

## Three things that are not the same

| Protects              | Set with                                                                      | Hitting it                                                                                |
| --------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| money                 | `@Budget` components in `@Application({ budgets })`                           | `BudgetExceededError` (`limit.budget`): rejected before the first step, or stopped        |
| the graph             | `@Workflow({ maxSteps })`, `maxVisits`, `maxDepth`, `maxConcurrentExecutions` | `StepsLimitExceededError`, `VisitsLimitExceededError`, `DepthLimitExceededError`; a queue |
| a provider's capacity | `@ModelProvider({ rateLimitPolicy, retryPolicy, circuitBreakerPolicy })`      | a call waits in a tenant-fair queue; never an error, never money                          |

## Budgets

Every budget is one class, one template: the decorator says **what** it limits, `maxSpend()` **how
much**. Every application has at least one execution budget covering each workflow, one tenant
budget and one application budget — no execution runs uncapped.

```ts file=src/billing/contexts/shop-tenant.context.ts
// contexts/shop-tenant.context.ts — the tenant's own fields, given per execution (identity, never secrets)
import { TenantContext } from "@agboss/core";
import { Decimal } from "@agboss/core/dto";

export class ShopTenantContext extends TenantContext {
  @Decimal({ min: 0 })
  dailyBudgetUsd!: number;
}
```

```ts file=src/billing/config/budget.config.ts
// config/budget.config.ts — every budget of the application
import { Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";
import { ShopTenantContext } from "../contexts/shop-tenant.context.js";
import { InvoiceWorkflow } from "../invoice.workflow.js";

@Budget({
  name: "application-daily-budget",
  scope: BudgetScope.Application, // the whole application, every tenant and instance
  period: BudgetPeriod.Day, // UTC: Day | Week | Month
})
export class ApplicationDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(50);
  }
}

@Budget({
  name: "tenant-daily-budget",
  scope: BudgetScope.Tenant, // one counter per tenantId
  period: BudgetPeriod.Day,
  deps: [ShopTenantContext], // the amount comes from the tenant's own data
})
export class TenantDailyBudget implements BudgetHandler {
  constructor(private readonly shopTenantContext: ShopTenantContext) {}

  maxSpend(): Usd {
    return usd(this.shopTenantContext.dailyBudgetUsd);
  }
}

@Budget({ name: "tenant-monthly-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Month })
export class TenantMonthlyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(200); // several budgets of one scope with different periods hold at once
  }
}

@Budget({ name: "execution-budget", scope: BudgetScope.Execution }) // no workflow: the default
export class ExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.05); // one pass of app.execute, its child workflows included
  }
}

@Budget({ name: "invoice-execution-budget", scope: BudgetScope.Execution, workflow: InvoiceWorkflow })
export class InvoiceExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.2); // its own: replaces the default for executions of this workflow
  }
}
```

- The options are discriminated by `scope`: `period` is required for `Tenant` / `Application` and does
  not compile on `Execution`; `workflow: X` exists only on `Execution`.
- **`maxSpend()` is read once per execution**, at its start, in the start step's frame (an injected
  `ExecutionContext` or tenant context is readable), and kept for the whole execution: a resume, a
  restart and a recovery count against the same amounts.
- **Before the first step** every budget is checked: one exhausted **rejects** the execution —
  `BudgetExceededError`, `onExecutionRejected` with `code: "limit.budget"`, no thread, no record.
- **During the execution** every model call's and paid service's cost is counted the moment it is
  made, in every budget of the execution; before every agent and router step and every model call of
  an agent's loop the counters are read again (the tenant's other executions count). The first
  exhausted **stops** the execution with `BudgetExceededError` (`budget`, `scope`, `key`,
  `maxSpend`, `spent`) — into `.onError(BudgetExceededError, …)` if the step has one (actions and
  finishes only, `[graph.limit-handler-uses-model]`), else the execution fails. In a parallel launch the
  call that exhausts a budget aborts the calls in flight of every branch of the tree.
- **Nothing is reserved**: a budget is exceeded by at most the calls in flight when it was exhausted,
  and parallel executions of one tenant may overrun it a little. An automatic undo is never refused
  by a budget (reference 02, section 8).
- Assembly: `[budget.execution-budget-required]`, `[budget.duplicate-execution-budget]`,
  `[budget.duplicate-default-execution-budget]`, `[budget.tenant-budget-required]`,
  `[budget.application-budget-required]`, `[budget.not-a-budget]`. The counters live in the
  application's `CostLedgerRepository` — the built-in in-memory one counts per instance and resets on
  restart (`[application.in-memory-cost-ledger]`); list `SqliteCostLedgerRepository` (reference 09).

### What a service costs: `SpendRecorder`

A `@Tool` or `@Action` that calls a paid API records what one call cost; the record joins the tool
call's spend (`tool:<name>`) or the step's (`action:<name>`) and counts in every budget. Outside a
step it throws `SpendOutsideStepError` (`[spend.outside-step]`).

```ts file=src/billing/tools/tax-rate.tool.ts
import { ExecutionContext, SpendRecorder, Tool, type ToolHandler } from "@agboss/core";
import { Decimal, Text } from "@agboss/core/dto";
import { seconds, usd } from "@agboss/core/units";

export class TaxQuery {
  @Text({ prompt: "the customer's country, ISO 3166 alpha-2" })
  country!: string;
}

export class TaxRate {
  @Decimal({ prompt: "the VAT rate, 0 to 1", min: 0, max: 1 })
  rate!: number;
}

@Tool({
  name: "tax-rate-tool",
  description: "The VAT rate of a country (a paid API)",
  input: TaxQuery,
  output: TaxRate,
  timeout: seconds(5),
  deps: [ExecutionContext, SpendRecorder],
})
export class TaxRateTool implements ToolHandler<TaxQuery, TaxRate> {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly spendRecorder: SpendRecorder,
  ) {}

  run({ country }: TaxQuery): Promise<TaxRate> {
    this.executionContext.signal.throwIfAborted();
    this.spendRecorder.record({ service: "tax-api", cost: usd(0.001) }); // counted in every budget
    return Promise.resolve({ rate: country === "IL" ? 0.18 : 0.2 });
  }
}
```

## Model providers

A workflow and its components name **models** only; the application lists the **providers** that
serve them, in `@Application({ providers })` (never a workflow's: `[di.infrastructure-in-workflow]`).

- **None listed** → the built-in `OpenRouterModelProvider` (every chat model, its key the `Secret`
  field `openRouterApiKey` of the environment) and `DecisionsModelProvider` (the decision models,
  `DECISION_MODELS`: Jev and the others — routers, guardrails, decision judges).
- **At least one listed** → the list is complete: the built-ins are not added. An application that
  lists its own chat provider and uses Jev lists `DecisionsModelProvider` too.
- Every model of the application must resolve to exactly one listed provider by `serves`, for its
  purpose (chat or decision): `[model.unserved]`, `[model.ambiguous-provider]` — one model through two
  providers is two model strings. `npx agboss describe` prints `model: … → <provider>`.
- A provider's `name` ends with `-model-provider` (`[name.kind-suffix]`).

```ts file=src/billing/environments/app.environment.ts
import type { Secret } from "@agboss/core";

export class AppEnvironment {
  openRouterApiKey?: Secret; // optional: the test environment leaves the keys out
  backupApiKey?: Secret;
  openRouterBaseUrl?: string; // a proxy or a stub; unset → the decorator's baseUrl
}
```

```ts file=src/billing/environments/dev.environment.ts
import { env, secret } from "@agboss/core";
import type { AppEnvironment } from "./app.environment.js";

export const environment: AppEnvironment = {
  openRouterApiKey: secret("OPENROUTER_API_KEY"),
  backupApiKey: secret("BACKUP_API_KEY"),
  openRouterBaseUrl: env.optional("OPENROUTER_BASE_URL"),
};
```

```ts file=src/billing/environments/test.environment.ts
import type { AppEnvironment } from "./app.environment.js";

export const environment: AppEnvironment = {}; // tests script every model: no key
```

```ts file=src/billing/model-providers/backup.model-provider.ts
// model-providers/backup.model-provider.ts — an OpenAI-compatible server, priced from a table
import {
  ModelCost,
  ModelProvider,
  OpenAiCompatibleProvider,
  PromptCaching,
  Reasoning,
  RetryPolicy,
  type NoRequestFields,
} from "@agboss/core/models";
import { minutes, seconds, usd } from "@agboss/core/units";

@ModelProvider({
  name: "backup-model-provider",
  description: "Our own inference server, used while OpenRouter's breaker is open",
  serves: [/^backup\//],
  baseUrl: "http://inference.internal:8000/v1",
  apiKey: "backupApiKey", // a Secret field of the application's environment
  timeout: minutes(1),
  cost: ModelCost.fromPrices({
    "backup/kimi": { inputPerMillion: usd(0.4), outputPerMillion: usd(1.6) },
  }),
  reasoning: Reasoning.off(),
  promptCaching: PromptCaching.off(),
  retryPolicy: RetryPolicy.none(),
  circuitBreakerPolicy: { failureThreshold: 5, window: minutes(1), openFor: seconds(30) },
})
export class BackupModelProvider extends OpenAiCompatibleProvider {
  override readonly requestFields: NoRequestFields = {};
}
```

```ts file=src/billing/model-providers/openrouter.model-provider.ts
// model-providers/openrouter.model-provider.ts — every policy of one provider, app-wide
import {
  CachedPart,
  CacheRetention,
  ModelCost,
  ModelFailure,
  ModelProvider,
  OpenRouterProvider,
  PromptCaching,
  ProviderSort,
  QueueBalancingStrategy,
  RateLimitPolicy,
  Reasoning,
  RetryPolicy,
  type OpenRouterFields,
} from "@agboss/core/models";
import { minutes, seconds } from "@agboss/core/units";
import { BackupModelProvider } from "./backup.model-provider.js";

@ModelProvider({
  name: "openrouter-model-provider",
  description: "OpenRouter — the chat models",
  serves: [/^moonshotai\//, /^deepseek\//],
  baseUrl: "https://openrouter.ai/api/v1", // the default…
  baseUrlField: "openRouterBaseUrl", // …unless this text field of the environment sets one
  apiKey: "openRouterApiKey",
  timeout: minutes(2), // per attempt, from the moment the call has room
  cost: ModelCost.fromResponse(), // OpenRouter reports each call's cost: exact
  reasoning: Reasoning.modelDecides(), // components may override it (reasoning: Reasoning.on(…))
  promptCaching: PromptCaching.whereSupported({
    retention: CacheRetention.FiveMinutes,
    cachedParts: [CachedPart.SystemPrompt, CachedPart.Tools, CachedPart.History],
  }),
  retryPolicy: RetryPolicy.exponential({
    maxAttempts: 3, // retries one call: one answer, one usage record, paid once
    initialDelay: seconds(1),
    maxDelay: seconds(20),
    jitter: true,
    retryOn: [ModelFailure.Timeout, ModelFailure.RateLimited, ModelFailure.ServerError],
  }),
  rateLimitPolicy: RateLimitPolicy.of({
    maxConcurrentCalls: 8, // for the whole application: every execution, tenant and instance
    perMinute: { calls: 120, tokens: 400_000 },
    balancing: QueueBalancingStrategy.TenantWeighted, // a tenant gets up to its weight per round
  }),
  circuitBreakerPolicy: {
    failureThreshold: 5, // 5 failed calls within a minute open it for 30 s
    window: minutes(1),
    openFor: seconds(30),
    fallback: BackupModelProvider, // while open, calls go there…
    fallbackModels: { "moonshotai/kimi-k2.6": "backup/kimi" }, // …each model mapped to one it serves
  },
})
export class AppOpenRouterModelProvider extends OpenRouterProvider {
  override readonly requestFields: OpenRouterFields = {
    provider: { sort: ProviderSort.Price }, // OpenRouter's routing between upstreams
  };
}
```

**Pinning the host (#395):** `OpenRouterRouting` — `order`, `only`, `ignore` (hosts by OpenRouter's
slug, `fireworks`), `sort` (`ProviderSort`), `quantizations` (`Quantization.Bf16`, `Fp8`, …) and
`allowFallbacks` — is camelCase in TypeScript; only the request body is OpenRouter's snake_case
(`allow_fallbacks`). Pin the host and precision when results must not drift between upstreams
(evals, a benchmark): `provider: { only: ["fireworks"], quantizations: [Quantization.Bf16],
allowFallbacks: false }`. Every call's `UsageRecord.servedBy` names the host that served it
(OpenRouter's `provider`, a plain or a streamed answer). `npx agboss check --models` checks each
served model's endpoints: a pinned host that does not serve it, or no allowed host at a pinned
quantization, is `[model.no-matching-endpoint]`; the endpoints are never asked at start.

### A custom transport: `complete(request)`

A provider that is not an OpenAI-compatible HTTP server — AWS Bedrock through its SDK, Vertex AI,
a corporate gateway with its own authorisation — `implements ModelProviderHandler` with
`complete(request)` (#385): no `baseUrl`, `baseUrlField` or `apiKey` (both modes at once do not
compile and fail assembly with `[model-provider.both-modes]`), its services through `deps`. The
application's container creates it on its first call — one instance per application — and an
injected `TenantContext` reads the calling execution. Everything of the gateway runs around
`complete()` unchanged: `serves`, the budgets before the call and the ledger after it, the
`rateLimitPolicy` queue and its 429 pause, `retryPolicy`, `circuitBreakerPolicy` (readiness
`Degraded`, its `fallback` either way between HTTP and transport providers), PII masking, the answer
tools of a DTO agent, traces, and `mockLlm` in `testWith` (which answers above it: `complete()` is
never called in a scripted test).

```ts file=src/billing/model-providers/bedrock.model-provider.ts
// model-providers/bedrock.model-provider.ts — a transport: the class makes the call itself
import { Injectable, TenantContext } from "@agboss/core";
import {
  ModelCost,
  ModelFailure,
  ModelProvider,
  ModelProviderFailureError,
  QueueBalancingStrategy,
  RateLimitPolicy,
  RetryPolicy,
  TRANSIENT_FAILURES,
  type ModelProviderHandler,
  type ModelProviderMessage,
  type ModelProviderRequest,
  type ModelProviderResponse,
  type ModelProviderToolDefinition,
} from "@agboss/core/models";
import { minutes, seconds, usd } from "@agboss/core/units";

/** What the SDK takes: the framework's plain messages and tools, the tenant, the call's signal. */
export interface BedrockInvocation {
  readonly model: string;
  readonly messages: readonly ModelProviderMessage[];
  readonly tools: readonly ModelProviderToolDefinition[];
  readonly tenantId: string;
  readonly signal: AbortSignal;
}

@Injectable()
export class BedrockSdkClient {
  async invoke(invocation: BedrockInvocation): Promise<ModelProviderResponse> {
    const response = await fetch(`https://bedrock.internal/${invocation.model}`, {
      method: "POST",
      body: JSON.stringify(invocation),
      signal: invocation.signal,
    });
    if (response.status === 429) {
      const retryAfter = seconds(Number(response.headers.get("retry-after") ?? "1"));
      throw new ModelProviderFailureError(ModelFailure.RateLimited, { retryAfter });
    }
    return (await response.json()) as ModelProviderResponse; // { text, toolCalls?, usage, cost? }
  }
}

@ModelProvider({
  name: "bedrock-model-provider",
  description: "AWS Bedrock through its SDK",
  serves: [/^bedrock\//],
  timeout: minutes(2), // per attempt: request.signal aborts at it
  cost: ModelCost.fromPrices({
    "bedrock/claude": { inputPerMillion: usd(3), outputPerMillion: usd(15) },
  }),
  rateLimitPolicy: RateLimitPolicy.of({
    maxConcurrentCalls: 8,
    balancing: QueueBalancingStrategy.TenantRoundRobin,
  }),
  retryPolicy: RetryPolicy.exponential({
    maxAttempts: 3,
    initialDelay: seconds(1),
    maxDelay: seconds(20),
    jitter: true,
    retryOn: TRANSIENT_FAILURES,
  }),
  circuitBreakerPolicy: { failureThreshold: 5, window: minutes(1), openFor: seconds(30) },
  deps: [BedrockSdkClient, TenantContext], // reasoning / promptCaching unset: off
})
export class BedrockModelProvider implements ModelProviderHandler {
  constructor(
    private readonly bedrockSdkClient: BedrockSdkClient,
    private readonly tenantContext: TenantContext,
  ) {}

  async complete(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    return this.bedrockSdkClient.invoke({
      model: request.model,
      messages: request.messages,
      tools: request.tools,
      tenantId: this.tenantContext.tenantId, // the execution of this call
      signal: request.signal,
    });
  }
}
```

- **The request** (`ModelProviderRequest`): `model` (a fallback's mapped one), `messages`
  (`ModelProviderMessage { role: ModelProviderMessageRole, text, toolCalls?, toolCallId? }`, text
  only, masked), `tools` (`ModelProviderToolDefinition { name, description, parameters }` — the
  agent's own and its `answer-<dto>` tools), `temperature`, `maxTokens` (`undefined` =
  `TokenLimit.MODEL_MAX`), `reasoning`, `promptCaching`, `signal` (pass it to the SDK; an SDK that
  ignores it is cut at `timeout` anyway, a `Timeout`).
- **The answer** (`ModelProviderResponse`): `text`, `toolCalls?` (`ModelProviderToolCall { id,
name, arguments }`), `usage` (`ModelProviderUsage { inputTokens, outputTokens, cacheReadTokens?,
cacheWriteTokens? }` — the rate limit's tokens and the price table's), `cost?` (exact,
  `costSource: "api"`; else the table), `finishReason?` (`FinishReason.Length`).
- **Failures**: throw `ModelProviderFailureError(ModelFailure.…, { retryAfter?, cause? })` — the
  retry policy retries the failures it lists, `RateLimited` pauses the whole queue for
  `retryAfter`, the breaker counts it. Any other error is not retried and counted by the breaker.
- **Its lifecycle** is a component's (#385 S4): created on its first call, its `onInit` → `onStart`
  (`implements OnInit, OnStart, …`) run, awaited, before that call's `complete()` — once, however
  many first calls arrive together. A failing hook fails that call with the start's error
  (`[di.hook-failed] BedrockModelProvider.onStart failed: …`), and the next call tries again. At
  `app.close()` a created transport gets `onStop` / `onDestroy` in the usual order; one never
  called gets no hook.
- `capabilities(model, connection)` is optional on a transport: given, it is checked at start like
  an HTTP provider's; absent, its models' settings are not checked (`npx agboss check --models`
  never creates a transport). `npx agboss describe` prints `bedrock-model-provider →
BedrockModelProvider (…) · serves /^bedrock\// · transport: BedrockModelProvider.complete()`
  and each `model: bedrock/claude → bedrock-model-provider`; the class is in `configHash`.

### The three policies

| Policy                 | Its one duty                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retryPolicy`          | retries **this** call — `RetryPolicy.exponential({ … })`, `.fixed({ maxAttempts, delay, retryOn })`, `.none()`; the only place backoff is set. Only the listed `ModelFailure`s are retried (`Timeout`, `RateLimited`, `ServerError`, `NetworkError`); a 4xx is the answer. `Retry-After` is honoured; a wait between attempts holds no slot                                                                                                                                             |
| `rateLimitPolicy`      | how many calls go out — `RateLimitPolicy.of({ maxConcurrentCalls?, perMinute?: { calls?, tokens? }, balancing? })`, at least one limit. Without it there is no limit. A call without room **waits** (never an error, never a cost): the tenant-fair queue → the 429 pause → the per-minute tokens → a slot → the per-minute calls. A 429 pauses the provider's whole queue for `Retry-After` on every instance and halves that instance's concurrency, which grows back by one a minute |
| `circuitBreakerPolicy` | `{ failureThreshold, window, openFor, fallback?, fallbackModels? }` (required): that many failed calls within the window open it for `openFor`; while open, calls go to the `fallback` provider with each model mapped by `fallbackModels`, or fail fast with `ModelCallError` `model.circuit-open`. An open breaker makes readiness `Degraded`                                                                                                                                         |

The fallback — HTTP or a transport, either way round — serves its own model strings;
every model used on the primary must be mapped to one it serves (`model.fallback-unmapped`), priced
when it prices from a table (`model.fallback-no-price`) — checked at start and by
`npx agboss check --models`.

**Fairness between tenants** (`balancing`, `QueueBalancingStrategy`) — who gets a free slot:

| Strategy                         | A free slot goes to                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `TenantRoundRobin` (the default) | the waiting tenants in turn, first in first out inside one                                              |
| `TenantLeastInFlight`            | the waiting tenant with the fewest calls in flight                                                      |
| `TenantWeighted`                 | round-robin, a tenant up to its `weight` slots per round (`tenant: { tenantId, weight: 3 }`, default 1) |
| `Fifo`                           | one queue in arrival order                                                                              |

The queue is per instance; the slots, windows, pause and breaker are shared through the
application's `RateLimitRepository` (`SqliteRateLimitRepository` or your own, reference 09). Every
wait runs on the application's `Clock` — tests move it with `clock.advance(…)`.

**Starting points** — the limits from your plan's documented ones, keeping about 20 % headroom:

| Plan                                       | `maxConcurrentCalls`                  | `perMinute`                               |
| ------------------------------------------ | ------------------------------------- | ----------------------------------------- |
| a free or trial key                        | 2                                     | `{ calls: 20 }`                           |
| a small paid plan (requests per minute)    | 8                                     | `{ calls: 120 }`                          |
| a plan with requests and tokens per minute | the plan's concurrency, else RPM ÷ 30 | `{ calls: RPM × 0.8, tokens: TPM × 0.8 }` |
| a local server (one GPU)                   | its batch size                        | —                                         |

### Cost, reasoning, caching

- `ModelCost.fromResponse()` — the provider reports each call's cost (OpenRouter's `usage.cost`, the
  Decisions API): exact. `ModelCost.fromPrices({ "<model>": { inputPerMillion: usd(…),
outputPerMillion: usd(…), cachedInputPerMillion?: usd(…) } })` — tokens × the table; a model it does
  not price is `model.no-price` at start. A call with neither fails: never silently free.
- `reasoning` (`Reasoning.modelDecides()`, `.on({ effort: ReasoningEffort.High })`,
  `.on({ budget: { tokens } })`, `.off()`) and `promptCaching` (`PromptCaching.whereSupported({ … })`,
  `.off()`) are required on an HTTP provider (a transport's default to off) and overridden by a
  component (`reasoning`, `cache`).
- At start and with `npx agboss check --models` every model setting is checked against what its
  model supports — all problems at once (`model.unsupported-setting`, `model.unknown-model`; with
  `--models` also `model.no-matching-endpoint` for a pinned host or quantization no endpoint serves);
  nothing is substituted.

## The application

```ts file=src/billing/invoice.workflow.ts
import { Agent, Workflow, WorkflowFinish, WorkflowStart, start } from "@agboss/core";
import { Text, WorkflowStartTextDto } from "@agboss/core/dto";
import { TaxRateTool } from "./tools/tax-rate.tool.js";

export class InvoiceDraftDto {
  @Text({ prompt: "the invoice, with its VAT line" })
  text!: string;
}

@WorkflowStart({ name: "invoice-workflow-start", description: "What to invoice", input: WorkflowStartTextDto })
export class InvoiceWorkflowStart {}

@Agent({
  name: "invoice-agent",
  description: "Drafts an invoice with the right VAT",
  prompt: "Draft the invoice; look the VAT rate up with tax-rate-tool.",
  model: "moonshotai/kimi-k2.6", // served by openrouter-model-provider (backup/kimi while its breaker is open)
  input: { request: WorkflowStartTextDto },
  output: InvoiceDraftDto,
  tools: [TaxRateTool],
})
export class InvoiceAgent {}

@WorkflowFinish({ name: "invoice-workflow-finish", description: "The draft", output: InvoiceDraftDto })
export class InvoiceWorkflowFinish {}

@Workflow({
  name: "invoice-workflow",
  version: "1.0.0",
  flow: [
    start(InvoiceWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(InvoiceAgent)
      .returns(InvoiceDraftDto)
      .toFinish(InvoiceWorkflowFinish),
  ],
  maxSteps: 2,
})
export class InvoiceWorkflow {}
```

```ts file=src/billing/billing.application.ts
import { Application } from "@agboss/core";
import {
  ApplicationDailyBudget,
  ExecutionBudget,
  InvoiceExecutionBudget,
  TenantDailyBudget,
  TenantMonthlyBudget,
} from "./config/budget.config.js";
import { ShopTenantContext } from "./contexts/shop-tenant.context.js";
import { AppEnvironment } from "./environments/app.environment.js";
import { InvoiceWorkflow } from "./invoice.workflow.js";
import { BackupModelProvider } from "./model-providers/backup.model-provider.js";
import { AppOpenRouterModelProvider } from "./model-providers/openrouter.model-provider.js";

@Application({
  name: "billing-application",
  version: "1.0.0",
  environment: AppEnvironment,
  tenantContext: ShopTenantContext,
  workflows: [InvoiceWorkflow],
  budgets: [
    ApplicationDailyBudget,
    TenantDailyBudget,
    TenantMonthlyBudget,
    ExecutionBudget,
    InvoiceExecutionBudget,
  ],
  // the list is complete: no built-in provider is added (no decision model is used here)
  providers: [AppOpenRouterModelProvider, BackupModelProvider],
})
export class BillingApplication {}
```

Each execution names its tenant; the tenant's fields come with it (from your own server-side tenant
data, never from the request body):

<!-- snippet-context
import { createApp } from "@agboss/core";
import { BillingApplication } from "./src/billing/billing.application.js";
import { InvoiceWorkflowStart } from "./src/billing/invoice.workflow.js";
-->

```ts
const app = await createApp(BillingApplication, { env: "prod" });

const result = await app.execute(
  InvoiceWorkflowStart,
  { text: "Invoice 3 hours of consulting to Acme Ltd, Israel" },
  { tenant: { tenantId: "acme", weight: 3, dailyBudgetUsd: 5 } }, // weight: TenantWeighted's share
);

// every result carries its spend: total, calls, by category, model and caller, and every call in order
console.log(result.spend.totalUsd, result.spend.calls, result.spend.byCategory.tools);
for (const call of result.spend.trace) console.log(call.caller, call.model, call.costUsd);
await app.close();
```

`spend.byCategory` has every key — `agents`, `routing`, `guards`, `review`, `tools`, `compaction`,
`retrieval`; callers are named `tool:<name>`, `action:<name>`, `router:<name>`, `guardrail:<name>`,
`arbiter:<name>`, `compaction:<name>`, `rag:<name>`, or the agent's name.

## Testing the money

An exhausted budget is reached the real way — a budget mocked low and a scripted cost; there is no
`limits` option. Scripted models answer above the providers, so the rate limit and the breaker
never slow a test down.

```ts file=tests/billing/budget.test.ts
import { expect } from "vitest";
import { BudgetExceededError, BudgetScope } from "@agboss/core";
import { callTool, replyWith, testWith } from "@agboss/core/testing";
import { usd } from "@agboss/core/units";
import { BillingApplication } from "../../src/billing/billing.application.js";
import { InvoiceExecutionBudget } from "../../src/billing/config/budget.config.js";
import { InvoiceAgent, InvoiceDraftDto, InvoiceWorkflowStart } from "../../src/billing/invoice.workflow.js";
import { TaxRateTool } from "../../src/billing/tools/tax-rate.tool.js";

const test = testWith(BillingApplication);

const TENANT = { tenant: { tenantId: "acme", dailyBudgetUsd: 5 } } as const;

test("a tool's recorded cost is in the spend", async ({ app, mockLlm }) => {
  mockLlm(InvoiceAgent).thenReturn(
    callTool(TaxRateTool, { country: "IL" }),
    replyWith(InvoiceDraftDto, { text: "3 h × $100 + 18% VAT" }),
  );

  const result = await app.execute(InvoiceWorkflowStart, { text: "invoice Acme" }, TENANT);

  expect(result.spend.byCategory.tools).toBeCloseTo(0.001);
});

test("a cost that exhausts the execution budget stops the agent before its next call", async ({
  app,
  mockLlm,
  mockOf,
}) => {
  mockOf(InvoiceExecutionBudget).maxSpend.mockReturnValue(usd(0.0005));
  mockLlm(InvoiceAgent).thenReturn(callTool(TaxRateTool, { country: "IL" })); // the tool records $0.001

  const run = app.execute(InvoiceWorkflowStart, { text: "invoice Acme" }, TENANT);

  await expect(run).rejects.toFailWith(BudgetExceededError, { scope: BudgetScope.Execution });
});
```

A scripted answer can carry a cost too — `replyWith(InvoiceDraftDto, { … }, { cost: usd(0.02) })` —
which stops the execution before its next agent or router step.

## Pitfalls

- A budget amount read from the request: `maxSpend()` reads trusted data — a tenant context the
  server fills, a billing service.
- Retries in a service around a model call: the provider's `retryPolicy` is the only backoff.
- A rate limit per tenant through budgets: budgets are money; capacity is `rateLimitPolicy` and its
  `balancing`.
- Listing one provider and forgetting `DecisionsModelProvider` while using Jev: `[model.unserved]`.
- Expecting the in-memory ledger to share counters: each instance counts alone — list
  `SqliteCostLedgerRepository` (or your own) in production.
