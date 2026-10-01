#if defined(__EMSCRIPTEN__)
#include "web_race_warm.h"

#include "memory.h"

#include <emscripten.h>

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

// Posts a list of disc paths to the file fetcher (mkw_fetchfs.js, which runs on another worker).
EM_JS(void, mkw_web_prefetch_paths, (const char* json), {
    try {
        if (!globalThis.__mkwPrefetchChannel) globalThis.__mkwPrefetchChannel = new BroadcastChannel('mkw-prefetch');
        globalThis.__mkwPrefetchChannel.postMessage({paths: JSON.parse(UTF8ToString(json))});
    } catch (e) {
        console.error('[web-warm] cannot post: ' + e);
    }
});

namespace WebRaceWarm {
namespace {

// Guest addresses in the supported RMCP01 build, read from ArchiveMgr::LoadKartArchive (0x80540E3C)
// and RaceScene::OnEnter (0x80553C50).
constexpr uint32_t kRacedataPointer = 0x809BD728u;  // pointer to the race scenario
constexpr uint32_t kPlayerStride = 240;
constexpr uint32_t kPlayerVehicle = 48;
constexpr uint32_t kPlayerCharacter = 52;
constexpr uint32_t kPlayerCountOffset = 36;         // u8
constexpr uint32_t kPlayerTeam = 244;
constexpr uint32_t kRaceMode = 2928;
constexpr uint32_t kVehicleNames = 0x808B3B50u;     // 36 pointers, indexed by vehicle
constexpr uint32_t kDriverNames = 0x808B3A90u;      // 48 pointers, indexed by character
constexpr uint32_t kKindNames = 0x808B3BE0u;        // 3 pointers (kart / bike)
constexpr uint32_t kSuffixNames = 0x808B3BECu;      // 3 pointers ("", split-screen)
constexpr uint32_t kVehicles = 36, kDrivers = 48, kMaxPlayers = 12;

std::string s_lastCourse;

std::string ReadText(uint32_t address) {
    std::string text;
    for (int i = 0; i < 24; ++i) {
        const char c = static_cast<char>(Memory::Read8(address + i));
        if (!c) break;
        text.push_back(c);
    }
    return text;
}

bool SafeText(const std::string& text) {
    for (const char c : text) {
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-')) return false;
    }
    return true;
}

} // namespace

void OnDiscRead(const std::string& path) {
    const size_t at = path.find("/Race/Course/");
    if (at == std::string::npos) return;
    if (path == s_lastCourse) return;
    s_lastCourse = path;
    try {
        const uint32_t scenario = Memory::Read32(kRacedataPointer);
        if (!scenario) return;
        const uint32_t count = Memory::Read8(scenario + kPlayerCountOffset);
        if (!count || count > kMaxPlayers) return;
        std::vector<std::string> kinds, suffixes;
        for (uint32_t i = 0; i < 3; ++i) {
            kinds.push_back(ReadText(Memory::Read32(kKindNames + i * 4)));
            suffixes.push_back(ReadText(Memory::Read32(kSuffixNames + i * 4)));
        }
        const uint32_t mode = Memory::Read32(scenario + kRaceMode) - 3u;
        const bool teamMode = mode <= 7u && ((1u << mode) & 193u) != 0;
        std::string json = "[";
        std::string summary;
        for (uint32_t i = 0; i < count; ++i) {
            const uint32_t entry = scenario + i * kPlayerStride;
            const uint32_t vehicle = Memory::Read32(entry + kPlayerVehicle);
            const uint32_t driver = Memory::Read32(entry + kPlayerCharacter);
            if (vehicle >= kVehicles || driver >= kDrivers) continue;
            const std::string vehicleName = ReadText(Memory::Read32(kVehicleNames + vehicle * 4));
            const std::string driverName = ReadText(Memory::Read32(kDriverNames + driver * 4));
            if (vehicleName.empty() || driverName.empty() || !SafeText(vehicleName) || !SafeText(driverName)) continue;
            summary += " " + vehicleName + "/" + driverName;
            // The vehicle names already end in "_kart"/"_bike". The kind table is "_red", "_blue",
            // "": the game uses "" (index 2) except in the team race modes, where it uses the
            // player's team (RaceScene::OnEnter, 0x80553C50). The suffix is the first entry ("" unless
            // the screen is split). Names that are not on the disc are ignored by the fetcher.
            uint32_t kindIndex = 2;
            if (teamMode) kindIndex = Memory::Read32(entry + kPlayerTeam);
            if (kindIndex > 2) kindIndex = 2;
            if (!SafeText(kinds[kindIndex])) continue;
            if (json.size() > 1) json += ",";
            json += "\"DATA/files/Race/Kart/" + vehicleName + kinds[kindIndex] + "-" + driverName + suffixes[0] + ".szs\"";
        }
        json += "]";
        std::printf("[web-warm] %u players (kinds \"%s\"/\"%s\"/\"%s\", team mode %d):%s\n", count, kinds[0].c_str(), kinds[1].c_str(), kinds[2].c_str(), teamMode ? 1 : 0, summary.c_str());
        mkw_web_prefetch_paths(json.c_str());
    } catch (...) {
        // The roster is not readable yet; the game's own reads still work.
    }
}

} // namespace WebRaceWarm
#endif
