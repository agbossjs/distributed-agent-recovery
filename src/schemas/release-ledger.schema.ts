import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export type ArtifactStatus = "STAGED" | "COMPENSATED" | "PROMOTED";
export type CandidateLockStatus = "LOCKED" | "COMPENSATED" | "PROMOTED";

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

export const modulePreparationsTable = sqliteTable("module_preparations", {
  executionId: text("execution_id").primaryKey(),
  releaseId: text("release_id").notNull(),
  attemptNumber: integer("attempt_number").notNull(),
  logicalTaskId: text("logical_task_id").notNull(),
  moduleName: text("module_name").notNull(),
  preparedByInstanceId: text("prepared_by_instance_id").notNull(),
  candidateDigest: text("candidate_digest").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const workerStallsTable = sqliteTable("worker_stalls", {
  executionId: text("execution_id").primaryKey(),
  logicalTaskId: text("logical_task_id").notNull(),
  releaseId: text("release_id").notNull(),
  attemptNumber: integer("attempt_number").notNull(),
  stalledInstanceId: text("stalled_instance_id").notNull(),
  stalledPid: integer("stalled_pid").notNull(),
  mode: text("mode").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const ledgerEventsTable = sqliteTable("ledger_events", {
  eventId: integer("event_id").primaryKey({ autoIncrement: true }),
  releaseId: text("release_id"),
  attemptNumber: integer("attempt_number"),
  executionId: text("execution_id").notNull(),
  instanceId: text("instance_id").notNull(),
  fencingToken: integer("fencing_token"),
  operation: text("operation").notNull(),
  outcome: text("outcome").notNull(),
  details: text("details").notNull(),
  recordedAt: integer("recorded_at").notNull(),
});

export type LedgerArtifactRow = typeof releaseArtifactsTable.$inferSelect;
export type NewLedgerArtifactRow = typeof releaseArtifactsTable.$inferInsert;
export type LedgerCandidateLockRow = typeof releaseCandidateLocksTable.$inferSelect;
export type NewLedgerCandidateLockRow = typeof releaseCandidateLocksTable.$inferInsert;
export type ModulePreparationRow = typeof modulePreparationsTable.$inferSelect;
export type WorkerStallRow = typeof workerStallsTable.$inferSelect;
export type LedgerEventRow = typeof ledgerEventsTable.$inferSelect;
export type NewLedgerEventRow = typeof ledgerEventsTable.$inferInsert;

/** Everything the verifier reads, from one SQLite file. */
export interface LedgerSnapshot {
  readonly sqlitePath: string;
  readonly artifactDir: string;
  readonly artifacts: readonly LedgerArtifactRow[];
  readonly candidateLocks: readonly LedgerCandidateLockRow[];
  readonly preparations: readonly ModulePreparationRow[];
  readonly stalls: readonly WorkerStallRow[];
  readonly events: readonly LedgerEventRow[];
}
