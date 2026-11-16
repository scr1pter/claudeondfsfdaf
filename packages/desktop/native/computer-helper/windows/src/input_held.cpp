#include "input_held.h"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <limits>

namespace vector::computer {
namespace {
std::atomic<uint64_t> next_worker{1};
[[noreturn]] void changed() { throw Failure{L"changed", L"The owned input lease is no longer current."}; }
}
InputHeldJournal::InputHeldJournal(std::function<bool(const InputRelease&)> release, Clock now)
  : release_(std::move(release)), now_(now ? std::move(now) : [] {
      return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count());
    }), worker_(next_worker.fetch_add(1)) {
  if (!release_ || worker_ == 0) throw Failure{L"unavailable", L"The input release journal is unavailable."};
}
void InputHeldJournal::require(const InputHeldLease& lease) const {
  if (closed_ || releasing_ || !active_ || *active_ != lease || lease.worker != worker_ || lease.generation != generation_) changed();
}
InputHeldLease InputHeldJournal::begin() {
  std::lock_guard guard(mutex_);
  if (closed_ || releasing_ || !entries_.empty() || sequence_ == std::numeric_limits<uint64_t>::max() || generation_ == std::numeric_limits<uint64_t>::max())
    throw Failure{L"unavailable", L"Owned input cleanup must complete before new input."};
  InputHeldLease lease{worker_, ++generation_, ++sequence_}; active_ = lease; return lease;
}
InputPostResult InputHeldJournal::press(const InputHeldLease& lease, std::wstring id, InputRelease up,
                                        const std::function<InputPostResult()>& post_action) {
  std::lock_guard guard(mutex_); require(lease);
  if (id.empty() || id.size() > 256 || !valid_input_release(up) || !post_action || entries_.size() >= 136 ||
      entries_.contains(id) || entry_sequence_ == std::numeric_limits<uint64_t>::max())
    throw Failure{L"failed", L"The owned input reservation is invalid."};
  size_t keys = 0, buttons = 0;
  for (const auto& item : entries_) {
    if (item.second.up == up) throw Failure{L"failed", L"This input is already owned."};
    if (item.second.up.kind == InputReleaseKind::mouse_button) ++buttons; else ++keys;
  }
  if ((up.kind == InputReleaseKind::mouse_button && buttons >= 8) || (up.kind != InputReleaseKind::mouse_button && keys >= 128))
    throw Failure{L"unavailable", L"The owned input limit was reached."};
  auto [entry, inserted] = entries_.emplace(std::move(id), Entry{lease, up, false, ++entry_sequence_});
  (void)inserted;
  InputPostResult outcome = InputPostResult::uncertain;
  try { outcome = post_action(); } catch (...) { /* Unknown native outcome never authorizes an unobserved up. */ }
  if (outcome == InputPostResult::not_posted) entries_.erase(entry);
  else if (outcome == InputPostResult::accepted) {
    entry->second.confirmed = true;
    if (closed_ || !active_ || *active_ != lease || lease.generation != generation_) {
      releasing_ = true;
      bool released = false; try { released = release_(entry->second.up); } catch (...) {}
      if (released) entries_.erase(entry);
      releasing_ = false;
      changed();
    }
  }
  // Uncertain records block successor leases. The independent guardian alone may release an actual
  // observed tagged down; this process never turns an unconfirmed reservation into an up.
  return outcome;
}
void InputHeldJournal::post(const InputHeldLease& lease, const std::function<InputPostResult()>& post_action) {
  std::lock_guard guard(mutex_); require(lease);
  if (!post_action || post_action() != InputPostResult::accepted) throw Failure{L"failed", L"The input event was not confirmed."};
  require(lease);
}
bool InputHeldJournal::lift(const InputHeldLease& lease, const std::wstring& id) {
  std::lock_guard guard(mutex_);
  const auto found = entries_.find(id);
  if (found == entries_.end() || found->second.lease != lease || lease.worker != worker_) return true;
  if (releasing_ || !found->second.confirmed) return false;
  releasing_ = true;
  bool released = false; try { released = release_(found->second.up); } catch (...) {}
  if (released) entries_.erase(found); releasing_ = false; return released;
}
bool InputHeldJournal::observed_release(const InputHeldLease& lease, const std::wstring& id, const InputRelease& up) {
  std::lock_guard guard(mutex_);
  const auto found = entries_.find(id);
  if (found == entries_.end()) return true;
  if (lease.worker != worker_ || found->second.lease != lease || found->second.up != up) return false;
  entries_.erase(found); return true;
}
uint32_t InputHeldJournal::drain(const std::optional<InputHeldLease>& lease, uint32_t deadline_ms) noexcept {
  if (releasing_) return 0;
  releasing_ = true; uint32_t count = 0;
  try {
    const auto started = now_(); std::vector<std::pair<uint64_t, std::wstring>> order;
    for (const auto& entry : entries_) if (!lease || entry.second.lease == *lease) order.emplace_back(entry.second.sequence, entry.first);
    std::sort(order.rbegin(), order.rend());
    for (const auto& item : order) {
      const auto now = now_(); if (now < started || now - started >= std::min<uint32_t>(deadline_ms, 300)) break;
      const auto found = entries_.find(item.second); if (found == entries_.end() || !found->second.confirmed) continue;
      bool released = false; try { released = release_(found->second.up); } catch (...) {}
      if (released) { entries_.erase(found); ++count; }
    }
  } catch (...) {}
  releasing_ = false; return count;
}
uint32_t InputHeldJournal::release(const InputHeldLease& lease, uint32_t deadline_ms) noexcept {
  std::lock_guard guard(mutex_);
  if (lease.worker != worker_) return 0;
  if (active_ == lease) { active_.reset(); if (generation_ == std::numeric_limits<uint64_t>::max()) closed_ = true; else ++generation_; }
  return drain(lease, deadline_ms);
}
uint32_t InputHeldJournal::release_all(uint32_t deadline_ms) noexcept {
  std::lock_guard guard(mutex_); active_.reset(); if (generation_ == std::numeric_limits<uint64_t>::max()) closed_ = true; else ++generation_; return drain({}, deadline_ms);
}
uint32_t InputHeldJournal::close() noexcept {
  std::lock_guard guard(mutex_); closed_ = true; active_.reset(); if (generation_ != std::numeric_limits<uint64_t>::max()) ++generation_; return drain({}, 300);
}
bool InputHeldJournal::current(const InputHeldLease& lease) const {
  std::lock_guard guard(mutex_); return !closed_ && !releasing_ && active_ == lease && lease.worker == worker_ && lease.generation == generation_;
}
bool InputHeldJournal::pending(const InputHeldLease& lease) const {
  std::lock_guard guard(mutex_);
  for (const auto& item : entries_) if (item.second.lease == lease) return true;
  return false;
}
std::vector<InputRelease> InputHeldJournal::owned() const {
  std::lock_guard guard(mutex_); std::vector<InputRelease> result;
  for (const auto& item : entries_) if (item.second.confirmed) result.push_back(item.second.up); return result;
}
}
