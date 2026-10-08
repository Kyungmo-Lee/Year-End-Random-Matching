declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    ASSETS: Fetcher;
    SESSION_SECRET: string;
    ADMIN_PASSWORD_HASH: string;
    TEST_ADMIN_PASSWORD: string;
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}
