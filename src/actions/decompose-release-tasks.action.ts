import {
  Action,
  type ActionHandler,
  type InputOf,
  type OutputOf,
  listOf,
} from "@agboss/core";
import { ModuleTaskDto } from "../dto/module-task.dto.js";
import { ReleaseRequestDto } from "../dto/release-request.dto.js";

@Action({
  name: "decompose-release-tasks-action",
  description:
    "Decomposes a software release request into independent module tasks for concurrent distributed execution.",
  input: {
    releaseRequest: ReleaseRequestDto,
  },
  output: listOf(ModuleTaskDto),
})
export class DecomposeReleaseTasksAction
  implements ActionHandler<DecomposeReleaseTasksAction>
{
  execute(
    input: InputOf<DecomposeReleaseTasksAction>,
  ): Promise<OutputOf<DecomposeReleaseTasksAction>> {
    const req = input.releaseRequest.value;
    const moduleNames = req.modules
      .split(",")
      .map((m) => m.trim())
      .filter((m) => m.length > 0);

    const tasks: ModuleTaskDto[] = moduleNames.map((moduleName) => {
      const logicalTaskId = moduleName.startsWith("task-")
        ? moduleName
        : `${req.releaseId}:${moduleName}`;

      return {
        logicalTaskId,
        releaseId: req.releaseId,
        version: req.version,
        attemptNumber: req.attemptNumber,
        moduleName,
        buildFlags: req.buildFlags,
        simulateWorkerStall: req.stallTargetModule === moduleName,
      };
    });

    return Promise.resolve(tasks);
  }
}
