import type { ToolStatus } from "./tools-admin.ts";
// Shared Tailwind class strings for the admin UI. Tap targets are at least 44px tall.
export const btn =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-base font-semibold shadow-xs focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50";
// Lime fill always takes lime-950 text (white fails contrast); see docs/UI-HANDOFF.md.
export const accentFill = "bg-lime-400 text-lime-950";
export const accentLink = "font-medium text-lime-700 underline underline-offset-2";
export const btnPrimary = `${btn} ${accentFill} hover:bg-lime-300 focus-visible:outline-lime-600`;
export const btnApprove = `${btn} ${accentFill} hover:bg-lime-300 focus-visible:outline-lime-600`;
export const btnReject = `${btn} bg-white text-red-700 ring-1 ring-red-300 ring-inset hover:bg-red-50 focus-visible:outline-red-600`;
export const btnSecondary = `${btn} bg-white text-stone-900 ring-1 ring-stone-300 ring-inset hover:bg-stone-50 focus-visible:outline-stone-600`;
export const input =
  "block w-full rounded-lg bg-white px-3 py-2.5 text-base text-stone-900 outline-1 -outline-offset-1 outline-stone-300 placeholder:text-stone-400 focus:outline-2 focus:-outline-offset-2 focus:outline-brand-600";
export const label = "block text-sm font-medium text-stone-900";
/** Status chip colors for tools; typed so a new status can't go unstyled. */
export const toolStatusChip: Record<ToolStatus, string> = {
  published: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  queued: "bg-amber-50 text-amber-800 ring-amber-600/20",
  hidden: "bg-stone-100 text-stone-600 ring-stone-500/20",
};
export const card = "rounded-xl bg-white shadow-xs ring-1 ring-stone-200";

export const SOURCE_LABELS: Record<string, string> = { hn: "Hacker News", lobsters: "lobste.rs", github: "GitHub", producthunt: "Product Hunt" };

export function timeAgo(iso: string, now = Date.now()): string {
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 1)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** A rough duration for ETAs: "about 40 minutes", "about 3 hours", "about 2 days". */
export function aboutDuration(minutes: number): string {
  const plural = (n: number, unit: string) => `about ${n} ${unit}${n === 1 ? "" : "s"}`;
  if (minutes < 90) return plural(Math.max(1, Math.round(minutes)), "minute");
  if (minutes < 36 * 60) return plural(Math.round(minutes / 60), "hour");
  return plural(Math.round(minutes / 1440), "day");
}

/** A run's length: "9s", "1m 30s", "2h 5m". */
export function shortDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 60)}h`;
}

export function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** An http(s) URL safe to use as a link, or null (never javascript: or data: URLs). */
export function safeHref(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

/** "owner/repo" -> its GitHub URL, or null if it isn't one. */
export function githubHref(repo: unknown): string | null {
  if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  const [owner, name] = repo.split("/");
  if (owner === "." || owner === ".." || name === "." || name === "..") return null;
  return `https://github.com/${repo}`;
}
