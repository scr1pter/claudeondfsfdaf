#pragma once
#include "uia_native.h"
#include <functional>
#include <map>
#include <mutex>
#include <optional>
#include <set>
#include <vector>

namespace vector::computer {
struct AccessibilityFacts {
  UiaSecurity security;
  UiaName name;
  WindowsAppIdentity owner;
  std::wstring document_status = L"unknown";
  std::optional<std::wstring> document;
  std::optional<std::vector<std::wstring>> menu_path;
  std::optional<std::vector<std::wstring>> menu_shortcut;
  bool menu_complete = true;
  bool complete() const noexcept;
};
bool same_accessibility_facts(const AccessibilityFacts&, const AccessibilityFacts&) noexcept;

struct AccessibilitySnapshot {
  uint64_t generation = 0, run_epoch = 0, observation_epoch = 0;
  std::wstring session_id;
  std::optional<uint64_t> revision;
 private:
  std::wstring worker;
  uint64_t token = 0;
  friend class AccessibilityRegistry;
};
struct AccessibilityReference {
  std::wstring ref, element_id;
  uint64_t generation = 0;
  UiaElement element, root;
  WindowsWindow window;
  uint64_t run_epoch = 0;
  std::wstring session_id;
  std::optional<AccessibilityFacts> facts;
};

/// Metadata only. Native equality/membership/policy and complete live facts must be obtained before
/// entering this registry. An opaque NativeUia identity is issued only after actual RuntimeId plus
/// CompareElements equality. No label, provider identifier, hash, or model witness establishes identity.
class AccessibilityRegistry final {
 public:
  using Random = std::function<std::wstring()>;
  using Retired = std::vector<std::shared_ptr<void>>;
  explicit AccessibilityRegistry(size_t limit = 4096, size_t stable_limit = 8192,
                                 size_t retired_limit = 32768, Random random = {});
  AccessibilitySnapshot begin_snapshot(const ServerSession&);
  AccessibilitySnapshot current_snapshot(const ServerSession&);
  AccessibilityReference register_element(UiaElement element, UiaElement root, const WindowsWindow&,
      std::optional<AccessibilityFacts> facts, const AccessibilitySnapshot&);
  AccessibilityReference resolve(const std::wstring& ref, const ServerSession&) const;
  AccessibilityReference resolve_element(const std::wstring& element_id, const ServerSession&) const;
  AccessibilityReference receipt(const std::wstring& ref, const ServerSession&);
  AccessibilityReference record_facts(const std::wstring& ref, const AccessibilityFacts&, const ServerSession&);
  AccessibilityReference refresh_receipt(const AccessibilityReference&, UiaElement live_element, UiaElement live_root,
      const WindowsWindow& live_window, const AccessibilityFacts& live_facts, const ServerSession&);
  void note_session(const std::optional<ServerSession>&);
  void suspend();
  void clear();
  void close();
  // Call outside Dispatcher authority. Destruction of retired COM/kernel leases happens in the caller.
  Retired drain_retired();
 private:
  struct Stable {
    std::wstring id;
    UiaElement element, root;
    WindowsWindow window;
  };
  mutable std::mutex mutex_;
  size_t limit_, stable_limit_, retired_limit_;
  std::wstring worker_;
  uint64_t generation_ = 0, sequence_ = 0, snapshot_token_ = 0;
  bool closed_ = false;
  std::optional<uint64_t> run_epoch_;
  std::wstring run_session_;
  std::optional<AccessibilitySnapshot> snapshot_;
  std::map<std::wstring, std::shared_ptr<AccessibilityReference>> references_, receipts_;
  std::map<std::wstring, std::shared_ptr<Stable>> stable_;
  std::map<std::wstring, std::wstring> latest_;
  std::vector<std::wstring> stable_order_, receipt_order_;
  Retired retired_;
  AccessibilitySnapshot begin(const ServerSession&, bool tree);
  bool same_run(const ServerSession&) const noexcept;
  bool matches(const ServerSession&) const noexcept;
  bool valid_snapshot(const AccessibilitySnapshot&) const noexcept;
  void capacity(size_t additional) const;
  std::wstring next(std::wstring_view prefix);
  void demote();
  void retire_all(bool keep_run = false);
  void retire_refs();
  void drop_receipt(const std::wstring& ref);
};
size_t run_accessibility_registry_tests();
}
