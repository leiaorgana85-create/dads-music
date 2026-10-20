(() => {
  'use strict';

  const nowRow = document.querySelector('.now-row');
  const nowCopy = document.querySelector('.now-copy');
  const nowTitle = document.getElementById('nowTitle');
  const audio = document.getElementById('audio');
  if (!nowRow || !nowCopy || !audio) return;

  const style = document.createElement('style');
  style.textContent = `
    .now-row { align-items: center; }
    .now-artwork-wrap {
      width: 58px;
      height: 58px;
      flex: 0 0 58px;
      border-radius: 10px;
      overflow: hidden;
      border: 1px solid var(--border);
      background: var(--surface-2);
      display: grid;
      place-items: center;
    }
    .now-artwork { width: 100%; height: 100%; object-fit: cover; display: block; }
    .now-artwork-placeholder { color: #8d7d5b; font-size: 26px; line-height: 1; transform: translateY(-1px); }
    .now-artwork-wrap.no-art .now-artwork { display: none; }
    .now-artwork-wrap:not(.no-art) .now-artwork-placeholder { display: none; }
  `;
  document.head.appendChild(style);

  const artworkWrap = document.createElement('div');
  artworkWrap.id = 'nowArtworkWrap';
  artworkWrap.className = 'now-artwork-wrap no-art';
  artworkWrap.setAttribute('aria-hidden', 'true');

  const artwork = document.createElement('img');
  artwork.id = 'nowArtwork';
  artwork.className = 'now-artwork';
  artwork.alt = '';

  const placeholder = document.createElement('span');
  placeholder.className = 'now-artwork-placeholder';
  placeholder.textContent = '♪';

  artworkWrap.append(artwork, placeholder);
  nowRow.insertBefore(artworkWrap, nowCopy);

  let artworkUrl = null;
  let parsedSource = '';
  let pendingSource = '';
  let generation = 0;

  function releaseArtwork() {
    if (artworkUrl) URL.revokeObjectURL(artworkUrl);
    artworkUrl = null;
    artwork.removeAttribute('src');
    artworkWrap.classList.add('no-art');
  }

  function currentMediaText() {
    let metadata = null;
    try { metadata = navigator.mediaSession?.metadata || null; } catch {}
    return {
      title: metadata?.title || nowTitle?.textContent?.trim() || '',
      artist: metadata?.artist || '아빠 음악',
      album: metadata?.album || "Dad's Music"
    };
  }

  function syncMediaSessionArtwork(src = '') {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    const text = currentMediaText();
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        ...text,
        ...(src ? { artwork: [{ src }] } : {})
      });
    } catch {}
  }

  async function syncArtwork() {
    const src = audio.currentSrc || audio.src || '';
    if (!src || !window.MusicMetadata?.parse) {
      releaseArtwork();
      parsedSource = '';
      syncMediaSessionArtwork('');
      return;
    }
    if (src === parsedSource || src === pendingSource) return;

    const run = ++generation;
    pendingSource = src;
    releaseArtwork();

    try {
      const response = await fetch(src);
      if (!response.ok) throw new Error(`Artwork source read failed (${response.status})`);
      const blob = await response.blob();
      const metadata = await window.MusicMetadata.parse(blob, blob.type || '', true);
      if (run !== generation || src !== (audio.currentSrc || audio.src || '')) return;

      const embedded = metadata?.artwork;
      parsedSource = src;
      if (!embedded?.bytes?.length) {
        syncMediaSessionArtwork('');
        return;
      }

      artworkUrl = URL.createObjectURL(new Blob([embedded.bytes], { type: embedded.mime || 'image/jpeg' }));
      artwork.src = artworkUrl;
      artworkWrap.classList.remove('no-art');
      syncMediaSessionArtwork(artworkUrl);
    } catch (error) {
      if (run !== generation) return;
      parsedSource = src;
      releaseArtwork();
      syncMediaSessionArtwork('');
      console.warn('Now Playing artwork unavailable', error);
    } finally {
      if (pendingSource === src) pendingSource = '';
    }
  }

  artwork.addEventListener('error', () => {
    releaseArtwork();
    syncMediaSessionArtwork('');
  });

  audio.addEventListener('loadstart', () => {
    generation += 1;
    pendingSource = '';
    parsedSource = '';
    releaseArtwork();
  });
  audio.addEventListener('loadedmetadata', syncArtwork);
  audio.addEventListener('play', syncArtwork);

  window.addEventListener('pagehide', releaseArtwork, { once: true });
})();