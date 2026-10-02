#pragma once

// Diagnostic only. Set to 1 to build a guest call-stack profiler: every static and indirect guest
// call pushes its target on a per-guest-thread stack (abi_bridge.h), and the "?log" sampler thread
// (web_platform.cpp) prints the innermost guest function ([web-gprof] self) and every function on
// the stack ([web-gprof] incl). Host work done inside a call (GX HLE, the renderer, waits) counts
// for the guest function that made it. Keep it 0 in normal builds: it costs a lookup per call, and
// toggling it rebuilds every translated shard.
#define MKW_WEB_GUEST_PROFILE 0

#if defined(__EMSCRIPTEN__) && MKW_WEB_GUEST_PROFILE
#include <cstdint>

struct CpuContext;

namespace WebGuestProfile {

inline constexpr uint32_t kMaxDepth = 1024;
struct Stack {
    const CpuContext* ctx;
    uint32_t depth;
    uint32_t addr[kMaxDepth];
};
inline Stack g_stacks[64];
// The stack of the guest thread that last called or returned, i.e. the one running now.
inline Stack* volatile g_current = nullptr;

inline Stack* StackFor(const CpuContext* ctx) {
    for (auto& s : g_stacks) {
        if (s.ctx == ctx) return &s;
        if (!s.ctx) {
            s.ctx = ctx;
            return &s;
        }
    }
    return &g_stacks[63];
}

inline void Push(uint32_t target, const CpuContext* ctx) {
    Stack* s = StackFor(ctx);
    if (s->depth < kMaxDepth) s->addr[s->depth] = target;
    ++s->depth;
    g_current = s;
}

inline void Pop(uint32_t target, const CpuContext* ctx) {
    Stack* s = StackFor(ctx);
    if (s->depth > kMaxDepth) {
        --s->depth;
    } else {
        // A longjmp can skip returns: unwind to the matching entry if there is one.
        for (uint32_t i = s->depth; i > 0; --i) {
            if (s->addr[i - 1] == target) {
                s->depth = i - 1;
                break;
            }
        }
    }
    g_current = s;
}

} // namespace WebGuestProfile
#endif
