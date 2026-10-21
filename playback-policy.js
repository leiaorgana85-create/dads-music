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

  // iOS/WebKit can leave the audible media pipeline attached to the previous
  // Blob URL when tracks change quickly. app.js revokes the previous Blob URL
  // immediately before assigning the next one, which can produce the exact
  // failure where the next track's clock advances but no sound is heard.
  // Delay Blob cleanup and explicitly release the old media resource before
  // the replacement src is installed. This covers automatic next, manual Next,
  // Previous, shuffle transitions, and direct song selection.
  const nativeRevokeObjectURL = URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL = function guardedRevokeObjectURL(value) {
    if (typeof value === 'string' && value.startsWith('blob:')) {
      setTimeout(() => {
        try { nativeRevokeObjectURL(value); } catch {}
      }, 1500);
      return;
    }
    return nativeRevokeObjectURL(value);
  };

  const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
  if (srcDescriptor?.get && srcDescriptor?.set && srcDescriptor.configurable) {
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      configurable: srcDescriptor.configurable,
      enumerable: srcDescriptor.enumerable,
      get: srcDescriptor.get,
      set(value) {
        if (this === audio) {
          const existing = this.getAttribute('src');
          if (existing && value && existing !== value) {
            try { this.pause(); } catch {}
            try {
              this.removeAttribute('src');
              this.load();
            } catch {}
          }
        }
        return srcDescriptor.set.call(this, value);
      }
    });
  }

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
