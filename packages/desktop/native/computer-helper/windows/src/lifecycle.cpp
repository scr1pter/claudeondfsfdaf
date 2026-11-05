#include "lifecycle.h"
#include "parent_identity.h"
#include <atomic>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <thread>
#include <utility>
#include <vector>
#include <winrt/base.h>

namespace vector::computer {
bool lifecycle_exit_due(std::uint64_t started, std::uint64_t now, bool process_exited) noexcept {
  return !process_exited && now >= started && now - started >= lifecycle_exit_budget_ms;
}
int lifecycle_exit_code(StopReason reason) noexcept {
  return reason == StopReason::transport_error || reason == StopReason::parent_changed ? 1 : 0;
}

struct HelperLifecycle::State final : std::enable_shared_from_this<HelperLifecycle::State> {
  winrt::handle parent;
  winrt::handle stop_event;
  winrt::handle finished_event;
  DWORD parent_pid = 0;
  std::uint64_t parent_created = 0;
  HANDLE input = INVALID_HANDLE_VALUE;
  StopCallback callback;
  HardExit hard_exit;
  std::atomic<bool> stopping{false};
  std::atomic<bool> finished{false};
  std::atomic<bool> bound{false};
  std::atomic<int> final_code{0};
  std::mutex io_lock;
  std::vector<winrt::handle> io_threads;

  bool parent_current() const noexcept {
    if (!parent || !parent_pid || !parent_created || GetProcessId(parent.get()) != parent_pid || WaitForSingleObject(parent.get(), 0) != WAIT_TIMEOUT) return false;
    FILETIME created{}, exited{}, kernel{}, user{};
    if (!GetProcessTimes(parent.get(), &created, &exited, &kernel, &user)) return false;
    return ((std::uint64_t(created.dwHighDateTime) << 32) | created.dwLowDateTime) == parent_created &&
      WaitForSingleObject(parent.get(), 0) == WAIT_TIMEOUT;
  }

  bool attach(HANDLE thread) noexcept {
    HANDLE raw = nullptr;
    if (!thread || thread == INVALID_HANDLE_VALUE || !DuplicateHandle(GetCurrentProcess(), thread, GetCurrentProcess(), &raw, THREAD_TERMINATE | SYNCHRONIZE, FALSE, 0)) return false;
    winrt::handle copy{raw};
    std::lock_guard guard(io_lock);
    if (stopping.load() || finished.load() || io_threads.size() >= 16) return false;
    try { io_threads.push_back(std::move(copy)); return true; } catch (...) { return false; }
  }

  void cancel_io() noexcept {
    std::lock_guard guard(io_lock);
    for (const auto& thread : io_threads) (void)CancelSynchronousIo(thread.get());
  }

  void request(StopReason reason, std::optional<int> completion_code = {}) noexcept {
    if (finished.load()) return;
    if (stopping.exchange(true)) {
      // Preserve a serving failure discovered during existing EOF/parent cleanup. A later skip
      // cannot replace an already-known transport/identity failure by77.
      if (completion_code && *completion_code != 0 && (final_code.load() != 1 || *completion_code == 1)) final_code.store(*completion_code);
      return;
    }
    if (completion_code) final_code.store(*completion_code);
    else if (lifecycle_exit_code(reason) != 0) final_code.store(lifecycle_exit_code(reason));
    SetEvent(stop_event.get());
    // This fuse is independent of callback completion, dispatcher/native locks, and blocked I/O.
    // TerminateProcess skips DLL detach waits that could themselves deadlock during ExitProcess.
    const auto self = shared_from_this();
    try {
      std::thread([self] {
        (void)WaitForSingleObject(self->finished_event.get(), static_cast<DWORD>(lifecycle_exit_budget_ms));
        // Cleanup may finish before the deadline, but only real process death can retire this fuse.
        self->hard_exit(self->final_code.load());
      }).detach();
    } catch (...) { hard_exit(lifecycle_exit_code(reason)); return; }
    cancel_io();
    try {
      std::thread([self, reason] {
        try { self->callback(reason); } catch (...) {}
      }).detach();
    } catch (...) { /* The already armed exit fuse still bounds shutdown. */ }
  }

  void watch() noexcept {
    const HANDLE handles[] = {stop_event.get(), parent.get()};
    const auto result = WaitForMultipleObjects(2, handles, FALSE, INFINITE);
    if (result == WAIT_OBJECT_0) return;
    request(result == WAIT_OBJECT_0 + 1 ? StopReason::parent_died : StopReason::transport_error);
  }

  void watch_pipe() noexcept {
    if (!attach(GetCurrentThread())) { if (!finished.load()) request(StopReason::transport_error); return; }
    // PeekNamedPipe on a synchronous pipe can wait behind another thread's ReadFile. It is
    // deliberately separate from the held-parent wait and its hard exit fuse, and cancelable.
    for (;;) {
      const auto result = WaitForSingleObject(stop_event.get(), 10);
      if (result == WAIT_OBJECT_0) return;
      if (result != WAIT_TIMEOUT) { request(StopReason::transport_error); return; }
      DWORD available = 0;
      if (!PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr)) {
        const auto error = GetLastError();
        request(error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED || error == ERROR_NO_DATA ? StopReason::eof : StopReason::transport_error);
        return;
      }
    }
  }
};

HelperLifecycle::HelperLifecycle(DWORD candidate_parent, HANDLE input, StopCallback stop, HardExit hard_exit)
  : HelperLifecycle(candidate_parent, input, true, std::move(stop), std::move(hard_exit)) {}
HelperLifecycle::HelperLifecycle(DWORD candidate_parent, StopCallback stop, HardExit hard_exit)
  : HelperLifecycle(candidate_parent, INVALID_HANDLE_VALUE, false, std::move(stop), std::move(hard_exit)) {}
HelperLifecycle::HelperLifecycle(DWORD candidate_parent, HANDLE input, bool require_pipe, StopCallback stop, HardExit hard_exit)
  : state_(std::make_shared<State>()) {
  if (candidate_parent == 0 || candidate_parent == GetCurrentProcessId() || !stop ||
      (require_pipe && (!input || input == INVALID_HANDLE_VALUE || GetFileType(input) != FILE_TYPE_PIPE)))
    throw std::runtime_error("The helper lifetime pipe or parent is unavailable.");
  state_->parent.attach(OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, candidate_parent));
  state_->stop_event.attach(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  state_->finished_event.attach(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  if (!state_->parent || !state_->stop_event || !state_->finished_event) throw std::runtime_error("The helper lifetime monitor could not start.");
  FILETIME parent_created{}, helper_created{}, exited{}, kernel{}, user{};
  if (!GetProcessTimes(state_->parent.get(), &parent_created, &exited, &kernel, &user) ||
      !GetProcessTimes(GetCurrentProcess(), &helper_created, &exited, &kernel, &user))
    throw std::runtime_error("The helper parent creation identity is unavailable.");
  state_->parent_pid = candidate_parent;
  state_->parent_created = (std::uint64_t(parent_created.dwHighDateTime) << 32) | parent_created.dwLowDateTime;
  const auto own_created = (std::uint64_t(helper_created.dwHighDateTime) << 32) | helper_created.dwLowDateTime;
  if (!own_created || !state_->parent_created || state_->parent_created > own_created || !state_->parent_current())
    throw std::runtime_error("The helper parent creation identity changed.");
  state_->input = input; state_->callback = std::move(stop);
  state_->hard_exit = hard_exit ? std::move(hard_exit) : [](int code) { (void)TerminateProcess(GetCurrentProcess(), static_cast<UINT>(code)); };
  const auto state = state_;
  std::thread([state] { state->watch(); }).detach();
  if (require_pipe) {
    try { std::thread([state] { state->watch_pipe(); }).detach(); }
    catch (...) { state_->request(StopReason::transport_error); throw; }
  }
}
HelperLifecycle::~HelperLifecycle() {
  // Normal callers finish after cleanup. An exception while still live arms the same bounded fuse.
  if (!state_->finished.load()) state_->request(StopReason::transport_error);
}
HANDLE HelperLifecycle::stop_event() const noexcept { return state_->stop_event.get(); }
bool HelperLifecycle::stopping() const noexcept { return state_->stopping.load(); }
bool HelperLifecycle::parent_current() const noexcept { return state_->parent_current(); }
int HelperLifecycle::exit_code() const noexcept { return state_->final_code.load(); }
void HelperLifecycle::request_stop(StopReason reason) noexcept { state_->request(reason); }
bool HelperLifecycle::attach_io_thread(HANDLE thread) noexcept {
  return state_->attach(thread);
}
bool HelperLifecycle::bind_parent(std::shared_ptr<ParentIdentity> parent) noexcept {
  if (!parent || parent->evidence().expected_parent != state_->parent_pid || parent->evidence().parent_created != state_->parent_created ||
      !state_->parent_current() || state_->stopping.load() || state_->finished.load() || state_->bound.exchange(true)) return false;
  const auto state = state_;
  try {
    std::thread([state, parent = std::move(parent)] {
      for (;;) {
        const auto result = WaitForSingleObject(state->stop_event.get(), 250);
        if (result == WAIT_OBJECT_0) return;
        if (result != WAIT_TIMEOUT || !parent->unchanged()) { state->request(StopReason::parent_changed); return; }
      }
    }).detach();
    return true;
  } catch (...) { state_->request(StopReason::transport_error); return false; }
}
void HelperLifecycle::finish(int exit_code) noexcept {
  // A completed privileged report may intentionally exit77. Publish that exact status before the
  // independent fuse starts; classifying its shutdown as transport_error must not replace it by1.
  state_->request(exit_code == 0 ? StopReason::shutdown : StopReason::transport_error, exit_code);
  state_->finished.store(true);
  SetEvent(state_->finished_event.get());
  SetEvent(state_->stop_event.get());
  state_->cancel_io();
}
}
