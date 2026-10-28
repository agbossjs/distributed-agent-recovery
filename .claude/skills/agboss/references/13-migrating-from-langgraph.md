# 13 — Migrating from LangGraph

Read this when you move an existing LangGraph graph — `@langchain/langgraph` in TypeScript or
`langgraph` in Python — to AGBoss: a `StateAnnotation` / `TypedDict` state, `addConditionalEdges`,
`Command({ goto })`, `Send` fan-outs, `interrupt()`. The algorithm has four steps. Do them in order
and do not translate node by node before step 1 is done: a line-by-line port keeps every design
problem of the old graph and adds the compiler's complaints on top.

Four mistakes a direct port makes, each prevented by one step:

1. **One "God DTO" for the whole state**, every field optional — the paths then say nothing and every
   node reads everything. Step 1 slices the state into one narrow DTO per thing a node produces.
2. **One `@Router` per `addConditionalEdges`**, even where the edge only reads what an agent just
   decided. An agent's own decision is its output: `output: oneOf(A, B)` + `.switch(caseOf(A)…, caseOf(B)…)`.
   A `@Router` is for a decision of its own — by code (`DecidedBy.Code`) or a classifier model
   (`DecidedBy.Model`).
3. **A review loop without `about` and `historyOf`** — `[input.outdated-on-path]` on the reviewer, or
   `[io.ambiguous-cycle]`. Step 2 says where each one goes.
4. **State interpolated into the prompt** (`` `Review: ${state.draft}` ``). A prompt is static
   instructions; what a node reads is its `input`, which comes in its own input message. A
   `{{input.…}}` in a prompt is `[prompt.input-in-instructions]`, and a prompt that changes per
   execution loses the provider's prompt cache.

Then: `01-composition-and-architecture.md` for the primitives, `02-flow-dsl-all-combinations.md` for
the paths, `05-channels-and-human-in-the-loop.md` for pauses, `10-testing-vcr-and-evals.md` for tests.

## Step 1 — The read / write matrix: from one state to narrow DTOs

List every node of the graph with the state keys it **reads** and the keys it **writes**, and where
the graph goes after it. Read the code, not the names: a key read in a prompt template is read; a key
returned in the node's update is written; a key read only by a conditional edge is a routing flag.
The graph below (Step 3's "before") gives:

| Node          | Reads                                                   | Writes                               | Then                                                               |
| ------------- | ------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------ |
| `classify`    | `message`                                               | `category`                           | `category === "refund"` → `plan`, else `END`                       |
| `plan`        | `orderId`, `message`                                    | `questions`                          | one `Send("research")` per question                                |
| `research`    | `orderId`, `question` (only inside its `Send`)          | `findings` (a reducer: concatenated) | `write`                                                            |
| `write`       | `message`, `findings`, `draft`, `critique`, `revisions` | `draft`, `refundCents`, `revisions`  | `review`                                                           |
| `review`      | `draft`, `findings`                                     | `approved`, `critique`               | `approved` → `routeBySize`; `revisions >= 3` → `END`; else `write` |
| `routeBySize` | `refundCents`                                           | —                                    | `Command({ goto })`: `signOff` or `issueRefund`                    |
| `signOff`     | `draft`, `refundCents`                                  | `approved` (from `interrupt`)        | `approved` → `issueRefund`, else `END`                             |
| `issueRefund` | `orderId`, `refundCents`                                | `refundId`                           | `END`                                                              |

Then turn each column into AGBoss's shapes, rule by rule:

1. **What a node writes together is one DTO**, named for what it is, ending with `Dto`: `write`'s
   `draft` + `refundCents` → `ReplyDraftDto { text, refundCents }`; `issueRefund`'s `refundId` →
   `RefundIssuedDto`. The start's keys (`orderId`, `message`) → the start's input, `SupportRequestDto`.
2. **A flag written only to route is not a field.** `category` disappears — the classifier is a model
   `@Router` whose routes are the outcomes. `approved` + `critique` become two variants of the
   reviewer's output, `oneOf(ChangesRequestedDto, ReplyApprovedDto)`: the variant _is_ the flag, and
   each variant carries only its own fields (`notes` when changes are asked, nothing when approved —
   a marker DTO with an optional note).
3. **A list built by a reducer from parallel nodes is a join.** `questions` → the planner's output
   `listOf(ResearchQuestionDto)`; `question`, set only inside the `Send`, → the item each parallel run
   reads; `findings` (concatenated) → the join's `listOf(ResearchFindingDto)`. No reducer remains.
4. **A counter is a limit.** `revisions` → `maxVisits` on the agents of the loop; the
   `revisions >= 3 → END` edge → `.onError(VisitsLimitExceededError, toFinish(…))`.
5. **A key read before any node wrote it is a bug the old graph hid.** `write` reads `draft` and
   `critique` on its first visit, when they are `undefined` — the prompt says `Draft: undefined`. In
   AGBoss the first writer and the editor are two agents: one reads the findings, the other the draft
   and the changes; a field read where no path brings it is `[input.missing-on-path]`.
6. **What a node interpolates into its prompt is its `input`.** `review`'s
   `` `Reply: ${state.draft}\nFindings: ${state.findings}` `` → `input: { draft: …, findings: … }`
   and a static `prompt`. Constant parameters (a company name, a tone) are `promptVariables`, the same
   for every execution.
7. **A key written and read by nobody is dropped** — kept, it is `[flow.unused-output]`.

The result — one row per DTO, its producer and its readers — is the plan for the files:

| DTO                   | Produced by                   | Read by                                                                    |
| --------------------- | ----------------------------- | -------------------------------------------------------------------------- |
| `SupportRequestDto`   | the start                     | triage router, planner, researcher, writer                                 |
| `ResearchQuestionDto` | planner (`listOf`)            | researcher (one run per item)                                              |
| `ResearchFindingDto`  | researcher (joined: `listOf`) | writer, reviewer                                                           |
| `ReplyDraftDto`       | writer, editor                | reviewer (`historyOf`), editor, size router, refund action, sign-off agent |
| `ChangesRequestedDto` | reviewer (variant)            | editor                                                                     |
| `ReplyApprovedDto`    | reviewer (variant)            | — (the case is the decision)                                               |
| `RefundIssuedDto`     | refund action, sign-off agent | the finish                                                                 |

## Step 2 — The translation table

| LangGraph (TypeScript / Python)                                | AGBoss                                                                                                                                                                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Annotation.Root({…})` / `TypedDict` state                     | narrow DTO classes (`@agboss/core/dto`: `@Text`, `@Integer`, `@ListOf`, `@Nested`, …), one per producer — Step 1                                                                                        |
| `new StateGraph(State)…compile()` / `builder.compile()`        | `@Workflow({ name, version, flow: [paths] })`, listed in `@Application({ workflows })`; `createApp(App)` in production, `testWith(App)` in tests                                                        |
| `START`, entry input                                           | `@WorkflowStart({ input: XDto })`; `app.execute(Start, input)`                                                                                                                                          |
| `END`                                                          | a `@WorkflowFinish({ output: XDto })` — one per way the graph ends; every path ends in one                                                                                                              |
| an LLM node, `createReactAgent`, `model.bindTools`, `ToolNode` | `@Agent({ prompt, model, input, output, tools })` + `@Tool` classes; `output` replaces `withStructuredOutput` and its parsing                                                                           |
| a node of plain code (DB, HTTP, a transform)                   | `@Action({ input, output, deps })` + `ActionHandler`; a side effect to undo on failure: `compensateWith` / `committedBy`                                                                                |
| `addConditionalEdges` reading what an LLM node just decided    | that agent's `output: oneOf(A, B)` + `.returns(oneOf(A, B)).switch(caseOf(A)…, caseOf(B)…)`                                                                                                             |
| `addConditionalEdges` / `Command({ goto })` decided by code    | `@Router({ decidedBy: DecidedBy.Code, routes })` + `RouterHandler`: `route(input)` returns a target; `.toRouter(R).chooseOne(route(X)…, …)`                                                             |
| `addConditionalEdges` with an LLM classifier                   | `@Router({ decidedBy: DecidedBy.Model, prompt, model, routes: [{ prompt, target }] })` — a decision model or a chat model                                                                               |
| a cycle `critic → editor → critic`                             | the reviewer in its own path `agent(Reviewer)…`; `caseOf(ChangesDto, { about: DraftDto })` (or `.returns(CritiqueDto, { about: DraftDto })`); `historyOf(DraftDto, { limit })` to read earlier versions |
| a loop counter, `recursionLimit`                               | `maxVisits` on a node, `@Workflow({ maxSteps })`; `.onError(VisitsLimitExceededError, …)` for the way out                                                                                               |
| `new Send(node, item)` per list item                           | `.returns(listOf(ItemDto)).toParallelAgents(Agent, { maxConcurrency, maxItems })` (or `.toParallelWorkflows(Child, …)`) then `.join().returns(listOf(OutDto))`                                          |
| `Send` to several different nodes, "first N answers win"       | `.toParallelAgents(A, B, C)` + `.join()`, or `.acceptedBy(Arbiter).joinQuorum({ min, max, deadline })`                                                                                                  |
| a reducer (`(a, b) => a.concat(b)`, `operator.add`)            | the join's `listOf(…)` — values are never merged by hand                                                                                                                                                |
| a subgraph                                                     | a child `@Workflow`: `.toWorkflow(Child)`, its own scope (only its start's input), its finishes' outputs as the step's result                                                                           |
| `interrupt(payload)` + `Command({ resume })`                   | a `@Tool({ channel: Role })` whose call needs an answer: a `@ChannelRole` (`extends ChannelOf<Self>`) and its `@Channel` returning `ChannelOutcome.awaitReply()`; `app.resume({ pauseId, decision })`   |
| `thread_id` in `configurable`                                  | `app.execute(Start, input, { threadId, ownerId })`                                                                                                                                                      |
| `MessagesAnnotation`, a messages reducer                       | across executions, the thread's turns: each agent sees its last `uncompactedTurns`, older ones through a `@Compaction`; within one, an agent's tool loop keeps its own messages                         |
| `MemorySaver`, `PostgresSaver`                                 | infrastructure in `@Application({ providers })`: `SqliteCheckpointSaver`, `SqlitePausedExecutionRepository`, … (in-memory by default)                                                                   |
| `streamMode: "updates"`                                        | `app.execute(…, { onStream })`; observers in `@Application({ observers })` for events                                                                                                                   |

There is no pause step in an AGBoss flow: a pause is always a tool call through a channel. An
`interrupt()` inside plain code therefore becomes a tool an agent calls (as in Step 3's sign-off
agent), with the approval asked before the tool runs; the decision is validated and recorded.

**Where a node goes in `flow`.** A node reached from one place is continued inline, right where it
is reached; a node reached from two or more places (the reviewer: from the writer and from the
editor) is continued once, in its own path that starts with `agent(X)` / `router(R)` / `action(A)`,
and every path into it ends with the step of its kind (`.toAgent(X)`, `.toRouter(R)`, …). The other way round is `[flow.shared-node-inline]`
or `[flow.single-entry-own-path]`.

## Step 3 — Before and after

### Before: one state, edges as functions

<!-- snippet-context
// the legacy application's own services, called from its nodes
const orderBook = {
  factsOf: (orderId: string): Promise<string> => Promise.resolve(`order ${orderId}: delivered late`),
};
const refundApi = {
  issue: (orderId: string, amountCents: number): Promise<string> =>
    Promise.resolve(`refund-${orderId}-${String(amountCents)}`),
};
// @snippet
-->

```ts file=legacy/support.graph.ts
import { Annotation, Command, END, MemorySaver, START, Send, StateGraph, interrupt } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

const model = new ChatOpenAI({ model: "gpt-4.1-mini", temperature: 0 });

// one state for every node: each reads and writes what it likes
export const SupportState = Annotation.Root({
  orderId: Annotation<string>,
  message: Annotation<string>,
  category: Annotation<"refund" | "other">,
  questions: Annotation<string[]>,
  question: Annotation<string>, // only set inside a Send to "research"
  findings: Annotation<string[]>({ reducer: (left, right) => left.concat(right), default: () => [] }),
  draft: Annotation<string>,
  refundCents: Annotation<number>,
  critique: Annotation<string>,
  approved: Annotation<boolean>,
  revisions: Annotation<number>({ reducer: (_, right) => right, default: () => 0 }),
  refundId: Annotation<string>,
});

type SupportStateType = typeof SupportState.State;
type SupportUpdate = typeof SupportState.Update;

const REFUND_SIGN_OFF_CENTS = 10_000;

async function classify(state: SupportStateType): Promise<SupportUpdate> {
  const answer = await model
    .withStructuredOutput(z.object({ category: z.enum(["refund", "other"]) }))
    .invoke(`Is this about a refund? Message: ${state.message}`);
  return { category: answer.category };
}

async function plan(state: SupportStateType): Promise<SupportUpdate> {
  const answer = await model
    .withStructuredOutput(z.object({ questions: z.array(z.string()) }))
    .invoke(`List what to check before answering order ${state.orderId}: ${state.message}`);
  return { questions: answer.questions };
}

async function research(state: SupportStateType): Promise<SupportUpdate> {
  const facts = await orderBook.factsOf(state.orderId);
  const answer = await model.invoke(`Answer "${state.question}" from: ${facts}`);
  return { findings: [`${state.question}: ${answer.text}`] };
}

async function write(state: SupportStateType): Promise<SupportUpdate> {
  const answer = await model
    .withStructuredOutput(z.object({ text: z.string(), refundCents: z.number().int() }))
    .invoke(
      `Reply to the customer, fixing: ${state.critique}.\n` +
        `Message: ${state.message}\nFindings: ${state.findings.join("\n")}\nDraft: ${state.draft}`,
    );
  return { draft: answer.text, refundCents: answer.refundCents, revisions: state.revisions + 1 };
}

async function review(state: SupportStateType): Promise<SupportUpdate> {
  const answer = await model
    .withStructuredOutput(z.object({ approved: z.boolean(), critique: z.string() }))
    .invoke(`Review this reply against the findings.\nReply: ${state.draft}\nFindings: ${state.findings.join("\n")}`);
  return { approved: answer.approved, critique: answer.critique };
}

function routeBySize(state: SupportStateType): Command {
  return new Command({ goto: state.refundCents > REFUND_SIGN_OFF_CENTS ? "signOff" : "issueRefund" });
}

function signOff(state: SupportStateType): SupportUpdate {
  const decision = interrupt<{ draft: string; refundCents: number }, { approved: boolean }>({
    draft: state.draft,
    refundCents: state.refundCents,
  });
  return { approved: decision.approved };
}

async function issueRefund(state: SupportStateType): Promise<SupportUpdate> {
  return { refundId: await refundApi.issue(state.orderId, state.refundCents) };
}

export const supportGraph = new StateGraph(SupportState)
  .addNode("classify", classify)
  .addNode("plan", plan)
  .addNode("research", research)
  .addNode("write", write)
  .addNode("review", review)
  .addNode("routeBySize", routeBySize, { ends: ["signOff", "issueRefund"] })
  .addNode("signOff", signOff)
  .addNode("issueRefund", issueRefund)
  .addEdge(START, "classify")
  .addConditionalEdges("classify", (state) => (state.category === "refund" ? "plan" : END))
  .addConditionalEdges("plan", (state) =>
    state.questions.map((question) => new Send("research", { ...state, question })),
  )
  .addEdge("research", "write")
  .addEdge("write", "review")
  .addConditionalEdges("review", (state) => {
    if (state.approved) return "routeBySize";
    return state.revisions >= 3 ? END : "write";
  })
  .addConditionalEdges("signOff", (state) => (state.approved ? "issueRefund" : END))
  .addEdge("issueRefund", END)
  .compile({ checkpointer: new MemorySaver() });
```

Its test calls the real model, pays for every run and passes or fails with the model's mood:

```ts file=legacy/support.graph.test.ts
import { Command } from "@langchain/langgraph";
import { expect, test } from "vitest";
import { supportGraph } from "./support.graph.js";

test("a refund request ends with a refund id", async () => {
  const config = { configurable: { thread_id: "thread-1" } };
  await supportGraph.invoke({ orderId: "7", message: "My order came late, refund it please" }, config);
  const final = await supportGraph.invoke(new Command({ resume: { approved: true } }), config);
  expect(final.refundId).toMatch(/^refund-7-/u);
}, 60_000);
```

### After: narrow DTOs, components, paths

The files follow Step 1's table. In a project each class is a file of its own
(`agents/writer.agent.ts`, …); a few share a file here for brevity.

```ts file=src/support/support.dto.ts
import { Integer, Text } from "@agboss/core/dto";

export class SupportRequestDto {
  @Text({ prompt: "the order the customer writes about" })
  orderId!: string;

  @Text({ prompt: "the customer's message" })
  message!: string;
}

export class ResearchQuestionDto {
  @Text({ prompt: "one thing to check before answering" })
  question!: string;
}

export class ResearchFindingDto {
  @Text({ prompt: "the question checked" })
  question!: string;

  @Text({ prompt: "what the order's facts say" })
  answer!: string;
}

export class ReplyDraftDto {
  @Text({ prompt: "the reply to the customer" })
  text!: string;

  @Integer({ prompt: "the refund the reply promises, in cents (0 for none)", min: 0 })
  refundCents!: number;
}

export class ChangesRequestedDto {
  @Text({ prompt: "what to change in the reply" })
  notes!: string;
}

/** The reviewer's approval: the variant is the decision, so it needs no flag. */
export class ReplyApprovedDto {
  @Text({ prompt: "a note for the record", optional: true })
  note?: string;
}

export class RefundOrderDto {
  @Text({ prompt: "the order to refund" })
  orderId!: string;

  @Integer({ prompt: "the amount in cents", min: 1 })
  amountCents!: number;
}

export class RefundIssuedDto {
  @Text({ prompt: "the refund's id" })
  refundId!: string;
}

export class OrderLookupDto {
  @Text({ prompt: "the order id" })
  orderId!: string;
}

export class OrderFactsDto {
  @Text({ prompt: "what is known about the order" })
  facts!: string;
}
```

The services the old nodes called are injected, the `interrupt()` becomes a channel role on the tool
that issues a large refund:

```ts file=src/support/support.services.ts
import { Injectable } from "@agboss/core";

@Injectable()
export class OrderBookService {
  factsOf(orderId: string): Promise<string> {
    return Promise.resolve(`order ${orderId}: delivered late`);
  }
}

@Injectable()
export class RefundApiService {
  issue(orderId: string, amountCents: number, idempotencyKey: string): Promise<string> {
    return Promise.resolve(`refund-${orderId}-${String(amountCents)}-${idempotencyKey}`);
  }
}

@Injectable()
export class SupervisorQueueService {
  notify(pauseId: string, text: string): Promise<void> {
    void pauseId;
    void text;
    return Promise.resolve();
  }
}
```

```ts file=src/support/channels/refund-sign-off.channel.ts
// interrupt({ draft, refundCents }) → the role: what is approved and who answers
import { Channel, ChannelOf, ChannelOutcome, ChannelRole, PauseAnswerer } from "@agboss/core";
import type { ChannelAsk } from "@agboss/core";
import { RefundOrderDto } from "../support.dto.js";
import { SupervisorQueueService } from "../support.services.js";

@ChannelRole({
  name: "refund-sign-off-channel",
  description: "A supervisor signs off a large refund before it is issued",
  approves: RefundOrderDto, // the input of the tool that names the role
  answeredBy: PauseAnswerer.ThreadOwner,
})
export abstract class RefundSignOffChannel extends ChannelOf<RefundSignOffChannel> {}

@Channel({ name: "supervisor-queue-refund-sign-off-channel", description: "Puts the refund in the supervisors' queue", deps: [SupervisorQueueService] })
export class SupervisorQueueRefundSignOffChannel extends RefundSignOffChannel {
  constructor(private readonly supervisorQueueService: SupervisorQueueService) {
    super();
  }

  async send(ask: ChannelAsk<RefundSignOffChannel>): Promise<ChannelOutcome<RefundSignOffChannel>> {
    const { orderId, amountCents } = ask.value.arguments;
    await this.supervisorQueueService.notify(ask.pauseId, `Refund ${String(amountCents)} cents on order ${orderId}?`);
    return ChannelOutcome.awaitReply(); // Command({ resume }) becomes app.resume({ pauseId, decision })
  }
}
```

```ts file=src/support/support.tools.ts
import { ExecutionContext, Tool, type ToolHandler } from "@agboss/core";
import { RefundSignOffChannel } from "./channels/refund-sign-off.channel.js";
import { OrderFactsDto, OrderLookupDto, RefundIssuedDto, RefundOrderDto } from "./support.dto.js";
import { OrderBookService, RefundApiService } from "./support.services.js";

@Tool({ name: "order-lookup-tool", description: "What is known about an order", input: OrderLookupDto, output: OrderFactsDto, deps: [OrderBookService] })
export class OrderLookupTool implements ToolHandler<OrderLookupDto, OrderFactsDto> {
  constructor(private readonly orderBookService: OrderBookService) {}

  async run({ orderId }: OrderLookupDto): Promise<OrderFactsDto> {
    return { facts: await this.orderBookService.factsOf(orderId) };
  }
}

@Tool({
  name: "issue-signed-off-refund-tool",
  description: "Issues a large refund — a supervisor signs it off first",
  input: RefundOrderDto,
  output: RefundIssuedDto,
  channel: RefundSignOffChannel, // the role, never its implementation
  deps: [RefundApiService, ExecutionContext],
})
export class IssueSignedOffRefundTool implements ToolHandler<RefundOrderDto, RefundIssuedDto> {
  constructor(
    private readonly refundApiService: RefundApiService,
    private readonly executionContext: ExecutionContext,
  ) {}

  async run({ orderId, amountCents }: RefundOrderDto): Promise<RefundIssuedDto> {
    const key: string = this.executionContext.step.idempotencyKey;
    return { refundId: await this.refundApiService.issue(orderId, amountCents, key) };
  }
}
```

Each LLM node is an agent with a static prompt and typed `input` / `output` — no `withStructuredOutput`,
no string building. The writer and the editor are two agents: the first never reads a draft.

```ts file=src/support/support.agents.ts
import { Agent, historyOf, listOf, oneOf } from "@agboss/core";
import {
  ChangesRequestedDto,
  ReplyApprovedDto,
  ReplyDraftDto,
  RefundIssuedDto,
  ResearchFindingDto,
  ResearchQuestionDto,
  SupportRequestDto,
} from "./support.dto.js";
import { IssueSignedOffRefundTool, OrderLookupTool } from "./support.tools.js";

@Agent({
  name: "research-planner-agent",
  description: "Lists what to check before answering",
  prompt: "List the questions to check before answering the customer about their order.",
  model: "moonshotai/kimi-k2.6",
  input: { request: SupportRequestDto },
  output: listOf(ResearchQuestionDto),
})
export class ResearchPlannerAgent {}

@Agent({
  name: "order-researcher-agent",
  description: "Answers one question from the order's facts",
  prompt: "Answer the question from the order's facts. Look the order up with order-lookup-tool.",
  model: "moonshotai/kimi-k2.6",
  input: { question: ResearchQuestionDto, request: SupportRequestDto },
  output: ResearchFindingDto,
  tools: [OrderLookupTool],
  maxToolCalls: 2,
})
export class OrderResearcherAgent {}

@Agent({
  name: "reply-writer-agent",
  description: "Writes the first reply from the findings",
  prompt: "Write a short, honest reply. Promise a refund only when the findings support one.",
  model: "moonshotai/kimi-k2.6",
  input: { request: SupportRequestDto, findings: listOf(ResearchFindingDto) },
  output: ReplyDraftDto,
})
export class ReplyWriterAgent {}

@Agent({
  name: "reply-reviewer-agent",
  description: "Approves the reply or asks for changes",
  prompt: "Approve the reply if the findings support every claim in it; otherwise say what to change. Do not ask again for what an earlier version fixed.",
  model: "moonshotai/kimi-k2.6",
  input: { draft: historyOf(ReplyDraftDto, { limit: 2 }), findings: listOf(ResearchFindingDto) },
  output: oneOf(ChangesRequestedDto, ReplyApprovedDto), // the old `approved` flag and `critique`
  maxVisits: 3,
})
export class ReplyReviewerAgent {}

@Agent({
  name: "reply-editor-agent",
  description: "Rewrites the reply as asked",
  prompt: "Rewrite the reply so it meets every requested change.",
  model: "moonshotai/kimi-k2.6",
  input: { draft: ReplyDraftDto, changes: ChangesRequestedDto },
  output: ReplyDraftDto,
  maxVisits: 2, // the old `revisions` counter
})
export class ReplyEditorAgent {}

@Agent({
  name: "refund-sign-off-agent",
  description: "Issues a large refund once it is signed off",
  prompt: "Issue the refund the reply promises with issue-signed-off-refund-tool, then report its id.",
  model: "moonshotai/kimi-k2.6",
  input: { request: SupportRequestDto, draft: ReplyDraftDto },
  output: RefundIssuedDto,
  tools: [IssueSignedOffRefundTool],
  maxToolCalls: 1,
})
export class RefundSignOffAgent {}
```

The classifier is a model router (its outcome is where to go, not data); `routeBySize`'s
`Command({ goto })` is a code router; the plain-code `issueRefund` node is an action:

```ts file=src/support/support.nodes.ts
import { Action, DecidedBy, ExecutionContext, Router, WorkflowFinish, WorkflowStart } from "@agboss/core";
import type { ActionHandler, InputOf, OutputOf, Route, RouterHandler } from "@agboss/core";
import { ResearchPlannerAgent, RefundSignOffAgent } from "./support.agents.js";
import { RefundIssuedDto, ReplyDraftDto, SupportRequestDto } from "./support.dto.js";
import { RefundApiService } from "./support.services.js";

@WorkflowStart({ name: "support-workflow-start", description: "A customer's message about an order", input: SupportRequestDto })
export class SupportWorkflowStart {}

@WorkflowFinish({ name: "refund-issued-workflow-finish", description: "The refund was issued", output: RefundIssuedDto })
export class RefundIssuedWorkflowFinish {}

@WorkflowFinish({ name: "hand-over-workflow-finish", description: "Not a refund: for the team", output: SupportRequestDto })
export class HandOverWorkflowFinish {}

@WorkflowFinish({ name: "reply-stuck-workflow-finish", description: "The review did not converge", output: SupportRequestDto })
export class ReplyStuckWorkflowFinish {}

@Router({
  name: "support-triage-router",
  description: "Sends a refund request on, hands anything else over",
  decidedBy: DecidedBy.Model,
  prompt: "Decide whether the customer asks for a refund.",
  model: "typesafe/jev-1.13",
  input: { request: SupportRequestDto },
  routes: [
    { prompt: "The customer asks for a refund", target: ResearchPlannerAgent },
    { prompt: "Stop and hand the message over: it is not about a refund", target: HandOverWorkflowFinish },
  ],
})
export class SupportTriageRouter {}

@Action({
  name: "issue-refund-action",
  description: "Issues a refund below the sign-off limit",
  input: { request: SupportRequestDto, draft: ReplyDraftDto },
  output: RefundIssuedDto,
  deps: [RefundApiService, ExecutionContext],
})
export class IssueRefundAction implements ActionHandler<IssueRefundAction> {
  constructor(
    private readonly refundApiService: RefundApiService,
    private readonly executionContext: ExecutionContext,
  ) {}

  async execute(input: InputOf<IssueRefundAction>): Promise<OutputOf<IssueRefundAction>> {
    const key: string = this.executionContext.step.idempotencyKey; // a retry after a crash is one refund
    return { refundId: await this.refundApiService.issue(input.request.value.orderId, input.draft.value.refundCents, key) };
  }
}

const REFUND_SIGN_OFF_CENTS = 10_000;

@Router({
  name: "refund-size-router",
  description: "Issues a small refund at once, sends a large one for sign-off",
  decidedBy: DecidedBy.Code,
  input: { draft: ReplyDraftDto },
  routes: [{ target: IssueRefundAction }, { target: RefundSignOffAgent }],
})
export class RefundSizeRouter implements RouterHandler<RefundSizeRouter> {
  route(input: InputOf<RefundSizeRouter>): Route<RefundSizeRouter> {
    return input.draft.value.refundCents > REFUND_SIGN_OFF_CENTS ? RefundSignOffAgent : IssueRefundAction;
  }
}
```

The graph's edges become two paths: the main one, and the reviewer's own (it is reached from the
writer and from the editor). The `Send` fan-out is a per-item launch, the reducer its join; the
review edge is the reviewer's `oneOf` output; `revisions >= 3 → END` is the editor's `maxVisits`:

```ts file=src/support/support.workflow.ts
import { VisitsLimitExceededError, Workflow, agent, caseOf, listOf, oneOf, route, start, toFinish } from "@agboss/core";
import {
  OrderResearcherAgent,
  RefundSignOffAgent,
  ReplyEditorAgent,
  ReplyReviewerAgent,
  ReplyWriterAgent,
  ResearchPlannerAgent,
} from "./support.agents.js";
import { ChangesRequestedDto, RefundIssuedDto, ReplyApprovedDto, ReplyDraftDto, ResearchFindingDto, ResearchQuestionDto, SupportRequestDto } from "./support.dto.js";
import {
  HandOverWorkflowFinish,
  IssueRefundAction,
  RefundIssuedWorkflowFinish,
  RefundSizeRouter,
  ReplyStuckWorkflowFinish,
  SupportTriageRouter,
  SupportWorkflowStart,
} from "./support.nodes.js";
import { OrderBookService, RefundApiService } from "./support.services.js";

@Workflow({
  name: "support-workflow",
  version: "1.0.0",
  flow: [
    start(SupportWorkflowStart)
      .returns(SupportRequestDto)
      .toRouter(SupportTriageRouter)
      .chooseOne(
        route(ResearchPlannerAgent)
          .returns(listOf(ResearchQuestionDto))
          .toParallelAgents(OrderResearcherAgent, { maxConcurrency: 3, maxItems: 5 }) // new Send(…) per question
          .join()
          .returns(listOf(ResearchFindingDto)) // the reducer's concatenated findings
          .toAgent(ReplyWriterAgent)
          .returns(ReplyDraftDto)
          .toAgent(ReplyReviewerAgent),
        route(HandOverWorkflowFinish),
      ),

    agent(ReplyReviewerAgent)
      .returns(oneOf(ChangesRequestedDto, ReplyApprovedDto))
      .switch(
        caseOf(ChangesRequestedDto, { about: ReplyDraftDto }) // the changes are about this draft
          .toAgent(ReplyEditorAgent)
          .onError(VisitsLimitExceededError, toFinish(ReplyStuckWorkflowFinish))
          .returns(ReplyDraftDto)
          .toAgent(ReplyReviewerAgent),
        caseOf(ReplyApprovedDto)
          .toRouter(RefundSizeRouter)
          .chooseOne(
            route(IssueRefundAction)
              .returns(RefundIssuedDto)
              .toFinish(RefundIssuedWorkflowFinish),
            route(RefundSignOffAgent)
              .returns(RefundIssuedDto)
              .toFinish(RefundIssuedWorkflowFinish),
          ),
      ),
  ],
  maxSteps: 16,
  providers: [OrderBookService, RefundApiService],
})
export class SupportWorkflow {}
```

The `compile({ checkpointer })` call becomes the application: its workflows, budgets and
infrastructure — here the channel's implementation; in production also `SqliteCheckpointSaver` and
`SqlitePausedExecutionRepository`, so a pause survives a restart (`09-persistence-k8s-and-deploy.md`).

```ts file=src/support/support.application.ts
import { Application, Budget, BudgetPeriod, BudgetScope, EmptyEnvironment, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";
import { SupervisorQueueRefundSignOffChannel } from "./channels/refund-sign-off.channel.js";
import { SupervisorQueueService } from "./support.services.js";
import { SupportWorkflow } from "./support.workflow.js";

@Budget({ name: "support-application-budget", scope: BudgetScope.Application, period: BudgetPeriod.Day })
export class SupportApplicationBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(10);
  }
}

@Budget({ name: "support-tenant-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
export class SupportTenantBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(2);
  }
}

@Budget({ name: "support-execution-budget", scope: BudgetScope.Execution })
export class SupportExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.2);
  }
}

@Application({
  name: "support-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [SupportWorkflow],
  budgets: [SupportApplicationBudget, SupportTenantBudget, SupportExecutionBudget],
  providers: [SupervisorQueueRefundSignOffChannel, SupervisorQueueService],
})
export class SupportApplication {}
```

## Step 4 — Let the compiler find what the graph hid, then move the tests

Run `npx agboss check` after the first files exist and after every change. A LangGraph graph
compiles whatever its nodes read; an AGBoss flow is checked path by path, so a port surfaces latent
bugs as rule codes — fix each in the design, never by widening a DTO:

| Code                             | What it found in the old graph                                                                | The fix                                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `[input.missing-on-path]`        | a node read a key no node before it wrote on every path (`write`'s first `draft`, `critique`) | split the node (writer / editor), or read the field only where a path brings it           |
| `[input.outdated-on-path]`       | a node read a value built from an older version of what was rewritten since (stale critique)  | `about` on the value it is about, `historyOf(Dto, { limit })` for the earlier versions    |
| `[io.ambiguous-cycle]`           | in a loop of values built from each other, nothing said which draft a critique is about       | `caseOf(ChangesDto, { about: DraftDto })` or `.returns(CritiqueDto, { about: DraftDto })` |
| `[flow.unused-output]`           | a key written and read by nobody                                                              | drop it from the DTO, or read it below                                                    |
| `[launch.max-items-required]`    | a `Send` per item with no bound — a long list fanned out without limit                        | `maxItems` (and `maxConcurrency`) on the launch                                           |
| `[launch.item-not-read]`         | the parallel node does not read the item it is launched for                                   | an `input` field of the item's DTO                                                        |
| `[flow.shared-node-inline]`      | a node reached from two places was continued inline                                           | its own path `agent(X)…`, every path into it ending `.toAgent(X)`                         |
| `[router.routes-mismatch]`       | a conditional edge's targets and the router's `chooseOne` differ                              | one `route(…)` per `@Router` route                                                        |
| `[prompt.input-in-instructions]` | state interpolated into the prompt                                                            | an `input` field; the prompt stays static                                                 |
| `[limits.max-steps-too-low]`     | `recursionLimit` was the only bound                                                           | a `maxSteps` the longest path fits, `maxVisits` on each node of a loop                    |

Then `npx agboss describe`: the flow as assembled, each node's inputs with their producers — check it
reads like the old graph's intent, not like its edges.

The tests move from live calls to scripts: no key, no network, no cost, the same result every run.
`testWith(App)` scripts each model by class; the path, the finish and the pause are asserted by
class, and a code component is tested alone with its unit runner:

```ts file=tests/support/support.test.ts
import { expect, it } from "vitest";
import { ExecutionStatus } from "@agboss/core";
import { callTool, replyWith, routeTo, testRouter, testWith } from "@agboss/core/testing";
import { SupportApplication } from "../../src/support/support.application.js";
import {
  OrderResearcherAgent,
  RefundSignOffAgent,
  ReplyEditorAgent,
  ReplyReviewerAgent,
  ReplyWriterAgent,
  ResearchPlannerAgent,
} from "../../src/support/support.agents.js";
import { ChangesRequestedDto, RefundIssuedDto, ReplyApprovedDto, ReplyDraftDto, ResearchFindingDto, ResearchQuestionDto } from "../../src/support/support.dto.js";
import {
  IssueRefundAction,
  RefundIssuedWorkflowFinish,
  RefundSizeRouter,
  SupportTriageRouter,
  SupportWorkflowStart,
} from "../../src/support/support.nodes.js";
import { IssueSignedOffRefundTool, OrderLookupTool } from "../../src/support/support.tools.js";

const test = testWith(SupportApplication);

const REQUEST = { orderId: "7", message: "My order came late, refund it please" };

test("a small refund: one round of changes, then issued at once", async ({ app, mockLlm }) => {
  mockLlm(SupportTriageRouter).thenReturn(routeTo(ResearchPlannerAgent));
  mockLlm(ResearchPlannerAgent).thenReturn(replyWith(ResearchQuestionDto, [{ question: "Was it late?" }]));
  mockLlm(OrderResearcherAgent).thenReturn(
    callTool(OrderLookupTool, { orderId: "7" }),
    replyWith(ResearchFindingDto, { question: "Was it late?", answer: "yes, by four days" }),
  );
  mockLlm(ReplyWriterAgent).thenReturn(replyWith(ReplyDraftDto, { text: "Sorry — refund on its way.", refundCents: 2_500 }));
  mockLlm(ReplyReviewerAgent).thenReturn(
    replyWith(ChangesRequestedDto, { notes: "say how many days late" }),
    replyWith(ReplyApprovedDto, {}),
  );
  mockLlm(ReplyEditorAgent).thenReturn(replyWith(ReplyDraftDto, { text: "Four days late — sorry, refund on its way.", refundCents: 2_500 }));

  const result = await app.execute(SupportWorkflowStart, REQUEST);

  expect(result).toFollowPath([
    SupportWorkflowStart,
    SupportTriageRouter,
    ResearchPlannerAgent,
    OrderResearcherAgent,
    ReplyWriterAgent,
    ReplyReviewerAgent,
    ReplyEditorAgent,
    ReplyReviewerAgent,
    RefundSizeRouter,
    IssueRefundAction,
    RefundIssuedWorkflowFinish,
  ]);
});

test("a large refund pauses for sign-off and is issued after app.resume", async ({ app, mockLlm }) => {
  mockLlm(SupportTriageRouter).thenReturn(routeTo(ResearchPlannerAgent));
  mockLlm(ResearchPlannerAgent).thenReturn(replyWith(ResearchQuestionDto, [{ question: "Was it late?" }]));
  mockLlm(OrderResearcherAgent).thenReturn(
    replyWith(ResearchFindingDto, { question: "Was it late?", answer: "yes, by four days" }),
  );
  mockLlm(ReplyWriterAgent).thenReturn(replyWith(ReplyDraftDto, { text: "Full refund.", refundCents: 25_000 }));
  mockLlm(ReplyReviewerAgent).thenReturn(replyWith(ReplyApprovedDto, {}));
  mockLlm(RefundSignOffAgent).thenReturn(
    callTool(IssueSignedOffRefundTool, { orderId: "7", amountCents: 25_000 }), // interrupt() was here
    replyWith(RefundIssuedDto, { refundId: "refund-7" }),
  );

  const paused = await app.execute(SupportWorkflowStart, REQUEST, { ownerId: "supervisor-1" });

  expect(paused.status).toBe(ExecutionStatus.Paused);
  expect(paused).toHavePausedAt(RefundSignOffAgent);

  const pauseId: string = paused.pending[0]?.pauseId ?? "";
  const result = await app.resume({ pauseId, decision: { approved: true } }, { ownerId: "supervisor-1" });

  expect(result).toFinishWith(RefundIssuedWorkflowFinish, { refundId: "refund-7" });
});

it("the size router decides by code, at no cost", async () => {
  const runRouter = testRouter(RefundSizeRouter);

  const { output } = await runRouter({
    draft: { producer: ReplyWriterAgent, value: { text: "Full refund.", refundCents: 25_000 } },
  });

  expect(output).toBe(RefundSignOffAgent);
});
```

Real answers for the same tests come from a recorded cassette (`testWith(App, { vcr })`), and the
behaviour a live model must keep goes in an `@EvalSuite` — both in `10-testing-vcr-and-evals.md`.

## The checklist

1. The read / write matrix written; every key placed: a DTO field, a variant, a route, a join, a
   limit, or dropped.
2. One DTO per producer, ending with `Dto`; no field optional only because "some node may not have
   set it".
3. Each node a component of its kind: agent (a model), action (code), router (a decision of its own),
   child workflow (a subgraph); every `interrupt()` a tool with a channel role.
4. Prompts static; what changes per execution in `input`.
5. The flow: one path per node reached from two places; `about` and `historyOf` on every loop;
   `maxItems` on every launch; `maxVisits` on every node of a loop; each way out a finish.
6. `npx agboss check` prints `ok:`, `npx agboss describe` reads like the old graph's intent, and
   `npm test` passes on scripts only.
