#include "user_input.h"
#include <shellscalingapi.h>
#include <ntddkbd.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstddef>
#include <limits>
#include <iterator>
#include <mutex>
#include <new>
#include <stdexcept>

namespace vector::computer {
UserInputOrigin classify_user_input_origin(const INPUT_MESSAGE_SOURCE&,bool known,DWORD raw_type) noexcept;
namespace {
uint64_t monotonic() noexcept {
  return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
    std::chrono::steady_clock::now().time_since_epoch()).count());
}
std::atomic<uint64_t> next_generation{1};
struct NativeListener;
std::mutex registration_mutex;
std::weak_ptr<NativeListener> registration_owner;
std::atomic<bool> registration_poisoned{false};
uint64_t generation() noexcept {
  auto value=next_generation.load();
  while (value!=std::numeric_limits<uint64_t>::max()) {
    if (next_generation.compare_exchange_weak(value,value+1)) return value;
  }
  return 0;
}
struct RawRoutes {
  HWND mouse=nullptr,keyboard=nullptr;
  DWORD mouse_flags=0,keyboard_flags=0;
  bool have_mouse=false,have_keyboard=false;
};
std::optional<RawRoutes> routes() noexcept {
  std::array<RAWINPUTDEVICE,128> devices{}; UINT capacity=static_cast<UINT>(devices.size());
  const auto count=GetRegisteredRawInputDevices(devices.data(),&capacity,static_cast<UINT>(sizeof(RAWINPUTDEVICE)));
  if (count==static_cast<UINT>(-1) || count>devices.size() || capacity>devices.size()) return {};
  RawRoutes result;
  for (UINT i=0;i<count;++i) {
    if (devices[i].usUsagePage!=0x01) continue;
    if (devices[i].usUsage==0x02) { if (result.have_mouse) return {}; result.mouse=devices[i].hwndTarget; result.mouse_flags=devices[i].dwFlags; result.have_mouse=true; }
    if (devices[i].usUsage==0x06) { if (result.have_keyboard) return {}; result.keyboard=devices[i].hwndTarget; result.keyboard_flags=devices[i].dwFlags; result.have_keyboard=true; }
  }
  return result;
}

UserInputEnvironment observe_environment() noexcept {
  UserInputEnvironment result{WindowsSurfaceState::unavailable,monotonic()};
  try {
    const auto observation=observe_windows_availability(WindowsAvailabilityBackend::system());
    result.state=windows_surface_state(observation);
    if (result.state!=WindowsSurfaceState::ready) return result;
    const auto foreground=GetForegroundWindow(); DWORD pid=0;
    const auto thread=foreground?GetWindowThreadProcessId(foreground,&pid):0;
    if (!thread || !pid) { result.state=WindowsSurfaceState::unavailable; return result; }
    winrt::handle process{OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,FALSE,pid)};
    if (!process || WaitForSingleObject(process.get(),0)!=WAIT_TIMEOUT) { result.state=WindowsSurfaceState::unavailable; return result; }
    const auto target=observe_token(process.get());
    DWORD actual_pid=0;
    if (GetForegroundWindow()!=foreground || GetWindowThreadProcessId(foreground,&actual_pid)!=thread || actual_pid!=pid ||
        WaitForSingleObject(process.get(),0)!=WAIT_TIMEOUT) { result.state=WindowsSurfaceState::unavailable; return result; }
    result.state=windows_surface_state(observation,&target);
    // Repeat desktop facts after the target query. No UIA, trust/hash, window title or content read.
    if (result.state==WindowsSurfaceState::ready && !windows_desktop_available(observe_windows_desktop()))
      result.state=WindowsSurfaceState::secure_desktop;
    const auto now=monotonic();
    if (now<result.observed_at_ms || now-result.observed_at_ms>100) result.state=WindowsSurfaceState::unavailable;
  } catch (...) { result.state=WindowsSurfaceState::unavailable; }
  return result;
}

std::optional<UserInputCursor> cursor() noexcept {
  // W3 records physical pixels and this same effective-monitor DPI. Raw HID counts are never DIP.
  if (!AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(),DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) return {};
  POINT point{}; if (!GetCursorPos(&point)) return {};
  const auto monitor=MonitorFromPoint(point,MONITOR_DEFAULTTONULL); if (!monitor) return {};
  MONITORINFO info{}; info.cbSize=static_cast<DWORD>(sizeof(info)); UINT x=0,y=0;
  if (!GetMonitorInfoW(monitor,&info) || !PtInRect(&info.rcMonitor,point) ||
      FAILED(GetDpiForMonitor(monitor,MDT_EFFECTIVE_DPI,&x,&y)) || x<24 || x!=y || x>1536) return {};
  return UserInputCursor{point.x,point.y,reinterpret_cast<uintptr_t>(monitor),static_cast<double>(x)/96};
}

UserInputOrigin origin(const INPUT_MESSAGE_SOURCE& source,bool known,DWORD raw_type) noexcept {
  if (!known || (raw_type!=RIM_TYPEKEYBOARD && raw_type!=RIM_TYPEMOUSE)) return UserInputOrigin::unknown;
  const bool device=raw_type==RIM_TYPEKEYBOARD?source.deviceType==IMDT_KEYBOARD:
    source.deviceType==IMDT_MOUSE || source.deviceType==IMDT_TOUCHPAD || source.deviceType==IMDT_TOUCH || source.deviceType==IMDT_PEN;
  if (!device) return UserInputOrigin::unknown;
  // Microsoft INPUT_MESSAGE_ORIGIN_ID: IMO_HARDWARE also includes UIAccess injection. Never infer
  // hardware from hDevice: RAWINPUTHEADER explicitly permits NULL for precision-touchpad input.
  // https://github.com/MicrosoftDocs/sdk-api/blob/656e9656bfaef34dd29cd7ee9e1146aec17e924c/sdk-api-src/content/winuser/ne-winuser-input_message_origin_id.md
  if (source.originId==IMO_HARDWARE) return UserInputOrigin::hardware;
  if (source.originId==IMO_INJECTED) return UserInputOrigin::injected;
  return UserInputOrigin::unknown;
}

std::optional<UserInputModifier> modifier(const RAWKEYBOARD& key) noexcept {
  WORD vk=key.VKey;
  if (vk==VK_SHIFT) {
    if (key.Flags&(RI_KEY_E0|RI_KEY_E1)) return {};
    const auto mapped=MapVirtualKeyW(key.MakeCode,MAPVK_VSC_TO_VK_EX);
    if (mapped!=VK_LSHIFT && mapped!=VK_RSHIFT) return {};
    vk=static_cast<WORD>(mapped);
  }
  if (vk==VK_CONTROL || vk==VK_MENU) {
    if (key.Flags&RI_KEY_E1) return {};
    vk=static_cast<WORD>(vk==VK_CONTROL?(key.Flags&RI_KEY_E0?VK_RCONTROL:VK_LCONTROL):(key.Flags&RI_KEY_E0?VK_RMENU:VK_LMENU));
  }
  switch (vk) {
    case VK_LCONTROL:return UserInputModifier::control_left;
    case VK_RCONTROL:return UserInputModifier::control_right;
    case VK_LMENU:return UserInputModifier::alt_left;
    case VK_RMENU:return UserInputModifier::alt_right;
    case VK_LSHIFT:return UserInputModifier::shift_left;
    case VK_RSHIFT:return UserInputModifier::shift_right;
    case VK_LWIN:return UserInputModifier::meta_left;
    case VK_RWIN:return UserInputModifier::meta_right;
    default:return UserInputModifier::none;
  }
}

struct NativeListener final : std::enable_shared_from_this<NativeListener> {
  struct Attachment { std::shared_ptr<NativeListener> state; };
  std::mutex lifecycle_mutex,health_mutex;
  winrt::handle stop_event,ready_event,health_event,thread;
  std::atomic<HANDLE> stop_signal{nullptr},thread_witness{nullptr};
  std::function<void(UserInputSample)> receive;
  std::function<void(UserInputHealthReceipt)> receive_health;
  std::array<UserInputHealthChallenge,8> challenges{}; size_t challenge_count=0;
  uint64_t last_health_sequence=0;
  std::atomic<bool> attempted{false},closed{false},installed{false},registered{false},alive{false};
  std::atomic<uint64_t> listener_generation{0},context_generation{0};
  std::atomic<UserInputFailure> first_failure{UserInputFailure::none};

  void record_failure(UserInputFailure reason)noexcept {auto expected=UserInputFailure::none;(void)first_failure.compare_exchange_strong(expected,reason);}
  [[noreturn]] void reject(UserInputFailure reason) {record_failure(reason);throw reason;}

  UserInputListenerStatus status()const noexcept {
    UserInputListenerStatus value;
    const auto first=listener_generation.load(),context=context_generation.load();
    value={installed.load(),registered.load(),alive.load()&&!closed.load(),first,context,first_failure.load()};
    if (!context || listener_generation.load()!=first || context_generation.load()!=context) value.alive=false;
    return value;
  }
  uint64_t invalidate_context() noexcept {
    auto observed=context_generation.load();
    while (observed && observed!=std::numeric_limits<uint64_t>::max()) {
      if (context_generation.compare_exchange_weak(observed,observed+1)) return observed+1;
    }
    fail(); return 0;
  }
  UserInputEnvironment environment() noexcept {
    if (closed.load() || !alive.load()) return {WindowsSurfaceState::unavailable,monotonic(),context_generation.load()};
    auto value=observe_environment();
    if (value.state!=WindowsSurfaceState::ready) (void)invalidate_context();
    value.context_generation=context_generation.load();
    return value;
  }
  void sample(UserInputSample value) noexcept {
    if (closed.load()) return;
    const auto current_context=context_generation.load();
    // Invalidation metadata cannot calibrate. Hardware/injected packets retain their observed
    // lineage; a concurrent context change must never relabel old input into a new setup scope.
    if (value.kind==UserInputKind::configuration || value.origin==UserInputOrigin::unknown) value.context_generation=current_context;
    else if (!value.context_generation || value.context_generation!=current_context) { configuration(); return; }
    try { if (receive) receive(std::move(value)); }
    catch (...) { fail(); }
  }
  void configuration() noexcept {
    (void)invalidate_context();
    UserInputSample value; value.listener_generation=listener_generation.load(); value.observed_at_ms=monotonic();
    sample(std::move(value));
  }
  void fail(UserInputFailure reason=UserInputFailure::native_failed) noexcept {
    record_failure(reason);
    alive.store(false); registration_poisoned.store(true);
    if (stop_event) SetEvent(stop_event.get());
  }
  void raw(WPARAM wparam,LPARAM lparam) noexcept {
    const auto context=context_generation.load(); const auto observed=monotonic();
    INPUT_MESSAGE_SOURCE source{};
    // Capture provenance in this exact WM_INPUT context, before any deferred work. Microsoft does
    // not promise that every WM_INPUT context supplies it; unavailable/system stays unknown.
    const bool known=GetCurrentInputMessageSource(&source)!=FALSE;
    if (wparam!=RIM_INPUT && wparam!=RIM_INPUTSINK) { configuration(); return; }
    RAWINPUT packet{}; UINT capacity=static_cast<UINT>(sizeof(packet));
    const auto size=GetRawInputData(reinterpret_cast<HRAWINPUT>(lparam),RID_INPUT,&packet,&capacity,static_cast<UINT>(sizeof(RAWINPUTHEADER)));
    if (size==static_cast<UINT>(-1) || size<sizeof(RAWINPUTHEADER) || size>sizeof(packet)) { configuration(); return; }
    const auto& raw=packet;
    if (raw.header.dwSize!=size || raw.header.wParam!=wparam ||
        (raw.header.dwType!=RIM_TYPEMOUSE && raw.header.dwType!=RIM_TYPEKEYBOARD)) { configuration(); return; }
    UserInputSample value; value.listener_generation=listener_generation.load(); value.observed_at_ms=observed; value.context_generation=context;
    value.origin=classify_user_input_origin(source,known,raw.header.dwType);
    if (raw.header.dwType==RIM_TYPEKEYBOARD) {
      if (size<offsetof(RAWINPUT,data)+sizeof(RAWKEYBOARD)) { configuration(); return; }
      const auto& key=raw.data.keyboard;
      const bool up=(key.Flags&RI_KEY_BREAK)!=0;
      if (key.Reserved || key.MakeCode==KEYBOARD_OVERRUN_MAKE_CODE || key.VKey==0 || key.VKey>=255 ||
          (key.Flags&~(RI_KEY_BREAK|RI_KEY_E0|RI_KEY_E1)) ||
          (up?(key.Message!=WM_KEYUP && key.Message!=WM_SYSKEYUP):(key.Message!=WM_KEYDOWN && key.Message!=WM_SYSKEYDOWN))) {
        configuration(); return;
      }
      const auto actual_modifier=modifier(key); if (!actual_modifier) { configuration(); return; }
      value.kind=up?UserInputKind::key_up:UserInputKind::key_down; value.virtual_key=key.VKey; value.modifier=*actual_modifier;
      value.extra_information=key.ExtraInformation;
    } else {
      if (size<offsetof(RAWINPUT,data)+sizeof(RAWMOUSE)) { configuration(); return; }
      const auto& mouse=raw.data.mouse;
      constexpr USHORT state_flags=MOUSE_MOVE_ABSOLUTE|MOUSE_VIRTUAL_DESKTOP|MOUSE_ATTRIBUTES_CHANGED|MOUSE_MOVE_NOCOALESCE;
      constexpr USHORT buttons=RI_MOUSE_LEFT_BUTTON_DOWN|RI_MOUSE_LEFT_BUTTON_UP|RI_MOUSE_RIGHT_BUTTON_DOWN|RI_MOUSE_RIGHT_BUTTON_UP|
        RI_MOUSE_MIDDLE_BUTTON_DOWN|RI_MOUSE_MIDDLE_BUTTON_UP|RI_MOUSE_BUTTON_4_DOWN|RI_MOUSE_BUTTON_4_UP|RI_MOUSE_BUTTON_5_DOWN|RI_MOUSE_BUTTON_5_UP;
      constexpr USHORT wheels=RI_MOUSE_WHEEL|RI_MOUSE_HWHEEL;
      if ((mouse.usFlags&~state_flags) || (mouse.usButtonFlags&~(buttons|wheels)) ||
          ((mouse.usFlags&MOUSE_VIRTUAL_DESKTOP) && !(mouse.usFlags&MOUSE_MOVE_ABSOLUTE))) { configuration(); return; }
      if (mouse.usFlags&MOUSE_ATTRIBUTES_CHANGED) { configuration(); return; }
      value.kind=mouse.usButtonFlags&buttons?UserInputKind::click:mouse.usButtonFlags&wheels?UserInputKind::scroll:UserInputKind::pointer;
      value.motion_only=mouse.usButtonFlags==0;
      value.extra_information=mouse.ulExtraInformation; value.cursor=cursor();
    }
    // ExtraInformation is ULONG32, not MOUSEINPUT.dwExtraInfo's ULONG_PTR64. It is never widened
    // into invented full-marker evidence. No names, values, Unicode translation or persistence.
    if (value.origin==UserInputOrigin::unknown) (void)invalidate_context();
    sample(std::move(value));
  }
  static LRESULT CALLBACK window_proc(HWND hwnd,UINT message,WPARAM wparam,LPARAM lparam) noexcept {
    auto attachment=reinterpret_cast<Attachment*>(GetWindowLongPtrW(hwnd,GWLP_USERDATA));
    if (message==WM_NCCREATE) {
      const auto create=reinterpret_cast<const CREATESTRUCTW*>(lparam);
      attachment=create?static_cast<Attachment*>(create->lpCreateParams):nullptr;
      if (!attachment || !attachment->state) return FALSE;
      SetLastError(ERROR_SUCCESS);
      if (!SetWindowLongPtrW(hwnd,GWLP_USERDATA,reinterpret_cast<LONG_PTR>(attachment)) && GetLastError()!=ERROR_SUCCESS) return FALSE;
    }
    if (attachment && attachment->state) {
      const auto state=attachment->state;
      if (message==WM_INPUT) state->raw(wparam,lparam);
      if (message==WM_INPUT_DEVICE_CHANGE) state->configuration();
    }
    if (message==WM_NCDESTROY) SetWindowLongPtrW(hwnd,GWLP_USERDATA,0);
    // In particular RIM_INPUT must reach DefWindowProc for the system's Raw Input cleanup.
    return DefWindowProcW(hwnd,message,wparam,lparam);
  }
  bool challenge_current(const UserInputHealthChallenge& value,uint64_t now)const noexcept {
    return value.listener_generation && value.context_generation && value.scope_ticket && value.sequence &&
      value.listener_generation==listener_generation.load() && value.context_generation==context_generation.load() &&
      value.deadline_ms>value.sent_at_ms && value.deadline_ms-value.sent_at_ms==500 &&
      now>=value.sent_at_ms && now<value.deadline_ms;
  }
  bool pump_messages() noexcept {
    MSG message{};
    for (size_t read=0;read<64 && !closed.load() && PeekMessageW(&message,nullptr,0,0,PM_REMOVE);++read) {
      if (message.message==WM_QUIT) { fail(UserInputFailure::native_quit); return false; }
      DispatchMessageW(&message);
    }
    if (closed.load()) return false;
    // A backlog is not a health acknowledgement; the original challenge deadline keeps running.
    return !PeekMessageW(&message,nullptr,0,0,PM_NOREMOVE);
  }
  void process_health(HWND hwnd) noexcept {
    const auto held=thread_witness.load();
    if (!held || GetThreadId(held)!=GetCurrentThreadId()) { fail(); return; }
    std::array<UserInputHealthChallenge,8> queued{}; size_t count=0;
    { std::lock_guard lock(health_mutex); count=challenge_count; std::copy_n(challenges.begin(),count,queued.begin()); challenge_count=0; ResetEvent(health_event.get()); }
    for (size_t i=0;i<count && !closed.load() && alive.load();++i) {
      const auto& challenge=queued[i];
      if (!challenge_current(challenge,monotonic())) continue;
      if (!own_routes(hwnd)) { record_failure(UserInputFailure::native_route_lost);configuration(); registered.store(false); fail(UserInputFailure::native_route_lost); return; }
      const auto observed_environment=environment();
      if (closed.load()) continue;
      if (!own_routes(hwnd)) { record_failure(UserInputFailure::native_route_lost);configuration(); registered.store(false); fail(UserInputFailure::native_route_lost); return; }
      // Charge every route/environment query to the original absolute challenge deadline.
      const auto observed=monotonic(); const auto listener=status();
      if (closed.load() || observed<challenge.sent_at_ms || observed>=challenge.deadline_ms) continue;
      const bool healthy=listener.installed && listener.registered && listener.alive &&
        listener.generation==challenge.listener_generation && listener.context_generation==challenge.context_generation &&
        observed_environment.state==WindowsSurfaceState::ready && observed_environment.context_generation==challenge.context_generation &&
        observed_environment.observed_at_ms>=challenge.sent_at_ms && observed_environment.observed_at_ms<=observed &&
        observed-observed_environment.observed_at_ms<500 && challenge_current(challenge,observed);
      // This typed acknowledgement proves only bounded listener/route/context work. It never
      // synthesizes Raw Input or establishes the separate hardware-calibration evidence.
      try { if (receive_health) receive_health({challenge,observed_environment,observed,healthy}); else fail(); }
      catch (...) { fail(); }
    }
  }
  bool own_routes(HWND hwnd) noexcept {
    const auto actual=routes();
    constexpr DWORD expected=RIDEV_INPUTSINK|RIDEV_DEVNOTIFY;
    return actual && actual->have_mouse && actual->have_keyboard && actual->mouse==hwnd && actual->keyboard==hwnd &&
      actual->mouse_flags==expected && actual->keyboard_flags==expected;
  }
  void retire_routes(HWND hwnd) noexcept {
    const auto actual=routes();
    if (!actual) { registration_poisoned.store(true); return; }
    std::array<RAWINPUTDEVICE,2> remove{}; UINT count=0;
    if (actual->have_mouse && actual->mouse==hwnd) remove[count++]={0x01,0x02,RIDEV_REMOVE,nullptr};
    if (actual->have_keyboard && actual->keyboard==hwnd) remove[count++]={0x01,0x06,RIDEV_REMOVE,nullptr};
    // Registration is process-wide. Never remove a route now targeting another exact HWND.
    if (count && !RegisterRawInputDevices(remove.data(),count,static_cast<UINT>(sizeof(RAWINPUTDEVICE)))) {
      registration_poisoned.store(true); return;
    }
    registered.store(false);
  }
  void run() noexcept {
    HWND hwnd=nullptr; bool did_register=false;
    Attachment attachment;
    try {
      if (closed.load()) reject(UserInputFailure::native_status);
      const auto module=GetModuleHandleW(nullptr); constexpr wchar_t class_name[]=L"VectorComputerRawInput";
      WNDCLASSEXW klass{}; klass.cbSize=static_cast<UINT>(sizeof(klass)); klass.lpfnWndProc=window_proc; klass.hInstance=module; klass.lpszClassName=class_name;
      if (!RegisterClassExW(&klass)) {
        WNDCLASSEXW existing{}; existing.cbSize=static_cast<UINT>(sizeof(existing));
        if (GetLastError()!=ERROR_CLASS_ALREADY_EXISTS || !GetClassInfoExW(module,class_name,&existing) || existing.lpfnWndProc!=window_proc || existing.hInstance!=module)
          reject(UserInputFailure::native_class);
      }
      // The thread and this attachment retain shared state through DestroyWindow. No HWND callback
      // owns a dangling this pointer, including a timed-out/quarantined startup or close.
      attachment.state=shared_from_this();
      hwnd=CreateWindowExW(0,class_name,L"",0,0,0,0,0,HWND_MESSAGE,nullptr,module,&attachment);
      if (!hwnd || closed.load()) reject(UserInputFailure::native_window);
      installed.store(true);
      const RAWINPUTDEVICE devices[]={{0x01,0x02,RIDEV_INPUTSINK|RIDEV_DEVNOTIFY,hwnd},{0x01,0x06,RIDEV_INPUTSINK|RIDEV_DEVNOTIFY,hwnd}};
      const auto actual=routes();
      if (!actual) reject(UserInputFailure::native_routes_query);
      if (actual->have_mouse || actual->have_keyboard) reject(UserInputFailure::native_routes_existing);
      did_register=RegisterRawInputDevices(devices,static_cast<UINT>(std::size(devices)),static_cast<UINT>(sizeof(RAWINPUTDEVICE)))!=FALSE;
      if (did_register) registered.store(true);
      if (!did_register) reject(UserInputFailure::native_register);
      if (closed.load() || !own_routes(hwnd)) reject(UserInputFailure::native_readback);
      alive.store(true); SetEvent(ready_event.get());
      const HANDLE waits[]={stop_event.get(),health_event.get()};
      while (!closed.load()) {
        const auto result=MsgWaitForMultipleObjectsEx(static_cast<DWORD>(std::size(waits)),waits,50,QS_ALLINPUT,MWMO_INPUTAVAILABLE);
        if (result==WAIT_OBJECT_0) break;
        if (result==WAIT_FAILED || result==WAIT_ABANDONED_0 || result==WAIT_ABANDONED_0+1) reject(UserInputFailure::native_wait);
        const bool pumped=pump_messages();
        if (WaitForSingleObject(stop_event.get(),0)==WAIT_OBJECT_0) break;
        if (!closed.load() && !own_routes(hwnd)) { record_failure(UserInputFailure::native_route_lost);configuration(); registered.store(false); fail(UserInputFailure::native_route_lost); break; }
        if (pumped && WaitForSingleObject(health_event.get(),0)==WAIT_OBJECT_0) process_health(hwnd);
        if (WaitForSingleObject(stop_event.get(),0)==WAIT_OBJECT_0) break;
      }
      alive.store(false);
      if (did_register) { retire_routes(hwnd); did_register=false; }
      if (hwnd) { SetWindowLongPtrW(hwnd,GWLP_USERDATA,0); DestroyWindow(hwnd); hwnd=nullptr; installed.store(false); }
    } catch (...) {
      record_failure(UserInputFailure::native_failed);
      alive.store(false); registration_poisoned.store(true);
      if (did_register) retire_routes(hwnd);
      if (hwnd) { SetWindowLongPtrW(hwnd,GWLP_USERDATA,0); DestroyWindow(hwnd); installed.store(false); }
    }
    { std::lock_guard lock(registration_mutex); if (const auto owner=registration_owner.lock();owner.get()==this) registration_owner.reset(); }
    alive.store(false); SetEvent(ready_event.get());
  }
  static DWORD WINAPI thread_proc(void* raw) noexcept {
    std::unique_ptr<std::shared_ptr<NativeListener>> context(static_cast<std::shared_ptr<NativeListener>*>(raw));
    const auto state=*context; context.reset(); state->run(); return 0;
  }
  bool start(std::function<void(UserInputSample)> callback,std::function<void(UserInputHealthReceipt)> health_callback) noexcept {
    if (!callback || !health_callback || closed.load() || attempted.exchange(true)) {record_failure(UserInputFailure::native_status);return false;}
    try {
      { std::lock_guard lock(registration_mutex); if (registration_poisoned.load() || registration_owner.lock()) { record_failure(UserInputFailure::native_owner);closed.store(true); return false; } registration_owner=shared_from_this(); }
      { std::lock_guard lock(lifecycle_mutex);
        if (closed.load()) {record_failure(UserInputFailure::native_status);return false;}
        const auto issued=generation(); if (!issued) {record_failure(UserInputFailure::native_generation);return false;} listener_generation.store(issued); context_generation.store(1); receive=std::move(callback); receive_health=std::move(health_callback);
        stop_event.attach(CreateEventW(nullptr,TRUE,FALSE,nullptr)); ready_event.attach(CreateEventW(nullptr,TRUE,FALSE,nullptr)); health_event.attach(CreateEventW(nullptr,TRUE,FALSE,nullptr));
        if (!stop_event || !ready_event || !health_event) { record_failure(UserInputFailure::native_events);closed.store(true); registration_poisoned.store(true); return false; }
        stop_signal.store(stop_event.get());
        auto context=std::make_unique<std::shared_ptr<NativeListener>>(shared_from_this());
        const auto launched=CreateThread(nullptr,0,thread_proc,context.get(),0,nullptr);
        if (!launched) { record_failure(UserInputFailure::native_thread);closed.store(true); registration_poisoned.store(true); return false; }
        thread.attach(launched); thread_witness.store(launched); (void)context.release();
      }
      const auto ready=WaitForSingleObject(ready_event.get(),200);
      if (ready!=WAIT_OBJECT_0 || !status().alive) { record_failure(ready==WAIT_TIMEOUT?UserInputFailure::native_ready_timeout:UserInputFailure::native_status);registration_poisoned.store(true); close(); return false; }
      return true;
    } catch (...) { record_failure(UserInputFailure::native_failed);registration_poisoned.store(true); close(); return false; }
  }
  bool health(const UserInputHealthChallenge& challenge) noexcept {
    if (closed.load() || !status().alive || !challenge_current(challenge,monotonic())) return false;
    std::lock_guard lock(health_mutex);
    if (closed.load() || !status().alive || !health_event || challenge_count>=challenges.size() ||
        challenge.sequence<=last_health_sequence || !challenge_current(challenge,monotonic())) return false;
    challenges[challenge_count++]=challenge; last_health_sequence=challenge.sequence;
    if (!SetEvent(health_event.get())) { fail(); return false; }
    return true;
  }
  void close() noexcept {
    closed.store(true); alive.store(false);
    // Published handles are immutable and retained by this shared state, including quarantined
    // threads. Close never waits for a startup/lifecycle mutex before signaling cancellation.
    if (const auto signal=stop_signal.load()) SetEvent(signal);
    const auto held=thread_witness.load();
    // Never terminate a thread or replace a quarantined listener. Its retained state/handles remain
    // valid until its own cleanup finishes; the helper's independent parent/EOF fuse remains primary.
    if (held && GetThreadId(held)!=GetCurrentThreadId() && WaitForSingleObject(held,200)!=WAIT_OBJECT_0) registration_poisoned.store(true);
  }
};
}

UserInputOrigin classify_user_input_origin(const INPUT_MESSAGE_SOURCE& source,bool known,DWORD raw_type) noexcept {
  return origin(source,known,raw_type);
}

UserInputBackend UserInputBackend::system() {
  const auto state=std::make_shared<NativeListener>();
  UserInputBackend backend;
  backend.start=[state](auto receive,auto health_receive){return state->start(std::move(receive),std::move(health_receive));};
  backend.status=[state]{return state->status();};
  backend.environment=[state]{return state->environment();};
  backend.health=[state](const UserInputHealthChallenge& challenge){return state->health(challenge);};
  backend.close=[state]{state->close();};
  return backend;
}
}
