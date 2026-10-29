import { AGBossError } from "@agboss/core";
import type { StaleWriteRejectionReason } from "../schemas/release-ledger.schema.js";

export interface StaleLeaseFenceDetails {
  readonly attemptedOperation: "STAGE_ARTIFACT";
  readonly targetArtifactId: string;
  readonly logicalTaskId: string;
  readonly executionId: string;
  readonly staleInstanceId: string;
  readonly staleLeaseEpoch: number;
  readonly activeHolderInstanceId: string;
  readonly activeLeaseEpoch: number;
  readonly rejectionReason: StaleWriteRejectionReason;
  readonly capturedCheckpointId: string | null;
  readonly observedHeadCheckpointId: string | null;
}

export class StaleLeaseFenceError extends AGBossError {
  static override readonly code = "release.stale_lease_fenced";
  readonly fenceDetails: StaleLeaseFenceDetails;

  constructor(fenceDetails: StaleLeaseFenceDetails) {
    super(
      `Stale lease fenced for ${fenceDetails.logicalTaskId} (${fenceDetails.attemptedOperation} -> ${fenceDetails.targetArtifactId}, reason=${fenceDetails.rejectionReason}): instance ${fenceDetails.staleInstanceId} (epoch ${String(fenceDetails.staleLeaseEpoch)}) vs active holder ${fenceDetails.activeHolderInstanceId} (epoch ${String(fenceDetails.activeLeaseEpoch)})`,
      { details: { ...fenceDetails } },
    );
    this.name = "StaleLeaseFenceError";
    this.fenceDetails = fenceDetails;
  }
}
