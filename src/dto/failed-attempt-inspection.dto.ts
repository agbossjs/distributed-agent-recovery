import { Flag, Integer, Text } from "@agboss/core/dto";

export class FailedAttemptInspectionDto {
  @Text({ prompt: "Release identifier" })
  releaseId!: string;

  @Integer({ prompt: "Inspected attempt number", min: 1 })
  failedAttemptNumber!: number;

  @Integer({ prompt: "Count of compensated artifacts in the ledger for this attempt", min: 0 })
  compensatedArtifactCount!: number;

  @Integer({ prompt: "Count of active uncompensated artifacts remaining for this attempt", min: 0 })
  activeArtifactsRemaining!: number;

  @Flag({ prompt: "True if every staged artifact from the failed attempt has been compensated" })
  allArtifactsCompensated!: boolean;

  @Text({ prompt: "Recorded failure diagnostic and recommended ABI fix flag (--abi-compat=v2)" })
  ledgerDiagnostic!: string;
}
