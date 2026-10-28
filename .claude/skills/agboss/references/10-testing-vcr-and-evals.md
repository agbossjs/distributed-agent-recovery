# 10 — Testing, VCR and evals

Read this before writing any test. Tests never call a real model or the network: the whole
application runs under `testWith(App)` with scripted models, and one component runs alone under its
unit runner. Real-model checks are recorded cassettes (VCR) and evals.

| You test…                                                                                                     | Use                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a path through the application                                                                                | `testWith(App)` → `app.execute(Start, input)`, `mockLlm(X).thenReturn(…)`, matchers                                                                                 |
| a race between parallel branches                                                                              | `testWith(App, { concurrency: TestConcurrency.inOrder([step(A), step(B)]) })`                                                                                       |
| time: timeouts, retries, retention, leases                                                                    | the `clock` fixture: `await clock.advance(seconds(31))`                                                                                                             |
| a restart, a second instance                                                                                  | `recoverApp()`, `testWith(App, { instances: 2 })` → `apps`                                                                                                          |
| one tool, action, router, arbiter, knowledge base, judge, guardrail, PII policy, tool interceptor, compaction | its unit runner: `testTool`, `testAction`, `testRouter`, `testArbiter`, `testRag`, `testJudge`, `testGuardrail`, `testToolInterceptor`, `testPii`, `testCompaction` |
| real model answers, replayed in CI                                                                            | `testWith(App, { vcr: { cassetteName } })`                                                                                                                          |
| what a live-model run must do, case by case                                                                   | `@EvalSuite` (`@agboss/core/eval`): cases, `checkTrajectory()`, `judgedBy(Judge)`, `EvalCascade`; `npx agboss eval run --suite <name> --runs <k>`                   |
| quality over real traffic                                                                                     | `npx agboss golden add`, `npx agboss eval score`, `npx agboss compare`                                                                                              |

`vitest.config.ts` registers the matchers: `setupFiles: ["@agboss/core/testing/setup"]`. A project made by
`npx agboss create` has three Vitest projects by file name, next to the sources: `src/**/*.test.ts`
(unit: scripts and fakes), `*.integration.test.ts` (recorded answers, real MCP servers) and
`*.suite.test.ts` (real models, budget-capped); `npm test` runs the first two.

## The application under test

A candidate screening: two agents score in parallel, a code arbiter checks each answer, a verdict
agent decides (judged, guarded, with a knowledge base in context), a code router saves a hire.

```ts file=src/screening/dtos/screening.dto.ts
import { Integer, OneOf, Text } from "@agboss/core/dto";

export class CandidateDto {
  @Text({ prompt: "the candidate's name" })
  name!: string;

  @Text({ prompt: "the candidate's CV" })
  cv!: string;
}

export class SkillsReportDto {
  @Integer({ prompt: "technical skills, 1 to 10", min: 1, max: 10 })
  score!: number;

  @Text({ prompt: "what the score rests on" })
  notes!: string;
}

export class CultureReportDto {
  @Integer({ prompt: "team fit, 1 to 10", min: 1, max: 10 })
  score!: number;

  @Text({ prompt: "what the score rests on" })
  notes!: string;
}

export class VerdictDto {
  @OneOf({ values: ["hire", "reject"], prompt: "the decision" })
  decision!: "hire" | "reject";

  @Text({ prompt: "why, in one sentence" })
  reason!: string;
}

export class HireSavedDto {
  @Text({ prompt: "the hire's id" })
  hireId!: string;
}

export class ArchiveQueryDto {
  @Text({ prompt: "the candidate's name" })
  name!: string;
}

export class ArchiveEntryDto {
  @Integer({ prompt: "earlier applications", min: 0 })
  applications!: number;
}
```

```ts file=src/screening/components.ts
// one class per file in a project; together here for brevity
import { Action, DecidedBy, Decision, ExecutionContext, Injectable, Judge, JudgeModel, JudgeVerdict, OutputGuardrail, PiiAction, PiiKind, PiiPolicy, Router, Tool, pii } from "@agboss/core";
import type { ActionHandler, InputOf, JudgeHandler, JudgeInput, OutputOf, Route, RouterHandler, ToolHandler } from "@agboss/core";
import { Rag, type RagConnector, type RagRetrieval } from "@agboss/core/rag";
import { ArchiveEntryDto, ArchiveQueryDto, HireSavedDto, VerdictDto } from "./dtos/screening.dto.js";
import { RejectedWorkflowFinish } from "./finishes.js";

@Injectable()
export class CandidateArchiveService {
  applicationsOf(name: string): Promise<number> {
    return Promise.resolve(name.length % 3);
  }
}

@Injectable()
export class HiringStoreService {
  save(name: string, idempotencyKey: string): Promise<string> {
    return Promise.resolve(`hire-${name}-${idempotencyKey}`);
  }
}

@Tool({
  name: "candidate-archive-tool",
  description: "How often the candidate applied before",
  input: ArchiveQueryDto,
  output: ArchiveEntryDto,
  deps: [CandidateArchiveService],
})
export class CandidateArchiveTool implements ToolHandler<ArchiveQueryDto, ArchiveEntryDto> {
  constructor(private readonly candidateArchiveService: CandidateArchiveService) {}

  async run({ name }: ArchiveQueryDto): Promise<ArchiveEntryDto> {
    return { applications: await this.candidateArchiveService.applicationsOf(name) };
  }
}

@Rag({ name: "hiring-policy-rag", description: "The hiring policy", topK: 2 })
export class HiringPolicyRag implements RagConnector {
  retrieve(query: string, options: { readonly topK: number }): Promise<RagRetrieval> {
    const results = [{ text: `Hire at 7 or more (${query.slice(0, 20)}).`, source: "policy.md#bar" }];
    return Promise.resolve({ results: results.slice(0, options.topK) });
  }
}

@Judge({ name: "reasoned-verdict-judge", model: "typesafe/jev-1.13", reply: VerdictDto, deps: [JudgeModel] })
export class ReasonedVerdictJudge implements JudgeHandler<VerdictDto> {
  constructor(private readonly judgeModel: JudgeModel) {}

  async judge({ reply }: JudgeInput<VerdictDto>): Promise<JudgeVerdict> {
    const answers = await this.judgeModel.decide({
      state: { decision: reply.decision, reason: reply.reason },
      questions: { reasoned: Decision.noul("Does the reason support the decision?") },
    });
    return answers.reasoned.noul >= 0.5
      ? JudgeVerdict.passed()
      : JudgeVerdict.failed({ reason: "give a reason that supports the decision" });
  }
}

// a code judge (#396): no model, no cost — its judge(input) decides; runs before the model judge
@Judge({ name: "short-reason-judge", decidedBy: DecidedBy.Code, reply: VerdictDto })
export class ShortReasonJudge implements JudgeHandler<VerdictDto> {
  judge({ reply }: JudgeInput<VerdictDto>): Promise<JudgeVerdict> {
    const words: number = reply.reason.split(" ").length;
    return Promise.resolve(
      reply.reason.trim() !== "" && words <= 30
        ? JudgeVerdict.passed({ metrics: { words } })
        : JudgeVerdict.failed({ reason: "give the reason in one sentence, at most 30 words" }),
    );
  }
}

// an eval judge judges a finish's output: the saved hire
@Judge({ name: "hire-saved-judge", decidedBy: DecidedBy.Code, reply: HireSavedDto })
export class HireSavedJudge implements JudgeHandler<HireSavedDto> {
  judge({ reply }: JudgeInput<HireSavedDto>): Promise<JudgeVerdict> {
    return Promise.resolve(
      reply.hireId.startsWith("hire-")
        ? JudgeVerdict.passed()
        : JudgeVerdict.failed({ reason: `not a hire id: ${reply.hireId}` }),
    );
  }
}

@OutputGuardrail({
  name: "bias-guardrail",
  description: "Blocks verdicts that rest on protected traits",
  prompt: "Does the verdict rest on age, gender, origin or religion?",
  model: "typesafe/jev-1.13",
  threshold: 0.7,
  refusal: "The verdict was withheld for review.",
})
export class BiasGuardrail {}

@PiiPolicy({
  name: "contact-pii-policy",
  description: "Hides candidates' emails",
  rules: [pii(PiiKind.Email, PiiAction.replaceWithToken())],
})
export class ContactPiiPolicy {}

@Action({
  name: "save-hire-action",
  description: "Saves the hire",
  input: { verdict: VerdictDto },
  output: HireSavedDto,
  deps: [ExecutionContext, HiringStoreService],
})
export class SaveHireAction implements ActionHandler<SaveHireAction> {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly hiringStoreService: HiringStoreService,
  ) {}

  async execute(input: InputOf<SaveHireAction>): Promise<OutputOf<SaveHireAction>> {
    const key: string = this.executionContext.step.idempotencyKey;
    return { hireId: await this.hiringStoreService.save(input.verdict.value.reason, key) };
  }
}

@Router({
  name: "hire-router",
  description: "Saves a hire, ends on a rejection",
  decidedBy: DecidedBy.Code,
  input: { verdict: VerdictDto },
  routes: [{ target: SaveHireAction }, { target: RejectedWorkflowFinish }],
})
export class HireRouter implements RouterHandler<HireRouter> {
  route(input: InputOf<HireRouter>): Route<HireRouter> {
    return input.verdict.value.decision === "hire" ? SaveHireAction : RejectedWorkflowFinish;
  }
}
```

```ts file=src/screening/agents.ts
import { Agent, RagMode } from "@agboss/core";
import { CandidateDto, CultureReportDto, SkillsReportDto, VerdictDto } from "./dtos/screening.dto.js";
import { BiasGuardrail, CandidateArchiveTool, HiringPolicyRag, ReasonedVerdictJudge, ShortReasonJudge } from "./components.js";

@Agent({
  name: "skills-agent",
  description: "Scores technical skills",
  prompt: "Score the candidate's technical skills.",
  model: "moonshotai/kimi-k2.6",
  input: { candidate: CandidateDto },
  output: SkillsReportDto,
  tools: [CandidateArchiveTool],
})
export class SkillsAgent {}

@Agent({
  name: "culture-agent",
  description: "Scores team fit",
  prompt: "Score the candidate's team fit.",
  model: "moonshotai/kimi-k2.6",
  input: { candidate: CandidateDto },
  output: CultureReportDto,
})
export class CultureAgent {}

@Agent({
  name: "verdict-agent",
  description: "Decides from both reports and the policy",
  prompt: "Decide hire or reject from the reports, following the policy.",
  model: "moonshotai/kimi-k2.6",
  input: { skills: SkillsReportDto, culture: CultureReportDto },
  output: VerdictDto,
  rag: [{ use: HiringPolicyRag, mode: RagMode.Context }],
  judges: [ShortReasonJudge, ReasonedVerdictJudge], // every judge runs; the code one costs nothing
  maxRetries: 1,
  guardrails: [BiasGuardrail],
})
export class VerdictAgent {}
```

```ts file=src/screening/arbiters.ts
// a code arbiter: one @OnAnswer method per agent of the launch, typed by that agent's output
import { Arbiter, DecidedBy, OnAnswer } from "@agboss/core";
import { CultureAgent, SkillsAgent } from "./agents.js";
import { CultureReportDto, SkillsReportDto } from "./dtos/screening.dto.js";

@Arbiter({ name: "has-notes-arbiter", decidedBy: DecidedBy.Code })
export class HasNotesArbiter {
  @OnAnswer(SkillsAgent)
  fromSkills(answer: SkillsReportDto): boolean {
    return answer.notes.trim() !== "";
  }

  @OnAnswer(CultureAgent)
  fromCulture(answer: CultureReportDto): boolean {
    return answer.notes.trim() !== "";
  }
}
```

```ts file=src/screening/finishes.ts
import { WorkflowFinish, WorkflowStart } from "@agboss/core";
import { CandidateDto, HireSavedDto, VerdictDto } from "./dtos/screening.dto.js";

@WorkflowStart({ name: "screening-workflow-start", description: "A candidate", input: CandidateDto })
export class ScreeningWorkflowStart {}

@WorkflowFinish({ name: "hired-workflow-finish", description: "The saved hire", output: HireSavedDto })
export class HiredWorkflowFinish {}

@WorkflowFinish({ name: "rejected-workflow-finish", description: "The rejection", output: VerdictDto })
export class RejectedWorkflowFinish {}
```

```ts file=src/screening/screening.application.ts
import { Application, Budget, BudgetPeriod, BudgetScope, EmptyEnvironment, Workflow, route, start, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";
import { CultureAgent, SkillsAgent, VerdictAgent } from "./agents.js";
import { HasNotesArbiter } from "./arbiters.js";
import { CandidateArchiveService, ContactPiiPolicy, HireRouter, HiringStoreService, SaveHireAction } from "./components.js";
import { CandidateDto, CultureReportDto, HireSavedDto, SkillsReportDto, VerdictDto } from "./dtos/screening.dto.js";
import { HiredWorkflowFinish, RejectedWorkflowFinish, ScreeningWorkflowStart } from "./finishes.js";

@Workflow({
  name: "screening-workflow",
  version: "1.0.0",
  flow: [
    start(ScreeningWorkflowStart)
      .returns(CandidateDto)
      .toParallelAgents(SkillsAgent, CultureAgent)
      .acceptedBy(HasNotesArbiter)
      .joinQuorum({ min: 2 })
      .returns(SkillsReportDto)
      .returns(CultureReportDto)
      .toAgent(VerdictAgent)
      .returns(VerdictDto)
      .toRouter(HireRouter)
      .chooseOne(
        route(SaveHireAction)
          .returns(HireSavedDto)
          .toFinish(HiredWorkflowFinish),
        route(RejectedWorkflowFinish),
      ),
  ],
  maxSteps: 4,
  providers: [CandidateArchiveService, HiringStoreService],
})
export class ScreeningWorkflow {}

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
  name: "screening-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ScreeningWorkflow],
  budgets: [ApplicationDailyBudget, TenantDailyBudget, ExecutionBudget],
  piiPolicies: [ContactPiiPolicy],
})
export class ScreeningApplication {}
```

## The whole application: `testWith(App)`

<!-- snippet-context
import { QuorumNotReachedError } from "@agboss/core";
import { callTool, decideWith, replyWith, step, TestConcurrency, testWith } from "@agboss/core/testing";
import { expect } from "vitest";
import { CultureAgent, SkillsAgent, VerdictAgent } from "./src/screening/agents.js";
import { CandidateArchiveTool, ReasonedVerdictJudge } from "./src/screening/components.js";
import { SkillsReportDto, CultureReportDto, VerdictDto } from "./src/screening/dtos/screening.dto.js";
import { HiredWorkflowFinish, RejectedWorkflowFinish, ScreeningWorkflowStart } from "./src/screening/finishes.js";
import { ScreeningApplication } from "./src/screening/screening.application.js";
-->

```ts
const test = testWith(ScreeningApplication); // the only form: testWith(Workflow) does not compile
const candidate = { name: "Dana", cv: "TypeScript, 6 years; dana@example.com" };

test("two reports, a hire verdict, the hire saved", async ({ app, mockLlm }) => {
  mockLlm(SkillsAgent).thenReturn(
    callTool(CandidateArchiveTool, { name: "Dana" }), // a turn that calls a tool, typed by its input
    replyWith(SkillsReportDto, { score: 8, notes: "strong TypeScript" }), // then the answer
  );
  mockLlm(CultureAgent).thenReturn(replyWith(CultureReportDto, { score: 7, notes: "clear writer" }));
  mockLlm(VerdictAgent).thenReturn(replyWith(VerdictDto, { decision: "hire", reason: "both reports at 7+" }));
  mockLlm(ReasonedVerdictJudge).thenReturn(decideWith({ reasoned: 0.9 }));

  const result = await app.execute(ScreeningWorkflowStart, candidate);

  expect(result).toFinishWith(HiredWorkflowFinish);
  expect(result.threadId).toBe("thread-1"); // ids are sequential in tests (SequentialIdGenerator)
  expect(result.executionId).toBe("execution-1");
  expect(mockLlm(VerdictAgent)).toHaveBeenCalledWith({ skills: { score: 8 } }); // its input, partly
  expect(mockLlm(SkillsAgent).lastRequest.input).toContain("<email:"); // the model read a token
});

test("a verdict that does not reason is retried once", async ({ app, mockLlm }) => {
  mockLlm(SkillsAgent).thenReturn(replyWith(SkillsReportDto, { score: 3, notes: "junior" }));
  mockLlm(CultureAgent).thenReturn(replyWith(CultureReportDto, { score: 4, notes: "quiet" }));
  mockLlm(VerdictAgent).thenReturn(
    replyWith(VerdictDto, { decision: "reject", reason: "n/a" }),
    replyWith(VerdictDto, { decision: "reject", reason: "both reports below the bar of 7" }),
  );
  mockLlm(ReasonedVerdictJudge).thenReturn(decideWith({ reasoned: 0.1 }), decideWith({ reasoned: 0.9 }));

  const result = await app.execute(ScreeningWorkflowStart, candidate);

  expect(result).toFinishWith(RejectedWorkflowFinish, {
    decision: "reject",
    reason: "both reports below the bar of 7", // the whole output: the second, judged answer
  });
  expect(mockLlm(VerdictAgent)).toHaveBeenCalledTimes(2);
});

// a race, the same on every run: the culture answer completes first and is rejected by the
// arbiter; with min 2 of 2 the quorum can no longer be reached, so the skills branch waiting at its
// gate is cancelled
const raceTest = testWith(ScreeningApplication, {
  concurrency: TestConcurrency.inOrder([step(CultureAgent), step(SkillsAgent)]),
});

raceTest("an answer without notes leaves the quorum short", async ({ app, mockLlm }) => {
  mockLlm(CultureAgent).thenReturn(replyWith(CultureReportDto, { score: 6, notes: " " }));
  mockLlm(SkillsAgent).thenReturn(replyWith(SkillsReportDto, { score: 9, notes: "senior" }));

  await expect(app.execute(ScreeningWorkflowStart, candidate)).rejects.toFailWith(QuorumNotReachedError, {
    counted: 0,
  });
});
```

- **Scripts are expectations**: every `thenReturn` turn and `when(…)` must be used, else the test
  fails at its end (`test.unused-script`); a call no script matches fails naming its input
  (`test.no-matching-script`). Turns: `replyWith(text)`, `replyWith(Dto, value, { cost: usd(…) })`,
  `callTool(Tool, args)`, `routeTo(Target)` (a model router), `decideWith({ question: p })` (decision
  models: judges, guardrails `{ blocks }`, model arbiters `{ counts }`), `failWith(ModelFailure.Timeout)`,
  `waitFor(seconds(31))` (the next turn after that long on the clock), and the model's invalid turns
  for a validation retry, no cast needed: `callToolWithInvalidArguments(Tool, { orderId: 7 })` (its
  input check refuses them) and `callToolWithTruncatedArguments(Tool, { orderId: "7" })` (cut JSON,
  `finish_reason: "length"`) — the tool never runs, the call is `ToolCallStatus.InvalidArguments`,
  counted in `step.validationAttempts` — and `replyWithInvalidAnswer(Dto, { body: "…" })` (a class
  of the agent's output, fields that do not fit it: the third fails the step with
  `AgentAnswerInvalidError`).
- **`when(partial)`** binds turns to the input: `mockLlm(SkillsAgent).when({ candidate: { name: "Dana" } }).thenReturn(…)`.
- **Unscripted**: a guardrail passes, a compaction writes a fixed summary; an agent, a router or a
  judge without a script is a blocked live call (`test.live-call-blocked`). A custom compaction
  (`CompactionStrategy.Custom`) calls no model: `mockLlm(GraphMemoryCompaction)` is a setup error —
  `mockOf(KnowledgeGraphService).saveFactsAndSummarize.mockResolvedValue([…])` the services its
  `compact()` uses.
- **Replacing a class**: `mockOf(Service).method.mockResolvedValue(…)` (any component or service, a
  budget's `maxSpend` too); `testWith(App, { overrides: [override(Base, Replacement)] })` creates a
  class instead of another — no instances, no `new`.
- **MCP**: `mcpOf(Server).thenReturn({ server_tool: (args) => result })`, `.calls`; **network** is
  blocked except `allowNetwork: ["localhost"]`.
- **A2A**: `const { url } = await a2aServer({ expose, callerResolver })` serves the test's `app` through
  `a2aHttpListener` on `127.0.0.1:0` (the resolver from its container, the loopback open, closed at
  the test's end); call it with `new A2AClient({ url, headers })` (#387, reference 04).
- **Matchers**: `toFollowPath([Start, …, Finish])`, `toFinishWith(Finish, output?)` (the whole output),
  `rejects.toFailWith(ErrorClass, { …fields, cause })` (through the cause chain),
  `toHaveChildExecutions(W, [{ item, finish | failedWith | cancelled }])`,
  `toHaveHandledError(E, { at, by })`, `toHaveCalledTools([A, B])` and `toHaveToolCallMatching(Tool,
partialOrCheck)` (the trajectory, below), `toHavePausedAt(Agent)`; on
  `mockLlm(X)` / `mockAction(A)`: `toHaveBeenCalledWith(partial)`, `toHaveBeenCalledTimes(n)`,
  `toHaveReturned(Dto, fields?)`, `toHaveScriptedToolCalls([Tool])` (its model's calls, exactly, in
  order), `.inputs`, `.lastRequest`.
- **Errors only the real way**: `failWith(…)`, a rejecting `mockOf`, `mockTool(Tool).thenFail(ToolFailure.Timeout)`,
  scripts that reach a limit (`mockOf(ExecutionBudget).maxSpend.mockReturnValue(usd(0.001))` + a
  scripted `cost`), `app.cancel` / an aborted `signal`. Never throw a framework error by hand.
- **Time**: the `clock` fixture is the application's `Clock` in every test, fixed at
  `2026-01-05T09:00:00Z`; `await clock.advance(seconds(31))` wakes every due wait (a tool's timeout,
  retries, `Retry-After`, the recovery sweep, pause retention) without real waiting.
- **Restarts and instances**: `await recoverApp()` closes the app and returns a new one over the same
  stores, clock and ids — a paused execution survives it; `testWith(App, { instances: 2 })` gives
  `apps` (each its own container, one set of stores) for leases and cross-instance resumes.
- **Health**: `await app.checkReadiness()` / `app.checkLiveness()` → `HealthReport` (a
  `@HealthCheck`'s service mocked with `mockOf`). `testWith` never traps SIGTERM / SIGINT.

### Serving the application over A2A: `a2aServer`

The `a2aServer` fixture (#387, an `A2AServerFixture`) serves the test's `app` through
`a2aHttpListener` (its `@A2AExpose`, listed in `@Application({ exposes })`, #398 PR 3) on `127.0.0.1:0` and returns an `A2ATestServer` — `{ url }` for `new A2AClient({
url, headers })`. The app is built first and the caller resolver taken from its container (so
`override(…)` and `mockOf` reach its services); the loopback is open for the test without
`allowNetwork`, and the server closes when the test ends. A refused caller is
`A2ACallerRejectedError` on the client (reference 04):

<!-- snippet-context
import { A2ACallerRejectedError, A2AClient, A2AStatus, type A2ACallerResolver } from "@agboss/core/a2a";
import { replyWith, testWith } from "@agboss/core/testing";
import { expect } from "vitest";
import { SkillsAgent } from "./src/screening/agents.js";
import { ScreeningWorkflowStart } from "./src/screening/finishes.js";
import { ScreeningApplication } from "./src/screening/screening.application.js";
declare const ScreeningA2aCallerResolver: new () => A2ACallerResolver<typeof ScreeningWorkflowStart>;
declare const ScreeningA2AExpose: new () => object;
const test = testWith(ScreeningApplication);
const candidate = { name: "Dana", cv: "TypeScript, 6 years" };
-->

```ts
const screening = { expose: ScreeningA2AExpose, callerResolver: ScreeningA2aCallerResolver };

test("a caller without a key is refused with 401, and nothing runs", async ({ a2aServer, mockLlm }) => {
  const { url } = await a2aServer(screening); // listed in the application's providers

  const sent = new A2AClient({ url }).send(candidate);

  await expect(sent).rejects.toFailWith(A2ACallerRejectedError, {
    httpStatus: 401,
    wireCode: "a2a.caller-unauthenticated",
  });
  expect(mockLlm(SkillsAgent)).toHaveBeenCalledTimes(0);
});

test("a known key runs for its tenant", async ({ a2aServer, mockLlm }) => {
  mockLlm(SkillsAgent).thenReturn(replyWith("…")); // and the rest of the path's scripts
  const { url } = await a2aServer(screening);

  const response = await new A2AClient({ url, headers: { authorization: "Bearer key-acme" } }).send(candidate, {
    threadId: "dana-1", // the caller's tenant's thread
  });

  expect(response.status).toBe(A2AStatus.Finished);
});
```

`app.resolve(Class)` of the test's `app` works once it is built (`await app.ready()`, or after an
`execute`); before that it fails with `test.app-not-ready`.

## The tool-call trajectory: `result.toolCalls`, `record.steps`, `JudgeInput.toolCalls`

Every tool call an agent's model asks for is a `ToolCallRecord` — `step` (its `component` is the
tool, with its `promptHash` / `schemaHash`; `nodeId` / `visitNumber` the agent's visit; `callId`,
`toolLoopIteration`, `validationAttempts`), `input`, `output`, `status: ToolCallStatus`, `error?`,
`isResultTruncated`, `startedAt` / `endedAt`. `ToolCallStatus`: `Succeeded`, `Failed` (the tool threw,
its output failed its check, or a PII rule refused it — `error.code` `pii.refused`),
`InvalidArguments` (the input check failed, or the arguments were no JSON at all — a truncated
call; the tool never ran), `Declined` (its approval said no), `TimedOut` (past the tool's
`timeout`), `Replied` (a tool interceptor's `replyToModel` answered instead — `output` is its
message), `Blocked` (a tool interceptor's `block`: the step fails with `ToolBlockedError`) and
`UnknownTool` (the model called a tool its agent does not have).

- `result.toolCalls` — the root execution's own calls, in call order, **real values**;
  `result.children[i].toolCalls` and `.steps` — each child's own. `result.record.toolCalls` (`{ record: true }`)
  holds the same **masked** by the application's and the workflow's PII policies.
- `result.record.steps` — one `ExecutionStepRecord` per visit of a node, in the order the visits
  ended: its `step`, `inputHash` (a stable hash of what it read — the same input, the same hash on
  every machine), `decision?` (#401: what it decided — `route:<node>` for a router, `launch:<node>,…`
  for the routes it launched, `variant:<class>` for a `oneOf` answer, else `answer:<hash>` of its
  value; none when it gave nothing), `judgeVerdicts` (`JudgeVerdictRecord`: `judge`, `attempt`, `passed`, `reason?`,
  `metrics?`), `guardrailDecisions` (`GuardrailDecisionRecord`: `guardrail`, `side`, `isBlocked`,
  `probability`), `spend`, `startedAt` / `endedAt`, `error?` (a failure a side path took).
- A failed visit keeps its records: the calls, judge verdicts and guardrail decisions of an agent
  whose step fails (`QualityGateError`, a blocked call, a guardrail, a limit) are in
  `result.toolCalls` and its `steps` entry (with `error`) when a side path takes the failure, and in
  the `ChildExecutionRecord` (`toolCalls`, `steps`) of a child it ends.
- The trajectory matchers (`ToolCallMatchers`, registered by `@agboss/core/testing/setup` as
  `toolCallMatchers`) read the root's `result.toolCalls`: `toHaveCalledTools([A, B])` passes when
  each was called at least once, in any order and whatever its status (`.not`: none of them was);
  `toHaveToolCallMatching(Tool, expected)` when some call matches — `expected` a
  `ToolCallExpectation<TInput>`: a deep partial of the input, or a check `(input) => boolean` run on
  the calls whose input passed the tool's input check (`.not`: none matches). A child's calls are
  asserted through `result.children`. The script matcher of `mockLlm(X)` is
  `toHaveScriptedToolCalls([…])`: the model's calls exactly, in order.
- A judge reads the visit's calls — every attempt's, real values — as `input.toolCalls`;
  `toolCallsOf(Tool, toolCalls)` gives one tool's calls typed by its input and output
  (`TypedToolCall`: narrowed by `status`). `testJudge` takes `toolCalls` optionally — `[]` when not
  given.
- A model call whose arguments are no JSON (truncated — the provider's `invalid_tool_calls`) is an
  `InvalidArguments` call: the model reads why and tries again, the step's `validationAttempts`
  counts it; it is never an empty reply. A truncated **answer** is an invalid answer
  (`AgentAnswerInvalidError` after the third).

<!-- snippet-context
import { ToolCallStatus, toolCallsOf } from "@agboss/core";
import { callTool, decideWith, replyWith, testWith } from "@agboss/core/testing";
import { expect } from "vitest";
import { CultureAgent, SkillsAgent, VerdictAgent } from "./src/screening/agents.js";
import { CandidateArchiveTool, ReasonedVerdictJudge } from "./src/screening/components.js";
import { SkillsReportDto, CultureReportDto, VerdictDto } from "./src/screening/dtos/screening.dto.js";
import { ScreeningWorkflowStart } from "./src/screening/finishes.js";
import { ScreeningApplication } from "./src/screening/screening.application.js";
-->

```ts
const test = testWith(ScreeningApplication);

test("the skills agent looks the candidate up, whatever else runs", async ({ app, mockLlm }) => {
  mockLlm(SkillsAgent).thenReturn(
    callTool(CandidateArchiveTool, { name: "Dana" }),
    replyWith(SkillsReportDto, { score: 8, notes: "strong TypeScript" }),
  );
  mockLlm(CultureAgent).thenReturn(replyWith(CultureReportDto, { score: 7, notes: "clear writer" }));
  mockLlm(VerdictAgent).thenReturn(replyWith(VerdictDto, { decision: "hire", reason: "both reports at 7+" }));
  mockLlm(ReasonedVerdictJudge).thenReturn(decideWith({ reasoned: 0.9 }));

  const result = await app.execute(ScreeningWorkflowStart, { name: "Dana", cv: "TypeScript" }, { record: true });

  // invariants, not positions: the archive was asked, once at least for Dana, and every lookup succeeded
  expect(result).toHaveCalledTools([CandidateArchiveTool]);
  expect(result).toHaveToolCallMatching(CandidateArchiveTool, { name: "Dana" });
  const lookups = toolCallsOf(CandidateArchiveTool, result.toolCalls);
  const succeeded = lookups.filter((call) => call.status === ToolCallStatus.Succeeded);
  expect(succeeded).toHaveLength(lookups.length);
  const verdict = result.record?.steps.find((entry) => entry.step.nodeId === "verdict-agent");
  expect(verdict?.judgeVerdicts.map((judged) => judged.passed)).toEqual([true]);
});
```

## Undo: `toHaveCompensated` and `result.compensations`

An action that declares `compensateWith` (reference 02, section 8) is tested by what its undo did:
`result.compensations` lists every undo that ran — `CompensationRecord { compensated, compensator,
reason, status, error?, startedAt, endedAt }` — and `expect(result).toHaveCompensated(Action, { by,
reason?, status? })` asserts one, with `CompensationReason` (`SidePath`, `JoinFailed`,
`ExecutionFailed`, `ExecutionCancelled`) and `CompensationStatus` (`Compensated`, `Failed`). An
execution that fails has no result: assert the undo through the mocked service, and a failed
automatic undo through `rejects.toFailWith(CompensationFailedError, { cause })`.

```ts file=src/rental/rental.ts
import { Action, ExecutionContext, Injectable, Workflow, WorkflowFinish, WorkflowStart, start, toAction } from "@agboss/core";
import type { ActionHandler, InputOf, OutputOf } from "@agboss/core";
import { Text } from "@agboss/core/dto";

export class RentalRequestDto {
  @Text({ prompt: "the customer" })
  customer!: string;
}

export class CarReservationDto {
  @Text({ prompt: "the reservation's id" })
  reservationId!: string;
}

export class DepositDto {
  @Text({ prompt: "the deposit's id" })
  depositId!: string;
}

export class DepositDeclinedError extends Error {}

@Injectable()
export class FleetService {
  reserve(customer: string, idempotencyKey: string): Promise<string> {
    return Promise.resolve(`${customer}:${idempotencyKey}`);
  }

  cancel(reservationId: string, idempotencyKey: string): Promise<void> {
    void reservationId;
    void idempotencyKey;
    return Promise.resolve();
  }

  chargeDeposit(customer: string): Promise<string> {
    return Promise.resolve(`deposit:${customer}`);
  }
}

@WorkflowStart({ name: "rental-workflow-start", description: "A car to rent", input: RentalRequestDto })
export class RentalWorkflowStart {}

@Action({ name: "cancel-car-action", description: "Cancels the reservation", input: { reservation: CarReservationDto }, deps: [FleetService, ExecutionContext] })
export class CancelCarAction implements ActionHandler<CancelCarAction> {
  constructor(
    private readonly fleetService: FleetService,
    private readonly executionContext: ExecutionContext,
  ) {}

  async execute(input: InputOf<CancelCarAction>): Promise<void> {
    await this.fleetService.cancel(input.reservation.value.reservationId, this.executionContext.step.idempotencyKey);
  }
}

@Action({
  name: "reserve-car-action",
  description: "Reserves the car",
  input: { request: RentalRequestDto },
  output: CarReservationDto,
  compensateWith: CancelCarAction,
  deps: [FleetService, ExecutionContext],
})
export class ReserveCarAction implements ActionHandler<ReserveCarAction> {
  constructor(
    private readonly fleetService: FleetService,
    private readonly executionContext: ExecutionContext,
  ) {}

  async execute(input: InputOf<ReserveCarAction>): Promise<OutputOf<ReserveCarAction>> {
    const key: string = this.executionContext.step.idempotencyKey;
    return { reservationId: await this.fleetService.reserve(input.request.value.customer, key) };
  }
}

@Action({ name: "charge-deposit-action", description: "Charges the deposit", input: { request: RentalRequestDto }, output: DepositDto, deps: [FleetService] })
export class ChargeDepositAction implements ActionHandler<ChargeDepositAction> {
  constructor(private readonly fleetService: FleetService) {}

  async execute(input: InputOf<ChargeDepositAction>): Promise<OutputOf<ChargeDepositAction>> {
    return { depositId: await this.fleetService.chargeDeposit(input.request.value.customer) };
  }
}

@WorkflowFinish({ name: "rental-booked-workflow-finish", description: "The deposit", output: DepositDto })
export class RentalBookedWorkflowFinish {}

@WorkflowFinish({ name: "rental-declined-workflow-finish", description: "Declined", output: RentalRequestDto })
export class RentalDeclinedWorkflowFinish {}

@Workflow({
  name: "rental-workflow",
  version: "1.0.0",
  flow: [
    start(RentalWorkflowStart)
      .returns(RentalRequestDto)
      .toAction(ReserveCarAction)
      .returns(CarReservationDto)
      .toAction(ChargeDepositAction)
      .onError(
        DepositDeclinedError, // a declined deposit: cancel the car on the side path (SidePath)
        toAction(CancelCarAction)
          .toFinish(RentalDeclinedWorkflowFinish),
      )
      .returns(DepositDto)
      .toFinish(RentalBookedWorkflowFinish),
  ],
  providers: [FleetService],
})
export class RentalWorkflow {}

```

```ts file=src/rental/rental.application.ts
import { Application, Budget, BudgetPeriod, BudgetScope, EmptyEnvironment, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";
import { RentalWorkflow } from "./rental.js";

@Budget({ name: "rental-application-budget", scope: BudgetScope.Application, period: BudgetPeriod.Day })
export class RentalApplicationBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

@Budget({ name: "rental-tenant-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
export class RentalTenantBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

@Budget({ name: "rental-execution-budget", scope: BudgetScope.Execution })
export class RentalExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.1);
  }
}

@Application({
  name: "rental-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [RentalWorkflow],
  budgets: [RentalApplicationBudget, RentalTenantBudget, RentalExecutionBudget],
})
export class RentalApplication {}
```

```ts file=tests/rental.test.ts
import { expect } from "vitest";
import { CompensationFailedError, CompensationReason, CompensationStatus, StepFailedError } from "@agboss/core";
import { testWith } from "@agboss/core/testing";
import { RentalApplication } from "../src/rental/rental.application.js";
import {
  CancelCarAction,
  DepositDeclinedError,
  FleetService,
  RentalDeclinedWorkflowFinish,
  RentalWorkflowStart,
  ReserveCarAction,
} from "../src/rental/rental.js";

const test = testWith(RentalApplication);

const REQUEST = { customer: "dana" };

test("a declined deposit: the side path cancels the car", async ({ app, mockOf }) => {
  const fleet = mockOf(FleetService); // every method of a mocked class is a mock
  fleet.reserve.mockResolvedValue("car-1");
  fleet.chargeDeposit.mockRejectedValue(new DepositDeclinedError("declined"));

  const result = await app.execute(RentalWorkflowStart, REQUEST);

  expect(result).toFinishWith(RentalDeclinedWorkflowFinish, REQUEST);
  expect(result).toHaveCompensated(ReserveCarAction, {
    by: CancelCarAction,
    reason: CompensationReason.SidePath,
    status: CompensationStatus.Compensated,
  });
  expect(result.compensations).toHaveLength(1);
});

test("an uncaught failure: the car is cancelled automatically, then the run fails", async ({ app, mockOf }) => {
  const fleet = mockOf(FleetService);
  fleet.reserve.mockResolvedValue("car-1");
  fleet.chargeDeposit.mockRejectedValue(new Error("payment gateway down")); // no side path takes it

  await expect(app.execute(RentalWorkflowStart, REQUEST)).rejects.toFailWith(StepFailedError);

  // the automatic undo's key is the undone step's key + ":compensation"
  expect(fleet.cancel.mock.calls[0]?.[1]).toMatch(/:reserve-car-action:1:compensation$/u);
});

test("an undo that fails: CompensationFailedError, the original error as its cause", async ({ app, mockOf }) => {
  const fleet = mockOf(FleetService);
  fleet.reserve.mockResolvedValue("car-1");
  fleet.chargeDeposit.mockRejectedValue(new Error("payment gateway down"));
  fleet.cancel.mockRejectedValue(new Error("fleet API down"));

  await expect(app.execute(RentalWorkflowStart, REQUEST)).rejects.toFailWith(CompensationFailedError, {
    cause: StepFailedError,
  });
});
```

- A failed join's undo is `CompensationReason.JoinFailed`; a cancel's (`app.cancel`, a `FailFast`
  abort) `ExecutionCancelled`.
- The automatic undo runs on the test's `clock` like everything else: a slow undo is cut at
  `compensationTimeout` only when the clock is advanced past it.

## A transport provider (`complete`) in tests

`mockLlm` answers **above** every model provider: in `testWith(App)` a transport provider's
`complete(request)` (#385, reference 06) is never called — script its agents like any other
(`mockLlm(BillingAgent).thenReturn(replyWith("…"))`), and no SDK, key or network is needed. What
is left to test is the class's own mapping: call `complete()` on an instance built with a fake SDK
client and a `testExecutionContext()` for its `TenantContext` (a class created by hand) — the
retries, the rate limit, the breaker and the accounting around it are the framework's.

```ts file=tests/bedrock.model-provider.test.ts
import { expect, it } from "vitest";
import { TenantContext } from "@agboss/core";
import {
  ModelCost,
  ModelProvider,
  ModelProviderMessageRole,
  RetryPolicy,
  type ModelProviderHandler,
  type ModelProviderRequest,
  type ModelProviderResponse,
} from "@agboss/core/models";
import { testExecutionContext } from "@agboss/core/testing";
import { minutes, seconds } from "@agboss/core/units";

class FakeSdk {
  invoke(model: string, tenantId: string): Promise<ModelProviderResponse> {
    return Promise.resolve({ text: `${model} for ${tenantId}`, usage: { inputTokens: 1, outputTokens: 1 } });
  }
}

@ModelProvider({
  name: "sdk-model-provider",
  description: "A model behind an SDK",
  serves: [/^sdk\//],
  timeout: seconds(30),
  cost: ModelCost.fromResponse(),
  retryPolicy: RetryPolicy.none(),
  circuitBreakerPolicy: { failureThreshold: 5, window: minutes(1), openFor: seconds(30) },
  deps: [FakeSdk, TenantContext],
})
class SdkModelProvider implements ModelProviderHandler {
  constructor(
    private readonly sdk: FakeSdk,
    private readonly tenantContext: TenantContext,
  ) {}

  complete(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    return this.sdk.invoke(request.model, this.tenantContext.tenantId);
  }
}

it("complete() maps the request to the SDK, with the execution's tenant", async () => {
  const provider = new SdkModelProvider(new FakeSdk(), testExecutionContext().tenant);
  const request: ModelProviderRequest = {
    model: "sdk/small",
    messages: [{ role: ModelProviderMessageRole.User, text: "hi" }],
    tools: [],
    temperature: 0,
    maxTokens: undefined,
    reasoning: { kind: "off" },
    promptCaching: { kind: "off" },
    signal: new AbortController().signal,
  };

  expect((await provider.complete(request)).text).toBe("sdk/small for default");
});
```

## One component: the unit runners

Each runner builds the component's own container (its `deps`, `overrides`, an `environment`) and
runs every call in the frame of its step, so `ExecutionContext`, `SpendRecorder` and `JudgeModel`
work as in a run. Every call returns `{ output, spend }`; `run.clock` is its `VirtualClock`.

<!-- snippet-context
import { Injectable } from "@agboss/core";
import { decideWith, override, testAction, testArbiter, testGuardrail, testJudge, testPii, testRag, testRouter, testTool } from "@agboss/core/testing";
import { seconds } from "@agboss/core/units";
import { expect, it } from "vitest";
import { CultureAgent, SkillsAgent, VerdictAgent } from "./src/screening/agents.js";
import { HasNotesArbiter } from "./src/screening/arbiters.js";
import { BiasGuardrail, CandidateArchiveService, CandidateArchiveTool, ContactPiiPolicy, HireRouter, HiringPolicyRag, ReasonedVerdictJudge, SaveHireAction, ShortReasonJudge } from "./src/screening/components.js";
import { VerdictDto } from "./src/screening/dtos/screening.dto.js";
import { RejectedWorkflowFinish } from "./src/screening/finishes.js";
-->

```ts
@Injectable()
export class FirstTimeArchiveService extends CandidateArchiveService {
  override applicationsOf(): Promise<number> {
    return Promise.resolve(0);
  }
}

it("testTool: input and output validated, a service replaced by a class", async () => {
  const runTool = testTool(CandidateArchiveTool, {
    overrides: [override(CandidateArchiveService, FirstTimeArchiveService)],
  });

  const { output, spend } = await runTool({ name: "Dana" }, { timeout: seconds(1) });

  expect(output).toEqual({ applications: 0 });
  expect(spend.totalUsd).toBe(0);
});

it("testAction: input fields are { producer, value } records", async () => {
  const runAction = testAction(SaveHireAction);

  const { output } = await runAction({
    verdict: { producer: VerdictAgent, value: { decision: "hire", reason: "strong" } },
  });

  expect(output.hireId).toMatch(/^hire-strong-/u);
});

it("testRouter: a code router at no cost", async () => {
  const runRouter = testRouter(HireRouter);

  const { output } = await runRouter({
    verdict: { producer: VerdictAgent, value: { decision: "reject", reason: "junior" } },
  });

  expect(output).toBe(RejectedWorkflowFinish);
});

it("testArbiter: the agent and its answer", async () => {
  const runArbiter = testArbiter(HasNotesArbiter);

  expect((await runArbiter(SkillsAgent, { score: 8, notes: "senior" })).output).toBe(true);
  expect((await runArbiter(CultureAgent, { score: 6, notes: "" })).output).toBe(false);
});

it("testRag: retrieve with topK", async () => {
  const runRag = testRag(HiringPolicyRag);

  const { output } = await runRag("the bar", { topK: 1 });

  expect(output[0]?.source).toBe("policy.md#bar");
});

it("testJudge: the reply as a plain object of its DTO", async () => {
  const runJudge = testJudge(ReasonedVerdictJudge, { model: decideWith({ reasoned: 0.2 }) });

  const { output } = await runJudge({
    variant: VerdictDto,
    reply: { decision: "hire", reason: "n/a" },
    task: "Decide",
    attempt: 0,
  });

  expect(output).toMatchObject({ passed: false, reason: "give a reason that supports the decision" });
  // `toolCalls` — the visit's tool calls the judge reads — is optional here: `[]` when not given
});

it("testJudge of a code judge: no model script, no spend", async () => {
  const runJudge = testJudge(ShortReasonJudge); // a `model` here is a TestSetupError

  const { output, spend } = await runJudge({
    variant: VerdictDto,
    reply: { decision: "reject", reason: "" },
    task: "Decide",
    attempt: 0,
  });

  expect(output).toMatchObject({ passed: false });
  expect(spend.totalUsd).toBe(0);
});

it("testGuardrail: a block is an output, not a throw", async () => {
  const check = testGuardrail(BiasGuardrail, { model: decideWith({ blocks: 0.9 }) });

  const { output } = await check("Reject: too old for the team", { element: "verdict-agent" });

  expect(output).toEqual({ isBlocked: true, probability: 0.9, refusal: "The verdict was withheld for review." });
});

it("testPii: what a model reads, and what its answer becomes", async () => {
  const contacts = testPii([ContactPiiPolicy]);

  const { output: masked } = await contacts.mask("Mail dana@example.com");

  expect(contacts.reveal(masked)).toBe("Mail dana@example.com");
});
```

`testToolInterceptor(Interceptor, options)` (#384) — a `ToolInterceptorRunner` — runs a `@ToolInterceptor` in the frame of a call
to a tool: `beforeToolCall(Tool, input)` gives the decision (compare it with `toEqual`),
`afterToolCall(Tool, input, output)` the output the model would read, validated against the tool's
output DTO. A method the class does not have is a `TestSetupError`.

<!-- snippet-context
import { TenantContext, Tool, ToolCallDecision, ToolInterceptor, type BeforeToolCall, type ToolCallContext, type ToolHandler } from "@agboss/core";
import { ListOf, Text } from "@agboss/core/dto";
import { testToolInterceptor } from "@agboss/core/testing";
import { expect, it } from "vitest";
export class CityTenantContext extends TenantContext {
  @ListOf(Text)
  allowedCities!: string[];
}
export class CityQuery {
  @Text({ prompt: "the city" })
  city!: string;
}
export class CityJobs {
  @Text({ prompt: "the jobs" })
  listing!: string;
}
@Tool({ name: "city-jobs-tool", description: "Jobs in a city", input: CityQuery, output: CityJobs })
export class CityJobsTool implements ToolHandler<CityQuery, CityJobs> {
  run({ city }: CityQuery): Promise<CityJobs> {
    return Promise.resolve({ listing: `Engineer in ${city}` });
  }
}
@ToolInterceptor({ name: "city-scope-tool-interceptor", description: "Allowed cities only", deps: [CityTenantContext] })
export class CityScopeToolInterceptor implements BeforeToolCall {
  constructor(private readonly cityTenantContext: CityTenantContext) {}
  beforeToolCall(call: ToolCallContext): ToolCallDecision {
    const city = typeof call.input === "object" && call.input !== null && "city" in call.input ? call.input.city : undefined;
    return typeof city === "string" && !this.cityTenantContext.allowedCities.includes(city)
      ? ToolCallDecision.replyToModel({ message: `City "${city}" is not allowed.` })
      : ToolCallDecision.allow();
  }
}
-->

```ts
it("testToolInterceptor: the decision for the tenant given", async () => {
  const scope = testToolInterceptor(CityScopeToolInterceptor, {
    tenantContext: CityTenantContext,
    tenant: { tenantId: "acme", allowedCities: ["Haifa"] },
  });

  const { output } = await scope.beforeToolCall(CityJobsTool, { city: "Eilat" });

  expect(output).toEqual(ToolCallDecision.replyToModel({ message: 'City "Eilat" is not allowed.' }));
});
```

`testCompaction(Compaction, options)` (#395) — a `CompactionRunner` — runs one `@Compaction` on a
`CompactionInput` (`previousSummaries`, `turnsToCompact`) and gives a `CompactionResult`:
`summaries` (what readers see next — a `SummaryQueue` the latest `summaryQueueLength`, a
`SingleSummary` the new one) and `requests` (each model call's `instructions` and `input`, two when
a summary cut at `summaryMaxTokens` was asked again; none for `CompactionStrategy.Custom`, whose
`compact()` runs on the runner's container). It checks the request and the plumbing; whether a fact
survives compaction is an eval case.

<!-- snippet-context
import { Compaction, CompactionStrategy } from "@agboss/core";
import { replyWith, testCompaction } from "@agboss/core/testing";
import { expect, it } from "vitest";
@Compaction({
  name: "conversation-compaction",
  description: "Summarises old turns",
  prompt: "Summarise the turns under `Turns to compact`.",
  model: "moonshotai/kimi-k2.6",
  strategy: CompactionStrategy.SummaryQueue,
  turnsBetweenCompactions: 5,
  summaryQueueLength: 10,
  summaryMaxTokens: 400,
})
export class ConversationCompaction {}
-->

```ts
it("testCompaction: the turns reach the model, the summary joins the queue", async () => {
  const compact = testCompaction(ConversationCompaction, { model: replyWith("Dana: no calls before 9.") });

  const { output } = await compact({
    previousSummaries: ["Dana asked about order 7."],
    turnsToCompact: [
      { startName: "chat-workflow-start", input: { text: "Never call me before 9." }, finishName: "chat-workflow-finish", output: { text: "Noted." } },
    ],
  });

  expect(output.requests[0]?.input).toContain("Never call me before 9.");
  expect(output.summaries).toEqual(["Dana asked about order 7.", "Dana: no calls before 9."]);
});
```

- `testRouter` of a model router answers from `model: routeTo(Target)` (or `decideWith(…)` before a
  launch); `testArbiter` of a model arbiter from `model: decideWith({ counts: 0.9 })`.
- The context levels: `{ tenantContext, tenant, executionContext, execution }` on any runner (checked
  by the classes' decorators); a class created by hand (a budget's `maxSpend()`) takes
  `testExecutionContext({ … })`.
- A tool's timeout is on `run.clock`: `await runTool.clock.advance(seconds(6))` past it gives
  `ToolTimeoutError`.

## Recorded runs (VCR)

<!-- snippet-context
import { ScreeningApplication } from "./src/screening/screening.application.js";
import { HiredWorkflowFinish, ScreeningWorkflowStart } from "./src/screening/finishes.js";
-->

```ts
// src/screening/screening.integration.test.ts — real models once, then replayed with no key or network
import { expect } from "vitest";
import { VCRMode, testWith } from "@agboss/core/testing";

const test = testWith(ScreeningApplication, {
  vcr: { cassetteName: "screening-hire", mode: process.env.CI ? VCRMode.REPLAY : VCRMode.AUTO },
});

test("a strong candidate is hired", async ({ app }) => {
  const result = await app.execute(ScreeningWorkflowStart, { name: "Dana", cv: "TypeScript, 6 years" });
  expect(result).toFinishWith(HiredWorkflowFinish);
});
```

`AUTO` records a missing cassette (`__snapshots__/screening-hire.cassette.json`, committed) and
replays an existing one; `REPLAY` (the default under `CI`) fails a call the cassette does not hold
with `CassetteMissingError` (`test.cassette-missing`); `RECORD` always calls the models.
`AGBOSS_VCR_MODE` (a `VCRMode` member's value) overrides every test's own mode for one run.
Recording goes through the application's model providers as `createApp` builds them — a transport
provider (`complete`, #385) too, created by the test app's container with its hooks (#439) — so an
offline transport records a cassette with no key: `AGBOSS_VCR_MODE=RECORD npx vitest run
tests/desk-cassette.test.ts` in `examples/flow-patterns`. A replay never creates a provider.

**Stale cassettes.** A cassette (version 2) keeps, with every call, its component and that
component's `promptHash` / `schemaHash` (the join keys of `npx agboss describe --json`). A replay
of a component whose prompt or schema changed since — an agent, a model router, and every other
component that calls a model (a model judge by the `reply` it judges, a guardrail, an arbiter, a
compaction, a reply interpreter, a PII policy that detects with a model) — or that the application
no longer has, fails with `StaleCassetteError` (`vcr.stale-cassette`: `file`, `component`, `changes`
— `CassetteChange.Prompt`, `Schema`, `Removed`), naming the command that fixes it.
`VCRMode.RECORD_STALE` replays the rest and records only the stale components' calls anew (a model
key needed for those only): `AGBOSS_VCR_MODE=RECORD_STALE npm test`. `npx agboss check --cassettes`
finds the same without running a test (`[vcr.stale-cassette]`, exit 3). A version 1 cassette (no
hashes) still replays, without stale detection, and prints a hint to re-record it once with
`AGBOSS_VCR_MODE=RECORD npm test`.

## The testing loops: the order to work in

Work from the cheapest loop outwards; a later loop never replaces an earlier one.

**Loop 0 — static, $0, after every change.** `npx agboss check` (assembly rules, generated types,
prompts, environment — all problems at once as `[rule.code]` lines, fix every one) and `npx agboss
describe` (the flow as assembled, each node's inputs and producers, models and limits). `check` also
assembles every `eval-suites/*.eval-suite.ts` of the application (its rules and its cases' values,
`eval-suites` in its list of checks) — no model is called. No test runs before `check` prints `ok:`.
With recorded cassettes, `npx agboss check --cassettes` too: a prompt or schema changed since a
recording is `[vcr.stale-cassette]`. An application that calls or serves others over A2A or MCP
runs `npx agboss check --federation snapshots/` too, with its neighbours' `agboss describe --json`
outputs saved there (files or folders, read from disk — no network): a consumed contract whose
target is gone is `[federation.missing-target]`, one whose export no longer accepts what it sends
or gives what it reads is `[federation.incompatible-schema]` (compared structurally, field by field),
each naming its blast radius — the consumer's workflows and tools that use it. Its own earlier
snapshot among them checks that a changed export got a new version
(`[federation.version-not-bumped]`, an error under `--strict`).

**Loop 1 — the harness, $0, every commit (`npm test`).**

1. The unit runners first, one component on its own: `testTool`, `testAction`, `testRouter`,
   `testArbiter`, `testRag`, `testJudge`, `testGuardrail`, `testPii`, `testToolInterceptor`,
   `testCompaction` (below).
2. Then the whole application: `testWith(App)` with `mockLlm(X).thenReturn(…)` scripts, or a
   recorded cassette (VCR) for real answers replayed with no key or network.
3. Assert the path and the finish (`toFollowPath`, `toFinishWith`) and **trajectory invariants**
   through `result.toolCalls` — which tools ran, with what input, how each ended — written so they
   hold whatever the order of the calls, never on the position of a step:
   `expect(result).toHaveCalledTools([GetOrderTool, CheckPolicyTool])` (each at least once),
   `expect(result).not.toHaveCalledTools([DeleteOrderTool])` (none of them),
   `expect(result).toHaveToolCallMatching(RefundTool, (input) => input.amountCents <= 10_000)` (a
   partial of the input or a check of it), and `toolCallsOf(Tool, result.toolCalls)` with filters on
   `status` for the rest.
4. Script the model's mistakes too — `callToolWithInvalidArguments`, `callToolWithTruncatedArguments`,
   `replyWithInvalidAnswer` — and assert the retry: the call recorded `InvalidArguments`, the next
   one's `step.validationAttempts`, or `rejects.toFailWith(AgentAnswerInvalidError, …)` after the
   third invalid answer.
5. **A stale cassette** (`StaleCassetteError`, `[vcr.stale-cassette]`: a component's prompt or
   schema hash changed since it was recorded): never edit a cassette by hand — re-record its stale
   interactions with `AGBOSS_VCR_MODE=RECORD_STALE npm test`, review the new answers in the diff,
   then run the evals (the section below): the re-recorded answers are new model behaviour.
6. The loops on a live model come next: an eval suite (the section below) runs the same trajectory
   invariants first, then code judges, then model judges — its cascade and the pass@k rule are
   there.

**Loops 2 and 3 — evals on a live model, paid, before a merge and on a schedule.**

1. Loop 2: `npx agboss eval run --suite <name> --runs <k> --env <name> --report <run.json>` — every
   case k times on the real application (the environment's services and fixtures), the cascade
   per run: free trajectory invariants → code `@Judge` → model `@Judge`. Read pass@k and pass^k
   per case; a case marked `unstable` (pass@k without pass^k) goes to deterministic code, not to a
   longer prompt. Add `--html <report.html>` to read the run in a browser: one self-contained page
   with the summary, the unstable cases and an attempt dot per run, each opening that run's checks
   and its timeline (every step's model calls, tool calls, guardrails and judges). An unstable case
   names the node where its attempts part ways: that node — same input, another choice — is the one
   to make deterministic.
2. Loop 3: the same run on `main` gives the run artifact (`--report`), kept as the reference the
   next runs are read against. `npx agboss eval show <run.json> --html <report.html>` renders a saved
   artifact again — in CI, from the artifact a run already made, without a second model bill. A
   branch runs `npx agboss eval run --suite <name> --runs <k> --baseline <run.json>
--fail-on-regression` — each case against the same case on `main`, exit 5 (`eval.regressed`)
   only when a case stable there (pass^k) is not now. A case that flapped on `main` too is
   quarantined (`CaseComparison.FlakyOnBaseline`), never a failure: move it to deterministic code.
3. Before trusting a model `@Judge` in the cascade, calibrate it: people label the runs of an
   artifact in `eval/labels/<suite>.jsonl`, and `npx agboss eval calibrate --report <run.json>` gives
   Cohen's κ between the judge and each labeler (and between labelers). A low κ with the judge
   passing what people fail: fix the judge (its prompt, or a code judge for what can be checked by
   code) before reading its pass rates.
4. Then the run under failures: `npx agboss eval run --suite <name> --runs <k> --chaos 0.2
--chaos-seed 7` injects 429s, timeouts and truncated answers into a fifth of the model calls — a
   case that passes without chaos and fails with it needs a `retryPolicy` on its provider, an
   `.onError` side path, or an undo (`compensateWith`) — never a longer prompt.
5. Then the run under rewordings: `npx agboss eval run --suite <name> --metamorphic` runs each
   case's `variants` too — a case whose rewording calls other tools (or misses a required call)
   depends on the wording: tighten the tool descriptions or move the choice to a code `@Router`.

## Eval suites: `@EvalSuite` (`@agboss/core/eval`)

The loops before it (the section above) are free; a suite is the first one that spends money —
reach it only once Loop 0 and Loop 1 are green.

An eval suite declares what a live-model run must do, case by case: one class per file in
`eval-suites/<name>.eval-suite.ts`, its `name` ending with `-eval-suite` and its class with
`EvalSuite`. The entry `@agboss/core/eval` holds the decorator and the builders only — nothing runs at
import. A case is one thread: `history` (past turns written into it, not run — what memory and its
compaction read), then `turns` run in order through the suite's `start`; the checks judge the last
turn. Every value is typed: a turn by the start's input, `tenant` / `execution` by the application's
context classes (required where it declares its own, as at `app.execute`), `toolCall` / `toolInvariant`
by the tool's input DTO, a past turn by its start's input and its finish's output.

<!-- snippet-context
import { CandidateArchiveTool, HireSavedJudge, ReasonedVerdictJudge } from "../components.js";
import { HiredWorkflowFinish, ScreeningWorkflowStart } from "../finishes.js";
-->

```ts file=src/screening/eval-suites/screening.eval-suite.ts
import {
  EvalCascade,
  EvalSuite,
  checkTrajectory,
  evalCase,
  judgedBy,
  pastTurn,
  toolCall,
  toolInvariant,
  turn,
} from "@agboss/core/eval";

@EvalSuite({
  name: "screening-eval-suite",
  description: "Strong candidates are hired, the archive is looked up once",
  start: ScreeningWorkflowStart,
  checks: [
    checkTrajectory(), // 1. each case's `tools`: deterministic, $0
    judgedBy(HireSavedJudge), // 2. a code judge: deterministic, $0
    judgedBy(ReasonedVerdictJudge), // 3. a model judge: paid, runs only if the two above passed
  ],
  cascade: EvalCascade.StopAtFirstFailure, // required: no implicit order
  cases: [
    evalCase({
      name: "strong-candidate-hired",
      tenant: { tenantId: "eval-acme" },
      turns: [turn({ name: "Dana", cv: "TypeScript, 6 years" })],
      tools: {
        required: [toolCall(CandidateArchiveTool, { name: "Dana" })],
        invariants: [toolInvariant(CandidateArchiveTool, (input) => input.name !== "")],
      },
    }),
    evalCase({
      name: "second-application",
      history: [
        pastTurn(ScreeningWorkflowStart, { name: "Ben", cv: "Go, 2 years" }, HiredWorkflowFinish, {
          hireId: "hire-ben-1",
        }),
      ],
      turns: [turn({ name: "Ben", cv: "Go, 4 years" })],
      variants: [turn({ name: "Ben", cv: "Four years of Go" })], // rewordings: the same tools
    }),
  ],
})
export class ScreeningEvalSuite {}
```

- **The cascade order is a declaration, not a convention:** free trajectory invariants first
  (`checkTrajectory()`), then code judges (`@Judge({ decidedBy: DecidedBy.Code })`), then model
  judges (`@Judge({ model })`) — with `EvalCascade.StopAtFirstFailure` a paid judge runs only on a
  run the free checks passed; the rest are `CheckStatus.Skipped`, and a skipped check fails the run.
  `EvalCascade.RunAll` runs every check whatever came before.
- **pass@k high, pass^k low** (a case solved at least once in k runs, but not every time): do not
  grow the prompt. Propose moving the check into deterministic code — a `@ToolInterceptor`, a code
  `@InputGuardrail` / `@OutputGuardrail` (`decidedBy: DecidedBy.Code`), `DecidedBy.Code` on a
  `@Router` or an `@Arbiter`, or an `@Action`.
- An eval judge judges the output of the finish the run ended at: its `reply` is a finish's
  `output` the start reaches (one value, never a list) — else `[eval.judge-wrong-reply]`. A case's
  own `judges: [judgedBy(X)]` run after the suite's checks.
- Assembled on its application before anything runs, every violation at once:
  `[name.kind-suffix]`, `[eval.unknown-start]` (the start is not one of the application's),
  `[eval.duplicate-case]` (case names key reports and baselines), `[eval.judge-wrong-reply]`, the
  judges' own `[judge.*]` rules; then the cases' values — `EvalCaseInvalidError`
  (`eval.case-invalid`, each issue as `case "x": tenant.plan — reason`, never a value).

## Running a suite: `agboss eval run`

```
npx agboss eval run --suite screening-eval-suite --runs 3 --env eval --report .artifacts/eval/main.json
```

- The application is built as `createApp` builds it, on the `--env` environment (default `dev`): the
  suite is assembled first (its rules, then its cases' values — `eval.case-invalid`, exit 3), then
  every case runs `--runs` times (default 1), one run after the other, each on a thread of its own.
  `--suite` names the suite by its full name; with one suite in the application it may be left out
  (several and none named, or an unknown name → `eval.unknown-suite`, exit 2, the suites listed).
- A run: the case's `history` written into its thread (no model call), its `turns` through
  `app.execute` with the case's `tenant` / `execution` (validated as there), then the checks on the
  last turn, in order. `checkTrajectory()` reads `result.toolCalls`: a `required` tool needs a call
  the tool ran (succeeded, failed or timed out) with the partial's arguments; a `forbidden` one any
  call at all; an invariant holds on every call with checked arguments.
- A judge runs in the frame of the case's last execution, created by the application's container:
  its services, `ExecutionContext` (that execution's id and thread) and the project's
  `TenantContext` / execution fields with the case's values. It gets the finish's output as its
  DTO and the last turn's `toolCalls`. A run that ended at a finish the judge does not judge (or at
  none: a pause) fails that check. A model judge's calls go through the application's models,
  counted in its application budgets.
- A turn that fails (or an earlier one that pauses) ends the run: `error: { code, message }`, no
  checks, the run failed.
- A run passes when every check that ran passed; a skipped check fails the run. Per case **pass@k**
  = at least one of the k runs passed, **pass^k** = every run passed; a case with pass@k and not
  pass^k is printed `unstable` (`isUnstable` in the artifact).
- It prints one row per case — `pass@3 pass^3 runs first failure` (`✓✗✓`, `run 2: trajectory: …`)
  — and the totals (`pass@3 3/3 · pass^3 2/3 · unstable 1 · judge calls 8 (1 skipped by the
cascade) · spent $0.3120`). `--report <run.json>` writes the run artifact — `kind:
"agboss.eval-run"`, `schemaVersion`, the suite, the workflow and its `configHash`, `runs`,
  `cascade`, each case's `caseHash`, `passed` / `runs`, `passAtK`, `passHatK`, `isUnstable` and
  `runResults` (each run's `executionId`, `finish`, `checks` with `status`, `reason`, `skippedBy`,
  `metrics`, `spentUsd`), `summary`, `spend`; `--json` carries the same as the envelope's `result`.
  `schemaVersion` 2 (#397 PR 2) adds each run's `trace` (`EvalExecutionTrace`: the last turn's steps
  — `EvalStepTrace` with `inputHash`, model calls, tool calls, guardrail decisions, judge verdicts —
  handled errors, pauses, undo actions, children, the output; masked by the application's PII
  policies like the record) and each case's `expectation` (`EvalCaseExpectation`); a version 1
  artifact is still read.
- The exit code says whether the suite ran (0), not how well it did.
- `--html <report.html>` writes the run as one self-contained HTML page (no request: inline style
  and script; light and dark; phone width): header, summary (pass@k, pass^k, cases, attempts,
  spend), against the baseline (a run made with `--baseline`: regressions first, every case's
  verdict), unstable cases (each with the node where its attempts part ways — the first step whose
  node, input, decisions or tool calls differ), every case with its expectation and an attempt dot
  per run — passed, failed, error, limit — each opening that run's execution, error, checks and
  timeline. It shows only what the artifact holds; one value is cut at 2,000 characters on the page,
  and a page above 16 MB leaves out the timelines of cases with pass^k, then all (the CLI line says so).
- `npx agboss eval ui [--dir .agboss/eval] [--port 4317]` serves a folder of run artifacts on
  127.0.0.1, read-only, behind the token it prints (open the printed URL): the runs newest first, each
  case's attempt dots, each run's report page. It runs nothing; Ctrl+C stops it. A `schemaVersion` 3
  artifact names what it ran on — `profile`, `agbossVersion`, `models` (`EvalModelUse`: each agent's
  and model router's model and provider), `piiPolicies` — shown in the page's header; a version 4
  one each run's `tenantId` (#397 PR 5b).
- Labelling there (#397 PR 4): each run's page has a form per judge verdict — passed / failed, a
  1–4 score (optional), failure tags from `eval/failure-taxonomy.yaml` (`tags: [{ tag, description
}]`, kebab-case, the only tags allowed), a note, who labels (`--labeler`) — saved to
  `eval/labels/<suite>.jsonl` (`--labels-dir`), exactly what `npx agboss eval calibrate` reads; the
  page's calibration (κ per pair of raters, confusion, disagreements) is recomputed on every load.
  Label disagreements first: they are where a judge needs a better rubric or deterministic code.
- Golden cases there (#397 PR 5): a run with an execution has "Save as golden case" — its kept
  execution drafted exactly as `npx agboss generate eval-case <name> --from-execution <executionId>`
  drafts it (the turn, the contexts, the thread's earlier turns as `history`, its calls as
  `tools.required`) and written into the suite's file under the name you give. It needs the
  application's history (`@Application({ executionRecordRetention })`, its stores on `--env`; the
  application from `package.json` or `--application`) — without it the page says so instead of a
  button. The file is written whole and atomically, only if it is still the one the page was made from
  (else 409: reload), never over a case of the same name (409). The execution is the run's own: the
  kept record on the run's thread, of the run's `tenantId` — an id kept for several tenants of a run
  from before artifacts carried the tenant (version 3 or older) is 409: run the suite again. Review the case, then
  commit it.
  `npx agboss eval show <run.json> [--html <report.html>]` reads a saved artifact back: the table,
  and the same page; it runs nothing.
- `--profile <name>` runs the suite on `profiles/<workflow>/<name>.yaml`; the case's `history` turns
  are kept `ExecutionRecordStatus.Written` — turns of their thread, never runs `npx agboss eval
score` scores or `npx agboss golden add` saves.

### Against a baseline: `--baseline <run.json> [--fail-on-regression]` and `--save-baseline <baseline.json>`

```
npx agboss eval run --suite screening-eval-suite --runs 3 --env eval --baseline main.json --fail-on-regression
```

- `--save-baseline <baseline.json>` writes a compact, git-diff-friendly baseline snapshot (`kind: "agboss.eval-baseline"`, `schemaVersion: 1`, per-case `caseId`, `caseHash`, `runs`, `passed`, `passAtK`, `passHatK`, `flaky`, `avgSpendUsd`, `verdictSummary`) meant for `eval/baseline/main-baseline.json`, while full run artifacts (`--report`) stay in gitignored `.agboss/eval/`.
- The baseline passed to `--baseline` is either a compact baseline snapshot (`--save-baseline`) or a full run artifact (`--report` of a run of `main`; its type `EvalRunReport`, public in
  `@agboss/core/eval` with `EVAL_RUN_KIND` and `EVAL_RUN_SCHEMA_VERSION`), read before anything runs: another
  `kind`, another `schemaVersion`, a missing field (`eval.run-invalid`), no file
  (`eval.run-not-found`) or a run of another suite (`eval.run-invalid`) — exit 2. `--fail-on-regression` needs `--baseline`.
- Each case is compared by name — `CaseComparison`: `Regressed` (pass^k on the baseline, not now),
  `Improved` (no pass@k there, pass@k now), `Unchanged`, `FlakyOnBaseline` (pass@k without pass^k on
  the baseline: quarantined), `New`, `Removed`, `Changed` (another `caseHash`: the case, its tools'
  expectations, its judges, the suite's checks or cascade changed — not compared).
- It prints `case baseline candidate verdict` (`3/3 1/3 regressed`, `flaky-on-baseline
(quarantined)`, `changed (not compared)`) and the counts (`1 regressed · 1 quarantined · 1
unchanged`); the artifact and `--json` gain `baseline` (`EvalRunComparison`: the file, its
  `configHash`, `startedAt`, `runs`, each case's verdict with both sides' passes, `regressed`).
- With `--fail-on-regression` a regression is exit 5 (`quality`, `eval.regressed`: `1 case regressed
against main.json: refund-within-policy`); without it the run exits 0 and shows the table.

### Calibrating a judge: `npx agboss eval calibrate`

```
npx agboss eval calibrate --report main.json        # labels from eval/labels/<suite>.jsonl
npx agboss eval calibrate --report main.json --labels labels/refunds.jsonl
```

- A label is one JSON line (`EvalLabel`, public in `@agboss/core/eval`): `{ "runId": "refund-within-policy#2",
"executionId": "…", "judge": "answer-grounded-judge", "labeler": "anna", "passed": false,
"score": 2, "failureTags": ["invents-fee"], "note": "…" }` — `runId` is the case and its run as the
  artifact numbers them (`<case>#<run>`), `executionId` the run's last execution (the one its judges
  judged, `executionId` in the artifact). `passed` is what κ reads; `score` (1–4, optional) only feeds
  the scores view; `failureTags` is required (`[]` for none).
- Per judge (`EvalJudgeCalibration`): `n` (labelled runs), pairwise Cohen's κ — the judge with each
  labeler, then every two labelers on the runs both labelled (`κ=—` when one rater gave one verdict
  only) —, a confusion matrix per labeler, every disagreement (run, labeler, the judge's metrics,
  tags, note), and the rubric: each key of the judge's `metrics` over the disagreements and the
  agreements (a text or flag by value, a number by its mean on each side) — which measure goes with
  the judge being wrong.
- Labels of executions the artifact does not have (the file grows over many runs) or of a skipped
  judge are counted as unmatched, never an error; a malformed line, a second label of one run by one
  labeler for one judge, or a `runId` that is not its execution's run → `eval.labels-invalid`, exit 2.
  It reads two files and runs nothing; `--json` carries the calibration (`EvalCalibration`).

### Under failures: `--chaos <rate> --chaos-seed <n> [--chaos-failures <list>]`

```
npx agboss eval run --suite screening-eval-suite --runs 3 --env eval --chaos 0.2 --chaos-seed 7
npx agboss eval run --suite screening-eval-suite --chaos 0.2 --chaos-seed 7 --chaos-failures rate-limited,timeout
```

- `ChaosFailure` (`@agboss/core/eval`, a set of its own — never a `ModelFailure`): `RateLimited`
  (`rate-limited`: a 429), `Timeout` (`timeout`), `TruncatedResponse` (`truncated-response`: the answer
  cut at its token limit — `finish_reason: "length"`, its text and its tool calls' arguments cut
  short). `--chaos-failures` defaults to all three.
- Injected at the provider's HTTP client (its `POST`s; the model lists read at start are never touched)
  and at a transport's `complete()`, below the attempt runner: the provider's `retryPolicy`, its rate
  limit's 429 pause and its breaker see each failure as the provider's own; a failure no retry
  absorbs fails the step — its `.onError` side path runs, and its undo actions (#340) with it.
- The rate (above 0, at most 1) and the seed (a whole number) come together (`usage.missing-option`
  otherwise; a bad value is `usage.option-value`): one seed, one sequence of failures — a chaos run can
  be repeated. Chaos runs on the real budgets: retried calls are paid as usual.
- It prints `chaos: rate 0.2, seed 7 — 5 of 31 model calls failed on purpose (rate-limited 2, timeout
2, truncated-response 1)`; the artifact (and `--json`) gains `chaos` (`EvalRunChaos`: the rate, the
  seed, the failures, `calls` seen, `injected` by kind). Chaos belongs to `eval run` only: there is
  no `createApp` option for it.

### Under rewordings: `--metamorphic`

```
npx agboss eval run --suite screening-eval-suite --runs 3 --metamorphic
```

- Each `variants` entry of a case is its last turn reworded (typed by the start's input like a
  turn). With `--metamorphic` every run of the case runs each variant too, on a thread of its own:
  the case's `history` written, its earlier turns run, then the variant in place of the last turn.
- The check `metamorphic` comes after the suite's checks and the case's judges, under the cascade
  (`StopAtFirstFailure`: skipped once one failed — no variant runs, nothing more is spent). It passes
  when every variant called the same set of tool classes as the case's own last turn (the calls that
  ran) and met the case's `tools.required` again (the same partials); else it fails with each reason
  — `variant 1 calls lookup-tool, not lookup-tool, refund-tool; variant 1: refund-tool not called
(required)`. `metrics: { variants: n }`; the variants' spend is the run's. A case without
  `variants` gets no such check.
- The artifact (and `--json`) says `metamorphic: true`; the case's `caseHash` covers its variants
  only then, so a run with the flag is `Changed` against a baseline without it — never `Regressed`.
  The check is no judge: calibration and the judge counts leave it out.

### A case from a kept execution: `generate eval-case`

```
npx agboss generate eval-case refund-from-prod --suite refunds-eval-suite --from-execution <executionId> [--tenant <id>] [--dry-run]
```

- Reads the execution from the application's history (`@Application({ executionRecordRetention })`,
  reference 09) — runs nothing, calls no model — and adds one `evalCase({ … })` to the suite's
  `cases`: its start's input as the case's one `turn(…)`, its tenant and execution values (none for
  the default tenant without fields), the thread's earlier **finished** turns as `history:
[pastTurn(Start, input, Finish, output)]` (oldest first), and the tool calls it ran (succeeded,
  failed or timed out — not declined or blocked), each tool with the same arguments once, as
  `tools: { required: [toolCall(Tool, arguments)] }`. The classes it names are imported into the
  suite's file (merged into an import of the same module), with `pastTurn` / `toolCall` / `turn`.
- Values are the history's: **masked** as it keeps them (`<email>`, tokens), so read the case and
  replace what a turn needs real before you run it; then tighten `required` to the partials that
  matter and add `forbidden` / `invariants` / judges by hand.
- `--suite` is optional when the application has one suite; the suite's `start` must be the
  execution's (`[eval.case-start-mismatch]`). An id two tenants kept needs `--tenant`
  (`records.ambiguous-execution`, exit 2); an unknown one is `records.not-found` (3); an application
  that keeps nothing `records.not-kept` (3); a case name the suite already has exit 4. A tool the
  project has no class for is left out and named in the notes.
- `npx agboss check` afterwards: the new case is assembled with the suite (`eval.case-invalid` for
  a value that no longer fits).

## Evals on real traffic

```
npx agboss golden add --start screening-workflow-start --name hires --from-last 20   # save recent tasks
npx agboss compare --start screening-workflow-start --profiles base,cheaper --golden hires
npx agboss eval score --start screening-workflow-start --limit 50                   # score recent runs
npx agboss replay --start screening-workflow-start --version <prompt version>        # re-run a version
```

- A golden set is `golden/<workflow>/<name>.yaml`; a profile (`profiles/<workflow>/<name>.yaml`)
  overrides models and settings for a comparison; the agent's judges score each answer.
- `compare` judges each task's pair of answers in both orders — the baseline's first, then the
  other's: agreeing verdicts are a win or a loss, anything else a tie; a judge that picks the same
  position both times is following the position, not the answer — counted as a tie and in `flips`
  (`PairwiseResult.positionFlips`). From code: `compareProfiles(Application, { start, profiles,
tasks })`, on the workflow that `start` opens, assembled as `createApp` assembles it.
- A model judge of the judged agent's own vendor grades that family's answers too kindly:
  `[judge.same-model-family]` (the slug's vendor prefix, `openai` of `openai/gpt-6`), a warning —
  an error under `npx agboss check --strict`; for a suite's judge, against every agent of the
  workflow its start opens. Give the judge another vendor's model, or decide it by code (`DecidedBy.Code`).
- Real-model runs cost money and are never part of `npm test`.

## Pitfalls

- `new SkillsAgent()`, `new CandidateArchiveTool(fake)` in a test: use `testWith` or the runner and
  `overrides` / `mockOf`.
- A script for a path the test does not take: it fails as unused — script only what runs.
- `thenReturnAlways` to silence a loop: script the exact turns; a loop is bounded by `maxVisits`.
- Asserting on `Date.now()` or real timers: advance the `clock` fixture.
- A test environment that reads a secret: leave secrets out of `test.environment.ts`.
- Testing the graph by inspecting it: run it and assert the path (`toFollowPath`) and the finish.
- Expecting `testWith` to call a transport provider's `complete()`: `mockLlm` answers above it (only a VCR recording calls it, #439).
