#pragma once

#if defined(__EMSCRIPTEN__)
// Small pacing hooks shared by vi.cpp and web_guest_hooks.cpp. Kept out of web_guest_hooks.h on
// purpose: abi_bridge.h includes that one, so touching it rebuilds every translated function.
namespace WebPacing {

// The VI code slept this long (ms) with nothing to run. Time asleep in a frame means the game is
// ahead of the VI clock, so there is no lag to catch up; a loop that never sleeps is the one that
// is behind. (Not the guest's own wait for the retrace: that also covers time other guest threads
// run, which is busy time, not headroom.)
void NoteIdleSleep(double sleptMs);

// The game skipped a draw to catch up: make the next retrace due now (vi.cpp).
void BorrowRetrace();

// Period of the VI timeline (ms), defined in vi.cpp.
double RetraceIntervalMs();

} // namespace WebPacing
#endif
