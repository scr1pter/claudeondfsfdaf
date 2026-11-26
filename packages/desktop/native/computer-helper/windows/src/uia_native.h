#pragma once
#include "windows_enum.h"
#include <oaidl.h>
#include <memory>
#include <atomic>
#include <array>
#include <chrono>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace vector::computer {
// Read-only diagnostics for the never-shipped driver. A queued or quarantined job owns the shared state;
// observers retain no stack references, callbacks or native/user values. Production callers omit it.
enum class WindowsUiaPhase : uint8_t {
  none, root_current, actor_admission, actor_queued, actor_budget, prepare_desktop,
  prepare_create, prepare_interface, prepare_connection, prepare_transaction, prepare_walker, prepare_cache,
  prepare_scope, prepare_control, prepare_filter, prepare_property, root_availability, root_target,
  root_element, root_handle, root_wrap, runtime_id, runtime_shape, runtime_bounds,
  runtime_value, wrap_equal, wrap_limit, security_cache, security_pid, security_type,
  security_password, security_enabled, security_focus, security_keyboard, security_keyboard_query_failed, security_keyboard_variant_invalid, security_value_pattern, security_value_pattern_query_failed, security_value_pattern_variant_invalid, security_value_pattern_marker, security_value_pattern_probe, security_value_pattern_probe_invalid, security_value_pattern_probe_empty, security_value_pattern_probe_no_interface, security_text_pattern, security_text_pattern_query_failed, security_text_pattern_variant_invalid, security_text_pattern_marker, security_text_pattern_probe, security_text_pattern_probe_invalid, security_text_pattern_probe_empty, security_text_pattern_probe_no_interface,
  security_classify, security_value_readonly, security_text_readonly, security_bounds, security_current, root_pid,
  hit_setup, hit_loop, hit_cycle, hit_pid, hit_equal, hit_depth, hit_children, hit_enqueue, hit_queue_limit, hit_ambiguous, hit_empty, hit_end, children_limit, children_first, children_loop, children_capacity, children_wrap, children_append, children_next, children_sibling_failed, children_compare, children_cycle, children_end, parent_read, parent_wrap,
  actor_current, actor_current_budget, actor_complete, actor_expired, actor_cancelled, actor_revoked,
  actor_com_uninitialized, actor_com_cancellation_unavailable, actor_com_timer_unavailable, actor_com_expired,
  // Internal checkpoints both report root_element to the existing failure and recovery paths.
  root_dispatch_started, root_dispatch_returned
};
inline constexpr std::array<std::wstring_view, 93> windows_uia_phases{
  L"none", L"root-current", L"actor-admission", L"actor-queued", L"actor-budget", L"prepare-desktop",
  L"prepare-create", L"prepare-interface", L"prepare-connection", L"prepare-transaction", L"prepare-walker", L"prepare-cache",
  L"prepare-scope", L"prepare-control", L"prepare-filter", L"prepare-property", L"root-availability", L"root-target",
  L"root-element", L"root-handle", L"root-wrap", L"runtime-id", L"runtime-shape", L"runtime-bounds",
  L"runtime-value", L"wrap-equal", L"wrap-limit", L"security-cache", L"security-pid", L"security-type",
  L"security-password", L"security-enabled", L"security-focus", L"security-keyboard", L"security-keyboard-query-failed", L"security-keyboard-variant-invalid", L"security-value-pattern", L"security-value-pattern-query-failed", L"security-value-pattern-variant-invalid", L"security-value-pattern-marker", L"security-value-pattern-probe", L"security-value-pattern-probe-invalid", L"security-value-pattern-probe-empty", L"security-value-pattern-probe-no-interface", L"security-text-pattern", L"security-text-pattern-query-failed", L"security-text-pattern-variant-invalid", L"security-text-pattern-marker", L"security-text-pattern-probe", L"security-text-pattern-probe-invalid", L"security-text-pattern-probe-empty", L"security-text-pattern-probe-no-interface",
  L"security-classify", L"security-value-readonly", L"security-text-readonly", L"security-bounds", L"security-current", L"root-pid",
  L"hit-setup", L"hit-loop", L"hit-cycle", L"hit-pid", L"hit-equal", L"hit-depth", L"hit-children", L"hit-enqueue", L"hit-queue-limit", L"hit-ambiguous", L"hit-empty", L"hit-end", L"children-limit", L"children-first", L"children-loop", L"children-capacity", L"children-wrap", L"children-append", L"children-next", L"children-sibling-failed", L"children-compare", L"children-cycle", L"children-end", L"parent-read", L"parent-wrap",
  L"actor-current", L"actor-current-budget", L"actor-complete", L"actor-expired", L"actor-cancelled", L"actor-revoked",
  L"actor-com-uninitialized", L"actor-com-cancellation-unavailable", L"actor-com-timer-unavailable", L"actor-com-expired"
};
// Which side first saw an actor ticket's deadline pass, written only inside the first timeout snapshot:
// a worker current_call() check, the worker's COM call budget after the body, or the caller's wait_until().
// worker_current means the worker itself found the budget spent at a check under the sampled phase. Under
// root_element the only such check precedes ElementFromHandleBuildCache, so that call was never made.
// caller_wait means the wait timed out or the caller saw readiness after the ticket deadline. The
// dispatch checkpoint names the last worker observation, so dispatch_started alone cannot prove COM entry.
enum class WindowsUiaExpiry : uint8_t { none, worker_current, worker_budget, caller_wait };
inline constexpr std::array<std::wstring_view, 4> windows_uia_expiries{L"none", L"worker-current", L"worker-budget", L"caller-wait"};
enum class WindowsUiaRootProgress : uint8_t { before_dispatch, dispatch_started, dispatch_returned };
enum class WindowsUiaCallerWait : uint8_t { none, pending, ready };
struct WindowsUiaRootWait {
  WindowsUiaRootProgress progress;
  WindowsUiaCallerWait caller;
};
struct WindowsUiaDiagnostic {
  std::atomic<WindowsUiaPhase> phase{WindowsUiaPhase::none};
  // Read only for a fresh actor. A root refused before enqueue leaves the prior diagnosis in place.
  std::atomic_bool ticket_queued{false};
  // Zero means unobserved. Bits 0-15 hold the sampled phase plus one (every sampled phase, including none,
  // has a distinct nonzero encoding), bits 16-23 the expiry side, bits 24-31 the root dispatch and caller
  // wait checkpoints, and bits 32-63 the root lookup HRESULT seen before the snapshot (zero if unobserved).
  std::atomic<uint64_t> timeout_observation{0};
  // Failure-path only: the first failing ElementFromHandleBuildCache HRESULT, written by the worker.
  // Zero means unobserved; a failing HRESULT is never zero. Only failure_status() reads it.
  std::atomic<int32_t> root_element_status{0};
  static WindowsUiaPhase reported_phase(WindowsUiaPhase observed) noexcept {
    if (observed == WindowsUiaPhase::root_dispatch_started || observed == WindowsUiaPhase::root_dispatch_returned)
      return WindowsUiaPhase::root_element;
    return observed;
  }
  // The first deadline observer samples before expiry/retirement. Late work cannot rewrite this observation.
  void note_timeout(WindowsUiaExpiry expiry, WindowsUiaCallerWait wait = WindowsUiaCallerWait::none) noexcept {
    const auto status = root_element_status.load(std::memory_order_relaxed);
    const auto current = phase.load(std::memory_order_relaxed);
    const auto progress = current == WindowsUiaPhase::root_dispatch_returned ? WindowsUiaRootProgress::dispatch_returned
      : current == WindowsUiaPhase::root_dispatch_started ? WindowsUiaRootProgress::dispatch_started
      : WindowsUiaRootProgress::before_dispatch;
    uint64_t empty = 0;
    const auto observed = (uint64_t{static_cast<uint32_t>(status)} << 32) |
      (uint64_t{static_cast<uint8_t>(wait)} << 28) | (uint64_t{static_cast<uint8_t>(progress)} << 24) |
      (uint64_t{static_cast<uint8_t>(expiry)} << 16) | (uint64_t{1} + static_cast<uint64_t>(reported_phase(current)));
    timeout_observation.compare_exchange_strong(empty, observed, std::memory_order_relaxed);
  }
  std::optional<WindowsUiaRootWait> failure_root_wait() const noexcept {
    const auto observed = timeout_observation.load(std::memory_order_relaxed);
    if ((observed & 0xffff) != 1 + static_cast<uint64_t>(WindowsUiaPhase::root_element) ||
        ((observed >> 16) & 0xff) != static_cast<uint8_t>(WindowsUiaExpiry::caller_wait)) return {};
    const auto wait = static_cast<WindowsUiaCallerWait>((observed >> 28) & 0xf);
    const auto progress = static_cast<WindowsUiaRootProgress>((observed >> 24) & 0xf);
    if ((wait != WindowsUiaCallerWait::pending && wait != WindowsUiaCallerWait::ready) ||
        progress > WindowsUiaRootProgress::dispatch_returned) return {};
    return WindowsUiaRootWait{progress, wait};
  }
  void note_root_element_status(int32_t status) noexcept {
    int32_t empty = 0;
    if (status) root_element_status.compare_exchange_strong(empty, status, std::memory_order_relaxed);
  }
  WindowsUiaPhase failure_phase(bool available) const noexcept {
    if (available) return reported_phase(phase.load(std::memory_order_relaxed));
    const auto observed = timeout_observation.load(std::memory_order_relaxed) & 0xffff;
    if (!observed || observed > windows_uia_phases.size()) return WindowsUiaPhase::none;
    return static_cast<WindowsUiaPhase>(observed - 1);
  }
  // A healthy actor never expired a ticket. For a retired actor only the immutable snapshot is eligible.
  WindowsUiaExpiry failure_expiry(bool available) const noexcept {
    if (available) return WindowsUiaExpiry::none;
    const auto observed = timeout_observation.load(std::memory_order_relaxed);
    const auto expiry = (observed >> 16) & 0xff;
    if (!observed || expiry >= windows_uia_expiries.size()) return WindowsUiaExpiry::none;
    return static_cast<WindowsUiaExpiry>(expiry);
  }
  // A healthy actor's failed call returned before the caller saw its exception, so the live status is its
  // own. For a retired actor, CoCancelCall can make late work fail afterwards, so only the snapshot counts.
  std::optional<int32_t> failure_status(bool available) const noexcept {
    const auto status = available ? root_element_status.load(std::memory_order_relaxed)
                                  : static_cast<int32_t>(static_cast<uint32_t>(timeout_observation.load(std::memory_order_relaxed) >> 32));
    if (!status) return {};
    return status;
  }
};
static_assert(std::atomic<WindowsUiaPhase>::is_always_lock_free);
static_assert(std::atomic_bool::is_always_lock_free);
static_assert(std::atomic<uint64_t>::is_always_lock_free);
static_assert(std::atomic<int32_t>::is_always_lock_free);
static_assert(windows_uia_phases.size() == static_cast<size_t>(WindowsUiaPhase::actor_com_expired) + 1);
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
// Metadata-only operations for the never-shipped Stop driver's native point resolver. The system
// implementation runs these directly inside one existing actor ticket, never through nested calls.
struct UiaPointMetadata {
  DWORD pid = 0;
  std::vector<int> runtime_id;
  std::optional<WindowsRect> bounds;
};
struct UiaPointBackend {
  std::function<void()> current;
  std::function<UiaElement(POINT)> point;
  std::function<UiaElement(const UiaElement&)> normalize;
  std::function<UiaPointMetadata(const UiaElement&)> metadata;
  std::function<UiaElement(const UiaElement&)> parent;
  std::function<bool(const UiaElement&, const UiaElement&)> equal;
  std::function<UiaSecurity(const UiaElement&)> security;
};
UiaElement resolve_uia_overlay_point(const UiaElement& root, POINT point, const UiaPointBackend&);
bool resolve_uia_overlay_membership(const UiaElement& root, const UiaElement& element, POINT point, const UiaPointBackend&);
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

using WindowsUiaDeadline = std::chrono::steady_clock::time_point;

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
  // Smoke-driver only; ordinary ui.hittest and pointer guards retain the app-scoped BFS above.
  std::function<UiaElement(const UiaElement&, POINT)> overlay_hit;
  std::function<bool(const UiaElement&, const WindowsWindow&, POINT)> overlay_belongs;
  std::function<bool(const UiaElement&, const UiaElement&)> equal;
  std::function<bool(const UiaElement&, const WindowsWindow&)> belongs;
  std::function<bool(const UiaElement&, std::wstring_view)> perform;
  std::function<bool(const UiaElement&, const std::wstring&)> set_value;
  std::function<void()> close;
  std::function<std::optional<std::vector<UiaMenuShortcut>>(const UiaElement&)> menu_shortcuts;
  std::function<bool()> available;
  // One bounded native job repeats target facts and invokes the selected pattern; no nested UIA waits
  // or a sequence of independent RPC budgets is permitted inside the final authority fence.
  std::function<bool(const UiaObservation&, const UiaName&, std::wstring_view, const std::optional<std::wstring>&,
                     const std::function<bool()>& metadata_gate)> commit;
  std::function<std::optional<UiaMenuShortcut>(const UiaElement&, const UiaElement&)> menu_target;
  static WindowsUiaBackend system(std::shared_ptr<WindowsUiaDiagnostic> diagnostic = {},
                                  WindowsUiaDeadline root_deadline = WindowsUiaDeadline::max());
};

// Only for the owner of a new observation, before it has any UIA element or root to preserve.
// On a retry the owner adopts the new backend so subsequent work uses its own elements.
UiaElement observe_first_uia_root(WindowsUiaBackend&, std::shared_ptr<WindowsUiaDiagnostic>&, const WindowsWindow&,
  WindowsUiaDeadline deadline, const std::function<bool()>& current,
  const std::function<WindowsUiaBackend(std::shared_ptr<WindowsUiaDiagnostic>, WindowsUiaDeadline)>& open = WindowsUiaBackend::system);

std::wstring sanitize_uia(std::wstring_view text, size_t maximum = 500);
// A documented negative default never authorizes focus. Query/type failures remain unavailable.
std::optional<bool> classify_uia_keyboard_focusable(HRESULT status, const VARIANT& value) noexcept;
// Used only after the exact reserved unsupported-property marker, for known typed Value/Text IDs.
// Unknown, conflicting and arbitrary failed results never establish absence.
std::optional<bool> classify_uia_pattern_support(HRESULT status, bool interface_present) noexcept;
// Metadata only: never a Dispatcher callback, UIA query, provider RPC or native input operation.
void require_uia_mutation_gate(const std::function<bool()>&);
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
