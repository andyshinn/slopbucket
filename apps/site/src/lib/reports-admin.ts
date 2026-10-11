// The admin Reports page: visitor reports from tool pages, and resolving them.

import { REPORT_REASONS } from "./reports.ts";

export interface AdminReport {
  id: number;
  reason: string;
  note: string | null;
  created_at: string;
  resolved_at: string | null;
  tool_id: number;
  tool_name: string;
  tool_slug: string;
  tool_status: string;
}

/** Open reports, newest first; or the most recently resolved ones. */
export async function listReports(db: D1Database, resolved = false, limit = 50): Promise<AdminReport[]> {
  const [where, order] = resolved ? ["r.resolved_at IS NOT NULL", "r.resolved_at"] : ["r.resolved_at IS NULL", "r.created_at"];
  const { results } = await db
    .prepare(
      `SELECT r.id, r.reason, r.note, r.created_at, r.resolved_at, r.tool_id,
        t.name AS tool_name, t.slug AS tool_slug, t.status AS tool_status
       FROM reports r JOIN tools t ON t.id = r.tool_id
       WHERE ${where} ORDER BY ${order} DESC, r.id DESC LIMIT ?`,
    )
    .bind(limit)
    .all<AdminReport>();
  return results;
}

export async function openReportCount(db: D1Database): Promise<number> {
  return (await db.prepare("SELECT count(*) AS n FROM reports WHERE resolved_at IS NULL").first<number>("n")) ?? 0;
}

/** Marks a report resolved; false if it doesn't exist or was already resolved. */
export async function resolveReport(db: D1Database, id: number): Promise<boolean> {
  const { meta } = await db
    .prepare("UPDATE reports SET resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND resolved_at IS NULL")
    .bind(id)
    .run();
  return meta.changes > 0;
}

/** The reason's label, or the stored value for a reason no longer in the list. */
export const reasonLabel = (reason: string): string => (Object.hasOwn(REPORT_REASONS, reason) ? REPORT_REASONS[reason as keyof typeof REPORT_REASONS].label : reason);
