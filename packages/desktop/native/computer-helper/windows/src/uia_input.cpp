#include "uia_input.h"
#include "windows_policy.h"
#include <algorithm>
#include <chrono>

namespace vector::computer {
namespace {
uint64_t monotonic() { return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count()); }
[[noreturn]] void stale() { throw Failure{L"stale_ref", L"The native accessibility target changed."}; }
std::shared_ptr<UiaInputWitness> witness(const InputObservation& value) { return std::dynamic_pointer_cast<UiaInputWitness>(value.element); }
struct StructuralInputWitness final : InputElementWitness {
  WindowsWindow window;
  POINT point{};
  uint64_t sampled = 0, run_epoch = 0, observation_epoch = 0;
  std::wstring session_id;
  std::optional<uint64_t> revision;
};
template<class Witness> bool scope(const Witness& value, const ServerSession& session) {
  return value.run_epoch == session.run_epoch && value.observation_epoch == session.observation_epoch && value.session_id == session.id && value.revision == session.revision;
}
template<class Left, class Right> bool same_scope(const Left& left, const Right& right) {
  return left.run_epoch == right.run_epoch && left.observation_epoch == right.observation_epoch && left.session_id == right.session_id && left.revision == right.revision;
}
bool coherent(const InputObservation& value, const UiaObservation& actual) {
  return same_windows_window(value.window, actual.window) && value.secure == actual.security.password && value.observed_at_ms == actual.observed_at_ms &&
      value.enabled == actual.security.enabled && value.focused == actual.security.focused && value.keyboard_focusable == actual.security.keyboard_focusable &&
      value.value_pattern == actual.security.value_pattern && value.read_only == actual.security.read_only &&
      value.text_pattern == actual.security.text_pattern && value.text_read_only == actual.security.text_read_only;
}
InputObservation input(UiaObservation observation, const ServerSession& session) {
  InputObservation result; result.window = observation.window; result.secure = observation.security.password; result.observed_at_ms = observation.observed_at_ms;
  result.enabled = observation.security.enabled; result.focused = observation.security.focused; result.keyboard_focusable = observation.security.keyboard_focusable;
  result.value_pattern = observation.security.value_pattern; result.read_only = observation.security.read_only;
  result.text_pattern = observation.security.text_pattern; result.text_read_only = observation.security.text_read_only;
  result.element = std::make_shared<UiaInputWitness>(std::move(observation), session); return result;
}
std::wstring trim(std::wstring_view value) {
  while (!value.empty() && value.front() == L' ') value.remove_prefix(1);
  while (!value.empty() && value.back() == L' ') value.remove_suffix(1);
  return std::wstring(value);
}
}
std::optional<std::vector<InputMenuShortcut>> parse_uia_menu_shortcuts(const std::vector<UiaMenuShortcut>& observed, const InputKeyTextRules& rules) {
  if (observed.size() > 128) return {};
  std::vector<InputMenuShortcut> result;
  for (const auto& menu : observed) {
    if (menu.path.empty() || menu.path.size() > 30) return {};
    std::wstring label;
    for (const auto& item : menu.path) {
      if (item.empty() || item.size() > 256 || sanitize_uia(item, 256) != item) return {};
      if (!label.empty()) label += L' '; label += item;
    }
    if (label.size() > 256) return {};
    const auto& raw = menu.accelerator.empty() ? menu.access : menu.accelerator;
    if (raw.empty()) continue;
    if (raw.size() > 256 || sanitize_uia(raw, 256) != raw || raw.find(L',') != std::wstring::npos) return {};
    std::vector<std::wstring> keys;
    size_t start = 0;
    for (size_t index = 0; index <= raw.size(); ++index) {
      if (index < raw.size() && raw[index] != L'+') continue;
      auto token = trim(std::wstring_view(raw).substr(start, index - start));
      if (token.empty()) {
        if (index + 1 == raw.size() && raw[index] == L'+') { keys.push_back(L"+"); start = raw.size(); break; }
        return {};
      }
      keys.push_back(std::move(token)); start = index + 1;
    }
    const auto combo = parse_input_combo(keys, rules);
    if (!combo || combo->physical || combo->key.empty()) return {};
    std::vector<std::wstring> canonical;
    for (const auto modifier : {InputModifier::control, InputModifier::alt, InputModifier::shift, InputModifier::meta, InputModifier::alt_graph}) {
      if (!(combo->modifiers & input_modifier(modifier))) continue;
      canonical.emplace_back(modifier == InputModifier::control ? L"Control" : modifier == InputModifier::alt ? L"Alt" : modifier == InputModifier::shift ? L"Shift" : modifier == InputModifier::meta ? L"Meta" : L"AltGraph");
    }
    canonical.push_back(combo->key); result.push_back(InputMenuShortcut{std::move(canonical), std::move(label)});
  }
  return result;
}
InputObservationProvider uia_input_provider(WindowsUiaBackend backend, UiaInputBinding binding, std::function<uint64_t()> clock, InputKeyTextRules rules) {
  const auto now = clock ? std::move(clock) : std::function<uint64_t()>(monotonic);
  const auto menus = backend.menu_shortcuts;
  const auto observer = std::make_shared<WindowsUiaObserver>(std::move(backend), now);
  InputObservationProvider provider;
  provider.focused = [observer](const WindowsWindow& window, const ServerSession& session) {
    WindowsSessionPolicy(session).require(window, WindowsPolicyOperation::key);
    return input(observer->focused(window), session);
  };
  provider.pointer = [observer, now](const WindowsWindow& window, POINT point, const ServerSession& session) {
    WindowsSessionPolicy(session).require(window, WindowsPolicyOperation::pointer);
    try { return input(observer->pointer(window, point), session); }
    catch (const Failure& failure) {
      if (failure.code != L"no_ui_tree") throw;
      // Canvas/WebGL may have no element path. Only bare coordinate input can use this structural
      // fallback; bind below refuses every supplied element/ref and keyboard never uses it.
      InputObservation result; result.window = window; result.observed_at_ms = now();
      auto proof = std::make_shared<StructuralInputWitness>(); proof->window = window; proof->point = point; proof->sampled = result.observed_at_ms;
      proof->run_epoch = session.run_epoch; proof->observation_epoch = session.observation_epoch; proof->session_id = session.id; proof->revision = session.revision;
      result.element = std::move(proof); return result;
    }
  };
  provider.bind = [observer, binding, now](const InputObservation& observed, const InputExpectedTarget& expected, const ServerSession& session) {
    WindowsSessionPolicy(session).require(observed.window, WindowsPolicyOperation::observe);
    if ((expected.pid && *expected.pid != observed.window.owner.process.pid) || (expected.window && *expected.window != observed.window.hwnd)) stale();
    const auto actual = witness(observed);
    const auto structural = std::dynamic_pointer_cast<StructuralInputWitness>(observed.element);
    if ((!actual && !structural) || (actual && (!scope(*actual, session) || !observer->fresh(actual->observation) || !coherent(observed, actual->observation))) ||
        (structural && (!scope(*structural, session) || !same_windows_window(structural->window, observed.window) || observed.secure || observed.enabled || observed.focused || observed.keyboard_focusable ||
          observed.value_pattern || observed.read_only || observed.text_pattern || observed.text_read_only || structural->sampled != observed.observed_at_ms ||
          now() < structural->sampled || now() - structural->sampled > 50))) stale();
    if (expected.ref || expected.element_id) {
      if (!actual || !binding) stale();
      binding(actual->observation, expected, session);
    }
  };
  provider.same = [observer](const InputObservation& left, const InputObservation& right) {
    try {
      if (!same_windows_window(left.window, right.window) || left.secure != right.secure) return false;
      const auto a = witness(left), b = witness(right);
      if (!a || !b) {
        const auto x = std::dynamic_pointer_cast<StructuralInputWitness>(left.element), y = std::dynamic_pointer_cast<StructuralInputWitness>(right.element);
        return x && y && same_scope(*x, *y) && same_windows_window(x->window, y->window) && x->point.x == y->point.x && x->point.y == y->point.y;
      }
      return same_scope(*a, *b) && coherent(left, a->observation) && coherent(right, b->observation) && observer->same(a->observation, b->observation);
    } catch (...) { return false; }
  };
  provider.fresh = [observer, now](const InputObservation& value, uint64_t age) {
    try {
      if (const auto actual = witness(value)) return observer->fresh(actual->observation, age) && coherent(value, actual->observation);
      const auto structural = std::dynamic_pointer_cast<StructuralInputWitness>(value.element); const auto time = now();
      return structural && !value.secure && !value.enabled && !value.focused && !value.keyboard_focusable && !value.value_pattern && !value.read_only && !value.text_pattern && !value.text_read_only &&
          same_windows_window(value.window, structural->window) && structural->sampled == value.observed_at_ms && value.observed_at_ms <= time && time - value.observed_at_ms <= std::min<uint64_t>(age, 50);
    } catch (...) { return false; }
  };
  provider.menus = [menus, rules](const InputObservation& value, const ServerSession& session) -> std::optional<std::vector<InputMenuShortcut>> {
    WindowsSessionPolicy(session).require(value.window, WindowsPolicyOperation::observe);
    const auto actual = witness(value);
    if (!actual || !scope(*actual, session) || !menus || !coherent(value, actual->observation)) return {};
    const auto observed = menus(actual->observation.root); if (!observed) return {};
    return parse_uia_menu_shortcuts(*observed, rules);
  };
  provider.close = [observer] { observer->close(); };
  return provider;
}
}
