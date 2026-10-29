import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type {
  AgbossCheckpointRow,
  ChildExecutionQueueRow,
  ExecutionLeaseRow,
} from "./agboss-cluster.schema.js";

export type ArtifactStatus = "STAGED" | "COMPENSATED" | "PROMOTED";
export type CandidateLockStatus = "LOCKED" | "COMPENSATED" | "PROMOTED";
export type NonAttemptStallDisposition =
  | "TERMINATED_BEFORE_WRITE"
  | "SUSPENDED_BEFORE_WRITE";
export type StallDisposition =
  | "RESUME_AND_ATTEMPT_WRITE"
  | NonAttemptStallDisposition;
export type StallStatus = "STALLED" | "FENCED" | NonAttemptStallDisposition;
export type StaleWriteRejectionReason =
  | "STALE_LEASE_EPOCH"
  | "LEASE_HOLDER_MISMATCH";

export interface FencingTokenSnapshot {
  readonly holderInstanceId: string;
  readonly leaseEpoch: number;
}

export interface ProtectedWriteRejectionEvidence {
  readonly attemptedOperation: "STAGE_ARTIFACT";
  readonly targetArtifactId: string;
  readonly targetStagingArtifactPath: string;
  readonly candidateDigest: string;
  readonly workerInstanceId: string;
  readonly executionId: string;
  readonly releaseId: string;
  readonly attemptNumber: number;
  readonly logicalTaskId: string;
  readonly moduleName: string;
  readonly idempotencyKey: string;
  readonly capturedToken: FencingTokenSnapshot;
  readonly observedToken: FencingTokenSnapshot;
  readonly rejectionReason: StaleWriteRejectionReason;
  readonly errorCode: string;
  readonly capturedCheckpointId: string | null;
  readonly observedHeadCheckpointId: string | null;
  readonly checkpointThreadId: string | null;
  readonly activeHolderInstanceId: string;
  readonly activeLeaseEpoch: number;
}

export const releaseArtifactsTable = sqliteTable("release_artifacts", {
  artifactId: text("artifact_id").primaryKey(),
  releaseId: text("release_id").notNull(),
  version: text("version").notNull(),
  attemptNumber: integer("attempt_number").notNull(),
  logicalTaskId: text("logical_task_id").notNull(),
  moduleName: text("module_name").notNull(),
  executionId: text("execution_id").notNull(),
  preparedByInstanceId: text("prepared_by_instance_id").notNull(),
  committedByInstanceId: text("committed_by_instance_id").notNull(),
  leaseEpoch: integer("lease_epoch").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  status: text("status").$type<ArtifactStatus>().notNull(),
  artifactPath: text("artifact_path").notNull(),
  candidateDigest: text("candidate_digest").notNull(),
  compensatedByKey: text("compensated_by_key"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const releaseCandidateLocksTable = sqliteTable("release_candidate_locks", {
  candidateLockId: text("candidate_lock_id").primaryKey(),
  releaseId: text("release_id").notNull(),
  version: text("version").notNull(),
  attemptNumber: integer("attempt_number").notNull(),
  status: text("status").$type<CandidateLockStatus>().notNull(),
  stagedModuleCount: integer("staged_module_count").notNull(),
  participatingInstances: text("participating_instances").notNull(),
  buildFlags: text("build_flags").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  compensatedByKey: text("compensated_by_key"),
  failureDiagnostic: text("failure_diagnostic"),
  manifestPath: text("manifest_path"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const fencingTokensTable = sqliteTable(
  "fencing_tokens",
  {
    tenantId: text("tenant_id").notNull(),
    executionId: text("execution_id").notNull(),
    logicalTaskId: text("logical_task_id").notNull(),
    releaseId: text("release_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    highestLeaseEpoch: integer("highest_lease_epoch").notNull(),
    currentHolderInstanceId: text("current_holder_instance_id").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.executionId] })],
);

export const faultInjectionStallsTable = sqliteTable(
  "fault_injection_stalls",
  {
    executionId: text("execution_id").notNull(),
    logicalTaskId: text("logical_task_id").notNull(),
    releaseId: text("release_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    stalledInstanceId: text("stalled_instance_id").notNull(),
    stalledLeaseEpoch: integer("stalled_lease_epoch").notNull(),
    status: text("status").$type<StallStatus>().notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.executionId, table.stalledInstanceId, table.stalledLeaseEpoch],
    }),
  ],
);

export const ledgerEventsTable = sqliteTable("ledger_events", {
  eventId: integer("event_id").primaryKey({ autoIncrement: true }),
  releaseId: text("release_id").notNull(),
  attemptNumber: integer("attempt_number").notNull(),
  logicalTaskId: text("logical_task_id").notNull(),
  moduleName: text("module_name").notNull(),
  executionId: text("execution_id").notNull(),
  instanceId: text("instance_id").notNull(),
  leaseEpoch: integer("lease_epoch").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  operation: text("operation").notNull(),
  outcome: text("outcome").notNull(),
  details: text("details").notNull(),
  recordedAt: integer("recorded_at").notNull(),
});

export type LedgerArtifactRow = typeof releaseArtifactsTable.$inferSelect;
export type NewLedgerArtifactRow = typeof releaseArtifactsTable.$inferInsert;
export type LedgerCandidateLockRow = typeof releaseCandidateLocksTable.$inferSelect;
export type NewLedgerCandidateLockRow = typeof releaseCandidateLocksTable.$inferInsert;
export type FencingTokenRow = typeof fencingTokensTable.$inferSelect;
export type FaultInjectionStallRow = typeof faultInjectionStallsTable.$inferSelect;
export type LedgerEventRow = typeof ledgerEventsTable.$inferSelect;
export type NewLedgerEventRow = typeof ledgerEventsTable.$inferInsert;

export interface LedgerSnapshot {
  readonly sqlitePath: string;
  readonly artifactDir: string;
  readonly artifacts: readonly LedgerArtifactRow[];
  readonly candidateLocks: readonly LedgerCandidateLockRow[];
  readonly fencingTokens: readonly FencingTokenRow[];
  readonly stalls?: readonly FaultInjectionStallRow[];
  readonly events: readonly LedgerEventRow[];
  readonly executionLeases: readonly ExecutionLeaseRow[];
  readonly childQueue: readonly ChildExecutionQueueRow[];
  readonly checkpoints: readonly AgbossCheckpointRow[];
}

export type ProtectedWriteOutcome =
  | "STALE_WRITE_REJECTED"
  | "STALE_WRITE_NOT_ATTEMPTED"
  | "VALID_OWNER_ACCEPTED"
  | "MISSING_OR_INCONSISTENT_EVIDENCE";

export interface TaskProtectedWriteVerification {
  readonly logicalTaskId: string;
  readonly moduleName: string;
  readonly executionId: string | null;
  readonly artifactId: string | null;
  readonly preparedByInstanceId: string | null;
  readonly committedByInstanceId: string | null;
  readonly committedLeaseEpoch: number | null;
  readonly checkpointCount: number;
  readonly linearCheckpointChain: boolean;
  readonly agbossExecutionLeaseEpoch: number | null;
  readonly agbossExecutionLeaseHolder: string | null;
  readonly agbossExecutionLeaseReleased: number | null;
  readonly orphanedChildQueueRows: number;
  readonly outcome: ProtectedWriteOutcome;
  readonly fencingRejectionDemonstrated: boolean;
  readonly protectedArtifactVerifiedOnDisk: boolean;
  readonly nonAttemptDisposition: NonAttemptStallDisposition | null;
  readonly rejectionEvidence: ProtectedWriteRejectionEvidence | null;
  readonly issues: readonly string[];
}

export interface ProtectedWriteVerificationSummary {
  readonly releaseId: string;
  readonly attemptNumber: number;
  readonly outcome: ProtectedWriteOutcome;
  readonly fencingRejectionDemonstrated: boolean;
  readonly rejectedStaleWriteCount: number;
  readonly unattemptedStaleWorkerCount: number;
  readonly validOwnerAcceptedCount: number;
  readonly inconsistentTaskCount: number;
  readonly tasks: readonly TaskProtectedWriteVerification[];
}
