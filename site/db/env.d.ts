declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    MESHFUL_ACCOUNT_SYNC?: string;
    MESHFUL_ALLOWED_ORIGIN?: string;
  }
}
