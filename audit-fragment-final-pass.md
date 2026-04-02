# Audit Fragment — Final Pass

Repo: `/Users/treygoff/Development/agent-context-kit`
Date: 2026-04-01

## What this final pass did

- Read the available audit fragments supplied for README, guide, and summary coverage.
- Re-read the live `README.md`, `AGENT-BUILD-GUIDE.md`, `SUMMARY.md`, and relevant `src/` files to sanity-check unresolved claims.
- Wrote a consolidated `AUDIT.md` covering all verified inaccuracies surfaced by the available fragment set, the fixes applied, the AGENT-BUILD-GUIDE filename/path mismatch note, limits/ambiguities, and a confidence assessment.

## Extra fixes needed in this pass

Yes — a few obvious inaccuracies still remained in the live docs after the chunk auditors' patches.

### Additional fixes applied directly in this pass

1. **README.md**
   - Removed an unused `computeArtifactId` import from the Artifact Storage snippet.
   - Rewrote the Artifact Storage layout section from legacy `.jsonl`-envelope wording to the current `.body` + `.meta.json` format with legacy `.jsonl` read compatibility noted.
   - Changed the context-guard comment from stale clearing `oldest first` to `lowest-priority first`.

2. **AGENT-BUILD-GUIDE.md**
   - Changed the artifact-backed read recovery example path from `.jsonl` to `.body`.

## Missing expected fragment files

These expected files were not present when this pass ran:
- `audit-fragment-readme-2.md`
- `audit-fragment-guide-6.md`

## Outcome

- Additional fixes beyond the chunk auditors: **yes**.
- `AUDIT.md` written: **yes**.
- I did not find further obvious live source/doc mismatches after those final edits.
