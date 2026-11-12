# App change and release rules

Preserve working app behavior, data, authentication and publishing identity.

## Visible release version — mandatory

- The active frontend release is recorded in `version.json` and embedded in the running page's small `#appVersion` label. Keep the label in Settings; Notes uses the top right because it has no Settings screen.
- Every frontend release must increment the version using `vX.xx` (for example `v1.00`, then `v1.01`, `v1.02`; use `v2.00` for a major release), update the HTML data/visible label and worker version marker, and advance that app's existing cache version. Preserve older HTML compatibility. Spend's existing frontend field must match. Do not rename separately deployed backend/API or playback-engine versions to imply they were updated.
- Before publication run `node scripts/check-version.cjs` and the existing required checks. Verify the exact repository, production URL, current main and publishing mechanism; retired/preview copies do not count.
- After successful publication run `node scripts/check-version.cjs --live`. It must byte-match the canonical live HTML and worker (plus Spend's version-setting JS) to the tested source. A successful push or an uploaded artifact is not production verification. Record the source commit and successful Pages run.
- Report every release to the owner with app name, exact visible version (for example v1.00), production URL, live-verification result and any remaining device/backend limits. Do not say the installed device is current without seeing its label. The label denotes the running/cached release and must not claim online “latest” or device “verified” from a network metadata fetch.
- Update the Canonical Map current version register and private runbook. Preserve settings, data, downloads, app identity and authorization; no reinstall/reset/storage clearing to receive a version label.

## Canonical source and anti-patchwork release policy (owner: 2026-11-12)

This policy applies to every Lexi app and its backend, not just this repository.

- **One code authority:** the reviewed, tested source in this app's canonical GitHub repository. Include Apps Script `appsscript.json` and every source/HTML file in version control. Never create independent production-only changes in the Apps Script editor or live Pages that are missing from GitHub.
- **No patchwork:** reconcile contradictory implementations and data contracts into one complete, coherent change; preserve previously accepted behavior and resolve all discrepancies before deployment. Prefer complete files and tests over isolated pasted fragments.
- **Two distinct release gates:** (1) source/tests on the exact commit; (2) deployed source/version and observed behavior in the real app. A passing GitHub Action or edited Apps Script file alone is not a live release.
- **Drift is a release blocker:** compare the live editor project to the approved source (file inventory and exact content/hash) before making further changes. If different, identify why and reconcile without silent overwrites or a blind copy.
- **One active production endpoint:** track the actual deployment ID and URL; coordinate frontend references and backend version together. A former endpoint can remain temporarily for verified rollback but is not a second production authority.
- **Protect user state:** never rotate credentials, clear browser storage/outbox, mutate production data with synthetic test entries, remove existing features or change app identity as part of a sync fix. Keep secrets in private project configuration, never commit them.
- **Completion proof:** record source commit, passing checks, exact deployed version/endpoint, and post-release behavior evidence. Report unverified steps explicitly; do not describe a staged or unverified change as deployed.
