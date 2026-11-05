#include "core.h"
#include "identity.h"
#include "protocol.h"
#include "lifecycle.h"
#include "caller_desktop.h"
#include <tlhelp32.h>
#include <algorithm>
#include <array>
#include <cstdint>
#include <filesystem>
#include <limits>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace vector::computer {
namespace {
void require_integration(bool value, const char* label) { if (!value) throw std::runtime_error(label); }
void desktop_security_boundaries() {
  namespace fixture = caller_desktop;
  require_integration(fixture::may_isolate(fixture::Access::denied) && !fixture::may_isolate(fixture::Access::unknown) &&
    !fixture::may_isolate(fixture::Access::allowed), "integration.desktop-denial-only-isolation");
  TokenIdentity token;
  const auto sid = [](const wchar_t* text) {
    PSID raw = nullptr;
    require_integration(ConvertStringSidToSidW(text, &raw) != FALSE, "integration.desktop-test-sid");
    fixture::Local close{raw};
    std::vector<unsigned char> value(GetLengthSid(raw));
    require_integration(CopySid(static_cast<DWORD>(value.size()), value.data(), raw) != FALSE, "integration.desktop-test-sid");
    return value;
  };
  token.user = sid(L"S-1-5-21-1-2-3-1001"); token.logon = sid(L"S-1-5-5-11-12");
  const auto user = fixture::sid_text(token.user), logon = fixture::sid_text(token.logon);
  const auto valid = [&](const std::wstring& text) {
    PSECURITY_DESCRIPTOR raw = nullptr;
    require_integration(ConvertStringSecurityDescriptorToSecurityDescriptorW(text.c_str(), SDDL_REVISION_1, &raw, nullptr) != FALSE,
      "integration.desktop-test-descriptor");
    fixture::Local close{raw};
    return fixture::descriptor_matches(raw, token, fixture::desktop_all);
  };
  const auto dacl = L"(A;;GA;;;" + user + L")(A;;GA;;;" + logon + L")";
  require_integration(valid(L"O:" + user + L"D:P" + dacl + L"S:(ML;;NW;;;ME)"), "integration.desktop-exact-security");
  require_integration(!valid(L"O:" + user + L"D:P" + dacl + L"(A;;GA;;;WD)S:(ML;;NW;;;ME)"), "integration.desktop-no-broad-acl");
  require_integration(!valid(L"O:" + user + L"D:" + dacl + L"S:(ML;;NW;;;ME)"), "integration.desktop-protected-acl");
  require_integration(!valid(L"O:SYD:P" + dacl + L"S:(ML;;NW;;;ME)"), "integration.desktop-exact-owner");
  require_integration(!valid(L"O:" + user + L"D:P" + dacl + L"S:(ML;;NW;;;HI)") && !valid(L"O:" + user + L"D:P" + dacl),
    "integration.desktop-medium-label-required");
}
std::wstring wide(std::string_view value) { const auto text = winrt::to_hstring(value); return {text.c_str(), text.size()}; }
std::filesystem::path own_directory() {
  std::wstring path(32'768, L'\0');
  const auto length = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
  require_integration(length > 0 && length < path.size(), "integration.unit-image");
  path.resize(length);
  return std::filesystem::canonical(path).parent_path();
}
bool same_path(const std::wstring& left, const std::wstring& right) {
  return left.size() < 32'768 && right.size() < 32'768 &&
    CompareStringOrdinal(left.c_str(), static_cast<int>(left.size()), right.c_str(), static_cast<int>(right.size()), TRUE) == CSTR_EQUAL;
}
uint64_t process_created(HANDLE process) {
  FILETIME created{}, exited{}, kernel{}, user{};
  require_integration(GetProcessTimes(process, &created, &exited, &kernel, &user) != FALSE, "integration.process-creation-witness");
  const auto value = (uint64_t(created.dwHighDateTime) << 32) | created.dwLowDateTime;
  require_integration(value > 0, "integration.process-creation-nonzero");
  return value;
}
DWORD parent_pid(DWORD process) {
  winrt::handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  require_integration(snapshot && snapshot.get() != INVALID_HANDLE_VALUE, "integration.ancestry-snapshot");
  PROCESSENTRY32W entry{}; entry.dwSize = static_cast<DWORD>(sizeof(entry));
  require_integration(Process32FirstW(snapshot.get(), &entry) != FALSE, "integration.ancestry-first");
  size_t count = 0;
  do {
    require_integration(++count <= 65'536, "integration.ancestry-bound");
    if (entry.th32ProcessID == process) return entry.th32ParentProcessID;
  } while (Process32NextW(snapshot.get(), &entry));
  throw std::runtime_error("integration.ancestry-missing");
}

struct FixtureFiles {
  std::filesystem::path root;
  std::filesystem::path caller;
  std::filesystem::path helper;
  FixtureFiles() {
    const auto source = own_directory();
    const auto caller_source = source / L"VectorComputerCaller.exe";
    require_integration(std::filesystem::is_regular_file(caller_source), "integration.caller-artifact");
    std::filesystem::path helper_source;
    for (const auto& directory : {source, source.parent_path()}) {
      const auto candidate = directory / wide(identity::kExecutable);
      if (std::filesystem::is_regular_file(candidate)) { helper_source = std::filesystem::canonical(candidate); break; }
    }
    require_integration(!helper_source.empty(), "integration.helper-artifact");
    std::wstring temporary(32'768, L'\0');
    const auto length = GetTempPathW(static_cast<DWORD>(temporary.size()), temporary.data());
    require_integration(length > 0 && length < temporary.size(), "integration.temporary-directory");
    temporary.resize(length);
    for (unsigned attempt = 0; attempt < 32; ++attempt) {
      const auto candidate = std::filesystem::path(temporary) / (L"vector-computer-w2-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64()) + L"-" + std::to_wstring(attempt));
      if (CreateDirectoryW(candidate.c_str(), nullptr)) { root = std::filesystem::canonical(candidate); break; }
      require_integration(GetLastError() == ERROR_ALREADY_EXISTS, "integration.temporary-create");
    }
    require_integration(!root.empty(), "integration.temporary-unique");
    caller = root / wide(identity::kChannels[0].windowsExecutable);
    helper = root / L"resources" / L"computer" / wide(identity::kExecutable);
    std::filesystem::create_directories(helper.parent_path());
    require_integration(CopyFileW(caller_source.c_str(), caller.c_str(), TRUE) != FALSE &&
      CopyFileW(helper_source.c_str(), helper.c_str(), TRUE) != FALSE, "integration.copy-unchanged-artifacts");
  }
  ~FixtureFiles() {
    // Parent death is the cleanup signal even on failed tests. Never job-kill a helper before release.
    for (unsigned attempt = 0; attempt < 100; ++attempt) {
      std::error_code error;
      std::filesystem::remove_all(root, error);
      if (!error) break;
      Sleep(10);
    }
  }
};

class Child {
 public:
  winrt::handle process;
  winrt::handle input;
  winrt::handle output;
  winrt::handle diagnostic;
  std::string diagnostic_line;
  size_t diagnostic_bytes = 0;
  bool diagnostic_overflow = false, diagnostic_forwarded = false, helper_diagnostic_forwarded = false, context_forwarded = false;
  explicit Child(const std::filesystem::path& caller, bool test_elevated_token = false) {
    SECURITY_ATTRIBUTES security{static_cast<DWORD>(sizeof(SECURITY_ATTRIBUTES)), nullptr, TRUE};
    HANDLE read = nullptr;
    HANDLE write = nullptr;
    require_integration(CreatePipe(&read, &write, &security, 0) != FALSE, "integration.stdin-pipe");
    winrt::handle child_input(read); input.attach(write);
    require_integration(SetHandleInformation(input.get(), HANDLE_FLAG_INHERIT, 0) != FALSE, "integration.stdin-private");
    require_integration(CreatePipe(&read, &write, &security, 0) != FALSE, "integration.stdout-pipe");
    output.attach(read); winrt::handle child_output(write);
    require_integration(SetHandleInformation(output.get(), HANDLE_FLAG_INHERIT, 0) != FALSE, "integration.stdout-private");
    require_integration(CreatePipe(&read, &write, &security, 0) != FALSE, "integration.stderr-pipe");
    diagnostic.attach(read); winrt::handle error(write);
    require_integration(SetHandleInformation(diagnostic.get(), HANDLE_FLAG_INHERIT, 0) != FALSE, "integration.stderr-private");
    SIZE_T count = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &count);
    require_integration(count > 0 && count <= 65'536, "integration.attribute-size");
    std::vector<unsigned char> storage(count);
    const auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
    require_integration(InitializeProcThreadAttributeList(attributes, 1, 0, &count) != FALSE, "integration.attribute-init");
    struct Cleanup { LPPROC_THREAD_ATTRIBUTE_LIST value; ~Cleanup() { DeleteProcThreadAttributeList(value); } } cleanup{attributes};
    std::array<HANDLE, 3> handles{child_input.get(), child_output.get(), error.get()};
    require_integration(UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles.data(), sizeof(handles), nullptr, nullptr) != FALSE, "integration.restricted-handles");
    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = static_cast<DWORD>(sizeof(startup));
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = child_input.get(); startup.StartupInfo.hStdOutput = child_output.get(); startup.StartupInfo.hStdError = error.get();
    startup.lpAttributeList = attributes;
    PROCESS_INFORMATION child{};
    auto command = L"\"" + caller.wstring() + L"\" --stdio" + (test_elevated_token ? L" --test-elevated-token" : L"");
    require_integration(CreateProcessW(caller.c_str(), command.data(), nullptr, nullptr, TRUE, EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW,
      nullptr, nullptr, &startup.StartupInfo, &child) != FALSE, "integration.caller-create");
    process.attach(child.hProcess);
    winrt::handle thread(child.hThread);
  }
  ~Child() {
    input.close();
    if (process && WaitForSingleObject(process.get(), 1000) == WAIT_TIMEOUT) {
      // Only the caller is terminated; its helper gets the normal parent-death cleanup grace.
      TerminateProcess(process.get(), 1);
      WaitForSingleObject(process.get(), 1000);
    }
  }
  void send(std::string_view body) {
    const auto bytes = frame_bytes({reinterpret_cast<const uint8_t*>(body.data()), body.size()});
    require_integration(bytes.size() <= 4096, "integration.request-bound");
    DWORD written = 0;
    require_integration(WriteFile(input.get(), bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr) != FALSE && written == bytes.size(), "integration.request-write");
  }
  void forward_caller_failure() {
    if ((diagnostic_forwarded && helper_diagnostic_forwarded && context_forwarded) || diagnostic_bytes >= 192) return;
    DWORD available = 0;
    if (!PeekNamedPipe(diagnostic.get(), nullptr, 0, nullptr, &available, nullptr) || !available) return;
    std::array<char, 192> bytes{};
    const auto count = std::min<DWORD>(available, static_cast<DWORD>(bytes.size() - diagnostic_bytes));
    DWORD received = 0;
    if (!ReadFile(diagnostic.get(), bytes.data(), count, &received, nullptr) || !received || received > count) return;
    diagnostic_bytes += received;
    constexpr std::array<std::string_view, 45> stages{"layout-image", "layout-name", "layout-self-ancestors", "layout-helper-ancestors",
      "layout-self-file", "layout-helper-file", "layout-install-root", "arguments", "parent-witness", "apartment", "token", "layout", "ancestors",
      "medium-admission", "restricted-token", "bootstrap-launch", "bootstrap-current", "child-exit", "final-current", "helper-launch", "console-control",
      "bootstrap-child-exit-failure", "helper-child-exit-failure", "bootstrap-child-exit-usage", "helper-child-exit-usage",
      "bootstrap-child-exit-access-violation", "helper-child-exit-access-violation", "bootstrap-child-exit-stack-overflow", "helper-child-exit-stack-overflow", "bootstrap-child-exit-dll-missing", "helper-child-exit-dll-missing",
      "bootstrap-child-exit-dll-initialization", "helper-child-exit-dll-initialization", "bootstrap-child-exit-fast-fail", "helper-child-exit-fast-fail",
      "bootstrap-child-exit-invalid-parameter", "helper-child-exit-invalid-parameter", "bootstrap-child-exit-other", "helper-child-exit-other",
      "desktop-observation", "desktop-access", "desktop-private-security", "desktop-private-station", "desktop-private-default", "desktop-private-access"};
    for (DWORD index = 0; index < received; ++index) {
      const auto value = bytes[index];
      if (value != '\n') {
        if (diagnostic_line.size() < 96) diagnostic_line.push_back(value);
        else diagnostic_overflow = true;
        continue;
      }
      if (!diagnostic_overflow) {
        if (!diagnostic_line.empty() && diagnostic_line.back() == '\r') diagnostic_line.pop_back();
        if (!context_forwarded) for (const auto route : {"serving", "linked", "restricted"}) for (const auto desktop : {"parent", "owned"})
          for (const auto owner : {'u', 'x', 'n'}) for (const auto access : {'g', 'd', 'n'}) {
          const auto fixed = std::string("vector-caller-context initial r=") + route + " d=" + desktop + " o=" + owner + " a=" + access;
          if (diagnostic_line == fixed) {
            context_forwarded = true;
            (void)write_utf8(GetStdHandle(STD_ERROR_HANDLE), fixed + "\n");
          }
        }
        for (const auto mode : {"initial.", "medium."}) for (const auto stage : stages)
          for (const auto route : {"", " r=serving", " r=linked", " r=restricted"}) for (const auto desktop : {"", " d=parent", " d=owned"}) {
          if (!*route && *desktop) continue;
          const auto fixed = std::string("vector-caller-failure ") + mode + std::string(stage) + route + desktop;
          if (!diagnostic_forwarded && diagnostic_line == fixed) {
            diagnostic_forwarded = true;
            // This is an allowlisted fixed line, never the private diagnostic stream.
            (void)write_utf8(GetStdHandle(STD_ERROR_HANDLE), fixed + "\n");
          }
        }
        if (!helper_diagnostic_forwarded) for (const auto fixed : {"The computer helper could not start safely.", "The helper process token could not be read."}) {
          if (diagnostic_line == fixed) {
            helper_diagnostic_forwarded = true;
            (void)write_utf8(GetStdHandle(STD_ERROR_HANDLE), std::string(fixed) + "\n");
          }
        }
      }
      diagnostic_line.clear(); diagnostic_overflow = false;
    }
  }
  JsonObject receive() {
    std::vector<uint8_t> bytes;
    std::optional<size_t> length;
    const auto start = GetTickCount64();
    while (!length || bytes.size() < *length + 4) {
      require_integration(GetTickCount64() - start < 10'000, "integration.reply-deadline");
      forward_caller_failure();
      DWORD available = 0;
      const auto peeked = PeekNamedPipe(output.get(), nullptr, 0, nullptr, &available, nullptr);
      if (!peeked) forward_caller_failure();
      require_integration(peeked != FALSE, "integration.reply-pipe");
      if (available == 0) { Sleep(5); continue; }
      std::array<uint8_t, 4096> buffer{};
      DWORD received = 0;
      require_integration(ReadFile(output.get(), buffer.data(), std::min<DWORD>(available, static_cast<DWORD>(buffer.size())), &received, nullptr) != FALSE && received > 0, "integration.reply-read");
      bytes.insert(bytes.end(), buffer.begin(), buffer.begin() + received);
      require_integration(bytes.size() <= 65'536, "integration.reply-bound");
      if (!length && bytes.size() >= 4) {
        size_t size = 0;
        for (size_t index = 0; index < 4; ++index) size = (size << 8) | bytes[index];
        require_integration(size > 0 && size <= 65'532, "integration.reply-frame-bound");
        length = size;
      }
    }
    require_integration(bytes.size() == *length + 4, "integration.reply-single-frame");
    return JsonObject::Parse(winrt::to_hstring(std::string_view(reinterpret_cast<const char*>(bytes.data() + 4), *length)));
  }
  void hello() {
    send(R"({"id":1,"op":"hello","protocol":{"min":1,"max":1}})");
    const auto result = receive();
    require_integration(result.GetNamedNumber(L"id") == 1 && result.GetNamedBoolean(L"ok") && result.GetNamedBoolean(L"responsible"), "integration.actual-responsible-hello");
    const auto helper = result.GetNamedObject(L"helper");
    require_integration(helper.GetNamedString(L"platform") == L"windows" && helper.GetNamedString(L"arch") == winrt::to_hstring(architecture()) &&
      helper.GetNamedString(L"version") == winrt::to_hstring(identity::kHelperVersion), "integration.actual-helper-identity");
    const auto permission = result.GetNamedObject(L"permissions");
    require_integration(permission.GetNamedString(L"screen") == L"n/a" && permission.GetNamedString(L"accessibility") == L"n/a", "integration.windows-permissions");
    const auto features = result.GetNamedObject(L"features");
    for (const auto& feature : features) require_integration(feature.Value().ValueType() == JsonValueType::Boolean, "integration.boolean-feature-contract");
    require_integration((!features.HasKey(L"background") || !features.GetNamedBoolean(L"background")) &&
      (!features.HasKey(L"clipboard") || !features.GetNamedBoolean(L"clipboard")), "integration.windows-permanent-feature-limits");
  }
};

winrt::handle held_helper(const FixtureFiles& files, HANDLE caller) {
  const auto caller_id = GetProcessId(caller);
  const auto caller_created = process_created(caller);
  require_integration(caller_id != 0 && WaitForSingleObject(caller, 0) == WAIT_TIMEOUT, "integration.caller-alive-witness");
  const auto& expected = files.helper;
  const auto filename = expected.filename().wstring();
  winrt::handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  require_integration(snapshot && snapshot.get() != INVALID_HANDLE_VALUE, "integration.process-snapshot");
  PROCESSENTRY32W entry{}; entry.dwSize = static_cast<DWORD>(sizeof(entry));
  require_integration(Process32FirstW(snapshot.get(), &entry) != FALSE, "integration.process-first");
  size_t count = 0;
  do {
    require_integration(++count <= 65'536, "integration.process-bound");
    if (!same_path(entry.szExeFile, filename)) continue;
    winrt::handle process(OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, entry.th32ProcessID));
    if (!process) continue;
    std::wstring path(32'768, L'\0');
    DWORD length = static_cast<DWORD>(path.size());
    if (!QueryFullProcessImageNameW(process.get(), 0, path.data(), &length) || length == 0 || length >= path.size()) continue;
    path.resize(length);
    if (!same_path(path, expected.wstring())) continue;
    const auto helper_created = process_created(process.get());
    require_integration(helper_created >= caller_created && WaitForSingleObject(process.get(), 0) == WAIT_TIMEOUT, "integration.helper-alive-witness");
    const auto actual_parent = parent_pid(GetProcessId(process.get()));
    if (actual_parent != caller_id) {
      winrt::handle medium(OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, actual_parent));
      require_integration(medium && WaitForSingleObject(medium.get(), 0) == WAIT_TIMEOUT && parent_pid(actual_parent) == caller_id, "integration.medium-parent-chain");
      path.assign(32'768, L'\0');
      DWORD parent_length = static_cast<DWORD>(path.size());
      require_integration(QueryFullProcessImageNameW(medium.get(), 0, path.data(), &parent_length) != FALSE && parent_length > 0 && parent_length < path.size(), "integration.medium-parent-image");
      path.resize(parent_length);
      const auto medium_created = process_created(medium.get());
      require_integration(same_path(path, files.caller.wstring()) && medium_created >= caller_created && medium_created <= helper_created, "integration.medium-parent-witness");
    }
    return process;
  } while (Process32NextW(snapshot.get(), &entry));
  throw std::runtime_error("integration.actual-helper-witness");
}

void check_lifecycle(const FixtureFiles& files, bool parent_death) {
  Child child(files.caller); child.hello();
  auto helper = held_helper(files, child.process.get());
  // Startup, token setup, enumeration and held HANDLE acquisition all precede the timed trigger.
  const auto start = GetTickCount64();
  if (parent_death) require_integration(TerminateProcess(child.process.get(), 0) != FALSE, "integration.kill-actual-caller");
  else child.input.close();
  require_integration(WaitForSingleObject(helper.get(), 1000) == WAIT_OBJECT_0 && GetTickCount64() - start <= 1000,
    parent_death ? "integration.parent-death-helper-within-one-second" : "integration.eof-helper-within-one-second");
  require_integration(WaitForSingleObject(child.process.get(), 1000) == WAIT_OBJECT_0, "integration.lifecycle-caller-exit");
}

struct ParentOnlyState { volatile LONG child = 0, cleanup_started = 0; };
std::uintptr_t private_handle(std::string_view value) {
  require_integration(!value.empty() && value.size() <= 20 && value.front() != '0', "integration.parent-only-private-handle");
  std::uintptr_t result = 0;
  for (const auto digit : value) {
    require_integration(digit >= '0' && digit <= '9' && result <= ((std::numeric_limits<std::uintptr_t>::max)() - static_cast<unsigned>(digit - '0')) / 10,
      "integration.parent-only-canonical-handle");
    result = result * 10 + static_cast<unsigned>(digit - '0');
  }
  return result;
}
winrt::handle parent_only_child(bool parent, HANDLE mapping, HANDLE ready, HANDLE job = nullptr, bool finish77 = false) {
  SECURITY_ATTRIBUTES security{static_cast<DWORD>(sizeof(SECURITY_ATTRIBUTES)), nullptr, TRUE};
  winrt::handle null(CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
  require_integration(null && GetFileType(null.get()) == FILE_TYPE_CHAR, "integration.parent-only-stdin-is-not-a-pipe");
  SIZE_T size = 0;
  const DWORD count = job ? DWORD{2} : DWORD{1};
  (void)InitializeProcThreadAttributeList(nullptr, count, 0, &size);
  require_integration(size > 0 && size < 65'536, "integration.parent-only-attribute-bound");
  std::vector<unsigned char> storage(size);
  const auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
  require_integration(InitializeProcThreadAttributeList(attributes, count, 0, &size) != FALSE, "integration.parent-only-attributes");
  struct Attributes { LPPROC_THREAD_ATTRIBUTE_LIST value; ~Attributes() { DeleteProcThreadAttributeList(value); } } close{attributes};
  std::array<HANDLE, 3> handles{mapping, ready, null.get()};
  require_integration(UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles.data(), sizeof(handles), nullptr, nullptr) != FALSE,
    "integration.parent-only-private-inheritance");
  if (job) require_integration(UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &job, sizeof(job), nullptr, nullptr) != FALSE,
    "integration.parent-only-owned-job");
  STARTUPINFOEXW startup{}; startup.StartupInfo.cb = static_cast<DWORD>(sizeof(startup));
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES; startup.StartupInfo.hStdInput = startup.StartupInfo.hStdOutput = startup.StartupInfo.hStdError = null.get();
  startup.lpAttributeList = attributes;
  std::wstring image(32'768, L'\0'); const auto length = GetModuleFileNameW(nullptr, image.data(), static_cast<DWORD>(image.size()));
  require_integration(length > 0 && length < image.size(), "integration.parent-only-test-image"); image.resize(length);
  auto command = L"\"" + image + (parent ? L"\" --self-test=parent-only-parent " : finish77 ? L"\" --self-test=parent-only-finish77 " : L"\" --self-test=parent-only-child ") +
    std::to_wstring(reinterpret_cast<std::uintptr_t>(mapping)) + L" " + std::to_wstring(reinterpret_cast<std::uintptr_t>(ready));
  PROCESS_INFORMATION process{};
  require_integration(CreateProcessW(image.c_str(), command.data(), nullptr, nullptr, TRUE, EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW,
    nullptr, nullptr, &startup.StartupInfo, &process) != FALSE, "integration.parent-only-create");
  winrt::handle thread(process.hThread); return winrt::handle(process.hProcess);
}
void check_parent_only_lifecycle() {
  SECURITY_ATTRIBUTES security{static_cast<DWORD>(sizeof(SECURITY_ATTRIBUTES)), nullptr, TRUE};
  winrt::handle mapping(CreateFileMappingW(INVALID_HANDLE_VALUE, &security, PAGE_READWRITE, 0, sizeof(ParentOnlyState), nullptr));
  winrt::handle ready(CreateEventW(&security, TRUE, FALSE, nullptr));
  require_integration(mapping && ready, "integration.parent-only-private-signals");
  const auto state = static_cast<ParentOnlyState*>(MapViewOfFile(mapping.get(), FILE_MAP_ALL_ACCESS, 0, 0, sizeof(ParentOnlyState)));
  require_integration(state != nullptr, "integration.parent-only-shared-state");
  struct View { void* value; ~View() { UnmapViewOfFile(value); } } view{state};
  InterlockedExchange(&state->child, 0); InterlockedExchange(&state->cleanup_started, 0);
  // This root-owned job cleans test failures; it stays open throughout the timed assertion and
  // therefore cannot make parent death look like a successful helper fuse.
  winrt::handle job(CreateJobObjectW(nullptr, nullptr));
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limit{}; limit.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  require_integration(job && SetInformationJobObject(job.get(), JobObjectExtendedLimitInformation, &limit, sizeof(limit)), "integration.parent-only-root-cleanup-job");
  const auto parent = parent_only_child(true, mapping.get(), ready.get(), job.get());
  require_integration(WaitForSingleObject(ready.get(), 5000) == WAIT_OBJECT_0 && WaitForSingleObject(parent.get(), 0) == WAIT_TIMEOUT,
    "integration.parent-only-child-ready");
  const auto pid = static_cast<DWORD>(InterlockedCompareExchange(&state->child, 0, 0));
  winrt::handle child(OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
  require_integration(pid != 0 && child && GetProcessId(child.get()) == pid && WaitForSingleObject(child.get(), 0) == WAIT_TIMEOUT &&
    parent_pid(pid) == GetProcessId(parent.get()) && process_created(child.get()) >= process_created(parent.get()), "integration.parent-only-held-child-witness");
  const auto started = GetTickCount64();
  require_integration(TerminateProcess(parent.get(), 0) != FALSE, "integration.parent-only-kill-actual-parent");
  require_integration(WaitForSingleObject(child.get(), 1000) == WAIT_OBJECT_0 && GetTickCount64() - started <= 1000,
    "integration.parent-only-fuse-exits-within-one-second-without-stdin");
  DWORD code = 1;
  require_integration(GetExitCodeProcess(child.get(), &code) != FALSE && code == 0, "integration.parent-only-actual-parent-death-exit");
  require_integration(InterlockedCompareExchange(&state->cleanup_started, 0, 0) == 1, "integration.parent-only-fuse-survives-blocked-cleanup");
  require_integration(ResetEvent(ready.get()) != FALSE, "integration.parent-only-finish-ready-reset");
  const auto finishing = parent_only_child(false, mapping.get(), ready.get(), job.get(), true);
  require_integration(WaitForSingleObject(ready.get(), 5000) == WAIT_OBJECT_0 && WaitForSingleObject(finishing.get(), 1000) == WAIT_OBJECT_0,
    "integration.parent-only-explicit-finish-is-finite");
  code = 1;
  require_integration(GetExitCodeProcess(finishing.get(), &code) != FALSE && code == 77,
    "integration.parent-only-explicit-skip-exit-survives-immediate-fuse");
}
}

int integration_parent_only_child(bool parent, std::string_view mapping_value, std::string_view ready_value, bool finish77) {
  try {
    const auto mapping = reinterpret_cast<HANDLE>(private_handle(mapping_value)), ready = reinterpret_cast<HANDLE>(private_handle(ready_value));
    require_integration(GetFileType(GetStdHandle(STD_INPUT_HANDLE)) == FILE_TYPE_CHAR, "integration.parent-only-child-has-no-stdin-pipe");
    const auto state = static_cast<ParentOnlyState*>(MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(ParentOnlyState)));
    require_integration(state != nullptr, "integration.parent-only-child-state");
    if (parent) { const auto child = parent_only_child(false, mapping, ready); Sleep(15'000); return 1; }
    HelperLifecycle lifecycle(parent_pid(GetCurrentProcessId()), [state](StopReason) { InterlockedExchange(&state->cleanup_started, 1); Sleep(10'000); });
    require_integration(lifecycle.parent_current() && !lifecycle.stopping(), "integration.parent-only-real-lifetime-armed");
    InterlockedExchange(&state->child, static_cast<LONG>(GetCurrentProcessId()));
    require_integration(SetEvent(ready) != FALSE, "integration.parent-only-ready-signal");
    if (finish77) lifecycle.finish(77);
    Sleep(15'000); return 1;
  } catch (...) { return 1; }
}

void integration_lifecycle_test(bool parent_death) {
  FixtureFiles files;
  check_lifecycle(files, parent_death);
}

void integration_tests() {
  desktop_security_boundaries();
  check_parent_only_lifecycle();
  FixtureFiles files;
  {
    Child child(files.caller); child.hello();
    auto helper = held_helper(files, child.process.get());
    child.send(R"({"id":2,"op":"shutdown"})");
    const auto reply = child.receive();
    require_integration(reply.GetNamedNumber(L"id") == 2 && reply.GetNamedBoolean(L"ok"), "integration.shutdown-ack-before-exit");
    require_integration(WaitForSingleObject(helper.get(), 1000) == WAIT_OBJECT_0 && WaitForSingleObject(child.process.get(), 1000) == WAIT_OBJECT_0, "integration.shutdown-process-exit");
    DWORD code = 1;
    require_integration(GetExitCodeProcess(child.process.get(), &code) != FALSE && code == 0, "integration.shutdown-clean-code");
  }
  {
    // The successful actual medium-token/responsible hello above is the baseline. This switch
    // adds only a refusal to the same verified high -> medium -> helper path; it cannot supply
    // token facts, bypass caller checks, or turn an already elevated helper into an allowed one.
    Child child(files.caller, true);
    require_integration(WaitForSingleObject(child.process.get(), 10'000) == WAIT_OBJECT_0, "integration.test-elevated-token-refuses-within-startup-bound");
    DWORD code = 0;
    require_integration(GetExitCodeProcess(child.process.get(), &code) != FALSE && code == 1, "integration.test-elevated-token-refuses-with-exit-one");
    DWORD available = 0; SetLastError(ERROR_SUCCESS);
    const auto peeked = PeekNamedPipe(child.output.get(), nullptr, 0, nullptr, &available, nullptr);
    require_integration((peeked || GetLastError() == ERROR_BROKEN_PIPE) && available == 0, "integration.test-elevated-token-emits-no-serving-frames");
  }
  {
    Child child(files.caller); child.hello();
    auto helper = held_helper(files, child.process.get());
    // A fatal publication failure must survive the independently scheduled lifecycle callback.
    child.output.close();
    child.send(R"({"id":2,"op":"permissions.status"})");
    require_integration(WaitForSingleObject(helper.get(), 1000) == WAIT_OBJECT_0 && WaitForSingleObject(child.process.get(), 1000) == WAIT_OBJECT_0, "integration.failed-transport-exits");
    DWORD code = 0;
    require_integration(GetExitCodeProcess(child.process.get(), &code) != FALSE && code == 1, "integration.failed-transport-nonzero-code");
  }
  check_lifecycle(files, false);
  check_lifecycle(files, true);
}
}
