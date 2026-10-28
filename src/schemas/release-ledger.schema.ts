import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { ExecutionLeaseRow } from "./agboss-cluster.schema.js";

export type ArtifactStatus = "STAGED" | "COMPENSATED" | "PROMOTED";
export type CandidateLockStatus = "LOCKED" | "COMPENSATED" | "PROMOTED";
export type StallStatus = "STALLED" | "FENCED";

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
  readonly events: readonly LedgerEventRow[];
  readonly executionLeases: readonly ExecutionLeaseRow[];
}
