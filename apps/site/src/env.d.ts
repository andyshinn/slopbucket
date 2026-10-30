declare namespace App {
  interface Locals {
    /** Set by middleware for /admin requests that passed Cloudflare Access. */
    adminEmail?: string;
    /** The category_info setting, read from D1 once per request on first use. */
    categoryInfo: () => Promise<import("@slop-bucket/core").CategoryInfo>;
  }
}
