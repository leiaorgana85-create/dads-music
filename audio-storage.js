(() => {
  'use strict';

  const AUDIO_DB_NAME = 'dads-music-audio-db';
  const AUDIO_DB_VERSION = 1;
  const AUDIO_STORE = 'audio';
  let audioDb = null;

  function requestPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB 요청에 실패했습니다.'));
    });
  }

  function transactionPromise(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB 저장에 실패했습니다.'));
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB 작업이 취소되었습니다.'));
    });
  }

  function normalizeRow(row) {
    if (!row || typeof row !== 'object') return row;
    const audio = row.blob;
    if (audio?.__bytes instanceof ArrayBuffer) {
      return { ...row, blob: new Blob([audio.__bytes], { type: audio.type || 'audio/mpeg' }) };
    }
    return row;
  }

  function audioValueSize(value) {
    const audio = value?.blob ?? value;
    if (!audio) return 0;
    if (audio.__bytes instanceof ArrayBuffer) return audio.__bytes.byteLength;
    if (audio instanceof ArrayBuffer) return audio.byteLength;
    if (ArrayBuffer.isView(audio)) return audio.byteLength;
    if (typeof Blob !== 'undefined' && audio instanceof Blob) return audio.size;
    return 0;
  }

  function openAudioDb() {
    if (audioDb) return Promise.resolve(audioDb);
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(AUDIO_DB_NAME, AUDIO_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(AUDIO_STORE)) db.createObjectStore(AUDIO_STORE, { keyPath: 'id' });
      };
      request.onsuccess = () => {
        const connection = request.result;
        audioDb = connection;
        connection.onversionchange = () => {
          connection.close();
          if (audioDb === connection) audioDb = null;
        };
        resolve(connection);
      };
      request.onerror = () => reject(request.error || new Error('오프라인 오디오 저장공간을 열지 못했습니다.'));
      request.onblocked = () => reject(new Error('다른 아빠 음악 창을 닫고 다시 시도해 주세요.'));
    });
  }

  async function audioRequest(mode, makeRequest) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const db = await openAudioDb();
        const transaction = db.transaction(AUDIO_STORE, mode);
        const committed = transactionPromise(transaction);
        const request = makeRequest(transaction.objectStore(AUDIO_STORE));
        const [result] = await Promise.all([requestPromise(request), committed]);
        return result;
      } catch (error) {
        const name = String(error?.name || '');
        const message = String(error?.message || '');
        const recoverable = (
          name === 'InvalidStateError' && /connection is (closing|closed)|database connection is (closing|closed)|not ready/i.test(message)
        ) || (
          name === 'UnknownError' && /indexed database server|connection to indexed database server lost/i.test(message)
        );
        if (attempt === 0 && recoverable) {
          try { audioDb?.close(); } catch {}
          audioDb = null;
          await new Promise(resolve => setTimeout(resolve, 0));
          continue;
        }
        throw error;
      }
    }
    throw new Error('오프라인 오디오 저장 요청에 실패했습니다.');
  }

  function deleteDatabaseByName(name) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error || new Error(`${name} 삭제에 실패했습니다.`));
      request.onblocked = () => reject(new Error(`${name}이 다른 아빠 음악 창에서 사용 중입니다.`));
    });
  }

  async function getAll() {
    return audioRequest('readonly', store => store.getAll());
  }

  async function get(key) {
    return audioRequest('readonly', store => store.get(key));
  }

  async function put(value) {
    return audioRequest('readwrite', store => store.put(normalizeRow(value)));
  }

  async function deleteKey(id) {
    return audioRequest('readwrite', store => store.delete(id));
  }

  async function readStats() {
    const rows = await getAll();
    return {
      count: rows.filter(row => audioValueSize(row) > 0).length,
      bytes: rows.reduce((sum, row) => sum + audioValueSize(row), 0)
    };
  }

  async function deleteDatabase() {
    try { audioDb?.close(); } catch {}
    audioDb = null;
    await deleteDatabaseByName(AUDIO_DB_NAME);
    await openAudioDb();
    return readStats();
  }

  const ready = openAudioDb();

  window.DadsMusicAudioStorage = {
    databaseName: AUDIO_DB_NAME,
    storeName: AUDIO_STORE,
    ready,
    getAll,
    get,
    put,
    deleteKey,
    readStats,
    deleteDatabase
  };
})();
