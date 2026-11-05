#include "core.h"
#include "identity.h"
#include "build-config.h"
#include "lifecycle.h"
#include "parent_identity.h"
#include "protocol.h"
#include "server.h"
#include "windows_enum.h"
#include "windows_policy.h"
#include "windows_process_tree.h"
#include "windows_program.h"
#include "capture.h"
#include "input.h"
#include "input_guardian.h"
#include "uia_input.h"
#include "accessibility.h"
#include <tlhelp32.h>
#include <objidl.h>
#include <xmllite.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <filesystem>
#include <fstream>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <stdexcept>
#include <winrt/Windows.Foundation.h>

namespace vector::computer {
namespace {
void require_native(bool value) { if (!value) throw std::runtime_error("native self-test failed"); }

DWORD immediate_parent() {
  winrt::handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  require_native(snapshot && snapshot.get() != INVALID_HANDLE_VALUE);
  PROCESSENTRY32W entry{};
  entry.dwSize = static_cast<DWORD>(sizeof(entry));
  require_native(Process32FirstW(snapshot.get(), &entry) != FALSE);
  size_t count = 0;
  do {
    require_native(++count <= 65'536);
    if (entry.th32ProcessID == GetCurrentProcessId()) return entry.th32ParentProcessID;
  }
  while (Process32NextW(snapshot.get(), &entry));
  throw std::runtime_error("parent unavailable");
}

std::filesystem::path own_image() {
  std::wstring value(32'768, L'\0');
  const auto length = GetModuleFileNameW(nullptr, value.data(), static_cast<DWORD>(value.size()));
  require_native(length > 0 && length < value.size());
  value.resize(length);
  return std::filesystem::canonical(value);
}

bool check_pe(const std::filesystem::path& path) {
  std::ifstream file(path, std::ios::binary);
  IMAGE_DOS_HEADER dos{};
  require_native(static_cast<bool>(file.read(reinterpret_cast<char*>(&dos), sizeof(dos))));
  require_native(dos.e_magic == IMAGE_DOS_SIGNATURE && dos.e_lfanew >= static_cast<LONG>(sizeof(dos)) && dos.e_lfanew < 1'048'576);
  file.seekg(dos.e_lfanew);
  DWORD signature = 0;
  IMAGE_FILE_HEADER header{};
  IMAGE_OPTIONAL_HEADER64 optional{};
  require_native(static_cast<bool>(file.read(reinterpret_cast<char*>(&signature), sizeof(signature))) && signature == IMAGE_NT_SIGNATURE);
  require_native(static_cast<bool>(file.read(reinterpret_cast<char*>(&header), sizeof(header))) && header.SizeOfOptionalHeader >= sizeof(optional));
  require_native(static_cast<bool>(file.read(reinterpret_cast<char*>(&optional), sizeof(optional))));
  const auto machine = architecture() == "x64" ? IMAGE_FILE_MACHINE_AMD64 : IMAGE_FILE_MACHINE_ARM64;
  return header.Machine == machine && (header.Characteristics & IMAGE_FILE_EXECUTABLE_IMAGE) != 0 &&
    (header.Characteristics & IMAGE_FILE_DLL) == 0 && optional.Magic == IMAGE_NT_OPTIONAL_HDR64_MAGIC &&
    optional.Subsystem == IMAGE_SUBSYSTEM_WINDOWS_GUI;
}

std::wstring manifest_attribute(IXmlReader* reader, const wchar_t* name) {
  require_native(reader->MoveToAttributeByName(name, nullptr) == S_OK);
  const wchar_t* value = nullptr;
  UINT length = 0;
  winrt::check_hresult(reader->GetValue(&value, &length));
  const std::wstring result(value, length);
  winrt::check_hresult(reader->MoveToElement());
  return result;
}

bool check_manifest() {
  const auto module = GetModuleHandleW(nullptr);
  const auto resource = FindResourceW(module, MAKEINTRESOURCEW(1), RT_MANIFEST);
  require_native(resource != nullptr);
  const auto size = SizeofResource(module, resource);
  require_native(size > 0 && size <= 1'048'576);
  const auto loaded = LoadResource(module, resource);
  const auto bytes = loaded ? LockResource(loaded) : nullptr;
  require_native(bytes != nullptr);
  winrt::com_ptr<IStream> stream;
  winrt::check_hresult(CreateStreamOnHGlobal(nullptr, TRUE, stream.put()));
  ULONG written = 0;
  winrt::check_hresult(stream->Write(bytes, size, &written));
  require_native(written == size);
  LARGE_INTEGER zero{};
  winrt::check_hresult(stream->Seek(zero, STREAM_SEEK_SET, nullptr));
  winrt::com_ptr<IXmlReader> reader;
  winrt::check_hresult(CreateXmlReader(__uuidof(IXmlReader), reader.put_void(), nullptr));
  winrt::check_hresult(reader->SetProperty(XmlReaderProperty_DtdProcessing, DtdProcessing_Prohibit));
  winrt::check_hresult(reader->SetInput(stream.get()));
  bool execution = false;
  bool supported = false;
  XmlNodeType node = XmlNodeType_None;
  HRESULT status = S_OK;
  while ((status = reader->Read(&node)) == S_OK) {
    UINT depth = 0;
    winrt::check_hresult(reader->GetDepth(&depth));
    require_native(depth <= 32);
    if (node != XmlNodeType_Element) continue;
    const wchar_t* local = nullptr;
    const wchar_t* uri = nullptr;
    UINT length = 0;
    UINT uri_length = 0;
    winrt::check_hresult(reader->GetLocalName(&local, &length));
    winrt::check_hresult(reader->GetNamespaceUri(&uri, &uri_length));
    const std::wstring_view name(local, length);
    const std::wstring_view space(uri ? uri : L"", uri_length);
    if (name == L"requestedExecutionLevel" && space == L"urn:schemas-microsoft-com:asm.v3") {
      require_native(!execution && manifest_attribute(reader.get(), L"level") == L"asInvoker" && manifest_attribute(reader.get(), L"uiAccess") == L"false");
      execution = true;
    }
    if (name == L"supportedOS" && space == L"urn:schemas-microsoft-com:compatibility.v1")
      supported = supported || manifest_attribute(reader.get(), L"Id") == L"{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}";
  }
  winrt::check_hresult(status);
  return execution && supported;
}

bool check_version(const std::filesystem::path& path) {
  DWORD ignored = 0;
  const auto size = GetFileVersionInfoSizeW(path.c_str(), &ignored);
  require_native(size > 0 && size <= 65'536);
  std::vector<unsigned char> bytes(size);
  require_native(GetFileVersionInfoW(path.c_str(), 0, size, bytes.data()) != FALSE);
  const auto string = [&](const wchar_t* name) {
    const auto key = std::wstring(L"\\StringFileInfo\\040904b0\\") + name;
    void* data = nullptr;
    UINT length = 0;
    require_native(VerQueryValueW(bytes.data(), key.c_str(), &data, &length) != FALSE && data != nullptr && length > 0);
    const auto begin = reinterpret_cast<uintptr_t>(bytes.data());
    const auto address = reinterpret_cast<uintptr_t>(data);
    require_native(address >= begin && address - begin <= bytes.size() && static_cast<size_t>(length) * sizeof(wchar_t) <= bytes.size() - (address - begin));
    const auto text = static_cast<const wchar_t*>(data);
    require_native(text[length - 1] == L'\0');
    return std::wstring(text, length - 1);
  };
  return string(L"FileVersion") == winrt::to_hstring(identity::kHelperVersion).c_str() &&
    string(L"ProductVersion") == winrt::to_hstring(identity::kHelperVersion).c_str() &&
    string(L"OriginalFilename") == winrt::to_hstring(identity::kExecutable).c_str() &&
    string(L"FileDescription") == winrt::to_hstring(identity::kDisplayName).c_str();
}

struct ServingRuntime {
  std::mutex mutex;
  std::shared_ptr<Dispatcher> server;
  std::shared_ptr<PipeFrameWriter> writer;
  std::shared_ptr<WindowsProgramService> programs;
  std::shared_ptr<CaptureService> capture;
  std::shared_ptr<InputService> input;
  std::shared_ptr<AccessibilityService> accessibility;
  std::atomic_int exit_code{0};
  void stop(StopReason reason) {
    if (lifecycle_exit_code(reason) != 0) exit_code.store(1);
    std::shared_ptr<Dispatcher> dispatcher;
    std::shared_ptr<PipeFrameWriter> output;
    std::shared_ptr<WindowsProgramService> launches;
    std::shared_ptr<CaptureService> screenshots;
    std::shared_ptr<InputService> inputs;
    std::shared_ptr<AccessibilityService> elements;
    { std::scoped_lock lock(mutex); dispatcher = server; output = writer; launches = programs; screenshots = capture; inputs=input; elements=accessibility; }
    if (output) output->cancel();
    if (dispatcher) dispatcher->close(L"transport stopped");
    if (inputs) inputs->close();
    if (elements) elements->close();
    if (launches) launches->close();
    if (screenshots) screenshots->close();
  }
};

int serve(const Command& command, HANDLE output) {
  const auto runtime = std::make_shared<ServingRuntime>();
  const auto input = GetStdHandle(STD_INPUT_HANDLE);
  // The lifetime fuse is armed before any signature, file hash, or token verification can block.
  const auto lifecycle = std::make_shared<HelperLifecycle>(command.parent, input, [runtime](StopReason reason) {
    // Lifecycle callbacks run on their own thread; WinRT activation is per-thread, not inherited.
    bool initialized = false;
    try {
      winrt::init_apartment(winrt::apartment_type::multi_threaded); initialized = true;
      runtime->stop(reason);
    } catch (...) { runtime->exit_code.store(1); }
    if (initialized) winrt::uninit_apartment();
  });
  try {
    const auto parent = verify_parent(command.parent);
    require_native(lifecycle->bind_parent(parent) && !lifecycle->stopping());
    require_native(lifecycle->attach_io_thread(GetCurrentThread()));
    const std::weak_ptr<HelperLifecycle> weak_lifecycle = lifecycle;
    const auto writer = std::make_shared<PipeFrameWriter>(output, lifecycle->stop_event(), [weak_lifecycle] {
      if (const auto active = weak_lifecycle.lock()) active->request_stop(StopReason::transport_error);
    });
    const auto native_windows = WindowsBackend::system(windows_child_shell);
    const auto windows = std::make_shared<WindowService>(windows_window_policy(), native_windows);
    WindowsProgramPolicy launch_policy;
    launch_policy.protected_path = windows_protected_path;
    launch_policy.refusal = windows_identity_refusal;
    launch_policy.require_app = [](const WindowsAppIdentity& identity, const ServerSession& session) { WindowsSessionPolicy(session).require_launch(identity); };
    launch_policy.require_window = [](const WindowsWindow& window, const ServerSession& session) { WindowsSessionPolicy(session).require(window, WindowsPolicyOperation::activate); };
    const auto programs = std::make_shared<WindowsProgramService>(launch_policy, WindowsProgramBackend::system(launch_policy), native_windows);
    const auto captures = std::make_shared<CaptureService>();
    const auto guardian=InputGuardian::native();
    auto native_input=InputBackend::system(captures,guardian);
    const auto input_rules=native_input.text_rules;
    const auto uia=WindowsUiaBackend::system();
    const auto accessibility=std::make_shared<AccessibilityService>(AccessibilityBackend::system(captures,uia));
    const std::weak_ptr<AccessibilityService> weak_accessibility=accessibility;
    const auto inputs=std::make_shared<InputService>(uia_input_provider(uia,[weak_accessibility](const auto& observed,const auto& expected,const auto& session) {
      const auto active=weak_accessibility.lock();
      if (!active) throw Failure{L"stale_ref",L"The accessibility observation is unavailable."};
      active->verify_input(observed,expected,session);
    },{},input_rules),std::move(native_input));
    Dispatcher::Options options;
    options.responsible = true;
    options.send = [writer](const JsonObject& document, std::span<const uint8_t> image) { return writer->write(document, image); };
    options.available = [weak_lifecycle] { const auto active = weak_lifecycle.lock(); return active && !active->stopping(); };
    options.stopped = [weak_lifecycle] { if (const auto active = weak_lifecycle.lock()) active->request_stop(StopReason::shutdown); };
    options.session_changed = [accessibility](const auto& session) { accessibility->note_session(session); };
    options.observations_invalidated = [programs, captures, accessibility] { programs->invalidate_observations(); captures->invalidate(); accessibility->invalidate_observations(); };
    options.cleanup = [programs, captures, accessibility](std::wstring_view) { programs->invalidate_observations(); captures->invalidate(); accessibility->invalidate_observations(true); };
    options.release_all=[inputs] { return inputs->release_all(); };
    options.prepare_release_all=[inputs] { return inputs->prepare_release_all(); };
    options.features = [windows, programs, captures, inputs, accessibility] {
      auto features = windows->features();
      for (const auto& entry : programs->features()) features.Insert(entry.Key(), entry.Value());
      for (const auto& entry : captures->features()) features.Insert(entry.Key(), entry.Value());
      for (const auto& entry : inputs->features()) features.Insert(entry.Key(), entry.Value());
      for (const auto& entry : accessibility->features()) features.Insert(entry.Key(), entry.Value());
      return features;
    };
    const auto server = std::make_shared<Dispatcher>(std::move(options));
    server->register_handler(L"apps.list", 5000, false, false, [windows](const auto& request, const auto& context, auto done) { windows->list(request.args, context, std::move(done)); });
    server->register_handler(L"cursor.position", 4000, false, false, [windows](const auto& request, const auto& context, auto done) { windows->cursor(request.args, context, std::move(done)); });
    server->register_handler(L"app.activate", 10'000, true, true, [windows](const auto& request, const auto& context, auto done) { windows->activate(request.args, context, std::move(done)); });
    server->register_handler(L"window.focus", 10'000, true, true, [windows](const auto& request, const auto& context, auto done) { windows->focus(request.args, context, std::move(done)); });
    server->register_handler(L"apps.resolve", 15'000, true, false, [programs](const auto& request, const auto& context, auto done) { programs->resolve(request.args, context, std::move(done)); });
    server->register_handler(L"app.launch", 15'000, true, true, [programs](const auto& request, const auto& context, auto done) { programs->launch(request.args, context, std::move(done)); });
    server->register_handler(L"program.launch", 15'000, true, true, [programs](const auto& request, const auto& context, auto done) { programs->launch_program(request.args, context, std::move(done)); });
    server->register_handler(L"displays.list", 4000, false, false, [captures](const auto& request, const auto& context, auto done) { captures->displays(request.args, context, std::move(done)); });
    server->register_handler(L"capture", 10'000, true, false, [captures](const auto& request, const auto& context, auto done) { captures->capture(request.args, context, std::move(done)); });
    server->register_handler(L"ui.tree",15'000,true,false,[accessibility](const auto& request,const auto& context,auto done) { accessibility->tree(request.args,context,std::move(done)); });
    server->register_handler(L"ui.hittest",5000,true,false,[accessibility](const auto& request,const auto& context,auto done) { accessibility->hit_test(request.args,context,std::move(done)); });
    server->register_handler(L"ui.focused",5000,true,false,[accessibility](const auto& request,const auto& context,auto done) { accessibility->focused(request.args,context,std::move(done)); });
    server->register_handler(L"ui.resolve",5000,true,false,[accessibility](const auto& request,const auto& context,auto done) { accessibility->resolve(request.args,context,std::move(done)); });
    server->register_handler(L"ui.perform",5000,true,true,[accessibility](const auto& request,const auto& context,auto done) { accessibility->perform(request.args,context,std::move(done)); });
    server->register_handler(L"ui.setValue",5000,true,true,[accessibility](const auto& request,const auto& context,auto done) { accessibility->set_value(request.args,context,std::move(done)); });
    for (const auto op:{L"input.click",L"input.move",L"input.drag",L"input.scroll",L"input.key",L"input.type",L"input.hold"})
      server->register_handler(op,30'000,true,true,[inputs](const auto& request,const auto& context,auto done) { inputs->handle(request.op,request.args,context,std::move(done)); });
    { std::scoped_lock lock(runtime->mutex); runtime->writer = writer; runtime->server = server; runtime->programs = programs; runtime->capture = captures; runtime->input=inputs; runtime->accessibility=accessibility; }
    if (lifecycle->stopping()) runtime->stop(StopReason::eof);
    FrameReader reader;
    std::array<uint8_t, 65'536> bytes{};
    while (!lifecycle->stopping()) {
      DWORD received = 0;
      if (!ReadFile(input, bytes.data(), static_cast<DWORD>(bytes.size()), &received, nullptr)) {
        const auto failure = GetLastError();
        if (!lifecycle->stopping()) lifecycle->request_stop(failure == ERROR_BROKEN_PIPE ? StopReason::eof : StopReason::transport_error);
        break;
      }
      if (received == 0) { lifecycle->request_stop(StopReason::eof); break; }
      if (lifecycle->stopping()) break;
      reader.consume(std::span<const uint8_t>(bytes.data(), received),
        [server](Request request) { server->receive(request); },
        [server](JsonObject failure) { server->send_protocol_failure(failure); });
    }
    // Partial EOF is never a new request and cannot retain task authority.
    reader.finish();
    runtime->stop(StopReason::eof);
    require_native(server->wait_for_output(200));
    require_native(writer->close(std::chrono::milliseconds(200)));
  } catch (...) {
    runtime->exit_code.store(1);
    lifecycle->request_stop(StopReason::transport_error);
    runtime->stop(StopReason::transport_error);
  }
  // Fatal lifecycle state is synchronous; its separately scheduled cleanup callback may still be pending.
  const auto code = std::max(runtime->exit_code.load(), lifecycle->exit_code());
  // finish keeps the independent hard fuse armed through process death, including CRT/DLL teardown.
  lifecycle->finish(code);
  TerminateProcess(GetCurrentProcess(), static_cast<UINT>(code));
  return code;
}
}

std::optional<Command> parse_command(std::span<const std::wstring> arguments) {
  std::set<std::wstring> flags;
  std::map<std::wstring, std::wstring> values;
  for (size_t index = 0; index < arguments.size(); ++index) {
    const auto& argument = arguments[index];
    if (argument == L"--version" || argument == L"--probe" || argument == L"--json" || argument == L"--stdio") {
      if (!flags.insert(argument).second) return std::nullopt;
    } else if (argument == L"--parent-pid" || argument == L"--target" || argument == L"--report") {
      if (++index >= arguments.size() || values.contains(argument)) return std::nullopt;
      const auto& value = arguments[index];
      if (value.empty() || value.size() > 16'384 || value.find(L'\0') != std::wstring::npos || value.starts_with(L"--")) return std::nullopt;
      values.emplace(argument, value);
    } else if (argument.starts_with(L"--self-test=")) {
      const auto mode = argument.substr(12);
      if ((mode != L"unprivileged" && mode != L"privileged" && mode != L"packaged") || !values.emplace(L"self-test", mode).second) return std::nullopt;
    } else return std::nullopt;
  }
  if (values.contains(L"self-test")) {
    if (!flags.empty() || values.contains(L"--parent-pid")) return std::nullopt;
    return Command{Mode::self_test, 0, values[L"self-test"], values[L"--target"], values[L"--report"]};
  }
  if (values.empty() && flags == std::set<std::wstring>{L"--version", L"--json"}) return Command{Mode::version};
  if (values.empty() && flags == std::set<std::wstring>{L"--probe", L"--json"}) return Command{Mode::probe};
  if (flags != std::set<std::wstring>{L"--stdio"} || values.size() != 1 || !values.contains(L"--parent-pid")) return std::nullopt;
  uint64_t parent = 0;
  for (const wchar_t digit : values[L"--parent-pid"]) {
    if (digit < L'0' || digit > L'9') return std::nullopt;
    parent = parent * 10 + static_cast<unsigned>(digit - L'0');
    if (parent > std::numeric_limits<DWORD>::max()) return std::nullopt;
  }
  if (parent == 0) return std::nullopt;
  return Command{Mode::serve, static_cast<DWORD>(parent)};
}

std::string_view architecture() {
#if defined(_M_X64)
  return "x64";
#elif defined(_M_ARM64)
  return "arm64";
#else
#error Unsupported helper architecture
#endif
}

JsonObject version_document() {
  JsonObject protocol;
  protocol.Insert(L"min", JsonValue::CreateNumberValue(identity::kProtocolMin));
  protocol.Insert(L"max", JsonValue::CreateNumberValue(identity::kProtocolMax));
  JsonObject value;
  value.Insert(L"helperVersion", JsonValue::CreateStringValue(winrt::to_hstring(identity::kHelperVersion)));
  value.Insert(L"protocol", protocol);
  value.Insert(L"platform", JsonValue::CreateStringValue(L"win32"));
  value.Insert(L"arch", JsonValue::CreateStringValue(winrt::to_hstring(architecture())));
  value.Insert(L"sourceDigest", JsonValue::CreateStringValue(winrt::to_hstring(build::kSourceDigest)));
  return value;
}

std::optional<bool> process_elevated(std::string* diagnostic) {
  if (diagnostic) diagnostic->clear();
  try {
    const auto token = observe_token(GetCurrentProcess());
    return token.elevated || token.integrity >= SECURITY_MANDATORY_HIGH_RID;
  } catch (const TokenObservationError& error) {
    if (diagnostic) *diagnostic = "token.step." + std::to_string(static_cast<unsigned>(error.step)) + ".information." + std::to_string(error.information_class) + ".error-" + std::to_string(error.win32_error);
    return std::nullopt;
  } catch (...) { return std::nullopt; }
}

bool write_utf8(HANDLE output, std::string_view value) {
  if (!output || output == INVALID_HANDLE_VALUE) return false;
  while (!value.empty()) {
    DWORD written = 0;
    const auto count = static_cast<DWORD>(std::min<size_t>(value.size(), 65'536));
    if (!WriteFile(output, value.data(), count, &written, nullptr) || written == 0 || written > count) return false;
    value.remove_prefix(written);
  }
  return true;
}

int run_command(const Command& command, HANDLE output, HANDLE error) {
  if (command.mode == Mode::serve) return serve(command, output);
  JsonObject result;
  if (command.mode == Mode::version) result = version_document();
  else if (command.mode == Mode::probe) {
    std::string diagnostic;
    const auto elevated = process_elevated(&diagnostic);
    if (!elevated) {
      write_utf8(error, "The helper process token could not be read.\n");
      if (!diagnostic.empty()) write_utf8(error, diagnostic + "\n");
      return 1;
    }
    JsonObject permissions;
    permissions.Insert(L"screen", JsonValue::CreateStringValue(L"n/a"));
    permissions.Insert(L"accessibility", JsonValue::CreateStringValue(L"n/a"));
    result.Insert(L"permissions", permissions);
    bool responsible = false;
    try {
      const auto parent = verify_parent(immediate_parent());
      responsible = parent->unchanged();
    } catch (...) { /* A read-only probe reports a refused parent without inventing responsibility. */ }
    result.Insert(L"responsible", JsonValue::CreateBooleanValue(responsible));
    result.Insert(L"elevated", JsonValue::CreateBooleanValue(*elevated));
    // W8 supplies the actual capture availability probe. A skeleton must never advertise capture readiness.
    result.Insert(L"captureBlocked", JsonValue::CreateBooleanValue(true));
  } else if (command.mode == Mode::self_test) {
    JsonArray checks;
    bool all = true;
    const auto add = [&](std::wstring_view name, const std::function<bool()>& test, bool skipped = false) {
      bool passed = false;
      if (!skipped) { try { passed = test(); } catch (...) {} }
      JsonObject check;
      check.Insert(L"name", JsonValue::CreateStringValue(name));
      check.Insert(L"ok", JsonValue::CreateBooleanValue(passed));
      if (skipped) check.Insert(L"skipped", JsonValue::CreateBooleanValue(true));
      checks.Append(check);
      if (!passed) all = false;
    };
    if (command.self_test == L"privileged") add(L"windows-privileged-target-pending", [] { return false; }, true);
    else {
      // These grant-free checks inspect the running binary and actual codec. The driver separately
      // executes every unconditional golden transcript against the real framed child process.
      const auto image = own_image();
      winrt::handle held(CreateFileW(image.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
      require_native(held && held.get() != INVALID_HANDLE_VALUE);
      add(L"wire-codec", run_protocol_self_test);
      add(L"packaged-pe", [&] { return check_pe(image); });
      add(L"packaged-manifest", check_manifest);
      add(L"packaged-version", [&] { return check_version(image); });
    }
    result.Insert(L"checks", checks);
    const auto document = winrt::to_string(result.Stringify()) + "\n";
    if (!command.report.empty()) {
      winrt::handle report(CreateFileW(command.report.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr));
      if (!report || report.get() == INVALID_HANDLE_VALUE || !write_utf8(report.get(), document)) return 1;
    }
    if (!write_utf8(output, document)) return 1;
    return command.self_test == L"privileged" ? 77 : all ? 0 : 1;
  }
  return write_utf8(output, winrt::to_string(result.Stringify()) + "\n") ? 0 : 1;
}

bool json_equal(const winrt::Windows::Data::Json::IJsonValue& left,
                const winrt::Windows::Data::Json::IJsonValue& right, unsigned depth) {
  if (depth > 64 || left.ValueType() != right.ValueType()) return false;
  switch (left.ValueType()) {
    case JsonValueType::Null: return true;
    case JsonValueType::Boolean: return left.GetBoolean() == right.GetBoolean();
    case JsonValueType::Number: return left.GetNumber() == right.GetNumber();
    case JsonValueType::String: return left.GetString() == right.GetString();
    case JsonValueType::Array: {
      const auto a = left.GetArray();
      const auto b = right.GetArray();
      if (a.Size() != b.Size()) return false;
      for (uint32_t index = 0; index < a.Size(); ++index) if (!json_equal(a.GetAt(index), b.GetAt(index), depth + 1)) return false;
      return true;
    }
    case JsonValueType::Object: {
      const auto a = left.GetObject();
      const auto b = right.GetObject();
      if (a.Size() != b.Size()) return false;
      for (const auto& pair : a) if (!b.HasKey(pair.Key()) || !json_equal(pair.Value(), b.Lookup(pair.Key()), depth + 1)) return false;
      return true;
    }
    default: return false;
  }
}
}
