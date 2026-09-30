// Web (Emscripten) start-up: file system layout before anything reads configuration.
//
// The page is served next to a `game/` folder holding the extracted disc (`game/DATA/sys`,
// `game/DATA/files`) and `game/manifest.txt`, which lists every directory ("d <path>") and file
// ("f <size> <path>") below `game/`. The disc is far too large to preload, so `game/` is mounted at
// /game with the WASMFS fetch backend: each listed file becomes a lazily fetched file, read in
// chunks with HTTP range requests the first time the game touches it (mkw_fetchfs.js, which also
// takes the sizes from the manifest). User state (Config.toml, NAND, logs) lives in memory under
// /data for now; an optional `game/save/rksys.dat` seeds the NAND save.
#if defined(__EMSCRIPTEN__)

#include "web_platform.h"

#include "fiber_manager.h"
#include "guest_flat_memory.h"
#include "recomp_mod_loader.h"
#include "runtime_config.h"

#include <atomic>
#include <chrono>
#include <thread>

#include <emscripten/proxying.h>
#include <emscripten/wasmfs.h>
#include <pthread.h>

#include <cerrno>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

namespace HostContext {
extern std::atomic<uint32_t> g_webContextSwitches;
}

namespace WebPlatform {
namespace {
constexpr const char* kGameMount = "/game";
constexpr uint32_t kFetchChunkSize = 1u << 20;

// Entries created inside a fetch-backed directory are fetch-backed themselves (their URL is
// derived from the path), so ordinary mkdir/open build the tree.
int CreateFile(const std::string& path) {
    const int fd = open(path.c_str(), O_RDONLY | O_CREAT | O_EXCL, 0444);
    if (fd < 0) {
        return fd;
    }
    close(fd);
    return 0;
}
} // namespace

void MountGame() {
    backend_t fetch = wasmfs_create_fetch_backend("game", kFetchChunkSize);
    if (!fetch || wasmfs_create_directory(kGameMount, 0777, fetch) != 0) {
        throw std::runtime_error("unable to mount the game folder");
    }
    const std::string manifestPath = std::string(kGameMount) + "/manifest.txt";
    if (CreateFile(manifestPath) != 0) {
        throw std::runtime_error("unable to create the game manifest entry");
    }

    std::ifstream manifest(manifestPath);
    if (!manifest) {
        throw std::runtime_error("game/manifest.txt is missing; run the web deploy script");
    }
    size_t files = 0;
    std::string line;
    while (std::getline(manifest, line)) {
        if (line.size() < 3 || line[1] != ' ') {
            continue;
        }
        // "d <path>" or "f <size> <path>"; the size is only needed by mkw_fetchfs.js.
        const size_t pathStart = line[0] == 'f' ? line.find(' ', 2) + 1 : 2;
        if (pathStart == 0 || pathStart >= line.size()) {
            continue;
        }
        const std::string path = std::string(kGameMount) + "/" + line.substr(pathStart);
        const int result = line[0] == 'd' ? mkdir(path.c_str(), 0777)
                         : line[0] == 'f' ? CreateFile(path)
                                          : 0;
        if (result != 0) {
            throw std::runtime_error("unable to create " + path + " from game/manifest.txt: " +
                                     std::strerror(errno));
        }
        files += line[0] == 'f';
    }
    std::printf("[web] mounted %zu game files at %s (game thread %p)\n", files, kGameMount,
                reinterpret_cast<void*>(pthread_self()));

    // Seed the (in-memory) NAND with the save staged next to the disc, if any.
    const std::filesystem::path stagedSave = std::string(kGameMount) + "/save/rksys.dat";
    const std::filesystem::path nandSave = RuntimeConfigFile::ApplicationDataDirectory() /
        "NAND/title/00010004/524d4350/data/rksys.dat";
    std::error_code ec;
    if (std::filesystem::exists(stagedSave, ec) && !std::filesystem::exists(nandSave, ec)) {
        std::filesystem::create_directories(nandSave.parent_path(), ec);
        std::filesystem::copy_file(stagedSave, nandSave, ec);
        // The copy inherits the read-only mode of the served file; the game must write its save.
        if (!ec) {
            std::filesystem::permissions(nandSave, std::filesystem::perms::owner_read |
                std::filesystem::perms::owner_write, std::filesystem::perm_options::replace, ec);
        }
        std::printf("[web] %s the staged save into the NAND\n", ec ? "could not copy" : "copied");
    }
}

void StartWatchdog() {
    // Other threads can read the game thread's state: it all lives in shared linear memory.
    const uint32_t* translatedAddress = &RecompMod::g_currentTranslatedExecutionAddress;
    std::thread([translatedAddress] {
        uint32_t lastSwitches = 0;
        for (;;) {
            std::this_thread::sleep_for(std::chrono::seconds(3));
            const uint32_t switches = HostContext::g_webContextSwitches.load(std::memory_order_relaxed);
            uint32_t runningThread = 0;
            if (const uint8_t* p = GuestFlat::HostPointer(0x800000e4u)) {
                runningThread = (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) |
                                (uint32_t(p[2]) << 8) | uint32_t(p[3]);
            }
            std::printf("[web] watchdog: switches=%u (+%u) retracePending=%u guestThread=%08x "
                        "osThread=%08x translated=%08x\n",
                        switches, switches - lastSwitches,
                        Fiber::g_viRetracePendingCount.load(std::memory_order_relaxed),
                        Fiber::GuestFiberManager::GetCurrentGuestThreadForWatchdog(), runningThread,
                        *reinterpret_cast<const volatile uint32_t*>(translatedAddress));
            lastSwitches = switches;
        }
    }).detach();
}

} // namespace WebPlatform

// Replaces Emscripten's html5/callback.c forwarder (same symbol; the linker prefers this
// definition). Browser events are queued to the thread that registered their handler; the stock
// version asserts when that thread's mailbox is closed, which a window resize could trigger.
// Log the dead target and drop the event instead.
extern "C" {
typedef bool (*mkw_event_callback)(int event_type, void* event_data, void* user_data);
struct MkwCallbackArgs {
    mkw_event_callback callback;
    int eventType;
    void* userData;
    alignas(max_align_t) uint8_t eventData[];
};

static void MkwRunCallback(void* arg) {
    auto* args = static_cast<MkwCallbackArgs*>(arg);
    args->callback(args->eventType, args->eventData, args->userData);
    std::free(arg);
}

void _emscripten_run_callback_on_thread(pthread_t target, mkw_event_callback callback, int eventType,
                                        void* eventData, size_t eventDataSize, void* userData) {
    auto* args = static_cast<MkwCallbackArgs*>(std::malloc(sizeof(MkwCallbackArgs) + eventDataSize));
    args->callback = callback;
    args->eventType = eventType;
    args->userData = userData;
    std::memcpy(args->eventData, eventData, eventDataSize);
    if (!emscripten_proxy_async(emscripten_proxy_get_system_queue(), target, MkwRunCallback, args)) {
        std::free(args);
        static std::atomic<int> reported{0};
        if (reported.fetch_add(1) < 8) {
            std::fprintf(stderr, "[web] dropped browser event %d for exited thread %p\n", eventType,
                         reinterpret_cast<void*>(target));
        }
    }
}
}

// Configuration is read during static initialization, so the default Config.toml has to exist
// before any other constructor runs. (The fetch mount cannot be created this early: constructors
// run on the browser's main thread, so MountGame waits for main().)
__attribute__((constructor(101))) static void WriteDefaultConfig() {
    const std::filesystem::path configPath = RuntimeConfigFile::ResolveConfigPath();
    std::error_code ec;
    std::filesystem::create_directories(configPath.parent_path(), ec);
    if (std::filesystem::exists(configPath, ec)) {
        return;
    }
    std::ofstream config(configPath);
    config << "[video]\n"
              "widescreen = true\n"
              "resolution_multiplier = 1.0\n"
              "graphics_api = \"auto\"\n"
              "\n"
              "[paths]\n"
              "dvd_root = \"/game/DATA\"\n";
    // The page sets this for a "?muted" URL (shell.html).
    if (const char* muted = std::getenv("MKW_WEB_MUTED"); muted && *muted == '1') {
        config << "\n[audio]\nmuted = true\n";
    }
}

#endif
