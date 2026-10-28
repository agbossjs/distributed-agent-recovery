import { Integer, Text } from "@agboss/core/dto";

export class ReleaseSummaryDto {
  @Text({ prompt: "Release identifier" })
  releaseId!: string;

  @Text({ prompt: "Release semantic version" })
  version!: string;

  @Integer({ prompt: "Completed attempt number", min: 1 })
  attemptNumber!: number;

  @Text({ prompt: "Final release status (PROMOTED)" })
  status!: string;

  @Integer({ prompt: "Number of promoted module artifacts", min: 1 })
  promotedModuleCount!: number;

  @Text({ prompt: "Distinct worker instance IDs that participated in building and staging" })
  participatingInstances!: string;

  @Text({ prompt: "Filesystem path to the final release manifest" })
  manifestPath!: string;
}
