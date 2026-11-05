#include "privileged_self_test.h"
#include "privileged_target.h"
#include "accessibility.h"
#include "availability.h"
#include "input.h"
#include "input_guardian.h"
#include "lifecycle.h"
#include "parent_identity.h"
#include "user_input.h"
#include "windows_process_tree.h"
#include <objidl.h>
#include <wincodec.h>
#include <tlhelp32.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <map>
#include <mutex>
#include <set>
#include <thread>

namespace vector::computer {
namespace {
struct ScenarioFailure { std::wstring reason; };
struct ScenarioSkip { std::wstring reason; };
void require(bool value) { if (!value) throw ScenarioFailure{L"assertion_failed"}; }
JsonObject object(std::wstring_view text) { return JsonObject::Parse(winrt::hstring(text)); }
std::optional<uint64_t> number(const JsonObject& value, const wchar_t* name) { return value.HasKey(name) ? safe_integer(value.Lookup(name)) : std::nullopt; }
bool isolated() {
  wchar_t value[3]{}; return GetEnvironmentVariableW(L"VECTOR_COMPUTER_TEST_ISOLATED", value, 3) == 1 && value[0] == L'1' && value[1] == L'\0';
}
DWORD immediate_parent() {
  winrt::handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  if (!snapshot || snapshot.get() == INVALID_HANDLE_VALUE) throw ScenarioFailure{L"target_validation_failed"};
  PROCESSENTRY32W entry{}; entry.dwSize = static_cast<DWORD>(sizeof(entry));
  if (!Process32FirstW(snapshot.get(), &entry)) throw ScenarioFailure{L"target_validation_failed"};
  size_t count = 0;
  do {
    if (++count > 65'536) throw ScenarioFailure{L"target_validation_failed"};
    if (entry.th32ProcessID == GetCurrentProcessId()) {
      if (!entry.th32ParentProcessID || entry.th32ParentProcessID == GetCurrentProcessId()) throw ScenarioFailure{L"target_validation_failed"};
      return entry.th32ParentProcessID;
    }
  } while (Process32NextW(snapshot.get(), &entry));
  throw ScenarioFailure{L"target_validation_failed"};
}
struct PrivilegedRunCleanup {
  std::atomic_bool revoked{false};
  std::mutex mutex;
  std::vector<std::function<void()>> actions;
  void add(std::function<void()> action) {
    bool immediately = false;
    { std::lock_guard lock(mutex); immediately = revoked.load(); if (!immediately) actions.push_back(action); }
    if (immediately) action();
  }
  void revoke() noexcept {
    if (revoked.exchange(true)) return;
    std::vector<std::function<void()>> pending;
    { std::lock_guard lock(mutex); pending.swap(actions); }
    bool apartment = false;
    try { winrt::init_apartment(winrt::apartment_type::multi_threaded); apartment = true; } catch (...) {}
    // Input/service cleanup was registered after the owned target. Retire actual input before
    // requesting that target's exit; no watcher metadata lock spans either cleanup path.
    for (auto action = pending.rbegin(); action != pending.rend(); ++action) try { (*action)(); } catch (...) {}
    if (apartment) winrt::uninit_apartment();
  }
};
struct NativeReply { JsonObject document; std::vector<uint8_t> image; };
struct ScenarioState {
  std::weak_ptr<Dispatcher> dispatcher;
  std::shared_ptr<CaptureService> captures;
  std::shared_ptr<AccessibilityService> accessibility;
  std::shared_ptr<InputService> input;
  std::shared_ptr<UserInputService> detector;
  std::shared_ptr<WindowsPrivilegedRunAuthority> authority;
  std::atomic_bool live{true}, physical{false};
  std::mutex mutex;
  std::condition_variable changed;
  std::map<uint64_t, NativeReply> replies;
  bool available() const noexcept { return live.load() && authority && authority->current(); }
  bool publish(const JsonObject& document, std::span<const uint8_t> image) {
    std::lock_guard lock(mutex);
    if (document.HasKey(L"event")) { const auto name = document.GetNamedString(L"event", L""); if (name == L"user_input" || name == L"stop") physical.store(true); changed.notify_all(); return true; }
    const auto id = number(document, L"id"); if (!id || *id == 0) return false;
    if (*id >= 1'000'000) return image.empty(); // Only the private heartbeat producer owns these ids.
    if (replies.size() >= 16 || image.size() > kMaxFrameBytes || replies.contains(*id)) return false;
    replies.emplace(*id, NativeReply{JsonObject::Parse(document.Stringify()), {image.begin(), image.end()}}); changed.notify_all(); return true;
  }
};
class NativeScenario final {
 public:
  NativeScenario(const WindowsTargetState& target, std::shared_ptr<WindowsPrivilegedRunAuthority> authority,
                 const std::shared_ptr<PrivilegedRunCleanup>& cleanup) : state(std::make_shared<ScenarioState>()) {
    state->authority = std::move(authority);
    if (!state->available()) throw ScenarioFailure{L"target_validation_failed"};
    const std::weak_ptr<ScenarioState> weak = state;
    const auto native_windows = WindowsBackend::system(windows_child_shell);
    windows = std::make_shared<WindowService>(windows_window_policy(), native_windows);
    state->captures = std::make_shared<CaptureService>();
    const auto uia = WindowsUiaBackend::system(); auto accessibility_backend = AccessibilityBackend::system(state->captures, uia);
    accessibility_backend.mutation_current = [weak](const auto& session) { const auto active = weak.lock(); return active && active->available() && active->detector && active->detector->foreground_ready(session); };
    state->accessibility = std::make_shared<AccessibilityService>(std::move(accessibility_backend));
    guardian = InputGuardian::native(); auto native_input = InputBackend::system(state->captures, guardian); const auto rules = native_input.text_rules;
    const std::weak_ptr<AccessibilityService> weak_accessibility = state->accessibility;
    state->input = std::make_shared<InputService>(uia_input_provider(uia, [weak_accessibility](const auto& observation, const auto& expected, const auto& session) {
      const auto service = weak_accessibility.lock(); if (!service) throw Failure{L"stale_ref", L"The isolated native session ended."}; service->verify_input(observation, expected, session);
    }, {}, rules), std::move(native_input));
    UserInputCallbacks callbacks;
    callbacks.physical = [weak](const auto& event, const auto& session, bool takeover) { const auto active = weak.lock(); const auto server = active ? active->dispatcher.lock() : nullptr; return server && server->physical_input(event, session, takeover); };
    callbacks.stop = [weak](auto by, const auto& session) { const auto active = weak.lock(); const auto server = active ? active->dispatcher.lock() : nullptr; return server && server->stop_from_physical_input(by, session); };
    callbacks.detection = [weak](bool alive, auto reason, const auto& session) { const auto active = weak.lock(); const auto server = active ? active->dispatcher.lock() : nullptr; return server && server->input_detection(alive, reason, session); };
    callbacks.readiness_changed = [weak](const auto& session) { const auto active = weak.lock(); const auto server = active ? active->dispatcher.lock() : nullptr; if (server) server->foreground_readiness_changed(session); };
    state->detector = std::make_shared<UserInputService>(guardian->tag(), std::move(callbacks));
    Dispatcher::Options options;
    // The CLI self-test admits only a verified same-source private target. This in-process authority
    // never exposes a serving pipe and is not evidence of an ordinary caller's responsibility.
    options.responsible = true;
    options.send = [active = state](const auto& reply, auto bytes) { return active->publish(reply, bytes); };
    options.available = [active = state] { return active->available(); };
    options.foreground_ready = [active = state](const auto& session) { return active->available() && active->detector->foreground_ready(session); };
    options.foreground_pending = [active = state](const auto& session) { return active->available() && active->detector->readiness(session) == UserInputReadiness::pending; };
    options.native_event_current = [active = state](const JsonObject& event, const std::optional<ServerSession>& session) {
      if (event.GetNamedString(L"event", L"") == L"input_detection" && event.HasKey(L"alive") && event.Lookup(L"alive").ValueType() == JsonValueType::Boolean && event.GetNamedBoolean(L"alive")) return active->available() && session && active->detector->foreground_ready(*session);
      return true;
    };
    options.release_all = [active = state] { return active->input->release_all(); };
    options.prepare_release_all = [active = state] { return active->input->prepare_release_all(); };
    options.session_changed = [active = state](auto session) { active->accessibility->note_session(session); active->detector->session_changed(session); };
    options.observations_invalidated = [active = state] { active->accessibility->invalidate_observations(); active->captures->invalidate(); };
    options.cleanup = [active = state](auto) { active->accessibility->invalidate_observations(true); active->captures->invalidate(); };
    server = std::make_shared<Dispatcher>(std::move(options)); state->dispatcher = server;
    cleanup->add([active = state] {
      active->live.store(false); active->changed.notify_all();
      active->detector->close();
      try { active->input->release_all_async([](bool, uint32_t) {}); } catch (...) {}
      try { if (const auto dispatcher = active->dispatcher.lock()) dispatcher->close(L"isolated-parent-stopped"); } catch (...) {}
      active->input->close();
      try { active->accessibility->close(); } catch (...) {}
      try { active->captures->close(); } catch (...) {}
    });
    if (!state->available()) throw ScenarioFailure{L"target_validation_failed"};
    server->register_handler(L"apps.list", 15'000, false, false, [service = windows](const auto& request, const auto& context, auto done) { service->list(request.args, context, std::move(done)); });
    server->register_handler(L"window.focus", 5000, true, true, [service = windows](const auto& request, const auto& context, auto done) { service->focus(request.args, context, std::move(done)); });
    server->register_handler(L"displays.list", 4000, false, false, [service = state->captures](const auto& request, const auto& context, auto done) { service->displays(request.args, context, std::move(done)); });
    server->register_handler(L"capture", 10'000, true, false, [service = state->captures](const auto& request, const auto& context, auto done) { service->capture(request.args, context, std::move(done)); });
    server->register_handler(L"ui.tree", 15'000, true, false, [service = state->accessibility](const auto& request, const auto& context, auto done) { service->tree(request.args, context, std::move(done)); });
    server->register_handler(L"ui.focused", 5000, true, false, [service = state->accessibility](const auto& request, const auto& context, auto done) { service->focused(request.args, context, std::move(done)); });
    server->register_handler(L"ui.perform", 5000, true, true, [service = state->accessibility](const auto& request, const auto& context, auto done) { service->perform(request.args, context, std::move(done)); });
    server->register_handler(L"ui.setValue", 5000, true, true, [service = state->accessibility](const auto& request, const auto& context, auto done) { service->set_value(request.args, context, std::move(done)); });
    for (const auto operation : {L"input.click", L"input.type", L"input.hold"}) server->register_handler(operation, 30'000, true, true, [service = state->input](const auto& request, const auto& context, auto done) { service->handle(request.op, request.args, context, std::move(done)); });
    const auto window = native_windows.observe(target.window); require(window.owner.process.pid == target.pid && window.hwnd == target.window);
    JsonObject begin = object(LR"({"sessionId":"isolated-windows-target","phaseRevision":1,"mode":"foreground","approved":[],"vectorPids":[],"vectorWindowIds":[],"overlayWindowIds":[],"escStops":false,"stopChord":"control+alt+escape","heartbeatMs":2000})");
    JsonArray approved; approved.Append(window.owner.identity.wire()); begin.Insert(L"approved", approved);
    if (!state->available()) throw ScenarioFailure{L"target_validation_failed"};
    detector_started = state->detector->start(); success(request(L"session.begin", begin));
    heartbeat = std::jthread([weak](std::stop_token stop) {
      bool initialized = false;
      try {
        winrt::init_apartment(winrt::apartment_type::multi_threaded); initialized = true;
        const auto started = GetTickCount64(); auto next_heartbeat = started; uint64_t id = 1'000'000;
        while (!stop.stop_requested()) {
          const auto active = weak.lock(); if (!active || !active->available()) break;
          const auto dispatcher = active->dispatcher.lock(); if (!dispatcher) break;
          const auto now = GetTickCount64();
          if (now - started >= 100'000) { active->live.store(false); dispatcher->close(L"isolated-deadline"); active->changed.notify_all(); break; }
          if (now >= next_heartbeat) { dispatcher->receive(Request{++id, L"heartbeat", JsonObject{}, 32}); next_heartbeat = now + 1500; }
          std::this_thread::sleep_for(std::chrono::milliseconds(25));
        }
      } catch (...) { if (const auto active = weak.lock()) { active->live.store(false); active->changed.notify_all(); } }
      if (initialized) winrt::uninit_apartment();
    });
  }
  ~NativeScenario() { close(); }
  uint64_t begin(std::wstring_view operation, const JsonObject& args) {
    if (!state->available() || next >= 999'999) throw ScenarioFailure{L"deadline_exceeded"};
    const auto id = ++next; server->receive(Request{id, std::wstring(operation), JsonObject::Parse(args.Stringify()), encoded_size(args) + 128}); return id;
  }
  NativeReply wait(uint64_t id, uint32_t timeout_ms = 16'000) {
    std::unique_lock lock(state->mutex);
    if (!state->changed.wait_for(lock, std::chrono::milliseconds(timeout_ms), [&] { return state->replies.contains(id) || !state->available(); })) throw ScenarioFailure{L"deadline_exceeded"};
    const auto found = state->replies.find(id); if (found == state->replies.end()) throw ScenarioFailure{L"deadline_exceeded"};
    auto result = std::move(found->second); state->replies.erase(found); return result;
  }
  NativeReply request(std::wstring_view operation, const JsonObject& args = {}) { return wait(begin(operation, args)); }
  static void success(const NativeReply& reply) { if (!reply.document.GetNamedBoolean(L"ok", false)) throw ScenarioFailure{L"native_operation_failed"}; }
  static bool failure(const NativeReply& reply, std::wstring_view code) { return !reply.document.GetNamedBoolean(L"ok", true) && reply.document.GetNamedObject(L"error").GetNamedString(L"code", L"") == code; }
  ServerSession session() const { const auto current = server->session_snapshot(); if (!current) throw ScenarioFailure{L"native_operation_failed"}; return *current; }
  JsonObject phase(JsonObject args) const { const auto current = session(); args.Insert(L"sessionId", JsonValue::CreateStringValue(current.id)); args.Insert(L"phaseRevision", JsonValue::CreateNumberValue(static_cast<double>(current.revision.value_or(0)))); return args; }
  bool await_input() {
    const auto deadline = GetTickCount64() + 1500;
    while (detector_started && state->available() && GetTickCount64() < deadline) {
      if (state->physical.load()) throw ScenarioSkip{L"physical_takeover"};
      const auto current = session(); if (!current.paused && state->detector->foreground_ready(current)) return true;
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    return false;
  }
  void require_input(HWND target) {
    if (!state->available()) throw ScenarioFailure{L"deadline_exceeded"};
    if (state->physical.load()) throw ScenarioSkip{L"physical_takeover"};
    const auto current = session(); if (current.paused || !state->detector->foreground_ready(current)) throw ScenarioSkip{L"input_detection_unavailable"};
    if (GetForegroundWindow() != target) throw ScenarioSkip{L"foreground_unavailable"};
  }
  bool close() noexcept {
    if (closed) return cleanup_ok;
    bool released = false;
    try { if (!server->closed() && state->live.load()) { const auto id = begin(L"input.releaseAll", JsonObject{}); released = wait(id, 1000).document.GetNamedBoolean(L"ok", false); } } catch (...) {}
    closed = true; state->live.store(false); state->changed.notify_all(); if (heartbeat.joinable()) heartbeat.request_stop();
    try { server->close(L"isolated-close"); state->detector->close(); state->input->close(); state->accessibility->close(); state->captures->close(); cleanup_ok = server->wait_for_output(200) && released; } catch (...) { cleanup_ok = false; }
    return cleanup_ok;
  }
  std::shared_ptr<ScenarioState> state;
  std::shared_ptr<WindowService> windows;
  std::shared_ptr<InputGuardian> guardian;
  std::shared_ptr<Dispatcher> server;
 private:
  uint64_t next = 0;
  bool detector_started = false, closed = false, cleanup_ok = false;
  std::jthread heartbeat;
};
CaptureBitmap decode_png(const std::vector<uint8_t>& bytes) {
  require(!bytes.empty() && bytes.size() <= kMaxFrameBytes);
  winrt::com_ptr<IStream> stream; winrt::check_hresult(CreateStreamOnHGlobal(nullptr, TRUE, stream.put())); ULONG written = 0;
  winrt::check_hresult(stream->Write(bytes.data(), static_cast<ULONG>(bytes.size()), &written)); require(written == bytes.size()); LARGE_INTEGER origin{}; winrt::check_hresult(stream->Seek(origin, STREAM_SEEK_SET, nullptr));
  winrt::com_ptr<IWICImagingFactory> factory; winrt::check_hresult(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(factory.put())));
  winrt::com_ptr<IWICBitmapDecoder> decoder; winrt::check_hresult(factory->CreateDecoderFromStream(stream.get(), nullptr, WICDecodeMetadataCacheOnLoad, decoder.put())); UINT frames = 0; winrt::check_hresult(decoder->GetFrameCount(&frames)); require(frames == 1);
  winrt::com_ptr<IWICBitmapFrameDecode> frame; winrt::check_hresult(decoder->GetFrame(0, frame.put())); CaptureBitmap result; winrt::check_hresult(frame->GetSize(&result.width, &result.height)); require(result.width > 0 && result.height > 0 && uint64_t(result.width) * result.height <= 1024 * 1024);
  winrt::com_ptr<IWICFormatConverter> converter; winrt::check_hresult(factory->CreateFormatConverter(converter.put())); winrt::check_hresult(converter->Initialize(frame.get(), GUID_WICPixelFormat32bppBGRA, WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeCustom));
  result.bgra.resize(static_cast<size_t>(result.width) * result.height * 4); winrt::check_hresult(converter->CopyPixels(nullptr, result.width * 4, static_cast<UINT>(result.bgra.size()), result.bgra.data())); require(result.valid()); return result;
}
struct Captured { CaptureReceipt receipt; CaptureBitmap image; };
Captured capture(NativeScenario& native, HWND window) {
  JsonObject target; target.Insert(L"windowId", JsonValue::CreateStringValue(window_id(window)));
  JsonObject args = object(LR"({"budget":{"maxWidth":1024,"maxHeight":1024,"maxPixels":1048576},"format":"png"})"); args.Insert(L"target", target);
  const auto response = native.request(L"capture", args); NativeScenario::success(response);
  const auto record = native.state->captures->receipt(response.document.GetNamedString(L"captureId"), native.session()); const auto image = decode_png(response.image);
  require(image.width == record.width && image.height == record.height); return {record, image};
}
std::pair<int64_t, int64_t> image_point(const CaptureReceipt& frame, const WindowsRect& region) {
  require(frame.bounds.contains(region)); const auto x = static_cast<int64_t>(std::floor((double(region.x - frame.bounds.x) + double(region.width) / 2) * frame.image_scale)); const auto y = static_cast<int64_t>(std::floor((double(region.y - frame.bounds.y) + double(region.height) / 2) * frame.image_scale));
  require(x >= 0 && y >= 0 && x < frame.width && y < frame.height); return {x, y};
}
bool color(const Captured& captured, const WindowsRect& region, std::array<int, 3> expected) {
  const auto [x, y] = image_point(captured.receipt, region); const auto offset = (static_cast<size_t>(y) * captured.image.width + static_cast<size_t>(x)) * 4;
  return std::abs(int(captured.image.bgra[offset + 2]) - expected[0]) <= 8 && std::abs(int(captured.image.bgra[offset + 1]) - expected[1]) <= 8 && std::abs(int(captured.image.bgra[offset]) - expected[2]) <= 8;
}
JsonObject tree(NativeScenario& native, const WindowsTargetState& target) {
  JsonObject args = object(LR"({"maxNodes":100,"maxDepth":12})"); args.Insert(L"windowId", JsonValue::CreateStringValue(window_id(target.window))); const auto response = native.request(L"ui.tree", args); NativeScenario::success(response); return response.document;
}
JsonObject element(const JsonObject& snapshot, const WindowsRect& region, std::wstring_view role) {
  std::vector<JsonObject> found;
  for (const auto& raw : snapshot.GetNamedArray(L"nodes")) {
    if (raw.ValueType() != JsonValueType::Object) continue; const auto node = raw.GetObject(); if (node.GetNamedString(L"role", L"") != role || !node.HasKey(L"bounds")) continue;
    const auto bounds = node.GetNamedObject(L"bounds"); const auto x = signed_integer(bounds.Lookup(L"x")), y = signed_integer(bounds.Lookup(L"y")), width = signed_integer(bounds.Lookup(L"w")), height = signed_integer(bounds.Lookup(L"h"));
    if (x && y && width && height && WindowsRect{*x, *y, *width, *height} == region) found.push_back(node);
  }
  require(found.size() == 1); return found.front();
}
JsonObject ref_args(const JsonObject& element) { JsonObject args; args.Insert(L"ref", element.Lookup(L"ref")); return args; }
JsonObject input_target(const WindowsTargetState& target) {
  JsonObject args; args.Insert(L"pid", JsonValue::CreateNumberValue(target.pid)); args.Insert(L"windowId", JsonValue::CreateStringValue(window_id(target.window))); return args;
}
JsonObject click_args(const WindowsTargetState& target, const Captured& frame) {
  auto args = input_target(target); const auto [x, y] = image_point(frame.receipt, target.button); args.Insert(L"captureId", JsonValue::CreateStringValue(frame.receipt.id)); args.Insert(L"x", JsonValue::CreateNumberValue(static_cast<double>(x))); args.Insert(L"y", JsonValue::CreateNumberValue(static_cast<double>(y))); args.Insert(L"button", JsonValue::CreateStringValue(L"left")); args.Insert(L"count", JsonValue::CreateNumberValue(1)); args.Insert(L"modifiers", JsonArray{}); return args;
}
bool running_target(const NativeReply& reply, DWORD pid, HWND window) {
  NativeScenario::success(reply);
  for (const auto& raw : reply.document.GetNamedArray(L"apps")) { const auto app = raw.GetObject(); if (number(app.GetNamedObject(L"identity"), L"pid") != pid) continue;
    for (const auto& item : app.GetNamedArray(L"windows")) if (item.GetObject().GetNamedString(L"windowId", L"") == window_id(window)) return true;
  }
  return false;
}
}

WindowsPrivilegedRunAuthority::WindowsPrivilegedRunAuthority(std::function<bool()> parent_current)
  : parent_current_(std::move(parent_current)) {}
bool WindowsPrivilegedRunAuthority::admit() noexcept {
  if (revoked_.load()) return false;
  bool live = false; try { live = parent_current_ && parent_current_(); } catch (...) {}
  if (!live) { revoke(); return false; }
  admitted_.store(true); return current();
}
bool WindowsPrivilegedRunAuthority::current() const noexcept {
  if (!admitted_.load() || revoked_.load()) return false;
  bool live = false; try { live = parent_current_ && parent_current_(); } catch (...) {}
  if (!live) revoked_.store(true);
  return live && !revoked_.load();
}
void WindowsPrivilegedRunAuthority::revoke() noexcept { revoked_.store(true); }

bool windows_privileged_reason(std::wstring_view reason) noexcept {
  static constexpr std::array reasons{L"isolation_required", L"elevated_helper", L"noninteractive_desktop", L"capture_blocked", L"input_detection_unavailable", L"foreground_unavailable", L"affinity_unavailable", L"target_not_installed", L"hardware_input_required", L"target_unavailable", L"target_validation_failed", L"target_spawn_failed", L"target_state_invalid", L"target_control_invalid", L"target_token_invalid", L"target_manifest_invalid", L"target_window_failed", L"target_report_failed", L"target_control_failed", L"target_exited", L"target_not_ready", L"assertion_failed", L"native_operation_failed", L"deadline_exceeded", L"cleanup_failed", L"dependency_failed", L"physical_takeover"};
  return std::find(reasons.begin(), reasons.end(), reason) != reasons.end();
}
bool windows_privileged_skip_reason(std::wstring_view reason) noexcept {
  static constexpr std::array reasons{L"isolation_required", L"elevated_helper", L"noninteractive_desktop", L"capture_blocked", L"input_detection_unavailable", L"foreground_unavailable", L"affinity_unavailable", L"target_not_installed", L"hardware_input_required", L"physical_takeover"};
  return std::find(reasons.begin(), reasons.end(), reason) != reasons.end();
}
bool WindowsPrivilegedReport::valid() const noexcept {
  if (checks.size() != windows_privileged_checks.size()) return false;
  for (size_t index = 0; index < checks.size(); ++index) if (checks[index].name != windows_privileged_checks[index] || (checks[index].ok && checks[index].skipped) ||
      (checks[index].skipped && !windows_privileged_skip_reason(checks[index].detail)) || (!checks[index].detail.empty() && !windows_privileged_reason(checks[index].detail))) return false;
  return true;
}
int WindowsPrivilegedReport::exit_code() const noexcept {
  if (!valid() || std::any_of(checks.begin(), checks.end(), [](const auto& check) { return !check.ok && !check.skipped; })) return 1;
  return std::any_of(checks.begin(), checks.end(), [](const auto& check) { return check.skipped; }) ? 77 : 0;
}
JsonObject WindowsPrivilegedReport::wire() const {
  JsonArray values; const bool coherent = valid();
  for (size_t index = 0; index < windows_privileged_checks.size(); ++index) {
    const auto check = coherent ? checks[index] : WindowsPrivilegedCheck{std::wstring(windows_privileged_checks[index]), false, false, L"native_operation_failed"};
    JsonObject value; value.Insert(L"name", JsonValue::CreateStringValue(check.name)); value.Insert(L"ok", JsonValue::CreateBooleanValue(check.ok)); if (check.skipped) value.Insert(L"skipped", JsonValue::CreateBooleanValue(true)); if (!check.detail.empty()) value.Insert(L"detail", JsonValue::CreateStringValue(check.detail)); values.Append(value);
  }
  JsonObject result; result.Insert(L"checks", values); return result;
}
void WindowsPrivilegedReport::skip_unrun(std::wstring_view reason) {
  if (!valid() || !windows_privileged_skip_reason(reason)) return;
  for (auto& check : checks) if (!check.ok && !check.skipped && check.detail == L"dependency_failed") {
    check.skipped = true; check.detail = reason;
  }
}
WindowsPrivilegedReport WindowsPrivilegedReport::skipped(std::wstring_view reason) {
  WindowsPrivilegedReport result; for (const auto name : windows_privileged_checks) result.checks.push_back({std::wstring(name), false, true, std::wstring(reason)}); return result;
}
WindowsPrivilegedReport run_windows_privileged_self_test(const Command& command, std::shared_ptr<HelperLifecycle>* lifetime) noexcept {
  WindowsPrivilegedReport report; for (const auto name : windows_privileged_checks) report.checks.push_back({std::wstring(name), false, false, L"dependency_failed"});
  std::shared_ptr<WindowsTargetClient> target; std::unique_ptr<NativeScenario> native;
  std::shared_ptr<HelperLifecycle> lifecycle;
  std::shared_ptr<WindowsPrivilegedRunAuthority> authority;
  std::shared_ptr<PrivilegedRunCleanup> cleanup;
  const auto finish_report = [&](WindowsPrivilegedReport completed) {
    if (cleanup) cleanup->revoke();
    if (lifetime) *lifetime = lifecycle;
    return completed;
  };
  const auto run = [&](size_t index, const auto& body) { try { body(); report.checks[index] = {std::wstring(windows_privileged_checks[index]), true, false, {}}; } catch (const ScenarioSkip& skip) { report.checks[index] = {std::wstring(windows_privileged_checks[index]), false, true, skip.reason}; } catch (const ScenarioFailure& failure) { report.checks[index] = {std::wstring(windows_privileged_checks[index]), false, false, failure.reason}; } catch (const Failure& failure) { report.checks[index] = {std::wstring(windows_privileged_checks[index]), false, false, windows_privileged_reason(failure.code) ? failure.code : L"native_operation_failed"}; } catch (...) { report.checks[index] = {std::wstring(windows_privileged_checks[index]), false, false, L"native_operation_failed"}; } };
  try {
    if (command.target.empty() || !lifetime) throw ScenarioFailure{L"target_validation_failed"};
    // No serving/stdio pipe exists in this mode. Hold the actual kernel parent/start witness and
    // arm its independent exit fuse before file hashes, Authenticode or target admission can stall.
    cleanup = std::make_shared<PrivilegedRunCleanup>();
    const auto parent = immediate_parent();
    lifecycle = std::make_shared<HelperLifecycle>(parent, [owned = cleanup](StopReason) { owned->revoke(); });
    const std::weak_ptr<HelperLifecycle> weak_lifecycle = lifecycle;
    const std::weak_ptr<PrivilegedRunCleanup> weak_cleanup = cleanup;
    authority = std::make_shared<WindowsPrivilegedRunAuthority>([weak_lifecycle, weak_cleanup] {
      const auto lifetime = weak_lifecycle.lock(); const auto owned = weak_cleanup.lock();
      return lifetime && owned && !owned->revoked.load() && !lifetime->stopping() && lifetime->parent_current();
    });
    cleanup->add([active = authority] { active->revoke(); });
    const auto authenticated = verify_parent(parent);
    if (!lifecycle->bind_parent(authenticated) || !authority->admit()) throw ScenarioFailure{L"target_validation_failed"};
    try { verify_windows_target_artifacts(command.target); } catch (...) { throw ScenarioFailure{L"target_validation_failed"}; }
    if (!authority->current()) throw ScenarioFailure{L"target_validation_failed"};
    // Artifact admission precedes every skip, and this explicit opt-in precedes every window/input.
    if (!isolated()) return finish_report(WindowsPrivilegedReport::skipped(L"isolation_required"));
    const auto availability = observe_windows_availability(WindowsAvailabilityBackend::system());
    if (!availability.helper) throw ScenarioFailure{L"native_operation_failed"};
    if (!windows_helper_may_serve(*availability.helper)) return finish_report(WindowsPrivilegedReport::skipped(L"elevated_helper"));
    if (!windows_desktop_available(availability.desktop)) return finish_report(WindowsPrivilegedReport::skipped(L"noninteractive_desktop"));
    if (!authority->current()) throw ScenarioFailure{L"target_validation_failed"};
    try { target = WindowsTargetClient::launch(command.target, [active = authority] { return active->current(); }); } catch (const Failure& failure) { throw ScenarioFailure{windows_privileged_reason(failure.code) ? failure.code : L"target_spawn_failed"}; } catch (...) { throw ScenarioFailure{L"target_spawn_failed"}; }
    cleanup->add([owned = target] { (void)owned->close(); });
    if (!authority->current()) throw ScenarioFailure{L"target_validation_failed"};
    const auto initial = target->request(); require(valid_windows_target_state(initial)); native = std::make_unique<NativeScenario>(initial, authority, cleanup);
    report.checks[0] = {std::wstring(windows_privileged_checks[0]), true, false, {}};
    run(1, [&] { require(running_target(native->request(L"apps.list", object(LR"({"installed":false})")), initial.pid, initial.window)); });
    run(2, [&] {
      require(running_target(native->request(L"apps.list", object(LR"({"installed":true})")), initial.pid, initial.window));
      const auto applications = WindowsBackend::system(windows_child_shell).list(true, [&] { return target->current(); });
      const auto found = std::find_if(applications.begin(), applications.end(), [&](const auto& app) { return app.owner && app.owner->process.pid == initial.pid && app.installed.has_value(); });
      if (found == applications.end()) throw ScenarioSkip{L"target_not_installed"};
      require(windows_file_current(*found->installed));
    });
    const bool input_ready = native->await_input();
    if (input_ready && GetForegroundWindow() != initial.window) {
      auto args = input_target(initial); args.Remove(L"pid"); (void)native->request(L"window.focus", native->phase(args));
    }
    run(3, [&] { if (windows_capture_blocked(availability)) throw ScenarioSkip{L"capture_blocked"}; const auto state = target->request(); require(color(capture(*native, state.window), state.patch, {32, 128, 192})); });
    run(4, [&] {
      if (windows_capture_blocked(availability)) throw ScenarioSkip{L"capture_blocked"}; const auto state = target->request(); if (!state.affinity) throw ScenarioSkip{L"affinity_unavailable"};
      target->request(WindowsTargetAction::show_excluded);
      try {
        const auto shown = target->request(); require(shown.excluded_visible); const auto session = native->session(); const auto frame = capture(*native, shown.window); require(color(frame, shown.patch, {32, 128, 192}));
        JsonObject args = object(LR"({"budget":{"maxWidth":1024,"maxHeight":1024,"maxPixels":1048576},"format":"png"})"); JsonObject selection; selection.Insert(L"display", JsonValue::CreateStringValue(frame.receipt.display_id)); args.Insert(L"target", selection);
        const auto response = native->request(L"capture", args); NativeScenario::success(response); const auto record = native->state->captures->receipt(response.document.GetNamedString(L"captureId"), session); const Captured display{record, decode_png(response.image)};
        require(color(display, shown.excluded_bounds, {32, 128, 192}));
      } catch (...) { target->request(WindowsTargetAction::hide_excluded); throw; }
      target->request(WindowsTargetAction::hide_excluded);
    });
    run(5, [&] {
      native->require_input(initial.window); const auto state = target->request(); const auto node = element(tree(*native, state), state.button, L"Button"); auto args = ref_args(node); args.Insert(L"action", JsonValue::CreateStringValue(L"Invoke")); NativeScenario::success(native->request(L"ui.perform", native->phase(args))); require(target->request().counter == state.counter + 1);
    });
    run(6, [&] {
      native->require_input(initial.window); const auto state = target->request(); const auto node = element(tree(*native, state), state.plain, L"Edit"); auto args = ref_args(node); args.Insert(L"value", JsonValue::CreateStringValue(L"Vector fixture value")); NativeScenario::success(native->request(L"ui.setValue", native->phase(args))); require(target->request().text == summarize_windows_target_text(L"Vector fixture value"));
      const auto fresh = element(tree(*native, target->request()), state.plain, L"Edit"); require(fresh.GetNamedString(L"value", L"") == L"Vector fixture value");
    });
    run(7, [&] {
      native->require_input(initial.window); const auto state = target->request(WindowsTargetAction::focus_secure); const auto node = element(tree(*native, state), state.secure, L"Edit"); require(node.GetNamedBoolean(L"secure", false) && !node.HasKey(L"value"));
      auto set = ref_args(node); set.Insert(L"value", JsonValue::CreateStringValue(L"refused fixture value")); require(NativeScenario::failure(native->request(L"ui.setValue", native->phase(set)), L"secure_field"));
      auto args = input_target(state); args.Insert(L"text", JsonValue::CreateStringValue(L"refused fixture text")); require(NativeScenario::failure(native->request(L"input.type", native->phase(args)), L"secure_field"));
      const auto after = target->request(); require(after.secret == state.secret && after.key_downs == state.key_downs && after.key_ups == state.key_ups);
      target->request(WindowsTargetAction::focus_plain);
    });
    run(8, [&] {
      native->require_input(initial.window); const auto state = target->request(); const auto frame = capture(*native, state.window); NativeScenario::success(native->request(L"input.click", native->phase(click_args(state, frame))));
      const auto after = target->request(); require(after.counter == state.counter + 1 && after.button_downs == state.button_downs + 1 && after.button_ups == state.button_ups + 1 && after.held_buttons == 0);
    });
    run(9, [&] {
      native->require_input(initial.window); auto state = target->request(); const auto node = element(tree(*native, state), state.plain, L"Edit"); auto set = ref_args(node); set.Insert(L"value", JsonValue::CreateStringValue(L"")); NativeScenario::success(native->request(L"ui.setValue", native->phase(set))); state = target->request(WindowsTargetAction::focus_plain);
      auto args = input_target(state); const std::wstring text = L"Vector \u00e9 \u03bb \U0001f680"; args.Insert(L"text", JsonValue::CreateStringValue(text)); NativeScenario::success(native->request(L"input.type", native->phase(args))); const auto after = target->request(); require(after.text == summarize_windows_target_text(text) && after.held_keys == 0 && after.key_downs > state.key_downs && after.key_ups > state.key_ups);
    });
    run(10, [&] {
      native->require_input(initial.window); const auto state = target->request(); const auto frame = capture(*native, state.window); const auto moved = target->request(WindowsTargetAction::move_window); require(moved.bounds != state.bounds);
      require(NativeScenario::failure(native->request(L"input.click", native->phase(click_args(state, frame))), L"stale_frame")); const auto after = target->request(); require(after.counter == state.counter && after.button_downs == state.button_downs);
    });
    run(11, [&] {
      native->require_input(initial.window); const auto before = target->request(WindowsTargetAction::focus_plain); auto args = input_target(before); JsonArray combo; combo.Append(JsonValue::CreateStringValue(L"shift")); combo.Append(JsonValue::CreateStringValue(L"arrowleft")); args.Insert(L"combo", combo); args.Insert(L"ms", JsonValue::CreateNumberValue(1000));
      const auto held = native->begin(L"input.hold", native->phase(args)); const auto deadline = GetTickCount64() + 500; bool observed = false;
      do { if (target->request().held_keys > 0) { observed = true; break; } std::this_thread::sleep_for(std::chrono::milliseconds(5)); } while (GetTickCount64() < deadline);
      require(observed); NativeScenario::success(native->request(L"cancel")); const auto interrupted = native->wait(held, 1000); require(!interrupted.document.GetNamedBoolean(L"ok", true));
      const auto after = target->request(); require(after.held_keys == 0 && after.held_buttons == 0 && after.key_ups > before.key_ups);
      const auto released = native->request(L"input.releaseAll"); NativeScenario::success(released); require(number(released.document, L"released") == 0);
    });
    run(12, [&] { if (!input_ready) throw ScenarioSkip{L"input_detection_unavailable"}; require(native->state->detector->foreground_ready(native->session())); });
    run(13, [&] { throw ScenarioSkip{L"hardware_input_required"}; });
  } catch (const ScenarioFailure& failure) { report.checks[0] = {std::wstring(windows_privileged_checks[0]), false, false, failure.reason}; }
  catch (const ScenarioSkip& skip) { report.skip_unrun(skip.reason); }
  catch (...) { report.checks[0] = {std::wstring(windows_privileged_checks[0]), false, false, L"native_operation_failed"}; }
  const bool native_closed = !native || native->close(); bool input_released = !target;
  if (target) try {
    const auto deadline = GetTickCount64() + 750;
    do { const auto observed = target->request(); if (observed.held_keys == 0 && observed.held_buttons == 0) { input_released = true; break; } std::this_thread::sleep_for(std::chrono::milliseconds(10)); } while (GetTickCount64() < deadline);
  } catch (...) {}
  const bool target_closed = !target || target->close(); const bool cleaned = native_closed && input_released && target_closed;
  report.checks.back() = {std::wstring(windows_privileged_checks.back()), cleaned, false, cleaned ? L"" : L"cleanup_failed"}; return finish_report(std::move(report));
}
}
