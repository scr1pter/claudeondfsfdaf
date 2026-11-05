#include "windows_program.h"
#include "windows_policy.h"
#include "windows_com.h"
#include "core.h"
#include <shlwapi.h>
#include <shellapi.h>
#include <shobjidl.h>
#include <algorithm>
#include <array>
#include <filesystem>
#include <map>
#include <mutex>
#include <set>
#include <thread>
#include <utility>

namespace vector::computer {
namespace {
[[noreturn]] void unavailable() { throw Failure{L"unavailable", L"The native launch route is unavailable."}; }
[[noreturn]] void changed() { throw Failure{L"changed", L"The native launch artifact changed."}; }
[[noreturn]] void invalid() { throw Failure{L"failed", L"The native launch arguments are invalid."}; }
[[noreturn]] void protected_route() { throw Failure{L"protected", L"The native launch route is protected."}; }
std::wstring lower(std::wstring value) { for (auto& c : value) if (c >= L'A' && c <= L'Z') c = static_cast<wchar_t>(c + 32); return value; }
bool allowed(const OperationContext& context) { return context.session && context.is_current && context.is_current(); }
void phase(const JsonObject& args, const OperationContext& context) {
  if (!allowed(context)) changed();
  const auto& session = *context.session;
  if (session.paused) throw Failure{L"stopped", L"The native computer session is paused."};
  if (args.HasKey(L"sessionId") && (args.Lookup(L"sessionId").ValueType() != JsonValueType::String || args.GetNamedString(L"sessionId") != session.id)) changed();
  if (args.HasKey(L"phaseRevision") && !safe_integer(args.Lookup(L"phaseRevision"))) changed();
  if (session.revision) {
    if (!args.HasKey(L"sessionId") || args.GetNamedString(L"sessionId", L"") != session.id ||
        !args.HasKey(L"phaseRevision") || safe_integer(args.Lookup(L"phaseRevision")) != session.revision) changed();
  }
}
void foreground(const OperationContext& context) {
  if (!context.session || context.session->mode != L"foreground") throw Failure{L"needs_foreground", L"Windows launches require foreground mode."};
}
bool keys(const JsonObject& args, const std::set<std::wstring>& expected) {
  for (const auto& pair : args) if (!expected.contains(std::wstring(pair.Key()))) return false;
  return true;
}
bool identity_request_shape(const IJsonValue& value) {
  if (value.ValueType() != JsonValueType::Object) return false;
  const auto object = value.GetObject();
  if (object.GetNamedString(L"platform", L"") != L"windows") return false;
  const auto kind = object.GetNamedString(L"kind", L"");
  if (kind != L"exe" && kind != L"aumid") return false;
  const std::set<std::wstring> fields = kind == L"exe"
    ? std::set<std::wstring>{L"platform", L"kind", L"publisher", L"product", L"binary", L"name", L"exe", L"system", L"verified", L"pid"}
    : std::set<std::wstring>{L"platform", L"kind", L"publisher", L"aumid", L"name", L"exe", L"system", L"verified", L"pid"};
  if (!keys(object, fields) || !object.HasKey(L"system") || !object.HasKey(L"verified") ||
      object.Lookup(L"system").ValueType() != JsonValueType::Boolean || object.Lookup(L"verified").ValueType() != JsonValueType::Boolean) return false;
  const auto bounded = [&](const wchar_t* name, size_t maximum, bool nonempty, bool required) {
    if (!object.HasKey(name)) return !required;
    if (object.Lookup(name).ValueType() != JsonValueType::String) return false;
    const auto string = object.GetNamedString(name);
    return string.size() <= maximum && (!nonempty || !string.empty()) && std::wstring_view(string).find(L'\0') == std::wstring_view::npos;
  };
  if (!bounded(L"name", 256, true, true) || !bounded(L"exe", 4096, true, kind == L"exe") ||
      !bounded(L"publisher", 256, false, kind == L"exe")) return false;
  if (kind == L"exe" && (!bounded(L"product", 256, false, true) || !bounded(L"binary", 260, true, true))) return false;
  if (kind == L"aumid" && !bounded(L"aumid", 512, true, true)) return false;
  if (object.HasKey(L"pid")) { const auto pid = safe_integer(object.Lookup(L"pid")); if (!pid || *pid == 0 || *pid > MAXDWORD) return false; }
  return true;
}
std::wstring text(const JsonObject& args, const wchar_t* key, size_t limit = 4096) {
  if (!args.HasKey(key) || args.Lookup(key).ValueType() != JsonValueType::String) invalid();
  const auto raw = args.GetNamedString(key);
  if (raw.empty() || raw.size() > limit || std::wstring_view(raw).find(L'\0') != std::wstring_view::npos) invalid();
  return std::wstring(raw);
}
std::wstring final_path(HANDLE file) {
  std::wstring result(32'768, L'\0');
  const auto size = GetFinalPathNameByHandleW(file, result.data(), static_cast<DWORD>(result.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (size == 0 || size >= result.size()) unavailable();
  result.resize(size);
  if (!result.starts_with(L"\\\\?\\") || result.starts_with(L"\\\\?\\UNC\\")) unavailable();
  result.erase(0, 4);
  if (!canonical_program_path(result)) unavailable();
  return result;
}
FileIdentity stamp(HANDLE file) {
  FILE_ID_INFO id{}; FILE_STANDARD_INFO standard{}; FILE_BASIC_INFO basic{};
  if (!GetFileInformationByHandleEx(file, FileIdInfo, &id, sizeof(id)) ||
      !GetFileInformationByHandleEx(file, FileStandardInfo, &standard, sizeof(standard)) ||
      !GetFileInformationByHandleEx(file, FileBasicInfo, &basic, sizeof(basic)) || standard.Directory || standard.DeletePending ||
      standard.EndOfFile.QuadPart < 0 || standard.EndOfFile.QuadPart > 268'435'456 ||
      (basic.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0) unavailable();
  FileIdentity result; result.path = final_path(file); result.volume = id.VolumeSerialNumber;
  std::copy(std::begin(id.FileId.Identifier), std::end(id.FileId.Identifier), result.id.begin());
  result.size = static_cast<uint64_t>(standard.EndOfFile.QuadPart);
  result.created = static_cast<uint64_t>(basic.CreationTime.QuadPart); result.modified = static_cast<uint64_t>(basic.LastWriteTime.QuadPart);
  return result;
}
bool same_stamp(const FileIdentity& a, const FileIdentity& b) {
  return a.path == b.path && a.volume == b.volume && a.id == b.id && a.size == b.size && a.created == b.created && a.modified == b.modified;
}
struct ContentSeal {
  winrt::handle file;
  FileIdentity image;
  std::wstring digest;
  bool pe = false;
};
std::shared_ptr<ContentSeal> content(const std::wstring& path, const WindowsProgramPolicy& policy, const std::function<bool()>& current) {
  if (!canonical_program_path(path) || !current() || !policy.protected_path || policy.protected_path(path)) protected_route();
  const auto raw = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
  if (!raw || raw == INVALID_HANDLE_VALUE) unavailable();
  auto result = std::make_shared<ContentSeal>(); result->file.attach(raw);
  if (GetFileType(raw) != FILE_TYPE_DISK) unavailable();
  result->image = stamp(raw);
  if (policy.protected_path(result->image.path)) protected_route();
  std::vector<uint8_t> bytes(static_cast<size_t>(result->image.size));
  const auto deadline = GetTickCount64() + 5000;
  size_t offset = 0;
  while (offset < bytes.size()) {
    if (!current() || GetTickCount64() >= deadline) changed();
    DWORD count = 0;
    if (!ReadFile(raw, bytes.data() + offset, static_cast<DWORD>(std::min<size_t>(65'536, bytes.size() - offset)), &count, nullptr) || count == 0) changed();
    offset += count;
  }
  result->digest = program_sha256(bytes);
  if (bytes.size() >= 64 && bytes[0] == 'M' && bytes[1] == 'Z') {
    const auto position = static_cast<uint32_t>(bytes[0x3c]) | (static_cast<uint32_t>(bytes[0x3d]) << 8) |
      (static_cast<uint32_t>(bytes[0x3e]) << 16) | (static_cast<uint32_t>(bytes[0x3f]) << 24);
    if (position >= 64 && position <= bytes.size() - 26 && bytes[position] == 'P' && bytes[position + 1] == 'E' && bytes[position + 2] == 0 && bytes[position + 3] == 0) {
      const auto machine = static_cast<WORD>(bytes[position + 4] | (static_cast<WORD>(bytes[position + 5]) << 8));
      const auto magic = static_cast<WORD>(bytes[position + 24] | (static_cast<WORD>(bytes[position + 25]) << 8));
      result->pe = (machine == IMAGE_FILE_MACHINE_I386 && magic == IMAGE_NT_OPTIONAL_HDR32_MAGIC) ||
        ((machine == IMAGE_FILE_MACHINE_AMD64 || machine == IMAGE_FILE_MACHINE_ARM64) && magic == IMAGE_NT_OPTIONAL_HDR64_MAGIC);
    }
  }
  if (!same_stamp(result->image, stamp(raw)) || !current()) changed();
  return result;
}
std::wstring association_string(ASSOCSTR kind, const std::wstring& extension) {
  DWORD size = 0;
  (void)AssocQueryStringW(ASSOCF_VERIFY, kind, extension.c_str(), L"open", nullptr, &size);
  if (size < 2 || size > 32'768) unavailable();
  std::wstring value(size, L'\0');
  if (FAILED(AssocQueryStringW(ASSOCF_VERIFY, kind, extension.c_str(), L"open", value.data(), &size)) || size == 0 || size > value.size() || value[size - 1] != 0) unavailable();
  value.resize(size - 1); return value;
}
WindowsProgramAssociation association(const std::wstring& path) {
  const auto extension = std::filesystem::path(path).extension().wstring();
  const auto executable = association_string(ASSOCSTR_EXECUTABLE, extension);
  const auto command = association_string(ASSOCSTR_COMMAND, extension);
  int count = 0; const auto raw = CommandLineToArgvW(command.c_str(), &count);
  if (!raw) unavailable();
  struct Free { LPWSTR* value; ~Free() { LocalFree(value); } } free{raw};
  if (count < 2 || count > 33) unavailable();
  std::vector<std::wstring> arguments;
  for (int index = 0; index < count; ++index) arguments.emplace_back(raw[index]);
  const auto result = program_association_plan(executable, arguments);
  if (!result) unavailable();
  return *result;
}
std::wstring clean_name(const std::wstring& path) {
  auto name = std::filesystem::path(path).filename().wstring();
  for (auto& c : name) if (c <= 32 || (c >= 127 && c <= 159) || c == 0x00a0 || c == 0x1680 ||
      (c >= 0x2000 && c <= 0x200a) || c == 0x202f || c == 0x205f || c == 0x3000) c = L' ';
  std::wstring result;
  for (const auto c : name) if (c != L' ' || (!result.empty() && result.back() != L' ')) result.push_back(c);
  while (!result.empty() && result.back() == L' ') result.pop_back();
  if (result.size() > 256) { result.resize(256); if (result.back() >= 0xd800 && result.back() <= 0xdbff) result.pop_back(); }
  return result.empty() ? L"Program" : result;
}
std::wstring image_hash(const FileIdentity& image) {
  constexpr wchar_t digits[] = L"0123456789abcdef";
  std::wstring result; for (const auto byte : image.sha256) { result.push_back(digits[byte >> 4]); result.push_back(digits[byte & 15]); } return result;
}
struct Seal {
  NativeProgramArtifact artifact;
  std::shared_ptr<ContentSeal> content;
  std::optional<WindowsStaticIdentity> executable;
  std::optional<WindowsStaticIdentity> handler;
  uint64_t expires = 0;
};
struct Child {
  winrt::handle process, thread, job;
  DWORD pid = 0;
  ~Child() { if (job && process) { (void)TerminateProcess(process.get(), 1); } }
};
std::wstring system_directory(bool windows) {
  std::wstring value(32'768, L'\0');
  const auto size = windows ? GetWindowsDirectoryW(value.data(), static_cast<UINT>(value.size())) : GetSystemDirectoryW(value.data(), static_cast<UINT>(value.size()));
  if (size == 0 || size >= value.size()) unavailable(); value.resize(size); return value;
}
std::shared_ptr<Child> suspended(const std::wstring& executable, const std::vector<std::wstring>& arguments) {
  auto child = std::make_shared<Child>(); child->job.attach(CreateJobObjectW(nullptr, nullptr));
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limit{}; limit.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!child->job || !SetInformationJobObject(child->job.get(), JobObjectExtendedLimitInformation, &limit, sizeof(limit))) unavailable();
  SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  const auto input_raw = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (input_raw == INVALID_HANDLE_VALUE) unavailable(); winrt::handle input{input_raw};
  const auto output_raw = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (output_raw == INVALID_HANDLE_VALUE) unavailable(); winrt::handle output{output_raw};
  SIZE_T size = 0; (void)InitializeProcThreadAttributeList(nullptr, 2, 0, &size);
  if (size == 0 || size > 65'536) unavailable(); std::vector<uint8_t> storage(size);
  const auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
  if (!InitializeProcThreadAttributeList(attributes, 2, 0, &size)) unavailable();
  struct Delete { LPPROC_THREAD_ATTRIBUTE_LIST value; ~Delete() { DeleteProcThreadAttributeList(value); } } delete_attributes{attributes};
  const HANDLE handles[] = {input.get(), output.get()}; HANDLE job = child->job.get();
  if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, const_cast<HANDLE*>(handles), sizeof(handles), nullptr, nullptr) ||
      !UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &job, sizeof(job), nullptr, nullptr)) unavailable();
  STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup); startup.lpAttributeList = attributes;
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES; startup.StartupInfo.hStdInput = input.get(); startup.StartupInfo.hStdOutput = output.get(); startup.StartupInfo.hStdError = output.get();
  auto command = program_command_line(executable, arguments); command.push_back(0);
  const auto directory = system_directory(false), root = system_directory(true);
  std::wstring environment = L"PATH=" + directory; environment.push_back(0); environment += L"SystemRoot=" + root; environment.push_back(0); environment += L"WINDIR=" + root; environment.push_back(0); environment.push_back(0);
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE,
        CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW,
        environment.data(), directory.c_str(), &startup.StartupInfo, &process)) unavailable();
  child->process.attach(process.hProcess); child->thread.attach(process.hThread); child->pid = process.dwProcessId;
  return child;
}

struct NativePrograms final : std::enable_shared_from_this<NativePrograms> {
  explicit NativePrograms(WindowsProgramPolicy value) : policy(std::move(value)) {}
  WindowsProgramPolicy policy;
  std::mutex mutex;
  bool closed = false;
  std::map<std::wstring, std::shared_ptr<Seal>> seals;
  std::map<DWORD, std::shared_ptr<Child>> children;
  void retire(const std::wstring& binding) {
    std::shared_ptr<Seal> retired;
    { std::lock_guard guard(mutex); const auto found = seals.find(binding); if (found != seals.end()) { retired = std::move(found->second); seals.erase(found); } }
  }
  void expire() {
    std::vector<std::shared_ptr<Seal>> retired;
    {
      std::lock_guard guard(mutex); const auto now = GetTickCount64();
      for (auto item = seals.begin(); item != seals.end();) {
        if (item->second->expires <= now) { retired.push_back(std::move(item->second)); item = seals.erase(item); } else ++item;
      }
    }
  }
  bool active() { std::lock_guard guard(mutex); return !closed; }
  bool current(const Seal& seal) {
    return !policy.protected_path(seal.artifact.path) && same_stamp(seal.content->image, stamp(seal.content->file.get())) &&
      (!seal.executable || windows_file_current(*seal.executable)) && (!seal.handler || windows_file_current(*seal.handler));
  }
  WindowsLaunchResolution resolve(const std::wstring& path, const std::function<bool()>& authority) {
    if (!active() || !authority || !authority()) changed();
    if (!policy.protected_path || !policy.refusal) unavailable();
    if (policy.protected_path(path)) return {WindowsLaunchKind::protected_route, {}, {}, L"security"};
    const auto retained = content(path, policy, authority);
    auto seal = std::make_shared<Seal>(); seal->content = retained;
    seal->artifact.path = retained->image.path; seal->artifact.name = clean_name(retained->image.path);
    std::string binding = "[\"native-artifact-windows-v1\"," + program_json_quote(retained->image.path) + "," + program_json_quote(retained->digest);
    if (retained->pe) {
      seal->executable = observe_windows_file(retained->file.get());
      if (const auto reason = policy.refusal(seal->executable->identity)) return {WindowsLaunchKind::protected_route, {}, {}, *reason};
      seal->artifact.route = WindowsProgramRoute::executable; binding += ",\"executable\"";
    } else {
      if (!program_extension_allowed(retained->image.path)) unavailable();
      const auto route = association(retained->image.path);
      seal->handler = observe_windows_file(route.executable);
      if (!seal->handler->identity.verified || seal->handler->identity.kind != WindowsAppKind::exe || seal->handler->identity.pid) unavailable();
      if (policy.protected_path(seal->handler->image.path)) protected_route();
      if (const auto reason = policy.refusal(seal->handler->identity)) return {WindowsLaunchKind::protected_route, {}, {}, *reason};
      seal->artifact.route = WindowsProgramRoute::document; seal->artifact.handler = seal->handler->identity;
      seal->artifact.handler_path = seal->handler->image.path; seal->artifact.handler_arguments = route.arguments;
      binding += ",\"document\"," + program_json_quote(seal->handler->image.path) + "," + program_json_quote(image_hash(seal->handler->image));
      const auto wire = encode_json(seal->handler->identity.wire()); binding += "," + std::string(wire.begin(), wire.end());
      for (const auto& argument : route.arguments) binding += "," + program_json_quote(argument);
    }
    binding += "]"; seal->artifact.binding = program_sha256({reinterpret_cast<const uint8_t*>(binding.data()), binding.size()});
    if (!valid_program_artifact(seal->artifact) || !current(*seal) || !authority()) changed();
    std::vector<std::shared_ptr<Seal>> retired;
    {
      std::lock_guard guard(mutex); if (closed) changed();
      if (seals.size() >= 128) { retired.push_back(std::move(seals.begin()->second)); seals.erase(seals.begin()); }
      const auto found = seals.find(seal->artifact.binding);
      if (found != seals.end()) retired.push_back(std::move(found->second));
      // A later launch re-resolves and rehashes anyway. Unused preparations need not pin build outputs
      // for the full 30-second capability lifetime; the private idle reaper drops leases after 5 seconds.
      seal->expires = GetTickCount64() + 5000; seals[seal->artifact.binding] = seal;
    }
    if (seal->executable && seal->executable->identity.verified)
      return {WindowsLaunchKind::app, seal->executable, seal->artifact, L""};
    return {WindowsLaunchKind::program, {}, seal->artifact, L""};
  }
  bool launch(const NativeProgramArtifact& artifact, const OperationContext& context, const std::function<void()>& commit) {
    if (!allowed(context) || !active() || context.session->paused) changed();
    foreground(context);
    const auto fresh = resolve(artifact.path, context.is_current);
    if (fresh.kind == WindowsLaunchKind::protected_route) protected_route();
    if (!fresh.artifact || !same_program_artifact(*fresh.artifact, artifact)) changed();
    std::shared_ptr<Seal> seal;
    { std::lock_guard guard(mutex); const auto found = seals.find(artifact.binding); if (found == seals.end() || closed) changed(); seal = found->second; }
    struct Retire { NativePrograms* owner; std::wstring binding; ~Retire() { try { owner->retire(binding); } catch (...) {} } } retire_seal{this, artifact.binding};
    if (!current(*seal)) changed();
    const auto executable = seal->executable ? seal->executable->image.path : seal->handler->image.path;
    auto arguments = artifact.handler_arguments;
    for (auto& argument : arguments) if (argument == L"%1" || argument == L"%L" || argument == L"%l") argument = artifact.path;
    const auto child = suspended(executable, arguments);
    { std::lock_guard guard(mutex); if (closed || children.size() >= 16) changed(); children[child->pid] = child; }
    const auto remove = [&] { std::lock_guard guard(mutex); children.erase(child->pid); };
    try {
      const auto observed = observe_windows_process(child->pid);
      const auto& expected = seal->executable ? *seal->executable : *seal->handler;
      if (!allowed(context) || observed.process.image.path != expected.image.path || !same_file(observed.process.image, expected.image) ||
          !serving_token_allowed(observed.process.token) || !same_token(observed.process.token, observe_token(GetCurrentProcess())) || !windows_owner_current(observed)) changed();
      bool resumed = false;
      if (!context.with_current || !context.with_current([&] {
        std::lock_guard guard(mutex);
        if (closed || !children.contains(child->pid) || !current(*seal)) return;
        if (policy.refusal(expected.identity) || policy.protected_path(artifact.path) || policy.protected_path(executable)) protected_route();
        commit();
        if (ResumeThread(child->thread.get()) == static_cast<DWORD>(-1)) return;
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION released{};
        if (!SetInformationJobObject(child->job.get(), JobObjectExtendedLimitInformation, &released, sizeof(released))) return;
        child->job.close(); resumed = true;
      }) || !resumed) changed();
      remove(); return true;
    } catch (...) { remove(); throw; }
  }
  bool launch_package(const WindowsStaticIdentity& app, const OperationContext& context, const std::function<void()>& commit) {
    if (!allowed(context) || !active() || !app.identity.verified || app.identity.kind != WindowsAppKind::aumid ||
        app.identity.aumid.empty() || !windows_file_current(app)) changed();
    foreground(context);
    if (policy.refusal(app.identity) || policy.protected_path(app.image.path)) protected_route();
    winrt::com_ptr<IApplicationActivationManager> manager;
    if (FAILED(CoCreateInstance(CLSID_ApplicationActivationManager, nullptr, CLSCTX_LOCAL_SERVER,
        __uuidof(IApplicationActivationManager), manager.put_void()))) unavailable();
    DWORD pid = 0; HRESULT result = E_FAIL; bool initiated = false, timely = false;
    {
      WindowsComCall call(50);
      if (!call.current()) unavailable();
      if (!context.with_current || !context.with_current([&] {
        std::lock_guard guard(mutex);
        if (closed || !call.current() || !app.lease || !same_stamp(app.image, stamp(app.lease->file_handle()))) return;
        if (policy.refusal(app.identity) || policy.protected_path(app.image.path)) protected_route();
        commit(); initiated = true;
        result = manager->ActivateApplication(app.identity.aumid.c_str(), L"", static_cast<ACTIVATEOPTIONS>(AO_NOERRORUI | AO_NOSPLASHSCREEN), &pid);
      })) changed();
      timely = call.current();
    }
    // Cancellation requests cannot roll back an activation already accepted by Windows. Never retry,
    // substitute a handler, kill an unrelated existing instance, or treat an uncertain PID as proof.
    if (!initiated || !timely || FAILED(result) || pid == 0 || !allowed(context) || !active()) changed();
    const auto owner = observe_windows_process(pid);
    auto identity = owner.identity; identity.pid.reset();
    if (!owner.process.package || owner.process.package->aumid != app.identity.aumid ||
        !same_windows_identity(identity, app.identity) || !same_file(owner.process.image, app.image) ||
        !serving_token_allowed(owner.process.token) || !same_token(owner.process.token, observe_token(GetCurrentProcess())) ||
        !windows_owner_current(owner) || !windows_file_current(app) || !allowed(context)) changed();
    return true;
  }
  void close() {
    std::map<DWORD, std::shared_ptr<Child>> owned;
    std::map<std::wstring, std::shared_ptr<Seal>> retired;
    { std::lock_guard guard(mutex); if (closed) return; closed = true; retired.swap(seals); owned.swap(children); }
    std::vector<HANDLE> pending;
    for (const auto& pair : owned) { (void)TerminateProcess(pair.second->process.get(), 1); pending.push_back(pair.second->process.get()); }
    if (!pending.empty()) (void)WaitForMultipleObjects(static_cast<DWORD>(pending.size()), pending.data(), TRUE, 200);
  }
};
}

bool program_extension_allowed(std::wstring_view path) {
  const auto dot = path.find_last_of(L'.'); if (dot == std::wstring_view::npos) return false;
  const auto extension = lower(std::wstring(path.substr(dot + 1)));
  constexpr std::wstring_view allowed[] = {L"txt",L"md",L"json",L"csv",L"png",L"jpg",L"jpeg",L"gif",L"pdf",L"html",L"htm",L"svg",L"rtf",L"docx",L"xlsx",L"pptx",L"odt",L"ods",L"odp",L"ps1",L"bat",L"cmd",L"vbs",L"wsf",L"js",L"mjs",L"cjs",L"ts",L"py",L"pyw",L"rb",L"pl",L"lua",L"jar"};
  return std::find(std::begin(allowed), std::end(allowed), extension) != std::end(allowed);
}
std::optional<WindowsProgramAssociation> program_association_plan(const std::wstring& executable, const std::vector<std::wstring>& command) {
  if (!canonical_program_path(executable) || command.size() < 2 || command.size() > 33 || lower(command[0]) != lower(executable)) return {};
  std::vector<std::wstring> arguments(command.begin() + 1, command.end());
  if (!valid_program_arguments(arguments)) return {};
  return WindowsProgramAssociation{executable, std::move(arguments)};
}
std::wstring program_command_line(const std::wstring& executable, const std::vector<std::wstring>& arguments) {
  std::wstring result;
  auto quote = [&](const std::wstring& value) {
    if (!result.empty()) result += L' '; result += L'"'; size_t slashes = 0;
    for (const auto c : value) {
      if (c == L'\\') { ++slashes; continue; }
      result.append(c == L'"' ? slashes * 2 + 1 : slashes, L'\\'); slashes = 0; result += c;
    }
    result.append(slashes * 2, L'\\'); result += L'"';
  };
  quote(executable); for (const auto& argument : arguments) quote(argument);
  if (result.size() > 32'766) invalid(); return result;
}
WindowsProgramBackend WindowsProgramBackend::system(WindowsProgramPolicy policy) {
  const auto native = std::make_shared<NativePrograms>(std::move(policy));
  std::thread([weak = std::weak_ptr<NativePrograms>(native)] {
    for (;;) {
      Sleep(100);
      const auto owner = weak.lock(); if (!owner || !owner->active()) return;
      owner->expire();
    }
  }).detach();
  return {
    [native](const auto& path, const auto& current) { return native->resolve(path, current); },
    [native](const JsonObject& requested) {
      if (!native->active()) changed();
      if (requested.HasKey(L"exe") && native->policy.protected_path(std::wstring(requested.GetNamedString(L"exe")))) protected_route();
      const auto identity = requested.GetNamedString(L"kind", L"") == L"aumid"
        ? observe_windows_aumid(std::wstring(requested.GetNamedString(L"aumid")))
        : observe_windows_file(std::wstring(requested.GetNamedString(L"exe")));
      if (!identity.identity.verified || !json_equal(requested, identity.identity.wire())) changed();
      if (native->policy.refusal(identity.identity) || native->policy.protected_path(identity.image.path)) protected_route();
      return identity;
    },
    [native](const auto& artifact, const auto& context) { return native->launch(artifact, context, [] {}); },
    [native](const WindowsStaticIdentity& app, const auto& context, const auto& commit) {
      if (app.identity.kind == WindowsAppKind::aumid) return native->launch_package(app, context, commit);
      if (app.identity.kind != WindowsAppKind::exe || !app.identity.verified || !windows_file_current(app)) unavailable();
      const auto fresh = native->resolve(app.image.path, context.is_current);
      if (fresh.kind != WindowsLaunchKind::app || !fresh.application || !fresh.artifact ||
          !same_windows_identity(app.identity, fresh.application->identity) || !same_file(app.image, fresh.application->image)) changed();
      return native->launch(*fresh.artifact, context, commit);
    },
    [native](const auto& binding) { native->retire(binding); },
    [native] { native->close(); },
  };
}

WindowsProgramService::WindowsProgramService(WindowsProgramPolicy policy, WindowsProgramBackend backend, WindowsBackend windows)
  : policy_(std::move(policy)), backend_(std::move(backend)), windows_(std::move(windows)) {
  if (!policy_.protected_path) policy_.protected_path = windows_protected_path;
  if (!policy_.refusal) policy_.refusal = windows_identity_refusal;
  if (!policy_.require_app) policy_.require_app = [](const auto& identity, const auto& session) { WindowsSessionPolicy(session).require_launch(identity); };
  if (!policy_.require_window) policy_.require_window = [](const auto& window, const auto& session) { WindowsSessionPolicy(session).require(window, WindowsPolicyOperation::activate); };
  if (!backend_.resolve) backend_ = WindowsProgramBackend::system(policy_);
}
WindowsProgramService::~WindowsProgramService() { try { close(); } catch (...) {} }
JsonObject WindowsProgramService::features() const {
  JsonObject value; value.Insert(L"apps.resolve", JsonValue::CreateBooleanValue(true));
  value.Insert(L"program.launch", JsonValue::CreateBooleanValue(true)); value.Insert(L"apps.open", JsonValue::CreateBooleanValue(true)); return value;
}
OperationContext WindowsProgramService::scoped(const OperationContext& original) {
  return {original.session,
    [this, original] { return !closed_.load() && original.is_current && original.is_current(); },
    [this, original](const std::function<void()>& body) {
      if (!original.with_current) return false;
      bool ran = false;
      const auto accepted = original.with_current([&] {
        std::lock_guard guard(authority_);
        if (!closed_.load()) { body(); ran = true; }
      });
      return accepted && ran;
    }};
}
void WindowsProgramService::resolve(const JsonObject& args, const OperationContext& original, Dispatcher::Completion done) {
  const auto context = scoped(original);
  try {
    if (closed_.load() || !allowed(context)) changed();
    if (!keys(args, {L"path"}) || args.Size() != 1) invalid();
    auto result = backend_.resolve(text(args, L"path"), context.is_current); Reply reply;
    const auto identity = result.application ? std::optional{result.application->identity} : result.artifact ? result.artifact->handler : std::nullopt;
    if (identity) if (const auto reason = policy_.refusal(*identity)) {
      result.kind = WindowsLaunchKind::protected_route; result.reason = *reason;
    }
    if (result.kind == WindowsLaunchKind::protected_route) {
      reply.fields.Insert(L"kind", JsonValue::CreateStringValue(L"protected")); reply.fields.Insert(L"reason", JsonValue::CreateStringValue(result.reason));
    } else if (result.kind == WindowsLaunchKind::app && result.application) {
      reply.fields.Insert(L"kind", JsonValue::CreateStringValue(L"app")); reply.fields.Insert(L"identity", result.application->identity.wire());
    } else if (result.kind == WindowsLaunchKind::program && result.artifact) {
      bool prepared = false;
      if (!context.with_current || !context.with_current([&] {
        if (closed_.load()) return;
        const auto launch = registry_.prepare(*result.artifact, *context.session);
        reply.fields.Insert(L"kind", JsonValue::CreateStringValue(L"program")); reply.fields.Insert(L"program", launch.wire()); prepared = true;
      }) || !prepared) changed();
    } else unavailable();
    if (closed_.load() || !allowed(context)) changed(); done(std::move(reply));
  } catch (const Failure& failure) { done(failure); } catch (...) { done(Failure{L"failed", L"The native launch resolution failed."}); }
}
void WindowsProgramService::launch_program(const JsonObject& args, const OperationContext& original, Dispatcher::Completion done) {
  const auto context = scoped(original);
  try {
    if (closed_.load()) changed(); phase(args, context);
    if (!keys(args, {L"token", L"binding", L"sessionId", L"phaseRevision"})) invalid();
    const auto token = text(args, L"token", 256), binding = text(args, L"binding", 64);
    std::optional<NativeProgramArtifact> artifact;
    if (!context.with_current || !context.with_current([&] {
      if (!closed_.load()) artifact = registry_.consume(token, binding, *context.session);
    }) || !artifact) changed();
    struct Retire { WindowsProgramBackend* backend; std::wstring binding; ~Retire() { try { if (backend->retire) backend->retire(binding); } catch (...) {} } } retire_seal{&backend_, artifact->binding};
    const auto fresh = backend_.resolve(artifact->path, context.is_current);
    if (fresh.kind == WindowsLaunchKind::protected_route) protected_route();
    if (fresh.kind != WindowsLaunchKind::program || !fresh.artifact || !same_program_artifact(*artifact, *fresh.artifact)) changed();
    if (artifact->handler && (policy_.refusal(*artifact->handler) || !artifact->handler_path || policy_.protected_path(*artifact->handler_path))) protected_route();
    foreground(context);
    if (!backend_.launch(*artifact, context) || closed_.load() || !allowed(context)) changed();
    Reply result; result.fields.Insert(L"launched", JsonValue::CreateBooleanValue(true)); done(std::move(result));
  } catch (const Failure& failure) { done(failure); } catch (...) { done(Failure{L"failed", L"The native program launch failed."}); }
}
void WindowsProgramService::launch(const JsonObject& args, const OperationContext& original, Dispatcher::Completion done) {
  const auto context = scoped(original);
  try {
    if (closed_.load()) changed(); phase(args, context);
    if (!keys(args, {L"identity", L"path", L"sessionId", L"phaseRevision"}) || args.HasKey(L"identity") == args.HasKey(L"path") || !policy_.require_app) invalid();
    std::optional<WindowsStaticIdentity> target;
    if (args.HasKey(L"identity")) {
      const auto requested = args.Lookup(L"identity"); if (!identity_request_shape(requested)) invalid();
      if (requested.GetObject().HasKey(L"exe") && policy_.protected_path(std::wstring(requested.GetObject().GetNamedString(L"exe")))) protected_route();
      if (!requested.GetObject().GetNamedBoolean(L"verified") && !requested.GetObject().HasKey(L"pid"))
        throw Failure{L"not_granted", L"An unsigned app needs a fresh native program preparation."};
      const bool process_bound = requested.GetObject().HasKey(L"pid");
      std::optional<WindowsStaticIdentity> static_witness;
      if (!process_bound) {
        if (!backend_.observe_identity) unavailable();
        static_witness = backend_.observe_identity(requested.GetObject());
        if (!static_witness->identity.verified || static_witness->identity.pid || !json_equal(requested, static_witness->identity.wire())) changed();
      }
      bool mismatched_running_file = false;
      for (const auto& app : windows_.list(true, context.is_current)) {
        auto identity = app.identity;
        if (!process_bound) identity.pid.reset();
        if (!json_equal(requested, identity.wire())) continue;
        if (app.owner && !process_bound && (!static_witness || !same_file(static_witness->image, app.owner->process.image))) { mismatched_running_file = true; continue; }
        if (target) changed();
        if (app.owner && !app.windows.empty()) {
          if (policy_.refusal(app.identity) || policy_.protected_path(app.identity.exe)) protected_route();
          const auto window = app.windows.front(); policy_.require_window(window, *context.session);
          foreground(context);
          if (!windows_.focus(window, context, [&](const WindowsWindow& live) { policy_.require_window(live, *context.session); }))
            throw Failure{L"not_foreground", L"The actual app did not become foreground."};
          const auto actual = windows_.observe(window.hwnd);
          if (!allowed(context) || !same_windows_window_target(actual, window) || !eligible_windows_window(actual) || !windows_.current(actual)) changed();
          policy_.require_window(actual, *context.session);
          if (!windows_.foreground(actual)) throw Failure{L"not_foreground", L"The actual app did not remain foreground."};
          if (!allowed(context) || !windows_.current(actual)) changed();
          Reply result; result.fields.Insert(L"foreground", JsonValue::CreateBooleanValue(true)); done(std::move(result)); return;
        }
        target = static_witness ? static_witness : app.installed;
      }
      if (!target && mismatched_running_file) changed();
      if (!target && static_witness) target = static_witness;
      if (!target) throw Failure{L"app_not_found", L"The native app identity is unavailable."};
    } else {
      const auto resolved = backend_.resolve(text(args, L"path"), context.is_current);
      if (resolved.kind == WindowsLaunchKind::protected_route) protected_route();
      if (resolved.kind != WindowsLaunchKind::app || !resolved.application) throw Failure{L"not_granted", L"This artifact needs a fresh program preparation."};
      target = resolved.application;
    }
    policy_.require_app(target->identity, *context.session);
    if (policy_.refusal(target->identity) || policy_.protected_path(target->image.path)) protected_route();
    foreground(context);
    if (!backend_.launch_app(*target, context, [&] { policy_.require_app(target->identity, *context.session); }) || closed_.load() || !allowed(context)) changed();
    bool focused = false;
    const auto deadline = GetTickCount64() + 1500;
    while (allowed(context) && !closed_.load() && GetTickCount64() < deadline) {
      for (const auto& app : windows_.list(false, context.is_current)) {
        auto identity = app.identity; identity.pid.reset();
        if (!app.owner || !same_windows_identity(identity, target->identity) || !same_file(app.owner->process.image, target->image) || app.windows.empty()) continue;
        const auto window = app.windows.front(); policy_.require_window(window, *context.session);
        focused = windows_.focus(window, context, [&](const WindowsWindow& live) { policy_.require_window(live, *context.session); });
        if (focused) {
          const auto actual = windows_.observe(window.hwnd);
          if (!allowed(context) || !same_windows_window_target(actual, window) || !eligible_windows_window(actual) || !windows_.current(actual)) changed();
          policy_.require_window(actual, *context.session); focused = windows_.foreground(actual);
          if (!allowed(context) || !windows_.current(actual)) changed();
        }
        break;
      }
      if (focused) break;
      Sleep(10);
    }
    if (!allowed(context) || closed_.load()) changed();
    Reply result; result.fields.Insert(L"foreground", JsonValue::CreateBooleanValue(focused)); done(std::move(result));
  } catch (const Failure& failure) { done(failure); } catch (...) { done(Failure{L"failed", L"The native app launch failed."}); }
}
void WindowsProgramService::invalidate_observations() { registry_.clear(); }
void WindowsProgramService::close() {
  { std::lock_guard guard(authority_); if (closed_.exchange(true)) return; }
  registry_.close(); if (backend_.close) backend_.close();
}
}
