import type { Secret } from "@agboss/core";

process.env.PII_PSEUDONYM_KEY ??= "distributed-agent-recovery-pseudonym-key-32b!";
process.env.OPENROUTER_API_KEY ??=
  process.env.OPEN_ROUTER_KEY ?? "offline-test-openrouter-api-key";

export class AppEnvironment {
  sqlitePath!: string;
  artifactDir!: string;
  nodeRole!: string;
  crashWorkerOnStall!: boolean;
  skipStaleWriteAttempt!: boolean;
  osFreeze!: boolean;
  piiPseudonymKey?: Secret;
  openRouterApiKey!: Secret;
}
