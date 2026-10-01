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
    const fileStates = new Map(); // file pointer -> {generation, waiters, controllers}
    // Resource records also hold bounded background warmups before WASMFS opens their files.
    const resources = new Map();
    let warmingStarted = false;
    // "<path>:<index>" -> { info, index, length }, in least-recently-used-first order
    const lru = new Map();
    let cachedBytes = 0;

    function fileState(file) {
      let state = fileStates.get(file);
      if (!state) {
        state = {generation: 0, waiters: new Set(), controllers: new Set()};
        fileStates.set(file, state);
      }
      return state;
    }

    function advanceFileGeneration(file) {
      const state = fileState(file);
      state.generation++;
      const closed = new Error('File closed during operation');
      for (const reject of state.waiters) reject(closed);
      state.waiters.clear();
      for (const controller of state.controllers) controller.abort();
      return state.generation;
    }

    function waitForFile(file, generation, promise) {
      const state = fileState(file);
      if (state.generation !== generation) {
        promise.catch(() => {});
        return Promise.reject(new Error('File closed during operation'));
      }
      let rejectClosed;
      const closed = new Promise((_, reject) => {
        rejectClosed = reject;
        state.waiters.add(rejectClosed);
      });
      return Promise.race([promise, closed]).finally(() => state.waiters.delete(rejectClosed));
    }

    function waitForResource(info, promise) {
      if (!info.active) return Promise.reject(new Error('File closed during download'));
      let rejectClosed;
      const closed = new Promise((_, reject) => {
        rejectClosed = reject;
        info.waiters.add(rejectClosed);
      });
      return Promise.race([promise, closed]).finally(() => info.waiters.delete(rejectClosed));
    }

    function deactivate(info) {
      info.active = false;
      const closed = new Error('File closed during download');
      for (const reject of info.waiters) reject(closed);
      info.waiters.clear();
      for (const cancel of info.cancellations) cancel(closed);
    }

    function touch(info, index, length) {
      const key = info.key + ':' + index;
      if (lru.has(key)) lru.delete(key); else cachedBytes += length;
      lru.set(key, {info, index, length});
      for (const [oldKey, old] of lru) {
        if (cachedBytes <= CACHE_LIMIT) break;
        if (old.info === info && old.index === index) continue;
        lru.delete(oldKey);
        old.info.chunks.delete(old.index);
        cachedBytes -= old.length;
      }
    }

    function resource(key, url, size, chunkSize, keepWarm = false) {
      let info = resources.get(key);
      if (!info) {
        const packed = packedFiles.get(key);
        if (packed && packed.size !== size) throw new Error('Small-file pack size mismatch');
        info = {key, url, size, packed, chunkSize, chunks: new Map(), inflight: new Map(),
                prefetch: null, active: true, references: 0, keepWarm,
                waiters: new Set(), cancellations: new Set()};
        resources.set(key, info);
      }
      if (keepWarm) info.keepWarm = true;
      return info;
    }

    function warmMenus(sizes, chunkSize) {
      if (warmingStarted) return;
      warmingStarted = true;
      const jobs = [];
      let remaining = 128 * 1024 * 1024;
      function queue(path, start = 0, length = Infinity) {
        const key = '/game/' + path, size = sizes.get(key);
        if (!size || packedFiles.has(key) || start >= size) return;
        const first = Math.floor(start / chunkSize);
        const last = Math.ceil(Math.min(start + length, size) / chunkSize) - 1;
        const bytes = Math.min((last + 1) * chunkSize, size) - first * chunkSize;
        if (bytes > remaining) return;
        remaining -= bytes;
        const url = new URL(aliases.get(key) || 'game/' + path, self.location.href);
        const info = resource(key, url, size, chunkSize, true);
        jobs.push(() => ensure(info, first, last));
      }
      // These menus are reached directly after choosing a licence. Warm their data while
      // startup prepares graphics, using two background requests and at most 128 MiB total.
      for (const path of ['Scene/UI/Title.szs', 'Scene/UI/Title_E.szs', 'Scene/UI/MenuSingle.szs',
                          'Scene/UI/Font.szs', 'Scene/Model/BackModel.szs',
                          'Scene/Model/Driver.szs', 'Scene/Model/Kart/pc-allkart.szs',
                          'Scene/UI/MenuMulti.szs', 'Scene/UI/MenuOther.szs']) queue('DATA/files/' + path);
      queue('DATA/files/sound/strm/o_Start2_32_fan.brstm');
      const firstVideos = ['DATA/files/thp/title/top_menu.thp', 'DATA/files/thp/button/single_top.thp'];
      for (const path of firstVideos) {
        if (aliases.has('/game/' + path)) queue(path, 0, 2 * 1024 * 1024);
      }
      // Menu sounds are in the beginning of the sound archive. Four bounded ranges avoid
      // waiting for its entire 100+ MiB body or issuing separate reads for each sound bank.
      for (const megabyte of [0, 8, 12, 4]) {
        queue('DATA/files/sound/revo_kart.brsar', megabyte * 1024 * 1024, 4 * 1024 * 1024);
      }
      // A race reads these as soon as it loads or starts, and every miss is a blocking round
      // trip (0.4-0.5 s from far away): the shared race and HUD archives, plus the sound-archive
      // blocks a race fetches (found by logging the ranges of Luigi Circuit Grand Prix runs: the
      // race-load banks, and at the start the effect banks at 45-78 MiB, where which blocks are
      // touched varies with the characters and karts, so the region is warmed whole).
      for (const path of ['Race/Common.szs', 'Scene/UI/Race.szs', 'Scene/UI/Race_E.szs']) queue('DATA/files/' + path);
      for (const [from, to] of [[19, 22], [25, 27], [45, 78]]) {
        queue('DATA/files/sound/revo_kart.brsar', from * 1024 * 1024, (to - from) * 1024 * 1024);
      }
      const remainingVideos = [...aliases.keys()].filter(key => key.startsWith('/game/DATA/files/thp/') &&
          !firstVideos.includes(key.slice(6)));
      remainingVideos.sort((a, b) => Number(a.includes('/battle/')) - Number(b.includes('/battle/')));
      for (const key of remainingVideos) {
        queue(key.slice(6), 0, 2 * 1024 * 1024);
      }
      async function run() {
        while (jobs.length) {
          try { await jobs.shift()(); } catch { /* demand reads retry failed warmups */ }
        }
      }
      void run();
      void run();
    }

    async function describe(file, generation) {
      if (fileState(file).generation !== generation) throw new Error('File closed during operation');
      let info = files.get(file);
      if (info) return info;
      const url = new URL(UTF8ToString(__wasmfs_fetch_get_file_url(file)), self.location.href);
      url.pathname = url.pathname.replace(/\/+/g, '/');
      const key = url.pathname;
      const sizes = await sizesReady;
      if (fileState(file).generation !== generation) throw new Error('File closed during operation');
      if (!sizes) throw new Error('Game manifest could not be loaded');
      let size = sizes.get(key);
      if (aliases.has(key)) url.href = aliases.get(key);
      if (size === undefined) {
        // Optional files absent from the manifest still need a metadata lookup.
        const controller = new AbortController();
        fileState(file).controllers.add(controller);
        let head;
        try {
          head = await fetch(url, {method: 'HEAD', signal: controller.signal});
        } finally {
          fileState(file).controllers.delete(controller);
        }
        if (fileState(file).generation !== generation) throw new Error('File closed during operation');
        if (!head.ok) throw head;
        const length = head.headers.get('Content-Length');
        size = length === null ? NaN : Number(length);
        if (!Number.isSafeInteger(size) || size < 0) throw new Error('Missing file length: ' + key);
      }
      // Another asynchronous lookup can have completed while this one awaited metadata.
      if (fileState(file).generation !== generation) throw new Error('File closed during operation');
      info = files.get(file);
      if (info) return info;
      const chunkSize = __wasmfs_fetch_get_chunk_size(file);
      info = resource(key, url, size, chunkSize);
      info.references++;
      files.set(file, info);
      if (key === '/game/manifest.txt') {
        for (let offset = 0, index = 0; offset < size; offset += info.chunkSize, index++) {
          const chunk = manifestBytes.slice(offset, offset + info.chunkSize);
          info.chunks.set(index, chunk);
          touch(info, index, chunk.byteLength);
        }
      }
      warmMenus(sizes, chunkSize);
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

    async function ensure(info, first, last) {
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
      if (!info.active) return;
      let missingFirst = -1, missingLast = -1;
      for (let i = first; i <= last; i++) {
        if (info.chunks.has(i)) {
          touch(info, i, info.chunks.get(i).byteLength);
        } else {
          if (missingFirst < 0) missingFirst = i;
          missingLast = i;
        }
      }
      if (missingFirst < 0) return;
      if (info.packed) {
        const pack = await waitForResource(info, getPack(info.packed));
        if (!info.active) return;
        if (info.packed.offset + info.size > pack.byteLength) throw new Error('Truncated small-file pack');
        for (let i = missingFirst; i <= missingLast; i++) {
          const start = info.packed.offset + i * info.chunkSize;
          const end = info.packed.offset + Math.min(info.size, (i + 1) * info.chunkSize);
          const chunk = pack.slice(start, end);
          info.chunks.set(i, chunk);
          touch(info, i, chunk.byteLength);
        }
        return;
      }
      // Yaz0 archives are consumed whole immediately after their header is read. One bounded
      // fetch avoids serial round trips for the header and subsequent compressed data. Music
      // streams (a few MiB each) are read through to the end, and fetching them a chunk at a
      // time stalls the game again at every chunk boundary.
      if ((/\.szs$/i.test(info.url.pathname) && info.size <= 16 * 1024 * 1024) ||
          (/\.brstm$/i.test(info.url.pathname) && info.size <= 8 * 1024 * 1024)) {
        missingFirst = 0;
        missingLast = Math.ceil(info.size / info.chunkSize) - 1;
      }
      // A demand read only needs its own chunks, even when they are part of a larger
      // background request. Release each complete chunk as the response body arrives.
      const pending = new Map();
      for (let i = missingFirst; i <= missingLast; i++) {
        let resolve, reject;
        const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
        promise.catch(() => {}); // a prefetched chunk may never have a waiting reader
        pending.set(i, {promise, resolve, reject});
        info.inflight.set(i, promise);
      }
      const controller = new AbortController();
      const cancel = (failed = new Error('File closed during download')) => {
        for (const item of pending.values()) item.reject(failed);
        controller.abort();
      };
      info.cancellations.add(cancel);
      function publish(index, chunk) {
        if (!info.active) throw new Error('File closed during download');
        info.chunks.set(index, chunk);
        touch(info, index, chunk.byteLength);
        pending.get(index).resolve();
      }
      const start = missingFirst * info.chunkSize;
      const end = Math.min((missingLast + 1) * info.chunkSize, info.size) - 1;
      let reader;
      try {
        const response = await fetch(info.url, {
          headers: {'Range': `bytes=${start}-${end}`}, signal: controller.signal,
        });
        if (!response.ok) throw response;
        if (response.status === 200) {
          // Preserve compatibility with a server that ignores Range and returns the whole file.
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.byteLength !== info.size) throw new Error('Invalid whole-file response');
          for (let i = missingFirst; i <= missingLast; i++) {
            publish(i, bytes.slice(i * info.chunkSize, (i + 1) * info.chunkSize));
          }
          return;
        }
        if (response.status !== 206 || !response.body) throw new Error('Invalid range response');
        const contentRange = response.headers.get('Content-Range');
        if (contentRange && contentRange !== `bytes ${start}-${end}/${info.size}`) {
          throw new Error('Unexpected response byte range');
        }
        reader = response.body.getReader();
        let received = 0, index = missingFirst, filled = 0, chunk;
        for (;;) {
          const {done, value} = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > end - start + 1) throw new Error('Oversized range response');
          let offset = 0;
          while (offset < value.byteLength) {
            if (!chunk) chunk = new Uint8Array(Math.min(info.chunkSize, info.size - index * info.chunkSize));
            const take = Math.min(chunk.byteLength - filled, value.byteLength - offset);
            chunk.set(value.subarray(offset, offset + take), filled);
            filled += take;
            offset += take;
            if (filled === chunk.byteLength) {
              publish(index++, chunk);
              chunk = null;
              filled = 0;
            }
          }
        }
        if (received !== end - start + 1) throw new Error('Truncated range response');
      } catch (failed) {
        for (const item of pending.values()) item.reject(failed);
        if (reader) await reader.cancel().catch(() => {});
        throw failed;
      } finally {
        if (reader) reader.releaseLock();
        info.cancellations.delete(cancel);
        for (const [index, item] of pending) {
          if (info.inflight.get(index) === item.promise) info.inflight.delete(index);
        }
      }
    }

    function prefetchVideo(info, lastRead) {
      if (info.prefetch || !/\.thp$/i.test(info.url.pathname) || !info.active) return;
      let first = lastRead + 1;
      const end = Math.ceil(info.size / info.chunkSize) - 1;
      while (first <= end && info.chunks.has(first)) first++;
      // Keep a few chunks ahead, issuing four-chunk batches while two remain buffered.
      // This is bounded to the current video, not a preload of the whole disc or all movies.
      if (first > end || first - lastRead - 1 > 2 || info.inflight.has(first)) return;
      const pending = ensure(info, first, Math.min(first + 3, end));
      info.prefetch = pending;
      pending.catch(() => {}).finally(() => {
        if (info.prefetch === pending) info.prefetch = null;
      });
    }
    wasmFS$backends[backend] = {
      allocFile: async (file) => { advanceFileGeneration(file); },
      freeFile: async (file) => {
        advanceFileGeneration(file);
        const info = files.get(file);
        if (!info) return;
        files.delete(file);
        if (--info.references > 0 || info.keepWarm) return;
        deactivate(info);
        resources.delete(info.key);
        for (const [index, chunk] of info.chunks) {
          lru.delete(info.key + ':' + index);
          cachedBytes -= chunk.byteLength;
        }
        info.chunks.clear();
      },
      write: async (file, buffer, length, offset) => -{{{ cDefs.EROFS }}},
      read: async (file, buffer, length, offset) => {
        if (offset < 0 || length <= 0) return 0;
        const generation = fileState(file).generation;
        let info;
        try {
          info = await waitForFile(file, generation, describe(file, generation));
          if (fileState(file).generation !== generation || files.get(file) !== info) {
            throw new Error('File closed during read');
          }
          length = Math.min(length, info.size - offset);
          if (length <= 0) return 0;
          const first = Math.floor(offset / info.chunkSize);
          const last = Math.floor((offset + length - 1) / info.chunkSize);
          await waitForFile(file, generation, ensure(info, first, last));
          if (fileState(file).generation !== generation || files.get(file) !== info) {
            throw new Error('File closed during read');
          }
          for (let i = first; i <= last; i++) {
            const chunkStart = i * info.chunkSize;
            const from = Math.max(chunkStart, offset);
            const to = Math.min(chunkStart + info.chunkSize, offset + length);
            HEAPU8.set(info.chunks.get(i).subarray(from - chunkStart, to - chunkStart),
                       buffer + (from - offset));
          }
          prefetchVideo(info, last);
          return length;
        } catch (failed) {
          return failed && failed.status === 404 ? -{{{ cDefs.ENOENT }}} : -{{{ cDefs.EIO }}};
        }
      },
      getSize: async (file) => {
        const generation = fileState(file).generation;
        try {
          const info = await waitForFile(file, generation, describe(file, generation));
          return fileState(file).generation === generation && files.get(file) === info ? info.size : 0;
        } catch (failed) {
          return 0;
        }
      },
    };
  },
});
