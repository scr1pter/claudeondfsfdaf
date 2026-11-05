#pragma once
#include <windows.h>
#include <cstdint>
#include <memory>

namespace vector::computer {
enum class WindowsComObservation { current, uninitialized, cancellation_unavailable, timer_unavailable, expired };
// A public COM cancellation request bounds cooperative RPCs. It cannot roll back an already
// accepted OS operation or force a remote provider to honor cancellation; callers reject late results.
class WindowsComCall final {
 public:
  explicit WindowsComCall(uint32_t milliseconds = 50);
  ~WindowsComCall();
  WindowsComCall(const WindowsComCall&) = delete;
  WindowsComCall& operator=(const WindowsComCall&) = delete;
  bool current() const noexcept;
  // Read-only failure classification; it does not renew or change the call's deadline.
  WindowsComObservation observation() const noexcept;
 private:
  struct State;
  std::unique_ptr<State> state_;
};
}
