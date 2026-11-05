#include "accessibility.h"
#include <algorithm>
#include <map>
#include <stdexcept>
#include <utility>

namespace vector::computer {
namespace {
void require(bool condition, const char* label) { if (!condition) throw std::runtime_error(label); }
JsonObject object(std::wstring_view json) { return JsonObject::Parse(winrt::hstring(json)); }
struct Node {
  UiaElement element;
  UiaSecurity security;
  UiaName name;
  std::wstring value;
  std::vector<UiaElement> children;
};
struct Fixture {
  ServerSession session;
  WindowsWindow window;
  WindowsWindow actual_foreground;
  std::vector<WindowsWindow> inventory;
  std::map<uint64_t, Node> nodes;
  UiaElement root = std::make_shared<WindowsUiaElement>(1), button = std::make_shared<WindowsUiaElement>(2),
      text = std::make_shared<WindowsUiaElement>(3), secure = std::make_shared<WindowsUiaElement>(4);
  UiaElement menu_leaf = std::make_shared<WindowsUiaElement>(5), menu_bar = std::make_shared<WindowsUiaElement>(6);
  UiaElement current_root = root, current_focus = text, point_element = button;
  std::map<uint64_t, UiaElement> parents;
  std::vector<UiaElement> menu_ancestors;
  std::wstring menu_accelerator, menu_access;
  bool menu_complete = true;
  size_t menu_reads = 0;
  CaptureReceipt frame;
  uint64_t clock = 100;
  bool current = true, live = true, frame_live = true, membership = true, focus_matches = true;
  bool deny_fence = false, inside_fence = false, set_result = true, partial = false, uncertain = false,detector_ready=true;
  size_t roots = 0, child_reads = 0, focused_reads = 0, point_reads = 0, performed = 0, writes = 0, attempts = 0, fences = 0, closes = 0;
  size_t max_children = 0;
  std::map<uint64_t, size_t> names, values, securities;
  std::wstring last_action;
  std::function<void()> on_prepare, on_commit, on_value, after_write,on_provider_prepare;
  std::function<void(uint64_t)> on_security;
  std::vector<Dispatcher::Result> results;
  std::unique_ptr<AccessibilityService> service;
  Fixture(bool approved = true,bool native_commit=false) {
    session.id = L"uia-service"; session.run_epoch = 100; session.observation_epoch = 200; session.revision = 1;
    window.hwnd = reinterpret_cast<HWND>(uintptr_t(42)); window.surface = window.hwnd; window.thread_id = 10; window.surface_thread_id = 10;
    auto& owner = window.owner;
    owner.identity.kind = WindowsAppKind::exe; owner.identity.name = L"Fixture"; owner.identity.exe = L"C:\\Fixture\\app.exe";
    owner.identity.publisher = L"Fixture Signer"; owner.identity.binary = L"fixture.exe"; owner.identity.verified = true; owner.identity.pid = 303;
    owner.process.pid = 303; owner.process.creation_time = 20; owner.process.image.path = owner.identity.exe; owner.process.image.size = 100;
    owner.process.image.id[0] = 1; owner.process.image.sha256[0] = 1; owner.process.image.signature = SignatureState::valid;
    window.physical_owner = owner; window.bounds = {0, 0, 800, 600}; window.surface_bounds = window.bounds;
    window.window_class = L"FixtureWindow"; window.visible = true; window.on_screen = true; window.cloaked = false;
    window.current_desktop = true; window.elevated = false; window.child_shell = false;
    actual_foreground = window; inventory = {window};
    if (approved) session.approved.Append(owner.identity.wire());
    add(root, L"Window", 50032, L"Fixture window", window.bounds, false, false);
    add(button, L"Button", 50000, L"Increment", {10, 20, 120, 30}, false, false);
    add(text, L"Edit", 50004, L"Plain field", {10, 70, 240, 30}, false, true);
    add(secure, L"Edit", 50004, L"Secure field", {10, 120, 240, 30}, true, true);
    nodes[root->identity].children = {button, text, secure}; nodes[text->identity].security.focused = true;
    nodes[text->identity].value = L"original"; nodes[secure->identity].value = L"never disclose";
    fresh_frame();
    AccessibilityBackend backend;
    backend.inventory = [this](const auto& valid) { if (!valid()) throw Failure{L"changed", L"Cancelled fixture."}; return inventory; };
    backend.foreground = [this] { return actual_foreground; };
    backend.now = [this] { return clock; };
    backend.mutation_current=[this](const ServerSession& expected){return detector_ready && expected.id==session.id && expected.run_epoch==session.run_epoch && expected.observation_epoch==session.observation_epoch && expected.revision==session.revision;};
    backend.windows.observe = [this](HWND hwnd) { for (const auto& candidate : inventory) if (candidate.hwnd == hwnd) return candidate; throw Failure{L"changed", L"The fixture window changed."}; };
    backend.windows.current = [this](const WindowsWindow& expected) {
      if (!live) return false;
      for (const auto& candidate : inventory) if (candidate.hwnd == expected.hwnd) return same_windows_window(candidate, expected);
      return false;
    };
    backend.windows.foreground = [this](const WindowsWindow& expected) { return focus_matches && same_windows_window_target(expected, actual_foreground); };
    backend.capture = [this](std::wstring_view id, const ServerSession& authority) {
      if (id != frame.id || frame.run_epoch != authority.run_epoch || frame.observation_epoch != authority.observation_epoch || frame.session_id != authority.id || frame.revision != authority.revision)
        throw Failure{L"stale_frame", L"The captured fixture frame changed."};
      return frame;
    };
    backend.capture_current = [this](const auto&, const auto&) { return frame_live; };
    backend.commit = [this](const WindowsWindow& expected, const auto&, const OperationContext& context, auto, const auto& body, auto) {
      if (on_prepare) on_prepare();
      if (!context.with_current([&] {
        ++fences; inside_fence = true;
        try {
          if (on_commit) on_commit();
          if (!live || !same_windows_window(expected, window) || !focus_matches) throw Failure{L"changed", L"The selected fixture window changed."};
          body(); inside_fence = false;
        } catch (...) { inside_fence = false; throw; }
      })) throw Failure{L"changed", L"The fixture authority changed."};
    };
    backend.uia.root = [this](const WindowsWindow& selected) { ++roots; require(selected.owner.process.pid == window.owner.process.pid, "accessibility.actual-app-root"); return current_root; };
    backend.uia.security = [this](const UiaElement& element) { ++securities[element->identity]; if (on_security) on_security(element->identity); return nodes.at(element->identity).security; };
    backend.uia.name = [this](const UiaElement& element) { ++names[element->identity]; return nodes.at(element->identity).name; };
    backend.uia.value = [this](const UiaElement& element) -> std::optional<std::wstring> {
      ++values[element->identity]; require(!nodes.at(element->identity).security.password, "accessibility.secure-value-reader-forbidden");
      if (on_value) on_value(); const auto& value = nodes.at(element->identity).value; if (value.size() > 4000) return {}; return value;
    };
    backend.uia.children = [this](const UiaElement& element, size_t limit) {
      ++child_reads; max_children = std::max(max_children, limit); const auto& children = nodes.at(element->identity).children;
      const auto count = std::min(limit, children.size()); return UiaChildren{{children.begin(), children.begin() + static_cast<ptrdiff_t>(count)}, count != children.size()};
    };
    backend.uia.parent = [this](const UiaElement& element) {
      if (element == current_root) return UiaElement{};
      const auto actual = parents.find(element->identity); return actual == parents.end() ? current_root : actual->second;
    };
    backend.uia.focused = [this](const UiaElement& observed) { ++focused_reads; require(observed == current_root, "accessibility.focus-is-app-scoped"); return current_focus; };
    backend.uia.hit = [this](const UiaElement& observed, POINT) { ++point_reads; require(observed == current_root, "accessibility.point-is-app-scoped"); return point_element; };
    backend.uia.equal = [](const UiaElement& a, const UiaElement& b) { return a && b && a->identity == b->identity; };
    backend.uia.belongs = [this](const UiaElement&, const WindowsWindow& selected) { return membership && selected.hwnd == window.hwnd; };
    backend.uia.perform = [this](const UiaElement& element, std::wstring_view action) {
      require(inside_fence, "accessibility.action-outside-authority"); ++performed;
      require((element == button || element == menu_leaf) && (action == L"AXPress" || action == L"Invoke"), "accessibility.actual-selected-action"); last_action = action; return true;
    };
    backend.uia.set_value = [this](const UiaElement& element, const std::wstring& value) {
      require(inside_fence, "accessibility.write-outside-authority"); ++attempts;
      if (nodes.at(element->identity).security.password) throw Failure{L"secure_field", L"Secure fixture field."};
      if (!set_result) return false; ++writes; nodes[element->identity].value = partial ? value + L"extra" : value;
      if (after_write) after_write();
      if (uncertain) throw Failure{L"changed", L"The fixture result is uncertain."}; return true;
    };
    backend.uia.close = [this] { ++closes; };
    backend.uia.available = [] { return true; };
    backend.uia.menu_shortcuts = [](const auto&) { return std::optional<std::vector<UiaMenuShortcut>>(std::vector<UiaMenuShortcut>{}); };
    backend.uia.menu_target = [this](const UiaElement& element, const UiaElement& observed_root) -> std::optional<UiaMenuShortcut> {
      ++menu_reads; require(observed_root == current_root, "accessibility.menu-ancestry-is-app-scoped");
      if (!menu_complete || nodes.at(element->identity).security.control_type != 50011) return {};
      std::vector<std::wstring> path; auto cursor = element;
      for (size_t depth = 0; cursor && cursor != observed_root && depth < 32; ++depth) {
        const auto& node = nodes.at(cursor->identity);
        if (node.security.pid != window.owner.process.pid) return {};
        if (node.security.control_type == 50011) { if (!node.name.complete || node.name.text.empty()) return {}; path.push_back(node.name.text); }
        else if (node.security.control_type != 50010 && node.security.control_type != 50009) return {};
        const auto parent = parents.find(cursor->identity); if (parent == parents.end()) return {}; cursor = parent->second;
      }
      if (cursor != observed_root || path.empty() || path.size() > 30) return {};
      std::reverse(path.begin(), path.end());
      return UiaMenuShortcut{std::move(path), element == menu_leaf ? menu_accelerator : L"", element == menu_leaf ? menu_access : L""};
    };
    if(native_commit)backend.uia.commit=[this](const UiaObservation& expected,const auto&,std::wstring_view action,const std::optional<std::wstring>& value,const std::function<bool()>& gate){
      require(inside_fence,"accessibility.native-job-keeps-caller-authority");if(on_provider_prepare)on_provider_prepare();require_uia_mutation_gate(gate);
      if(value){++attempts;++writes;nodes.at(expected.element->identity).value=*value;return true;}
      ++performed;last_action=action;return true;
    };
    service = std::make_unique<AccessibilityService>(std::move(backend)); service->note_session(session);
  }
  void add(const UiaElement& element, std::wstring role, int type, std::wstring name, WindowsRect bounds, bool password, bool editable) {
    Node node; node.element = element; node.name = UiaName{std::move(name), true}; node.security.pid = window.owner.process.pid;
    node.security.role = std::move(role); node.security.control_type = type; node.security.bounds = bounds; node.security.password = password;
    node.security.enabled = true; node.security.keyboard_focusable = true; node.security.value_pattern = editable;
    if (editable) node.security.read_only = false; nodes[element->identity] = std::move(node);
  }
  void fresh_frame() {
    frame.id = L"fixture-frame"; frame.display_id = L"fixture-display"; frame.session_id = session.id; frame.run_epoch = session.run_epoch;
    frame.observation_epoch = session.observation_epoch; frame.revision = session.revision; frame.generation = 1;
    frame.bounds = window.bounds; frame.width = 800; frame.height = 600; frame.image_scale = 1; frame.dpi_scale = 1; frame.window = window;
    CaptureSurface surface; surface.hwnd = window.hwnd; surface.pid = window.physical_owner.process.pid; surface.thread = window.thread_id;
    surface.bounds = window.bounds; surface.frame_bounds = window.bounds; surface.visible = true; surface.cloaked = false;
    surface.window_class = window.window_class; surface.window = window; frame.inventory.windows = {surface};
  }
  void make_menu(std::vector<std::wstring> path, std::wstring accelerator = L"", std::wstring access = L"") {
    require(!path.empty() && path.size() <= 30, "accessibility.valid-fixture-menu-path");
    menu_accelerator = std::move(accelerator); menu_access = std::move(access);
    add(menu_bar, L"MenuBar", 50010, L"", {0, 0, 800, 30}, false, false); parents[menu_bar->identity] = root;
    nodes[root->identity].children.push_back(menu_bar); auto parent = menu_bar;
    for (size_t index = 0; index < path.size(); ++index) {
      const auto item = index + 1 == path.size() ? menu_leaf : std::make_shared<WindowsUiaElement>(40 + index);
      add(item, L"MenuItem", 50011, std::move(path[index]), {10, 20, 120, 30}, false, false);
      nodes[parent->identity].children = {item}; parents[item->identity] = parent; menu_ancestors.push_back(item); parent = item;
    }
    point_element = menu_leaf;
  }
  OperationContext context() {
    return OperationContext{session, [this] { return current; }, [this](const auto& body) { if (!current || deny_fence) return false; body(); return true; }};
  }
  auto done() { return [this](Dispatcher::Result value) { results.push_back(std::move(value)); }; }
  JsonObject reply() const { require(results.size() == 1 && std::holds_alternative<Reply>(results[0]), "accessibility.expected-success"); return std::get<Reply>(results[0]).fields; }
  std::wstring code() const { require(results.size() == 1 && std::holds_alternative<Failure>(results[0]), "accessibility.expected-failure"); return std::get<Failure>(results[0]).code; }
  void reset() { results.clear(); }
  JsonObject tree_args(size_t count = 100, size_t depth = 15) const {
    JsonObject args; args.Insert(L"windowId", JsonValue::CreateStringValue(window_id(window.hwnd)));
    args.Insert(L"maxNodes", JsonValue::CreateNumberValue(static_cast<double>(count))); args.Insert(L"maxDepth", JsonValue::CreateNumberValue(static_cast<double>(depth))); return args;
  }
  JsonObject point_args() const { JsonObject args; args.Insert(L"captureId", JsonValue::CreateStringValue(frame.id)); args.Insert(L"x", JsonValue::CreateNumberValue(20)); args.Insert(L"y", JsonValue::CreateNumberValue(25)); return args; }
  JsonObject focus_args() const { return JsonObject{}; }
  std::wstring mint(std::wstring_view name = L"Plain field") {
    reset(); service->tree(tree_args(), context(), done()); const auto listed_nodes = reply().GetNamedArray(L"nodes");
    for (const auto& value : listed_nodes) if (value.GetObject().GetNamedString(L"name") == winrt::hstring(name)) { const auto ref = std::wstring(value.GetObject().GetNamedString(L"ref")); reset(); return ref; }
    throw std::runtime_error("accessibility.missing-fixture-node");
  }
  JsonObject resolve(const std::wstring& ref) { reset(); JsonObject args; args.Insert(L"ref", JsonValue::CreateStringValue(ref)); service->resolve(args, context(), done()); return reply(); }
  JsonObject action(const std::wstring& ref, std::wstring_view payload, std::wstring_view value, std::optional<std::wstring> id = {}) const {
    JsonObject args; args.Insert(L"ref", JsonValue::CreateStringValue(ref)); args.Insert(winrt::hstring(payload), JsonValue::CreateStringValue(value));
    args.Insert(L"sessionId", JsonValue::CreateStringValue(session.id)); args.Insert(L"phaseRevision", JsonValue::CreateNumberValue(static_cast<double>(*session.revision)));
    args.Insert(L"pid", JsonValue::CreateNumberValue(window.owner.process.pid)); if (id) args.Insert(L"elementId", JsonValue::CreateStringValue(*id)); return args;
  }
  void phase() { service->invalidate_observations(); ++session.observation_epoch; session.revision = *session.revision + 1; service->note_session(session); reset(); }
  UiaObservation observation() const { return UiaObservation{window, current_root, text, nodes.at(text->identity).security, clock}; }
  void structural() const {
    const auto value = reply(); require(value.GetNamedString(L"role") == L"Window" && std::wstring(value.GetNamedString(L"windowId")) == window_id(window.hwnd), "accessibility.real-window-structural-result");
    for (const auto key : {L"ref", L"elementId", L"name", L"value", L"document", L"layout", L"focusedMenuShortcuts"}) require(!value.HasKey(key), "accessibility.no-content-in-structural-result");
    require(roots == 0 && names.empty() && values.empty() && securities.empty() && point_reads == 0 && focused_reads == 0, "accessibility.structural-never-calls-uia");
  }
};
template<class Body> void stale(Body body) {
  try { body(); } catch (const Failure& error) { require(error.code == L"stale_ref" || error.code == L"changed", "accessibility.binder-refusal"); return; }
  throw std::runtime_error("accessibility.binder-missing-refusal");
}
void menu_wire(const JsonObject& value, const std::vector<std::wstring>& path, const std::optional<std::vector<std::wstring>>& shortcut = {}) {
  require(value.HasKey(L"menu") && !value.HasKey(L"menuPath") && !value.HasKey(L"menuShortcut"), "accessibility.windows-menu-is-nested-window-metadata");
  const auto menu = value.GetNamedObject(L"menu"); const auto actual = menu.GetNamedArray(L"path");
  require(actual.Size() == path.size(), "accessibility.complete-menu-path-length");
  for (uint32_t index = 0; index < actual.Size(); ++index) require(actual.GetAt(index).GetString() == winrt::hstring(path[index]), "accessibility.actual-menu-ancestor-label");
  require(menu.HasKey(L"shortcut") == shortcut.has_value(), "accessibility.known-menu-shortcut-presence");
  if (shortcut) {
    const auto keys = menu.GetNamedArray(L"shortcut"); require(keys.Size() == shortcut->size(), "accessibility.complete-menu-shortcut-length");
    for (uint32_t index = 0; index < keys.Size(); ++index) require(keys.GetAt(index).GetString() == winrt::hstring(shortcut->at(index)), "accessibility.actual-canonical-menu-shortcut");
  }
}
}

size_t run_accessibility_tests() {
  size_t groups = 0; const auto test = [&](const std::function<void()>& body) { body(); ++groups; };
  test([] { Fixture fixture; const auto features = fixture.service->features(); require(features.GetNamedBoolean(L"ui.tree") && features.GetNamedBoolean(L"ui.actions") && features.GetNamedBoolean(L"ui.secureFieldDetect"), "accessibility.actual-implemented-feature-groups"); });
  test([] {
    Fixture fixture; fixture.service->tree(fixture.tree_args(10000, 10000), fixture.context(), fixture.done());
    require(fixture.reply().GetNamedArray(L"nodes").Size() == 4 && fixture.max_children <= 400, "accessibility.bounded-tree-caps");
    Fixture limited; limited.service->tree(limited.tree_args(1, 1), limited.context(), limited.done());
    require(limited.reply().GetNamedArray(L"nodes").Size() <= 1 && limited.reply().GetNamedBoolean(L"truncated"), "accessibility.partial-tree-reports-cap");
  });
  test([] {
    Fixture fixture; auto args = fixture.tree_args(); args.Remove(L"windowId"); args.Insert(L"pid", JsonValue::CreateNumberValue(303));
    fixture.service->tree(args, fixture.context(), fixture.done()); require(fixture.reply().GetNamedArray(L"nodes").Size() == 4, "accessibility.pid-tree-uses-actual-window");
    for (const auto malformed : {LR"({"windowId":"42","maxNodes":0,"maxDepth":1})", LR"({"windowId":"42","pid":303,"maxNodes":1,"maxDepth":1})", LR"({"windowId":"42","maxNodes":1,"maxDepth":0})", LR"({"windowId":"42","maxNodes":1,"maxDepth":1,"extra":true})"}) {
      fixture.reset(); fixture.service->tree(object(malformed), fixture.context(), fixture.done()); require(fixture.code() == L"failed", "accessibility.strict-tree-args");
    }
  });
  test([] {
    Fixture fixture; fixture.service->tree(fixture.tree_args(), fixture.context(), fixture.done());
    bool found = false; for (const auto& value : fixture.reply().GetNamedArray(L"nodes")) { const auto node = value.GetObject(); if (node.GetNamedBoolean(L"secure")) { found = true; require(!node.HasKey(L"value"), "accessibility.password-value-omitted"); } }
    require(found && fixture.values[fixture.secure->identity] == 0, "accessibility.password-never-value-reader");
  });
  test([] {
    Fixture fixture(false); fixture.service->tree(fixture.tree_args(), fixture.context(), fixture.done()); require(fixture.code() == L"not_granted" && fixture.roots == 0 && fixture.names.empty(), "accessibility.tree-grant-before-content");
    Fixture protected_app; protected_app.window.window_class = L"ConsoleWindowClass"; protected_app.inventory = {protected_app.window};
    protected_app.service->tree(protected_app.tree_args(), protected_app.context(), protected_app.done()); require(protected_app.code() == L"protected" && protected_app.roots == 0, "accessibility.tree-protected-before-uia");
  });
  test([] { Fixture fixture(false); fixture.frame.window.reset(); fixture.service->hit_test(fixture.point_args(), fixture.context(), fixture.done()); fixture.structural(); });
  test([] { Fixture fixture(false); fixture.service->focused(fixture.focus_args(), fixture.context(), fixture.done()); fixture.structural(); });
  test([] {
    Fixture fixture; fixture.window.window_class = L"ConsoleWindowClass"; fixture.inventory = {fixture.window}; fixture.actual_foreground = fixture.window;
    fixture.service->focused(fixture.focus_args(), fixture.context(), fixture.done()); fixture.structural();
  });
  test([] {
    Fixture fixture; fixture.service->hit_test(fixture.point_args(), fixture.context(), fixture.done()); const auto hit = fixture.reply();
    require(hit.GetNamedString(L"role") == L"Button" && hit.HasKey(L"ref") && hit.HasKey(L"elementId") && fixture.point_reads == 1, "accessibility.actual-app-scoped-hit");
    Fixture focus; focus.service->focused(focus.focus_args(), focus.context(), focus.done()); require(focus.reply().GetNamedString(L"role") == L"Edit" && focus.focused_reads == 1, "accessibility.actual-app-scoped-focus");
  });
  test([] {
    Fixture fixture; fixture.window.owner.process.pid = 405; fixture.window.owner.process.creation_time += 1;
    fixture.window.owner.process.image.path = L"C:\\Foreign\\other.exe"; fixture.window.owner.identity.exe = fixture.window.owner.process.image.path;
    fixture.window.owner.identity.pid = 405; fixture.window.owner.identity.binary = L"other.exe"; fixture.window.physical_owner = fixture.window.owner;
    fixture.actual_foreground = fixture.window; fixture.inventory = {fixture.window};
    fixture.service->focused(fixture.focus_args(), fixture.context(), fixture.done()); fixture.structural();
    require(fixture.reply().GetNamedObject(L"owner").GetNamedNumber(L"pid") == 405, "accessibility.focus-uses-actual-foreground-owner-before-uia");
    Fixture frame; frame.frame_live = false; frame.service->hit_test(frame.point_args(), frame.context(), frame.done());
    require(frame.code() == L"stale_frame" && frame.roots == 0, "accessibility.capture-before-uia");
  });
  test([] {
    Fixture fixture; fixture.nodes[fixture.text->identity].security.pid = 404;
    fixture.service->focused(fixture.focus_args(), fixture.context(), fixture.done()); require(fixture.code() == L"stale_ref" && fixture.names[fixture.text->identity] == 0 && fixture.values[fixture.text->identity] == 0, "accessibility.foreign-element-no-content");
  });
  test([] {
    Fixture fixture; const auto first = fixture.mint(); const auto before = fixture.resolve(first); const auto second = fixture.mint();
    fixture.reset(); fixture.service->resolve(object(L"{\"ref\":\"" + first + L"\"}"), fixture.context(), fixture.done()); require(fixture.code() == L"stale_ref", "accessibility.only-latest-tree-refs");
    const auto after = fixture.resolve(second); require(first != second && before.GetNamedString(L"elementId") == after.GetNamedString(L"elementId"), "accessibility.stable-native-element-id");
  });
  test([] {
    Fixture fixture; const auto ref = fixture.mint(L"Secure field"); const auto observed = fixture.resolve(ref); fixture.reset();
    fixture.service->set_value(fixture.action(ref, L"value", L"refused", std::wstring(observed.GetNamedString(L"elementId"))), fixture.context(), fixture.done());
    require(fixture.code() == L"secure_field" && fixture.writes == 0 && fixture.values[fixture.secure->identity] == 0, "accessibility.secure-set-refusal-no-value");
  });
  test([] {
    Fixture fixture; const auto ref = fixture.mint(); fixture.reset(); fixture.service->set_value(fixture.action(ref, L"value", L"replacement"), fixture.context(), fixture.done());
    require(fixture.reply().GetNamedBoolean(L"took") && fixture.nodes[fixture.text->identity].value == L"replacement" && fixture.writes == 1 && fixture.performed == 0, "accessibility.exact-set-readback");
    for (const bool uncertain : {false, true}) {
      Fixture partial; const auto target = partial.mint(); partial.partial = !uncertain; partial.uncertain = uncertain; partial.reset();
      partial.service->set_value(partial.action(target, L"value", L"wanted"), partial.context(), partial.done());
      require(partial.code() == L"changed" && partial.writes == 1 && partial.performed == 0 && partial.attempts == 1, "accessibility.uncertain-write-never-duplicates-or-types");
    }
  });
  test([] {
    Fixture fixture; const auto ref = fixture.mint(L"Increment"); const auto before = fixture.resolve(ref); fixture.phase();
    fixture.service->perform(fixture.action(ref, L"action", L"AXPress"), fixture.context(), fixture.done()); require(fixture.code() == L"stale_ref" && fixture.performed == 0, "accessibility.phase-raw-action-stale");
    const auto refreshed = fixture.resolve(ref); require(refreshed.GetNamedString(L"ref") == before.GetNamedString(L"ref") && refreshed.GetNamedString(L"elementId") == before.GetNamedString(L"elementId"), "accessibility.explicit-resolve-preserves-receipt");
    fixture.reset(); fixture.service->perform(fixture.action(ref, L"action", L"AXPress", std::wstring(refreshed.GetNamedString(L"elementId"))), fixture.context(), fixture.done());
    require(fixture.reply().GetNamedBoolean(L"took") && fixture.performed == 1, "accessibility-refreshed-once-action");
  });
  test([] {
    for (const auto change : {0, 1, 2, 3, 4, 5}) {
      Fixture fixture; const auto ref = fixture.mint(); fixture.phase(); auto& node = fixture.nodes[fixture.text->identity];
      if (change == 0) node.name.text = L"Changed label";
      if (change == 1) node.security.role = L"Button";
      if (change == 2) node.security.bounds->x += 1;
      if (change == 3) node.security.password = true;
      if (change == 4) node.security.read_only = true;
      if (change == 5) { fixture.window.owner.process.creation_time += 1; fixture.inventory = {fixture.window}; fixture.actual_foreground = fixture.window; }
      fixture.service->resolve(object(L"{\"ref\":\"" + ref + L"\"}"), fixture.context(), fixture.done());
      require(fixture.code() == L"stale_ref" && fixture.writes == 0, "accessibility.changed-complete-receipt-facts-refused");
    }
  });
  test([] {
    Fixture fixture; const auto ref = fixture.mint(); fixture.phase(); fixture.add(std::make_shared<WindowsUiaElement>(11), L"Window", 50032, L"new root", fixture.window.bounds, false, false);
    fixture.current_root = fixture.nodes.at(11).element; fixture.service->resolve(object(L"{\"ref\":\"" + ref + L"\"}"), fixture.context(), fixture.done());
    require(fixture.code() == L"stale_ref", "accessibility.actual-root-replacement-not-label-retarget");
    Fixture incomplete; incomplete.nodes[incomplete.text->identity].name.complete = false; const auto old = incomplete.mint(); incomplete.phase();
    incomplete.service->resolve(object(L"{\"ref\":\"" + old + L"\"}"), incomplete.context(), incomplete.done()); require(incomplete.code() == L"stale_ref", "accessibility.incomplete-name-has-no-inactive-receipt");
  });
  test([] {
    Fixture fixture; const auto ref = fixture.mint(); fixture.deny_fence = true; fixture.reset();
    fixture.service->set_value(fixture.action(ref, L"value", L"denied"), fixture.context(), fixture.done());
    require(fixture.code() == L"changed" && fixture.writes == 0 && fixture.performed == 0, "accessibility.final-authority-denied-no-mutation");
  });
  test([] {
    Fixture fixture; const auto ref = fixture.mint(); fixture.on_commit = [&] { fixture.window.owner.process.creation_time += 1; };
    fixture.reset(); fixture.service->set_value(fixture.action(ref, L"value", L"denied"), fixture.context(), fixture.done());
    require(fixture.code() == L"changed" && fixture.writes == 0, "accessibility.actual-window-owner-fence-before-write");
  });
  test([] {
    Fixture fixture; const auto ref = fixture.mint(); const auto resolved = fixture.resolve(ref);
    InputExpectedTarget expected; expected.pid = fixture.window.owner.process.pid; expected.window = fixture.window.hwnd; expected.ref = ref; expected.element_id = std::wstring(resolved.GetNamedString(L"elementId"));
    const auto before = fixture.values[fixture.text->identity]; fixture.service->verify_input(fixture.observation(), expected, fixture.session);
    require(fixture.values[fixture.text->identity] == before, "accessibility.input-binding-never-reads-values");
    auto forged = expected; forged.element_id = L"forged"; stale([&] { fixture.service->verify_input(fixture.observation(), forged, fixture.session); });
    auto replacement = fixture.observation(); replacement.element = std::make_shared<WindowsUiaElement>(33); stale([&] { fixture.service->verify_input(replacement, expected, fixture.session); });
    auto owner_changed = fixture.observation(); owner_changed.window.bounds.x += 1; stale([&] { fixture.service->verify_input(owner_changed, expected, fixture.session); });
    fixture.phase(); stale([&] { fixture.service->verify_input(fixture.observation(), expected, fixture.session); });
  });
  test([] {
    Fixture fixture; const auto ref = fixture.mint(); fixture.service->invalidate_observations(true); fixture.reset();
    fixture.service->resolve(object(L"{\"ref\":\"" + ref + L"\"}"), fixture.context(), fixture.done()); require(fixture.code() == L"stale_ref", "accessibility.stop-hard-retires-receipts");
    Fixture run; const auto old = run.mint(); ++run.session.run_epoch; run.service->note_session(run.session); run.reset();
    run.service->resolve(object(L"{\"ref\":\"" + old + L"\"}"), run.context(), run.done()); require(run.code() == L"stale_ref", "accessibility.new-private-run-no-resurrection");
  });
  test([] {
    Fixture fixture; const auto ref = fixture.mint(L"Increment"); fixture.reset();
    fixture.service->perform(fixture.action(ref, L"action", L"press"), fixture.context(), fixture.done()); require(fixture.code() == L"unsupported_action" && fixture.performed == 0, "accessibility.strict-action-whitelist");
    fixture.reset(); auto malformed = fixture.action(ref, L"action", L"AXPress"); malformed.Insert(L"unexpected", JsonValue::CreateBooleanValue(true));
    fixture.service->perform(malformed, fixture.context(), fixture.done()); require(fixture.code() == L"failed" && fixture.performed == 0, "accessibility.strict-mutation-args");
  });
  test([] {
    Fixture fixture; fixture.nodes[fixture.root->identity].children = {fixture.root}; fixture.service->tree(fixture.tree_args(), fixture.context(), fixture.done());
    require(fixture.reply().GetNamedBoolean(L"truncated") && fixture.reply().GetNamedArray(L"nodes").Size() <= 1, "accessibility.cycle-bounded-partial-snapshot");
    Fixture deadline; deadline.on_security = [&](auto) { deadline.clock += 20'000; }; deadline.service->tree(deadline.tree_args(), deadline.context(), deadline.done());
    require(deadline.reply().GetNamedBoolean(L"truncated") && deadline.reply().GetNamedArray(L"nodes").Size() <= 1, "accessibility.deadline-bounded-partial-snapshot");
  });
  test([] {
    Fixture fixture; fixture.service->close(); fixture.service->tree(fixture.tree_args(), fixture.context(), fixture.done());
    require(fixture.code() == L"changed" && fixture.roots == 0 && fixture.closes == 1, "accessibility.closed-service-no-native-work");
  });
  test([] {
    Fixture fixture; const auto ref = fixture.mint(); fixture.partial = true; fixture.reset();
    fixture.service->set_value(fixture.action(ref, L"value", std::wstring(4000, L'x')), fixture.context(), fixture.done());
    require(fixture.code() == L"changed" && fixture.writes == 1 && fixture.attempts == 1, "accessibility.prefix-only-overlength-readback-never-took");
  });
  test([] {
    Fixture fixture; const auto ref = fixture.mint(); size_t at_write = 0;
    fixture.after_write = [&] { at_write = fixture.values[fixture.text->identity]; fixture.nodes[fixture.text->identity].security.password = true; }; fixture.reset();
    fixture.service->set_value(fixture.action(ref, L"value", L"new value"), fixture.context(), fixture.done());
    require(fixture.code() == L"changed" && fixture.writes == 1 && fixture.values[fixture.text->identity] == at_write, "accessibility-postwrite-secure-transition-prevents-readback");
  });
  test([] {
    Fixture fixture; fixture.service->hit_test(object(LR"({"captureId":"fixture-frame","x":1,"y":2,"unexpected":true})"), fixture.context(), fixture.done());
    require(fixture.code() == L"failed" && fixture.roots == 0, "accessibility.strict-point-args"); fixture.reset();
    fixture.service->focused(object(LR"({"pid":303})"), fixture.context(), fixture.done()); require(fixture.code() == L"failed" && fixture.roots == 0, "accessibility.strict-empty-focus-args"); fixture.reset();
    fixture.service->resolve(object(LR"({"ref":"unknown","unexpected":true})"), fixture.context(), fixture.done()); require(fixture.code() == L"failed" && fixture.roots == 0, "accessibility.strict-resolve-args");
  });
  test([] {
    Fixture fixture; fixture.service->focused(JsonObject{}, fixture.context(), fixture.done());
    require(fixture.reply().GetNamedString(L"name") == L"Plain field" && fixture.focused_reads == 1, "accessibility.desktop-empty-focused-contract");
    const auto ref = fixture.mint(L"Increment"); fixture.reset();
    fixture.service->perform(fixture.action(ref, L"action", L"Invoke"), fixture.context(), fixture.done());
    require(fixture.reply().GetNamedBoolean(L"took") && fixture.performed == 1 && fixture.last_action == L"Invoke", "accessibility.desktop-invoke-forwarded-to-actual-pattern");
  });
  test([] {
    Fixture fixture; fixture.make_menu({L"File", L"Save"}, L"Ctrl+S");
    fixture.service->tree(fixture.tree_args(), fixture.context(), fixture.done()); bool found = false;
    for (const auto& value : fixture.reply().GetNamedArray(L"nodes")) {
      const auto node = value.GetObject(); if (node.GetNamedString(L"name") != L"Save") continue;
      menu_wire(node, {L"File", L"Save"}, std::vector<std::wstring>{L"Control", L"s"});
      require(node.GetNamedString(L"role") == L"MenuItem" && node.HasKey(L"ref") && node.HasKey(L"elementId") && node.HasKey(L"bounds"), "accessibility.real-menu-node-binds-actual-window-element-lineage"); found = true;
      require(node.GetNamedNumber(L"pid") == fixture.window.owner.process.pid &&
          node.GetNamedObject(L"owner").GetNamedNumber(L"pid") == fixture.window.owner.process.pid &&
          node.GetNamedObject(L"owner").GetNamedString(L"exe") == winrt::hstring(fixture.window.owner.identity.exe) &&
          node.GetNamedString(L"windowId") == winrt::hstring(window_id(fixture.window.hwnd)), "accessibility.menu-tree-owner-pid-window-match-private-native-witness");
    }
    require(found && fixture.menu_reads > 0, "accessibility.actual-nested-menu-tree-observed");
  });
  test([] {
    Fixture fixture; fixture.make_menu({L"Fixture", L"Increment"});
    fixture.service->hit_test(fixture.point_args(), fixture.context(), fixture.done()); const auto hit = fixture.reply();
    menu_wire(hit, {L"Fixture", L"Increment"});
    require(hit.HasKey(L"ref") && hit.HasKey(L"elementId") && hit.GetNamedString(L"windowId") == L"42" && fixture.point_reads == 1,
        "accessibility.menu-hit-retains-actual-window-and-private-reference");
  });
  test([] {
    for (const bool partial : {false, true}) {
      Fixture fixture; fixture.make_menu({L"File", L"Save"}, L"Ctrl+S");
      if (partial) fixture.nodes[fixture.menu_ancestors.front()->identity].name.complete = false; else fixture.menu_complete = false;
      const auto ref = fixture.mint(L"Save"); fixture.reset();
      fixture.service->perform(fixture.action(ref, L"action", L"Invoke"), fixture.context(), fixture.done());
      require((fixture.code() == L"stale_ref" || fixture.code() == L"unsupported_action") && fixture.performed == 0 && fixture.writes == 0,
          "accessibility.unknown-or-partial-menu-evidence-never-invokes");
    }
  });
  test([] {
    Fixture fixture; fixture.make_menu({L"Tools", L"Run Macro", L"Save"}, L"Ctrl+S"); const auto ref = fixture.mint(L"Save"); fixture.reset();
    fixture.service->perform(fixture.action(ref, L"action", L"Invoke"), fixture.context(), fixture.done());
    require(fixture.code() == L"blocked" && fixture.performed == 0, "accessibility.unsafe-actual-menu-ancestor-overrides-benign-leaf");
  });
  test([] {
    Fixture fixture; fixture.make_menu({L"Outils", L"Inspecteur Web"}, L"Ctrl+Shift+I"); const auto ref = fixture.mint(L"Inspecteur Web"); fixture.reset();
    fixture.service->perform(fixture.action(ref, L"action", L"Invoke"), fixture.context(), fixture.done());
    require(fixture.code() == L"blocked" && fixture.performed == 0, "accessibility.localized-inspector-blocked-by-actual-windows-shortcut");
  });
  test([] {
    Fixture fixture; fixture.make_menu({L"File", L"Save"}, L"Ctrl+S"); const auto ref = fixture.mint(L"Save");
    const auto observed = fixture.resolve(ref); menu_wire(observed, {L"File", L"Save"}, std::vector<std::wstring>{L"Control", L"s"}); fixture.reset();
    fixture.service->perform(fixture.action(ref, L"action", L"Invoke", std::wstring(observed.GetNamedString(L"elementId"))), fixture.context(), fixture.done());
    require(fixture.reply().GetNamedBoolean(L"took") && fixture.performed == 1 && fixture.last_action == L"Invoke" && fixture.focused_reads == 0,
        "accessibility.safe-observed-save-invokes-exact-menu-pattern");
  });
  test([] {
    Fixture fixture; fixture.make_menu({L"File", L"Save"}, L"Ctrl+S"); const auto ref = fixture.mint(L"Save"); const auto original = fixture.resolve(ref);
    fixture.phase(); const auto refreshed = fixture.resolve(ref); menu_wire(refreshed, {L"File", L"Save"}, std::vector<std::wstring>{L"Control", L"s"});
    require(refreshed.GetNamedString(L"ref") == original.GetNamedString(L"ref") && refreshed.GetNamedString(L"elementId") == original.GetNamedString(L"elementId"),
        "accessibility.explicit-menu-phase-refresh-keeps-exact-lineage");
    for (const bool shortcut : {false, true}) {
      Fixture changed; changed.make_menu({L"File", L"Save"}, L"Ctrl+S"); const auto old = changed.mint(L"Save"); changed.phase();
      if (shortcut) changed.menu_accelerator = L"Ctrl+R"; else changed.nodes[changed.menu_ancestors.front()->identity].name.text = L"Other";
      changed.service->resolve(object(L"{\"ref\":\"" + old + L"\"}"), changed.context(), changed.done());
      require(changed.code() == L"stale_ref" && changed.performed == 0, "accessibility.menu-receipt-binds-actual-path-and-shortcut");
    }
  });
  test([] {
    Fixture fixture; fixture.make_menu({L"File", L"Save"}, L"Ctrl+S"); const auto ref = fixture.mint(L"Save");
    fixture.on_commit = [&] { fixture.nodes[fixture.menu_ancestors.front()->identity].name.text = L"Other"; }; fixture.reset();
    fixture.service->perform(fixture.action(ref, L"action", L"Invoke"), fixture.context(), fixture.done());
    require(fixture.code() == L"stale_ref" && fixture.performed == 0, "accessibility.menu-ancestry-drift-at-final-fence-never-invokes");
  });
  test([] {
    for (const auto kind : {0, 1, 2}) {
      Fixture fixture; fixture.make_menu({L"Edition", L"Coller"}, L"Ctrl+V");
      if (kind == 1) { fixture.current_focus = fixture.secure; fixture.nodes[fixture.secure->identity].security.focused = true; }
      if (kind == 2) {
        fixture.window.owner.identity.binary = L"Code.exe"; fixture.window.physical_owner = fixture.window.owner;
        fixture.inventory = {fixture.window}; fixture.actual_foreground = fixture.window; fixture.session.approved.Clear(); fixture.session.approved.Append(fixture.window.owner.identity.wire());
      }
      const auto ref = fixture.mint(L"Coller"); const auto value_reads = fixture.values[fixture.text->identity]; fixture.reset();
      fixture.service->perform(fixture.action(ref, L"action", L"Invoke"), fixture.context(), fixture.done());
      const auto expected = kind == 0 ? L"unsupported_action" : kind == 1 ? L"secure_field" : L"blocked";
      require(fixture.code() == expected && fixture.focused_reads > 0 && fixture.performed == 0 && fixture.writes == 0 && fixture.values[fixture.text->identity] == value_reads &&
          fixture.values[fixture.secure->identity] == 0, "accessibility.localized-paste-checks-real-focus-policy-before-explicit-no-mutation-fallback");
    }
  });
  test([]{
    Fixture fixture(true,true);const auto ref=fixture.mint();fixture.reset();
    fixture.service->set_value(fixture.action(ref,L"value",L"accepted"),fixture.context(),fixture.done());
    require(fixture.reply().GetNamedBoolean(L"took") && fixture.writes==1,"accessibility.native-metadata-gate-allows-current-private-scope");
  });
  test([]{
    for(const bool replace:{false,true}){
      Fixture fixture(true,true);const auto ref=fixture.mint();fixture.reset();
      fixture.on_provider_prepare=[&]{if(replace)++fixture.session.run_epoch;else fixture.detector_ready=false;};
      fixture.service->set_value(fixture.action(ref,L"value",L"refused"),fixture.context(),fixture.done());
      require(fixture.code()==L"changed" && fixture.writes==0 && fixture.performed==0 && fixture.attempts==0,
        "accessibility.detector-revocation-or-run-replacement-during-provider-prep-prevents-mutation");
    }
  });
  return groups;
}
}
