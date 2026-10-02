#pragma once

#if defined(__EMSCRIPTEN__)
namespace WebPerformance {
// Frame/disc/pacing statistics and the 3 s summary lines (MKW_WEB_PERF=1; the page sets it for
// every player so a saved log always has them). Cheap: a few clock reads per frame.
bool Enabled() noexcept;
// The guest-function sampling profiler thread ("?log" only: MKW_WEB_PROFILE=1).
bool ProfilerEnabled() noexcept;
double Now() noexcept;
void RecordFrame(double interval, double guest, double drain, double copy, double wait,
                 double overlay, double present) noexcept;
void RecordPresentParts(double endFrame, double pace, double post) noexcept;
void RecordDiscRead(double elapsed) noexcept;
void RecordSleep(double elapsed) noexcept;
// Guest-function sampler support: samples are pushed from a helper thread; a slow frame reports
// what was sampled during it.
void PushSample(double now, unsigned address) noexcept;
void ReportSlowFrameSamples(double frameStart, double frameEnd) noexcept;
void Report(double elapsed) noexcept;
// Separate, low-overhead benchmark mode: no statistical profiler or per-frame console output.
bool BenchmarkEnabled() noexcept;
void InitializeBenchmark();
void RecordBenchmarkStep() noexcept;
void RecordBenchmarkOnlineCheck() noexcept;
void RecordBenchmarkPresentation(double now, double guest, double drain, double copy,
                                 double wait, double overlay, double present) noexcept;
} // namespace WebPerformance
#endif
