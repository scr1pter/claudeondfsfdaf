#include "input.h"
#include "input_guardian.h"
#include "windows_process_tree.h"
#include "availability.h"
#include <imm.h>
#include <algorithm>
#include <array>
#include <map>
#include <mutex>
#include <set>
#include <winrt/Windows.Data.Text.h>

namespace vector::computer {
namespace {
[[noreturn]] void changed() { throw Failure{L"changed", L"The native keyboard or input target changed."}; }
[[noreturn]] void unsupported() { throw Failure{L"unsupported_action", L"The current native input cannot be represented safely."}; }
constexpr uint32_t control = input_modifier(InputModifier::control), alt = input_modifier(InputModifier::alt),
  shift = input_modifier(InputModifier::shift), meta = input_modifier(InputModifier::meta), alt_graph = input_modifier(InputModifier::alt_graph);
std::wstring lower(std::wstring value) { for (auto& c : value) if (c >= L'A' && c <= L'Z') c = static_cast<wchar_t>(c + 32); return value; }
bool safe_unicode(std::wstring_view value) {
  try {
    using winrt::Windows::Data::Text::UnicodeCharacters;
    using Category = winrt::Windows::Data::Text::UnicodeGeneralCategory;
    for (size_t index = 0; index < value.size(); ++index) {
      uint32_t scalar = static_cast<uint16_t>(value[index]);
      if (scalar >= 0xd800 && scalar <= 0xdbff) {
        if (++index >= value.size() || value[index] < 0xdc00 || value[index] > 0xdfff) return false;
        scalar = 0x10000 + ((scalar - 0xd800) << 10) + (static_cast<uint16_t>(value[index]) - 0xdc00);
      } else if (scalar >= 0xdc00 && scalar <= 0xdfff) return false;
      const auto category = UnicodeCharacters::GetGeneralCategory(scalar);
      if (category == Category::Control || category == Category::Format || category == Category::Surrogate ||
          category == Category::PrivateUse || category == Category::NotAssigned || category == Category::LineSeparator || category == Category::ParagraphSeparator) return false;
    }
    return true;
  } catch (...) { return false; }
}
std::optional<std::wstring> normalize_menu(std::wstring_view value) {
  if (!safe_unicode(value) || value.empty() || value.size() > 256) return {};
  const auto length = NormalizeString(NormalizationKC, value.data(), static_cast<int>(value.size()), nullptr, 0);
  if (length <= 0 || length > 4096) return {};
  std::wstring result(static_cast<size_t>(length), L'\0');
  const auto written = NormalizeString(NormalizationKC, value.data(), static_cast<int>(value.size()), result.data(), length);
  if (written <= 0 || written > length) return {}; result.resize(static_cast<size_t>(written));
  return safe_unicode(result) ? std::optional{result} : std::nullopt;
}
bool desktop_available() {
  require_windows_surface(observe_windows_availability(WindowsAvailabilityBackend::system()));
  return true;
}

// Physical positions are the documented Windows scan-code column of Chromium's USB/PS2 table,
// itself sourced from Microsoft's Keyboard Scan Code Specification. They are not US semantic letters.
// https://github.com/chromium/chromium/blob/0676a288c03d068a583baca01fdf8c11fc55aefb/ui/events/keycodes/dom/dom_code_data.inc
const std::map<std::wstring, WORD>& physical_scans() {
  static const std::map<std::wstring, WORD> values = {
    {L"keya",WORD{0x1e}},{L"keyb",WORD{0x30}},{L"keyc",WORD{0x2e}},{L"keyd",WORD{0x20}},{L"keye",WORD{0x12}},{L"keyf",WORD{0x21}},{L"keyg",WORD{0x22}},
    {L"keyh",WORD{0x23}},{L"keyi",WORD{0x17}},{L"keyj",WORD{0x24}},{L"keyk",WORD{0x25}},{L"keyl",WORD{0x26}},{L"keym",WORD{0x32}},{L"keyn",WORD{0x31}},
    {L"keyo",WORD{0x18}},{L"keyp",WORD{0x19}},{L"keyq",WORD{0x10}},{L"keyr",WORD{0x13}},{L"keys",WORD{0x1f}},{L"keyt",WORD{0x14}},{L"keyu",WORD{0x16}},
    {L"keyv",WORD{0x2f}},{L"keyw",WORD{0x11}},{L"keyx",WORD{0x2d}},{L"keyy",WORD{0x15}},{L"keyz",WORD{0x2c}},
    {L"digit1",WORD{0x02}},{L"digit2",WORD{0x03}},{L"digit3",WORD{0x04}},{L"digit4",WORD{0x05}},{L"digit5",WORD{0x06}},{L"digit6",WORD{0x07}},
    {L"digit7",WORD{0x08}},{L"digit8",WORD{0x09}},{L"digit9",WORD{0x0a}},{L"digit0",WORD{0x0b}},
    {L"minus",WORD{0x0c}},{L"equal",WORD{0x0d}},{L"bracketleft",WORD{0x1a}},{L"bracketright",WORD{0x1b}},{L"backslash",WORD{0x2b}},{L"semicolon",WORD{0x27}},
    {L"quote",WORD{0x28}},{L"backquote",WORD{0x29}},{L"comma",WORD{0x33}},{L"period",WORD{0x34}},{L"slash",WORD{0x35}},
    {L"numpad0",WORD{0x52}},{L"numpad1",WORD{0x4f}},{L"numpad2",WORD{0x50}},{L"numpad3",WORD{0x51}},{L"numpad4",WORD{0x4b}},
    {L"numpad5",WORD{0x4c}},{L"numpad6",WORD{0x4d}},{L"numpad7",WORD{0x47}},{L"numpad8",WORD{0x48}},{L"numpad9",WORD{0x49}},
  };
  return values;
}
InputRelease key_release(WORD vk, HKL layout) {
  const auto scan = MapVirtualKeyExW(vk, MAPVK_VK_TO_VSC_EX, layout);
  if (!scan || (scan & 0xff) == 0 || (scan & 0xffff0000) != 0 || ((scan & 0xff00) != 0 && (scan & 0xff00) != 0xe000)) unsupported();
  return {InputReleaseKind::scan_key, vk, static_cast<WORD>(scan & 0xff), (scan & 0xff00) == 0xe000, 0};
}
WORD named_virtual(std::wstring_view key) {
  const std::map<std::wstring_view, WORD> values = {{L"enter",WORD{VK_RETURN}},{L"tab",WORD{VK_TAB}},{L"escape",WORD{VK_ESCAPE}},{L"backspace",WORD{VK_BACK}},
    {L"delete",WORD{VK_DELETE}},{L"insert",WORD{VK_INSERT}},{L"home",WORD{VK_HOME}},{L"end",WORD{VK_END}},{L"pageup",WORD{VK_PRIOR}},{L"pagedown",WORD{VK_NEXT}},
    {L"arrowleft",WORD{VK_LEFT}},{L"arrowright",WORD{VK_RIGHT}},{L"arrowup",WORD{VK_UP}},{L"arrowdown",WORD{VK_DOWN}},{L"space",WORD{VK_SPACE}}};
  if (const auto found = values.find(key); found != values.end()) return found->second;
  if (key.size() >= 2 && key.size() <= 3 && key[0] == L'f') {
    unsigned number = 0; for (size_t index = 1; index < key.size(); ++index) { if (key[index] < L'0' || key[index] > L'9') return 0; number = number * 10 + static_cast<unsigned>(key[index] - L'0'); }
    if (number >= 1 && number <= 24) return static_cast<WORD>(VK_F1 + number - 1);
  }
  return 0;
}
struct KeyboardSnapshot { HKL layout = nullptr; HWND focus = nullptr; DWORD thread = 0; std::wstring fingerprint; };
KeyboardSnapshot snapshot(const WindowsWindow& window, bool include_ime=true) {
  GUITHREADINFO info{}; info.cbSize = sizeof(info);
  if (!GetGUIThreadInfo(window.surface_thread_id, &info) || !info.hwndFocus ||
      (info.hwndFocus != window.surface && !IsChild(window.surface, info.hwndFocus))) changed();
  DWORD pid = 0; const auto thread = GetWindowThreadProcessId(info.hwndFocus, &pid);
  if (!thread || pid != window.owner.process.pid) changed();
  KeyboardSnapshot result; result.thread = thread; result.focus = info.hwndFocus; result.layout = GetKeyboardLayout(thread);
  if (!result.layout) changed();
  std::wstring ime = L"none";
  if (include_ime && ImmIsIME(result.layout)) {
    const auto context = ImmGetContext(info.hwndFocus);
    if (!context) unsupported();
    struct Release { HWND window; HIMC context; ~Release() { ImmReleaseContext(window, context); } } release{info.hwndFocus, context};
    DWORD conversion = 0, sentence = 0;
    if (ImmGetOpenStatus(context) || !ImmGetConversionStatus(context, &conversion, &sentence) || ImmGetCompositionStringW(context, GCS_COMPSTR, nullptr, 0) != 0) unsupported();
    ime = L"closed:" + std::to_wstring(conversion) + L":" + std::to_wstring(sentence);
  }
  result.fingerprint = std::to_wstring(reinterpret_cast<uintptr_t>(result.layout)) + L":" + std::to_wstring(thread) + L":" +
    std::to_wstring(reinterpret_cast<uintptr_t>(info.hwndFocus)) + L":toggle-invariant";
  if (include_ime) result.fingerprint += L"|" + ime;
  return result;
}
std::optional<std::wstring> translated(WORD vk, WORD scan, uint32_t modifiers, const KeyboardSnapshot& keyboard,bool shortcut_case=false) {
  std::array<std::optional<std::wstring>,4> alternatives;
  for (size_t toggle=0;toggle<alternatives.size();++toggle) {
    std::array<BYTE,256> state{}; state[VK_CAPITAL]=static_cast<BYTE>(toggle&1); state[VK_NUMLOCK]=static_cast<BYTE>((toggle>>1)&1);
    if (modifiers & shift) state[VK_SHIFT]=state[VK_LSHIFT]=0x80;
    if ((modifiers & alt_graph) || (modifiers & (control | alt))==(control | alt)) state[VK_CONTROL]=state[VK_LCONTROL]=state[VK_MENU]=state[VK_RMENU]=0x80;
    wchar_t output[8]{};
    // Public ToUnicodeEx wFlags bit2 prevents dead-key state mutation (supported on minimumWin10).
    const auto count=ToUnicodeEx(vk,scan,state.data(),output,8,0x4,keyboard.layout);
    if (count<=0 || count>8) continue;
    std::wstring value(output,static_cast<size_t>(count)); if (safe_unicode(value)) alternatives[toggle]=std::move(value);
  }
  return input_toggle_invariant(alternatives,shortcut_case);
}
std::vector<InputNativeKey> modifiers(uint32_t bits, const KeyboardSnapshot& keyboard) {
  if (bits & meta || bits & ~(control | alt | shift | alt_graph) || ((bits & alt_graph) && (bits & (control | alt)))) unsupported();
  std::vector<InputNativeKey> result;
  if (bits & control || bits & alt_graph) result.push_back({key_release(VK_LCONTROL, keyboard.layout), control});
  if (bits & alt) result.push_back({key_release(VK_LMENU, keyboard.layout), alt});
  if (bits & shift) result.push_back({key_release(VK_LSHIFT, keyboard.layout), shift});
  if (bits & alt_graph) result.push_back({key_release(VK_RMENU, keyboard.layout), alt_graph});
  return result;
}

class NativeInput final {
 public:
  explicit NativeInput(std::shared_ptr<InputGuardian> value) : guardian(std::move(value)), tag(guardian ? guardian->tag() : 0) {
    if (!tag) throw Failure{L"unavailable", L"The private native input source is unavailable."};
    owned.reserve(136);
  }
  std::shared_ptr<InputGuardian> guardian;
  const uint64_t tag;
  std::recursive_mutex mutex;
  bool closed = false;
  std::vector<InputRelease> owned;
  bool quiet() {
    std::lock_guard guard(mutex); std::array<bool, 256> allowed{};
    for (const auto& key : owned) {
      if (key.kind == InputReleaseKind::mouse_button) allowed[key.button == 0 ? VK_LBUTTON : key.button == 1 ? VK_RBUTTON : VK_MBUTTON] = true;
      else {
        allowed[key.virtual_key] = true;
        if (key.virtual_key == VK_LSHIFT || key.virtual_key == VK_RSHIFT) allowed[VK_SHIFT] = true;
        if (key.virtual_key == VK_LCONTROL || key.virtual_key == VK_RCONTROL) allowed[VK_CONTROL] = true;
        if (key.virtual_key == VK_LMENU || key.virtual_key == VK_RMENU) allowed[VK_MENU] = true;
      }
    }
    for (int key = 1; key < 255; ++key) if ((GetAsyncKeyState(key) & 0x8000) != 0 && !allowed[static_cast<size_t>(key)]) return false;
    return true;
  }
  InputNativeChord resolve(std::span<const std::wstring> raw, const InputObservation& observation) {
    const auto keyboard = snapshot(observation.window); const InputKeyTextRules rules{safe_unicode, normalize_menu};
    const auto parsed = parse_input_combo(raw, rules); if (!parsed) unsupported();
    InputKeyLayout layout; layout.fingerprint = keyboard.fingerprint;
    InputRelease leaf; uint32_t effective = parsed->modifiers;
    const bool shortcut_case=(effective&control)!=0 && !(effective&(alt|alt_graph|meta));
    if (parsed->physical) {
      if (parsed->key.starts_with(L"numpad")) unsupported();
      const auto found = physical_scans().find(parsed->key); if (found == physical_scans().end()) unsupported();
      const auto vk = MapVirtualKeyExW(found->second, MAPVK_VSC_TO_VK_EX, keyboard.layout); if (!vk || vk > 0xfe) unsupported();
      leaf = {InputReleaseKind::scan_key, static_cast<WORD>(vk), found->second, false, 0};
      const auto base = translated(leaf.virtual_key, leaf.scan, 0, keyboard,shortcut_case);
      if (!base) unsupported();
      layout.keys[parsed->key] = {*base, translated(leaf.virtual_key, leaf.scan, shift, keyboard,shortcut_case),
        translated(leaf.virtual_key, leaf.scan, alt_graph, keyboard), translated(leaf.virtual_key, leaf.scan, shift | alt_graph, keyboard)};
    } else if (const auto vk = named_virtual(parsed->key)) leaf = key_release(vk, keyboard.layout);
    else {
      if (parsed->key.size() != 1) unsupported();
      const auto encoded = VkKeyScanExW(parsed->key[0], keyboard.layout); if (encoded == -1) unsupported();
      const auto extra = static_cast<uint8_t>((static_cast<uint16_t>(encoded) >> 8) & 0xff);
      if (extra & ~7U) unsupported();
      if (extra & 1) effective |= shift;
      if ((extra & 6) == 6) effective |= alt_graph;
      else { if (extra & 2) effective |= control; if (extra & 4) effective |= alt; }
      leaf = key_release(static_cast<WORD>(static_cast<uint16_t>(encoded) & 0xff), keyboard.layout);
    }
    auto semantic = resolve_input_combo(raw, layout, rules); if (!semantic) unsupported();
    semantic->modifiers = effective;
    if (!named_virtual(parsed->key)) {
      const auto value = translated(leaf.virtual_key, leaf.scan, effective, keyboard,shortcut_case); if (!value) unsupported();
      const std::vector<std::wstring> one{*value}; const auto observed = parse_input_combo(one, rules); if (!observed || observed->physical) unsupported();
      semantic->key = observed->key;
    }
    if (snapshot(observation.window).fingerprint != keyboard.fingerprint || !quiet()) changed();
    InputNativeChord chord; chord.semantic = *semantic; chord.keys = modifiers(effective, keyboard); chord.keys.push_back({leaf, 0}); return chord;
  }
  InputPostResult post(const InputPostedEvent& event) {
    std::lock_guard guard(mutex);
    const bool up = event.kind == InputEventKind::button_up || event.kind == InputEventKind::key_up || event.kind == InputEventKind::unicode_up;
    if (event.tag != tag || (!up && (closed || !desktop_available() || !quiet()))) return InputPostResult::not_posted;
    INPUT value{};
    if (event.kind == InputEventKind::move) {
      const InputDesktopExtent extent{GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_YVIRTUALSCREEN), GetSystemMetrics(SM_CXVIRTUALSCREEN), GetSystemMetrics(SM_CYVIRTUALSCREEN)};
      const auto absolute = input_absolute_center(event.point.x, event.point.y, extent); if (!absolute) return InputPostResult::not_posted;
      value.type = INPUT_MOUSE; value.mi.dx = absolute->x; value.mi.dy = absolute->y;
      value.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK; value.mi.dwExtraInfo = static_cast<ULONG_PTR>(tag);
    } else if (event.kind == InputEventKind::scroll) {
      if ((event.dx == 0) == (event.dy == 0) || event.dx < -10'000 || event.dx > 10'000 || event.dy < -10'000 || event.dy > 10'000) return InputPostResult::not_posted;
      value.type = INPUT_MOUSE; value.mi.dwFlags = event.dx ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL;
      value.mi.mouseData = static_cast<DWORD>((event.dx ? event.dx : -event.dy) * WHEEL_DELTA); value.mi.dwExtraInfo = static_cast<ULONG_PTR>(tag);
    } else {
      if (!valid_input_release(event.release)) return InputPostResult::not_posted;
      if (up && std::find(owned.begin(), owned.end(), event.release) == owned.end()) return InputPostResult::accepted;
      if (event.release.kind == InputReleaseKind::mouse_button) {
        if (event.kind != InputEventKind::button_down && event.kind != InputEventKind::button_up) return InputPostResult::not_posted;
        constexpr DWORD downs[] = {MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_MIDDLEDOWN};
        constexpr DWORD ups[] = {MOUSEEVENTF_LEFTUP, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_MIDDLEUP};
        value.type = INPUT_MOUSE; value.mi.dwFlags = up ? ups[event.release.button] : downs[event.release.button]; value.mi.dwExtraInfo = static_cast<ULONG_PTR>(tag);
        if (!up) {
          const InputDesktopExtent extent{GetSystemMetrics(SM_XVIRTUALSCREEN),GetSystemMetrics(SM_YVIRTUALSCREEN),GetSystemMetrics(SM_CXVIRTUALSCREEN),GetSystemMetrics(SM_CYVIRTUALSCREEN)};
          const auto absolute=input_absolute_center(event.point.x,event.point.y,extent); if (!absolute) return InputPostResult::not_posted;
          // The button's own INPUT also carries the exact position. A physical cursor move between
          // hover and DOWN can never redirect the click to a different current cursor position.
          value.mi.dx=absolute->x; value.mi.dy=absolute->y; value.mi.dwFlags|=MOUSEEVENTF_MOVE|MOUSEEVENTF_ABSOLUTE|MOUSEEVENTF_VIRTUALDESK;
        }
      } else {
        if (event.kind != InputEventKind::key_down && event.kind != InputEventKind::key_up && event.kind != InputEventKind::unicode_down && event.kind != InputEventKind::unicode_up) return InputPostResult::not_posted;
        if ((event.release.kind == InputReleaseKind::unicode_key) != (event.kind == InputEventKind::unicode_down || event.kind == InputEventKind::unicode_up)) return InputPostResult::not_posted;
        value.type = INPUT_KEYBOARD; value.ki.wVk = 0; value.ki.wScan = event.release.scan;
        value.ki.dwFlags = (event.release.kind == InputReleaseKind::unicode_key ? KEYEVENTF_UNICODE : KEYEVENTF_SCANCODE) |
          (event.release.extended ? KEYEVENTF_EXTENDEDKEY : 0) | (up ? KEYEVENTF_KEYUP : 0); value.ki.dwExtraInfo = static_cast<ULONG_PTR>(tag);
      }
    }
    if (SendInput(1, &value, sizeof(INPUT)) != 1) return InputPostResult::not_posted;
    if (!up && event.kind != InputEventKind::move && event.kind != InputEventKind::scroll) owned.push_back(event.release);
    if (up) owned.erase(std::remove(owned.begin(), owned.end(), event.release), owned.end());
    if (event.kind == InputEventKind::move) { POINT actual{}; if (!GetCursorPos(&actual) || actual.x != event.point.x || actual.y != event.point.y) return InputPostResult::uncertain; }
    return InputPostResult::accepted;
  }
  InputPostResult batch(std::span<const InputPostedEvent> events) {
    std::lock_guard guard(mutex);
    if (closed || !desktop_available() || !quiet() || (events.size() != 2 && events.size() != 4)) return InputPostResult::not_posted;
    std::array<INPUT, 4> values{};
    for (size_t index = 0; index < events.size(); index += 2) {
      const auto& down = events[index]; const auto& up = events[index + 1];
      if (down.kind != InputEventKind::unicode_down || up.kind != InputEventKind::unicode_up || down.tag != tag || up.tag != tag ||
          down.release.kind != InputReleaseKind::unicode_key || !valid_input_release(down.release) || down.release != up.release) return InputPostResult::not_posted;
      if (events.size() == 2 && down.release.scan >= 0xd800 && down.release.scan <= 0xdfff) return InputPostResult::not_posted;
      if (events.size() == 4 && ((index == 0 && (down.release.scan < 0xd800 || down.release.scan > 0xdbff)) ||
          (index == 2 && (down.release.scan < 0xdc00 || down.release.scan > 0xdfff)))) return InputPostResult::not_posted;
      values[index].type = values[index + 1].type = INPUT_KEYBOARD;
      values[index].ki.wScan = values[index + 1].ki.wScan = down.release.scan;
      values[index].ki.dwFlags = KEYEVENTF_UNICODE; values[index + 1].ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
      values[index].ki.dwExtraInfo = values[index + 1].ki.dwExtraInfo = static_cast<ULONG_PTR>(tag);
    }
    const auto sent = SendInput(static_cast<UINT>(events.size()), values.data(), sizeof(INPUT));
    if (sent == events.size()) return InputPostResult::accepted;
    return sent == 0 ? InputPostResult::not_posted : InputPostResult::uncertain;
  }
};
}

InputKeyTextRules native_input_text_rules() { return {safe_unicode, normalize_menu}; }
std::optional<std::wstring> input_toggle_invariant(const std::array<std::optional<std::wstring>,4>& values,bool shortcut_case) {
  std::optional<std::wstring> result;
  for (const auto& value:values) {
    if (!value || value->empty()) return {};
    auto observed=*value;
    if (shortcut_case) for (auto& c:observed) if (c>=L'A' && c<=L'Z') c=static_cast<wchar_t>(c+32);
    if (result && *result!=observed) return {}; result=std::move(observed);
  }
  return result;
}
InputBackend InputBackend::system(std::shared_ptr<CaptureService> captures, std::shared_ptr<InputGuardian> guardian) {
  const auto native = std::make_shared<NativeInput>(std::move(guardian));
  const auto guard = std::make_shared<WindowsGuard>(); const auto windows = WindowsBackend::system(windows_child_shell);
  InputBackend result; result.tag = native->tag; result.guardian = native->guardian; result.text_rules = native_input_text_rules();
  result.receipt = [captures](auto id, const auto& session) { if (!captures) changed(); return captures->receipt(id, session); };
  result.capture_current = [captures](const auto& receipt, const auto& session) { return captures && captures->current(receipt, session); };
  result.focused_window = [windows](const ServerSession& session) { const auto foreground = GetForegroundWindow(); if (!foreground) changed(); const auto window = windows.observe(foreground); WindowsSessionPolicy(session).require(window, WindowsPolicyOperation::observe); return window; };
  result.point = [guard](const auto& window, POINT point, const auto& session) { return guard->point(window, point, session); };
  result.foreground = [windows](const auto& expected, const auto& session) { const auto actual = windows.observe(GetForegroundWindow()); WindowsSessionPolicy(session).require(actual, WindowsPolicyOperation::observe); if (!same_windows_window(expected, actual) || !windows.foreground(actual)) changed(); return actual; };
  result.commit_point = [guard](const auto& point, const auto& session, const auto& context,const auto& precondition,const auto& mutation) { guard->commit_point(point, session, context, mutation,precondition); };
  result.commit_foreground = [guard](const auto& window, const auto& session, const auto& context, auto operation, auto secure, auto keys, uint64_t observed_at,const auto& precondition,const auto& mutation) { guard->commit_foreground(window, session, context,WindowsGuardStamp(session,observed_at), operation, mutation, secure, keys,precondition); };
  result.resolve = [native](auto raw, const auto& observation) { return native->resolve(raw, observation); };
  result.pointer_modifiers = [](auto raw, const WindowsWindow& window) {
    uint32_t bits = 0;
    for (const auto& name : raw) { const auto modifier = input_modifier_name(name); if (!modifier || *modifier == InputModifier::meta || *modifier == InputModifier::alt_graph || (bits & input_modifier(*modifier))) unsupported(); bits |= input_modifier(*modifier); }
    if (!bits) return std::vector<InputNativeKey>{};
    KeyboardSnapshot keyboard; keyboard.layout = GetKeyboardLayout(window.surface_thread_id); if (!keyboard.layout) changed();
    return modifiers(bits, keyboard);
  };
  result.keyboard_current = [native](auto fingerprint, const auto& window, auto) {
    // IMM preparation stays outside authority. The current field proof is separately ≤50 ms old;
    // this final guard repeats only live layout/focus/toggles/owned-modifier metadata.
    try { const auto current=snapshot(window,false).fingerprint+L"|"; return native->quiet() && fingerprint.starts_with(current); } catch (...) { return false; }
  };
  result.keyboard_fingerprint = [](const WindowsWindow& window) { return snapshot(window).fingerprint; };
  result.quiet = [native] { return native->quiet(); }; result.available = desktop_available;
  result.post = [native](const auto& event) { return native->post(event); };
  result.post_batch = [native](auto events) { return native->batch(events); };
  result.release = [native](const InputRelease& release) { return native->post({release.kind == InputReleaseKind::mouse_button ? InputEventKind::button_up : release.kind == InputReleaseKind::unicode_key ? InputEventKind::unicode_up : InputEventKind::key_up, {}, release, 0, 0, native->tag}) == InputPostResult::accepted; };
  result.confirm_down = [native](const InputRelease& release) {
    std::lock_guard lock(native->mutex);
    if (!valid_input_release(release)) changed();
    if (std::find(native->owned.begin(),native->owned.end(),release)==native->owned.end()) {
      if (native->owned.size()>=136) changed(); native->owned.push_back(release);
    }
  };
  result.forget_release = [native](const InputRelease& release) { std::lock_guard lock(native->mutex); native->owned.erase(std::remove(native->owned.begin(), native->owned.end(), release), native->owned.end()); };
  result.close = [native] { std::lock_guard lock(native->mutex); native->closed = true; };
  return result;
}
}
