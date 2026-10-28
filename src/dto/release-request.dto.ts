import { Flag, Integer, Text } from "@agboss/core/dto";

export class ReleaseRequestDto {
  @Text({ prompt: "Unique release identifier (e.g., rel-2026.10.0)" })
  releaseId!: string;

  @Text({ prompt: "Semantic version for the release" })
  version!: string;

  @Integer({ prompt: "Release attempt number (1 for initial attempt, 2+ for recovery attempt)", min: 1 })
  attemptNumber!: number;

  @Text({ prompt: "Comma-separated list of independent modules in the release" })
  modules!: string;

  @Text({ prompt: "Compiler and ABI flags for building the release modules" })
  buildFlags!: string;

  @Flag({ prompt: "Whether the post-staging integration smoke gate should fail" })
  simulateIntegrationFailure!: boolean;

  @Text({ prompt: "Module name whose initial worker should stall mid-execution (empty string for none)" })
  stallTargetModule!: string;
}
