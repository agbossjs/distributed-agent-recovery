import { Flag, Integer, Text } from "@agboss/core/dto";

export class ModuleTaskDto {
  @Text({ prompt: "Stable logical task identifier across retries and worker takeovers (e.g., task-001)" })
  logicalTaskId!: string;

  @Text({ prompt: "Release identifier" })
  releaseId!: string;

  @Text({ prompt: "Release semantic version" })
  version!: string;

  @Integer({ prompt: "Attempt number for this module task", min: 1 })
  attemptNumber!: number;

  @Text({ prompt: "Independent module name (e.g., auth-service, payment-engine)" })
  moduleName!: string;

  @Text({ prompt: "Build and ABI flags for this module" })
  buildFlags!: string;

  @Flag({ prompt: "Whether the initial worker holding lease epoch 1 should stall during staging" })
  simulateWorkerStall!: boolean;
}
