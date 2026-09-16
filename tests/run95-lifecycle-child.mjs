import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';

const mode = process.argv[2] || 'mixed';
const modeMap = mode === 'both-zero-byte'
  ? { '720p': 'zero-byte', '1080p': 'zero-byte' }
  : mode === 'reverse'
    ? { '720p': 'success', '1080p': 'zero-byte' }
    : mode === 'both-success'
      ? { '720p': 'success', '1080p': 'success' }
      : mode === 'fatal'
        ? { '720p': 'fatal', '1080p': 'success' }
        : { '720p': 'zero-byte', '1080p': 'success' };
const env = {
  ...process.env,
  PREPARE_CLOUD_MEDIA_CONTEXT_MODULE: 'tests/run95-cli-context.mjs',
  TRANSFER_MOVIE_IDS: '9501',
  TRANSFER_METADATA_TIMEOUT_SECONDS: '0.04',
  TRANSFER_NO_PROGRESS_TIMEOUT_SECONDS: '0.04',
  TRANSFER_CLEANUP_TIMEOUT_SECONDS: '0.08',
  MEDIA_TEST_MODES: JSON.stringify(modeMap),
};
await rm('tmp/r2-video-manifest.json', { force: true });
await rm('tmp/media/9501-720p', { recursive: true, force: true });
await rm('tmp/media/9501-1080p', { recursive: true, force: true });
const child = spawn(process.execPath, ['scripts/prepare-cloud-media.mjs', '--max-movies=1'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '';
let stderr = '';
child.stdout.on('data', chunk => { stdout += chunk; });
child.stderr.on('data', chunk => { stderr += chunk; });
const result = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('close', (code, signal) => resolve({ code, signal }));
});
let manifest = null;
try { manifest = JSON.parse(await readFile('tmp/r2-video-manifest.json', 'utf8')); } catch {}
await rm('tmp/r2-video-manifest.json', { force: true });
await rm('tmp/media/9501-720p', { recursive: true, force: true });
await rm('tmp/media/9501-1080p', { recursive: true, force: true });
if (mode === 'fatal') {
  if (result.code === 0) throw new Error('fatal CLI fixture unexpectedly succeeded');
  console.log(JSON.stringify({ event: 'RUN95_FATAL_SETTLED', code: result.code, signal: result.signal, stderr }));
} else {
  if (result.code !== 0 || result.signal) throw new Error(`literal CLI failed: ${result.code}/${result.signal}\n${stderr}`);
  if (/unsettled top-level await|exit code 13/i.test(stderr)) throw new Error('literal CLI emitted an unsettled-await failure');
  const byQuality = Object.fromEntries((manifest?.files || []).map(item => [item.quality, item]));
  const expected = {
    mixed: { '720p': 'NO_PEERS', '1080p': 'prepared', media: 'HALF' },
    reverse: { '720p': 'prepared', '1080p': 'NO_PEERS', media: 'HALF' },
    'both-zero-byte': { '720p': 'NO_PEERS', '1080p': 'NO_PEERS', media: 'FAILED' },
    'both-success': { '720p': 'prepared', '1080p': 'prepared', media: 'READY' },
  }[mode];
  for (const quality of ['720p', '1080p']) {
    if (expected[quality] === 'prepared' && !byQuality[quality]?.file) throw new Error(`literal CLI did not stage successful ${quality}`);
    if (expected[quality] !== 'prepared' && byQuality[quality]?.failureCode !== expected[quality]) throw new Error(`literal CLI did not preserve ${quality} ${expected[quality]}`);
  }
  console.log(JSON.stringify({ event: 'RUN95_SETTLED', code: result.code, signal: result.signal, attempts: ['720p:1', '1080p:1'], prepared: Object.values(byQuality).filter(item => item.file).length, quality_720: expected['720p'], quality_1080: expected['1080p'], downstream_r2_reachable: true, expected_media_state: expected.media }));
}