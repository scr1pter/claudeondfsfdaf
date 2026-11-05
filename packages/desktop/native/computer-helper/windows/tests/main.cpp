#include "core.h"
#include "windows_identity.h"
#include "windows_enum.h"
#include "windows_icon.h"
#include "windows_policy.h"
#include "windows_process_tree.h"
#include "windows_program.h"
#include "identity.h"
#include "blocklist.h"
#include "build-config.h"
#include "protocol.h"
#include "server.h"
#include "guard.h"
#include "capture.h"
#include <objidl.h>
#include <xmllite.h>
#include <algorithm>
#include <array>
#include <charconv>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <set>
#include <stdexcept>
#include <utility>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>

namespace vector::computer {
int run_protocol_tests();
size_t run_windows_identity_tests();
void parent_identity_tests();
void lifecycle_tests();
void integration_tests();
void integration_lifecycle_test(bool parent_death);
}

namespace {
using namespace vector::computer;
using winrt::Windows::Data::Json::JsonObject;
using winrt::Windows::Data::Json::JsonValue;

class UnitFailure final : public std::exception {
 public:
  explicit UnitFailure(const char* label) : label_(label) {}
  const char* what() const noexcept override { return label_.c_str(); }
 private:
  std::string label_;
};

void require(bool condition, const char* label) {
  if (!condition) throw UnitFailure(label);
}

std::wstring wide(std::string_view value) {
  const auto converted = winrt::to_hstring(value);
  return std::wstring(converted.c_str(), converted.size());
}

std::filesystem::path own_executable() {
  std::wstring value(32'768, L'\0');
  const auto size = GetModuleFileNameW(nullptr, value.data(), static_cast<DWORD>(value.size()));
  require(size > 0 && size < value.size(), "unit.executable-path");
  value.resize(size);
  return std::filesystem::canonical(value);
}

std::filesystem::path shipped_executable() {
  const auto directory = own_executable().parent_path();
  for (const auto& base : {directory, directory.parent_path()}) {
    const auto candidate = base / wide(identity::kExecutable);
    if (std::filesystem::is_regular_file(candidate)) return std::filesystem::canonical(candidate);
  }
  throw UnitFailure("unit.shipping-executable-missing");
}

std::string resource(HMODULE module, WORD id, LPCWSTR kind) {
  const auto entry = FindResourceW(module, MAKEINTRESOURCEW(id), kind);
  require(entry != nullptr, "unit.resource-missing");
  const auto size = SizeofResource(module, entry);
  require(size > 0 && size <= 1'048'576, "unit.resource-size");
  const auto loaded = LoadResource(module, entry);
  require(loaded != nullptr, "unit.resource-load");
  const auto bytes = static_cast<const char*>(LockResource(loaded));
  require(bytes != nullptr, "unit.resource-lock");
  return std::string(bytes, size);
}

void identity_tables() {
  const auto expected = JsonObject::Parse(winrt::to_hstring(resource(GetModuleHandleW(nullptr), 101, RT_RCDATA)));
  JsonObject protocol;
  protocol.Insert(L"min", JsonValue::CreateNumberValue(identity::kProtocolMin));
  protocol.Insert(L"max", JsonValue::CreateNumberValue(identity::kProtocolMax));
  JsonObject mac;
  mac.Insert(L"bundle", JsonValue::CreateStringValue(winrt::to_hstring(build::kMacBundle)));
  mac.Insert(L"executable", JsonValue::CreateStringValue(winrt::to_hstring(build::kMacExecutable)));
  mac.Insert(L"minimumSystemVersion", JsonValue::CreateStringValue(winrt::to_hstring(build::kMacMinimumSystemVersion)));
  JsonObject windows;
  windows.Insert(L"executable", JsonValue::CreateStringValue(winrt::to_hstring(identity::kExecutable)));
  windows.Insert(L"minimumBuild", JsonValue::CreateNumberValue(identity::kMinimumBuild));
  JsonObject compiled;
  compiled.Insert(L"displayName", JsonValue::CreateStringValue(winrt::to_hstring(identity::kDisplayName)));
  compiled.Insert(L"helperVersion", JsonValue::CreateStringValue(winrt::to_hstring(identity::kHelperVersion)));
  compiled.Insert(L"protocol", protocol);
  compiled.Insert(L"bundleIdSuffix", JsonValue::CreateStringValue(winrt::to_hstring(identity::kBundleIdSuffix)));
  compiled.Insert(L"mac", mac);
  compiled.Insert(L"windows", windows);
  require(json_equal(compiled, expected), "identity.full-json-equality");

  struct Channel { std::string_view name; std::string_view app; std::string_view binary; std::string_view word; };
  constexpr std::array<Channel, 3> channels{{
    {"prod", "ai.vector.app", "vector-desktop.exe", ""},
    {"beta", "ai.vector.app.beta", "vector-desktop-beta.exe", " Beta"},
    {"dev", "ai.vector.app.dev", "vector-desktop-dev.exe", " Dev"},
  }};
  constexpr std::array<std::string_view, 6> electron{{"helper", "helper.Renderer", "helper.GPU", "helper.Plugin", "helper.EH", "helper.NP"}};
  require(identity::kChannels.size() == channels.size(), "identity.channel-count");
  std::vector<std::string> bundles;
  for (size_t index = 0; index < channels.size(); ++index) {
    const auto& actual = identity::kChannels[index];
    const auto& channel = channels[index];
    const auto helper = std::string(channel.app) + "." + std::string(identity::kBundleIdSuffix);
    require(actual.name == channel.name && actual.appId == channel.app && actual.windowsExecutable == channel.binary,
            "identity.channel-matrix");
    require(actual.helperBundleId == helper && actual.helperName == std::string(identity::kDisplayName) + std::string(channel.word),
            "identity.helper-channel-matrix");
    bundles.emplace_back(channel.app);
    bundles.push_back(helper);
    for (const auto suffix : electron) bundles.push_back(std::string(channel.app) + "." + std::string(suffix));
  }
  require(identity::kVectorBundleIds.size() == bundles.size(), "identity.vector-bundle-count");
  for (size_t index = 0; index < bundles.size(); ++index)
    require(identity::kVectorBundleIds[index] == bundles[index], "identity.vector-bundle-matrix");
  constexpr std::array<std::string_view, 4> binaries{{"vector-desktop.exe", "vector-desktop-beta.exe", "vector-desktop-dev.exe", "vector-computer.exe"}};
  require(identity::kVectorWindowsBinaries.size() == binaries.size(), "identity.vector-binary-count");
  for (size_t index = 0; index < binaries.size(); ++index)
    require(identity::kVectorWindowsBinaries[index] == binaries[index], "identity.vector-binary-matrix");

  const auto input = resource(GetModuleHandleW(nullptr), 102, RT_RCDATA);
  std::string joined;
  for (const auto part : blocklist::kJsonParts) joined.append(part);
  require(joined == input, "blocklist.verbatim-equality");
  require(json_equal(JsonObject::Parse(winrt::to_hstring(joined)), JsonObject::Parse(winrt::to_hstring(input))),
          "blocklist.full-json-equality");
}

struct PeMetadata { WORD machine; WORD subsystem; };

PeMetadata pe_metadata(const std::filesystem::path& path) {
  std::ifstream file(path, std::ios::binary);
  require(file.good(), "pe.open");
  IMAGE_DOS_HEADER dos{};
  require(static_cast<bool>(file.read(reinterpret_cast<char*>(&dos), sizeof(dos))), "pe.dos-read");
  require(dos.e_magic == IMAGE_DOS_SIGNATURE && dos.e_lfanew >= static_cast<LONG>(sizeof(dos)) && dos.e_lfanew < 1'048'576,
          "pe.dos-signature");
  file.seekg(dos.e_lfanew);
  DWORD signature = 0;
  IMAGE_FILE_HEADER header{};
  IMAGE_OPTIONAL_HEADER64 optional{};
  require(static_cast<bool>(file.read(reinterpret_cast<char*>(&signature), sizeof(signature))) && signature == IMAGE_NT_SIGNATURE,
          "pe.nt-signature");
  require(static_cast<bool>(file.read(reinterpret_cast<char*>(&header), sizeof(header))) && header.SizeOfOptionalHeader >= sizeof(optional),
          "pe.coff-header");
  require(static_cast<bool>(file.read(reinterpret_cast<char*>(&optional), sizeof(optional))) && optional.Magic == IMAGE_NT_OPTIONAL_HDR64_MAGIC,
          "pe.optional-header");
  require((header.Characteristics & IMAGE_FILE_EXECUTABLE_IMAGE) != 0 && (header.Characteristics & IMAGE_FILE_DLL) == 0,
          "pe.executable-kind");
  return {header.Machine, optional.Subsystem};
}

class ChildCleanup {
 public:
  explicit ChildCleanup(HANDLE child) : child_(child) {}
  ~ChildCleanup() {
    if (!child_) return;
    DWORD code = 0;
    if (!GetExitCodeProcess(child_, &code) || code == STILL_ACTIVE) {
      TerminateProcess(child_, 1);
      WaitForSingleObject(child_, 1000);
    }
  }
 private:
  HANDLE child_;
};

std::string command_output(const std::filesystem::path& executable, std::wstring_view arguments) {
  SECURITY_ATTRIBUTES security{static_cast<DWORD>(sizeof(SECURITY_ATTRIBUTES)), nullptr, TRUE};
  HANDLE read = nullptr;
  HANDLE write = nullptr;
  require(CreatePipe(&read, &write, &security, 0) != FALSE, "version.pipe-create");
  winrt::handle reader(read);
  winrt::handle writer(write);
  require(SetHandleInformation(reader.get(), HANDLE_FLAG_INHERIT, 0) != FALSE, "version.pipe-parent-only");
  winrt::handle input(CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
  require(input && input.get() != INVALID_HANDLE_VALUE, "version.stdin-create");

  SIZE_T attributeBytes = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeBytes);
  require(attributeBytes > 0 && attributeBytes <= 65'536, "version.attribute-size");
  std::vector<unsigned char> attributeData(attributeBytes);
  const auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributeData.data());
  require(InitializeProcThreadAttributeList(attributes, 1, 0, &attributeBytes) != FALSE, "version.attribute-init");
  struct AttributesCleanup { LPPROC_THREAD_ATTRIBUTE_LIST value; ~AttributesCleanup() { DeleteProcThreadAttributeList(value); } } cleanup{attributes};
  std::array<HANDLE, 2> inherited{{writer.get(), input.get()}};
  require(UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited.data(), sizeof(inherited), nullptr, nullptr) != FALSE,
          "version.attribute-handles");
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = static_cast<DWORD>(sizeof(startup));
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = input.get();
  startup.StartupInfo.hStdOutput = writer.get();
  startup.StartupInfo.hStdError = writer.get();
  startup.lpAttributeList = attributes;
  PROCESS_INFORMATION process{};
  auto command = L"\"" + executable.wstring() + L"\" " + std::wstring(arguments);
  const auto start = GetTickCount64();
  require(CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE,
                         EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW, nullptr, nullptr,
                         &startup.StartupInfo, &process) != FALSE, "version.process-create");
  winrt::handle child(process.hProcess);
  winrt::handle thread(process.hThread);
  ChildCleanup childCleanup(child.get());
  writer.close();
  input.close();
  std::string output;
  std::array<char, 4096> bytes{};
  bool exited = false;
  while (true) {
    require(GetTickCount64() - start <= 5000, "version.deadline");
    DWORD available = 0;
    const auto peek = PeekNamedPipe(reader.get(), nullptr, 0, nullptr, &available, nullptr);
    if (!peek) {
      require(GetLastError() == ERROR_BROKEN_PIPE, "version.pipe-peek");
      if (exited) break;
    } else if (available > 0) {
      DWORD received = 0;
      require(ReadFile(reader.get(), bytes.data(), std::min<DWORD>(available, static_cast<DWORD>(bytes.size())), &received, nullptr) != FALSE && received > 0,
              "version.pipe-read");
      require(received <= 65'536 - output.size(), "version.output-bound");
      output.append(bytes.data(), received);
      continue;
    } else if (exited) break;
    const auto wait = WaitForSingleObject(child.get(), 10);
    require(wait == WAIT_OBJECT_0 || wait == WAIT_TIMEOUT, "version.process-wait");
    exited = wait == WAIT_OBJECT_0;
  }
  DWORD exit = 1;
  require(GetExitCodeProcess(child.get(), &exit) != FALSE, "cli.exit-code-unavailable");
  if (exit != 0) {
    std::string label = arguments == L"--version --json" ? "cli.version" : arguments == L"--probe --json" ? "cli.probe" :
      arguments == L"--self-test=unprivileged" ? "cli.unprivileged" : arguments == L"--self-test=packaged" ? "cli.packaged" : "cli.unknown";
    if (arguments == L"--self-test=unprivileged" || arguments == L"--self-test=packaged") {
      // Parse only fixed check names/booleans. Never print a child's private/raw stdout or stderr.
      try {
        const auto report = JsonObject::Parse(winrt::to_hstring(output));
        for (const auto& value : report.GetNamedArray(L"checks")) {
          const auto check = value.GetObject();
          if (check.GetNamedBoolean(L"ok")) continue;
          const auto name = check.GetNamedString(L"name");
          if (name == L"wire-codec") label += ".wire-codec";
          else if (name == L"packaged-pe") label += ".packaged-pe";
          else if (name == L"packaged-manifest") label += ".packaged-manifest";
          else if (name == L"packaged-version") label += ".packaged-version";
          break;
        }
      } catch (...) {}
    }
    if (output == "The computer helper could not start safely.\n") label += ".safe-start";
    label += ".exit-" + std::to_string(exit);
    throw UnitFailure(label.c_str());
  }
  return output;
}

void executable_metadata(const std::filesystem::path& executable) {
  const auto value = JsonObject::Parse(winrt::to_hstring(command_output(executable, L"--version --json")));
  require(json_equal(value, version_document()), "version.actual-json-equality");
  require(value.GetNamedString(L"helperVersion") == winrt::to_hstring(identity::kHelperVersion), "version.helper-version");
  require(value.GetNamedString(L"platform") == L"win32", "version.platform");
  require(value.GetNamedString(L"sourceDigest") == winrt::to_hstring(build::kSourceDigest), "version.source-digest");
  const auto pe = pe_metadata(executable);
  require(pe.subsystem == IMAGE_SUBSYSTEM_WINDOWS_GUI, "pe.windows-gui-subsystem");
  const auto actualArchitecture = pe.machine == IMAGE_FILE_MACHINE_AMD64 ? "x64" : pe.machine == IMAGE_FILE_MACHINE_ARM64 ? "arm64" : "unsupported";
  require(std::string_view(actualArchitecture) == architecture() && value.GetNamedString(L"arch") == winrt::to_hstring(actualArchitecture), "pe.machine-matches-json-architecture");
}

void native_cli_checks(const std::filesystem::path& executable) {
  for (const auto mode : {L"--self-test=unprivileged", L"--self-test=packaged"}) {
    const auto result = JsonObject::Parse(winrt::to_hstring(command_output(executable, mode)));
    require(result.Size() == 1 && result.HasKey(L"checks"), "self-test.report-envelope");
    const auto checks = result.GetNamedArray(L"checks");
    require(checks.Size() == 4, "self-test.actual-check-count");
    std::set<std::wstring> names;
    for (const auto& value : checks) {
      const auto check = value.GetObject();
      require(check.Size() == 2 && check.GetNamedBoolean(L"ok") && !check.HasKey(L"skipped"), "self-test.no-core-skip");
      const auto name = check.GetNamedString(L"name");
      require(names.emplace(name.c_str(), name.size()).second, "self-test.unique-check-names");
    }
    require(names == std::set<std::wstring>{L"wire-codec", L"packaged-pe", L"packaged-manifest", L"packaged-version"}, "self-test.real-check-catalog");
  }
  // A process outside the exact containing install root must not claim responsibility.
  const auto probe = JsonObject::Parse(winrt::to_hstring(command_output(executable, L"--probe --json")));
  require(!probe.GetNamedBoolean(L"responsible") && probe.GetNamedBoolean(L"captureBlocked"), "probe.unverified-parent-refused");
}

std::wstring xml_attribute(IXmlReader* reader, const wchar_t* name) {
  require(reader->MoveToAttributeByName(name, nullptr) == S_OK, "manifest.required-attribute");
  const wchar_t* value = nullptr;
  UINT length = 0;
  winrt::check_hresult(reader->GetValue(&value, &length));
  const std::wstring result(value, length);
  winrt::check_hresult(reader->MoveToElement());
  return result;
}

void check_manifest_xml(std::string_view bytes) {
  winrt::com_ptr<IStream> stream;
  winrt::check_hresult(CreateStreamOnHGlobal(nullptr, TRUE, stream.put()));
  ULONG written = 0;
  winrt::check_hresult(stream->Write(bytes.data(), static_cast<ULONG>(bytes.size()), &written));
  require(written == bytes.size(), "manifest.stream-write");
  LARGE_INTEGER zero{};
  winrt::check_hresult(stream->Seek(zero, STREAM_SEEK_SET, nullptr));
  winrt::com_ptr<IXmlReader> reader;
  winrt::check_hresult(CreateXmlReader(__uuidof(IXmlReader), reader.put_void(), nullptr));
  winrt::check_hresult(reader->SetProperty(XmlReaderProperty_DtdProcessing, DtdProcessing_Prohibit));
  winrt::check_hresult(reader->SetInput(stream.get()));
  std::map<std::wstring, std::wstring> text;
  std::set<std::wstring> seen;
  std::wstring current;
  std::wstring currentNamespace;
  bool execution = false;
  bool supported = false;
  XmlNodeType node = XmlNodeType_None;
  HRESULT status = S_OK;
  while ((status = reader->Read(&node)) == S_OK) {
    if (node == XmlNodeType_Element) {
      require(current.empty(), "manifest.nested-setting");
      const wchar_t* local = nullptr;
      const wchar_t* uri = nullptr;
      UINT localLength = 0;
      UINT uriLength = 0;
      winrt::check_hresult(reader->GetLocalName(&local, &localLength));
      winrt::check_hresult(reader->GetNamespaceUri(&uri, &uriLength));
      const std::wstring name(local, localLength);
      const std::wstring space(uri ? uri : L"", uriLength);
      if (name == L"requestedExecutionLevel" && space == L"urn:schemas-microsoft-com:asm.v3") {
        require(!execution, "manifest.duplicate-execution-level");
        require(xml_attribute(reader.get(), L"level") == L"asInvoker" && xml_attribute(reader.get(), L"uiAccess") == L"false", "manifest.as-invoker-without-uiaccess");
        execution = true;
      }
      if (name == L"supportedOS" && space == L"urn:schemas-microsoft-com:compatibility.v1")
        supported = supported || xml_attribute(reader.get(), L"Id") == L"{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}";
      const bool setting = (name == L"dpiAware" && space == L"http://schemas.microsoft.com/SMI/2005/WindowsSettings") ||
        ((name == L"dpiAwareness" || name == L"longPathAware") && space == L"http://schemas.microsoft.com/SMI/2016/WindowsSettings") ||
        (name == L"activeCodePage" && space == L"http://schemas.microsoft.com/SMI/2019/WindowsSettings");
      if (setting) {
        require(seen.insert(name).second, "manifest.duplicate-setting");
        require(!reader->IsEmptyElement(), "manifest.empty-setting");
        current = name;
        currentNamespace = space;
      }
    } else if (!current.empty() && (node == XmlNodeType_Text || node == XmlNodeType_Whitespace || node == XmlNodeType_CDATA)) {
      const wchar_t* value = nullptr;
      UINT length = 0;
      winrt::check_hresult(reader->GetValue(&value, &length));
      text[current].append(value, length);
    } else if (!current.empty() && node == XmlNodeType_EndElement) {
      // XmlLite measures depth before processing this node, so an end tag's depth differs from its start tag.
      const wchar_t* local = nullptr;
      const wchar_t* uri = nullptr;
      UINT localLength = 0;
      UINT uriLength = 0;
      winrt::check_hresult(reader->GetLocalName(&local, &localLength));
      winrt::check_hresult(reader->GetNamespaceUri(&uri, &uriLength));
      if (current == std::wstring_view(local, localLength) &&
          currentNamespace == std::wstring_view(uri ? uri : L"", uriLength)) {
        current.clear();
        currentNamespace.clear();
      }
    }
  }
  winrt::check_hresult(status);
  require(execution && supported, "manifest.execution-and-supported-os");
  require(text[L"dpiAware"] == L"true/PM", "manifest.legacy-per-monitor-dpi");
  require(text[L"dpiAwareness"] == L"PerMonitorV2", "manifest.per-monitor-v2");
  require(text[L"longPathAware"] == L"true", "manifest.long-path-aware");
  require(text[L"activeCodePage"] == L"UTF-8", "manifest.utf8-codepage");
}

std::wstring version_string(const std::vector<unsigned char>& bytes, const wchar_t* name) {
  auto key = std::wstring(L"\\StringFileInfo\\040904b0\\") + name;
  void* pointer = nullptr;
  UINT length = 0;
  require(VerQueryValueW(bytes.data(), key.c_str(), &pointer, &length) != FALSE && pointer != nullptr && length > 0,
          "version-resource.string-missing");
  const auto start = reinterpret_cast<uintptr_t>(bytes.data());
  const auto value = reinterpret_cast<uintptr_t>(pointer);
  require(value >= start && value - start <= bytes.size() && static_cast<size_t>(length) * sizeof(wchar_t) <= bytes.size() - (value - start),
          "version-resource.string-bound");
  const auto text = static_cast<const wchar_t*>(pointer);
  require(text[length - 1] == L'\0', "version-resource.string-terminator");
  return std::wstring(text, length - 1);
}

void embedded_manifest(const std::filesystem::path& executable) {
  const auto module = LoadLibraryExW(executable.c_str(), nullptr, LOAD_LIBRARY_AS_DATAFILE | LOAD_LIBRARY_AS_IMAGE_RESOURCE);
  require(module != nullptr, "manifest.load-as-data");
  struct ModuleCleanup { HMODULE value; ~ModuleCleanup() { FreeLibrary(value); } } cleanup{module};
  check_manifest_xml(resource(module, 1, RT_MANIFEST));

  // A valid close tag must finish the first value, while a second setting must still be rejected.
  constexpr std::string_view duplicate = R"xml(<root xmlns:ws="http://schemas.microsoft.com/SMI/2005/WindowsSettings"><ws:dpiAware>true/PM</ws:dpiAware><ws:dpiAware>true/PM</ws:dpiAware></root>)xml";
  bool refused = false;
  try { check_manifest_xml(duplicate); }
  catch (const UnitFailure& failure) { refused = std::string_view(failure.what()) == "manifest.duplicate-setting"; }
  require(refused, "manifest.duplicate-fixture-refused");
}

void embedded_version(const std::filesystem::path& executable) {
  DWORD ignored = 0;
  const auto size = GetFileVersionInfoSizeW(executable.c_str(), &ignored);
  require(size > 0 && size <= 65'536, "version-resource.size");
  std::vector<unsigned char> bytes(size);
  require(GetFileVersionInfoW(executable.c_str(), 0, size, bytes.data()) != FALSE, "version-resource.read");
  require(version_string(bytes, L"FileDescription") == wide(identity::kDisplayName), "version-resource.file-description");
  require(version_string(bytes, L"ProductName") == L"Vector", "version-resource.product-name");
  require(version_string(bytes, L"FileVersion") == wide(identity::kHelperVersion) &&
          version_string(bytes, L"ProductVersion") == wide(identity::kHelperVersion), "version-resource.version-strings");
  require(version_string(bytes, L"OriginalFilename") == wide(identity::kExecutable), "version-resource.original-filename");
  void* pointer = nullptr;
  UINT length = 0;
  require(VerQueryValueW(bytes.data(), L"\\", &pointer, &length) != FALSE && pointer != nullptr && length >= sizeof(VS_FIXEDFILEINFO), "version-resource.fixed-info");
  const auto start = reinterpret_cast<uintptr_t>(bytes.data());
  const auto address = reinterpret_cast<uintptr_t>(pointer);
  require(address >= start && address - start <= bytes.size() && sizeof(VS_FIXEDFILEINFO) <= bytes.size() - (address - start), "version-resource.fixed-bound");
  const auto fixed = static_cast<const VS_FIXEDFILEINFO*>(pointer);
  require(fixed->dwSignature == VS_FFI_SIGNATURE && fixed->dwFileType == VFT_APP && fixed->dwFileOS == VOS_NT_WINDOWS32,
          "version-resource.fixed-kind");
  std::array<unsigned, 4> version{};
  auto rest = identity::kHelperVersion;
  for (size_t index = 0; index < 3; ++index) {
    const auto end = rest.find('.');
    const auto part = rest.substr(0, end);
    const auto parsed = std::from_chars(part.data(), part.data() + part.size(), version[index]);
    require(parsed.ec == std::errc{} && parsed.ptr == part.data() + part.size() && version[index] <= 0xffff, "version-resource.numeric-version");
    if (end != std::string_view::npos) rest.remove_prefix(end + 1);
  }
  const DWORD most = (version[0] << 16) | version[1];
  const DWORD least = (version[2] << 16) | version[3];
  require(fixed->dwFileVersionMS == most && fixed->dwFileVersionLS == least &&
          fixed->dwProductVersionMS == most && fixed->dwProductVersionLS == least, "version-resource.numeric-equality");
}

void command_line() {
  const auto parse = [](std::initializer_list<const wchar_t*> arguments) {
    std::vector<std::wstring> values;
    for (const auto value : arguments) values.emplace_back(value);
    return parse_command(values);
  };
  const auto version = parse({L"--version", L"--json"});
  const auto probe = parse({L"--probe", L"--json"});
  require(version && version->mode == Mode::version, "cli.version");
  require(probe && probe->mode == Mode::probe, "cli.probe");
  const auto serve = parse({L"--stdio", L"--parent-pid", L"123"});
  require(serve && serve->mode == Mode::serve && serve->parent == 123, "cli.serve");
  const auto self = parse({L"--self-test=privileged", L"--target", L"isolated-target", L"--report", L"report.json"});
  require(self && self->mode == Mode::self_test && self->self_test == L"privileged" && self->target == L"isolated-target", "cli.self-test");
  for (const auto& arguments : std::vector<std::vector<std::wstring>>{
      {}, {L"--version"}, {L"--version", L"--json", L"--json"}, {L"--probe", L"--version", L"--json"},
      {L"--stdio", L"--parent-pid", L"0"}, {L"--stdio", L"--parent-pid", L"-1"},
      {L"--stdio", L"--parent-pid", L"4294967296"}, {L"--stdio", L"--parent-pid", L"1", L"--parent-pid", L"2"},
      {L"--self-test=unknown"}, {L"--self-test=unprivileged", L"--stdio"}, {L"--unknown"}})
    require(!parse_command(arguments), "cli.invalid-arguments");
}

template<class Check> void run_check(const char* label, Check check) {
  try { check(); }
  catch (const UnitFailure&) { throw; }
  catch (const std::exception& error) {
    const std::string_view detail(error.what(), strnlen_s(error.what(), 129));
    const bool fixed = detail.size() <= 128 &&
      (detail.starts_with("protocol.") || detail.starts_with("server.") || detail.starts_with("parent.") || detail.starts_with("lifecycle.") || detail.starts_with("integration.") ||
        detail.starts_with("windows-") || detail.starts_with("policy.") || detail.starts_with("tree.") || detail.starts_with("program.") || detail.starts_with("guard.") || detail.starts_with("capture.")) &&
      std::all_of(detail.begin(), detail.end(), [](char value) { return (value >= 'a' && value <= 'z') || (value >= '0' && value <= '9') || value == '.' || value == '-'; });
    throw UnitFailure(fixed ? error.what() : label);
  }
  catch (...) { throw UnitFailure(label); }
  std::cout << "PASS " << label << '\n';
}
}

int main(int argc, char** argv) {
  if (argc == 2 && (std::string_view(argv[1]) == "--self-test=lifecycle-eof" || std::string_view(argv[1]) == "--self-test=lifecycle-parent-death")) {
    const bool parent_death = std::string_view(argv[1]) == "--self-test=lifecycle-parent-death";
    bool passed = false;
    try {
      winrt::init_apartment(winrt::apartment_type::multi_threaded);
      integration_lifecycle_test(parent_death);
      passed = true;
    } catch (...) {}
    // A finite native test report contains no observed path, token, PID, transcript or private content.
    std::cout << "{\"checks\":[{\"name\":\"" << (parent_death ? "caller-parent-death" : "caller-eof") << "\",\"ok\":" << (passed ? "true" : "false") << "}]}\n";
    return passed ? 0 : 1;
  }
  try {
    require(argc == 1, "unit.unexpected-arguments");
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    const auto executable = shipped_executable();
    run_check("identity-and-blocklist", identity_tables);
    run_check("command-line", command_line);
    run_check("executable-json-and-pe", [&] { executable_metadata(executable); });
    run_check("embedded-manifest", [&] { embedded_manifest(executable); });
    run_check("embedded-version", [&] { embedded_version(executable); });
    run_check("native-cli-checks", [&] { native_cli_checks(executable); });
    run_check("protocol", [] { static_cast<void>(run_protocol_tests()); });
    run_check("server", [] { static_cast<void>(run_server_tests()); });
    run_check("parent-identity", parent_identity_tests);
    run_check("lifecycle", lifecycle_tests);
    run_check("caller-and-native-lifecycle", integration_tests);
    run_check("window-identities", [] { static_cast<void>(run_windows_identity_tests()); });
    run_check("window-catalog-and-focus", [] { static_cast<void>(run_windows_enum_tests()); });
    run_check("generated-app-icons", [] { static_cast<void>(run_windows_icon_tests()); });
    run_check("window-policy", [] { static_cast<void>(run_windows_policy_tests()); });
    run_check("native-process-tree", [] { static_cast<void>(run_windows_process_tree_tests()); });
    run_check("program-capabilities", [] { static_cast<void>(run_program_registry_tests()); });
    run_check("program-resolution-and-launch", [] { static_cast<void>(run_windows_program_tests()); });
    run_check("live-target-guard", [] { static_cast<void>(run_guard_tests()); });
    run_check("capture-geometry-and-privacy", [] { static_cast<void>(run_capture_math_tests()); });
    run_check("capture-service-and-receipts", [] { static_cast<void>(run_capture_tests()); });
    std::cout << "Windows computer helper unit checks passed.\n";
    return 0;
  } catch (const UnitFailure& failure) {
    std::cerr << "FAIL " << failure.what() << '\n';
    return 1;
  } catch (...) {
    std::cerr << "FAIL unit.initialization\n";
    return 1;
  }
}
