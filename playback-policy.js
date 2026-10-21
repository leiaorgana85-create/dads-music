(() => {
  'use strict';

  const audio = document.getElementById('audio');
  if (!audio) return;

  const POSITION_KEY = 'dadsMusicPositions';
  try { localStorage.removeItem(POSITION_KEY); } catch {}

  // Dad's Music is a music player, not a resume-position player. Keep the
  // legacy player core from persisting or restoring per-file positions.
  const originalGetItem = Storage.prototype.getItem;
  const originalSetItem = Storage.prototype.setItem;
  Storage.prototype.getItem = function patchedGetItem(key) {
    if (this === localStorage && String(key) === POSITION_KEY) return null;
    return originalGetItem.call(this, key);
  };
  Storage.prototype.setItem = function patchedSetItem(key, value) {
    if (this === localStorage && String(key) === POSITION_KEY) return;
    return originalSetItem.call(this, key, value);
  };

  // Loading/selecting a track must start at 0:00. Pause/play on the currently
  // loaded track is unaffected because it does not reload metadata.
  audio.addEventListener('loadedmetadata', () => {
    setTimeout(() => {
      try {
        if (audio.currentTime !== 0) audio.currentTime = 0;
      } catch {}
    }, 0);
  });
})();
