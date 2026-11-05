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
struct UiaActor {
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
void current_call() { if (!active_ticket || active_ticket->cancelled.load() || !active_ticket->actor || active_ticket->actor->revoked.load() || now_ms() >= active_ticket->deadline) unavailable(); }
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

  IUIAutomationElement* native(const UiaElement& value) {
    current_call(); if (!value || !value->native_ || !value->native_->element) unavailable(); return value->native_->element.get();
  }
  std::vector<int> runtime_id(IUIAutomationElement* element) {
    SAFEARRAY* array = nullptr; current_call();
    if (FAILED(element->GetRuntimeId(&array)) || !array) unavailable();
    struct Array { SAFEARRAY* value; ~Array() { SafeArrayDestroy(value); } } close{array};
    LONG lower = 0, upper = -1;
    VARTYPE kind = VT_EMPTY;
    if (SafeArrayGetDim(array) != 1 || FAILED(SafeArrayGetVartype(array, &kind)) || kind != VT_I4 || SafeArrayGetElemsize(array) != sizeof(int) ||
        FAILED(SafeArrayGetLBound(array, 1, &lower)) || FAILED(SafeArrayGetUBound(array, 1, &upper)) || upper < lower || int64_t(upper) - lower >= 64) unavailable();
    std::vector<int> result;
    for (int64_t offset = 0; offset <= int64_t(upper) - lower; ++offset) { auto index = static_cast<LONG>(int64_t(lower) + offset); int value = 0; if (FAILED(SafeArrayGetElement(array, &index, &value))) unavailable(); result.push_back(value); }
    current_call(); return result;
  }
  UiaElement wrap(winrt::com_ptr<IUIAutomationElement> element) {
    if (!element) return {};
    const auto id = runtime_id(element.get());
    std::erase_if(elements_, [](const auto& value) { return value.expired(); });
    for (const auto& weak : elements_) if (const auto existing = weak.lock(); existing && existing->native_->runtime_id == id) {
      BOOL same = FALSE; current_call();
      if (SUCCEEDED(automation_->CompareElements(element.get(), existing->native_->element.get(), &same)) && same) return existing;
    }
    if (elements_.size() >= 8192) unavailable();
    auto storage = std::make_shared<WindowsUiaElement::Storage>(); storage->element = std::move(element); storage->owner = actor_; storage->runtime_id = id;
    auto result = std::shared_ptr<WindowsUiaElement>(new WindowsUiaElement(++sequence_, std::move(storage))); elements_.push_back(result); return result;
  }
  void prepare() {
    current_call(); desktop_ready(); if (automation_) return;
    winrt::com_ptr<IUIAutomation> automation;
    winrt::com_ptr<IUIAutomationTreeWalker> walker;
    winrt::com_ptr<IUIAutomationCacheRequest> structural;
    if (FAILED(CoCreateInstance(CLSID_CUIAutomation8, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(automation.put())))) unavailable();
    const auto timeouts = automation.try_as<IUIAutomation2>();
    if (!timeouts || FAILED(timeouts->put_ConnectionTimeout(50)) || FAILED(timeouts->put_TransactionTimeout(50)) ||
        FAILED(automation->get_ControlViewWalker(walker.put())) || FAILED(automation->CreateCacheRequest(structural.put())) ||
        FAILED(structural->put_TreeScope(TreeScope_Element))) unavailable();
    winrt::com_ptr<IUIAutomationCondition> control;
    if (FAILED(automation->get_ControlViewCondition(control.put())) || FAILED(structural->put_TreeFilter(control.get()))) unavailable();
    for (const auto property : {UIA_ProcessIdPropertyId, UIA_ControlTypePropertyId, UIA_BoundingRectanglePropertyId,
         UIA_IsPasswordPropertyId, UIA_IsEnabledPropertyId, UIA_HasKeyboardFocusPropertyId, UIA_IsKeyboardFocusablePropertyId,
         UIA_IsValuePatternAvailablePropertyId, UIA_IsTextPatternAvailablePropertyId, UIA_ValueIsReadOnlyPropertyId}) if (FAILED(structural->AddProperty(property))) unavailable();
    current_call();
    automation_ = std::move(automation); walker_ = std::move(walker); structural_ = std::move(structural);
  }
 public:
  static std::shared_ptr<NativeUia> make() {
    const auto self = std::shared_ptr<NativeUia>(new NativeUia());
    const auto actor = self->actor_;
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
    { std::lock_guard lock(actor_->mutex); if (actor_->closed || actor_->quarantined || actor_->jobs.size() >= 8) unavailable();
      actor_->jobs.push_back([self = shared_from_this(), promise, ticket, body = std::move(body)]() mutable {
        active_ticket = ticket.get();
        try { WindowsComCall budget; current_call(); if (!budget.current()) unavailable(); self->prepare();
          auto value = body(); current_call(); if (!budget.current()) unavailable(); promise->set_value(std::move(value)); }
        catch (...) { try { promise->set_exception(std::current_exception()); } catch (...) {} }
        active_ticket = nullptr;
      }); actor_->condition.notify_one(); }
    const auto deadline = std::chrono::steady_clock::time_point(std::chrono::milliseconds(ticket->deadline));
    if (result.wait_until(deadline) != std::future_status::ready || now_ms() >= ticket->deadline) {
      ticket->cancelled.store(true); actor_->revoked.store(true); DWORD thread = 0; std::deque<std::function<void()>> discarded;
      { std::lock_guard lock(actor_->mutex); actor_->quarantined = true; discarded.swap(actor_->jobs); thread = actor_->thread; actor_->condition.notify_all(); }
      if (thread) (void)CoCancelCall(thread, 0); unavailable();
    }
    return result.get();
  }
  UiaSecurity security(const UiaElement& value) {
    auto element = native(value); winrt::com_ptr<IUIAutomationElement> cached;
    if (FAILED(element->BuildUpdatedCache(structural_.get(), cached.put())) || !cached) unavailable();
    const auto property = [&](PROPERTYID id, VARTYPE expected, VARIANT& result) {
      current_call(); if (FAILED(cached->GetCachedPropertyValueEx(id, TRUE, &result)) || result.vt != expected) unavailable();
    };
    Variant pid, type, password, enabled, focus, keyboard, available, text_available;
    property(UIA_ProcessIdPropertyId, VT_I4, pid.value); property(UIA_ControlTypePropertyId, VT_I4, type.value);
    current_call(); if (FAILED(cached->GetCachedPropertyValueEx(UIA_IsPasswordPropertyId, TRUE, &password.value))) unavailable();
    property(UIA_IsEnabledPropertyId, VT_BOOL, enabled.value);
    property(UIA_HasKeyboardFocusPropertyId, VT_BOOL, focus.value); property(UIA_IsKeyboardFocusablePropertyId, VT_BOOL, keyboard.value);
    property(UIA_IsValuePatternAvailablePropertyId, VT_BOOL, available.value);
    property(UIA_IsTextPatternAvailablePropertyId, VT_BOOL, text_available.value);
    if (pid.value.lVal <= 0) unavailable();
    UiaSecurity result; result.pid = static_cast<DWORD>(pid.value.lVal); result.control_type = type.value.lVal; result.role = role(result.control_type);
    result.value_pattern = available.value.boolVal != VARIANT_FALSE; result.text_pattern = text_available.value.boolVal != VARIANT_FALSE;
    const auto classification = classify_uia_password(result.control_type,
        password.value.vt == VT_BOOL ? std::optional<bool>(password.value.boolVal != VARIANT_FALSE) : std::nullopt, result.value_pattern, result.text_pattern);
    if (!classification) unavailable(); result.password = *classification; result.enabled = enabled.value.boolVal != VARIANT_FALSE;
    result.focused = focus.value.boolVal != VARIANT_FALSE; result.keyboard_focusable = keyboard.value.boolVal != VARIANT_FALSE; result.value_pattern = available.value.boolVal != VARIANT_FALSE;
    if (result.value_pattern) {
      Variant read; current_call(); if (SUCCEEDED(cached->GetCachedPropertyValueEx(UIA_ValueIsReadOnlyPropertyId, TRUE, &read.value)) && read.value.vt == VT_BOOL) result.read_only = read.value.boolVal != VARIANT_FALSE;
    }
    if (!result.password && result.text_pattern) {
      winrt::com_ptr<IUIAutomationTextPattern> pattern; winrt::com_ptr<IUIAutomationTextRange> range;
      current_call(); if (SUCCEEDED(element->GetCurrentPatternAs(UIA_TextPatternId, IID_PPV_ARGS(pattern.put()))) && pattern && SUCCEEDED(pattern->get_DocumentRange(range.put())) && range) {
        Variant read; current_call(); if (SUCCEEDED(range->GetAttributeValue(UIA_IsReadOnlyAttributeId, &read.value)) && read.value.vt == VT_BOOL) result.text_read_only = read.value.boolVal != VARIANT_FALSE;
      }
    }
    RECT bounds{}; if (SUCCEEDED(cached->get_CachedBoundingRectangle(&bounds))) {
      WindowsRect rect{bounds.left, bounds.top, int64_t(bounds.right) - bounds.left, int64_t(bounds.bottom) - bounds.top}; if (rect.valid()) result.bounds = rect;
    }
    current_call(); return result;
  }
  UiaName name(const UiaElement& value) {
    BSTR name = nullptr; current_call(); if (FAILED(native(value)->get_CurrentName(&name))) unavailable();
    struct String { BSTR value; ~String() { SysFreeString(value); } } close{name};
    const auto length = SysStringLen(name); const auto count = std::min<UINT>(length, 500);
    const std::wstring raw(name ? name : L"", count); const auto safe = sanitize_uia(raw);
    current_call(); return UiaName{safe, length <= 500 && safe == raw};
  }
  UiaElement root(const WindowsWindow& window) {
    const auto actual = observe_windows_availability(WindowsAvailabilityBackend::system());
    require_windows_surface(actual, &window.owner.process.token);
    require_windows_surface(actual, &window.physical_owner.process.token);
    DWORD pid = 0;
    if (!eligible_windows_window(window) || GetWindowThreadProcessId(window.surface, &pid) != window.surface_thread_id || pid != window.owner.process.pid ||
        GetAncestor(window.surface, GA_ROOT) != window.hwnd || !windows_owner_current(window.owner) || !windows_owner_current(window.physical_owner)) unavailable();
    winrt::com_ptr<IUIAutomationElement> root;
    current_call(); if (FAILED(automation_->ElementFromHandleBuildCache(window.surface, structural_.get(), root.put()))) unavailable();
    UIA_HWND handle = nullptr;
    if (!root || FAILED(root->get_CurrentNativeWindowHandle(&handle)) || reinterpret_cast<HWND>(handle) != window.surface) unavailable();
    auto value = wrap(std::move(root)); if (security(value).pid != window.owner.process.pid || GetWindowThreadProcessId(window.surface, &pid) != window.surface_thread_id || pid != window.owner.process.pid) unavailable(); return value;
  }
  UiaElement parent(const UiaElement& element) {
    winrt::com_ptr<IUIAutomationElement> parent;
    current_call(); if (FAILED(walker_->GetParentElementBuildCache(native(element), structural_.get(), parent.put()))) unavailable(); return wrap(std::move(parent));
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
    if (limit > 400) unavailable(); UiaChildren result;
    winrt::com_ptr<IUIAutomationElement> next;
    current_call(); if (FAILED(walker_->GetFirstChildElementBuildCache(native(value), structural_.get(), next.put()))) unavailable();
    while (next) {
      if (result.elements.size() >= limit) { result.truncated = true; break; }
      const auto element = wrap(next); result.elements.push_back(element);
      winrt::com_ptr<IUIAutomationElement> sibling; current_call();
      if (FAILED(walker_->GetNextSiblingElementBuildCache(next.get(), structural_.get(), sibling.put()))) { result.truncated = true; break; }
      if (sibling && std::any_of(result.elements.begin(), result.elements.end(), [&](const auto& candidate) { return equal(candidate, wrap(sibling)); })) { result.truncated = true; break; }
      next = std::move(sibling);
    }
    return result;
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
  UiaElement hit(const UiaElement& root, POINT point) {
    struct Node { UiaElement element; size_t depth; };
    std::deque<Node> queue{{root, 0}}; std::vector<uint64_t> visited; UiaElement result; size_t selected_depth = 0; bool ambiguous = false;
    const auto pid = security(root).pid;
    while (!queue.empty() && visited.size() < 400) {
      current_call(); const auto node = queue.front(); queue.pop_front();
      if (std::find(visited.begin(), visited.end(), node.element->identity) != visited.end()) unavailable(); visited.push_back(node.element->identity);
      const auto state = security(node.element); if (state.pid != pid) unavailable();
      if (!state.bounds || !state.bounds->contains(point)) continue;
      if (!result || node.depth > selected_depth) { result = node.element; selected_depth = node.depth; ambiguous = false; }
      else if (node.depth == selected_depth && !equal(result, node.element)) ambiguous = true;
      if (node.depth >= 30) unavailable();
      const auto descendants = children(node.element, 400 - visited.size() - std::min<size_t>(queue.size(), 400 - visited.size()));
      if (descendants.truncated) unavailable();
      for (const auto& child : descendants.elements) queue.push_back(Node{child, node.depth + 1});
    }
    if (!queue.empty() || ambiguous || !result) unavailable(); return result;
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
    if (action == L"AXRaise" || action == L"SetFocus") { const auto target = native(element); before_mutation(window); return mutation_result(target->SetFocus()); }
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
              const std::optional<std::wstring>& text, const std::shared_ptr<std::atomic_bool>& attempted) {
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
    current_call(); attempted->store(true); mutation_ = &expected; mutation_name_ = expected_name.text;
    struct Reset { const UiaObservation*& target; std::wstring& name; ~Reset() { target = nullptr; name.clear(); } } reset{mutation_, mutation_name_};
    return text ? set_value(expected.element, *text, &expected.window) : perform(expected.element, action, &expected.window);
  }
};

WindowsUiaBackend WindowsUiaBackend::system() {
  const auto native = NativeUia::make(); WindowsUiaBackend backend;
  backend.root = [native](const auto& window) { if (!windows_window_current(window)) unavailable(); return native->call([native, window] { return native->root(window); }); };
  backend.security = [native](const auto& element) { return native->call([native, element] { return native->security(element); }); };
  backend.name = [native](const auto& element) { return native->call([native, element] { return native->name(element); }); };
  backend.value = [native](const auto& element) { return native->call([native, element] { return native->value(element); }); };
  backend.children = [native](const auto& element, size_t limit) { return native->call([native, element, limit] { return native->children(element, limit); }); };
  backend.parent = [native](const auto& element) { return native->call([native, element] { return native->parent(element); }); };
  backend.focused = [native](const auto& root) { return native->call([native, root] { return native->focused(root); }); };
  backend.hit = [native](const auto& root, POINT point) { return native->call([native, root, point] { return native->hit(root, point); }); };
  backend.equal = [native](const auto& left, const auto& right) { return native->call([native, left, right] { return native->equal(left, right); }); };
  backend.belongs = [native](const auto& element, const auto& window) { return native->call([native, element, window] { return native->belongs(element, window); }); };
  backend.perform = [native](const auto& element, auto action) { return native->call([native, element, action = std::wstring(action)] { return native->perform(element, action); }); };
  backend.set_value = [native](const auto& element, const auto& text) { return native->call([native, element, text] { return native->set_value(element, text); }); };
  backend.close = [native] { native->close(); };
  backend.menu_shortcuts = [native](const auto& root) { try { return native->call([native, root] { return native->menus(root); }); } catch (...) { return std::optional<std::vector<UiaMenuShortcut>>{}; } };
  backend.available = [native] { return native->available(); };
  backend.commit = [native](const auto& observed, const auto& name, std::wstring_view action, const std::optional<std::wstring>& text) {
    const auto attempted = std::make_shared<std::atomic_bool>(false);
    try { return native->call([native, observed, name, action = std::wstring(action), text, attempted] { return native->commit(observed, name, action, text, attempted); }); }
    catch (...) { if (attempted->load()) throw Failure{L"changed", L"The native accessibility action could not be confirmed."}; throw; }
  };
  backend.menu_target = [native](const auto& element, const auto& root) -> std::optional<UiaMenuShortcut> {
    try { return native->call([native, element, root] { return native->menu_target(element, root); }); } catch (...) { return {}; }
  };
  return backend;
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
      left.security.text_pattern == right.security.text_pattern && left.security.text_read_only == right.security.text_read_only &&
      backend_.equal(left.root, right.root) && backend_.equal(left.element, right.element);
}
bool WindowsUiaObserver::fresh(const UiaObservation& value, uint64_t maximum_age) const noexcept {
  try { const auto now = now_(); return (!backend_.available || backend_.available()) && value.element && value.root && value.observed_at_ms <= now && now - value.observed_at_ms <= std::min<uint64_t>(maximum_age, 50); }
  catch (...) { return false; }
}
void WindowsUiaObserver::close() { if (backend_.close) backend_.close(); }
}
