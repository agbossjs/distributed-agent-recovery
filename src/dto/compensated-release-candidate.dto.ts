import { Integer, Text } from "@agboss/core/dto";

export class CompensatedReleaseCandidateDto {
  @Text({ prompt: "Candidate bundle lock identifier that was rolled back" })
  candidateLockId!: string;

  @Text({ prompt: "Release identifier" })
  releaseId!: string;

  @Text({ prompt: "Release semantic version" })
  version!: string;

  @Integer({ prompt: "Failed attempt number that was compensated", min: 1 })
  failedAttemptNumber!: number;

  @Integer({ prompt: "Number of staged module artifacts compensated and removed", min: 0 })
  compensatedModuleCount!: number;

  @Text({ prompt: "Integration failure diagnostic that triggered saga compensation" })
  failureDiagnostic!: string;

  @Text({ prompt: "Idempotency key of the saga compensation step" })
  compensationIdempotencyKey!: string;
}
