#pragma once
#include "core.h"
#include <array>
#include <atomic>
#include <functional>
#include <memory>

namespace vector::computer {
class HelperLifecycle;
struct CaptureBackend;
enum class WindowsInventoryDiagnostic;
enum class CaptureReadPhase;
inline constexpr std::array<std::wstring_view, 15> windows_privileged_checks{
  L"privileged-isolated-target", L"apps-running-target", L"apps-installed-target",
  L"capture-color-patch", L"capture-affinity-exclusion", L"uia-counter-increment",
  L"uia-value-set-and-readback", L"secure-field-refusal", L"tagged-click-increments",
  L"unicode-type-readback", L"stale-capture-refusal", L"owned-input-release",
  L"input-detection-probe", L"hardware-user-input-pauses", L"isolated-target-cleanup"};
inline constexpr std::array<std::wstring_view, 113> windows_privileged_stages{
  L"installed-list-reply", L"installed-list-native", L"installed-seal",
  L"window-capture-reply", L"window-capture-receipt", L"png-decode",
  L"affinity-show", L"affinity-hide", L"display-capture-reply", L"display-capture-receipt",
  L"capture-service", L"capture-native", L"authority-completion", L"authority-delivery",
  L"capture-inventory-initial", L"capture-inventory-refresh", L"capture-native-read", L"capture-commit-current",
  L"capture-structural-identity", L"capture-structural-bounds", L"capture-structural-cloak", L"capture-structural-class", L"capture-structural-style",
  L"capture-enumeration-cap", L"capture-enumeration-deadline", L"capture-enumeration-context", L"capture-enumeration-api", L"capture-structural-exception",
  L"installed-apps-folder", L"installed-apps-bind", L"installed-apps-next", L"installed-apps-com-current",
  L"installed-apps-count", L"installed-apps-shape", L"installed-apps-title", L"installed-apps-icon",
  L"capture-bounds-read", L"capture-bounds-empty", L"capture-bounds-negative", L"capture-bounds-range",
  L"capture-empty-cloaked", L"capture-empty-visible", L"capture-empty-minimized", L"capture-empty-hidden",
  L"capture-empty-unknown", L"installed-folder-start-uninitialized", L"installed-folder-start-cancellation", L"installed-folder-start-timer",
  L"installed-folder-start-expired", L"installed-folder-after-uninitialized", L"installed-folder-after-cancellation", L"installed-folder-after-timer",
  L"installed-folder-after-expired", L"installed-bind-after-uninitialized", L"installed-bind-after-cancellation", L"installed-bind-after-timer",
  L"installed-bind-after-expired", L"installed-next-start-uninitialized", L"installed-next-start-cancellation", L"installed-next-start-timer",
  L"installed-next-start-expired", L"installed-next-after-uninitialized", L"installed-next-after-cancellation", L"installed-next-after-timer",
  L"installed-next-after-expired", L"capture-empty-frame-unknown", L"capture-empty-frame-geometry",
  L"capture-read-surface-before", L"capture-read-context-before", L"capture-screen-bounds",
  L"capture-screen-dc", L"capture-screen-memory-dc", L"capture-screen-dib",
  L"capture-screen-select", L"capture-screen-blit", L"capture-screen-flush",
  L"capture-screen-copy", L"capture-window-supported", L"capture-window-frame",
  L"capture-window-device", L"capture-window-interop", L"capture-window-item-ticket",
  L"capture-window-item-create", L"capture-window-item-current", L"capture-window-item-size",
  L"capture-window-pool", L"capture-window-session", L"capture-window-start-ticket",
  L"capture-window-start", L"capture-window-start-current", L"capture-window-first-frame",
  L"capture-window-content-size", L"capture-window-texture", L"capture-window-description",
  L"capture-window-staging", L"capture-window-copy", L"capture-window-map",
  L"capture-window-crop", L"capture-window-current", L"capture-read-surface-after",
  L"capture-read-context-after", L"capture-color-location-screen", L"capture-color-location-window",
  L"capture-color-location-unknown", L"capture-color-masked-screen", L"capture-color-masked-window",
  L"capture-color-masked-unknown", L"capture-color-unmasked-screen", L"capture-color-unmasked-window",
  L"capture-color-unmasked-unknown", L"capture-color-mask-unknown-screen", L"capture-color-mask-unknown-window",
  L"capture-color-mask-unknown-unknown"};
inline constexpr std::array<std::wstring_view, 32> windows_privileged_native_codes{
  L"unavailable", L"permissions", L"busy", L"stopped", L"paused", L"locked", L"blocked", L"protected", L"denied",
  L"not_granted", L"stale_frame", L"stale_ref", L"changed", L"occluded", L"secure_field", L"elevated",
  L"secure_desktop", L"not_foreground", L"capture_unavailable", L"no_ui_tree", L"out_of_bounds", L"needs_foreground",
  L"timeout", L"app_not_found", L"unsupported_action", L"frame_too_large", L"helper_incompatible", L"unsupported_os",
  L"blocked_by_os", L"responsible_missing", L"failed", L"unknown"};
struct WindowsPrivilegedCheck {
  std::wstring name; bool ok = false, skipped = false; std::wstring detail;
  // Closed failure-only diagnostics; never native error text, application names, paths or identifiers.
  std::wstring stage, native_code;
};
struct WindowsPrivilegedReport {
  std::vector<WindowsPrivilegedCheck> checks;
  bool valid() const noexcept;
  int exit_code() const noexcept;
  winrt::Windows::Data::Json::JsonObject wire() const;
  // Preserve every observed result when a later prerequisite prevents unrun scenarios.
  void skip_unrun(std::wstring_view reason);
  static WindowsPrivilegedReport skipped(std::wstring_view reason);
};
bool windows_privileged_reason(std::wstring_view) noexcept;
bool windows_privileged_skip_reason(std::wstring_view) noexcept;
std::wstring windows_privileged_native_code(std::wstring_view);
std::wstring windows_privileged_origin_stage(std::wstring_view message, std::wstring_view fallback = {}, std::wstring_view capture_stage = {});
// Injected providers exercise the same scoped observer without querying a real window or desktop.
std::wstring windows_privileged_capture_diagnostic(CaptureBackend, const std::function<void(CaptureBackend&)>&);
void windows_privileged_inventory_failure(WindowsInventoryDiagnostic) noexcept;
void windows_privileged_capture_read_failure(CaptureReadPhase) noexcept;
bool windows_privileged_response_failure(const winrt::Windows::Data::Json::JsonObject&, std::wstring_view) noexcept;
// A monotonic admission gate over the already-held parent witness. Production supplies only bounded
// kernel metadata; tests can advance that witness without creating a process or touching a desktop.
class WindowsPrivilegedRunAuthority final {
 public:
  explicit WindowsPrivilegedRunAuthority(std::function<bool()> parent_current);
  bool admit() noexcept;
  bool current() const noexcept;
  void revoke() noexcept;
 private:
  std::function<bool()> parent_current_;
  std::atomic_bool admitted_{false};
  mutable std::atomic_bool revoked_{false};
};
// Core retains the lifetime lease through actual report emission, then finishes immediately before
// process exit. Finishing it while returning this report would race away the required JSON output.
WindowsPrivilegedReport run_windows_privileged_self_test(const Command&, std::shared_ptr<HelperLifecycle>* lifetime = nullptr) noexcept;
}
