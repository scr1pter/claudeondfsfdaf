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
  count
};
// Optional metadata-only observation; ordinary factories have no observer.
using WindowsInventoryObserver = void (*)(WindowsInventoryDiagnostic);
void observe_windows_inventory_failure(WindowsInventoryObserver, WindowsInventoryDiagnostic) noexcept;
std::wstring_view windows_inventory_diagnostic_stage(WindowsInventoryDiagnostic) noexcept;
struct WindowsRect {
  int64_t x = 0, y = 0, width = 0, height = 0;
  bool operator==(const WindowsRect&) const = default;
  bool valid() const noexcept;
  bool contains(const WindowsRect& value) const noexcept;
  bool contains(POINT point) const noexcept;
  JsonObject wire() const;
};

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
