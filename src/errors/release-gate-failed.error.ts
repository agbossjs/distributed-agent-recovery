import { AGBossError } from "@agboss/core";

export class ReleaseGateFailedError extends AGBossError {
  static override readonly code = "release.gate_failed";

  constructor(
    readonly releaseId: string,
    readonly attemptNumber: number,
    readonly diagnostic: string,
  ) {
    super(diagnostic, {
      details: { releaseId, attemptNumber },
    });
    this.name = "ReleaseGateFailedError";
  }
}
