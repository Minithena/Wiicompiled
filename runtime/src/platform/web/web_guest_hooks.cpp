#if defined(__EMSCRIPTEN__)
#include "web_guest_hooks.h"

#include "hle_stubs.h"
#include "ppc_runtime.h"
#include "web_pacing.h"
#include "web_performance.h"

#include <atomic>
#include <cstdio>
#include <cstdlib>

namespace WebGuestHooks {

namespace {

constexpr uint32_t kRaceCalc = 0x80554E6Cu;      // RaceScene::OnCalc
constexpr uint32_t kSceneDraw = 0x80009988u;     // RKSceneManager::draw (EGG::SceneManager::draw)
constexpr uint32_t kEggSceneDraw = 0x8023AEACu;  // EGG::SceneManager::draw
constexpr uint32_t kProcessLagFrames = 0x80654B00u;  // RKNet::PacketMgr::ProcessLagFrames

constexpr int32_t kMaxSkipStreak = 5;  // at least every sixth iteration is drawn (10 frames a second)
constexpr int32_t kForgiveLag = 6;     // further behind than this is a stall, not slowness

bool s_catchup = false;
bool s_noLagWait = true;
std::atomic<uint32_t> s_lagCalls{0};
bool s_raceCalc = false;        // RaceScene::OnCalc ran in this iteration
bool s_decided = false;         // the draw of this iteration has been decided
bool s_skipped = false;         // ... and it was skipped
double s_baseTime = 0.0;        // when the race's step 0 was due (ms); step n is due at base + n * period
bool s_trace = false;
double s_idleSleepMs = 0.0;
double s_lastDecision = 0.0;    // time slept with nothing to run since the previous decision
int32_t s_steps = 0;
int32_t s_streak = 0;

// Counters for the report.
std::atomic<uint32_t> s_raceSteps{0}, s_drawn{0}, s_skipCount{0}, s_forgiven{0};
std::atomic<int32_t> s_maxLag{0};

// Cost of one race iteration, in microseconds. Two consecutive skipped iterations never draw and
// never wait (the game is behind), so the time between them is the cost of the simulation step
// alone: if that is under 16.7 ms the machine can hold 60 steps a second. An iteration that
// draws includes the draw, the present and any wait for the next retrace.
std::atomic<uint64_t> s_simUs{0}, s_drawnUs{0}, s_drawGuestUs{0};
std::atomic<uint32_t> s_simN{0}, s_drawnN{0};
double s_previousBoundary = 0.0;
double s_drawStarted = 0.0;
bool s_previousSkipped = false;
bool s_previousRace = false;
bool s_thisRace = false;

bool DecideSkip() {
    const double now = WebPerformance::Now();
    const double period = WebPacing::RetraceIntervalMs();
    if (!s_raceCalc) {
        // Not in a race: nothing to catch up, and the next race starts level.
        s_baseTime = now;
        s_steps = 0;
        s_streak = 0;
        s_idleSleepMs = 0.0;
        return false;
    }
    s_raceCalc = false;
    s_thisRace = true;
    ++s_steps;
    ++s_raceSteps;
    const bool ahead = s_idleSleepMs >= 3.0;
    if (s_trace) {
        static int printed = 0;
        if (printed < 240 && (printed++ % 1) == 0) {
            std::printf("[web-pace-trace] step=%d dt=%.1f idle=%.1f lag=%.2f%s\n", s_steps, now - s_lastDecision,
                        s_idleSleepMs, (now - s_baseTime) / period - s_steps, ahead ? " AHEAD" : "");
        }
    }
    s_lastDecision = now;
    s_idleSleepMs = 0.0;
    if (ahead) {
        // The game had time to sleep this iteration, so it has headroom and owes nothing (this
        // also absorbs any drift between our clock and the VI's). Real lag never sleeps: the
        // retraces it waits for are already due.
        s_baseTime = now - s_steps * period;
        s_streak = 0;
        return false;
    }
    const int32_t lag = static_cast<int32_t>((now - s_baseTime) / period) - s_steps;
    if (lag > s_maxLag.load(std::memory_order_relaxed)) s_maxLag.store(lag, std::memory_order_relaxed);
    if (lag > kForgiveLag) {
        s_baseTime = now - s_steps * period;
        s_streak = 0;
        ++s_forgiven;
        return false;
    }
    if (lag >= 1 && s_streak < kMaxSkipStreak) {
        ++s_streak;
        ++s_skipCount;
        WebPacing::BorrowRetrace();
        return true;
    }
    s_streak = 0;
    return false;
}

} // namespace

void Init() {
    const char* noCatchup = std::getenv("MKW_WEB_NOCATCHUP");
    s_catchup = !(noCatchup && *noCatchup == '1');
    const char* lagwait = std::getenv("MKW_WEB_LAGWAIT");
    s_noLagWait = !(lagwait && *lagwait == '1');
    const char* trace = std::getenv("MKW_WEB_PACE_TRACE");
    s_trace = trace && *trace == '1';
    if (s_noLagWait) {
        std::printf("[web-pace] lag-frame waiting off: a lagging player does not slow the room\n");
    }
    if (s_catchup) {
        std::printf("[web-pace] real-time simulation on: a late race frame skips its draw so the game keeps up\n");
    }
}

bool Handle(uint32_t target, CpuContext*) {
    if (target == kProcessLagFrames) {
        s_lagCalls.fetch_add(1, std::memory_order_relaxed);
        return s_noLagWait;
    }
    if (!s_catchup) return false;
    if (target == kRaceCalc) {
        s_raceCalc = true;
        return false;
    }
    // Any of the draw entry points: decide once per iteration, the first one seen.
    if (!s_decided) {
        s_thisRace = false;
        s_skipped = DecideSkip();
        s_decided = true;
        s_drawStarted = WebPerformance::Now();
    }
    return s_skipped;
}

bool ConsumeSkippedFrame() {
    const bool skipped = s_skipped;
    const double now = WebPerformance::Now();
    if (s_decided && s_thisRace && s_previousRace && s_previousBoundary != 0.0) {
        const uint64_t us = static_cast<uint64_t>((now - s_previousBoundary) * 1000.0);
        if (skipped && s_previousSkipped) {
            s_simUs.fetch_add(us, std::memory_order_relaxed);
            s_simN.fetch_add(1, std::memory_order_relaxed);
        } else if (!skipped) {
            s_drawnUs.fetch_add(us, std::memory_order_relaxed);
            s_drawnN.fetch_add(1, std::memory_order_relaxed);
        }
    }
    if (!skipped && s_decided) {
        ++s_drawn;
        if (s_thisRace) s_drawGuestUs.fetch_add(static_cast<uint64_t>((now - s_drawStarted) * 1000.0), std::memory_order_relaxed);
    }
    s_previousBoundary = now;
    s_previousSkipped = skipped;
    s_previousRace = s_decided && s_thisRace;
    s_decided = false;
    s_skipped = false;
    return skipped;
}

void Report(double elapsedMs) {
    const uint32_t lagCalls = s_lagCalls.exchange(0);
    if (lagCalls) {
        std::printf("[web-pace] online race: lag-frame checks %s (%u)\n", s_noLagWait ? "skipped" : "run", lagCalls);
    }
    if (!s_catchup) return;
    const uint32_t steps = s_raceSteps.exchange(0), drawn = s_drawn.exchange(0), skipped = s_skipCount.exchange(0),
                   forgiven = s_forgiven.exchange(0);
    const int32_t maxLag = s_maxLag.exchange(0);
    if (!steps) return;
    const uint64_t simUs = s_simUs.exchange(0), drawnUs = s_drawnUs.exchange(0), drawGuestUs = s_drawGuestUs.exchange(0);
    const uint32_t simN = s_simN.exchange(0), drawnN = s_drawnN.exchange(0);
    char cost[160] = "";
    if (simN || drawnN) {
        // step_ms: one simulation step alone (needs to be under 16.7 for 60 steps/s);
        // drawn_ms: an iteration that draws, with its present and any wait; draw_guest_ms: just the
        // game's own scene drawing inside it.
        std::snprintf(cost, sizeof(cost), " step_ms=%.1f(%u) drawn_ms=%.1f(%u) draw_guest_ms=%.1f",
                      simN ? simUs / 1000.0 / simN : 0.0, simN, drawnN ? drawnUs / 1000.0 / drawnN : 0.0, drawnN,
                      drawnN ? drawGuestUs / 1000.0 / drawnN : 0.0);
    }
    std::printf("[web-pace] race steps/s=%.1f drawn/s=%.1f skipped/s=%.1f forgiven=%u max_lag=%d%s\n",
                steps * 1000.0 / elapsedMs, drawn * 1000.0 / elapsedMs, skipped * 1000.0 / elapsedMs, forgiven,
                maxLag, cost);
}

} // namespace WebGuestHooks

void WebPacing::NoteIdleSleep(double sleptMs) {
    WebGuestHooks::s_idleSleepMs += sleptMs;
}
#endif
