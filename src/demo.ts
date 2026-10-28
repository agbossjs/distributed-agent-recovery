import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isLiveDemoRequested } from "../scenarios/offline-openrouter-fetch.js";
import { runReleaseRecoveryPipeline } from "../scenarios/release-recovery-pipeline.js";
import { ReleaseInvariantVerifierService } from "./services/release-invariant-verifier.service.js";

const verifyOnly = process.argv.includes("--verify-only");
const spawnClusterWorkers = process.argv.includes("--cluster");
const realClock =
  process.argv.includes("--real-clock") || process.env["AGBOSS_REAL_CLOCK"] === "true";
const externalWorkers = process.env["AGBOSS_EXTERNAL_WORKERS"] === "true";
const isLive = isLiveDemoRequested();
const releaseId = process.env["RELEASE_ID"] ?? "rel-2026.10.0";

const defaultDataDir = resolve(process.cwd(), ".data/demo");
const sqlitePath =
  process.env["SQLITE_PATH"] ?? resolve(defaultDataDir, "cluster-state.sqlite");
const artifactDir =
  process.env["ARTIFACT_DIR"] ?? resolve(defaultDataDir, "artifacts");

if (verifyOnly) {
  const report = await ReleaseInvariantVerifierService.verifyFromFile({
    sqlitePath,
    artifactDir,
    releaseId,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.allVerified) {
    process.exitCode = 1;
  }
} else {
  if (!externalWorkers) {
    rmSync(sqlitePath, { force: true });
    rmSync(`${sqlitePath}-wal`, { force: true });
    rmSync(`${sqlitePath}-shm`, { force: true });
    rmSync(artifactDir, { recursive: true, force: true });
  }
  mkdirSync(dirname(sqlitePath), { recursive: true });
  mkdirSync(artifactDir, { recursive: true });

  const pipelineReport = await runReleaseRecoveryPipeline({
    sqlitePath,
    artifactDir,
    keepStorageOnExit: true,
    liveModel: isLive,
    externalWorkers,
    spawnClusterWorkers,
    realClock,
    releaseId,
    version: "2.4.0",
  });

  const invariants = await ReleaseInvariantVerifierService.verifyFromFile({
    sqlitePath,
    artifactDir,
    releaseId,
  });

  if (!invariants.allVerified) {
    throw new Error(
      `Release recovery invariants failed verification:\n${JSON.stringify(invariants, null, 2)}`,
    );
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        showcase: "agbossjs/distributed-agent-recovery",
        title: "Ghost in the Machine: The Zombie AI Worker",
        tagline: "The worker didn't survive. The workflow did.",
        mode: pipelineReport.mode,
        clockMode: pipelineReport.clockMode,
        faultMode: pipelineReport.faultMode,
        workerTopology: pipelineReport.workerTopology,
        ...(pipelineReport.workerPids.length > 0
          ? { workerPids: pipelineReport.workerPids }
          : {}),
        health: pipelineReport.health,
        attempt1: pipelineReport.attempt1,
        attempt2: pipelineReport.attempt2,
        invariants,
        ledgerTimeline: pipelineReport.ledger.events.map((e) => ({
          eventId: e.eventId,
          attempt: e.attemptNumber,
          task: e.logicalTaskId,
          operation: e.operation,
          outcome: e.outcome,
          instanceId: e.instanceId,
          leaseEpoch: e.leaseEpoch,
          executionId: e.executionId,
          idempotencyKey: e.idempotencyKey,
        })),
      },
      null,
      2,
    )}\n`,
  );
}
