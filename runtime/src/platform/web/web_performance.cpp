#if defined(__EMSCRIPTEN__)
#include "web_performance.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <emscripten/emscripten.h>

extern "C" void aurora_web_frame_timings(double*, double*, double*, double*, double*);
extern "C" void aurora_web_map_stats(double*, double*);

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
Timing sleeps;
std::array<Timing, 3> presentParts;
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
    // Each long frame on its own line, in order with the other [web] / aurora log lines, so a spike
    // can be matched with what the game or renderer was doing just before it.
    static std::atomic<uint32_t> slowLogged{0};
    if (interval > 40.0 && slowLogged.fetch_add(1, std::memory_order_relaxed) < 400) {
        std::printf("[web-perf] slow frame %.1f ms: guest %.1f copy %.1f wait %.1f overlay %.1f present %.1f\n",
                    interval, guest, copy, wait, overlay, present);
    }
}

void RecordPresentParts(double endFrame, double pace, double post) noexcept {
    presentParts[0].Add(endFrame);
    presentParts[1].Add(pace);
    presentParts[2].Add(post);
}

void RecordSleep(double elapsed) noexcept { sleeps.Add(elapsed); }

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
    std::array<double, 3> partTotals{}, partPeaks{};
    for (size_t i = 0; i < presentParts.size(); ++i) {
        partTotals[i] = presentParts[i].total.exchange(0, std::memory_order_relaxed) / 1000.0;
        partPeaks[i] = presentParts[i].peak.exchange(0, std::memory_order_relaxed) / 1000.0;
    }
    double sealMs, encodeMs, waitMs, yieldMs, encodeMaxMs, mapLatencyMs, mapWaitMs;
    aurora_web_frame_timings(&sealMs, &encodeMs, &waitMs, &yieldMs, &encodeMaxMs);
    aurora_web_map_stats(&mapLatencyMs, &mapWaitMs);
    const double sleepMs = sleeps.total.exchange(0) / 1000.0;
    sleeps.peak.store(0);
    const auto reads = discReads.exchange(0);
    const double discTotal = disc.total.exchange(0) / 1000.0, discPeak = disc.peak.exchange(0) / 1000.0;
    if (!count) return;
    std::printf("[web-perf] fps=%.1f frames=%u over25/50/100=%u/%u/%u "
                "avg_ms(frame/guest/drain/copy/wait/overlay/present)=%.2f/%.2f/%.2f/%.2f/%.2f/%.2f/%.2f "
                "max_ms=%.2f/%.2f/%.2f/%.2f/%.2f/%.2f/%.2f disc=%u total/max_ms=%.2f/%.2f "
                "present_parts(endframe/pace/post) avg=%.2f/%.2f/%.2f max=%.2f/%.2f/%.2f "
                "aurora(seal/encode/schedwait/yield) avg=%.2f/%.2f/%.2f/%.2f encode_max=%.2f map(latency/wait_per_frame)=%.2f/%.2f vi_sleep_per_frame=%.2f busy_per_frame=%.2f\n",
                count * 1000.0 / elapsed, count, slow25, slow50, slow100,
                totals[0] / count, totals[1] / count, totals[2] / count, totals[3] / count,
                totals[4] / count, totals[5] / count, totals[6] / count,
                peaks[0], peaks[1], peaks[2], peaks[3], peaks[4], peaks[5], peaks[6],
                reads, discTotal, discPeak,
                partTotals[0] / count, partTotals[1] / count, partTotals[2] / count,
                partPeaks[0], partPeaks[1], partPeaks[2],
                sealMs / count, encodeMs / count, waitMs / count, yieldMs / count, encodeMaxMs,
                mapLatencyMs, mapWaitMs / count, sleepMs / count,
                totals[0] / count - sleepMs / count - waitMs / count - mapWaitMs / count - yieldMs / count);
}
} // namespace WebPerformance
#endif
