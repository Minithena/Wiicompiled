#if defined(__EMSCRIPTEN__)
#include "web_room_launch.h"

#include "abi_bridge.h"
#include "guest_service_call.h"
#include "input_bindings.h"
#include "memory.h"

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <initializer_list>
#include <emscripten/em_asm.h>
#include <emscripten/emscripten.h>

namespace {
// Original RMCP01 service ABI. These are engine calls and configuration fields,
// not UI button handlers. The guest still owns scene/page creation and networking.
constexpr uint32_t kSectionManagerSlot = 0x809c1e38;
constexpr uint32_t kSaveManagerSlot = 0x809bd748;
constexpr uint32_t kRaceDataSlot = 0x809bd728;
constexpr uint32_t kInputManagerSlot = 0x809bd70c;
constexpr uint32_t kNetworkControllerSlot = 0x809c20d8;
constexpr uint32_t kSectionInit = 0x80634e44;
constexpr uint32_t kSectionCreate = 0x80634fbc;
constexpr uint32_t kSectionUpdate = 0x806224f8;
constexpr uint32_t kAddPageLayer = 0x80622da0;
constexpr uint32_t kOnlineSection = 0x55;
constexpr uint32_t kTitleSection = 0x3f;
constexpr uint32_t kConnectPage = 0x84;
constexpr uint32_t kSearchPage = 0x8f;
constexpr uint32_t kCharacterPage = 0x6b;
constexpr uint32_t kNetworkIdle = 5;
constexpr uint32_t kNoPage = 0xffffffff;

enum class Phase { Boot, Prepared, Connecting, Character, Finished, Stopped };
Phase phase = Phase::Boot;
std::atomic<bool> cancelled{false};
bool inServiceCall = false;
bool connectionPageOmitted = false;
bool controllerAssigned = false, controllerRegistered = false, controllerNoticeShown = false;
double phaseStarted = 0;

bool Enabled() {
    static const bool enabled = [] {
        const char* flag = std::getenv("MKW_WEB_DIRECT_JOIN");
        const char* room = std::getenv("MKW_WEB_ROOM");
        return flag && *flag == '1' && room && *room;
    }();
    return enabled;
}

bool Valid(uint32_t address, uint32_t size) {
    return address && !(address & 3) && Memory::Contains(address, size);
}

uint32_t Object(uint32_t slot, uint32_t size) {
    const uint32_t address = Memory::Read32(slot);
    return Valid(address, size) ? address : 0;
}

uint32_t Section(uint32_t manager) {
    const uint32_t section = manager ? Memory::Read32(manager) : 0;
    return Valid(section, 0x408) ? section : 0;
}

uint32_t Page(uint32_t section, uint32_t id, uint32_t size = 0x44) {
    if (!section || id >= 0xd3) return 0;
    const uint32_t page = Memory::Read32(section + 8 + id * 4);
    return Valid(page, size) && Memory::Read32(page + 4) == id ? page : 0;
}

bool Active(uint32_t section, uint32_t id) {
    if (!section) return false;
    const uint32_t count = Memory::Read32(section + 0x37c);
    if (count > 10) return false;
    for (uint32_t i = 0; i < count; ++i) {
        const uint32_t page = Memory::Read32(section + 0x354 + i * 4);
        if (Valid(page, 0x44) && Memory::Read32(page + 4) == id) return true;
    }
    return false;
}

void Status(const char* text, const char* state) {
    MAIN_THREAD_EM_ASM({
        if (window.mkwSetRoomLaunchStatus) {
            window.mkwSetRoomLaunchStatus(UTF8ToString($0), UTF8ToString($1));
        }
    }, text, state);
}

void SetPhase(Phase next, const char* text) {
    phase = next;
    phaseStarted = emscripten_get_now();
    Status(text, "loading");
}

void Manual(const char* text) {
    phase = Phase::Stopped;
    std::printf("[room-launch] manual: %s\n", text);
    Status(text, "manual");
}

void Fail(const char* text) {
    phase = Phase::Stopped;
    std::printf("[room-launch] failed: %s\n", text);
    Status(text, "failed");
}

// Network services can yield into the guest scheduler. Keep its live CPU object
// stable and reserve a separate caller frame so service argument/linkage writes
// cannot overwrite the interrupted caller's stack or register state.
uint32_t Call(CpuContext* source, uint32_t address, std::initializer_list<uint32_t> args) {
    GuestServiceCallScope scope(*source, [](uint32_t scratch, uint32_t caller) {
        if (!Memory::Contains(scratch, caller - scratch)) return false;
        Memory::Write32(scratch, caller);
        return true;
    });
    unsigned reg = 3;
    for (uint32_t arg : args) source->gpr[reg++] = arg;
    InvokeIndirectCpu(address, source);
    return source->gpr[3];
}

struct ServiceScope {
    ServiceScope() { inServiceCall = true; }
    ~ServiceScope() { inServiceCall = false; }
};

void PrepareBoot(CpuContext* cpu) {
    const uint32_t manager = Object(kSectionManagerSlot, 0x9c);
    const uint32_t save = Object(kSaveManagerSlot, 0x25008);
    const uint32_t raceData = Object(kRaceDataSlot, 0x73f0);
    if (!manager || !save || !raceData) {
        Manual("The game needs its normal setup. Continue through the game menus.");
        return;
    }
    // Init has already validated NAND/save state. Preserve repair/create-save
    // destinations, and any explicit developer launch destination.
    if (Memory::Read32(manager + 4) != kTitleSection ||
        Memory::Read32(manager + 8) != kNoPage ||
        Memory::Read8(save + 0x25000) || Memory::Read32(save + 0x25004)) {
        Manual("Your saved profile needs attention. Follow the game's setup screen.");
        return;
    }
    const uint32_t params = Memory::Read32(manager + 0x98);
    if (!Valid(params, 0x510)) {
        Manual("The game could not initialise the profile. Continue through the game menus.");
        return;
    }

    uint32_t license = Memory::Read16(save + 0x36);
    if (license >= 4 || !Call(cpu, 0x80544d10, {save, license})) {
        license = 0;
        while (license < 4 && !Call(cpu, 0x80544d10, {save, license})) ++license;
    }
    if (license == 4) {
        Manual("Create a game profile first. You can then reopen the invite.");
        return;
    }

    // The same profile/Mii services used by the game's native -l launch path.
    Call(cpu, 0x80544cd8, {save, license});
    const uint32_t licenseObject = save + 0x38 + license * 0x93f0;
    const uint32_t createId = Call(cpu, 0x80547034, {licenseObject});
    if (!Memory::Contains(createId, 8)) {
        Manual("Choose a Mii for your game profile, then reopen the invite.");
        return;
    }
    Call(cpu, 0x805fa6e0, {params + 0x238, 0, createId});
    if (!Call(cpu, 0x805fa930, {params + 0x238, 0})) {
        Manual("Choose a Mii for your game profile, then reopen the invite.");
        return;
    }
    Memory::Write8(params + 0x4e8, static_cast<uint8_t>(license));
    Call(cpu, 0x805e40a8, {params});

    // Preserve the non-UI setup normally performed on MainMenu activation,
    // then apply its one-player online category and scenario configuration.
    Call(cpu, 0x8052e454, {raceData}); // Racedata::ResetScenarios.
    Memory::Write32(params + 0x124, 1); // Local player count.
    Memory::Write32(params + 0x60, 0); // VS race number.
    Call(cpu, 0x805e32ac, {params}); // SectionParams::ResetBattleParams.
    Memory::Write32(params + 0x74, 2); // Both karts and bikes.
    Memory::Write32(params + 0x128, 4); // One-player Nintendo WFC category.
    // This helper is independent of a MainMenu page object.
    Call(cpu, 0x808516bc, {0, 1});
    if (cancelled.load(std::memory_order_relaxed)) {
        Manual("Continuing through the game menus manually.");
        return;
    }

    // Redirect before GetBootSectionSceneId selects the initial host scene:
    // Title is scene 1, whereas OnlineSingle needs scene 4 and its resources.
    Memory::Write32(manager + 8, kOnlineSection);
    Memory::Write32(manager + 0xc, kOnlineSection);
    SetPhase(Phase::Prepared, "Connecting your profile to the room…");
    std::printf("[room-launch] direct boot: section=%02x license=%u\n", kOnlineSection, license);
}

bool RegisterController(CpuContext* cpu, uint32_t manager) {
    const uint32_t input = Object(kInputManagerSlot, 0x415c);
    if (!input) return false;
    if (!controllerAssigned) {
        // Scene entry resets holders. Register after that reset, before the
        // first selectable page is activated. No input state is synthesized.
        Call(cpu, 0x80524438, {input, 0, 3, 0});
        controllerAssigned = true;
    }
    const uint32_t controllerId = Call(cpu, 0x8061be40, {input + 4});
    if (!(controllerId & 0xff00)) {
        if (!controllerNoticeShown) {
            Status("Connect a controller or enable keyboard controls to continue.", "loading");
            controllerNoticeShown = true;
        }
        return false;
    }
    Call(cpu, 0x8061b490, {manager + 0x34, 0, controllerId});
    controllerRegistered = true;
    Status("Preparing online play…", "loading");
    std::printf("[room-launch] controller registered: id=%03x\n", controllerId);
    return true;
}

void Update(CpuContext* cpu) {
    const uint32_t manager = Object(kSectionManagerSlot, 0x9c);
    const uint32_t section = Section(manager);
    if (!section) return;
    if (cancelled.load(std::memory_order_relaxed)) {
        const uint32_t network = Object(kNetworkControllerSlot, 0x29c8);
        if (network) Call(cpu, 0x806561a8, {network}); // ScheduleShutdown.
        // Return through the ordinary scene lifecycle. No input or delayed
        // automatic action remains after the manual handoff.
        Memory::Write32(manager + 8, kNoPage);
        Call(cpu, 0x80635a3c, {manager, 0x41, 0});
        Call(cpu, 0x80635ac8, {manager, 0, 0});
        Manual("Continuing through the game menus manually.");
        return;
    }
    if (emscripten_get_now() - phaseStarted > 120000) {
        Fail("Connecting to the room took too long. Reload to try again.");
        return;
    }
    if (Memory::Read32(section) != kOnlineSection) {
        Fail("The game could not connect to this room. Reload to try again.");
        return;
    }
    const uint32_t network = Object(kNetworkControllerSlot, 0x29c8);
    if (phase == Phase::Prepared) {
        if (!connectionPageOmitted) return; // Initial page creation/entry is still running.
        if (!controllerRegistered && !RegisterController(cpu, manager)) return;
        const uint32_t friends = Memory::Read32(section + 0x404);
        if (!network || !Valid(friends, 0x38d0)) {
            Fail("The online services could not be initialised. Reload to try again.");
            return;
        }
        // Despite its name, IsUpdated means friend-data changes are pending.
        // Match the native connection prerequisite: drain those changes first.
        if (Call(cpu, 0x805d294c, {friends})) return;
        // Play online authorises this profile's exchange with the invite's own
        // relay. Start the real async login service without the Nintendo UI or
        // changing the saved Nintendo data-consent preferences.
        Call(cpu, 0x80655c10, {network, 1});
        SetPhase(Phase::Connecting, "Connecting to online play…");
        std::printf("[room-launch] network login service started\n");
    }
    if (phase == Phase::Connecting) {
        if (!network) {
            Fail("The online session ended before joining. Reload to try again.");
            return;
        }
        if (Memory::Read32(network + 0x2c)) {
            char message[128];
            std::snprintf(message, sizeof(message), "The game could not connect (error %d). Reload to try again.",
                          static_cast<int32_t>(Memory::Read32(network + 0x30)));
            Fail(message);
            return;
        }
        if (Memory::Read32(network + 0x28) != kNetworkIdle || !Call(cpu, 0x80656d9c, {network})) return;
        const uint32_t search = Page(section, kSearchPage, 0x1d04);
        if (!search) {
            Fail("The race lobby could not be opened. Reload to try again.");
            return;
        }
        Memory::Write32(search + 0x1cf4, 0); // Worldwide inside this isolated room.
        Memory::Write32(search + 0x1cf8, 0); // VS Race.
        SetPhase(Phase::Character, "Opening character selection…");
        // The native matching page starts the search and opens CharacterSelect
        // through its normal lifecycle. No menu click or connection-page state
        // machine is used by this launch path.
        Call(cpu, kAddPageLayer, {section, kSearchPage});
        std::printf("[room-launch] login complete; matching page activated\n");
    }
    if (phase == Phase::Character && Active(section, kCharacterPage)) {
        const uint32_t character = Page(section, kCharacterPage);
        if (character && Memory::Read32(character + 8) == 4 && !InputBindings::InputBlocked()) {
            phase = Phase::Finished;
            Status("Choose your character and vehicle to join the race.", "ready");
            std::printf("[room-launch] character selection ready\n");
        }
    }
}
}

extern "C" EMSCRIPTEN_KEEPALIVE void mkw_web_cancel_room_launch() {
    cancelled.store(true, std::memory_order_relaxed);
}

namespace WebRoomLaunch {
bool TryHandleGuestCall(uint32_t target, CpuContext* cpu) {
    if (!Enabled() || inServiceCall || phase != Phase::Prepared ||
        cancelled.load(std::memory_order_relaxed) || target != kAddPageLayer || cpu->gpr[4] != kConnectPage) return false;
    try {
        const uint32_t section = Section(Object(kSectionManagerSlot, 0x9c));
        if (!section || cpu->gpr[3] != section || Memory::Read32(section) != kOnlineSection) return false;
        // Retain every page's construction/OnInit (including FriendList setup),
        // but the web lobby owns login presentation instead of WFCConnect.
        connectionPageOmitted = true;
        std::printf("[room-launch] web lobby owns initial connection\n");
        return true;
    } catch (const Memory::AccessViolation&) {
        Fail("The game could not initialise direct room entry. Reload to try again.");
        return false;
    }
}

void BeforeGuestCall(uint32_t target, CpuContext* cpu) {
    if (!Enabled() || inServiceCall) return;
    ServiceScope scope;
    try {
        if (target == kSectionCreate) {
            const uint32_t manager = Object(kSectionManagerSlot, 0x9c);
            if (manager && std::getenv("MKW_WEB_PERF")) {
                const uint32_t network = Object(kNetworkControllerSlot, 0x29c8);
                const uint32_t input = Object(kInputManagerSlot, 0x415c);
                std::printf("[room-launch] create section=%02x network=%u error=%d idle_frames=%u\n",
                            Memory::Read32(manager + 0xc), network ? Memory::Read32(network + 0x28) : 0,
                            network ? static_cast<int32_t>(Memory::Read32(network + 0x30)) : 0,
                            input ? Memory::Read16(input + 4 + 0xc2) : 0);
            }
        } else if (target == kSectionUpdate && phase != Phase::Boot && phase != Phase::Finished && phase != Phase::Stopped) {
            Update(cpu);
        }
    } catch (const Memory::AccessViolation&) {
        Fail("The game could not finish joining. Reload to try again.");
    }
}
void AfterGuestCall(uint32_t target, CpuContext* cpu) {
    if (!Enabled() || inServiceCall || phase == Phase::Finished || phase == Phase::Stopped) return;
    ServiceScope scope;
    try {
        if (target == kSectionInit && phase == Phase::Boot) {
            if (cancelled.load(std::memory_order_relaxed)) Manual("Continuing through the game menus manually.");
            else PrepareBoot(cpu);
        }
    } catch (const Memory::AccessViolation&) {
        Fail("The game could not finish joining. Reload to try again.");
    }
}
}
#endif
