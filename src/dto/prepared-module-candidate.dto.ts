import { Bool, Integer, Text } from "@agboss/core/dto";

export class PreparedModuleCandidateDto {
  @Text({ prompt: "Stable logical task identifier" })
  logicalTaskId!: string;

  @Text({ prompt: "Release identifier" })
  releaseId!: string;

  @Text({ prompt: "Release semantic version" })
  version!: string;

  @Integer({ prompt: "Attempt number", min: 1 })
  attemptNumber!: number;

  @Text({ prompt: "Module name" })
  moduleName!: string;

  @Text({ prompt: "Build and ABI flags" })
  buildFlags!: string;

  @Text({ prompt: "Worker instance ID that executed the preparation checkpoint" })
  preparedByInstanceId!: string;

  @Text({ prompt: "Deterministic digest of the prepared module candidate" })
  candidateDigest!: string;

  @Bool({ prompt: "Whether the first worker to stage this module should stall before its write (the zombie drill)" })
  simulateWorkerStall!: boolean;
}
