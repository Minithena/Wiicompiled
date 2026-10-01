#pragma once

#if defined(__EMSCRIPTEN__)
namespace WebPerformance {
bool Enabled() noexcept;
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
} // namespace WebPerformance
#endif
