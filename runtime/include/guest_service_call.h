#pragma once

#include "ppc_runtime.h"

#include <cstdint>
#include <stdexcept>
#include <utility>

// Keep the live CpuContext stable across cooperative guest-fiber yields while
// giving a synchronous service callee a private caller frame below the
// interrupted stack pointer. The backchain links that frame to the source SP.
class GuestServiceCallScope {
public:
    static constexpr uint32_t kScratchFrameBytes = 0x100;
    static constexpr uint32_t kStackAlignment = 16;

    template <typename WriteGuest32>
    GuestServiceCallScope(CpuContext& cpu, WriteGuest32&& writeGuest32)
        : cpu_(&cpu), saved_(cpu), contextScope_(&cpu) {
        const uint32_t callerSp = saved_.gpr[1];
        if (callerSp < kScratchFrameBytes) {
            throw std::runtime_error("guest service call has no stack scratch space");
        }

        const uint32_t scratchSp = (callerSp - kScratchFrameBytes) & ~(kStackAlignment - 1);
        if (scratchSp == 0 || scratchSp >= callerSp || callerSp - scratchSp < kScratchFrameBytes) {
            throw std::runtime_error("guest service call stack frame is invalid");
        }
        if (!std::forward<WriteGuest32>(writeGuest32)(scratchSp, callerSp)) {
            throw std::runtime_error("guest service call backchain is not writable");
        }

        scratchSp_ = scratchSp;
        cpu_->gpr[1] = scratchSp_;
    }

    ~GuestServiceCallScope() noexcept { *cpu_ = saved_; }

    GuestServiceCallScope(const GuestServiceCallScope&) = delete;
    GuestServiceCallScope& operator=(const GuestServiceCallScope&) = delete;
    GuestServiceCallScope(GuestServiceCallScope&&) = delete;
    GuestServiceCallScope& operator=(GuestServiceCallScope&&) = delete;

    uint32_t callerStackPointer() const noexcept { return saved_.gpr[1]; }
    uint32_t scratchStackPointer() const noexcept { return scratchSp_; }

private:
    CpuContext* cpu_;
    CpuContext saved_;
    uint32_t scratchSp_ = 0;
    CpuContextScope contextScope_;
};
