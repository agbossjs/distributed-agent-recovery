import {
  Action,
  type ActionHandler,
  ExecutionContext,
  type InputOf,
  type OutputOf,
} from "@agboss/core";
import { ModuleFailedDto } from "../dto/module-failed.dto.js";
import { ModuleTaskDto } from "../dto/module-task.dto.js";

@Action({
  name: "mark-module-failed-action",
  description:
    "Formats a terminal module failure record if a child module workflow encounters an unrecoverable error.",
  input: {
    moduleTask: ModuleTaskDto,
  },
  output: ModuleFailedDto,
  deps: [ExecutionContext],
})
export class MarkModuleFailedAction
  implements ActionHandler<MarkModuleFailedAction>
{
  constructor(private readonly executionContext: ExecutionContext) {}

  execute(
    input: InputOf<MarkModuleFailedAction>,
  ): Promise<OutputOf<MarkModuleFailedAction>> {
    const task = input.moduleTask.value;
    return Promise.resolve({
      logicalTaskId: task.logicalTaskId,
      releaseId: task.releaseId,
      attemptNumber: task.attemptNumber,
      moduleName: task.moduleName,
      executionId: this.executionContext.executionId,
      reason: `Unrecoverable error staging module ${task.moduleName}`,
    });
  }
}
