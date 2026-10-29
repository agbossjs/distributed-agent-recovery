import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ApplicationContext, Injectable } from "@agboss/core";
import type { LedgerArtifactRow } from "../schemas/release-ledger.schema.js";

export interface PromotedModuleEntry {
  readonly moduleName: string;
  readonly logicalTaskId: string;
  readonly artifactId: string;
  readonly preparedByInstanceId: string;
  readonly committedByInstanceId: string;
  readonly leaseEpoch: number;
  readonly idempotencyKey: string;
  readonly moduleManifestPath: string;
}

@Injectable({ deps: [ApplicationContext] })
export class ReleaseArtifactStoreService {
  constructor(private readonly applicationContext: ApplicationContext) {}

  artifactDir(): string {
    const env = this.applicationContext.environment as { readonly artifactDir?: string };
    return env.artifactDir ?? join(process.cwd(), ".data/dev/artifacts");
  }

  resolveStagedArtifactPath(params: {
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
    readonly leaseEpoch: number;
    readonly idempotencyKey: string;
    readonly candidateDigest: string;
    readonly stagedAtMs: number;
  }): string {
    const artifactPath = this.resolveStagedArtifactPath(params);
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(
      artifactPath,
      JSON.stringify({ ...params, stagedAt: new Date(params.stagedAtMs).toISOString() }, null, 2),
      "utf8",
    );
    return artifactPath;
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
      const moduleManifestPath = join(releaseDir, `${art.moduleName}.manifest.json`);
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
            leaseEpoch: art.leaseEpoch,
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
        leaseEpoch: art.leaseEpoch,
        idempotencyKey: art.idempotencyKey,
        moduleManifestPath,
      };
    });

    const participatingInstances = [
      ...new Set(
        params.artifacts.flatMap((r) => [r.preparedByInstanceId, r.committedByInstanceId]),
      ),
    ].sort();
    const manifestPath = join(releaseDir, "release-manifest.json");
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
