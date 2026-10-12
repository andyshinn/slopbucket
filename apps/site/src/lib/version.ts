// What's deployed, for the admin footer. deploy.yml tags each Worker version with
// the short git commit; the version ID is Cloudflare's own and differs from it.

export interface BuildInfo {
  /** Short git commit from the version tag, or null when deployed without one. */
  commit: string | null;
  commitHref: string | null;
  /** Cloudflare Worker version ID (a UUID). */
  versionId: string;
  /** The first 8 characters of the version ID, for the footer on a phone. */
  versionShort: string;
  /** When the version was uploaded, ISO 8601. */
  deployedAt: string;
}

const REPO = "https://github.com/andyshinn/slopbucket";

export function buildInfo(meta: WorkerVersionMetadata): BuildInfo {
  const tag = meta.tag ?? "";
  const commit = /^[0-9a-f]{7,40}$/.test(tag) ? tag : null;
  return {
    commit,
    commitHref: commit ? `${REPO}/commit/${commit}` : null,
    versionId: meta.id,
    versionShort: meta.id.slice(0, 8),
    deployedAt: meta.timestamp,
  };
}
