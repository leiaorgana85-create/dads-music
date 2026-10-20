(() => {
  'use strict';

  const audio = document.getElementById('audio');

  function preserveDirectTrackControls() {
    if (!('mediaSession' in navigator) || !audio) return;
    for (const action of ['seekbackward', 'seekforward', 'seekto']) {
      try { navigator.mediaSession.setActionHandler(action, null); } catch {}
    }
  }

  window.addEventListener('load', preserveDirectTrackControls);
  window.addEventListener('pageshow', preserveDirectTrackControls);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) preserveDirectTrackControls();
  });
  audio?.addEventListener('playing', preserveDirectTrackControls);
  setTimeout(preserveDirectTrackControls, 0);
  setTimeout(preserveDirectTrackControls, 500);
})();
