#include "core.h"
#include "identity.h"
#include "parent_identity.h"
#include <tlhelp32.h>
#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <io.h>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>
#include <winrt/base.h>

namespace {
using vector::computer::TokenIdentity;

[[noreturn]] void invalid() { throw std::runtime_error("The native fixture caller could not be validated."); }

bool equal_path(const std::wstring& left, const std::wstring& right) {
  return left.size() <= 32'000 && right.size() <= 32'000 &&
    CompareStringOrdinal(left.c_str(), static_cast<int>(left.size()), right.c_str(), static_cast<int>(right.size()), TRUE) == CSTR_EQUAL;
}

bool canonical_path(const std::wstring& value) {
  if (value.size() < 4 || value.size() > 32'000 || value[1] != L':' || value[2] != L'\\' ||
      !((value[0] >= L'A' && value[0] <= L'Z') || (value[0] >= L'a' && value[0] <= L'z')) || value.back() == L'\\') return false;
  size_t begin = 3;
  for (size_t index = 3; index <= value.size(); ++index) {
    if (index != value.size() && value[index] != L'\\') {
      if (value[index] < 32 || value[index] == 127 || value[index] == L'/' || value[index] == L':') return false;
      continue;
    }
    const auto part = value.substr(begin, index - begin);
    if (part.empty() || part == L"." || part == L".." || part.back() == L'.' || part.back() == L' ') return false;
    begin = index + 1;
  }
  return true;
}

std::uint64_t created(HANDLE process) {
  FILETIME start{}, exit{}, kernel{}, user{};
  if (!GetProcessTimes(process, &start, &exit, &kernel, &user)) invalid();
  const auto result = (std::uint64_t(start.dwHighDateTime) << 32) | start.dwLowDateTime;
  if (result == 0) invalid();
  return result;
}

DWORD actual_parent(DWORD pid) {
  const auto raw = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (!raw || raw == INVALID_HANDLE_VALUE) invalid();
  winrt::handle snapshot{raw};
  PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry);
  if (!Process32FirstW(snapshot.get(), &entry)) invalid();
  size_t count = 0;
  do {
    if (++count > 65'536) invalid();
    if (entry.th32ProcessID == pid) {
      if (entry.th32ParentProcessID == 0 || entry.th32ParentProcessID == pid) invalid();
      return entry.th32ParentProcessID;
    }
  } while (Process32NextW(snapshot.get(), &entry));
  invalid();
}

struct ProcessWitness {
  winrt::handle handle;
  DWORD pid = 0;
  std::uint64_t start = 0;
};

ProcessWitness witness(winrt::handle process, DWORD pid, std::uint64_t child_start) {
  if (!process || pid == 0 || pid == GetCurrentProcessId() || GetProcessId(process.get()) != pid ||
      WaitForSingleObject(process.get(), 0) != WAIT_TIMEOUT) invalid();
  const auto start = created(process.get());
  if (start > child_start) invalid();
  return {std::move(process), pid, start};
}

ProcessWitness open_process(DWORD pid, std::uint64_t child_start) {
  return witness(winrt::handle{OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid)}, pid, child_start);
}

void current(const ProcessWitness& value) {
  if (GetProcessId(value.handle.get()) != value.pid || WaitForSingleObject(value.handle.get(), 0) != WAIT_TIMEOUT ||
      created(value.handle.get()) != value.start) invalid();
}

class ParentWatches final {
 public:
  ParentWatches() : state_(std::make_shared<State>()) {
    state_->done.attach(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    if (!state_->done) invalid();
  }
  ~ParentWatches() { (void)SetEvent(state_->done.get()); }
  void arm(const ProcessWitness& value) {
    HANDLE raw = nullptr;
    if (!DuplicateHandle(GetCurrentProcess(), value.handle.get(), GetCurrentProcess(), &raw,
                         SYNCHRONIZE, FALSE, 0)) invalid();
    const auto state = state_;
    // The wait owns its lifetime witness. It never closes or terminates the helper's process.
    std::thread([state, parent = winrt::handle{raw}] {
      const HANDLE handles[] = {state->done.get(), parent.get()};
      const auto result = WaitForMultipleObjects(2, handles, FALSE, INFINITE);
      if (result != WAIT_OBJECT_0) (void)TerminateProcess(GetCurrentProcess(), result == WAIT_OBJECT_0 + 1 ? 0 : 1);
    }).detach();
  }
 private:
  struct State { winrt::handle done; };
  std::shared_ptr<State> state_;
};

BOOL WINAPI console_control(DWORD kind) {
  if (kind != CTRL_C_EVENT && kind != CTRL_BREAK_EVENT && kind != CTRL_CLOSE_EVENT &&
      kind != CTRL_LOGOFF_EVENT && kind != CTRL_SHUTDOWN_EVENT) return FALSE;
  // Caller death is the helper's graceful parent-death signal. Never kill the helper directly.
  (void)TerminateProcess(GetCurrentProcess(), 0);
  return TRUE;
}

std::wstring process_path(HANDLE process) {
  std::wstring result(32'768, L'\0');
  DWORD size = static_cast<DWORD>(result.size());
  if (!QueryFullProcessImageNameW(process, 0, result.data(), &size) || size == 0 || size >= result.size()) invalid();
  result.resize(size);
  if (!canonical_path(result)) invalid();
  return result;
}

std::wstring final_path(HANDLE file) {
  std::wstring result(32'768, L'\0');
  const auto size = GetFinalPathNameByHandleW(file, result.data(), static_cast<DWORD>(result.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (size == 0 || size >= result.size()) invalid();
  result.resize(size);
  if (!result.starts_with(L"\\\\?\\") || result.starts_with(L"\\\\?\\UNC\\")) invalid();
  result.erase(0, 4);
  return result;
}

struct HeldFile {
  winrt::handle handle;
  std::wstring path;
  FILE_ID_INFO id{};
  FILE_BASIC_INFO basic{};
  FILE_STANDARD_INFO standard{};
};

HeldFile hold_file(const std::wstring& path) {
  if (!canonical_path(path)) invalid();
  HeldFile result;
  result.handle.attach(CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                                   FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!result.handle || result.handle.get() == INVALID_HANDLE_VALUE || GetFileType(result.handle.get()) != FILE_TYPE_DISK ||
      !GetFileInformationByHandleEx(result.handle.get(), FileIdInfo, &result.id, sizeof(result.id)) ||
      !GetFileInformationByHandleEx(result.handle.get(), FileBasicInfo, &result.basic, sizeof(result.basic)) ||
      !GetFileInformationByHandleEx(result.handle.get(), FileStandardInfo, &result.standard, sizeof(result.standard)) ||
      result.standard.Directory || result.standard.DeletePending || result.standard.EndOfFile.QuadPart <= 0 ||
      result.standard.EndOfFile.QuadPart > 1'073'741'824 ||
      (result.basic.FileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) != 0) invalid();
  result.path = final_path(result.handle.get());
  if (!canonical_path(result.path) || !equal_path(result.path, path)) invalid();
  return result;
}

bool same_file(const HeldFile& left, const HeldFile& right) {
  return equal_path(left.path, right.path) && left.id.VolumeSerialNumber == right.id.VolumeSerialNumber &&
    std::equal(std::begin(left.id.FileId.Identifier), std::end(left.id.FileId.Identifier), std::begin(right.id.FileId.Identifier)) &&
    left.standard.EndOfFile.QuadPart == right.standard.EndOfFile.QuadPart &&
    left.basic.CreationTime.QuadPart == right.basic.CreationTime.QuadPart &&
    left.basic.LastWriteTime.QuadPart == right.basic.LastWriteTime.QuadPart;
}

struct Layout {
  std::vector<winrt::handle> directories;
  HeldFile self;
  HeldFile helper;
};

void hold_directories(const std::wstring& file, std::vector<winrt::handle>& held) {
  size_t count = 0;
  for (size_t index = 2; index < file.size(); ++index) {
    if (file[index] != L'\\') continue;
    if (++count > 128) invalid();
    const auto directory = file.substr(0, index == 2 ? 3 : index);
    winrt::handle handle{CreateFileW(directory.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                                     FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
    FILE_BASIC_INFO basic{};
    if (!handle || handle.get() == INVALID_HANDLE_VALUE ||
        !GetFileInformationByHandleEx(handle.get(), FileBasicInfo, &basic, sizeof(basic)) ||
        (basic.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 || (basic.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
        !equal_path(final_path(handle.get()), directory)) invalid();
    held.push_back(std::move(handle));
  }
}

Layout layout() {
  const auto image = process_path(GetCurrentProcess());
  const auto slash = image.find_last_of(L'\\');
  if (slash == std::wstring::npos || slash <= 2) invalid();
  const auto name = image.substr(slash + 1);
  if (std::none_of(vector::computer::identity::kChannels.begin(), vector::computer::identity::kChannels.end(), [&](const auto& channel) {
        return equal_path(name, std::wstring(channel.windowsExecutable.begin(), channel.windowsExecutable.end()));
      }) || vector::computer::identity::kExecutable != "vector-computer.exe") invalid();
  const auto helper = image.substr(0, slash) + L"\\resources\\computer\\vector-computer.exe";
  Layout result;
  hold_directories(image, result.directories);
  hold_directories(helper, result.directories);
  result.self = hold_file(image);
  result.helper = hold_file(helper);
  const auto root = vector::computer::helper_install_root(result.helper.path);
  if (!root || !equal_path(*root, image.substr(0, slash))) invalid();
  return result;
}

bool same_context(const TokenIdentity& left, const TokenIdentity& right) {
  return !left.user.empty() && !left.logon.empty() && left.authentication != 0 &&
    left.user == right.user && left.logon == right.logon && left.authentication == right.authentication && left.session == right.session;
}

std::vector<unsigned char> information(HANDLE token, TOKEN_INFORMATION_CLASS kind) {
  DWORD size = 0;
  if (GetTokenInformation(token, kind, nullptr, 0, &size) || GetLastError() != ERROR_INSUFFICIENT_BUFFER || size == 0 || size > 65'536) invalid();
  std::vector<unsigned char> result(size);
  if (!GetTokenInformation(token, kind, result.data(), size, &size) || size > result.size()) invalid();
  return result;
}

std::vector<unsigned char> sid_bytes(PSID sid) {
  if (!sid || !IsValidSid(sid)) invalid();
  const auto size = GetLengthSid(sid);
  if (size == 0 || size > SECURITY_MAX_SID_SIZE) invalid();
  std::vector<unsigned char> result(size);
  if (!CopySid(size, result.data(), sid)) invalid();
  return result;
}

TokenIdentity token_identity(HANDLE token) {
  TokenIdentity result;
  const auto user = information(token, TokenUser), groups = information(token, TokenGroups), stats = information(token, TokenStatistics);
  const auto session = information(token, TokenSessionId), integrity = information(token, TokenIntegrityLevel);
  const auto elevated = information(token, TokenElevation), ui = information(token, TokenUIAccess), container = information(token, TokenIsAppContainer);
  if (user.size() < sizeof(TOKEN_USER) || groups.size() < FIELD_OFFSET(TOKEN_GROUPS, Groups) || stats.size() < sizeof(TOKEN_STATISTICS) ||
      session.size() < sizeof(DWORD) || integrity.size() < sizeof(TOKEN_MANDATORY_LABEL) || elevated.size() < sizeof(TOKEN_ELEVATION) ||
      ui.size() < sizeof(DWORD) || container.size() < sizeof(DWORD)) invalid();
  result.user = sid_bytes(reinterpret_cast<const TOKEN_USER*>(user.data())->User.Sid);
  const auto entries = reinterpret_cast<const TOKEN_GROUPS*>(groups.data());
  if (entries->GroupCount > (groups.size() - FIELD_OFFSET(TOKEN_GROUPS, Groups)) / sizeof(SID_AND_ATTRIBUTES)) invalid();
  for (DWORD index = 0; index < entries->GroupCount; ++index) {
    if ((entries->Groups[index].Attributes & SE_GROUP_LOGON_ID) != SE_GROUP_LOGON_ID) continue;
    if (!result.logon.empty()) invalid();
    result.logon = sid_bytes(entries->Groups[index].Sid);
  }
  const auto auth = reinterpret_cast<const TOKEN_STATISTICS*>(stats.data())->AuthenticationId;
  result.authentication = (std::uint64_t(static_cast<DWORD>(auth.HighPart)) << 32) | auth.LowPart;
  result.session = *reinterpret_cast<const DWORD*>(session.data());
  const auto sid = reinterpret_cast<const TOKEN_MANDATORY_LABEL*>(integrity.data())->Label.Sid;
  if (!sid || !IsValidSid(sid) || *GetSidSubAuthorityCount(sid) == 0) invalid();
  result.integrity = *GetSidSubAuthority(sid, static_cast<DWORD>(*GetSidSubAuthorityCount(sid) - 1));
  result.elevated = reinterpret_cast<const TOKEN_ELEVATION*>(elevated.data())->TokenIsElevated != 0;
  result.ui_access = *reinterpret_cast<const DWORD*>(ui.data()) != 0;
  result.app_container = *reinterpret_cast<const DWORD*>(container.data()) != 0;
  return result;
}

winrt::handle medium_token(const TokenIdentity& original) {
  HANDLE raw = nullptr;
  const DWORD access = TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT;
  if (!OpenProcessToken(GetCurrentProcess(), access, &raw)) invalid();
  winrt::handle source{raw};
  TOKEN_ELEVATION_TYPE type{}; DWORD size = 0;
  if (GetTokenInformation(source.get(), TokenElevationType, &type, sizeof(type), &size) && type == TokenElevationTypeFull) {
    TOKEN_LINKED_TOKEN linked{};
    if (GetTokenInformation(source.get(), TokenLinkedToken, &linked, sizeof(linked), &size)) {
      winrt::handle limited{linked.LinkedToken};
      HANDLE copy = nullptr;
      if (limited && DuplicateTokenEx(limited.get(), access, nullptr, SecurityImpersonation, TokenPrimary, &copy)) {
        winrt::handle candidate{copy};
        const auto observed = token_identity(candidate.get());
        if (vector::computer::serving_token_allowed(observed) && same_context(original, observed)) return candidate;
      }
    }
  }
  // No UAC policy changes: derive a genuinely restricted token from this actual primary token.
  alignas(DWORD) std::array<std::array<unsigned char, SECURITY_MAX_SID_SIZE>, 2> sids{};
  std::array<SID_AND_ATTRIBUTES, 2> disabled{};
  const WELL_KNOWN_SID_TYPE types[] = {WinBuiltinAdministratorsSid, WinBuiltinPowerUsersSid};
  for (size_t index = 0; index < disabled.size(); ++index) {
    DWORD length = SECURITY_MAX_SID_SIZE;
    if (!CreateWellKnownSid(types[index], nullptr, sids[index].data(), &length)) invalid();
    disabled[index].Sid = sids[index].data();
  }
  raw = nullptr;
  if (!CreateRestrictedToken(source.get(), LUA_TOKEN | DISABLE_MAX_PRIVILEGE, static_cast<DWORD>(disabled.size()), disabled.data(),
                             0, nullptr, 0, nullptr, &raw)) invalid();
  winrt::handle candidate{raw};
  struct Label { TOKEN_MANDATORY_LABEL label{}; alignas(DWORD) std::array<unsigned char, SECURITY_MAX_SID_SIZE> sid{}; } label;
  DWORD length = SECURITY_MAX_SID_SIZE;
  if (!CreateWellKnownSid(WinMediumLabelSid, nullptr, label.sid.data(), &length)) invalid();
  label.label.Label.Sid = label.sid.data(); label.label.Label.Attributes = SE_GROUP_INTEGRITY;
  if (!SetTokenInformation(candidate.get(), TokenIntegrityLevel, &label.label,
                           static_cast<DWORD>(offsetof(Label, sid) + length))) invalid();
  const auto observed = token_identity(candidate.get());
  if (!vector::computer::serving_token_allowed(observed) || !same_context(original, observed)) invalid();
  return candidate;
}

class QuotaPrivilege final {
 public:
  QuotaPrivilege() {
    HANDLE raw = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_ADJUST_PRIVILEGES, &raw)) return;
    token_.attach(raw);
    TOKEN_PRIVILEGES wanted{}; wanted.PrivilegeCount = 1;
    if (!LookupPrivilegeValueW(nullptr, SE_INCREASE_QUOTA_NAME, &wanted.Privileges[0].Luid)) return;
    wanted.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
    DWORD size = 0; SetLastError(ERROR_SUCCESS);
    enabled_ = AdjustTokenPrivileges(token_.get(), FALSE, &wanted, sizeof(previous_), &previous_, &size) != FALSE && GetLastError() == ERROR_SUCCESS;
  }
  ~QuotaPrivilege() { if (enabled_) (void)AdjustTokenPrivileges(token_.get(), FALSE, &previous_, 0, nullptr, nullptr); }
  bool enabled() const noexcept { return enabled_; }
 private:
  winrt::handle token_;
  TOKEN_PRIVILEGES previous_{};
  bool enabled_ = false;
};

struct Child { winrt::handle process; winrt::handle thread; DWORD pid = 0; };

void close_standard_handles() {
  const DWORD kinds[] = {STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE};
  const std::array<std::FILE*, 3> streams{stdin, stdout, stderr};
  std::array<HANDLE, 3> originals{}, crt{};
  for (size_t index = 0; index < originals.size(); ++index) {
    originals[index] = GetStdHandle(kinds[index]);
    const auto descriptor = _fileno(streams[index]);
    const auto raw = descriptor >= 0 ? _get_osfhandle(descriptor) : -1;
    if (raw != -1 && raw != -2) crt[index] = reinterpret_cast<HANDLE>(raw);
    (void)SetStdHandle(kinds[index], INVALID_HANDLE_VALUE);
  }
  // Closing through the CRT also retires its descriptor, so later handle-number reuse cannot be double-closed at exit.
  for (const auto stream : streams) (void)std::fclose(stream);
  for (size_t index = 0; index < originals.size(); ++index) {
    const auto handle = originals[index];
    if (!handle || handle == INVALID_HANDLE_VALUE || std::find(crt.begin(), crt.end(), handle) != crt.end() ||
        std::find(originals.begin(), originals.begin() + index, handle) != originals.begin() + index) continue;
    (void)CloseHandle(handle);
  }
}

Child launch(const std::wstring& executable, std::wstring command, HANDLE token, HANDLE bootstrap, bool serving) {
  const auto original_command = command;
  std::array<winrt::handle, 3> copies;
  std::vector<HANDLE> inherited;
  const DWORD kinds[] = {STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE};
  for (size_t index = 0; index < copies.size(); ++index) {
    const auto original = GetStdHandle(kinds[index]);
    const auto type = original && original != INVALID_HANDLE_VALUE ? GetFileType(original) : FILE_TYPE_UNKNOWN;
    if (type != FILE_TYPE_PIPE && type != FILE_TYPE_CHAR && type != FILE_TYPE_DISK) invalid();
    if (serving && index < 2 && type != FILE_TYPE_PIPE) invalid();
    HANDLE raw = nullptr;
    if (!DuplicateHandle(GetCurrentProcess(), original, GetCurrentProcess(), &raw, 0, TRUE, DUPLICATE_SAME_ACCESS)) invalid();
    copies[index].attach(raw); inherited.push_back(raw);
  }
  if (bootstrap) inherited.push_back(bootstrap);
  SIZE_T size = 0;
  (void)InitializeProcThreadAttributeList(nullptr, 1, 0, &size);
  if (size == 0 || size > 65'536) invalid();
  std::vector<unsigned char> storage(size);
  const auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
  if (!InitializeProcThreadAttributeList(attributes, 1, 0, &size)) invalid();
  struct AttributeClose { LPPROC_THREAD_ATTRIBUTE_LIST value; ~AttributeClose() { DeleteProcThreadAttributeList(value); } } close{attributes};
  if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited.data(),
                                 inherited.size() * sizeof(HANDLE), nullptr, nullptr)) invalid();
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup); startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = copies[0].get(); startup.StartupInfo.hStdOutput = copies[1].get(); startup.StartupInfo.hStdError = copies[2].get();
  startup.lpAttributeList = attributes;
  PROCESS_INFORMATION process{};
  const DWORD flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW;
  BOOL success = token
    ? CreateProcessAsUserW(token, executable.c_str(), command.data(), nullptr, nullptr, TRUE, flags, nullptr, nullptr, &startup.StartupInfo, &process)
    : CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE, flags, nullptr, nullptr, &startup.StartupInfo, &process);
  if (!success && token && GetLastError() == ERROR_PRIVILEGE_NOT_HELD) {
    QuotaPrivilege quota;
    if (quota.enabled()) {
      command = original_command;
      success = CreateProcessAsUserW(token, executable.c_str(), command.data(), nullptr, nullptr, TRUE, flags,
                                    nullptr, nullptr, &startup.StartupInfo, &process);
    }
  }
  if (!success) invalid();
  Child result{winrt::handle{process.hProcess}, winrt::handle{process.hThread}, process.dwProcessId};
  close_standard_handles();
  return result;
}

std::uint64_t number(std::wstring_view value, std::uint64_t maximum) {
  if (value.empty() || value.size() > 20 || value.front() == L'0') invalid();
  std::uint64_t result = 0;
  for (const auto digit : value) {
    if (digit < L'0' || digit > L'9' || result > (maximum - static_cast<unsigned>(digit - L'0')) / 10) invalid();
    result = result * 10 + static_cast<unsigned>(digit - L'0');
  }
  if (result == 0) invalid();
  return result;
}

int wait_child(const Child& child) {
  DWORD code = 1;
  if (WaitForSingleObject(child.process.get(), INFINITE) != WAIT_OBJECT_0 || !GetExitCodeProcess(child.process.get(), &code)) invalid();
  return code <= static_cast<DWORD>((std::numeric_limits<int>::max)()) ? static_cast<int>(code) : 1;
}
}

int wmain(int count, wchar_t** argv) {
  try {
    bool internal = false;
    DWORD high_pid = 0; HANDLE bootstrap = nullptr;
    int offset = 1;
    if (count >= 2 && std::wstring_view(argv[1]) == L"--fixture-medium") {
      if (count < 6 || std::wstring_view(argv[3]) != L"--bootstrap-handle") return 2;
      internal = true;
      high_pid = static_cast<DWORD>(number(argv[2], (std::numeric_limits<DWORD>::max)()));
      bootstrap = reinterpret_cast<HANDLE>(static_cast<std::uintptr_t>(number(argv[4], (std::numeric_limits<std::uintptr_t>::max)())));
      offset = 5;
    }
    const bool serving = count == offset + 1 && std::wstring_view(argv[offset]) == L"--stdio";
    const bool probe = count == offset + 2 && std::wstring_view(argv[offset]) == L"--probe" && std::wstring_view(argv[offset + 1]) == L"--json";
    if ((!serving && !probe) || !SetConsoleCtrlHandler(console_control, TRUE)) return 2;
    ParentWatches watches;
    const auto own_start = created(GetCurrentProcess());
    const auto parent_pid = actual_parent(GetCurrentProcessId());
    std::vector<ProcessWitness> ancestors;
    if (internal) {
      if (parent_pid != high_pid || bootstrap == INVALID_HANDLE_VALUE || !SetHandleInformation(bootstrap, HANDLE_FLAG_INHERIT, 0)) invalid();
      ancestors.push_back(witness(winrt::handle{bootstrap}, high_pid, own_start));
      watches.arm(ancestors.back());
      const auto node_pid = actual_parent(high_pid);
      ancestors.push_back(open_process(node_pid, ancestors.front().start));
      watches.arm(ancestors.back());
    } else {
      ancestors.push_back(open_process(parent_pid, own_start));
      watches.arm(ancestors.back());
    }
    // The independent held-parent waits are already armed before token/path work or a helper launch.
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    const auto own_token = vector::computer::observe_token(GetCurrentProcess());
    auto files = layout();
    for (const auto& ancestor : ancestors) {
      current(ancestor);
      if (!same_context(own_token, vector::computer::observe_token(ancestor.handle.get()))) invalid();
    }
    if (internal) {
      const auto high_token = vector::computer::observe_token(ancestors.front().handle.get());
      if (!vector::computer::serving_token_allowed(own_token) || !high_token.elevated ||
          high_token.integrity < SECURITY_MANDATORY_HIGH_RID || high_token.ui_access || high_token.app_container ||
          !same_file(files.self, hold_file(process_path(ancestors.front().handle.get()))) ||
          actual_parent(high_pid) != ancestors.back().pid || actual_parent(GetCurrentProcessId()) != high_pid) invalid();
    }
    if (!vector::computer::serving_token_allowed(own_token)) {
      if (internal || !own_token.elevated || own_token.integrity < SECURITY_MANDATORY_HIGH_RID || own_token.ui_access || own_token.app_container) invalid();
      const auto token = medium_token(own_token);
      HANDLE raw = nullptr;
      if (!DuplicateHandle(GetCurrentProcess(), GetCurrentProcess(), GetCurrentProcess(), &raw,
                           SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, TRUE, 0)) invalid();
      winrt::handle high_handle{raw};
      const auto observed = token_identity(token.get());
      if (!vector::computer::serving_token_allowed(observed) || !same_context(own_token, observed)) invalid();
      for (const auto& ancestor : ancestors) current(ancestor);
      const auto command = L"\"" + files.self.path + L"\" --fixture-medium " + std::to_wstring(GetCurrentProcessId()) +
        L" --bootstrap-handle " + std::to_wstring(reinterpret_cast<std::uintptr_t>(high_handle.get())) + (serving ? L" --stdio" : L" --probe --json");
      auto child = launch(files.self.path, command, token.get(), high_handle.get(), serving);
      high_handle.close();
      const auto child_token = vector::computer::observe_token(child.process.get());
      if (!vector::computer::serving_token_allowed(child_token) || !vector::computer::same_token(observed, child_token) ||
          !same_file(files.self, hold_file(process_path(child.process.get()))) || created(child.process.get()) < own_start) invalid();
      return wait_child(child);
    }
    for (const auto& ancestor : ancestors) current(ancestor);
    if (!vector::computer::same_token(own_token, vector::computer::observe_token(GetCurrentProcess())) ||
        actual_parent(GetCurrentProcessId()) != parent_pid) invalid();
    const auto command = L"\"" + files.helper.path + L"\"" + (serving
      ? L" --stdio --parent-pid " + std::to_wstring(GetCurrentProcessId()) : std::wstring(L" --probe --json"));
    auto child = launch(files.helper.path, command, nullptr, nullptr, serving);
    return wait_child(child);
  } catch (...) {
    // Unwinding retired the death watches. Never block on a pipe while reporting a startup failure.
    return 1;
  }
}
