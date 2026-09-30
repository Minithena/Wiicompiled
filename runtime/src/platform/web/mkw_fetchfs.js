// Replacement for the JS half of Emscripten's WASMFS fetch backend (web_platform.cpp mounts it at
// /game). Two problems with the stock one (src/lib/libwasmfs_fetch.js, Emscripten 6.0.10):
//  - A file between one and two chunks long is downloaded whole, but later reads index its
//    chunks by the backend chunk size instead of the whole-file size, splicing wrong bytes in.
//  - Learning a file's size costs a HEAD plus a data fetch, so scanning the 2000-file disc at
//    start-up downloads a large part of it.
// Here sizes come from game/manifest.txt ("f <size> <path>"), reads fetch exactly the
// chunk-aligned ranges they need, and fetched chunks are kept in a bounded LRU cache.
//
// This runs on the WASMFS proxy worker, not on the thread that created the backend, so the
// manifest is fetched again here rather than handed over from C++.

addToLibrary({
  _wasmfs_create_fetch_backend_js__deps: [
    '$wasmFS$backends', '_wasmfs_fetch_get_file_url', '_wasmfs_fetch_get_chunk_size',
  ],
  _wasmfs_create_fetch_backend_js: function(backend) {
    const CACHE_LIMIT = 384 * 1024 * 1024;

    // The backend must be registered before this function yields (the proxy starts calling it
    // straight away), so lookups wait on the manifest instead.
    let manifestBytes;
    const aliases = new Map();
    const sizesReady = (async () => {
      const sizes = new Map();
      const response = await fetch('game/manifest-v2.txt', {cache: 'no-store'});
      if (!response.ok) throw new Error('HTTP ' + response.status);
      manifestBytes = new Uint8Array(await response.arrayBuffer());
      for (const line of new TextDecoder().decode(manifestBytes).split(/\r?\n/)) {
        const match = /^f (\d+) (.+)$/.exec(line);
        if (match) sizes.set('/game/' + match[2], Number(match[1]));
        if (line.startsWith('u ')) {
          const alias = JSON.parse(line.slice(2));
          if (!Array.isArray(alias) || alias.length !== 2 || typeof alias[0] !== 'string' ||
              typeof alias[1] !== 'string' || !/^web-videos\/[a-f0-9]{64}\.thp$/.test(alias[1])) {
            throw new Error('Invalid browser video alias');
          }
          aliases.set('/game/' + alias[0], new URL('game/' + alias[1], self.location.href).href);
        }
      }
      if (!(sizes.get('/game/DATA/sys/fst.bin') > 0)) throw new Error('missing disc file entries');
      // The manifest has already arrived. Reuse its bytes instead of a second HEAD/range
      // request, whose cached or stripped Content-Length can incorrectly report an empty file.
      sizes.set('/game/manifest.txt', manifestBytes.byteLength);
      return sizes;
    })().catch((failed) => {
      console.error('[web] Failed to load game manifest: ' + failed);
      return null;
    });

    // file pointer -> { url, size, chunkSize, chunks: Map<index, Uint8Array> }
    const files = new Map();
    // "<file>:<index>" -> byte length, in least-recently-used-first order
    const lru = new Map();
    let cachedBytes = 0;

    function touch(file, index, length) {
      const key = file + ':' + index;
      if (lru.has(key)) lru.delete(key); else cachedBytes += length;
      lru.set(key, length);
      for (const [oldKey, oldLength] of lru) {
        if (cachedBytes <= CACHE_LIMIT) break;
        const [oldFile, oldIndex] = oldKey.split(':').map(Number);
        if (oldFile === file && oldIndex === index) continue;
        lru.delete(oldKey);
        files.get(oldFile)?.chunks.delete(oldIndex);
        cachedBytes -= oldLength;
      }
    }

    async function describe(file) {
      let info = files.get(file);
      if (info) return info;
      const url = new URL(UTF8ToString(__wasmfs_fetch_get_file_url(file)), self.location.href);
      url.pathname = url.pathname.replace(/\/+/g, '/');
      const key = url.pathname;
      const sizes = await sizesReady;
      if (!sizes) throw new Error('Game manifest could not be loaded');
      let size = sizes.get(key);
      if (aliases.has(key)) url.href = aliases.get(key);
      if (size === undefined) {
        // Optional files absent from the manifest still need a metadata lookup.
        const head = await fetch(url, {method: 'HEAD'});
        if (!head.ok) throw head;
        const length = head.headers.get('Content-Length');
        size = length === null ? NaN : Number(length);
        if (!Number.isSafeInteger(size) || size < 0) throw new Error('Missing file length: ' + key);
      }
      info = {url, size, chunkSize: __wasmfs_fetch_get_chunk_size(file), chunks: new Map()};
      files.set(file, info);
      if (key === '/game/manifest.txt') {
        for (let offset = 0, index = 0; offset < size; offset += info.chunkSize, index++) {
          const chunk = manifestBytes.slice(offset, offset + info.chunkSize);
          info.chunks.set(index, chunk);
          touch(file, index, chunk.byteLength);
        }
      }
      return info;
    }

    async function ensure(file, info, first, last) {
      let missingFirst = -1, missingLast = -1;
      for (let i = first; i <= last; i++) {
        if (info.chunks.has(i)) {
          touch(file, i, info.chunks.get(i).byteLength);
        } else {
          if (missingFirst < 0) missingFirst = i;
          missingLast = i;
        }
      }
      if (missingFirst < 0) return;
      const start = missingFirst * info.chunkSize;
      const end = Math.min((missingLast + 1) * info.chunkSize, info.size) - 1;
      const response = await fetch(info.url, {headers: {'Range': `bytes=${start}-${end}`}});
      if (!response.ok) throw response;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (response.status === 200 && bytes.byteLength === info.size) {
        // The server ignored the range and sent the whole file.
        for (let i = missingFirst; i <= missingLast; i++) {
          const chunk = bytes.slice(i * info.chunkSize, (i + 1) * info.chunkSize);
          info.chunks.set(i, chunk);
          touch(file, i, chunk.byteLength);
        }
        return;
      }
      if (response.status !== 206 || bytes.byteLength !== end - start + 1) throw {status: 0};
      for (let i = missingFirst; i <= missingLast; i++) {
        const chunk = bytes.slice(i * info.chunkSize - start, (i + 1) * info.chunkSize - start);
        info.chunks.set(i, chunk);
        touch(file, i, chunk.byteLength);
      }
    }

    wasmFS$backends[backend] = {
      allocFile: async (file) => {},
      freeFile: async (file) => {
        const info = files.get(file);
        if (!info) return;
        for (const [index, chunk] of info.chunks) {
          lru.delete(file + ':' + index);
          cachedBytes -= chunk.byteLength;
        }
        files.delete(file);
      },
      write: async (file, buffer, length, offset) => -{{{ cDefs.EROFS }}},
      read: async (file, buffer, length, offset) => {
        if (offset < 0 || length <= 0) return 0;
        let info;
        try {
          info = await describe(file);
          length = Math.min(length, info.size - offset);
          if (length <= 0) return 0;
          const first = Math.floor(offset / info.chunkSize);
          const last = Math.floor((offset + length - 1) / info.chunkSize);
          await ensure(file, info, first, last);
          for (let i = first; i <= last; i++) {
            const chunkStart = i * info.chunkSize;
            const from = Math.max(chunkStart, offset);
            const to = Math.min(chunkStart + info.chunkSize, offset + length);
            HEAPU8.set(info.chunks.get(i).subarray(from - chunkStart, to - chunkStart),
                       buffer + (from - offset));
          }
          return length;
        } catch (failed) {
          return failed && failed.status === 404 ? -{{{ cDefs.ENOENT }}} : -{{{ cDefs.EIO }}};
        }
      },
      getSize: async (file) => {
        try {
          return (await describe(file)).size;
        } catch (failed) {
          return 0;
        }
      },
    };
  },
});
