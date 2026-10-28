import {
  Action,
  type ActionHandler,
  ExecutionContext,
  type InputOf,
  type OutputOf,
} from "@agboss/core";
import { ModuleTaskDto } from "../dto/module-task.dto.js";
import { PreparedModuleCandidateDto } from "../dto/prepared-module-candidate.dto.js";
import { ReleaseLedgerService } from "../services/release-ledger.service.js";

@Action({
  name: "prepare-module-candidate-action",
  description:
    "Compiles and prepares a module candidate under the worker's execution lease before checkpointing.",
  input: {
    moduleTask: ModuleTaskDto,
  },
  output: PreparedModuleCandidateDto,
  deps: [ReleaseLedgerService, ExecutionContext],
})
export class PrepareModuleCandidateAction
  implements ActionHandler<PrepareModuleCandidateAction>
{
  constructor(
    private readonly ledger: ReleaseLedgerService,
    private readonly executionContext: ExecutionContext,
  ) {}

  async execute(
    input: InputOf<PrepareModuleCandidateAction>,
  ): Promise<OutputOf<PrepareModuleCandidateAction>> {
    const task = input.moduleTask.value;
    const prepared = await this.ledger.recordModulePreparation({
      releaseId: task.releaseId,
      version: task.version,
      attemptNumber: task.attemptNumber,
      logicalTaskId: task.logicalTaskId,
      moduleName: task.moduleName,
      buildFlags: task.buildFlags,
      executionId: this.executionContext.executionId,
      idempotencyKey: this.executionContext.step.idempotencyKey,
    });

    return {
      logicalTaskId: task.logicalTaskId,
      releaseId: task.releaseId,
      version: task.version,
      attemptNumber: task.attemptNumber,
      moduleName: task.moduleName,
      buildFlags: task.buildFlags,
      preparedByInstanceId: prepared.preparedByInstanceId,
      preparedUnderLeaseEpoch: prepared.preparedUnderLeaseEpoch,
      candidateDigest: prepared.candidateDigest,
      simulateWorkerStall: task.simulateWorkerStall,
    };
  }
}
