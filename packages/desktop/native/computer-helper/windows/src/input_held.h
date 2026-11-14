#pragma once
#include "input_events.h"
#include "protocol.h"
#include <functional>
#include <map>
#include <mutex>
#include <optional>

namespace vector::computer {
struct InputHeldLease {
  uint64_t worker = 0, generation = 0, sequence = 0;
  bool operator==(const InputHeldLease&) const = default;
};
class InputHeldJournal final {
 public:
  using Clock = std::function<uint64_t()>;
  explicit InputHeldJournal(std::function<bool(const InputRelease&)> release, Clock now = {});
  InputHeldLease begin();
  InputPostResult press(const InputHeldLease&, std::wstring id, InputRelease up,
                        const std::function<InputPostResult()>& post);
  void post(const InputHeldLease&, const std::function<InputPostResult()>& post);
  bool lift(const InputHeldLease&, const std::wstring& id);
  // Only an independently observed matching tagged up may retire an uncertain/failed release.
  bool observed_release(const InputHeldLease&, const std::wstring& id, const InputRelease& up);
  uint32_t release(const InputHeldLease&, uint32_t deadline_ms = 300) noexcept;
  uint32_t release_all(uint32_t deadline_ms = 300) noexcept;
  uint32_t close() noexcept;
  bool current(const InputHeldLease&) const;
  bool pending(const InputHeldLease&) const;
  std::vector<InputRelease> owned() const;
 private:
  struct Entry { InputHeldLease lease; InputRelease up; bool confirmed = false; uint64_t sequence = 0; };
  void require(const InputHeldLease&) const;
  uint32_t drain(const std::optional<InputHeldLease>& lease, uint32_t deadline_ms) noexcept;
  mutable std::recursive_mutex mutex_;
  std::function<bool(const InputRelease&)> release_;
  Clock now_;
  uint64_t worker_, generation_ = 1, sequence_ = 0, entry_sequence_ = 0;
  bool closed_ = false, releasing_ = false;
  std::optional<InputHeldLease> active_;
  std::map<std::wstring, Entry> entries_;
};
size_t run_input_held_tests();
}
