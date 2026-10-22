(() => {
  'use strict';

  const player = document.getElementById('player');
  const nowRow = player?.querySelector('.now-row');
  const audio = document.getElementById('audio');
  const prevBtn = document.getElementById('prevBtn');
  const playBtn = document.getElementById('playBtn');
  const nextBtn = document.getElementById('nextBtn');
  if (!player || !nowRow || !audio || player.dataset.fullscreenNowPlaying === '1') return;
  player.dataset.fullscreenNowPlaying = '1';

  const style = document.createElement('style');
  style.id = 'fullscreenNowPlayingStyles';
  style.textContent = `
    .player:not(.expanded) .now-row { cursor: pointer; }
    .now-playing-close {
      display: none;
      position: absolute;
      z-index: 3;
      top: calc(env(safe-area-inset-top) + 10px);
      left: 14px;
      width: 48px;
      height: 48px;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: transparent;
      color: var(--text);
      place-items: center;
    }
    .now-playing-close svg { width: 30px; height: 30px; display: block; fill: none; stroke: currentColor; stroke-width: 2.1; stroke-linecap: round; stroke-linejoin: round; }
    body.now-playing-expanded { overflow: hidden; }
    .player.expanded {
      z-index: 200;
      inset: 0;
      height: 100dvh;
      min-height: 0;
      max-width: none;
      overflow: hidden;
      padding: calc(env(safe-area-inset-top) + 58px) 22px calc(env(safe-area-inset-bottom) + 18px);
      background: #0d0d0e;
      border: 0;
      box-shadow: none;
      backdrop-filter: none;
      display: grid;
      grid-template-rows: minmax(0, 1fr) 36px 24px 92px;
      align-items: stretch;
    }
    .player.expanded .now-playing-close { display: grid; }
    .player.expanded .now-row {
      width: min(520px, 100%);
      height: 100%;
      min-height: 0;
      margin: 0 auto;
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: minmax(0, 1fr) 92px 52px;
      align-items: center;
      justify-items: stretch;
      gap: 0;
      cursor: default;
      position: relative;
    }
    .player.expanded .now-artwork-wrap {
      width: min(82vw, 42dvh, 340px);
      height: min(82vw, 42dvh, 340px);
      flex: none;
      margin: 0;
      align-self: center;
      justify-self: auto;
      position: relative;
      left: 50%;
      transform: translateX(-50%);
      border-radius: 18px;
      box-shadow: 0 18px 46px rgba(0,0,0,.34);
    }
    .player.expanded .now-artwork { object-position: 50% 50%; }
    .player.expanded .now-artwork-placeholder { font-size: 64px; }
    .player.expanded .now-copy {
      width: 100%;
      height: 92px;
      min-width: 0;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      text-align: center;
      overflow: hidden;
    }
    .player.expanded .now-title {
      width: 100%;
      max-height: none;
      font-size: clamp(22px, 6vw, 29px);
      line-height: 1.18;
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      overflow: hidden;
    }
    .player.expanded .now-title::before { font-size: 11px; margin-bottom: 5px; }
    .player.expanded .now-status {
      width: 100%;
      margin-top: 6px;
      font-size: 13px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .player.expanded .player-options {
      height: 52px;
      display: flex;
      align-items: center;
      justify-content: center;
      justify-self: center;
      gap: 10px;
    }
    .player.expanded .repeat-btn {
      min-width: 92px;
      min-height: 42px;
      padding: 8px 14px;
      font-size: 13px;
    }
    .player.expanded .seek-wrap,
    .player.expanded .controls { width: min(520px, 100%); }
    .player.expanded .seek-wrap { margin: 0 auto; align-self: center; }
    .player.expanded .seek { margin: 0; }
    .player.expanded .seek-times { margin-top: 2px; font-size: 12px; }
    .player.expanded .controls {
      height: 92px;
      margin: 0 auto;
      display: grid;
      grid-template-columns: 76px 86px 76px;
      column-gap: 18px;
      align-items: center;
      justify-content: center;
    }
    .player.expanded .control-btn {
      width: 72px;
      height: 72px;
    }
    .player.expanded .skip-icon { width: 31px; height: 28px; }
    .player.expanded .skip-bar { top: 4px; bottom: 4px; width: 3px; }
    .player.expanded .skip-triangle { top: 4px; border-top-width: 10px; border-bottom-width: 10px; }
    .player.expanded .skip-prev .skip-bar { left: 2px; }
    .player.expanded .skip-prev .skip-triangle { left: 8px; border-right-width: 17px; }
    .player.expanded .skip-next .skip-bar { right: 2px; }
    .player.expanded .skip-next .skip-triangle { right: 8px; border-left-width: 17px; }
    .player.expanded .play-btn {
      width: 84px;
      height: 84px;
    }
    .player.expanded .play-btn[data-state="play"]::before {
      border-top-width: 11px;
      border-bottom-width: 11px;
      border-left-width: 18px;
    }
    .player.expanded .play-btn[data-state="pause"]::before,
    .player.expanded .play-btn[data-state="pause"]::after {
      width: 5px;
      height: 24px;
    }
    .player.expanded .play-btn[data-state="pause"]::before { left: calc(50% - 8px); }
    .player.expanded .play-btn[data-state="pause"]::after { right: calc(50% - 8px); }
    @media (max-height: 680px) {
      .player.expanded {
        padding-top: calc(env(safe-area-inset-top) + 50px);
        grid-template-rows: minmax(0, 1fr) 32px 22px 80px;
      }
      .player.expanded .now-row { grid-template-rows: minmax(0, 1fr) 78px 46px; }
      .player.expanded .now-artwork-wrap { width: min(68vw, 34dvh, 270px); height: min(68vw, 34dvh, 270px); }
      .player.expanded .now-copy { height: 78px; }
      .player.expanded .player-options { height: 46px; }
      .player.expanded .controls { height: 80px; }
      .player.expanded .control-btn { width: 66px; height: 66px; }
      .player.expanded .play-btn { width: 76px; height: 76px; }
    }
  `;
  document.head.appendChild(style);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'now-playing-close';
  closeBtn.setAttribute('aria-label', '전체 화면 닫기');
  closeBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 9 7 7 7-7"></path></svg>';
  player.prepend(closeBtn);

  function openFullscreen() {
    if (player.classList.contains('hidden') || player.classList.contains('expanded')) return;
    player.classList.add('expanded');
    document.body.classList.add('now-playing-expanded');
  }

  function closeFullscreen() {
    player.classList.remove('expanded');
    document.body.classList.remove('now-playing-expanded');
  }

  nowRow.addEventListener('click', event => {
    if (player.classList.contains('expanded')) return;
    if (event.target.closest('button, input, a, [role="button"]')) return;
    openFullscreen();
  });
  closeBtn.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    closeFullscreen();
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeFullscreen(); });

  const observer = new MutationObserver(() => {
    if (player.classList.contains('hidden') && player.classList.contains('expanded')) closeFullscreen();
  });
  observer.observe(player, { attributes: true, attributeFilter: ['class'] });
})();
