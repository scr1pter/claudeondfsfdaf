#include "accessibility_registry.h"
#include <bcrypt.h>
#include <algorithm>
#include <array>
#include <limits>

namespace vector::computer {
namespace {
constexpr uint64_t maximum_id = 9'007'199'254'740'991ULL;
[[noreturn]] void stale() { throw Failure{L"stale_ref", L"The native accessibility reference is no longer current."}; }
[[noreturn]] void full() { throw Failure{L"unavailable", L"The accessibility reference limit was reached."}; }
bool safe(std::wstring_view value, size_t maximum, bool empty = false) {
  return (empty || !value.empty()) && value.size() <= maximum && sanitize_uia(value, maximum) == value;
}
bool path(std::wstring_view value) {
  if (!safe(value, 4096) || value.size() < 4 || value[1] != L':' || value[2] != L'\\' ||
      !((value[0] >= L'A' && value[0] <= L'Z') || (value[0] >= L'a' && value[0] <= L'z')) || value.back() == L'\\') return false;
  size_t start = 3;
  for (size_t index = 3; index <= value.size(); ++index) {
    if (index < value.size() && value[index] != L'\\') { if (value[index] == L'/' || value[index] == L':') return false; continue; }
    const auto part = value.substr(start, index - start);
    if (part.empty() || part == L"." || part == L".." || part.back() == L' ' || part.back() == L'.') return false;
    start = index + 1;
  }
  return true;
}
bool valid_session(const ServerSession& session) {
  return session.run_epoch != 0 && session.observation_epoch != 0 && !session.id.empty() && session.id.size() <= 256 &&
      session.id.find(L'\0') == std::wstring::npos && (!session.revision || *session.revision <= maximum_id);
}
bool valid_window(const WindowsWindow& window) {
  return window.hwnd && window.surface && window.thread_id && window.surface_thread_id && window.bounds.valid() && window.surface_bounds.valid() &&
      window.owner.process.pid && window.owner.process.creation_time && window.physical_owner.process.pid && window.physical_owner.process.creation_time &&
      window.owner.process.image.size > 0 && window.physical_owner.process.image.size > 0 && path(window.owner.process.image.path) && path(window.physical_owner.process.image.path) &&
      window.owner.identity.pid == window.owner.process.pid && window.physical_owner.identity.pid == window.physical_owner.process.pid &&
      window.owner.identity.exe == window.owner.process.image.path && window.physical_owner.identity.exe == window.physical_owner.process.image.path;
}
bool complete_for(const AccessibilityFacts& facts, const WindowsWindow& window) {
  return facts.complete() && facts.security.pid == window.owner.process.pid && same_windows_identity(facts.owner, window.owner.identity);
}
bool element(const UiaElement& value) { return value && value->identity != 0; }
bool same_element(const UiaElement& left, const UiaElement& right) { return element(left) && element(right) && left->identity == right->identity; }
bool same_stable_scope(const WindowsWindow& left, const WindowsWindow& right) {
  return same_windows_window_target(left, right);
}
std::wstring random_worker() {
  std::array<uint8_t, 16> bytes{};
  if (BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) full();
  constexpr wchar_t digits[] = L"0123456789abcdef"; std::wstring result; result.reserve(32);
  for (const auto byte : bytes) { result += digits[byte >> 4]; result += digits[byte & 15]; }
  return result;
}
}

bool AccessibilityFacts::complete() const noexcept {
  try {
    if (!name.complete || !menu_complete || !safe(security.role, 64) || !safe(name.text, 500, true) || security.pid == 0 || security.control_type <= 0 ||
        !security.bounds || !security.bounds->valid() || owner.pid != security.pid ||
        (security.value_pattern && !security.read_only) || (!security.value_pattern && security.read_only) ||
        (security.text_pattern && !security.text_read_only) || (!security.text_pattern && security.text_read_only)) return false;
    if (document_status != L"unknown" && document_status != L"known" && document_status != L"none") return false;
    if (document_status == L"known" ? !document || !path(*document) : document.has_value()) return false;
    if (menu_path) {
      if (menu_path->size() > 30) return false;
      for (const auto& component : *menu_path) if (!safe(component, 256)) return false;
    }
    if (menu_shortcut) {
      if (menu_shortcut->empty() || menu_shortcut->size() > 8) return false;
      for (const auto& key : *menu_shortcut) if (!safe(key, 32)) return false;
    }
    return true;
  } catch (...) { return false; }
}
bool same_accessibility_facts(const AccessibilityFacts& left, const AccessibilityFacts& right) noexcept {
  return left.security.pid == right.security.pid && left.security.control_type == right.security.control_type && left.security.role == right.security.role &&
      left.security.bounds == right.security.bounds && left.security.password == right.security.password && left.security.enabled == right.security.enabled &&
      left.security.keyboard_focusable == right.security.keyboard_focusable && left.security.value_pattern == right.security.value_pattern && left.security.read_only == right.security.read_only &&
      left.security.text_pattern == right.security.text_pattern && left.security.text_read_only == right.security.text_read_only &&
      left.name.text == right.name.text && left.name.complete == right.name.complete && same_windows_identity(left.owner, right.owner) &&
      left.document_status == right.document_status && left.document == right.document && left.menu_path == right.menu_path && left.menu_shortcut == right.menu_shortcut && left.menu_complete == right.menu_complete;
}

AccessibilityRegistry::AccessibilityRegistry(size_t limit, size_t stable_limit, size_t retired_limit, Random random)
    : limit_(std::clamp<size_t>(limit, 1, 4096)), stable_limit_(std::clamp<size_t>(stable_limit, limit_, 8192)),
      retired_limit_(std::clamp<size_t>(retired_limit, 2, 32768)), worker_(random ? random() : random_worker()) {
  if (worker_.size() != 32 || !std::all_of(worker_.begin(), worker_.end(), [](wchar_t value) { return (value >= L'0' && value <= L'9') || (value >= L'a' && value <= L'f'); })) full();
  retired_.reserve(retired_limit_); stable_order_.reserve(stable_limit_); receipt_order_.reserve(limit_);
}
bool AccessibilityRegistry::same_run(const ServerSession& session) const noexcept {
  return run_epoch_ && *run_epoch_ == session.run_epoch && run_session_ == session.id;
}
bool AccessibilityRegistry::matches(const ServerSession& session) const noexcept {
  return !closed_ && snapshot_ && same_run(session) && snapshot_->observation_epoch == session.observation_epoch && snapshot_->revision == session.revision;
}
bool AccessibilityRegistry::valid_snapshot(const AccessibilitySnapshot& requested) const noexcept {
  return !closed_ && snapshot_ && requested.worker == worker_ && requested.token == snapshot_->token && requested.generation == snapshot_->generation &&
      requested.run_epoch == snapshot_->run_epoch && requested.observation_epoch == snapshot_->observation_epoch && requested.session_id == snapshot_->session_id && requested.revision == snapshot_->revision;
}
void AccessibilityRegistry::capacity(size_t additional) const {
  const auto count = references_.size() + receipts_.size() + stable_.size() + retired_.size();
  if (count > retired_limit_ || additional > retired_limit_ - count) full();
}
std::wstring AccessibilityRegistry::next(std::wstring_view prefix) {
  if (sequence_ >= maximum_id) full();
  return std::wstring(prefix) + L"_" + worker_ + L"_" + std::to_wstring(++sequence_);
}
void AccessibilityRegistry::retire_refs() {
  for (auto& [key, value] : references_) { static_cast<void>(key); retired_.push_back(std::move(value)); }
  references_.clear(); latest_.clear();
}
void AccessibilityRegistry::drop_receipt(const std::wstring& ref) {
  const auto found = receipts_.find(ref); if (found == receipts_.end()) return;
  retired_.push_back(std::move(found->second)); receipts_.erase(found);
}
void AccessibilityRegistry::retire_all(bool keep_run) {
  retire_refs();
  for (auto& [key, value] : receipts_) { static_cast<void>(key); retired_.push_back(std::move(value)); }
  receipts_.clear(); receipt_order_.clear();
  for (auto& [key, value] : stable_) { static_cast<void>(key); retired_.push_back(std::move(value)); }
  stable_.clear(); stable_order_.clear(); snapshot_.reset();
  if (!keep_run) { run_epoch_.reset(); run_session_.clear(); }
}
void AccessibilityRegistry::demote() {
  for (auto& [ref, record] : references_) {
    if (record->facts && record->facts->complete() && stable_.contains(record->element_id)) {
      if (receipts_.contains(ref)) drop_receipt(ref);
      receipts_[ref] = std::move(record); receipt_order_.push_back(ref);
    } else retired_.push_back(std::move(record));
  }
  references_.clear(); latest_.clear(); snapshot_.reset();
  while (receipts_.size() > limit_) { drop_receipt(receipt_order_.front()); receipt_order_.erase(receipt_order_.begin()); }
}
AccessibilitySnapshot AccessibilityRegistry::begin(const ServerSession& session, bool tree) {
  if (closed_ || !valid_session(session) || generation_ >= maximum_id || snapshot_token_ == std::numeric_limits<uint64_t>::max()) stale();
  if (!same_run(session)) { retire_all(); run_epoch_ = session.run_epoch; run_session_ = session.id; }
  if (tree) {
    retire_refs();
    for (auto& [key, value] : receipts_) { static_cast<void>(key); retired_.push_back(std::move(value)); }
    receipts_.clear(); receipt_order_.clear();
  } else if (snapshot_ && !matches(session)) demote();
  AccessibilitySnapshot snapshot;
  snapshot.generation = ++generation_; snapshot.run_epoch = session.run_epoch; snapshot.observation_epoch = session.observation_epoch;
  snapshot.session_id = session.id; snapshot.revision = session.revision; snapshot.worker = worker_; snapshot.token = ++snapshot_token_;
  snapshot_ = snapshot; return snapshot;
}
AccessibilitySnapshot AccessibilityRegistry::begin_snapshot(const ServerSession& session) {
  std::lock_guard lock(mutex_); return begin(session, true);
}
AccessibilitySnapshot AccessibilityRegistry::current_snapshot(const ServerSession& session) {
  std::lock_guard lock(mutex_); if (matches(session)) return *snapshot_; return begin(session, false);
}
AccessibilityReference AccessibilityRegistry::register_element(UiaElement value, UiaElement root, const WindowsWindow& window,
    std::optional<AccessibilityFacts> facts, const AccessibilitySnapshot& snapshot) {
  std::lock_guard lock(mutex_);
  if (!valid_snapshot(snapshot) || !element(value) || !element(root) || !valid_window(window)) stale();
  std::wstring id;
  for (const auto& [key, candidate] : stable_) if (same_element(candidate->element, value) && same_element(candidate->root, root) && same_stable_scope(candidate->window, window)) { id = key; break; }
  if (!id.empty()) {
    const auto existing = latest_.find(id);
    if (existing != latest_.end()) {
      const auto record = references_.find(existing->second);
      if (record != references_.end() && same_windows_window(record->second->window, window)) return *record->second;
    }
  }
  if (references_.size() + receipts_.size() >= limit_) full();
  capacity(id.empty() ? 2 : 1);
  if (id.empty()) {
    while (stable_.size() >= stable_limit_) {
      const auto retired = std::find_if(stable_order_.begin(), stable_order_.end(), [&](const auto& candidate) { return !latest_.contains(candidate); });
      if (retired == stable_order_.end()) full();
      const auto key = *retired;
      std::vector<std::wstring> discarded;
      for (const auto& [ref, record] : receipts_) if (record->element_id == key) discarded.push_back(ref);
      for (const auto& ref : discarded) drop_receipt(ref);
      std::erase_if(receipt_order_, [&](const auto& ref) { return !receipts_.contains(ref); });
      retired_.push_back(std::move(stable_.at(key))); stable_.erase(key); stable_order_.erase(retired);
    }
    id = next(L"uie"); auto stable = std::make_shared<Stable>(); stable->id = id; stable->element = value; stable->root = root; stable->window = window;
    stable_[id] = std::move(stable); stable_order_.push_back(id);
  }
  auto record = std::make_shared<AccessibilityReference>(); record->ref = next(L"uir"); record->element_id = id; record->generation = snapshot.generation;
  record->element = std::move(value); record->root = std::move(root); record->window = window; record->run_epoch = snapshot.run_epoch; record->session_id = snapshot.session_id;
  if (facts && complete_for(*facts, window)) record->facts = std::move(facts);
  references_[record->ref] = record; latest_[id] = record->ref; return *record;
}
AccessibilityReference AccessibilityRegistry::resolve(const std::wstring& ref, const ServerSession& session) const {
  std::lock_guard lock(mutex_);
  const auto record = references_.find(ref);
  if (!matches(session) || record == references_.end() || record->second->generation != snapshot_->generation) stale();
  return *record->second;
}
AccessibilityReference AccessibilityRegistry::resolve_element(const std::wstring& id, const ServerSession& session) const {
  std::lock_guard lock(mutex_); if (!matches(session) || !stable_.contains(id)) stale();
  const auto ref = latest_.find(id); if (ref == latest_.end()) stale();
  const auto record = references_.find(ref->second); if (record == references_.end() || record->second->element_id != id || record->second->generation != snapshot_->generation) stale();
  return *record->second;
}
AccessibilityReference AccessibilityRegistry::receipt(const std::wstring& ref, const ServerSession& session) {
  std::lock_guard lock(mutex_); if (closed_ || !valid_session(session) || !same_run(session)) stale();
  if (snapshot_ && !matches(session)) demote();
  const auto found = receipts_.find(ref);
  if (found == receipts_.end() || found->second->run_epoch != session.run_epoch || found->second->session_id != session.id ||
      !found->second->facts || !found->second->facts->complete() || !stable_.contains(found->second->element_id)) stale();
  return *found->second;
}
AccessibilityReference AccessibilityRegistry::record_facts(const std::wstring& ref, const AccessibilityFacts& facts, const ServerSession& session) {
  std::lock_guard lock(mutex_); const auto found = references_.find(ref);
  if (!matches(session) || found == references_.end()) stale(); capacity(1);
  auto record = std::make_shared<AccessibilityReference>(*found->second); record->facts.reset();
  if (complete_for(facts, record->window)) record->facts = facts;
  retired_.push_back(std::move(found->second)); found->second = record; return *record;
}
AccessibilityReference AccessibilityRegistry::refresh_receipt(const AccessibilityReference& receipt, UiaElement live_element, UiaElement live_root,
    const WindowsWindow& live_window, const AccessibilityFacts& facts, const ServerSession& session) {
  std::lock_guard lock(mutex_); const auto found = receipts_.find(receipt.ref);
  if (closed_ || !valid_session(session) || !same_run(session) || found == receipts_.end()) stale();
  const auto& stored = *found->second;
  if (stored.ref != receipt.ref || stored.element_id != receipt.element_id || stored.run_epoch != session.run_epoch || stored.session_id != session.id ||
      !stable_.contains(stored.element_id) || !same_element(stored.element, receipt.element) || !same_element(stored.element, live_element) ||
      !same_element(stored.root, receipt.root) || !same_element(stored.root, live_root) || !valid_window(live_window) || !same_windows_window(stored.window, live_window) ||
      !stored.facts || !complete_for(facts, live_window) || !same_accessibility_facts(*stored.facts, facts) || references_.size() + receipts_.size() > limit_) stale();
  capacity(1); const auto snapshot = matches(session) ? *snapshot_ : begin(session, false);
  auto record = std::make_shared<AccessibilityReference>(stored); record->generation = snapshot.generation; record->facts = facts; record->window = live_window;
  // Keep the original native handle and opaque IDs. A receipt never redirects to a fresh object.
  const auto ref = stored.ref; const auto id = stored.element_id;
  drop_receipt(ref); std::erase(receipt_order_, ref); references_[ref] = record; latest_[id] = ref; return *record;
}
void AccessibilityRegistry::note_session(const std::optional<ServerSession>& session) {
  std::lock_guard lock(mutex_);
  if (closed_) return;
  if (!session || !valid_session(*session)) { retire_all(); return; }
  if (!same_run(*session)) { retire_all(); run_epoch_ = session->run_epoch; run_session_ = session->id; }
}
void AccessibilityRegistry::suspend() { std::lock_guard lock(mutex_); if (!closed_) demote(); }
void AccessibilityRegistry::clear() { std::lock_guard lock(mutex_); retire_all(); }
void AccessibilityRegistry::close() { std::lock_guard lock(mutex_); closed_ = true; retire_all(); }
AccessibilityRegistry::Retired AccessibilityRegistry::drain_retired() {
  // Allocate the successor buffer outside authority/registry locking. clear/suspend need only noexcept
  // shared-pointer moves into preallocated storage, including when a full registry is hard-retired.
  Retired result; result.reserve(retired_limit_);
  std::lock_guard lock(mutex_); result.swap(retired_); return result;
}
}
