import { Agent } from "@agboss/core";
import { Reasoning } from "@agboss/core/models";
import { CompensatedReleaseCandidateDto } from "../../dto/compensated-release-candidate.dto.js";
import { RecoveryPlanDto } from "../../dto/recovery-plan.dto.js";
import { ReleaseRequestDto } from "../../dto/release-request.dto.js";
import { InspectFailedAttemptTool } from "../../tools/inspect-failed-attempt.tool.js";

@Agent({
  name: "release-recovery-planner-agent",
  description:
    "Analyzes a compensated release attempt using the SQLite release ledger tool and produces a corrected recovery plan for the next distributed release attempt.",
  promptUrls: ["./release-recovery-planner.prompt.md"],
  model: "openai/gpt-4o-mini",
  reasoning: Reasoning.off(),
  temperature: 0,
  maxTokens: 800,
  maxToolCalls: 2,
  maxVisits: 2,
  maxRetries: 1,
  tools: [InspectFailedAttemptTool],
  input: {
    releaseRequest: ReleaseRequestDto,
    compensatedCandidate: CompensatedReleaseCandidateDto,
  },
  output: RecoveryPlanDto,
})
export class ReleaseRecoveryPlannerAgent {}
