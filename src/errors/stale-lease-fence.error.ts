import { AGBossError } from "@agboss/core";

export interface StaleLeaseFenceDetails {
  readonly logicalTaskId: string;
  readonly executionId: string;
  readonly staleInstanceId: string;
  readonly staleLeaseEpoch: number;
  readonly activeHolderInstanceId: string;
  readonly activeLeaseEpoch: number;
}

export class StaleLeaseFenceError extends AGBossError {
  static override readonly code = "release.stale_lease_fenced";
  readonly fenceDetails: StaleLeaseFenceDetails;

  constructor(fenceDetails: StaleLeaseFenceDetails) {
    super(
      `Stale lease fenced for ${fenceDetails.logicalTaskId}: instance ${fenceDetails.staleInstanceId} (epoch ${String(fenceDetails.staleLeaseEpoch)}) < active holder ${fenceDetails.activeHolderInstanceId} (epoch ${String(fenceDetails.activeLeaseEpoch)})`,
      { details: { ...fenceDetails } },
    );
    this.name = "StaleLeaseFenceError";
    this.fenceDetails = fenceDetails;
  }
}
