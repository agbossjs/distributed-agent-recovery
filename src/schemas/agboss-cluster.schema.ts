import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const executionLeasesTable = sqliteTable(
  "execution_leases",
  {
    tenantId: text("tenant_id").notNull(),
    rootExecutionId: text("root_execution_id").notNull(),
    holderInstanceId: text("holder_instance_id").notNull(),
    leaseEpoch: integer("lease_epoch").notNull(),
    expiresAt: integer("expires_at").notNull(),
    released: integer("released").notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.rootExecutionId] })],
);

export const childExecutionQueueTable = sqliteTable(
  "child_execution_queue",
  {
    tenantId: text("tenant_id").notNull(),
    executionId: text("execution_id").notNull(),
    rootExecutionId: text("root_execution_id").notNull(),
    parentExecutionId: text("parent_execution_id").notNull(),
    rootWorkflow: text("root_workflow").notNull(),
    workflow: text("workflow").notNull(),
    depth: integer("depth").notNull(),
    status: text("status").notNull(),
    run: text("run").notNull(),
    queuedAt: integer("queued_at").notNull(),
    instanceId: text("instance_id"),
    claimedAt: integer("claimed_at"),
    endedAt: integer("ended_at"),
    failure: text("failure"),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.executionId] })],
);

export const sqliteMasterTable = sqliteTable("sqlite_master", {
  type: text("type").notNull(),
  name: text("name").notNull(),
});

export type ExecutionLeaseRow = typeof executionLeasesTable.$inferSelect;
export type ChildExecutionQueueRow = typeof childExecutionQueueTable.$inferSelect;
