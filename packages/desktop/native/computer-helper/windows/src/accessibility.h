#pragma once
#include "accessibility_registry.h"
#include "capture.h"
#include "guard.h"
#include "uia_input.h"
#include <atomic>

namespace vector::computer {
struct AccessibilityBackend {
  WindowsUiaBackend uia;
  WindowsBackend windows;
  std::function<std::vector<WindowsWindow>(const std::function<bool()>&)> inventory;
  std::function<WindowsWindow()> foreground;
  std::function<void(const WindowsWindow&, const ServerSession&, const OperationContext&, WindowsPolicyOperation,
                     const std::function<void()>&, std::optional<bool>)> commit;
  std::function<CaptureReceipt(std::wstring_view, const ServerSession&)> capture;
  std::function<bool(const CaptureReceipt&, const ServerSession&)> capture_current;
  std::function<uint64_t()> now;
  InputKeyTextRules key_rules;
  std::function<bool(const ServerSession&)> mutation_current;
  static AccessibilityBackend system(std::shared_ptr<CaptureService>, WindowsUiaBackend = WindowsUiaBackend::system());
};

class AccessibilityService final {
 public:
  explicit AccessibilityService(AccessibilityBackend backend);
  JsonObject features() const;
  void tree(const JsonObject&, const OperationContext&, Dispatcher::Completion);
  void hit_test(const JsonObject&, const OperationContext&, Dispatcher::Completion);
  void focused(const JsonObject&, const OperationContext&, Dispatcher::Completion);
  void resolve(const JsonObject&, const OperationContext&, Dispatcher::Completion);
  void perform(const JsonObject&, const OperationContext&, Dispatcher::Completion);
  void set_value(const JsonObject&, const OperationContext&, Dispatcher::Completion);
  // Existing live refs only; this never refreshes an inactive receipt or mints a new input ref.
  void verify_input(const UiaObservation&, const InputExpectedTarget&, const ServerSession&);
  // Under Dispatcher authority: metadata only. Actual releases are drained by operations/close outside it.
  void note_session(const std::optional<ServerSession>&);
  void invalidate_observations(bool hard = false);
  void close();
 private:
  AccessibilityBackend backend_;
  AccessibilityRegistry registry_;
  std::atomic_bool closed_{false};
  struct Observation { UiaObservation native; AccessibilityFacts facts; };
  Observation observe(UiaElement, const WindowsWindow&, const ServerSession&, const OperationContext&,
                      UiaElement expected_root = {});
  Reply hit(UiaElement, const WindowsWindow&, const ServerSession&, const OperationContext&,
            const std::optional<AccessibilityReference>& = {}, bool refreshing = false);
  void mutate(const JsonObject&, const OperationContext&, Dispatcher::Completion, bool setting);
};
size_t run_accessibility_tests();
}
