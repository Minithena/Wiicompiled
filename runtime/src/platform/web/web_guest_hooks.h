#pragma once

#if defined(__EMSCRIPTEN__)
#include <cstdint>

struct CpuContext;

// Guest calls the web build replaces or watches. abi_bridge.h asks about a fixed list of addresses
// (constants, so generated static calls cost nothing); everything else is decided in
// web_guest_hooks.cpp. Two behaviours, both about one slow player not slowing everyone else:
//
//  * No lag-frame waiting (default; "?lagwait" restores the game's own). Mario Kart Wii keeps
//    online clocks together by counting, per player, the frames that player lagged and sending the
//    count in the race header; every other client that sees a higher count than its own idles one
//    frame and raises its own count (RKNet::PacketMgr::ProcessLagFrames, GameScene::calc). So the
//    whole room runs at the slowest player's speed. Skipping ProcessLagFrames removes both the
//    waiting and the reporting: a lagging player is simply slower, nobody else is.
//
//  * Real-time simulation (default; "?nocatchup" turns it off). The game steps its simulation once
//    per loop iteration and a late frame is just presented late, so a machine that cannot draw 60
//    frames a second plays in slow motion. When the VI clock is a step or more ahead of the
//    simulation, the scene draw and the frame's present are skipped, which makes that iteration
//    cheap enough to catch up: the race keeps 60 steps a second while fewer frames are drawn. Only
//    in a race, never more than kMaxSkipStreak in a row; a long stall (loading, a disc read) is
//    forgiven, not replayed. Measured with ?burn=12 (extra cost per drawn frame): 44-49 steps a
//    second without, 60.0 with, drawing 15 frames a second.
namespace WebGuestHooks {

// Reads the page options (MKW_WEB_NOCATCHUP, MKW_WEB_LAGWAIT). Call once from main().
void Init();

// Called for a matching guest call before it runs; true means "handled, do not run it".
bool Handle(uint32_t target, CpuContext* cpu);

// GXCopyDisp asks whether this iteration's draw was skipped; true means do not copy or present.
// Also marks the end of the iteration.
bool ConsumeSkippedFrame();

// One line per report period when diagnostics are on.
void Report(double elapsedMs);

} // namespace WebGuestHooks
#endif
