# 07 — Guardrails, PII and security

Read this when unsafe input must be refused before a model reads it, an answer must be stopped
before it leaves an agent, or personal data must never reach a model as is. Quality checks that
retry an answer are judges (`03-components-di-and-lifecycle.md`); guardrails only block.

| Need                                                               | Use                                                                            |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| refuse a request before the model reads it                         | `@InputGuardrail` — a yes / no question; P(yes) ≥ `threshold` blocks           |
| stop an answer before it leaves the agent                          | `@OutputGuardrail`                                                             |
| block by a rule in code (a deny list, a regex), no model           | `decidedBy: DecidedBy.Code` + `implements GuardrailHandler` (`check(text)`)    |
| hide contact, government, financial or credential data from models | a declarative `@PiiPolicy({ rules: [pii(PiiKind…, PiiAction…)] })`             |
| hide your own identifiers (employee ids, case numbers)             | `@PiiPolicy({ action, deps })` + `implements PiiPolicyHandler` (`findMatches`) |
| mask one DTO or context field wherever it goes                     | `sensitive: PiiAction.replaceWithToken()` on its decorator                     |
| refuse a message that contains a card number                       | `pii(PiiKind.CardNumber, PiiAction.blockWithRefusal(…))`                       |

## Guardrails

```ts file=src/clinic/clinic-context.ts
// the project's execution context (identity only) and a service the refusal reads
import { ExecutionContext, Injectable } from "@agboss/core";
import { OneOf } from "@agboss/core/dto";

export class ClinicExecutionContext extends ExecutionContext {
  @OneOf({ values: ["en", "he"] })
  locale!: "en" | "he";
}

@Injectable()
export class RefusalTextService {
  legalAdvice(locale: "en" | "he"): Promise<string> {
    return Promise.resolve(locale === "he" ? "אין ייעוץ משפטי." : "I can't give legal advice.");
  }
}
```

```ts file=src/clinic/guardrails.ts
import { InputGuardrail, OutputGuardrail, type GuardrailRefusal } from "@agboss/core";
import { ClinicExecutionContext, RefusalTextService } from "./clinic-context.js";

// guardrails/legal-advice.guardrail.ts — a computed refusal: the sender's language, from a service
@InputGuardrail({
  name: "legal-advice-guardrail",
  description: "Blocks requests for legal advice",
  prompt: "Does the message ask for legal advice?",
  model: "typesafe/jev-1.13", // a decision model: one Decision.noul; a chat model: one answer tool
  threshold: 0.8,
  deps: [ClinicExecutionContext, RefusalTextService],
})
export class LegalAdviceGuardrail implements GuardrailRefusal {
  constructor(
    private readonly clinicExecutionContext: ClinicExecutionContext,
    private readonly refusalTextService: RefusalTextService,
  ) {}

  refusal(): Promise<string> {
    return this.refusalTextService.legalAdvice(this.clinicExecutionContext.locale);
  }
}

// guardrails/no-diagnosis.guardrail.ts — a fixed refusal; no model: defaults.guardrail.model
@OutputGuardrail({
  name: "no-diagnosis-guardrail",
  description: "Blocks answers that diagnose",
  prompt: "Does the answer give a medical diagnosis?",
  threshold: 0.7,
  refusal: "I can't diagnose. Please see a doctor.",
})
export class NoDiagnosisGuardrail {}
```

A guardrail decided by code (#383) is the same component without a model: `decidedBy:
DecidedBy.Code` and the class's `check(text)` (`implements GuardrailHandler`) returns
`GuardrailVerdict.passed()` or `GuardrailVerdict.blocked()` — no `prompt`, `promptUrls`, `model` or
`threshold` (they do not compile), no model call, cost 0. Its refusal is the decorator's text or the
class's `refusal()` (`implements GuardrailHandler, GuardrailRefusal`), as for a model guardrail:

```ts file=src/clinic/code-guardrails.ts
import {
  DecidedBy,
  GuardrailVerdict,
  Injectable,
  OutputGuardrail,
  TenantContext,
  type GuardrailHandler,
} from "@agboss/core";

@Injectable()
export class BlocklistService {
  containsBlockedTerms(tenantId: string, text: string): Promise<boolean> {
    return Promise.resolve(tenantId === "acme" && text.toLowerCase().includes("competitor"));
  }
}

// guardrails/tenant-blocklist.guardrail.ts — decided by code: the tenant's deny list, no model
@OutputGuardrail({
  name: "tenant-blocklist-guardrail",
  description: "Blocks replies containing words forbidden by the tenant",
  decidedBy: DecidedBy.Code, // absent = DecidedBy.Model
  refusal: "The response contained restricted terms.",
  deps: [TenantContext, BlocklistService],
})
export class TenantBlocklistGuardrail implements GuardrailHandler {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly blocklistService: BlocklistService,
  ) {}

  async check(text: string): Promise<GuardrailVerdict> {
    const hasForbidden = await this.blocklistService.containsBlockedTerms(
      this.tenantContext.tenantId,
      text,
    );
    return hasForbidden ? GuardrailVerdict.blocked() : GuardrailVerdict.passed();
  }
}
```

- **What it reads**: an input guardrail reads the visit's input message of an agent or a model
  router — **masked** by that element's PII policies — before the first model call (a resume never
  checks again); an output guardrail reads the agent's answer (its text or its answer's JSON,
  masked) as it leaves the loop. A code guardrail's `check(text)` gets the same masked text — it
  sees `<email:7f3a91>`, never the address; a rule on raw values belongs in a `@PiiPolicy`
  detector.
- **Blocked** → the execution fails with `GuardrailBlockedError` (`guardrail.blocked`: `guard`,
  `refusal` — the text to send instead —, `key: guardrails.<name>.threshold`, `probability`,
  `threshold`; a code guardrail's block is `probability` 1 against `threshold` 1, a pass 0). A model
  that does not answer, or a `check` that throws (its error the `cause`) or returns no
  `GuardrailVerdict`, **fails closed**: `GuardFailedError` (`step.guard`, a `StepFailedError`).
- **Levels add up**: `guardrails` on `@Application` → `@Workflow` → `@Agent` / `@Router`;
  `excludeGuardrails` on an agent or a router removes an inherited one for that element only. A model
  router takes input guardrails only; a code router calls no model and takes none. A child workflow
  gets its own workflow's lists over the application's.
- **The model**: `model`, else `defaults.guardrail.model` (application or workflow) — never
  `defaults.router.model`, no built-in (`[guardrail.no-model]`); a code guardrail needs none.
- Spend `guardrail:<name>` (category `guards`), counted in the budgets — none for a code guardrail;
  events `onGuardrailStart` / `onGuardrailEnd` for both. `agboss describe` prints a code one as
  `tenant-blocklist-guardrail — output · decidedBy: code · refusal: "…" · on …`; `configHash` covers
  its `decidedBy`, side and refusal.

The caller sends the refusal instead of an answer:

<!-- snippet-context
import { GuardrailBlockedError, type App } from "@agboss/core";
import { ClinicWorkflowStart } from "./src/clinic/clinic.application.js";
declare const app: App;
declare function reply(text: string): Promise<void>;
-->

```ts
try {
  const result = await app.execute(
    ClinicWorkflowStart,
    { text: "Can I sue my doctor?", patientName: "Dana Levi" },
    { execution: { locale: "he" } },
  );
  await reply(result.output?.text ?? "");
} catch (error) {
  if (!(error instanceof GuardrailBlockedError)) throw error;
  await reply(error.refusal); // the guardrail's text, in the sender's language
}
```

## PII policies

```ts file=src/clinic/pii.ts
import { Injectable, PiiAction, PiiGroup, PiiKind, PiiPolicy, pii, type PiiMatch, type PiiPolicyHandler, type PiiRefusal } from "@agboss/core";

// pii/contact.pii-policy.ts — declarative: only the kinds a rule names are found
@PiiPolicy({
  name: "contact-pii-policy",
  description: "Hides contact details and refuses card numbers",
  rules: [
    pii(PiiGroup.Contact, PiiAction.replaceWithKind()), // <phone>, <postal-code>, …
    pii(PiiKind.Email, PiiAction.replaceWithToken()), // a kind rule beats its group: <email:7f3a91>
    pii(PiiKind.CardNumber, PiiAction.blockWithRefusal()), // the text: refusal(kind) below
  ],
})
export class ContactPiiPolicy implements PiiRefusal {
  refusal(kind: PiiKind): string {
    return `Please do not send a ${kind} here.`;
  }
}

@Injectable()
export class PatientRegistryService {
  patientIdsIn(text: string): readonly PiiMatch[] {
    return [...text.matchAll(/PAT-\d{6}/gu)].map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
    }));
  }
}

// pii/patient-id.pii-policy.ts — the project's own detector: ranges, the framework applies `action`
@PiiPolicy({
  name: "patient-id-pii-policy",
  action: PiiAction.replaceWithToken(), // the model reads <patient-id:…>
  deps: [PatientRegistryService],
})
export class PatientIdPiiPolicy implements PiiPolicyHandler {
  constructor(private readonly patientRegistryService: PatientRegistryService) {}

  findMatches(text: string): readonly PiiMatch[] {
    return this.patientRegistryService.patientIdsIn(text);
  }
}
```

```ts file=src/clinic/environments/app.environment.ts
import type { Secret } from "@agboss/core";

export class ClinicEnvironment {
  piiPseudonymKey?: Secret; // the HMAC key of tokens: one token per value on every instance
}
```

```ts file=src/clinic/environments/test.environment.ts
import type { ClinicEnvironment } from "./app.environment.js";

export const environment: ClinicEnvironment = {}; // tests: a fixed PII key, no secret to set
```

```ts file=src/clinic/clinic.application.ts
import { Agent, Application, Budget, BudgetPeriod, BudgetScope, DecidedBy, PiiAction, Router, Workflow, WorkflowFinish, WorkflowStart, route, start, type BudgetHandler } from "@agboss/core";
import { Text, WorkflowFinishTextDto } from "@agboss/core/dto";
import { usd, type Usd } from "@agboss/core/units";
import { ClinicExecutionContext, RefusalTextService } from "./clinic-context.js";
import { ClinicEnvironment } from "./environments/app.environment.js";
import { LegalAdviceGuardrail, NoDiagnosisGuardrail } from "./guardrails.js";
import { ContactPiiPolicy, PatientIdPiiPolicy, PatientRegistryService } from "./pii.js";

export class PatientMessageDto {
  @Text({ prompt: "the patient's message" })
  text!: string;

  @Text({ prompt: "the patient's name", sensitive: PiiAction.replaceWithToken() }) // masked wherever it goes
  patientName!: string;
}

@Agent({
  name: "clinic-agent",
  description: "Answers patients' practical questions",
  prompt: "Answer practical questions about appointments. Never diagnose.",
  model: "moonshotai/kimi-k2.6",
  input: { message: PatientMessageDto },
  guardrails: [LegalAdviceGuardrail], // this agent's model only
})
export class ClinicAgent {}

@Agent({
  name: "billing-agent",
  description: "Answers billing questions",
  prompt: "Answer billing questions.",
  model: "moonshotai/kimi-k2.6",
  input: { message: PatientMessageDto },
  excludeGuardrails: [NoDiagnosisGuardrail], // billing answers cannot diagnose
  excludePiiPolicies: [PatientIdPiiPolicy], // its model sees patient ids; logs and traces stay masked
})
export class BillingAgent {}

@Router({
  name: "clinic-router",
  description: "Sends a message to the agent that answers it",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  prompt: "Pick who answers the patient.",
  input: { message: PatientMessageDto }, // read masked: the policies apply to routers too
  routes: [
    { prompt: "Appointments and practical questions", target: ClinicAgent },
    { prompt: "Invoices, payments and insurance", target: BillingAgent },
  ],
})
export class ClinicRouter {}

@WorkflowStart({ name: "clinic-workflow-start", description: "A patient's message", input: PatientMessageDto })
export class ClinicWorkflowStart {}

@WorkflowFinish({ name: "clinic-workflow-finish", description: "The answer", output: WorkflowFinishTextDto })
export class ClinicWorkflowFinish {}

@Workflow({
  name: "clinic-workflow",
  version: "1.0.0",
  flow: [
    start(ClinicWorkflowStart)
      .returns(PatientMessageDto)
      .toRouter(ClinicRouter)
      .chooseOne(
        route(ClinicAgent)
          .toFinish(ClinicWorkflowFinish),
        route(BillingAgent)
          .toFinish(ClinicWorkflowFinish),
      ),
  ],
  maxSteps: 2,
  piiPolicies: [PatientIdPiiPolicy], // every agent and router of this workflow
  providers: [RefusalTextService, PatientRegistryService],
})
export class ClinicWorkflow {}

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
  name: "clinic-application",
  version: "1.0.0",
  environment: ClinicEnvironment,
  executionContext: ClinicExecutionContext, // execute(…, { execution: { locale } })
  pseudonymKey: "piiPseudonymKey", // names the Secret field of the environment
  workflows: [ClinicWorkflow],
  budgets: [ApplicationDailyBudget, TenantDailyBudget, ExecutionBudget],
  guardrails: [NoDiagnosisGuardrail], // every agent of every workflow
  piiPolicies: [ContactPiiPolicy], // every agent and router of every workflow
  defaults: { guardrail: { model: "typesafe/jev-1.13" } }, // guardrails without their own model
})
export class ClinicApplication {}
```

How PII masking works — the **model boundary** (S38):

- **Everything a model reads is masked** — instructions, thread memory and summaries, the input
  message, tool results — and its move is **revealed before any DTO is validated**: a tool gets the
  real `alice@example.com`, an `@Email` field validates the address. Code — actions, finishes, code
  routers, channels, tools — always holds real values; so do the scope and the checkpoint.
- Only `replaceWithToken()` is reversible (HMAC-SHA256; its map is the checkpoint's `piiTokens`
  channel, surviving pauses, resumes and recovery). A token a model invents (no map knows it) is an
  invalid answer: the model reads why and answers again.
- **Block rules**: in what comes in or in an answer → the execution fails with `PiiRefusedError`
  (`pii.refused`, `kind`, `refusal`); in tool arguments or a tool result → only that call is
  rejected (the model reads `Tool error: the call was refused: …`).
- **Levels add up**: `piiPolicies` on `@Application` → `@Workflow` → `@Agent` / `@Router`;
  `excludePiiPolicies` removes one for that element's model and tools only. Logs, traces, events and
  `result.record` are always masked by the application's and the workflow's lists.
- **Detection**: formats are validated (Luhn, IBAN, Israeli ID, SSN rules, …); kinds without a
  format (`PersonName`, `StreetAddress`, `DateOfBirth`, `PassportNumber`, …) need
  `detectWithModel: "<chat model>"` on the policy (`[pii.kind-needs-model]`); a detection answer that
  is not the JSON asked for fails closed (`PiiDetectionFailedError`).
- **The key**: a policy's own `pseudonymKey: secret("…")`, else `@Application({ pseudonymKey })`.
  Neither → a key per root execution and the warning `[application.pii-instance-key]`.

Actions: `PiiAction.replaceWithKind()` → `<israeli-id>`; `replacePart({ keepLast: 4 })` /
`replacePart({ keepDomain: true })` / `replacePart({ pattern })` → `•••• 4242`;
`replaceWithToken()` → `<email:7f3a91>`; `blockWithRefusal({ refusal })` or `blockWithRefusal()` with
`implements PiiRefusal`.

## Testing

<!-- snippet-context
import { ClinicExecutionContext } from "./src/clinic/clinic-context.js";
import { ContactPiiPolicy } from "./src/clinic/pii.js";
import { LegalAdviceGuardrail } from "./src/clinic/guardrails.js";
-->

```ts
import { decideWith, testGuardrail, testPii } from "@agboss/core/testing";
import { expect, it } from "vitest";

it("blocks a legal question with the refusal in the sender's language", async () => {
  const check = testGuardrail(LegalAdviceGuardrail, {
    model: decideWith({ blocks: 0.95 }),
    execution: { locale: "he" }, // the ClinicExecutionContext fields the refusal reads
    executionContext: ClinicExecutionContext,
  });

  const { output } = await check("Can I sue my doctor?", { element: "clinic-agent" });

  expect(output).toEqual({ isBlocked: true, probability: 0.95, refusal: "אין ייעוץ משפטי." });
});

it("a model reads a token, its answer gets the address back", async () => {
  const contacts = testPii([ContactPiiPolicy]);

  const { output: masked } = await contacts.mask("Mail alice@example.com");

  expect(masked).toMatch(/^Mail <email:[0-9a-f]{6,}>$/u);
  expect(contacts.reveal(masked)).toBe("Mail alice@example.com");
});
```

A code guardrail runs its `check(text)` on its own container — no `model` option (one is a
`TestSetupError`): `testGuardrail(TenantBlocklistGuardrail, { tenant: { tenantId: "acme" } })("…")`
→ `{ isBlocked: true, probability: 1, refusal }` or `{ isBlocked: false, probability: 0 }`; in
`testWith(App)` it is not scripted (`mockLlm` of it names why) — `mockOf()` the services its `check`
uses.

In `testWith(App)` an unscripted model guardrail passes; `mockLlm(LegalAdviceGuardrail).thenReturn(decideWith({ blocks: 0.9 }))`
blocks, and `rejects.toFailWith(GuardrailBlockedError, { guard: "legal-advice-guardrail" })`
asserts it. A `pseudonymKey` whose variable is unset gets a fixed test key.

## Rule codes

| Code                                                                | Cause → fix                                                                       |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `[guardrail.no-model]`                                              | no `model` and no `defaults.guardrail.model` → set one (the router's is not used) |
| `[guardrail.missing-refusal]` / `[guardrail.refusal-twice]`         | neither / both a `refusal` text and a `refusal()` method → exactly one            |
| `[guardrail.no-prompt]`                                             | no question → `prompt` or `promptUrls`                                            |
| `[guardrail.missing-handler]`                                       | `DecidedBy.Code` without `check(text)` → `implements GuardrailHandler`            |
| `[guardrail.threshold-invalid]`                                     | `threshold` outside (0, 1] → e.g. `0.8`                                           |
| `[guardrail.output-on-router]`                                      | an `@OutputGuardrail` on a router → on the agents                                 |
| `[guardrail.no-model-call]`                                         | guardrails on a code router → remove them (it calls no model)                     |
| `[guardrail.exclude-not-inherited]` / `[pii.exclude-not-inherited]` | excluding what the element does not inherit → remove the exclude                  |
| `[guardrail.not-a-guardrail]` / `[pii.not-a-policy]`                | a class without the decorator in a list → decorate it                             |
| `[pii.conflicting-rules]`                                           | two policies give one kind different actions → one action per kind                |
| `[pii.missing-refusal]` / `[pii.unused-refusal]`                    | `blockWithRefusal()` without `refusal(kind)` / a `refusal` nobody uses            |
| `[pii.kind-needs-model]`                                            | a kind without a format and no `detectWithModel` → add it, or drop the kind       |
| `[application.pii-instance-key]`                                    | tokens without an application key (a warning) → `@Application({ pseudonymKey })`  |

## Pitfalls

- A prompt rule ("never repeat emails") instead of a policy: models leak; the boundary does not.
- Masking inside a tool by hand: the tool gets real values on purpose — the boundary already masked
  what the model read.
- Excluding a policy on an agent and expecting logs to show the value: logs and traces stay masked.
- A secret in a context subclass or a DTO: contexts are identity only; services read secrets from
  the environment (`Secret`, `.reveal()` only where it is sent).
- Catching `GuardFailedError` as "allowed": it means nothing was checked.
