import { Integer, Text } from "@agboss/core/dto";

export class StagedModuleArtifactDto {
  @Text({ prompt: "Release identifier" })
  releaseId!: string;

  @Text({ prompt: "Release semantic version" })
  version!: string;

  @Integer({ prompt: "Attempt number", min: 1 })
  attemptNumber!: number;

  @Text({ prompt: "Stable logical task identifier" })
  logicalTaskId!: string;

  @Text({ prompt: "Module name" })
  moduleName!: string;

  @Text({ prompt: "Unique artifact identifier in the shared ledger" })
  artifactId!: string;

  @Text({ prompt: "Filesystem path to the staged artifact file" })
  artifactPath!: string;

  @Text({ prompt: "Worker instance ID that prepared step 1" })
  preparedByInstanceId!: string;

  @Text({ prompt: "Worker instance ID that committed the staged artifact" })
  committedByInstanceId!: string;

  @Integer({ prompt: "Lease epoch under which the artifact was committed", min: 1 })
  leaseEpoch!: number;

  @Text({ prompt: "Child workflow execution ID" })
  executionId!: string;

  @Text({ prompt: "Step idempotency key used for external deduplication" })
  idempotencyKey!: string;

  @Text({ prompt: "Artifact status in the external ledger (STAGED)" })
  status!: string;
}
