#include "guest_flat_memory.h"

// WebAssembly has no virtual-memory reservation, page protection or fault handler, and wasm32's
// whole linear memory is 4 GiB, so there is no flat guest view. Each backing store is an ordinary
// zeroed buffer; cached/uncached/physical mirrors of MEM1 and MEM2 alias one store, as the section
// objects do natively. RequiresCheckedAccess() is a compile-time true here, which keeps every
// translated access on the checked page-table path (memory_access.h), the same path macOS uses
// when its 16 KiB host pages cannot represent 4 KiB Wii pages.

#include <algorithm>
#include <cstdlib>
#include <mutex>
#include <stdexcept>
#include <vector>

namespace GuestFlat {
namespace {
struct Mapping { uint32_t base; uint64_t size; uint8_t* host; };
std::mutex g_mutex;
std::vector<Mapping> g_mappings;
std::vector<RegionRequest> g_layout;
bool g_active = false;

uint64_t Offset(const RegionRequest& r) {
    if (r.backing == Backing::Mem1) return r.base & 0x1fffffffu;
    if (r.backing == Backing::Mem2) return (r.base & 0x1fffffffu) - 0x10000000u;
    return 0;
}
bool Same(const std::vector<RegionRequest>& a, const std::vector<RegionRequest>& b) {
    return a.size() == b.size() && std::equal(a.begin(), a.end(), b.begin(),
        [](const auto& x, const auto& y) { return x.base == y.base && x.size == y.size && x.backing == y.backing; });
}
} // namespace

bool IsActive() { return g_active; }
void Initialize(const std::vector<RegionRequest>& regions) {
    std::lock_guard lock(g_mutex);
    if (g_active) { if (!Same(g_layout, regions)) throw std::runtime_error("flat guest layout cannot be remapped"); return; }
    struct Store { Backing kind; uint32_t owned; uint64_t size; uint8_t* data; };
    std::vector<Store> stores;
    for (const auto& r : regions) {
        if (!r.size) continue;
        const uint32_t owned = r.backing == Backing::Owned ? r.base : 0;
        auto it = std::find_if(stores.begin(), stores.end(), [&](const Store& s) { return s.kind == r.backing && s.owned == owned; });
        const uint64_t need = Offset(r) + r.size;
        if (it == stores.end()) stores.push_back({r.backing, owned, need, nullptr}); else it->size = std::max(it->size, need);
    }
    for (auto& s : stores) {
        // Never freed: guest memory lives for the whole process, as the native reservations do.
        s.data = static_cast<uint8_t*>(std::aligned_alloc(kGuestPageSize, (s.size + kGuestPageSize - 1) & ~uint64_t(kGuestPageSize - 1)));
        if (!s.data) throw std::runtime_error("unable to allocate WebAssembly guest backing store");
        std::fill_n(s.data, s.size, uint8_t{0});
    }
    for (const auto& r : regions) {
        if (!r.size) continue;
        const uint32_t owned = r.backing == Backing::Owned ? r.base : 0;
        const auto& s = *std::find_if(stores.begin(), stores.end(), [&](const Store& x) { return x.kind == r.backing && x.owned == owned; });
        g_mappings.push_back({r.base, r.size, s.data + Offset(r)});
    }
    g_layout = regions; g_active = true;
}
uint8_t* HostPointer(uint32_t a) { for (const auto& m : g_mappings) if (a >= m.base && uint64_t(a - m.base) < m.size) return m.host + (a - m.base); return nullptr; }
void ProtectDeferredRange(uint32_t, size_t) {}
void UnprotectDeferredRange(uint32_t, size_t) {}
void RegisterExecutableRange(uint32_t, uint32_t) {}
FaultCounters Counters() { return {}; }
void LogFaultSummary() noexcept {}
bool HandleAccessViolation(void*, bool) noexcept { return false; }
} // namespace GuestFlat
