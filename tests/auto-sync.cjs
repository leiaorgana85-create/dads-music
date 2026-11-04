// Exercise the production auto-sync scheduler without a device or Google API key.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const code = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const match = code.match(/  function autoSyncIfDue\(force = false\) \{[\s\S]*?\n  \}/);
assert(match, 'production scheduler must exist');
let clock = 1_000_000, syncCount = 0;
const ctx = {
  db: {}, operationBusy: false, lastAutoSyncAttempt: 0,
  AUTO_SYNC_INTERVAL_MS: 15 * 60 * 1000,
  navigator: { onLine: true },
  document: { visibilityState: 'visible' },
  els: { audio: { paused: true } },
  Date: { now: () => clock },
  syncLibrary: () => { syncCount += 1; }
};
vm.runInNewContext(match[0] + '; this.invoke = autoSyncIfDue;', ctx);
ctx.invoke(); assert.equal(syncCount, 1, 'syncs on first eligible opening');
ctx.invoke(); assert.equal(syncCount, 1, 'debounces repeated events');
clock += ctx.AUTO_SYNC_INTERVAL_MS + 1;
ctx.operationBusy = true; ctx.invoke(); assert.equal(syncCount, 1, 'does not overlap mutations');
ctx.operationBusy = false;
ctx.navigator.onLine = false; ctx.invoke(true); assert.equal(syncCount, 1, 'offline is safe');
ctx.navigator.onLine = true;
ctx.document.visibilityState = 'hidden'; ctx.invoke(true); assert.equal(syncCount, 1, 'background is safe');
ctx.document.visibilityState = 'visible';
ctx.els.audio.paused = false; ctx.invoke(true); assert.equal(syncCount, 1, 'playing is uninterrupted');
ctx.els.audio.paused = true;
ctx.invoke(); assert.equal(syncCount, 2, 'syncs after interval when idle');
ctx.invoke(true); assert.equal(syncCount, 3, 'reconnect can force update');
assert.match(code, /window\.addEventListener\('online',[\s\S]*?autoSyncIfDue\(true\)/, 'reconnect listener');
assert.match(code, /document\.addEventListener\('visibilitychange'/, 'foreground listener');
assert.match(code, /setInterval\(\(\) => autoSyncIfDue\(\), AUTO_SYNC_INTERVAL_MS\)/, 'periodic check');
assert.match(code, /async function boot\(\)[\s\S]*?autoSyncIfDue\(true\)/, 'boot triggers refresh');
console.log('PASS auto-sync startup, reconnect, foreground, interval, throttle, offline/playing/lock guards');
