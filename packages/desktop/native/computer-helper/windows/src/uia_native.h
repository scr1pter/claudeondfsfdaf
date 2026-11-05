#pragma once
#include "windows_enum.h"
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace vector::computer {
class NativeUia;
class WindowsUiaElement final {
 public:
  // Synthetic identities are accepted only by explicitly injected test backends.
  explicit WindowsUiaElement(uint64_t fixture_identity = 0) : identity(fixture_identity) {}
  const uint64_t identity;
 private:
  struct Storage;
  std::shared_ptr<Storage> native_;
  WindowsUiaElement(uint64_t, std::shared_ptr<Storage>);
  friend class NativeUia;
};
using UiaElement = std::shared_ptr<WindowsUiaElement>;
struct UiaSecurity {
  DWORD pid = 0;
  int control_type = 0;
  std::wstring role;
  std::optional<WindowsRect> bounds;
  bool password = true, enabled = false, focused = false, keyboard_focusable = false;
  bool value_pattern = false;
  std::optional<bool> read_only;
  bool text_pattern = false;
  std::optional<bool> text_read_only;
  bool editable() const noexcept {
    return (value_pattern || text_pattern) && (!value_pattern || read_only == false) && (!text_pattern || text_read_only == false);
  }
};
struct UiaName { std::wstring text; bool complete = false; };
struct UiaChildren { std::vector<UiaElement> elements; bool truncated = false; };
struct UiaMenuShortcut { std::vector<std::wstring> path; std::wstring accelerator; std::wstring access; };
struct UiaObservation {
  WindowsWindow window;
  UiaElement root;
  UiaElement element;
  UiaSecurity security;
  uint64_t observed_at_ms = 0;
  // Complete native MenuItem lineage/accelerators only. Empty means unobserved, never no-shortcut.
  std::optional<UiaMenuShortcut> menu;
};

struct WindowsUiaBackend {
  std::function<UiaElement(const WindowsWindow&)> root;
  std::function<UiaSecurity(const UiaElement&)> security;
  std::function<UiaName(const UiaElement&)> name;
  // Secure/unknown-password nodes never enter this callback from the service or native backend.
  std::function<std::optional<std::wstring>(const UiaElement&)> value;
  std::function<UiaChildren(const UiaElement&, size_t)> children;
  std::function<UiaElement(const UiaElement&)> parent;
  std::function<UiaElement(const UiaElement&)> focused;
  std::function<UiaElement(const UiaElement&, POINT)> hit;
  std::function<bool(const UiaElement&, const UiaElement&)> equal;
  std::function<bool(const UiaElement&, const WindowsWindow&)> belongs;
  std::function<bool(const UiaElement&, std::wstring_view)> perform;
  std::function<bool(const UiaElement&, const std::wstring&)> set_value;
  std::function<void()> close;
  std::function<std::optional<std::vector<UiaMenuShortcut>>(const UiaElement&)> menu_shortcuts;
  std::function<bool()> available;
  // One bounded native job repeats target facts and invokes the selected pattern; no nested UIA waits
  // or a sequence of independent RPC budgets is permitted inside the final authority fence.
  std::function<bool(const UiaObservation&, const UiaName&, std::wstring_view, const std::optional<std::wstring>&)> commit;
  std::function<std::optional<UiaMenuShortcut>(const UiaElement&, const UiaElement&)> menu_target;
  static WindowsUiaBackend system();
};

std::wstring sanitize_uia(std::wstring_view text, size_t maximum = 500);
// Unsupported IsPassword is acceptable only for documented nontext controls with positively absent
// ValuePattern/TextPattern. Editable/custom/document controls always need an explicit boolean.
std::optional<bool> classify_uia_password(int control_type, std::optional<bool> reported,
                                          bool value_pattern, bool text_pattern) noexcept;
// For W4: app-scoped actual focus/hit + known password fact, without names or values.
class WindowsUiaObserver final {
 public:
  explicit WindowsUiaObserver(WindowsUiaBackend backend = WindowsUiaBackend::system(), std::function<uint64_t()> now = {});
  UiaObservation focused(const WindowsWindow& window);
  UiaObservation pointer(const WindowsWindow& window, POINT point);
  bool same(const UiaObservation& left, const UiaObservation& right) const;
  bool fresh(const UiaObservation&, uint64_t maximum_age_ms = 50) const noexcept;
  void close();
 private:
  WindowsUiaBackend backend_;
  std::function<uint64_t()> now_;
};
size_t run_uia_native_tests();
}
