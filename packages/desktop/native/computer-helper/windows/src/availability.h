#pragma once
#include "parent_identity.h"
#include <functional>

namespace vector::computer {
struct WindowsDesktopFacts {
  bool opened = false;
  bool default_name = false;
  bool visible_station = false;
  bool operator==(const WindowsDesktopFacts&) const = default;
};
// Read-only kernel/window-station facts. No desktop switch, prompt, capture or external UI RPC.
WindowsDesktopFacts observe_windows_desktop() noexcept;
bool windows_desktop_available(const WindowsDesktopFacts&) noexcept;

enum class WindowsSurfaceState { ready, elevated, secure_desktop, unavailable };
// The test switch only adds a refusal; it can never enable elevated serving.
bool windows_helper_may_serve(const TokenIdentity&, bool test_elevated_token = false) noexcept;
WindowsSurfaceState windows_surface_state(const TokenIdentity& helper, const TokenIdentity* target,
                                         const WindowsDesktopFacts&) noexcept;

struct WindowsAvailabilityObservation {
  std::optional<TokenIdentity> helper;
  WindowsDesktopFacts desktop;
  // False means no actually observed applicable policy blocker, never proof that future pixels are available.
  // A registered observer that cannot determine its result returns nullopt and capture fails closed.
  std::optional<bool> capture_policy_blocked;
};
struct WindowsAvailabilityBackend {
  std::function<std::optional<TokenIdentity>()> helper;
  std::function<WindowsDesktopFacts()> desktop;
  std::function<std::optional<bool>()> capture_policy_blocked;
  static WindowsAvailabilityBackend system();
};
WindowsAvailabilityObservation observe_windows_availability(const WindowsAvailabilityBackend&) noexcept;
WindowsSurfaceState windows_surface_state(const WindowsAvailabilityObservation&, const TokenIdentity* target = nullptr) noexcept;
bool windows_capture_blocked(const WindowsAvailabilityObservation&) noexcept;
void require_windows_surface(const WindowsAvailabilityObservation&, const TokenIdentity* target = nullptr);
void require_windows_capture(const WindowsAvailabilityObservation&, const TokenIdentity* target = nullptr);
struct WindowsAvailabilityProbe { bool elevated = false, capture_blocked = true; };
std::optional<WindowsAvailabilityProbe> windows_availability_probe(const WindowsAvailabilityObservation&) noexcept;
size_t run_availability_tests();
}
