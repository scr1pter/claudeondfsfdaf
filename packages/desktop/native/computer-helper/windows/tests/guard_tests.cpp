#include "guard.h"
#include "availability.h"
#include <array>
#include <stdexcept>

namespace vector::computer {
namespace {
void require(bool value, const char* name) { if (!value) throw std::runtime_error(name); }
WindowsWindow window_fixture() {
  WindowsWindow window;
  window.hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(100)); window.surface = window.hwnd;
  window.thread_id = 10; window.surface_thread_id = 10;
  window.owner.identity.kind = WindowsAppKind::exe; window.owner.identity.publisher = L"Synthetic verified publisher";
  window.owner.identity.binary = L"fixture.exe"; window.owner.identity.name = L"Fixture";
  window.owner.identity.exe = L"C:\\Fixture\\fixture.exe"; window.owner.identity.verified = true; window.owner.identity.pid = 123;
  window.owner.process.pid = 123; window.owner.process.creation_time = 100;
  window.owner.process.image.path = window.owner.identity.exe; window.owner.process.image.signature = SignatureState::valid;
  window.owner.process.image.size = 1024; window.owner.process.image.id[0] = 1; window.owner.process.image.sha256[0] = 1;
  window.physical_owner = window.owner; window.bounds = {0, 0, 800, 600}; window.surface_bounds = window.bounds;
  window.window_class = L"FixtureWindow"; window.visible = true; window.on_screen = true;
  window.cloaked = false; window.current_desktop = true; window.elevated = false; window.child_shell = false;
  return window;
}
struct Fixture {
  WindowsWindow expected = window_fixture(), pointer = expected, focused = expected;
  ServerSession session;
  bool live = true, admitted = true, current = true, point_current = true, foreground_current = true, keyboard_current = true;
  uint64_t time = 100;
  size_t mutations = 0, preparations = 0, fences = 0, point_preparations = 0, keyboard_checks = 0;
  std::function<void()> before_fence, during_surface;
  std::vector<HWND> overlays;
  std::optional<DWORD> hit_pid;
  std::optional<std::wstring> hit_class;
  std::optional<WindowsAvailabilityObservation> availability;
  Fixture() {
    session.id = L"synthetic"; session.run_epoch = 1; session.observation_epoch = 2;
    session.approved.Append(expected.owner.identity.wire());
  }
  WindowsGuardBackend backend() {
    WindowsGuardBackend result;
    result.point = [this](POINT point, const ServerSession&) {
      ++preparations; ++point_preparations; return WindowsPointOwner{pointer, pointer.surface, point, overlays, hit_pid.value_or(pointer.owner.process.pid), pointer.surface_thread_id, hit_class.value_or(pointer.window_class)};
    };
    result.foreground = [this] { ++preparations; return focused; };
    result.current = [this](const WindowsWindow&) { return current; };
    result.point_current = [this](const WindowsPointOwner& actual, const ServerSession&) {
      return point_current && same_windows_window(actual.window, pointer) && actual.hit == pointer.surface && actual.skipped_overlays == overlays;
    };
    result.foreground_current = [this](const WindowsWindow& actual) {
      return foreground_current && same_windows_window(actual, focused);
    };
    result.keyboard_current = [this](const WindowsWindow& actual) {
      ++keyboard_checks; return keyboard_current && foreground_current && same_windows_window(actual, focused);
    };
    result.require_surface = [this](const WindowsWindow& window) {
      if (during_surface) during_surface();
      if (!availability) return;
      require_windows_surface(*availability, &window.owner.process.token);
      require_windows_surface(*availability, &window.physical_owner.process.token);
    };
    result.now = [this] { return time; };
    return result;
  }
  OperationContext context() {
    OperationContext result;
    result.session = session; result.is_current = [this] { return live; };
    result.with_current = [this](const auto& body) {
      ++fences;
      if (!live || !admitted) return false;
      if (before_fence) before_fence();
      if (!live) return false;
      body(); return true;
    };
    return result;
  }
  void click() {
    WindowsGuard(backend()).with_point(expected, POINT{200, 200}, session, context(), [this] { ++mutations; });
  }
  void key(std::span<const std::wstring> keys, std::optional<bool> secure = {}) {
    WindowsGuard(backend()).with_foreground(expected, session, context(), WindowsPolicyOperation::key, [this] { ++mutations; }, secure, keys);
  }
  void type(std::optional<bool> secure = false) {
    WindowsGuard(backend()).with_foreground(expected, session, context(), WindowsPolicyOperation::type_text, [this] { ++mutations; }, secure);
  }
  void available_surface() {
    TokenIdentity helper;
    helper.user = {1}; helper.logon = {2}; helper.authentication = 3; helper.session = 1;
    helper.integrity = SECURITY_MANDATORY_MEDIUM_RID;
    helper.elevated = helper.ui_access = helper.app_container = false;
    availability = WindowsAvailabilityObservation{helper, {true, true, true}, false};
    expected.owner.process.token = helper; expected.physical_owner = expected.owner;
    pointer = expected; focused = expected;
  }
};
void fails(const std::function<void()>& body, std::wstring_view expected) {
  try { body(); } catch (const Failure& failure) { require(failure.code == expected, "guard.wrong-refusal"); return; }
  throw std::runtime_error("guard.expected-refusal");
}
}

size_t run_guard_tests() {
  size_t groups = 0;
  const auto test = [&](const std::function<void()>& body) { body(); ++groups; };
  test([] {
    Fixture fixture; fixture.click();
    require(fixture.mutations == 1 && fixture.preparations == 1 && fixture.fences == 1, "guard.pointer-one-current-commit");
  });
  test([] {
    Fixture fixture; fixture.type();
    require(fixture.mutations == 1 && fixture.preparations == 1 && fixture.fences == 1, "guard.type-one-current-commit");
  });
  test([] {
    Fixture fixture; fixture.pointer.window_class = L"ConsoleWindowClass";
    fails([&] { fixture.click(); }, L"protected");
    require(fixture.mutations == 0 && fixture.fences == 0, "guard.terminal-hit-before-post");
  });
  test([] {
    Fixture fixture; fixture.hit_class = L"ConsoleWindowClass";
    fails([&] { fixture.click(); }, L"protected");
    require(fixture.mutations == 0, "guard.console-child-not-hidden-by-approved-root");
  });
  test([] {
    Fixture fixture; fixture.hit_pid = 200;
    fails([&] { fixture.click(); }, L"changed");
    require(fixture.mutations == 0, "guard.foreign-child-not-relabelled-as-container");
  });
  test([] {
    Fixture fixture; fixture.pointer.owner.process.pid = 200; fixture.pointer.owner.identity.pid = 200;
    fixture.pointer.physical_owner = fixture.pointer.owner;
    fixture.session.vector_pids.Append(JsonValue::CreateNumberValue(200));
    fails([&] { fixture.click(); }, L"protected");
    require(fixture.mutations == 0, "guard.hit-is-vector-process-not-target-label");
  });
  test([] {
    Fixture fixture; fixture.pointer.owner.identity.binary = L"CredentialUIBroker.exe"; fixture.pointer.physical_owner = fixture.pointer.owner;
    fails([&] { fixture.click(); }, L"protected");
    require(fixture.mutations == 0, "guard.security-hit-before-post");
  });
  test([] {
    Fixture fixture; fixture.before_fence = [&] { fixture.point_current = false; };
    fails([&] { fixture.click(); }, L"changed");
    require(fixture.mutations == 0 && fixture.fences == 1, "guard.hit-change-inside-authority-before-post");
  });
  test([] {
    Fixture fixture; fixture.before_fence = [&] {
      fixture.focused.owner.identity.binary = L"powershell.exe"; fixture.focused.physical_owner = fixture.focused.owner;
    };
    const std::array<std::wstring, 1> keys{L"ArrowLeft"};
    fails([&] { fixture.key(keys); }, L"changed");
    require(fixture.mutations == 0, "guard.mid-type-protected-foreground-stops-before-next-chunk");
  });
  test([] {
    Fixture fixture; fixture.before_fence = [&] { fixture.keyboard_current = false; };
    const std::array<std::wstring, 1> keys{L"ArrowLeft"};
    fails([&] { fixture.key(keys); }, L"changed");
    require(fixture.mutations == 0, "guard.focus-leaves-logical-surface-before-keyboard-post");
  });
  test([] {
    Fixture fixture; fixture.focused.window_class = L"ConsoleWindowClass";
    const std::array<std::wstring, 1> keys{L"Enter"};
    fails([&] { fixture.key(keys); }, L"protected");
    require(fixture.mutations == 0, "guard.actual-foreground-refused-before-expected-comparison");
  });
  test([] {
    Fixture fixture; fixture.focused.hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(101)); fixture.focused.surface = fixture.focused.hwnd;
    const std::array<std::wstring, 1> keys{L"ArrowLeft"};
    fails([&] { fixture.key(keys); }, L"changed");
    require(fixture.mutations == 0, "guard.same-app-different-window-not-reused");
  });
  test([] {
    Fixture fixture; fixture.pointer.owner.process.creation_time += 1; fixture.pointer.physical_owner = fixture.pointer.owner;
    fails([&] { fixture.click(); }, L"changed");
    require(fixture.mutations == 0, "guard.pid-reuse-start-witness");
  });
  test([] {
    Fixture fixture; fixture.pointer.bounds.x += 1;
    fails([&] { fixture.click(); }, L"changed");
    require(fixture.mutations == 0, "guard.geometry-change-not-stale-success");
  });
  test([] {
    Fixture fixture; fixture.current = false;
    fails([&] { fixture.click(); }, L"changed");
    require(fixture.mutations == 0, "guard.held-native-process-or-window-gone");
  });
  test([] {
    Fixture fixture; fixture.foreground_current = false;
    fails([&] { fixture.click(); }, L"not_foreground");
    require(fixture.mutations == 0, "guard.windows-pointer-requires-actual-foreground");
  });
  test([] {
    Fixture fixture; fixture.expected.minimized = true; fixture.pointer = fixture.expected;
    fails([&] { fixture.click(); }, L"not_foreground");
    require(fixture.mutations == 0, "guard.minimized-window-never-posted");
  });
  test([] {
    Fixture fixture; fixture.before_fence = [&] { fixture.time += 51; };
    fails([&] { fixture.click(); }, L"changed");
    require(fixture.mutations == 0, "guard.expired-preparation-cannot-post");
    fixture.before_fence = [&] { fixture.time = 0; };
    fails([&] { fixture.click(); }, L"changed");
  });
  test([] {
    Fixture fixture; fixture.live = false;
    fails([&] { fixture.click(); }, L"changed");
    require(fixture.mutations == 0 && fixture.preparations == 0, "guard.cancel-before-native-preparation");
    fixture.live = true; fixture.admitted = false;
    fails([&] { fixture.click(); }, L"changed");
    require(fixture.mutations == 0, "guard.phase-closed-before-commit");
  });
  test([] {
    Fixture fixture; auto context = fixture.context();
    context.session->run_epoch += 1;
    fails([&] { WindowsGuard(fixture.backend()).with_point(fixture.expected, POINT{200, 200}, fixture.session, context, [&] { ++fixture.mutations; }); }, L"changed");
    require(fixture.mutations == 0 && fixture.preparations == 0, "guard-same-wire-session-new-accepted-run");
    context = fixture.context(); context.session->observation_epoch += 1;
    fails([&] { WindowsGuard(fixture.backend()).with_point(fixture.expected, POINT{200, 200}, fixture.session, context, [&] { ++fixture.mutations; }); }, L"changed");
  });
  test([] {
    Fixture fixture; fixture.before_fence = [&] { fixture.live = false; };
    fails([&] { fixture.type(); }, L"changed");
    require(fixture.mutations == 0, "guard.cancel-while-native-preparation-finishes");
  });
  test([] {
    Fixture fixture;
    fails([&] { fixture.type(std::nullopt); }, L"secure_field");
    fails([&] { fixture.type(true); }, L"secure_field");
    require(fixture.mutations == 0, "guard.unknown-or-secure-field-refuses-text");
  });
  test([] {
    Fixture fixture;
    fixture.expected.owner.identity.binary = L"Code.exe"; fixture.expected.physical_owner = fixture.expected.owner;
    fixture.pointer = fixture.expected; fixture.focused = fixture.expected; fixture.session.approved.Clear(); fixture.session.approved.Append(fixture.expected.owner.identity.wire());
    fails([&] { fixture.type(); }, L"blocked");
    const std::array<std::wstring, 2> paste{L"Control", L"KeyV"};
    fails([&] { fixture.key(paste, false); }, L"blocked");
    const std::array<std::wstring, 3> alt_graph{L"Control", L"AltGraph", L"KeyQ"};
    fails([&] { fixture.key(alt_graph, false); }, L"blocked");
    const std::array<std::wstring, 2> copy{L"Control", L"KeyC"};
    fixture.key(copy);
    require(fixture.mutations == 1, "guard.developer-click-shortcut-only");
  });
  test([] {
    Fixture fixture; fixture.session.paused = true;
    fails([&] { fixture.click(); }, L"paused");
    fixture.session.paused = false; fixture.session.mode = L"background";
    fails([&] { fixture.click(); }, L"unsupported_action");
    require(fixture.mutations == 0, "guard.no-paused-or-background-post");
  });
  test([] {
    Fixture fixture;
    const auto overlay = reinterpret_cast<HWND>(static_cast<uintptr_t>(1000));
    fixture.session.overlay_window_ids.Append(JsonValue::CreateStringValue(window_id(overlay)));
    fixture.session.vector_pids.Append(JsonValue::CreateNumberValue(200));
    const auto styles = WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE;
    require(windows_overlay_passthrough_allowed({overlay, 200, styles}, fixture.session), "guard.exact-actual-vector-click-through-overlay");
    require(!windows_overlay_passthrough_allowed({overlay, 201, styles}, fixture.session), "guard.overlay-id-does-not-authorize-foreign-owner");
    require(!windows_overlay_passthrough_allowed({overlay, 200, WS_EX_LAYERED | WS_EX_NOACTIVATE}, fixture.session), "guard.stop-banner-never-skipped");
    require(!windows_overlay_passthrough_allowed({reinterpret_cast<HWND>(static_cast<uintptr_t>(1001)), 200, styles}, fixture.session), "guard.vector-pid-does-not-authorize-other-window");
  });
  test([] {
    Fixture fixture; const auto overlay = reinterpret_cast<HWND>(static_cast<uintptr_t>(1000));
    fixture.overlays.push_back(overlay); fixture.before_fence = [&] { fixture.overlays.clear(); };
    fails([&] { fixture.click(); }, L"changed");
    require(fixture.mutations == 0, "guard.overlay-stack-change-before-commit");
  });
  test([] {
    Fixture fixture; const std::array<std::wstring, 0> empty{};
    fails([&] { fixture.key(empty); }, L"failed");
    fails([&] { WindowsGuard(fixture.backend()).with_foreground(fixture.expected, fixture.session, fixture.context(), WindowsPolicyOperation::observe, [&] { ++fixture.mutations; }); }, L"failed");
    require(fixture.mutations == 0, "guard.read-only-operation-cannot-post-keyboard-input");
  });
  test([] {
    Fixture fixture; fixture.keyboard_current = false; fixture.point_current = false;
    WindowsGuard(fixture.backend()).with_element(fixture.expected, fixture.session, fixture.context(), WindowsPolicyOperation::pointer, [&] { ++fixture.mutations; }, false);
    require(fixture.mutations == 1 && fixture.preparations == 1 && fixture.fences == 1 && fixture.keyboard_checks == 0 && fixture.point_preparations == 0,
      "guard.nonfocused-uia-element-needs-foreground-app-not-keyboard-or-point-proof");
    const std::array<std::wstring, 1> key{L"ArrowLeft"};
    fails([&] { fixture.key(key); }, L"not_foreground");
    fails([&] { WindowsGuard(fixture.backend()).with_foreground(fixture.expected, fixture.session, fixture.context(), WindowsPolicyOperation::pointer, [&] { ++fixture.mutations; }, false); }, L"failed");
    require(fixture.mutations == 1, "guard.element-route-does-not-relax-keyboard-route");
  });
  test([] {
    Fixture fixture; fixture.keyboard_current = false;
    bool inside = false; auto context = fixture.context();
    context.with_current = [&](const auto& body) {
      inside = true; body(); inside = false; return true;
    };
    WindowsGuard(fixture.backend()).with_element(fixture.expected, fixture.session, context, WindowsPolicyOperation::set_value, [&] {
      require(inside, "guard.private-element-proof-remains-inside-authority"); ++fixture.mutations;
    }, false);
    require(fixture.mutations == 1 && fixture.keyboard_checks == 0, "guard.value-pattern-does-not-require-field-focus");
  });
  test([] {
    Fixture fixture;
    for (const auto operation : {WindowsPolicyOperation::observe, WindowsPolicyOperation::capture, WindowsPolicyOperation::activate, WindowsPolicyOperation::key, WindowsPolicyOperation::type_text}) {
      fails([&] { WindowsGuard(fixture.backend()).with_element(fixture.expected, fixture.session, fixture.context(), operation, [&] { ++fixture.mutations; }, false); }, L"failed");
    }
    for (const auto secure : {std::optional<bool>{}, std::optional<bool>{true}}) {
      fails([&] { WindowsGuard(fixture.backend()).with_element(fixture.expected, fixture.session, fixture.context(), WindowsPolicyOperation::pointer, [&] { ++fixture.mutations; }, secure); }, L"secure_field");
    }
    require(fixture.mutations == 0 && fixture.preparations == 0, "guard.element-route-only-permits-known-nonsecure-uia-actions");
  });
  test([] {
    Fixture fixture; fixture.before_fence = [&] { fixture.focused.hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(101)); };
    fails([&] { WindowsGuard(fixture.backend()).with_element(fixture.expected, fixture.session, fixture.context(), WindowsPolicyOperation::pointer, [&] { ++fixture.mutations; }, false); }, L"changed");
    require(fixture.mutations == 0, "guard.element-foreground-change-before-pattern-call");
    fixture.focused = fixture.expected; fixture.before_fence = [&] { fixture.time += 51; };
    fails([&] { WindowsGuard(fixture.backend()).with_element(fixture.expected, fixture.session, fixture.context(), WindowsPolicyOperation::pointer, [&] { ++fixture.mutations; }, false); }, L"changed");
    require(fixture.mutations == 0, "guard.element-window-proof-expired-before-pattern-call");
  });
  test([] {
    Fixture fixture; auto context = fixture.context(); context.session->run_epoch += 1;
    fails([&] { WindowsGuard(fixture.backend()).with_element(fixture.expected, fixture.session, context, WindowsPolicyOperation::pointer, [&] { ++fixture.mutations; }, false); }, L"changed");
    require(fixture.mutations == 0 && fixture.preparations == 0, "guard.element-same-wire-ids-cannot-reuse-an-accepted-run");
    fixture.before_fence = [&] { fixture.live = false; };
    fails([&] { WindowsGuard(fixture.backend()).with_element(fixture.expected, fixture.session, fixture.context(), WindowsPolicyOperation::pointer, [&] { ++fixture.mutations; }, false); }, L"changed");
    require(fixture.mutations == 0, "guard.element-cancel-before-pattern-call");
  });
  test([] {
    Fixture fixture;
    fails([&] { WindowsGuard(fixture.backend()).with_element(fixture.expected, fixture.session, fixture.context(), WindowsPolicyOperation::pointer, [&] {
      throw Failure{L"stale_ref", L"The native element proof changed."};
    }, false); }, L"stale_ref");
    require(fixture.mutations == 0, "guard.element-proof-failure-is-not-converted-to-action");
    fails([&] { WindowsGuard(fixture.backend()).with_element(fixture.expected, fixture.session, fixture.context(), WindowsPolicyOperation::pointer, [&] {
      ++fixture.mutations; throw Failure{L"changed", L"The native action could not be confirmed."};
    }, false); }, L"changed");
    require(fixture.mutations == 1, "guard.uncertain-uia-action-never-retries");
  });
  test([] {
    Fixture fixture; fixture.focused.window_class = L"ConsoleWindowClass";
    fails([&] { WindowsGuard(fixture.backend()).with_element(fixture.expected, fixture.session, fixture.context(), WindowsPolicyOperation::pointer, [&] { ++fixture.mutations; }, false); }, L"protected");
    fixture.focused = fixture.expected; fixture.session.vector_pids.Append(JsonValue::CreateNumberValue(fixture.expected.owner.process.pid));
    fails([&] { WindowsGuard(fixture.backend()).with_element(fixture.expected, fixture.session, fixture.context(), WindowsPolicyOperation::pointer, [&] { ++fixture.mutations; }, false); }, L"protected");
    require(fixture.mutations == 0, "guard.uia-element-route-retains-native-never-and-vector-floors");
  });
  test([] {
    Fixture fixture; fixture.available_surface(); fixture.click();
    require(fixture.mutations == 1, "guard.actual-normal-surface-contract-permits-owned-input");
    fixture.availability->capture_policy_blocked = true;
    fixture.type(false);
    require(fixture.mutations == 2, "guard.capture-policy-never-invents-an-input-permission");
  });
  test([] {
    Fixture fixture; fixture.available_surface(); fixture.availability->desktop.default_name = false;
    fails([&] { fixture.click(); }, L"secure_desktop");
    fails([&] { fixture.type(); }, L"secure_desktop");
    fails([&] { WindowsGuard(fixture.backend()).with_element(fixture.expected, fixture.session, fixture.context(), WindowsPolicyOperation::pointer, [&] { ++fixture.mutations; }, false); }, L"secure_desktop");
    require(fixture.mutations == 0 && fixture.preparations == 0, "guard.secure-desktop-stops-pointer-keyboard-and-uia-before-native-work");
  });
  test([] {
    Fixture fixture; fixture.available_surface();
    fixture.before_fence = [&] { fixture.availability->desktop.opened = false; };
    fails([&] { fixture.click(); }, L"secure_desktop");
    require(fixture.mutations == 0, "guard.desktop-switch-retains-typed-refusal-at-final-post-fence");
  });
  test([] {
    for (int field = 0; field < 4; ++field) {
      Fixture fixture; fixture.available_surface();
      auto& token = fixture.expected.owner.process.token;
      if (field == 0) token.elevated = true;
      if (field == 1) token.integrity = SECURITY_MANDATORY_HIGH_RID;
      if (field == 2) token.integrity = SECURITY_MANDATORY_MEDIUM_PLUS_RID;
      if (field == 3) token.ui_access = true;
      fixture.expected.physical_owner = fixture.expected.owner; fixture.pointer = fixture.expected; fixture.focused = fixture.expected;
      fails([&] { fixture.click(); }, L"elevated");
      require(fixture.mutations == 0 && fixture.preparations == 0, "guard.actual-target-token-overrides-legacy-window-flag");
    }
  });
  test([] {
    Fixture fixture; fixture.available_surface();
    fixture.expected.physical_owner.process.pid = 200; fixture.expected.physical_owner.identity.pid = 200;
    fixture.expected.physical_owner.process.token.integrity = SECURITY_MANDATORY_HIGH_RID;
    fixture.pointer = fixture.expected;
    fails([&] { fixture.click(); }, L"elevated");
    require(fixture.mutations == 0, "guard.hosted-physical-endpoint-must-also-respect-integrity");
  });
  test([] {
    for (int field = 0; field < 4; ++field) {
      Fixture fixture; fixture.available_surface(); auto& token = fixture.expected.owner.process.token;
      if (field == 0) token.user = {9};
      if (field == 1) token.logon = {9};
      if (field == 2) ++token.authentication;
      if (field == 3) ++token.session;
      fixture.expected.physical_owner = fixture.expected.owner; fixture.pointer = fixture.expected;
      fails([&] { fixture.click(); }, L"unavailable");
      require(fixture.mutations == 0, "guard.foreign-token-context-never-posts");
    }
  });
  test([] {
    Fixture fixture; fixture.available_surface(); fixture.availability->helper.reset();
    fails([&] { fixture.click(); }, L"unavailable");
    require(fixture.mutations == 0, "guard.unknown-actual-helper-token-never-defaults-medium");
  });
  test([] {
    for (int route = 0; route < 3; ++route) {
      Fixture fixture; fixture.available_surface(); size_t final_surfaces = 0;
      fixture.during_surface = [&] { if (fixture.fences != 0 && ++final_surfaces == 2) fixture.time += 51; };
      fails([&] {
        if (route == 0) fixture.click();
        if (route == 1) fixture.type();
        if (route == 2) WindowsGuard(fixture.backend()).with_element(fixture.expected, fixture.session, fixture.context(), WindowsPolicyOperation::pointer, [&] { ++fixture.mutations; }, false);
      }, L"changed");
      require(final_surfaces == 2 && fixture.mutations == 0, "guard.final-availability-read-cannot-extend-private-observation-deadline");
    }
  });
  return groups;
}
}
