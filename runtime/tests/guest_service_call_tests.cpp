#include "guest_service_call.h"

#include <array>
#include <cstdint>
#include <iostream>
#include <iterator>
#include <stdexcept>

namespace {
constexpr uint32_t kGuestStackBase = 0x80390000u;
constexpr size_t kGuestStackWords = 0x1000;
constexpr uint32_t kCallerSp = kGuestStackBase + 0x800u;
struct SimulatedGuestFailure {};

class GuestMemory {
public:
    bool Write32(uint32_t address, uint32_t value) {
        if ((address & 3u) != 0 || address < kGuestStackBase) return false;
        const uint32_t offset = address - kGuestStackBase;
        if (offset > sizeof(words_) - sizeof(uint32_t)) return false;
        words_[offset / sizeof(uint32_t)] = value;
        return true;
    }

    uint32_t Read32(uint32_t address) const {
        if ((address & 3u) != 0 || address < kGuestStackBase) {
            throw std::runtime_error("invalid test guest-memory read");
        }
        const uint32_t offset = address - kGuestStackBase;
        if (offset > sizeof(words_) - sizeof(uint32_t)) {
            throw std::runtime_error("test guest-memory read is out of range");
        }
        return words_[offset / sizeof(uint32_t)];
    }

private:
    std::array<uint32_t, kGuestStackWords> words_{};
};

void Require(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

CpuContext MakeContext(uint32_t stackPointer) {
    CpuContext cpu{};
    for (size_t i = 0; i < std::size(cpu.gpr); ++i) {
        cpu.gpr[i] = 0x10000000u + static_cast<uint32_t>(i);
    }
    cpu.gpr[1] = stackPointer;
    cpu.cr = 0x12345678u;
    cpu.lr = 0x87654321u;
    cpu.ctr = 0x23456789u;
    cpu.xer = 0x3456789au;
    cpu.fpscr = 0;
    cpu.pc = 0x456789abu;
    for (size_t i = 0; i < std::size(cpu.fpr); ++i) {
        cpu.fpr[i].raw = 0x0102030405060708ull + i;
    }
    for (size_t i = 0; i < std::size(cpu.gqr); ++i) {
        cpu.gqr[i] = 0x50000000u + static_cast<uint32_t>(i);
    }
    cpu.hid0 = 0x60000001u;
    cpu.hid1 = 0x60000002u;
    cpu.hid2 = 0x60000003u;
    cpu.srr0 = 0x70000001u;
    cpu.srr1 = 0x70000002u;
    cpu.msr = 0x70000003u;
    return cpu;
}

bool SameContext(const CpuContext& left, const CpuContext& right) {
    for (size_t i = 0; i < std::size(left.gpr); ++i) {
        if (left.gpr[i] != right.gpr[i]) return false;
    }
    if (left.cr != right.cr || left.lr != right.lr || left.ctr != right.ctr || left.xer != right.xer ||
        left.fpscr != right.fpscr || left.pc != right.pc) return false;
    for (size_t i = 0; i < std::size(left.fpr); ++i) {
        if (left.fpr[i].raw != right.fpr[i].raw) return false;
    }
    for (size_t i = 0; i < std::size(left.gqr); ++i) {
        if (left.gqr[i] != right.gqr[i]) return false;
    }
    return left.hid0 == right.hid0 && left.hid1 == right.hid1 && left.hid2 == right.hid2 &&
           left.srr0 == right.srr0 && left.srr1 == right.srr1 && left.msr == right.msr;
}

void TestScratchFramePreservesCallerAndLiveContext() {
    constexpr uint32_t kArgumentCanary = 0xc0ffee11u;
    constexpr uint32_t kLocalCanary = 0xc0ffee22u;
    constexpr uint32_t kCalleeArgument = 0xaabbcc01u;
    constexpr uint32_t kCalleeLocal = 0xaabbcc02u;
    GuestMemory memory;
    Require(memory.Write32(kCallerSp + 8, kArgumentCanary), "set caller argument canary");
    Require(memory.Write32(kCallerSp + 0x2c, kLocalCanary), "set caller local canary");

    CpuContext prior = MakeContext(kGuestStackBase + 0x1800u);
    prior.fpscr = 0x4u; // Set host NI so the nested scope must restore it.
    CpuContext live = MakeContext(kCallerSp);
    const CpuContext original = live;
    const uint32_t hostFpBefore = MkwGetHostFpControl();
    uint32_t scratchSpUsed = 0;
    {
        CpuContextScope priorScope(&prior);
        const uint32_t priorFp = MkwGetHostFpControl();
        {
            GuestServiceCallScope call(live, [&memory](uint32_t address, uint32_t value) {
                return memory.Write32(address, value);
            });
            const uint32_t scratchSp = call.scratchStackPointer();
            scratchSpUsed = scratchSp;
            Require(TryGetCpuContext() == &live, "service call must retain the supplied CPU context pointer");
            Require(live.gpr[1] == scratchSp, "live r1 must use the scratch stack pointer");
            Require((scratchSp & (GuestServiceCallScope::kStackAlignment - 1)) == 0,
                    "scratch stack pointer must be ABI aligned");
            Require(kCallerSp - scratchSp >= GuestServiceCallScope::kScratchFrameBytes,
                    "scratch frame must be below the caller stack");
            Require(memory.Read32(scratchSp) == kCallerSp, "scratch backchain must link to caller r1");
            Require((MkwGetHostFpControl() & kMkwFpControlFlushToZeroBits) == 0,
                    "service CPU FPSCR must be active in the host FP scope");

            // Model the callee's incoming linkage/argument writes and prologue.
            Require(memory.Write32(scratchSp + 8, kCalleeArgument), "write scratch argument area");
            Require(memory.Write32(scratchSp + 0x2c, kCalleeLocal), "write scratch linkage area");
            const uint32_t calleeSp = scratchSp - 0x40;
            Require(memory.Write32(calleeSp, scratchSp), "write callee backchain");
            live.gpr[1] = calleeSp;
            live.gpr[3] = 0xdead0003u;
            live.gpr[31] = 0xdead001fu;
            live.lr = 0xdead0020u;
            live.cr = 0xdead0021u;
            live.fpr[1].raw = 0xdead0022u;
            live.gqr[2] = 0xdead0023u;
            // This unit test checks pointer identity; actual scheduler yields
            // are exercised by the browser's login-service integration test.
            Require(TryGetCpuContext() == &live, "register changes must keep the supplied CPU object active");
        }
        Require(SameContext(live, original), "service scope must restore the full caller CPU context");
        Require(TryGetCpuContext() == &prior, "service scope must restore the previous TLS CPU context");
        Require(MkwGetHostFpControl() == priorFp, "service scope must restore the prior host FP mode");
    }
    Require(TryGetCpuContext() == nullptr, "outer CPU scope must restore an empty TLS context");
    Require(MkwGetHostFpControl() == hostFpBefore, "outer CPU scope must restore host FP control");
    Require(memory.Read32(kCallerSp + 8) == kArgumentCanary, "callee linkage writes must not touch caller arguments");
    Require(memory.Read32(kCallerSp + 0x2c) == kLocalCanary, "callee locals must not overwrite caller stack data");
    Require(memory.Read32(scratchSpUsed) == kCallerSp, "the scratch backchain must remain linked after return");
}

void TestExceptionRestoresCpuAndTls() {
    GuestMemory memory;
    CpuContext prior = MakeContext(kGuestStackBase + 0x1800u);
    CpuContext live = MakeContext(kCallerSp);
    const CpuContext original = live;
    {
        CpuContextScope priorScope(&prior);
        bool caught = false;
        try {
            GuestServiceCallScope call(live, [&memory](uint32_t address, uint32_t value) {
                return memory.Write32(address, value);
            });
            live.gpr[1] -= 0x40;
            live.gpr[7] = 0xdead0007u;
            live.lr = 0xdead0008u;
            throw SimulatedGuestFailure{};
        } catch (const SimulatedGuestFailure&) {
            caught = true;
        }
        Require(caught, "simulated guest service exception must propagate");
        Require(SameContext(live, original), "exception must restore the full caller CPU context");
        Require(TryGetCpuContext() == &prior, "exception must restore TLS CPU context");
    }
    Require(TryGetCpuContext() == nullptr, "outer scope must restore empty TLS after exception");
}
} // namespace

int main() {
    try {
        TestScratchFramePreservesCallerAndLiveContext();
        TestExceptionRestoresCpuAndTls();
        std::cout << "Guest service call stack/context tests passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
