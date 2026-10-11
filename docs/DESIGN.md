# Slop Bucket — Design Doc

As of Oct 9, 2026

## Overview

A public website that discovers new AI coding tools daily from developer communities and ranks them by what is trending. It runs entirely on Cloudflare, with a target cost of $1–2 per day. It is called Slop Bucket and lives at https://slopbucket.app.

**In scope:** developer tools that use AI to help write, run or manage code. This means coding agents, AI IDEs and editor extensions, CLIs, and tools built for AI coding-agent workflows (plugins, skills, hooks, monitors, orchestrators). Every MCP server is in scope too, whatever it is for, in its own category: `mcp-dev` when it helps with software development, `mcp-general` otherwise. Both open-source and closed-source tools are included; closed-source tools are flagged as such.

**Categories** (by what the tool is for; the classifier picks the most specific one that fits):

| Category | For |
| --- | --- |
| `agent` | Coding agents that plan and make changes on their own |
| `agent-addon` | Add-ons installed into a coding agent: plugins, skills, hooks, mods, status lines, rule and prompt packs |
| `agent-tools` | Tools made for coding agents that run alongside them: running agents in parallel, dashboards, usage and cost tracking, remote control, sandboxes for coding agents |
| `agent-security` | Keeping coding agents safe: guardrails, blocking dangerous commands, catching leaked secrets, audit trails, pinning MCP tools |
| `review-testing` | AI code review, test generation, and checking AI-written code |
| `memory-context` | Memory for coding agents, codebase docs or indexes made for agents, keeping an agent's context small |
| `ide` | AI IDEs and editor extensions |
| `cli` | AI command-line tools that fit none of the more specific categories |
| `mcp-dev` / `mcp-general` | MCP servers, for software development or for anything else |
| `other` | In-scope tools that fit nothing above (always queued, as a signal the list may need to grow) |

The list lives in the `categories` setting; the one-line description the classifier sees for each is in `apps/ingest/src/classifier.ts`, so a category added from the settings page works but has no description until the code adds one.

**Tags** come from a fixed vocabulary in the `tags` setting, in four groups. Visitors filter by them, and the classifier may only choose from them (up to 6 per tool):

| Group | Means | Tags |
| --- | --- | --- |
| Works with | The coding agent or editor it plugs into or drives | Claude Code, Codex, Cursor, OpenCode, Gemini CLI, Pi, GitHub Copilot, Windsurf, Zed, VS Code, JetBrains, Xcode, Any agent |
| Models | Whose AI models it uses | Claude, OpenAI, Gemini, DeepSeek, Qwen, Local models, Any model |
| Platform | Where it runs | macOS, Linux, Windows, iOS, Self-hosted, Docker |
| Interface | How you use it | CLI, Desktop app, Web app, Editor extension, MCP server, Plugin or skill, Menu bar, GitHub Action |

Interface overlaps some categories on purpose; it is a filter, while the category says what the tool is for. A tag the model needs but can't use goes into `suggested_tags`, and the settings page lists the most requested ones so the vocabulary can grow. Programming languages are not tags: the language filter uses GitHub's repo language. Tool and post tags are stored as slugs.

**Out of scope:**

- SDKs and libraries for building LLM apps
- Models, papers, benchmarks and general AI news
- Roundups, comparisons and "awesome-X" lists (dropped entirely)
- User accounts, user submissions, email digests, RSS and site analytics (not in v1)

**Key product decisions:**

| Decision | Choice |
| --- | --- |
| Audience | Public, anyone can browse |
| Unit of content | Tool pages, each with a timeline of linked posts |
| Home page | Trending tools |
| Freshness | One batch run per day |
| Inclusion bar | Everything that qualifies, no minimum traction |
| Review | Queue built in; a confidence threshold controls auto-publishing |
| Classifier | Workers AI open models only |
| Categories | Fixed list controlled by the admin |
| Backfill at launch | 90 days |
| Environments | Production only |
| Public visitor features | Search, filters, and a "report this" link |

## Architecture

The system is two Workers that share one D1 database. An ingestion Worker writes once a day, and the Astro site Worker reads.

```mermaid
flowchart TD
    cron["Cron Trigger<br/>daily, one job per source"] --> ingest["Ingest Worker<br/>source adapters, dedupe by URL"]
    ingest --> queue["Classify queue<br/>one message per post"]
    queue --> classifier["Classifier<br/>fetch text<br/>Workers AI (model from settings)"]
    classifier --> resolver["Tool resolver<br/>aliases and auto-merge<br/>threshold: publish or queue"]
    classifier -- cache text --> r2[("R2<br/>extracted article text")]
    resolver -- published or queued --> d1[("D1 database<br/>tools, posts, snapshots, settings")]
    cron -- after ingest --> trending["Trending job<br/>refresh engagement<br/>scores, active flags"]
    trending --> d1
    site["Astro site Worker<br/>pages, search, reports, edge cache"] -- reads --> d1
    admin["/admin<br/>behind Cloudflare Access"] --> d1
```

Cloudflare resources use an `sb` prefix: Workers `sb-ingest` and `sb-site`, D1 database `sb`, R2 bucket `sb-articles`, queues `sb-fetch` and `sb-classify`, and AI Gateway `sb`. Where a slug is needed (packages, user agent) it is `slop-bucket`.

Only the classifier step costs meaningful money. The site never calls Workers AI, so traffic spikes do not raise AI costs.

## Sources and ingestion

Each source is a small adapter that returns normalized posts. A daily Cron Trigger enqueues one fetch job per source, so a broken source never blocks the others.

| Source | Method | Native signals | 90-day backfill |
| --- | --- | --- | --- |
| Hacker News | Algolia API, filtered by date | Points, comments, Show HN tag | Full |
| lobste.rs | `/newest/page/N.json`, paginated | Score, comments, tags such as `ai` and `vibecoding` | Full |
| GitHub | Search API for repos with topics such as `mcp` or `ai-agent` (`github_topics`) and at least `github_min_stars` stars; daily runs cover repos created in the last 7 days. Trending page scraped | Stars, topics | Search only; Trending has no history |
| Product Hunt | GraphQL API, OAuth client credentials | Votes, comments, topics | Full via date filter. **Disabled:** no adapter until API access is granted |

Every adapter emits the same shape: source, external ID, URL, title, author, posted time, score and comment count. Dedupe happens before classification, using the canonical URL. A GitHub URL is reduced to `owner/repo`. A post whose exact URL was already classified reuses that result instead of calling the model; the canonical URL alone is not enough, because a release link and a launch post can share `owner/repo` but need their own type and version.

**Engagement refresh:** each daily run also re-fetches scores and comments for posts linked to active tools. It writes a snapshot row, so trending can measure growth.

**Backfill:** a one-off job runs the same adapters over 90-day date windows, pushing into the same queue. Sources whose API filters by date (Hacker News) split the backfill into one fetch job per day; lobste.rs pages back through `/newest` in a single job. All backfilled items go to the review queue (threshold set to 1) so classifier quality can be checked before anything is public.

**Product Hunt terms:** the API must not be used commercially without permission. The site has no ads, paid features or data resale, so it is treated as non-commercial, with the attribution link Product Hunt asks for. Revisit if that changes.

**Reddit:** dropped. Since November 2025 every new Reddit API app needs manual approval under the Responsible Builder Policy, and HN, lobste.rs and GitHub already cover most launches.

**GitHub traction floor:** an exception to "no minimum traction". About 2,000 repos with the tracked topics are created each day, mostly empty or abandoned; at 10 stars it is about 22 a day (measured Oct 2026). The floor is the `github_min_stars` setting.

## Extraction and classification

Every new post passes through three stages. The pre-filter runs inside the fetch job, so only posts that pass it are stored and enqueued. After that, each post is its own queue message, which keeps every invocation well inside Worker CPU limits and gives free retries.

1. **Pre-filter (no AI).** Score the title, URL and domain against a keyword list (`llm`, `agent`, `mcp`, `copilot`, `claude`, `cursor`, `codegen` and so on). GitHub links, Show HN and lobste.rs `ai` or `vibecoding` tags add points. Posts scoring zero are not stored; the fetch job logs how many it dropped. The keyword list lives in settings. A bare `ai` keyword is deliberately left out: on a week of HN it let through about 125 extra posts a day, almost all general AI news.
2. **Content fetch.** For GitHub links, fetch the README through the API. Otherwise fetch the page and extract the main text with Mozilla Readability and `linkedom`. JS-heavy pages are meant to fall back to Browser Rendering; that fallback is not built yet, so such pages are classified mostly from their title until the review queue shows it is needed. Text is truncated to about 3,000 tokens and cached in R2 so posts can be reclassified later without re-fetching.
3. **LLM classification.** One Workers AI call per post. The model is the `model_id` setting (GLM 5.3 Flash since Oct 2026, with `model_reasoning_effort` = `low`), chosen by scoring candidates against a hand-labeled set in `evals/classifier`: 85% precision against 39% for Llama 3.3 70B on the first prompt, at under half the cost. The prompt contains a scope checklist, the fixed category list as an enum, and the curated few-shot examples (capped at 20). The model writes a one-line `reason` first, which reviewers see. GLM is a Workers Paid model limited to 20 requests per minute, and a call takes 4–10 seconds, so the classify consumer handles two posts at a time (about 10–15 a minute).

The model must return JSON in this shape:

```json
{
  "is_ai_dev_tool": true,
  "post_type": "launch | release | discussion | roundup | news",
  "tool_name": "string",
  "homepage_url": "string | null",
  "github_repo": "owner/repo | null",
  "version": "string | null",
  "category": "one of the categories setting (see Categories above)",
  "tags": ["slugs from the tags setting only, up to 6"],
  "suggested_tags": ["missing tags the model would add, up to 3; usually empty"],
  "is_open_source": true,
  "description": "one line, under 140 characters",
  "confidence": 0.0
}
```

**Routing after classification:**

- `is_ai_dev_tool` false, or `post_type` roundup: dropped, with the reason stored.
- `is_ai_dev_tool` true but no `tool_name` and no `github_repo`: dropped (`no_tool_named`). Such posts are articles about AI tools in general, not about one tool.
- `confidence` at or above the review threshold: auto-published. A threshold of 1 sends everything to review, even confidence 1.0.
- Below the threshold: sent to the review queue.
- `category` of `other`: always queued, as a signal that the category list may need to grow.

**Validation:** the Worker parses and checks the JSON against the schema. An invalid response is retried once, then queued for review with the raw output attached.

## Tool identity and merging

Every classified post resolves to exactly one tool. The resolver matches identifiers from strongest to weakest and stops at the first hit.

1. GitHub `owner/repo`, normalized to lowercase.
2. Homepage domain, ignoring generic hosts such as `github.io`, `vercel.app` or `medium.com`, which fall through to the next step.
3. Normalized name: lowercase, with spaces, hyphens and suffixes like "AI" or "CLI" stripped. A fuzzy match (similarity of 0.9 or higher) auto-merges.
4. No match: a new tool is created.

Each identifier that matched or was newly seen is stored in `tool_aliases`. A tool can therefore pick up new names, domains and repos over time.

**Admin merge and split:** auto-merge is allowed to be wrong because every merge is reversible. Each merge writes a `tool_merges` row listing which aliases and posts moved. Splitting a merge restores them. The admin can also move a single post to a different tool.

**Releases:** a post with `post_type` release and a `version` attaches to its tool as a release event on the timeline. It also counts as a post for trending. If the tool is new, it is created from the release post.

## Trending score and activity

Trending is recomputed once per day after ingestion, as an engagement score divided by an age penalty. All weights and the gravity exponent live in settings, so they can be tuned without a deploy.

```
score = (w_s * S + w_e * ln(1 + P + 2C) + w_g * ln(1 + stars_gained_7d)) / (h + 2)^g
```

| Term | Meaning | Starting value |
| --- | --- | --- |
| S | Distinct sources with a post about the tool in the last 14 days | — |
| P, C | Total upvotes and comments across those posts | — |
| stars_gained_7d | Stars gained in the last 7 days (0 for closed-source tools) | — |
| h | Hours since the tool's most recent post | — |
| w_s | Source weight | 3.0 |
| w_e | Engagement weight | 1.0 |
| w_g | Star growth weight | 1.5 |
| g | Gravity exponent | 1.5 |

The starting values are guesses to tune against the backfilled data. Closed-source tools have no star term, so their score leans on posts and engagement.

**Active tools:** a tool is active if it had a post or release in the last 30 days, or gained stars compared with a week earlier. Only active tools get their posts' engagement and their GitHub stats refreshed. A new post reactivates a tool automatically.

**Daily trending job:** a second cron at 07:00 UTC, an hour after the fetch, puts a `trending` job on the fetch queue. The status panel's Run button sends the same job. It runs in three steps and records a `source_runs` row with source `trending`:
1. **Engagement:** refreshes upvotes and comments for HN and lobste.rs posts from the last 14 days, on tools that aren't hidden. HN uses batched Algolia lookups of 50; lobste.rs is one request per story.
2. **GitHub stats:** snapshots stars, forks, language and license into `repo_snapshots` for active tools with a repo. It uses GraphQL in batches of 50, which needs the `GH_API_TOKEN` Worker secret; without it, the job snapshots about 40 repos over REST and the run notes the shortfall.
3. **Scores:** recomputes `trending_score` and `is_active` for every tool that isn't hidden.

GitHub posts count toward S, but their stars are not counted as upvotes in P; stars enter only through `stars_gained_7d`. Partial problems, such as a rate limit or a failed lookup, are recorded on the run instead of failing it, so the scores still update.

**Backfill gap:** star growth is unknown for the 90 backfilled days, because snapshots only start at launch. Trending relies on posts and engagement until a week of snapshots exists.

## Data model

All state lives in one D1 database. Extracted article text is stored in R2, keyed by post ID, and is not kept in D1.

| Table | Holds | Key columns |
| --- | --- | --- |
| `tools` | One row per tool | id, slug, name, description, category, tags (JSON), homepage_url, github_repo, is_open_source, status (published, queued, hidden), is_active, trending_score, first_seen_at, last_post_at |
| `tool_aliases` | Names, domains and repos that resolve to a tool | tool_id, kind (repo, domain, name), value (unique per kind) |
| `tool_merges` | Merge log, used to undo merges and to redirect merged tools' pages | id, from_tool_id, into_tool_id, moved_aliases (JSON), moved_posts (JSON), from_status, merged_at, undone_at |
| `posts` | One row per submission | id, source, external_id, url, canonical_url, title, author, posted_at, tool_id, post_type, version, classification (JSON), confidence, status (pending, published, queued, rejected, dropped), drop_reason, raw_output, classified_at |
| `post_snapshots` | Daily engagement per post | post_id, date, score, comments |
| `repo_snapshots` | Daily GitHub stats per tool | tool_id, date, stars, forks, language, license |
| `review_decisions` | Every approve, reject or edit made in the queue | post_id, decision, corrected_fields (JSON), use_in_prompt, decided_at |
| `reports` | Visitor reports from tool pages | id, tool_id, reason, note, created_at, resolved_at |
| `source_runs` | One row per source per run, for the status panel (source `trending` is the daily trending job; its item count is tools scored) | source, mode (daily, manual, backfill), started_at, finished_at, items_fetched, error |
| `operations` | Backfills and re-classifies started from the admin panel, for progress | id, kind (backfill, reclassify), source, days, total, last_post_id, started_at, finished_at |
| `settings` | Tunable values as JSON | key, value |

**Post status:** `pending` means stored but not yet classified. `raw_output` holds model output that failed validation twice, for the review queue. `classified_at` is set by a trigger when a post leaves `pending`.

**Settings keys:** `review_threshold`, `trending_weights`, `categories`, `tags`, `prefilter_keywords`, `model_id`, `model_reasoning_effort`, `max_fewshot`, `github_topics` and `github_min_stars`.

**Search:** a D1 FTS5 virtual table indexes tool name, description and tags. It is kept in sync with triggers on `tools`.

## Frontend

The site is Astro with the Cloudflare adapter, deployed as a Worker with static assets on the custom domain `slopbucket.app` (no `workers.dev` URL). Pages are server-rendered from D1 and cached at the edge for 5 minutes (the Workers Cache API, in `middleware.ts`; `/admin` and `/api` are never cached). The cache key is the path plus the filters as `parseFilters` reads them, written back in one canonical form (`pageCacheKey` in `lib/edge-cache.ts`), so unknown parameters, bad values and reorderings share one entry. Data changes once a day, so a short TTL keeps pages fresh without purging, and pages stay fast and indexable without a rebuild per day. Page renders that miss the cache count toward a per-IP limit (`PAGE_LIMITER`, 60 a minute, a Workers rate-limiting binding); over it, the visitor gets a plain 429, so no one can run D1 queries in a loop.

| Route | Content |
| --- | --- |
| `/` | Trending tools, 25 per page (`?page=`): rank, avatar, name, one-line description, category, open or closed badge, sources, up to 3 tags, published post count, latest activity, stars and the 7-day star gain (shown once a snapshot at least 7 days old exists). Above the list: the last daily run and three counts (published tools, all stored posts, dropped posts). Only published tools and published posts appear |
| `/avatar/[owner]` | The GitHub owner's avatar (`github.com/{owner}.png?size=88`), proxied so visitors' browsers never contact GitHub, or an SVG monogram when GitHub has none; cached at the edge. Tools without a repo get a monogram tile in their category's color instead |
| `/new` | Newest tools by first-seen date, with the same filters |
| `/tools/[slug]` | Tool page: description, category and tags, homepage and GitHub links, At a glance (stars and 7-day gain, license, language, repo, homepage, first seen; GitHub rows left out for closed-source tools), and a timeline of published posts and releases, newest first (the latest 100), with engagement from the latest snapshot and a link to the HN or lobste.rs thread. Only published tools have a page; a merged tool redirects (301) to the tool it was merged into, following chains, while the merge is active; queued, hidden and unknown slugs are 404 |
| `/tools/[slug]/report` | The report form (a full page, so it works without JavaScript and Turnstile renders normally) |
| `/category/[name]` | Trending within one category (404 for a slug not in `categories`), with the other filters |
| `/search` | Full-text search (`q`) with the same filters; sorted by best match (FTS5 `bm25`, name matches weighted highest) with matches highlighted |
| `/about` | What the site is, and how ranking works (`#ranking`, with the weights read from `trending_weights`) |
| `/api/*` | JSON endpoints for search, filters and reports |
| `/admin/*` | Review queue, tools, settings, reports and status panel |

**Look:** the visual spec is `docs/UI-HANDOFF.md`: Tailwind lime on stone, Space Grotesk and Space Mono (self-hosted with Fontsource), and the pail-pig logo (`apps/site/public/`). Public pages share `layouts/Public.astro` (header, footer, theme toggle). They are light by default with a dark mode: a small inline script sets a `dark` class on `<html>` from the visitor's saved choice or the OS setting before first paint. The same script closes header menus on Escape and makes `/` focus search. Admin pages leave the script out and stay light. Category labels and colors live in `packages/core` (`categoryDisplay`); a category added from settings shows its slug, capitalized, in stone until code adds a label.

**Search and filters:** every list page (`/`, `/new`, `/search`, `/category/[name]`) shares one filter set, read from the URL so results can be shared and indexed: `q` (text), `category` (repeatable), `tag` (repeatable; any of the chosen tags within a tag group, and every group with a choice), `license` (`open` or `closed`), `stars` (at least 10, 100, 1k or 10k, from the latest repo snapshot), `lang` (repeatable, GitHub's repo language), `seen` (first seen in the last 7, 30 or 90 days), `sort` (trending, newest, most stars, most discussed = most published posts; best match with a query) and `page`. The sidebar shows faceted counts: each option's count applies every other active filter but not its own group's. Active filters show as removable chips. On desktop the sidebar submits on change (with an Apply button when JavaScript is off); on phones the same form opens in a native `<dialog>` with a Show results button. Matched text in names and descriptions is highlighted with FTS5 `highlight()`, HTML-escaped before the `<mark>` tags are added.

**Reports:** a small form with a reason (not an AI coding tool, wrong merge, spam, broken link) and an optional note (up to 500 characters), stored in `reports`. It is rate-limited per IP (`REPORT_LIMITER`, 5 a minute), and Turnstile blocks bots (a Managed widget with `interaction-only` appearance, so visitors see it only when it needs a click): the site key and secret are the Worker secrets `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` (set in the dashboard as type Secret, or with `ops.yml` → set-secret). Until both are set, the form says reports aren't switched on and refuses submissions.

Public pages do not show confidence or whether an entry was auto-classified.

## Review queue, settings and feedback

One setting controls how automatic the site is: `review_threshold`. Posts with confidence at or above it publish automatically; the rest wait in the queue.

| Threshold | Behavior |
| --- | --- |
| 0 | Fully automatic; the queue only holds invalid outputs and `other` categories |
| 0.7–0.9 | Confident items publish; borderline items wait for review |
| 1 | Everything is reviewed (used for the backfill) |

**Admin pages** sit behind Cloudflare Access (a self-hosted Access application for the site's `/admin` path), so there is no login code to write. The site still verifies the Access JWT on every `/admin` request and refuses cross-site form posts: if Access is not configured (`ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` vars in `apps/site/wrangler.jsonc` missing) or the token is invalid, `/admin` returns 503 or 403 instead of opening up. Workers with static assets do not receive `ctx.access`, which is why the token is checked directly.

**UI stack:** Tailwind CSS v4 with Heroicons and Tailwind's palette, server-rendered `.astro` components. Admin actions are plain HTML forms, so the admin ships no JavaScript. Tailwind Plus Elements (web components) is the choice when an interactive widget is needed; React is not used.

- **Queue:** each item shows the title, source, extracted text preview and the model's JSON. A "Resolves to" box names the tool the post belongs to, or marks it as a new tool when this is the only post of a still-queued tool (usually the resolver created it for this post). Tags outside the current vocabulary are struck through; saving with Edit drops them, since the edit page only offers vocabulary tags. Actions are approve, reject, edit fields, or reassign to a different tool. Edit and reassign are separate full-screen pages rather than dialogs. Edit stores only the changed fields in `review_decisions.corrected_fields` (the model's output stays in `posts.classification`), updates those fields on the tool, re-resolves the tool if its name, repo or homepage changed, then approves (or rejects, if marked out of scope). Reject records `{"is_ai_dev_tool": false}` so a rejection can serve as a few-shot example. Reassign keeps the post queued. On the edit page, tags are checkboxes grouped by tag group, so only vocabulary tags can be chosen.
- **Tools:** a list with search (name, or any alias: repo, domain or name), status tabs with counts, a category filter and sort. Each tool has an edit page:
  - **Details:** name, slug, description, category, tags (vocabulary checkboxes), homepage, repo, open or closed source. A new repo, homepage domain or name is also added as an alias, and the save is refused if another tool already owns it, since that means the two should be merged.
  - **Aliases:** add (normalized like the resolver; shared hosts like `github.io` are refused) and remove.
  - **Posts:** the latest posts, with Move for queued ones.
  - **Hide or unhide:** hidden tools keep their aliases, so new posts about them stay hidden. Unhide returns the tool to published if any of its posts is published, otherwise to queued.
  - **Merge:** search for the tool to keep and review what moves (posts and aliases), then confirm. In one transaction, posts and aliases move to the target. The target fills blank fields from the merged tool, unions their tags, takes the earlier first-seen date, and becomes published if a moved post is published. The merged tool is hidden. Its public page (`/tools/[slug]`) redirects (301) to the target while the merge is active.
  - **Split:** "Split back out" in the target's merge history undoes a merge. Posts and aliases still on the target go back, and the merged tool gets its old status back (`tool_merges.from_status`). Anything reassigned elsewhere since the merge stays where it is.
- **Settings:** every key in `settings` (threshold, trending weights, category list, tag vocabulary, pre-filter keywords, model ID and reasoning effort, few-shot cap, GitHub topics and star floor), one form per setting, validated with the same zod schemas the Worker uses. Changes apply on the next job without a deploy. The tag vocabulary is edited as text (`# Group | hint` lines, then `slug: Label` lines), with the classifier's most requested missing tags listed below it.
- **Reports:** open visitor reports, newest first (the admin nav shows their count): the reason, age, tool (linking to its public page), the visitor's note, Open tool (the admin edit page) and Resolve (a form POST that sets `resolved_at`). "Show resolved reports" lists the 50 most recently resolved.
- **Status panel:** last run per source, item count, error, and a warning when a source's count drops sharply below its 7-day average. Buttons to run a source now, start a backfill, and re-classify unreviewed queued posts (each with a confirmation step). A Trending card shows the last trending job and can run it now. Re-classify can also re-check posts dropped by a model other than the current `model_id`, since an older model's drops may hide real tools. These enqueue jobs through the site Worker's own queue bindings, so they need no API token; infrastructure actions (migrations, secrets, deploys) stay in GitHub Actions. An "In progress" section shows:
  - **Classifying:** posts waiting, the rate over the last 15 minutes and an ETA. A warning appears when posts are waiting but nothing was classified in 15 minutes (usually the AI spend cap).
  - **Each backfill and re-classify** started from the panel (from `operations`), until a day after it finishes. A backfill shows fetch runs done out of expected (one per day for HN and GitHub, or a single run when the backfill covers two days or less; one for lobste.rs) and its stored posts classified. A re-classify shows its posts classified. Fetching counts as over once every run succeeds or none has started for an hour, so a day that keeps failing does not hold the backfill open forever. Progress is derived from `posts` and `source_runs` when the page loads, and a Refresh button reloads it (no JavaScript). Runs started from `ops.yml` only show in the Classifying line.

**Feedback loop:** every queue decision is stored in `review_decisions`. A checkbox marks a decision as a few-shot example. Only marked rows, up to `max_fewshot`, go into the classifier prompt. A "reclassify" button re-runs the classifier over cached R2 text after the prompt or examples change.

## Operations, cost and launch

Expected daily cost is under $1, inside the $1–2 target, assuming about 300 posts pass the pre-filter each day.

| Item | Assumption | Approx. cost per day |
| --- | --- | --- |
| Classification | 300 posts with GLM 5.3 Flash, measured on the eval set (about 2,200 input tokens per post plus low-effort reasoning) | $0.12 |
| Workers, Queues, D1, R2 | Workers Paid plan, $5 per month, usage well within its allowances | $0.17 |
| **Total** | | **about $0.29** |

Model prices are approximate, taken from third-party trackers, and should be confirmed on Cloudflare's model pages. The 90-day backfill is a one-off cost of roughly 90 days of classification, about $12 with GLM 5.3 Flash. The AI Gateway's daily cap and the model's 20 requests per minute spread it over several days.

**Deploy:** GitHub Actions on GitHub-hosted runners with `cloudflare/wrangler-action`. On push to `main`, it runs type checks and tests, applies D1 migrations, then deploys. The API token and GitHub (and later Product Hunt) credentials are kept in repo secrets and Worker secrets.

**Cost cap:** every Workers AI call goes through an AI Gateway (`sb`) with a daily spend limit, defined in `infra/ai-gateway.json` and applied by `deploy.yml`. When the limit is reached the gateway rejects AI calls; those posts stay `pending` and the next daily run re-enqueues them (up to 5,000, about what the cap buys in a day), so a large backfill spreads over several days instead of running up the bill. A Cloudflare budget alert (Billing > Billable Usage) emails when the month's usage-based spend crosses a set amount.

**Monitoring:** the admin status panel only, as decided. Each run writes `source_runs`, and the panel flags errors and sudden drops in item counts.

**Launch plan:**

1. Scaffold the repo: Astro site, ingestion Worker, D1 schema and migrations, CI.
2. Build the HN and lobste.rs adapters plus classification, then test on a week of data.
3. Add the GitHub adapter (Reddit dropped; Product Hunt waits for API access).
4. Build the admin review queue (added: steps 6 and 7 need it).
5. Build the admin status panel and settings page (added): run a source now, start a backfill, re-classify the queue, and edit every setting without a migration.
6. Run the 90-day backfill with the threshold at 1 and review the queue.
7. Tune the prompt, few-shot examples, category list and trending weights against the backfill. (The category list was expanded before the backfill, after the first re-classify left half the queue in `other`, so the backfill does not have to be re-classified for it.)
8. Lower the threshold and make the site public.

**Open questions:**

- When Product Hunt API access is granted, add its adapter.

## Phone-only workflow

All development and operations happen from a phone, so nothing may require a local machine. Claude Code (from the Claude mobile app) writes code and opens PRs; GitHub Actions runs every command that would normally run locally.

| Workflow | Trigger | Does |
| --- | --- | --- |
| `bootstrap.yml` | Manual, run once | Creates the D1 database, R2 bucket and queues with Wrangler, then commits their IDs into `wrangler.jsonc` |
| `ci.yml` | Pull request | Type checks, unit tests, migration dry run |
| `deploy.yml` | Push to `main` | Applies D1 migrations, then deploys both Workers |
| `eval.yml` | Manual, with inputs | Scores a classifier model and the current prompt against the hand-labeled set in `evals/classifier` (through the AI Gateway, so the spend cap applies). Model and categories default to production's settings; either can be overridden to try a candidate |
| `rename.yml` | Manual, one-off | Moves the old `radar-*` resources to `sb-*`: copies D1 and R2 data, deploys the new Workers, deletes the old ones; a second `cleanup` run deletes the old D1, bucket, queues and gateway. Delete it (and `.github/scripts/copy-data.mjs`) after cleanup |
| `ops.yml` | Manual, with inputs | Fallback for when the admin is unavailable, and for infrastructure. Runs one action: apply migrations, run a read-only SQL query, set a Worker secret, start the backfill, trigger one source now, or re-classify unreviewed queued posts after a classifier change |

**Setup done in a phone browser:** the Cloudflare API token, Cloudflare Access for `/admin`, and GitHub repo secrets. The GitHub app cannot manage secrets, so use the browser in desktop-site mode.

**Debugging:** Workers Logs is enabled through `observability` in the Wrangler config, so logs are searchable in the Cloudflare dashboard. The admin status panel adds a "run now" button per source, and each queue item shows its raw extracted text and model output. The D1 console in the dashboard covers ad hoc queries.

**Admin UI is mobile-first:** one queue item per screen, large approve and reject buttons, and no actions that need a keyboard.

**Work in small PRs:** each Claude Code session takes one step of the launch plan and ends with a PR small enough to review on a phone.
