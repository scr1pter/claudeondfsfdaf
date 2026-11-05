#pragma once
#include "windows_enum.h"

namespace vector::computer {
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
struct OverlayDriverResult {
  bool ok = false, skipped = false;
  std::wstring reason;
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
int run_overlay_driver(const OverlayDriverOptions&, HANDLE input, HANDLE output) noexcept;
size_t run_overlay_driver_tests();
}
