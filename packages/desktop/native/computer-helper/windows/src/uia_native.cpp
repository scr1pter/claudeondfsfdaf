#include <windows.h>
#include <objidl.h>
#include <propidl.h>
#include <oleacc.h>
#include <uiautomation.h>
#include <oleauto.h>
#include "uia_native.h"
#include "windows_com.h"
#include "availability.h"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cmath>
#include <deque>
#include <future>
#include <mutex>
#include <thread>
#include <type_traits>
#include <winrt/base.h>

namespace vector::computer {
namespace {
uint64_t now_ms() { return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count()); }
[[noreturn]] void unavailable() { throw Failure{L"no_ui_tree", L"The native accessibility provider is unavailable."}; }
void desktop_ready() {
  USEROBJECTFLAGS flags{}; DWORD used = 0;
  if (!GetUserObjectInformationW(GetProcessWindowStation(), UOI_FLAGS, &flags, sizeof(flags), &used) || !(flags.dwFlags & WSF_VISIBLE))
    throw Failure{L"secure_desktop", L"The interactive desktop is unavailable."};
  const auto desktop = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS);
  if (!desktop) throw Failure{L"secure_desktop", L"The interactive desktop is unavailable."};
  wchar_t name[64]{}; const auto read = GetUserObjectInformationW(desktop, UOI_NAME, name, sizeof(name), &used); CloseDesktop(desktop);
  if (!read || used <= sizeof(wchar_t) || used > sizeof(name) || std::wstring_view(name) != L"Default")
    throw Failure{L"secure_desktop", L"The interactive desktop is unavailable."};
}
void note_uia(const std::shared_ptr<WindowsUiaDiagnostic>& state, WindowsUiaPhase phase) noexcept {
  if (state) {
    if (phase == WindowsUiaPhase::actor_expired || phase == WindowsUiaPhase::actor_com_expired) state->note_timeout();
    state->phase.store(phase, std::memory_order_relaxed);
  }
}
struct UiaActor {
  std::shared_ptr<WindowsUiaDiagnostic> diagnostic;
  std::mutex mutex;
  std::condition_variable condition;
  std::deque<std::function<void()>> jobs;
  std::vector<IUIAutomationElement*> retired;
  std::atomic_bool revoked{false};
  bool closed = false, quarantined = false;
  DWORD thread = 0;
  winrt::handle thread_handle;
  void retire(IUIAutomationElement* value) noexcept {
    if (!value) return;
    try { std::lock_guard lock(mutex); if (retired.size() < 8192) retired.push_back(value); condition.notify_one(); }
    catch (...) { /* Bounded quarantined native handles survive only until this helper exits. */ }
  }
};
struct CallTicket { std::atomic_bool cancelled{false}; uint64_t deadline = 0; std::shared_ptr<UiaActor> actor; };
thread_local CallTicket* active_ticket = nullptr;
void current_call() {
  if (!active_ticket) unavailable();
  if (active_ticket->cancelled.load()) { if (active_ticket->actor) note_uia(active_ticket->actor->diagnostic, WindowsUiaPhase::actor_cancelled); unavailable(); }
  if (!active_ticket->actor) unavailable();
  if (active_ticket->actor->revoked.load()) { note_uia(active_ticket->actor->diagnostic, WindowsUiaPhase::actor_revoked); unavailable(); }
  if (now_ms() >= active_ticket->deadline) { note_uia(active_ticket->actor->diagnostic, WindowsUiaPhase::actor_expired); unavailable(); }
}
bool mutation_result(HRESULT status) {
  if (FAILED(status)) throw Failure{L"changed", L"The native accessibility action could not be confirmed."}; return true;
}
void current_mutation(const WindowsWindow* window) {
  current_call();
  if (!window || !windows_window_current(*window)) throw Failure{L"stale_ref", L"The native accessibility target changed."};
  const auto actual = observe_windows_availability(WindowsAvailabilityBackend::system());
  require_windows_surface(actual, &window->owner.process.token);
  require_windows_surface(actual, &window->physical_owner.process.token);
  // Provider lookups above can run while the user changes apps. UIA actions remain foreground
  // only, so repeat the cheap native window check immediately before the actual pattern call.
  if (GetForegroundWindow()!=window->hwnd || !IsWindowVisible(window->hwnd) || IsIconic(window->hwnd))
    throw Failure{L"not_foreground", L"The native accessibility target is no longer foreground."};
  current_call();
}
struct Variant {
  VARIANT value{};
  Variant() { VariantInit(&value); }
  ~Variant() { VariantClear(&value); }
};
std::wstring role(int control) {
  switch (control) {
    case UIA_ButtonControlTypeId: return L"Button";
    case UIA_CalendarControlTypeId: return L"Calendar";
    case UIA_CheckBoxControlTypeId: return L"CheckBox";
    case UIA_ComboBoxControlTypeId: return L"ComboBox";
    case UIA_EditControlTypeId: return L"Edit";
    case UIA_HyperlinkControlTypeId: return L"Hyperlink";
    case UIA_ImageControlTypeId: return L"Image";
    case UIA_ListItemControlTypeId: return L"ListItem";
    case UIA_ListControlTypeId: return L"List";
    case UIA_MenuControlTypeId: return L"Menu";
    case UIA_MenuBarControlTypeId: return L"MenuBar";
    case UIA_MenuItemControlTypeId: return L"MenuItem";
    case UIA_ProgressBarControlTypeId: return L"ProgressBar";
    case UIA_RadioButtonControlTypeId: return L"RadioButton";
    case UIA_ScrollBarControlTypeId: return L"ScrollBar";
    case UIA_SliderControlTypeId: return L"Slider";
    case UIA_SpinnerControlTypeId: return L"Spinner";
    case UIA_StatusBarControlTypeId: return L"StatusBar";
    case UIA_TabControlTypeId: return L"Tab";
    case UIA_TabItemControlTypeId: return L"TabItem";
    case UIA_TextControlTypeId: return L"Text";
    case UIA_ToolBarControlTypeId: return L"ToolBar";
    case UIA_ToolTipControlTypeId: return L"ToolTip";
    case UIA_TreeControlTypeId: return L"Tree";
    case UIA_TreeItemControlTypeId: return L"TreeItem";
    case UIA_WindowControlTypeId: return L"Window";
    case UIA_PaneControlTypeId: return L"Pane";
    case UIA_DocumentControlTypeId: return L"Document";
    case UIA_SplitButtonControlTypeId: return L"SplitButton";
    case UIA_GroupControlTypeId: return L"Group";
    default: return L"Custom";
  }
}
}

struct WindowsUiaElement::Storage {
  winrt::com_ptr<IUIAutomationElement> element;
  std::shared_ptr<UiaActor> owner;
  std::vector<int> runtime_id;
  ~Storage() { if (element) owner->retire(element.detach()); }
};
WindowsUiaElement::WindowsUiaElement(uint64_t id, std::shared_ptr<Storage> value) : identity(id), native_(std::move(value)) {}

class NativeUia final : public std::enable_shared_from_this<NativeUia> {
  std::shared_ptr<UiaActor> actor_ = std::make_shared<UiaActor>();
  winrt::com_ptr<IUIAutomation> automation_;
  winrt::com_ptr<IUIAutomationTreeWalker> walker_;
  winrt::com_ptr<IUIAutomationCacheRequest> structural_;
  std::vector<std::weak_ptr<WindowsUiaElement>> elements_;
  uint64_t sequence_ = 0;
  const UiaObservation* mutation_ = nullptr;
  std::wstring mutation_name_;
  std::function<bool()> mutation_gate_;

  void note(WindowsUiaPhase phase) const noexcept { note_uia(actor_->diagnostic, phase); }
  void note_budget_failure(const WindowsComCall& budget) const noexcept {
    if (!actor_->diagnostic) return;
    // Only a failed original current() probe samples this existing closed observation. No success
    // path gains another clock read, cancellation call or budget renewal.
    switch (budget.observation()) {
      case WindowsComObservation::uninitialized: note(WindowsUiaPhase::actor_com_uninitialized); return;
      case WindowsComObservation::cancellation_unavailable: note(WindowsUiaPhase::actor_com_cancellation_unavailable); return;
      case WindowsComObservation::timer_unavailable: note(WindowsUiaPhase::actor_com_timer_unavailable); return;
      case WindowsComObservation::expired: note(WindowsUiaPhase::actor_com_expired); return;
      case WindowsComObservation::current: return;
    }
  }
  struct PatternPhases { WindowsUiaPhase read, query_failed, variant_invalid, marker, probe, probe_invalid, probe_empty, probe_no_interface; };
  template<class Pattern> bool pattern_available(IUIAutomationElement* cached, IUIAutomationElement* element,
                                                PROPERTYID property, PATTERNID pattern, PatternPhases phases) {
    Variant reported; note(phases.read); current_call();
    const auto status = cached->GetCachedPropertyValueEx(property, TRUE, &reported.value);
    if (status != S_OK) { note(phases.query_failed); unavailable(); }
    if (reported.value.vt == VT_BOOL) {
      if (reported.value.boolVal == VARIANT_TRUE) return true;
      if (reported.value.boolVal == VARIANT_FALSE) return false;
      note(phases.variant_invalid); unavailable();
    }
    // Availability defaults are not evidence of absence. Only UIA's exact reserved marker can
    // request a metadata-only typed probe; no value, text or document range is read here.
    // CheckNotSupported: "TRUE if the provided VARIANT contains the Not Supported identifier".
    // https://github.com/MicrosoftDocs/sdk-api/blob/docs/sdk-api-src/content/uiautomationclient/nf-uiautomationclient-iuiautomation-checknotsupported.md
    if (reported.value.vt != VT_UNKNOWN || !reported.value.punkVal) { note(phases.variant_invalid); unavailable(); }
    note(phases.marker); current_call(); BOOL unsupported = FALSE;
    if (automation_->CheckNotSupported(reported.value, &unsupported) != S_OK || unsupported != TRUE) unavailable();
    note(phases.probe); current_call(); winrt::com_ptr<Pattern> capability;
    const auto probed = element->GetCurrentPatternAs(pattern, IID_PPV_ARGS(capability.put())); current_call();
    const auto support = classify_uia_pattern_support(probed, static_cast<bool>(capability));
    if (!support) {
      note(probed == S_OK && !capability ? phases.probe_empty : probed == E_NOINTERFACE ? phases.probe_no_interface : phases.probe_invalid);
      unavailable();
    }
    return *support;
  }
  IUIAutomationElement* native(const UiaElement& value) {
    current_call(); if (!value || !value->native_ || !value->native_->element) unavailable(); return value->native_->element.get();
  }
  std::vector<int> runtime_id(IUIAutomationElement* element) {
    SAFEARRAY* array = nullptr; note(WindowsUiaPhase::runtime_id); current_call();
    if (FAILED(element->GetRuntimeId(&array)) || !array) unavailable();
    struct Array { SAFEARRAY* value; ~Array() { SafeArrayDestroy(value); } } close{array};
    LONG lower = 0, upper = -1;
    VARTYPE kind = VT_EMPTY;
    note(WindowsUiaPhase::runtime_shape);
    if (SafeArrayGetDim(array) != 1 || FAILED(SafeArrayGetVartype(array, &kind)) || kind != VT_I4 || SafeArrayGetElemsize(array) != sizeof(int)) unavailable();
    note(WindowsUiaPhase::runtime_bounds);
    if (FAILED(SafeArrayGetLBound(array, 1, &lower)) || FAILED(SafeArrayGetUBound(array, 1, &upper)) || upper < lower || int64_t(upper) - lower >= 64) unavailable();
    std::vector<int> result;
    note(WindowsUiaPhase::runtime_value);
    for (int64_t offset = 0; offset <= int64_t(upper) - lower; ++offset) { auto index = static_cast<LONG>(int64_t(lower) + offset); int value = 0; if (FAILED(SafeArrayGetElement(array, &index, &value))) unavailable(); result.push_back(value); }
    current_call(); return result;
  }
  UiaElement wrap(winrt::com_ptr<IUIAutomationElement> element) {
    if (!element) return {};
    const auto id = runtime_id(element.get());
    std::erase_if(elements_, [](const auto& value) { return value.expired(); });
    for (const auto& weak : elements_) if (const auto existing = weak.lock(); existing && existing->native_->runtime_id == id) {
      note(WindowsUiaPhase::wrap_equal); BOOL same = FALSE; current_call();
      if (SUCCEEDED(automation_->CompareElements(element.get(), existing->native_->element.get(), &same)) && same) return existing;
    }
    note(WindowsUiaPhase::wrap_limit);
    if (elements_.size() >= 8192) unavailable();
    auto storage = std::make_shared<WindowsUiaElement::Storage>(); storage->element = std::move(element); storage->owner = actor_; storage->runtime_id = id;
    auto result = std::shared_ptr<WindowsUiaElement>(new WindowsUiaElement(++sequence_, std::move(storage))); elements_.push_back(result); return result;
  }
  void prepare() {
    current_call(); note(WindowsUiaPhase::prepare_desktop); desktop_ready(); if (automation_) return;
    winrt::com_ptr<IUIAutomation> automation;
    winrt::com_ptr<IUIAutomationTreeWalker> walker;
    winrt::com_ptr<IUIAutomationCacheRequest> structural;
    note(WindowsUiaPhase::prepare_create);
    if (FAILED(CoCreateInstance(CLSID_CUIAutomation8, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(automation.put())))) unavailable();
    note(WindowsUiaPhase::prepare_interface); const auto timeouts = automation.try_as<IUIAutomation2>();
    if (!timeouts) unavailable();
    note(WindowsUiaPhase::prepare_connection); if (FAILED(timeouts->put_ConnectionTimeout(50))) unavailable();
    note(WindowsUiaPhase::prepare_transaction); if (FAILED(timeouts->put_TransactionTimeout(50))) unavailable();
    note(WindowsUiaPhase::prepare_walker); if (FAILED(automation->get_ControlViewWalker(walker.put()))) unavailable();
    note(WindowsUiaPhase::prepare_cache); if (FAILED(automation->CreateCacheRequest(structural.put()))) unavailable();
    note(WindowsUiaPhase::prepare_scope); if (FAILED(structural->put_TreeScope(TreeScope_Element))) unavailable();
    winrt::com_ptr<IUIAutomationCondition> control;
    note(WindowsUiaPhase::prepare_control); if (FAILED(automation->get_ControlViewCondition(control.put()))) unavailable();
    note(WindowsUiaPhase::prepare_filter); if (FAILED(structural->put_TreeFilter(control.get()))) unavailable();
    for (const auto property : {UIA_ProcessIdPropertyId, UIA_ControlTypePropertyId, UIA_BoundingRectanglePropertyId,
         UIA_IsPasswordPropertyId, UIA_IsEnabledPropertyId, UIA_HasKeyboardFocusPropertyId, UIA_IsKeyboardFocusablePropertyId,
         UIA_IsValuePatternAvailablePropertyId, UIA_IsTextPatternAvailablePropertyId, UIA_ValueIsReadOnlyPropertyId}) {
      note(WindowsUiaPhase::prepare_property); if (FAILED(structural->AddProperty(property))) unavailable();
    }
    current_call();
    automation_ = std::move(automation); walker_ = std::move(walker); structural_ = std::move(structural);
  }
 public:
  static std::shared_ptr<NativeUia> make(std::shared_ptr<WindowsUiaDiagnostic> diagnostic) {
    const auto self = std::shared_ptr<NativeUia>(new NativeUia());
    const auto actor = self->actor_; actor->diagnostic = std::move(diagnostic);
    // Native interfaces and provider calls are confined to this owned MTA. Late calls are quarantined;
    // a timeout never creates replacement threads or lets old work publish into a new observation.
    std::thread([weak = std::weak_ptr<NativeUia>(self), actor] {
      const auto initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
      HANDLE held_thread = nullptr;
      const auto held = DuplicateHandle(GetCurrentProcess(), GetCurrentThread(), GetCurrentProcess(), &held_thread, SYNCHRONIZE, FALSE, 0);
      { std::lock_guard lock(actor->mutex); actor->thread = GetCurrentThreadId(); actor->thread_handle.attach(held_thread);
        if (FAILED(initialized) || !held) { actor->quarantined = true; actor->revoked.store(true); } actor->condition.notify_all(); }
      for (;;) {
        std::function<void()> work; std::vector<IUIAutomationElement*> retired; std::deque<std::function<void()>> discarded; bool ended = false;
        { std::unique_lock lock(actor->mutex); actor->condition.wait(lock, [&] { return actor->closed || actor->quarantined || !actor->jobs.empty() || !actor->retired.empty(); });
          if (actor->closed || actor->quarantined) { discarded.swap(actor->jobs); ended = true; }
          else { retired.swap(actor->retired); if (!actor->jobs.empty()) { work = std::move(actor->jobs.front()); actor->jobs.pop_front(); } } }
        if (ended) break;
        for (const auto value : retired) value->Release();
        if (work) work();
      }
      if (const auto live = weak.lock()) { live->structural_ = nullptr; live->walker_ = nullptr; live->automation_ = nullptr; }
      if (SUCCEEDED(initialized)) CoUninitialize();
      { std::lock_guard lock(actor->mutex); actor->thread = 0; actor->condition.notify_all(); }
    }).detach();
    return self;
  }
  ~NativeUia() { close(); }
  bool available() const { std::lock_guard lock(actor_->mutex); return !actor_->closed && !actor_->quarantined; }
  void close() {
    actor_->revoked.store(true);
    DWORD thread = 0; std::deque<std::function<void()>> discarded;
    { std::lock_guard lock(actor_->mutex); if (actor_->closed) return; actor_->closed = true; discarded.swap(actor_->jobs); thread = actor_->thread; actor_->condition.notify_all(); }
    if (thread) (void)CoCancelCall(thread, 0);
  }
  template<class Body> auto call(Body body) -> std::invoke_result_t<Body> {
    using Result = std::invoke_result_t<Body>;
    auto promise = std::make_shared<std::promise<Result>>(); auto result = promise->get_future();
    auto ticket = std::make_shared<CallTicket>(); ticket->deadline = now_ms() + 50; ticket->actor = actor_;
    note(WindowsUiaPhase::actor_admission);
    { std::lock_guard lock(actor_->mutex); if (actor_->closed || actor_->quarantined || actor_->jobs.size() >= 8) unavailable();
      note(WindowsUiaPhase::actor_queued); actor_->jobs.push_back([self = shared_from_this(), promise, ticket, body = std::move(body)]() mutable {
        active_ticket = ticket.get();
        try { self->note(WindowsUiaPhase::actor_budget); WindowsComCall budget;
          self->note(WindowsUiaPhase::actor_current); current_call(); self->note(WindowsUiaPhase::actor_current_budget); if (!budget.current()) { self->note_budget_failure(budget); unavailable(); } self->prepare();
          auto value = body(); self->note(WindowsUiaPhase::actor_current); current_call(); self->note(WindowsUiaPhase::actor_current_budget); if (!budget.current()) { self->note_budget_failure(budget); unavailable(); } self->note(WindowsUiaPhase::actor_complete); promise->set_value(std::move(value)); }
        catch (...) { try { promise->set_exception(std::current_exception()); } catch (...) {} }
        active_ticket = nullptr;
      }); actor_->condition.notify_one(); }
    const auto deadline = std::chrono::steady_clock::time_point(std::chrono::milliseconds(ticket->deadline));
    if (result.wait_until(deadline) != std::future_status::ready || now_ms() >= ticket->deadline) {
      note(WindowsUiaPhase::actor_expired); ticket->cancelled.store(true); actor_->revoked.store(true); DWORD thread = 0; std::deque<std::function<void()>> discarded;
      { std::lock_guard lock(actor_->mutex); actor_->quarantined = true; discarded.swap(actor_->jobs); thread = actor_->thread; actor_->condition.notify_all(); }
      if (thread) (void)CoCancelCall(thread, 0); unavailable();
    }
    return result.get();
  }
  UiaSecurity security(const UiaElement& value) {
    note(WindowsUiaPhase::security_cache); auto element = native(value); winrt::com_ptr<IUIAutomationElement> cached;
    if (FAILED(element->BuildUpdatedCache(structural_.get(), cached.put())) || !cached) unavailable();
    const auto property = [&](PROPERTYID id, VARTYPE expected, VARIANT& result, WindowsUiaPhase phase) {
      note(phase); current_call(); if (FAILED(cached->GetCachedPropertyValueEx(id, TRUE, &result)) || result.vt != expected) unavailable();
    };
    Variant pid, type, password, enabled, focus, keyboard;
    property(UIA_ProcessIdPropertyId, VT_I4, pid.value, WindowsUiaPhase::security_pid); property(UIA_ControlTypePropertyId, VT_I4, type.value, WindowsUiaPhase::security_type);
    note(WindowsUiaPhase::security_password); current_call(); if (FAILED(cached->GetCachedPropertyValueEx(UIA_IsPasswordPropertyId, TRUE, &password.value))) unavailable();
    property(UIA_IsEnabledPropertyId, VT_BOOL, enabled.value, WindowsUiaPhase::security_enabled);
    property(UIA_HasKeyboardFocusPropertyId, VT_BOOL, focus.value, WindowsUiaPhase::security_focus);
    // Microsoft documents IsKeyboardFocusable as VT_BOOL with "Default value: FALSE" and says
    // ignoreDefaultValue=FALSE returns the UIA default when a provider does not support a property:
    // https://github.com/MicrosoftDocs/win32/blob/docs/desktop-src/WinAuto/uiauto-automation-element-propids.md
    // https://github.com/MicrosoftDocs/sdk-api/blob/docs/sdk-api-src/content/uiautomationclient/nf-uiautomationclient-iuiautomationelement-getcachedpropertyvalueex.md
    // Only this capability accepts that negative default; the observed phase alone does not prove
    // provider non-support. Failed queries and malformed variants still refuse the observation.
    note(WindowsUiaPhase::security_keyboard); current_call();
    const auto keyboard_status = cached->GetCachedPropertyValueEx(UIA_IsKeyboardFocusablePropertyId, FALSE, &keyboard.value);
    const auto keyboard_focusable = classify_uia_keyboard_focusable(keyboard_status, keyboard.value);
    if (!keyboard_focusable) {
      note(FAILED(keyboard_status) ? WindowsUiaPhase::security_keyboard_query_failed : WindowsUiaPhase::security_keyboard_variant_invalid); unavailable();
    }
    const auto value_pattern = pattern_available<IUIAutomationValuePattern>(cached.get(), element, UIA_IsValuePatternAvailablePropertyId, UIA_ValuePatternId,
        {WindowsUiaPhase::security_value_pattern, WindowsUiaPhase::security_value_pattern_query_failed, WindowsUiaPhase::security_value_pattern_variant_invalid,
         WindowsUiaPhase::security_value_pattern_marker, WindowsUiaPhase::security_value_pattern_probe, WindowsUiaPhase::security_value_pattern_probe_invalid,
         WindowsUiaPhase::security_value_pattern_probe_empty, WindowsUiaPhase::security_value_pattern_probe_no_interface});
    const auto text_pattern = pattern_available<IUIAutomationTextPattern>(cached.get(), element, UIA_IsTextPatternAvailablePropertyId, UIA_TextPatternId,
        {WindowsUiaPhase::security_text_pattern, WindowsUiaPhase::security_text_pattern_query_failed, WindowsUiaPhase::security_text_pattern_variant_invalid,
         WindowsUiaPhase::security_text_pattern_marker, WindowsUiaPhase::security_text_pattern_probe, WindowsUiaPhase::security_text_pattern_probe_invalid,
         WindowsUiaPhase::security_text_pattern_probe_empty, WindowsUiaPhase::security_text_pattern_probe_no_interface});
    note(WindowsUiaPhase::security_pid);
    if (pid.value.lVal <= 0) unavailable();
    UiaSecurity result; result.pid = static_cast<DWORD>(pid.value.lVal); result.control_type = type.value.lVal; result.role = role(result.control_type);
    result.value_pattern = value_pattern; result.text_pattern = text_pattern;
    note(WindowsUiaPhase::security_classify); const auto classification = classify_uia_password(result.control_type,
        password.value.vt == VT_BOOL ? std::optional<bool>(password.value.boolVal != VARIANT_FALSE) : std::nullopt, result.value_pattern, result.text_pattern);
    if (!classification) unavailable(); result.password = *classification; result.enabled = enabled.value.boolVal != VARIANT_FALSE;
    result.focused = focus.value.boolVal != VARIANT_FALSE; result.keyboard_focusable = *keyboard_focusable;
    if (result.value_pattern) {
      note(WindowsUiaPhase::security_value_readonly); Variant read; current_call(); if (SUCCEEDED(cached->GetCachedPropertyValueEx(UIA_ValueIsReadOnlyPropertyId, TRUE, &read.value)) && read.value.vt == VT_BOOL) result.read_only = read.value.boolVal != VARIANT_FALSE;
    }
    if (!result.password && result.text_pattern) {
      note(WindowsUiaPhase::security_text_readonly); winrt::com_ptr<IUIAutomationTextPattern> pattern; winrt::com_ptr<IUIAutomationTextRange> range;
      current_call(); if (SUCCEEDED(element->GetCurrentPatternAs(UIA_TextPatternId, IID_PPV_ARGS(pattern.put()))) && pattern && SUCCEEDED(pattern->get_DocumentRange(range.put())) && range) {
        Variant read; current_call(); if (SUCCEEDED(range->GetAttributeValue(UIA_IsReadOnlyAttributeId, &read.value)) && read.value.vt == VT_BOOL) result.text_read_only = read.value.boolVal != VARIANT_FALSE;
      }
    }
    note(WindowsUiaPhase::security_bounds); RECT bounds{}; if (SUCCEEDED(cached->get_CachedBoundingRectangle(&bounds))) {
      WindowsRect rect{bounds.left, bounds.top, int64_t(bounds.right) - bounds.left, int64_t(bounds.bottom) - bounds.top}; if (rect.valid()) result.bounds = rect;
    }
    note(WindowsUiaPhase::security_current); current_call(); return result;
  }
  UiaName name(const UiaElement& value) {
    BSTR name = nullptr; current_call(); if (FAILED(native(value)->get_CurrentName(&name))) unavailable();
    struct String { BSTR value; ~String() { SysFreeString(value); } } close{name};
    const auto length = SysStringLen(name); const auto count = std::min<UINT>(length, 500);
    const std::wstring raw(name ? name : L"", count); const auto safe = sanitize_uia(raw);
    current_call(); return UiaName{safe, length <= 500 && safe == raw};
  }
  UiaElement root(const WindowsWindow& window) {
    note(WindowsUiaPhase::root_availability); const auto actual = observe_windows_availability(WindowsAvailabilityBackend::system());
    require_windows_surface(actual, &window.owner.process.token);
    require_windows_surface(actual, &window.physical_owner.process.token);
    DWORD pid = 0;
    note(WindowsUiaPhase::root_target);
    if (!eligible_windows_window(window) || GetWindowThreadProcessId(window.surface, &pid) != window.surface_thread_id || pid != window.owner.process.pid ||
        GetAncestor(window.surface, GA_ROOT) != window.hwnd || !windows_owner_current(window.owner) || !windows_owner_current(window.physical_owner)) unavailable();
    winrt::com_ptr<IUIAutomationElement> root;
    note(WindowsUiaPhase::root_element); current_call(); if (FAILED(automation_->ElementFromHandleBuildCache(window.surface, structural_.get(), root.put()))) unavailable();
    UIA_HWND handle = nullptr;
    note(WindowsUiaPhase::root_handle);
    if (!root || FAILED(root->get_CurrentNativeWindowHandle(&handle)) || reinterpret_cast<HWND>(handle) != window.surface) unavailable();
    note(WindowsUiaPhase::root_wrap); auto value = wrap(std::move(root)); const auto observed = security(value);
    note(WindowsUiaPhase::root_pid); if (observed.pid != window.owner.process.pid || GetWindowThreadProcessId(window.surface, &pid) != window.surface_thread_id || pid != window.owner.process.pid) unavailable(); return value;
  }
  UiaElement parent(const UiaElement& element) {
    winrt::com_ptr<IUIAutomationElement> parent;
    note(WindowsUiaPhase::parent_read); current_call(); if (FAILED(walker_->GetParentElementBuildCache(native(element), structural_.get(), parent.put()))) unavailable();
    note(WindowsUiaPhase::parent_wrap); return wrap(std::move(parent));
  }
  bool equal(const UiaElement& left, const UiaElement& right) {
    if (!left || !right) return false; BOOL same = FALSE; current_call();
    return SUCCEEDED(automation_->CompareElements(native(left), native(right), &same)) && same && left->native_->runtime_id == right->native_->runtime_id;
  }
  bool belongs(const UiaElement& value, const WindowsWindow& window) {
    const auto expected = root(window); auto cursor = value; std::vector<uint64_t> visited;
    for (size_t depth = 0; cursor && depth < 32; ++depth) {
      current_call(); if (security(cursor).pid != window.owner.process.pid || std::find(visited.begin(), visited.end(), cursor->identity) != visited.end()) return false;
      if (equal(cursor, expected)) return true; visited.push_back(cursor->identity); cursor = parent(cursor);
    }
    return false;
  }
  UiaChildren children(const UiaElement& value, size_t limit) {
    note(WindowsUiaPhase::children_limit); if (limit > 400) unavailable(); UiaChildren result;
    winrt::com_ptr<IUIAutomationElement> next;
    note(WindowsUiaPhase::children_first); current_call(); if (FAILED(walker_->GetFirstChildElementBuildCache(native(value), structural_.get(), next.put()))) unavailable();
    while (next) {
      note(WindowsUiaPhase::children_loop);
      if (result.elements.size() >= limit) { note(WindowsUiaPhase::children_capacity); result.truncated = true; break; }
      note(WindowsUiaPhase::children_wrap); const auto element = wrap(next); note(WindowsUiaPhase::children_append); result.elements.push_back(element);
      winrt::com_ptr<IUIAutomationElement> sibling; note(WindowsUiaPhase::children_next); current_call();
      if (FAILED(walker_->GetNextSiblingElementBuildCache(next.get(), structural_.get(), sibling.put()))) { note(WindowsUiaPhase::children_sibling_failed); result.truncated = true; break; }
      note(WindowsUiaPhase::children_compare);
      if (sibling && std::any_of(result.elements.begin(), result.elements.end(), [&](const auto& candidate) { return equal(candidate, wrap(sibling)); })) { note(WindowsUiaPhase::children_cycle); result.truncated = true; break; }
      next = std::move(sibling);
    }
    // A proven truncation leaves its terminal fact for hit's unchanged rejection below.
    if (!result.truncated) note(WindowsUiaPhase::children_end); return result;
  }
  UiaElement focused(const UiaElement& root) {
    VARIANT flag{}; flag.vt = VT_BOOL; flag.boolVal = VARIANT_TRUE;
    winrt::com_ptr<IUIAutomationCondition> condition;
    current_call(); if (FAILED(automation_->CreatePropertyCondition(UIA_HasKeyboardFocusPropertyId, flag, condition.put()))) unavailable();
    winrt::com_ptr<IUIAutomationElement> result;
    if (FAILED(native(root)->FindFirstBuildCache(TreeScope_Subtree, condition.get(), structural_.get(), result.put()))) unavailable();
    auto value = wrap(std::move(result)); if (!value || !security(value).focused) unavailable(); return value;
  }
  std::optional<std::wstring> accelerator(const UiaElement& element, bool command) {
    Variant raw; current_call();
    if (FAILED(native(element)->GetCurrentPropertyValueEx(command ? UIA_AcceleratorKeyPropertyId : UIA_AccessKeyPropertyId, TRUE, &raw.value)) ||
        raw.value.vt != VT_BSTR || SysStringLen(raw.value.bstrVal) > 256) return {};
    const std::wstring text(raw.value.bstrVal ? raw.value.bstrVal : L"", SysStringLen(raw.value.bstrVal));
    if (sanitize_uia(text, 256) != text) return {}; return text;
  }
  std::optional<std::vector<UiaMenuShortcut>> menus(const UiaElement& root) {
    VARIANT type{}; type.vt = VT_I4; type.lVal = UIA_MenuBarControlTypeId;
    winrt::com_ptr<IUIAutomationCondition> condition;
    if (FAILED(automation_->CreatePropertyCondition(UIA_ControlTypePropertyId, type, condition.put()))) return {};
    winrt::com_ptr<IUIAutomationElement> menu;
    current_call(); if (FAILED(native(root)->FindFirstBuildCache(TreeScope_Subtree, condition.get(), structural_.get(), menu.put()))) return {};
    if (!menu) return std::vector<UiaMenuShortcut>{};
    const auto pid = security(root).pid;
    struct Menu { UiaElement element; std::vector<std::wstring> path; size_t depth; };
    std::deque<Menu> queue{{wrap(std::move(menu)), {}, 0}}; std::vector<uint64_t> visited; std::vector<UiaMenuShortcut> result;
    while (!queue.empty() && visited.size() < 200 && result.size() <= 128) {
      current_call(); auto node = queue.front(); queue.pop_front();
      if (node.depth > 30 || std::find(visited.begin(), visited.end(), node.element->identity) != visited.end()) return {};
      visited.push_back(node.element->identity); const auto state = security(node.element); if (state.pid != pid) return {};
      if (state.control_type == UIA_MenuItemControlTypeId) {
        const auto label = name(node.element); if (!label.complete || label.text.empty() || label.text.size() > 256 || node.path.size() >= 30) return {};
        node.path.push_back(label.text);
        const auto command = accelerator(node.element, true), access = accelerator(node.element, false); if (!command || !access) return {};
        if (!command->empty() || !access->empty()) result.push_back(UiaMenuShortcut{node.path, *command, *access});
      } else if (state.control_type != UIA_MenuControlTypeId && state.control_type != UIA_MenuBarControlTypeId && state.control_type != UIA_SeparatorControlTypeId) return {};
      const auto descendants = children(node.element, 200 - visited.size() - std::min<size_t>(queue.size(), 200 - visited.size()));
      if (descendants.truncated) return {};
      for (const auto& child : descendants.elements) queue.push_back(Menu{child, node.path, node.depth + 1});
    }
    if (!queue.empty() || result.size() > 128) return {}; return result;
  }
  std::optional<UiaMenuShortcut> menu_target(const UiaElement& element, const UiaElement& root) {
    const auto initial = security(element), owner = security(root);
    if (initial.control_type != UIA_MenuItemControlTypeId || initial.pid != owner.pid) return {};
    UiaMenuShortcut result;
    const auto command = accelerator(element, true), access = accelerator(element, false); if (!command || !access) return {};
    result.accelerator = *command; result.access = *access;
    auto cursor = element; std::vector<uint64_t> visited; bool actual_menu = false;
    for (size_t depth = 0; cursor && depth < 32; ++depth) {
      current_call(); if (std::find(visited.begin(), visited.end(), cursor->identity) != visited.end()) return {};
      visited.push_back(cursor->identity); const auto state = security(cursor); if (state.pid != owner.pid) return {};
      if (equal(cursor, root)) {
        if (!actual_menu || result.path.empty()) return {};
        std::reverse(result.path.begin(), result.path.end()); return result;
      }
      if (state.control_type == UIA_MenuItemControlTypeId) {
        const auto label = name(cursor); if (!label.complete || label.text.empty() || label.text.size() > 256 || result.path.size() >= 30) return {};
        result.path.push_back(label.text);
      } else if (state.control_type == UIA_MenuControlTypeId || state.control_type == UIA_MenuBarControlTypeId) actual_menu = true;
      cursor = parent(cursor);
    }
    return {};
  }
  UiaPointBackend overlay_backend() {
    // Unlike the ordinary app-scoped BFS, this smoke-only path asks UIA for its actual point
    // target. It never searches underneath a foreign result or substitutes a guessed root.
    // https://learn.microsoft.com/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomation-elementfrompointbuildcache
    // https://learn.microsoft.com/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomationtreewalker-normalizeelementbuildcache
    UiaPointBackend backend; backend.current = current_call;
    backend.point = [this](POINT location) {
      note(WindowsUiaPhase::hit_setup); current_call(); winrt::com_ptr<IUIAutomationElement> element;
      if (automation_->ElementFromPointBuildCache(location, structural_.get(), element.put()) != S_OK || !element) unavailable();
      current_call(); return wrap(std::move(element));
    };
    backend.normalize = [this](const UiaElement& value) {
      current_call(); winrt::com_ptr<IUIAutomationElement> element;
      if (walker_->NormalizeElementBuildCache(native(value), structural_.get(), element.put()) != S_OK || !element) unavailable();
      current_call(); return wrap(std::move(element));
    };
    backend.metadata = [this](const UiaElement& value) {
      // wrap() intentionally reuses stable native identities; its original cached properties may
      // predate this hit. Refresh metadata rather than treating those old bounds as current proof.
      winrt::com_ptr<IUIAutomationElement> element; Variant pid; RECT bounds{};
      if (native(value)->BuildUpdatedCache(structural_.get(), element.put()) != S_OK || !element) unavailable();
      current_call();
      if (element->GetCachedPropertyValueEx(UIA_ProcessIdPropertyId, TRUE, &pid.value) != S_OK || pid.value.vt != VT_I4 || pid.value.lVal <= 0 ||
          element->get_CachedBoundingRectangle(&bounds) != S_OK) unavailable();
      current_call(); return UiaPointMetadata{static_cast<DWORD>(pid.value.lVal), value->native_->runtime_id,
          WindowsRect{bounds.left, bounds.top, int64_t(bounds.right) - bounds.left, int64_t(bounds.bottom) - bounds.top}};
    };
    backend.parent = [this](const auto& value) { return parent(value); };
    backend.equal = [this](const auto& left, const auto& right) { return equal(left, right); };
    backend.security = [this](const auto& value) { return security(value); };
    return backend;
  }
  UiaElement overlay_hit(const UiaElement& root, POINT point) {
    return resolve_uia_overlay_point(root, point, overlay_backend());
  }
  bool overlay_belongs(const UiaElement& element, const WindowsWindow& window, POINT point) {
    // Re-observe the actual native window root, including its existing token, handle, owner and
    // full security checks. This is a new proof inside the caller's one original 50 ms ticket.
    const auto expected = root(window);
    return resolve_uia_overlay_membership(expected, element, point, overlay_backend());
  }
  UiaElement hit(const UiaElement& root, POINT point) {
    note(WindowsUiaPhase::hit_setup); struct Node { UiaElement element; size_t depth; };
    std::deque<Node> queue{{root, 0}}; std::vector<uint64_t> visited; UiaElement result; size_t selected_depth = 0; bool ambiguous = false;
    const auto pid = security(root).pid;
    while (!queue.empty() && visited.size() < 400) {
      note(WindowsUiaPhase::hit_loop); current_call(); const auto node = queue.front(); queue.pop_front();
      note(WindowsUiaPhase::hit_cycle); if (std::find(visited.begin(), visited.end(), node.element->identity) != visited.end()) unavailable(); visited.push_back(node.element->identity);
      const auto state = security(node.element); note(WindowsUiaPhase::hit_pid); if (state.pid != pid) unavailable();
      if (!state.bounds || !state.bounds->contains(point)) continue;
      if (!result || node.depth > selected_depth) { result = node.element; selected_depth = node.depth; ambiguous = false; }
      else if (node.depth == selected_depth) { note(WindowsUiaPhase::hit_equal); if (!equal(result, node.element)) ambiguous = true; }
      note(WindowsUiaPhase::hit_depth); if (node.depth >= 30) unavailable();
      note(WindowsUiaPhase::hit_children); const auto descendants = children(node.element, 400 - visited.size() - std::min<size_t>(queue.size(), 400 - visited.size()));
      if (descendants.truncated) unavailable();
      note(WindowsUiaPhase::hit_enqueue); for (const auto& child : descendants.elements) queue.push_back(Node{child, node.depth + 1});
    }
    // Preserve the original terminal guard's short-circuit order, naming only the failing fact.
    note(WindowsUiaPhase::hit_queue_limit); if (!queue.empty()) unavailable();
    note(WindowsUiaPhase::hit_ambiguous); if (ambiguous) unavailable();
    note(WindowsUiaPhase::hit_empty); if (!result) unavailable();
    note(WindowsUiaPhase::hit_end); return result;
  }
  std::optional<std::wstring> value(const UiaElement& element) {
    const auto state = security(element); if (state.password) throw Failure{L"secure_field", L"The native field is secure."};
    winrt::com_ptr<IUIAutomationValuePattern> pattern;
    current_call(); if (!state.value_pattern || FAILED(native(element)->GetCurrentPatternAs(UIA_ValuePatternId, IID_PPV_ARGS(pattern.put()))) || !pattern) return {};
    if (security(element).password) throw Failure{L"secure_field", L"The native field is secure."};
    BSTR value = nullptr; if (FAILED(pattern->get_CurrentValue(&value))) unavailable();
    struct String { BSTR value; ~String() { SysFreeString(value); } } close{value};
    if (SysStringLen(value) > 4000) return {};
    const std::wstring text(value ? value : L"", SysStringLen(value)); current_call(); return text;
  }
  void before_mutation(const WindowsWindow* window) {
    if (!mutation_ || !window) throw Failure{L"stale_ref", L"The native accessibility target changed."};
    const auto live = security(mutation_->element); const auto label = name(mutation_->element); const auto& old = mutation_->security;
    if (live.password) throw Failure{L"secure_field", L"The native field is secure."};
    if (live.pid != old.pid || live.control_type != old.control_type || live.bounds != old.bounds || live.enabled != old.enabled ||
        live.value_pattern != old.value_pattern || live.read_only != old.read_only || live.text_pattern != old.text_pattern || live.text_read_only != old.text_read_only ||
        live.keyboard_focusable != old.keyboard_focusable || !label.complete || label.text != mutation_name_)
      throw Failure{L"stale_ref", L"The native accessibility target changed."};
    if (mutation_->menu) {
      const auto actual = menu_target(mutation_->element, mutation_->root);
      if (!actual || actual->path != mutation_->menu->path || actual->accelerator != mutation_->menu->accelerator || actual->access != mutation_->menu->access)
        throw Failure{L"stale_ref", L"The native accessibility menu changed."};
    }
    current_mutation(window);
    require_uia_mutation_gate(mutation_gate_);
  }
  bool set_value(const UiaElement& element, const std::wstring& text, const WindowsWindow* window = nullptr) {
    const auto state = security(element); if (state.password) throw Failure{L"secure_field", L"The native field is secure."};
    if (!state.enabled || !state.value_pattern || state.read_only != false || !state.editable() || text.size() > 4000 || text.find(L'\0') != std::wstring::npos) return false;
    winrt::com_ptr<IUIAutomationValuePattern> pattern;
    current_call(); if (FAILED(native(element)->GetCurrentPatternAs(UIA_ValuePatternId, IID_PPV_ARGS(pattern.put()))) || !pattern) return false;
    BOOL read_only = TRUE; if (FAILED(pattern->get_CurrentIsReadOnly(&read_only)) || read_only) return false;
    const auto final = security(element); if (final.password) throw Failure{L"secure_field", L"The native field is secure."};
    if (!final.enabled || !final.value_pattern || final.read_only != false || !final.editable()) return false;
    const auto value=SysAllocStringLen(text.data(),static_cast<UINT>(text.size()));
    if (!value) unavailable();
    struct Value { BSTR data; ~Value() { SysFreeString(data); } } release_value{value};
    before_mutation(window); return mutation_result(pattern->SetValue(value));
  }
  bool perform(const UiaElement& element, std::wstring_view action, const WindowsWindow* window = nullptr) {
    const auto state = security(element); if (!state.enabled) return false;
    if (state.password) throw Failure{L"secure_field", L"The native field is secure."};
    if (action == L"AXRaise" || action == L"SetFocus") { if (!state.keyboard_focusable) return false; const auto target = native(element); before_mutation(window); return mutation_result(target->SetFocus()); }
    if (action == L"AXScrollToVisible" || action == L"ScrollIntoView") { winrt::com_ptr<IUIAutomationScrollItemPattern> pattern; current_call();
      if (FAILED(native(element)->GetCurrentPatternAs(UIA_ScrollItemPatternId, IID_PPV_ARGS(pattern.put()))) || !pattern) return false; before_mutation(window); return mutation_result(pattern->ScrollIntoView()); }
    if (action == L"AXShowMenu" || action == L"Expand" || action == L"Collapse") { winrt::com_ptr<IUIAutomationExpandCollapsePattern> pattern; current_call();
      if (FAILED(native(element)->GetCurrentPatternAs(UIA_ExpandCollapsePatternId, IID_PPV_ARGS(pattern.put()))) || !pattern) return false; before_mutation(window); return mutation_result(action == L"Collapse" ? pattern->Collapse() : pattern->Expand()); }
    if (action == L"Select") { winrt::com_ptr<IUIAutomationSelectionItemPattern> pattern; current_call();
      if (FAILED(native(element)->GetCurrentPatternAs(UIA_SelectionItemPatternId, IID_PPV_ARGS(pattern.put()))) || !pattern) return false; before_mutation(window); return mutation_result(pattern->Select()); }
    if (action == L"Toggle") { winrt::com_ptr<IUIAutomationTogglePattern> pattern; current_call();
      if (FAILED(native(element)->GetCurrentPatternAs(UIA_TogglePatternId, IID_PPV_ARGS(pattern.put()))) || !pattern) return false; before_mutation(window); return mutation_result(pattern->Toggle()); }
    if (action == L"Invoke" || action == L"AXPress" || action == L"AXConfirm" || action == L"AXPick") {
      winrt::com_ptr<IUIAutomationInvokePattern> invoke; current_call();
      if (SUCCEEDED(native(element)->GetCurrentPatternAs(UIA_InvokePatternId, IID_PPV_ARGS(invoke.put()))) && invoke) { before_mutation(window); return mutation_result(invoke->Invoke()); }
      winrt::com_ptr<IUIAutomationSelectionItemPattern> select; current_call();
      if (SUCCEEDED(native(element)->GetCurrentPatternAs(UIA_SelectionItemPatternId, IID_PPV_ARGS(select.put()))) && select) { before_mutation(window); return mutation_result(select->Select()); }
      winrt::com_ptr<IUIAutomationTogglePattern> toggle; current_call();
      if (FAILED(native(element)->GetCurrentPatternAs(UIA_TogglePatternId, IID_PPV_ARGS(toggle.put()))) || !toggle) return false; before_mutation(window); return mutation_result(toggle->Toggle());
    }
    if (action == L"AXIncrement" || action == L"AXDecrement" || action == L"Increment" || action == L"Decrement") {
      winrt::com_ptr<IUIAutomationRangeValuePattern> range; current_call();
      if (FAILED(native(element)->GetCurrentPatternAs(UIA_RangeValuePatternId, IID_PPV_ARGS(range.put()))) || !range) return false;
      BOOL read_only = TRUE; double value = 0, change = 0, minimum = 0, maximum = 0;
      if (FAILED(range->get_CurrentIsReadOnly(&read_only)) || read_only || FAILED(range->get_CurrentValue(&value)) || FAILED(range->get_CurrentSmallChange(&change)) ||
          FAILED(range->get_CurrentMinimum(&minimum)) || FAILED(range->get_CurrentMaximum(&maximum)) || !std::isfinite(value) || !std::isfinite(change) || change <= 0 || !std::isfinite(minimum) || !std::isfinite(maximum) || minimum > maximum) return false;
      before_mutation(window); return mutation_result(range->SetValue(std::clamp(value + (action == L"AXIncrement" || action == L"Increment" ? change : -change), minimum, maximum)));
    }
    return false;
  }
  bool commit(const UiaObservation& expected, const UiaName& expected_name, const std::wstring& action,
              const std::optional<std::wstring>& text, const std::shared_ptr<std::atomic_bool>& attempted,const std::function<bool()>& metadata_gate) {
    if (!windows_window_current(expected.window) || !equal(root(expected.window), expected.root) || !belongs(expected.element, expected.window))
      throw Failure{L"stale_ref", L"The native accessibility target changed."};
    const auto state = security(expected.element); const auto label = name(expected.element); const auto& old = expected.security;
    if (state.pid != old.pid || state.control_type != old.control_type || state.bounds != old.bounds || state.password != old.password || state.enabled != old.enabled ||
        state.value_pattern != old.value_pattern || state.read_only != old.read_only || state.text_pattern != old.text_pattern || state.text_read_only != old.text_read_only || state.keyboard_focusable != old.keyboard_focusable ||
        !label.complete || !expected_name.complete || label.text != expected_name.text) throw Failure{L"stale_ref", L"The native accessibility target changed."};
    if (state.control_type == UIA_MenuItemControlTypeId) {
      const auto menu = menu_target(expected.element, expected.root);
      if (!menu || !expected.menu || menu->path != expected.menu->path || menu->accelerator != expected.menu->accelerator || menu->access != expected.menu->access)
        throw Failure{L"stale_ref", L"The native accessibility menu changed."};
    } else if (expected.menu) throw Failure{L"stale_ref", L"The native accessibility target changed."};
    current_call(); attempted->store(true); mutation_ = &expected; mutation_name_ = expected_name.text;mutation_gate_=metadata_gate;
    struct Reset { const UiaObservation*& target; std::wstring& name;std::function<bool()>& gate; ~Reset() { target = nullptr; name.clear();gate={}; } } reset{mutation_, mutation_name_,mutation_gate_};
    return text ? set_value(expected.element, *text, &expected.window) : perform(expected.element, action, &expected.window);
  }
};

void require_uia_mutation_gate(const std::function<bool()>& gate) {
  bool current=false;try{current=gate && gate();}catch(...){}
  if(!current)throw Failure{L"changed",L"Physical input detection no longer permits the accessibility action."};
}

WindowsUiaBackend WindowsUiaBackend::system(std::shared_ptr<WindowsUiaDiagnostic> diagnostic) {
  const auto native = NativeUia::make(diagnostic); WindowsUiaBackend backend;
  backend.root = [native, diagnostic](const auto& window) { note_uia(diagnostic, WindowsUiaPhase::root_current); if (!windows_window_current(window)) unavailable(); return native->call([native, window] { return native->root(window); }); };
  backend.security = [native](const auto& element) { return native->call([native, element] { return native->security(element); }); };
  backend.name = [native](const auto& element) { return native->call([native, element] { return native->name(element); }); };
  backend.value = [native](const auto& element) { return native->call([native, element] { return native->value(element); }); };
  backend.children = [native](const auto& element, size_t limit) { return native->call([native, element, limit] { return native->children(element, limit); }); };
  backend.parent = [native](const auto& element) { return native->call([native, element] { return native->parent(element); }); };
  backend.focused = [native](const auto& root) { return native->call([native, root] { return native->focused(root); }); };
  backend.hit = [native](const auto& root, POINT point) { return native->call([native, root, point] { return native->hit(root, point); }); };
  backend.overlay_hit = [native](const auto& root, POINT point) { return native->call([native, root, point] { return native->overlay_hit(root, point); }); };
  backend.overlay_belongs = [native](const auto& element, const auto& window, POINT point) { return native->call([native, element, window, point] { return native->overlay_belongs(element, window, point); }); };
  backend.equal = [native](const auto& left, const auto& right) { return native->call([native, left, right] { return native->equal(left, right); }); };
  backend.belongs = [native](const auto& element, const auto& window) { return native->call([native, element, window] { return native->belongs(element, window); }); };
  backend.perform = [native](const auto& element, auto action) { return native->call([native, element, action = std::wstring(action)] { return native->perform(element, action); }); };
  backend.set_value = [native](const auto& element, const auto& text) { return native->call([native, element, text] { return native->set_value(element, text); }); };
  backend.close = [native] { native->close(); };
  backend.menu_shortcuts = [native](const auto& root) { try { return native->call([native, root] { return native->menus(root); }); } catch (...) { return std::optional<std::vector<UiaMenuShortcut>>{}; } };
  backend.available = [native] { return native->available(); };
  backend.commit = [native](const auto& observed, const auto& name, std::wstring_view action, const std::optional<std::wstring>& text,const std::function<bool()>& metadata_gate) {
    const auto attempted = std::make_shared<std::atomic_bool>(false);
    try { return native->call([native, observed, name, action = std::wstring(action), text, attempted,metadata_gate] { return native->commit(observed, name, action, text, attempted,metadata_gate); }); }
    catch (...) { if (attempted->load()) throw Failure{L"changed", L"The native accessibility action could not be confirmed."}; throw; }
  };
  backend.menu_target = [native](const auto& element, const auto& root) -> std::optional<UiaMenuShortcut> {
    try { return native->call([native, element, root] { return native->menu_target(element, root); }); } catch (...) { return {}; }
  };
  return backend;
}

namespace {
void require_overlay_backend(const UiaElement& root, const UiaPointBackend& backend) {
  if (!root || !backend.current || !backend.metadata || !backend.parent || !backend.equal || !backend.security) unavailable();
}
UiaPointMetadata overlay_metadata(const UiaElement& value, POINT point, const UiaPointBackend& backend) {
  backend.current(); if (!value) unavailable(); const auto state = backend.metadata(value); backend.current();
  if (!state.pid || state.runtime_id.empty() || state.runtime_id.size() > 64 || !state.bounds || !state.bounds->valid() || !state.bounds->contains(point)) unavailable();
  return state;
}
bool overlay_equal(const UiaElement& left, const UiaElement& right, const UiaPointBackend& backend) {
  backend.current(); if (!left || !right) unavailable(); const auto result = backend.equal(left, right); backend.current(); return result;
}
UiaElement overlay_parent(const UiaElement& value, const UiaPointBackend& backend) {
  backend.current(); const auto result = backend.parent(value); backend.current(); return result;
}
UiaElement require_overlay_ancestry(const UiaElement& root, const UiaPointMetadata& scope, const UiaElement& selected,
                                  const UiaPointMetadata& selected_state, POINT point, const UiaPointBackend& backend) {
  auto cursor = selected; auto state = selected_state; std::vector<std::vector<int>> visited; bool reached = false;
  for (size_t depth = 0; cursor && depth < 32; ++depth) {
    backend.current(); if (state.pid != scope.pid || std::find(visited.begin(), visited.end(), state.runtime_id) != visited.end()) unavailable();
    visited.push_back(state.runtime_id);
    if (state.runtime_id == scope.runtime_id) { if (!overlay_equal(cursor, root, backend)) unavailable(); reached = true; break; }
    cursor = overlay_parent(cursor, backend); if (!cursor) unavailable(); state = overlay_metadata(cursor, point, backend);
  }
  if (!reached) unavailable();
  // No name, value or document content is requested while membership is still unknown. The full
  // native classifier preserves unknown-password refusals before the driver can inspect a label.
  backend.current(); const auto security = backend.security(selected); backend.current();
  if (security.pid != scope.pid || security.password || !security.enabled || !security.bounds || !security.bounds->valid() ||
      security.bounds != selected_state.bounds || !security.bounds->contains(point)) unavailable();
  return selected;
}
}

UiaElement resolve_uia_overlay_point(const UiaElement& root, POINT point, const UiaPointBackend& backend) {
  require_overlay_backend(root, backend); if (!backend.point || !backend.normalize) unavailable();
  const auto scope = overlay_metadata(root, point, backend);
  backend.current(); const auto raw = backend.point(point); backend.current(); const auto raw_state = overlay_metadata(raw, point, backend);
  if (raw_state.pid != scope.pid) unavailable();
  backend.current(); const auto selected = backend.normalize(raw); backend.current(); const auto selected_state = overlay_metadata(selected, point, backend);
  if (selected_state.pid != scope.pid) unavailable();
  // Normalization must preserve the actual point target or its immediate Control View parent.
  // A same-process result in another window is never sufficient proof of membership.
  if (overlay_equal(raw, selected, backend)) { if (raw_state.runtime_id != selected_state.runtime_id) unavailable(); }
  else if (!overlay_equal(overlay_parent(raw, backend), selected, backend)) unavailable();
  return require_overlay_ancestry(root, scope, selected, selected_state, point, backend);
}

bool resolve_uia_overlay_membership(const UiaElement& root, const UiaElement& element, POINT point, const UiaPointBackend& backend) {
  require_overlay_backend(root, backend);
  const auto scope = overlay_metadata(root, point, backend), selected = overlay_metadata(element, point, backend);
  static_cast<void>(require_overlay_ancestry(root, scope, element, selected, point, backend)); return true;
}

std::wstring sanitize_uia(std::wstring_view text, size_t maximum) {
  std::wstring result;
  for (size_t index = 0; index < text.size() && result.size() < maximum; ++index) {
    const auto value = static_cast<uint16_t>(text[index]);
    if (value < 32 || (value >= 0x7f && value <= 0x9f) || value == 0x061c || (value >= 0x200b && value <= 0x200f) ||
        (value >= 0x2028 && value <= 0x202e) || (value >= 0x2060 && value <= 0x206f) || value == 0xfeff) continue;
    if (value >= 0xd800 && value <= 0xdbff) { if (index + 1 < text.size() && text[index + 1] >= 0xdc00 && text[index + 1] <= 0xdfff && result.size() + 2 <= maximum) { result.push_back(text[index]); result.push_back(text[++index]); } continue; }
    if (value >= 0xdc00 && value <= 0xdfff) continue; result.push_back(text[index]);
  }
  return result;
}
std::optional<bool> classify_uia_keyboard_focusable(HRESULT status, const VARIANT& value) noexcept {
  if (FAILED(status) || value.vt != VT_BOOL || (value.boolVal != VARIANT_FALSE && value.boolVal != VARIANT_TRUE)) return {};
  return value.boolVal == VARIANT_TRUE;
}
std::optional<bool> classify_uia_pattern_support(HRESULT status, bool interface_present) noexcept {
  // Called only after the exact reserved NotSupported cache marker for a known typed pattern.
  // Microsoft's provider contract/sample return S_OK + NULL when a pattern is unsupported. Its
  // client checks the native HRESULT first, then treats a successful zero pattern handle as absent.
  // https://github.com/microsoft/Windows-classic-samples/blob/main/Samples/Win7Samples/winui/uiautomation/simpleuiaprovider/CPP/Provider.cpp#L117-L128
  // https://github.com/MicrosoftDocs/sdk-api/blob/docs/sdk-api-src/content/uiautomationcore/nf-uiautomationcore-irawelementprovidersimple-getpatternprovider.md
  // https://github.com/dotnet/wpf/blob/1fdaaaab9b20a0c00c3a53fa1a61d047fac96d2a/src/Microsoft.DotNet.Wpf/src/UIAutomation/UIAutomationClient/MS/Internal/Automation/UiaCoreApi.cs#L397-L407
  // https://github.com/dotnet/wpf/blob/1fdaaaab9b20a0c00c3a53fa1a61d047fac96d2a/src/Microsoft.DotNet.Wpf/src/UIAutomation/UIAutomationClient/System/Windows/Automation/AutomationElement.cs#L562-L595
  // https://github.com/dotnet/wpf/blob/1fdaaaab9b20a0c00c3a53fa1a61d047fac96d2a/src/Microsoft.DotNet.Wpf/src/UIAutomation/UIAutomationClient/MS/Internal/Automation/SafeHandles.cs#L39-L51
  if (status == S_OK) return interface_present;
  // UIA_E_NOTSUPPORTED also means the provider "explicitly does not support the specified
  // property or control pattern". Every other failed or ambiguous result remains unknown.
  // https://github.com/MicrosoftDocs/win32/blob/docs/desktop-src/WinAuto/uiauto-error-codes.md
  if (status == UIA_E_NOTSUPPORTED && !interface_present) return false;
  return {};
}
std::optional<bool> classify_uia_password(int control_type, std::optional<bool> reported, bool value_pattern, bool text_pattern) noexcept {
  if (reported) return reported;
  if (value_pattern || text_pattern) return {};
  switch (control_type) {
    case UIA_ButtonControlTypeId: case UIA_CheckBoxControlTypeId: case UIA_RadioButtonControlTypeId:
    case UIA_HyperlinkControlTypeId: case UIA_ImageControlTypeId: case UIA_ListControlTypeId: case UIA_ListItemControlTypeId:
    case UIA_MenuControlTypeId: case UIA_MenuBarControlTypeId: case UIA_MenuItemControlTypeId: case UIA_ProgressBarControlTypeId:
    case UIA_ScrollBarControlTypeId: case UIA_SliderControlTypeId: case UIA_StatusBarControlTypeId: case UIA_TabControlTypeId:
    case UIA_TabItemControlTypeId: case UIA_TextControlTypeId: case UIA_ToolBarControlTypeId: case UIA_ToolTipControlTypeId:
    case UIA_TreeControlTypeId: case UIA_TreeItemControlTypeId: case UIA_WindowControlTypeId: case UIA_PaneControlTypeId:
    case UIA_GroupControlTypeId: case UIA_SeparatorControlTypeId: case UIA_SplitButtonControlTypeId: return false;
    default: return {};
  }
}
WindowsUiaObserver::WindowsUiaObserver(WindowsUiaBackend backend, std::function<uint64_t()> now) : backend_(std::move(backend)), now_(now ? std::move(now) : std::function<uint64_t()>(now_ms)) {}
UiaObservation WindowsUiaObserver::focused(const WindowsWindow& window) {
  auto root = backend_.root(window), element = backend_.focused(root);
  if (!backend_.belongs(element, window)) unavailable();
  const auto sampled = now_(); const auto state = backend_.security(element);
  if (!state.focused || state.pid != window.owner.process.pid) unavailable();
  return UiaObservation{window, root, element, state, sampled};
}
UiaObservation WindowsUiaObserver::pointer(const WindowsWindow& window, POINT point) {
  auto root = backend_.root(window), element = backend_.hit(root, point);
  if (!backend_.belongs(element, window)) unavailable();
  const auto sampled = now_(); const auto state = backend_.security(element);
  if (state.pid != window.owner.process.pid || !state.bounds || !state.bounds->contains(point)) unavailable();
  return UiaObservation{window, root, element, state, sampled};
}
bool WindowsUiaObserver::same(const UiaObservation& left, const UiaObservation& right) const {
  return same_windows_window(left.window, right.window) && left.security.pid == right.security.pid && left.security.password == right.security.password &&
      left.security.control_type == right.security.control_type && left.security.bounds == right.security.bounds && left.security.enabled == right.security.enabled &&
      left.security.focused == right.security.focused && left.security.read_only == right.security.read_only && left.security.value_pattern == right.security.value_pattern &&
      left.security.keyboard_focusable == right.security.keyboard_focusable &&
      left.security.text_pattern == right.security.text_pattern && left.security.text_read_only == right.security.text_read_only &&
      backend_.equal(left.root, right.root) && backend_.equal(left.element, right.element);
}
bool WindowsUiaObserver::fresh(const UiaObservation& value, uint64_t maximum_age) const noexcept {
  try { const auto now = now_(); return (!backend_.available || backend_.available()) && value.element && value.root && value.observed_at_ms <= now && now - value.observed_at_ms <= std::min<uint64_t>(maximum_age, 50); }
  catch (...) { return false; }
}
void WindowsUiaObserver::close() { if (backend_.close) backend_.close(); }
}
