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
                 beforeFetch = async () => {} } = {}) {
  const requests = [], errors = [], backends = {}, heap = new Uint8Array(4096);
  let library;
  vm.runInNewContext(source, {
    addToLibrary(value) { library = value; },
    wasmFS$backends: backends, HEAPU8: heap,
    UTF8ToString: (s) => s,
    __wasmfs_fetch_get_file_url: (file) => file === 1 ? 'game//manifest.txt' : 'game//' + fileUrls[file],
    __wasmfs_fetch_get_chunk_size: () => chunkSize,
    self: { location: { href: 'https://game.test/WiiCompiled.js' } },
    URL, TextDecoder, crypto: webcrypto,
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
  return { backend: backends[1], requests, errors, heap };
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

test('video warmups fetch only the start of each clip, with a 64 MiB budget and two concurrent jobs', async () => {
  const mb = 1024 * 1024, rows = [];
  for (let index = 0; index < 40; index++) {
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
  for (let attempt = 0; attempt < 100 && (requests.length < 33 || active); attempt++) await tick();
  await tick();
  assert.equal(peak, 2);
  assert.equal(requests.length, 33); // manifest plus 32 two-MiB prefixes
});
