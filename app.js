(() => {
  'use strict';

  const DEFAULT_FOLDER_ID = '1c7Dj_Dnysp8YSIO4QQqUJ-fLA4nbqTec';
  const API_KEY_STORAGE = 'dadsMusicPublicApiKey';
  const WRITER_URL_KEY = 'dadsMusicWriterUrl';
  const WRITER_TOKEN_KEY = 'dadsMusicWriterToken';
  const DB_NAME = 'dads-music-db';
  const DB_VERSION = 1;
  const SETTINGS_KEY = 'dadsMusicSettings';
  const POSITION_KEY = 'dadsMusicPositions';
  const REPEAT_KEY = 'dadsMusicRepeatMode';
  const SHUFFLE_KEY = 'dadsMusicShuffle';
  const REJECTED_KEY = 'dadsMusicRejectedLocal';
  const PENDING_KEY = 'dadsMusicRejectedPending';
  const LEDGER_NAME = 'REJECTED_SONGS.csv';
  const SUPPORTED_MIMES = new Set(['audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/flac', 'audio/x-flac', 'audio/wav', 'audio/x-wav']);

  const els = Object.fromEntries([
    'syncBtn','settingsBtn','statusTitle','statusDetail','trackCount','trackList','emptyState','player','nowTitle','nowStatus',
    'shuffleBtn','repeatBtn','seek','timeCurrent','timeTotal','prevBtn','playBtn','nextBtn','audio',
    'settingsDialog','apiKeyInput','folderIdInput','writerUrlInput','writerTokenInput','offlineStats','storageEstimate','driveStorageStatus','rejectedStats',
    'deleteOfflineBtn','factoryResetBtn','storageResult','saveSettingsBtn'
  ].map(id => [id, document.getElementById(id)]));

  let db = null;
  let library = [];
  let audioRows = new Map();
  let currentId = null;
  let currentUrl = null;
  let seekDragging = false;
  let savePositionTimer = null;
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
      const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {};
      return { folderId: String(stored.folderId || DEFAULT_FOLDER_ID).trim() || DEFAULT_FOLDER_ID };
    } catch {
      return { folderId: DEFAULT_FOLDER_ID };
    }
  }

  function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ folderId: settings.folderId || DEFAULT_FOLDER_ID }));
  }

  function readApiKey() {
    return String(localStorage.getItem(API_KEY_STORAGE) || '').trim();
  }

  function validApiKey(value = readApiKey()) {
    return /^AIza[\w-]{20,}$/.test(String(value || '').trim());
  }

  function writerConfig() {
    return {
      url: String(localStorage.getItem(WRITER_URL_KEY) || '').trim(),
      token: String(localStorage.getItem(WRITER_TOKEN_KEY) || '').trim()
    };
  }

  function writerConfigured() {
    const { url, token } = writerConfig();
    return /^https:\/\//i.test(url) && !!token;
  }

  function cleanLegacyAuthState() {
    localStorage.removeItem('dadsMusicGoogleAccessToken');
    localStorage.removeItem('dadsMusicGoogleAuthorized');
    localStorage.removeItem('dadsMusicGoogleForceConsent');
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

  function loadPositions() {
    try {
      const value = JSON.parse(localStorage.getItem(POSITION_KEY) || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  }

  function savePosition(id, time) {
    if (!id || !Number.isFinite(time) || time < 0) return;
    const positions = loadPositions();
    positions[id] = Math.floor(time);
    localStorage.setItem(POSITION_KEY, JSON.stringify(positions));
  }

  function removePosition(id) {
    const positions = loadPositions();
    delete positions[id];
    localStorage.setItem(POSITION_KEY, JSON.stringify(positions));
  }

  function loadRows(key) {
    try {
      const rows = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(rows) ? rows.filter(row => row?.id) : [];
    } catch { return []; }
  }

  function dedupeRows(rows) {
    const byId = new Map();
    for (const row of rows || []) {
      if (!row?.id) continue;
      const existing = byId.get(row.id);
      if (!existing || String(row.rejectedAt || '') < String(existing.rejectedAt || '')) byId.set(row.id, row);
    }
    return [...byId.values()];
  }

  function loadRejected() { return loadRows(REJECTED_KEY); }
  function saveRejected(rows) { localStorage.setItem(REJECTED_KEY, JSON.stringify(dedupeRows(rows))); }
  function loadPending() { return loadRows(PENDING_KEY); }
  function savePending(rows) { localStorage.setItem(PENDING_KEY, JSON.stringify(dedupeRows(rows))); }
  function rejectedMap() { return new Map(loadRejected().map(row => [row.id, row])); }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const idb = req.result;
        if (!idb.objectStoreNames.contains('library')) idb.createObjectStore('library', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
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
        const objectStore = db.transaction(store, mode).objectStore(store);
        return await reqP(makeRequest(objectStore));
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

  async function responseToAudioValue(response) { return response.blob(); }

  function rowIsCurrent(track, row) {
    if (!track || !row?.blob) return false;
    const actual = audioValueSize(row.blob);
    const expected = Number(track.size || 0);
    if (actual <= 0) return false;
    if (expected > 0 && actual !== expected) return false;
    if (track.modifiedTime && row.modifiedTime && track.modifiedTime !== row.modifiedTime) return false;
    return true;
  }

  function resetShuffleBag() { shuffleBag = null; }

  async function reloadLocal() {
    const rejected = rejectedMap();
    library = (await dbGetAll('library')).filter(track => !rejected.has(track.id));
    library.sort((a, b) => String(a.name).localeCompare(String(b.name), 'ko'));
    const rows = await dbGetAll('audio');
    audioRows = new Map(rows.map(row => [row.id, row]));
    resetShuffleBag();
    render();
    updateStatus();
    updateOfflineStats();
  }

  function totalOfflineBytes() {
    return library.reduce((sum, track) => sum + (rowIsCurrent(track, audioRows.get(track.id)) ? audioValueSize(audioRows.get(track.id).blob) : 0), 0);
  }

  function currentOfflineCount() { return library.filter(track => rowIsCurrent(track, audioRows.get(track.id))).length; }
  function storedAudioCount() { return [...audioRows.values()].filter(row => audioValueSize(row?.blob) > 0).length; }
  function storedAudioBytes() { return [...audioRows.values()].reduce((sum, row) => sum + audioValueSize(row?.blob), 0); }

  function updateOfflineStats() {
    if (els.offlineStats) els.offlineStats.textContent = `${storedAudioCount()}개 · ${fmtBytes(storedAudioBytes())}`;
    if (els.rejectedStats) {
      const pending = loadPending().length;
      els.rejectedStats.textContent = pending ? `${loadRejected().length}개 · 전송 대기 ${pending}개` : `${loadRejected().length}개`;
    }
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
      else if (!validApiKey()) els.driveStorageStatus.textContent = 'API 키 필요';
      else els.driveStorageStatus.textContent = writerConfigured() ? '연결됨 · 제외 기록 설정됨' : '연결됨 · 제외 기록 미설정';
    }
  }

  function updateStatus(title, detail) {
    const offline = currentOfflineCount();
    const total = library.length;
    els.statusTitle.textContent = title || (total ? '오프라인 재생 준비 완료' : '저장된 음악이 없습니다');
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

  async function driveFetch(url, options = {}) {
    const key = readApiKey();
    if (!validApiKey(key)) throw new Error('설정에서 Google Drive API 키를 한 번 저장해 주세요.');
    const target = new URL(url);
    target.searchParams.set('key', key);
    const response = await fetch(target.toString(), options);
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
    do {
      const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
      const fields = encodeURIComponent('nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime)');
      const page = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
      const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=1000&orderBy=name${page}`;
      const json = await (await driveFetch(url)).json();
      files.push(...(json.files || []));
      pageToken = json.nextPageToken || '';
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
    if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
    return rows;
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
    return [...byId.values()];
  }

  async function flushPendingRejections() {
    const pending = loadPending();
    if (!pending.length || !navigator.onLine || !writerConfigured()) return;
    const { url, token } = writerConfig();
    for (const row of pending) {
      const body = new URLSearchParams({ token, id: row.id, name: row.name || '', rejectedAt: row.rejectedAt || '' });
      await fetch(url, { method: 'POST', mode: 'no-cors', body });
    }
  }

  function confirmPendingFromRemote(remoteRows) {
    if (!remoteRows.length) return;
    const remoteIds = new Set(remoteRows.map(row => row.id));
    savePending(loadPending().filter(row => !remoteIds.has(row.id)));
  }

  function mergeRejected(remoteRows) {
    const rows = dedupeRows([...remoteRows, ...loadRejected()]);
    saveRejected(rows);
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
    if (!navigator.onLine) return updateStatus('오프라인 상태입니다');
    els.syncBtn.disabled = true;
    els.syncBtn.textContent = '업데이트 중…';
    try {
      updateStatus('Google Drive 확인 중…', '새 음악과 제외한 노래 목록을 확인합니다.');
      await flushPendingRejections().catch(error => console.warn('Pending rejection send failed', error));
      const files = await listDriveFolder();
      const rawAudio = files.filter(isAudioFile);
      if (!rawAudio.length) throw new Error('Drive에서 음악 파일을 찾지 못했습니다. 기존 오프라인 음악은 그대로 유지했습니다.');

      const remoteRejected = await readRemoteRejected(files);
      confirmPendingFromRemote(remoteRejected);
      const rejected = mergeRejected(remoteRejected);
      const incoming = rawAudio.filter(file => !rejected.has(file.id));
      const incomingIds = new Set(incoming.map(file => file.id));
      const oldById = new Map(library.map(track => [track.id, track]));

      for (const old of library) {
        if (!incomingIds.has(old.id)) {
          await dbDelete('library', old.id);
          await dbDelete('audio', old.id);
          audioRows.delete(old.id);
          removePosition(old.id);
          if (currentId === old.id) stopPlayer();
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

      for (let i = 0; i < needsDownload.length; i++) {
        const track = needsDownload[i];
        updateStatus(`다운로드 중 ${i + 1}/${needsDownload.length}`, cleanTitle(track.name));
        await downloadTrack(track);
        render();
        updateOfflineStats();
      }

      await reloadLocal();
      const pending = loadPending().length;
      updateStatus('모든 음악이 최신 상태입니다', `${library.length}개 준비됨 · 제외한 노래 ${loadRejected().length}개${pending ? ` · 기록 대기 ${pending}개` : ''}`);
    } catch (error) {
      console.error(error);
      updateStatus('업데이트하지 못했습니다', error.message || '다시 시도해 주세요.');
    } finally {
      els.syncBtn.disabled = false;
      els.syncBtn.textContent = '음악 업데이트';
    }
  }

  async function rejectTrack(id) {
    const track = library.find(item => item.id === id);
    if (!track) return;
    if (!confirm(`“${cleanTitle(track.name)}”을 목록에서 뺄까요?\n\n휴대폰에서 삭제되고 다음 음악 업데이트에서도 다시 받지 않습니다.`)) return;

    const row = { id, name: track.name, rejectedAt: new Date().toISOString() };
    saveRejected([...loadRejected(), row]);
    savePending([...loadPending(), row]);

    if (currentId === id) stopPlayer();
    await dbDelete('audio', id).catch(() => {});
    await dbDelete('library', id).catch(() => {});
    audioRows.delete(id);
    removePosition(id);
    await reloadLocal();

    if (!navigator.onLine) {
      updateStatus('이 노래를 뺐습니다', '제외 기록은 인터넷 연결 후 자동으로 전송합니다.');
      return;
    }
    if (!writerConfigured()) {
      updateStatus('이 노래를 뺐습니다', '휴대폰에서는 다시 받지 않습니다. 제외 기록 전송 설정이 아직 필요합니다.');
      return;
    }

    try {
      await flushPendingRejections();
      updateStatus('이 노래를 뺐습니다', '제외 기록을 전송했습니다. 다음 음악 업데이트에서 Drive 기록을 확인합니다.');
    } catch (error) {
      console.warn(error);
      updateStatus('이 노래를 뺐습니다', '휴대폰에서는 제거했습니다. 제외 기록은 다음 음악 업데이트 때 다시 전송합니다.');
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

    if (currentId && Number.isFinite(els.audio.currentTime)) savePosition(currentId, els.audio.currentTime);
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    if (options.recordHistory !== false) recordHistory(id);

    const stale = !rowIsCurrent(track, row);
    currentId = id;
    currentUrl = audioValueToUrl(row.blob);
    els.audio.src = currentUrl;
    els.audio.playbackRate = 1;
    els.nowTitle.textContent = cleanTitle(track.name);
    els.player.classList.remove('hidden');
    updateNowStatus(stale);
    render();

    els.audio.onloadedmetadata = async () => {
      const saved = Number(loadPositions()[id] || 0);
      if (saved > 0 && saved < els.audio.duration - 10) els.audio.currentTime = saved;
      els.timeTotal.textContent = fmtTime(els.audio.duration);
      updateSeek();
      updateMediaPosition();
      try { await els.audio.play(); } catch {}
    };

    if ('mediaSession' in navigator) {
      try { navigator.mediaSession.metadata = new MediaMetadata({ title: cleanTitle(track.name), artist: '아빠 음악', album: 'Dad\'s Music' }); } catch {}
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
    try { navigator.mediaSession.setPositionState({ duration: els.audio.duration, playbackRate: 1, position: Math.min(els.audio.currentTime || 0, els.audio.duration) }); } catch {}
  }

  function currentIndex() { return library.findIndex(item => item.id === currentId); }

  function shuffledIds() {
    const ids = library.map(item => item.id).filter(id => id !== currentId);
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
    if (!library.length || !currentId) return;
    if (auto && repeatMode === 'one') return playTrack(currentId);

    if (shuffleEnabled) {
      let next = nextShuffleId();
      if (!next && repeatMode === 'all') {
        resetShuffleBag();
        next = nextShuffleId();
      }
      if (next) return playTrack(next);
      return;
    }

    const idx = currentIndex();
    if (idx >= 0 && idx < library.length - 1) return playTrack(library[idx + 1].id);
    if (repeatMode === 'all') return playTrack(library[0].id);
  }

  function playPrev() {
    if (!library.length || !currentId) return;
    if ((els.audio.currentTime || 0) > 3) {
      els.audio.currentTime = 0;
      return;
    }
    if (shuffleEnabled && historyCursor > 0) {
      historyCursor -= 1;
      return playTrack(playbackHistory[historyCursor], { recordHistory: false });
    }
    const idx = currentIndex();
    if (idx > 0) return playTrack(library[idx - 1].id);
    if (repeatMode === 'all') return playTrack(library[library.length - 1].id);
    els.audio.currentTime = 0;
  }

  function openSettings() {
    if (els.apiKeyInput) els.apiKeyInput.value = readApiKey();
    if (els.writerUrlInput) els.writerUrlInput.value = writerConfig().url;
    if (els.writerTokenInput) els.writerTokenInput.value = writerConfig().token;
    els.folderIdInput.value = settings.folderId || DEFAULT_FOLDER_ID;
    updateSettingsStatus();
    if (els.storageResult) els.storageResult.textContent = '';
    els.settingsDialog.showModal();
  }

  async function deleteAllOfflineAudio() {
    const count = storedAudioCount();
    const size = storedAudioBytes();
    const description = count ? `오프라인 오디오 ${count}개 (${fmtBytes(size)})를 모두 삭제할까요?` : '오프라인 오디오 저장공간을 초기화할까요?';
    if (!confirm(`${description}\n\n오디오 전용 데이터베이스만 삭제합니다. Google Drive 원본, 음악 목록, 제외한 노래 기록은 유지됩니다.`)) return;

    els.deleteOfflineBtn.disabled = true;
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
      els.deleteOfflineBtn.disabled = false;
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
    els.audio.paused ? els.audio.play() : els.audio.pause();
  });

  els.saveSettingsBtn.addEventListener('click', () => {
    const nextKey = String(els.apiKeyInput?.value || '').trim();
    const nextWriterUrl = String(els.writerUrlInput?.value || '').trim();
    const nextWriterToken = String(els.writerTokenInput?.value || '').trim();

    if (nextKey && !validApiKey(nextKey)) {
      alert('Google Drive API 키 형식이 올바르지 않습니다. AIza로 시작하는 키를 확인해 주세요.');
      return;
    }
    if (nextWriterUrl && !/^https:\/\//i.test(nextWriterUrl)) {
      alert('제외 기록 주소는 https:// 로 시작해야 합니다.');
      return;
    }

    if (nextKey) localStorage.setItem(API_KEY_STORAGE, nextKey); else localStorage.removeItem(API_KEY_STORAGE);
    if (nextWriterUrl) localStorage.setItem(WRITER_URL_KEY, nextWriterUrl); else localStorage.removeItem(WRITER_URL_KEY);
    if (nextWriterToken) localStorage.setItem(WRITER_TOKEN_KEY, nextWriterToken); else localStorage.removeItem(WRITER_TOKEN_KEY);
    settings.folderId = els.folderIdInput.value.trim() || DEFAULT_FOLDER_ID;
    saveSettings();
    cleanLegacyAuthState();
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
    if (!currentId) return;
    clearTimeout(savePositionTimer);
    savePositionTimer = setTimeout(() => savePosition(currentId, els.audio.currentTime), 500);
  });
  els.audio.addEventListener('play', () => {
    els.playBtn.dataset.state = 'pause';
    els.playBtn.setAttribute('aria-label', '일시정지');
    if ('mediaSession' in navigator) { try { navigator.mediaSession.playbackState = 'playing'; } catch {} }
  });
  els.audio.addEventListener('pause', () => {
    els.playBtn.dataset.state = 'play';
    els.playBtn.setAttribute('aria-label', '재생');
    if (currentId) savePosition(currentId, els.audio.currentTime);
    if ('mediaSession' in navigator) { try { navigator.mediaSession.playbackState = 'paused'; } catch {} }
  });
  els.audio.addEventListener('ended', () => {
    if (currentId) removePosition(currentId);
    playNext(true);
  });

  window.addEventListener('online', () => {
    updateStatus();
    flushPendingRejections().catch(error => console.warn('Pending rejection send failed', error));
  });
  window.addEventListener('offline', () => updateStatus('오프라인 상태입니다'));

  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('play', () => els.audio.play());
      navigator.mediaSession.setActionHandler('pause', () => els.audio.pause());
      navigator.mediaSession.setActionHandler('previoustrack', playPrev);
      navigator.mediaSession.setActionHandler('nexttrack', () => playNext(false));
      navigator.mediaSession.setActionHandler('seekbackward', details => { els.audio.currentTime = Math.max(0, els.audio.currentTime - (details.seekOffset || 15)); });
      navigator.mediaSession.setActionHandler('seekforward', details => { els.audio.currentTime = Math.min(els.audio.duration || Infinity, els.audio.currentTime + (details.seekOffset || 15)); });
      navigator.mediaSession.setActionHandler('seekto', details => { if (details.seekTime != null) els.audio.currentTime = details.seekTime; });
    } catch {}
  }

  window.addEventListener('beforeunload', () => {
    if (currentId) savePosition(currentId, els.audio.currentTime);
    if (currentUrl) URL.revokeObjectURL(currentUrl);
  });

  async function boot() {
    cleanLegacyAuthState();
    saveSettings();
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
    if (navigator.onLine) {
      flushPendingRejections().catch(error => console.warn('Pending rejection send failed', error));
      updateStatus(library.length ? '오프라인 재생 준비 완료' : '처음에는 음악 업데이트를 눌러 주세요');
    } else updateStatus('오프라인 상태입니다');
  }

  boot().catch(error => {
    console.error(error);
    els.statusTitle.textContent = '앱을 시작하지 못했습니다';
    els.statusDetail.textContent = error.message || '';
  });
})();