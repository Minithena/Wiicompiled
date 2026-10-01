#if defined(__EMSCRIPTEN__)
#include "web_auto_join.h"

#include "input_bindings.h"
#include "memory.h"

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <emscripten/em_asm.h>
#include <emscripten/emscripten.h>

namespace {
std::atomic<bool> cancelled{false};
bool finished = false, leftMainMenu = false;
uint32_t previousPage = 0, previousId = 0xffffffff;
double enteredAt = 0.0, nextPress = 0.0;
unsigned heldFrames = 0, mainStep = 0, dataStep = 0;
uint16_t heldButton = PAD_BUTTON_A;
const char* lastStatus = nullptr;

void Status(const char* text, bool active = true) {
    if (lastStatus == text && active) return;
    lastStatus = text;
    MAIN_THREAD_EM_ASM({
        if (window.mkwSetAutoJoinStatus) window.mkwSetAutoJoinStatus(UTF8ToString($0), !!$1);
    }, text, active);
}

bool Valid(uint32_t address, uint32_t size) {
    return address != 0 && (address & 3) == 0 && Memory::Contains(address, size);
}

// Original RMCP01 SectionManager/Page layouts. Read only: the route uses ordinary
// controller input, without calling handlers out of context or editing saved data.
uint32_t FocusedPage() {
    constexpr uint32_t managerSlot = 0x809c1e38;
    if (!Memory::Contains(managerSlot, 4)) return 0;
    const uint32_t manager = Memory::Read32(managerSlot);
    if (!Valid(manager, 0x9c)) return 0;
    const uint32_t section = Memory::Read32(manager);
    if (!Valid(section, 0x388)) return 0;
    const uint32_t count = Memory::Read32(section + 0x37c);
    if (count == 0 || count > 10) return 0;
    const uint32_t page = Memory::Read32(section + 0x354 + (count - 1) * 4);
    return Valid(page, 0x44) ? page : 0;
}
} // namespace

extern "C" EMSCRIPTEN_KEEPALIVE void mkw_web_cancel_auto_join() {
    cancelled.store(true, std::memory_order_relaxed);
}

namespace WebAutoJoin {
void Apply(PADStatus& pad) {
    static const bool enabled = [] {
        const char* value = std::getenv("MKW_WEB_AUTO_JOIN");
        const char* room = std::getenv("MKW_WEB_ROOM");
        return value && *value == '1' && room && *room;
    }();
    if (!enabled || finished) return;
    if (cancelled.load(std::memory_order_relaxed)) {
        heldFrames = 0;
        finished = true;
        Status("Automatic joining stopped. You can use the game menus.", false);
        return;
    }
    if (InputBindings::InputBlocked()) { heldFrames = 0; return; }
    if (pad.err != PAD_ERR_NONE) {
        heldFrames = 0;
        Status("Connect a controller or enable keyboard controls to continue.");
        return;
    }
    try {
        const uint32_t page = FocusedPage();
        if (!page) { heldFrames = 0; return; }
        const uint32_t id = Memory::Read32(page + 4);
        const double now = emscripten_get_now();
        if (page != previousPage || id != previousId) {
            previousPage = page;
            previousId = id;
            enteredAt = now;
            nextPress = now + 300.0;
            heldFrames = 0;
            std::printf("[autojoin] page=%02x\n", id);
        }
        if (Memory::Read32(page + 8) != 4 || Memory::Read8(page + 0x0c) != 0) {
            heldFrames = 0;
            return;
        }
        if (id == 0x6b) {
            heldFrames = 0;
            finished = true;
            Status("Choose your character and vehicle to join the race.", false);
            return;
        }
        if (now - enteredAt > 120000.0) {
            heldFrames = 0;
            finished = true;
            Status("Automatic joining paused. Continue using the game menus.", false);
            return;
        }
        uint16_t requested = PAD_BUTTON_A;
        unsigned* step = nullptr;
        switch (id) {
        case 0x57: case 0x59: case 0x5f:
            Status("Opening your profile…");
            break;
        case 0x65:
            Status("Selecting your profile…");
            break; // Accept the game's current/remembered licence selection.
        case 0x5a:
            Status("Opening online play…");
            if (leftMainMenu) {
                finished = true;
                Status("Online play returned to the menu. Continue using the game menus.", false);
                return;
            }
            // A newly booted main menu starts on Single Player. One Down selects WFC 1P.
            if (mainStep >= 2 && !heldFrames) return;
            requested = mainStep == 0 ? PAD_BUTTON_DOWN : PAD_BUTTON_A;
            step = &mainStep;
            break;
        case 0x85:
            leftMainMenu = true;
            Status("Preparing your game profile for this room…");
            break; // Known first-use profile/data notices, each with a Next button.
        case 0x86:
            leftMainMenu = true;
            Status("Preparing your game profile for this room…");
            // Play online explicitly connects the profile to this invite's relay, which
            // cannot contact Nintendo. This known connection gate starts on Do Not Allow;
            // Up selects Allow. Generic confirmation dialogs below are never automated.
            if (dataStep >= 2 && !heldFrames) return;
            requested = dataStep == 0 ? PAD_BUTTON_UP : PAD_BUTTON_A;
            step = &dataStep;
            break;
        case 0x8b:
            leftMainMenu = true;
            Status("Joining this room…");
            break; // WFC's initial selection is Worldwide.
        case 0x8c:
            Status("Opening the race lobby…");
            break; // The initial mode selection is VS Race.
        case 0x50: case 0x84: case 0x88:
            leftMainMenu = true;
            Status("Connecting to online play…");
            return;
        default:
            Status("Respond to the game's prompt to continue, or use the menus manually.");
            return;
        }
        if (pad.button || pad.stickX > 32 || pad.stickX < -32 || pad.stickY > 32 || pad.stickY < -32) {
            heldFrames = 0;
            finished = true;
            Status("You have control. Continue using the game menus.", false);
            return;
        }
        if (heldFrames) {
            --heldFrames;
        } else {
            if (now < nextPress) return;
            heldFrames = 1;
            heldButton = requested;
            if (step) ++*step;
            nextPress = now + 900.0;
            std::printf("[autojoin] input=%04x page=%02x\n", heldButton, id);
        }
        pad.button |= heldButton;
        if (heldButton == PAD_BUTTON_A) pad.analogA = 255;
    } catch (const Memory::AccessViolation&) {
        heldFrames = 0;
    }
}
} // namespace WebAutoJoin
#endif
