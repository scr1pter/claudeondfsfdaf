#pragma once
#include "windows_policy.h"

namespace vector::computer {
struct WindowsOverlayWitness { HWND window = nullptr; DWORD pid = 0; LONG_PTR extended_style = 0; };
bool windows_overlay_passthrough_allowed(const WindowsOverlayWitness&, const ServerSession&);
struct WindowsGuardStamp {
  uint64_t observed_at_ms=0, run_epoch=0, observation_epoch=0;
  std::wstring session_id;
  std::optional<uint64_t> revision;
  WindowsGuardStamp()=default;
  WindowsGuardStamp(const ServerSession& session,uint64_t observed)
    : observed_at_ms(observed),run_epoch(session.run_epoch),observation_epoch(session.observation_epoch),session_id(session.id),revision(session.revision) {}
};
struct WindowsPointOwner {
  WindowsWindow window;
  HWND hit = nullptr;
  POINT point{};
  std::vector<HWND> skipped_overlays;
  DWORD hit_pid = 0, hit_thread = 0;
  std::wstring hit_class;
  WindowsGuardStamp stamp;
};

struct WindowsGuardBackend {
  std::function<WindowsPointOwner(POINT, const ServerSession&)> point;
  std::function<WindowsWindow()> foreground;
  // Quick native facts only. No hash/signature, process-tree scan, UIA, or cross-process message.
  std::function<bool(const WindowsWindow&)> current;
  std::function<bool(const WindowsPointOwner&, const ServerSession&)> point_current;
  std::function<bool(const WindowsWindow&)> foreground_current;
  std::function<bool(const WindowsWindow&)> keyboard_current;
  std::function<void(const WindowsWindow&)> require_surface;
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
  // UIA element actions do not synthesize keyboard input or a pointer hit. The callback must
  // verify its private native element/ref and invoke one bounded UIA actor job before returning.
  // An element may be nonfocusable; its actual approved app/window must still be foreground.
  void with_element(const WindowsWindow& expected, const ServerSession&, const OperationContext&,
                    WindowsPolicyOperation, const std::function<void()>& bound_element_action,
                    std::optional<bool> secure_field = {}) const;
  // A previous bounded UIA observation can precede these metadata-only native posting fences.
  // Prepared witnesses remain private native values; every actual hit/focus fact is repeated here.
  void commit_point(const WindowsPointOwner&, const ServerSession&, const OperationContext&,
                    const std::function<void()>& mutation,const std::function<void()>& precondition={}) const;
  void commit_foreground(const WindowsWindow&, const ServerSession&, const OperationContext&,
                         const WindowsGuardStamp&, WindowsPolicyOperation, const std::function<void()>& mutation,
                         std::optional<bool> secure_field = {}, std::span<const std::wstring> keys = {},
                         const std::function<void()>& precondition={}) const;
 private:
  WindowsGuardBackend backend_;
};

size_t run_guard_tests();
}
