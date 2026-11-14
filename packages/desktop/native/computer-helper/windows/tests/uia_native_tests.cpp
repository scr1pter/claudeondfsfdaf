#include "uia_native.h"
#include <uiautomation.h>
#include <map>
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
struct PointFixture {
  UiaElement root = std::make_shared<WindowsUiaElement>(1), selected = std::make_shared<WindowsUiaElement>(2), raw = selected, normalized = selected;
  std::map<uint64_t, UiaPointMetadata> facts;
  std::map<uint64_t, UiaElement> parents;
  UiaSecurity security;
  UiaPointBackend backend;
  uint64_t elapsed = 0;
  bool alive = true, equality = true;
  size_t points = 0, normalizations = 0, metadata_reads = 0, parent_reads = 0, security_reads = 0;
  std::function<void(std::string_view)> on;
  void operation(std::string_view name) { if (on) on(name); }
  PointFixture() {
    facts[1] = {101, {1}, WindowsRect{0, 0, 100, 100}}; facts[2] = {101, {2}, WindowsRect{10, 10, 20, 20}}; parents[2] = root;
    security.pid = 101; security.control_type = 50000; security.password = false; security.enabled = true; security.bounds = facts[2].bounds;
    backend.current = [this] { if (!alive || elapsed >= 50) throw Failure{L"no_ui_tree", L"fixture ticket retired"}; };
    backend.point = [this](POINT point) { ++points; require(point.x == 15 && point.y == 15, "uia-native.overlay-actual-point"); operation("point"); return raw; };
    backend.normalize = [this](const UiaElement& value) { ++normalizations; require(value == raw, "uia-native.overlay-normalizes-actual-hit"); operation("normalize"); return normalized; };
    backend.metadata = [this](const UiaElement& value) {
      ++metadata_reads; operation("metadata"); const auto found = facts.find(value->identity);
      if (found == facts.end()) throw Failure{L"no_ui_tree", L"fixture metadata absent"}; return found->second;
    };
    backend.parent = [this](const UiaElement& value) { ++parent_reads; operation("parent"); const auto found = parents.find(value->identity); return found == parents.end() ? UiaElement{} : found->second; };
    backend.equal = [this](const UiaElement& left, const UiaElement& right) { operation("equal"); return equality && left == right; };
    backend.security = [this](const UiaElement& value) { ++security_reads; require(value == normalized, "uia-native.overlay-selected-security-only"); operation("security"); return security; };
  }
  UiaElement resolve() { return resolve_uia_overlay_point(root, POINT{15, 15}, backend); }
  bool member() { return resolve_uia_overlay_membership(root, selected, POINT{15, 15}, backend); }
};
template<class Body> void refusal(Body body) {
  try { body(); } catch (const Failure& failure) { require(failure.code == L"no_ui_tree", "uia-native.fixed-refusal"); return; }
  throw std::runtime_error("uia-native.missing-refusal");
}
}
size_t run_uia_native_tests() {
  size_t groups = 0; const auto test = [&](const std::function<void()>& body) { body(); ++groups; };
  test([] {
    PointFixture fixture; fixture.backend.point = {}; fixture.backend.normalize = {};
    for (uint64_t id = 10; id < 5010; ++id) fixture.facts[id] = {101, {static_cast<int>(id)}, WindowsRect{0, 0, 100, 100}};
    require(fixture.member() && fixture.metadata_reads == 3 && fixture.parent_reads == 1 && fixture.security_reads == 1 &&
        fixture.points == 0 && fixture.normalizations == 0, "uia-native.overlay-membership-rechecks-ancestry-without-point-or-subtree-search");
    fixture.facts[2].pid = 202; refusal([&] { fixture.member(); });
    require(fixture.security_reads == 1, "uia-native.overlay-membership-never-reuses-an-earlier-positive-proof");
  });
  test([] {
    PointFixture fixture; fixture.parents[2] = std::make_shared<WindowsUiaElement>(3); fixture.facts[3] = {101, {3}, WindowsRect{0, 0, 100, 100}};
    refusal([&] { fixture.member(); }); require(fixture.security_reads == 0, "uia-native.overlay-membership-same-process-other-root-refused");
    fixture.parents[3] = fixture.root; fixture.facts[3].pid = 202; refusal([&] { fixture.member(); });
    fixture.facts[3].pid = 101; fixture.facts[3].runtime_id = {1}; refusal([&] { fixture.member(); });
  });
  test([] {
    PointFixture fixture; fixture.parents[2] = fixture.selected; refusal([&] { fixture.member(); });
    require(fixture.parent_reads == 1 && fixture.security_reads == 0, "uia-native.overlay-membership-cycle-is-bounded");
    fixture.parents[2] = fixture.root; fixture.equality = false; refusal([&] { fixture.member(); });
  });
  test([] {
    PointFixture fixture; auto cursor = fixture.selected;
    for (uint64_t id = 3; id < 38; ++id) {
      const auto parent = std::make_shared<WindowsUiaElement>(id); fixture.parents[cursor->identity] = parent;
      fixture.facts[id] = {101, {static_cast<int>(id)}, WindowsRect{0, 0, 100, 100}}; cursor = parent;
    }
    fixture.parents[cursor->identity] = fixture.root; refusal([&] { fixture.member(); });
    require(fixture.parent_reads == 32 && fixture.security_reads == 0, "uia-native.overlay-membership-depth-cannot-expand-the-ticket");
  });
  test([] {
    PointFixture fixture; fixture.facts[2].bounds.reset(); refusal([&] { fixture.member(); });
    fixture.facts[2].bounds = WindowsRect{20, 20, 20, 20}; refusal([&] { fixture.member(); });
    fixture.facts[2].bounds = fixture.security.bounds; fixture.facts[1].runtime_id.clear(); refusal([&] { fixture.member(); });
    fixture.facts[1].runtime_id = {1}; fixture.security.password = true; refusal([&] { fixture.member(); });
    fixture.security = UiaSecurity{}; refusal([&] { fixture.member(); });
  });
  test([] {
    PointFixture fixture; fixture.security.bounds = WindowsRect{10, 10, 21, 20}; refusal([&] { fixture.member(); });
    fixture.security.bounds = fixture.facts[2].bounds; fixture.security.pid = 202; refusal([&] { fixture.member(); });
    fixture.security.pid = 101; fixture.security.enabled = false; refusal([&] { fixture.member(); });
  });
  test([] {
    for (const auto late : {"metadata", "parent", "equal", "security"}) {
      PointFixture fixture; fixture.on = [&](std::string_view operation) { if (operation == late) fixture.elapsed = 50; };
      refusal([&] { fixture.member(); }); require(fixture.points == 0 && fixture.normalizations == 0, "uia-native.overlay-membership-late-result-has-no-fallback");
    }
    PointFixture fixture; fixture.on = [&](std::string_view operation) { if (operation == "parent") fixture.alive = false; };
    refusal([&] { fixture.member(); }); require(fixture.security_reads == 0, "uia-native.overlay-membership-cancelled-proof-cannot-publish");
  });
  test([] {
    for (const auto failed : {"metadata", "parent", "equal", "security"}) {
      PointFixture fixture; fixture.on = [&](std::string_view operation) { if (operation == failed) throw Failure{L"no_ui_tree", L"fixture membership unknown"}; };
      refusal([&] { fixture.member(); });
    }
    PointFixture fixture; fixture.backend.metadata = {}; refusal([&] { fixture.member(); });
  });
  test([] {
    PointFixture fixture;
    // Thousands of unrelated nodes cannot turn a native point lookup into a subtree scan.
    for (uint64_t id = 10; id < 5010; ++id) fixture.facts[id] = {101, {static_cast<int>(id)}, WindowsRect{0, 0, 100, 100}};
    require(fixture.resolve() == fixture.selected && fixture.points == 1 && fixture.normalizations == 1 && fixture.parent_reads == 1 &&
        fixture.metadata_reads == 4 && fixture.security_reads == 1, "uia-native.overlay-point-work-follows-ancestry-not-subtree-size");
  });
  test([] {
    PointFixture fixture; fixture.raw = std::make_shared<WindowsUiaElement>(3); fixture.facts[3] = {101, {3}, WindowsRect{10, 10, 20, 20}}; fixture.parents[3] = fixture.selected;
    require(fixture.resolve() == fixture.selected && fixture.parent_reads == 2, "uia-native.overlay-raw-child-normalizes-only-to-observed-parent");
    fixture.parents[3] = fixture.root; refusal([&] { fixture.resolve(); });
  });
  test([] {
    PointFixture fixture; fixture.facts[2].pid = 202; refusal([&] { fixture.resolve(); });
    require(fixture.security_reads == 0 && fixture.parent_reads == 0, "uia-native.overlay-foreign-point-refused-before-security");
  });
  test([] {
    PointFixture fixture; fixture.parents[2] = std::make_shared<WindowsUiaElement>(3); fixture.facts[3] = {101, {3}, WindowsRect{0, 0, 100, 100}};
    refusal([&] { fixture.resolve(); }); require(fixture.security_reads == 0, "uia-native.overlay-same-process-different-root-refused");
    fixture.parents[3] = fixture.root; fixture.facts[3].pid = 202; refusal([&] { fixture.resolve(); });
  });
  test([] {
    PointFixture fixture; fixture.parents[2] = fixture.selected; refusal([&] { fixture.resolve(); });
    require(fixture.parent_reads == 1 && fixture.security_reads == 0, "uia-native.overlay-cycle-refused-without-security-or-content");
    fixture.parents[2] = fixture.root; fixture.equality = false; refusal([&] { fixture.resolve(); });
    fixture.equality = true; fixture.facts[2].runtime_id = fixture.facts[1].runtime_id; refusal([&] { fixture.resolve(); });
  });
  test([] {
    PointFixture fixture; fixture.on = [&](std::string_view operation) {
      if (operation == "metadata" && fixture.metadata_reads == 3) fixture.facts[2].runtime_id = {3};
    };
    refusal([&] { fixture.resolve(); }); require(fixture.security_reads == 0, "uia-native.overlay-normalization-cannot-change-runtime-identity");
  });
  test([] {
    PointFixture fixture;
    auto cursor = fixture.selected;
    for (uint64_t id = 3; id < 38; ++id) {
      const auto parent = std::make_shared<WindowsUiaElement>(id); fixture.parents[cursor->identity] = parent;
      fixture.facts[id] = {101, {static_cast<int>(id)}, WindowsRect{0, 0, 100, 100}}; cursor = parent;
    }
    fixture.parents[cursor->identity] = fixture.root; refusal([&] { fixture.resolve(); });
    require(fixture.parent_reads == 32 && fixture.security_reads == 0, "uia-native.overlay-ancestry-depth-is-bounded");
  });
  test([] {
    for (const auto bounds : {std::optional<WindowsRect>{}, std::optional<WindowsRect>{WindowsRect{10, 10, 0, 20}},
        std::optional<WindowsRect>{WindowsRect{20, 20, 20, 20}}, std::optional<WindowsRect>{WindowsRect{WindowsRect::bound, 0, 20, 20}}}) {
      PointFixture fixture; fixture.facts[2].bounds = bounds; refusal([&] { fixture.resolve(); }); require(fixture.security_reads == 0, "uia-native.overlay-invalid-or-offpoint-metadata-refused");
    }
    PointFixture fixture; fixture.facts[2].runtime_id.clear(); refusal([&] { fixture.resolve(); });
    fixture.facts[2].runtime_id.assign(65, 1); refusal([&] { fixture.resolve(); });
    fixture.facts[2].runtime_id = {2}; fixture.facts[1].pid = 0; refusal([&] { fixture.resolve(); });
  });
  test([] {
    PointFixture fixture; fixture.security.password = true; refusal([&] { fixture.resolve(); });
    fixture.security = UiaSecurity{}; refusal([&] { fixture.resolve(); });
    fixture.security.pid = 101; fixture.security.password = false; fixture.security.enabled = true; fixture.security.bounds = WindowsRect{10, 10, 21, 20};
    refusal([&] { fixture.resolve(); }); fixture.security.bounds = fixture.facts[2].bounds; fixture.security.pid = 202; refusal([&] { fixture.resolve(); });
  });
  test([] {
    for (const auto late : {"point", "normalize", "metadata", "parent", "equal", "security"}) {
      PointFixture fixture; fixture.on = [&](std::string_view operation) { if (operation == late) fixture.elapsed = 50; };
      refusal([&] { fixture.resolve(); }); require(fixture.points <= 1 && fixture.normalizations <= 1, "uia-native.overlay-late-work-cannot-retry-or-renew-ticket");
    }
    PointFixture fixture; fixture.on = [&](std::string_view operation) { if (operation == "parent") fixture.alive = false; };
    refusal([&] { fixture.resolve(); }); require(fixture.security_reads == 0, "uia-native.overlay-cancelled-ancestry-cannot-publish");
  });
  test([] {
    for (const auto failed : {"point", "normalize", "metadata", "parent", "equal", "security"}) {
      PointFixture fixture; fixture.on = [&](std::string_view operation) { if (operation == failed) throw Failure{L"no_ui_tree", L"fixture unknown native result"}; };
      refusal([&] { fixture.resolve(); });
    }
    PointFixture fixture; fixture.raw.reset(); refusal([&] { fixture.resolve(); });
    fixture.raw = fixture.selected; fixture.normalized.reset(); refusal([&] { fixture.resolve(); });
    fixture.normalized = fixture.selected; fixture.backend.current = {}; refusal([&] { fixture.resolve(); });
  });
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
  test([] {
    require(classify_uia_pattern_support(S_OK, true) == true, "uia-native.typed-pattern-positive-interface");
    require(classify_uia_pattern_support(UIA_E_NOTSUPPORTED, false) == false, "uia-native.typed-pattern-documented-negative-capability");
    for (const auto status : std::array<HRESULT, 6>{S_FALSE, E_FAIL, E_NOINTERFACE, E_ACCESSDENIED, static_cast<HRESULT>(UIA_E_ELEMENTNOTAVAILABLE), static_cast<HRESULT>(UIA_E_TIMEOUT)})
      for (const bool present : {false, true}) require(!classify_uia_pattern_support(status, present), "uia-native.typed-pattern-unknown-outcomes-refused");
    require(classify_uia_pattern_support(S_OK, false) == false, "uia-native.typed-pattern-successful-null-is-documented-absence");
    require(!classify_uia_pattern_support(UIA_E_NOTSUPPORTED, true), "uia-native.typed-pattern-contradictory-outcomes-refused");
  });
  test([] {
    const auto absent = classify_uia_pattern_support(S_OK, false), present = classify_uia_pattern_support(S_OK, true);
    require(absent.has_value() && present.has_value(), "uia-native.typed-pattern-proof-required-before-password-classification");
    for (const int type : {50000, 50011, 50032}) {
      require(classify_uia_password(type, {}, *absent, *absent) == false, "uia-native.documented-pattern-absence-permits-only-nontext-password-fallback");
      require(!classify_uia_password(type, {}, *present, *absent) && !classify_uia_password(type, {}, *absent, *present) &&
          !classify_uia_password(type, {}, *present, *present), "uia-native.either-present-pattern-blocks-missing-password-fallback");
    }
    for (const int type : {50004, 50025, 50030, 59999})
      require(!classify_uia_password(type, {}, *absent, *absent), "uia-native.typed-pattern-absence-cannot-unlock-text-or-custom-password");
    Fixture fixture; fixture.state.value_pattern = *present; fixture.state.text_pattern = *present;
    fixture.state.read_only = false; fixture.state.text_read_only = true; WindowsUiaObserver observer(fixture.backend, [&] { return fixture.clock; });
    require(!observer.focused(fixture.window).security.editable(), "uia-native.pattern-fallback-preserves-readonly-conflicts");
    fixture.state.text_read_only.reset();
    require(!observer.focused(fixture.window).security.editable() && fixture.values == 0 && fixture.names == 0,
        "uia-native.pattern-fallback-preserves-unknown-readonly-without-content-reads");
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
