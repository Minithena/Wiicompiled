#if defined(__EMSCRIPTEN__)
#include "web_performance.h"
#include "runtime_config.h"
#include "memory.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <emscripten/emscripten.h>

extern "C" void aurora_web_frame_timings(double*, double*, double*, double*, double*);
extern "C" void aurora_web_map_stats(double*, double*);
extern "C" void mkw_benchmark_init(const char*, const char*);
extern "C" void mkw_benchmark_step(double, double, double, int, int, int, int, int, int);
extern "C" void mkw_benchmark_online();
extern "C" void mkw_benchmark_present(double, double, double, double, double, double, double);

namespace WebPerformance {
namespace {
struct Sample { double time; uint32_t address; };
constexpr size_t kSampleRing = 16384;
std::array<Sample, kSampleRing> sampleRing;
std::atomic<uint32_t> sampleHead{0};

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
// Only the cooperative game worker writes these; the diagnostic watchdog does not reset them.
double benchmarkIdleMs = 0.0, benchmarkDiscMs = 0.0;
} // namespace

bool Enabled() noexcept {
    static const bool enabled = [] {
        const char* value = std::getenv("MKW_WEB_PERF");
        return value && *value == '1';
    }();
    return enabled;
}

double Now() noexcept { return emscripten_get_now(); }

bool BenchmarkEnabled() noexcept {
    static const bool enabled = std::getenv("MKW_WEB_BENCHMARK_CONFIG") != nullptr;
    return enabled;
}

void InitializeBenchmark() {
    if (!BenchmarkEnabled()) return;
    char settings[512];
    std::snprintf(settings, sizeof(settings),
        "{\"resolution_scale\":%.3f,\"interpolation_fps\":%u,\"disabled_effects\":%u,"
        "\"skip_unready_pipelines\":%s,\"disable_copy_filter\":%s,\"audio_mix_worker\":%s,\"muted\":%s}",
        RuntimeConfigFile::ResolutionMultiplier(), RuntimeConfigFile::FrameInterpolationFps(),
        RuntimeConfigFile::DisabledPostProcessingPaths(),
        RuntimeConfigFile::SkipUnreadyPipelines() ? "true" : "false",
        RuntimeConfigFile::DisableCopyFilter() ? "true" : "false",
        RuntimeConfigFile::AudioMixWorkerEnabled() ? "true" : "false",
        RuntimeConfigFile::AudioMuted() ? "true" : "false");
    mkw_benchmark_init(std::getenv("MKW_WEB_BENCHMARK_CONFIG"), settings);
}

void RecordBenchmarkStep() noexcept {
    if (!BenchmarkEnabled()) return;
    // Supported RMCP01: Raceinfo singleton and stage, also used by IsAtLeastStage.
    // Stage 2 is active racing, excluding intro/countdown from the driving benchmark.
    int stage = -1;
    const uint32_t raceInfo = Memory::Read32(0x809BD730u);
    if (raceInfo && Memory::Contains(raceInfo, 44)) stage = static_cast<int>(Memory::Read32(raceInfo + 40));
    int course = -1, engine = -1, mode = -1, players = -1, firstPlayerType = -1;
    const uint32_t scenario = Memory::Read32(0x809BD728u);
    if (scenario && Memory::Contains(scenario, 2932)) {
        course = static_cast<int>(Memory::Read32(scenario + 2920));
        engine = static_cast<int>(Memory::Read32(scenario + 2924));
        mode = static_cast<int>(Memory::Read32(scenario + 2928));
        players = Memory::Read8(scenario + 36);
        firstPlayerType = static_cast<int>(Memory::Read32(scenario + 56));
    }
    mkw_benchmark_step(Now(), benchmarkIdleMs, benchmarkDiscMs, stage,
        course, engine, mode, players, firstPlayerType);
    benchmarkIdleMs = benchmarkDiscMs = 0.0;
}

void RecordBenchmarkOnlineCheck() noexcept {
    if (BenchmarkEnabled()) mkw_benchmark_online();
}

void RecordBenchmarkPresentation(double now, double guest, double drain, double copy,
                                 double wait, double overlay, double present) noexcept {
    if (BenchmarkEnabled()) mkw_benchmark_present(now, guest, drain, copy, wait, overlay, present);
}

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
    if (interval > 150.0) {
        const double endTime = Now();
        ReportSlowFrameSamples(endTime - interval, endTime);
    }
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

void RecordSleep(double elapsed) noexcept {
    if (Enabled()) sleeps.Add(elapsed);
    if (BenchmarkEnabled()) benchmarkIdleMs += elapsed;
}

void PushSample(double now, unsigned address) noexcept {
    const uint32_t index = sampleHead.load(std::memory_order_relaxed);
    sampleRing[index % kSampleRing] = {now, address};
    sampleHead.store(index + 1, std::memory_order_release);
}

void ReportSlowFrameSamples(double frameStart, double frameEnd) noexcept {
    const uint32_t head = sampleHead.load(std::memory_order_acquire);
    std::array<std::pair<uint32_t, uint32_t>, 4096> bins{};  // address, count
    size_t used = 0;
    uint32_t total = 0;
    for (uint32_t i = 0; i < kSampleRing && i < head; ++i) {
        const Sample sample = sampleRing[(head - 1 - i) % kSampleRing];
        if (sample.time < frameStart) break;
        if (sample.time > frameEnd) continue;
        ++total;
        size_t b = 0;
        while (b < used && bins[b].first != sample.address) ++b;
        if (b == used && used < bins.size()) bins[used++] = {sample.address, 0};
        if (b < used) ++bins[b].second;
    }
    if (!total) return;
    std::sort(bins.begin(), bins.begin() + used, [](auto& a, auto& b) { return a.second > b.second; });
    std::string line = "[web-prof] slow frame " + std::to_string(static_cast<int>(frameEnd - frameStart)) + " ms samples=" + std::to_string(total);
    for (size_t i = 0; i < used && i < 8; ++i) {
        char item[40];
        std::snprintf(item, sizeof(item), " %08x:%.0f%%", bins[i].first, 100.0 * bins[i].second / total);
        line += item;
    }
    std::printf("%s\n", line.c_str());
}

void RecordDiscRead(double elapsed) noexcept {
    if (Enabled()) {
        disc.Add(elapsed);
        discReads.fetch_add(1, std::memory_order_relaxed);
    }
    if (BenchmarkEnabled()) benchmarkDiscMs += elapsed;
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
