#pragma once
#include <windows.h>
#include <cstdint>
#include <functional>
#include <memory>

namespace vector::computer {
class ParentIdentity;
enum class StopReason { eof, parent_died, parent_changed, transport_error, shutdown };

// Finished means actual process death, never merely completed resource cleanup.
// The production fuse remains armed through cleanup and skips potentially stalled CRT/DLL teardown.
constexpr std::uint64_t lifecycle_exit_budget_ms = 750;
bool lifecycle_exit_due(std::uint64_t started, std::uint64_t now, bool process_exited) noexcept;
int lifecycle_exit_code(StopReason reason) noexcept;

class HelperLifecycle final {
 public:
  using StopCallback = std::function<void(StopReason)>;
  using HardExit = std::function<void(int)>;
  // Start before signature/hash verification so parent death cannot strand startup in native APIs.
  // This handle is only a lifetime witness. verify_parent() must still authenticate before serving.
  HelperLifecycle(DWORD candidate_parent, HANDLE input, StopCallback stop, HardExit hard_exit = {});
  // The finite privileged self-test has no serving pipe. Its real parent is still independently
  // watched before file/trust work; this overload never installs an EOF observer or invents a pipe.
  HelperLifecycle(DWORD candidate_parent, StopCallback stop, HardExit hard_exit = {});
  ~HelperLifecycle();
  HelperLifecycle(const HelperLifecycle&) = delete;
  HelperLifecycle& operator=(const HelperLifecycle&) = delete;
  HANDLE stop_event() const noexcept;
  bool stopping() const noexcept;
  // Bounded held-kernel-process/start facts, suitable for the final same-thread/actor metadata gate.
  bool parent_current() const noexcept;
  int exit_code() const noexcept;
  void request_stop(StopReason reason) noexcept;
  // Reader/writer adapters register their actual thread handles before synchronous pipe I/O.
  // Duplicated thread handles are private and CancelSynchronousIo is called on every stop.
  bool attach_io_thread(HANDLE thread) noexcept;
  // One authenticated identity, polled away from both the parent wait and server authority lock.
  bool bind_parent(std::shared_ptr<ParentIdentity> parent) noexcept;
  // Called only after authority revocation/resource cleanup. No joins or OS-handler locks.
  void finish(int exit_code = 0) noexcept;
 private:
  HelperLifecycle(DWORD, HANDLE, bool require_pipe, StopCallback, HardExit);
  struct State;
  std::shared_ptr<State> state_;
};
}
