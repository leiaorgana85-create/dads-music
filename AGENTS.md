# App change and release rules

Preserve working app behavior, data, authentication and publishing identity.

## Visible release version — mandatory

- The active frontend release is recorded in `version.json` and embedded in the running page's small `#appVersion` label. Keep the label in Settings; Notes uses the top right because it has no Settings screen.
- Every frontend release must increment the version using `YYYY.MM.DD.N` (release date in America/New_York; increment N for further releases that day), update the HTML data/visible label and worker version marker, and advance that app's existing cache version. Preserve older HTML compatibility. Spend's existing frontend field must match. Do not rename separately deployed backend/API or playback-engine versions to imply they were updated.
- Before publication run `node scripts/check-version.cjs` and the existing required checks. Verify the exact repository, production URL, current main and publishing mechanism; retired/preview copies do not count.
- After successful publication run `node scripts/check-version.cjs --live`. It must byte-match the canonical live HTML and worker (plus Spend's version-setting JS) to the tested source. A successful push or an uploaded artifact is not production verification. Record the source commit and successful Pages run.
- Report every release to the owner with app name, exact visible Version, production URL, live-verification result and any remaining device/backend limits. Do not say the installed device is current without seeing its label. The label denotes the running/cached release and must not claim online “latest” or device “verified” from a network metadata fetch.
- Update the Canonical Map current version register and private runbook. Preserve settings, data, downloads, app identity and authorization; no reinstall/reset/storage clearing to receive a version label.
