#pragma once
#include "core.h"
#include "server.h"
#include "user_input.h"
#include <array>
#include <atomic>
#include <functional>
#include <memory>
#include <optional>

namespace vector::computer {
class HelperLifecycle;
struct CaptureBackend;
struct CaptureBitmap;
struct CaptureReceipt;
struct WindowsRect;
enum class WindowsInventoryDiagnostic;
enum class CaptureReadPhase;
inline constexpr std::array<std::wstring_view, 17> windows_privileged_checks{
  L"privileged-isolated-target", L"apps-running-target", L"apps-installed-target",
  L"capture-color-patch", L"capture-affinity-exclusion", L"uia-counter-increment",
  L"uia-value-set-and-readback", L"secure-field-refusal", L"tagged-click-increments",
  L"unicode-type-readback", L"stale-capture-refusal", L"owned-input-release",
  L"input-detection-probe", L"hardware-user-input-pauses", L"isolated-target-cleanup",
  L"capture-isolated-window-worker", L"input-listener-health"};
inline constexpr std::array<std::wstring_view, 262> windows_privileged_stages{
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
  L"capture-window-device", L"capture-window-interop", L"capture-window-factory-ticket",
  L"capture-window-factory", L"capture-window-factory-current", L"capture-window-factory-context",
  L"capture-window-factory-retired", L"capture-window-item-ticket",
  L"capture-window-item-create", L"capture-window-item-expired-cancelled",
    L"capture-window-item-full-cancelled-setup-lt25-rpc-lt25", L"capture-window-item-full-cancelled-setup-lt25-rpc-from25to49",
    L"capture-window-item-full-cancelled-setup-lt25-rpc-ge50", L"capture-window-item-full-cancelled-setup-ge25-rpc-lt25",
    L"capture-window-item-full-cancelled-setup-ge25-rpc-from25to49", L"capture-window-item-full-cancelled-setup-ge25-rpc-ge50",
    L"capture-window-item-expired-denied", L"capture-window-item-expired-other",
  L"capture-window-item-current-cancelled", L"capture-window-item-current-denied", L"capture-window-item-current-other", L"capture-window-item-current",
  L"capture-window-item-acquisition-expired", L"capture-window-item-full-ticket-expired",
    L"capture-window-item-full-expired-setup-lt25-rpc-lt25", L"capture-window-item-full-expired-setup-lt25-rpc-from25to49",
    L"capture-window-item-full-expired-setup-lt25-rpc-ge50", L"capture-window-item-full-expired-setup-ge25-rpc-lt25",
    L"capture-window-item-full-expired-setup-ge25-rpc-from25to49", L"capture-window-item-full-expired-setup-ge25-rpc-ge50",
    L"capture-window-item-truncated-ticket-expired",
  L"capture-window-item-context", L"capture-window-item-retired", L"capture-window-item-size",
  L"capture-window-pool", L"capture-window-session", L"capture-window-start-ticket",
  L"capture-window-start", L"capture-window-start-current", L"capture-window-first-frame",
  L"capture-window-content-size", L"capture-window-texture", L"capture-window-description",
  L"capture-window-staging", L"capture-window-copy", L"capture-window-map",
  L"capture-window-crop", L"capture-window-current", L"capture-read-surface-after",
  L"capture-read-context-after", L"capture-window-worker-prepare", L"capture-window-worker-start",
  L"capture-window-worker-wait", L"capture-window-worker-exit", L"capture-window-worker-reply",
  L"capture-window-worker-cleanup", L"capture-window-worker-deadline", L"capture-window-worker-auth",
  L"capture-window-worker-target", L"capture-window-worker-read",
  L"capture-color-location-screen", L"capture-color-location-window",
  L"capture-color-location-unknown", L"capture-color-masked-screen", L"capture-color-masked-window",
  L"capture-color-masked-unknown", L"capture-color-unmasked-screen", L"capture-color-unmasked-window",
  L"capture-color-unmasked-unknown", L"capture-color-mask-unknown-screen", L"capture-color-mask-unknown-window",
  L"capture-color-mask-unknown-unknown",
  L"affinity-sample-plan", L"affinity-fixture-current", L"affinity-native-sample-missing", L"affinity-native-sample-mismatch", L"affinity-display-proof",
  L"input-listener-setup", L"input-listener-health", L"input-calibration-required",
  L"input-listener-authority", L"input-listener-target", L"input-listener-start-outcome", L"input-listener-installed",
  L"input-listener-registered", L"input-listener-alive", L"input-listener-generation", L"input-listener-context",
  L"input-start-runtime-events", L"input-start-runtime-observations", L"input-start-runtime-timer",
  L"input-start-native-owner", L"input-start-native-generation", L"input-start-native-events", L"input-start-native-thread",
  L"input-start-native-class", L"input-start-native-window", L"input-start-native-routes-query", L"input-start-native-routes-existing",
  L"input-start-native-register", L"input-start-native-readback", L"input-start-native-ready-timeout", L"input-start-native-status",
  L"input-listener-native-failed", L"input-listener-native-wait", L"input-listener-native-route-lost", L"input-listener-native-quit",
  L"input-start-service", L"input-listener-service-closed",
  L"input-readback-query", L"input-readback-mouse-missing", L"input-readback-keyboard-missing",
  L"input-readback-mouse-target", L"input-readback-keyboard-target", L"input-readback-devnotify-both",
  L"input-readback-devnotify-mouse", L"input-readback-devnotify-keyboard", L"input-readback-mouse-flags",
  L"input-readback-keyboard-flags", L"input-readback-closed",
  L"apps-list-request", L"apps-list-reply", L"apps-list-decode", L"apps-list-target",
  L"affinity-plan-context", L"affinity-plan-target", L"affinity-plan-fixture", L"affinity-plan-main",
  L"affinity-plan-session", L"affinity-plan-current-frame", L"affinity-plan-display", L"affinity-plan-excluded-surface",
  L"affinity-plan-excluded-owner", L"affinity-plan-geometry", L"affinity-plan-request",
  L"affinity-plan-current-target-lost", L"affinity-plan-current-target-stale", L"affinity-plan-current-pid", L"affinity-plan-current-main-window",
  L"affinity-plan-current-excluded-window", L"affinity-plan-current-point-patch", L"affinity-plan-current-point-excluded", L"affinity-plan-current-owner",
  L"affinity-plan-current-hit-null", L"affinity-plan-current-hit-main", L"affinity-plan-current-hit-foreign", L"affinity-plan-current-affinity-call",
  L"affinity-plan-current-affinity-monitor", L"affinity-plan-current-affinity-none", L"affinity-plan-current-affinity-other", L"affinity-plan-current-exception",
  L"affinity-plan-current-context", L"input-health-context", L"input-health-target", L"input-health-ready",
  L"input-health-unavailable-listener", L"input-health-unavailable-context", L"input-health-calibrating",
  L"input-health-no-foreground", L"input-health-foreground-refused", L"input-health-observe-slow", L"input-health-observe-exception",
  L"affinity-capture-stale-target-lost", L"affinity-capture-stale-target-stale", L"affinity-capture-stale-pid", L"affinity-capture-stale-main-window",
  L"affinity-capture-stale-excluded-window", L"affinity-capture-stale-point-patch", L"affinity-capture-stale-point-excluded", L"affinity-capture-stale-owner",
  L"affinity-capture-stale-hit-null", L"affinity-capture-stale-hit-main", L"affinity-capture-stale-hit-foreign", L"affinity-capture-stale-affinity-call",
  L"affinity-capture-stale-affinity-monitor", L"affinity-capture-stale-affinity-none", L"affinity-capture-stale-affinity-other", L"affinity-capture-stale-exception",
  L"authority-paused-detection", L"authority-paused-physical",
  L"input-settle-context", L"input-settle-session", L"input-settle-verdict"};
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
// The isolated scenario's detection settle once its bounded wait ends: empty when the session is
// paused, otherwise the closed input-settle-* stage. Pure; it reads only the two session snapshots.
std::wstring windows_privileged_settle_stage(bool context_available, const ServerSession& begun, const std::optional<ServerSession>& latest);
// HF-6: the first false term of the isolated affinity sample plan, in its original short-circuit order.
enum class WindowsAffinityStale {
  none, target_lost, target_stale, pid, main_window, excluded_window, point_patch, point_excluded, owner,
  hit_null, hit_main, hit_foreign, affinity_call, affinity_monitor, affinity_none, affinity_other, exception};
// Pure: the hit-test term from an already-read root window, and the term from an already-read display affinity.
WindowsAffinityStale windows_privileged_affinity_hit(HWND root, HWND owner, HWND excluded) noexcept;
WindowsAffinityStale windows_privileged_affinity_value(bool read, DWORD affinity) noexcept;
// The closed stage for a stale term, at planning or during the display read; empty for none.
std::wstring_view windows_privileged_affinity_stale_stage(WindowsAffinityStale, bool during_capture) noexcept;
// HF-6: read-only facts taken once after row 16's unchanged health wait fails, compared with the
// pre-setup diagnostic. The surface covers the helper, the desktop and the foreground owner's token.
struct WindowsListenerHealthFacts {
  UserInputSetupState setup = UserInputSetupState::unavailable;
  bool listener_changed = false, context_changed = false, foreground_null = false, observe_slow = false, observe_exception = false;
  WindowsSurfaceState surface = WindowsSurfaceState::unavailable;
};
// Pure: the closed input-health-* stage for those facts; input-health-ready when none applies.
std::wstring_view windows_privileged_listener_health_stage(const WindowsListenerHealthFacts&) noexcept;
std::wstring windows_privileged_origin_stage(std::wstring_view message, std::wstring_view fallback = {}, std::wstring_view capture_stage = {});
// Injected providers exercise the same scoped observer without querying a real window or desktop.
std::wstring windows_privileged_capture_diagnostic(CaptureBackend, const std::function<void(CaptureBackend&)>&);
void windows_privileged_inventory_failure(WindowsInventoryDiagnostic) noexcept;
void windows_privileged_capture_read_failure(CaptureReadPhase) noexcept;
bool windows_privileged_response_failure(const winrt::Windows::Data::Json::JsonObject&, std::wstring_view) noexcept;
// Pure fixture proof: a masked delivered pixel alone never establishes native affinity exclusion.
bool windows_privileged_affinity_sample_verified(std::optional<bool>, const CaptureBitmap&, const CaptureReceipt&,
  const winrt::Windows::Data::Json::JsonObject&, const WindowsRect&) noexcept;
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
