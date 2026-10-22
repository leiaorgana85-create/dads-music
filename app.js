(() => {
  'use strict';

  const DEFAULT_CLIENT_ID = '';
  const DEFAULT_FOLDER_ID = '1c7Dj_Dnysp8YSIO4QQqUJ-fLA4nbqTec';
  const DRIVE_SCOPES = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file';
  const DB_NAME = 'dads-music-db';
  const DB_VERSION = 1;
  const SETTINGS_KEY = 'dadsMusicSettings';
  const POSITION_KEY = 'dadsMusicPositions';
  const REPEAT_KEY = 'dadsMusicRepeatMode';
  const SHUFFLE_KEY = 'dadsMusicShuffle';
  const REJECTED_KEY = 'dadsMusicRejectedLocal';
  const LEDGER_NAME = 'REJECTED_SONGS.csv';
  const SUPPORTED_MIMES = new Set(['audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/flac', 'audio/x-flac', 'audio/wav', 'audio/x-wav']);

  const els = Object.fromEntries([
    'syncBtn','settingsBtn','statusTitle','statusDetail','trackCount','trackList','emptyState','player','nowTitle','nowStatus',
    'shuffleBtn','repeatBtn','seek','timeCurrent','timeTotal','prevBtn','playBtn','nextBtn','audio',
    'settingsDialog','clientIdInput','folderIdInput','offlineStats','storageEstimate','driveStorageStatus','rejectedStats',
    'deleteOfflineBtn','factoryResetBtn','storageResult','saveSettingsBtn'
  ].map(id => [id, document.getElementById(id)]));

  let db = null;
  let library = [];
  let audioRows = new Map();
  let currentId = null;
  let currentUrl = null;
  let accessToken = null;
  let tokenClient = null;
  let seekDragging = false;
  let operationBusy = false;
  let playbackGeneration = 0;
  let settings = loadSettings();
  let repeatMode = normalizeRepeat(localStorage.getItem(REPEAT_KEY) || 'all');
  const storedShuffle = localStorage.getItem(SHUFFLE_KEY);
  let shuffleEnabled = storedShuffle == null ? true : storedShuffle === '1';
  let shuffleBag = null;
  let playbackHistory = [];
  let historyCursor = -1;

  function normalizeRepeat(value) {
    return value === 'off' || value === 'one' ? value : 'all';
  }

  function loadSettings() {
    try {
      return {
        clientId: DEFAULT_CLIENT_ID,
        folderId: DEFAULT_FOLDER_ID,
        ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')
      };
    } catch {
      return { clientId: DEFAULT_CLIENT_ID, folderId: DEFAULT_FOLDER_ID };
    }
  }

  function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  function cleanTitle(name = '') {
    return name.replace(/\.(mp3|m4a|aac|flac|wav)$/i, '').trim();
  }

  function fmtBytes(n) {
    const x = Number(n || 0);
    if (x <= 0) return '0 MB';
    if (x >= 1024 ** 3) return `${(x / 1024 ** 3).toFixed(2)} GB`;
    if (x >= 1024 ** 2) return `${(x / 1024 ** 2).toFixed(1)} MB`;
    return `${Math.round(x / 1024)} KB`;
  }

  function fmtTime(seconds) {
    const s = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  }

  // New track selections always start at zero; pause/play keeps the loaded position.
  function removePosition() { localStorage.removeItem(POSITION_KEY); }

  async function runOperation(action) {
    if (operationBusy) return;
    operationBusy = true;
    els.deleteOfflineBtn.disabled = true;
    els.syncBtn.disabled = true;
    els.saveSettingsBtn.disabled = true;
    if (els.factoryResetBtn) els.factoryResetBtn.disabled = true;
    const run = async () => {
      await audioStorage().ready;
      if (!db) db = await openDb();
      await reloadLocal();
      return action();
    };
    try {
      // Also serialize separate tabs of this app, without locking sibling apps.
      if (navigator.locks?.request) return await navigator.locks.request(DB_NAME + '-mutation', run);
      return await run();
    } catch (error) {
      console.error(error);
      try { await reloadLocal(); } catch {}
      updateStatus('작업을 완료하지 못했습니다', error.message || '다시 시도해 주세요.');
    } finally {
      operationBusy = false;
      els.deleteOfflineBtn.disabled = false;
      els.syncBtn.disabled = false;
      els.saveSettingsBtn.disabled = false;
      if (els.factoryResetBtn) els.factoryResetBtn.disabled = false;
    }
  }

  async function removeLocalTrack(id) {
    if (currentId === id) stopPlayer();
    await dbDelete('audio', id);
    if (await audioStorage().get(id)) throw new Error('오디오 삭제를 확인하지 못했습니다. 다시 시도해 주세요.');
    audioRows.delete(id);
    // Metadata stays recoverable until the separate audio deletion is verified.
    await dbDelete('library', id);
    removePosition(id);
  }

  async function resumeAudio() {
    const generation = playbackGeneration;
    try { await els.audio.play(); }
    catch (error) {
      if (generation !== playbackGeneration || error.name === 'AbortError') return;
      updateStatus('재생하지 못했습니다', '재생 버튼을 다시 눌러 주세요. ' + (error.message || ''));
    }
  }

  function loadRejected() {
    try {
      const rows = JSON.parse(localStorage.getItem(REJECTED_KEY) || '[]');
      return Array.isArray(rows) ? rows.filter(row => row?.id) : [];
    } catch { return []; }
  }

  function saveRejected(rows) {
    const byId = new Map();
    for (const row of rows || []) {
      if (!row?.id) continue;
      const existing = byId.get(row.id);
      if (!existing || String(row.rejectedAt || '') < String(existing.rejectedAt || '')) byId.set(row.id, row);
    }
    localStorage.setItem(REJECTED_KEY, JSON.stringify([...byId.values()]));
  }

  function rejectedMap() {
    return new Map(loadRejected().map(row => [row.id, row]));
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const idb = req.result;
        if (!idb.objectStoreNames.contains('library')) idb.createObjectStore('library', { keyPath: 'id' });
      };
      req.onsuccess = () => {
        const connection = req.result;
        connection.onversionchange = () => { connection.close(); if (db === connection) db = null; };
        resolve(connection);
      };
      req.onblocked = () => reject(new Error('다른 앱 창을 닫고 다시 시도해 주세요.'));
      req.onerror = () => reject(req.error);
    });
  }

  function reqP(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function isRecoverableDbError(error) {
    const name = String(error?.name || '');
    const message = String(error?.message || '');
    return (name === 'InvalidStateError' && /connection is (closing|closed)|database connection is (closing|closed)/i.test(message)) ||
      (name === 'UnknownError' && /indexed database server|connection to indexed database server lost/i.test(message));
  }

  async function reopenDb() {
    try { db?.close(); } catch {}
    db = null;
    await new Promise(resolve => setTimeout(resolve, 0));
    db = await openDb();
    return db;
  }

  async function dbRequest(store, mode, makeRequest) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        if (!db) db = await openDb();
        const transaction = db.transaction(store, mode);
        const committed = new Promise((resolve, reject) => {
          transaction.oncomplete = resolve;
          transaction.onabort = () => reject(transaction.error || new Error('저장 작업이 취소되었습니다.'));
          transaction.onerror = () => reject(transaction.error || new Error('저장하지 못했습니다.'));
        });
        const [result] = await Promise.all([reqP(makeRequest(transaction.objectStore(store))), committed]);
        return result;
      } catch (error) {
        if (attempt === 0 && isRecoverableDbError(error)) {
          await reopenDb();
          continue;
        }
        throw error;
      }
    }
    throw new Error('IndexedDB 요청에 실패했습니다.');
  }

  function audioStorage() {
    if (!window.DadsMusicAudioStorage) throw new Error('오프라인 오디오 저장 모듈을 불러오지 못했습니다.');
    return window.DadsMusicAudioStorage;
  }

  async function dbGetAll(store) {
    if (store === 'audio') {
      const storage = audioStorage();
      await storage.ready;
      return storage.getAll();
    }
    return dbRequest(store, 'readonly', objectStore => objectStore.getAll());
  }

  async function dbPut(store, value) {
    if (store === 'audio') {
      const storage = audioStorage();
      await storage.ready;
      return storage.put(value);
    }
    return dbRequest(store, 'readwrite', objectStore => objectStore.put(value));
  }

  async function dbDelete(store, key) {
    if (store === 'audio') {
      const storage = audioStorage();
      await storage.ready;
      return storage.deleteKey(key);
    }
    return dbRequest(store, 'readwrite', objectStore => objectStore.delete(key));
  }

  function audioValueSize(value) {
    if (!value) return 0;
    if (value.__bytes instanceof ArrayBuffer) return value.__bytes.byteLength;
    if (value instanceof ArrayBuffer) return value.byteLength;
    if (ArrayBuffer.isView(value)) return value.byteLength;
    if (typeof Blob !== 'undefined' && value instanceof Blob) return value.size;
    return 0;
  }

  function audioValueToUrl(value) {
    if (value?.__bytes instanceof ArrayBuffer) return URL.createObjectURL(new Blob([value.__bytes], { type: value.type || 'audio/mpeg' }));
    return URL.createObjectURL(value);
  }

  async function responseToAudioValue(response) {
    return response.blob();
  }

  function rowIsCurrent(track, row) {
    if (!track || !row?.blob) return false;
    const actual = audioValueSize(row.blob);
    const expected = Number(track.size || 0);
    if (actual <= 0) return false;
    if (expected > 0 && actual !== expected) return false;
    if (track.modifiedTime && track.modifiedTime !== row.modifiedTime) return false;
    return true;
  }

  function resetShuffleBag() {
    shuffleBag = null;
  }

  async function reloadLocal() {
    const rejected = rejectedMap();
    for (const id of rejected.keys()) await removeLocalTrack(id);
    library = (await dbGetAll('library')).filter(track => !rejected.has(track.id));
    library.sort((a, b) => String(a.name).localeCompare(String(b.name), 'ko'));
    const rows = await dbGetAll('audio');
    audioRows = new Map(rows.map(row => [row.id, row]));
    playbackHistory = playbackHistory.filter(id => library.some(track => track.id === id));
    historyCursor = playbackHistory.length - 1;
    resetShuffleBag();
    render();
    updateStatus();
    updateOfflineStats();
  }

  function totalOfflineBytes() {
    return library.reduce((sum, track) => sum + (rowIsCurrent(track, audioRows.get(track.id)) ? audioValueSize(audioRows.get(track.id).blob) : 0), 0);
  }

  function currentOfflineCount() {
    return library.filter(track => rowIsCurrent(track, audioRows.get(track.id))).length;
  }

  function storedAudioCount() {
    return [...audioRows.values()].filter(row => audioValueSize(row?.blob) > 0).length;
  }

  function storedAudioBytes() {
    return [...audioRows.values()].reduce((sum, row) => sum + audioValueSize(row?.blob), 0);
  }

  function updateOfflineStats() {
    if (els.offlineStats) els.offlineStats.textContent = `${storedAudioCount()}개 · ${fmtBytes(storedAudioBytes())}`;
    if (els.rejectedStats) els.rejectedStats.textContent = `${loadRejected().length}개`;
  }

  async function updateStorageEstimate() {
    if (!els.storageEstimate) return;
    els.storageEstimate.textContent = '계산 중…';
    try {
      const estimate = await navigator.storage?.estimate?.();
      els.storageEstimate.textContent = estimate && Number.isFinite(estimate.usage) ? fmtBytes(estimate.usage) : '확인 불가';
    } catch { els.storageEstimate.textContent = '확인 불가'; }
  }

  async function updateSettingsStatus() {
    updateOfflineStats();
    await updateStorageEstimate();
    if (els.driveStorageStatus) {
      if (!navigator.onLine) els.driveStorageStatus.textContent = '오프라인';
      else if (accessToken) els.driveStorageStatus.textContent = 'API 키 저장됨';
      else els.driveStorageStatus.textContent = settings.clientId ? '설정됨' : 'OAuth 설정 필요';
    }
  }

  function updateStatus(title, detail) {
    const offline = currentOfflineCount();
    const total = library.length;
    els.statusTitle.textContent = title || (total ? (offline === total ? '오프라인 재생 준비 완료' : '다운로드가 필요합니다') : '저장된 음악이 없습니다');
    els.statusDetail.textContent = detail != null
      ? detail
      : total ? `${offline}/${total}개 저장됨 · ${fmtBytes(totalOfflineBytes())}` : '음악 업데이트를 눌러 Google Drive에서 받아오세요.';
  }

  function render() {
    els.trackCount.textContent = `${library.length}개`;
    els.emptyState.classList.toggle('hidden', library.length > 0);
    els.trackList.innerHTML = '';

    library.forEach((track, index) => {
      const row = document.createElement('div');
      row.className = 'track-row';
      row.dataset.id = track.id;
      if (track.id === currentId) row.classList.add('playing');

      const number = document.createElement('div');
      number.className = 'track-number';
      number.textContent = track.id === currentId ? '▶' : String(index + 1);

      const main = document.createElement('button');
      main.className = 'track-main';
      main.type = 'button';
      const title = document.createElement('span');
      title.className = 'track-title';
      title.textContent = cleanTitle(track.name);
      const meta = document.createElement('span');
      meta.className = 'track-meta';
      const audioRow = audioRows.get(track.id);
      const saved = rowIsCurrent(track, audioRow);
      const stale = !saved && !!audioRow?.blob;
      meta.textContent = saved ? '오프라인 저장됨' : stale ? '업데이트 필요' : '다운로드 필요';
      main.append(title, meta);
      main.addEventListener('click', () => playTrack(track.id));

      const mark = document.createElement('div');
      mark.className = 'offline-mark';
      mark.textContent = saved ? '✓' : stale ? '!' : '↓';

      const reject = document.createElement('button');
      reject.className = 'reject-btn';
      reject.type = 'button';
      reject.textContent = '빼기';
      reject.setAttribute('aria-label', `${cleanTitle(track.name)} 목록에서 빼기`);
      reject.addEventListener('click', event => {
        event.stopPropagation();
        rejectTrack(track.id);
      });

      row.append(number, main, mark, reject);
      els.trackList.appendChild(row);
    });
  }

  async function loadGoogleIdentity() {
    if (window.google?.accounts?.oauth2) return;
    if (!navigator.onLine) throw new Error('인터넷에 연결한 후 다시 시도하세요.');
    await new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-google-identity]');
      if (existing) {
        existing.addEventListener('load', resolve, { once: true });
        existing.addEventListener('error', reject, { once: true });
        return;
      }
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.dataset.googleIdentity = '1';
      script.onload = resolve;
      script.onerror = () => reject(new Error('Google 로그인 기능을 불러오지 못했습니다.'));
      document.head.appendChild(script);
    });
  }

  async function ensureToken(interactive = true) {
    if (accessToken) return accessToken;
    if (!settings.clientId) throw new Error('Google OAuth Client ID 설정이 필요합니다.');
    await loadGoogleIdentity();
    return new Promise((resolve, reject) => {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: settings.clientId,
        scope: DRIVE_SCOPES,
        callback: response => {
          if (response.error) return reject(new Error(response.error_description || response.error));
          accessToken = response.access_token;
          resolve(accessToken);
        },
        error_callback: err => reject(new Error(err?.message || 'Google Drive 연결이 필요합니다.'))
      });
      tokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' });
    });
  }

  async function driveFetch(url, options = {}) {
    const token = await ensureToken(false).catch(() => ensureToken(true));
    let response = await fetch(url, { ...options, signal: AbortSignal.timeout(90000), cache: 'no-store', headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` } });
    if (response.status === 401) {
      accessToken = null;
      const fresh = await ensureToken(true);
      response = await fetch(url, { ...options, signal: AbortSignal.timeout(90000), cache: 'no-store', headers: { ...(options.headers || {}), Authorization: `Bearer ${fresh}` } });
    }
    if (!response.ok) {
      let message = '';
      try { message = (await response.json())?.error?.message || ''; } catch {}
      throw new Error(message || `Google Drive 오류 (${response.status})`);
    }
    return response;
  }

  async function listDriveFolder() {
    const folderId = settings.folderId || DEFAULT_FOLDER_ID;
    const files = [];
    let pageToken = '';
    const seenPages = new Set();
    do {
      const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
      const fields = encodeURIComponent('nextPageToken,incompleteSearch,files(id,name,mimeType,size,createdTime,modifiedTime,appProperties)');
      const page = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
      const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=1000&orderBy=name${page}`;
      const json = await (await driveFetch(url)).json();
      if (json.incompleteSearch || !Array.isArray(json.files) || json.files.some(file => !file.id || typeof file.name !== 'string')) {
        throw new Error('Drive 목록이 불완전합니다. 저장된 파일을 유지했습니다.');
      }
      files.push(...json.files);
      pageToken = json.nextPageToken || '';
      if (pageToken && seenPages.has(pageToken)) throw new Error('Drive 페이지를 확인하지 못했습니다.');
      seenPages.add(pageToken);
    } while (pageToken);
    return files;
  }

  function isAudioFile(file) {
    return SUPPORTED_MIMES.has(file.mimeType) || /\.(mp3|m4a|aac|flac|wav)$/i.test(file.name || '');
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    const source = String(text || '').replace(/^\uFEFF/, '');
    for (let i = 0; i < source.length; i++) {
      const ch = source[i];
      if (quoted) {
        if (ch === '"' && source[i + 1] === '"') { field += '"'; i += 1; }
        else if (ch === '"') quoted = false;
        else field += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
      else field += ch;
    }
    if (quoted) throw new Error('Malformed rejection ledger: unterminated quoted field.');
    if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
    return rows;
  }

  function csvCell(value) {
    return `"${String(value ?? '').replaceAll('"', '""')}"`;
  }

  function serializeRejectedCsv(rows) {
    const sorted = [...rows].sort((a, b) => String(a.rejectedAt || '').localeCompare(String(b.rejectedAt || '')));
    const lines = [['Rejected At', 'Song', 'Drive File ID'], ...sorted.map(row => [row.rejectedAt || '', row.name || '', row.id])];
    return `\uFEFF${lines.map(line => line.map(csvCell).join(',')).join('\r\n')}\r\n`;
  }

  async function readRemoteRejected(files) {
    const ledgers = files.filter(file => file.name === LEDGER_NAME);
    const byId = new Map();
    for (const ledger of ledgers) {
      try {
        const text = await (await driveFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(ledger.id)}?alt=media`)).text();
        const parsed = parseCsv(text);
        const header = parsed[0] || [];
        if (header.length !== 3 || header[0] !== 'Rejected At' || header[1] !== 'Song' || header[2] !== 'Drive File ID') {
          throw new Error('Unexpected rejection-ledger header');
        }
        for (const fields of parsed.slice(1)) {
          if (fields.length === 1 && fields[0] === '') continue;
          if (fields.length !== 3 || !fields[2]) throw new Error('Unexpected rejection-ledger row');
          const [rejectedAt, name, id] = fields;
          if (!byId.has(id)) byId.set(id, { id, name: name || '', rejectedAt: rejectedAt || '' });
        }
      } catch (error) {
        console.warn('Rejected-song ledger read failed', ledger.id, error);
        throw new Error('Google Drive의 제외 목록을 안전하게 읽지 못했습니다. 기존 음악과 제외 기록은 그대로 유지했습니다.');
      }
    }
    return { rows: [...byId.values()], ledgerId: ledgers[0]?.id || null };
  }

  async function createLedgerFile(rows) {
    const metadata = {
      name: LEDGER_NAME,
      parents: [settings.folderId || DEFAULT_FOLDER_ID],
      mimeType: 'text/csv',
      appProperties: { owner: 'dads-music', kind: 'rejected-songs' }
    };
    const boundary = `dads_music_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const csv = serializeRejectedCsv(rows);
    const body = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(metadata),
      `--${boundary}`,
      'Content-Type: text/csv; charset=UTF-8',
      '',
      csv,
      `--${boundary}--`,
      ''
    ].join('\r\n');
    const response = await driveFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body
    });
    const file = await response.json();
    if (!file?.id) throw new Error('Google Drive 제외 목록을 만들지 못했습니다.');
    return file.id;
  }

  async function writeLedgerFile(fileId, rows) {
    const body = serializeRejectedCsv(rows);
    await driveFetch(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'text/csv; charset=UTF-8' },
      body
    });
  }

  async function syncRejectedLedger(files) {
    const remote = await readRemoteRejected(files);
    const merged = new Map(remote.rows.map(row => [row.id, row]));
    for (const row of loadRejected()) {
      const existing = merged.get(row.id);
      if (!existing || !existing.rejectedAt) merged.set(row.id, row);
    }
    const rows = [...merged.values()];
    saveRejected(rows);
    if (!rows.length) return new Map();
    let ledgerId = remote.ledgerId;
    if (!ledgerId) ledgerId = await createLedgerFile(rows);
    else await writeLedgerFile(ledgerId, rows);
    return new Map(rows.map(row => [row.id, row]));
  }

  async function downloadTrack(track) {
    const oldRow = audioRows.get(track.id) || null;
    const response = await driveFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(track.id)}?alt=media`);
    const blob = await responseToAudioValue(response);
    const actual = audioValueSize(blob);
    const expected = Number(track.size || 0);
    if (actual <= 0 || (expected > 0 && actual !== expected)) {
      if (oldRow) audioRows.set(track.id, oldRow);
      throw new Error(`${cleanTitle(track.name)} 다운로드 확인에 실패했습니다. 기존 저장본은 유지했습니다.`);
    }
    const row = { id: track.id, blob, modifiedTime: track.modifiedTime || null };
    await dbPut('audio', row);
    audioRows.set(track.id, row);
  }

  async function syncLibrary() {
    return runOperation(syncLibraryNow);
  }

  async function syncLibraryNow() {
    if (!navigator.onLine) return updateStatus('오프라인 상태입니다');
    els.syncBtn.disabled = true;
    els.syncBtn.textContent = '업데이트 중…';
    try {
      updateStatus('Google Drive 확인 중…', '새 음악과 제외한 노래 목록을 확인합니다.');
      const files = await listDriveFolder();
      const rawAudio = files.filter(isAudioFile);
      if (!rawAudio.length) throw new Error('Drive에서 음악 파일을 찾지 못했습니다. 기존 오프라인 음악은 그대로 유지했습니다.');

      const rejected = await syncRejectedLedger(files);
      const incoming = rawAudio.filter(file => !rejected.has(file.id));
      const incomingIds = new Set(incoming.map(file => file.id));
      const oldById = new Map(library.map(track => [track.id, track]));

      for (const old of library) {
        if (!incomingIds.has(old.id)) {
          await removeLocalTrack(old.id);
        }
      }

      for (const file of incoming) {
        const old = oldById.get(file.id);
        const track = {
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          size: Number(file.size || 0),
          createdTime: file.createdTime || old?.createdTime || null,
          modifiedTime: file.modifiedTime || old?.modifiedTime || null
        };
        await dbPut('library', track);
      }

      await reloadLocal();
      const needsDownload = library.filter(track => !rowIsCurrent(track, audioRows.get(track.id)));
      if (navigator.storage?.persist) { try { await navigator.storage.persist(); } catch {} }

      const failures = [];
      for (let i = 0; i < needsDownload.length; i++) {
        const track = needsDownload[i];
        updateStatus(`다운로드 중 ${i + 1}/${needsDownload.length}`, cleanTitle(track.name));
        try { await downloadTrack(track); } catch (error) { failures.push(error.message || cleanTitle(track.name)); }
        render();
        updateOfflineStats();
      }

      await reloadLocal();
      if (failures.length) throw new Error(`${failures.length}개 다운로드 실패 · 업데이트를 다시 누르면 이어서 받습니다. ${failures[0]}`);
      updateStatus('모든 음악이 최신 상태입니다', `${library.length}개 준비됨 · 제외한 노래 ${loadRejected().length}개`);
    } catch (error) {
      console.error(error);
      updateStatus('업데이트하지 못했습니다', error.message || '다시 시도해 주세요.');
    } finally {
      els.syncBtn.textContent = '음악 업데이트';
    }
  }

  async function rejectTrack(id) {
    return runOperation(() => rejectTrackNow(id));
  }

  async function rejectTrackNow(id) {
    const track = library.find(item => item.id === id);
    if (!track) return;
    const confirmed = confirm(`“${cleanTitle(track.name)}”을 목록에서 뺄까요?\n\n휴대폰에서 삭제되고 다음 음악 업데이트에서도 다시 받지 않습니다.`);
    if (!confirmed) return;

    const rows = loadRejected();
    if (!rows.some(row => row.id === id)) rows.push({ id, name: track.name, rejectedAt: new Date().toISOString() });
    saveRejected(rows);

    await removeLocalTrack(id);
    await reloadLocal();

    if (!navigator.onLine) {
      updateStatus('이 노래를 뺐습니다', '다음 음악 업데이트 때 Google Drive의 제외 목록에 기록합니다.');
      return;
    }

    try {
      const files = await listDriveFolder();
      await syncRejectedLedger(files);
      updateStatus('이 노래를 뺐습니다', 'Google Drive의 REJECTED_SONGS.csv에도 기록했습니다.');
    } catch (error) {
      console.warn(error);
      updateStatus('이 노래를 뺐습니다', '휴대폰에서는 제거했습니다. 다음 음악 업데이트 때 Drive 기록을 다시 시도합니다.');
    }
  }

  function repeatLabel() {
    if (repeatMode === 'one') return '↻ 1곡';
    if (repeatMode === 'all') return '↻ 전체';
    return '↻ 끔';
  }

  function updateRepeatButton() {
    els.repeatBtn.textContent = repeatLabel();
    els.repeatBtn.dataset.mode = repeatMode;
    const label = repeatMode === 'one' ? '한 곡 반복' : repeatMode === 'all' ? '전체 반복' : '반복 끔';
    els.repeatBtn.setAttribute('aria-label', label);
  }

  function cycleRepeat() {
    repeatMode = repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off';
    localStorage.setItem(REPEAT_KEY, repeatMode);
    updateRepeatButton();
    updateNowStatus();
  }

  function updateShuffleButton() {
    els.shuffleBtn.classList.toggle('active', shuffleEnabled);
    els.shuffleBtn.textContent = shuffleEnabled ? '셔플 켬' : '셔플';
    els.shuffleBtn.setAttribute('aria-pressed', shuffleEnabled ? 'true' : 'false');
  }

  function toggleShuffle() {
    shuffleEnabled = !shuffleEnabled;
    localStorage.setItem(SHUFFLE_KEY, shuffleEnabled ? '1' : '0');
    resetShuffleBag();
    updateShuffleButton();
    updateNowStatus();
  }

  function updateNowStatus(stale = null) {
    if (!currentId) return;
    const track = library.find(item => item.id === currentId);
    const row = audioRows.get(currentId);
    const isStale = stale == null ? !rowIsCurrent(track, row) : stale;
    const repeat = repeatMode === 'one' ? '한 곡 반복' : repeatMode === 'all' ? '전체 반복' : '반복 끔';
    els.nowStatus.textContent = `${shuffleEnabled ? '셔플 켬' : '순서 재생'} · ${repeat}${isStale ? ' · 저장된 이전 파일' : ' · 오프라인 재생'}`;
  }

  function stopPlayer() {
    playbackGeneration += 1;
    els.audio.onloadedmetadata = null;
    try { els.audio.pause(); } catch {}
    els.audio.removeAttribute('src');
    try { els.audio.load(); } catch {}
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    currentUrl = null;
    currentId = null;
    els.player.classList.add('hidden');
    els.nowTitle.textContent = '—';
    els.nowStatus.textContent = '—';
    els.timeCurrent.textContent = '0:00';
    els.timeTotal.textContent = '0:00';
    els.seek.value = 0;
    render();
  }

  function recordHistory(id) {
    if (historyCursor < playbackHistory.length - 1) playbackHistory = playbackHistory.slice(0, historyCursor + 1);
    if (playbackHistory[playbackHistory.length - 1] !== id) playbackHistory.push(id);
    historyCursor = playbackHistory.length - 1;
  }

  async function playTrack(id, options = {}) {
    const track = library.find(item => item.id === id);
    if (!track) return;
    const row = audioRows.get(id);
    if (!row?.blob) return updateStatus('아직 다운로드되지 않았습니다', '음악 업데이트를 눌러 오프라인 파일을 받아오세요.');

    const previousUrl = currentUrl;
    if (options.recordHistory !== false) recordHistory(id);

    const stale = !rowIsCurrent(track, row);
    currentId = id;
    currentUrl = audioValueToUrl(row.blob);
    els.audio.src = currentUrl;
    try { els.audio.currentTime = 0; } catch {}
    els.audio.playbackRate = 1;
    els.nowTitle.textContent = cleanTitle(track.name);
    els.player.classList.remove('hidden');
    updateNowStatus(stale);
    render();

    const generation = ++playbackGeneration;
    els.audio.onloadedmetadata = () => {
      if (generation !== playbackGeneration) return;
      els.timeTotal.textContent = fmtTime(els.audio.duration);
      updateSeek();
      updateMediaPosition();
    };
    // Start inside the tap/ended handler, rather than waiting for metadata.
    // Replacing src starts a fresh resource at 0:00; pause/play does not reload it.
    resumeAudio();
    if (previousUrl) URL.revokeObjectURL(previousUrl);

    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({ title: cleanTitle(track.name), artist: '아빠 음악', album: 'Dad\'s Music' });
      } catch {}
    }
  }

  function updateSeek() {
    const duration = els.audio.duration || 0;
    const current = els.audio.currentTime || 0;
    if (!seekDragging) els.seek.value = duration ? Math.round((current / duration) * 1000) : 0;
    els.timeCurrent.textContent = fmtTime(current);
    els.timeTotal.textContent = fmtTime(duration);
  }

  function updateMediaPosition() {
    if (!('mediaSession' in navigator) || !Number.isFinite(els.audio.duration) || els.audio.duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({ duration: els.audio.duration, playbackRate: 1, position: Math.min(els.audio.currentTime || 0, els.audio.duration) });
    } catch {}
  }

  function playableQueue() { return library.filter(track => audioValueSize(audioRows.get(track.id)?.blob) > 0); }

  function currentIndex() {
    return playableQueue().findIndex(item => item.id === currentId);
  }

  function shuffledIds() {
    const ids = playableQueue().map(item => item.id).filter(id => id !== currentId);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    return ids;
  }

  function nextShuffleId() {
    if (shuffleBag === null) shuffleBag = shuffledIds();
    return shuffleBag.shift() || null;
  }

  function playNext(auto = false) {
    const queue = playableQueue();
    if (!queue.length || !currentId) return;
    if (auto && repeatMode === 'one') return playTrack(currentId);

    if (shuffleEnabled) {
      let next = nextShuffleId();
      if (!next && repeatMode === 'all') {
        resetShuffleBag();
        next = nextShuffleId();
      }
      if (!next && repeatMode === 'all' && queue.length === 1) next = currentId;
      if (next) return playTrack(next);
      return;
    }

    const idx = currentIndex();
    if (idx >= 0 && idx < queue.length - 1) return playTrack(queue[idx + 1].id);
    if (repeatMode === 'all') return playTrack(queue[0].id);
  }

  function playPrev() {
    const queue = playableQueue();
    if (!queue.length || !currentId) return;
    if ((els.audio.currentTime || 0) > 3) {
      els.audio.currentTime = 0;
      return;
    }

    if (shuffleEnabled && historyCursor > 0) {
      historyCursor -= 1;
      return playTrack(playbackHistory[historyCursor], { recordHistory: false });
    }

    const idx = currentIndex();
    if (idx > 0) return playTrack(queue[idx - 1].id);
    if (repeatMode === 'all') return playTrack(queue[queue.length - 1].id);
    els.audio.currentTime = 0;
  }

  function openSettings() {
    els.clientIdInput.value = settings.clientId || DEFAULT_CLIENT_ID;
    els.folderIdInput.value = settings.folderId || DEFAULT_FOLDER_ID;
    updateSettingsStatus();
    if (els.storageResult) els.storageResult.textContent = '';
    els.settingsDialog.showModal();
  }

  async function deleteAllOfflineAudio() {
    return runOperation(deleteAllOfflineAudioNow);
  }

  async function deleteAllOfflineAudioNow() {
    const count = storedAudioCount();
    const size = storedAudioBytes();
    const description = count ? `오프라인 오디오 ${count}개 (${fmtBytes(size)})를 모두 삭제할까요?` : '오프라인 오디오 저장공간을 초기화할까요?';
    if (!confirm(`${description}\n\n오디오 전용 데이터베이스만 삭제합니다. Google Drive 원본, 음악 목록, 제외한 노래 기록은 유지됩니다.`)) return;

    if (els.storageResult) els.storageResult.textContent = '오프라인 오디오 저장공간을 삭제하는 중…';
    try {
      stopPlayer();
      try { db?.close(); } catch {}
      db = null;
      const storage = audioStorage();
      await storage.ready;
      const after = await storage.deleteDatabase();
      if (after.count !== 0 || after.bytes !== 0) throw new Error(`삭제 확인 실패: ${after.count}개의 오디오가 남아 있습니다.`);
      db = await openDb();
      await reloadLocal();
      await updateStorageEstimate();
      if (els.storageResult) els.storageResult.textContent = '확인 완료: 오프라인 오디오 0개 · 0 MB';
      updateStatus('오프라인 오디오를 삭제했습니다', '다시 받으려면 음악 업데이트를 누르세요.');
    } catch (error) {
      console.error(error);
      if (!db) { try { db = await openDb(); } catch {} }
      if (els.storageResult) els.storageResult.textContent = '완전한 삭제를 확인하지 못했습니다.';
      updateStatus('오프라인 오디오를 삭제하지 못했습니다', error.message || '다시 시도해 주세요.');
    } finally {
      updateOfflineStats();
    }
  }

  els.syncBtn.addEventListener('click', syncLibrary);
  els.settingsBtn.addEventListener('click', openSettings);
  els.shuffleBtn.addEventListener('click', toggleShuffle);
  els.repeatBtn.addEventListener('click', cycleRepeat);
  els.prevBtn.addEventListener('click', playPrev);
  els.nextBtn.addEventListener('click', () => playNext(false));
  els.playBtn.addEventListener('click', () => {
    if (!currentId && library[0]) return playTrack(library[0].id);
    els.audio.paused ? resumeAudio() : els.audio.pause();
  });

  els.saveSettingsBtn.addEventListener('click', () => {
    settings.clientId = els.clientIdInput.value.trim();
    settings.folderId = els.folderIdInput.value.trim() || DEFAULT_FOLDER_ID;
    saveSettings();
    accessToken = null;
    tokenClient = null;
    localStorage.removeItem('dadsMusicGoogleAccessToken');
    localStorage.removeItem('dadsMusicGoogleAuthorized');
    localStorage.removeItem('dadsMusicGoogleForceConsent');
    updateStatus('고급 설정을 저장했습니다', '다음 음악 업데이트 때 새 설정을 사용합니다.');
    updateSettingsStatus();
  });

  els.deleteOfflineBtn.addEventListener('click', deleteAllOfflineAudio);
  els.factoryResetBtn?.addEventListener('click', () => {
    if (!confirm('이 기기의 아빠 음악을 처음 상태로 되돌릴까요?\n\n로컬 목록, 오프라인 오디오, 재생 위치, 제외 기록, 설정과 앱 캐시를 삭제합니다. Google Drive 원본과 Drive의 REJECTED_SONGS.csv는 삭제되지 않습니다.')) return;
    location.href = './reset.html';
  });

  els.seek.addEventListener('input', () => {
    seekDragging = true;
    const duration = els.audio.duration || 0;
    if (duration) els.timeCurrent.textContent = fmtTime((Number(els.seek.value) / 1000) * duration);
  });
  els.seek.addEventListener('change', () => {
    const duration = els.audio.duration || 0;
    if (duration) els.audio.currentTime = (Number(els.seek.value) / 1000) * duration;
    seekDragging = false;
    updateMediaPosition();
  });

  els.audio.addEventListener('timeupdate', () => {
    updateSeek();
    updateMediaPosition();

  });
  els.audio.addEventListener('play', () => {
    els.playBtn.dataset.state = 'pause';
    els.playBtn.setAttribute('aria-label', '일시정지');
    if ('mediaSession' in navigator) { try { navigator.mediaSession.playbackState = 'playing'; } catch {} }
  });
  els.audio.addEventListener('pause', () => {
    els.playBtn.dataset.state = 'play';
    els.playBtn.setAttribute('aria-label', '재생');
    if ('mediaSession' in navigator) { try { navigator.mediaSession.playbackState = 'paused'; } catch {} }
  });
  els.audio.addEventListener('ended', () => {
    if (currentId) removePosition(currentId);
    playNext(true);
  });

  window.addEventListener('online', () => updateStatus());
  window.addEventListener('offline', () => updateStatus('오프라인 상태입니다'));

  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('play', resumeAudio);
      navigator.mediaSession.setActionHandler('pause', () => els.audio.pause());
      navigator.mediaSession.setActionHandler('previoustrack', playPrev);
      navigator.mediaSession.setActionHandler('nexttrack', () => playNext(false));
      navigator.mediaSession.setActionHandler('seekbackward', details => { els.audio.currentTime = Math.max(0, els.audio.currentTime - (details.seekOffset || 15)); });
      navigator.mediaSession.setActionHandler('seekforward', details => { els.audio.currentTime = Math.min(els.audio.duration || Infinity, els.audio.currentTime + (details.seekOffset || 15)); });
      navigator.mediaSession.setActionHandler('seekto', details => { if (details.seekTime != null) els.audio.currentTime = details.seekTime; });
    } catch {}
  }

  els.audio.addEventListener('error', () => {
    if (currentId) updateStatus('오디오를 재생하지 못했습니다', '다른 곡을 선택하거나 업데이트를 다시 눌러 주세요.');
  });
  window.addEventListener('pageshow', () => {
    if (!operationBusy && db) runOperation(async () => {}).catch(() => {});
  });

  window.addEventListener('beforeunload', () => {
    if (currentUrl) URL.revokeObjectURL(currentUrl);
  });

  async function boot() {
    if ('serviceWorker' in navigator) {
      try {
        const registration = await navigator.serviceWorker.register('./sw.js');
        registration.update().catch(() => {});
      } catch (error) { console.warn('Service worker unavailable', error); }
    }
    updateShuffleButton();
    updateRepeatButton();
    await audioStorage().ready;
    db = await openDb();
    await reloadLocal();
    if (navigator.onLine) updateStatus(library.length ? undefined : '처음에는 음악 업데이트를 눌러 주세요');
    else updateStatus('오프라인 상태입니다');
  }

  boot().catch(error => {
    console.error(error);
    els.statusTitle.textContent = '앱을 시작하지 못했습니다';
    els.statusDetail.textContent = error.message || '';
  });
})();
