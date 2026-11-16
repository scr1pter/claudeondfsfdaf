#include "availability.h"
#include "protocol.h"
#include <stdexcept>

namespace vector::computer {
namespace {
void require(bool condition, const char* label) { if (!condition) throw std::runtime_error(label); }
template<class Work> void denied(Work work, std::wstring_view code, const char* label) {
  try { work(); } catch (const Failure& failure) { require(failure.code == code, label); return; }
  throw std::runtime_error(label);
}
TokenIdentity medium() {
  TokenIdentity token;
  token.user = {1}; token.logon = {2}; token.authentication = 3; token.session = 1;
  token.integrity = SECURITY_MANDATORY_MEDIUM_RID;
  token.elevated = false; token.ui_access = false; token.app_container = false;
  return token;
}
}
size_t run_availability_tests() {
  size_t count = 0;
  const auto test = [&](auto body) { body(); ++count; };
  const auto helper = medium();
  const WindowsDesktopFacts normal{true, true, true};
  test([&] { require(windows_helper_may_serve(helper) && windows_surface_state(helper, nullptr, normal) == WindowsSurfaceState::ready, "availability.normal-medium-desktop"); });
  test([&] { require(!windows_helper_may_serve(helper, true), "availability.test-elevation-only-refuses"); });
  test([&] { auto own = helper; own.elevated = true; require(!windows_helper_may_serve(own) && windows_surface_state(own, nullptr, normal) == WindowsSurfaceState::elevated, "availability.actual-own-elevation-no-exception"); });
  test([&] { auto own = helper; own.integrity = SECURITY_MANDATORY_HIGH_RID; require(!windows_helper_may_serve(own) && windows_surface_state(own, nullptr, normal) == WindowsSurfaceState::elevated, "availability.high-integrity-without-elevation-flag"); });
  test([&] { auto own = helper; own.ui_access = true; require(!windows_helper_may_serve(own), "availability.uiaccess-cannot-enable-serving"); });
  test([&] { auto own = helper; own.user.clear(); require(windows_surface_state(own, nullptr, normal) == WindowsSurfaceState::unavailable, "availability.unknown-token-is-not-normal"); });
  test([&] { auto facts = normal; facts.opened = false; require(windows_surface_state(helper, nullptr, facts) == WindowsSurfaceState::secure_desktop, "availability.failed-input-desktop-open-refused"); });
  test([&] { auto facts = normal; facts.default_name = false; require(windows_surface_state(helper, nullptr, facts) == WindowsSurfaceState::secure_desktop, "availability.nondefault-input-desktop-refused"); });
  test([&] { auto facts = normal; facts.visible_station = false; require(windows_surface_state(helper, nullptr, facts) == WindowsSurfaceState::secure_desktop, "availability.noninteractive-station-refused"); });
  test([&] { auto target = helper; target.elevated = true; require(windows_surface_state(helper, &target, normal) == WindowsSurfaceState::elevated, "availability.elevated-target-reports-handoff"); });
  test([&] { auto target = helper; target.integrity = SECURITY_MANDATORY_SYSTEM_RID; require(windows_surface_state(helper, &target, normal) == WindowsSurfaceState::elevated, "availability.higher-target-integrity-proactively-refused"); });
  test([&] { auto target = helper; target.integrity = SECURITY_MANDATORY_LOW_RID; target.app_container = true; require(windows_surface_state(helper, &target, normal) == WindowsSurfaceState::ready, "availability.ordinary-appcontainer-not-invented-elevated"); });
  test([&] { auto target = helper; target.integrity = 0; require(windows_surface_state(helper, &target, normal) == WindowsSurfaceState::unavailable, "availability.unknown-target-integrity-refused"); });
  test([&] { auto target = helper; target.session += 1; require(windows_surface_state(helper, &target, normal) == WindowsSurfaceState::unavailable, "availability.other-session-not-current-desktop"); });
  test([&] {
    auto own = helper; own.integrity = SECURITY_MANDATORY_MEDIUM_PLUS_RID;
    require(!windows_helper_may_serve(own) && windows_surface_state(own, nullptr, normal) == WindowsSurfaceState::elevated,
      "availability.medium-plus-never-creates-serving-exception");
  });
  test([&] {
    for (int field = 0; field < 3; ++field) {
      auto target = helper;
      if (field == 0) target.user = {9};
      if (field == 1) target.logon = {9};
      if (field == 2) ++target.authentication;
      require(windows_surface_state(helper, &target, normal) == WindowsSurfaceState::unavailable, "availability.other-principal-not-current-authority");
    }
  });
  test([&] {
    WindowsAvailabilityObservation unknown;
    require(windows_surface_state(unknown) == WindowsSurfaceState::unavailable && windows_capture_blocked(unknown) && !windows_availability_probe(unknown),
      "availability.unknown-defaults-never-invent-token-or-permission");
  });
  test([&] {
    WindowsAvailabilityObservation observation{helper, normal, false};
    const auto probe = windows_availability_probe(observation);
    require(probe && !probe->elevated && !probe->capture_blocked, "availability.normal-probe-reports-no-observed-blocker");
    require_windows_surface(observation); require_windows_capture(observation);
  });
  test([&] {
    WindowsAvailabilityObservation observation{helper, normal, false}; observation.helper->elevated = true;
    const auto probe = windows_availability_probe(observation);
    require(probe && probe->elevated && probe->capture_blocked, "availability.probe-uses-actual-elevation");
    denied([&] { require_windows_surface(observation); }, L"elevated", "availability.elevated-helper-never-reaches-operation");
  });
  test([&] {
    WindowsAvailabilityObservation observation{helper, normal, false}; observation.desktop.default_name = false;
    const auto probe = windows_availability_probe(observation);
    require(probe && !probe->elevated && probe->capture_blocked, "availability.secure-desktop-probe-is-not-invented-elevation");
    unsigned reads = 0, posts = 0;
    denied([&] { require_windows_capture(observation); ++reads; }, L"secure_desktop", "availability.secure-desktop-refuses-before-native-read");
    denied([&] { require_windows_surface(observation); ++posts; }, L"secure_desktop", "availability.secure-desktop-refuses-before-native-post");
    require(reads == 0 && posts == 0, "availability.secure-desktop-has-zero-native-effects");
  });
  test([&] {
    WindowsAvailabilityObservation observation{helper, normal, false}; auto target = helper; target.integrity = SECURITY_MANDATORY_HIGH_RID;
    unsigned posts = 0;
    denied([&] { require_windows_surface(observation, &target); ++posts; }, L"elevated", "availability.target-higher-integrity-refuses-before-post");
    require(posts == 0, "availability.elevated-target-has-zero-native-posts");
  });
  test([&] {
    WindowsAvailabilityObservation observation{helper, normal, true};
    require(windows_capture_blocked(observation) && windows_surface_state(observation) == WindowsSurfaceState::ready,
      "availability.known-capture-policy-is-not-an-input-permission");
    denied([&] { require_windows_capture(observation); }, L"capture_unavailable", "availability.known-applicable-capture-block-is-refused");
  });
  test([&] {
    WindowsAvailabilityObservation observation{helper, normal, std::nullopt};
    require(windows_capture_blocked(observation), "availability.failed-applicable-policy-read-fails-capture-closed");
    denied([&] { require_windows_capture(observation); }, L"capture_unavailable", "availability.unknown-policy-never-claims-capture-ready");
  });
  test([&] {
    unsigned tokens = 0, desktops = 0, policies = 0;
    WindowsAvailabilityBackend backend;
    backend.helper = [&] { ++tokens; return std::optional<TokenIdentity>(helper); };
    backend.desktop = [&] { ++desktops; return normal; };
    backend.capture_policy_blocked = [&] { ++policies; return std::optional<bool>(false); };
    require(tokens == 0 && desktops == 0 && policies == 0, "availability.backend-construction-is-inert");
    const auto observation = observe_windows_availability(backend);
    require(tokens == 1 && desktops == 1 && policies == 1 && windows_surface_state(observation) == WindowsSurfaceState::ready,
      "availability.explicit-read-uses-current-injected-facts");
  });
  test([&] {
    WindowsAvailabilityBackend backend;
    backend.helper = []() -> std::optional<TokenIdentity> { throw std::runtime_error("fixture"); };
    backend.desktop = [&] { return normal; };
    const auto observation = observe_windows_availability(backend);
    require(!observation.helper && windows_capture_blocked(observation) && !windows_availability_probe(observation), "availability.failed-token-query-never-synthesizes-medium");
  });
  test([&] {
    WindowsAvailabilityBackend backend;
    backend.helper = [&] { return std::optional<TokenIdentity>(helper); };
    backend.desktop = []() -> WindowsDesktopFacts { throw std::runtime_error("fixture"); };
    require(windows_surface_state(observe_windows_availability(backend)) == WindowsSurfaceState::secure_desktop, "availability.failed-desktop-query-fails-closed");
  });
  test([&] {
    WindowsAvailabilityBackend backend;
    backend.helper = [&] { return std::optional<TokenIdentity>(helper); }; backend.desktop = [&] { return normal; };
    backend.capture_policy_blocked = []() -> std::optional<bool> { throw std::runtime_error("fixture"); };
    const auto observation = observe_windows_availability(backend);
    require(!observation.capture_policy_blocked && windows_capture_blocked(observation), "availability.failed-policy-query-is-not-no-known-blocker");
  });
  test([&] {
    WindowsAvailabilityBackend backend;
    backend.helper = [&] { return std::optional<TokenIdentity>(helper); }; backend.desktop = [&] { return normal; };
    const auto observation = observe_windows_availability(backend);
    require(windows_surface_state(observation) == WindowsSurfaceState::ready && windows_capture_blocked(observation),
      "availability.missing-policy-provider-does-not-invent-a-known-no-blocker-result");
  });
  return count;
}
}
