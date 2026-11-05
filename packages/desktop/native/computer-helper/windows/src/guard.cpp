#include "guard.h"
#include "windows_process_tree.h"
#include "availability.h"
#include <dwmapi.h>
#include <algorithm>
#include <array>
#include <chrono>
#include <limits>
#include <set>
#include <stdexcept>
#include <winrt/base.h>

namespace vector::computer {
namespace {
[[noreturn]] void fail(std::wstring code, std::wstring message) { throw Failure{std::move(code), std::move(message)}; }
bool contains_window(const JsonArray& values, HWND window) {
  for (const auto& value : values) if (value.ValueType() == JsonValueType::String && parse_window_id(std::wstring_view(value.GetString())) == window) return true;
  return false;
}
bool contains_pid(const JsonArray& values, DWORD pid) {
  for (const auto& value : values) if (safe_integer(value) == pid) return true;
  return false;
}
bool current_stamp(const WindowsGuardStamp& stamp,const ServerSession& session,uint64_t now) {
  return stamp.observed_at_ms!=0 && now>=stamp.observed_at_ms && now-stamp.observed_at_ms<=50 &&
    stamp.run_epoch==session.run_epoch && stamp.observation_epoch==session.observation_epoch && stamp.session_id==session.id && stamp.revision==session.revision;
}
std::wstring native_class(HWND window) {
  wchar_t value[257]{};
  const auto length = GetClassNameW(window, value, 257);
  if (length <= 0 || length > 256) fail(L"changed", L"The native input surface changed.");
  return std::wstring(value, static_cast<size_t>(length));
}
bool class_allowed(const WindowsAppIdentity& identity, std::wstring_view window_class) {
  static const auto rules = WindowsBlocklist::generated();
  return !rules.refusal(identity, {std::wstring(window_class), false});
}
bool keyboard_focus_current(const WindowsWindow& window, const WindowsBackend& windows) {
  try {
    if (!windows.foreground(window)) return false;
    GUITHREADINFO info{}; info.cbSize = static_cast<DWORD>(sizeof(info));
    if (!GetGUIThreadInfo(window.surface_thread_id, &info) || !info.hwndFocus ||
        (info.hwndFocus != window.surface && !IsChild(window.surface, info.hwndFocus))) return false;
    DWORD pid = 0;
    return GetWindowThreadProcessId(info.hwndFocus, &pid) != 0 && pid == window.owner.process.pid &&
      class_allowed(window.owner.identity, native_class(info.hwndFocus));
  } catch (...) { return false; }
}
bool trusted_passthrough_overlay(HWND window, const ServerSession& session) {
  if (!contains_window(session.overlay_window_ids, window)) return false;
  DWORD pid = 0;
  if (!GetWindowThreadProcessId(window, &pid)) fail(L"protected", L"The native overlay owner could not be verified.");
  const auto style = GetWindowLongPtrW(window, GWL_EXSTYLE);
  // A Stop banner remains a real input surface. Only an exact native click-through overlay
  // can be skipped; an ID alone never permits posting through Vector's interactive controls.
  if (!windows_overlay_passthrough_allowed({window, pid, style}, session)) fail(L"protected", L"The native Vector surface receives input.");
  return true;
}
bool point_in_window(HWND window, POINT point) {
  if (!IsWindowVisible(window) || IsIconic(window)) return false;
  RECT bounds{};
  if (!GetWindowRect(window, &bounds)) fail(L"unavailable", L"The native hit bounds are unavailable.");
  if (!PtInRect(&bounds, point)) return false;
  DWORD cloaked = 0;
  if (FAILED(DwmGetWindowAttribute(window, DWMWA_CLOAKED, &cloaked, static_cast<DWORD>(sizeof(cloaked))))) fail(L"unavailable", L"The native hit surface is unavailable.");
  if (cloaked != 0) return false;
  const auto region = CreateRectRgn(0, 0, 0, 0);
  if (!region) fail(L"unavailable", L"The native hit region is unavailable.");
  const auto kind = GetWindowRgn(window, region);
  const auto local_x = static_cast<int64_t>(point.x) - bounds.left, local_y = static_cast<int64_t>(point.y) - bounds.top;
  if (local_x > std::numeric_limits<int>::max() || local_y > std::numeric_limits<int>::max()) { DeleteObject(region); fail(L"unavailable", L"The native hit region is too large."); }
  const auto inside = kind == ERROR || PtInRegion(region, static_cast<int>(local_x), static_cast<int>(local_y));
  DeleteObject(region);
  return inside;
}
HWND deepest_child(HWND root, POINT point) {
  auto current = root;
  std::set<HWND> seen;
  for (size_t depth = 0; depth < 32; ++depth) {
    if (!seen.insert(current).second) fail(L"changed", L"The native hit hierarchy changed.");
    POINT local = point;
    if (!ScreenToClient(current, &local)) fail(L"unavailable", L"The native hit coordinates are unavailable.");
    const auto child = ChildWindowFromPointEx(current, local, CWP_SKIPINVISIBLE | CWP_SKIPDISABLED | CWP_SKIPTRANSPARENT);
    if (!child || child == current) return current;
    if (!IsChild(current, child)) fail(L"changed", L"The native hit hierarchy changed.");
    current = child;
  }
  fail(L"unavailable", L"The native hit hierarchy is too deep.");
}
struct NativeHit { HWND hit = nullptr, root = nullptr; std::vector<HWND> overlays; };
NativeHit native_hit(POINT point, const ServerSession& session, bool test_nonclient) {
  const auto started = GetTickCount64();
  NativeHit result;
  result.hit = WindowFromPoint(point);
  if (!result.hit) fail(L"unavailable", L"The native pointer target is unavailable.");
  result.root = GetAncestor(result.hit, GA_ROOT);
  if (!result.root) fail(L"changed", L"The native pointer target changed.");
  std::set<HWND> seen;
  size_t checked = 0;
  while (trusted_passthrough_overlay(result.root, session)) {
    if (!seen.insert(result.root).second || result.overlays.size() >= 32) fail(L"unavailable", L"The native overlay stack is unavailable.");
    result.overlays.push_back(result.root);
    auto next = GetWindow(result.root, GW_HWNDNEXT);
    while (next) {
      const auto now = GetTickCount64();
      if (++checked > 256 || now < started || now - started >= 25 || !seen.insert(next).second) fail(L"unavailable", L"The native window stack is unavailable.");
      if (!point_in_window(next, point)) { next = GetWindow(next, GW_HWNDNEXT); continue; }
      if (contains_window(session.overlay_window_ids, next)) {
        // The outer loop validates actual PID and native pass-through styles before skipping.
        seen.erase(next); break;
      }
      const auto style = GetWindowLongPtrW(next, GWL_EXSTYLE);
      // Native WindowFromPoint already handles layered alpha. When reconstructing the stack
      // beneath an explicitly excluded overlay, unknown alpha cannot become a target proof.
      if ((style & WS_EX_LAYERED) != 0) fail(L"unavailable", L"The underlying native hit surface is uncertain.");
      if (test_nonclient) {
        if (point.x < std::numeric_limits<SHORT>::min() || point.x > std::numeric_limits<SHORT>::max() ||
            point.y < std::numeric_limits<SHORT>::min() || point.y > std::numeric_limits<SHORT>::max()) fail(L"unavailable", L"The native hit coordinates cannot be represented.");
        const auto coordinates = MAKELPARAM(static_cast<WORD>(static_cast<SHORT>(point.x)), static_cast<WORD>(static_cast<SHORT>(point.y)));
        DWORD_PTR hit = static_cast<DWORD_PTR>(static_cast<LRESULT>(HTERROR));
        if (!SendMessageTimeoutW(next, WM_NCHITTEST, 0, coordinates, SMTO_ABORTIFHUNG | SMTO_BLOCK, 25, &hit)) fail(L"unavailable", L"The underlying native hit test did not complete.");
        if (static_cast<LRESULT>(hit) == HTTRANSPARENT || static_cast<LRESULT>(hit) == HTNOWHERE) { next = GetWindow(next, GW_HWNDNEXT); continue; }
        if (static_cast<LRESULT>(hit) == HTERROR) fail(L"unavailable", L"The underlying native hit test is unavailable.");
      }
      break;
    }
    if (!next) fail(L"unavailable", L"The underlying native pointer target is unavailable.");
    result.root = next; result.hit = deepest_child(next, point);
  }
  return result;
}
bool same_point(POINT left, POINT right) noexcept { return left.x == right.x && left.y == right.y; }
bool same_session(const ServerSession& expected, const std::optional<ServerSession>& actual) noexcept {
  return actual && expected.run_epoch != 0 && expected.observation_epoch != 0 && expected.run_epoch == actual->run_epoch &&
    expected.observation_epoch == actual->observation_epoch && expected.id == actual->id && expected.revision == actual->revision;
}
}

bool windows_overlay_passthrough_allowed(const WindowsOverlayWitness& observed, const ServerSession& session) {
  const auto required = WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE;
  return observed.window && observed.pid != 0 && contains_window(session.overlay_window_ids, observed.window) &&
    contains_pid(session.vector_pids, observed.pid) && (observed.extended_style & required) == required;
}
WindowsGuardBackend WindowsGuardBackend::system() {
  auto windows = WindowsBackend::system(windows_child_shell);
  const auto availability = WindowsAvailabilityBackend::system();
  WindowsGuardBackend result;
  result.point = [windows](POINT point, const ServerSession& session) {
    const auto hit = native_hit(point, session, true);
    auto window = windows.observe(hit.root);
    DWORD pid = 0;
    const auto thread = GetWindowThreadProcessId(hit.hit, &pid);
    const auto window_class = native_class(hit.hit);
    if (!window.bounds.contains(point) || !window.surface_bounds.contains(point) ||
        (hit.hit != window.surface && !IsChild(window.surface, hit.hit)) || !thread || pid != window.owner.process.pid ||
        !class_allowed(window.owner.identity, window_class)) fail(L"protected", L"The native point is not owned by the approved app surface.");
    if (!windows.current(window)) fail(L"changed", L"The native pointer target changed.");
    return WindowsPointOwner{std::move(window), hit.hit, point, hit.overlays, pid, thread, window_class};
  };
  result.foreground = [windows] {
    const auto native = GetForegroundWindow();
    if (!native) fail(L"not_foreground", L"The native foreground app is unavailable.");
    auto window = windows.observe(native);
    if (!windows.current(window) || !windows.foreground(window)) fail(L"changed", L"The native foreground app changed.");
    return window;
  };
  result.current = [](const WindowsWindow& window) { return windows_window_current(window); };
  result.foreground_current = [windows](const WindowsWindow& window) { return windows.foreground(window); };
  result.keyboard_current = [windows](const WindowsWindow& window) { return keyboard_focus_current(window, windows); };
  result.require_surface = [availability](const WindowsWindow& window) {
    const auto actual = observe_windows_availability(availability);
    require_windows_surface(actual, &window.owner.process.token);
    require_windows_surface(actual, &window.physical_owner.process.token);
  };
  result.point_current = [](const WindowsPointOwner& expected, const ServerSession& session) {
    try {
      const auto actual = native_hit(expected.point, session, false);
      DWORD pid = 0;
      const auto thread = GetWindowThreadProcessId(actual.hit, &pid);
      const auto window_class = native_class(actual.hit);
      return actual.root == expected.window.hwnd && actual.hit == expected.hit && actual.overlays == expected.skipped_overlays &&
        thread != 0 && thread == expected.hit_thread && pid == expected.hit_pid && pid == expected.window.owner.process.pid &&
        window_class == expected.hit_class && class_allowed(expected.window.owner.identity, window_class) &&
        expected.window.bounds.contains(expected.point) && expected.window.surface_bounds.contains(expected.point) &&
        (actual.hit == expected.window.surface || IsChild(expected.window.surface, actual.hit));
    } catch (...) { return false; }
  };
  result.now = [] { return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count()); };
  return result;
}
WindowsGuard::WindowsGuard(WindowsGuardBackend backend) : backend_(std::move(backend)) {
  if (!backend_.point || !backend_.foreground || !backend_.current || !backend_.point_current || !backend_.foreground_current || !backend_.keyboard_current || !backend_.require_surface || !backend_.now) throw std::invalid_argument("guard.incomplete-backend");
}
WindowsPointOwner WindowsGuard::point(const WindowsWindow& expected, POINT point, const ServerSession& session) const {
  backend_.require_surface(expected);
  auto actual = backend_.point(point, session);
  backend_.require_surface(actual.window);
  WindowsSessionPolicy(session).require(actual.window, WindowsPolicyOperation::pointer);
  if (!class_allowed(actual.window.owner.identity, actual.hit_class)) fail(L"protected", L"The native input surface is protected.");
  if (!same_point(actual.point, point) || !actual.hit || actual.hit_pid != actual.window.owner.process.pid || actual.hit_thread == 0 || actual.hit_class.empty() ||
      !same_windows_window(actual.window, expected) || !backend_.current(actual.window)) fail(L"changed", L"The native pointer target changed.");
  if (!actual.window.visible || actual.window.minimized || !actual.window.on_screen || !backend_.foreground_current(actual.window)) fail(L"not_foreground", L"The native target is not visible and foreground.");
  if (!backend_.point_current(actual, session)) fail(L"changed", L"The native pointer ownership changed.");
  actual.stamp=WindowsGuardStamp(session,backend_.now());
  return actual;
}
WindowsWindow WindowsGuard::foreground(const WindowsWindow& expected, const ServerSession& session, WindowsPolicyOperation operation, std::optional<bool> secure, std::span<const std::wstring> keys) const {
  if ((operation != WindowsPolicyOperation::key && operation != WindowsPolicyOperation::type_text && operation != WindowsPolicyOperation::set_value) ||
      (operation == WindowsPolicyOperation::key && (keys.empty() || keys.size() > 8))) fail(L"failed", L"The native keyboard operation is invalid.");
  backend_.require_surface(expected);
  auto actual = backend_.foreground();
  backend_.require_surface(actual);
  WindowsSessionPolicy(session).require(actual, operation, secure, keys);
  if (!same_windows_window(actual, expected) || !backend_.current(actual)) fail(L"changed", L"The native foreground app changed.");
  if (!actual.visible || actual.minimized || !actual.on_screen || !backend_.keyboard_current(actual)) fail(L"not_foreground", L"The native target is not visible and foreground.");
  return actual;
}
void WindowsGuard::with_point(const WindowsWindow& expected, POINT point, const ServerSession& session, const OperationContext& context, const std::function<void()>& mutation) const {
  if (!mutation || !context.is_current || !context.with_current || !same_session(session,context.session) || !context.is_current()) fail(L"changed",L"The computer session changed.");
  const auto actual=this->point(expected,point,session); commit_point(actual,session,context,mutation);
}
void WindowsGuard::commit_point(const WindowsPointOwner& actual, const ServerSession& session, const OperationContext& context, const std::function<void()>& mutation,const std::function<void()>& precondition) const {
  if (!mutation || !context.is_current || !context.with_current || !same_session(session, context.session) || !context.is_current()) fail(L"changed", L"The computer session changed.");
  backend_.require_surface(actual.window);
  WindowsSessionPolicy(session).require(actual.window,WindowsPolicyOperation::pointer);
  if (!actual.hit || actual.hit_pid!=actual.window.owner.process.pid || !actual.hit_thread || actual.hit_class.empty() ||
      !class_allowed(actual.window.owner.identity,actual.hit_class)) fail(L"protected",L"The native input surface is protected.");
  if (!current_stamp(actual.stamp,session,backend_.now())) fail(L"changed",L"The native pointer observation expired.");
  if (!context.with_current([&] {
    backend_.require_surface(actual.window);
    if (precondition) precondition();
    WindowsSessionPolicy(session).require(actual.window,WindowsPolicyOperation::pointer);
    if (!current_stamp(actual.stamp,session,backend_.now()) || !backend_.current(actual.window) || !backend_.foreground_current(actual.window) || !backend_.point_current(actual, session) || !current_stamp(actual.stamp,session,backend_.now())) fail(L"changed", L"The native pointer ownership changed before input.");
    backend_.require_surface(actual.window);
    if (!current_stamp(actual.stamp,session,backend_.now())) fail(L"changed",L"The native pointer observation expired before input.");
    mutation();
  })) fail(L"changed", L"The computer session changed before input.");
}
void WindowsGuard::with_foreground(const WindowsWindow& expected, const ServerSession& session, const OperationContext& context, WindowsPolicyOperation operation, const std::function<void()>& mutation, std::optional<bool> secure, std::span<const std::wstring> keys) const {
  if (!mutation || !context.is_current || !context.with_current || !same_session(session,context.session) || !context.is_current()) fail(L"changed",L"The computer session changed.");
  const auto actual=foreground(expected,session,operation,secure,keys); commit_foreground(actual,session,context,WindowsGuardStamp(session,backend_.now()),operation,mutation,secure,keys);
}
void WindowsGuard::with_element(const WindowsWindow& expected, const ServerSession& session, const OperationContext& context, WindowsPolicyOperation operation, const std::function<void()>& mutation, std::optional<bool> secure) const {
  if (operation != WindowsPolicyOperation::pointer && operation != WindowsPolicyOperation::set_value) fail(L"failed", L"The native element operation is invalid.");
  if (!mutation || !context.is_current || !context.with_current || !same_session(session, context.session) || !context.is_current()) fail(L"changed", L"The computer session changed.");
  if (secure != false) fail(L"secure_field", L"The native element cannot receive this action.");
  backend_.require_surface(expected);
  const auto actual = backend_.foreground();
  backend_.require_surface(actual);
  WindowsSessionPolicy(session).require(actual, operation, secure);
  if (!same_windows_window(actual, expected) || !backend_.current(actual)) fail(L"changed", L"The native element window changed.");
  if (!actual.visible || actual.minimized || !actual.on_screen || !backend_.foreground_current(actual)) fail(L"not_foreground", L"The native element app is not visible and foreground.");
  const auto stamp = WindowsGuardStamp(session, backend_.now());
  if (!context.with_current([&] {
    backend_.require_surface(actual);
    WindowsSessionPolicy(session).require(actual, operation, secure);
    if (!current_stamp(stamp, session, backend_.now()) || !backend_.current(actual) || !backend_.foreground_current(actual) || !current_stamp(stamp, session, backend_.now())) fail(L"changed", L"The native element app changed before its action.");
    // AccessibilityService repeats its private registry proof here, then its single actor job
    // repeats element/security/menu facts. The actor caller waits at most 50ms and quarantines
    // timeout/late completion; no provider wait extends this authority fence indefinitely.
    backend_.require_surface(actual);
    if (!current_stamp(stamp,session,backend_.now())) fail(L"changed",L"The native element observation expired before its action.");
    mutation();
  })) fail(L"changed", L"The computer session changed before the element action.");
}
void WindowsGuard::commit_foreground(const WindowsWindow& actual, const ServerSession& session, const OperationContext& context, const WindowsGuardStamp& stamp, WindowsPolicyOperation operation, const std::function<void()>& mutation, std::optional<bool> secure, std::span<const std::wstring> keys,const std::function<void()>& precondition) const {
  if (!mutation || !context.is_current || !context.with_current || !same_session(session, context.session) || !context.is_current()) fail(L"changed", L"The computer session changed.");
  if ((operation!=WindowsPolicyOperation::key && operation!=WindowsPolicyOperation::type_text && operation!=WindowsPolicyOperation::set_value) ||
      (operation==WindowsPolicyOperation::key && (keys.empty() || keys.size()>8))) fail(L"failed",L"The native keyboard operation is invalid.");
  backend_.require_surface(actual);
  WindowsSessionPolicy(session).require(actual,operation,secure,keys);
  if (!current_stamp(stamp,session,backend_.now())) fail(L"changed",L"The native keyboard observation expired.");
  if (!context.with_current([&] {
    backend_.require_surface(actual);
    if (precondition) precondition();
    WindowsSessionPolicy(session).require(actual,operation,secure,keys);
    if (!current_stamp(stamp,session,backend_.now()) || !backend_.current(actual) || !backend_.keyboard_current(actual) || !current_stamp(stamp,session,backend_.now())) fail(L"changed", L"The native foreground app changed before input.");
    backend_.require_surface(actual);
    if (!current_stamp(stamp,session,backend_.now())) fail(L"changed",L"The native keyboard observation expired before input.");
    mutation();
  })) fail(L"changed", L"The computer session changed before input.");
}
}
