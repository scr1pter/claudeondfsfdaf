#include "guard.h"
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
  size_t mutations = 0, preparations = 0, fences = 0;
  std::function<void()> before_fence;
  std::vector<HWND> overlays;
  std::optional<DWORD> hit_pid;
  std::optional<std::wstring> hit_class;
  Fixture() {
    session.id = L"synthetic"; session.run_epoch = 1; session.observation_epoch = 2;
    session.approved.Append(expected.owner.identity.wire());
  }
  WindowsGuardBackend backend() {
    WindowsGuardBackend result;
    result.point = [this](POINT point, const ServerSession&) {
      ++preparations; return WindowsPointOwner{pointer, pointer.surface, point, overlays, hit_pid.value_or(pointer.owner.process.pid), pointer.surface_thread_id, hit_class.value_or(pointer.window_class)};
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
      return keyboard_current && foreground_current && same_windows_window(actual, focused);
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
  return groups;
}
}
