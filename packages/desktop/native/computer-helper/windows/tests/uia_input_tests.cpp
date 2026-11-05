#include "uia_input.h"
#include <stdexcept>

namespace vector::computer {
namespace {
void require(bool value, const char* why) { if (!value) throw std::runtime_error(why); }
struct Fixture {
  WindowsWindow window;
  ServerSession session;
  UiaSecurity state;
  UiaElement root = std::make_shared<WindowsUiaElement>(1), element = std::make_shared<WindowsUiaElement>(2);
  uint64_t clock = 100;
  size_t roots = 0, names = 0, values = 0, menus = 0, closed = 0, bindings = 0;
  bool no_tree = false;
  WindowsUiaBackend backend;
  Fixture() {
    window.hwnd = reinterpret_cast<HWND>(uintptr_t(10)); window.surface = window.hwnd; window.thread_id = 1; window.surface_thread_id = 1;
    auto& owner = window.owner; owner.identity.kind = WindowsAppKind::exe; owner.identity.name = L"Fixture"; owner.identity.publisher = L"Fixture Publisher";
    owner.identity.binary = L"fixture.exe"; owner.identity.exe = L"C:\\Fixture\\fixture.exe"; owner.identity.pid = 0xf0000001U; owner.identity.verified = true;
    owner.process.pid = *owner.identity.pid; owner.process.creation_time = 10; owner.process.image.path = owner.identity.exe; owner.process.image.signature = SignatureState::valid;
    window.physical_owner = owner; window.bounds = {0, 0, 100, 100}; window.surface_bounds = window.bounds; window.window_class = L"FixtureWindow";
    window.visible = true; window.current_desktop = true; window.on_screen = true; window.cloaked = false; window.elevated = false; window.child_shell = false;
    session.id = L"fixture"; session.run_epoch = 1; session.observation_epoch = 2; session.revision = 3; session.approved.Append(owner.identity.wire());
    state.pid = owner.process.pid; state.control_type = 50004; state.role = L"Edit"; state.password = false; state.enabled = true; state.focused = true; state.keyboard_focusable = true;
    state.bounds = WindowsRect{0, 0, 100, 100}; state.value_pattern = true; state.read_only = false;
    backend.root = [this](const auto&) { ++roots; if (no_tree) throw Failure{L"no_ui_tree", L"No fixture provider."}; return root; };
    backend.focused = [this](const auto& actual) { require(actual == root, "uia-input.focus-root"); return element; };
    backend.hit = [this](const auto& actual, POINT) { require(actual == root, "uia-input.point-root"); return element; };
    backend.security = [this](const auto&) { return state; };
    backend.belongs = [](const auto&, const auto&) { return true; };
    backend.equal = [](const auto& left, const auto& right) { return left == right; };
    backend.name = [this](const auto&) { ++names; return UiaName{L"not requested", true}; };
    backend.value = [this](const auto&) { ++values; return std::optional<std::wstring>(L"not requested"); };
    backend.close = [this] { ++closed; };
    backend.menu_shortcuts = [this](const auto& actual) { require(actual == root, "uia-input.menu-root"); ++menus; return std::optional<std::vector<UiaMenuShortcut>>{{UiaMenuShortcut{{L"File", L"Save"}, L"Ctrl+S", L""}}}; };
  }
  InputObservationProvider provider(bool refs = false) {
    return uia_input_provider(backend, refs ? UiaInputBinding([this](const auto& observed, const auto& expected, const auto& scope) {
      require(observed.element == element && scope.run_epoch == session.run_epoch && expected.ref == L"actual-ref", "uia-input.native-ref-binding"); ++bindings;
    }) : UiaInputBinding{}, [&] { return clock; });
  }
};
template<class Body> void refusal(Body body, std::wstring_view code) {
  try { body(); } catch (const Failure& failure) { require(failure.code == code, "uia-input.wrong-refusal"); return; }
  throw std::runtime_error("uia-input.missing-refusal");
}
}
size_t run_uia_input_tests() {
  size_t groups = 0; const auto test = [&](const std::function<void()>& body) { body(); ++groups; };
  test([] {
    Fixture fixture; auto provider = fixture.provider(); const auto actual = provider.focused(fixture.window, fixture.session);
    require(actual.secure == false && actual.enabled && actual.focused && actual.keyboard_focusable && actual.value_pattern && actual.read_only == false && provider.fresh(actual, 50), "uia-input.actual-facts");
    require(fixture.names == 0 && fixture.values == 0 && fixture.menus == 0, "uia-input.typing-observation-does-not-read-content-or-menus");
  });
  test([] {
    Fixture fixture; fixture.state.password = true; auto provider = fixture.provider(); const auto actual = provider.focused(fixture.window, fixture.session);
    require(actual.secure == true && fixture.values == 0 && fixture.names == 0, "uia-input.actual-secure-fact-without-value");
  });
  test([] {
    Fixture fixture; fixture.session.vector_pids.Append(JsonValue::CreateNumberValue(fixture.window.owner.process.pid)); auto provider = fixture.provider();
    refusal([&] { static_cast<void>(provider.focused(fixture.window, fixture.session)); }, L"protected"); require(fixture.roots == 0, "uia-input.protected-before-uia");
  });
  test([] {
    Fixture fixture; auto provider = fixture.provider(); const auto actual = provider.focused(fixture.window, fixture.session);
    InputExpectedTarget expected; expected.pid = 11;
    refusal([&] { provider.bind(actual, expected, fixture.session); }, L"stale_ref"); expected.pid.reset(); expected.window = reinterpret_cast<HWND>(uintptr_t(11));
    refusal([&] { provider.bind(actual, expected, fixture.session); }, L"stale_ref");
  });
  test([] {
    Fixture fixture; auto provider = fixture.provider(); const auto actual = provider.focused(fixture.window, fixture.session); InputExpectedTarget expected; expected.ref = L"actual-ref";
    refusal([&] { provider.bind(actual, expected, fixture.session); }, L"stale_ref");
    auto bound = fixture.provider(true); const auto observed = bound.focused(fixture.window, fixture.session); bound.bind(observed, expected, fixture.session);
    require(fixture.bindings == 1, "uia-input.ref-never-echoed-without-real-registry-binder");
  });
  test([] {
    Fixture fixture; auto provider = fixture.provider(); const auto actual = provider.focused(fixture.window, fixture.session); ++fixture.session.observation_epoch;
    refusal([&] { provider.bind(actual, {}, fixture.session); }, L"stale_ref");
    const auto next = provider.focused(fixture.window, fixture.session); require(!provider.same(actual, next), "uia-input.exact-private-phase-scope");
  });
  test([] {
    Fixture fixture; auto provider = fixture.provider(); auto actual = provider.focused(fixture.window, fixture.session); actual.read_only = true;
    require(!provider.fresh(actual, 50), "uia-input.copied-readonly-facts-cannot-drift");
    refusal([&] { provider.bind(actual, {}, fixture.session); }, L"stale_ref");
  });
  test([] {
    Fixture fixture; fixture.no_tree = true; auto provider = fixture.provider();
    refusal([&] { static_cast<void>(provider.focused(fixture.window, fixture.session)); }, L"no_ui_tree");
    const auto point = provider.pointer(fixture.window, POINT{10, 10}, fixture.session);
    require(!point.secure && !point.value_pattern && provider.fresh(point, 50), "uia-input.structural-canvas-fallback-is-not-a-typing-proof");
    provider.bind(point, {}, fixture.session); InputExpectedTarget expected; expected.element_id = L"guessed";
    refusal([&] { provider.bind(point, expected, fixture.session); }, L"stale_ref");
    ++fixture.session.run_epoch; refusal([&] { provider.bind(point, {}, fixture.session); }, L"stale_ref");
  });
  test([] {
    Fixture fixture; auto provider = fixture.provider(); const auto actual = provider.focused(fixture.window, fixture.session);
    const auto menus = provider.menus(actual, fixture.session);
    require(menus && menus->size() == 1 && (*menus)[0].combo == std::vector<std::wstring>{L"Control", L"s"} && (*menus)[0].label == L"File Save" && fixture.menus == 1, "uia-input.actual-app-scoped-lazy-shortcut");
    provider.close(); require(fixture.closed == 1, "uia-input.owns-observer-cleanup");
  });
  test([] {
    const auto actual = parse_uia_menu_shortcuts({UiaMenuShortcut{{L"Debug", L"Start"}, L"F5", L""}, UiaMenuShortcut{{L"View"}, L"", L"Alt+V"}, UiaMenuShortcut{{L"Zoom"}, L"Ctrl++", L""}});
    require(actual && actual->size() == 3 && (*actual)[0].combo == std::vector<std::wstring>{L"f5"} && (*actual)[2].combo == std::vector<std::wstring>{L"Control", L"+"}, "uia-input-observed-semantic-menu-keys");
    require(!parse_uia_menu_shortcuts({UiaMenuShortcut{{L"Unsafe"}, L"Ctrl+KeyS", L""}}) && !parse_uia_menu_shortcuts({UiaMenuShortcut{{L"Unsafe"}, L"", L"Alt, F"}}), "uia-input-no-physical-or-sequential-menu-guess");
    require(!parse_uia_menu_shortcuts({UiaMenuShortcut{{L"Unsafe\u202e"}, L"Ctrl+S", L""}}) && !parse_uia_menu_shortcuts({UiaMenuShortcut{{std::wstring(257, L'x')}, L"Ctrl+S", L""}}), "uia-input-no-partial-or-hidden-menu-label");
  });
  test([] {
    Fixture fixture; fixture.state.value_pattern = false; fixture.state.read_only.reset(); fixture.state.text_pattern = true; fixture.state.text_read_only = false;
    auto provider = fixture.provider(); auto actual = provider.focused(fixture.window, fixture.session);
    require(actual.text_pattern && actual.text_read_only == false && actual.editable() && !actual.value_pattern && provider.fresh(actual, 50), "uia-input.rich-text-readonly-proof-propagates");
    require(fixture.names == 0 && fixture.values == 0, "uia-input.rich-text-never-reads-content");
    actual.text_read_only = true; require(!actual.editable() && !provider.fresh(actual, 50), "uia-input.text-readonly-copy-cannot-drift");
    refusal([&] { provider.bind(actual, {}, fixture.session); }, L"stale_ref");
  });
  test([] {
    Fixture fixture; fixture.no_tree = true; auto provider = fixture.provider(); auto actual = provider.pointer(fixture.window, POINT{10, 10}, fixture.session);
    actual.text_pattern = true; actual.text_read_only = false;
    require(!provider.fresh(actual, 50), "uia-input.structural-witness-cannot-be-upgraded-to-text");
    refusal([&] { provider.bind(actual, {}, fixture.session); }, L"stale_ref");
  });
  return groups;
}
}
