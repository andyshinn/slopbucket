# Progress

Where Slop Bucket stands, so a new session can pick up without the chat history. Update this file in each PR that moves the launch plan, changes what's next, or resolves an open issue.

**Last updated:** 2026-10-30 (desktop admin shell and queue split view; fix: daily update failed on a negative lobste.rs score)

## Resuming in a new session

1. Read `CLAUDE.md`, then `docs/DESIGN.md` (source of truth), then this file.
2. For public-site work, also read `docs/UI-HANDOFF.md` (visual spec). Logos are in `docs/brand/logo-concepts/pail-pig-round-3/`.
3. Check `gh pr list` for open PRs, and the Status page at https://slopbucket.app/admin/status for what's running.

## Launch plan

| Step | Status |
| --- | --- |
| 1. Scaffold repo, D1 schema, CI | Done (#1) |
| 2. HN and lobste.rs adapters, classification | Done (#2, #3) |
| 3. GitHub adapter (Reddit dropped, Product Hunt waiting) | Done (#4) |
| 4. Admin review queue | Done (#5, #6) |
| 5. Admin status panel and settings | Done (#8, #10) |
| 6. 90-day backfill, review the queue | **In progress**: the 90-day backfill (started 2026-10-12) has finished fetching and is still classifying (2026-10-20); review the queue as it fills |
| 7. Tune prompt, few-shot, categories, trending weights | Started early: classifier accuracy (#7), categories v3 (#11), tag vocabulary (#14) |
| 8. Lower the threshold, go public | Not started. Needs the public site (below) |

Built outside the plan's step list, all needed before launch: the daily trending job (#12), classify concurrency (#13), the admin Tools page with merge and split (#15, #16), the rename to Slop Bucket (#17), and the queue page improvements from the UI handoff.

## Next steps, in order

1. ~~Re-classify for tags~~: done. The posts queued before the tag vocabulary (#14) now carry tags from the current prompt.
2. **Let the 90-day backfill finish.** Started 2026-10-12; as of 2026-10-20 every fetch run is done and classification is still running. Status → In progress shows the posts left and the ETA. If the Classifying card says nothing moved in 15 minutes, it's usually the $15/day AI Gateway cap, and it resumes after the 06:00 UTC run.
3. **Review the queue** as it fills. Use Tools → Merge for duplicate tools. Mark good decisions as few-shot examples.
4. **Build while the backfill runs:**
   - ~~Queue page improvements~~: done (Resolves to box, tag chips, reason quote, lime Approve).
   - **The public site**, following the handoff's suggested build order. Steps 1 (tokens, layout, theme, `/about`), 2 (home trending list, rows, `/avatar/[owner]`, 5-minute edge cache), 3 (filters with faceted counts, sort, `/search`, `/new`, `/category/[name]`, the phone filter dialog) and 4 (tool pages with merge redirects, the report form, per-IP rate limits) are done. The admin Reports page (handoff step 8) is done too. Step 5 (admin restyle: top bar with logo, ADMIN chip and View site; scrolling underline tabs with counts; stone neutrals; the queue polish and lime Approve came earlier in #19) is done. Step 6's Tools polish (desktop table with tiles and category badges, stacked list on phones; edit page with tile header, description count and hint, segmented Source control, "via merge" aliases, "Show all" posts, and an Other actions card) is done. The Status page restyle (model ID in the title row, mono section labels, lime progress bars, source cards with shaped status marks, run durations and the drop percentage, a muted Product Hunt card, and a Jobs list that leads to the backfill form and the re-classify confirmation) is done. Step 9 (desktop admin shell: the dark sidebar from `lg` up; the queue split view with source, confidence and order filters, a list of matching posts, actions top right and the extracted text open) is done. Merge redirects (301 from a merged tool's slug) are part of the tool page. **Left from the handoff** (question for Andy: still wanted, or does Settings cover it?): the Tags & categories admin page (`/admin/taxonomy`, tags are edited in Settings today) and the public `/tag/[slug]` page (tag filtering already works through `?tag=`). The optional A/R/S keyboard shortcuts were skipped, since the admin ships no JavaScript.
   - ~~Reports page (admin)~~: done.
5. **Step 7 tuning** against the backfilled data, then **step 8**: lower `review_threshold`, press Status → Publish confident posts (uses stored confidence, no model calls) so confident queued posts publish, and go public. Re-classify only after changing the model, prompt, categories, tags or few-shot examples.

## Open issues

- **Daily update failed with `NOT NULL constraint failed: tools.trending_score`** (fixed in this PR): a flagged lobste.rs story with a negative score made `ln(1 + P + 2C)` NaN, D1 bound it as NULL, and the whole batch failed, so no tool was scored. After the deploy, press Run on Status → Daily update and check it scores tools.
- **Trending cron didn't run on Oct 9.** `source_runs` has only the manual trending run from Oct 8 20:49 UTC, and nothing from the 07:00 UTC cron on Oct 9, although the 06:00 fetch ran. Check tomorrow's 07:00 run on `sb-ingest`; if it's missing again, check the deployed cron triggers and the ingest logs.
- **Rename cleanup failed.** The `rename.yml` "cleanup" run on Oct 9 23:55 failed with R2 429 (rate limited) while deleting `radar-articles` objects. Re-run cleanup; already-deleted objects return 404, which the script ignores. Afterwards, delete `rename.yml` and `.github/scripts/copy-data.mjs`.
- **Unmerged commit:** `649a841` ("Attach slopbucket.app in the dashboard instead of wrangler routes") sits on `rename-slop-bucket` after #17 merged. Decide whether it's still wanted.
- **Reports are off until Turnstile is set up:** create a Turnstile widget for `slopbucket.app` in the Cloudflare dashboard, then add its site key and secret to the `sb-site` Worker as the secrets `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`: either in the dashboard (Workers & Pages → sb-site → Settings → Variables and Secrets, type **Secret**, since deploys remove plain-text variables that aren't in `wrangler.jsonc`), or as repo secrets copied over with `ops.yml` → set-secret (worker: site). Reports show on Admin → Reports.
- **Re-classify operation never marked finished:** operation 1 has `finished_at` NULL, because finishing is written lazily when the Status page loads. It should close on the next Status view. If it doesn't, check `reclassifyProgress`.

## Production snapshot (2026-10-09)

- **Site:** https://slopbucket.app. Admin at `/admin`, behind Cloudflare Access.
- **Resources:** Workers `sb-ingest` and `sb-site`; D1 `sb`; R2 `sb-articles`; queues `sb-fetch` and `sb-classify`; AI Gateway `sb` (its daily cap, $15 in `infra/ai-gateway.json`, counts GLM spend, confirmed in Analytics; `deploy.yml` reapplies the file on every deploy, so change the cap there, not in the dashboard).
- **Crons (UTC):** 06:00 fetches all sources; 07:00 runs the trending job (engagement, GitHub stars, scores).
- **Migrations applied:** 0001–0010.
- **Data:** 511 queued posts, 2,421 dropped, 2 published, 1 rejected; 461 tools.
- **Classifier:** GLM 5.3 Flash (`@cf/zai-org/glm-5.3-flash`), reasoning `low`, two posts at a time (about 10–15 a minute). Eval: 82% precision, 94% recall on the 150 labeled posts. About $0.0004 a post.
- **Categories (v3):** agent, agent-addon, agent-tools, agent-security, review-testing, memory-context, ide, cli, mcp-dev, mcp-general, other. "other" fell from 51% to about 1.4% of the queue.
- **Tags:** four groups (Works with, Models, Platform, Interface) in the `tags` setting; the classifier may only use these.
- **Secrets:** `GH_API_TOKEN` is set on the ingest Worker (GraphQL star snapshots).

## Decisions worth remembering

- **Phone-only owner.** Every operation is an admin action or a `workflow_dispatch` workflow. Confirm before running anything that spends money or deletes data.
- **Classifier:** GLM 5.3 Flash replaced Llama 3.3 (39% → about 80% precision). Every MCP server is in scope (`mcp-dev` / `mcp-general`), but a product that merely offers MCP is judged by its main purpose.
- **Threshold changes don't re-classify.** Status → Publish confident posts (or `ops.yml` → `publish-confident`) applies a lowered `review_threshold` to the queue from stored confidence, with the classify job's rule (`autoPublishes` in `packages/core/src/ops.ts`). Only model, reasoning, category, tag or few-shot changes need a re-classify.
- **Duplicate-URL reuse** needs the same classifier fingerprint (model, reasoning, prompt, categories, tags). Re-classify jobs are `force: true`.
- **Trending:** GitHub posts count as a source, but their stars aren't counted as upvotes; stars enter only as 7-day growth. Queued tools are scored too.
- **Tags:** Option C (four groups, Interface overlaps categories on purpose). Languages come from GitHub stats, not tags.
- **Deployed version:** `deploy.yml` tags each `sb-site` Worker version with the 12-character commit (`wrangler deploy --tag`); the admin footer reads it, the Cloudflare version ID and the upload time from the `version_metadata` binding. Versions uploaded another way show "Commit unknown".
- **UI:** Tailwind v4, Heroicons, Tailwind Plus Elements only when JS is needed. No React. The admin ships no JavaScript.
- **Naming:** Slop Bucket at slopbucket.app, `sb-*` resources, `@slop-bucket/*` packages.
- **Logo:** the round-3 pail pig (`docs/brand/logo-concepts/pail-pig-round-3/`): the lime variant on light pages, the dark variant in dark mode, and the lime favicon. Copies without the C2PA metadata are in `apps/site/public/`.
- **Brand token:** `brand-*` is lime for the admin too, so primary buttons use the lime fill with `lime-950` text (white on lime fails contrast).

## Gotchas

- **D1 LIKE limit:** production rejects LIKE patterns over 50 bytes, while local SQLite and tests don't. Use `instr()` or `substr()`.
- **Local sqlite3 CLI:** needs `PRAGMA trusted_schema=1` to run migrations that touch `tools`, because of the FTS triggers.
- **Local `wrangler login` token** expires about hourly; run `npx wrangler whoami` first. Long local evals can fail midway with 401. It can't reach the AI Gateway config, Observability or Access APIs; use `wrangler tail` for logs.
- **Evals:** `pnpm --filter @slop-bucket/ingest eval:classifier -- --reasoning=low [--rpm=10] [--categories=…] [--tags=file.json]`. Model, categories and tags default to production's settings. Run-to-run noise is about ±3 points of precision. Use a lower `--rpm` while production is classifying, since they share the model's 20 requests/minute.
- **Shared working tree:** other sessions edit this repo too. Commit and push often, and `git add` only your own paths.
- **Copilot reviews** every PR. The owner wants its findings checked and fixed where they make sense before merging.
- **GitHub search budget is per token:** 30 requests/minute shared by every fetch job, and the fetch queue runs two at once. The adapter paces each job to its share (`FETCH_CONCURRENCY` in `sources/github.ts`); a test fails if the fetch consumer's `max_concurrency` no longer matches it.
