# The daily steward routine

Claude runs this once a day, unattended. The aim is a Metyu that stays healthy and honest and gets a little better each day, without ever taking risks the owner did not choose. The hard rules in `CLAUDE.md` come first.

## 1. Look (always)
1. Fetch the published state:
   ```bash
   git fetch origin autopilot-data main
   mkdir -p /tmp/metyu-state
   for f in status.json exchange-status.json account-public.json; do git show origin/autopilot-data:$f > /tmp/metyu-state/$f; done
   ```
2. Run the three scripts on it:
   - `node scripts/daily-report.js /tmp/metyu-state`
   - `node scripts/watchdog.js /tmp/metyu-state`
   - `node scripts/preflight-live.js /tmp/metyu-state` (real-money preflight: exit 1 means order code, a secret or a sent shadow order appeared; fix that first)
3. Check the scheduler: in the last 24 h, the `autopilot` workflow should have about 96 successful runs (one every 15 minutes). Fewer means cron-job.org or its token has a problem. Tell the owner; the owner fixes it.

## 2. Fix (only when something is wrong)
Fix things in this order:
1. A failing tick, a failing workflow or a red test on `main`.
2. Stale data, or an external API that changed (Coinbase, Kraken, Jupiter, Polymarket). Check the provider's changelog, then add a fallback, as with `api.jup.ag` and the Data API v2.
3. A board error: a failed request, a page error or a layout overflow.

For each fix:
- **Root cause first:** reproduce the failure, then show the same check passing.
- **One PR per fix**, merged after green CI. Then trigger `autopilot.yml` once and check the next published state.

## 3. Improve (at most one small change a day, and only when steps 1–2 are clean)
Good candidates, in order:
1. **Tests** for something untested.
2. **Robustness:** time-outs, fallbacks, input validation.
3. **Board clarity**, checked on the iPhone viewport.
4. **Research-backed honesty in the statistics.** Always verify with a dry run on the live state.

Not without the owner:
- anything about real money;
- loosening the evidence gate or the risk rules;
- new paid services;
- big redesigns.

**Strategies:** new strategy ideas may be *tested* in a scratch folder. They join the engine only through the same gate as the others (2 years of data, weekly blocks, multiple testing). Report the result honestly, especially when it fails.

**The weekly strategy lab (automatic).** The agent runs `metyu-lab.js` every week with the history test. It shows on the board, in the log (`LAB`) and in the daily report. When the report lists a **NEW CANDIDATE**, this is the day's Improve step:
1. Add it to the engine in a branch (a strategy entry, a test, `familySize` = strategies × 2).
2. Run the dry run on the live state with a forced retrain (`model.trainedAt = 0`) and read the candidate's gate in both tiers.
3. Proven to lose in either tier (its 95% interval entirely below zero), or clearly negative in both: do not add it. Record it in `metyu-lab.js` `REJECTED` and in `research/README.md`.
4. Otherwise add it as a learning candidate: a PR with the dry-run numbers, merged after green CI. Record it in `ENGINE`.
5. Report it either way. The lab never adopts anything by itself, and the gate is never loosened for a candidate.

## 4. Report (always)
End with a short report in Turkish for the owner:
- the daily report numbers;
- what was fixed or improved, with PR links;
- what needs the owner. Usually nothing. Otherwise one clear step, with a link.

No silence when something is wrong, and no noise when everything is fine: then say so in one line.

## Limits
- At most 3 PRs a day.
- Stop and report instead of guessing when a fix would touch real money, secrets, the gate or the risk rules.
- If a step fails 3 times, write down why and move on.
