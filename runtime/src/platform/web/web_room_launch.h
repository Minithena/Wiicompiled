#pragma once

#if defined(__EMSCRIPTEN__)
#include <cstdint>

struct CpuContext;

namespace WebRoomLaunch {
// These are engine lifecycle boundaries in the supported RMCP01 build. The
// direct entry path runs outside PADRead and never injects controller input.
void BeforeGuestCall(uint32_t target, CpuContext* cpu);
void AfterGuestCall(uint32_t target, CpuContext* cpu);
bool TryHandleGuestCall(uint32_t target, CpuContext* cpu);
}
#endif
