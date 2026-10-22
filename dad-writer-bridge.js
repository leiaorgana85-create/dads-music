(() => {
  'use strict';

  const WRITER_URL = 'https://script.google.com/macros/s/AKfycbz_XRJcYb9_2bMZWeX9kDVJkbVxcjH-znPH0yHiUgGiJUXktPxCbClo3WLSLL1NvC5e/exec';
  const API_KEY_STORAGE = 'dadsMusicPublicApiKey';
  const WRITER_URL_KEY = 'dadsMusicWriterUrl';
  const WRITER_TOKEN_KEY = 'dadsMusicWriterToken';
  const WRITER_MARKER = 'bridge-v5';
  const CONFIG_TIMEOUT_MS = 12000;
  const WRITE_TIMEOUT_MS = 12000;

  let iframe = null;
  let nonce = '';
  let bridgeOrigin = '';
  let ready = false;
  let readyError = null;
  let readyWaiters = [];
  const pendingWrites = new Map();

  const nativeFetch = window.fetch.bind(window);

  function validApiKey(value) {
    return /^AIza[\w-]{20,}$/.test(String(value || '').trim());
  }

  function makeToken(bytes = 24) {
    const array = new Uint8Array(bytes);
    crypto.getRandomValues(array);
    return Array.from(array, value => value.toString(16).padStart(2, '0')).join('');
  }

  function allowedBridgeOrigin(origin) {
    try {
      const url = new URL(origin);
      return url.protocol === 'https:' && (
        url.hostname === 'script.google.com' ||
        url.hostname === 'script.googleusercontent.com' ||
        url.hostname.endsWith('.googleusercontent.com')
      );
    } catch {
      return false;
    }
  }

  function settleReady(error = null) {
    readyError = error;
    if (!error) ready = true;
    const waiters = readyWaiters;
    readyWaiters = [];
    for (const waiter of waiters) {
      if (error) waiter.reject(error);
      else waiter.resolve(true);
    }
  }

  function waitForReady(timeoutMs = CONFIG_TIMEOUT_MS) {
    if (ready) return Promise.resolve(true);
    if (readyError) return Promise.reject(readyError);
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      readyWaiters.push(entry);
      const timer = setTimeout(() => {
        const index = readyWaiters.indexOf(entry);
        if (index >= 0) readyWaiters.splice(index, 1);
        reject(new Error('Dad Music bridge config timeout'));
      }, timeoutMs);
      entry.resolve = value => { clearTimeout(timer); resolve(value); };
      entry.reject = error => { clearTimeout(timer); reject(error); };
    });
  }

  function ensureIframe() {
    if (iframe) return;
    nonce = makeToken(20);
    iframe = document.createElement('iframe');
    iframe.id = 'dadMusicWriterBridge';
    iframe.hidden = true;
    iframe.tabIndex = -1;
    iframe.setAttribute('aria-hidden', 'true');
    iframe.src = `${WRITER_URL}?mode=bridge&nonce=${encodeURIComponent(nonce)}&v=5&t=${Date.now()}`;
    iframe.addEventListener('error', () => {
      settleReady(new Error('Dad Music bridge failed to load'));
    }, { once: true });
    document.body.appendChild(iframe);
  }

  function enableSyncWhenSafe() {
    const button = document.getElementById('syncBtn');
    if (button && validApiKey(localStorage.getItem(API_KEY_STORAGE))) button.disabled = false;
  }

  function bootstrapExistingKey() {
    if (validApiKey(localStorage.getItem(API_KEY_STORAGE))) return;
    const shared = [
      localStorage.getItem('familyPlayersDriveApiKey'),
      localStorage.getItem('parentsPlayerPublicApiKey')
    ].map(value => String(value || '').trim()).find(validApiKey);
    if (shared) localStorage.setItem(API_KEY_STORAGE, shared);
  }

  function installSyncGate() {
    const button = document.getElementById('syncBtn');
    if (!button || validApiKey(localStorage.getItem(API_KEY_STORAGE))) return;
    button.disabled = true;
    setTimeout(() => {
      if (!ready) button.disabled = false;
    }, CONFIG_TIMEOUT_MS + 500);
  }

  function postReject(id) {
    return waitForReady().then(() => new Promise((resolve, reject) => {
      const requestId = makeToken(12);
      const timer = setTimeout(() => {
        pendingWrites.delete(requestId);
        reject(new Error('Dad Music rejection writer timeout'));
      }, WRITE_TIMEOUT_MS);

      pendingWrites.set(requestId, {
        id,
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); }
      });

      iframe.contentWindow.postMessage({
        type: 'dad-music-reject',
        nonce,
        requestId,
        id
      }, bridgeOrigin);
    }));
  }

  window.addEventListener('message', event => {
    if (!iframe || event.source !== iframe.contentWindow || !allowedBridgeOrigin(event.origin)) return;
    const data = event.data || {};

    if (data.type === 'dad-music-config' && data.nonce === nonce) {
      const key = String(data.apiKey || '').trim();
      if (!validApiKey(key)) {
        settleReady(new Error('Dad Music bridge returned invalid Drive config'));
        return;
      }
      bridgeOrigin = event.origin;
      localStorage.setItem(API_KEY_STORAGE, key);
      localStorage.setItem(WRITER_URL_KEY, WRITER_URL);
      localStorage.setItem(WRITER_TOKEN_KEY, WRITER_MARKER);
      settleReady();
      enableSyncWhenSafe();
      if (navigator.onLine) window.dispatchEvent(new Event('online'));
      return;
    }

    if (data.type === 'dad-music-config-error' && data.nonce === nonce) {
      settleReady(new Error('Dad Music bridge config unavailable'));
      return;
    }

    if (data.type === 'dad-music-reject-result' && data.nonce === nonce) {
      const requestId = String(data.requestId || '');
      const pending = pendingWrites.get(requestId);
      if (!pending || pending.id !== String(data.id || '')) return;
      pendingWrites.delete(requestId);
      if (data.ok) pending.resolve(true);
      else pending.reject(new Error('Dad Music rejection writer failed'));
    }
  });

  window.fetch = function(input, init = {}) {
    const url = typeof input === 'string' ? input : input?.url;
    const method = String(init?.method || (typeof input !== 'string' ? input?.method : '') || 'GET').toUpperCase();

    if (url === WRITER_URL && method === 'POST') {
      const params = init?.body instanceof URLSearchParams
        ? init.body
        : new URLSearchParams(String(init?.body || ''));
      if (params.get('token') === WRITER_MARKER) {
        const id = String(params.get('id') || '').trim();
        if (!id) return Promise.reject(new Error('Missing Drive file ID'));
        return postReject(id).then(() => new Response(null, { status: 204 }));
      }
    }
    return nativeFetch(input, init);
  };

  bootstrapExistingKey();
  installSyncGate();
  ensureIframe();

  window.DadsMusicBridge = Object.freeze({
    ensureReady: waitForReady,
    sendReject: postReject,
    get ready() { return ready; }
  });
})();
