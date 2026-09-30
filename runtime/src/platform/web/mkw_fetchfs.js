// Replacement for the JS half of Emscripten's WASMFS fetch backend (web_platform.cpp mounts it at
// /game). Two problems with the stock one (src/lib/libwasmfs_fetch.js, Emscripten 6.0.10):
//  - A file between one and two chunks long is downloaded whole, but later reads index its
//    chunks by the backend chunk size instead of the whole-file size, splicing wrong bytes in.
//  - Learning a file's size costs a HEAD plus a data fetch, so scanning the 2000-file disc at
//    start-up downloads a large part of it.
// Sizes and immutable asset mappings come from game/manifest-v2.txt. Small files share a
// verified pack; bounded archives load at once; video reads keep a short buffer ahead.
// Other reads fetch chunk-aligned ranges, kept in a bounded LRU cache.
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
    const packedFiles = new Map();
    const packDownloads = new Map();
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
        if (line.startsWith('p ')) {
          const packed = JSON.parse(line.slice(2));
          if (!Array.isArray(packed) || packed.length !== 4 || typeof packed[0] !== 'string' ||
              typeof packed[1] !== 'string' ||
              !/^file-packs\/[a-f0-9]{64}\.bin$/.test(packed[1]) ||
              !Number.isSafeInteger(packed[2]) || packed[2] < 0 ||
              !Number.isSafeInteger(packed[3]) || packed[3] <= 0 || packed[3] > 65536) {
            throw new Error('Invalid small-file pack entry');
          }
          packedFiles.set('/game/' + packed[0], {
            url: new URL('game/' + packed[1], self.location.href).href,
            offset: packed[2], size: packed[3],
          });
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
      // Another asynchronous lookup can have completed while this one awaited metadata.
      info = files.get(file);
      if (info) return info;
      const packed = packedFiles.get(key);
      if (packed && packed.size !== size) throw new Error('Small-file pack size mismatch');
      info = {url, size, packed, chunkSize: __wasmfs_fetch_get_chunk_size(file), chunks: new Map(),
              inflight: new Map(), prefetch: null};
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

    async function getPack(entry) {
      let download = packDownloads.get(entry.url);
      if (!download) {
        download = (async () => {
          const response = await fetch(entry.url, {cache: 'force-cache'});
          if (!response.ok) throw response;
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.byteLength > 16 * 1024 * 1024) throw new Error('Small-file pack too large');
          const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
          const hash = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
          if (!entry.url.endsWith('/' + hash + '.bin')) throw new Error('Small-file pack checksum mismatch');
          return bytes;
        })();
        packDownloads.set(entry.url, download);
        download.catch(() => { if (packDownloads.get(entry.url) === download) packDownloads.delete(entry.url); });
      }
      return download;
    }

    async function ensure(file, info, first, last) {
      // Join an earlier prefetch/read for these chunks instead of downloading them twice.
      // Recheck after waiting: another caller may already be retrying a failed prefetch.
      for (;;) {
        const waiting = new Set();
        for (let i = first; i <= last; i++) {
          if (!info.chunks.has(i) && info.inflight.has(i)) waiting.add(info.inflight.get(i));
        }
        if (!waiting.size) break;
        await Promise.allSettled([...waiting]);
      }
      if (files.get(file) !== info) return;
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
      if (info.packed) {
        const pack = await getPack(info.packed);
        if (files.get(file) !== info) return;
        if (info.packed.offset + info.size > pack.byteLength) throw new Error('Truncated small-file pack');
        for (let i = missingFirst; i <= missingLast; i++) {
          const start = info.packed.offset + i * info.chunkSize;
          const end = info.packed.offset + Math.min(info.size, (i + 1) * info.chunkSize);
          const chunk = pack.slice(start, end);
          info.chunks.set(i, chunk);
          touch(file, i, chunk.byteLength);
        }
        return;
      }
      // Yaz0 archives are consumed whole immediately after their header is read. One bounded
      // fetch avoids serial round trips for the header and subsequent compressed data.
      if (/\.szs$/i.test(info.url.pathname) && info.size <= 16 * 1024 * 1024) {
        missingFirst = 0;
        missingLast = Math.ceil(info.size / info.chunkSize) - 1;
      }
      const download = (async () => {
        const start = missingFirst * info.chunkSize;
        const end = Math.min((missingLast + 1) * info.chunkSize, info.size) - 1;
        const response = await fetch(info.url, {headers: {'Range': `bytes=${start}-${end}`}});
        if (!response.ok) throw response;
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (files.get(file) !== info) return; // a closed file must not repopulate the cache
        const wholeFile = response.status === 200 && bytes.byteLength === info.size;
        if (!wholeFile && (response.status !== 206 || bytes.byteLength !== end - start + 1)) throw {status: 0};
        for (let i = missingFirst; i <= missingLast; i++) {
          const base = wholeFile ? 0 : start;
          const chunk = bytes.slice(i * info.chunkSize - base, (i + 1) * info.chunkSize - base);
          info.chunks.set(i, chunk);
          touch(file, i, chunk.byteLength);
        }
      })();
      for (let i = missingFirst; i <= missingLast; i++) info.inflight.set(i, download);
      try {
        await download;
      } finally {
        for (let i = missingFirst; i <= missingLast; i++) {
          if (info.inflight.get(i) === download) info.inflight.delete(i);
        }
      }
    }

    function prefetchVideo(file, info, lastRead) {
      if (info.prefetch || !/\.thp$/i.test(info.url.pathname) || files.get(file) !== info) return;
      let first = lastRead + 1;
      const end = Math.ceil(info.size / info.chunkSize) - 1;
      while (first <= end && info.chunks.has(first)) first++;
      // Keep a few chunks ahead, issuing four-chunk batches while two remain buffered.
      // This is bounded to the current video, not a preload of the whole disc or all movies.
      if (first > end || first - lastRead - 1 > 2 || info.inflight.has(first)) return;
      const pending = ensure(file, info, first, Math.min(first + 3, end));
      info.prefetch = pending;
      pending.catch(() => {}).finally(() => {
        if (info.prefetch === pending) info.prefetch = null;
      });
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
          prefetchVideo(file, info, last);
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
