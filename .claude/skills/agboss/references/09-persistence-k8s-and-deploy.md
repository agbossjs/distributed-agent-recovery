# 09 — Persistence, Kubernetes and deploys

Read this when you make an application durable (its stores), run it as several instances, expose
health probes, stop it gracefully, or deploy a new version while executions are paused or running.
Budgets' counters are in reference 06, pauses in reference 05, the undo's durability in reference 02.

## The stores

Every store is an **infrastructure contract** with a built-in **in-memory** default, listed only in
`@Application({ providers })` and found by inheritance (a class that `extends` the contract; two →
`[di.ambiguous-implementation]`, in a workflow's `providers` → `[di.infrastructure-in-workflow]`).
In memory nothing is shared between instances and nothing survives a restart.

| Contract                            | Holds                                                                        | SQLite implementation              |
| ----------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------- |
| `BaseCheckpointSaver` (LangGraph's) | every step's checkpoint: a pause, a crash and a resume continue from it      | `SqliteCheckpointSaver`            |
| `ExecutionRecordRepository`         | threads, owners, execution records, who answered each pause, summaries       | `SqliteExecutionRecordRepository`  |
| `PausedExecutionRepository`         | each pause's record (`Pending → Resolved → Taken`, or `Cancelled`)           | `SqlitePausedExecutionRepository`  |
| `CostLedgerRepository`              | the budgets' counters (reference 06)                                         | `SqliteCostLedgerRepository`       |
| `ExecutionLeaseRepository`          | one lease per execution tree: who moves it                                   | `SqliteExecutionLeaseRepository`   |
| `ExecutionTreeRepository`           | the shared state of one request (cancel requests, the undo's progress marks) | `SqliteExecutionTreeRepository`    |
| `RateLimitRepository`               | a provider's slots, per-minute windows, 429 pause and circuit breaker        | `SqliteRateLimitRepository`        |
| `ExecutionHistoryRepository`        | each root execution's history, only with `executionRecordRetention` (below)  | `SqliteExecutionHistoryRepository` |

The SQLite ones share **one file**, the environment's `sqlitePath` (required only when one is
listed: `[environment.missing-field]`), over one `node:sqlite` connection per instance (the
`SqliteConnection` token), in WAL mode with a 5 s busy timeout; every atomic operation runs in one
`BEGIN IMMEDIATE`, every time value comes from the application's `Clock`. SQLite shares state
between **processes on one machine** (one volume). Several machines need a shared store: list your
own implementation of each contract (below) over Postgres, Redis or the like.

## The worked example: a durable application

```ts file=src/claims/environments/app.environment.ts
import type { Secret } from "@agboss/core";

export class AppEnvironment {
  sqlitePath!: string; // required because SQLite stores are listed
  openRouterApiKey?: Secret;
}
```

```ts file=src/claims/environments/prod.environment.ts
import { env, secret } from "@agboss/core";
import type { AppEnvironment } from "./app.environment.js";

export const environment: AppEnvironment = {
  sqlitePath: env("AGBOSS_SQLITE_PATH", { default: "/data/claims.sqlite" }), // a persistent volume
  openRouterApiKey: secret("OPENROUTER_API_KEY"),
};
```

```ts file=src/claims/environments/test.environment.ts
import type { AppEnvironment } from "./app.environment.js";

export const environment: AppEnvironment = { sqlitePath: ":memory:" };
```

```ts file=src/claims/claims.workflow.ts
import {
  Agent,
  Workflow,
  WorkflowFinish,
  WorkflowSettings,
  WorkflowStart,
  start,
  type IncompatibleResume,
  type ResumeDecision,
  type WorkflowDefinition,
} from "@agboss/core";
import { Text, WorkflowStartTextDto } from "@agboss/core/dto";

export class ClaimAssessmentDto {
  @Text({ prompt: "the assessment of the claim" })
  assessment!: string;
}

@WorkflowStart({ name: "claim-workflow-start", description: "An insurance claim", input: WorkflowStartTextDto })
export class ClaimWorkflowStart {}

@Agent({
  name: "claim-assessor-agent",
  description: "Assesses a claim",
  prompt: "Assess the claim in three sentences.",
  model: "moonshotai/kimi-k2.6",
  input: { claim: WorkflowStartTextDto },
  output: ClaimAssessmentDto,
})
export class ClaimAssessorAgent {}

@WorkflowFinish({ name: "claim-workflow-finish", description: "The assessment", output: ClaimAssessmentDto })
export class ClaimWorkflowFinish {}

/** A paused or running execution of another config hash is continued only when the version is the same. */
const sameVersionOnly = (resume: IncompatibleResume): ResumeDecision =>
  resume.paused.workflowVersion === resume.current.workflowVersion ? "resume" : "reject";

@Workflow({
  name: "claim-workflow",
  version: "1.1.0",
  flow: [
    start(ClaimWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(ClaimAssessorAgent)
      .returns(ClaimAssessmentDto)
      .toFinish(ClaimWorkflowFinish),
  ],
  maxSteps: 1,
})
export class ClaimWorkflow implements WorkflowDefinition {
  settings(): WorkflowSettings {
    return WorkflowSettings.builder()
      .onIncompatibleResume(sameVersionOnly)
      .build();
  }
}
```

```ts file=src/claims/health/claims-api.health-check.ts
import { HealthCheck, HealthCheckResult, Injectable, type HealthCheckHandler } from "@agboss/core";
import { seconds } from "@agboss/core/units";

@Injectable()
export class ClaimsApiService {
  ping(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

@HealthCheck({ name: "claims-api-health-check", timeout: seconds(2), deps: [ClaimsApiService] })
export class ClaimsApiHealthCheck implements HealthCheckHandler {
  constructor(private readonly claimsApiService: ClaimsApiService) {}

  async check(): Promise<HealthCheckResult> {
    return (await this.claimsApiService.ping())
      ? HealthCheckResult.healthy()
      : HealthCheckResult.degraded({ reason: "claims API is slow" }); // still serves
  }
}
```

```ts file=src/claims/claims.application.ts
import {
  Application,
  Budget,
  BudgetPeriod,
  BudgetScope,
  SqliteCheckpointSaver,
  SqliteCostLedgerRepository,
  SqliteExecutionHistoryRepository,
  SqliteExecutionLeaseRepository,
  SqliteExecutionRecordRepository,
  SqliteExecutionTreeRepository,
  SqlitePausedExecutionRepository,
  SqliteRateLimitRepository,
  type BudgetHandler,
} from "@agboss/core";
import { hours, seconds, usd, type Usd } from "@agboss/core/units";
import { ClaimWorkflow } from "./claims.workflow.js";
import { AppEnvironment } from "./environments/app.environment.js";
import { ClaimsApiHealthCheck, ClaimsApiService } from "./health/claims-api.health-check.js";

@Budget({ name: "application-daily-budget", scope: BudgetScope.Application, period: BudgetPeriod.Day })
export class ApplicationDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(100);
  }
}

@Budget({ name: "tenant-daily-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
export class TenantDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(10);
  }
}

@Budget({ name: "execution-budget", scope: BudgetScope.Execution })
export class ExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.1);
  }
}

@Application({
  name: "claims-application",
  version: "1.1.0",
  environment: AppEnvironment,
  workflows: [ClaimWorkflow],
  budgets: [ApplicationDailyBudget, TenantDailyBudget, ExecutionBudget],
  providers: [
    // every store durable and shared: no [application.in-memory-…] warning
    SqliteCheckpointSaver,
    SqliteExecutionRecordRepository,
    SqlitePausedExecutionRepository,
    SqliteCostLedgerRepository,
    SqliteExecutionLeaseRepository,
    SqliteExecutionTreeRepository,
    SqliteRateLimitRepository,
    SqliteExecutionHistoryRepository,
    ClaimsApiService,
  ],
  healthChecks: [ClaimsApiHealthCheck],
  shutdownTimeout: seconds(25), // under the platform's 30 s grace period and the 30 s lease
  pauseRecordRetention: hours(24), // resolved pause records kept this long, then swept
  executionRecordRetention: hours(24 * 30), // each root execution's history, 30 days after it ended
  compensationTimeout: seconds(15), // each automatic undo's clean-up signal
  maxConcurrentSteps: 32, // agent, router and action steps of this instance at once
})
export class ClaimsApplication {}
```

The process: `createApp` closes the app on SIGTERM / SIGINT by itself; the project's server maps the
probes to its endpoints (`Unhealthy` → 503, anything else 200 — a `Degraded` instance still serves):

```ts file=src/claims/main.ts
import { createServer } from "node:http";
import { HealthStatus, createApp, type HealthReport } from "@agboss/core";
import { ClaimsApplication } from "./claims.application.js";
import { ClaimWorkflowStart } from "./claims.workflow.js";

const app = await createApp(ClaimsApplication, { env: "prod" }); // listens for SIGTERM / SIGINT

const probeOf = (path: string | undefined): Promise<HealthReport> | undefined =>
  path === "/livez" ? app.checkLiveness() : path === "/readyz" ? app.checkReadiness() : undefined;

createServer((request, response) => {
  const probe = probeOf(request.url);
  if (probe !== undefined) {
    void probe.then((report: HealthReport) => {
      response.writeHead(report.status === HealthStatus.Unhealthy ? 503 : 200, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify(report));
    });
    return;
  }
  void app
    .execute(ClaimWorkflowStart, { text: "a claim" }, { tenant: { tenantId: "acme" } })
    .then((result) => response.end(JSON.stringify(result.output)));
}).listen(8080);
```

## Health probes

`app.checkLiveness()` / `app.checkReadiness()` → `HealthReport { status, components }` — never a
rejection; `status` is the worst component's `HealthStatus.Healthy | Degraded | Unhealthy`, each
`HealthComponentReport { name, kind: HealthComponentKind, status, reason?, duration }`.

| Probe     | Components                                                                                                                                                                                                                                                                    |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| liveness  | no I/O: the application (`Unhealthy`, `stopping` from `app.close()` on) and the recovery loop (`Unhealthy` when its last sweep ended over 90 s ago)                                                                                                                           |
| readiness | liveness's, every store's `ping()` (`seconds(2)` each), every model provider's circuit breaker (open → `Degraded`), the step slots when `maxConcurrentSteps` is set (all busy → `Degraded`), every `@HealthCheck` of `@Application({ healthChecks })` under its own `timeout` |

A check that throws or times out is that component's `Unhealthy`. `HealthCheckResult.healthy()` /
`.degraded({ reason })` / `.unhealthy({ reason })` are the only results (a plain object does not
compile); `[health.not-a-health-check]`, `[health.duplicate-name]`.

## Several instances

- **The lease.** `execute` / `resume` move a tree only while holding its lease (keyed by `tenantId`
  and the root execution id, `seconds(30)`, renewed every 10 s and before every checkpoint write).
  A holder that lost it stops: its call rejects with `ExecutionLeaseLostError` — no `.onError`, no
  failed record; the new holder owns the execution.
- **Recovery.** Every instance looks for `running` roots at start and every 30 s, takes the lease of
  one whose holder died or stopped, and continues it from its last checkpoint — only the interrupted
  step runs again (`onExecutionResume` with `ResumeReason.Recovered`; the log's
  `execution.recovered`). An interrupted automatic undo is finished the same way.
- **At least once.** A step can run twice (a crash after its side effect, before its checkpoint):
  pass `executionContext.step.idempotencyKey` —
  `${executionId}:${nodeId}:${visitNumber}[:${itemIndex}][:${callId}]`, the same on a rerun — to
  every external side effect, and make each undo safe to run twice.
- **Any instance answers.** A pause made on one instance is resumed on another; `app.cancel` reaches
  the tree on whichever instance moves it.
- **The cap on steps.** `@Application({ maxConcurrentSteps })` (a whole number from 1,
  `[limits.max-concurrent-steps-invalid]`; unset → no cap) bounds the agent, router and action steps
  one instance runs at once over every tree and tenant — a queue, never an error; readiness is
  `Degraded` while every slot is busy, and the recovery sweep starts at most its free slots' worth.
- **PII tokens** are the same on every instance only with `@Application({ pseudonymKey })` (reference 07).

## A graceful stop

`app.close({ timeout? })` (and SIGTERM / SIGINT through `createApp`):

1. no new execution: `execute` / `resume` reject with `ApplicationStoppingError` (`app.stopping`),
   observers get `onExecutionRejected`; `cancel` still works; liveness turns `Unhealthy`;
2. the instance's recovery sweep stops, then every component's `onStop`;
3. running executions are awaited until a grace before the end of the shutdown timeout
   (`@Application({ shutdownTimeout })`, default `seconds(25)`; the grace `min(5 s, 20 %)`), then
   interrupted — their calls reject with `ApplicationStoppingError`, their leases are released at
   once, their records stay `running`, so another instance continues them at its next sweep;
4. the step bodies still running get the grace (a lease is released only once its tree's bodies
   returned, so no other instance reruns a step meanwhile), then `onDestroy` and the connections close.

`app.close({ timeout: seconds(0) })` interrupts at once. A second signal while stopping interrupts at
once too. `testWith` never listens for signals.

## Kubernetes

```yaml
# deployment.yaml — one pod per instance; SQLite needs every replica on one node and one volume
apiVersion: apps/v1
kind: Deployment
metadata:
  name: claims
spec:
  replicas: 1 # more replicas on several nodes: your own shared stores instead of SQLite
  template:
    spec:
      terminationGracePeriodSeconds: 30 # above shutdownTimeout (25 s)
      containers:
        - name: claims
          image: registry.example.com/claims:1.1.0
          env:
            - name: AGBOSS_SQLITE_PATH
              value: /data/claims.sqlite
            - name: OPENROUTER_API_KEY
              valueFrom: { secretKeyRef: { name: claims, key: openrouter-api-key } }
          livenessProbe: { httpGet: { path: /livez, port: 8080 }, periodSeconds: 10 }
          readinessProbe: { httpGet: { path: /readyz, port: 8080 }, periodSeconds: 5 }
          volumeMounts: [{ name: data, mountPath: /data }]
      volumes:
        - name: data
          persistentVolumeClaim: { claimName: claims-data }
```

`npx agboss check --env prod` lists the process variables the environment needs (names only, `value`
or `secret`, `optional` / `has a default`) — the list for the manifest.

## Deploying a new version

- **The config hash** (`configHash`, printed by `npx agboss describe --json` and carried by every
  record, event and trace) is the fingerprint of a workflow's config, flow and every text its models
  read — its child workflows' included.
- A paused or running execution started under another hash is **not** continued by an instance of
  the new version unless the workflow's `onIncompatibleResume` policy says `"resume"`
  (`implements WorkflowDefinition`, `settings()` above): `app.resume` rejects with
  `IncompatibleResumeError` (`resume.incompatible`) and the execution stays paused; recovery leaves
  such a root to an instance of a compatible version (logged once, `recovery.incompatible`).
- So a rolling deploy works as: new instances start next to the old ones; old ones finish or pause
  their executions and stop gracefully; executions the policy refuses wait for an instance of their
  version. A workflow's name is unique in one application (`[application.duplicate-workflow]`): two
  versions of one workflow do not run side by side in one application — keep the old version
  deployed until its paused executions are answered, or accept them with the policy.
- Resolved pause records are kept `pauseRecordRetention` (default `hours(24)`), then removed by the
  sweep: a late answer is `NotPausedError` within it, `UnknownPauseError` after. `Pending` is never
  removed.

## Execution history: `executionRecordRetention` and `agboss records export`

Nothing of an execution is kept beyond its thread's turns unless the application says how long:
`@Application({ executionRecordRetention: hours(24 * 30) })`. Then every **root** execution's
`ExecutionHistoryRecord` is saved in the `ExecutionHistoryRepository` — when its tree rests at a
pause (`ExecutionHistoryStatus.Paused`, no `endedAt`) and when it ends (`Finished`, `Failed` or
`Cancelled`, with its `error`) — and the recovery sweep removes it once it ended longer ago than the
retention (a paused one is never removed). A record is the execution's `ExecutionRecord` (path,
scope, spend, children, pauses and who answered them, undo actions, `toolCalls`, `steps`, `origin`)
with who and what it was: `executionId`, `rootExecutionId`, `threadId`, `tenantId`, `application`
(name, version, instance), `workflow` (with its `configHash`), `start` and `input`, `finish` and
`output`, `startedAt` / `endedAt` on the `Clock`, and the `contexts` values. It is **masked like the
execution's traces**: the application's and the workflow's PII policies, a context field marked
`sensitive` hidden — a record never holds what a trace would not show. A save that fails is a
warning in the log (`execution-history.failed`), never the execution's failure; work handed over
(a lost lease, the app's stop) saves nothing — the next holder does.

On the built-in in-memory store it warns `[application.in-memory-execution-history]` (another
instance and the CLI do not see it); list `SqliteExecutionHistoryRepository` (or your own) to keep
it. Export it without running anything — the application's stores opened, no workflow built, no
sweep:

```
npx agboss records export --env prod --tenant acme --since 2026-10-16 --out hub/records/acme.jsonl
npx agboss records export --env prod --all-tenants --out hub/records/all.jsonl
```

One masked record per line, oldest start first, each `{ "kind": "agboss.execution-record",
"schema": 1, …record }`. A tenant is always named (`--tenant <id>`) or every tenant explicitly
(`--all-tenants`) — neither or both is `records.tenant-required` (exit 2); `--since` / `--until`
take an ISO 8601 date or time (records started in `[since, until)`); an application without
`executionRecordRetention` is `records.not-kept` (exit 3).

## The Mesh Hub: `agboss hub show`

Many applications' files form one picture of the mesh — no project, no application assembled, no
network. Each service's CI saves what it has; a platform repo reads the folder:

```
npx agboss describe --json > hub/desk-application/describe.json
npx agboss eval run --suite refunds-eval-suite --runs 5 --env eval --report hub/desk-application/refunds.run.json
npx agboss records export --env prod --tenant acme --since 2026-10-16 --out hub/desk-application/records/acme.jsonl
npx agboss hub show hub/ --html .artifacts/mesh.html
```

- Inputs are files and folders only (a folder's `*.json` / `*.jsonl`, any depth), each known by its
  own marker: a `describe --json` envelope (`command: "describe"`), a run artifact (`kind:
"agboss.eval-run"`), an export (`kind: "agboss.execution-record"` per line). Anything else, or a
  newer schema, is `hub.input-schema` naming the file (and the line); two snapshots of one
  application version `hub.duplicate-application`; a missing path `hub.input-not-found` (all exit 3).
- The page (`--html`, one self-contained file in the eval report's shell: inline style and script by
  hash, no request — share it behind your own SSO) shows the **mesh graph** (each application, solid
  when a snapshot describes it, dashed when only records or runs name it), the **observed edges** — a
  caller's `toolCalls[].remote` and a receiver's `origin`, one call counted once by its step's
  `idempotencyKey` (never by tenant) — and a card per application: its workflows with their agents,
  routers, actions, child workflows, tools and MCP servers, its channel roles, and its **health from
  its files only**: executions, failure rate, p95 duration, spend and spend per day from its records,
  the `limit.*` / `mesh.*` codes they failed with, and the latest run of each eval suite (pass^k,
  pass@k, unstable). Nothing live: probes stay the orchestrator's (`app.checkReadiness()`).
- **Execution trees across applications**: each tree that crosses applications, stitched from the
  exports by each receiver's `origin` — a record is a child of the execution whose `executionId` is
  `origin.executionId` (a root's or one of its children's), under the call whose step
  `idempotencyKey` is `origin.step.idempotencyKey`; never by tenant. A call whose receiver exported
  nothing is a stub (`billing-application · b1 (not exported)`), not an error; a receiver whose
  caller's record holds no such call is a root of its own, "called by" its caller. `--json` lists
  each tree's root, applications, executions and stubs.
- **The crystallization radar**: every model step (an agent or router with model calls) of the
  records, per application, workflow and step, ranked by **spend × stability** — stability is the
  share of the most frequent `steps[].decision` among the calls with the same `inputHash`, over the
  inputs seen at least twice. A **candidate** to turn into code (`DecidedBy.Code`, an `@Action`) has
  at least 50 calls, stability ≥ 0.95 and, where its workflow has eval runs, pass^k on every case of
  their latest; each row names its calls, spend, stability, pass^k and the executions behind it.
- **Blast radius & federation**: every contract a snapshot declares (`application.contracts`, an
  `@A2AAgent` or an `@McpServer` tool with a target) is a **declared edge**, consumer → producer —
  dashed in the graph when no record shows a call, a producer no snapshot describes a dashed box
  ("producer not among the inputs"). The problems are `agboss check --federation`'s own: the hub
  calls the same `checkFederation` over the newest snapshot of every application, so it lists the
  same `[federation.incompatible-schema]` / `[federation.missing-target]` with the same blast radius
  (the consumer's workflows and tools), and draws a broken contract red. Beside them, each
  application whose latest eval run lost pass^k with its callers — by a declared contract and by
  calls the records saw. A snapshot from an agboss without `contracts` is named, never guessed.
- **Served**: `npx agboss hub ui hub/ [--port 4318]` — the same files on 127.0.0.1 behind the token it
  prints, on `eval ui`'s server and rules (its own `Host` only, no CORS, read-only — GET and HEAD),
  read again on every request: the page, `/records` (every export's executions searched by
  application, workflow, status, a start window and a text in an id, a page at a time) and the JSON
  API `/api/mesh`, `/api/applications/<name>`, `/api/trees/<rootExecutionId>`, `/api/records?…`,
  `/api/radar`, `/api/blast-radius`. It is for one person on their own machine; share the static page instead.
- Above 16 MB the page is refused (`hub.report-too-large`): export a shorter period. Without
  `--html` it prints the summary; `--json` gives the applications, the inputs, the observed and declared edges, the trees, the
  radar and the federation's problems.

## Your own store and application repositories

Every class with a direct database connection or store contract lives in `repositories/<name>.repository.ts`
(never in `services/`). Keep SQL DDL in `sql/<name>.sql` files, define table schemas in
`schemas/<name>.schema.ts` using a typed ORM / query builder (such as Drizzle ORM), and never build
queries with string interpolation (`SELECT … ${clause}`).

A project's store implementation `extends` the contract (or a SQLite one, with `override`) and is
listed in `@Application({ providers })` **instead of** it. A SQLite subclass takes the base's `deps`
first — `SqliteConnection`, `Clock`, `ApplicationContext` (and `IdGenerator` for the records):

```ts file=src/claims/services/lease-audit.service.ts
import { Injectable, type ExecutionLease } from "@agboss/core";

@Injectable()
export class LeaseAuditService {
  taken(lease: ExecutionLease): void {
    void lease;
  }
}
```

```ts file=src/claims/repositories/audited-lease.repository.ts
import {
  ApplicationContext,
  Clock,
  Injectable,
  SqliteConnection,
  SqliteExecutionLeaseRepository,
  type ExecutionLease,
} from "@agboss/core";
import type { Milliseconds } from "@agboss/core/units";
import { LeaseAuditService } from "../services/lease-audit.service.js";

/** The SQLite leases, each one taken written to the audit log as well. */
@Injectable({ deps: [SqliteConnection, Clock, ApplicationContext, LeaseAuditService] })
export class AuditedSqliteExecutionLeaseRepository extends SqliteExecutionLeaseRepository {
  constructor(
    connection: SqliteConnection,
    clock: Clock,
    applicationContext: ApplicationContext,
    private readonly leaseAuditService: LeaseAuditService,
  ) {
    super(connection, clock, applicationContext);
  }

  override async acquire(
    tenantId: string,
    rootExecutionId: string,
    lease: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    const taken = await super.acquire(tenantId, rootExecutionId, lease);
    if (taken !== undefined) this.leaseAuditService.taken(taken);
    return taken;
  }
}
```

An implementation over another store keeps every operation atomic, takes every time value from the
framework (durations as parameters, now from `Clock`), never from the store's clock, and implements
`ping()` — one fast round trip that readiness calls.

## Testing it

```ts file=tests/claims/health.test.ts
import { expect } from "vitest";
import { HealthStatus } from "@agboss/core";
import { replyWith, testWith } from "@agboss/core/testing";
import { ClaimsApplication } from "../../src/claims/claims.application.js";
import { ClaimAssessmentDto, ClaimAssessorAgent, ClaimWorkflowStart } from "../../src/claims/claims.workflow.js";

const test = testWith(ClaimsApplication); // the test environment: sqlitePath ":memory:"
const twoInstances = testWith(ClaimsApplication, { instances: 2 });

test("ready on its stores; a closing instance is not live", async ({ app }) => {
  await app.ready();
  expect((await app.checkReadiness()).status).toBe(HealthStatus.Healthy);

  await app.close();

  expect((await app.checkLiveness()).status).toBe(HealthStatus.Unhealthy);
});

twoInstances("two instances share one set of stores", async ({ app, apps, mockLlm }) => {
  mockLlm(ClaimAssessorAgent).thenReturn(replyWith(ClaimAssessmentDto, { assessment: "Covered." }));

  const result = await app.execute(ClaimWorkflowStart, { text: "a broken window" }); // apps[0]

  expect(result.output).toEqual({ assessment: "Covered." });
  expect(apps).toHaveLength(2);
  await expect(apps[1]?.checkReadiness()).resolves.toMatchObject({ status: HealthStatus.Healthy });
});
```

`testWith(App, { instances: 2 })` gives `apps` — two instances, each its own container, over one set
of stores and one `clock`: a pause resumed on the other instance, a lease taken over after
`await clock.advance(seconds(31))`, a recovery at the next sweep. The in-memory defaults are shared
between the instances; listed SQLite stores are shared only through a file. Each instance opens its
own connection, and `sqlitePath: ":memory:"` is one database per connection, so on `:memory:` the
two instances see nothing of each other. A multi-instance test runs on an environment with a temp
file (`sqlitePath: join(mkdtempSync(join(tmpdir(), "app-")), "stores.sqlite")`) —
`testWith(App, { instances: 2, env: "instances" })` (#458).

## Pitfalls

- In-memory stores in production: pauses vanish on restart (`[application.in-memory-pauses]`),
  budgets count per instance (`[application.in-memory-cost-ledger]`).
- SQLite across machines: one file is one machine; several nodes need shared implementations.
- Holding a `node:sqlite` (`DatabaseSync`) `BEGIN IMMEDIATE` write lock across an `await` (for
  example through an async ORM proxy): when `testWith(App, { instances: 2 })` runs two instances on
  one Node.js event loop over one SQLite file, the sibling connection blocks synchronously inside
  `sqlite3_busy_timeout` and self-deadlocks with `SQLITE_BUSY`. Execute `BEGIN IMMEDIATE … COMMIT`
  synchronously in one JS turn without yielding microtasks inside the open write transaction.
- Relying on `LeasedCheckpointSaver` alone for external writes: `ExecutionLeaseLostError` fences
  checkpoint saves after a step returns, not external database or filesystem mutations executed inside
  an `@Action` or `@Tool` body before returning — enforce monotonic `leaseEpoch` fencing tokens plus
  `executionContext.step.idempotencyKey` at the external repository boundary.
- Multi-process `ChildPlacement.AnyInstance` queue behavior: `remoteChildSignals` is process-local, so
  separate OS worker processes discover queued children on the 30 s worker sweep and greedily drain up
  to their free `maxConcurrentSteps` slots; measure sibling fairness windows from `min(claimed_at)`
  (not `queued_at`) and re-queue `Running` children whose peer `execution_leases` row expired.
- Missing non-TypeScript assets in `dist/`: plain `tsc` does not copy `*.prompt.md` (`promptUrls`) or
  `sql/*.sql` files into `dist/`, causing `PromptError: [prompt.missing-file]` when running compiled
  `node dist/…` in containers — copy non-`.ts` assets from `src/` into `dist/src/` during `npm run build`.
- A side effect without `step.idempotencyKey`: a recovered step runs again.
- `terminationGracePeriodSeconds` below `shutdownTimeout`: the platform kills the pod mid-drain.
- Expecting a new version to pick up an old paused execution: it is refused unless
  `onIncompatibleResume` says `"resume"`.
