#pragma once
#include "windows_enum.h"
#include <span>
#include <string_view>

namespace vector::computer {
struct WindowsPolicySignals {
  std::wstring window_class;
  std::optional<bool> child_shell = false;
};

class WindowsBlocklist final {
 public:
  struct Entry {
    std::wstring key, category, list;
    std::vector<std::wstring> aumids, binaries, window_classes;
  };
  static WindowsBlocklist generated();
  explicit WindowsBlocklist(std::string_view json);
  static bool matches(std::wstring_view pattern, std::wstring_view value) noexcept;
  std::wstring category(const WindowsAppIdentity&, const WindowsPolicySignals& = {}) const;
  std::optional<std::wstring> refusal(const WindowsAppIdentity&, const WindowsPolicySignals& = {}) const;
  bool click_only(const WindowsAppIdentity&, const WindowsPolicySignals& = {}) const;
  const std::vector<Entry>& entries() const noexcept;
 private:
  std::vector<Entry> entries_;
};

// These functions inspect only actual identity fields or an already canonical native artifact path.
// They never resolve an app/handler, approve an identity, read artifact contents, or launch a process.
std::optional<std::wstring> windows_identity_refusal(const WindowsAppIdentity&);
bool windows_protected_path(const std::wstring& canonical_path);
bool windows_keys_type_text(std::span<const std::wstring> keys) noexcept;
bool windows_approved_identity(const WindowsAppIdentity&, const ServerSession&) noexcept;

enum class WindowsSurfaceRole { application, furniture, notification, protected_surface };
WindowsSurfaceRole windows_surface_role(const WindowsWindow&);

enum class WindowsPolicyOperation { observe, capture, activate, pointer, key, type_text, set_value };

class WindowsSessionPolicy final {
 public:
  explicit WindowsSessionPolicy(ServerSession session, DWORD helper_pid = GetCurrentProcessId());
  void require(const WindowsWindow&, WindowsPolicyOperation, std::optional<bool> secure_field = {},
               std::span<const std::wstring> keys = {}) const;
  void require_launch(const WindowsAppIdentity&) const;
  bool disclose(const WindowsWindow&) const noexcept;
  bool include_in_display(const WindowsWindow&) const noexcept;
 private:
  ServerSession session_;
  DWORD helper_pid_;
  const WindowsBlocklist* blocklist_;
};

// Native window/process/tree observation belongs to WindowsBackend, before these pure callbacks run.
WindowPolicy windows_window_policy();
size_t run_windows_policy_tests();
}
