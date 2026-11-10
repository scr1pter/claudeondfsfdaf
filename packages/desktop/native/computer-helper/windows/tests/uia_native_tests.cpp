#include "uia_native.h"
#include <stdexcept>

namespace vector::computer {
namespace {
void require(bool value, const char* why) { if (!value) throw std::runtime_error(why); }
struct Fixture {
  uint64_t clock = 100;
  WindowsWindow window;
  UiaElement root = std::make_shared<WindowsUiaElement>(1), element = std::make_shared<WindowsUiaElement>(2);
  UiaSecurity state;
  bool member = true, equal = true;
  size_t names = 0, values = 0, roots = 0, focus = 0, points = 0, states = 0, closed = 0;
  std::function<void()> on_security, on_membership;
  WindowsUiaBackend backend;
  Fixture() {
    window.hwnd = reinterpret_cast<HWND>(uintptr_t(10)); window.surface = window.hwnd; window.owner.process.pid = 101;
    window.owner.process.creation_time = 20; window.physical_owner = window.owner; window.bounds = {0, 0, 100, 100}; window.surface_bounds = window.bounds;
    state.pid = 101; state.control_type = 50004; state.role = L"Edit"; state.bounds = WindowsRect{10, 10, 50, 20};
    state.password = false; state.enabled = true; state.focused = true; state.value_pattern = true; state.read_only = false;
    backend.root = [this](const auto&) { ++roots; return root; };
    backend.focused = [this](const auto& actual) { require(actual == root, "uia-native.app-scoped-focus"); ++focus; return element; };
    backend.hit = [this](const auto& actual, POINT point) { require(actual == root && point.x == 15 && point.y == 15, "uia-native.app-scoped-point"); ++points; return element; };
    backend.security = [this](const auto& actual) { require(actual == element, "uia-native.actual-object"); ++states; if (on_security) on_security(); return state; };
    backend.name = [this](const auto&) { ++names; return UiaName{L"private fixture label", true}; };
    backend.value = [this](const auto&) { ++values; return std::optional<std::wstring>(L"private fixture value"); };
    backend.belongs = [this](const auto& actual, const auto& scope) { require(actual == element && scope.hwnd == window.hwnd, "uia-native.actual-window-membership"); if (on_membership) on_membership(); return member; };
    backend.equal = [this](const auto& left, const auto& right) { return equal && left == right; };
    backend.close = [this] { ++closed; };
  }
};
template<class Body> void refusal(Body body) {
  try { body(); } catch (const Failure& failure) { require(failure.code == L"no_ui_tree", "uia-native.fixed-refusal"); return; }
  throw std::runtime_error("uia-native.missing-refusal");
}
}
size_t run_uia_native_tests() {
  size_t groups = 0; const auto test = [&](const std::function<void()>& body) { body(); ++groups; };
  test([] {
    VARIANT value{}; value.vt = VT_BOOL; value.boolVal = VARIANT_FALSE;
    require(classify_uia_keyboard_focusable(S_OK, value) == false, "uia-native.keyboard-negative-default-never-authorizes-focus");
    value.boolVal = VARIANT_TRUE;
    require(classify_uia_keyboard_focusable(S_OK, value) == true, "uia-native.keyboard-positive-boolean-required");
    for (const auto status : {E_FAIL, E_ACCESSDENIED, E_UNEXPECTED})
      require(!classify_uia_keyboard_focusable(status, value), "uia-native.keyboard-query-failure-not-defaulted");
    for (const auto kind : {VT_EMPTY, VT_NULL, VT_UNKNOWN, VT_I4, VT_BSTR}) {
      value.vt = static_cast<VARTYPE>(kind); require(!classify_uia_keyboard_focusable(S_OK, value), "uia-native.keyboard-malformed-type-not-defaulted");
    }
    value.vt = VT_BOOL; value.boolVal = 1;
    require(!classify_uia_keyboard_focusable(S_OK, value), "uia-native.keyboard-noncanonical-boolean-not-positive");
  });
  test([] { require(sanitize_uia(L"abc\n\r\txyz\u202e\u200b") == L"abcxyz", "uia-native.control-bidi-stripping"); });
  test([] { require(sanitize_uia(std::wstring(600, L'a')).size() == 500 && sanitize_uia(L"abcd", 2) == L"ab", "uia-native.string-cap"); });
  test([] {
    const std::wstring astral{wchar_t(0xd83d), wchar_t(0xde00)};
    require(sanitize_uia(astral, 1).empty() && sanitize_uia(astral, 2) == astral && sanitize_uia(std::wstring{wchar_t(0xd800), L'x', wchar_t(0xdc00)}) == L"x", "uia-native.scalar-boundary");
  });
  test([] {
    Fixture fixture; WindowsUiaObserver observer(fixture.backend, [&] { return fixture.clock; }); const auto actual = observer.focused(fixture.window);
    require(actual.root == fixture.root && actual.element == fixture.element && !actual.security.password && actual.security.editable() && observer.fresh(actual), "uia-native.real-security-seam");
    require(fixture.names == 0 && fixture.values == 0 && fixture.roots == 1 && fixture.focus == 1, "uia-native.focus-no-content-reads");
  });
  test([] {
    Fixture fixture; fixture.state.password = true; WindowsUiaObserver observer(fixture.backend, [&] { return fixture.clock; }); const auto actual = observer.focused(fixture.window);
    require(actual.security.password && fixture.values == 0 && fixture.names == 0, "uia-native.secure-input-observation-never-reads-value");
  });
  test([] {
    Fixture fixture; fixture.state.read_only = true; WindowsUiaObserver observer(fixture.backend, [&] { return fixture.clock; });
    require(!observer.focused(fixture.window).security.editable(), "uia-native.readonly-never-inferred-editable");
    fixture.state.value_pattern = false; fixture.state.read_only.reset(); require(!observer.focused(fixture.window).security.editable(), "uia-native.unsupported-value-pattern");
  });
  test([] {
    Fixture fixture; fixture.member = false; WindowsUiaObserver observer(fixture.backend, [&] { return fixture.clock; });
    refusal([&] { static_cast<void>(observer.focused(fixture.window)); }); require(fixture.names == 0 && fixture.values == 0, "uia-native.foreign-root-no-content");
  });
  test([] {
    Fixture fixture; fixture.state.pid = 202; WindowsUiaObserver observer(fixture.backend, [&] { return fixture.clock; });
    refusal([&] { static_cast<void>(observer.focused(fixture.window)); }); require(fixture.names == 0 && fixture.values == 0, "uia-native.foreign-pid-no-content");
  });
  test([] {
    Fixture fixture; fixture.state.focused = false; WindowsUiaObserver observer(fixture.backend, [&] { return fixture.clock; }); refusal([&] { static_cast<void>(observer.focused(fixture.window)); });
  });
  test([] {
    Fixture fixture; WindowsUiaObserver observer(fixture.backend, [&] { return fixture.clock; }); const auto actual = observer.pointer(fixture.window, POINT{15, 15});
    require(actual.element == fixture.element && fixture.points == 1 && fixture.names == 0 && fixture.values == 0, "uia-native.app-scoped-point-no-content");
  });
  test([] {
    Fixture fixture; fixture.state.bounds = WindowsRect{20, 20, 50, 20}; WindowsUiaObserver observer(fixture.backend, [&] { return fixture.clock; }); refusal([&] { static_cast<void>(observer.pointer(fixture.window, POINT{15, 15})); });
  });
  test([] {
    Fixture fixture; fixture.on_membership = [&] { fixture.clock += 60; }; WindowsUiaObserver observer(fixture.backend, [&] { return fixture.clock; }); const auto actual = observer.focused(fixture.window);
    require(actual.observed_at_ms == 160 && observer.fresh(actual), "uia-native-security-after-slow-membership");
  });
  test([] {
    Fixture fixture; fixture.on_security = [&] { fixture.clock += 60; }; WindowsUiaObserver observer(fixture.backend, [&] { return fixture.clock; }); const auto actual = observer.focused(fixture.window);
    require(actual.observed_at_ms == 100 && !observer.fresh(actual, 1000), "uia-native-security-clock-start-not-renewed-after-query");
  });
  test([] {
    Fixture fixture; WindowsUiaObserver observer(fixture.backend, [&] { return fixture.clock; }); const auto actual = observer.focused(fixture.window);
    fixture.clock = 99; require(!observer.fresh(actual), "uia-native-clock-rollback-fails-closed"); fixture.clock = 151; require(!observer.fresh(actual), "uia-native-freshness-upper-bound");
  });
  test([] {
    Fixture fixture; WindowsUiaObserver observer(fixture.backend, [&] { return fixture.clock; }); const auto first = observer.focused(fixture.window); auto next = first;
    require(observer.same(first, next), "uia-native.actual-element-equality"); fixture.equal = false; require(!observer.same(first, next), "uia-native-runtime-id-alone-no-equality");
    fixture.equal = true; next.security.password = true; require(!observer.same(first, next), "uia-native-secure-transition-changes-target");
    next = first; next.window.owner.process.creation_time += 1; require(!observer.same(first, next), "uia-native-process-replacement-changes-target");
  });
  test([] { Fixture fixture; WindowsUiaObserver observer(fixture.backend, [&] { return fixture.clock; }); observer.close(); require(fixture.closed == 1, "uia-native-owned-backend-close"); });
  test([] {
    require(classify_uia_password(50000, {}, false, false) == false && classify_uia_password(50011, {}, false, false) == false,
        "uia-native.documented-nontext-unsupported-password");
    for (const int type : {50004, 50025, 50030, 59999}) require(!classify_uia_password(type, {}, false, false), "uia-native.edit-custom-document-unknown-password-refused");
    require(!classify_uia_password(50000, {}, true, false) && !classify_uia_password(50000, {}, false, true), "uia-native.nontext-pattern-needs-explicit-password");
    require(classify_uia_password(50004, false, true, false) == false && classify_uia_password(50000, true, false, false) == true,
        "uia-native.explicit-password-bool-authoritative");
  });
  test([] {
    Fixture fixture; fixture.state.value_pattern = false; fixture.state.read_only.reset(); fixture.state.control_type = 50030; fixture.state.role = L"Document";
    fixture.state.text_pattern = true; fixture.state.text_read_only = false; WindowsUiaObserver observer(fixture.backend, [&] { return fixture.clock; });
    auto actual = observer.focused(fixture.window); require(actual.security.editable() && !actual.security.value_pattern && fixture.values == 0 && fixture.names == 0,
        "uia-native.rich-text-editable-without-reading-text");
    fixture.state.text_read_only.reset(); require(!observer.focused(fixture.window).security.editable(), "uia-native.unknown-mixed-text-readonly-refused");
    fixture.state.text_read_only = true; require(!observer.focused(fixture.window).security.editable(), "uia-native.text-readonly-refused");
  });
  test([] {
    Fixture fixture; fixture.state.text_pattern = true; fixture.state.text_read_only = false; WindowsUiaObserver observer(fixture.backend, [&] { return fixture.clock; });
    const auto first = observer.focused(fixture.window); require(first.security.editable(), "uia-native.both-patterns-positive-readonly-proof");
    fixture.state.read_only = true; const auto changed = observer.focused(fixture.window);
    require(!changed.security.editable() && !observer.same(first, changed), "uia-native.pattern-readonly-conflict-and-drift");
    fixture.state.read_only = false; fixture.state.text_read_only.reset(); require(!observer.focused(fixture.window).security.editable(), "uia-native.both-patterns-require-complete-proof");
  });
  return groups;
}
}
