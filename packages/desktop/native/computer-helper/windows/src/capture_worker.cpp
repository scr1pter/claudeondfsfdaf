#include "capture_worker.h"
#include "availability.h"
#include "windows_process_tree.h"
#include <bcrypt.h>
#include <dwmapi.h>
#include <tlhelp32.h>
#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cstring>
#include <exception>
#include <limits>
#include <mutex>
#include <thread>
#include <winrt/base.h>

namespace vector::computer {
namespace {
[[noreturn]] void unavailable() { throw Failure{L"capture_unavailable", L"The isolated native capture could not be completed."}; }
void require(bool value) { if (!value) unavailable(); }
bool authority(const std::function<bool()>& current) noexcept {
  try { return current && current(); } catch (...) { return false; }
}
uint64_t created(HANDLE process) noexcept {
  FILETIME start{}, end{}, kernel{}, user{};
  if (!GetProcessTimes(process, &start, &end, &kernel, &user)) return 0;
  return (static_cast<uint64_t>(start.dwHighDateTime) << 32) | start.dwLowDateTime;
}
DWORD actual_parent() noexcept {
  winrt::handle snapshot{CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)};
  if (!snapshot || snapshot.get() == INVALID_HANDLE_VALUE) return 0;
  PROCESSENTRY32W entry{}; entry.dwSize = static_cast<DWORD>(sizeof(entry));
  if (!Process32FirstW(snapshot.get(), &entry)) return 0;
  size_t count = 0;
  do {
    if (++count > 65'536) return 0;
    if (entry.th32ProcessID == GetCurrentProcessId()) return entry.th32ParentProcessID;
  } while (Process32NextW(snapshot.get(), &entry));
  return 0;
}
std::wstring own_path() {
  std::wstring path(32'768, L'\0');
  const auto count = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
  require(count > 0 && count < path.size()); path.resize(count); return path;
}
WindowsRect frame_bounds(HWND window) {
  RECT bounds{};
  require(SUCCEEDED(DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS, &bounds, sizeof(bounds))));
  WindowsRect result{bounds.left, bounds.top, int64_t(bounds.right) - bounds.left, int64_t(bounds.bottom) - bounds.top};
  require(result.valid()); return result;
}
std::wstring nonce_text(const CaptureWorkerNonce& nonce) {
  constexpr wchar_t digits[] = L"0123456789abcdef";
  std::wstring text; text.reserve(nonce.size() * 2);
  for (const auto value : nonce) { text.push_back(digits[value >> 4]); text.push_back(digits[value & 15]); }
  return text;
}
std::optional<uint64_t> decimal(std::wstring_view value) noexcept {
  if (value.empty() || value.size() > 20 || value.front() == L'0') return {};
  uint64_t result = 0;
  for (const auto digit : value) {
    if (digit < L'0' || digit > L'9' || result > (std::numeric_limits<uint64_t>::max() - static_cast<uint64_t>(digit - L'0')) / 10) return {};
    result = result * 10 + static_cast<uint64_t>(digit - L'0');
  }
  return result;
}
std::optional<CaptureWorkerNonce> parse_nonce(std::wstring_view text) noexcept {
  if (text.size() != CaptureWorkerNonce{}.size() * 2) return {};
  const auto digit = [](wchar_t value) -> int {
    if (value >= L'0' && value <= L'9') return value - L'0';
    if (value >= L'a' && value <= L'f') return value - L'a' + 10;
    return -1;
  };
  CaptureWorkerNonce nonce{};
  for (size_t index = 0; index < nonce.size(); ++index) {
    const auto high = digit(text[index * 2]), low = digit(text[index * 2 + 1]);
    if (high < 0 || low < 0) return {};
    nonce[index] = static_cast<uint8_t>((high << 4) | low);
  }
  if (std::all_of(nonce.begin(), nonce.end(), [](auto value) { return value == 0; })) return {};
  return nonce;
}
struct View final {
  void* data = nullptr;
  View() = default;
  View(const View&) = delete;
  View& operator=(const View&) = delete;
  ~View() { if (data) (void)UnmapViewOfFile(data); }
  void map(HANDLE mapping, DWORD access, size_t bytes) {
    require(!data); data = MapViewOfFile(mapping, access, 0, 0, bytes); require(data != nullptr);
  }
  bool close() noexcept {
    if (!data) return true;
    const bool result = UnmapViewOfFile(data) != FALSE; data = nullptr; return result;
  }
};
// The private output header's aligned phase word doubles as a last-checkpoint hint
// while pending. It is never an acceptance/authority signal or a pixel read. A
// complete canonical header still replaces it, and only actual exit permits decoding.
volatile LONG* checkpoint_word(const View& view) noexcept {
  static_assert(sizeof(LONG) == 4 && 12 % alignof(LONG) == 0);
  return reinterpret_cast<volatile LONG*>(static_cast<uint8_t*>(view.data) + 12);
}
void checkpoint(const View& view, CaptureReadPhase phase) noexcept {
  (void)InterlockedExchange(checkpoint_word(view), static_cast<LONG>(phase));
}
struct FailedCheckpoint final {
  View& view; CaptureReadPhase& phase; int exceptions = std::uncaught_exceptions();
  ~FailedCheckpoint() {
    if (!view.data || std::uncaught_exceptions() <= exceptions) return;
    if (phase != CaptureReadPhase::window_worker_wait && phase != CaptureReadPhase::window_worker_exit) return;
    const auto value = static_cast<uint32_t>(InterlockedCompareExchange(checkpoint_word(view), 0, 0));
    if (const auto failed = capture_worker_failure_checkpoint(phase, value)) phase = *failed;
  }
};
winrt::handle duplicate(HANDLE source, DWORD rights, bool inherit) {
  HANDLE result = nullptr;
  require(DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), &result, rights, inherit ? TRUE : FALSE, 0) != FALSE);
  return winrt::handle{result};
}
winrt::handle mapping(size_t bytes) {
  require(bytes > 0 && bytes <= capture_worker_max_bytes + capture_worker_output_header_bytes);
  const auto size = static_cast<uint64_t>(bytes);
  winrt::handle result{CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE,
    static_cast<DWORD>(size >> 32), static_cast<DWORD>(size & 0xffffffffU), nullptr)};
  require(static_cast<bool>(result)); return result;
}

// The supervisor exists before launch/trust/COM can block. Only this call's held process
// and noninherited private job are terminated; no PID lookup is used for termination.
class ParentWatch final {
 public:
  ParentWatch(const CaptureWorkerDeadline& deadline, std::function<bool()> current)
    : deadline_(deadline), current_(std::move(current)), cancel_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {
    require(static_cast<bool>(cancel_));
    timer_ = std::thread([this] {
      while (!finished_.load()) {
        if (!this->current()) { revoke(); break; }
        std::unique_lock lock(wait_mutex_);
        condition_.wait_for(lock, std::chrono::milliseconds(1), [this] { return finished_.load(); });
      }
    });
  }
  ~ParentWatch() {
    revoke(); stop_timer();
    // No grace period is added to the acquisition. Closing the kill-on-close job also
    // owns failed/late teardown; an unsignaled process can never produce accepted pixels.
    reap();
  }
  bool current() noexcept {
    if (revoked_.load() || !capture_worker_deadline_current(deadline_) || !authority(current_)) {
      revoke(); return false;
    }
    if (revoked_.load() || !capture_worker_deadline_current(deadline_)) { revoke(); return false; }
    return true;
  }
  HANDLE cancel_event() const noexcept { return cancel_.get(); }
  void prepare_job() {
    require(current());
    winrt::handle job{CreateJobObjectW(nullptr, nullptr)}; require(static_cast<bool>(job));
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    require(SetInformationJobObject(job.get(), JobObjectExtendedLimitInformation, &limits, sizeof(limits)) != FALSE);
    std::lock_guard lock(process_mutex_); job_ = std::move(job);
    if (revoked_.load()) (void)TerminateJobObject(job_.get(), 1);
  }
  HANDLE job() const noexcept { return job_.get(); }
  void attach(HANDLE process) noexcept {
    std::lock_guard lock(process_mutex_); process_.attach(process);
    if (revoked_.load()) (void)TerminateProcess(process_.get(), 1);
  }
  void validate_and_resume(HANDLE thread) {
    require(current());
    std::lock_guard lock(process_mutex_);
    require(!revoked_.load() && capture_worker_deadline_current(deadline_) && job_ && process_);
    // Creation associated the job atomically: parent death cannot strand a suspended
    // process between CreateProcess and assignment, before its own watchdog can run.
    BOOL in_job = FALSE;
    require(IsProcessInJob(process_.get(), job_.get(), &in_job) != FALSE && in_job != FALSE);
    assigned_ = true;
    require(!revoked_.load() && capture_worker_deadline_current(deadline_));
    require(ResumeThread(thread) == 1);
  }
  HANDLE process() const noexcept { return process_.get(); }
  void revoke() noexcept {
    revoked_.store(true); if (cancel_) (void)SetEvent(cancel_.get());
    std::lock_guard lock(process_mutex_);
    if (job_) (void)TerminateJobObject(job_.get(), 1);
    if (process_ && !assigned_) (void)TerminateProcess(process_.get(), 1);
  }
  bool finish() noexcept {
    stop_timer();
    const bool exited = process_ && WaitForSingleObject(process_.get(), 0) == WAIT_OBJECT_0;
    require_noexcept_cleanup();
    return exited && !revoked_.load() && capture_worker_deadline_current(deadline_) && authority(current_) && capture_worker_deadline_current(deadline_);
  }
 private:
  void stop_timer() noexcept {
    finished_.store(true); condition_.notify_all();
    if (timer_.joinable()) timer_.join();
  }
  void reap() noexcept {
    if (process_) {
      while (capture_worker_deadline_current(deadline_) && WaitForSingleObject(process_.get(), 0) == WAIT_TIMEOUT) {
        const auto remaining = capture_worker_remaining_ms(deadline_);
        if (!remaining) break;
        (void)WaitForSingleObject(process_.get(), std::min<DWORD>(remaining, 1));
      }
    }
    require_noexcept_cleanup();
  }
  void require_noexcept_cleanup() noexcept {
    // The watcher has joined, so no concurrent use survives these handle releases.
    process_.close(); job_.close(); cancel_.close();
  }
  CaptureWorkerDeadline deadline_;
  std::function<bool()> current_;
  winrt::handle cancel_, job_, process_;
  std::thread timer_;
  std::atomic_bool revoked_{false}, finished_{false};
  std::mutex process_mutex_, wait_mutex_;
  std::condition_variable condition_;
  bool assigned_ = false;
};

// This child has no input obligations. Its own watchdog can terminate blocked setup or
// cleanup, while the independent parent accepts only actual normal exit within budget.
class ChildWatch final {
 public:
  ChildWatch(CaptureWorkerDeadline deadline, winrt::handle parent, winrt::handle cancel)
    : deadline_(deadline), parent_(std::move(parent)), cancel_(std::move(cancel)), done_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {
    require(parent_ && cancel_ && done_);
    timer_ = std::thread([this] {
      const HANDLE handles[]{done_.get(), parent_.get(), cancel_.get()};
      for (;;) {
        if (!capture_worker_deadline_current(deadline_)) break;
        const auto remaining = capture_worker_remaining_ms(deadline_);
        if (!remaining) break;
        const auto wait = WaitForMultipleObjects(3, handles, FALSE, std::min<DWORD>(remaining, 1));
        if (wait == WAIT_OBJECT_0) return;
        if (wait != WAIT_TIMEOUT) break;
      }
      revoked_.store(true);
      (void)TerminateProcess(GetCurrentProcess(), 1);
    });
  }
  ~ChildWatch() { (void)SetEvent(done_.get()); if (timer_.joinable()) timer_.join(); }
  HANDLE parent() const noexcept { return parent_.get(); }
  bool current() const noexcept {
    return !revoked_.load() && capture_worker_deadline_current(deadline_) &&
      WaitForSingleObject(parent_.get(), 0) == WAIT_TIMEOUT && WaitForSingleObject(cancel_.get(), 0) == WAIT_TIMEOUT &&
      capture_worker_deadline_current(deadline_);
  }
 private:
  CaptureWorkerDeadline deadline_;
  winrt::handle parent_, cancel_, done_;
  std::atomic_bool revoked_{false};
  std::thread timer_;
};
struct Apartment final {
  Apartment() { winrt::init_apartment(winrt::apartment_type::multi_threaded); }
  ~Apartment() { winrt::uninit_apartment(); }
};
CaptureWorkerParentFacts authenticate(const CaptureWorkerCommand& command, const CaptureWorkerRequest& request, const ChildWatch& watch) {
  require(watch.current() && actual_parent() == command.parent && request.parent_pid == command.parent);
  CaptureWorkerParentFacts facts;
  facts.expected_pid = command.parent; facts.actual_pid = actual_parent(); facts.expected_created = request.parent_created;
  facts.parent = observe_windows_process(command.parent);
  facts.child = observe_windows_process(GetCurrentProcessId());
  require(facts.parent.lease && facts.child.lease && watch.current());
  facts.same_parent_object = CompareObjectHandles(watch.parent(), facts.parent.lease->process_handle()) != FALSE;
  facts.parent_alive = WaitForSingleObject(facts.parent.lease->process_handle(), 0) == WAIT_TIMEOUT;
  facts.held_pid = GetProcessId(facts.parent.lease->process_handle()); facts.held_created = created(facts.parent.lease->process_handle());
  facts.child_pid = GetCurrentProcessId(); facts.child_created = created(GetCurrentProcess());
  require(capture_worker_parent_allowed(facts) && helper_install_root(facts.child.process.image.path).has_value());
  require(actual_parent() == command.parent && windows_owner_current(facts.parent) && windows_owner_current(facts.child) && watch.current());
  return facts;
}
void child_handle(HANDLE value) {
  DWORD flags = 0;
  require(value && value != INVALID_HANDLE_VALUE && GetHandleInformation(value, &flags) != FALSE && (flags & HANDLE_FLAG_INHERIT) != 0);
  require(SetHandleInformation(value, HANDLE_FLAG_INHERIT, 0) != FALSE);
}
}

std::optional<CaptureWorkerCommand> parse_capture_worker(std::span<const std::wstring> args) noexcept {
  if (args.size() != 13 || args[0] != L"--computer-capture-worker" || args[1] != L"--parent-pid" ||
      args[3] != L"--request-mapping" || args[5] != L"--output-mapping" || args[7] != L"--parent-witness" ||
      args[9] != L"--cancel-event" || args[11] != L"--capture-nonce") return {};
  const auto parent = decimal(args[2]), request = decimal(args[4]), output = decimal(args[6]), witness = decimal(args[8]), cancel = decimal(args[10]);
  const auto nonce = parse_nonce(args[12]);
  if (!parent || *parent > std::numeric_limits<DWORD>::max() || !request || !output || !witness || !cancel || !nonce) return {};
  const auto maximum = std::numeric_limits<uintptr_t>::max();
  if (*request >= maximum || *output >= maximum || *witness >= maximum || *cancel >= maximum ||
      *request == *output || *request == *witness || *request == *cancel || *output == *witness || *output == *cancel || *witness == *cancel) return {};
  return CaptureWorkerCommand{static_cast<DWORD>(*parent), static_cast<uintptr_t>(*request), static_cast<uintptr_t>(*output),
    static_cast<uintptr_t>(*witness), static_cast<uintptr_t>(*cancel), *nonce};
}

CaptureBitmap capture_window_isolated(const CaptureReadRequest& read, const CaptureWorkerDeadline& deadline,
    const std::function<bool()>& current, CaptureReadPhase& phase) {
  phase = CaptureReadPhase::window_worker_prepare;
  require(read.window && read.isolate_window && capture_worker_deadline_current(deadline) && authority(current));
  CaptureBitmap image;
  WindowsRect admitted_frame;
  {
    const auto target_current = [&read, &current] { return authority(current) && windows_window_current(*read.window); };
    ParentWatch watch(deadline, target_current);
    require(watch.current());
    // Keep this exact executing image locked against write/delete replacement throughout
    // launch and acceptance; matching two newly reopened paths is insufficient.
    const auto launcher = observe_windows_process(GetCurrentProcessId());
    require(windows_owner_current(launcher) && serving_token_allowed(launcher.process.token) &&
      helper_install_root(launcher.process.image.path).has_value() && watch.current());
    CaptureWorkerNonce nonce{};
    require(BCryptGenRandom(nullptr, nonce.data(), static_cast<ULONG>(nonce.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) >= 0);
    admitted_frame = frame_bounds(read.window->hwnd);
    const auto request = capture_worker_request(*read.window, admitted_frame, read.bounds,
      GetCurrentProcessId(), created(GetCurrentProcess()), nonce, deadline);
    require(request.has_value());
    const auto bytes = encode_capture_worker_request(*request); require(bytes.has_value());
    const size_t output_bytes = capture_worker_output_header_bytes + static_cast<size_t>(request->extent.bytes);
    auto request_map = mapping(capture_worker_request_bytes), output_map = mapping(output_bytes);
    View request_view; request_view.map(request_map.get(), FILE_MAP_WRITE, capture_worker_request_bytes);
    std::memcpy(request_view.data, bytes->data(), bytes->size()); require(request_view.close());
    View output_view; output_view.map(output_map.get(), FILE_MAP_READ | FILE_MAP_WRITE, output_bytes);
    FailedCheckpoint failed_checkpoint{output_view, phase};
    CaptureWorkerOutput pending; pending.nonce = request->nonce; pending.binding = request->target.binding; pending.extent = request->extent;
    const auto pending_bytes = encode_capture_worker_output(pending); require(pending_bytes.has_value());
    std::memcpy(output_view.data, pending_bytes->data(), pending_bytes->size());
    auto child_request = duplicate(request_map.get(), SECTION_MAP_READ, true);
    auto child_output = duplicate(output_map.get(), SECTION_MAP_READ | SECTION_MAP_WRITE, true);
    auto child_parent = duplicate(GetCurrentProcess(), SYNCHRONIZE, true);
    auto child_cancel = duplicate(watch.cancel_event(), SYNCHRONIZE, true);
    SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    winrt::handle null{CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
      &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr)};
    require(null && null.get() != INVALID_HANDLE_VALUE);
    watch.prepare_job(); require(watch.current());
    SIZE_T attribute_bytes = 0;
    (void)InitializeProcThreadAttributeList(nullptr, 2, 0, &attribute_bytes);
    require(attribute_bytes > 0 && attribute_bytes <= 65'536);
    std::vector<uint8_t> attributes_buffer(attribute_bytes);
    const auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes_buffer.data());
    require(InitializeProcThreadAttributeList(attributes, 2, 0, &attribute_bytes) != FALSE);
    struct DeleteAttributes { LPPROC_THREAD_ATTRIBUTE_LIST value; ~DeleteAttributes() { DeleteProcThreadAttributeList(value); } } attributes_cleanup{attributes};
    HANDLE inherited[]{child_request.get(), child_output.get(), child_parent.get(), child_cancel.get(), null.get()};
    require(UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), nullptr, nullptr) != FALSE);
    HANDLE jobs[]{watch.job()};
    require(UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, jobs, sizeof(jobs), nullptr, nullptr) != FALSE);
    const auto path = own_path();
    std::wstring command = L"\"" + path + L"\" --computer-capture-worker --parent-pid " + std::to_wstring(GetCurrentProcessId()) +
      L" --request-mapping " + std::to_wstring(reinterpret_cast<uintptr_t>(child_request.get())) +
      L" --output-mapping " + std::to_wstring(reinterpret_cast<uintptr_t>(child_output.get())) +
      L" --parent-witness " + std::to_wstring(reinterpret_cast<uintptr_t>(child_parent.get())) +
      L" --cancel-event " + std::to_wstring(reinterpret_cast<uintptr_t>(child_cancel.get())) + L" --capture-nonce " + nonce_text(nonce);
    command.push_back(L'\0');
    STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup); startup.lpAttributeList = attributes;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = null.get(); startup.StartupInfo.hStdOutput = null.get(); startup.StartupInfo.hStdError = null.get();
    PROCESS_INFORMATION process{};
    phase = CaptureReadPhase::window_worker_start; require(windows_owner_current(launcher) && watch.current());
    require(CreateProcessW(path.c_str(), command.data(), nullptr, nullptr, TRUE,
      EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW | CREATE_SUSPENDED, nullptr, nullptr, &startup.StartupInfo, &process) != FALSE);
    watch.attach(process.hProcess); winrt::handle thread{process.hThread};
    // A late launch is still suspended. Attach/cleanup owns it; it cannot begin capture.
    require(watch.current()); watch.validate_and_resume(thread.get()); thread.close();
    child_request.close(); child_output.close(); child_parent.close(); child_cancel.close(); null.close();
    phase = CaptureReadPhase::window_worker_wait;
    for (;;) {
      require(watch.current());
      const auto wait = WaitForSingleObject(watch.process(), std::min<DWORD>(capture_worker_remaining_ms(deadline), 1));
      if (wait == WAIT_OBJECT_0) break;
      require(wait == WAIT_TIMEOUT);
    }
    phase = CaptureReadPhase::window_worker_exit;
    DWORD exit = 1; require(GetExitCodeProcess(watch.process(), &exit) != FALSE && exit != STILL_ACTIVE && watch.current());
    phase = CaptureReadPhase::window_worker_reply;
    const auto output = decode_capture_worker_output(std::span(static_cast<const uint8_t*>(output_view.data), capture_worker_output_header_bytes));
    require(output.has_value());
    if (exit != 0 && output->status == CaptureWorkerStatus::failed && output->nonce == request->nonce &&
        output->binding == request->target.binding && output->extent == request->extent &&
        output->phase != CaptureReadPhase::none && output->phase < CaptureReadPhase::count) phase = output->phase;
    require(capture_worker_accept(*request, *output, output_bytes, true, exit, watch.current()));
    require(frame_bounds(read.window->hwnd) == request->target.frame && watch.current());
    image.width = output->extent.width; image.height = output->extent.height;
    const auto pixels = static_cast<const uint8_t*>(output_view.data) + capture_worker_output_header_bytes;
    image.bgra.assign(pixels, pixels + output->extent.bytes);
    require(image.valid() && frame_bounds(read.window->hwnd) == request->target.frame && windows_owner_current(launcher) && watch.current());
    phase = CaptureReadPhase::window_worker_cleanup;
    SecureZeroMemory(static_cast<uint8_t*>(output_view.data) + capture_worker_output_header_bytes, request->extent.bytes);
    require(output_view.close()); output_map.close(); request_map.close();
    require(watch.finish());
  }
  phase = CaptureReadPhase::window_worker_deadline;
  require(capture_worker_deadline_current(deadline) && authority(current) && windows_window_current(*read.window) &&
    frame_bounds(read.window->hwnd) == admitted_frame && capture_worker_deadline_current(deadline));
  return image;
}

int run_capture_worker(const CaptureWorkerCommand& command) noexcept {
  View output_view;
  std::optional<CaptureWorkerRequest> request;
  CaptureReadPhase phase = CaptureReadPhase::window_worker_prepare;
  try {
    require(command.parent && command.parent != GetCurrentProcessId());
    const HANDLE handles[]{reinterpret_cast<HANDLE>(command.request_mapping), reinterpret_cast<HANDLE>(command.output_mapping),
      reinterpret_cast<HANDLE>(command.parent_witness), reinterpret_cast<HANDLE>(command.cancel_event)};
    for (size_t index = 0; index < std::size(handles); ++index) {
      for (size_t before = 0; before < index; ++before) require(handles[index] != handles[before]);
      require(handles[index] != GetStdHandle(STD_INPUT_HANDLE) && handles[index] != GetStdHandle(STD_OUTPUT_HANDLE) && handles[index] != GetStdHandle(STD_ERROR_HANDLE));
      child_handle(handles[index]);
    }
    winrt::handle request_map{handles[0]}, output_map{handles[1]}, parent{handles[2]}, cancel{handles[3]};
    View request_view; request_view.map(request_map.get(), FILE_MAP_READ, capture_worker_request_bytes);
    request = decode_capture_worker_request(std::span(static_cast<const uint8_t*>(request_view.data), capture_worker_request_bytes));
    require(request && request->nonce == command.nonce && request->parent_pid == command.parent && capture_worker_deadline_current(request->deadline));
    require(request_view.close()); request_map.close();
    ChildWatch watch(request->deadline, std::move(parent), std::move(cancel));
    const auto current = [&watch] { return watch.current(); };
    const size_t output_bytes = capture_worker_output_header_bytes + static_cast<size_t>(request->extent.bytes);
    output_view.map(output_map.get(), FILE_MAP_READ | FILE_MAP_WRITE, output_bytes);
    checkpoint(output_view, phase);
    {
      // No apartment, trust, token, package, WGC or GPU setup precedes the watchdog.
      Apartment apartment;
      phase = CaptureReadPhase::window_worker_auth;
      checkpoint(output_view, phase);
      const auto authenticated = authenticate(command, *request, watch);
      require(watch.current());
      phase = CaptureReadPhase::window_worker_target; checkpoint(output_view, phase);
      // The never-shipped driver also re-enters this exact private mode. Its normal
      // driver setup has not run; establish only this worker thread's physical geometry.
      require(SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) != nullptr);
      require(AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) != FALSE && watch.current());
      auto target = WindowsBackend::system(windows_child_shell).observe(reinterpret_cast<HWND>(static_cast<uintptr_t>(request->target.root_hwnd)));
      require(watch.current() && capture_worker_target_matches(request->target, target, frame_bounds(target.hwnd)));
      const auto available = observe_windows_availability(WindowsAvailabilityBackend::system());
      require_windows_capture(available, &target.owner.process.token); require_windows_capture(available, &target.physical_owner.process.token);
      require(windows_window_current(target) && watch.current());
      CaptureReadRequest read{request->target.crop, target, true};
      phase = CaptureReadPhase::window_worker_read; checkpoint(output_view, phase);
      auto image = capture_worker_window_bitmap(read, request->deadline, current, phase);
      checkpoint(output_view, CaptureReadPhase::window_worker_reply);
      require(image.valid() && image.width == request->extent.width && image.height == request->extent.height && image.bgra.size() == request->extent.bytes);
      require(watch.current() && windows_owner_current(authenticated.parent) && windows_owner_current(authenticated.child) &&
        windows_window_current(target) && capture_worker_target_matches(request->target, target, frame_bounds(target.hwnd)) && watch.current());
      std::memcpy(static_cast<uint8_t*>(output_view.data) + capture_worker_output_header_bytes, image.bgra.data(), image.bgra.size());
      SecureZeroMemory(image.bgra.data(), image.bgra.size()); image = {};
      require(watch.current());
      CaptureWorkerOutput output; output.status = CaptureWorkerStatus::complete; output.nonce = request->nonce;
      output.binding = request->target.binding; output.extent = request->extent;
      checkpoint(output_view, CaptureReadPhase::window_worker_cleanup);
      const auto bytes = encode_capture_worker_output(output); require(bytes.has_value());
      // Header is committed only after pixels and native WGC cleanup. Parent accepts neither
      // before actual exit; only the closed failure checkpoint may be inspected earlier.
      std::memcpy(output_view.data, bytes->data(), bytes->size());
      require(output_view.close()); output_map.close();
      require(watch.current());
    }
    require(watch.current());
    return 0;
  } catch (...) {
    if (output_view.data && request) {
      CaptureWorkerOutput output; output.status = CaptureWorkerStatus::failed; output.phase = phase;
      output.nonce = request->nonce; output.binding = request->target.binding; output.extent = request->extent;
      if (const auto bytes = encode_capture_worker_output(output)) std::memcpy(output_view.data, bytes->data(), bytes->size());
    }
    return 1;
  }
}
}
