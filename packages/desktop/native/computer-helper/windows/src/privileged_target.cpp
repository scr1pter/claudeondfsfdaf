#include "privileged_target.h"
#include "core.h"
#include "build-config.h"
#include "identity.h"
#include <bcrypt.h>
#include <commctrl.h>
#include <dwmapi.h>
#include <tlhelp32.h>
#include <algorithm>
#include <array>
#include <bit>
#include <chrono>
#include <filesystem>
#include <limits>
#include <set>
#include <thread>

namespace vector::computer {
namespace {
[[noreturn]] void invalid() { throw Failure{L"failed", L"The isolated test target could not be validated."}; }
void require(bool value) { if (!value) invalid(); }
bool keys(const JsonObject& object, const std::set<std::wstring>& expected) {
  if (object.Size() != expected.size()) return false;
  for (const auto& entry : object) if (!expected.contains(std::wstring(entry.Key()))) return false;
  return true;
}
IJsonValue field(const JsonObject& object, const wchar_t* key) { return object.HasKey(key) ? object.Lookup(key) : nullptr; }
std::optional<uint64_t> number(const JsonObject& object, const wchar_t* key) { const auto value = field(object, key); return value ? safe_integer(value) : std::nullopt; }
std::optional<std::wstring> string(const JsonObject& object, const wchar_t* key, size_t limit = 256) {
  const auto value = field(object, key);
  if (!value || value.ValueType() != JsonValueType::String) return {};
  const std::wstring result(value.GetString());
  if (result.size() > limit || result.find(L'\0') != std::wstring::npos) return {};
  return result;
}
bool boolean(const JsonObject& object, const wchar_t* key, bool& result) {
  const auto value = field(object, key); if (!value || value.ValueType() != JsonValueType::Boolean) return false;
  result = value.GetBoolean(); return true;
}
std::optional<WindowsRect> rectangle(const IJsonValue& value) {
  if (!value || value.ValueType() != JsonValueType::Object) return {};
  const auto object = value.GetObject();
  if (!keys(object, {L"x", L"y", L"w", L"h"})) return {};
  const auto x = signed_integer(field(object, L"x")), y = signed_integer(field(object, L"y")), w = signed_integer(field(object, L"w")), h = signed_integer(field(object, L"h"));
  if (!x || !y || !w || !h) return {};
  const WindowsRect result{*x, *y, *w, *h};
  return result.valid() ? std::optional(result) : std::nullopt;
}
std::wstring hex(std::span<const unsigned char> bytes) {
  std::wstring result; result.reserve(bytes.size() * 2);
  for (const auto byte : bytes) { result.push_back(L"0123456789abcdef"[byte >> 4]); result.push_back(L"0123456789abcdef"[byte & 15]); }
  return result;
}
std::filesystem::path image_path() {
  std::wstring value(32'768, L'\0'); const auto size = GetModuleFileNameW(nullptr, value.data(), static_cast<DWORD>(value.size()));
  require(size > 0 && size < value.size()); value.resize(size); return std::filesystem::canonical(value);
}
bool same_path(const std::filesystem::path& a, const std::filesystem::path& b) {
  const auto left = a.wstring(), right = b.wstring();
  return left.size() < 32'768 && right.size() < 32'768 && CompareStringOrdinal(left.c_str(), static_cast<int>(left.size()), right.c_str(), static_cast<int>(right.size()), TRUE) == CSTR_EQUAL;
}
DWORD immediate_parent() {
  winrt::handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)); require(snapshot && snapshot.get() != INVALID_HANDLE_VALUE);
  PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry); require(Process32FirstW(snapshot.get(), &entry) != FALSE);
  size_t count = 0;
  do { require(++count <= 65'536); if (entry.th32ProcessID == GetCurrentProcessId()) return entry.th32ParentProcessID; }
  while (Process32NextW(snapshot.get(), &entry));
  invalid();
}
JsonObject manifest(const std::filesystem::path& file) {
  winrt::handle input(CreateFileW(file.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  require(input && input.get() != INVALID_HANDLE_VALUE);
  FILE_ATTRIBUTE_TAG_INFO attributes{}; LARGE_INTEGER size{};
  require(GetFileInformationByHandleEx(input.get(), FileAttributeTagInfo, &attributes, sizeof(attributes)) && !(attributes.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) && GetFileSizeEx(input.get(), &size) && size.QuadPart > 0 && size.QuadPart <= 65'536);
  std::string bytes(static_cast<size_t>(size.QuadPart), '\0'); DWORD read = 0;
  require(ReadFile(input.get(), bytes.data(), static_cast<DWORD>(bytes.size()), &read, nullptr) && read == bytes.size() && strict_utf8({reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size()}));
  return JsonObject::Parse(winrt::to_hstring(bytes));
}
void manifested(const JsonObject& document, const WindowsStaticIdentity& executable, std::wstring_view name) {
  require(document.GetNamedString(L"platform", L"") == L"win32" && document.GetNamedString(L"helperVersion", L"") == winrt::to_hstring(identity::kHelperVersion) &&
    document.GetNamedString(L"sourceDigest", L"") == winrt::to_hstring(build::kSourceDigest));
  const auto protocol = document.GetNamedObject(L"protocol");
  require(number(protocol, L"min") == identity::kProtocolMin && number(protocol, L"max") == identity::kProtocolMax);
  const auto entry = document.GetNamedObject(L"files").GetNamedObject(winrt::hstring(name));
  const auto architectures = entry.GetNamedArray(L"arch");
  require(entry.GetNamedString(L"sha256", L"") == hex(executable.image.sha256) && architectures.Size() == 1 && architectures.GetStringAt(0) == winrt::to_hstring(architecture()));
}
struct TargetFiles { WindowsStaticIdentity helper, target; };
TargetFiles verify_files(const std::filesystem::path& helper, const std::filesystem::path& target) {
  require(helper.is_absolute() && target.is_absolute() && same_path(helper.filename(), L"vector-computer.exe") && same_path(target.filename(), windows_target_name) &&
    same_path(target.parent_path().filename(), L"tests") && same_path(helper.parent_path(), target.parent_path().parent_path()));
  auto own = observe_windows_file(helper.wstring()); auto fixture = observe_windows_file(target.wstring());
  require(own.image.size > 0 && own.image.size <= 64 * 1024 * 1024 && fixture.image.size > 0 && fixture.image.size <= 64 * 1024 * 1024 &&
    same_path(own.image.path, helper) && same_path(fixture.image.path, target));
  manifested(manifest(helper.parent_path() / L"computer-helper.json"), own, L"vector-computer.exe");
  manifested(manifest(target.parent_path() / L"computer-helper-tests.json"), fixture, windows_target_name);
  return {std::move(own), std::move(fixture)};
}
WindowsRect bounds(HWND window) {
  RECT value{}; require(window && GetWindowRect(window, &value)); return {value.left, value.top, int64_t(value.right) - value.left, int64_t(value.bottom) - value.top};
}
JsonObject summary_wire(const WindowsTargetSummary& value) {
  JsonObject result; result.Insert(L"length", JsonValue::CreateNumberValue(static_cast<double>(value.length))); result.Insert(L"sha256", JsonValue::CreateStringValue(value.sha256)); return result;
}
std::optional<WindowsTargetSummary> summary(const IJsonValue& value) {
  if (!value || value.ValueType() != JsonValueType::Object) return {};
  const auto object = value.GetObject(); if (!keys(object, {L"length", L"sha256"})) return {};
  const auto length = number(object, L"length"); const auto hash = string(object, L"sha256");
  if (!length || *length > 4000 || !hash || !windows_target_hex(*hash, 64)) return {};
  return WindowsTargetSummary{*length, *hash};
}
struct Fixture {
  WindowsTargetOptions options;
  HWND window = nullptr, button = nullptr, plain = nullptr, secure = nullptr, excluded = nullptr;
  uint64_t counter = 0, key_downs = 0, key_ups = 0, button_downs = 0, button_ups = 0;
  std::atomic_bool quit{false};
  std::set<WPARAM> held_keys;
  uint32_t held_buttons = 0;
  WindowsRect patch() const { POINT point{20, 20}; require(ClientToScreen(window, &point)); return {point.x, point.y, 180, 100}; }
  void input(UINT message, WPARAM key) {
    if (message == WM_KEYDOWN || message == WM_SYSKEYDOWN) { require(key_downs < 1'000'000 && held_keys.size() < 256); ++key_downs; held_keys.insert(key); }
    if (message == WM_KEYUP || message == WM_SYSKEYUP) { require(key_ups < 1'000'000); ++key_ups; held_keys.erase(key); }
    if (message == WM_LBUTTONDOWN || message == WM_RBUTTONDOWN || message == WM_MBUTTONDOWN) { require(button_downs < 1'000'000); ++button_downs; held_buttons |= message == WM_LBUTTONDOWN ? 1U : message == WM_RBUTTONDOWN ? 2U : 4U; }
    if (message == WM_LBUTTONUP || message == WM_RBUTTONUP || message == WM_MBUTTONUP) { require(button_ups < 1'000'000); ++button_ups; held_buttons &= ~(message == WM_LBUTTONUP ? 1U : message == WM_RBUTTONUP ? 2U : 4U); }
  }
  WindowsTargetState state() const {
    WindowsTargetState result; result.pid = GetCurrentProcessId(); result.parent = options.parent; result.window = window; result.excluded = excluded;
    result.bounds = bounds(window); result.patch = patch(); result.button = bounds(button); result.plain = bounds(plain); result.secure = bounds(secure); result.excluded_bounds = bounds(excluded);
    result.visible = IsWindowVisible(window) != FALSE; result.minimized = IsIconic(window) != FALSE; result.foreground = GetForegroundWindow() == window; DWORD observed_affinity = WDA_NONE; result.affinity = GetWindowDisplayAffinity(excluded, &observed_affinity) && observed_affinity == WDA_EXCLUDEFROMCAPTURE; result.excluded_visible = IsWindowVisible(excluded) != FALSE;
    result.counter = counter; result.key_downs = key_downs; result.key_ups = key_ups; result.button_downs = button_downs; result.button_ups = button_ups; result.held_keys = held_keys.size(); result.held_buttons = static_cast<uint64_t>(std::popcount(held_buttons));
    const auto text = [](HWND edit) { const auto count = GetWindowTextLengthW(edit); require(count >= 0 && count <= 4000); std::wstring value(static_cast<size_t>(count) + 1, L'\0'); require(GetWindowTextW(edit, value.data(), count + 1) == count); value.resize(static_cast<size_t>(count)); return summarize_windows_target_text(value); };
    result.text = text(plain); result.secret = text(secure); require(valid_windows_target_state(result)); return result;
  }
  void act(WindowsTargetAction action) {
    if (action == WindowsTargetAction::focus_plain || action == WindowsTargetAction::focus_secure || action == WindowsTargetAction::focus_button) {
      require(GetForegroundWindow() == window); const auto child = action == WindowsTargetAction::focus_plain ? plain : action == WindowsTargetAction::focus_secure ? secure : button;
      SetFocus(child); require(GetFocus() == child); return;
    }
    if (action == WindowsTargetAction::show_excluded || action == WindowsTargetAction::hide_excluded) {
      if (action == WindowsTargetAction::show_excluded) { const auto region = patch(); require(SetWindowPos(excluded, HWND_TOP, static_cast<int>(region.x + 20), static_cast<int>(region.y + 20), 60, 60, SWP_NOACTIVATE | SWP_SHOWWINDOW)); }
      else ShowWindow(excluded, SW_HIDE);
      winrt::check_hresult(DwmFlush());
      return;
    }
    if (action == WindowsTargetAction::move_window) { const auto region = bounds(window); require(SetWindowPos(window, nullptr, static_cast<int>(region.x + 12), static_cast<int>(region.y + 12), 0, 0, SWP_NOZORDER | SWP_NOSIZE | SWP_NOACTIVATE)); winrt::check_hresult(DwmFlush()); return; }
    if (action == WindowsTargetAction::quit) quit = true;
  }
};
LRESULT CALLBACK child_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam, UINT_PTR, DWORD_PTR reference) {
  auto& fixture = *reinterpret_cast<Fixture*>(reference);
  try { fixture.input(message, wparam); } catch (...) { PostQuitMessage(1); }
  return DefSubclassProc(window, message, wparam, lparam);
}
LRESULT CALLBACK window_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
  if (message == WM_NCCREATE) { const auto create = reinterpret_cast<CREATESTRUCTW*>(lparam); SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(create->lpCreateParams)); }
  auto* fixture = reinterpret_cast<Fixture*>(GetWindowLongPtrW(window, GWLP_USERDATA));
  if (!fixture) return DefWindowProcW(window, message, wparam, lparam);
  try {
    fixture->input(message, wparam);
    if (message == WM_COMMAND && LOWORD(wparam) == 1001 && HIWORD(wparam) == BN_CLICKED && reinterpret_cast<HWND>(lparam) == fixture->button) { require(fixture->counter < 1'000'000); ++fixture->counter; return 0; }
    if (message == WM_CLOSE) { fixture->quit = true; return 0; }
    if (message == WM_PAINT) {
      PAINTSTRUCT paint{}; const auto dc = BeginPaint(window, &paint); if (!dc) return 0;
      RECT client{}; GetClientRect(window, &client); FillRect(dc, &client, reinterpret_cast<HBRUSH>(static_cast<uintptr_t>(COLOR_WINDOW + 1)));
      RECT patch{20, 20, 200, 120}; const auto color = CreateSolidBrush(RGB(32, 128, 192)); if (color) { FillRect(dc, &patch, color); DeleteObject(color); }
      EndPaint(window, &paint); return 0;
    }
  } catch (...) { fixture->quit = true; }
  return DefWindowProcW(window, message, wparam, lparam);
}
LRESULT CALLBACK excluded_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
  if (message != WM_PAINT) return DefWindowProcW(window, message, wparam, lparam);
  PAINTSTRUCT paint{}; const auto dc = BeginPaint(window, &paint); RECT client{}; GetClientRect(window, &client);
  const auto color = CreateSolidBrush(RGB(224, 96, 32)); if (dc && color) FillRect(dc, &client, color); if (color) DeleteObject(color); EndPaint(window, &paint); return 0;
}
JsonObject state_wire(const WindowsTargetState& state) {
  JsonObject result; result.Insert(L"pid", JsonValue::CreateNumberValue(state.pid)); result.Insert(L"parentPID", JsonValue::CreateNumberValue(state.parent));
  result.Insert(L"windowId", JsonValue::CreateStringValue(window_id(state.window))); result.Insert(L"excludedWindowId", JsonValue::CreateStringValue(window_id(state.excluded)));
  result.Insert(L"bounds", state.bounds.wire()); result.Insert(L"excludedBounds", state.excluded_bounds.wire());
  JsonObject views; views.Insert(L"patch", state.patch.wire()); views.Insert(L"button", state.button.wire()); views.Insert(L"plain", state.plain.wire()); views.Insert(L"secure", state.secure.wire()); result.Insert(L"views", views);
  for (const auto item : {std::pair{L"visible", state.visible}, {L"minimized", state.minimized}, {L"foreground", state.foreground}, {L"affinity", state.affinity}, {L"excludedVisible", state.excluded_visible}}) result.Insert(item.first, JsonValue::CreateBooleanValue(item.second));
  result.Insert(L"counter", JsonValue::CreateNumberValue(static_cast<double>(state.counter))); result.Insert(L"text", summary_wire(state.text)); result.Insert(L"secure", summary_wire(state.secret));
  JsonObject events; for (const auto item : {std::pair{L"keyDowns", state.key_downs}, {L"keyUps", state.key_ups}, {L"buttonDowns", state.button_downs}, {L"buttonUps", state.button_ups}, {L"heldKeys", state.held_keys}, {L"heldButtons", state.held_buttons}}) events.Insert(item.first, JsonValue::CreateNumberValue(static_cast<double>(item.second)));
  result.Insert(L"events", events); return result;
}
JsonObject reply(uint64_t id, std::wstring_view nonce, const WindowsTargetState& state) {
  JsonObject result; result.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(id))); result.Insert(L"ok", JsonValue::CreateBooleanValue(true)); result.Insert(L"nonce", JsonValue::CreateStringValue(nonce)); result.Insert(L"sourceDigest", JsonValue::CreateStringValue(winrt::to_hstring(build::kSourceDigest))); result.Insert(L"state", state_wire(state)); return result;
}
// Nonblocking availability checks bound both memory and time without placing a blocking read on the UI thread.
class TargetReader {
 public:
  std::optional<JsonObject> read(HANDLE input) {
    DWORD available = 0; require(PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr) != FALSE);
    if (available) {
      require(available <= windows_target_frame_limit + 4 && bytes_.size() <= windows_target_frame_limit + 4);
      std::array<uint8_t, 4096> buffer{}; DWORD received = 0;
      require(ReadFile(input, buffer.data(), std::min<DWORD>(available, static_cast<DWORD>(buffer.size())), &received, nullptr) && received > 0);
      require(received <= windows_target_frame_limit + 4 - bytes_.size()); bytes_.insert(bytes_.end(), buffer.begin(), buffer.begin() + received);
    }
    if (bytes_.size() < 4) return {};
    const auto size = (uint32_t(bytes_[0]) << 24) | (uint32_t(bytes_[1]) << 16) | (uint32_t(bytes_[2]) << 8) | bytes_[3];
    require(size > 0 && size <= windows_target_frame_limit); if (bytes_.size() < size + 4) return {};
    require(bytes_.size() == size + 4 && strict_utf8(std::span(bytes_).subspan(4)));
    const std::string json(reinterpret_cast<const char*>(bytes_.data() + 4), size); bytes_.clear(); return JsonObject::Parse(winrt::to_hstring(json));
  }
 private:
  std::vector<uint8_t> bytes_;
};
}

bool windows_target_hex(std::wstring_view value, size_t length) noexcept {
  return value.size() == length && std::all_of(value.begin(), value.end(), [](wchar_t c) { return (c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f'); });
}
std::optional<WindowsTargetOptions> parse_windows_target_options(std::span<const std::wstring> arguments) {
  if (arguments.size() != 6 || arguments[0] != L"--control" || arguments[1] != L"--parent-pid" || arguments[3] != L"--nonce" || arguments[5] != L"--isolated" || !windows_target_hex(arguments[4], 64)) return {};
  uint64_t parent = 0; const auto& text = arguments[2]; if (text.empty() || text.size() > 10 || text[0] == L'0') return {};
  for (const auto c : text) { if (c < L'0' || c > L'9') return {}; parent = parent * 10 + static_cast<unsigned>(c - L'0'); if (parent > MAXDWORD) return {}; }
  if (!parent) return {}; return WindowsTargetOptions{static_cast<DWORD>(parent), arguments[4]};
}
std::wstring_view windows_target_action(WindowsTargetAction action) noexcept {
  switch (action) {
    case WindowsTargetAction::state: return L"state";
    case WindowsTargetAction::focus_plain: return L"focus-plain";
    case WindowsTargetAction::focus_secure: return L"focus-secure";
    case WindowsTargetAction::focus_button: return L"focus-button";
    case WindowsTargetAction::show_excluded: return L"show-excluded";
    case WindowsTargetAction::hide_excluded: return L"hide-excluded";
    case WindowsTargetAction::move_window: return L"move-window";
    case WindowsTargetAction::quit: return L"quit";
  }
  return L"";
}
std::optional<WindowsTargetControl> parse_windows_target_control(const JsonObject& value) {
  if (!keys(value, {L"id", L"op"})) return {};
  const auto id = number(value, L"id"); const auto action = string(value, L"op", 32); if (!id || *id == 0 || !action) return {};
  for (const auto candidate : {WindowsTargetAction::state, WindowsTargetAction::focus_plain, WindowsTargetAction::focus_secure, WindowsTargetAction::focus_button, WindowsTargetAction::show_excluded, WindowsTargetAction::hide_excluded, WindowsTargetAction::move_window, WindowsTargetAction::quit}) if (*action == windows_target_action(candidate)) return WindowsTargetControl{*id, candidate};
  return {};
}
bool valid_windows_target_state(const WindowsTargetState& value) noexcept {
  if (!value.pid || !value.parent || value.pid == value.parent || !value.window || !value.excluded || value.window == value.excluded || !value.bounds.valid() || !value.visible || value.minimized) return false;
  for (const auto& view : {value.patch, value.button, value.plain, value.secure, value.excluded_bounds}) if (!view.valid() || !value.bounds.contains(view)) return false;
  if (value.plain == value.secure || value.button == value.plain || value.button == value.secure || value.held_keys > 256 || value.held_buttons > 3) return false;
  for (const auto count : {value.counter, value.key_downs, value.key_ups, value.button_downs, value.button_ups}) if (count > 1'000'000) return false;
  return value.text.length <= 4000 && value.secret.length <= 4000 && windows_target_hex(value.text.sha256, 64) && windows_target_hex(value.secret.sha256, 64);
}
std::optional<WindowsTargetState> decode_windows_target_state(const JsonObject& value) {
  try {
    if (!keys(value, {L"pid", L"parentPID", L"windowId", L"excludedWindowId", L"bounds", L"views", L"excludedBounds", L"visible", L"minimized", L"foreground", L"affinity", L"excludedVisible", L"counter", L"text", L"secure", L"events"})) return {};
    WindowsTargetState result; const auto pid = number(value, L"pid"), parent = number(value, L"parentPID"), count = number(value, L"counter"); const auto main = string(value, L"windowId"), excluded = string(value, L"excludedWindowId");
    if (!pid || !parent || !count || *pid > MAXDWORD || *parent > MAXDWORD || !main || !excluded) return {};
    const auto main_window = parse_window_id(*main), excluded_window = parse_window_id(*excluded); if (!main_window || !excluded_window) return {};
    result.pid = static_cast<DWORD>(*pid); result.parent = static_cast<DWORD>(*parent); result.window = *main_window; result.excluded = *excluded_window; result.counter = *count;
    if (!boolean(value, L"visible", result.visible) || !boolean(value, L"minimized", result.minimized) || !boolean(value, L"foreground", result.foreground) || !boolean(value, L"affinity", result.affinity) || !boolean(value, L"excludedVisible", result.excluded_visible)) return {};
    const auto views = value.GetNamedObject(L"views"); if (!keys(views, {L"patch", L"button", L"plain", L"secure"})) return {};
    const auto main_bounds = rectangle(field(value, L"bounds")), excluded_bounds = rectangle(field(value, L"excludedBounds")), patch = rectangle(field(views, L"patch")), button = rectangle(field(views, L"button")), plain = rectangle(field(views, L"plain")), secure = rectangle(field(views, L"secure"));
    if (!main_bounds || !excluded_bounds || !patch || !button || !plain || !secure) return {};
    result.bounds = *main_bounds; result.excluded_bounds = *excluded_bounds; result.patch = *patch; result.button = *button; result.plain = *plain; result.secure = *secure;
    const auto text = summary(field(value, L"text")), secret = summary(field(value, L"secure")); if (!text || !secret) return {}; result.text = *text; result.secret = *secret;
    const auto events = value.GetNamedObject(L"events"); if (!keys(events, {L"keyDowns", L"keyUps", L"buttonDowns", L"buttonUps", L"heldKeys", L"heldButtons"})) return {};
    const auto downs = number(events, L"keyDowns"), ups = number(events, L"keyUps"), button_downs = number(events, L"buttonDowns"), button_ups = number(events, L"buttonUps"), held = number(events, L"heldKeys"), buttons = number(events, L"heldButtons");
    if (!downs || !ups || !button_downs || !button_ups || !held || !buttons) return {};
    result.key_downs = *downs; result.key_ups = *ups; result.button_downs = *button_downs; result.button_ups = *button_ups; result.held_keys = *held; result.held_buttons = *buttons;
    return valid_windows_target_state(result) ? std::optional(result) : std::nullopt;
  } catch (...) { return {}; }
}
WindowsTargetSummary summarize_windows_target_text(std::wstring_view text) {
  require(text.size() <= 4000); const auto bytes = winrt::to_string(winrt::hstring(text));
  BCRYPT_ALG_HANDLE raw = nullptr; require(BCryptOpenAlgorithmProvider(&raw, BCRYPT_SHA256_ALGORITHM, nullptr, 0) >= 0);
  struct Close { BCRYPT_ALG_HANDLE handle; ~Close() { BCryptCloseAlgorithmProvider(handle, 0); } } close{raw};
  std::array<unsigned char, 32> digest{};
  require(BCryptHash(raw, nullptr, 0, reinterpret_cast<PUCHAR>(const_cast<char*>(bytes.data())), static_cast<ULONG>(bytes.size()), digest.data(), static_cast<ULONG>(digest.size())) >= 0);
  return {text.size(), hex(digest)};
}
JsonObject windows_target_control_report() {
  JsonObject check; check.Insert(L"name", JsonValue::CreateStringValue(L"windows-test-target-control-schema"));
  const std::vector<std::wstring> valid{L"--control", L"--parent-pid", L"123", L"--nonce", std::wstring(64, L'a'), L"--isolated"};
  bool passed = parse_windows_target_options(valid).has_value(); auto bad = valid; bad.push_back(L"--execute"); passed = passed && !parse_windows_target_options(bad);
  JsonObject control; control.Insert(L"id", JsonValue::CreateNumberValue(1)); control.Insert(L"op", JsonValue::CreateStringValue(L"state")); passed = passed && parse_windows_target_control(control).has_value();
  control.Insert(L"op", JsonValue::CreateStringValue(L"execute")); passed = passed && !parse_windows_target_control(control);
  // Exercise the actual production writer adapter with our private success envelopes. The private
  // pipe cannot silently rely on the serving writer accepting a request-shaped JSON object.
  std::vector<uint8_t> bytes;
  FrameWriter writer([&](std::span<const uint8_t> chunk, ProtocolDeadline) {
    if (chunk.size() > windows_target_frame_limit + 4 - std::min(bytes.size(), windows_target_frame_limit + 4)) return WriteResult{};
    bytes.insert(bytes.end(), chunk.begin(), chunk.end()); return WriteResult{chunk.size(), WriteStatus::written};
  });
  control.Insert(L"op", JsonValue::CreateStringValue(L"state")); JsonObject body; body.Insert(L"control", control);
  passed = passed && writer.write(response_success(1, body)) && bytes.size() > 4;
  if (passed) { const auto encoded = JsonObject::Parse(winrt::to_hstring(std::string(reinterpret_cast<const char*>(bytes.data() + 4), bytes.size() - 4))); passed = parse_windows_target_control(encoded.GetNamedObject(L"control")).has_value(); }
  WindowsTargetState state; state.pid = 43; state.parent = 42; state.window = reinterpret_cast<HWND>(uintptr_t{100}); state.excluded = reinterpret_cast<HWND>(uintptr_t{101}); state.bounds = {0, 0, 640, 480};
  state.patch = {10, 10, 100, 100}; state.button = {200, 10, 100, 30}; state.plain = {10, 200, 300, 30}; state.secure = {10, 250, 300, 30}; state.excluded_bounds = {20, 20, 40, 40}; state.visible = true; state.minimized = false;
  state.text.sha256 = std::wstring(64, L'a'); state.secret.sha256 = std::wstring(64, L'b'); bytes.clear();
  passed = passed && writer.write(reply(0, valid[4], state)) && bytes.size() > 4;
  if (passed) { const auto encoded = JsonObject::Parse(winrt::to_hstring(std::string(reinterpret_cast<const char*>(bytes.data() + 4), bytes.size() - 4))); passed = decode_windows_target_state(encoded.GetNamedObject(L"state")).has_value(); }
  check.Insert(L"ok", JsonValue::CreateBooleanValue(passed)); JsonArray checks; checks.Append(check); JsonObject result; result.Insert(L"checks", checks); return result;
}

int run_windows_target(const WindowsTargetOptions& options, HANDLE input, HANDLE output) noexcept {
  int stage = 20;
  try {
    require(input && output && GetFileType(input) == FILE_TYPE_PIPE && GetFileType(output) == FILE_TYPE_PIPE && immediate_parent() == options.parent && windows_target_hex(options.nonce, 64));
    stage = 21;
    const auto parent = observe_windows_process(options.parent); const auto own = observe_windows_process(GetCurrentProcessId());
    require(parent.process.creation_time <= own.process.creation_time && same_token(parent.process.token, own.process.token) && serving_token_allowed(own.process.token) && windows_owner_current(parent));
    stage = 22;
    const auto files = verify_files(parent.process.image.path, image_path()); require(same_file(files.helper.image, parent.process.image) && same_file(files.target.image, own.process.image));
    stage = 23;
    SetLastError(ERROR_SUCCESS); const auto context = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2); require(context != nullptr);
    winrt::handle stop(CreateEventW(nullptr, TRUE, FALSE, nullptr)); require(static_cast<bool>(stop));
    const auto parent_handle = parent.lease->process_handle(); HANDLE copied = nullptr; require(DuplicateHandle(GetCurrentProcess(), parent_handle, GetCurrentProcess(), &copied, SYNCHRONIZE, FALSE, 0));
    const auto watcher = std::make_shared<winrt::handle>(copied); const auto stopping = std::make_shared<winrt::handle>(); HANDLE duplicate_stop = nullptr; require(DuplicateHandle(GetCurrentProcess(), stop.get(), GetCurrentProcess(), &duplicate_stop, SYNCHRONIZE, FALSE, 0)); *stopping = winrt::handle(duplicate_stop);
    std::thread([watcher, stopping] { const std::array<HANDLE, 2> handles{watcher->get(), stopping->get()}; const auto status = WaitForMultipleObjects(static_cast<DWORD>(handles.size()), handles.data(), FALSE, windows_target_lifetime_ms); if (status != WAIT_OBJECT_0 + 1) TerminateProcess(GetCurrentProcess(), 1); }).detach();
    Fixture fixture; fixture.options = options;
    WNDCLASSEXW main{}; main.cbSize = sizeof(main); main.lpfnWndProc = window_proc; main.hInstance = GetModuleHandleW(nullptr); main.lpszClassName = windows_target_class.data(); main.hCursor = LoadCursorW(nullptr, IDC_ARROW); require(RegisterClassExW(&main));
    WNDCLASSEXW excluded = main; excluded.lpfnWndProc = excluded_proc; excluded.lpszClassName = L"VectorComputerIsolatedTargetExcluded"; require(RegisterClassExW(&excluded));
    RECT work{}; require(SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0)); require(work.right - work.left >= 660 && work.bottom - work.top >= 440);
    fixture.window = CreateWindowExW(0, main.lpszClassName, L"Vector isolated test target", WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU, work.left + 20, work.top + 20, 640, 420, nullptr, nullptr, main.hInstance, &fixture); require(fixture.window);
    const auto child = [&](const wchar_t* type, const wchar_t* title, DWORD style, int x, int y, int width, int height, UINT id) {
      const auto window = CreateWindowExW(0, type, title, WS_CHILD | WS_VISIBLE | style, x, y, width, height, fixture.window, reinterpret_cast<HMENU>(static_cast<uintptr_t>(id)), main.hInstance, nullptr);
      require(window && SetWindowSubclass(window, child_proc, id, reinterpret_cast<DWORD_PTR>(&fixture))); return window;
    };
    fixture.button = child(L"BUTTON", L"Increment", BS_PUSHBUTTON | WS_TABSTOP, 240, 40, 180, 36, 1001);
    child(L"STATIC", L"Plain field", 0, 20, 140, 100, 20, 1102); fixture.plain = child(L"EDIT", L"", WS_BORDER | ES_AUTOHSCROLL | WS_TABSTOP, 20, 164, 560, 30, 1002);
    child(L"STATIC", L"Secure field", 0, 20, 220, 100, 20, 1103); fixture.secure = child(L"EDIT", L"fixture_secret_9", WS_BORDER | ES_PASSWORD | ES_AUTOHSCROLL | WS_TABSTOP, 20, 244, 560, 30, 1003);
    SendMessageW(fixture.plain, EM_LIMITTEXT, 4000, 0); SendMessageW(fixture.secure, EM_LIMITTEXT, 4000, 0);
    const auto patch = fixture.patch(); fixture.excluded = CreateWindowExW(WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW, excluded.lpszClassName, L"Vector isolated excluded patch", WS_POPUP, static_cast<int>(patch.x + 20), static_cast<int>(patch.y + 20), 60, 60, fixture.window, nullptr, main.hInstance, nullptr); require(fixture.excluded);
    (void)SetWindowDisplayAffinity(fixture.excluded, WDA_EXCLUDEFROMCAPTURE);
    ShowWindow(fixture.window, SW_SHOW); UpdateWindow(fixture.window); winrt::check_hresult(DwmFlush());
    PipeFrameWriter writer(output, stop.get(), [&] { fixture.quit = true; }); TargetReader reader;
    stage = 24;
    require(writer.write(reply(0, options.nonce, fixture.state())));
    stage = 25;
    uint64_t sequence = 0;
    while (!fixture.quit) {
      require(WaitForSingleObject(parent_handle, 0) == WAIT_TIMEOUT && windows_owner_current(parent));
      MSG message{}; size_t count = 0;
      while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) { require(++count <= 4096); if (message.message == WM_QUIT) { fixture.quit = true; break; } TranslateMessage(&message); DispatchMessageW(&message); }
      if (fixture.quit) break;
      if (const auto document = reader.read(input)) {
        require(keys(*document, {L"id", L"ok", L"control"}) && document->GetNamedBoolean(L"ok"));
        const auto request = parse_windows_target_control(document->GetNamedObject(L"control")); require(request && number(*document, L"id") == request->id && request->id == sequence + 1);
        sequence = request->id; fixture.act(request->action); require(writer.write(reply(sequence, options.nonce, fixture.state())));
      }
      if (!fixture.quit) (void)MsgWaitForMultipleObjects(0, nullptr, FALSE, 5, QS_ALLINPUT);
    }
    writer.cancel(); require(writer.close()); DestroyWindow(fixture.excluded); DestroyWindow(fixture.window); SetEvent(stop.get()); return 0;
  } catch (...) { return stage; }
}

struct WindowsTargetClient::State {
  TargetFiles files;
  winrt::handle process, input, output, stop, job;
  std::unique_ptr<PipeFrameWriter> writer;
  TargetReader reader;
  std::wstring nonce;
  DWORD pid = 0;
  uint64_t next = 0, creation_time = 0;
  std::optional<WindowsTargetState> last;
  std::recursive_mutex mutex;
  bool closed = false, quit_acknowledged = false, close_result = false;
  JsonObject read(uint32_t timeout_ms) {
    const auto deadline = GetTickCount64() + timeout_ms;
    for (;;) {
      require(!closed);
      std::optional<JsonObject> value;
      try { value = reader.read(output.get()); } catch (...) { if (WaitForSingleObject(process.get(), 0) == WAIT_TIMEOUT) throw; }
      if (value) return *value;
      if (WaitForSingleObject(process.get(), 0) != WAIT_TIMEOUT) {
        DWORD status = 1; (void)GetExitCodeProcess(process.get(), &status);
        const auto reason = status == 20 ? L"target_control_invalid" : status == 21 ? L"target_token_invalid" : status == 22 ? L"target_manifest_invalid" : status == 23 ? L"target_window_failed" : status == 24 ? L"target_report_failed" : status == 25 ? L"target_control_failed" : L"target_exited";
        throw Failure{reason, L"The isolated test target exited."};
      }
      if (GetTickCount64() >= deadline) throw Failure{L"target_not_ready", L"The isolated test target did not reply in time."};
      SwitchToThread(); std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
  }
  WindowsTargetState decode(const JsonObject& reply, uint64_t id, bool terminal = false) {
    require(keys(reply, {L"id", L"ok", L"nonce", L"sourceDigest", L"state"}) && reply.GetNamedBoolean(L"ok") && number(reply, L"id") == id && reply.GetNamedString(L"nonce", L"") == nonce && reply.GetNamedString(L"sourceDigest", L"") == winrt::to_hstring(build::kSourceDigest));
    const auto value = decode_windows_target_state(reply.GetNamedObject(L"state")); require(value && value->pid == pid && value->parent == GetCurrentProcessId());
    if (!terminal) { DWORD main_pid = 0, excluded_pid = 0; require(GetWindowThreadProcessId(value->window, &main_pid) && GetWindowThreadProcessId(value->excluded, &excluded_pid) && main_pid == pid && excluded_pid == pid && GetAncestor(value->window, GA_ROOT) == value->window && GetAncestor(value->excluded, GA_ROOT) == value->excluded); }
    if (last) require(value->window == last->window && value->excluded == last->excluded && value->counter >= last->counter && value->key_downs >= last->key_downs && value->key_ups >= last->key_ups && value->button_downs >= last->button_downs && value->button_ups >= last->button_ups);
    last = *value; if (terminal) quit_acknowledged = true; return *value;
  }
};
WindowsTargetClient::WindowsTargetClient(std::unique_ptr<State> state) : state_(std::move(state)) {}
void verify_windows_target_artifacts(const std::wstring& target) { (void)verify_files(image_path(), std::filesystem::canonical(target)); }
std::unique_ptr<WindowsTargetClient> WindowsTargetClient::launch(const std::wstring& target, std::function<bool()> current) {
  require(current && current());
  auto state = std::make_unique<State>(); const auto helper = image_path(); const auto fixture = std::filesystem::canonical(target); state->files = verify_files(helper, fixture);
  const auto token = observe_token(GetCurrentProcess()); require(serving_token_allowed(token));
  std::array<unsigned char, 32> nonce{}; require(BCryptGenRandom(nullptr, nonce.data(), static_cast<ULONG>(nonce.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) >= 0); state->nonce = hex(nonce);
  SECURITY_ATTRIBUTES inherited{sizeof(inherited), nullptr, TRUE}; HANDLE read = nullptr, write = nullptr;
  require(CreatePipe(&read, &write, &inherited, static_cast<DWORD>(windows_target_frame_limit + 4))); winrt::handle child_input(read); state->input = winrt::handle(write); require(SetHandleInformation(state->input.get(), HANDLE_FLAG_INHERIT, 0));
  read = nullptr; write = nullptr; require(CreatePipe(&read, &write, &inherited, static_cast<DWORD>(windows_target_frame_limit + 4))); state->output = winrt::handle(read); winrt::handle child_output(write); require(SetHandleInformation(state->output.get(), HANDLE_FLAG_INHERIT, 0));
  state->job = winrt::handle(CreateJobObjectW(nullptr, nullptr)); require(static_cast<bool>(state->job)); JOBOBJECT_EXTENDED_LIMIT_INFORMATION limit{}; limit.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; require(SetInformationJobObject(state->job.get(), JobObjectExtendedLimitInformation, &limit, sizeof(limit)));
  SIZE_T size = 0; (void)InitializeProcThreadAttributeList(nullptr, 2, 0, &size); require(size > 0 && size < 65'536); std::vector<unsigned char> storage(size);
  auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data()); require(InitializeProcThreadAttributeList(attributes, 2, 0, &size));
  struct Delete { LPPROC_THREAD_ATTRIBUTE_LIST value; ~Delete() { DeleteProcThreadAttributeList(value); } } delete_attributes{attributes};
  const std::array<HANDLE, 2> handles{child_input.get(), child_output.get()}; require(UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, const_cast<HANDLE*>(handles.data()), sizeof(handles), nullptr, nullptr));
  // Assign the job as part of process creation: a parent crash between suspended creation and a
  // later AssignProcessToJobObject must not leave a never-resumed orphan without its own watcher.
  HANDLE job = state->job.get(); require(UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &job, sizeof(job), nullptr, nullptr));
  STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup); startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES; startup.StartupInfo.hStdInput = child_input.get(); startup.StartupInfo.hStdOutput = child_output.get(); startup.StartupInfo.hStdError = child_output.get(); startup.lpAttributeList = attributes;
  std::wstring command = L"\"" + fixture.wstring() + L"\" --control --parent-pid " + std::to_wstring(GetCurrentProcessId()) + L" --nonce " + state->nonce + L" --isolated";
  PROCESS_INFORMATION process{}; require(current());
  require(CreateProcessW(fixture.c_str(), command.data(), nullptr, nullptr, TRUE, EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, nullptr, fixture.parent_path().c_str(), &startup.StartupInfo, &process));
  state->process = winrt::handle(process.hProcess); winrt::handle thread(process.hThread); state->pid = process.dwProcessId;
  FILETIME created{}, exited{}, kernel{}, user{}; require(GetProcessTimes(state->process.get(), &created, &exited, &kernel, &user)); state->creation_time = (uint64_t(created.dwHighDateTime) << 32) | created.dwLowDateTime; require(state->creation_time > 0);
  BOOL contained = FALSE; require(IsProcessInJob(state->process.get(), state->job.get(), &contained) && contained);
  require(current()); require(ResumeThread(thread.get()) != static_cast<DWORD>(-1)); child_input.close(); child_output.close();
  state->stop = winrt::handle(CreateEventW(nullptr, TRUE, FALSE, nullptr)); require(static_cast<bool>(state->stop));
  state->writer = std::make_unique<PipeFrameWriter>(state->input.get(), state->stop.get(), [] {});
  auto client = std::unique_ptr<WindowsTargetClient>(new WindowsTargetClient(std::move(state)));
  try { client->state_->decode(client->state_->read(6000), 0); require(current() && client->current()); }
  catch (...) { client->close(); throw; }
  return client;
}
WindowsTargetClient::~WindowsTargetClient() { close(); }
DWORD WindowsTargetClient::pid() const noexcept { return state_->pid; }
bool WindowsTargetClient::current() const noexcept {
  try { std::lock_guard lock(state_->mutex); if (state_->closed || WaitForSingleObject(state_->process.get(), 0) != WAIT_TIMEOUT || !windows_file_current(state_->files.helper) || !windows_file_current(state_->files.target)) return false;
    const auto observed = observe_windows_process(state_->pid); return observed.process.creation_time == state_->creation_time && same_file(observed.process.image, state_->files.target.image) && same_token(observed.process.token, observe_token(GetCurrentProcess())) && WaitForSingleObject(state_->process.get(), 0) == WAIT_TIMEOUT;
  } catch (...) { return false; }
}
WindowsTargetState WindowsTargetClient::request(WindowsTargetAction action) {
  std::lock_guard lock(state_->mutex); require(!state_->quit_acknowledged && current() && state_->next < kMaximumSafeInteger); const auto id = ++state_->next;
  JsonObject document; document.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(id))); document.Insert(L"op", JsonValue::CreateStringValue(windows_target_action(action)));
  JsonObject body; body.Insert(L"control", document); require(state_->writer->write(response_success(id, body))); return state_->decode(state_->read(2500), id, action == WindowsTargetAction::quit);
}
bool WindowsTargetClient::close() noexcept {
  try { std::lock_guard lock(state_->mutex); if (state_->closed) return state_->close_result;
    bool graceful = state_->quit_acknowledged;
    if (!graceful && state_->process && WaitForSingleObject(state_->process.get(), 0) == WAIT_TIMEOUT) { try { (void)request(WindowsTargetAction::quit); graceful = true; } catch (...) {} }
    state_->closed = true; if (state_->writer) { state_->writer->cancel(); (void)state_->writer->close(std::chrono::milliseconds(100)); } if (state_->stop) SetEvent(state_->stop.get()); state_->input.close();
    if (state_->process && WaitForSingleObject(state_->process.get(), 500) != WAIT_OBJECT_0) { TerminateProcess(state_->process.get(), 1); (void)WaitForSingleObject(state_->process.get(), 200); graceful = false; }
    DWORD code = 1; const bool reaped = !state_->process || (WaitForSingleObject(state_->process.get(), 0) == WAIT_OBJECT_0 && GetExitCodeProcess(state_->process.get(), &code)); state_->job.close(); state_->close_result = graceful && reaped && code == 0; return state_->close_result;
  } catch (...) { if (state_->process) TerminateProcess(state_->process.get(), 1); return false; }
}
}
