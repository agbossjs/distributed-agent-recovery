import { Flag, Integer, Text } from "@agboss/core/dto";

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

  @Integer({ prompt: "Lease epoch under which preparation ran", min: 1 })
  preparedUnderLeaseEpoch!: number;

  @Text({ prompt: "Deterministic digest of the prepared module candidate" })
  candidateDigest!: string;

  @Flag({ prompt: "Whether the initial worker should stall before staging commit" })
  simulateWorkerStall!: boolean;
}
