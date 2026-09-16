import { EventEmitter } from 'node:events';
import { patchWebTorrent } from '../scripts/webtorrent-guard.mjs';

const MAGNET = 'magnet:?xt=urn:btih:0123456789012345678901234567890123456789';
const VIDEO_BYTES = 10 * 1024 * 1024 + 12;
let WebTorrentFile;

class FakeTorrent extends EventEmitter {
  constructor(mode) {
    super();
    this.mode = mode;
    this.infoHash = '0123456789012345678901234567890123456789';
    this.length = VIDEO_BYTES;
    this.pieceLength = 1024 * 1024;
    this.pieces = [Buffer.alloc(20)];
    this.wires = [];
    this.lastPieceLength = this.pieceLength;
    this.destroyed = false;
    this.bitfield = { get: () => this.mode === 'success' };
    this._select = () => {};
    this._deselect = () => {};
    this.select = () => {};
    this.deselect = () => {};
    this.critical = () => {};
    this.store = {
      get: (_index, options, callback) => {
        const bytes = Buffer.alloc(options.length);
        bytes.write('ftyp', 4, 'ascii');
        setImmediate(() => callback(null, bytes));
      },
      close: callback => setImmediate(() => callback()),
    };
    this.client = null;
    this.files = [new WebTorrentFile(this, { name: 'feature.mp4', path: 'feature.mp4', length: VIDEO_BYTES, offset: 0 })];
    this.destroyObserved = false;
  }
  _destroyFileStreams() {
    for (const file of this.files) file._destroy();
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.destroyObserved = true;
    this._destroyFileStreams();
    this.emit('close');
  }
}

class FakeClient extends EventEmitter {
  constructor(mode) {
    super();
    this.mode = mode;
    this.torrent = null;
  }
  add(_descriptor, _options, ready) {
    this.torrent = new FakeTorrent(this.mode);
    setImmediate(() => ready(this.torrent));
    return this.torrent;
  }
  destroy(callback) {
    this.torrent?.destroy();
    if (this.mode !== 'zero-byte') setImmediate(() => callback?.());
  }
}

function modes() {
  try { return JSON.parse(process.env.MEDIA_TEST_MODES || '{}'); }
  catch { return {}; }
}

export function createContext() {
  const configuredModes = modes();
  return initializeContext(configuredModes);
}

async function initializeContext(configuredModes) {
  await patchWebTorrent();
  ({ default: WebTorrentFile } = await import('webtorrent/lib/file.js'));
  return {
    s3: { destroy() {} },
    bucket: 'fixture-bucket',
    statfs: async () => ({ bavail: 100000, bsize: 1024 ** 3 }),
    createClient: async (_options, item) => {
      const mode = configuredModes[item.quality] || 'zero-byte';
      if (mode === 'fatal') throw Object.assign(new Error('fixture R2 boundary failure'), { code: 'R2_UPLOAD_FAILED' });
      return new FakeClient(mode);
    },
    validateMp4: async (filePath, expectedBytes) => {
      const { stat } = await import('node:fs/promises');
      const info = await stat(filePath);
      if (!info.isFile() || info.size !== expectedBytes) throw new Error('fixture MP4 validation failed');
      return { bytes: info.size };
    },
    head: async () => null,
    query: async (sql) => {
      if (sql.startsWith('SELECT id,slug')) return [{ id: 9501, slug: 'fixture-9501', imdb_id: 'tt1234567', download_sources_json: JSON.stringify({ sources: [{ quality: '720p', url: MAGNET }, { quality: '1080p', url: MAGNET }] }), r2_storage_key: null, r2_video_bytes: null }];
      if (sql.startsWith('SELECT download_sources_json')) return [{ download_sources_json: JSON.stringify({ sources: [{ quality: '720p', url: MAGNET }, { quality: '1080p', url: MAGNET }] }) }];
      if (sql.startsWith('SELECT id, slug, ingest_status')) return [];
      return [];
    },
  };
}
