#include "core.h"
#include "identity.h"
#include "protocol.h"
#include <tlhelp32.h>
#include <algorithm>
#include <array>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <vector>

namespace vector::computer {
namespace {
void require_integration(bool value, const char* label) { if (!value) throw std::runtime_error(label); }
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
  explicit Child(const std::filesystem::path& caller) {
    SECURITY_ATTRIBUTES security{static_cast<DWORD>(sizeof(SECURITY_ATTRIBUTES)), nullptr, TRUE};
    HANDLE read = nullptr;
    HANDLE write = nullptr;
    require_integration(CreatePipe(&read, &write, &security, 0) != FALSE, "integration.stdin-pipe");
    winrt::handle child_input(read); input.attach(write);
    require_integration(SetHandleInformation(input.get(), HANDLE_FLAG_INHERIT, 0) != FALSE, "integration.stdin-private");
    require_integration(CreatePipe(&read, &write, &security, 0) != FALSE, "integration.stdout-pipe");
    output.attach(read); winrt::handle child_output(write);
    require_integration(SetHandleInformation(output.get(), HANDLE_FLAG_INHERIT, 0) != FALSE, "integration.stdout-private");
    winrt::handle error(CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
    require_integration(error && error.get() != INVALID_HANDLE_VALUE, "integration.stderr-null");
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
    auto command = L"\"" + caller.wstring() + L"\" --stdio";
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
  JsonObject receive() {
    std::vector<uint8_t> bytes;
    std::optional<size_t> length;
    const auto start = GetTickCount64();
    while (!length || bytes.size() < *length + 4) {
      require_integration(GetTickCount64() - start < 10'000, "integration.reply-deadline");
      DWORD available = 0;
      require_integration(PeekNamedPipe(output.get(), nullptr, 0, nullptr, &available, nullptr) != FALSE, "integration.reply-pipe");
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
    for (const auto& feature : result.GetNamedObject(L"features")) require_integration(!feature.Value().GetBoolean(), "integration.no-future-features");
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
}

void integration_lifecycle_test(bool parent_death) {
  FixtureFiles files;
  check_lifecycle(files, parent_death);
}

void integration_tests() {
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
