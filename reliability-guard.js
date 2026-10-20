(() => {
  'use strict';

  const MAIN_DB_NAME = 'dads-music-db';
  const LIBRARY_STORE = 'library';
  const REJECTED_KEY = 'dadsMusicRejectedLocal';
  const syncBtn = document.getElementById('syncBtn');
  const deleteBtn = document.getElementById('deleteOfflineBtn');
  const audio = document.getElementById('audio');
  const statusTitle = document.getElementById('statusTitle');
  const statusDetail = document.getElementById('statusDetail');
  const storage = window.DadsMusicAudioStorage;
  const nativeStoreDelete = IDBObjectStore.prototype.delete;
  const pendingLibraryDeletes = new Set();

  let deleteBarrier = false;
  let deleteComplete = false;
  let syncWasActiveAtDelete = false;
  let syncDisabledBeforeDelete = false;
  let rejectionBusy = false;
  let activeRejectId = null;
  let syncDisabledBeforeRejection = false;
  let verifyingRejection = false;
  let pendingSync = false;
  const queuedRejectIds = [];

  function syncIsActive() {
    return String(syncBtn?.textContent || '').includes('업데이트 중');
  }

  function maybeReleaseDeleteBarrier() {
    if (!deleteComplete || (syncWasActiveAtDelete && syncIsActive())) return;
    deleteBarrier = false;
    deleteComplete = false;
    if (syncBtn && !rejectionBusy) syncBtn.disabled = syncWasActiveAtDelete ? false : syncDisabledBeforeDelete;
    syncWasActiveAtDelete = false;
  }

  function waitTransaction(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Library deletion failed.'));
      transaction.onabort = () => reject(transaction.error || new Error('Library deletion was cancelled.'));
    });
  }

  function openMainDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(MAIN_DB_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open the local music library.'));
      request.onblocked = () => reject(new Error('The local music library is open in another app window.'));
    });
  }

  async function commitLibraryDelete(id, force = false) {
    const key = String(id || '');
    if (!key || (!force && !pendingLibraryDeletes.has(key))) return;

    const db = await openMainDb();
    try {
      if (!db.objectStoreNames.contains(LIBRARY_STORE)) {
        pendingLibraryDeletes.delete(key);
        return;
      }
      const transaction = db.transaction(LIBRARY_STORE, 'readwrite');
      nativeStoreDelete.call(transaction.objectStore(LIBRARY_STORE), key);
      await waitTransaction(transaction);
      pendingLibraryDeletes.delete(key);
    } finally {
      db.close();
    }
  }

  async function commitIfAudioGone(id) {
    if (!storage?.get) return;
    const remaining = await storage.get(id);
    if (!remaining) await commitLibraryDelete(id, true);
  }

  // Stage library-row deletion until the separate audio row is proven gone.
  // This covers both Drive reconciliation (library first) and rejection
  // cleanup (audio first) without leaving an inaccessible audio blob behind.
  IDBObjectStore.prototype.delete = function guardedDelete(key) {
    if (this.transaction?.db?.name === MAIN_DB_NAME && this.name === LIBRARY_STORE) {
      const id = String(key || '');
      pendingLibraryDeletes.add(id);
      queueMicrotask(() => commitIfAudioGone(id).catch(() => {}));
      return this.get(key);
    }
    return nativeStoreDelete.call(this, key);
  };

  if (storage?.put && storage?.deleteDatabase) {
    const originalPut = storage.put.bind(storage);
    const originalDeleteDatabase = storage.deleteDatabase.bind(storage);
    const originalDeleteKey = storage.deleteKey?.bind(storage);
    const originalGet = storage.get?.bind(storage);

    storage.put = async value => {
      if (deleteBarrier) throw new DOMException('Offline-audio update cancelled by Delete All.', 'AbortError');
      return originalPut(value);
    };

    if (originalDeleteKey && originalGet) {
      storage.deleteKey = async id => {
        let lastError = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            await originalDeleteKey(id);
            const remaining = await originalGet(id);
            if (!remaining) {
              await commitLibraryDelete(id, true);
              return;
            }
            lastError = new Error('Deleted audio row is still present.');
          } catch (error) {
            lastError = error;
          }
          await new Promise(resolve => setTimeout(resolve, 60 * (attempt + 1)));
        }
        throw lastError || new Error('Could not verify song audio deletion.');
      };
    }

    storage.deleteDatabase = async (...args) => {
      deleteBarrier = true;
      deleteComplete = false;
      if (syncBtn) syncBtn.disabled = true;
      try {
        return await originalDeleteDatabase(...args);
      } finally {
        deleteComplete = true;
        maybeReleaseDeleteBarrier();
      }
    };
  }

  async function cleanupRejectedAudio() {
    if (!storage?.ready || !storage?.deleteKey) return;
    await storage.ready;
    let rows = [];
    try {
      const parsed = JSON.parse(localStorage.getItem(REJECTED_KEY) || '[]');
      rows = Array.isArray(parsed) ? parsed : [];
    } catch {}

    for (const row of rows) {
      const id = String(row?.id || '');
      if (!id) continue;
      try {
        const remaining = await storage.get(id);
        if (remaining) await storage.deleteKey(id);
        else await commitLibraryDelete(id, true);
      } catch (error) {
        console.warn('Rejected-song cleanup remains pending', id, error);
      }
    }
  }

  deleteBtn?.addEventListener('click', () => {
    syncWasActiveAtDelete = syncIsActive();
    syncDisabledBeforeDelete = !!syncBtn?.disabled;
    deleteBarrier = true;
    queueMicrotask(() => {
      if (!deleteBtn.disabled) {
        deleteBarrier = false;
        syncWasActiveAtDelete = false;
        return;
      }
      if (syncBtn) syncBtn.disabled = true;
    });
  }, true);

  function hasBalancedCsvQuotes(text) {
    let quoted = false;
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] !== '"') continue;
      if (quoted && text[i + 1] === '"') {
        i += 1;
        continue;
      }
      quoted = !quoted;
    }
    return !quoted;
  }

  const originalResponseText = Response.prototype.text;
  Response.prototype.text = async function patchedText() {
    const text = await originalResponseText.call(this);
    if (
      /googleapis\.com\/drive\/v3\/files\//.test(String(this.url || '')) &&
      text.includes('Rejected At') &&
      text.includes('Drive File ID') &&
      !hasBalancedCsvQuotes(text)
    ) {
      throw new Error('Malformed rejection ledger: unterminated quoted field.');
    }
    return text;
  };

  function replayNextRejection() {
    if (rejectionBusy || syncIsActive() || !queuedRejectIds.length) return;
    const id = queuedRejectIds.shift();
    const row = [...document.querySelectorAll('.track-row')].find(item => item.dataset.id === id);
    const button = row?.querySelector('.reject-btn');
    if (button) queueMicrotask(() => button.click());
    else replayNextRejection();
  }

  function finishRejection() {
    if (!rejectionBusy) return;
    rejectionBusy = false;
    activeRejectId = null;
    if (syncBtn && !deleteBarrier && !syncIsActive()) syncBtn.disabled = syncDisabledBeforeRejection;
    if (pendingSync && syncBtn && !deleteBarrier && !syncIsActive()) {
      pendingSync = false;
      queueMicrotask(() => syncBtn.click());
      return;
    }
    replayNextRejection();
  }

  async function verifyRejectedAudioGone() {
    if (verifyingRejection || !rejectionBusy) return;
    verifyingRejection = true;
    const id = activeRejectId;
    try {
      if (id && storage?.get && storage?.deleteKey) {
        let remaining;
        try {
          remaining = await storage.get(id);
        } catch (error) {
          if (statusTitle) statusTitle.textContent = '오디오 삭제를 확인하지 못했습니다';
          if (statusDetail) statusDetail.textContent = error?.message || '휴대폰 오디오 삭제 상태를 확인할 수 없습니다.';
          return;
        }
        for (let attempt = 0; remaining && attempt < 2; attempt += 1) {
          try { await storage.deleteKey(id); } catch {}
          try { remaining = await storage.get(id); } catch { break; }
        }
        if (remaining) {
          if (statusTitle) statusTitle.textContent = '오디오 삭제를 확인하지 못했습니다';
          if (statusDetail) statusDetail.textContent = '이 노래의 휴대폰 오디오가 남아 있어 삭제 완료로 처리하지 않았습니다.';
        } else {
          await commitLibraryDelete(id, true).catch(() => {});
        }
      }
    } finally {
      verifyingRejection = false;
      finishRejection();
    }
  }

  document.addEventListener('click', event => {
    const button = event.target.closest?.('.reject-btn');
    if (!button) return;
    const id = button.closest('.track-row')?.dataset.id;

    if (syncIsActive() || rejectionBusy) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (id && !queuedRejectIds.includes(id)) queuedRejectIds.push(id);
      return;
    }

    rejectionBusy = true;
    activeRejectId = id || null;
    syncDisabledBeforeRejection = !!syncBtn?.disabled;
    if (syncBtn) syncBtn.disabled = true;
  }, true);

  syncBtn?.addEventListener('click', event => {
    if (!rejectionBusy) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    pendingSync = true;
  }, true);

  const originalConfirm = window.confirm.bind(window);
  window.confirm = message => {
    const rejectionPrompt = String(message || '').includes('목록에서 뺄까요?');
    const result = originalConfirm(message);
    if (rejectionPrompt && !result) queueMicrotask(finishRejection);
    return result;
  };

  if (statusTitle) {
    new MutationObserver(() => {
      if (statusTitle.textContent.trim() === '이 노래를 뺐습니다') verifyRejectedAudioGone();
    }).observe(statusTitle, { childList: true, subtree: true, characterData: true });
  }

  if (syncBtn) {
    new MutationObserver(() => {
      maybeReleaseDeleteBarrier();
      if (!syncIsActive()) replayNextRejection();
    }).observe(syncBtn, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled']
    });
  }

  audio?.addEventListener('ended', () => {
    setTimeout(() => {
      const rows = document.querySelectorAll('.track-row');
      const repeatMode = localStorage.getItem('dadsMusicRepeatMode') || 'all';
      const storedShuffle = localStorage.getItem('dadsMusicShuffle');
      const shuffleEnabled = storedShuffle == null ? true : storedShuffle === '1';
      if (rows.length !== 1 || repeatMode !== 'all' || !shuffleEnabled) return;
      rows[0].querySelector('.track-main')?.click();
    }, 0);
  });

  storage?.ready?.then(cleanupRejectedAudio).catch(() => {});
  window.addEventListener('pageshow', () => cleanupRejectedAudio().catch(() => {}));
})();
