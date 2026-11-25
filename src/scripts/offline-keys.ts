/**
 * Synthetic keys for the offline demos, scenarios and tests only: the application reads them through
 * `secret(…)` and fails closed at start when one is not set. Never import this from `src/` outside
 * `scripts/`.
 */
process.env["OPENROUTER_API_KEY"] ??= process.env["OPEN_ROUTER_KEY"] ?? "offline-test-openrouter-api-key";
process.env["IDEMPOTENCY_KEY"] ??= "distributed-agent-recovery-offline-idempotency-key";
