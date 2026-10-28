import { Flag, Integer, Text } from "@agboss/core/dto";

export class RecoveryPlanDto {
  @Text({ prompt: "Release identifier" })
  releaseId!: string;

  @Text({ prompt: "Release semantic version" })
  version!: string;

  @Integer({ prompt: "Next attempt number to execute", min: 2 })
  nextAttemptNumber!: number;

  @Text({ prompt: "Root cause analysis of the integration gate failure and confirmation of saga compensation" })
  rootCauseAnalysis!: string;

  @Text({ prompt: "Corrected compiler and ABI build flags for the next attempt (including --abi-compat=v2)" })
  correctedBuildFlags!: string;

  @Flag({ prompt: "Whether the retry should enable the lease takeover drill" })
  enableLeaseTakeoverDrill!: boolean;
}
