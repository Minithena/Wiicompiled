import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import vm from 'node:vm';

const manifest = '# café\nd DATA\nd DATA/sys\nf 10 DATA/sys/fst.bin\nf 12 DATA/files/test.bin\n';
const manifestBytes = new TextEncoder().encode(manifest);
const source = (await readFile(new URL('../mkw_fetchfs.js', import.meta.url), 'utf8'))
  .replace(/\{\{\{\s*cDefs\.(\w+)\s*\}\}\}/g, (_, name) => ({ EROFS: 30, ENOENT: 2, EIO: 5 })[name]);

const encode = (text) => new TextEncoder().encode(text);
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function setup({ invalidManifest = false, ignoreRange = false, aliases = '', manifestText = manifest,
                 fileUrls = { 2: 'DATA/files/test.bin' }, contents = {}, chunkSize = 4,
                 beforeFetch = async () => {}, now = () => performance.now(), cacheLimit } = {}) {
  const requests = [], errors = [], backends = {}, heap = new Uint8Array(4096);
  const channels = [];
  let library;
  const testSource = cacheLimit === undefined ? source
    : source.replace('const CACHE_LIMIT = 384 * 1024 * 1024;', 'const CACHE_LIMIT = ' + cacheLimit + ';');
  vm.runInNewContext(testSource, {
    addToLibrary(value) { library = value; },
    wasmFS$backends: backends, HEAPU8: heap,
    UTF8ToString: (s) => s,
    __wasmfs_fetch_get_file_url: (file) => file === 1 ? 'game//manifest.txt' : 'game//' + fileUrls[file],
    __wasmfs_fetch_get_chunk_size: () => chunkSize,
    self: { location: { href: 'https://game.test/WiiCompiled.js' } },
    URL, TextDecoder, AbortController, crypto: webcrypto,
    performance: { now },
    BroadcastChannel: class { constructor(name) { this.name = name; channels.push(this); } },
    console: { error: (...args) => errors.push(args.join(' ')) },
    fetch: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      const override = await beforeFetch(String(url), options);
      if (override) return override;
      // Reproduce a hosted/cached HEAD with an unusable length. The manifest's own GET
      // contains the correct bytes, so boot must not depend on this second request.
      if (options.method === 'HEAD') return new Response(null, { headers: { 'Content-Length': '0' } });
      if (/manifest(?:-v2)?\.txt$/.test(String(url))) {
        return new Response(invalidManifest ? '<html>Sign in</html>' : encode(manifestText + aliases));
      }
      const data = contents[new URL(url).pathname.replace(/^\/game\//, '')] ?? encode('abcdefghijkl');
      if (ignoreRange || !options.headers?.Range) return new Response(data);
      const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
      return new Response(data.slice(Number(first), Number(last) + 1), { status: 206 });
    },
  });
  library._wasmfs_create_fetch_backend_js(1);
  return { backend: backends[1], requests, errors, heap, channels };
}

test('manifest size and bytes come from one uncached GET, regardless of broken HEAD metadata', async () => {
  const { backend, requests, heap } = setup();
  assert.equal(await backend.getSize(1), manifestBytes.length);
  assert.equal(await backend.read(1, 0, manifestBytes.length, 0), manifestBytes.length);
  assert.deepEqual(heap.slice(0, manifestBytes.length), manifestBytes);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.cache, 'no-store');
});

test('file ranges use canonical URLs and preserve reads across chunk boundaries', async () => {
  const { backend, requests, heap } = setup();
  assert.equal(await backend.getSize(2), 12);
  assert.equal(await backend.read(2, 0, 8, 2), 8);
  assert.equal(new TextDecoder().decode(heap.slice(0, 8)), 'cdefghij');
  assert.equal(requests[1].url, 'https://game.test/game/DATA/files/test.bin');
  assert.equal(requests[1].options.headers.Range, 'bytes=0-11');
});

test('a server that ignores ranges still supplies the correct requested bytes', async () => {
  const { backend, heap } = setup({ ignoreRange: true });
  assert.equal(await backend.read(2, 0, 6, 5), 6);
  assert.equal(new TextDecoder().decode(heap.slice(0, 6)), 'fghijk');
});

test('whole-file fallback preserves a short final chunk and rejects a body with the wrong size', async () => {
  const manifestText = manifest.replace('f 12 DATA/files/test.bin', 'f 10 DATA/files/test.bin');
  const options = {
    manifestText, ignoreRange: true, chunkSize: 4,
    contents: { 'DATA/files/test.bin': encode('abcdefghij') },
  };
  const { backend, heap, requests } = setup(options);
  heap.fill(123);
  assert.equal(await backend.read(2, 0, 4, 8), 2);
  assert.equal(new TextDecoder().decode(heap.slice(0, 2)), 'ij');
  assert.ok(heap.slice(2).every(byte => byte === 123));
  assert.equal(requests[1].options.headers.Range, 'bytes=8-9');

  const corrupt = setup({
    ...options,
    contents: { 'DATA/files/test.bin': encode('abcdefghijkl') },
  });
  corrupt.heap.fill(123);
  assert.equal(await corrupt.backend.read(2, 0, 4, 8), -5);
  assert.ok(corrupt.heap.every(byte => byte === 123));
});

test('an HTML login response cannot become an empty successful manifest', async () => {
  const { backend, errors } = setup({ invalidManifest: true });
  assert.equal(await backend.getSize(1), 0);
  assert.equal(await backend.read(1, 0, 10, 0), -5);
  assert.ok(errors.some((message) => /manifest/i.test(message)));
});

test('browser video aliases keep logical file sizes and use immutable download URLs', async () => {
  const target = 'web-videos/' + 'a'.repeat(64) + '.thp';
  const { backend, requests, heap } = setup({ aliases: 'u ' + JSON.stringify(['DATA/files/test.bin', target]) + '\n' });
  assert.equal(await backend.getSize(2), 12);
  assert.equal(await backend.read(2, 0, 4, 0), 4);
  assert.equal(new TextDecoder().decode(heap.slice(0, 4)), 'abcd');
  assert.equal(requests[0].url, 'game/manifest-v2.txt');
  assert.equal(requests[1].url, 'https://game.test/game/' + target);
});

test('concurrent cold reads share a single file description and download', async () => {
  const gate = deferred();
  const { backend, requests, heap } = setup({
    beforeFetch: async (url) => { if (url.endsWith('test.bin')) await gate.promise; },
  });
  const first = backend.read(2, 0, 8, 0);
  const second = backend.read(2, 20, 4, 4);
  await tick();
  assert.equal(requests.length, 2); // manifest plus one range
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), [8, 4]);
  assert.equal(new TextDecoder().decode(heap.slice(20, 24)), 'efgh');
});

test('packed files share one verified download and preserve file-relative offsets', async () => {
  const payload = encode('abcdefghijkl0123456789');
  const target = 'file-packs/' + createHash('sha256').update(payload).digest('hex') + '.bin';
  const packed = [['DATA/files/test.bin', target, 0, 12], ['DATA/files/other.bin', target, 12, 10]];
  const { backend, requests, heap } = setup({
    manifestText: manifest + 'f 10 DATA/files/other.bin\n',
    aliases: packed.map((row) => 'p ' + JSON.stringify(row) + '\n').join(''),
    fileUrls: { 2: 'DATA/files/test.bin', 3: 'DATA/files/other.bin' },
    contents: { [target]: payload },
  });
  assert.deepEqual(await Promise.all([backend.read(2, 0, 6, 3), backend.read(3, 20, 7, 3)]), [6, 7]);
  assert.equal(new TextDecoder().decode(heap.slice(0, 6)), 'defghi');
  assert.equal(new TextDecoder().decode(heap.slice(20, 27)), '3456789');
  await backend.freeFile(2);
  assert.equal(await backend.read(2, 40, 4, 8), 4);
  assert.equal(new TextDecoder().decode(heap.slice(40, 44)), 'ijkl');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].options.cache, 'force-cache');
});

test('corrupt or truncated packs never copy invalid bytes into game memory', async () => {
  for (const corruption of ['checksum', 'bounds', 'size']) {
    const payload = encode('abcdefghijkl');
    const hash = corruption === 'checksum' ? '0'.repeat(64) : createHash('sha256').update(payload).digest('hex');
    const target = 'file-packs/' + hash + '.bin';
    const row = ['DATA/files/test.bin', target, corruption === 'bounds' ? 1 : 0, corruption === 'size' ? 11 : 12];
    const { backend, heap } = setup({ aliases: 'p ' + JSON.stringify(row) + '\n', contents: { [target]: payload } });
    heap.fill(123);
    assert.equal(await backend.read(2, 0, 4, 0), -5, corruption);
    assert.ok(heap.every((byte) => byte === 123), corruption);
  }
});

test('a failed pack download is retried by the next read', async () => {
  const payload = encode('abcdefghijkl');
  const target = 'file-packs/' + createHash('sha256').update(payload).digest('hex') + '.bin';
  let attempts = 0;
  const { backend, heap } = setup({
    aliases: 'p ' + JSON.stringify(['DATA/files/test.bin', target, 0, 12]) + '\n',
    contents: { [target]: payload },
    beforeFetch: async (url) => { if (url.includes('/file-packs/') && ++attempts === 1) return new Response(null, { status: 503 }); },
  });
  assert.equal(await backend.read(2, 0, 4, 0), -5);
  assert.equal(await backend.read(2, 0, 4, 0), 4);
  assert.equal(new TextDecoder().decode(heap.slice(0, 4)), 'abcd');
  assert.equal(attempts, 2);
});

test('an archive header read fetches the bounded archive once for subsequent reads', async () => {
  const { backend, requests, heap } = setup({
    manifestText: manifest.replace('test.bin', 'test.szs'), fileUrls: { 2: 'DATA/files/test.szs' },
  });
  assert.equal(await backend.read(2, 0, 2, 0), 2);
  assert.equal(requests[1].options.headers.Range, 'bytes=0-11');
  assert.equal(await backend.read(2, 20, 6, 6), 6);
  assert.equal(new TextDecoder().decode(heap.slice(20, 26)), 'ghijkl');
  assert.equal(requests.length, 2);
});

test('large archives keep bounded range reads instead of downloading the whole file', async () => {
  const { backend, requests } = setup({
    manifestText: manifest.replace('f 12 DATA/files/test.bin', 'f 16777217 DATA/files/test.szs'),
    fileUrls: { 2: 'DATA/files/test.szs' },
  });
  assert.equal(await backend.read(2, 0, 2, 0), 2);
  assert.equal(requests[1].options.headers.Range, 'bytes=0-3');
});

function videoSetup(options = {}) {
  return setup({
    manifestText: manifest.replace('f 12 DATA/files/test.bin', 'f 40 DATA/files/test.thp'),
    fileUrls: { 2: 'DATA/files/test.thp' },
    contents: { 'DATA/files/test.thp': encode('0123456789'.repeat(4)) },
    ...options,
  });
}

test('video reads return before read-ahead completes and demand joins that download', async () => {
  const gate = deferred();
  const { backend, requests, heap } = videoSetup({
    beforeFetch: async (_url, options) => { if (options.headers?.Range === 'bytes=4-19') await gate.promise; },
  });
  assert.equal(await backend.read(2, 0, 4, 0), 4);
  assert.equal(requests[2].options.headers.Range, 'bytes=4-19');
  const demand = backend.read(2, 20, 4, 4);
  await tick();
  assert.equal(requests.length, 3);
  gate.resolve();
  assert.equal(await demand, 4);
  assert.equal(new TextDecoder().decode(heap.slice(20, 24)), '4567');
  assert.equal(requests.length, 3);
  // With two chunks still buffered, start another four-chunk batch.
  assert.equal(await backend.read(2, 30, 4, 8), 4);
  assert.equal(requests[3].options.headers.Range, 'bytes=20-35');
});

test('a failed background video read can be retried on demand', async () => {
  let failed = false;
  const { backend, requests, heap } = videoSetup({
    beforeFetch: async (_url, options) => {
      if (!failed && options.headers?.Range === 'bytes=4-19') {
        failed = true;
        return new Response(null, { status: 503 });
      }
    },
  });
  assert.equal(await backend.read(2, 0, 4, 0), 4);
  await tick();
  assert.equal(await backend.read(2, 20, 4, 4), 4);
  assert.equal(requests[3].options.headers.Range, 'bytes=4-7');
  assert.equal(new TextDecoder().decode(heap.slice(20, 24)), '4567');
});

test('a complete streamed chunk can be read while the rest of its prefetch is still downloading', async (t) => {
  const tail = deferred();
  t.after(() => tail.resolve());
  const { backend, heap, requests } = videoSetup({
    beforeFetch: async (_url, options) => {
      if (options.headers?.Range !== 'bytes=4-19') return;
      return new Response(new ReadableStream({
        async start(controller) {
          controller.enqueue(encode('45'));
          controller.enqueue(encode('67')); // one complete cache chunk, split across network packets
          await tail.promise;
          controller.enqueue(encode('890123456789'));
          controller.close();
        },
      }), { status: 206, headers: { 'Content-Range': 'bytes 4-19/40' } });
    },
  });
  assert.equal(await backend.read(2, 0, 4, 0), 4);
  let completed = false;
  const demand = backend.read(2, 20, 4, 4).then(value => { completed = true; return value; });
  await tick();
  assert.equal(completed, true, 'demand must not wait for the later three chunks');
  assert.equal(await demand, 4);
  assert.equal(new TextDecoder().decode(heap.slice(20, 24)), '4567');
  assert.equal(requests.length, 3);
  tail.resolve();
  await tick();
});

test('truncated prefetch keeps complete chunks but never publishes an incomplete chunk', async () => {
  const { backend, heap, requests } = videoSetup({
    beforeFetch: async (_url, options) => {
      if (options.headers?.Range === 'bytes=4-19') {
        return new Response(encode('4567xx'), { status: 206 });
      }
    },
  });
  assert.equal(await backend.read(2, 0, 4, 0), 4);
  await tick();
  assert.equal(await backend.read(2, 20, 4, 8), 4);
  assert.equal(new TextDecoder().decode(heap.slice(20, 24)), '8901');
  assert.equal(requests[3].options.headers.Range, 'bytes=8-11');
});

test('a mismatched Content-Range cannot put bytes at the wrong file offset', async () => {
  const { backend, heap } = setup({
    beforeFetch: async (_url, options) => {
      if (options.headers?.Range) return new Response(encode('abcd'), {
        status: 206, headers: { 'Content-Range': 'bytes 0-3/12' },
      });
    },
  });
  heap.fill(123);
  assert.equal(await backend.read(2, 0, 4, 4), -5);
  assert.ok(heap.every(byte => byte === 123));
});

test('a cold read cannot recreate a file handle freed while its manifest lookup is pending', async (t) => {
  const manifestGate = deferred(), manifestStarted = deferred();
  t.after(() => manifestGate.resolve());
  const { backend, heap } = setup({
    beforeFetch: async (url) => {
      if (url.endsWith('/manifest-v2.txt')) {
        manifestStarted.resolve();
        await manifestGate.promise;
      }
    },
  });
  await manifestStarted.promise;
  await backend.allocFile(2);
  const read = backend.read(2, 0, 4, 0);
  await tick();
  await backend.freeFile(2);
  manifestGate.resolve();
  assert.equal(await read, -5);
  assert.ok(heap.every(byte => byte === 0));
});

test('freeing a handle aborts its optional-file metadata request', async () => {
  const headStarted = deferred();
  let headSignal;
  const { backend } = setup({
    fileUrls: { 2: 'DATA/files/optional.bin' },
    beforeFetch: async (_url, options) => {
      if (options.method !== 'HEAD') return;
      headSignal = options.signal;
      headStarted.resolve();
      return new Promise((_, reject) => {
        const abort = () => reject(new Error('mock HEAD aborted'));
        if (headSignal.aborted) abort();
        else headSignal.addEventListener('abort', abort, { once: true });
      });
    },
  });
  await backend.allocFile(2);
  const size = backend.getSize(2);
  await headStarted.promise;
  await backend.freeFile(2);
  assert.equal(await size, 0);
  assert.equal(headSignal.aborted, true);
});

test('a reused file pointer cannot let its old shared-resource read write into the new handle', async (t) => {
  const rangeGate = deferred(), rangeStarted = deferred();
  t.after(() => rangeGate.resolve());
  const { backend, heap } = setup({
    fileUrls: { 2: 'DATA/files/test.bin', 3: 'DATA/files/test.bin' },
    beforeFetch: async (url, options) => {
      if (url.endsWith('test.bin') && options.headers?.Range === 'bytes=0-3') {
        rangeStarted.resolve();
        await rangeGate.promise;
      }
    },
  });
  await backend.allocFile(2);
  await backend.allocFile(3);
  heap.fill(123);
  const stale = backend.read(2, 0, 4, 0);
  await rangeStarted.promise;
  await backend.freeFile(2);
  await backend.allocFile(2); // the same pointer now names a new open handle
  const current = backend.read(2, 20, 4, 0);
  rangeGate.resolve();
  assert.equal(await stale, -5);
  assert.equal(await current, 4);
  assert.ok(heap.slice(0, 4).every(byte => byte === 123));
  assert.equal(new TextDecoder().decode(heap.slice(20, 24)), 'abcd');
});

test('closing one handle settles only its read while another handle keeps the shared fetch alive', async (t) => {
  const rangeGate = deferred(), rangeStarted = deferred();
  t.after(() => rangeGate.resolve());
  let rangeSignal;
  const { backend, heap } = setup({
    fileUrls: { 2: 'DATA/files/test.bin', 3: 'DATA/files/test.bin' },
    beforeFetch: async (url, options) => {
      if (url.endsWith('test.bin') && options.headers?.Range === 'bytes=0-3') {
        rangeSignal = options.signal;
        rangeStarted.resolve();
        await rangeGate.promise;
      }
    },
  });
  await backend.allocFile(2);
  await backend.allocFile(3);
  const closedHandleRead = backend.read(2, 0, 4, 0);
  await rangeStarted.promise;
  const liveHandleRead = backend.read(3, 20, 4, 0);
  await tick();
  await backend.freeFile(2);
  assert.equal(await closedHandleRead, -5);
  assert.equal(rangeSignal.aborted, false);
  rangeGate.resolve();
  assert.equal(await liveHandleRead, 4);
  assert.equal(new TextDecoder().decode(heap.slice(20, 24)), 'abcd');
});

test('freeing a file settles readers waiting on its stalled in-flight chunk', async (t) => {
  const networkGate = deferred(), fetchStarted = deferred();
  t.after(() => networkGate.resolve());
  const { backend } = setup({
    beforeFetch: async (url, options) => {
      if (!url.endsWith('test.bin') || options.headers?.Range !== 'bytes=0-3') return;
      fetchStarted.resolve();
      let aborted = false;
      await new Promise((resolve) => {
        if (options.signal) {
          const onAbort = () => { aborted = true; resolve(); };
          if (options.signal.aborted) onAbort();
          else options.signal.addEventListener('abort', onAbort, { once: true });
        } else {
          networkGate.promise.then(resolve);
        }
      });
      if (aborted || options.signal?.aborted) throw new Error('mock range request aborted');
    },
  });
  await backend.allocFile(2);
  const first = backend.read(2, 0, 4, 0);
  await fetchStarted.promise;
  const second = backend.read(2, 20, 4, 0);
  await tick();
  await backend.freeFile(2);
  const result = await Promise.race([
    Promise.all([first, second]).then(values => ({ values })),
    new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 50)),
  ]);
  networkGate.resolve();
  assert.deepEqual(result, { values: [-5, -5] });
});

test('an in-flight read cannot restore data after its file is freed', async () => {
  const gate = deferred();
  let attempts = 0;
  const { backend, requests, heap } = setup({
    beforeFetch: async (url) => { if (url.endsWith('test.bin') && ++attempts === 1) await gate.promise; },
  });
  const read = backend.read(2, 0, 4, 0);
  await tick();
  await backend.freeFile(2);
  gate.resolve();
  assert.equal(await read, -5);
  assert.ok(heap.every((byte) => byte === 0));
  assert.equal(await backend.read(2, 0, 4, 0), 4);
  assert.equal(requests.length, 3);
});

test('menu warmups stay in the background, use two requests, and satisfy demand without duplicates', async () => {
  const gate = deferred();
  const paths = ['DATA/files/Scene/UI/Title.szs', 'DATA/files/Scene/UI/Title_E.szs', 'DATA/files/Scene/UI/MenuSingle.szs'];
  const { backend, requests, heap } = setup({
    manifestText: manifest + paths.map(path => 'f 12 ' + path + '\n').join(''),
    fileUrls: { 2: paths[0], 3: paths[1], 4: paths[2] },
    beforeFetch: async url => { if (url.endsWith('.szs')) await gate.promise; },
  });
  assert.ok(await backend.getSize(1) > 0);
  await tick();
  assert.equal(requests.length, 3); // one manifest, two pending warmups
  const demand = backend.read(2, 0, 6, 2);
  await tick();
  assert.equal(requests.length, 3);
  gate.resolve();
  assert.equal(await demand, 6);
  assert.equal(new TextDecoder().decode(heap.slice(0, 6)), 'cdefgh');
  await tick();
  assert.equal(requests.length, 4);
  assert.equal(await backend.read(4, 20, 4, 8), 4);
  await backend.freeFile(2);
  assert.equal(await backend.read(2, 40, 4, 0), 4);
  assert.equal(requests.length, 4);
});

test('failed optional menu warmups do not block startup and can retry on demand', async () => {
  const path = 'DATA/files/Scene/UI/Title.szs';
  let attempts = 0;
  const { backend, heap } = setup({
    manifestText: manifest + 'f 12 ' + path + '\n', fileUrls: { 2: path },
    beforeFetch: async url => { if (url.endsWith('.szs') && ++attempts === 1) return new Response(null, { status: 503 }); },
  });
  assert.ok(await backend.getSize(1) > 0);
  await tick();
  assert.equal(await backend.read(2, 0, 4, 0), 4);
  assert.equal(attempts, 2);
  assert.equal(new TextDecoder().decode(heap.slice(0, 4)), 'abcd');
});

test('file handles share cached resources until their final reference is freed', async () => {
  const { backend, requests } = setup({ fileUrls: { 2: 'DATA/files/test.bin', 3: 'DATA/files/test.bin' } });
  assert.deepEqual(await Promise.all([backend.read(2, 0, 4, 0), backend.read(3, 20, 4, 0)]), [4, 4]);
  assert.equal(requests.length, 2);
  await backend.freeFile(2);
  assert.equal(await backend.read(3, 40, 4, 0), 4);
  assert.equal(requests.length, 2);
  await backend.freeFile(3);
  assert.equal(await backend.read(2, 60, 4, 0), 4);
  assert.equal(requests.length, 3);
});

test('video warmups fetch only the start of each clip, with a 160 MiB budget and two concurrent jobs', async () => {
  const mb = 1024 * 1024, rows = [];
  for (let index = 0; index < 80; index++) {
    const path = 'DATA/files/thp/course/test' + index + '.thp';
    const target = 'web-videos/' + index.toString(16).padStart(64, '0') + '.thp';
    rows.push('f ' + 20 * mb + ' ' + path, 'u ' + JSON.stringify([path, target]));
  }
  let active = 0, peak = 0;
  const { backend, requests } = setup({
    manifestText: manifest + rows.join('\n') + '\n', chunkSize: mb,
    beforeFetch: async (url, options) => {
      if (!url.endsWith('.thp')) return;
      active++;
      peak = Math.max(peak, active);
      await tick();
      active--;
      assert.equal(options.headers.Range, 'bytes=0-2097151');
      return new Response(new Uint8Array(2 * mb), { status: 206 });
    },
  });
  assert.ok(await backend.getSize(1) > 0);
  for (let attempt = 0; attempt < 100 && (requests.length < 81 || active); attempt++) await tick();
  await tick();
  assert.equal(peak, 2);
  assert.equal(requests.length, 81); // manifest plus 80 two-MiB prefixes
});

test('startup warms the shared race archives and the sound blocks a race fetches at its start', async () => {
  const mb = 1024 * 1024;
  const files = [['Race/Common.szs', mb], ['Scene/UI/Race.szs', mb], ['Scene/UI/Race_E.szs', mb / 4],
                 ['sound/revo_kart.brsar', 107 * mb]];
  const rows = files.map(([path, size]) => 'f ' + size + ' DATA/files/' + path);
  const { backend, requests } = setup({
    manifestText: manifest + rows.join('\n') + '\n', chunkSize: mb,
    beforeFetch: async (url, options) => {
      if (url.endsWith('.szs') || url.endsWith('.brsar')) {
        const [from, to] = options.headers.Range.slice(6).split('-').map(Number);
        return new Response(new Uint8Array(to - from + 1), { status: 206 });
      }
    },
  });
  assert.ok(await backend.getSize(1) > 0);
  for (let attempt = 0; attempt < 200 && requests.length < 1 + 3 + 3 + 4; attempt++) await tick();
  await tick();
  const fetched = requests.filter((request) => request.url.endsWith('.brsar'))
    .map((request) => request.options.headers.Range);
  // The four menu-sound ranges, then the race ranges (MiB 19-22, 25-27 and the whole 45-78 region).
  for (const [from, to] of [[19, 22], [25, 27], [45, 78]]) {
    assert.ok(fetched.includes('bytes=' + from * mb + '-' + (to * mb - 1)), 'range ' + from + '-' + to);
  }
  for (const name of ['Race/Common.szs', 'Scene/UI/Race.szs', 'Scene/UI/Race_E.szs']) {
    assert.ok(requests.some((request) => request.url.endsWith(name)), name);
  }
});

test('a music stream is fetched whole in one request instead of a chunk at a time', async () => {
  const mb = 1024 * 1024;
  const { backend, requests } = setup({
    manifestText: manifest + 'f ' + 5 * mb + ' DATA/files/sound/strm/test.brstm\n', chunkSize: mb,
    fileUrls: { 2: 'DATA/files/sound/strm/test.brstm' },
    beforeFetch: async (url, options) => {
      if (!url.endsWith('.brstm')) return;
      const [from, to] = options.headers.Range.slice(6).split('-').map(Number);
      return new Response(new Uint8Array(to - from + 1), { status: 206 });
    },
  });
  assert.equal(await backend.read(2, 10, 16, 3 * mb + 5), 16);
  const stream = requests.filter((request) => request.url.endsWith('.brstm'));
  assert.equal(stream.length, 1);
  assert.equal(stream[0].options.headers.Range, 'bytes=0-' + (5 * mb - 1));
});

test('opening a course stream also fetches its final-lap stream, whatever the letter case', async () => {
  const mb = 1024 * 1024;
  const { backend, requests } = setup({
    manifestText: manifest + 'f ' + 3 * mb + ' DATA/files/sound/strm/n_Circuit32_n.brstm\n' +
      'f ' + 2 * mb + ' DATA/files/sound/strm/n_Circuit32_f.brstm\n' +
      'f ' + 2 * mb + ' DATA/files/sound/strm/n_Other32_f.brstm\n', chunkSize: mb,
    fileUrls: { 2: 'DATA/files/sound/strm/n_Circuit32_n.brstm' },
    beforeFetch: async (url, options) => {
      if (!url.endsWith('.brstm')) return;
      const [from, to] = options.headers.Range.slice(6).split('-').map(Number);
      return new Response(new Uint8Array(to - from + 1), { status: 206 });
    },
  });
  assert.equal(await backend.read(2, 10, 16, 0), 16);
  for (let attempt = 0; attempt < 100 && requests.filter((r) => r.url.endsWith('.brstm')).length < 2; attempt++) await tick();
  const streams = requests.filter((request) => request.url.endsWith('.brstm'));
  assert.deepEqual(streams.map((request) => request.url.split('/').pop()).sort(),
                   ['n_Circuit32_f.brstm', 'n_Circuit32_n.brstm']);
  assert.equal(streams.find((r) => r.url.endsWith('_f.brstm')).options.headers.Range, 'bytes=0-' + (2 * mb - 1));
});

test('a course read fetches the next Grand Prix course in the background', async () => {
  const mb = 1024 * 1024;
  const { backend, requests } = setup({
    manifestText: manifest + 'f ' + 2 * mb + ' DATA/files/Race/Course/beginner_course.szs\n' +
      'f ' + 3 * mb + ' DATA/files/Race/Course/farm_course.szs\n' +
      'f ' + 3 * mb + ' DATA/files/Race/Course/kinoko_course.szs\n', chunkSize: mb,
    fileUrls: { 2: 'DATA/files/Race/Course/beginner_course.szs' },
    beforeFetch: async (url, options) => {
      if (!url.endsWith('.szs')) return;
      const [from, to] = options.headers.Range.slice(6).split('-').map(Number);
      return new Response(new Uint8Array(to - from + 1), { status: 206 });
    },
  });
  assert.equal(await backend.read(2, 10, 16, 0), 16);
  for (let attempt = 0; attempt < 100 && requests.filter((r) => r.url.endsWith('.szs')).length < 2; attempt++) await tick();
  const archives = requests.filter((request) => request.url.endsWith('.szs')).map((request) => request.url.split('/').pop());
  assert.deepEqual(archives.sort(), ['beginner_course.szs', 'farm_course.szs']);
});

test('opening a prefetched course continues warming the following Grand Prix course', async () => {
  const paths = ['beginner_course', 'farm_course', 'kinoko_course', 'factory_course']
    .map(name => 'DATA/files/Race/Course/' + name + '.szs');
  const { backend, requests, heap } = setup({
    manifestText: manifest + paths.map(path => 'f 12 ' + path + '\n').join(''),
    fileUrls: { 2: paths[0], 3: paths[1], 4: paths[2] },
  });
  assert.equal(await backend.read(2, 0, 4, 0), 4);
  await tick();
  assert.equal(await backend.read(3, 10, 4, 0), 4);
  await tick();
  assert.ok(requests.some(r => r.url.endsWith('/kinoko_course.szs')));
  assert.equal(requests.filter(r => r.url.endsWith('/farm_course.szs')).length, 1);
  assert.equal(new TextDecoder().decode(heap.slice(10, 14)), 'abcd');
  assert.equal(await backend.read(4, 20, 4, 0), 4);
  await tick();
  assert.ok(requests.some(r => r.url.endsWith('/factory_course.szs')));
});

test('failed race warmups retry before demand, with backoff rather than a request on every read', async () => {
  let time = 0, attempts = 0;
  const sourcePath = 'DATA/files/Race/Course/beginner_course.szs';
  const nextPath = 'DATA/files/Race/Course/farm_course.szs';
  const { backend, requests } = setup({
    manifestText: manifest + 'f 12 ' + sourcePath + '\nf 12 ' + nextPath + '\n',
    fileUrls: { 2: sourcePath, 3: nextPath }, now: () => time,
    beforeFetch: async url => {
      if (url.endsWith('/farm_course.szs') && ++attempts === 1) return new Response(null, { status: 503 });
    },
  });
  await backend.read(2, 0, 4, 0);
  await tick();
  assert.equal(attempts, 1);
  await backend.read(2, 0, 4, 0);
  await tick();
  assert.equal(attempts, 1);
  time = 1500;
  await backend.read(2, 0, 4, 0);
  await tick();
  assert.equal(attempts, 2);
  const count = requests.length;
  assert.equal(await backend.read(3, 0, 4, 0), 4);
  assert.equal(requests.length, count, 'the retried course should already be available');
});

test('a later race can warm related assets again after their cached bytes are evicted', async () => {
  const start = 'DATA/files/Race/Course/beginner_course.szs';
  const next = 'DATA/files/Race/Course/farm_course.szs';
  const filler = 'DATA/files/filler.bin';
  const { backend, requests } = setup({
    manifestText: manifest + 'f 12 ' + start + '\nf 12 ' + next + '\nf 24 ' + filler + '\n',
    fileUrls: { 2: start, 3: filler }, cacheLimit: 24,
    contents: { [filler]: encode('abcdefghijklmnopqrstuvwx') },
  });
  await backend.read(2, 0, 4, 0);
  await tick();
  assert.equal(requests.filter(r => r.url.endsWith('/farm_course.szs')).length, 1);
  assert.equal(await backend.read(3, 20, 24, 0), 24);
  assert.equal(await backend.read(2, 0, 4, 0), 4);
  await tick();
  assert.equal(requests.filter(r => r.url.endsWith('/farm_course.szs')).length, 2);
});

test('race roster warmups are bounded, deduplicate notifications, and do not block a demand read', async () => {
  const paths = Array.from({length: 12}, (_, i) => 'DATA/files/Race/Kart/test_kart-driver' + i + '.szs');
  const gates = new Map(paths.map(path => [path, deferred()]));
  let active = 0, peak = 0;
  const { backend, requests, channels, heap } = setup({
    manifestText: manifest + paths.map(path => 'f 12 ' + path + '\n').join(''),
    beforeFetch: async url => {
      const gate = gates.get(new URL(url, 'https://game.test').pathname.replace(/^\/game\//, ''));
      if (!gate) return;
      peak = Math.max(peak, ++active);
      await gate.promise;
      active--;
    },
  });
  await backend.getSize(1);
  const channel = channels.find(c => c.name === 'mkw-prefetch');
  channel.onmessage({data: {paths}});
  channel.onmessage({data: {paths}});
  await tick();
  assert.equal(requests.filter(r => r.url.includes('/Race/Kart/')).length, 6);
  assert.equal(await backend.read(2, 0, 4, 0), 4);
  assert.equal(new TextDecoder().decode(heap.slice(0, 4)), 'abcd');
  assert.equal(requests.find(r => r.url.endsWith('/test.bin')).options.priority, 'high');
  for (const gate of gates.values()) gate.resolve();
  for (let i = 0; i < 50 && requests.filter(r => r.url.includes('/Race/Kart/')).length < 12; i++) await tick();
  await tick();
  assert.equal(requests.filter(r => r.url.includes('/Race/Kart/')).length, 12);
  assert.equal(peak, 6);
  assert.ok(requests.filter(r => r.url.includes('/Race/Kart/')).every(r => r.options.priority === 'low'));
});

test('prefetched final-lap music is readable without another network request', async () => {
  const normal = 'DATA/files/sound/strm/n_Test_n.brstm';
  const final = 'DATA/files/sound/strm/n_Test_f.brstm';
  const { backend, requests, heap } = setup({
    manifestText: manifest + 'f 12 ' + normal + '\nf 12 ' + final + '\n',
    fileUrls: { 2: normal, 3: final },
  });
  await backend.read(2, 0, 4, 0);
  await tick();
  const count = requests.length;
  assert.equal(await backend.read(3, 20, 4, 4), 4);
  assert.equal(new TextDecoder().decode(heap.slice(20, 24)), 'efgh');
  assert.equal(requests.length, count);
});

test('selected race assets take the next free warmup slot ahead of speculative related files', async () => {
  const normals = Array.from({length: 7}, (_, i) => 'DATA/files/sound/strm/n_Test' + i + '_n.brstm');
  const finals = normals.map(path => path.replace('_n.brstm', '_f.brstm'));
  const kart = 'DATA/files/Race/Kart/test_kart-driver.szs';
  const gates = new Map([...finals, kart].map(path => [path, deferred()]));
  const { backend, requests, channels } = setup({
    manifestText: manifest + [...normals, ...finals, kart].map(path => 'f 12 ' + path + '\n').join(''),
    fileUrls: Object.fromEntries(normals.map((path, i) => [i + 2, path])),
    beforeFetch: async url => {
      const gate = gates.get(new URL(url, 'https://game.test').pathname.replace(/^\/game\//, ''));
      if (gate) await gate.promise;
    },
  });
  for (let i = 0; i < normals.length; i++) await backend.read(i + 2, 0, 4, 0);
  channels.find(c => c.name === 'mkw-prefetch').onmessage({data: {paths: [kart]}});
  await tick();
  assert.equal(requests.filter(r => r.url.endsWith('_f.brstm')).length, 6);
  assert.ok(!requests.some(r => r.url.endsWith('/test_kart-driver.szs')));
  gates.get(finals[0]).resolve();
  await tick();
  await tick();
  assert.ok(requests.some(r => r.url.endsWith('/test_kart-driver.szs')));
  assert.ok(!requests.some(r => r.url.endsWith('/n_Test6_f.brstm')));
  for (const gate of gates.values()) gate.resolve();
  await tick();
});

test('a chosen course arrives on the prefetch channel and is fetched; other paths are ignored', async () => {
  const course = 'DATA/files/Race/Course/castle_course.szs';
  const { backend, requests, channels } = setup({
    manifestText: manifest + 'f 12 ' + course + '\nf 12 DATA/files/Scene/UI/Other.szs\n',
  });
  await backend.getSize(1);
  const channel = channels.find(c => c.name === 'mkw-prefetch');
  channel.onmessage({data: {paths: [course, 'DATA/files/Scene/UI/Other.szs', '../escape.szs']}});
  await tick();
  assert.equal(requests.filter(r => r.url.endsWith('/castle_course.szs')).length, 1);
  assert.ok(!requests.some(r => r.url.endsWith('/Other.szs') || r.url.includes('escape')));
  channel.onmessage({data: {paths: [course]}});
  await tick();
  assert.equal(requests.filter(r => r.url.endsWith('/castle_course.szs')).length, 1);
});

test('a music stream over 8 MiB is still fetched whole', async () => {
  const mb = 1024 * 1024;
  const { backend, requests } = setup({
    manifestText: manifest + 'f ' + 21 * mb + ' DATA/files/sound/strm/big.brstm\n', chunkSize: mb,
    fileUrls: { 2: 'DATA/files/sound/strm/big.brstm' },
    beforeFetch: async (url, options) => {
      if (!url.endsWith('.brstm')) return;
      const [from, to] = options.headers.Range.slice(6).split('-').map(Number);
      return new Response(new Uint8Array(to - from + 1), { status: 206 });
    },
  });
  assert.equal(await backend.read(2, 10, 16, 15 * mb), 16);
  const stream = requests.filter((request) => request.url.endsWith('.brstm'));
  assert.equal(stream.length, 1);
  assert.equal(stream[0].options.headers.Range, 'bytes=0-' + (21 * mb - 1));
});

test('looking up a course or stream size alone does not prefetch its related files', async () => {
  const mb = 1024 * 1024;
  const { backend, requests } = setup({
    manifestText: manifest + 'f ' + 2 * mb + ' DATA/files/Race/Course/beginner_course.szs\n' +
      'f ' + 3 * mb + ' DATA/files/Race/Course/farm_course.szs\n', chunkSize: mb,
    fileUrls: { 2: 'DATA/files/Race/Course/beginner_course.szs' },
  });
  assert.equal(await backend.getSize(2), 2 * mb);
  for (let attempt = 0; attempt < 20; attempt++) await tick();
  assert.equal(requests.filter((request) => request.url.endsWith('.szs')).length, 0);
});

test('start-up files are requested at once, and .rel/.arc files are fetched whole', async () => {
  const mb = 1024 * 1024;
  const files = [['rel/StaticR.rel', 5 * mb], ['contents/HomeButton.arc', 2 * mb], ['Boot/Strap/eu/English.szs', mb / 4],
                 ['contents/RFLRes01.arc', mb / 2]];
  const { backend, requests } = setup({
    manifestText: manifest + files.map(([path, size]) => 'f ' + size + ' DATA/files/' + path).join('\n') + '\n', chunkSize: mb,
    fileUrls: { 2: 'DATA/files/rel/StaticR.rel' },
    beforeFetch: async (url, options) => {
      if (/manifest/.test(url)) return;
      const [from, to] = options.headers.Range.slice(6).split('-').map(Number);
      return new Response(new Uint8Array(to - from + 1), { status: 206 });
    },
  });
  assert.ok(await backend.getSize(1) > 0);
  for (let attempt = 0; attempt < 100 && requests.length < 5; attempt++) await tick();
  const ranges = Object.fromEntries(requests.filter((r) => !/manifest/.test(r.url))
    .map((r) => [r.url.split('/').pop(), r.options.headers.Range]));
  assert.equal(ranges['StaticR.rel'], 'bytes=0-' + (5 * mb - 1));
  assert.equal(ranges['HomeButton.arc'], 'bytes=0-' + (2 * mb - 1));
  assert.ok(ranges['English.szs'] && ranges['RFLRes01.arc']);
  assert.equal(await backend.read(2, 10, 16, 4 * mb), 16);
  assert.equal(requests.filter((r) => r.url.endsWith('StaticR.rel')).length, 1);
});
