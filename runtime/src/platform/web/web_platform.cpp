// Web (Emscripten) start-up: file system layout before anything reads configuration.
//
// The page is served next to a `game/` folder holding the extracted disc (`game/DATA/sys`,
// `game/DATA/files`) and `game/manifest.txt`, which lists every directory ("d <path>") and file
// ("f <size> <path>") below `game/`. The disc is far too large to preload, so `game/` is mounted at
// /game with the WASMFS fetch backend: each listed file becomes a lazily fetched file, read in
// chunks with HTTP range requests the first time the game touches it (mkw_fetchfs.js, which also
// takes the sizes from the manifest). User state (Config.toml, NAND, logs) lives in memory under
// /data for now.
#if defined(__EMSCRIPTEN__)

#include "web_platform.h"

#include "runtime_config.h"

#include <emscripten/wasmfs.h>

#include <cerrno>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

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
    std::printf("[web] mounted %zu game files at %s\n", files, kGameMount);
}

} // namespace WebPlatform

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
}

#endif
