import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

const MAGNET = 'magnet:?xt=urn:btih:0123456789012345678901234567890123456789';
const VIDEO_BYTES = 10 * 1024 * 1024 + 12;

class HangingReadable extends Readable {
  _read() {}
}

class FakeFile {
  constructor(mode) {
    this.mode = mode;
    this.name = 'feature.mp4';
    this.length = VIDEO_BYTES;
    this.streams = [];
  }
  select() {}
  createReadStream() {
    const bytes = Buffer.alloc(this.length);
    bytes.write('ftyp', 4, 'ascii');
    const stream = this.mode === 'success' ? Readable.from([bytes]) : new HangingReadable();
    this.streams.push(stream);
    return stream;
  }
}

class FakeTorrent extends EventEmitter {
  constructor(mode) {
    super();
    this.mode = mode;
    this.infoHash = '0123456789012345678901234567890123456789';
    this.length = VIDEO_BYTES;
    this.pieceLength = 1024 * 1024;
    this.pieces = [Buffer.alloc(20)];
    this.wires = [];
    this.files = [new FakeFile(mode)];
    this.destroyObserved = false;
  }
  deselect() {}
  destroy() {
    this.destroyObserved = true;
    for (const file of this.files) for (const stream of file.streams) stream.destroy(new Error('fixture torrent destroyed'));
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
  return {
    s3: { destroy() {} },
    bucket: 'fixture-bucket',
    statfs: async () => ({ bavail: 100000, bsize: 1024 ** 3 }),
    createClient: async (_options, item) => {
      const mode = configuredModes[item.quality] || 'zero-byte';
      if (mode === 'fatal') throw Object.assign(new Error('fixture R2 boundary failure'), { code: 'R2_UPLOAD_FAILED' });
      return new FakeClient(mode);
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