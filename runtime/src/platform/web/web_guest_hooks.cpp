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
constexpr int32_t kForgiveLagOnline = 600;  // online: catch up after stalls of up to 10 s

bool s_catchup = false;
bool s_noLagWait = true;
bool s_onlineRace = false;      // ProcessLagFrames has run in this race: other players are racing too
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

// What an iteration costs when it draws and when it does not (ms of work, sleeping excluded), as
// moving averages, and from that how often a frame has to be drawn. Mild lag (a fifth of the draws
// or fewer have to go) skips on demand, which costs the occasional frame showing two steps of
// motion. More than that draws on a fixed rhythm instead (every 2nd, 3rd... step): every frame
// then shows the same amount of motion at the same interval, which looks steady where skipping
// on demand looks shaky.
double s_drawBusy = 0.0, s_skipBusy = 0.0;
int32_t s_divider = 1, s_pendingDivider = 1;
constexpr int32_t kEvaluateEvery = 45;
constexpr double kOnDemandLimit = 0.20;   // above this skipped fraction, use a fixed rhythm
constexpr int32_t kMaxDivider = 6;

void UpdateDivider(double period) {
    int32_t wanted = 1;
    if (s_drawBusy > period * 1.03) {
        const double skipBusy = s_skipBusy > 0.5 ? s_skipBusy : 3.0;
        const double needed = (s_drawBusy - period) / (s_drawBusy - skipBusy);  // fraction to skip
        if (needed > kOnDemandLimit) {
            const double clamped = needed < 0.9 ? needed : 0.9;
            wanted = static_cast<int32_t>(1.0 / (1.0 - clamped) + 0.999);
            if (wanted < 2) wanted = 2;
            if (wanted > kMaxDivider) wanted = kMaxDivider;
        }
    }
    // Two evaluations in a row, so one slow stretch does not flip the rhythm.
    if (wanted == s_pendingDivider) s_divider = wanted;
    s_pendingDivider = wanted;
}

bool DecideSkip() {
    const double now = WebPerformance::Now();
    const double period = WebPacing::RetraceIntervalMs();
    if (!s_raceCalc) {
        // Not in a race: nothing to catch up, and the next race starts level.
        s_baseTime = now;
        s_steps = 0;
        s_streak = 0;
        s_idleSleepMs = 0.0;
        s_drawBusy = s_skipBusy = 0.0;
        s_divider = s_pendingDivider = 1;
        s_onlineRace = false;
        return false;
    }
    s_raceCalc = false;
    s_thisRace = true;
    ++s_steps;
    ++s_raceSteps;
    const double dt = now - s_lastDecision;
    if (s_trace) {
        static int printed = 0;
        if (printed < 240 && (printed++ % 1) == 0) {
            std::printf("[web-pace-trace] step=%d dt=%.1f idle=%.1f lag=%.2f%s div=%d\n", s_steps, dt, s_idleSleepMs,
                        (now - s_baseTime) / period - s_steps, s_idleSleepMs >= 3.0 ? " SLEPT" : "", s_divider);
        }
    }
    // The iteration that just ended was a skipped one or a drawn one; its work was dt minus sleeping.
    if (s_previousRace && s_lastDecision != 0.0 && dt < 200.0) {
        const double busy = dt - s_idleSleepMs;
        double& average = s_previousSkipped ? s_skipBusy : s_drawBusy;
        average = average == 0.0 ? busy : average * 0.85 + busy * 0.15;
    }
    s_lastDecision = now;
    s_idleSleepMs = 0.0;
    if (s_steps % kEvaluateEvery == 0) UpdateDivider(period);

    // How far the race is behind the wall clock, in whole steps. Sleeping does not prove the game
    // is on time: after a frame overruns its retrace, VIWaitForRetrace sleeps until the following
    // one, so a machine that is slightly too slow sleeps every iteration and still loses a step
    // each time (53-56 steps/s on a 143 Hz Windows player, 2026-10-07). Only the clock decides;
    // being early re-anchors the timeline (absorbing drift between this clock and the VI's).
    double behind = (now - s_baseTime) / period - s_steps;
    if (behind < 0.0) {
        s_baseTime = now - s_steps * period;
        behind = 0.0;
    }
    const int32_t lag = static_cast<int32_t>(behind);
    if (lag > s_maxLag.load(std::memory_order_relaxed)) s_maxLag.store(lag, std::memory_order_relaxed);
    // A long stall is forgiven offline (catching up would only fast-forward the scene), but online
    // the other players kept racing, so the race catches up to them instead.
    if (lag > (s_onlineRace ? kForgiveLagOnline : kForgiveLag)) {
        s_baseTime = now - s_steps * period;
        s_streak = 0;
        ++s_forgiven;
        return false;
    }

    bool skip;
    if (s_divider >= 2) {
        skip = (s_steps % s_divider) != 0;
        s_streak = 0;
    } else {
        skip = lag >= 1 && s_streak < kMaxSkipStreak;
        s_streak = skip ? s_streak + 1 : 0;
    }
    if (skip) {
        ++s_skipCount;
        // Only a real debt is repaid by running on; otherwise the skipped step waits its turn.
        if (lag >= 1) WebPacing::BorrowRetrace();
    }
    return skip;
}

} // namespace

void Init() {
    WebPerformance::InitializeBenchmark();
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
        WebPerformance::RecordBenchmarkOnlineCheck();
        s_lagCalls.fetch_add(1, std::memory_order_relaxed);
        s_onlineRace = true;
        return s_noLagWait;
    }
    // Measure the simulation even with catch-up disabled; otherwise a slow-motion baseline
    // could falsely look healthy because its simulation steps were never counted.
    if (target == kRaceCalc) WebPerformance::RecordBenchmarkStep();
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
    std::printf("[web-pace] race steps/s=%.1f drawn/s=%.1f skipped/s=%.1f forgiven=%u max_lag=%d draw_every=%d "
                "work_ms(draw/skip)=%.1f/%.1f%s\n",
                steps * 1000.0 / elapsedMs, drawn * 1000.0 / elapsedMs, skipped * 1000.0 / elapsedMs, forgiven,
                maxLag, s_divider, s_drawBusy, s_skipBusy, cost);
}

} // namespace WebGuestHooks

void WebPacing::NoteIdleSleep(double sleptMs) {
    WebGuestHooks::s_idleSleepMs += sleptMs;
}
#endif
