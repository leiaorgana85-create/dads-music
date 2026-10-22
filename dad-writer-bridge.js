(() => {
  'use strict';
  const WRITER_URL = 'https://script.google.com/macros/s/AKfycbz_XRJcYb9_2bMZWeX9kDVJkbVxcjH-znPH0yHiUgGiJUXktPxCbClo3WLSLL1NvC5e/exec';
  const API_KEY_STORAGE = 'dadsMusicPublicApiKey';
  const PARENT_ORIGIN = location.origin;
  const pending = new Map();
  let frame = null;
  let bridgeWindow = null;
  let bridgeOrigin = '';
  let nonce = '';
  let readyPromise = null;
  let readyAt = 0;
  let settle = null;
  let timer = null;
  const token = () => Array.from(crypto.getRandomValues(new Uint8Array(20)), x => x.toString(16).padStart(2, '0')).join('');
  function allowed(origin) {
    try {
      const u = new URL(origin);
      return u.protocol === 'https:' && (u.hostname === 'script.google.com' || u.hostname === 'script.googleusercontent.com' || u.hostname.endsWith('-script.googleusercontent.com'));
    } catch { return false; }
  }
  function reset() {
    clearTimeout(timer);
    frame?.remove();
    frame = null;
    bridgeWindow = null;
    bridgeOrigin = '';
    readyPromise = null;
    readyAt = 0;
    settle = null;
    for (const entry of pending.values()) entry.reject(new Error('연결이 갱신되었습니다. 업데이트를 다시 눌러 주세요.'));
    pending.clear();
  }
  function startBridge() {
    // Renew before the server's 10-minute session expiry; offline playback needs no bridge.
    if (readyAt && Date.now() - readyAt > 8 * 60 * 1000) reset();
    if (readyPromise) return readyPromise;
    if (!navigator.onLine) return Promise.reject(new Error('인터넷에 연결한 후 다시 시도해 주세요.'));
    nonce = token();
    readyPromise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    frame = document.createElement('iframe');
    frame.hidden = true;
    frame.tabIndex = -1;
    frame.setAttribute('aria-hidden', 'true');
    frame.src = WRITER_URL + '?mode=bridge&nonce=' + encodeURIComponent(nonce);
    document.body.appendChild(frame);
    timer = setTimeout(() => {
      const waiter = settle;
      reset();
      waiter?.reject(new Error('제외 기록 연결 시간이 초과되었습니다. 업데이트를 다시 눌러 주세요.'));
    }, 30000);
    return readyPromise;
  }
  async function ensureReady() {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try { return await startBridge(); }
      catch (error) {
        if (!navigator.onLine || attempt === 1) throw error;
      }
    }
  }
  window.addEventListener('message', event => {
    const data = event.data;
    // HtmlService code runs in a descendant sandbox, not the outer iframe window.
    // Bind the first valid response to its exact source, nonce and Google origin.
    if (!frame || !allowed(event.origin) || !data || data.nonce !== nonce) return;
    if (data.type === 'dad-music-config' && settle) {
      const key = String(data.apiKey || '').trim();
      if (data.version !== 6 || data.folderId !== '1c7Dj_Dnysp8YSIO4QQqUJ-fLA4nbqTec' || !/^AIza[\w-]{20,}$/.test(key) || !event.source) return;
      bridgeWindow = event.source;
      bridgeOrigin = event.origin;
      localStorage.setItem(API_KEY_STORAGE, key);
      clearTimeout(timer);
      readyAt = Date.now();
      const waiter = settle;
      settle = null;
      waiter.resolve(true);
    } else if (data.type === 'dad-music-config-error' && settle) {
      const waiter = settle;
      reset();
      waiter.reject(new Error('제외 기록 설정을 불러오지 못했습니다.'));
    } else if (data.type === 'dad-music-reject-result' && event.source === bridgeWindow && event.origin === bridgeOrigin) {
      const entry = pending.get(String(data.requestId || ''));
      if (!entry || data.id !== entry.id) return;
      pending.delete(data.requestId);
      if (data.ok === true) entry.resolve(true);
      else {
        entry.reject(new Error('제외 기록 전송을 확인하지 못했습니다. 다음 업데이트 때 다시 시도합니다.'));
        reset();
      }
    }
  });
  async function sendReject(id) {
    await ensureReady();
    const requestId = token();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error('제외 기록 전송 시간이 초과되었습니다.'));
        reset();
      }, 30000);
      pending.set(requestId, { id,
        resolve: value => { clearTimeout(timeout); resolve(value); },
        reject: error => { clearTimeout(timeout); reject(error); }
      });
      bridgeWindow.postMessage({ type: 'dad-music-reject', nonce, requestId, id }, bridgeOrigin);
    });
  }
  // Reuse previously configured reads without modifying any sibling app's settings.
  if (!localStorage.getItem(API_KEY_STORAGE)) {
    for (const key of ['familyPlayersDriveApiKey', 'parentsPlayerPublicApiKey']) {
      const value = localStorage.getItem(key) || '';
      if (/^AIza[\w-]{20,}$/.test(value)) { localStorage.setItem(API_KEY_STORAGE, value); break; }
    }
  }
  window.DadsMusicBridge = Object.freeze({ ensureReady, sendReject, get ready() { return !!bridgeWindow; } });
})();
