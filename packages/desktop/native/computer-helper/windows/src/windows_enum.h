#pragma once
#include "server.h"
#include "windows_identity.h"
#include <functional>
#include <optional>
#include <vector>

namespace vector::computer {
enum class WindowsInventoryDiagnostic {
  none, capture_identity, capture_bounds, capture_cloak, capture_class, capture_style,
  capture_cap, capture_deadline, capture_context, capture_enum, capture_structure,
  apps_folder, apps_bind, apps_next, apps_current, apps_count, apps_shape, apps_title, apps_icon,
  capture_bounds_read, capture_bounds_empty, capture_bounds_negative, capture_bounds_range,
  capture_empty_cloaked, capture_empty_visible, capture_empty_minimized, capture_empty_hidden, capture_empty_unknown,
  apps_folder_start_uninitialized, apps_folder_start_cancellation, apps_folder_start_timer, apps_folder_start_expired,
  apps_folder_after_uninitialized, apps_folder_after_cancellation, apps_folder_after_timer, apps_folder_after_expired,
  apps_bind_after_uninitialized, apps_bind_after_cancellation, apps_bind_after_timer, apps_bind_after_expired,
  apps_next_start_uninitialized, apps_next_start_cancellation, apps_next_start_timer, apps_next_start_expired,
  apps_next_after_uninitialized, apps_next_after_cancellation, apps_next_after_timer, apps_next_after_expired,
  count
};
// Optional metadata-only observation; ordinary factories have no observer.
using WindowsInventoryObserver = void (*)(WindowsInventoryDiagnostic);
enum class WindowsComObservation;
enum class WindowsComInventoryCall { folder_start, folder_after, bind_after, next_start, next_after, count };
WindowsInventoryDiagnostic windows_com_inventory_diagnostic(WindowsComObservation, WindowsComInventoryCall) noexcept;
void observe_windows_inventory_failure(WindowsInventoryObserver, WindowsInventoryDiagnostic) noexcept;
std::wstring_view windows_inventory_diagnostic_stage(WindowsInventoryDiagnostic) noexcept;
struct WindowsRect {
  static constexpr int64_t bound = 100'000'000;
  int64_t x = 0, y = 0, width = 0, height = 0;
  bool operator==(const WindowsRect&) const = default;
  bool valid() const noexcept;
  bool contains(const WindowsRect& value) const noexcept;
  bool contains(POINT point) const noexcept;
  JsonObject wire() const;
};
WindowsInventoryDiagnostic windows_capture_bounds_diagnostic(const WindowsRect&) noexcept;
WindowsInventoryDiagnostic windows_capture_empty_diagnostic(bool cloak_known, bool cloaked, bool visible, bool minimized) noexcept;

// Both endpoints are actual native observations. A hosted app never receives a fabricated HWND/PID.
struct WindowsWindow {
  HWND hwnd = nullptr;
  HWND surface = nullptr;
  DWORD thread_id = 0, surface_thread_id = 0;
  WindowsOwner physical_owner;
  WindowsOwner owner;
  WindowsRect bounds, surface_bounds;
  std::wstring window_class;
  std::optional<std::wstring> host_aumid;
  std::optional<bool> child_shell;
  bool visible = false, minimized = false, on_screen = false;
  bool cloaked = true, current_desktop = false, elevated = true;
};
bool eligible_windows_window(const WindowsWindow& window) noexcept;
bool same_windows_window_target(const WindowsWindow& left, const WindowsWindow& right) noexcept;
bool same_windows_window(const WindowsWindow& left, const WindowsWindow& right) noexcept;
std::wstring window_id(HWND window);
std::optional<HWND> parse_window_id(std::wstring_view value) noexcept;
bool windows_window_current(const WindowsWindow& window) noexcept;

struct WindowsApplication {
  WindowsAppIdentity identity;
  std::optional<WindowsOwner> owner;
  std::optional<WindowsStaticIdentity> installed;
  bool active = false;
  std::vector<WindowsWindow> windows;
  std::optional<std::string> icon;
};
struct WindowsCursor { POINT point{}; std::wstring display_id; };
enum class WindowIntent { observe, activate, focus, launch };
struct WindowPolicy {
  // Pure/cache-only callbacks. Unknown policy never permits labels or actions.
  std::function<bool(const WindowsWindow&, const std::optional<ServerSession>&)> disclose;
  std::function<void(const WindowsWindow&, const ServerSession&, WindowIntent)> require;
};

struct WindowsBackend {
  std::function<std::vector<WindowsApplication>(bool, const std::function<bool()>&)> list;
  std::function<WindowsWindow(HWND)> observe;
  std::function<bool(const WindowsWindow&)> current;
  std::function<std::wstring(const WindowsWindow&)> title;
  std::function<bool(const WindowsWindow&)> foreground;
  // Only native initiation occurs under authority; foreground confirmation never holds it.
  std::function<bool(const WindowsWindow&, const OperationContext&, const std::function<void(const WindowsWindow&)>&)> focus;
  std::function<WindowsCursor()> cursor;
  static WindowsBackend system(std::function<std::optional<bool>(const WindowsOwner&)> shell_observer = {}, WindowsInventoryObserver diagnostic = nullptr);
};

class WindowService final {
 public:
  explicit WindowService(WindowPolicy policy = {}, WindowsBackend backend = WindowsBackend::system(), WindowsInventoryObserver diagnostic = nullptr);
  JsonObject features() const;
  void list(const JsonObject& args, const OperationContext& context, Dispatcher::Completion done);
  void activate(const JsonObject& args, const OperationContext& context, Dispatcher::Completion done);
  void focus(const JsonObject& args, const OperationContext& context, Dispatcher::Completion done);
  void cursor(const JsonObject& args, const OperationContext& context, Dispatcher::Completion done);
 private:
  WindowPolicy policy_;
  WindowsBackend backend_;
  WindowsInventoryObserver diagnostic_ = nullptr;
  void mutate(const JsonObject&, const OperationContext&, Dispatcher::Completion, bool activate);
};

size_t run_windows_enum_tests();
}
