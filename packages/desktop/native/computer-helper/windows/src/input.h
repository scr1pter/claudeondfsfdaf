#pragma once
#include "capture.h"
#include "guard.h"
#include "input_events.h"
#include "input_keys.h"
#include <array>
#include <memory>

namespace vector::computer {
class InputGuardian;
InputKeyTextRules native_input_text_rules();
// GetKeyState on a helper thread cannot prove another thread's Caps/NumLock state. Native scan
// resolution must be invariant across every possible toggle combination, or fail closed. Physical
// numpad scans are refused separately because ToUnicodeEx does not authenticate NumLock routing.
std::optional<std::wstring> input_toggle_invariant(const std::array<std::optional<std::wstring>,4>&,
                                                 bool ascii_shortcut_case=false);
struct InputElementWitness { virtual ~InputElementWitness() = default; };
struct InputExpectedTarget {
  std::optional<DWORD> pid;
  std::optional<HWND> window;
  std::optional<std::wstring> ref;
  std::optional<std::wstring> element_id;
};
struct InputObservation {
  WindowsWindow window;
  std::optional<bool> secure;
  std::shared_ptr<InputElementWitness> element;
  std::optional<std::vector<InputMenuShortcut>> menus;
  uint64_t observed_at_ms = 0;
  bool enabled = false, focused = false, keyboard_focusable = false, value_pattern = false;
  std::optional<bool> read_only;
  bool text_pattern = false;
  std::optional<bool> text_read_only;
  bool editable() const noexcept {
    return (value_pattern || text_pattern) && (!value_pattern || read_only==false) && (!text_pattern || text_read_only==false);
  }
};
struct InputObservationProvider {
  // Implementations authorize the actual app/window before bounded app-root-scoped UIA. No values.
  std::function<InputObservation(const WindowsWindow&, const ServerSession&)> focused;
  std::function<InputObservation(const WindowsWindow&, POINT, const ServerSession&)> pointer;
  std::function<void(const InputObservation&, const InputExpectedTarget&, const ServerSession&)> bind;
  std::function<bool(const InputObservation&, const InputObservation&)> same;
  std::function<bool(const InputObservation&, uint64_t)> fresh;
  std::function<std::optional<std::vector<InputMenuShortcut>>(const InputObservation&, const ServerSession&)> menus;
  std::function<void()> close;
};
struct InputNativeKey {
  InputRelease release;
  uint32_t modifier = 0;
};
struct InputNativeChord {
  InputResolvedChord semantic;
  // Explicit modifier downs followed by the one actual nonmodifier key, in native posting order.
  std::vector<InputNativeKey> keys;
};
struct InputBackend {
  uint64_t tag = 0;
  InputKeyTextRules text_rules;
  std::shared_ptr<InputGuardian> guardian;
  std::function<CaptureReceipt(std::wstring_view, const ServerSession&)> receipt;
  std::function<bool(const CaptureReceipt&, const ServerSession&)> capture_current;
  std::function<WindowsWindow(const ServerSession&)> focused_window;
  std::function<WindowsPointOwner(const WindowsWindow&, POINT, const ServerSession&)> point;
  std::function<WindowsWindow(const WindowsWindow&, const ServerSession&)> foreground;
  std::function<void(const WindowsPointOwner&, const ServerSession&, const OperationContext&,const std::function<void()>& precondition,const std::function<void()>&)> commit_point;
  std::function<void(const WindowsWindow&, const ServerSession&, const OperationContext&, WindowsPolicyOperation,
                     std::optional<bool>, std::span<const std::wstring>, uint64_t observed_at_ms,const std::function<void()>& precondition,const std::function<void()>&)> commit_foreground;
  std::function<InputNativeChord(std::span<const std::wstring>, const InputObservation&)> resolve;
  std::function<std::vector<InputNativeKey>(std::span<const std::wstring>, const WindowsWindow&)> pointer_modifiers;
  // Quick live HKL/focus/physical-modifier facts. Fresh IME preparation remains outside authority.
  std::function<bool(std::wstring_view, const WindowsWindow&, std::span<const InputRelease>)> keyboard_current;
  std::function<std::wstring(const WindowsWindow&)> keyboard_fingerprint;
  std::function<bool()> quiet;
  std::function<bool()> available;
  // Called on the same authority-owning thread immediately before the native SendInput call,
  // after its kernel/layout preparation. Owned cleanup UPs deliberately have no current gate.
  std::function<InputPostResult(const InputPostedEvent&,const std::function<bool()>& current)> post;
  // One complete Unicode scalar (one/two UTF16 units), DOWN/UP pairs in one atomic SendInput array.
  std::function<InputPostResult(std::span<const InputPostedEvent>,const std::function<bool()>& current)> post_batch;
  std::function<bool(const InputRelease&)> release;
  // Metadata only, after an actual matching tagged-DOWN receipt, including Unicode scalar batches.
  std::function<void(const InputRelease&)> confirm_down;
  std::function<void(const InputRelease&)> forget_release;
  std::function<void()> close;
  static InputBackend system(std::shared_ptr<CaptureService>, std::shared_ptr<InputGuardian>);
};

class InputService final {
 public:
  using Cancel = std::function<void()>;
  using CleanupCompletion = std::function<void(bool complete,uint32_t released)>;
  using PreparedCleanup = std::function<void(CleanupCompletion)>;
  // Enqueue-only; callbacks must never run inline under the posting authority fence.
  using Schedule = std::function<Cancel(uint32_t, std::function<void()>)>;
  explicit InputService(InputObservationProvider observations, InputBackend backend,
                        Schedule schedule = {}, std::function<uint64_t()> now = {}, Schedule inspections = {});
  ~InputService();
  JsonObject features() const;
  void handle(std::wstring_view operation, const JsonObject&, const OperationContext&, Dispatcher::Completion);
  uint32_t release_all() noexcept;
  // Revokes immediately; completion follows matching actual tagged UP receipts outside authority.
  void release_all_async(CleanupCompletion);
  PreparedCleanup prepare_release_all();
  void close() noexcept;
 private:
  struct State;
  std::shared_ptr<State> state_;
};
size_t run_input_tests();
}
