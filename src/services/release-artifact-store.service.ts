import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Injectable, type InferEnv } from "@agboss/core";
import { appEnv } from "../environments/app.environment.js";
import type { LedgerArtifactRow } from "../schemas/release-ledger.schema.js";

export interface PromotedModuleEntry {
  readonly moduleName: string;
  readonly logicalTaskId: string;
  readonly artifactId: string;
  readonly preparedByInstanceId: string;
  readonly committedByInstanceId: string;
  readonly idempotencyKey: string;
  readonly moduleManifestPath: string;
}

@Injectable({ deps: [appEnv] })
export class ReleaseArtifactStoreService {
  constructor(private readonly environment: InferEnv<typeof appEnv>) {}

  artifactDir(): string {
    return this.environment.artifactDir;
  }

  /** Where a module's staged artifact of one attempt lives: the same path for every worker that stages it. */
  stagedArtifactPath(params: {
    readonly releaseId: string;
    readonly attemptNumber: number;
    readonly moduleName: string;
  }): string {
    return join(
      this.artifactDir(),
      "staging",
      params.releaseId,
      `attempt-${String(params.attemptNumber)}`,
      `${params.moduleName}.artifact.json`,
    );
  }

  /** Writes the staged artifact file at its path; writing it again (a replayed step) rewrites the same content. */
  writeStagedArtifact(params: {
    readonly artifactId: string;
    readonly releaseId: string;
    readonly version: string;
    readonly attemptNumber: number;
    readonly logicalTaskId: string;
    readonly moduleName: string;
    readonly executionId: string;
    readonly preparedByInstanceId: string;
    readonly committedByInstanceId: string;
    readonly fencingToken: number;
    readonly idempotencyKey: string;
    readonly candidateDigest: string;
    readonly stagedAtMs: number;
  }): string {
    const artifactPath = this.stagedArtifactPath(params);
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(
      artifactPath,
      JSON.stringify({ ...params, stagedAt: new Date(params.stagedAtMs).toISOString() }, null, 2),
      "utf8",
    );
    return artifactPath;
  }

  moduleManifestPath(releaseId: string, moduleName: string): string {
    return join(this.artifactDir(), "releases", releaseId, `${moduleName}.manifest.json`);
  }

  releaseManifestPath(releaseId: string): string {
    return join(this.artifactDir(), "releases", releaseId, "release-manifest.json");
  }

  removeArtifactFile(artifactPath: string): void {
    if (existsSync(artifactPath)) {
      rmSync(artifactPath, { force: true });
    }
  }

  writePromotedManifests(params: {
    readonly releaseId: string;
    readonly version: string;
    readonly attemptNumber: number;
    readonly promotedByInstanceId: string;
    readonly artifacts: readonly LedgerArtifactRow[];
    readonly promotedAtMs: number;
  }): {
    readonly manifestPath: string;
    readonly promotedModules: readonly PromotedModuleEntry[];
  } {
    const releaseDir = join(this.artifactDir(), "releases", params.releaseId);
    mkdirSync(releaseDir, { recursive: true });
    const promotedAt = new Date(params.promotedAtMs).toISOString();

    const promotedModules: PromotedModuleEntry[] = params.artifacts.map((art) => {
      const moduleManifestPath = this.moduleManifestPath(params.releaseId, art.moduleName);
      writeFileSync(
        moduleManifestPath,
        JSON.stringify(
          {
            artifactId: art.artifactId,
            releaseId: art.releaseId,
            version: art.version,
            attemptNumber: art.attemptNumber,
            logicalTaskId: art.logicalTaskId,
            moduleName: art.moduleName,
            executionId: art.executionId,
            preparedByInstanceId: art.preparedByInstanceId,
            committedByInstanceId: art.committedByInstanceId,
                idempotencyKey: art.idempotencyKey,
            candidateDigest: art.candidateDigest,
            status: "PROMOTED",
            promotedAt,
          },
          null,
          2,
        ),
        "utf8",
      );
      return {
        moduleName: art.moduleName,
        logicalTaskId: art.logicalTaskId,
        artifactId: art.artifactId,
        preparedByInstanceId: art.preparedByInstanceId,
        committedByInstanceId: art.committedByInstanceId,
        idempotencyKey: art.idempotencyKey,
        moduleManifestPath,
      };
    });

    const participatingInstances = [
      ...new Set(
        params.artifacts.flatMap((r) => [r.preparedByInstanceId, r.committedByInstanceId]),
      ),
    ].sort();
    const manifestPath = this.releaseManifestPath(params.releaseId);
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          releaseId: params.releaseId,
          version: params.version,
          attemptNumber: params.attemptNumber,
          status: "PROMOTED",
          promotedByInstanceId: params.promotedByInstanceId,
          participatingInstances,
          modules: promotedModules,
          promotedAt,
        },
        null,
        2,
      ),
      "utf8",
    );
    return { manifestPath, promotedModules };
  }
}
