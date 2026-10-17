import type { D1Migration } from "cloudflare:test";

declare global {
  /** Vite's eager `import.meta.glob`, used by the EXPLAIN lint to find every module's repo.ts. */
  interface ImportMeta {
    glob<T>(pattern: string, options: { eager: true }): Record<string, T>;
  }

  namespace Cloudflare {
    interface Env {
      /** Migrations read by vitest.config.ts and applied in test/setup.ts. */
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
