#pragma once
#include "windows_enum.h"
#include <array>
#include <exception>
#include <string_view>

namespace vector::computer {
enum class WindowsUiaPhase : uint8_t;
enum class OverlayDriverMode { stop, launch_electron };
struct OverlayDriverOptions {
  OverlayDriverMode mode = OverlayDriverMode::stop;
  DWORD parent = 0;
  std::wstring nonce;
};
struct OverlayStopRequest {
  DWORD parent = 0;
  uint64_t parent_created = 0;
  std::wstring nonce, source_digest, title;
  HWND banner = nullptr;
  WindowsRect banner_bounds, stop_bounds;
};
// Thrown only inside the never-shipped finite driver. Exported solely so pure tests can classify them.
struct DriverFailure { std::wstring reason; };
struct DriverSkip { std::wstring reason; };
// Closed failure-only locations of the finite Stop path. Tracking is a plain byte store, never a call.
// dpi also covers the mode and nonce check before the DPI call. dpi and parent precede the stop-mode
// writer, so neither is ever reported in a result frame. One stage can cover several checks of a step.
enum class OverlayDriverStage : uint8_t {
  dpi, parent, files, observe_parent, observe_bootstrap, isolation,
  token, desktop, ready_write, envelope_read, envelope_shape, request,
  foreground, guardian_create, backend_create, uia_create, uia_available, window_observe,
  stop_element, stop_root, stop_root_retired, stop_root_refused, stop_hit, stop_security,
  stop_name, stop_belongs, stop_equal, stop_parent, window_current, quiet,
  guardian_ready, reserve, refresh, post, observe_down, retire,
  observe_up, cleanup, uia_root_current, uia_actor_admission, uia_actor_queued, uia_actor_budget,
  uia_prepare_desktop, uia_prepare_create, uia_prepare_interface, uia_prepare_connection, uia_prepare_transaction, uia_prepare_walker,
  uia_prepare_cache, uia_prepare_scope, uia_prepare_control, uia_prepare_filter, uia_prepare_property, uia_root_availability,
  uia_root_target, uia_root_element, uia_root_handle, uia_root_wrap, uia_runtime_id, uia_runtime_shape,
  uia_runtime_bounds, uia_runtime_value, uia_wrap_equal, uia_wrap_limit, uia_security_cache, uia_security_pid,
  uia_security_type, uia_security_password, uia_security_enabled, uia_security_focus, uia_security_keyboard, uia_security_value_pattern,
  uia_security_text_pattern, uia_security_classify, uia_security_value_readonly, uia_security_text_readonly, uia_security_bounds, uia_security_current,
  uia_root_pid, uia_actor_current, uia_actor_current_budget, uia_actor_complete, uia_actor_expired, uia_actor_cancelled,
  uia_actor_revoked, uia_actor_com_uninitialized, uia_actor_com_cancellation_unavailable, uia_actor_com_timer_unavailable, uia_actor_com_expired
};
inline constexpr std::array<std::wstring_view, 89> overlay_driver_stages{
  L"dpi", L"parent", L"files", L"observe-parent", L"observe-bootstrap", L"isolation",
  L"token", L"desktop", L"ready-write", L"envelope-read", L"envelope-shape", L"request",
  L"foreground", L"guardian-create", L"backend-create", L"uia-create", L"uia-available", L"window-observe",
  L"stop-element", L"stop-root", L"stop-root-retired", L"stop-root-refused", L"stop-hit", L"stop-security",
  L"stop-name", L"stop-belongs", L"stop-equal", L"stop-parent", L"window-current", L"quiet",
  L"guardian-ready", L"reserve", L"refresh", L"post", L"observe-down", L"retire",
  L"observe-up", L"cleanup", L"uia-root-current", L"uia-actor-admission", L"uia-actor-queued", L"uia-actor-budget",
  L"uia-prepare-desktop", L"uia-prepare-create", L"uia-prepare-interface", L"uia-prepare-connection", L"uia-prepare-transaction", L"uia-prepare-walker",
  L"uia-prepare-cache", L"uia-prepare-scope", L"uia-prepare-control", L"uia-prepare-filter", L"uia-prepare-property", L"uia-root-availability",
  L"uia-root-target", L"uia-root-element", L"uia-root-handle", L"uia-root-wrap", L"uia-runtime-id", L"uia-runtime-shape",
  L"uia-runtime-bounds", L"uia-runtime-value", L"uia-wrap-equal", L"uia-wrap-limit", L"uia-security-cache", L"uia-security-pid",
  L"uia-security-type", L"uia-security-password", L"uia-security-enabled", L"uia-security-focus", L"uia-security-keyboard", L"uia-security-value-pattern",
  L"uia-security-text-pattern", L"uia-security-classify", L"uia-security-value-readonly", L"uia-security-text-readonly", L"uia-security-bounds", L"uia-security-current",
  L"uia-root-pid", L"uia-actor-current", L"uia-actor-current-budget", L"uia-actor-complete", L"uia-actor-expired", L"uia-actor-cancelled",
  L"uia-actor-revoked", L"uia-actor-com-uninitialized", L"uia-actor-com-cancellation-unavailable", L"uia-actor-com-timer-unavailable", L"uia-actor-com-expired"
};
static_assert(overlay_driver_stages.size() == static_cast<size_t>(OverlayDriverStage::uia_actor_com_expired) + 1);
// HRESULTs are reported only as one of these buckets, never as a value.
inline constexpr std::array<std::wstring_view, 5> overlay_driver_hresult_classes{L"access_denied", L"rpc", L"not_found", L"timeout", L"other"};
struct OverlayDriverResult {
  bool ok = false, skipped = false;
  std::wstring reason;
  // Closed failure-only stop diagnostics; wire() emits both or neither, only for a coherent unskipped
  // failure. Never text, paths, HRESULT values, titles or ids. They never change ok, skip, reason or exit.
  std::wstring stage, cause;
  int exit_code() const noexcept;
  JsonObject wire() const;
};
bool overlay_driver_hex(std::wstring_view, size_t = 64) noexcept;
std::optional<OverlayDriverOptions> parse_overlay_driver_options(std::span<const std::wstring>);
std::optional<OverlayStopRequest> parse_overlay_stop_request(const JsonObject&);
bool valid_overlay_stop_request(const OverlayStopRequest&) noexcept;
// DOM coordinates are only a rounding hint. Posting always uses the independently observed native
// Stop button rectangle; both of its edges must be within one physical pixel of the hint.
bool overlay_stop_bounds_match(const WindowsRect& hint, const WindowsRect& observed) noexcept;
bool overlay_driver_reason(std::wstring_view) noexcept;
std::wstring_view overlay_driver_stage_name(OverlayDriverStage) noexcept;
bool overlay_driver_stage(std::wstring_view) noexcept;
std::optional<OverlayDriverStage> overlay_driver_uia_stage(WindowsUiaPhase) noexcept;
// driver_failure, std_exception, unknown, core_failure:<closed native code> or hresult:<closed bucket>.
bool overlay_driver_cause(std::wstring_view) noexcept;
std::wstring_view overlay_driver_hresult_class(HRESULT) noexcept;
// Keeps the driver's ok/skip/reason mapping exactly; only stop mode gains the closed stage and cause.
OverlayDriverResult overlay_driver_caught(OverlayDriverMode, OverlayDriverStage, std::exception_ptr);
int run_overlay_driver(const OverlayDriverOptions&, HANDLE input, HANDLE output) noexcept;
size_t run_overlay_driver_tests();
}
