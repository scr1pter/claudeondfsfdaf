#include "windows_enum.h"
#include "windows_com.h"
#include "windows_icon.h"
#include "core.h"
#include "availability.h"
#include <dwmapi.h>
#include <knownfolders.h>
#include <propidl.h>
#include <propkey.h>
#include <propsys.h>
#include <propvarutil.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <uiautomation.h>
#include <algorithm>
#include <array>
#include <chrono>
#include <limits>
#include <map>
#include <set>
#include <thread>
#include <utility>
#include <winrt/base.h>

namespace vector::computer {
namespace {
using Clock = std::chrono::steady_clock;
[[noreturn]] void refuse(std::wstring code = L"unavailable") { throw Failure{std::move(code), L"The native window operation is unavailable."}; }
void observe_com_current(WindowsInventoryObserver observer, const WindowsComCall& call, WindowsComInventoryCall location) noexcept {
  if (observer) observe_windows_inventory_failure(observer, windows_com_inventory_diagnostic(call.observation(), location));
}
bool equal_i(std::wstring_view left, std::wstring_view right) noexcept {
  if (left.size() != right.size() || left.size() > static_cast<size_t>(std::numeric_limits<int>::max())) return false;
  return CompareStringOrdinal(left.data(), static_cast<int>(left.size()), right.data(), static_cast<int>(right.size()), TRUE) == CSTR_EQUAL;
}
std::wstring clean(std::wstring_view text, size_t limit) {
  std::wstring result;
  for (size_t index = 0; index < text.size() && result.size() < limit; ++index) {
    const auto value = static_cast<uint16_t>(text[index]);
    if (value < 32 || (value >= 0x7f && value <= 0x9f) || value == 0x061c || value == 0x200b ||
        (value >= 0x200e && value <= 0x200f) || (value >= 0x2028 && value <= 0x202e) ||
        (value >= 0x2060 && value <= 0x206f) || value == 0xfeff) continue;
    if (value >= 0xd800 && value <= 0xdbff) {
      if (index + 1 < text.size() && text[index + 1] >= 0xdc00 && text[index + 1] <= 0xdfff && result.size() + 2 <= limit) {
        result.push_back(text[index]); result.push_back(text[++index]);
      }
      continue;
    }
    if (value >= 0xdc00 && value <= 0xdfff) continue;
    result.push_back(text[index]);
  }
  return result;
}
WindowsRect rectangle(const RECT& rect) {
  return WindowsRect{rect.left, rect.top, int64_t(rect.right) - rect.left, int64_t(rect.bottom) - rect.top};
}
WindowsRect native_bounds(HWND window) {
  RECT rect{};
  if (!GetWindowRect(window, &rect)) refuse();
  const auto value = rectangle(rect); if (!value.valid()) refuse(); return value;
}
std::wstring native_class(HWND window) {
  wchar_t value[257]{}; const auto length = GetClassNameW(window, value, 257);
  if (length <= 0 || length > 256) refuse(); return std::wstring(value, static_cast<size_t>(length));
}
bool on_screen(const WindowsRect& bounds, bool visible, bool minimized) {
  if (!visible || minimized) return false;
  RECT rect{static_cast<LONG>(bounds.x), static_cast<LONG>(bounds.y), static_cast<LONG>(bounds.x + bounds.width), static_cast<LONG>(bounds.y + bounds.height)};
  return MonitorFromRect(&rect, MONITOR_DEFAULTTONULL) != nullptr;
}
std::optional<std::wstring> appid(HWND window) {
  WindowsComCall call;
  if (!call.current()) return {};
  winrt::com_ptr<IPropertyStore> store;
  if (FAILED(SHGetPropertyStoreForWindow(window, IID_PPV_ARGS(store.put())))) return {};
  PROPVARIANT property{}; PropVariantInit(&property);
  const auto status = store->GetValue(PKEY_AppUserModel_ID, &property);
  std::optional<std::wstring> result;
  if (SUCCEEDED(status) && property.vt == VT_LPWSTR && property.pwszVal) {
    const auto count = wcsnlen_s(property.pwszVal, 513);
    if (count > 0 && count <= 512) result = std::wstring(property.pwszVal, count);
  }
  PropVariantClear(&property); return call.current() ? result : std::nullopt;
}
struct ChildWindows {
  HWND root = nullptr;
  size_t count = 0;
  Clock::time_point deadline;
  bool complete = true;
  std::vector<std::pair<HWND, DWORD>> candidates;
};
BOOL CALLBACK children(HWND window, LPARAM raw) noexcept {
  auto& state = *reinterpret_cast<ChildWindows*>(raw);
  if (++state.count > 128 || Clock::now() >= state.deadline) { state.complete = false; return FALSE; }
  try {
    if (native_class(window) != L"Windows.UI.Core.CoreWindow") return TRUE;
    DWORD pid = 0; const auto thread = GetWindowThreadProcessId(window, &pid);
    if (!thread || !pid || GetAncestor(window, GA_ROOT) != state.root || !IsChild(state.root, window)) { state.complete = false; return FALSE; }
    state.candidates.emplace_back(window, pid);
  } catch (...) { state.complete = false; return FALSE; }
  return TRUE;
}
std::vector<std::pair<HWND, DWORD>> child_windows(HWND root) {
  ChildWindows state{root, 0, Clock::now() + std::chrono::milliseconds(20), true, {}};
  EnumChildWindows(root, children, reinterpret_cast<LPARAM>(&state));
  if (!state.complete) refuse(); return state.candidates;
}
bool frame_host(const WindowsOwner& owner) {
  return owner.identity.verified && owner.identity.system && owner.identity.kind == WindowsAppKind::exe &&
      equal_i(owner.identity.binary, L"ApplicationFrameHost.exe");
}
bool current_desktop(HWND window) {
  WindowsComCall call;
  if (!call.current()) refuse();
  winrt::com_ptr<IVirtualDesktopManager> desktops;
  if (FAILED(CoCreateInstance(CLSID_VirtualDesktopManager, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(desktops.put())))) refuse();
  BOOL current = FALSE; if (FAILED(desktops->IsWindowOnCurrentVirtualDesktop(window, &current))) refuse();
  if (!call.current()) refuse(); return current != FALSE;
}
bool interactive_desktop() {
  const auto desktop = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS);
  if (!desktop) return false;
  wchar_t name[64]{}; DWORD bytes = 0;
  const bool same = GetUserObjectInformationW(desktop, UOI_NAME, name, sizeof(name), &bytes) &&
      bytes > sizeof(wchar_t) && bytes <= sizeof(name) && std::wstring_view(name) == L"Default";
  CloseDesktop(desktop); return same;
}
struct NativeWindows {
  std::function<std::optional<bool>(const WindowsOwner&)> shell_observer;
  WindowsInventoryObserver diagnostic = nullptr;

  WindowsWindow observe(HWND window) const {
    if (!window || !IsWindow(window) || GetAncestor(window, GA_ROOT) != window) refuse(L"changed");
    DWORD pid = 0; const auto thread = GetWindowThreadProcessId(window, &pid);
    if (!thread || !pid) refuse(L"changed");
    const auto physical = observe_windows_process(pid);
    WindowsWindow result;
    result.hwnd = window; result.surface = window; result.thread_id = thread; result.surface_thread_id = thread;
    result.physical_owner = physical; result.owner = physical;
    result.bounds = native_bounds(window); result.surface_bounds = result.bounds; result.window_class = native_class(window);
    DWORD cloak = 0;
    if (FAILED(DwmGetWindowAttribute(window, DWMWA_CLOAKED, &cloak, sizeof(cloak)))) refuse();
    result.cloaked = cloak != 0;
    result.current_desktop = current_desktop(window);
    result.visible = IsWindowVisible(window) != FALSE; result.minimized = IsIconic(window) != FALSE;
    result.on_screen = on_screen(result.bounds, result.visible, result.minimized);
    if (frame_host(physical)) {
      const auto candidates = child_windows(window);
      if (candidates.size() != 1 || candidates[0].second == pid) refuse(L"protected");
      result.host_aumid = appid(window);
      if (!result.host_aumid) refuse(L"protected");
      result.owner = observe_windows_process(candidates[0].second);
      if (result.owner.identity.kind != WindowsAppKind::aumid ||
          !result.owner.process.package || !equal_i(*result.host_aumid, result.owner.identity.aumid)) refuse(L"protected");
      result.surface = candidates[0].first; result.surface_thread_id = GetWindowThreadProcessId(result.surface, nullptr);
      result.surface_bounds = native_bounds(result.surface);
      if (!result.surface_thread_id || !result.bounds.contains(result.surface_bounds)) refuse(L"protected");
    }
    const auto own_token = observe_token(GetCurrentProcess());
    auto availability = WindowsAvailabilityBackend::system();
    availability.helper = [own_token] { return std::optional<TokenIdentity>(own_token); };
    const auto actual = observe_windows_availability(availability);
    require_windows_surface(actual);
    const auto physical_state = windows_surface_state(actual, &physical.process.token);
    const auto logical_state = windows_surface_state(actual, &result.owner.process.token);
    // Elevated surfaces may be listed structurally for handoff, while another principal or an
    // unknown context cannot disclose a title or become an app-scoped native target.
    if (physical_state != WindowsSurfaceState::elevated) require_windows_surface(actual, &physical.process.token);
    if (logical_state != WindowsSurfaceState::elevated) require_windows_surface(actual, &result.owner.process.token);
    result.elevated = physical_state == WindowsSurfaceState::elevated || logical_state == WindowsSurfaceState::elevated;
    if (shell_observer) result.child_shell = shell_observer(result.owner);
    if (!windows_window_current(result)) refuse(L"changed");
    return result;
  }
  struct Enumeration {
    const NativeWindows* native;
    Clock::time_point deadline;
    const std::function<bool()>* current;
    std::vector<WindowsWindow> windows;
    size_t visited = 0;
    bool cancelled = false;
  };
  static BOOL CALLBACK enumerate(HWND window, LPARAM raw) noexcept {
    auto& state = *reinterpret_cast<Enumeration*>(raw);
    if (++state.visited > 4096 || state.windows.size() >= 1000 || Clock::now() >= state.deadline) return FALSE;
    if (!(*state.current)()) { state.cancelled = true; return FALSE; }
    try {
      if (!IsWindowVisible(window) && !IsIconic(window)) return TRUE;
      auto value = state.native->observe(window);
      if (eligible_windows_window(value)) state.windows.push_back(std::move(value));
    } catch (...) { /* Unknown, recycled, unproven-host and inaccessible windows never become content. */ }
    return TRUE;
  }
  std::vector<WindowsApplication> list(bool installed, const std::function<bool()>& current) const {
    const auto deadline = Clock::now() + std::chrono::seconds(4);
    Enumeration state{this, deadline, &current, {}, 0, false};
    EnumWindows(enumerate, reinterpret_cast<LPARAM>(&state)); if (state.cancelled || !current()) refuse(L"changed");
    std::vector<WindowsApplication> apps;
    std::map<DWORD, size_t> indices;
    const auto foreground = GetForegroundWindow();
    for (auto& window : state.windows) {
      const auto pid = window.owner.process.pid;
      if (!indices.contains(pid)) { indices.emplace(pid, apps.size()); apps.push_back(WindowsApplication{window.owner.identity, window.owner, {}, false, {}}); }
      auto& app = apps[indices.at(pid)]; app.active = app.active || window.hwnd == foreground; app.windows.push_back(std::move(window));
    }
    if (installed && Clock::now() < deadline) installed_apps(apps, std::min(deadline, Clock::now() + std::chrono::seconds(2)), current);
    size_t icons = 0;
    for (auto& app : apps) {
      if (!current()) refuse(L"changed");
      if (icons >= 128 || Clock::now() >= deadline) break;
      app.icon = windows_application_icon(app); ++icons;
    }
    return apps;
  }
  void installed_apps(std::vector<WindowsApplication>& apps, Clock::time_point deadline, const std::function<bool()>& current) const {
    winrt::com_ptr<IShellItem> folder;
    winrt::com_ptr<IEnumShellItems> enumeration;
    {
      WindowsComCall call;
      if (!call.current()) { observe_com_current(diagnostic, call, WindowsComInventoryCall::folder_start); refuse(); }
      if (FAILED(SHGetKnownFolderItem(FOLDERID_AppsFolder, KF_FLAG_DEFAULT, nullptr, IID_PPV_ARGS(folder.put())))) { observe_windows_inventory_failure(diagnostic, WindowsInventoryDiagnostic::apps_folder); refuse(); }
      if (!call.current()) { observe_com_current(diagnostic, call, WindowsComInventoryCall::folder_after); refuse(); }
      if (FAILED(folder->BindToHandler(nullptr, BHID_EnumItems, IID_PPV_ARGS(enumeration.put())))) { observe_windows_inventory_failure(diagnostic, WindowsInventoryDiagnostic::apps_bind); refuse(); }
      if (!call.current()) { observe_com_current(diagnostic, call, WindowsComInventoryCall::bind_after); refuse(); }
    }
    for (size_t count = 0; count < 2048 && apps.size() < 1000 && Clock::now() < deadline; ++count) {
      if (!current()) refuse(L"changed");
      winrt::com_ptr<IShellItem> item; ULONG fetched = 0;
      HRESULT status = E_FAIL;
      { WindowsComCall call;
        if (!call.current()) { observe_com_current(diagnostic, call, WindowsComInventoryCall::next_start); refuse(); }
        status = enumeration->Next(1, item.put(), &fetched);
        if (!call.current()) { observe_com_current(diagnostic, call, WindowsComInventoryCall::next_after); refuse(); } }
      if (status == S_FALSE) break;
      if (FAILED(status) || fetched != 1 || !item) { observe_windows_inventory_failure(diagnostic, WindowsInventoryDiagnostic::apps_next); refuse(); }
      try {
        winrt::com_ptr<IPropertyStore> properties;
        {
          WindowsComCall call;
          if (!call.current() || FAILED(item->BindToHandler(nullptr, BHID_PropertyStore, IID_PPV_ARGS(properties.put()))) || !call.current()) continue;
        }
        const auto property = [&](const PROPERTYKEY& key, size_t maximum) -> std::optional<std::wstring> {
          WindowsComCall call; if (!call.current()) return {};
          PROPVARIANT value{}; PropVariantInit(&value); const auto read = properties->GetValue(key, &value);
          std::optional<std::wstring> result;
          if (SUCCEEDED(read) && value.vt == VT_LPWSTR && value.pwszVal) { const auto length = wcsnlen_s(value.pwszVal, maximum + 1); if (length > 0 && length <= maximum) result = std::wstring(value.pwszVal, length); }
          PropVariantClear(&value); return call.current() ? result : std::nullopt;
        };
        const auto aumid = property(PKEY_AppUserModel_ID, 512), target = property(PKEY_Link_TargetParsingPath, 4096);
        WindowsStaticIdentity observed;
        if (aumid && aumid->find(L'!') != std::wstring::npos) observed = observe_windows_aumid(*aumid);
        else if (target) observed = observe_windows_file(*target);
        else continue;
        if (!windows_file_current(observed)) continue;
        const auto exists = std::any_of(apps.begin(), apps.end(), [&](const auto& app) {
          if (app.identity.kind != observed.identity.kind) return false;
          if (app.identity.kind == WindowsAppKind::aumid) return equal_i(app.identity.aumid, observed.identity.aumid);
          return app.owner && same_file(app.owner->process.image, observed.image);
        });
        if (!exists) apps.push_back(WindowsApplication{observed.identity, {}, observed, false, {}});
      } catch (...) { /* No trustworthy static identity means no launchable app entry. */ }
    }
  }
};
}

void observe_windows_inventory_failure(WindowsInventoryObserver observer, WindowsInventoryDiagnostic diagnostic) noexcept {
  try { if (observer) observer(diagnostic); } catch (...) {}
}
std::wstring_view windows_inventory_diagnostic_stage(WindowsInventoryDiagnostic diagnostic) noexcept {
  switch (diagnostic) {
    case WindowsInventoryDiagnostic::capture_identity: return L"capture-structural-identity";
    case WindowsInventoryDiagnostic::capture_bounds: return L"capture-structural-bounds";
    case WindowsInventoryDiagnostic::capture_cloak: return L"capture-structural-cloak";
    case WindowsInventoryDiagnostic::capture_class: return L"capture-structural-class";
    case WindowsInventoryDiagnostic::capture_style: return L"capture-structural-style";
    case WindowsInventoryDiagnostic::capture_cap: return L"capture-enumeration-cap";
    case WindowsInventoryDiagnostic::capture_deadline: return L"capture-enumeration-deadline";
    case WindowsInventoryDiagnostic::capture_context: return L"capture-enumeration-context";
    case WindowsInventoryDiagnostic::capture_enum: return L"capture-enumeration-api";
    case WindowsInventoryDiagnostic::capture_structure: return L"capture-structural-exception";
    case WindowsInventoryDiagnostic::apps_folder: return L"installed-apps-folder";
    case WindowsInventoryDiagnostic::apps_bind: return L"installed-apps-bind";
    case WindowsInventoryDiagnostic::apps_next: return L"installed-apps-next";
    case WindowsInventoryDiagnostic::apps_current: return L"installed-apps-com-current";
    case WindowsInventoryDiagnostic::apps_count: return L"installed-apps-count";
    case WindowsInventoryDiagnostic::apps_shape: return L"installed-apps-shape";
    case WindowsInventoryDiagnostic::apps_title: return L"installed-apps-title";
    case WindowsInventoryDiagnostic::apps_icon: return L"installed-apps-icon";
    case WindowsInventoryDiagnostic::capture_bounds_read: return L"capture-bounds-read";
    case WindowsInventoryDiagnostic::capture_bounds_empty: return L"capture-bounds-empty";
    case WindowsInventoryDiagnostic::capture_bounds_negative: return L"capture-bounds-negative";
    case WindowsInventoryDiagnostic::capture_bounds_range: return L"capture-bounds-range";
    case WindowsInventoryDiagnostic::capture_empty_cloaked: return L"capture-empty-cloaked";
    case WindowsInventoryDiagnostic::capture_empty_visible: return L"capture-empty-visible";
    case WindowsInventoryDiagnostic::capture_empty_minimized: return L"capture-empty-minimized";
    case WindowsInventoryDiagnostic::capture_empty_hidden: return L"capture-empty-hidden";
    case WindowsInventoryDiagnostic::capture_empty_unknown: return L"capture-empty-unknown";
    case WindowsInventoryDiagnostic::apps_folder_start_uninitialized: return L"installed-folder-start-uninitialized";
    case WindowsInventoryDiagnostic::apps_folder_start_cancellation: return L"installed-folder-start-cancellation";
    case WindowsInventoryDiagnostic::apps_folder_start_timer: return L"installed-folder-start-timer";
    case WindowsInventoryDiagnostic::apps_folder_start_expired: return L"installed-folder-start-expired";
    case WindowsInventoryDiagnostic::apps_folder_after_uninitialized: return L"installed-folder-after-uninitialized";
    case WindowsInventoryDiagnostic::apps_folder_after_cancellation: return L"installed-folder-after-cancellation";
    case WindowsInventoryDiagnostic::apps_folder_after_timer: return L"installed-folder-after-timer";
    case WindowsInventoryDiagnostic::apps_folder_after_expired: return L"installed-folder-after-expired";
    case WindowsInventoryDiagnostic::apps_bind_after_uninitialized: return L"installed-bind-after-uninitialized";
    case WindowsInventoryDiagnostic::apps_bind_after_cancellation: return L"installed-bind-after-cancellation";
    case WindowsInventoryDiagnostic::apps_bind_after_timer: return L"installed-bind-after-timer";
    case WindowsInventoryDiagnostic::apps_bind_after_expired: return L"installed-bind-after-expired";
    case WindowsInventoryDiagnostic::apps_next_start_uninitialized: return L"installed-next-start-uninitialized";
    case WindowsInventoryDiagnostic::apps_next_start_cancellation: return L"installed-next-start-cancellation";
    case WindowsInventoryDiagnostic::apps_next_start_timer: return L"installed-next-start-timer";
    case WindowsInventoryDiagnostic::apps_next_start_expired: return L"installed-next-start-expired";
    case WindowsInventoryDiagnostic::apps_next_after_uninitialized: return L"installed-next-after-uninitialized";
    case WindowsInventoryDiagnostic::apps_next_after_cancellation: return L"installed-next-after-cancellation";
    case WindowsInventoryDiagnostic::apps_next_after_timer: return L"installed-next-after-timer";
    case WindowsInventoryDiagnostic::apps_next_after_expired: return L"installed-next-after-expired";
    default: return {};
  }
}
WindowsInventoryDiagnostic windows_com_inventory_diagnostic(WindowsComObservation observation, WindowsComInventoryCall location) noexcept {
  constexpr std::array<std::array<WindowsInventoryDiagnostic, 4>, 5> stages{{
    {WindowsInventoryDiagnostic::apps_folder_start_uninitialized, WindowsInventoryDiagnostic::apps_folder_start_cancellation, WindowsInventoryDiagnostic::apps_folder_start_timer, WindowsInventoryDiagnostic::apps_folder_start_expired},
    {WindowsInventoryDiagnostic::apps_folder_after_uninitialized, WindowsInventoryDiagnostic::apps_folder_after_cancellation, WindowsInventoryDiagnostic::apps_folder_after_timer, WindowsInventoryDiagnostic::apps_folder_after_expired},
    {WindowsInventoryDiagnostic::apps_bind_after_uninitialized, WindowsInventoryDiagnostic::apps_bind_after_cancellation, WindowsInventoryDiagnostic::apps_bind_after_timer, WindowsInventoryDiagnostic::apps_bind_after_expired},
    {WindowsInventoryDiagnostic::apps_next_start_uninitialized, WindowsInventoryDiagnostic::apps_next_start_cancellation, WindowsInventoryDiagnostic::apps_next_start_timer, WindowsInventoryDiagnostic::apps_next_start_expired},
    {WindowsInventoryDiagnostic::apps_next_after_uninitialized, WindowsInventoryDiagnostic::apps_next_after_cancellation, WindowsInventoryDiagnostic::apps_next_after_timer, WindowsInventoryDiagnostic::apps_next_after_expired}}};
  const auto row = static_cast<unsigned>(location), column = static_cast<unsigned>(observation);
  return row < stages.size() && column >= 1 && column <= 4 ? stages[row][column - 1] : WindowsInventoryDiagnostic::apps_current;
}
WindowsInventoryDiagnostic windows_capture_bounds_diagnostic(const WindowsRect& value) noexcept {
  if (value.valid()) return WindowsInventoryDiagnostic::none;
  if (value.width < 0 || value.height < 0) return WindowsInventoryDiagnostic::capture_bounds_negative;
  constexpr auto bound = WindowsRect::bound;
  if (value.x < -bound || value.x > bound || value.y < -bound || value.y > bound || value.width > bound || value.height > bound ||
      value.x > bound - value.width || value.y > bound - value.height) return WindowsInventoryDiagnostic::capture_bounds_range;
  return WindowsInventoryDiagnostic::capture_bounds_empty;
}
WindowsInventoryDiagnostic windows_capture_empty_diagnostic(bool cloak_known, bool cloaked, bool visible, bool minimized) noexcept {
  if (!cloak_known) return WindowsInventoryDiagnostic::capture_empty_unknown;
  if (cloaked) return WindowsInventoryDiagnostic::capture_empty_cloaked;
  if (minimized) return WindowsInventoryDiagnostic::capture_empty_minimized;
  return visible ? WindowsInventoryDiagnostic::capture_empty_visible : WindowsInventoryDiagnostic::capture_empty_hidden;
}
bool WindowsRect::valid() const noexcept {
  return x >= -bound && x <= bound && y >= -bound && y <= bound && width > 0 && height > 0 && width <= bound && height <= bound && x <= bound - width && y <= bound - height;
}
bool WindowsRect::contains(const WindowsRect& value) const noexcept {
  return valid() && value.valid() && value.x >= x && value.y >= y && value.x + value.width <= x + width && value.y + value.height <= y + height;
}
bool WindowsRect::contains(POINT point) const noexcept { return valid() && point.x >= x && point.y >= y && point.x < x + width && point.y < y + height; }
JsonObject WindowsRect::wire() const {
  if (!valid()) refuse(); JsonObject result;
  result.Insert(L"x", JsonValue::CreateNumberValue(static_cast<double>(x))); result.Insert(L"y", JsonValue::CreateNumberValue(static_cast<double>(y)));
  result.Insert(L"w", JsonValue::CreateNumberValue(static_cast<double>(width))); result.Insert(L"h", JsonValue::CreateNumberValue(static_cast<double>(height))); return result;
}
bool eligible_windows_window(const WindowsWindow& window) noexcept {
  return window.hwnd && window.surface && window.thread_id && window.surface_thread_id && window.owner.process.pid && window.physical_owner.process.pid &&
      window.bounds.valid() && window.surface_bounds.valid() && window.bounds.contains(window.surface_bounds) && !window.cloaked && window.current_desktop && (window.visible || window.minimized);
}
bool same_windows_window(const WindowsWindow& left, const WindowsWindow& right) noexcept {
  return same_windows_window_target(left, right) &&
      left.bounds == right.bounds && left.surface_bounds == right.surface_bounds && left.child_shell == right.child_shell &&
      left.visible == right.visible && left.minimized == right.minimized && left.on_screen == right.on_screen && left.cloaked == right.cloaked && left.current_desktop == right.current_desktop && left.elevated == right.elevated;
}
bool same_windows_window_target(const WindowsWindow& left, const WindowsWindow& right) noexcept {
  return left.hwnd == right.hwnd && left.surface == right.surface && left.thread_id == right.thread_id && left.surface_thread_id == right.surface_thread_id &&
      same_windows_process(left.physical_owner.process, right.physical_owner.process) && same_windows_process(left.owner.process, right.owner.process) &&
      same_windows_identity(left.physical_owner.identity, right.physical_owner.identity) && same_windows_identity(left.owner.identity, right.owner.identity) &&
      left.window_class == right.window_class && left.host_aumid == right.host_aumid;
}
std::wstring window_id(HWND window) { return std::to_wstring(reinterpret_cast<uintptr_t>(window)); }
std::optional<HWND> parse_window_id(std::wstring_view value) noexcept {
  if (value.empty() || value.size() > 20 || value.front() == L'0') return {};
  uintptr_t result = 0;
  for (const auto digit : value) {
    if (digit < L'0' || digit > L'9' || result > (std::numeric_limits<uintptr_t>::max() - static_cast<uintptr_t>(digit - L'0')) / 10) return {};
    result = result * 10 + static_cast<uintptr_t>(digit - L'0');
  }
  return result ? std::optional<HWND>(reinterpret_cast<HWND>(result)) : std::nullopt;
}
bool windows_window_current(const WindowsWindow& window) noexcept {
  try {
    if (!window.hwnd || !window.surface || !IsWindow(window.hwnd) || !IsWindow(window.surface) || GetAncestor(window.hwnd, GA_ROOT) != window.hwnd ||
        GetAncestor(window.surface, GA_ROOT) != window.hwnd || !windows_owner_current(window.physical_owner) || !windows_owner_current(window.owner)) return false;
    DWORD physical = 0, logical = 0;
    if (GetWindowThreadProcessId(window.hwnd, &physical) != window.thread_id || physical != window.physical_owner.process.pid ||
        GetWindowThreadProcessId(window.surface, &logical) != window.surface_thread_id || logical != window.owner.process.pid ||
        native_bounds(window.hwnd) != window.bounds || native_bounds(window.surface) != window.surface_bounds || native_class(window.hwnd) != window.window_class) return false;
    if (window.hwnd != window.surface) { const auto children = child_windows(window.hwnd); if (children.size() != 1 || children[0] != std::make_pair(window.surface, window.owner.process.pid)) return false; }
    DWORD cloak = 1;
    // DesktopManager is an outside-authority preparation fact. This final check is native metadata
    // only; cloak changes and the caller's <=50ms preparation/observation epoch retire that fact.
    return SUCCEEDED(DwmGetWindowAttribute(window.hwnd, DWMWA_CLOAKED, &cloak, sizeof(cloak))) && (cloak != 0) == window.cloaked &&
        (IsWindowVisible(window.hwnd) != FALSE) == window.visible && (IsIconic(window.hwnd) != FALSE) == window.minimized;
  } catch (...) { return false; }
}

WindowsBackend WindowsBackend::system(std::function<std::optional<bool>(const WindowsOwner&)> shell_observer, WindowsInventoryObserver diagnostic) {
  const auto native = std::make_shared<NativeWindows>(NativeWindows{std::move(shell_observer), diagnostic});
  WindowsBackend backend;
  backend.list = [native](bool installed, const auto& current) { return native->list(installed, current); };
  backend.observe = [native](HWND window) { return native->observe(window); };
  backend.current = windows_window_current;
  backend.title = [](const WindowsWindow& window) {
    if (!windows_window_current(window)) refuse(L"changed");
    wchar_t title[1025]{}; const auto length = GetWindowTextW(window.hwnd, title, 1025);
    if (!windows_window_current(window)) refuse(L"changed");
    return clean(std::wstring_view(title, length > 0 ? static_cast<size_t>(length) : 0), 1024);
  };
  backend.foreground = [](const WindowsWindow& window) {
    if (!windows_window_current(window) || GetForegroundWindow() != window.hwnd) return false;
    if (window.surface == window.hwnd) return true;
    GUITHREADINFO info{}; info.cbSize = sizeof(info);
    if (!GetGUIThreadInfo(window.surface_thread_id, &info) || !info.hwndFocus || (info.hwndFocus != window.surface && !IsChild(window.surface, info.hwndFocus))) return false;
    DWORD pid = 0; GetWindowThreadProcessId(info.hwndFocus, &pid); return pid == window.owner.process.pid;
  };
  backend.focus = [native](const WindowsWindow& prepared, const OperationContext& context, const std::function<void(const WindowsWindow&)>& policy) {
    if (!interactive_desktop()) refuse(L"secure_desktop");
    auto prepared_at = Clock::now();
    auto live = native->observe(prepared.hwnd);
    if (!same_windows_window(live, prepared)) refuse(L"changed");
    if (live.minimized) {
      bool initiated = false;
      if (!context.with_current([&] { if (Clock::now() - prepared_at >= std::chrono::milliseconds(50) || !windows_window_current(live)) refuse(L"changed"); policy(live); if(!context.is_current())refuse(L"changed");initiated = ShowWindowAsync(live.hwnd, SW_RESTORE) != FALSE; })) refuse(L"changed");
      if (!initiated) return false;
      const auto deadline = Clock::now() + std::chrono::milliseconds(700);
      while (IsIconic(live.hwnd) && Clock::now() < deadline) { if (!context.is_current()) refuse(L"changed"); std::this_thread::sleep_for(std::chrono::milliseconds(10)); }
      prepared_at = Clock::now(); const auto restored = native->observe(live.hwnd);
      if (!same_windows_window_target(restored, live) || restored.minimized) refuse(L"changed");
      live = restored;
    }
    winrt::com_ptr<IUIAutomationElement> focused;
    {
      WindowsComCall call;
      if (!call.current()) return false;
      winrt::com_ptr<IUIAutomation> automation;
      if (FAILED(CoCreateInstance(CLSID_CUIAutomation8, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(automation.put())))) return false;
      const auto timeouts = automation.try_as<IUIAutomation2>();
      if (!timeouts || FAILED(timeouts->put_ConnectionTimeout(50)) || FAILED(timeouts->put_TransactionTimeout(50)) ||
          FAILED(automation->ElementFromHandle(live.surface, focused.put())) || !call.current()) return false;
      int pid = 0; UIA_HWND handle = nullptr;
      if (FAILED(focused->get_CurrentProcessId(&pid)) || FAILED(focused->get_CurrentNativeWindowHandle(&handle)) ||
          pid <= 0 || static_cast<DWORD>(pid) != live.owner.process.pid || reinterpret_cast<HWND>(handle) != live.surface || !call.current()) return false;
    }
    // UIA preparation may use its own entire RPC budget. Renew full desktop/owner/tree facts outside
    // authority immediately before the native initiation, then keep final checks metadata-only.
    prepared_at = Clock::now(); const auto final = native->observe(live.hwnd);
    if (!same_windows_window(final, live)) refuse(L"changed"); live = final;
    bool requested = false;
    if (!context.with_current([&] {
      if (Clock::now() - prepared_at >= std::chrono::milliseconds(50) || !windows_window_current(live)) refuse(L"changed"); policy(live);
      WindowsComCall call;
      if (!call.current()) return;
      // Respect the OS foreground rules; UIA is the real user-equivalent focus route.
      if(!context.is_current())refuse(L"changed");
      (void)SetForegroundWindow(live.hwnd);
      if(!context.is_current())refuse(L"changed");
      const auto result = focused->SetFocus();
      if (!call.current()) refuse(L"changed"); requested = SUCCEEDED(result);
    })) refuse(L"changed");
    if (!requested) return false;
    const auto deadline = Clock::now() + std::chrono::milliseconds(700);
    while (Clock::now() < deadline) {
      if (!context.is_current() || !windows_window_current(live)) refuse(L"changed");
      if (GetForegroundWindow() == live.hwnd) return true;
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    return false;
  };
  backend.cursor = [] {
    if (!interactive_desktop()) refuse(L"secure_desktop");
    POINT point{}; if (!GetCursorPos(&point)) refuse();
    const auto monitor = MonitorFromPoint(point, MONITOR_DEFAULTTONULL); MONITORINFOEXW info{}; info.cbSize = sizeof(info);
    if (!monitor || !GetMonitorInfoW(monitor, &info) || !interactive_desktop()) refuse();
    return WindowsCursor{point, info.szDevice};
  };
  return backend;
}
}
