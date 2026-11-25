import { Bool, Integer, Text } from "@agboss/core/dto";

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

  @Bool({ prompt: "Whether the first worker to stage this module should stall before its write (the zombie drill)" })
  simulateWorkerStall!: boolean;
}
