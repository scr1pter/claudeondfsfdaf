#include "accessibility.h"
#include "windows_process_tree.h"
#include <algorithm>
#include <chrono>
#include <deque>
#include <regex>
#include <set>
#include <type_traits>

namespace vector::computer {
namespace {
[[noreturn]] void failure(std::wstring code = L"failed") { throw Failure{std::move(code), L"The accessibility target is unavailable."}; }
IJsonValue field(const JsonObject& value, std::wstring_view key) { return value.HasKey(winrt::hstring(key)) ? value.Lookup(winrt::hstring(key)) : nullptr; }
std::optional<std::wstring> text(const IJsonValue& value, size_t maximum = 256, bool empty = false) {
  if (!value || value.ValueType() != JsonValueType::String) return {};
  const auto raw = value.GetString(); if ((!empty && raw.empty()) || raw.size() > maximum || std::find(raw.begin(), raw.end(), L'\0') != raw.end()) return {};
  return std::wstring(raw.c_str(), raw.size());
}
bool keys(const JsonObject& value, std::initializer_list<std::wstring_view> allowed) {
  for (const auto& pair : value) if (std::find(allowed.begin(), allowed.end(), std::wstring_view(pair.Key())) == allowed.end()) return false; return true;
}
uint64_t now_ms() { return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count()); }
void current(const OperationContext& context) { if (!context.session || !context.is_current || !context.is_current()) failure(L"changed"); }
void phase(const JsonObject& args, const ServerSession& session) {
  if (field(args, L"sessionId") && text(field(args, L"sessionId")) != session.id) failure(L"changed");
  if (field(args, L"phaseRevision") && !safe_integer(field(args, L"phaseRevision"))) failure();
  if (session.revision && (text(field(args, L"sessionId")) != session.id || safe_integer(field(args, L"phaseRevision")) != session.revision)) failure(L"changed");
}
JsonObject structural(const WindowsWindow& window) {
  JsonObject fields; fields.Insert(L"owner", window.owner.identity.wire()); fields.Insert(L"windowId", JsonValue::CreateStringValue(window_id(window.hwnd)));
  fields.Insert(L"role", JsonValue::CreateStringValue(L"Window")); fields.Insert(L"secure", JsonValue::CreateBooleanValue(false));
  fields.Insert(L"elevated", JsonValue::CreateBooleanValue(window.elevated)); JsonObject signals;
  signals.Insert(L"windowClass", JsonValue::CreateStringValue(window.window_class)); if (window.child_shell) signals.Insert(L"childShell", JsonValue::CreateBooleanValue(*window.child_shell));
  fields.Insert(L"signals", signals); return fields;
}
template<class Body> void run_accessibility_operation(const OperationContext& context, std::atomic_bool& closed, AccessibilityRegistry& registry, const Dispatcher::Completion& done, Body body) {
  try { current(context); if (closed.load()) failure(L"changed"); auto result = body(); current(context); if (closed.load()) failure(L"changed"); done(std::move(result)); }
  catch (const Failure& error) { done(error); }
  catch (...) { done(Failure{L"no_ui_tree", L"The accessibility provider is unavailable."}); }
  // Destruction occurs after all authority fences, including on an error/timeout path.
  auto retired = registry.drain_retired();
}
template<class Body> auto publish(const OperationContext& context, Body body) -> std::invoke_result_t<Body> {
  using Result = std::invoke_result_t<Body>; std::optional<Result> result;
  if (!context.with_current || !context.with_current([&] { result = body(); }) || !result) failure(L"changed"); return std::move(*result);
}
bool menu(int type) { return type == 50011 || type == 50010 || type == 50009; }
std::optional<InputResolvedChord> menu_chord(const AccessibilityFacts& facts, const InputKeyTextRules& rules) {
  if (!facts.menu_shortcut) return {};
  const auto parsed = parse_input_combo(*facts.menu_shortcut, rules); if (!parsed || parsed->physical) failure(L"blocked");
  InputResolvedChord result; result.key = parsed->key; result.modifiers = parsed->modifiers; result.layout_fingerprint = L"observed-uia-menu"; result.complete = true; return result;
}
void require_menu(const AccessibilityFacts& facts, const InputKeyTextRules& rules) {
  if (!facts.menu_complete || !facts.menu_path || input_forbidden_menu(*facts.menu_path, rules)) failure(L"blocked");
  if (const auto chord = menu_chord(facts, rules)) {
    const auto evidence = std::vector<InputMenuShortcut>{InputMenuShortcut{*facts.menu_shortcut, facts.menu_path->back()}};
    if (!input_allowed_chord(*facts.menu_shortcut, *chord, evidence, rules)) failure(L"blocked");
  }
}
InputKeyTextRules prepared_menu_rules(const AccessibilityFacts& facts, const InputKeyTextRules& source) {
  // Unicode/NFKC observation may consult OS helpers. Record it outside Dispatcher authority, then
  // repeat the identical policy calculation at commit using immutable, exact-string evidence only.
  const auto safe = std::make_shared<std::map<std::wstring, bool>>();
  const auto normalized = std::make_shared<std::map<std::wstring, std::optional<std::wstring>>>();
  InputKeyTextRules recording;
  if (source.safe) recording.safe = [safe, check = source.safe](std::wstring_view value) { const auto result = check(value); safe->insert_or_assign(std::wstring(value), result); return result; };
  if (source.normalize_menu) recording.normalize_menu = [normalized, normalize = source.normalize_menu](std::wstring_view value) { auto result = normalize(value); normalized->insert_or_assign(std::wstring(value), result); return result; };
  require_menu(facts, recording);
  InputKeyTextRules cached;
  if (source.safe) cached.safe = [safe](std::wstring_view value) { const auto found = safe->find(std::wstring(value)); return found != safe->end() && found->second; };
  if (source.normalize_menu) cached.normalize_menu = [normalized](std::wstring_view value) -> std::optional<std::wstring> { const auto found = normalized->find(std::wstring(value)); return found == normalized->end() ? std::nullopt : found->second; };
  return cached;
}
// Known text-affecting menu actions require a separate real focused-target proof. The current
// implementation refuses their Invoke after that proof; it never treats a menu item as a text field.
std::pair<bool, bool> menu_text(const AccessibilityFacts& facts, const InputKeyTextRules& rules) {
  bool needed = false, edits = false;
  if (const auto chord = menu_chord(facts, rules)) {
    edits = input_chord_types_text(*facts.menu_shortcut, *chord, {}, rules);
    needed = edits || ((chord->modifiers & (input_modifier(InputModifier::control) | input_modifier(InputModifier::meta))) && (chord->key == L"c" || chord->key == L"a"));
  }
  if (facts.menu_path && !facts.menu_path->empty()) {
    const auto normalized = rules.normalize_menu ? rules.normalize_menu(facts.menu_path->back()) : std::optional<std::wstring>(facts.menu_path->back());
    if (normalized) {
      static const std::wregex modifying(L"(^|[^A-Za-z0-9_])(paste|cut|undo|redo|delete|backspace)(?=$|[^A-Za-z0-9_])", std::regex_constants::ECMAScript | std::regex_constants::icase);
      static const std::wregex inspecting(L"(^|[^A-Za-z0-9_])(copy|select[ ]+all)(?=$|[^A-Za-z0-9_])", std::regex_constants::ECMAScript | std::regex_constants::icase);
      edits = edits || std::regex_search(*normalized, modifying); needed = needed || edits || std::regex_search(*normalized, inspecting);
    }
  }
  return {needed, edits};
}
void menu_fields(JsonObject& fields, const AccessibilityFacts& facts) {
  if (!facts.menu_complete || !facts.menu_path) return;
  JsonObject value; JsonArray path; for (const auto& item : *facts.menu_path) path.Append(JsonValue::CreateStringValue(item)); value.Insert(L"path", path);
  if (facts.menu_shortcut) { JsonArray shortcut; for (const auto& key : *facts.menu_shortcut) shortcut.Append(JsonValue::CreateStringValue(key)); value.Insert(L"shortcut", shortcut); }
  fields.Insert(L"menu", value);
}
}

AccessibilityBackend AccessibilityBackend::system(std::shared_ptr<CaptureService> captures, WindowsUiaBackend uia) {
  AccessibilityBackend backend; backend.uia = std::move(uia); backend.windows = WindowsBackend::system(windows_child_shell);
  backend.inventory = [windows = backend.windows](const auto& valid) {
    std::vector<WindowsWindow> result;
    for (const auto& app : windows.list(false, valid)) for (const auto& window : app.windows) { if (result.size() >= 4096) failure(L"unavailable"); result.push_back(window); }
    return result;
  };
  const auto guard = std::make_shared<WindowsGuard>();
  const auto native = WindowsGuardBackend::system(); backend.foreground = native.foreground;
  backend.commit = [guard](const auto& window, const auto& session, const auto& context, auto operation, const auto& mutation, auto secure) {
    guard->with_element(window, session, context, operation, mutation, secure);
  };
  backend.capture = [captures](auto id, const auto& session) { if (!captures) failure(L"stale_frame"); return captures->receipt(id, session); };
  backend.capture_current = [captures](const auto& receipt, const auto& session) { return captures && captures->current(receipt, session); };
  backend.now = now_ms; backend.key_rules = native_input_text_rules(); return backend;
}
AccessibilityService::AccessibilityService(AccessibilityBackend backend) : backend_(std::move(backend)) { if (!backend_.now) backend_.now = now_ms; }
JsonObject AccessibilityService::features() const {
  JsonObject result; result.Insert(L"ui.tree", JsonValue::CreateBooleanValue(true)); result.Insert(L"ui.actions", JsonValue::CreateBooleanValue(true)); result.Insert(L"ui.secureFieldDetect", JsonValue::CreateBooleanValue(true)); return result;
}
void AccessibilityService::note_session(const std::optional<ServerSession>& session) { registry_.note_session(session); }
void AccessibilityService::invalidate_observations(bool hard) { if (hard) registry_.clear(); else registry_.suspend(); }
void AccessibilityService::close() { if (closed_.exchange(true)) return; registry_.close(); if (backend_.uia.close) backend_.uia.close(); auto retired = registry_.drain_retired(); }

AccessibilityService::Observation AccessibilityService::observe(UiaElement element, const WindowsWindow& window, const ServerSession& session,
                                                               const OperationContext& context, UiaElement expected_root) {
  current(context); if (closed_.load() || !backend_.windows.current(window)) failure(L"stale_ref");
  WindowsSessionPolicy(session).require(window, WindowsPolicyOperation::observe);
  auto root = backend_.uia.root(window);
  if (!root || (expected_root && !backend_.uia.equal(root, expected_root))) failure(L"stale_ref");
  const auto state = backend_.uia.security(element);
  if (state.pid != window.owner.process.pid || !backend_.uia.belongs(element, window)) failure(L"stale_ref");
  current(context); if (!backend_.windows.current(window)) failure(L"stale_ref");
  const auto name = backend_.uia.name(element);
  current(context); if (!backend_.windows.current(window)) failure(L"stale_ref");
  AccessibilityFacts facts; facts.security = state; facts.name = name; facts.owner = window.owner.identity;
  // Windows has no standard UIA file-document property. Absence is explicitly unknown, never none.
  facts.document_status = L"unknown"; UiaObservation native{window, root, element, state, backend_.now()};
  if (menu(state.control_type)) {
    facts.menu_complete = false;
    if (state.control_type == 50011 && backend_.uia.menu_target) {
      const auto raw = backend_.uia.menu_target(element, root);
      if (raw && !raw->path.empty() && raw->path.size() <= 30 && std::all_of(raw->path.begin(), raw->path.end(), [](const auto& label) { return !label.empty() && label.size() <= 256 && sanitize_uia(label, 256) == label; })) {
        const auto parsed = parse_uia_menu_shortcuts({UiaMenuShortcut{{raw->path.back()}, raw->accelerator, raw->access}}, backend_.key_rules);
        if (parsed && parsed->size() <= 1) {
          facts.menu_path = raw->path; if (!parsed->empty()) facts.menu_shortcut = parsed->front().combo; facts.menu_complete = true; native.menu = raw;
        }
      }
    }
  }
  current(context); if (!backend_.windows.current(window)) failure(L"stale_ref");
  return Observation{std::move(native), std::move(facts)};
}

Reply AccessibilityService::hit(UiaElement element, const WindowsWindow& window, const ServerSession& session, const OperationContext& context,
                                const std::optional<AccessibilityReference>& previous, bool refreshing) {
  auto observed = observe(element, window, session, context, previous ? previous->root : UiaElement{});
  if (!observed.native.security.bounds) failure(L"no_ui_tree");
  AccessibilityReference record;
  if (previous) {
    if (!same_windows_window(previous->window, window) || !backend_.uia.equal(element, previous->element)) failure(L"stale_ref");
    record = publish(context, [&] {
      if (refreshing) return registry_.refresh_receipt(*previous, element, observed.native.root, window, observed.facts, session);
      registry_.resolve(previous->ref, session); return registry_.record_facts(previous->ref, observed.facts, session);
    });
  } else record = publish(context, [&] { return registry_.register_element(element, observed.native.root, window, observed.facts, registry_.current_snapshot(session)); });
  auto fields = structural(window); fields.Insert(L"ref", JsonValue::CreateStringValue(record.ref)); fields.Insert(L"elementId", JsonValue::CreateStringValue(record.element_id));
  fields.Insert(L"role", JsonValue::CreateStringValue(observed.native.security.role)); fields.Insert(L"name", JsonValue::CreateStringValue(observed.facts.name.text));
  fields.Insert(L"secure", JsonValue::CreateBooleanValue(observed.native.security.password)); fields.Insert(L"enabled", JsonValue::CreateBooleanValue(observed.native.security.enabled));
  fields.Insert(L"editable", JsonValue::CreateBooleanValue(observed.native.security.editable())); fields.Insert(L"documentStatus", JsonValue::CreateStringValue(L"unknown"));
  menu_fields(fields, observed.facts);
  if (backend_.uia.menu_shortcuts) {
    if (const auto raw = backend_.uia.menu_shortcuts(observed.native.root)) if (const auto shortcuts = parse_uia_menu_shortcuts(*raw, backend_.key_rules)) {
      JsonArray values;
      for (const auto& shortcut : *shortcuts) { JsonObject item; JsonArray combo; for (const auto& key : shortcut.combo) combo.Append(JsonValue::CreateStringValue(key)); item.Insert(L"combo", combo); item.Insert(L"label", JsonValue::CreateStringValue(shortcut.label)); values.Append(item); }
      fields.Insert(L"focusedMenuShortcuts", values);
    }
  }
  current(context); if (!backend_.windows.current(window)) failure(L"stale_ref"); return Reply{fields, {}};
}

void AccessibilityService::tree(const JsonObject& args, const OperationContext& context, Dispatcher::Completion done) {
  run_accessibility_operation(context, closed_, registry_, done, [&]() -> Reply {
    if (!keys(args, {L"pid", L"windowId", L"maxNodes", L"maxDepth"}) || args.HasKey(L"pid") == args.HasKey(L"windowId")) failure();
    const auto count = safe_integer(field(args, L"maxNodes")), depth = safe_integer(field(args, L"maxDepth"));
    const auto pid = safe_integer(field(args, L"pid")); const auto id = text(field(args, L"windowId"));
    if (!count || !depth || !*count || !*depth || (args.HasKey(L"pid") && (!pid || !*pid || *pid > MAXDWORD)) || (args.HasKey(L"windowId") && (!id || !parse_window_id(*id)))) failure();
    const auto limit = static_cast<size_t>(std::min<uint64_t>(*count, 400)), maximum_depth = static_cast<size_t>(std::min<uint64_t>(*depth, 30));
    const auto& session = *context.session; const auto deadline = backend_.now() + 13'000;
    std::vector<WindowsWindow> windows;
    if (id) windows.push_back(backend_.windows.observe(*parse_window_id(*id)));
    else for (const auto& window : backend_.inventory(context.is_current)) if (window.owner.process.pid == *pid && eligible_windows_window(window)) windows.push_back(window);
    if (windows.empty() || windows.size() > 128) failure(L"no_ui_tree");
    for (const auto& window : windows) WindowsSessionPolicy(session).require(window, WindowsPolicyOperation::observe);
    const auto snapshot = publish(context, [&] { return registry_.begin_snapshot(session); });
    JsonArray nodes; bool truncated = false;
    for (const auto& window : windows) {
      if (nodes.Size() >= limit || backend_.now() >= deadline) { truncated = true; break; }
      auto root = backend_.uia.root(window);
      struct Node { UiaElement element; size_t depth; };
      std::deque<Node> queue{{root, 1}}; std::set<uint64_t> visited;
      while (!queue.empty()) {
        current(context); if (nodes.Size() >= limit || visited.size() >= 400 || backend_.now() >= deadline) { truncated = true; break; }
        auto node = queue.front(); queue.pop_front(); if (!node.element || !visited.insert(node.element->identity).second) { truncated = true; continue; }
        try {
          const auto security = backend_.uia.security(node.element); if (security.pid != window.owner.process.pid) failure(L"stale_ref");
          if (security.bounds) {
            auto observed = observe(node.element, window, session, context, root);
            const auto& attributes = observed.native.security; if (!attributes.bounds) failure(L"no_ui_tree");
            const auto record = publish(context, [&] { return registry_.register_element(node.element, root, window, observed.facts, snapshot); });
            JsonObject value; value.Insert(L"ref", JsonValue::CreateStringValue(record.ref)); value.Insert(L"role", JsonValue::CreateStringValue(observed.native.security.role));
            value.Insert(L"name", JsonValue::CreateStringValue(observed.facts.name.text)); value.Insert(L"bounds", attributes.bounds->wire());
            value.Insert(L"enabled", JsonValue::CreateBooleanValue(attributes.enabled)); value.Insert(L"focused", JsonValue::CreateBooleanValue(attributes.focused)); value.Insert(L"secure", JsonValue::CreateBooleanValue(attributes.password));
            if (observed.facts.menu_complete && observed.facts.menu_path) {
              menu_fields(value, observed.facts); value.Insert(L"elementId", JsonValue::CreateStringValue(record.element_id));
              value.Insert(L"owner", window.owner.identity.wire()); value.Insert(L"pid", JsonValue::CreateNumberValue(window.owner.process.pid));
              value.Insert(L"windowId", JsonValue::CreateStringValue(window_id(window.hwnd)));
            }
            if (!attributes.password && backend_.uia.value) {
              current(context); if (!backend_.windows.current(window)) failure(L"stale_ref");
              const auto fresh = backend_.uia.security(node.element);
              if (fresh.pid != window.owner.process.pid || fresh.password) failure(L"stale_ref");
              if (const auto text = backend_.uia.value(node.element)) value.Insert(L"value", JsonValue::CreateStringValue(sanitize_uia(*text)));
            }
            current(context); if (!backend_.windows.current(window)) failure(L"stale_ref");
            nodes.Append(value);
          } else truncated = true;
          const auto available = limit > nodes.Size() + queue.size() ? limit - nodes.Size() - queue.size() : 0;
          const auto children = backend_.uia.children(node.element, node.depth < maximum_depth ? available : 0);
          if (children.elements.size() > (node.depth < maximum_depth ? available : 0)) failure(L"no_ui_tree");
          if (children.truncated) truncated = true;
          if (node.depth < maximum_depth) for (const auto& element : children.elements) { if (queue.size() >= limit) { truncated = true; break; } queue.push_back(Node{element, node.depth + 1}); }
        } catch (const Failure& error) {
          if (error.code == L"changed" || error.code == L"stale_ref" || error.code == L"protected" || error.code == L"not_granted" || error.code == L"secure_desktop") throw;
          truncated = true;
        }
      }
    }
    JsonObject fields; fields.Insert(L"generation", JsonValue::CreateNumberValue(static_cast<double>(snapshot.generation))); fields.Insert(L"truncated", JsonValue::CreateBooleanValue(truncated)); fields.Insert(L"nodes", nodes); return Reply{fields, {}};
  });
}
void AccessibilityService::focused(const JsonObject& args, const OperationContext& context, Dispatcher::Completion done) {
  run_accessibility_operation(context, closed_, registry_, done, [&]() -> Reply {
    if (args.Size() != 0) failure();
    const auto window = backend_.foreground(); if (!backend_.windows.current(window)) failure(L"stale_ref");
    try { WindowsSessionPolicy(*context.session).require(window, WindowsPolicyOperation::observe); }
    catch (const Failure&) { return Reply{structural(window), {}}; }
    auto root = backend_.uia.root(window); auto element = backend_.uia.focused(root); const auto security = backend_.uia.security(element);
    if (security.pid != window.owner.process.pid || !security.focused) failure(L"stale_ref");
    return hit(element, window, *context.session, context);
  });
}
void AccessibilityService::hit_test(const JsonObject& args, const OperationContext& context, Dispatcher::Completion done) {
  run_accessibility_operation(context, closed_, registry_, done, [&]() -> Reply {
    const auto capture = text(field(args, L"captureId")); const auto x = signed_integer(field(args, L"x")), y = signed_integer(field(args, L"y"));
    if (!keys(args, {L"captureId", L"x", L"y"}) || !capture || !x || !y || !backend_.capture || !backend_.capture_current) failure();
    const auto& session = *context.session; const auto frame = backend_.capture(*capture, session); if (!backend_.capture_current(frame, session)) failure(L"stale_frame");
    const auto point = frame.point(*x, *y); WindowsWindow window;
    if (frame.window) {
      window = backend_.windows.observe(frame.window->hwnd); if (!same_windows_window(window, *frame.window)) failure(L"stale_frame");
    } else {
      const auto selected = std::find_if(frame.inventory.windows.begin(), frame.inventory.windows.end(), [&](const auto& item) {
        return item.visible && !item.minimized && !item.cloaked && !item.excluded_overlay && item.bounds.contains(point);
      });
      if (selected == frame.inventory.windows.end() || !selected->window) failure(L"protected");
      window = backend_.windows.observe(selected->hwnd); if (!same_windows_window(window, *selected->window)) failure(L"stale_frame");
    }
    try { WindowsSessionPolicy(session).require(window, WindowsPolicyOperation::observe); }
    catch (const Failure&) { return Reply{structural(window), {}}; }
    const auto root = backend_.uia.root(window); const auto element = backend_.uia.hit(root, point);
    if (!backend_.capture_current(frame, session)) failure(L"stale_frame"); return hit(element, window, session, context);
  });
}
void AccessibilityService::resolve(const JsonObject& args, const OperationContext& context, Dispatcher::Completion done) {
  run_accessibility_operation(context, closed_, registry_, done, [&]() -> Reply {
    const auto ref = text(field(args, L"ref")); if (!keys(args, {L"ref"}) || !ref) failure();
    AccessibilityReference record; bool refreshing = false;
    try { record = registry_.resolve(*ref, *context.session); } catch (const Failure&) { record = registry_.receipt(*ref, *context.session); refreshing = true; }
    const auto window = backend_.windows.observe(record.window.hwnd);
    if (!same_windows_window(window, record.window)) failure(L"stale_ref");
    return hit(record.element, window, *context.session, context, record, refreshing);
  });
}
void AccessibilityService::perform(const JsonObject& args, const OperationContext& context, Dispatcher::Completion done) { mutate(args, context, std::move(done), false); }
void AccessibilityService::set_value(const JsonObject& args, const OperationContext& context, Dispatcher::Completion done) { mutate(args, context, std::move(done), true); }
void AccessibilityService::mutate(const JsonObject& args, const OperationContext& context, Dispatcher::Completion done, bool setting) {
  run_accessibility_operation(context, closed_, registry_, done, [&]() -> Reply {
    if (!keys(args, {L"ref", L"action", L"value", L"pid", L"elementId", L"sessionId", L"phaseRevision"}) ||
        args.HasKey(setting ? L"action" : L"value")) failure();
    const auto ref = text(field(args, L"ref")), payload = text(field(args, setting ? L"value" : L"action"), setting ? 4000 : 64, setting);
    if (!ref || !payload || (field(args, L"pid") && (!safe_integer(field(args, L"pid")) || !*safe_integer(field(args, L"pid")) || *safe_integer(field(args, L"pid")) > MAXDWORD)) ||
        (field(args, L"elementId") && !text(field(args, L"elementId")))) failure();
    static const std::set<std::wstring_view> actions{L"Invoke", L"SetFocus", L"Select", L"Toggle", L"Expand", L"Collapse", L"ScrollIntoView", L"Increment", L"Decrement",
        L"AXPress", L"AXConfirm", L"AXPick", L"AXRaise", L"AXShowMenu", L"AXScrollToVisible", L"AXIncrement", L"AXDecrement"};
    if (!setting && !actions.contains(*payload)) failure(L"unsupported_action");
    const auto& session = *context.session; phase(args, session); const auto record = registry_.resolve(*ref, session);
    if ((field(args, L"pid") && safe_integer(field(args, L"pid")) != record.window.owner.process.pid) ||
        (field(args, L"elementId") && text(field(args, L"elementId")) != record.element_id)) failure(L"stale_ref");
    const auto window = backend_.windows.observe(record.window.hwnd); if (!same_windows_window(window, record.window)) failure(L"stale_ref");
    const auto prepared = observe(record.element, window, session, context, record.root);
    if (!record.facts || !record.facts->complete() || !same_accessibility_facts(*record.facts, prepared.facts)) failure(L"stale_ref");
    if (prepared.native.security.password) failure(L"secure_field");
    if (!prepared.native.security.enabled) failure(L"unsupported_action");
    const auto operation = setting ? WindowsPolicyOperation::set_value : WindowsPolicyOperation::pointer;
    WindowsSessionPolicy(session).require(window, operation, prepared.native.security.password);
    if (setting && (!prepared.native.security.editable() || !prepared.native.security.value_pattern || prepared.native.security.read_only != false)) failure(L"unsupported_action");
    InputKeyTextRules menu_rules;
    if (menu(prepared.native.security.control_type)) {
      if (setting || prepared.native.security.control_type != 50011 || !prepared.facts.menu_complete || !prepared.facts.menu_path) failure(L"unsupported_action");
      menu_rules = prepared_menu_rules(prepared.facts, backend_.key_rules);
      const auto [requires_focus, edits] = menu_text(prepared.facts, backend_.key_rules);
      if (requires_focus) {
        const auto focused = backend_.uia.focused(prepared.native.root);
        if (!focused || !backend_.uia.belongs(focused, window)) failure(L"unsupported_action");
        const auto security = backend_.uia.security(focused); if (security.pid != window.owner.process.pid || !security.focused) failure(L"stale_ref");
        if (security.password) failure(L"secure_field");
        WindowsSessionPolicy(session).require(window, edits ? WindowsPolicyOperation::type_text : WindowsPolicyOperation::observe, security.password);
        failure(L"unsupported_action");
      }
    }
    std::optional<std::wstring> original;
    if (setting) {
      original = backend_.uia.value(record.element);
      if (!original || original->size() > 4000) failure(L"unsupported_action");
    }
    bool attempted = false, accepted = false;
    backend_.commit(window, session, context, operation, [&] {
      current(context); if (closed_.load()) failure(L"changed");
      const auto active = registry_.resolve(record.ref, session);
      if (active.element->identity != record.element->identity || active.root->identity != record.root->identity || !same_windows_window(active.window, window)) failure(L"stale_ref");
      WindowsSessionPolicy(session).require(window, operation, prepared.native.security.password);
      if (menu(prepared.native.security.control_type)) require_menu(prepared.facts, menu_rules);
      if (backend_.uia.commit) {
        attempted = true;
        accepted = backend_.uia.commit(prepared.native, prepared.facts.name, setting ? std::wstring_view{} : std::wstring_view(*payload), setting ? std::optional<std::wstring>(*payload) : std::nullopt);
      } else {
        // Explicit injected backends run the same fresh-fact fence synchronously. Production uses
        // the single-job UIA commit above, with one total RPC deadline and late-result quarantine.
        const auto began = backend_.now(); const auto live = observe(record.element, window, session, context, record.root);
        if (!same_accessibility_facts(prepared.facts, live.facts) || backend_.now() - began >= 50) failure(L"stale_ref");
        WindowsSessionPolicy(session).require(window, operation, live.native.security.password);
        if (live.native.security.password) failure(L"secure_field");
        attempted = true;
        accepted = setting ? backend_.uia.set_value(record.element, *payload) : backend_.uia.perform(record.element, *payload);
      }
    }, prepared.native.security.password);
    if (!attempted) failure(L"changed"); current(context);
    const auto actual_window = backend_.windows.observe(window.hwnd);
    if (!same_windows_window(actual_window, window) || !backend_.windows.current(actual_window)) failure(L"changed");
    if (!setting) {
      if (!accepted) failure(L"unsupported_action");
      JsonObject fields; fields.Insert(L"took", JsonValue::CreateBooleanValue(true)); return Reply{fields, {}};
    }
    const auto security = backend_.uia.security(record.element);
    if (security.pid != window.owner.process.pid || security.password || !backend_.uia.belongs(record.element, actual_window)) failure(L"changed");
    const auto value = backend_.uia.value(record.element);
    current(context); if (!backend_.windows.current(actual_window) || !value || value->size() > 4000) failure(L"changed");
    const auto took = *value == *payload;
    // No blind typing after partial/uncertain provider mutation. Only an exact unchanged original
    // may truthfully report no effect, allowing the caller to choose a new explicit step.
    if (!took && *value != *original) failure(L"changed");
    JsonObject fields; fields.Insert(L"took", JsonValue::CreateBooleanValue(took)); return Reply{fields, {}};
  });
}
void AccessibilityService::verify_input(const UiaObservation& observed, const InputExpectedTarget& expected, const ServerSession& session) {
  if (closed_.load()) failure(L"stale_ref");
  WindowsSessionPolicy(session).require(observed.window, WindowsPolicyOperation::observe);
  if ((expected.pid && *expected.pid != observed.window.owner.process.pid) || (expected.window && *expected.window != observed.window.hwnd)) failure(L"stale_ref");
  if (!expected.ref && !expected.element_id) return;
  const auto record = expected.ref ? registry_.resolve(*expected.ref, session) : registry_.resolve_element(*expected.element_id, session);
  if ((expected.element_id && *expected.element_id != record.element_id) || !same_windows_window(record.window, observed.window) || !record.facts ||
      !record.facts->complete() || !backend_.uia.equal(record.element, observed.element) || !backend_.uia.equal(record.root, observed.root) ||
      !backend_.uia.belongs(observed.element, observed.window)) failure(L"stale_ref");
  const auto state = backend_.uia.security(observed.element);
  if (state.pid != observed.window.owner.process.pid) failure(L"stale_ref");
  const auto name = backend_.uia.name(observed.element);
  AccessibilityFacts facts; facts.security = state; facts.name = name; facts.owner = observed.window.owner.identity;
  if (!same_accessibility_facts(*record.facts, facts) || !backend_.windows.current(observed.window)) failure(L"stale_ref");
  const auto latest_record = registry_.resolve(record.ref, session);
  if (latest_record.element->identity != record.element->identity || latest_record.root->identity != record.root->identity) failure(L"stale_ref");
}
}
