// Visitor reports from tool pages: validated, protected by Turnstile and a
// per-IP rate limit, stored in `reports` for the admin.

export const REPORT_REASONS = {
  "not-ai-tool": { label: "Not an AI coding tool", hint: "It isn't an AI dev tool, or it's an article, list or model." },
  "wrong-merge": { label: "Wrong merge", hint: "Two different tools ended up on one page." },
  spam: { label: "Spam", hint: "Promotion, junk or something malicious." },
  "broken-link": { label: "Broken link", hint: "The homepage, repo or a post link doesn't work." },
} as const;
export type ReportReason = keyof typeof REPORT_REASONS;
export const NOTE_MAX = 500;

export class ReportError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface ReportDeps {
  /** Turnstile secret; reports are off without it. */
  turnstileSecret?: string;
  limiter?: RateLimit;
  fetcher?: typeof fetch;
}

/** Checks a Turnstile token with siteverify. */
export async function verifyTurnstile(secret: string, token: string, ip: string | null, fetcher: typeof fetch = fetch): Promise<boolean> {
  if (!token || token.length > 2048) return false;
  try {
    const res = await fetcher("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, response: token, ...(ip ? { remoteip: ip } : {}) }),
      signal: AbortSignal.timeout(5000),
    });
    const body = (await res.json()) as { success?: boolean };
    return body.success === true;
  } catch {
    return false;
  }
}

/** Validates and stores a report from the form. Throws ReportError with an HTTP status. */
export async function submitReport(db: D1Database, toolId: number, form: FormData, ip: string | null, deps: ReportDeps): Promise<void> {
  if (!deps.turnstileSecret) throw new ReportError("Reports aren't switched on yet.", 503);
  const reason = String(form.get("reason") ?? "");
  if (!Object.hasOwn(REPORT_REASONS, reason)) throw new ReportError("Pick a reason.", 422);
  const note = String(form.get("note") ?? "").trim();
  if (note.length > NOTE_MAX) throw new ReportError(`Keep the note under ${NOTE_MAX} characters.`, 422);
  if (deps.limiter && !(await deps.limiter.limit({ key: `report:${ip ?? "unknown"}` })).success) {
    throw new ReportError("That's a lot of reports. Try again in a minute.", 429);
  }
  const human = await verifyTurnstile(deps.turnstileSecret, String(form.get("cf-turnstile-response") ?? ""), ip, deps.fetcher);
  if (!human) throw new ReportError("The bot check didn't pass. Try again.", 400);
  await db.prepare("INSERT INTO reports (tool_id, reason, note) VALUES (?, ?, ?)").bind(toolId, reason, note || null).run();
}
