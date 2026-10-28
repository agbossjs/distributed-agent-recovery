# 12 — End-to-end recipes

Read this when you build a whole feature or a whole application from scratch. Each recipe is a set
of files — one class per file in a project; a few small classes share a file here for brevity — that
compiles with its generated types, and a test that drives it by script. Start from the recipe closest
to your task, then read the reference each part points to.

| Recipe                                                | Shows                                                                                                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. An offer review loop                               | `oneOf` + `switch`, `about`, `historyOf`, `maxVisits`, a code router, `.onError` side paths                                                       |
| 2. Sourcing: children per item, a quorum, an approval | `.toParallelWorkflows`, a soft child failure, `.acceptedBy(anyOf(…))`, `.joinQuorum`, a channel role, `app.resume`                                |
| 3. A help desk on MCP and A2A, streamed               | `@McpServer` / `@McpTool`, an `@A2AAgent` behind a tool, `onStream`, `mcpOf`, `mockOf`                                                            |
| 4. A production multi-tenant application              | tenant context, budgets, model providers with a fallback and `TenantWeighted`, PII, a guardrail, SQLite, health, undo, unit and integration tests |

After writing any of them: `npx agboss check` (types, every rule), `npx agboss describe`, `npm test`.

## 1. An offer review loop

A draft is reviewed until approved; the reviewer compares it with the earlier versions; the editor
may rewrite it at most twice; an approved offer above a limit waits for a person, below it is sent.

```ts file=src/offers/offer.dto.ts
import { Integer, Text } from "@agboss/core/dto";

export class OfferRequestDto {
  @Text({ prompt: "the candidate's name" })
  candidate!: string;

  @Integer({ prompt: "the yearly salary in dollars", min: 1 })
  salary!: number;
}

export class OfferLetterDto {
  @Text({ prompt: "the offer letter" })
  text!: string;
}

export class LetterChangesDto {
  @Text({ prompt: "what to change in the letter" })
  notes!: string;
}

export class LetterApprovedDto {
  @Text({ prompt: "a note for the record", optional: true })
  note?: string;
}

export class OfferMailedDto {
  @Text({ prompt: "the sent message's id" })
  messageId!: string;
}
```

```ts file=src/offers/services/offer-mailer.service.ts
import { Injectable } from "@agboss/core";

export class MailerUnavailableError extends Error {}

@Injectable()
export class OfferMailerService {
  send(candidate: string, text: string, idempotencyKey: string): Promise<string> {
    return Promise.resolve(`${candidate}:${String(text.length)}:${idempotencyKey}`);
  }
}
```

```ts file=src/offers/offer.components.ts
import { Action, Agent, DecidedBy, ExecutionContext, Router, WorkflowFinish, WorkflowStart, historyOf, oneOf } from "@agboss/core";
import type { ActionHandler, InputOf, OutputOf, Route, RouterHandler } from "@agboss/core";
import { LetterApprovedDto, LetterChangesDto, OfferLetterDto, OfferMailedDto, OfferRequestDto } from "./offer.dto.js";
import { OfferMailerService } from "./services/offer-mailer.service.js";

@WorkflowStart({ name: "offer-letter-workflow-start", description: "An offer to write", input: OfferRequestDto })
export class OfferLetterWorkflowStart {}

@Agent({
  name: "letter-writer-agent",
  description: "Writes the first offer letter",
  prompt: "Write a warm, short offer letter.",
  model: "moonshotai/kimi-k2.6",
  input: { request: OfferRequestDto },
  output: OfferLetterDto,
})
export class LetterWriterAgent {}

@Agent({
  name: "letter-reviewer-agent",
  description: "Approves the letter or asks for changes",
  prompt: "Approve the letter, or say what to change. Do not ask again for what earlier versions fixed.",
  model: "moonshotai/kimi-k2.6",
  input: { letter: historyOf(OfferLetterDto, { limit: 2 }) },
  output: oneOf(LetterChangesDto, LetterApprovedDto),
  maxVisits: 3,
})
export class LetterReviewerAgent {}

@Agent({
  name: "letter-editor-agent",
  description: "Rewrites the letter as asked",
  prompt: "Rewrite the letter so it meets every requested change.",
  model: "moonshotai/kimi-k2.6",
  input: { letter: OfferLetterDto, changes: LetterChangesDto },
  output: OfferLetterDto,
  maxVisits: 2,
})
export class LetterEditorAgent {}

@Action({
  name: "mail-offer-action",
  description: "Mails the approved letter",
  input: { request: OfferRequestDto, letter: OfferLetterDto },
  output: OfferMailedDto,
  deps: [OfferMailerService, ExecutionContext],
})
export class MailOfferAction implements ActionHandler<MailOfferAction> {
  constructor(
    private readonly offerMailerService: OfferMailerService,
    private readonly executionContext: ExecutionContext,
  ) {}

  async execute(input: InputOf<MailOfferAction>): Promise<OutputOf<MailOfferAction>> {
    const key: string = this.executionContext.step.idempotencyKey; // a resend after a crash is one send
    const messageId: string = await this.offerMailerService.send(input.request.value.candidate, input.letter.value.text, key);
    return { messageId };
  }
}

@WorkflowFinish({ name: "offer-mailed-workflow-finish", description: "The mailed offer", output: OfferMailedDto })
export class OfferMailedWorkflowFinish {}

@WorkflowFinish({ name: "offer-for-sign-off-workflow-finish", description: "A large offer, for a person to sign off", output: OfferLetterDto })
export class OfferForSignOffWorkflowFinish {}

@WorkflowFinish({ name: "offer-stuck-workflow-finish", description: "The review did not converge", output: OfferRequestDto })
export class OfferStuckWorkflowFinish {}

const SIGN_OFF_SALARY = 200_000;

@Router({
  name: "offer-size-router",
  description: "Mails an ordinary offer, holds a large one for sign-off",
  decidedBy: DecidedBy.Code,
  input: { request: OfferRequestDto },
  routes: [{ target: MailOfferAction }, { target: OfferForSignOffWorkflowFinish }],
})
export class OfferSizeRouter implements RouterHandler<OfferSizeRouter> {
  route(input: InputOf<OfferSizeRouter>): Route<OfferSizeRouter> {
    return input.request.value.salary > SIGN_OFF_SALARY ? OfferForSignOffWorkflowFinish : MailOfferAction;
  }
}
```

```ts file=src/offers/offer-letter.workflow.ts
import { VisitsLimitExceededError, Workflow, agent, caseOf, oneOf, route, start, toFinish } from "@agboss/core";
import {
  LetterEditorAgent,
  LetterReviewerAgent,
  LetterWriterAgent,
  MailOfferAction,
  OfferForSignOffWorkflowFinish,
  OfferLetterWorkflowStart,
  OfferMailedWorkflowFinish,
  OfferSizeRouter,
  OfferStuckWorkflowFinish,
} from "./offer.components.js";
import { LetterApprovedDto, LetterChangesDto, OfferLetterDto, OfferMailedDto, OfferRequestDto } from "./offer.dto.js";
import { MailerUnavailableError, OfferMailerService } from "./services/offer-mailer.service.js";

@Workflow({
  name: "offer-letter-workflow",
  version: "1.0.0",
  flow: [
    start(OfferLetterWorkflowStart)
      .returns(OfferRequestDto)
      .toAgent(LetterWriterAgent)
      .returns(OfferLetterDto)
      .toAgent(LetterReviewerAgent),

    agent(LetterReviewerAgent)
      .returns(oneOf(LetterChangesDto, LetterApprovedDto))
      .switch(
        caseOf(LetterChangesDto, { about: OfferLetterDto })
          .toAgent(LetterEditorAgent)
          .onError(VisitsLimitExceededError, toFinish(OfferStuckWorkflowFinish)) // no model past a limit
          .returns(OfferLetterDto)
          .toAgent(LetterReviewerAgent),
        caseOf(LetterApprovedDto)
          .toRouter(OfferSizeRouter)
          .chooseOne(
            route(MailOfferAction)
              .onError(MailerUnavailableError, toFinish(OfferForSignOffWorkflowFinish)) // through ActionFailedError's cause
              .returns(OfferMailedDto)
              .toFinish(OfferMailedWorkflowFinish),
            route(OfferForSignOffWorkflowFinish),
          ),
      ),
  ],
  maxSteps: 8,
  providers: [OfferMailerService],
})
export class OfferLetterWorkflow {}
```

```ts file=src/offers/offers.application.ts
import { Application, Budget, BudgetPeriod, BudgetScope, EmptyEnvironment, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";
import { OfferLetterWorkflow } from "./offer-letter.workflow.js";

@Budget({ name: "offers-application-budget", scope: BudgetScope.Application, period: BudgetPeriod.Day })
export class OffersApplicationBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(5);
  }
}

@Budget({ name: "offers-tenant-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
export class OffersTenantBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

@Budget({ name: "offers-execution-budget", scope: BudgetScope.Execution })
export class OffersExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.1);
  }
}

@Application({
  name: "offers-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [OfferLetterWorkflow],
  budgets: [OffersApplicationBudget, OffersTenantBudget, OffersExecutionBudget],
})
export class OffersApplication {}
```

```ts file=tests/offers/offer-letter.test.ts
import { expect } from "vitest";
import { replyWith, testWith } from "@agboss/core/testing";
import { OffersApplication } from "../../src/offers/offers.application.js";
import {
  LetterEditorAgent,
  LetterReviewerAgent,
  LetterWriterAgent,
  MailOfferAction,
  OfferLetterWorkflowStart,
  OfferMailedWorkflowFinish,
  OfferSizeRouter,
  OfferStuckWorkflowFinish,
} from "../../src/offers/offer.components.js";
import { LetterApprovedDto, LetterChangesDto, OfferLetterDto } from "../../src/offers/offer.dto.js";

const test = testWith(OffersApplication);

const REQUEST = { candidate: "Ada", salary: 150_000 };

test("one round of changes, then the offer is mailed", async ({ app, mockLlm }) => {
  mockLlm(LetterWriterAgent).thenReturn(replyWith(OfferLetterDto, { text: "Dear Ada, v1" }));
  mockLlm(LetterReviewerAgent).thenReturn(
    replyWith(LetterChangesDto, { notes: "mention the start date" }),
    replyWith(LetterApprovedDto, {}),
  );
  mockLlm(LetterEditorAgent).thenReturn(replyWith(OfferLetterDto, { text: "Dear Ada, v2, from May 1" }));

  const result = await app.execute(OfferLetterWorkflowStart, REQUEST);

  expect(result).toFollowPath([
    OfferLetterWorkflowStart,
    LetterWriterAgent,
    LetterReviewerAgent,
    LetterEditorAgent,
    LetterReviewerAgent,
    OfferSizeRouter,
    MailOfferAction,
    OfferMailedWorkflowFinish,
  ]);
});

test("a review that never converges ends at the stuck finish", async ({ app, mockLlm }) => {
  mockLlm(LetterWriterAgent).thenReturn(replyWith(OfferLetterDto, { text: "v1" }));
  mockLlm(LetterReviewerAgent).thenReturn(
    replyWith(LetterChangesDto, { notes: "shorter" }),
    replyWith(LetterChangesDto, { notes: "longer" }),
    replyWith(LetterChangesDto, { notes: "shorter again" }),
  );
  mockLlm(LetterEditorAgent).thenReturn(
    replyWith(OfferLetterDto, { text: "v2" }),
    replyWith(OfferLetterDto, { text: "v3" }),
  );

  const result = await app.execute(OfferLetterWorkflowStart, REQUEST);

  expect(result).toFinishWith(OfferStuckWorkflowFinish, REQUEST); // the editor's third visit hit maxVisits
});
```

## 2. Sourcing: children per item, a quorum, an approval

A finder lists suppliers; each is checked by a child workflow that fails softly; three reviewers
assess the shortlist and any two accepted reviews are enough; the buyer — the thread's owner —
approves the order before it is placed.

```ts file=src/sourcing/sourcing.dto.ts
import { Integer, Text } from "@agboss/core/dto";

export class SupplierDto {
  @Text({ prompt: "the supplier's name" })
  name!: string;
}

export class SupplierScoreDto {
  @Text({ prompt: "the supplier's name" })
  name!: string;

  @Integer({ prompt: "fit for the request, 1 to 10" })
  score!: number;
}

export class SupplierUncheckedDto {
  @Text({ prompt: "the supplier that could not be checked" })
  name!: string;
}

export class SupplierShortlistDto {
  @Text({ prompt: "the chosen supplier" })
  supplier!: string;

  @Integer({ prompt: "the price in dollars", min: 1 })
  price!: number;
}

export class PurchaseReviewDto {
  @Integer({ prompt: "how sound the purchase is, 1 to 10" })
  score!: number;

  @Text({ prompt: "what the score rests on" })
  reason!: string;
}

export class PurchaseOrderDto {
  @Text({ prompt: "the supplier to order from" })
  supplier!: string;

  @Integer({ prompt: "the price in dollars", min: 1 })
  price!: number;
}

export class PurchasePlacedDto {
  @Text({ prompt: "the purchase order's id" })
  orderId!: string;
}

export class PurchaseSummaryDto {
  @Text({ prompt: "what was ordered and why" })
  text!: string;
}
```

```ts file=src/sourcing/supplier-check.workflow.ts
// the child: one supplier; its own failure becomes a result class, so one bad item never cancels the rest
import { Action, Agent, StepFailedError, Workflow, WorkflowFinish, WorkflowStart, start, toAction } from "@agboss/core";
import type { ActionHandler, InputOf, OutputOf } from "@agboss/core";
import { SupplierDto, SupplierScoreDto, SupplierUncheckedDto } from "./sourcing.dto.js";

@WorkflowStart({ name: "supplier-check-workflow-start", description: "A supplier to check", input: SupplierDto })
export class SupplierCheckWorkflowStart {}

@Agent({
  name: "supplier-checker-agent",
  description: "Scores one supplier",
  prompt: "Score the supplier's fit from 1 to 10.",
  model: "moonshotai/kimi-k2.6",
  input: { supplier: SupplierDto },
  output: SupplierScoreDto,
})
export class SupplierCheckerAgent {}

@Action({ name: "mark-supplier-unchecked-action", description: "Records a failed check", input: { supplier: SupplierDto }, output: SupplierUncheckedDto })
export class MarkSupplierUncheckedAction implements ActionHandler<MarkSupplierUncheckedAction> {
  execute(input: InputOf<MarkSupplierUncheckedAction>): Promise<OutputOf<MarkSupplierUncheckedAction>> {
    return Promise.resolve({ name: input.supplier.value.name });
  }
}

@WorkflowFinish({ name: "supplier-scored-workflow-finish", description: "The score", output: SupplierScoreDto })
export class SupplierScoredWorkflowFinish {}

@WorkflowFinish({ name: "supplier-unchecked-workflow-finish", description: "Not checked", output: SupplierUncheckedDto })
export class SupplierUncheckedWorkflowFinish {}

@Workflow({
  name: "supplier-check-workflow",
  version: "1.0.0",
  flow: [
    start(SupplierCheckWorkflowStart)
      .returns(SupplierDto)
      .toAgent(SupplierCheckerAgent)
      .onError(
        StepFailedError,
        toAction(MarkSupplierUncheckedAction)
          .returns(SupplierUncheckedDto)
          .toFinish(SupplierUncheckedWorkflowFinish),
      )
      .returns(SupplierScoreDto)
      .toFinish(SupplierScoredWorkflowFinish),
  ],
})
export class SupplierCheckWorkflow {}
```

```ts file=src/sourcing/channels/purchase-approval.channel.ts
// the role: what it approves and who answers; its implementation is infrastructure
import { Channel, ChannelOf, ChannelOutcome, ChannelRole, Injectable, PauseAnswerer } from "@agboss/core";
import type { ChannelAsk } from "@agboss/core";
import { PurchaseOrderDto } from "../sourcing.dto.js";

@ChannelRole({
  name: "purchase-approval-channel",
  description: "The buyer approves every purchase order",
  approves: PurchaseOrderDto, // the input of the tool that names the role
  answeredBy: PauseAnswerer.ThreadOwner, // app.resume(…, { ownerId }); the pauseId is in result.pending
})
export abstract class PurchaseApprovalChannel extends ChannelOf<PurchaseApprovalChannel> {}

@Injectable()
export class BuyerInboxService {
  notify(pauseId: string, text: string): Promise<void> {
    void pauseId;
    void text;
    return Promise.resolve();
  }
}

@Channel({ name: "buyer-inbox-purchase-approval-channel", description: "Tells the buyer in their inbox", deps: [BuyerInboxService] })
export class BuyerInboxPurchaseApprovalChannel extends PurchaseApprovalChannel {
  constructor(private readonly buyerInboxService: BuyerInboxService) {
    super();
  }

  async send(ask: ChannelAsk<PurchaseApprovalChannel>): Promise<ChannelOutcome<PurchaseApprovalChannel>> {
    const { supplier, price } = ask.value.arguments;
    await this.buyerInboxService.notify(ask.pauseId, `Order from ${supplier} for $${String(price)}?`);
    return ChannelOutcome.awaitReply(); // the execution rests until app.resume
  }
}
```

```ts file=src/sourcing/sourcing.components.ts
import { Agent, Arbiter, DecidedBy, ExecutionContext, OnAnswer, Tool, WorkflowFinish, WorkflowStart, listOf, oneOf } from "@agboss/core";
import type { ArbiterAnswerOf, ToolHandler } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { PurchaseApprovalChannel } from "./channels/purchase-approval.channel.js";
import {
  PurchaseOrderDto,
  PurchasePlacedDto,
  PurchaseReviewDto,
  PurchaseSummaryDto,
  SupplierDto,
  SupplierScoreDto,
  SupplierShortlistDto,
  SupplierUncheckedDto,
} from "./sourcing.dto.js";

@WorkflowStart({ name: "sourcing-workflow-start", description: "What to buy", input: WorkflowStartTextDto })
export class SourcingWorkflowStart {}

@Agent({
  name: "supplier-finder-agent",
  description: "Lists suppliers for the request",
  prompt: "List the suppliers that can deliver the request.",
  model: "moonshotai/kimi-k2.6",
  input: { request: WorkflowStartTextDto },
  output: listOf(SupplierDto),
})
export class SupplierFinderAgent {}

@Agent({
  name: "supplier-shortlist-agent",
  description: "Picks the best checked supplier",
  prompt: "Pick the best scored supplier and its price; ignore the unchecked ones.",
  model: "moonshotai/kimi-k2.6",
  input: { checks: listOf(oneOf(SupplierScoreDto, SupplierUncheckedDto)) },
  output: SupplierShortlistDto,
})
export class SupplierShortlistAgent {}

@Agent({ name: "price-review-agent", description: "Reviews the price", prompt: "Score the price from 1 to 10.", model: "moonshotai/kimi-k2.6", input: { shortlist: SupplierShortlistDto }, output: PurchaseReviewDto })
export class PriceReviewAgent {}

@Agent({ name: "risk-review-agent", description: "Reviews the supplier risk", prompt: "Score the supplier risk from 1 (high) to 10 (low).", model: "moonshotai/kimi-k2.6", input: { shortlist: SupplierShortlistDto }, output: PurchaseReviewDto })
export class RiskReviewAgent {}

@Agent({ name: "terms-review-agent", description: "Reviews the terms", prompt: "Score the delivery terms from 1 to 10.", model: "moonshotai/kimi-k2.6", input: { shortlist: SupplierShortlistDto }, output: PurchaseReviewDto })
export class TermsReviewAgent {}

@Arbiter({ name: "review-range-arbiter", decidedBy: DecidedBy.Code })
export class ReviewRangeArbiter {
  @OnAnswer(PriceReviewAgent)
  fromPriceReview(answer: ArbiterAnswerOf<typeof PriceReviewAgent>): boolean {
    return this.isUsable(answer.score, answer.reason);
  }

  @OnAnswer(RiskReviewAgent)
  fromRiskReview(answer: ArbiterAnswerOf<typeof RiskReviewAgent>): boolean {
    return this.isUsable(answer.score, answer.reason);
  }

  @OnAnswer(TermsReviewAgent)
  fromTermsReview(answer: ArbiterAnswerOf<typeof TermsReviewAgent>): boolean {
    return this.isUsable(answer.score, answer.reason);
  }

  private isUsable(score: number, reason: string): boolean {
    return score >= 1 && score <= 10 && reason.trim() !== "";
  }
}

@Arbiter({
  name: "review-grounded-arbiter",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  prompt: "Count a review only if it meets the criterion of the agent that gave it.",
  criteria: [
    { agent: PriceReviewAgent, prompt: "The reason compares the price with the market" },
    { agent: RiskReviewAgent, prompt: "The reason names a concrete risk" },
    { agent: TermsReviewAgent, prompt: "The reason names a delivery term" },
  ],
})
export class ReviewGroundedArbiter {}

@Tool({
  name: "place-purchase-tool",
  description: "Places the purchase order — the buyer approves it first",
  input: PurchaseOrderDto,
  output: PurchasePlacedDto,
  channel: PurchaseApprovalChannel, // the role, never the implementation
  deps: [ExecutionContext],
})
export class PlacePurchaseTool implements ToolHandler<PurchaseOrderDto, PurchasePlacedDto> {
  constructor(private readonly executionContext: ExecutionContext) {}

  run({ supplier }: PurchaseOrderDto): Promise<PurchasePlacedDto> {
    return Promise.resolve({ orderId: `${supplier}:${this.executionContext.step.idempotencyKey}` });
  }
}

@Agent({
  name: "purchase-agent",
  description: "Places the order and sums it up",
  prompt: "Place the order for the shortlisted supplier with place-purchase-tool, then sum it up.",
  model: "moonshotai/kimi-k2.6",
  input: { shortlist: SupplierShortlistDto, reviews: listOf(PurchaseReviewDto) },
  output: PurchaseSummaryDto,
  tools: [PlacePurchaseTool],
  maxToolCalls: 2,
})
export class PurchaseAgent {}

@WorkflowFinish({ name: "purchase-placed-workflow-finish", description: "The purchase", output: PurchaseSummaryDto })
export class PurchasePlacedWorkflowFinish {}

@WorkflowFinish({ name: "purchase-unreviewed-workflow-finish", description: "Too few usable reviews", output: SupplierShortlistDto })
export class PurchaseUnreviewedWorkflowFinish {}
```

```ts file=src/sourcing/sourcing.workflow.ts
import { QuorumNotReachedError, Workflow, anyOf, listOf, oneOf, start, toFinish } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { minutes } from "@agboss/core/units";
import {
  PriceReviewAgent,
  PurchaseAgent,
  PurchasePlacedWorkflowFinish,
  PurchaseUnreviewedWorkflowFinish,
  ReviewGroundedArbiter,
  ReviewRangeArbiter,
  RiskReviewAgent,
  SourcingWorkflowStart,
  SupplierFinderAgent,
  SupplierShortlistAgent,
  TermsReviewAgent,
} from "./sourcing.components.js";
import {
  PurchaseReviewDto,
  PurchaseSummaryDto,
  SupplierDto,
  SupplierScoreDto,
  SupplierShortlistDto,
  SupplierUncheckedDto,
} from "./sourcing.dto.js";
import { SupplierCheckWorkflow } from "./supplier-check.workflow.js";

@Workflow({
  name: "sourcing-workflow",
  version: "1.0.0",
  flow: [
    start(SourcingWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(SupplierFinderAgent)
      .returns(listOf(SupplierDto))
      .toParallelWorkflows(SupplierCheckWorkflow, { maxConcurrency: 3, maxItems: 10 })
      .join()
      .returns(listOf(oneOf(SupplierScoreDto, SupplierUncheckedDto)))
      .toAgent(SupplierShortlistAgent)
      .returns(SupplierShortlistDto)
      .toParallelAgents(PriceReviewAgent, RiskReviewAgent, TermsReviewAgent)
      .acceptedBy(anyOf(ReviewRangeArbiter, ReviewGroundedArbiter)) // the model only when the code rejects
      .joinQuorum({ min: 2, max: 3, deadline: minutes(2) })
      .onJoinError(QuorumNotReachedError, toFinish(PurchaseUnreviewedWorkflowFinish))
      .returns(listOf(PurchaseReviewDto))
      .toAgent(PurchaseAgent) // its tool pauses for the buyer
      .returns(PurchaseSummaryDto)
      .toFinish(PurchasePlacedWorkflowFinish),
  ],
  maxSteps: 20,
})
export class SourcingWorkflow {}
```

```ts file=src/sourcing/environments/app.environment.ts
export class SourcingEnvironment {
  sqlitePath!: string; // pauses must survive a restart
}
```

```ts file=src/sourcing/environments/test.environment.ts
import type { SourcingEnvironment } from "./app.environment.js";

export const environment: SourcingEnvironment = { sqlitePath: ":memory:" };
```

```ts file=src/sourcing/sourcing.application.ts
import { Application, Budget, BudgetPeriod, BudgetScope, SqliteCheckpointSaver, SqlitePausedExecutionRepository, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";
import { BuyerInboxPurchaseApprovalChannel, BuyerInboxService } from "./channels/purchase-approval.channel.js";
import { SourcingEnvironment } from "./environments/app.environment.js";
import { SourcingWorkflow } from "./sourcing.workflow.js";

@Budget({ name: "sourcing-application-budget", scope: BudgetScope.Application, period: BudgetPeriod.Day })
export class SourcingApplicationBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(20);
  }
}

@Budget({ name: "sourcing-tenant-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
export class SourcingTenantBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(5);
  }
}

@Budget({ name: "sourcing-execution-budget", scope: BudgetScope.Execution })
export class SourcingExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.5); // the root pays for every child
  }
}

@Application({
  name: "sourcing-application",
  version: "1.0.0",
  environment: SourcingEnvironment,
  workflows: [SourcingWorkflow], // the child need not be listed: it belongs to its parent
  budgets: [SourcingApplicationBudget, SourcingTenantBudget, SourcingExecutionBudget],
  providers: [BuyerInboxPurchaseApprovalChannel, BuyerInboxService, SqlitePausedExecutionRepository, SqliteCheckpointSaver],
})
export class SourcingApplication {}
```

```ts file=tests/sourcing/sourcing.test.ts
import { expect } from "vitest";
import { ExecutionStatus } from "@agboss/core";
import { callTool, replyWith, testWith } from "@agboss/core/testing";
import { SourcingApplication } from "../../src/sourcing/sourcing.application.js";
import {
  PlacePurchaseTool,
  PriceReviewAgent,
  PurchaseAgent,
  PurchasePlacedWorkflowFinish,
  RiskReviewAgent,
  SourcingWorkflowStart,
  SupplierFinderAgent,
  SupplierShortlistAgent,
  TermsReviewAgent,
} from "../../src/sourcing/sourcing.components.js";
import { PurchaseReviewDto, PurchaseSummaryDto, SupplierDto, SupplierScoreDto, SupplierShortlistDto } from "../../src/sourcing/sourcing.dto.js";
import {
  SupplierCheckWorkflow,
  SupplierCheckerAgent,
  SupplierScoredWorkflowFinish,
} from "../../src/sourcing/supplier-check.workflow.js";

const test = testWith(SourcingApplication);

test("checked per supplier, reviewed by a quorum, placed once the buyer approves", async ({ app, mockLlm }) => {
  mockLlm(SupplierFinderAgent).thenReturn(replyWith(SupplierDto, [{ name: "Acme" }, { name: "Globex" }]));
  mockLlm(SupplierCheckerAgent).thenReturn(
    replyWith(SupplierScoreDto, { name: "Acme", score: 8 }),
    replyWith(SupplierScoreDto, { name: "Globex", score: 6 }),
  );
  mockLlm(SupplierShortlistAgent).thenReturn(replyWith(SupplierShortlistDto, { supplier: "Acme", price: 900 }));
  for (const reviewer of [PriceReviewAgent, RiskReviewAgent, TermsReviewAgent])
    mockLlm(reviewer).thenReturn(replyWith(PurchaseReviewDto, { score: 7, reason: "fair against the market" }));
  mockLlm(PurchaseAgent).thenReturn(
    callTool(PlacePurchaseTool, { supplier: "Acme", price: 900 }), // pauses here
    replyWith(PurchaseSummaryDto, { text: "Ordered from Acme for $900." }), // after the resume
  );

  const paused = await app.execute(SourcingWorkflowStart, { text: "900 office chairs" }, { ownerId: "buyer-1" });

  expect(paused.status).toBe(ExecutionStatus.Paused);
  expect(paused).toHavePausedAt(PurchaseAgent);
  expect(paused).toHaveChildExecutions(SupplierCheckWorkflow, [
    { item: { name: "Acme" }, finish: SupplierScoredWorkflowFinish },
    { item: { name: "Globex" }, finish: SupplierScoredWorkflowFinish },
  ]);

  const pauseId: string = paused.pending[0]?.pauseId ?? "";
  const result = await app.resume({ pauseId, decision: { approved: true } }, { ownerId: "buyer-1" });

  expect(result).toFinishWith(PurchasePlacedWorkflowFinish, { text: "Ordered from Acme for $900." });
});
```

## 3. A help desk on MCP and A2A, streamed

An agent searches a knowledge base over MCP and asks the billing application over A2A; the caller
streams the answer as it is written.

```ts file=src/helpdesk/mcp/kb.server.ts
import { Text } from "@agboss/core/dto";
import { McpServer, McpServerClient } from "@agboss/core/mcp";

export class KbSearchDto {
  @Text({ prompt: "words to search the knowledge base for" })
  query!: string;
}

export class KbArticleDto {
  @Text({ prompt: "the best matching article" })
  text!: string;
}

const tools = {
  search_articles: { input: KbSearchDto, output: KbArticleDto }, // the server's own tool name
};

@McpServer({
  name: "kb",
  transport: "stdio",
  command: "kb-mcp-server",
  args: ["--read-only"],
  env: ["KB_TOKEN"], // names of variables passed to the process, never values
  tools,
})
export class KbServer extends McpServerClient<typeof tools> {}
```

```ts file=src/helpdesk/mcp/search-kb.mcp.ts
import { ExecutionContext, type ToolHandler } from "@agboss/core";
import { McpTool } from "@agboss/core/mcp";
import { kilobytes, seconds } from "@agboss/core/units";
import { KbArticleDto, KbSearchDto, KbServer } from "./kb.server.js";

@McpTool({
  server: KbServer,
  name: "search-kb-tool",
  description: "Searches the help center's articles",
  input: KbSearchDto,
  output: KbArticleDto,
  timeout: seconds(10),
  maxResultSize: kilobytes(16),
  deps: [KbServer, ExecutionContext],
})
export class SearchKbTool implements ToolHandler<KbSearchDto, KbArticleDto> {
  constructor(
    private readonly kbServer: KbServer,
    private readonly executionContext: ExecutionContext,
  ) {}

  run({ query }: KbSearchDto): Promise<KbArticleDto> {
    return this.kbServer.call("search_articles", { query }, this.executionContext.signal);
  }
}
```

```ts file=src/helpdesk/a2a/billing-desk.a2a-agent.ts
import { ExecutionContext, Tool, type ToolHandler } from "@agboss/core";
import { Text } from "@agboss/core/dto";
import { A2AAgent, A2AClient } from "@agboss/core/a2a";
import { seconds, usd } from "@agboss/core/units";

export class BillingQuestionDto {
  @Text({ prompt: "the question for the billing desk" })
  question!: string;
}

export class BillingAnswerDto {
  @Text({ prompt: "the billing desk's answer" })
  text!: string;
}

// the billing desk's export, declared (#398 PR 3): what it takes, gives back and costs a call
@A2AAgent({
  name: "billing-desk-a2a-agent",
  url: "https://billing.example/a2a",
  target: { application: "billing-application", start: "billing-workflow-start" },
  input: BillingQuestionDto,
  output: BillingAnswerDto,
  price: usd(0.002),
  deps: [ExecutionContext],
})
export class BillingDeskA2AAgent extends A2AClient<BillingQuestionDto, BillingAnswerDto> {
  constructor(private readonly executionContext: ExecutionContext) {
    super();
  }

  protected override getHeaders(): Promise<Record<string, string>> {
    return Promise.resolve({ "x-tenant-id": this.executionContext.tenant.tenantId });
  }
}

@Tool({
  name: "ask-billing-tool",
  description: "Asks the billing desk about invoices and payments",
  input: BillingQuestionDto,
  output: BillingAnswerDto,
  timeout: seconds(60),
  deps: [BillingDeskA2AAgent, ExecutionContext],
})
export class AskBillingTool implements ToolHandler<BillingQuestionDto, BillingAnswerDto> {
  constructor(
    private readonly billingDeskA2AAgent: BillingDeskA2AAgent,
    private readonly executionContext: ExecutionContext,
  ) {}

  run(question: BillingQuestionDto): Promise<BillingAnswerDto> {
    // typed by the contract; its price recorded in this call's spend
    return this.billingDeskA2AAgent.execute(question, { signal: this.executionContext.signal });
  }
}
```

```ts file=src/helpdesk/helpdesk.workflow.ts
import { Agent, Workflow, WorkflowFinish, WorkflowStart, start } from "@agboss/core";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "@agboss/core/dto";
import { AskBillingTool, BillingDeskA2AAgent } from "./a2a/billing-desk.a2a-agent.js";
import { KbServer } from "./mcp/kb.server.js";
import { SearchKbTool } from "./mcp/search-kb.mcp.js";

@WorkflowStart({ name: "helpdesk-workflow-start", description: "A customer's question", input: WorkflowStartTextDto })
export class HelpdeskWorkflowStart {}

@Agent({
  name: "helpdesk-agent",
  description: "Answers from the knowledge base and the billing desk",
  prompt: "Answer the question. Search articles with search-kb-tool; ask billing with ask-billing-tool.",
  model: "moonshotai/kimi-k2.6",
  tools: [SearchKbTool, AskBillingTool],
  maxToolCalls: 4,
}) // a text agent: it streams its text
export class HelpdeskAgent {}

@WorkflowFinish({ name: "helpdesk-workflow-finish", description: "The answer", output: WorkflowFinishTextDto })
export class HelpdeskWorkflowFinish {}

@Workflow({
  name: "helpdesk-workflow",
  version: "1.0.0",
  flow: [
    start(HelpdeskWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(HelpdeskAgent)
      .toFinish(HelpdeskWorkflowFinish),
  ],
  mcp: [KbServer], // connected at start, closed by app.close()
  providers: [BillingDeskA2AAgent],
  maxSteps: 1,
})
export class HelpdeskWorkflow {}
```

```ts file=src/helpdesk/a2a/helpdesk.a2a-caller-resolver.ts
// who calls over A2A: the API gateway in front authenticated the caller and named its tenant
import { Injectable } from "@agboss/core";
import { A2ACallerResolution, type A2ACallerRequest, type A2ACallerResolver } from "@agboss/core/a2a";
import type { HelpdeskWorkflowStart } from "../helpdesk.workflow.js";

@Injectable()
export class HelpdeskA2aCallerResolver implements A2ACallerResolver<typeof HelpdeskWorkflowStart> {
  resolveCaller(request: A2ACallerRequest): A2ACallerResolution<typeof HelpdeskWorkflowStart> {
    const tenantId = request.http.headers["x-gateway-tenant"];
    const clientId = request.http.headers["x-gateway-client"];
    if (typeof tenantId !== "string" || typeof clientId !== "string") {
      return A2ACallerResolution.unauthenticated({ reason: "not through the gateway" });
    }
    return A2ACallerResolution.resolved({ tenant: { tenantId }, ownerId: clientId });
  }
}
```

```ts file=src/helpdesk/helpdesk.application.ts
import { Application, Budget, BudgetPeriod, BudgetScope, EmptyEnvironment, type BudgetHandler } from "@agboss/core";
import { A2AExpose } from "@agboss/core/a2a";
import { usd, type Usd } from "@agboss/core/units";
import { HelpdeskA2aCallerResolver } from "./a2a/helpdesk.a2a-caller-resolver.js";
import { HelpdeskWorkflow, HelpdeskWorkflowStart } from "./helpdesk.workflow.js";

// what other applications may run here (#398 PR 3)
@A2AExpose({ name: "helpdesk-a2a-expose", version: "1.0.0", exports: [HelpdeskWorkflowStart] })
export class HelpdeskA2AExpose {}

@Budget({ name: "helpdesk-application-budget", scope: BudgetScope.Application, period: BudgetPeriod.Day })
export class HelpdeskApplicationBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(10);
  }
}

@Budget({ name: "helpdesk-tenant-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
export class HelpdeskTenantBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(2);
  }
}

@Budget({ name: "helpdesk-execution-budget", scope: BudgetScope.Execution })
export class HelpdeskExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.05);
  }
}

@Application({
  name: "helpdesk-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [HelpdeskWorkflow],
  providers: [HelpdeskA2aCallerResolver], // an ordinary service may be listed here too
  budgets: [HelpdeskApplicationBudget, HelpdeskTenantBudget, HelpdeskExecutionBudget],
  exposes: [HelpdeskA2AExpose],
})
export class HelpdeskApplication {}
```

The caller streams the text as it arrives and serves the same workflow to A2A callers:

```ts file=src/helpdesk/server.ts
import { createServer } from "node:http";
import { createApp } from "@agboss/core";
import { a2aHttpListener } from "@agboss/core/a2a";
import { HelpdeskA2aCallerResolver } from "./a2a/helpdesk.a2a-caller-resolver.js";
import { HelpdeskA2AExpose, HelpdeskApplication } from "./helpdesk.application.js";
import { HelpdeskWorkflowStart } from "./helpdesk.workflow.js";

const app = await createApp(HelpdeskApplication, { env: "prod" });

const result = await app.execute(
  HelpdeskWorkflowStart,
  { text: "Why was I charged twice?" },
  {
    tenant: { tenantId: "acme" },
    threadId: "ticket-88",
    onStream: (event) => {
      if (event.kind === "textDelta") process.stdout.write(event.delta); // also "toolCall"
    },
  },
);
console.log("\n", result.spend.totalUsd);

// other applications call this workflow: POST /a2a/execute, /a2a/resume, /a2a/cancel — each request's tenant
// from the resolver the application lists (reference 04; in a route of your own: A2AAdapter)
const listener = a2aHttpListener(app, {
  expose: HelpdeskA2AExpose,
  callerResolver: HelpdeskA2aCallerResolver,
  base: "/a2a",
});
createServer(listener).listen(8080);
```

```ts file=tests/helpdesk/helpdesk.test.ts
import { expect } from "vitest";
import { callTool, replyWith, testWith } from "@agboss/core/testing";
import { AskBillingTool, BillingDeskA2AAgent } from "../../src/helpdesk/a2a/billing-desk.a2a-agent.js";
import { HelpdeskApplication } from "../../src/helpdesk/helpdesk.application.js";
import { HelpdeskAgent, HelpdeskWorkflowFinish, HelpdeskWorkflowStart } from "../../src/helpdesk/helpdesk.workflow.js";
import { KbServer } from "../../src/helpdesk/mcp/kb.server.js";
import { SearchKbTool } from "../../src/helpdesk/mcp/search-kb.mcp.js";

const test = testWith(HelpdeskApplication); // the MCP server is never started, the network blocked

test("the agent reads an article and asks billing", async ({ app, mcpOf, mockLlm, mockOf }) => {
  mcpOf(KbServer).thenReturn({ search_articles: () => Promise.resolve({ text: "Double charges are refunded in 5 days." }) });
  mockOf(BillingDeskA2AAgent).execute.mockResolvedValue({ text: "One charge is pending; it will drop." });
  mockLlm(HelpdeskAgent).thenReturn(
    callTool(SearchKbTool, { query: "charged twice" }),
    callTool(AskBillingTool, { question: "Was customer acme charged twice?" }),
    replyWith("One charge is pending and will drop within 5 days."),
  );

  const result = await app.execute(HelpdeskWorkflowStart, { text: "Why was I charged twice?" });

  expect(mockLlm(HelpdeskAgent)).toHaveScriptedToolCalls([SearchKbTool, AskBillingTool]); // the script, in order
  expect(result).toHaveCalledTools([AskBillingTool, SearchKbTool]); // the run: each at least once, any order
  expect(result).toFinishWith(HelpdeskWorkflowFinish, { text: "One charge is pending and will drop within 5 days." });
  expect(mockOf(BillingDeskA2AAgent).execute.mock.calls[0]?.[0]).toEqual({ question: "Was customer acme charged twice?" });
});
```

## 4. A production multi-tenant application

Loan pre-approval for many lenders (tenants): each tenant's own daily budget and queue weight, PII
masked before any model reads it, a guardrail that refuses out-of-scope requests, a reservation of
funds that is undone when a later step fails, SQLite stores, readiness probes, unit and integration
tests. Production also needs `main.ts` with the probes and the Kubernetes manifest of reference 09.

```ts file=src/loans/contexts/lender.context.ts
import { TenantContext } from "@agboss/core";
import { Decimal, OneOf } from "@agboss/core/dto";

export class LenderTenantContext extends TenantContext {
  @OneOf({ values: ["standard", "enterprise"] })
  plan!: "standard" | "enterprise";

  @Decimal({ min: 0 })
  dailyBudgetUsd!: number;
}
```

```ts file=src/loans/environments/app.environment.ts
import type { Secret } from "@agboss/core";

export class LoansEnvironment {
  sqlitePath!: string;
  openRouterApiKey?: Secret;
  backupApiKey?: Secret;
  piiPseudonymKey?: Secret; // one PII token per value on every instance
}
```

```ts file=src/loans/environments/prod.environment.ts
import { env, secret } from "@agboss/core";
import type { LoansEnvironment } from "./app.environment.js";

export const environment: LoansEnvironment = {
  sqlitePath: env("AGBOSS_SQLITE_PATH", { default: "/data/loans.sqlite" }),
  openRouterApiKey: secret("OPENROUTER_API_KEY"),
  backupApiKey: secret("BACKUP_API_KEY"),
  piiPseudonymKey: secret("PII_PSEUDONYM_KEY"),
};
```

```ts file=src/loans/environments/test.environment.ts
import type { LoansEnvironment } from "./app.environment.js";

export const environment: LoansEnvironment = { sqlitePath: ":memory:" }; // no keys: models are scripted
```

```ts file=src/loans/model-providers/loans.model-providers.ts
import {
  ModelCost,
  ModelFailure,
  ModelProvider,
  OpenAiCompatibleProvider,
  OpenRouterProvider,
  PromptCaching,
  QueueBalancingStrategy,
  RateLimitPolicy,
  Reasoning,
  RetryPolicy,
  type NoRequestFields,
  type OpenRouterFields,
} from "@agboss/core/models";
import { minutes, seconds, usd } from "@agboss/core/units";

@ModelProvider({
  name: "loans-backup-model-provider",
  description: "The in-house server, while OpenRouter is down",
  serves: [/^inhouse\//],
  baseUrl: "http://inference.internal:8000/v1",
  apiKey: "backupApiKey",
  timeout: minutes(1),
  cost: ModelCost.fromPrices({ "inhouse/kimi": { inputPerMillion: usd(0.4), outputPerMillion: usd(1.6) } }),
  reasoning: Reasoning.off(),
  promptCaching: PromptCaching.off(),
  retryPolicy: RetryPolicy.none(),
  circuitBreakerPolicy: { failureThreshold: 5, window: minutes(1), openFor: seconds(30) },
})
export class LoansBackupModelProvider extends OpenAiCompatibleProvider {
  override readonly requestFields: NoRequestFields = {};
}

@ModelProvider({
  name: "loans-openrouter-model-provider",
  description: "OpenRouter: the chat models",
  serves: [/^moonshotai\//],
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "openRouterApiKey",
  timeout: minutes(2),
  cost: ModelCost.fromResponse(),
  reasoning: Reasoning.modelDecides(),
  promptCaching: PromptCaching.off(),
  retryPolicy: RetryPolicy.exponential({
    maxAttempts: 3,
    initialDelay: seconds(1),
    maxDelay: seconds(20),
    jitter: true,
    retryOn: [ModelFailure.Timeout, ModelFailure.RateLimited, ModelFailure.ServerError],
  }),
  rateLimitPolicy: RateLimitPolicy.of({
    maxConcurrentCalls: 16,
    perMinute: { calls: 300 },
    balancing: QueueBalancingStrategy.TenantWeighted, // enterprise lenders weigh more
  }),
  circuitBreakerPolicy: {
    failureThreshold: 5,
    window: minutes(1),
    openFor: seconds(30),
    fallback: LoansBackupModelProvider,
    fallbackModels: { "moonshotai/kimi-k2.6": "inhouse/kimi" },
  },
})
export class LoansOpenRouterModelProvider extends OpenRouterProvider {
  override readonly requestFields: OpenRouterFields = {};
}
```

```ts file=src/loans/safety/loans.safety.ts
import { InputGuardrail, PiiAction, PiiKind, PiiPolicy, pii } from "@agboss/core";

@PiiPolicy({
  name: "applicant-pii-policy",
  description: "Hides the applicant's identifiers and contacts from models",
  rules: [
    pii(PiiKind.IsraeliId, PiiAction.replaceWithToken()), // the model reads <israeli-id:…>; tools get the real id
    pii(PiiKind.Email, PiiAction.replaceWithToken()),
    pii(PiiKind.Phone, PiiAction.replacePart({ keepLast: 2 })),
    pii(PiiKind.CardNumber, PiiAction.blockWithRefusal({ refusal: "Please do not send card numbers here." })),
  ],
})
export class ApplicantPiiPolicy {}

@InputGuardrail({
  name: "out-of-scope-guardrail",
  description: "Refuses requests that are not about a loan application",
  prompt: "Is the message about something other than applying for a loan?",
  model: "typesafe/jev-1.13",
  threshold: 0.8,
  refusal: "I can only help with loan applications.",
})
export class OutOfScopeGuardrail {}
```

```ts file=src/loans/loans.dto.ts
import { Decimal, Flag, Integer, Text } from "@agboss/core/dto";

export class LoanApplicationDto {
  @Text({ prompt: "the applicant's message, with their id and income" })
  text!: string;

  @Integer({ prompt: "the amount asked for, in dollars", min: 1 })
  amount!: number;
}

export class CreditScoreQuery {
  @Text({ prompt: "the applicant's national id, as written in the message" })
  applicantId!: string;
}

export class CreditScore {
  @Integer({ prompt: "the credit score, 300 to 850" })
  score!: number;
}

export class LoanDecisionDto {
  @Flag({ prompt: "whether the loan is pre-approved" })
  isApproved!: boolean;

  @Decimal({ prompt: "the yearly rate, 0 to 1", min: 0, max: 1 })
  rate!: number;

  @Text({ prompt: "one sentence: why" })
  reason!: string;
}

export class FundsReservationDto {
  @Text({ prompt: "the reservation's id" })
  reservationId!: string;
}

export class LoanOfferSentDto {
  @Text({ prompt: "the sent offer's id" })
  offerId!: string;
}
```

```ts file=src/loans/services/loans.services.ts
import { ApplicationContext, Injectable } from "@agboss/core";

export class LedgerUnavailableError extends Error {}

@Injectable()
export class CreditBureauService {
  scoreOf(applicantId: string, signal: AbortSignal): Promise<number> {
    signal.throwIfAborted();
    return Promise.resolve(600 + (applicantId.length % 200));
  }
}

@Injectable({ deps: [ApplicationContext] })
export class FundsLedgerService {
  constructor(private readonly applicationContext: ApplicationContext) {}

  reserve(amount: number, idempotencyKey: string): Promise<string> {
    return Promise.resolve(`${this.applicationContext.environmentName}:${String(amount)}:${idempotencyKey}`);
  }

  release(reservationId: string, idempotencyKey: string): Promise<void> {
    void reservationId;
    void idempotencyKey;
    return Promise.resolve();
  }

  sendOffer(reservationId: string, idempotencyKey: string): Promise<string> {
    return Promise.resolve(`offer:${reservationId}:${idempotencyKey}`);
  }

  ping(): Promise<boolean> {
    return Promise.resolve(true);
  }
}
```

```ts file=src/loans/loans.components.ts
import { Action, Agent, ExecutionContext, HealthCheck, HealthCheckResult, SpendRecorder, Tool, WorkflowFinish, WorkflowStart } from "@agboss/core";
import type { ActionHandler, HealthCheckHandler, InputOf, OutputOf, ToolHandler } from "@agboss/core";
import { seconds, usd } from "@agboss/core/units";
import { CreditScore, CreditScoreQuery, FundsReservationDto, LoanApplicationDto, LoanDecisionDto, LoanOfferSentDto } from "./loans.dto.js";
import { CreditBureauService, FundsLedgerService } from "./services/loans.services.js";

@WorkflowStart({ name: "loan-workflow-start", description: "A loan application", input: LoanApplicationDto })
export class LoanWorkflowStart {}

@Tool({
  name: "credit-score-tool",
  description: "The applicant's credit score from the bureau",
  input: CreditScoreQuery,
  output: CreditScore,
  timeout: seconds(5),
  deps: [CreditBureauService, ExecutionContext, SpendRecorder],
})
export class CreditScoreTool implements ToolHandler<CreditScoreQuery, CreditScore> {
  constructor(
    private readonly creditBureauService: CreditBureauService,
    private readonly executionContext: ExecutionContext,
    private readonly spendRecorder: SpendRecorder,
  ) {}

  async run({ applicantId }: CreditScoreQuery): Promise<CreditScore> {
    // the model passed <israeli-id:…>; the tool gets the real id, revealed before validation
    const score: number = await this.creditBureauService.scoreOf(applicantId, this.executionContext.signal);
    this.spendRecorder.record({ service: "credit-bureau", cost: usd(0.01) });
    return { score };
  }
}

@Agent({
  name: "underwriter-agent",
  description: "Pre-approves or declines a loan",
  prompt: "Look the credit score up with credit-score-tool, then pre-approve or decline with a rate.",
  model: "moonshotai/kimi-k2.6",
  input: { application: LoanApplicationDto },
  output: LoanDecisionDto,
  tools: [CreditScoreTool],
  maxToolCalls: 2,
})
export class UnderwriterAgent {}

@Action({ name: "release-funds-action", description: "Releases reserved funds", input: { reservation: FundsReservationDto }, deps: [FundsLedgerService, ExecutionContext] })
export class ReleaseFundsAction implements ActionHandler<ReleaseFundsAction> {
  constructor(
    private readonly fundsLedgerService: FundsLedgerService,
    private readonly executionContext: ExecutionContext,
  ) {}

  async execute(input: InputOf<ReleaseFundsAction>): Promise<void> {
    await this.fundsLedgerService.release(input.reservation.value.reservationId, this.executionContext.step.idempotencyKey);
  }
}

@Action({
  name: "reserve-funds-action",
  description: "Reserves the loan's funds",
  input: { application: LoanApplicationDto },
  output: FundsReservationDto,
  compensateWith: ReleaseFundsAction, // undone if the offer cannot be sent; committed by the finish
  deps: [FundsLedgerService, ExecutionContext],
})
export class ReserveFundsAction implements ActionHandler<ReserveFundsAction> {
  constructor(
    private readonly fundsLedgerService: FundsLedgerService,
    private readonly executionContext: ExecutionContext,
  ) {}

  async execute(input: InputOf<ReserveFundsAction>): Promise<OutputOf<ReserveFundsAction>> {
    const key: string = this.executionContext.step.idempotencyKey;
    return { reservationId: await this.fundsLedgerService.reserve(input.application.value.amount, key) };
  }
}

@Action({
  name: "send-loan-offer-action",
  description: "Sends the offer to the applicant",
  input: { reservation: FundsReservationDto, decision: LoanDecisionDto },
  output: LoanOfferSentDto,
  deps: [FundsLedgerService, ExecutionContext],
})
export class SendLoanOfferAction implements ActionHandler<SendLoanOfferAction> {
  constructor(
    private readonly fundsLedgerService: FundsLedgerService,
    private readonly executionContext: ExecutionContext,
  ) {}

  async execute(input: InputOf<SendLoanOfferAction>): Promise<OutputOf<SendLoanOfferAction>> {
    const key: string = this.executionContext.step.idempotencyKey;
    return { offerId: await this.fundsLedgerService.sendOffer(input.reservation.value.reservationId, key) };
  }
}

@WorkflowFinish({ name: "loan-offered-workflow-finish", description: "The sent offer", output: LoanOfferSentDto })
export class LoanOfferedWorkflowFinish {}

@WorkflowFinish({ name: "loan-not-offered-workflow-finish", description: "Not offered", output: LoanApplicationDto })
export class LoanNotOfferedWorkflowFinish {}

@HealthCheck({ name: "funds-ledger-health-check", timeout: seconds(2), deps: [FundsLedgerService] })
export class FundsLedgerHealthCheck implements HealthCheckHandler {
  constructor(private readonly fundsLedgerService: FundsLedgerService) {}

  async check(): Promise<HealthCheckResult> {
    return (await this.fundsLedgerService.ping())
      ? HealthCheckResult.healthy()
      : HealthCheckResult.unhealthy({ reason: "the funds ledger is unreachable" });
  }
}
```

```ts file=src/loans/loan.workflow.ts
import { StepFailedError, Workflow, start, toAction } from "@agboss/core";
import {
  LoanNotOfferedWorkflowFinish,
  LoanOfferedWorkflowFinish,
  LoanWorkflowStart,
  ReleaseFundsAction,
  ReserveFundsAction,
  SendLoanOfferAction,
  UnderwriterAgent,
} from "./loans.components.js";
import { FundsReservationDto, LoanApplicationDto, LoanDecisionDto, LoanOfferSentDto } from "./loans.dto.js";
import { CreditBureauService, FundsLedgerService } from "./services/loans.services.js";

@Workflow({
  name: "loan-workflow",
  version: "1.0.0",
  flow: [
    start(LoanWorkflowStart)
      .returns(LoanApplicationDto)
      .toAgent(UnderwriterAgent)
      .returns(LoanDecisionDto)
      .toAction(ReserveFundsAction)
      .returns(FundsReservationDto)
      .toAction(SendLoanOfferAction)
      .onError(
        StepFailedError, // the offer failed: release the funds — proved by npx agboss check
        toAction(ReleaseFundsAction)
          .toFinish(LoanNotOfferedWorkflowFinish),
      )
      .returns(LoanOfferSentDto)
      .toFinish(LoanOfferedWorkflowFinish),
  ],
  maxSteps: 2,
  providers: [CreditBureauService, FundsLedgerService],
})
export class LoanWorkflow {}
```

```ts file=src/loans/config/budget.config.ts
import { Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";
import { LenderTenantContext } from "../contexts/lender.context.js";

@Budget({ name: "loans-application-budget", scope: BudgetScope.Application, period: BudgetPeriod.Day })
export class LoansApplicationBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(200);
  }
}

@Budget({ name: "lender-daily-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day, deps: [LenderTenantContext] })
export class LenderDailyBudget implements BudgetHandler {
  constructor(private readonly lenderTenantContext: LenderTenantContext) {}

  maxSpend(): Usd {
    return usd(this.lenderTenantContext.dailyBudgetUsd);
  }
}

@Budget({ name: "loans-execution-budget", scope: BudgetScope.Execution })
export class LoansExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.25);
  }
}
```

```ts file=src/loans/loans.application.ts
import {
  Application,
  SqliteCheckpointSaver,
  SqliteCostLedgerRepository,
  SqliteExecutionLeaseRepository,
  SqliteExecutionRecordRepository,
  SqliteExecutionTreeRepository,
  SqlitePausedExecutionRepository,
  SqliteRateLimitRepository,
} from "@agboss/core";
import { DecisionsModelProvider } from "@agboss/core/models";
import { seconds } from "@agboss/core/units";
import { LenderDailyBudget, LoansApplicationBudget, LoansExecutionBudget } from "./config/budget.config.js";
import { LenderTenantContext } from "./contexts/lender.context.js";
import { LoansEnvironment } from "./environments/app.environment.js";
import { LoanWorkflow } from "./loan.workflow.js";
import { FundsLedgerHealthCheck } from "./loans.components.js";
import { LoansBackupModelProvider, LoansOpenRouterModelProvider } from "./model-providers/loans.model-providers.js";
import { ApplicantPiiPolicy, OutOfScopeGuardrail } from "./safety/loans.safety.js";

@Application({
  name: "loans-application",
  version: "1.0.0",
  environment: LoansEnvironment,
  tenantContext: LenderTenantContext,
  workflows: [LoanWorkflow],
  budgets: [LoansApplicationBudget, LenderDailyBudget, LoansExecutionBudget],
  providers: [
    LoansOpenRouterModelProvider,
    LoansBackupModelProvider,
    DecisionsModelProvider, // the guardrail's decision model: one listed → the list is complete
    SqliteCheckpointSaver,
    SqliteExecutionRecordRepository,
    SqlitePausedExecutionRepository,
    SqliteCostLedgerRepository,
    SqliteExecutionLeaseRepository,
    SqliteExecutionTreeRepository,
    SqliteRateLimitRepository,
  ],
  piiPolicies: [ApplicantPiiPolicy], // every agent and router of every workflow
  pseudonymKey: "piiPseudonymKey",
  guardrails: [OutOfScopeGuardrail],
  healthChecks: [FundsLedgerHealthCheck],
  maxConcurrentSteps: 32,
  shutdownTimeout: seconds(25),
})
export class LoansApplication {}
```

Unit tests — one component on its own container:

```ts file=tests/loans/loans.unit.test.ts
import { expect, it } from "vitest";
import { Injectable } from "@agboss/core";
import { decideWith, override, testGuardrail, testPii, testTool } from "@agboss/core/testing";
import { seconds } from "@agboss/core/units";
import { CreditScoreTool } from "../../src/loans/loans.components.js";
import { ApplicantPiiPolicy, OutOfScopeGuardrail } from "../../src/loans/safety/loans.safety.js";
import { CreditBureauService } from "../../src/loans/services/loans.services.js";

@Injectable()
export class FixedCreditBureauService extends CreditBureauService {
  override scoreOf(): Promise<number> {
    return Promise.resolve(720);
  }
}

it("the credit score tool records the bureau's cost", async () => {
  const runTool = testTool(CreditScoreTool, { overrides: [override(CreditBureauService, FixedCreditBureauService)] });

  const { output, spend } = await runTool({ applicantId: "000000018" }, { timeout: seconds(1) });

  expect(output).toEqual({ score: 720 });
  expect(spend.totalUsd).toBeCloseTo(0.01);
});

it("emails reach a model as tokens and come back revealed", async () => {
  const applicant = testPii([ApplicantPiiPolicy]);

  const { output: masked } = await applicant.mask("Write to dana@example.com");

  expect(masked).not.toContain("dana@example.com");
  expect(applicant.reveal(masked)).toBe("Write to dana@example.com");
});

it("an out-of-scope message is blocked with the refusal", async () => {
  const check = testGuardrail(OutOfScopeGuardrail, { model: decideWith({ blocks: 0.95 }) });

  const { output } = await check("Write me a poem", { element: "underwriter-agent" });

  expect(output).toMatchObject({ isBlocked: true, refusal: "I can only help with loan applications." });
});
```

Integration tests — the whole application, models by script:

```ts file=tests/loans/loans.test.ts
import { expect } from "vitest";
import { CompensationReason, GuardrailBlockedError, HealthStatus, nameOf } from "@agboss/core";
import { callTool, decideWith, replyWith, testWith } from "@agboss/core/testing";
import { LoansApplication } from "../../src/loans/loans.application.js";
import {
  CreditScoreTool,
  LoanNotOfferedWorkflowFinish,
  LoanOfferedWorkflowFinish,
  LoanWorkflowStart,
  ReleaseFundsAction,
  ReserveFundsAction,
  UnderwriterAgent,
} from "../../src/loans/loans.components.js";
import { LoanDecisionDto } from "../../src/loans/loans.dto.js";
import { FundsLedgerService } from "../../src/loans/services/loans.services.js";
import { OutOfScopeGuardrail } from "../../src/loans/safety/loans.safety.js";

const test = testWith(LoansApplication);

const LENDER = { tenant: { tenantId: "bank-a", weight: 3, plan: "enterprise", dailyBudgetUsd: 20 } } as const;
const APPLICATION = { text: "ID 000000018, income $90k, mail dana@example.com", amount: 15000 };
const APPROVED = { isApproved: true, rate: 0.07, reason: "a good score" };

test("a pre-approved loan is offered", async ({ app, mockLlm }) => {
  mockLlm(UnderwriterAgent).thenReturn(
    callTool(CreditScoreTool, { applicantId: "000000018" }),
    replyWith(LoanDecisionDto, APPROVED),
  );

  const result = await app.execute(LoanWorkflowStart, APPLICATION, LENDER);

  expect(result.finish?.name).toBe(nameOf(LoanOfferedWorkflowFinish)); // the finish commits the reservation
  expect(result.compensations).toEqual([]);
  expect((await app.checkReadiness()).status).toBe(HealthStatus.Healthy);
});

test("a failed offer releases the reserved funds", async ({ app, mockLlm, mockOf }) => {
  const ledger = mockOf(FundsLedgerService); // every method of a mocked class is a mock
  ledger.reserve.mockResolvedValue("reservation-1");
  ledger.sendOffer.mockRejectedValue(new Error("mail server down"));
  mockLlm(UnderwriterAgent).thenReturn(replyWith(LoanDecisionDto, APPROVED));

  const result = await app.execute(LoanWorkflowStart, APPLICATION, LENDER);

  expect(result).toFinishWith(LoanNotOfferedWorkflowFinish, APPLICATION);
  expect(result).toHaveCompensated(ReserveFundsAction, { by: ReleaseFundsAction, reason: CompensationReason.SidePath });
  expect(ledger.release.mock.calls[0]?.[0]).toBe("reservation-1");
});

test("an out-of-scope message is refused before the model reads it", async ({ app, mockLlm }) => {
  mockLlm(OutOfScopeGuardrail).thenReturn(decideWith({ blocks: 0.95 }));

  const run = app.execute(LoanWorkflowStart, { text: "Write me a poem", amount: 1 }, LENDER);

  await expect(run).rejects.toFailWith(GuardrailBlockedError, { refusal: "I can only help with loan applications." });
});
```

## Pitfalls

- Copying a recipe's names into a second recipe of the same application: names are unique in the
  application (`[graph.duplicate-node-name]`), DTO names across the project (`[dto.duplicate-name]`).
- Writing the files and skipping `npx agboss check`: the paths are typed by the generated
  `.agboss/types.d.ts` — a fresh file is red until it runs.
- A test with an unused scripted turn: it fails (`test.unused-script`) — script exactly what runs.
- Production without the SQLite (or your own) stores: pauses and budgets live in memory per instance.
