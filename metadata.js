(() => {
  'use strict';

  const utf8 = new TextDecoder('utf-8', { fatal: false });
  const latin1 = new TextDecoder('iso-8859-1', { fatal: false });

  async function toBytes(value) {
    if (!value) return null;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (typeof Blob !== 'undefined' && value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
    return null;
  }

  function trimText(value = '') {
    return value.replace(/\0/g, '').trim();
  }

  function syncSafe(bytes, offset) {
    return ((bytes[offset] & 0x7f) << 21) |
      ((bytes[offset + 1] & 0x7f) << 14) |
      ((bytes[offset + 2] & 0x7f) << 7) |
      (bytes[offset + 3] & 0x7f);
  }

  function u32be(bytes, offset) {
    return ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
  }

  function u32le(bytes, offset) {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | ((bytes[offset + 3] << 24) >>> 0)) >>> 0;
  }

  function decodeUtf16BE(bytes) {
    const swapped = new Uint8Array(bytes.length);
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      swapped[i] = bytes[i + 1];
      swapped[i + 1] = bytes[i];
    }
    try { return new TextDecoder('utf-16le', { fatal: false }).decode(swapped); }
    catch { return ''; }
  }

  function decodeText(bytes, encoding = 3) {
    if (!bytes?.length) return '';
    try {
      if (encoding === 0) return trimText(latin1.decode(bytes));
      if (encoding === 3) return trimText(utf8.decode(bytes));
      if (encoding === 2) return trimText(decodeUtf16BE(bytes));
      if (encoding === 1) {
        if (bytes[0] === 0xfe && bytes[1] === 0xff) return trimText(decodeUtf16BE(bytes.subarray(2)));
        if (bytes[0] === 0xff && bytes[1] === 0xfe) return trimText(new TextDecoder('utf-16le', { fatal: false }).decode(bytes.subarray(2)));
        return trimText(new TextDecoder('utf-16le', { fatal: false }).decode(bytes));
      }
    } catch {}
    return '';
  }

  function findTerminator(bytes, start, wide) {
    if (!wide) {
      for (let i = start; i < bytes.length; i++) if (bytes[i] === 0) return i;
      return bytes.length;
    }
    for (let i = start; i + 1 < bytes.length; i += 2) {
      if (bytes[i] === 0 && bytes[i + 1] === 0) return i;
    }
    return bytes.length;
  }

  function imageMime(bytes, fallback = '') {
    if (bytes?.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
    if (bytes?.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    return fallback || 'image/jpeg';
  }

  function parseID3(bytes, includeArtwork) {
    if (bytes.length < 10 || String.fromCharCode(...bytes.subarray(0, 3)) !== 'ID3') return null;
    const version = bytes[3];
    const tagEnd = Math.min(bytes.length, 10 + syncSafe(bytes, 6));
    const out = {};
    let artwork = null;
    let pos = 10;

    while (pos + 10 <= tagEnd) {
      const id = String.fromCharCode(...bytes.subarray(pos, pos + 4));
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const size = version === 4 ? syncSafe(bytes, pos + 4) : u32be(bytes, pos + 4);
      if (!size || pos + 10 + size > tagEnd) break;
      const frame = bytes.subarray(pos + 10, pos + 10 + size);

      if (id === 'TIT2' || id === 'TPE1' || id === 'TALB') {
        const value = decodeText(frame.subarray(1), frame[0]);
        if (value) {
          if (id === 'TIT2') out.title = value;
          if (id === 'TPE1') out.artist = value;
          if (id === 'TALB') out.album = value;
        }
      } else if (id === 'APIC' && includeArtwork && !artwork && frame.length > 8) {
        const encoding = frame[0];
        const mimeEnd = findTerminator(frame, 1, false);
        const mime = latin1.decode(frame.subarray(1, mimeEnd));
        let p = mimeEnd + 1;
        p += 1;
        const wide = encoding === 1 || encoding === 2;
        const descEnd = findTerminator(frame, p, wide);
        p = Math.min(frame.length, descEnd + (wide ? 2 : 1));
        if (p < frame.length) {
          const data = frame.slice(p);
          artwork = { mime: imageMime(data, mime), bytes: data };
        }
      }
      pos += 10 + size;
    }

    if (artwork) out.artwork = artwork;
    return out;
  }

  function atomType(bytes, offset) {
    if (offset + 4 > bytes.length) return '';
    return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  }

  function listAtoms(bytes, start, end) {
    const atoms = [];
    let pos = start;
    while (pos + 8 <= end) {
      let size = u32be(bytes, pos);
      const type = atomType(bytes, pos + 4);
      let header = 8;
      if (size === 1) {
        if (pos + 16 > end) break;
        const hi = u32be(bytes, pos + 8);
        const lo = u32be(bytes, pos + 12);
        const extended = hi * 4294967296 + lo;
        if (!Number.isSafeInteger(extended)) break;
        size = extended;
        header = 16;
      } else if (size === 0) {
        size = end - pos;
      }
      if (size < header || pos + size > end) break;
      atoms.push({ type, start: pos, dataStart: pos + header, end: pos + size });
      pos += size;
    }
    return atoms;
  }

  function parseMp4DataBox(bytes, tagAtom) {
    const children = listAtoms(bytes, tagAtom.dataStart, tagAtom.end);
    const data = children.find(a => a.type === 'data');
    if (!data || data.dataStart + 8 > data.end) return null;
    const typeCode = ((bytes[data.dataStart + 1] << 16) | (bytes[data.dataStart + 2] << 8) | bytes[data.dataStart + 3]) >>> 0;
    const payload = bytes.subarray(data.dataStart + 8, data.end);
    return { typeCode, payload };
  }

  function parseMP4(bytes, includeArtwork) {
    const out = {};
    let artwork = null;

    function walk(start, end, depth = 0) {
      if (depth > 8) return;
      for (const atom of listAtoms(bytes, start, end)) {
        if (atom.type === '©nam' || atom.type === '©ART' || atom.type === 'aART' || atom.type === '©alb' || atom.type === 'covr') {
          const data = parseMp4DataBox(bytes, atom);
          if (!data) continue;
          if (atom.type === 'covr') {
            if (includeArtwork && !artwork && data.payload.length) {
              const mime = data.typeCode === 14 ? 'image/png' : data.typeCode === 13 ? 'image/jpeg' : imageMime(data.payload);
              artwork = { mime, bytes: data.payload.slice() };
            }
          } else {
            const value = trimText(utf8.decode(data.payload));
            if (!value) continue;
            if (atom.type === '©nam') out.title = value;
            if ((atom.type === '©ART' || atom.type === 'aART') && !out.artist) out.artist = value;
            if (atom.type === '©alb') out.album = value;
          }
          continue;
        }

        if (atom.type === 'moov' || atom.type === 'udta' || atom.type === 'ilst') {
          walk(atom.dataStart, atom.end, depth + 1);
        } else if (atom.type === 'meta') {
          walk(Math.min(atom.end, atom.dataStart + 4), atom.end, depth + 1);
        }
      }
    }

    walk(0, bytes.length);
    if (artwork) out.artwork = artwork;
    return out;
  }

  function parseFLAC(bytes, includeArtwork) {
    if (bytes.length < 8 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'fLaC') return null;
    const out = {};
    let artwork = null;
    let pos = 4;
    let last = false;

    while (!last && pos + 4 <= bytes.length) {
      last = !!(bytes[pos] & 0x80);
      const type = bytes[pos] & 0x7f;
      const len = (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
      const start = pos + 4;
      const end = start + len;
      if (end > bytes.length) break;

      if (type === 4 && len >= 8) {
        let p = start;
        const vendorLen = u32le(bytes, p); p += 4 + vendorLen;
        if (p + 4 <= end) {
          const count = u32le(bytes, p); p += 4;
          for (let i = 0; i < count && p + 4 <= end; i++) {
            const n = u32le(bytes, p); p += 4;
            if (p + n > end) break;
            const comment = utf8.decode(bytes.subarray(p, p + n)); p += n;
            const eq = comment.indexOf('=');
            if (eq < 1) continue;
            const key = comment.slice(0, eq).toUpperCase();
            const value = trimText(comment.slice(eq + 1));
            if (key === 'TITLE' && !out.title) out.title = value;
            if (key === 'ARTIST' && !out.artist) out.artist = value;
            if (key === 'ALBUM' && !out.album) out.album = value;
          }
        }
      } else if (type === 6 && includeArtwork && !artwork && len > 32) {
        let p = start;
        p += 4;
        if (p + 4 > end) { pos = end; continue; }
        const mimeLen = u32be(bytes, p); p += 4;
        const mime = utf8.decode(bytes.subarray(p, p + mimeLen)); p += mimeLen;
        if (p + 4 > end) { pos = end; continue; }
        const descLen = u32be(bytes, p); p += 4 + descLen;
        p += 16;
        if (p + 4 <= end) {
          const dataLen = u32be(bytes, p); p += 4;
          if (dataLen > 0 && p + dataLen <= end) {
            const data = bytes.slice(p, p + dataLen);
            artwork = { mime: imageMime(data, mime), bytes: data };
          }
        }
      }
      pos = end;
    }

    if (artwork) out.artwork = artwork;
    return out;
  }

  async function parse(value, mimeType = '', includeArtwork = false) {
    const bytes = await toBytes(value);
    if (!bytes?.length) return {};
    try {
      if (bytes.length >= 3 && String.fromCharCode(...bytes.subarray(0, 3)) === 'ID3') return parseID3(bytes, includeArtwork) || {};
      if (bytes.length >= 4 && String.fromCharCode(...bytes.subarray(0, 4)) === 'fLaC') return parseFLAC(bytes, includeArtwork) || {};
      if (mimeType.includes('mp4') || mimeType.includes('m4a') || atomType(bytes, 4) === 'ftyp') return parseMP4(bytes, includeArtwork) || {};
    } catch (error) {
      console.warn('Embedded metadata parse failed', error);
    }
    return {};
  }

  window.MusicMetadata = { parse };
})();