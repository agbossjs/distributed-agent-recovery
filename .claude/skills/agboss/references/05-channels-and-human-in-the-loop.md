# 05 — Channels and human in the loop

Read this when a tool call must be approved by a person or a system before it runs, when an
execution pauses and is answered later (`app.resume`), or when a reply arrives as free text.
Tools themselves: `03-components-di-and-lifecycle.md`; durable stores: `09-persistence-k8s-and-deploy.md`.

## How a pause works

1. A `@Tool({ channel })` (or `@McpTool`) names a **channel role** — a project's abstract class
   `@ChannelRole({ approves: ToolInputDto, answeredBy })` that `extends ChannelOf<Self>`.
2. Before every call of that tool the framework creates a pause record (`PausedExecutionRepository`,
   keyed by the step's idempotency key) and calls the role's one implementation —
   `send(ask: ChannelAsk<Role>)`, `ask = { pauseId, value }` (`value.arguments` typed by the tool's input).
3. `send` returns `ChannelOutcome.decided(decision)` (go on at once — a rule decided) or
   `ChannelOutcome.awaitReply()` (the execution rests, `result.status === ExecutionStatus.Paused`,
   `result.pending: PendingPause[]`).
4. Later, a webhook, a CLI or a scheduler answers by the pause's id: `app.resume({ pauseId,
decision }, { tenantId, answeredBy | ownerId })` — or with free text, `{ pauseId, reply }`, read
   by the role's `@ReplyInterpreter`. Approved → the tool runs once (with `overrideArguments` if
   given); rejected → the model reads `Tool error: the call was rejected …` and goes on.

There is no pause step in the flow: a pause is always a tool call through a channel. Nothing waits
in memory — a pause survives a restart when the pause store and the checkpointer are durable.

## A worked example: refunds approved in Slack

```ts file=src/refunds/dtos/refund.dto.ts
import { Integer, Text } from "@agboss/core/dto";

export class RefundRequestDto {
  @Text({ prompt: "the order to refund" })
  orderId!: string;

  @Integer({ prompt: "the amount in cents", min: 1 })
  amountCents!: number;
}

export class RefundDoneDto {
  @Text({ prompt: "the refund's id" })
  refundId!: string;
}
```

```ts file=src/refunds/services/slack-client.service.ts
import { Injectable } from "@agboss/core";

@Injectable()
export class SlackClientService {
  postApproval(_replyKey: string, _text: string): Promise<void> {
    return Promise.resolve(); // posts the message with buttons keyed by the reply key
  }

  closeApproval(_replyKey: string, _text: string): Promise<void> {
    return Promise.resolve(); // replaces the buttons with a note
  }
}
```

```ts file=src/refunds/channels/refund-approval.channel.ts
// channels/refund-approval.channel.ts — the role: what it approves and who may answer
import { ChannelOf, ChannelRole, DecidedBy, PauseAnswerer, ReplyInterpretation, ReplyInterpreter } from "@agboss/core";
import type { InputOf, OutputOf, ReplyInterpreterHandler } from "@agboss/core";
import { RefundRequestDto } from "../dtos/refund.dto.js";

// free text → a decision, by code (DecidedBy.Model: a chat model, or a decision model for yes / no)
@ReplyInterpreter({
  name: "refund-reply-interpreter",
  description: "Reads a manager's Slack reply to a refund",
  decidedBy: DecidedBy.Code,
})
export class RefundReplyInterpreter implements ReplyInterpreterHandler<RefundReplyInterpreter> {
  interpret(input: InputOf<RefundReplyInterpreter>): ReplyInterpretation<OutputOf<RefundReplyInterpreter>> {
    const reply: string = input.reply.trim().toLowerCase(); // input.ask is the original question
    if (reply === "approve") return ReplyInterpretation.understood({ approved: true });
    if (reply.startsWith("reject")) return ReplyInterpretation.understood({ approved: false, reason: reply });
    return ReplyInterpretation.notUnderstood({ reason: `not "approve" or "reject …": ${input.reply}` });
  }
}

@ChannelRole({
  name: "refund-approval-channel",
  description: "A manager approves refunds",
  approves: RefundRequestDto, // must be the input of every tool naming the role ([channel.wrong-tool])
  answeredBy: PauseAnswerer.Channel, // required: Slack authenticates who answers
  replyInterpreter: RefundReplyInterpreter, // one interpreter belongs to one role
})
export abstract class RefundApprovalChannel extends ChannelOf<RefundApprovalChannel> {}
```

```ts file=src/refunds/channels/slack-refund-approval.channel.ts
// channels/slack-refund-approval.channel.ts — the role's one implementation: infrastructure
import { Channel, ChannelOutcome, ExecutionContext, PauseResolution } from "@agboss/core";
import type { ChannelAsk, ChannelWithdrawal } from "@agboss/core";
import { SlackClientService } from "../services/slack-client.service.js";
import { RefundApprovalChannel } from "./refund-approval.channel.js";

const AUTO_APPROVE_CENTS = 5000;

@Channel({
  name: "slack-refund-approval-channel",
  description: "Asks a manager in Slack; small refunds are approved at once",
  deps: [SlackClientService, ExecutionContext],
})
export class SlackRefundApprovalChannel extends RefundApprovalChannel {
  constructor(
    private readonly slackClientService: SlackClientService,
    private readonly executionContext: ExecutionContext,
  ) {
    super();
  }

  async send(ask: ChannelAsk<RefundApprovalChannel>): Promise<ChannelOutcome<RefundApprovalChannel>> {
    const { orderId, amountCents } = ask.value.arguments; // typed by RefundRequestDto
    if (amountCents <= AUTO_APPROVE_CENTS)
      return ChannelOutcome.decided({ approved: true, reason: "under the auto-approve limit" });
    const tenantId: string = this.executionContext.tenant.tenantId;
    // the pauseId is the reply key — and the idempotency key: a retried send gets the same one
    await this.slackClientService.postApproval(ask.pauseId, `Refund ${orderId} (${tenantId})?`);
    return ChannelOutcome.awaitReply();
  }

  // once, when a sent pause closes without an answer (a FailFast sibling, a cancel, the tree ended)
  override async withdraw(withdrawal: ChannelWithdrawal<RefundApprovalChannel>): Promise<void> {
    const why: string = withdrawal.resolution === PauseResolution.Withdrawn ? "no longer needed" : "cancelled";
    await this.slackClientService.closeApproval(withdrawal.pauseId, why);
  }
}
```

```ts file=src/refunds/tools/refund.tool.ts
// tools/refund.tool.ts — names the role; runs only once a call is approved
import { ExecutionContext, Tool, type ToolHandler } from "@agboss/core";
import { RefundApprovalChannel } from "../channels/refund-approval.channel.js";
import { RefundDoneDto, RefundRequestDto } from "../dtos/refund.dto.js";

@Tool({
  name: "refund-tool",
  description: "Refunds an order",
  input: RefundRequestDto,
  output: RefundDoneDto,
  channel: RefundApprovalChannel, // the role, never the implementation
  deps: [ExecutionContext],
})
export class RefundTool implements ToolHandler<RefundRequestDto, RefundDoneDto> {
  constructor(private readonly executionContext: ExecutionContext) {}

  run({ orderId }: RefundRequestDto): Promise<RefundDoneDto> {
    return Promise.resolve({ refundId: `${orderId}:${this.executionContext.step.idempotencyKey}` });
  }
}
```

```ts file=src/refunds/environments/app.environment.ts
export class AppEnvironment {
  sqlitePath!: string; // the Sqlite* stores read it ([environment.missing-field] without it)
}
```

```ts file=src/refunds/environments/test.environment.ts
import type { AppEnvironment } from "./app.environment.js";

export const environment: AppEnvironment = { sqlitePath: ":memory:" };
```

```ts file=src/refunds/refunds.application.ts
import { Agent, Application, Budget, BudgetPeriod, BudgetScope, SqliteCheckpointSaver, SqlitePausedExecutionRepository, Workflow, WorkflowFinish, WorkflowStart, start, type BudgetHandler } from "@agboss/core";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "@agboss/core/dto";
import { usd, type Usd } from "@agboss/core/units";
import { SlackRefundApprovalChannel } from "./channels/slack-refund-approval.channel.js";
import { AppEnvironment } from "./environments/app.environment.js";
import { SlackClientService } from "./services/slack-client.service.js";
import { RefundTool } from "./tools/refund.tool.js";

@Agent({
  name: "refund-agent",
  description: "Refunds orders on request",
  prompt: "Refund the order the customer names, with refund-tool.",
  model: "moonshotai/kimi-k2.6",
  tools: [RefundTool],
})
export class RefundAgent {}

@WorkflowStart({ name: "refund-workflow-start", description: "A request", input: WorkflowStartTextDto })
export class RefundWorkflowStart {}

@WorkflowFinish({ name: "refund-workflow-finish", description: "The answer", output: WorkflowFinishTextDto })
export class RefundWorkflowFinish {}

@Workflow({
  name: "refund-workflow",
  version: "1.0.0",
  flow: [
    start(RefundWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(RefundAgent)
      .toFinish(RefundWorkflowFinish),
  ],
  providers: [SlackClientService], // services in the workflow…
})
export class RefundWorkflow {}

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
    return usd(0.1);
  }
}

@Application({
  name: "refunds-application",
  version: "1.0.0",
  environment: AppEnvironment,
  workflows: [RefundWorkflow],
  budgets: [ApplicationDailyBudget, TenantDailyBudget, ExecutionBudget],
  providers: [
    SlackRefundApprovalChannel, // …the channel implementation in the application
    SqlitePausedExecutionRepository, // pauses survive a restart: a durable pause store…
    SqliteCheckpointSaver, // …and a durable checkpointer, both
  ],
})
export class RefundsApplication {}
```

## Answering

<!-- snippet-context
import type { App } from "@agboss/core";
declare const app: App;
declare const pauseId: string;
-->

```ts
// the Slack webhook: the button's reply key is the pauseId the channel was sent
const result = await app.resume(
  { pauseId, decision: { approved: true } }, // a ToolCallApprovalDecisionDto, validated first
  { tenantId: "acme", answeredBy: "manager-17", record: true }, // Channel role → answeredBy
);
console.log(result.status, result.pending.length, result.record?.pauses); // who answered what

// approve with corrected arguments, bypassing the model (only with approved: true)
await app.resume(
  { pauseId, decision: { approved: true, overrideArguments: { orderId: "7", amountCents: 900 } } },
  { tenantId: "acme", answeredBy: "manager-17" },
);

// a free-text reply, read by the role's reply interpreter
await app.resume({ pauseId, reply: "reject: duplicate" }, { tenantId: "acme", answeredBy: "manager-17" });
```

| `answeredBy` of the role    | `app.resume` takes                                       | Where the `pauseId` is              |
| --------------------------- | -------------------------------------------------------- | ----------------------------------- |
| `PauseAnswerer.ThreadOwner` | `ownerId` — the thread's owner (else `ThreadOwnerError`) | `result.pending[i].pauseId`         |
| `PauseAnswerer.Channel`     | `answeredBy` — non-empty, recorded                       | only in the channel's `ask.pauseId` |

The wrong credential for the role is `PauseAnswererError`. The contract of every channel is
`ChannelHandler<Role>` — `send(ask)` and an optional `withdraw(withdrawal)`; a role's implementation
gets it by extending the role (`ChannelOf<Role>` implements it, `withdraw` a no-op you `override`). Ready-made concrete channels named on a
tool as is: `TerminalUserChannel` (answered in the terminal by `npx agboss chat` / `run`),
`AutoApproveChannel`, `AutoRejectChannel` (decide at once — scripts and tests).

## The pause's life and its records

- **`PendingPause`** (`result.pending`): `pauseId?` (ThreadOwner roles only), `answeredBy`, `agent`,
  `channel`, `ask` (the `ToolCallApprovalAskDto`: `tool`, `arguments`, `summary`, `callId` —
  `sensitive` fields masked), `itemIndex`, `childExecutionId` (a pause in a child workflow is the
  root's). Parallel branches pause on their own; the execution rests when nothing else can move,
  and answering one continues it while the rest keep waiting.
- **`PauseStatus`**: `Pending` → `Resolved` (an answer recorded, atomically) → `Taken` (its step went
  on), or `Cancelled` (withdrawn). An answer to anything but `Pending` → `NotPausedError` (a double
  click); an unknown id or another tenant's → `UnknownPauseError`. Resolved records are kept
  `@Application({ pauseRecordRetention: hours(24) })`, then removed by the recovery sweep.
- **`PauseAnswerRecord`** (`result.record.pauses`, with `{ record: true }`) — the permanent history:
  `pauseId`, `executionId`, `step`, `role`, `answeredBy`, `responder`, `resolution`
  (`PauseResolution.Decided` | `Replied` | `Withdrawn` | `Cancelled`), `askedAt`, `resolvedAt`, the
  masked `decision`. A child's own are in its `ChildExecutionRecord.pauses`.
- **`withdraw(withdrawal)`** is called once when a sent pause closes without an answer
  (`PauseResolution.Withdrawn` / `Cancelled`), best-effort: a failure is a `channel.withdraw-failed`
  warning, nothing else.
- **Free text** that cannot be read throws `UninterpretableReplyError` (`pause.uninterpretable-reply`,
  `reason`) and the pause stays `Pending`; a role without `replyInterpreter` →
  `ReplyInterpreterMissingError`. Exactly one of `decision` / a non-empty `reply`, else
  `DtoValidationError`.
- **Timeouts** are not a channel's job: a scheduler answers with
  `{ approved: false, reason: "timed out" }` and its own `answeredBy`.
- `app.cancel(threadId, { tenantId })` withdraws a paused thread's pauses (the channel's `withdraw` is
  told).

## Testing a pause

<!-- snippet-context
import { ChannelOutcome } from "@agboss/core";
import { callTool, replyWith, testWith } from "@agboss/core/testing";
import { expect } from "vitest";
import { RefundAgent, RefundsApplication, RefundWorkflowFinish, RefundWorkflowStart } from "./src/refunds/refunds.application.js";
import { SlackRefundApprovalChannel } from "./src/refunds/channels/slack-refund-approval.channel.js";
import { RefundTool } from "./src/refunds/tools/refund.tool.js";
-->

```ts
const test = testWith(RefundsApplication);

test("a large refund waits for the manager, then runs", async ({ app, mockLlm, mockOf }) => {
  mockOf(SlackRefundApprovalChannel).send.mockResolvedValue(ChannelOutcome.awaitReply());
  mockLlm(RefundAgent).thenReturn(
    callTool(RefundTool, { orderId: "7", amountCents: 90_000 }),
    replyWith("Refunded order 7."),
  );

  const paused = await app.execute(RefundWorkflowStart, { text: "refund order 7" });
  expect(paused.pending).toHaveLength(1);
  const [ask] = mockOf(SlackRefundApprovalChannel).send.mock.calls[0] ?? [];

  const done = await app.resume(
    { pauseId: ask?.pauseId ?? "", decision: { approved: true } },
    { answeredBy: "manager-17" },
  );
  expect(done).toFinishWith(RefundWorkflowFinish, { text: "Refunded order 7." });
});
```

- `mockOf(Implementation).send.mockResolvedValue(ChannelOutcome.decided({ approved: true }))` decides
  at once; `testWith(App, { overrides: [override(RefundApprovalChannel, AutoApproveChannel)] })`
  replaces the role's implementation for the whole test.
- A model reply interpreter is scripted by its input: `mockLlm(Interpreter).when({ reply: "ok" })
.thenReturn(replyWith(ToolCallApprovalDecisionDto, { approved: true }))`; one on a decision model
  with `decideWith({ approved: 0.9 })`.

## Rule codes and errors

| Code / error                              | Cause → fix                                                                                        |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `[channel.wrong-tool]`                    | the role's `approves` is not the tool's `input` → make them the same DTO                           |
| `[di.missing-implementation]`             | a role named on a tool, no `@Channel` that `extends` it listed → list one in the application       |
| `[di.ambiguous-implementation]`           | two implementations of one role → keep one (one per application)                                   |
| `[di.infrastructure-in-workflow]`         | the implementation in `@Workflow({ providers })` → `@Application({ providers })`                   |
| `[channel.shared-interpreter]`            | one `@ReplyInterpreter` on two roles → one each                                                    |
| `[reply-interpreter.decision-model]`      | a question role's interpreter on a decision model → a chat model                                   |
| `[reply-interpreter.no-interpret-method]` | a code interpreter without `interpret` → add it                                                    |
| `[application.in-memory-pauses]`          | pauses possible on the in-memory stores (a warning; an error under `--strict`) → list durable ones |
| `PauseAnswererError`                      | `ownerId` for a Channel role or `answeredBy` for a ThreadOwner role → the other credential         |
| `IncompatibleResumeError`                 | resumed on an app with another config hash → `WorkflowSettings.builder().onIncompatibleResume(…)`  |

## Pitfalls

- Naming the implementation on the tool (`channel: SlackRefundApprovalChannel`): name the role.
- Reading the `pauseId` from `result.pending` for a `Channel` role — it is not there by design; the
  channel gets it in `ask.pauseId` and is its reply key.
- A channel that sleeps until an answer: return `awaitReply()` and let `app.resume` continue it.
- Pauses on the in-memory stores in production: they vanish on restart.
