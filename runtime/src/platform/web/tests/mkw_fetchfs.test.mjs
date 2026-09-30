import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const manifest = '# café\nd DATA\nd DATA/sys\nf 10 DATA/sys/fst.bin\nf 12 DATA/files/test.bin\n';
const manifestBytes = new TextEncoder().encode(manifest);
const source = (await readFile(new URL('../mkw_fetchfs.js', import.meta.url), 'utf8'))
  .replace(/\{\{\{\s*cDefs\.(\w+)\s*\}\}\}/g, (_, name) => ({ EROFS: 30, ENOENT: 2, EIO: 5 })[name]);

function setup({ invalidManifest = false, ignoreRange = false, aliases = '' } = {}) {
  const requests = [], errors = [], backends = {}, heap = new Uint8Array(4096);
  let library;
  vm.runInNewContext(source, {
    addToLibrary(value) { library = value; },
    wasmFS$backends: backends, HEAPU8: heap,
    UTF8ToString: (s) => s,
    __wasmfs_fetch_get_file_url: (file) => file === 1 ? 'game//manifest.txt' : 'game//DATA/files/test.bin',
    __wasmfs_fetch_get_chunk_size: () => 4,
    self: { location: { href: 'https://game.test/WiiCompiled.js' } },
    URL, TextDecoder,
    console: { error: (...args) => errors.push(args.join(' ')) },
    fetch: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      // Reproduce a hosted/cached HEAD with an unusable length. The manifest's own GET
      // contains the correct bytes, so boot must not depend on this second request.
      if (options.method === 'HEAD') return new Response(null, { headers: { 'Content-Length': '0' } });
      if (/manifest(?:-v2)?\.txt$/.test(String(url))) {
        return new Response(invalidManifest ? '<html>Sign in</html>' : new TextEncoder().encode(manifest + aliases));
      }
      const data = new TextEncoder().encode('abcdefghijkl');
      if (ignoreRange) return new Response(data);
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
