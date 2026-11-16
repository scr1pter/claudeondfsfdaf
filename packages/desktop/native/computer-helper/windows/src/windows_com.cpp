#include "windows_com.h"
#include <objbase.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <thread>

namespace vector::computer {
struct WindowsComCall::State {
  std::mutex mutex;
  std::condition_variable condition;
  std::thread timer;
  std::chrono::steady_clock::time_point deadline;
  DWORD thread = 0;
  bool finished = false, enabled = false;
  WindowsComObservation unavailable = WindowsComObservation::cancellation_unavailable;
  std::atomic_bool expired{false};
};
WindowsComCall::WindowsComCall(uint32_t milliseconds) : state_(std::make_unique<State>()) {
  state_->deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(std::clamp<uint32_t>(milliseconds, 1, 50));
  state_->thread = GetCurrentThreadId(); const auto enabled = CoEnableCallCancellation(nullptr); state_->enabled = SUCCEEDED(enabled);
  if (enabled == CO_E_NOTINITIALIZED) state_->unavailable = WindowsComObservation::uninitialized;
  if (!state_->enabled) return;
  try {
    state_->timer = std::thread([state = state_.get()] {
      const auto initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
      std::unique_lock lock(state->mutex);
      if (!state->condition.wait_until(lock, state->deadline, [&] { return state->finished; })) {
        state->expired.store(true);
        // Keep retirement serialized so this ticket cannot cancel a successor RPC on the same thread.
        if (SUCCEEDED(initialized)) (void)CoCancelCall(state->thread, 0);
      }
      lock.unlock(); if (SUCCEEDED(initialized)) CoUninitialize();
    });
  } catch (...) { CoDisableCallCancellation(nullptr); state_->enabled = false; state_->unavailable = WindowsComObservation::timer_unavailable; }
}
WindowsComCall::~WindowsComCall() {
  { std::lock_guard lock(state_->mutex); state_->finished = true; state_->condition.notify_all(); }
  if (state_->timer.joinable()) state_->timer.join();
  if (state_->enabled) CoDisableCallCancellation(nullptr);
}
bool WindowsComCall::current() const noexcept {
  return state_->enabled && !state_->expired.load() && std::chrono::steady_clock::now() < state_->deadline;
}
WindowsComObservation WindowsComCall::observation() const noexcept {
  if (!state_->enabled) return state_->unavailable;
  return state_->expired.load() || std::chrono::steady_clock::now() >= state_->deadline
    ? WindowsComObservation::expired : WindowsComObservation::current;
}
}
