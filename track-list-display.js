(() => {
  'use strict';

  const SEPARATOR = ' - ';

  function splitDisplayName(value) {
    const text = String(value || '').trim();
    const separatorIndex = text.indexOf(SEPARATOR);
    if (separatorIndex <= 0) return null;

    const artist = text.slice(0, separatorIndex).trim();
    const song = text.slice(separatorIndex + SEPARATOR.length).trim();
    return artist && song ? { artist, song } : null;
  }

  function installStyles() {
    if (document.getElementById('dad-track-display-styles')) return;
    const style = document.createElement('style');
    style.id = 'dad-track-display-styles';
    style.textContent = `
      .track-artist {
        display: block;
        margin-top: 1px;
        color: var(--muted);
        font-size: 12px;
        font-weight: 500;
        line-height: 1.3;
        word-break: keep-all;
        overflow-wrap: anywhere;
      }
      .track-row.playing .track-artist {
        color: var(--gold-text);
        opacity: .72;
      }
    `;
    document.head.appendChild(style);
  }

  function enhanceTrackTitles(root) {
    root.querySelectorAll('.track-title:not([data-artist-split])').forEach(title => {
      title.dataset.artistSplit = '1';
      const parsed = splitDisplayName(title.textContent);
      if (!parsed) return;

      title.textContent = parsed.song;
      const artist = document.createElement('span');
      artist.className = 'track-artist';
      artist.textContent = parsed.artist;
      title.insertAdjacentElement('afterend', artist);
    });
  }

  function boot() {
    installStyles();
    const trackList = document.getElementById('trackList');
    if (!trackList) return;

    enhanceTrackTitles(trackList);
    new MutationObserver(() => enhanceTrackTitles(trackList)).observe(trackList, {
      childList: true,
      subtree: true
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
