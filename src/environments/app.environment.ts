/**
 * The environment contract: declared fields only. The ledger's SQLite file, the model provider's key
 * and base URL are not here: the `@DatabaseStorage` and the `@ModelProvider` each read their own
 * reference (`env(…)`, `secret(…)`) when the application starts.
 */
export class AppEnvironment {
  /** Where the staged and promoted artifact files go (shared by every instance of one machine). */
  artifactDir!: string;
}
