-- 0012: trending penalty for tools whose GitHub repo is under the star floor
-- (`github_min_stars`, by the latest repo snapshot; a repo with no snapshot counts as
-- under, as for review routing). The trending job multiplies such a tool's score by
-- `low_star`, so they sink in the ranking. 1 turns the penalty off.
UPDATE settings SET value = json_set(value, '$.low_star', 0.5) WHERE key = 'trending_weights';
