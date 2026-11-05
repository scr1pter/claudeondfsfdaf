#include "windows_policy.h"
#include "blocklist.h"
#include "identity.h"
#include <algorithm>
#include <array>
#include <limits>
#include <set>
#include <stdexcept>

namespace vector::computer {
namespace {
bool equal(std::wstring_view left, std::wstring_view right) noexcept {
  if (left.size() != right.size() || left.size() > static_cast<size_t>(std::numeric_limits<int>::max())) return false;
  if (left.empty()) return true;
  return CompareStringOrdinal(left.data(), static_cast<int>(left.size()), right.data(), static_cast<int>(right.size()), TRUE) == CSTR_EQUAL;
}
bool member(std::wstring_view value, std::initializer_list<std::wstring_view> values) noexcept {
  return std::any_of(values.begin(), values.end(), [&](const auto candidate) { return equal(candidate, value); });
}
bool never(std::wstring_view category) noexcept {
  return member(category, {L"vector", L"terminal", L"scripting", L"password-manager", L"security", L"remote-viewer"});
}
bool category_name(std::wstring_view category) noexcept {
  return never(category) || member(category, {L"browser", L"files", L"mail", L"messaging", L"finance", L"developer", L"office", L"creative", L"simulator", L"system-ui", L"general"});
}
std::wstring reason(std::wstring_view category) {
  if (category == L"vector") return L"vector";
  if (category == L"terminal" || category == L"scripting") return L"terminal";
  if (category == L"password-manager") return L"passwords";
  if (category == L"remote-viewer") return L"remote";
  return L"security";
}
IJsonValue field(const JsonObject& object, std::wstring_view name) {
  return object.GetNamedValue(winrt::hstring(name), nullptr);
}
std::optional<std::wstring> string(const IJsonValue& value, size_t limit, bool empty = false) {
  if (!value || value.ValueType() != JsonValueType::String) return {};
  const auto text = value.GetString();
  if ((!empty && text.empty()) || text.size() > limit) return {};
  for (const auto unit : text) if (unit < 0x20 || (unit >= 0x7f && unit <= 0x9f) || unit == 0x061c ||
      (unit >= 0x200b && unit <= 0x200f) || (unit >= 0x2028 && unit <= 0x202e) ||
      (unit >= 0x2060 && unit <= 0x2069) || unit == 0xfeff) return {};
  return std::wstring(text.c_str(), text.size());
}
std::optional<bool> boolean(const IJsonValue& value) {
  return value && value.ValueType() == JsonValueType::Boolean ? std::optional<bool>(value.GetBoolean()) : std::nullopt;
}
bool exact_keys(const JsonObject& object, std::initializer_list<std::wstring_view> allowed) {
  for (const auto& entry : object) if (std::find(allowed.begin(), allowed.end(), std::wstring_view(entry.Key())) == allowed.end()) return false;
  return true;
}
std::vector<std::wstring> patterns(const JsonObject& object, std::wstring_view name) {
  const auto value = field(object, name);
  if (!value) return {};
  if (value.ValueType() != JsonValueType::Array || value.GetArray().Size() > 4096) throw std::runtime_error("policy.invalid-patterns");
  std::vector<std::wstring> result;
  for (const auto& item : value.GetArray()) {
    const auto text = string(item, 512);
    if (!text || (text->find(L'*') != std::wstring::npos && text->find(L'*') != text->size() - 1)) throw std::runtime_error("policy.invalid-pattern");
    result.push_back(*text);
  }
  return result;
}
bool matches_entry(const WindowsBlocklist::Entry& entry, const WindowsAppIdentity& identity, const WindowsPolicySignals& signals) noexcept {
  const auto matching = [](const auto& values, std::wstring_view actual) {
    return std::any_of(values.begin(), values.end(), [&](const auto& pattern) { return WindowsBlocklist::matches(pattern, actual); });
  };
  if (!signals.window_class.empty() && matching(entry.window_classes, signals.window_class)) return true;
  return identity.kind == WindowsAppKind::aumid ? matching(entry.aumids, identity.aumid) : matching(entry.binaries, identity.binary);
}
std::optional<WindowsAppIdentity> approval(const IJsonValue& value) {
  if (!value || value.ValueType() != JsonValueType::Object) return {};
  const auto object = value.GetObject();
  const auto platform = string(field(object, L"platform"), 16), kind = string(field(object, L"kind"), 16);
  const auto verified = boolean(field(object, L"verified")), system = boolean(field(object, L"system"));
  const auto name = string(field(object, L"name"), 256, true);
  if (platform != L"windows" || !kind || !verified || !system || !name) return {};
  WindowsAppIdentity result;
  result.verified = *verified; result.system = *system; result.name = *name;
  if (const auto pid_value = field(object, L"pid")) {
    const auto pid = safe_integer(pid_value);
    if (!pid || *pid == 0 || *pid > std::numeric_limits<DWORD>::max()) return {};
    result.pid = static_cast<DWORD>(*pid);
  }
  if (const auto path = field(object, L"exe")) {
    const auto exe = string(path, 32'767);
    if (!exe) return {};
    result.exe = *exe;
  }
  if (*kind == L"aumid") {
    if (!exact_keys(object, {L"platform", L"kind", L"aumid", L"publisher", L"name", L"verified", L"system", L"pid", L"exe"})) return {};
    const auto aumid = string(field(object, L"aumid"), 512);
    if (!aumid) return {};
    result.kind = WindowsAppKind::aumid; result.aumid = *aumid;
    if (const auto publisher = field(object, L"publisher")) {
      const auto observed = string(publisher, 256, true);
      if (!observed) return {};
      result.publisher = *observed;
    }
  } else if (*kind == L"exe") {
    if (!exact_keys(object, {L"platform", L"kind", L"publisher", L"product", L"binary", L"name", L"verified", L"system", L"pid", L"exe"})) return {};
    const auto publisher = string(field(object, L"publisher"), 256, true), product = string(field(object, L"product"), 256, true), binary = string(field(object, L"binary"), 260);
    if (!publisher || !product || !binary || result.exe.empty()) return {};
    result.publisher = *publisher; result.product = *product; result.binary = *binary;
  } else return {};
  if (!result.verified && (!result.pid || result.exe.empty() || result.system)) return {};
  return result;
}
bool same_approval(const WindowsAppIdentity& granted, const WindowsAppIdentity& actual) noexcept {
  if (granted.kind != actual.kind || granted.verified != actual.verified || granted.system != actual.system || !equal(granted.publisher, actual.publisher)) return false;
  if (actual.kind == WindowsAppKind::aumid ? !equal(granted.aumid, actual.aumid) :
      !equal(granted.product, actual.product) || !equal(granted.binary, actual.binary)) return false;
  return actual.verified || (actual.pid && granted.pid == actual.pid && equal(granted.exe, actual.exe));
}
bool contains_pid(const JsonArray& values, DWORD pid) {
  for (const auto& value : values) if (safe_integer(value) == pid) return true;
  return false;
}
bool contains_window(const JsonArray& values, HWND window) {
  for (const auto& value : values) {
    const auto text = string(value, 256);
    if (text && parse_window_id(*text) == window) return true;
  }
  return false;
}
bool excluded(const WindowsWindow& window, const ServerSession& session, DWORD helper_pid) {
  for (const auto pid : {window.owner.process.pid, window.physical_owner.process.pid}) {
    if (pid == helper_pid || contains_pid(session.vector_pids, pid)) return true;
  }
  for (const auto hwnd : {window.hwnd, window.surface}) {
    if (contains_window(session.vector_window_ids, hwnd) || contains_window(session.overlay_window_ids, hwnd)) return true;
  }
  return false;
}
bool coherent(const WindowsOwner& owner) noexcept {
  if (owner.process.pid == 0 || owner.process.creation_time == 0 || owner.identity.pid != owner.process.pid ||
      owner.process.image.path.empty() || !equal(owner.identity.exe, owner.process.image.path)) return false;
  if (owner.identity.kind == WindowsAppKind::aumid) return windows_package_identity_matches(owner.identity, owner.process);
  return !owner.process.package && (!owner.identity.verified || owner.process.image.signature == SignatureState::valid);
}
bool notification(const WindowsWindow& window) noexcept {
  if (member(window.window_class, {L"ToastChildWindowClass", L"ToastWindowClass"})) return true;
  // Explorer's Run dialog has no distinct process identity. Its native modal-dialog class is
  // never treated as an ordinary File Explorer window, regardless of the displayed caption.
  return window.owner.identity.system && equal(window.owner.identity.binary, L"explorer.exe") && equal(window.window_class, L"#32770");
}
WindowsPolicySignals signals(const WindowsWindow& window) { return {window.window_class, window.child_shell}; }
[[noreturn]] void fail(std::wstring code, std::wstring message) { throw Failure{std::move(code), std::move(message)}; }
const WindowsBlocklist& generated_rules() {
  static const auto rules = WindowsBlocklist::generated();
  return rules;
}
}

WindowsBlocklist WindowsBlocklist::generated() {
  std::string json;
  for (const auto part : blocklist::kJsonParts) json += part;
  return WindowsBlocklist(json);
}
WindowsBlocklist::WindowsBlocklist(std::string_view json) {
  if (json.empty() || json.size() > 1'048'576) throw std::runtime_error("policy.invalid-size");
  const auto root = JsonObject::Parse(winrt::to_hstring(json));
  if (!exact_keys(root, {L"schemaVersion", L"source", L"match", L"never", L"noAlways", L"clickOnly", L"reasons", L"rules", L"entries"}) ||
      safe_integer(field(root, L"schemaVersion")) != 1 || string(field(root, L"source"), 256) != L"packages/schema/src/computer-apps.ts") throw std::runtime_error("policy.invalid-schema");
  const auto never_values = patterns(root, L"never"), click_values = patterns(root, L"clickOnly");
  if (never_values.size() != 6 || !std::all_of(never_values.begin(), never_values.end(), [](const auto& value) { return never(value); }) ||
      std::set<std::wstring>(never_values.begin(), never_values.end()).size() != 6 || click_values != std::vector<std::wstring>{L"developer"}) throw std::runtime_error("policy.invalid-categories");
  for (const auto& value : patterns(root, L"noAlways")) if (!category_name(value)) throw std::runtime_error("policy.invalid-categories");
  const auto match = field(root, L"match"), reasons = field(root, L"reasons"), rules = field(root, L"rules");
  if (!match || match.ValueType() != JsonValueType::Object ||
      !exact_keys(match.GetObject(), {L"case", L"wildcard", L"macos", L"windows"}) ||
      string(field(match.GetObject(), L"case"), 32) != L"insensitive" ||
      !string(field(match.GetObject(), L"wildcard"), 512) || !string(field(match.GetObject(), L"macos"), 512) || !string(field(match.GetObject(), L"windows"), 512) ||
      !reasons || reasons.ValueType() != JsonValueType::Object || reasons.GetObject().Size() != 6 ||
      !rules || rules.ValueType() != JsonValueType::Array || rules.GetArray().Size() != 7) throw std::runtime_error("policy.invalid-contract");
  for (const auto category : {L"vector", L"terminal", L"scripting", L"password-manager", L"security", L"remote-viewer"}) {
    if (string(field(reasons.GetObject(), category), 64) != reason(category)) throw std::runtime_error("policy.invalid-reason");
  }
  size_t rule_index = 0;
  for (const auto id : {L"never", L"child-shell", L"system-ui", L"system", L"listed", L"enforce", L"click-only"}) {
    const auto value = rules.GetArray().GetAt(static_cast<uint32_t>(rule_index++));
    if (value.ValueType() != JsonValueType::Object || string(field(value.GetObject(), L"id"), 64) != id ||
        !string(field(value.GetObject(), L"rule"), 4096)) throw std::runtime_error("policy.invalid-rule");
  }
  const auto raw = field(root, L"entries");
  if (!raw || raw.ValueType() != JsonValueType::Array || raw.GetArray().Size() == 0 || raw.GetArray().Size() > 4096) throw std::runtime_error("policy.invalid-entries");
  std::set<std::wstring> keys;
  bool passed_never = false;
  for (const auto& value : raw.GetArray()) {
    if (value.ValueType() != JsonValueType::Object) throw std::runtime_error("policy.invalid-entry");
    const auto row = value.GetObject();
    const auto key = string(field(row, L"key"), 256), category = string(field(row, L"category"), 64), list = string(field(row, L"list"), 64);
    if (!key || !category || !list || !category_name(*category) || !keys.insert(*key).second ||
        !member(*list, {L"never", L"system-ui", L"default-blocked", L"benign-system", L"categorized"}) ||
        (*list == L"never") != never(*category) || (passed_never && *list == L"never") ||
        (*list == L"system-ui") != (*category == L"system-ui") ||
        (*list == L"never" && boolean(field(row, L"removable")) != false) ||
        (*list == L"default-blocked" && boolean(field(row, L"removable")) != true)) throw std::runtime_error("policy.invalid-entry");
    if (*list != L"never") passed_never = true;
    Entry entry{*key, *category, *list, {}, {}, {}};
    if (const auto windows = field(row, L"windows")) {
      if (windows.ValueType() != JsonValueType::Object || !exact_keys(windows.GetObject(), {L"aumid", L"binary", L"windowClass"})) throw std::runtime_error("policy.invalid-windows-entry");
      entry.aumids = patterns(windows.GetObject(), L"aumid"); entry.binaries = patterns(windows.GetObject(), L"binary"); entry.window_classes = patterns(windows.GetObject(), L"windowClass");
    }
    entries_.push_back(std::move(entry));
  }
}
bool WindowsBlocklist::matches(std::wstring_view pattern, std::wstring_view value) noexcept {
  return !pattern.empty() && pattern.back() == L'*' ? value.size() >= pattern.size() - 1 && equal(pattern.substr(0, pattern.size() - 1), value.substr(0, pattern.size() - 1)) : equal(pattern, value);
}
std::wstring WindowsBlocklist::category(const WindowsAppIdentity& identity, const WindowsPolicySignals& observed) const {
  if (identity.system && !identity.verified) return L"security";
  const auto listed = std::find_if(entries_.begin(), entries_.end(), [&](const auto& entry) { return matches_entry(entry, identity, observed); });
  if (listed != entries_.end() && never(listed->category)) return listed->category;
  if (observed.child_shell == true && (listed == entries_.end() || listed->category != L"developer")) return L"terminal";
  if (listed != entries_.end() && listed->category == L"system-ui") return L"system-ui";
  const auto exception = std::any_of(entries_.begin(), entries_.end(), [&](const auto& entry) {
    return (entry.list == L"benign-system" || entry.list == L"default-blocked") && matches_entry(entry, identity, observed);
  });
  if (identity.system && !exception) return L"security";
  return listed == entries_.end() ? L"general" : listed->category;
}
std::optional<std::wstring> WindowsBlocklist::refusal(const WindowsAppIdentity& identity, const WindowsPolicySignals& observed) const {
  const auto value = category(identity, observed);
  return never(value) || value == L"system-ui" ? std::optional<std::wstring>(reason(value)) : std::nullopt;
}
bool WindowsBlocklist::click_only(const WindowsAppIdentity& identity, const WindowsPolicySignals& observed) const { return category(identity, observed) == L"developer"; }
const std::vector<WindowsBlocklist::Entry>& WindowsBlocklist::entries() const noexcept { return entries_; }

std::optional<std::wstring> windows_identity_refusal(const WindowsAppIdentity& identity) {
  if (identity.system && !identity.verified) return L"security";
  return generated_rules().refusal(identity);
}
bool windows_protected_path(const std::wstring& path) {
  if (path.size() < 3 || path.size() > 32'767 || !((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z')) ||
      path[1] != L':' || path[2] != L'\\' || path.find(L'/') != std::wstring::npos) return true;
  std::vector<std::wstring_view> parts;
  size_t start = 3;
  for (size_t index = 0; index <= path.size(); ++index) {
    if (index < path.size() && (path[index] < 0x20 || (path[index] == L':' && index != 1))) return true;
    if (index < start || (index < path.size() && path[index] != L'\\')) continue;
    const auto part = std::wstring_view(path).substr(start, index - start);
    if (part.empty() || part == L"." || part == L".." || part.back() == L'.' || part.back() == L' ') return true;
    parts.push_back(part); start = index + 1;
  }
  if (parts.empty()) return true;
  for (size_t index = 0; index < parts.size(); ++index) {
    const auto part = parts[index];
    if (member(part, {L".ssh", L".aws", L".gnupg", L".azure", L".kube", L".config", L".vector", L".claude", L".codex", L".cursor", L"brain"})) return true;
    if (index > 0 && equal(parts[index - 1], L"Microsoft") && member(part, {L"Credentials", L"Vault", L"Protect", L"SystemCertificates"})) return true;
    if (index > 0 && equal(parts[index - 1], L"System32") && member(part, {L"config", L"Tasks"})) return true;
    if (member(part, {L"User Data", L"Keychains"})) return true;
  }
  const auto filename = parts.back();
  if (WindowsBlocklist::matches(L".env.*", filename) || member(filename, {L".env", L"credentials", L"credentials.json", L"id_rsa", L"id_ed25519", L"agents", L"agents.md", L"claude", L"claude.md", L"context", L"context.md", L"rules", L"rules.md", L"memory.md", L"vector.json", L".cursorrules", L".clinerules", L".windsurfrules", L"copilot-instructions.md"})) return true;
  return false;
}
bool windows_keys_type_text(std::span<const std::wstring> keys) noexcept {
  bool control = false, alt = false, alt_graph = false, win = false, shift = false, numpad = false;
  for (const auto& key : keys) {
    control = control || member(key, {L"ctrl", L"control", L"controlleft", L"controlright", L"⌃"});
    alt = alt || member(key, {L"alt", L"altleft", L"altright", L"option", L"opt", L"⌥"});
    alt_graph = alt_graph || member(key, {L"AltGraph", L"AltGr"});
    win = win || member(key, {L"cmd", L"command", L"meta", L"metaleft", L"metaright", L"super", L"⌘", L"win", L"windows", L"os", L"osleft", L"osright"});
    shift = shift || member(key, {L"shift", L"shiftleft", L"shiftright", L"⇧"});
    numpad = numpad || WindowsBlocklist::matches(L"Numpad*", key);
  }
  for (const auto& key : keys) {
    if ((control && member(key, {L"v", L"keyv"})) || (shift && member(key, {L"insert", L"ins"}))) return true;
  }
  if (win || (control && !alt && !alt_graph) || (alt && !control && !numpad && !alt_graph)) return false;
  for (const auto& key : keys) {
    if (member(key, {L"ctrl", L"control", L"controlleft", L"controlright", L"⌃", L"alt", L"altleft", L"altright", L"option", L"opt", L"⌥", L"altgr", L"altgraph", L"fn", L"shift", L"shiftleft", L"shiftright", L"⇧"})) continue;
    if (member(key, {L"enter", L"return", L"numpadenter", L"tab", L"backspace", L"delete", L"del", L"forwarddelete", L"escape", L"esc", L"arrowleft", L"arrowright", L"arrowup", L"arrowdown", L"left", L"right", L"up", L"down", L"home", L"end", L"pageup", L"pagedown", L"pgup", L"pgdn", L"insert", L"ins", L"help", L"capslock", L"numlock", L"scrolllock", L"printscreen", L"pause", L"contextmenu"})) continue;
    const auto function = key.size() >= 2 && key.size() <= 3 && (key[0] == L'f' || key[0] == L'F') &&
      ((key.size() == 2 && key[1] >= L'1' && key[1] <= L'9') ||
       (key.size() == 3 && ((key[1] == L'1' && key[2] >= L'0' && key[2] <= L'9') || (key[1] == L'2' && key[2] >= L'0' && key[2] <= L'4'))));
    const auto named_media = [&](std::wstring_view prefix) {
      if (key.size() <= prefix.size() || !equal(std::wstring_view(key).substr(0, prefix.size()), prefix)) return false;
      return std::all_of(key.begin() + static_cast<ptrdiff_t>(prefix.size()), key.end(), [](wchar_t unit) {
        return (unit >= L'a' && unit <= L'z') || (unit >= L'A' && unit <= L'Z');
      });
    };
    if (function || named_media(L"Media") || named_media(L"AudioVolume") || member(key, {L"VolumeUp", L"VolumeDown", L"VolumeMute"})) continue;
    return true;
  }
  return false;
}
bool windows_approved_identity(const WindowsAppIdentity& identity, const ServerSession& session) noexcept {
  try {
    if (session.approved.Size() > 1000) return false;
    for (const auto& value : session.approved) {
      const auto granted = approval(value);
      if (granted && same_approval(*granted, identity)) return true;
    }
  } catch (...) {}
  return false;
}
WindowsSurfaceRole windows_surface_role(const WindowsWindow& window) {
  if (!coherent(window.owner) || !coherent(window.physical_owner)) return WindowsSurfaceRole::protected_surface;
  const auto& identity = window.owner.identity;
  const auto& physical = window.physical_owner.identity;
  if (member(window.window_class, {L"ToastChildWindowClass", L"ToastWindowClass"}) ||
      (identity.verified && identity.system && equal(identity.binary, L"ShellExperienceHost.exe")) ||
      (physical.verified && physical.system && equal(physical.binary, L"ShellExperienceHost.exe"))) return WindowsSurfaceRole::notification;
  if (notification(window) || generated_rules().category(identity, signals(window)) == L"security" ||
      (generated_rules().category(physical) == L"security" && !equal(physical.binary, L"ApplicationFrameHost.exe"))) return WindowsSurfaceRole::protected_surface;
  const auto category = generated_rules().category(identity, signals(window));
  if (category == L"system-ui") return identity.system && identity.verified ? WindowsSurfaceRole::furniture : WindowsSurfaceRole::protected_surface;
  return never(category) ? WindowsSurfaceRole::protected_surface : WindowsSurfaceRole::application;
}

WindowsSessionPolicy::WindowsSessionPolicy(ServerSession session, DWORD helper_pid)
  : session_(std::move(session)), helper_pid_(helper_pid), blocklist_(&generated_rules()) {
  if (helper_pid_ == 0 || session_.id.empty() || session_.approved.Size() > 1000) fail(L"failed", L"The native session approvals are invalid.");
  session_.approved = JsonArray::Parse(session_.approved.Stringify());
  session_.vector_pids = JsonArray::Parse(session_.vector_pids.Stringify());
  session_.vector_window_ids = JsonArray::Parse(session_.vector_window_ids.Stringify());
  session_.overlay_window_ids = JsonArray::Parse(session_.overlay_window_ids.Stringify());
  for (const auto& value : session_.approved) if (!approval(value)) fail(L"failed", L"The native session approvals are invalid.");
}
void WindowsSessionPolicy::require(const WindowsWindow& window, WindowsPolicyOperation operation, std::optional<bool> secure, std::span<const std::wstring> keys) const {
  if (!coherent(window.owner) || !coherent(window.physical_owner) || !window.hwnd || !window.surface) fail(L"changed", L"The native owner changed.");
  const auto category = blocklist_->category(window.owner.identity, signals(window));
  if (excluded(window, session_, helper_pid_) || notification(window) || blocklist_->refusal(window.owner.identity, signals(window))) fail(L"protected", L"This native target is protected.");
  if (!same_windows_process(window.owner.process, window.physical_owner.process) &&
      !(window.physical_owner.identity.verified && window.physical_owner.identity.system && equal(window.physical_owner.identity.binary, L"ApplicationFrameHost.exe"))) fail(L"protected", L"The native host cannot be driven.");
  if (!window.child_shell && category != L"developer") fail(L"unavailable", L"The native process tree could not be verified.");
  if (!windows_approved_identity(window.owner.identity, session_)) fail(L"not_granted", L"This app is not approved for the current task.");
  if (session_.mode != L"foreground") fail(L"unsupported_action", L"Background operation is unavailable on Windows.");
  if (operation != WindowsPolicyOperation::observe && operation != WindowsPolicyOperation::capture && session_.paused) fail(L"paused", L"The computer session is paused.");
  if (window.elevated) fail(L"elevated", L"The native target is elevated.");
  if (!window.current_desktop || window.cloaked) fail(L"unavailable", L"The native window is not on the current desktop.");
  const auto text = operation == WindowsPolicyOperation::type_text || operation == WindowsPolicyOperation::set_value || (operation == WindowsPolicyOperation::key && windows_keys_type_text(keys));
  if (text && secure != false) fail(L"secure_field", L"The native field cannot receive text.");
  if (text && category == L"developer") fail(L"blocked", L"Text input is unavailable for this app.");
}
void WindowsSessionPolicy::require_launch(const WindowsAppIdentity& identity) const {
  if (identity.pid || !identity.verified || identity.exe.empty()) fail(L"unavailable", L"The app's static identity could not be verified.");
  if (windows_identity_refusal(identity)) fail(L"protected", L"This native app is protected.");
  if (!windows_approved_identity(identity, session_)) fail(L"not_granted", L"This app is not approved for the current task.");
  if (session_.mode != L"foreground") fail(L"unsupported_action", L"Background operation is unavailable on Windows.");
  if (session_.paused) fail(L"paused", L"The computer session is paused.");
}
bool WindowsSessionPolicy::disclose(const WindowsWindow& window) const noexcept {
  try { require(window, WindowsPolicyOperation::observe); return true; } catch (...) { return false; }
}
bool WindowsSessionPolicy::include_in_display(const WindowsWindow& window) const noexcept {
  try {
    if (coherent(window.owner) && coherent(window.physical_owner) && !excluded(window, session_, helper_pid_) && !notification(window) &&
        window.owner.identity.verified && window.owner.identity.system && blocklist_->category(window.owner.identity, signals(window)) == L"system-ui" && window.child_shell == false) return true;
    require(window, WindowsPolicyOperation::capture); return true;
  } catch (...) { return false; }
}
WindowPolicy windows_window_policy() {
  WindowPolicy result;
  result.disclose = [](const WindowsWindow& window, const std::optional<ServerSession>& session) {
    return session && WindowsSessionPolicy(*session).disclose(window);
  };
  result.require = [](const WindowsWindow& window, const ServerSession& session, WindowIntent) {
    WindowsSessionPolicy(session).require(window, WindowsPolicyOperation::activate);
  };
  return result;
}
}
