#pragma once

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
extern "C" {
// common.cpp: suspend until the next staging-map completion (or a short timeout), and wake it.
void aurora_web_wait_for_map(void);
void aurora_web_map_signal(void);
}
#endif
#include <chrono>
#include <cstdlib>
#include <condition_variable>
#include <cstdint>
#include <mutex>

namespace aurora::gfx {

enum class BufferMapState { Unmapped, Mapping, Mapped };

// The renderer owns request/reset; Dawn may complete a request on another thread.
// An old callback must never publish readiness for a different staging slot.
class StagingMapState {
  mutable std::mutex mutex_;
  std::condition_variable changed_;
  uint64_t generation_ = 0;
  BufferMapState state_ = BufferMapState::Unmapped;

public:
  uint64_t request() {
    std::lock_guard lock(mutex_);
    if (state_ != BufferMapState::Unmapped) return 0;
    state_ = BufferMapState::Mapping;
    return ++generation_;
  }

  bool complete(uint64_t generation, BufferMapState state) {
    {
      std::lock_guard lock(mutex_);
      if (generation != generation_ || state_ != BufferMapState::Mapping) return false;
      state_ = state;
    }
    changed_.notify_all();
    return true;
  }

  void reset() {
    {
      std::lock_guard lock(mutex_);
      ++generation_;
      state_ = BufferMapState::Unmapped;
    }
    changed_.notify_all();
  }

  BufferMapState state() const {
    std::lock_guard lock(mutex_);
    return state_;
  }

  void wait_for_progress() {
#ifdef __EMSCRIPTEN__
    // Map completions are delivered from the browser event loop of this same thread, so a condition
    // variable wait would deadlock. Suspend through JSPI until the completion callback signals:
    // polling with emscripten_sleep(1) cost 4 ms per poll once the browser clamps nested timers,
    // however early the GPU finished.
    static const bool oldYield = [] { const char* v = std::getenv("MKW_WEB_OLD_YIELD"); return v && *v == '1'; }();
    if (oldYield) emscripten_sleep(1); else aurora_web_wait_for_map();
    return;
#else
    std::unique_lock lock(mutex_);
    // ProcessEvents is still serviced between waits for implementations that
    // need it. A spontaneous completion wakes immediately, without polling.
    changed_.wait_for(lock, std::chrono::milliseconds(1),
                      [&] { return state_ != BufferMapState::Mapping; });
#endif
  }
};

} // namespace aurora::gfx
