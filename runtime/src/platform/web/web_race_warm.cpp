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

// RaceConfig holds the race in progress at +0x20 and the one being set up in the menus at +0xC10;
// the menu one is copied over when a race loads. Each keeps its course ID at +0xB48.
constexpr uint32_t kRaceCourse = 0x20 + 0xB48;   // 2920, as RecordBenchmarkStep reads it
constexpr uint32_t kMenuCourse = 0xC10 + 0xB48;
// Course IDs 0x00-0x29 (32 race courses, then 10 battle arenas) and their Race/Course file names.
constexpr const char* kCourseFiles[] = {
    "castle_course", "farm_course", "kinoko_course", "volcano_course", "factory_course",
    "shopping_course", "boardcross_course", "truck_course", "beginner_course", "senior_course",
    "ridgehighway_course", "treehouse_course", "koopa_course", "rainbow_course", "desert_course",
    "water_course", "old_peach_gc", "old_mario_gc", "old_waluigi_gc", "old_donkey_gc",
    "old_falls_ds", "old_desert_ds", "old_garden_ds", "old_town_ds", "old_mario_sfc",
    "old_obake_sfc", "old_mario_64", "old_sherbet_64", "old_koopa_64", "old_donkey_64",
    "old_koopa_gba", "old_heyho_gba", "block_battle", "venice_battle", "skate_battle",
    "casino_battle", "sand_battle", "old_battle4_sfc", "old_battle3_gba", "old_matenro_64",
    "old_CookieLand_gc", "old_House_ds",
};
constexpr uint32_t kCourseCount = sizeof(kCourseFiles) / sizeof(kCourseFiles[0]);
// Each course's music stream in sound/strm, without its "_n"/"_f" (normal / final lap) ending; the
// same order as kCourseFiles. A race opens the stream as it starts: an uncached read took 1.5 s on
// a player's machine (2026-10-07 log) and froze the game at the start line.
constexpr const char* kCourseMusic[] = {
    "n_Circuit32", "n_Farm", "n_Kinoko", "n_Volcano32", "STRM_N_FACTORY",
    "n_Shopping32", "n_Snowboard32", "STRM_N_TRUCK", "n_Circuit32", "n_Daisy32",
    "STRM_N_RIDGEHIGHWAY", "n_maple", "STRM_N_KOOPA", "n_Rainbow32", "STRM_N_DESERT",
    "STRM_N_WATER", "r_GC_Beach32", "r_GC_Circuit32", "r_GC_Stadium32", "r_GC_Mountain32",
    "r_DS_Jungle32", "r_DS_Desert32", "r_DS_Garden32", "r_DS_Town32", "r_SFC_Circuit32",
    "r_SFC_Obake32", "r_64_Circuit32", "r_64_Sherbet32", "r_64_Kuppa32", "r_64_Jungle32",
    "r_AGB_Kuppa32", "r_AGB_Beach32", "n_block", "n_venice", "n_skate",
    "n_casino", "n_ryuusa", "r_sfc_battle", "r_agb_battle", "r_64_battle",
    "r_GC_Battle32", "r_ds_battle",
};
static_assert(sizeof(kCourseMusic) / sizeof(kCourseMusic[0]) == kCourseCount, "one music stream per course");

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
        const uint32_t courseId = Memory::Read32(scenario + kRaceCourse);
        std::printf("[web-warm] course file %s, scenario course %u (%s)\n", path.c_str() + at + 13, courseId,
                    courseId < kCourseCount ? kCourseFiles[courseId] : "?");
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

void OnFrame() {
    static uint32_t seen = UINT32_MAX, posted = UINT32_MAX, stableFrames = 0;
    static bool booted = false;
    try {
        const uint32_t config = Memory::Read32(kRacedataPointer);
        if (!config) return;
        const uint32_t course = Memory::Read32(config + kMenuCourse);
        if (course != seen) {
            seen = course;
            stableFrames = 0;
            return;
        }
        if (++stableFrames != 30) return;
        if (!booted) {
            // The value present at boot is a default, not a choice.
            booted = true;
            posted = course;
            return;
        }
        if (course == posted || course >= kCourseCount) return;
        posted = course;
        std::printf("[web-warm] course %u (%s) chosen: fetching it before the race loads\n", course, kCourseFiles[course]);
        // The fetcher matches names without regard to case and fetches the final-lap "_f" stream once
        // the "_n" one is read; leaving it out keeps a fetch slot free for the kart archives.
        const std::string json = std::string("[\"DATA/files/Race/Course/") + kCourseFiles[course] +
                                 ".szs\",\"DATA/files/sound/strm/" + kCourseMusic[course] + "_n.brstm\"]";
        mkw_web_prefetch_paths(json.c_str());
    } catch (...) {
    }
}

} // namespace WebRaceWarm
#endif
