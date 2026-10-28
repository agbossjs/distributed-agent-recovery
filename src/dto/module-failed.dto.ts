import { Integer, Text } from "@agboss/core/dto";

export class ModuleFailedDto {
  @Text({ prompt: "Logical task identifier that failed" })
  logicalTaskId!: string;

  @Text({ prompt: "Release identifier" })
  releaseId!: string;

  @Integer({ prompt: "Attempt number", min: 1 })
  attemptNumber!: number;

  @Text({ prompt: "Module name that failed" })
  moduleName!: string;

  @Text({ prompt: "Child execution ID" })
  executionId!: string;

  @Text({ prompt: "Failure reason" })
  reason!: string;
}
