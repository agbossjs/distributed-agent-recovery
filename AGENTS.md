# Distributed Agent Recovery — instructions for coding agents

This is an [AGBoss](https://agboss.dev) application (`DistributedAgentRecoveryApplication`).

Before writing or changing any AGBoss code, read `.claude/skills/agboss/SKILL.md` — it is the
framework's own guide for the installed `agboss` version and routes each task to one reference:

| Task                                                        | Read                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| Designing a workflow, its DTOs                              | `.claude/skills/agboss/references/01-composition-and-architecture.md`    |
| Writing `*.workflow.ts` paths, `.onError`                   | `.claude/skills/agboss/references/02-flow-dsl-all-combinations.md`       |
| Components, DI, lifecycle hooks, `app.execute`              | `.claude/skills/agboss/references/03-components-di-and-lifecycle.md`     |
| MCP servers and tools, A2A agents                           | `.claude/skills/agboss/references/04-mcp-and-a2a.md`                     |
| Approvals, pauses, channels, `app.resume`                   | `.claude/skills/agboss/references/05-channels-and-human-in-the-loop.md`  |
| Budgets, model providers, retries, rate limits              | `.claude/skills/agboss/references/06-finops-providers-and-queues.md`     |
| Guardrails, PII policies                                    | `.claude/skills/agboss/references/07-guardrails-pii-and-security.md`     |
| Execution records, observers, tracing                       | `.claude/skills/agboss/references/08-observability-and-tracing.md`       |
| Storage, recovery, shutdown, health checks, deploys         | `.claude/skills/agboss/references/09-persistence-k8s-and-deploy.md`      |
| Tests: unit runners, `testWith`, VCR, evals                 | `.claude/skills/agboss/references/10-testing-vcr-and-evals.md`           |
| A `[rule.code]` error, a CLI command                        | `.claude/skills/agboss/references/11-cli-studio-and-error-catalog.md`    |
| A whole feature or application from scratch                 | `.claude/skills/agboss/references/12-end-to-end-recipes.md`              |
| Migrating LangGraph code: state, edges, `Send`, `interrupt` | `.claude/skills/agboss/references/13-migrating-from-langgraph.md`        |

The loop after every change: `npx agboss check` → `npx agboss describe` → `npm test`.

## Project rules
- **Strict directory-by-kind layout (`src/<kind>/<name>.<kind>.<ext>`)**:
  - `src/errors/*.error.ts` — custom `AGBossError` subclasses only.
  - `src/repositories/*.repository.ts` — all classes with direct database access (`SqliteConnection` / Drizzle ORM / `Sqlite*Repository` overrides).
  - `src/schemas/*.schema.ts` — Drizzle ORM table schemas (`sqliteTable`) and inferred row types only.
  - `src/sql/*.sql` — pure `.sql` DDL migration files only (never inline `CREATE TABLE` strings in TypeScript).
  - `src/services/*.service.ts` — stateless `@Injectable` domain, filesystem, and verification services only (never errors, schemas, repositories, or direct SQL).
- **Typed ORM queries only**: All database queries use Drizzle ORM (`drizzle-orm`) with parameterized builders — never hand-rolled string-interpolated SQL.
- **Stateless & virtual-clock safe**: All components, repositories, and services remain stateless (`agboss/no-component-state`) and use injected `Clock` (`agboss/no-direct-time`).
- **Static model declarations**: Models are declared statically inside `@Agent` components — never rewrite models dynamically via `fetch` overrides or CLI flags.
- **Small, single-entity files**: Keep every TypeScript file under 200 lines (functions ≤ 50 lines), strictly one class per file (including `src/dto/*.dto.ts`).
- **Offline default**: `npm run check`, `npm test`, and `npm run demo` must run 100% offline.
