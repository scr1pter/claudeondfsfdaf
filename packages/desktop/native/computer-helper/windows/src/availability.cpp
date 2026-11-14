#include "availability.h"
#include "protocol.h"
#include <array>

namespace vector::computer {
WindowsDesktopFacts observe_windows_desktop() noexcept {
  WindowsDesktopFacts result;
  const auto desktop = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS);
  if (!desktop) return result;
  struct Desktop { HDESK value; ~Desktop() { CloseDesktop(value); } } close{desktop};
  result.opened = true;
  std::array<wchar_t, 256> name{};
  DWORD bytes = 0;
  if (GetUserObjectInformationW(desktop, UOI_NAME, name.data(), static_cast<DWORD>(sizeof(name)), &bytes) &&
      bytes >= 2 * sizeof(wchar_t) && bytes <= sizeof(name) && bytes % sizeof(wchar_t) == 0 && name[bytes / sizeof(wchar_t) - 1] == L'\0') {
    const auto length = static_cast<int>(bytes / sizeof(wchar_t) - 1);
    result.default_name = CompareStringOrdinal(name.data(), length, L"Default", 7, TRUE) == CSTR_EQUAL;
  }
  USEROBJECTFLAGS flags{}; bytes = 0;
  const auto station = GetProcessWindowStation();
  result.visible_station = station && GetUserObjectInformationW(station, UOI_FLAGS, &flags, sizeof(flags), &bytes) &&
    bytes == sizeof(flags) && (flags.dwFlags & WSF_VISIBLE) != 0;
  return result;
}
bool windows_desktop_available(const WindowsDesktopFacts& facts) noexcept {
  return facts.opened && facts.default_name && facts.visible_station;
}
bool windows_helper_may_serve(const TokenIdentity& helper, bool test_elevated_token) noexcept {
  return !test_elevated_token && helper.integrity == SECURITY_MANDATORY_MEDIUM_RID && serving_token_allowed(helper);
}
WindowsSurfaceState windows_surface_state(const TokenIdentity& helper, const TokenIdentity* target,
                                         const WindowsDesktopFacts& desktop) noexcept {
  if (helper.elevated || helper.integrity > SECURITY_MANDATORY_MEDIUM_RID || helper.ui_access) return WindowsSurfaceState::elevated;
  if (!windows_helper_may_serve(helper)) return WindowsSurfaceState::unavailable;
  if (!windows_desktop_available(desktop)) return WindowsSurfaceState::secure_desktop;
  if (!target) return WindowsSurfaceState::ready;
  if (target->user.empty() || target->logon.empty() || target->authentication == 0 || target->integrity == 0 || target->session != helper.session)
    return WindowsSurfaceState::unavailable;
  if (target->elevated || target->integrity > helper.integrity || target->ui_access) return WindowsSurfaceState::elevated;
  if (target->user != helper.user || target->logon != helper.logon || target->authentication != helper.authentication) return WindowsSurfaceState::unavailable;
  return WindowsSurfaceState::ready;
}
WindowsAvailabilityBackend WindowsAvailabilityBackend::system() {
  WindowsAvailabilityBackend backend;
  backend.helper = []() -> std::optional<TokenIdentity> { try { return observe_token(GetCurrentProcess()); } catch (...) { return {}; } };
  backend.desktop = observe_windows_desktop;
  // This unpackaged, BitBlt-primary helper has no documented universal capture-permission getter.
  // PFN-only graphicsCaptureProgrammatic and border-removal settings are not a BitBlt permission.
  // https://learn.microsoft.com/windows/client-management/mdm/policy-csp-privacy#letappsaccessgraphicscaptureprogrammatic
  // Actual capture still respects affinity and rejects denied/black/unavailable OS results.
  backend.capture_policy_blocked = [] { return std::optional<bool>(false); };
  return backend;
}
WindowsAvailabilityObservation observe_windows_availability(const WindowsAvailabilityBackend& backend) noexcept {
  WindowsAvailabilityObservation result;
  try { if (backend.helper) result.helper = backend.helper(); } catch (...) { result.helper.reset(); }
  try { if (backend.desktop) result.desktop = backend.desktop(); } catch (...) { result.desktop = {}; }
  try { if (backend.capture_policy_blocked) result.capture_policy_blocked = backend.capture_policy_blocked(); } catch (...) { result.capture_policy_blocked.reset(); }
  return result;
}
WindowsSurfaceState windows_surface_state(const WindowsAvailabilityObservation& observation, const TokenIdentity* target) noexcept {
  return observation.helper ? windows_surface_state(*observation.helper, target, observation.desktop) : WindowsSurfaceState::unavailable;
}
bool windows_capture_blocked(const WindowsAvailabilityObservation& observation) noexcept {
  return windows_surface_state(observation) != WindowsSurfaceState::ready || !observation.capture_policy_blocked || *observation.capture_policy_blocked;
}
void require_windows_surface(const WindowsAvailabilityObservation& observation, const TokenIdentity* target) {
  switch (windows_surface_state(observation, target)) {
    case WindowsSurfaceState::ready: return;
    case WindowsSurfaceState::elevated: throw Failure{L"elevated", L"This Windows surface requires a manual handoff."};
    case WindowsSurfaceState::secure_desktop: throw Failure{L"secure_desktop", L"The Windows interactive desktop is unavailable. Complete the protected step manually."};
    case WindowsSurfaceState::unavailable: throw Failure{L"unavailable", L"The Windows desktop or token could not be verified."};
  }
  throw Failure{L"unavailable", L"The Windows desktop or token could not be verified."};
}
void require_windows_capture(const WindowsAvailabilityObservation& observation, const TokenIdentity* target) {
  require_windows_surface(observation, target);
  if (!observation.capture_policy_blocked || *observation.capture_policy_blocked) throw Failure{L"capture_unavailable", L"Windows capture is unavailable. Check Privacy & security settings."};
}
std::optional<WindowsAvailabilityProbe> windows_availability_probe(const WindowsAvailabilityObservation& observation) noexcept {
  if (!observation.helper) return {};
  const auto& helper = *observation.helper;
  return WindowsAvailabilityProbe{helper.elevated || helper.integrity > SECURITY_MANDATORY_MEDIUM_RID || helper.ui_access, windows_capture_blocked(observation)};
}
}
