#pragma once
#include "input_events.h"
#include <array>
#include <atomic>
#include <condition_variable>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <span>
#include <string>
#include <vector>

namespace vector::computer {
inline constexpr uint64_t input_guardian_held_limit_ms=10'000;
// Smoke-only observation of existing receipt refusal paths. No ticket, event, tag or native value.
enum class InputGuardianPhase : uint8_t { none, request_invalid, lock_expired, budget_expired, inactive, write_refused, read_refused, reply_invalid, setup_failed, reply_negative, confirmed, reply_negative_zero_budget, reply_negative_short_budget, reply_negative_full_budget,
  reply_negative_no_callback_pump_stalled, reply_negative_no_callback_pump_progressed, reply_negative_own_move_only, reply_negative_own_down_refused, reply_negative_own_up_only, reply_negative_own_tag_unflagged, reply_negative_low32_tag_candidate,
  reply_negative_up_not_released, reply_negative_up_release_blocked, reply_negative_up_release_blocked_callbacks, reply_negative_up_release_refused,
  reply_negative_up_release_slow, reply_negative_up_release_slow_callbacks, reply_negative_up_pump_stalled, reply_negative_up_callbacks_without_up,
  reply_negative_up_no_callback };
struct InputGuardianDiagnostic { std::atomic<InputGuardianPhase> phase{InputGuardianPhase::none}; };
static_assert(std::atomic<InputGuardianPhase>::is_always_lock_free);
struct InputGuardianTicket {
  uint64_t id = 0;
  InputRelease release;
  bool operator==(const InputGuardianTicket&) const = default;
};
struct InputGuardianEvent {
  InputRelease release;
  uint64_t tag = 0;
  bool injected = false;
  bool down = false;
  uint64_t observed_at_ms = 0;
};
// Private smoke metadata only. "No callback" means no matching own-tag injected callback
// (or own mouse MOVE) recorded for this reservation, never absence of global/hardware input.
// A low32 candidate is weak correlation only; it never identifies an owned event or creates a receipt.
// Codes 2-8 answer only a negative DOWN query and codes 9-17 only a negative UP query.
enum class InputGuardianReceiptDiagnostic : uint8_t {
  none, opt_in, no_callback_pump_stalled, no_callback_pump_progressed, own_move_only, own_down_refused, own_up_only, own_tag_unflagged, low32_tag_candidate,
  up_not_released, up_release_blocked, up_release_blocked_callbacks, up_release_refused, up_release_slow, up_release_slow_callbacks,
  up_pump_stalled, up_callbacks_without_up, up_no_callback,
};
struct InputGuardianReceiptEvidence {
  bool enabled = false, own_move = false, own_down_refused = false, own_up = false, own_tag_unflagged = false, low32_tag_candidate = false;
};
InputGuardianReceiptDiagnostic input_guardian_receipt_diagnostic(const InputGuardianReceiptEvidence&, uint64_t pump_before, uint64_t pump_after) noexcept;
// UP-only smoke metadata for an opted-in reservation, recorded from the latest release attempt on.
// DOWN-era callback flags never enter it. Times are monotonic milliseconds; callbacks count every
// low-level hook call of the release's kind (mouse or keyboard), whatever its message or tag.
struct InputGuardianReleaseEvidence {
  bool started = false, returned = false, accepted = false;
  uint64_t started_ms = 0, returned_ms = 0, callbacks_at_start = 0, callbacks_at_return = 0;
};
// A SendInput that outlasts one default 15.6 ms scheduler tick is slow. A hook thread that has not
// finished a pump iteration for the whole 40 ms observe budget has stalled; its normal gap is at most
// about two ticks, one in the release wait and one in its message wait.
inline constexpr uint64_t input_guardian_release_slow_ms = 16, input_guardian_pump_stall_ms = 40;
InputGuardianReceiptDiagnostic input_guardian_release_diagnostic(const InputGuardianReleaseEvidence&, uint64_t callbacks, uint64_t pump_stale_ms) noexcept;

struct InputIoDeadlineSnapshot {
  uint64_t generation = 0, deadline = 0;
  bool operator==(const InputIoDeadlineSnapshot&) const = default;
};
// Each armed synchronous I/O phase owns a generation, including an unbounded read with deadline zero.
// Eligibility and the actual cancellation are serialized with arm/retire. The callback must not
// re-enter this fence; it cancels only the watcher's already-held native thread handle.
class InputIoDeadlineFence final {
 public:
  std::optional<InputIoDeadlineSnapshot> arm(uint64_t deadline) noexcept;
  std::optional<InputIoDeadlineSnapshot> snapshot() const noexcept;
  bool retire(const InputIoDeadlineSnapshot&) noexcept;
  template<class Cancel> bool cancel_if_due(const InputIoDeadlineSnapshot& observed, uint64_t now, bool cancelled, Cancel cancel) {
    std::lock_guard lock(mutex_);
    if (!active_ || *active_ != observed || (!cancelled && (!observed.deadline || now < observed.deadline))) return false;
    cancel(); return true;
  }
 private:
  mutable std::mutex mutex_;
  uint64_t generation_ = 0;
  std::optional<InputIoDeadlineSnapshot> active_;
};

// Pure bounded metadata. A reservation never authorizes an up; only a matching injected tagged
// down observed after that reservation creates a cleanup obligation. Hooks perform no allocation.
class InputGuardianLedger final {
 public:
  explicit InputGuardianLedger(uint64_t tag);
  std::optional<InputGuardianTicket> reserve(const InputRelease&, bool diagnostic = false);
  bool observe(const InputGuardianEvent&) noexcept;
  bool observed(const InputGuardianTicket&, bool down, InputGuardianReceiptDiagnostic* diagnostic = nullptr, uint64_t pump_before = 0, uint64_t pump_after = 0) const noexcept;
  bool diagnostics_enabled() const noexcept;
  void observe_move(uint64_t tag, bool injected) noexcept;
  // Opted-in, pending entries only. Neither call changes a receipt, an order or a release obligation.
  void release_started(const InputGuardianTicket&, uint64_t now_ms, uint64_t callbacks) noexcept;
  void release_returned(const InputGuardianTicket&, bool accepted, uint64_t now_ms, uint64_t callbacks) noexcept;
  // none unless the exact opted-in ticket is still waiting for its UP.
  InputGuardianReceiptDiagnostic release_diagnostic(const InputGuardianTicket&, uint64_t callbacks, uint64_t pump_stale_ms) const noexcept;
  // Unobserved/held retirement quarantines that descriptor; it cannot be reused by a successor.
  // A late matching own down remains release-only. An observed own up frees a retired slot.
  // Trusted no-call/one-event SendInput0 proof may free only an unobserved reservation, never emit an up.
  void retire(const InputGuardianTicket&, bool definitely_not_posted = false) noexcept;
  std::vector<InputGuardianTicket> releases(bool retired_only = false, std::optional<uint64_t> now_ms = {}) const;
  uint64_t released_count() const noexcept;
  bool pending() const noexcept;
  void close() noexcept;
 private:
  struct Entry {
    InputGuardianTicket ticket;
    uint64_t down_order = 0;
    uint64_t down_at_ms = 0;
    bool down = false, up = false, retired = false;
    InputGuardianReceiptEvidence diagnostic;
    InputGuardianReleaseEvidence release;
  };
  mutable std::mutex mutex_;
  uint64_t tag_ = 0, sequence_ = 0, order_ = 0, released_ = 0;
  bool closed_ = false;
  std::array<Entry, 136> entries_{};
  std::array<InputGuardianTicket,136> completed_{};
  size_t completed_cursor_ = 0;
  std::atomic<uint32_t> diagnostic_entries_{0};
  void erase(Entry&) noexcept;
  bool is_low32_tag_candidate(uint64_t observed_tag, bool injected) const noexcept;
};

// Serializes the guardian child's UP releases. A release runs with neither the ledger lock nor the
// wake lock held, so a hook callback on another thread can always record the UP it causes.
class InputGuardianReleaser final {
 public:
  using Release = std::function<bool(const InputRelease&)>;
  using Callbacks = std::function<uint64_t(InputReleaseKind)>;
  InputGuardianReleaser(InputGuardianLedger&, Release, Callbacks = {});
  // Bounded to 300 ms. Returns 0 at once while another drain holds the release lock. At most one
  // accepted UP per ticket is in flight, and only an observed DOWN is ever released.
  uint32_t drain(uint32_t milliseconds, bool retired_only = false);
  // Lock-free for hook callbacks. A wake that races a waiter's check costs at most its timeout.
  void notify() noexcept;
  uint64_t generation() const noexcept;
  void wait(uint64_t seen, uint32_t milliseconds);
 private:
  InputGuardianLedger& ledger_;
  Release release_;
  Callbacks callbacks_;
  std::mutex drain_mutex_, changed_mutex_;
  std::condition_variable changed_;
  std::atomic<uint64_t> generation_{0};
  std::array<uint64_t, 136> in_flight_{};
};

class InputGuardian {
 public:
  virtual ~InputGuardian() = default;
  virtual uint64_t tag() const noexcept = 0;
  // Held-process metadata only. Never starts a child, takes the control-I/O lock, or performs RPC.
  virtual bool alive() const noexcept = 0;
  // A held process HANDLE actually signaled; generic IPC failure/unknown liveness is insufficient.
  virtual bool exited() const noexcept { return false; }
  virtual bool ready() = 0;
  virtual std::optional<InputGuardianTicket> reserve(const InputRelease&) = 0;
  virtual bool observed(const InputGuardianTicket&, bool down, uint32_t timeout_ms = 50) = 0;
  virtual void retire(const InputGuardianTicket&, bool definitely_not_posted = false) noexcept = 0;
  virtual uint32_t drain(uint32_t budget_ms = 300) noexcept = 0;
  virtual void close() noexcept = 0;
  static std::shared_ptr<InputGuardian> native(std::shared_ptr<InputGuardianDiagnostic> diagnostic = {});
};

struct InputGuardianCommand {
  DWORD parent = 0;
  std::wstring nonce;
  uint64_t tag = 0;
  uintptr_t shutdown_event = 0;
  bool operator==(const InputGuardianCommand&) const = default;
};
// Exact internal same-image mode only. No executable path, target PID, arbitrary flags or commands.
std::optional<InputGuardianCommand> parse_input_guardian(std::span<const std::wstring> args);
int run_input_guardian(const InputGuardianCommand&, HANDLE input, HANDLE output) noexcept;
int run_input_guardian(std::span<const std::wstring> args, HANDLE input, HANDLE output) noexcept;
bool input_guardian_protocol_self_test();
size_t run_input_guardian_tests();
}
