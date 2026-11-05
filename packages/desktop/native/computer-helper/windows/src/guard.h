#pragma once
#include "windows_policy.h"

namespace vector::computer {
struct WindowsOverlayWitness { HWND window = nullptr; DWORD pid = 0; LONG_PTR extended_style = 0; };
bool windows_overlay_passthrough_allowed(const WindowsOverlayWitness&, const ServerSession&);
struct WindowsPointOwner {
  WindowsWindow window;
  HWND hit = nullptr;
  POINT point{};
  std::vector<HWND> skipped_overlays;
  DWORD hit_pid = 0, hit_thread = 0;
  std::wstring hit_class;
};

struct WindowsGuardBackend {
  std::function<WindowsPointOwner(POINT, const ServerSession&)> point;
  std::function<WindowsWindow()> foreground;
  // Quick native facts only. No hash/signature, process-tree scan, UIA, or cross-process message.
  std::function<bool(const WindowsWindow&)> current;
  std::function<bool(const WindowsPointOwner&, const ServerSession&)> point_current;
  std::function<bool(const WindowsWindow&)> foreground_current;
  std::function<bool(const WindowsWindow&)> keyboard_current;
  std::function<uint64_t()> now;
  static WindowsGuardBackend system();
};

class WindowsGuard final {
 public:
  explicit WindowsGuard(WindowsGuardBackend backend = WindowsGuardBackend::system());
  // Expected targets originate in an actual capture/AX/window receipt, never request identity text.
  WindowsPointOwner point(const WindowsWindow& expected, POINT, const ServerSession&) const;
  WindowsWindow foreground(const WindowsWindow& expected, const ServerSession&, WindowsPolicyOperation,
                           std::optional<bool> secure_field = {}, std::span<const std::wstring> keys = {}) const;
  // Native preparation is outside authority. The supplied mutation runs once inside the current
  // Dispatcher fence, after fresh held-window/process/point/foreground witnesses are checked.
  void with_point(const WindowsWindow& expected, POINT, const ServerSession&, const OperationContext&,
                  const std::function<void()>& mutation) const;
  void with_foreground(const WindowsWindow& expected, const ServerSession&, const OperationContext&,
                       WindowsPolicyOperation, const std::function<void()>& mutation,
                       std::optional<bool> secure_field = {}, std::span<const std::wstring> keys = {}) const;
 private:
  WindowsGuardBackend backend_;
};

size_t run_guard_tests();
}
