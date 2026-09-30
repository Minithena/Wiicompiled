#pragma once

#if defined(__EMSCRIPTEN__)
namespace WebPerformance {
bool Enabled() noexcept;
double Now() noexcept;
void RecordFrame(double interval, double guest, double drain, double copy, double wait,
                 double overlay, double present) noexcept;
void RecordDiscRead(double elapsed) noexcept;
void Report(double elapsed) noexcept;
} // namespace WebPerformance
#endif
