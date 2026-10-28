import { Integer, Text } from "@agboss/core/dto";

export class FailedAttemptQueryDto {
  @Text({ prompt: "Release identifier to inspect in the shared ledger" })
  releaseId!: string;

  @Integer({ prompt: "Failed attempt number to inspect", min: 1 })
  failedAttemptNumber!: number;
}
