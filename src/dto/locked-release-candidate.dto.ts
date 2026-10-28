import { Integer, Text } from "@agboss/core/dto";

export class LockedReleaseCandidateDto {
  @Text({ prompt: "Candidate bundle lock identifier" })
  candidateLockId!: string;

  @Text({ prompt: "Release identifier" })
  releaseId!: string;

  @Text({ prompt: "Release semantic version" })
  version!: string;

  @Integer({ prompt: "Attempt number", min: 1 })
  attemptNumber!: number;

  @Integer({ prompt: "Count of staged modules in this candidate bundle", min: 0 })
  stagedModuleCount!: number;

  @Text({ prompt: "Comma-separated list of distinct worker instance IDs that staged modules" })
  participatingInstances!: string;

  @Text({ prompt: "Build flags used for this candidate bundle" })
  buildFlags!: string;

  @Text({ prompt: "Idempotency key of the candidate lock operation" })
  idempotencyKey!: string;
}
