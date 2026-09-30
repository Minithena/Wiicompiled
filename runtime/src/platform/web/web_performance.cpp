#if defined(__EMSCRIPTEN__)
#include "web_performance.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <emscripten/emscripten.h>

namespace WebPerformance {
namespace {
struct Timing {
    std::atomic<uint32_t> total{0};
    std::atomic<uint32_t> peak{0};

    void Add(double milliseconds) noexcept {
        // A suspended laptop can resume with a very large first frame interval.
        const auto micros = static_cast<uint32_t>(std::clamp(milliseconds, 0.0, 4000000.0) * 1000.0);
        total.fetch_add(micros, std::memory_order_relaxed);
        uint32_t old = peak.load(std::memory_order_relaxed);
        while (old < micros && !peak.compare_exchange_weak(old, micros, std::memory_order_relaxed)) {}
    }
};
std::array<Timing, 7> timings;
Timing disc;
std::atomic<uint32_t> frames{0}, over25{0}, over50{0}, over100{0}, discReads{0};
} // namespace

bool Enabled() noexcept {
    static const bool enabled = [] {
        const char* value = std::getenv("MKW_WEB_PERF");
        return value && *value == '1';
    }();
    return enabled;
}

double Now() noexcept { return emscripten_get_now(); }

void RecordFrame(double interval, double guest, double drain, double copy, double wait,
                 double overlay, double present) noexcept {
    const std::array<double, 7> values{interval, guest, drain, copy, wait, overlay, present};
    for (size_t i = 0; i < values.size(); ++i) timings[i].Add(values[i]);
    frames.fetch_add(1, std::memory_order_relaxed);
    if (interval > 25.0) over25.fetch_add(1, std::memory_order_relaxed);
    if (interval > 50.0) over50.fetch_add(1, std::memory_order_relaxed);
    if (interval > 100.0) over100.fetch_add(1, std::memory_order_relaxed);
}

void RecordDiscRead(double elapsed) noexcept {
    disc.Add(elapsed);
    discReads.fetch_add(1, std::memory_order_relaxed);
}

void Report(double elapsed) noexcept {
    const uint32_t count = frames.exchange(0, std::memory_order_relaxed);
    std::array<double, 7> totals{}, peaks{};
    for (size_t i = 0; i < timings.size(); ++i) {
        totals[i] = timings[i].total.exchange(0, std::memory_order_relaxed) / 1000.0;
        peaks[i] = timings[i].peak.exchange(0, std::memory_order_relaxed) / 1000.0;
    }
    const auto slow25 = over25.exchange(0), slow50 = over50.exchange(0), slow100 = over100.exchange(0);
    const auto reads = discReads.exchange(0);
    const double discTotal = disc.total.exchange(0) / 1000.0, discPeak = disc.peak.exchange(0) / 1000.0;
    if (!count) return;
    std::printf("[web-perf] fps=%.1f frames=%u over25/50/100=%u/%u/%u "
                "avg_ms(frame/guest/drain/copy/wait/overlay/present)=%.2f/%.2f/%.2f/%.2f/%.2f/%.2f/%.2f "
                "max_ms=%.2f/%.2f/%.2f/%.2f/%.2f/%.2f/%.2f disc=%u total/max_ms=%.2f/%.2f\n",
                count * 1000.0 / elapsed, count, slow25, slow50, slow100,
                totals[0] / count, totals[1] / count, totals[2] / count, totals[3] / count,
                totals[4] / count, totals[5] / count, totals[6] / count,
                peaks[0], peaks[1], peaks[2], peaks[3], peaks[4], peaks[5], peaks[6],
                reads, discTotal, discPeak);
}
} // namespace WebPerformance
#endif
