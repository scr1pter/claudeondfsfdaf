#pragma once
#include "input_events.h"
#include <array>
#include <memory>
#include <mutex>
#include <optional>
#include <span>
#include <string>
#include <vector>

namespace vector::computer {
inline constexpr uint64_t input_guardian_held_limit_ms=10'000;
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

// Pure bounded metadata. A reservation never authorizes an up; only a matching injected tagged
// down observed after that reservation creates a cleanup obligation. Hooks perform no allocation.
class InputGuardianLedger final {
 public:
  explicit InputGuardianLedger(uint64_t tag);
  std::optional<InputGuardianTicket> reserve(const InputRelease&);
  bool observe(const InputGuardianEvent&) noexcept;
  bool observed(const InputGuardianTicket&, bool down) const noexcept;
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
  };
  mutable std::mutex mutex_;
  uint64_t tag_ = 0, sequence_ = 0, order_ = 0, released_ = 0;
  bool closed_ = false;
  std::array<Entry, 136> entries_{};
  std::array<InputGuardianTicket,136> completed_{};
  size_t completed_cursor_ = 0;
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
  static std::shared_ptr<InputGuardian> native();
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
