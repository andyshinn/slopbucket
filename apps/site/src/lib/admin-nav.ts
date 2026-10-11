// Counts for the admin tabs: one small query per admin page.

export interface NavCounts {
  /** Posts waiting in the review queue. */
  queue: number;
  /** Tools that aren't hidden. */
  tools: number;
  /** Open visitor reports. */
  reports: number;
}

/** The tab counts, or null if the query fails: they are badges, so a failure must not take the admin down. */
export async function navCounts(db: D1Database): Promise<NavCounts | null> {
  try {
    return await db
      .prepare(
        `SELECT (SELECT count(*) FROM posts WHERE status = 'queued') AS queue,
          (SELECT count(*) FROM tools WHERE status != 'hidden') AS tools,
          (SELECT count(*) FROM reports WHERE resolved_at IS NULL) AS reports`,
      )
      .first<NavCounts>();
  } catch {
    return null;
  }
}
