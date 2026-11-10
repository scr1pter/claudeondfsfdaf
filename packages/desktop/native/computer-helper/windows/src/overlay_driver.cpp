#include "overlay_driver.h"
#include "overlay-driver-identity.h"
#include "build-config.h"
#include "availability.h"
#include "input.h"
#include "input_guardian.h"
#include "privileged_self_test.h"
#include "uia_native.h"
#include "windows_process_tree.h"
#include "../tests/caller_token_acl.h"
#include <bcrypt.h>
#include <propidl.h>
#include <tlhelp32.h>
#include <uiautomation.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cwchar>
#include <filesystem>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <thread>

namespace vector::computer {
namespace {
static_assert(overlay_driver_identity::kSourceDigest == build::kSourceDigest);
static_assert(overlay_driver_identity::kElectronVersion == "42.11.4");
constexpr size_t frame_limit = 8192;
[[noreturn]] void invalid(std::wstring reason = L"proof_changed") { throw DriverFailure{std::move(reason)}; }
void require(bool value, std::wstring reason = L"proof_changed") { if (!value) invalid(std::move(reason)); }
bool keys(const JsonObject& value, const std::set<std::wstring>& expected) {
  if (value.Size() != expected.size()) return false;
  for (const auto& entry : value) if (!expected.contains(std::wstring(entry.Key()))) return false;
  return true;
}
IJsonValue field(const JsonObject& value, const wchar_t* key) { return value.HasKey(key) ? value.Lookup(key) : nullptr; }
std::optional<std::wstring> text(const JsonObject& value, const wchar_t* key, size_t maximum = 256) {
  const auto raw = field(value, key); if (!raw || raw.ValueType() != JsonValueType::String) return {};
  const std::wstring result(raw.GetString()); if (result.empty() || result.size() > maximum || result.find(L'\0') != std::wstring::npos) return {}; return result;
}
std::optional<uint64_t> decimal(std::wstring_view value, uint64_t maximum) {
  if (value.empty() || value.size() > 20 || value[0] == L'0') return {};
  uint64_t result = 0;
  for (const auto c : value) { if (c < L'0' || c > L'9' || result > (maximum - static_cast<unsigned>(c - L'0')) / 10) return {}; result = result * 10 + static_cast<unsigned>(c - L'0'); }
  return result ? std::optional(result) : std::nullopt;
}
std::optional<WindowsRect> rectangle(const IJsonValue& raw) {
  if (!raw || raw.ValueType() != JsonValueType::Object) return {}; const auto object = raw.GetObject(); if (!keys(object, {L"x", L"y", L"w", L"h"})) return {};
  const auto x = signed_integer(field(object, L"x")), y = signed_integer(field(object, L"y")), w = signed_integer(field(object, L"w")), h = signed_integer(field(object, L"h"));
  if (!x || !y || !w || !h) return {}; const WindowsRect result{*x, *y, *w, *h}; return result.valid() ? std::optional(result) : std::nullopt;
}
std::wstring widen(std::string_view value) { const auto text = winrt::to_hstring(value); return {text.c_str(), text.size()}; }
bool equal_path(std::wstring_view left, std::wstring_view right) {
  return left.size() < 32'000 && right.size() < 32'000 && CompareStringOrdinal(left.data(), static_cast<int>(left.size()), right.data(), static_cast<int>(right.size()), TRUE) == CSTR_EQUAL;
}
std::wstring final_path(HANDLE file) {
  std::wstring result(32'768, L'\0'); const auto size = GetFinalPathNameByHandleW(file, result.data(), static_cast<DWORD>(result.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  require(size > 0 && size < result.size(), L"source_mismatch"); result.resize(size);
  require(result.starts_with(L"\\\\?\\") && !result.starts_with(L"\\\\?\\UNC\\"), L"source_mismatch"); result.erase(0, 4); return result;
}
std::wstring hex(std::span<const unsigned char> bytes) {
  std::wstring result; result.reserve(bytes.size() * 2);
  for (const auto byte : bytes) { result.push_back(L"0123456789abcdef"[byte >> 4]); result.push_back(L"0123456789abcdef"[byte & 15]); } return result;
}
uint64_t created(HANDLE process) {
  FILETIME start{}, end{}, kernel{}, user{}; require(GetProcessTimes(process, &start, &end, &kernel, &user) != FALSE);
  const auto result = (uint64_t(start.dwHighDateTime) << 32) | start.dwLowDateTime; require(result > 0); return result;
}
DWORD actual_parent(DWORD pid = GetCurrentProcessId()) {
  winrt::handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)); require(snapshot && snapshot.get() != INVALID_HANDLE_VALUE, L"parent_invalid");
  PROCESSENTRY32W value{}; value.dwSize = sizeof(value); require(Process32FirstW(snapshot.get(), &value) != FALSE, L"parent_invalid"); size_t count = 0;
  do { require(++count <= 65'536, L"parent_invalid"); if (value.th32ProcessID == pid) return value.th32ParentProcessID; } while (Process32NextW(snapshot.get(), &value));
  invalid(L"parent_invalid");
}
bool isolated() { wchar_t value[3]{}; return GetEnvironmentVariableW(L"VECTOR_COMPUTER_TEST_ISOLATED", value, 3) == 1 && value[0] == L'1' && value[1] == L'\0'; }
bool same_context(const TokenIdentity& a, const TokenIdentity& b) {
  return !a.user.empty() && !a.logon.empty() && a.authentication && a.user == b.user && a.logon == b.logon && a.authentication == b.authentication && a.session == b.session;
}
struct PinnedFile {
  winrt::handle file;
  std::wstring path;
  FILE_ID_INFO id{};
  FILE_BASIC_INFO basic{};
  FILE_STANDARD_INFO standard{};
  std::wstring sha256;
  bool current() const noexcept {
    try {
      FILE_ID_INFO next_id{}; FILE_BASIC_INFO next_basic{}; FILE_STANDARD_INFO next_standard{};
      return file && GetFileInformationByHandleEx(file.get(), FileIdInfo, &next_id, sizeof(next_id)) && GetFileInformationByHandleEx(file.get(), FileBasicInfo, &next_basic, sizeof(next_basic)) && GetFileInformationByHandleEx(file.get(), FileStandardInfo, &next_standard, sizeof(next_standard)) &&
        !next_standard.Directory && !next_standard.DeletePending && id.VolumeSerialNumber == next_id.VolumeSerialNumber && std::equal(std::begin(id.FileId.Identifier), std::end(id.FileId.Identifier), std::begin(next_id.FileId.Identifier)) &&
        basic.CreationTime.QuadPart == next_basic.CreationTime.QuadPart && basic.LastWriteTime.QuadPart == next_basic.LastWriteTime.QuadPart && standard.EndOfFile.QuadPart == next_standard.EndOfFile.QuadPart && equal_path(path, final_path(file.get()));
    } catch (...) { return false; }
  }
};
PinnedFile pin_file(const std::filesystem::path& path, std::string_view expected) {
  require(overlay_driver_hex(widen(expected)), L"source_mismatch");
  PinnedFile result; result.file.attach(CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  require(result.file && result.file.get() != INVALID_HANDLE_VALUE && GetFileType(result.file.get()) == FILE_TYPE_DISK &&
    GetFileInformationByHandleEx(result.file.get(), FileIdInfo, &result.id, sizeof(result.id)) && GetFileInformationByHandleEx(result.file.get(), FileBasicInfo, &result.basic, sizeof(result.basic)) && GetFileInformationByHandleEx(result.file.get(), FileStandardInfo, &result.standard, sizeof(result.standard)) &&
    !result.standard.Directory && !result.standard.DeletePending && result.standard.EndOfFile.QuadPart > 0 && result.standard.EndOfFile.QuadPart <= 512LL * 1024 * 1024 && !(result.basic.FileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)), L"source_mismatch");
  result.path = final_path(result.file.get()); require(equal_path(result.path, path.wstring()), L"source_mismatch");
  BCRYPT_ALG_HANDLE algorithm = nullptr; require(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) >= 0, L"source_mismatch");
  struct Algorithm { BCRYPT_ALG_HANDLE value; ~Algorithm() { BCryptCloseAlgorithmProvider(value, 0); } } close_algorithm{algorithm};
  DWORD object_size = 0, returned = 0; require(BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&object_size), sizeof(object_size), &returned, 0) >= 0 && returned == sizeof(object_size) && object_size > 0 && object_size <= 1'048'576, L"source_mismatch");
  std::vector<unsigned char> object(object_size); BCRYPT_HASH_HANDLE hash = nullptr; require(BCryptCreateHash(algorithm, &hash, object.data(), object_size, nullptr, 0, 0) >= 0, L"source_mismatch");
  struct Hash { BCRYPT_HASH_HANDLE value; ~Hash() { BCryptDestroyHash(value); } } close_hash{hash};
  std::array<unsigned char, 65'536> chunk{}; uint64_t total = 0;
  for (;;) { DWORD count = 0; require(ReadFile(result.file.get(), chunk.data(), static_cast<DWORD>(chunk.size()), &count, nullptr) != FALSE, L"source_mismatch"); if (!count) break;
    total += count; require(total <= static_cast<uint64_t>(result.standard.EndOfFile.QuadPart) && BCryptHashData(hash, chunk.data(), count, 0) >= 0, L"source_mismatch"); }
  std::array<unsigned char, 32> digest{}; require(total == static_cast<uint64_t>(result.standard.EndOfFile.QuadPart) && BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0) >= 0, L"source_mismatch");
  result.sha256 = hex(digest); require(result.sha256 == widen(expected) && result.current(), L"source_mismatch"); return result;
}
struct FixtureFiles {
  WindowsStaticIdentity self;
  std::filesystem::path root;
  PinnedFile electron, main, preload, default_app;
  std::optional<PinnedFile> fake;
  std::vector<winrt::handle> directories;
  bool current() const { return windows_file_current(self) && electron.current() && main.current() && preload.current() && default_app.current() && (!fake || fake->current()); }
};
void hold_directories(const std::filesystem::path& file, std::vector<winrt::handle>& result) {
  const auto path = file.wstring(); require(path.size() > 3 && path[1] == L':' && path[2] == L'\\', L"source_mismatch"); size_t count = 0;
  for (size_t index = 2; index < path.size(); ++index) if (path[index] == L'\\') {
    require(++count <= 128 && result.size() < 1024, L"source_mismatch"); const auto directory = path.substr(0, index == 2 ? 3 : index);
    winrt::handle held(CreateFileW(directory.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)); FILE_BASIC_INFO basic{};
    require(held && held.get() != INVALID_HANDLE_VALUE && GetFileInformationByHandleEx(held.get(), FileBasicInfo, &basic, sizeof(basic)) && (basic.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) && !(basic.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) && equal_path(final_path(held.get()), directory), L"source_mismatch"); result.push_back(std::move(held));
  }
}
FixtureFiles fixture_files() {
  const auto own = observe_windows_process(GetCurrentProcessId()); const auto root = helper_install_root(own.process.image.path); require(root.has_value(), L"source_mismatch");
  FixtureFiles files; files.self = observe_windows_file(own.process.image.path); require(same_file(files.self.image, own.process.image), L"source_mismatch"); files.root = *root;
  const auto electron = files.root / L"electron" / L"electron.exe", main = files.root / L"smoke" / L"computer-overlay-smoke-electron.mjs", preload = files.root / L"smoke" / L"computer-overlay-smoke-preload.cjs", archive = files.root / L"electron" / L"resources" / L"default_app.asar";
  for (const auto& file : {std::filesystem::path(files.self.image.path), electron, main, preload, archive}) hold_directories(file, files.directories);
  files.electron = pin_file(electron, overlay_driver_identity::kElectronSha256); files.main = pin_file(main, overlay_driver_identity::kMainSha256); files.preload = pin_file(preload, overlay_driver_identity::kPreloadSha256); files.default_app = pin_file(archive, overlay_driver_identity::kDefaultAppSha256);
  const auto fake = files.root / L"smoke" / L"computer-fake-helper.mjs";
  if (!overlay_driver_identity::kFakeHelperSha256.empty()) { hold_directories(fake, files.directories); files.fake = pin_file(fake, overlay_driver_identity::kFakeHelperSha256); }
  else { SetLastError(ERROR_SUCCESS); const auto attributes = GetFileAttributesW(fake.c_str()); const auto error = GetLastError(); require(attributes == INVALID_FILE_ATTRIBUTES && (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND), L"source_mismatch"); }
  require(files.current(), L"source_mismatch"); return files;
}
struct Lifetime {
  winrt::handle parent, stop;
  std::atomic_bool revoked{false};
  DWORD pid = 0;
  uint64_t birth = 0;
  static std::shared_ptr<Lifetime> arm(DWORD expected_parent, uint32_t timeout_ms) {
    auto state = std::make_shared<Lifetime>(); state->pid = expected_parent; state->parent.attach(OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, expected_parent)); state->stop.attach(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    require(state->parent && state->stop && GetProcessId(state->parent.get()) == expected_parent && WaitForSingleObject(state->parent.get(), 0) == WAIT_TIMEOUT, L"parent_invalid"); state->birth = created(state->parent.get()); require(state->birth <= created(GetCurrentProcess()), L"parent_invalid");
    std::thread([state, timeout_ms] { const std::array<HANDLE, 2> handles{state->parent.get(), state->stop.get()}; const auto status = WaitForMultipleObjects(static_cast<DWORD>(handles.size()), handles.data(), FALSE, timeout_ms);
      if (status == WAIT_OBJECT_0 + 1) return; state->revoked.store(true); Sleep(250); TerminateProcess(GetCurrentProcess(), 1); }).detach(); return state;
  }
  // Parentage is immutable for this held live process. Its actual parent and creation ordering were
  // checked before arming; a process-table scan must not consume the final UIA posting budget.
  bool current() const { return !revoked.load() && WaitForSingleObject(parent.get(), 0) == WAIT_TIMEOUT && GetProcessId(parent.get()) == pid && created(parent.get()) == birth; }
};
class PrivateReader {
 public:
  JsonObject read(HANDLE pipe, const std::shared_ptr<Lifetime>& life) {
    const auto deadline = GetTickCount64() + 2500; std::vector<uint8_t> bytes;
    for (;;) {
      require(life->current(), L"parent_invalid"); require(GetTickCount64() < deadline, L"deadline_exceeded"); DWORD available = 0; require(PeekNamedPipe(pipe, nullptr, 0, nullptr, &available, nullptr) != FALSE, L"control_invalid");
      if (available) { require(available <= frame_limit + 4 && bytes.size() <= frame_limit + 4, L"control_invalid"); std::array<uint8_t, 4096> chunk{}; DWORD count = 0;
        require(ReadFile(pipe, chunk.data(), std::min<DWORD>(available, static_cast<DWORD>(chunk.size())), &count, nullptr) && count && count <= frame_limit + 4 - bytes.size(), L"control_invalid"); bytes.insert(bytes.end(), chunk.begin(), chunk.begin() + count); }
      if (bytes.size() >= 4) { const auto size = (uint32_t(bytes[0]) << 24) | (uint32_t(bytes[1]) << 16) | (uint32_t(bytes[2]) << 8) | bytes[3]; require(size && size <= frame_limit, L"control_invalid");
        if (bytes.size() >= size + 4) { require(bytes.size() == size + 4 && strict_utf8(std::span(bytes).subspan(4)), L"control_invalid"); return JsonObject::Parse(winrt::to_hstring(std::string(reinterpret_cast<const char*>(bytes.data() + 4), size))); } }
      Sleep(2);
    }
  }
};
std::wstring caption(HWND window) { wchar_t text[257]{}; const auto count = GetWindowTextW(window, text, 257); require(count > 0 && count <= 256); return {text, static_cast<size_t>(count)}; }
WindowsRect bounds(HWND window) { RECT rect{}; require(GetWindowRect(window, &rect) != FALSE); return {rect.left, rect.top, int64_t(rect.right) - rect.left, int64_t(rect.bottom) - rect.top}; }
POINT point(const OverlayStopRequest& request) { return {static_cast<LONG>(request.stop_bounds.x + request.stop_bounds.width / 2), static_cast<LONG>(request.stop_bounds.y + request.stop_bounds.height / 2)}; }
bool window_current(const OverlayStopRequest& request, const WindowsOwner& parent, const WindowsWindow& expected, const std::shared_ptr<Lifetime>& life) {
  if (!life->current() || !windows_owner_current(parent) || !windows_window_current(expected) || request.parent_created != parent.process.creation_time || bounds(request.banner) != request.banner_bounds || caption(request.banner) != request.title) return false;
  DWORD owner = 0, foreground = 0; if (GetWindowThreadProcessId(request.banner, &owner) != expected.thread_id || owner != request.parent || GetAncestor(request.banner, GA_ROOT) != request.banner || !IsWindowVisible(request.banner) || IsIconic(request.banner)) return false;
  if (!GetWindowThreadProcessId(GetForegroundWindow(), &foreground) || foreground != request.parent) return false;
  const auto hit = WindowFromPoint(point(request)); DWORD hit_pid = 0; if (!hit || GetAncestor(hit, GA_ROOT) != request.banner || !GetWindowThreadProcessId(hit, &hit_pid) || hit_pid != request.parent) return false;
  wchar_t type[257]{}; const auto length = GetClassNameW(request.banner, type, 257); if (length <= 0 || length > 256 || std::wstring_view(type, static_cast<size_t>(length)) != L"Chrome_WidgetWin_1") return false;
  const auto extended = GetWindowLongPtrW(request.banner, GWL_EXSTYLE), style = GetWindowLongPtrW(request.banner, GWL_STYLE);
  return (extended & WS_EX_NOACTIVATE) && (extended & WS_EX_LAYERED) && !(extended & WS_EX_TRANSPARENT) && !(style & WS_CAPTION) && windows_desktop_available(observe_windows_desktop());
}
struct StopElement { UiaElement root, element; UiaSecurity security; UiaName name; };
StopElement observe_stop(const WindowsUiaBackend& uia, const WindowsWindow& window, const OverlayStopRequest& request, OverlayDriverStage& stage, const std::shared_ptr<WindowsUiaDiagnostic>& diagnostic) {
  stage = OverlayDriverStage::stop_root; UiaElement root;
  try { root = uia.root(window); }
  catch (...) {
    // Sample the actor's existing health before click_stop's RAII closes it. This is not a new UIA
    // query or a retry. A retired actor is not by itself proof of why its ticket could not complete.
    // Diagnostics must never replace the original exception, including if the health read throws.
    try {
      if (uia.available) {
        const auto available = uia.available();
        stage = available ? OverlayDriverStage::stop_root_refused : OverlayDriverStage::stop_root_retired;
        // A retired worker may still run late; only a positively healthy actor refines this failure.
        if (available && diagnostic) if (const auto observed = overlay_driver_uia_stage(diagnostic->phase.load(std::memory_order_relaxed))) stage = *observed;
      }
    } catch (...) {}
    throw;
  }
  stage = OverlayDriverStage::stop_hit; UiaElement element;
  try { element = uia.hit(root, point(request)); }
  catch (...) {
    // As for root, sample before cleanup and never label late retired work with its mutable phase.
    try {
      if (uia.available) {
        const auto available = uia.available();
        stage = available ? OverlayDriverStage::stop_hit_refused : OverlayDriverStage::stop_hit_retired;
        if (available && diagnostic) if (const auto observed = overlay_driver_uia_stage(diagnostic->phase.load(std::memory_order_relaxed))) stage = *observed;
      }
    } catch (...) {}
    throw;
  }
  for (size_t depth = 0; element && depth < 8; ++depth) {
    stage = OverlayDriverStage::stop_security; const auto security = uia.security(element);
    if (security.control_type == 50000) {
      stage = OverlayDriverStage::stop_name; const auto name = uia.name(element);
      // The belongs step retains all preceding local button facts in their original short-circuit order.
      stage = OverlayDriverStage::stop_belongs; require(security.pid == request.parent && security.enabled && !security.password && (!security.value_pattern || security.read_only == true) && (!security.text_pattern || security.text_read_only == true) && security.bounds && security.bounds->width >= 3 && security.bounds->height >= 3 && request.banner_bounds.contains(*security.bounds) && overlay_stop_bounds_match(request.stop_bounds, *security.bounds) && name.complete && name.text == L"Stop" && uia.belongs(element, window));
      return {root, element, security, name};
    }
    require(security.pid == request.parent && !security.password); stage = OverlayDriverStage::stop_equal; if (uia.equal(element, root)) break;
    stage = OverlayDriverStage::stop_parent; element = uia.parent(element);
  }
  invalid(L"stop_target_invalid");
}
uint64_t refresh_stop(const WindowsUiaBackend& uia, const WindowsWindow& window, const OverlayStopRequest& request, const StopElement& expected, OverlayDriverStage& stage, const std::shared_ptr<WindowsUiaDiagnostic>& diagnostic) {
  const auto started = GetTickCount64(); const auto current = observe_stop(uia, window, request, stage, diagnostic);
  stage = OverlayDriverStage::refresh;
  require(uia.equal(current.root, expected.root) && uia.equal(current.element, expected.element) && current.security.bounds == expected.security.bounds && current.name.text == expected.name.text && GetTickCount64() - started < 50);
  return started;
}
// Each store below names the next fallible step for a failed result frame. They are plain enum
// assignments: no call, allocation or wait is added, including inside the prepared-to-post window.
OverlayDriverResult click_stop(const OverlayDriverOptions& options, const std::shared_ptr<Lifetime>& life, const FixtureFiles& files, HANDLE input, PipeFrameWriter& writer, OverlayDriverStage& stage) {
  using Stage = OverlayDriverStage;
  stage = Stage::observe_parent; require(actual_parent() == options.parent && life->current(), L"parent_invalid"); const auto parent = observe_windows_process(options.parent), self = observe_windows_process(GetCurrentProcessId());
  require(parent.process.creation_time == life->birth && parent.process.creation_time <= self.process.creation_time && equal_path(parent.process.image.path, files.electron.path) && hex(parent.process.image.sha256) == files.electron.sha256 && same_file(self.process.image, files.self.image), L"parent_invalid");
  stage = Stage::observe_bootstrap; const auto bootstrap = observe_windows_process(actual_parent(options.parent));
  require(bootstrap.process.creation_time <= parent.process.creation_time && same_file(bootstrap.process.image, files.self.image) && same_context(bootstrap.process.token, parent.process.token) && !bootstrap.process.token.ui_access && !bootstrap.process.token.app_container && windows_owner_current(bootstrap), L"parent_invalid");
  require(files.current() && same_context(parent.process.token, self.process.token), L"parent_invalid");
  stage = Stage::isolation; if (!isolated()) throw DriverSkip{L"isolation_required"};
  stage = Stage::token; if (!serving_token_allowed(parent.process.token) || !serving_token_allowed(self.process.token) || !same_token(parent.process.token, self.process.token)) throw DriverSkip{L"elevated_parent"};
  stage = Stage::desktop; if (!windows_desktop_available(observe_windows_desktop())) throw DriverSkip{L"noninteractive_desktop"};
  stage = Stage::ready_write; JsonObject ready; ready.Insert(L"protocol", JsonValue::CreateNumberValue(1)); ready.Insert(L"ready", JsonValue::CreateBooleanValue(true)); ready.Insert(L"nonce", JsonValue::CreateStringValue(options.nonce)); ready.Insert(L"parentPID", JsonValue::CreateNumberValue(options.parent)); ready.Insert(L"parentCreationTime", JsonValue::CreateStringValue(std::to_wstring(life->birth))); ready.Insert(L"sourceDigest", JsonValue::CreateStringValue(widen(overlay_driver_identity::kSourceDigest)));
  require(writer.write(response_success(0, ready)), L"control_invalid"); stage = Stage::envelope_read; const auto envelope = PrivateReader{}.read(input, life);
  stage = Stage::envelope_shape; require(keys(envelope, {L"id", L"ok", L"stop"}) && safe_integer(field(envelope, L"id")) == 1 && envelope.GetNamedBoolean(L"ok"), L"control_invalid");
  stage = Stage::request; const auto request = parse_overlay_stop_request(envelope.GetNamedObject(L"stop")); require(request && request->parent == options.parent && request->nonce == options.nonce && request->parent_created == life->birth && request->source_digest == widen(overlay_driver_identity::kSourceDigest), L"control_invalid");
  stage = Stage::foreground; DWORD foreground = 0; if (!GetWindowThreadProcessId(GetForegroundWindow(), &foreground) || foreground != options.parent) throw DriverSkip{L"foreground_unavailable"};
  stage = Stage::guardian_create; auto guardian = InputGuardian::native(); stage = Stage::backend_create; auto backend = InputBackend::system({}, guardian); stage = Stage::uia_create; const auto uia_diagnostic = std::make_shared<WindowsUiaDiagnostic>(); const auto uia = WindowsUiaBackend::system(uia_diagnostic);
  struct Close { InputBackend& backend; const WindowsUiaBackend& uia; std::shared_ptr<InputGuardian> guardian; ~Close() { guardian->close(); if (backend.close) backend.close(); if (uia.close) uia.close(); } } close{backend, uia, guardian};
  stage = Stage::uia_available; if (!uia.available || !uia.available()) throw DriverSkip{L"uia_unavailable"};
  stage = Stage::window_observe; const auto window = WindowsBackend::system(windows_child_shell).observe(request->banner);
  require(window.hwnd == request->banner && window.surface == request->banner && window.owner.process.pid == options.parent && window.physical_owner.process.pid == options.parent && same_windows_process(window.owner.process, parent.process) && same_windows_process(window.physical_owner.process, parent.process));
  stage = Stage::stop_element; const auto element = observe_stop(uia, window, *request, stage, uia_diagnostic); auto observed_request = *request; observed_request.stop_bounds = *element.security.bounds; stage = Stage::window_current; require(valid_overlay_stop_request(observed_request) && window_current(observed_request, parent, window, life));
  stage = Stage::quiet; if (!backend.quiet()) throw DriverSkip{L"physical_input"};
  stage = Stage::guardian_ready; require(guardian->ready(), L"guardian_unavailable");
  stage = Stage::reserve; const InputRelease release{InputReleaseKind::mouse_button, 0, 0, false, 0}; const auto ticket = guardian->reserve(release); require(ticket.has_value(), L"guardian_unavailable");
  bool attempted = false, confirmed_up = false;
  try {
    stage = Stage::refresh; const auto prepared = refresh_stop(uia, window, observed_request, element, stage, uia_diagnostic);
    require(files.current() && windows_owner_current(bootstrap) && window_current(observed_request, parent, window, life) && backend.quiet() && guardian->alive() && GetTickCount64() - prepared < 50); stage = Stage::post;
    const auto outcome = backend.post({InputEventKind::button_down, point(observed_request), release, 0, 0, backend.tag}, [&] {
      if (!files.current() || !windows_owner_current(bootstrap) || !window_current(observed_request, parent, window, life) || !guardian->alive() || GetTickCount64() - prepared >= 50) return false;
      attempted = true; return true;
    });
    if (outcome == InputPostResult::not_posted) { attempted = false; invalid(L"input_post_failed"); }
    // The former single condition is unchanged; the stage names observe-down only once the post was accepted.
    if (outcome == InputPostResult::accepted) stage = Stage::observe_down;
    require(outcome == InputPostResult::accepted && guardian->observed(*ticket, true, 50), L"input_post_failed");
    if (backend.confirm_down) backend.confirm_down(release);
    stage = Stage::retire; guardian->retire(*ticket); stage = Stage::observe_up; confirmed_up = guardian->observed(*ticket, false, 300); require(confirmed_up, L"cleanup_failed");
    stage = Stage::cleanup; if (backend.forget_release) backend.forget_release(release);
  } catch (...) { guardian->retire(*ticket, !attempted); (void)guardian->drain(300); throw; }
  require(confirmed_up, L"cleanup_failed"); return {true, false, {}};
}
caller_token_acl::Observation bootstrap_token_diagnostic(HANDLE output, HANDLE token, const char* route) {
  const auto proof = caller_token_acl::observe(token);
  JsonObject value; value.Insert(L"protocol", JsonValue::CreateNumberValue(1)); value.Insert(L"route", JsonValue::CreateStringValue(widen(route)));
  value.Insert(L"owner", JsonValue::CreateStringValue(widen(std::string(1, proof.owner)))); value.Insert(L"access", JsonValue::CreateStringValue(widen(std::string(1, proof.process_dacl)))); value.Insert(L"cause", JsonValue::CreateStringValue(widen(std::string(1, proof.cause))));
  const auto document = "computer-smoke-bootstrap-token " + winrt::to_string(value.Stringify()) + "\n"; DWORD written = 0;
  require(document.size() <= 256 && WriteFile(output, document.data(), static_cast<DWORD>(document.size()), &written, nullptr) && written == document.size(), L"control_invalid"); return proof;
}
winrt::handle medium_token(const TokenIdentity& original, HANDLE output) {
  HANDLE raw = nullptr; const DWORD access = TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT;
  require(OpenProcessToken(GetCurrentProcess(), access, &raw) != FALSE, L"medium_token_unavailable"); winrt::handle source(raw);
  TOKEN_ELEVATION_TYPE elevation{}; DWORD returned = 0;
  if (GetTokenInformation(source.get(), TokenElevationType, &elevation, sizeof(elevation), &returned) && returned == sizeof(elevation) && elevation == TokenElevationTypeFull) {
    TOKEN_LINKED_TOKEN linked{}; if (GetTokenInformation(source.get(), TokenLinkedToken, &linked, sizeof(linked), &returned) && returned == sizeof(linked)) {
      winrt::handle limited(linked.LinkedToken); HANDLE duplicate = nullptr;
      if (limited && DuplicateTokenEx(limited.get(), access, nullptr, SecurityImpersonation, TokenPrimary, &duplicate)) {
        winrt::handle candidate(duplicate); const auto observed = observe_token_handle(candidate.get());
        require(serving_token_allowed(observed) && same_context(original, observed), L"parent_invalid");
        (void)bootstrap_token_diagnostic(output, candidate.get(), "linked"); return candidate;
      }
    }
  }
  alignas(DWORD) std::array<std::array<unsigned char, SECURITY_MAX_SID_SIZE>, 2> storage{}; std::array<SID_AND_ATTRIBUTES, 2> disabled{};
  const WELL_KNOWN_SID_TYPE types[]{WinBuiltinAdministratorsSid, WinBuiltinPowerUsersSid};
  for (size_t index = 0; index < disabled.size(); ++index) { DWORD count = SECURITY_MAX_SID_SIZE; require(CreateWellKnownSid(types[index], nullptr, storage[index].data(), &count) != FALSE, L"medium_token_unavailable"); disabled[index].Sid = storage[index].data(); }
  raw = nullptr; require(CreateRestrictedToken(source.get(), LUA_TOKEN | DISABLE_MAX_PRIVILEGE, static_cast<DWORD>(disabled.size()), disabled.data(), 0, nullptr, 0, nullptr, &raw) != FALSE, L"medium_token_unavailable"); winrt::handle token(raw);
  struct Label { TOKEN_MANDATORY_LABEL label{}; alignas(DWORD) std::array<unsigned char, SECURITY_MAX_SID_SIZE> sid{}; } label;
  DWORD count = SECURITY_MAX_SID_SIZE; require(CreateWellKnownSid(WinMediumLabelSid, nullptr, label.sid.data(), &count) != FALSE, L"medium_token_unavailable"); label.label.Label.Sid = label.sid.data(); label.label.Label.Attributes = SE_GROUP_INTEGRITY;
  require(SetTokenInformation(token.get(), TokenIntegrityLevel, &label.label, static_cast<DWORD>(offsetof(Label, sid) + count)) != FALSE, L"medium_token_unavailable");
  const auto observed = observe_token_handle(token.get()); require(serving_token_allowed(observed) && same_context(original, observed), L"parent_invalid");
  (void)bootstrap_token_diagnostic(output, token.get(), "restricted");
  // Match the never-shipped Caller's proven startup boundary on this newly owned candidate only.
  // Its supported unknown preproof still needs exact readback, unchanged authority and a positive
  // conservative postproof. Source/high/linked tokens and process/global ACLs are never changed.
  (void)caller_token_acl::ensure_owned_restricted(token.get());
  require(same_token(observed, observe_token_handle(token.get())), L"parent_invalid"); return token;
}
class QuotaPrivilege final {
 public:
  QuotaPrivilege() { HANDLE raw = nullptr; if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_ADJUST_PRIVILEGES, &raw)) return; token.attach(raw); TOKEN_PRIVILEGES wanted{}; wanted.PrivilegeCount = 1;
    if (!LookupPrivilegeValueW(nullptr, SE_INCREASE_QUOTA_NAME, &wanted.Privileges[0].Luid)) return; wanted.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED; DWORD returned = 0; SetLastError(ERROR_SUCCESS);
    enabled = AdjustTokenPrivileges(token.get(), FALSE, &wanted, sizeof(previous), &previous, &returned) && GetLastError() == ERROR_SUCCESS; }
  ~QuotaPrivilege() { if (enabled) (void)AdjustTokenPrivileges(token.get(), FALSE, &previous, 0, nullptr, nullptr); }
  bool ready() const noexcept { return enabled; }
 private:
  winrt::handle token; TOKEN_PRIVILEGES previous{}; bool enabled = false;
};
std::vector<wchar_t> child_environment(const std::filesystem::path& profile) {
  std::map<std::wstring, std::wstring> values;
  for (const auto key : {L"SystemRoot", L"WINDIR", L"SystemDrive", L"PATH", L"TEMP", L"TMP", L"APPDATA", L"LOCALAPPDATA", L"USERPROFILE"}) {
    std::wstring value(32'768, L'\0'); const auto count = GetEnvironmentVariableW(key, value.data(), static_cast<DWORD>(value.size())); if (!count) continue; require(count < value.size(), L"control_invalid"); value.resize(count); values.emplace(key, std::move(value));
  }
  values.emplace(L"VECTOR_COMPUTER_TEST_ISOLATED", L"1"); values.emplace(L"CI", L"true");
  values[L"USERPROFILE"] = (profile / L"home").wstring(); values[L"APPDATA"] = (profile / L"AppData" / L"Roaming").wstring(); values[L"LOCALAPPDATA"] = (profile / L"AppData" / L"Local").wstring(); values[L"TEMP"] = (profile / L"tmp").wstring(); values[L"TMP"] = values[L"TEMP"];
  std::vector<wchar_t> result; for (const auto& entry : values) { result.insert(result.end(), entry.first.begin(), entry.first.end()); result.push_back(L'='); result.insert(result.end(), entry.second.begin(), entry.second.end()); result.push_back(L'\0'); } result.push_back(L'\0'); return result;
}
int launch_electron(const OverlayDriverOptions& options, const std::shared_ptr<Lifetime>& life, const FixtureFiles& files, HANDLE output) {
  require(life->current() && files.current(), L"parent_invalid"); if (!isolated()) throw DriverSkip{L"isolation_required"}; if (!windows_desktop_available(observe_windows_desktop())) throw DriverSkip{L"noninteractive_desktop"};
  const auto original = observe_token(GetCurrentProcess()); require(!original.ui_access && !original.app_container, L"parent_invalid");
  winrt::handle token;
  if (!serving_token_allowed(original)) { if (!original.elevated || original.integrity < SECURITY_MANDATORY_HIGH_RID) invalid(L"parent_invalid"); token = medium_token(original, output); }
  else {
    HANDLE raw = nullptr; require(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, &raw) != FALSE, L"bootstrap_failed"); winrt::handle serving(raw);
    (void)bootstrap_token_diagnostic(output, serving.get(), "serving");
  }
  std::array<winrt::handle, 3> standard; std::array<HANDLE, 3> inherited{}; const DWORD kinds[]{STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE};
  for (size_t index = 0; index < standard.size(); ++index) {
    const auto handle = GetStdHandle(kinds[index]); const auto kind = handle && handle != INVALID_HANDLE_VALUE ? GetFileType(handle) : FILE_TYPE_UNKNOWN; require(kind == FILE_TYPE_PIPE || kind == FILE_TYPE_CHAR || kind == FILE_TYPE_DISK, L"control_invalid");
    HANDLE copied = nullptr; require(DuplicateHandle(GetCurrentProcess(), handle, GetCurrentProcess(), &copied, 0, TRUE, DUPLICATE_SAME_ACCESS) != FALSE, L"control_invalid"); standard[index].attach(copied); inherited[index] = copied;
  }
  // Only Electron is in this kill-on-close job. Its test driver and release guardian silently
  // break away, so a bootstrap crash cannot job-kill the process that owes a matching UP.
  winrt::handle job(CreateJobObjectW(nullptr, nullptr)); require(static_cast<bool>(job), L"bootstrap_failed"); JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{}; limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
  require(SetInformationJobObject(job.get(), JobObjectExtendedLimitInformation, &limits, sizeof(limits)) != FALSE, L"bootstrap_failed");
  SIZE_T size = 0; (void)InitializeProcThreadAttributeList(nullptr, 2, 0, &size); require(size && size <= 65'536, L"bootstrap_failed"); std::vector<unsigned char> storage(size); auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
  require(InitializeProcThreadAttributeList(attributes, 2, 0, &size) != FALSE, L"bootstrap_failed"); struct Delete { LPPROC_THREAD_ATTRIBUTE_LIST value; ~Delete() { DeleteProcThreadAttributeList(value); } } delete_attributes{attributes};
  require(UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited.data(), sizeof(inherited), nullptr, nullptr) != FALSE, L"bootstrap_failed"); HANDLE job_handle = job.get(); require(UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &job_handle, sizeof(job_handle), nullptr, nullptr) != FALSE, L"bootstrap_failed");
  STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup); startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES; startup.StartupInfo.hStdInput = inherited[0]; startup.StartupInfo.hStdOutput = inherited[1]; startup.StartupInfo.hStdError = inherited[2]; startup.lpAttributeList = attributes;
  const auto profile = files.root / L"profile";
  winrt::handle profile_handle(CreateFileW(profile.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)); FILE_BASIC_INFO profile_info{};
  require(profile_handle && GetFileInformationByHandleEx(profile_handle.get(), FileBasicInfo, &profile_info, sizeof(profile_info)) && (profile_info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) && !(profile_info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) && equal_path(final_path(profile_handle.get()), profile.wstring()), L"source_mismatch");
  std::vector<winrt::handle> profile_directories;
  for (const auto& relative : {std::filesystem::path(L"home"), std::filesystem::path(L"AppData") / L"Roaming", std::filesystem::path(L"AppData") / L"Local", std::filesystem::path(L"tmp")}) {
    auto directory = profile;
    for (const auto& component : relative) {
      directory /= component;
      if (!CreateDirectoryW(directory.c_str(), nullptr)) require(GetLastError() == ERROR_ALREADY_EXISTS, L"bootstrap_failed");
      winrt::handle held(CreateFileW(directory.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)); FILE_BASIC_INFO info{};
      require(held && GetFileInformationByHandleEx(held.get(), FileBasicInfo, &info, sizeof(info)) && (info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) && !(info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) && equal_path(final_path(held.get()), directory.wstring()), L"source_mismatch"); profile_directories.push_back(std::move(held));
    }
  }
  // Enable Chromium accessibility before the fixture renders any window. Its later app setting
  // follows earlier rendered windows and does not wait for a native accessibility tree.
  std::wstring command = L"\"" + files.electron.path + L"\" --force-renderer-accessibility \"" + files.main.path + L"\" \"--user-data-dir=" + profile.wstring() + L"\" --computer-smoke-nonce=" + options.nonce;
  const auto preserved = command; auto environment = child_environment(profile); PROCESS_INFORMATION process{}; constexpr DWORD flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT;
  BOOL launched = token ? CreateProcessAsUserW(token.get(), files.electron.path.c_str(), command.data(), nullptr, nullptr, TRUE, flags, environment.data(), files.root.c_str(), &startup.StartupInfo, &process) : CreateProcessW(files.electron.path.c_str(), command.data(), nullptr, nullptr, TRUE, flags, environment.data(), files.root.c_str(), &startup.StartupInfo, &process);
  if (!launched && token && GetLastError() == ERROR_PRIVILEGE_NOT_HELD) { QuotaPrivilege quota; if (quota.ready()) { command = preserved; launched = CreateProcessAsUserW(token.get(), files.electron.path.c_str(), command.data(), nullptr, nullptr, TRUE, flags, environment.data(), files.root.c_str(), &startup.StartupInfo, &process); } }
  require(launched != FALSE, L"bootstrap_failed"); winrt::handle child(process.hProcess), thread(process.hThread); BOOL contained = FALSE;
  require(IsProcessInJob(child.get(), job.get(), &contained) && contained && GetProcessId(child.get()) == process.dwProcessId && actual_parent(process.dwProcessId) == GetCurrentProcessId(), L"bootstrap_failed");
  const auto observed = observe_windows_process(process.dwProcessId); const auto actual = observe_token(child.get());
  require(observed.process.creation_time == created(child.get()) && observed.process.creation_time >= created(GetCurrentProcess()) && serving_token_allowed(actual) && same_context(original, actual) && equal_path(observed.process.image.path, files.electron.path) && hex(observed.process.image.sha256) == files.electron.sha256 && files.current() && life->current(), L"parent_invalid");
  require(ResumeThread(thread.get()) != static_cast<DWORD>(-1), L"bootstrap_failed"); const auto started = GetTickCount64();
  for (;;) { const auto status = WaitForSingleObject(child.get(), 25); if (status == WAIT_OBJECT_0) break; require(status == WAIT_TIMEOUT && life->current() && GetTickCount64() - started < 120'000, L"deadline_exceeded"); }
  DWORD status = 1; require(GetExitCodeProcess(child.get(), &status) != FALSE, L"bootstrap_failed"); return status <= static_cast<DWORD>((std::numeric_limits<int>::max)()) ? static_cast<int>(status) : 1;
}
}

bool overlay_driver_hex(std::wstring_view value, size_t size) noexcept {
  return value.size() == size && std::all_of(value.begin(), value.end(), [](wchar_t c) { return (c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f'); });
}
std::optional<OverlayDriverOptions> parse_overlay_driver_options(std::span<const std::wstring> arguments) {
  if (arguments.size() == 3 && arguments[0] == L"--launch-electron" && arguments[1] == L"--nonce" && overlay_driver_hex(arguments[2])) return OverlayDriverOptions{OverlayDriverMode::launch_electron, 0, arguments[2]};
  if (arguments.size() != 5 || arguments[0] != L"--overlay-stop" || arguments[1] != L"--parent-pid" || arguments[3] != L"--nonce" || !overlay_driver_hex(arguments[4])) return {};
  const auto parent = decimal(arguments[2], MAXDWORD); if (!parent) return {}; return OverlayDriverOptions{OverlayDriverMode::stop, static_cast<DWORD>(*parent), arguments[4]};
}
bool valid_overlay_stop_request(const OverlayStopRequest& value) noexcept {
  constexpr std::wstring_view prefix = L"Vector computer smoke ";
  return value.parent > 0 && value.parent_created > 0 && overlay_driver_hex(value.nonce) && overlay_driver_hex(value.source_digest) && value.banner && value.banner_bounds.valid() && value.stop_bounds.valid() &&
    value.banner_bounds.width <= 4096 && value.banner_bounds.height <= 1024 && value.stop_bounds.width <= 512 && value.stop_bounds.height <= 256 && value.banner_bounds.contains(value.stop_bounds) && std::wstring_view(value.title).starts_with(prefix) && std::wstring_view(value.title).substr(prefix.size()) == value.nonce;
}
bool overlay_stop_bounds_match(const WindowsRect& hint, const WindowsRect& observed) noexcept {
  if (!hint.valid() || !observed.valid()) return false;
  const auto adjacent = [](int64_t a, int64_t b) { return a >= b - 1 && a <= b + 1; };
  return adjacent(hint.x, observed.x) && adjacent(hint.y, observed.y) && adjacent(hint.x + hint.width, observed.x + observed.width) && adjacent(hint.y + hint.height, observed.y + observed.height);
}
std::optional<OverlayStopRequest> parse_overlay_stop_request(const JsonObject& value) {
  try {
    if (!keys(value, {L"protocol", L"nonce", L"parentPID", L"parentCreationTime", L"sourceDigest", L"bannerWindowId", L"bannerBounds", L"stopBounds", L"bannerTitle"}) || safe_integer(field(value, L"protocol")) != 1) return {};
    const auto nonce = text(value, L"nonce", 64), source = text(value, L"sourceDigest", 64), start = text(value, L"parentCreationTime", 20), window = text(value, L"bannerWindowId", 20), title = text(value, L"bannerTitle", 128);
    const auto parent = safe_integer(field(value, L"parentPID")); const auto banner_bounds = rectangle(field(value, L"bannerBounds")), stop_bounds = rectangle(field(value, L"stopBounds"));
    if (!nonce || !source || !start || !window || !title || !parent || *parent == 0 || *parent > MAXDWORD || !banner_bounds || !stop_bounds) return {};
    const auto birth = decimal(*start, std::numeric_limits<uint64_t>::max()); const auto banner = parse_window_id(*window); if (!birth || !banner) return {};
    OverlayStopRequest result{static_cast<DWORD>(*parent), *birth, *nonce, *source, *title, *banner, *banner_bounds, *stop_bounds}; return valid_overlay_stop_request(result) ? std::optional(result) : std::nullopt;
  } catch (...) { return {}; }
}
bool overlay_driver_reason(std::wstring_view value) noexcept {
  static constexpr std::array reasons{L"isolation_required", L"noninteractive_desktop", L"elevated_parent", L"foreground_unavailable", L"uia_unavailable", L"guardian_unavailable", L"physical_input", L"source_mismatch", L"parent_invalid", L"control_invalid", L"stop_target_invalid", L"proof_changed", L"input_post_failed", L"cleanup_failed", L"deadline_exceeded", L"medium_token_unavailable", L"bootstrap_failed", L"native_failure"};
  return std::find(reasons.begin(), reasons.end(), value) != reasons.end();
}
std::wstring_view overlay_driver_stage_name(OverlayDriverStage stage) noexcept {
  const auto index = static_cast<size_t>(stage); return index < overlay_driver_stages.size() ? overlay_driver_stages[index] : std::wstring_view{};
}
std::optional<OverlayDriverStage> overlay_driver_uia_stage(WindowsUiaPhase phase) noexcept {
  const auto index = static_cast<size_t>(phase);
  if (index == 0 || index >= windows_uia_phases.size()) return {};
  return static_cast<OverlayDriverStage>(static_cast<size_t>(OverlayDriverStage::uia_root_current) + index - 1);
}
bool overlay_driver_stage(std::wstring_view value) noexcept {
  return std::find(overlay_driver_stages.begin(), overlay_driver_stages.end(), value) != overlay_driver_stages.end();
}
bool overlay_driver_cause(std::wstring_view value) noexcept {
  constexpr std::wstring_view core_prefix = L"core_failure:", hresult_prefix = L"hresult:";
  if (value == L"driver_failure" || value == L"std_exception" || value == L"unknown") return true;
  if (value.starts_with(core_prefix)) return std::find(windows_privileged_native_codes.begin(), windows_privileged_native_codes.end(), value.substr(core_prefix.size())) != windows_privileged_native_codes.end();
  return value.starts_with(hresult_prefix) && std::find(overlay_driver_hresult_classes.begin(), overlay_driver_hresult_classes.end(), value.substr(hresult_prefix.size())) != overlay_driver_hresult_classes.end();
}
// Ordered buckets: RPC_E_TIMEOUT is in FACILITY_RPC, so timeouts are classified first.
std::wstring_view overlay_driver_hresult_class(HRESULT code) noexcept {
  if (code == static_cast<HRESULT>(UIA_E_TIMEOUT) || code == RPC_E_TIMEOUT || code == HRESULT_FROM_WIN32(ERROR_TIMEOUT)) return L"timeout";
  if (code == E_ACCESSDENIED) return L"access_denied";
  if (HRESULT_FACILITY(code) == FACILITY_RPC || code == HRESULT_FROM_WIN32(RPC_S_SERVER_UNAVAILABLE) || code == HRESULT_FROM_WIN32(RPC_S_CALL_FAILED) || code == HRESULT_FROM_WIN32(RPC_S_CALL_FAILED_DNE)) return L"rpc";
  if (code == static_cast<HRESULT>(UIA_E_ELEMENTNOTAVAILABLE) || code == HRESULT_FROM_WIN32(ERROR_NOT_FOUND) || code == HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND) || code == HRESULT_FROM_WIN32(ERROR_PATH_NOT_FOUND) || code == HRESULT_FROM_WIN32(ERROR_INVALID_WINDOW_HANDLE)) return L"not_found";
  return L"other";
}
OverlayDriverResult overlay_driver_caught(OverlayDriverMode mode, OverlayDriverStage stage, std::exception_ptr error) {
  // Only a stop-mode failure has a result frame. The launch bootstrap record keeps its exact keys.
  const auto diagnosed = [mode, stage](std::wstring reason, std::wstring_view cause) {
    OverlayDriverResult value{false, false, std::move(reason)};
    if (mode == OverlayDriverMode::stop) { value.stage = overlay_driver_stage_name(stage); value.cause = cause; }
    return value;
  };
  auto result = diagnosed(L"native_failure", L"unknown");
  try { if (error) std::rethrow_exception(error); }
  catch (const DriverSkip& skip) { result = {false, true, skip.reason}; }
  catch (const DriverFailure& driver) { result = mode == OverlayDriverMode::launch_electron && driver.reason == L"medium_token_unavailable" ? OverlayDriverResult{false, true, driver.reason} : diagnosed(driver.reason, L"driver_failure"); }
  catch (const Failure& core_error) { result = diagnosed(L"native_failure", L"core_failure:" + windows_privileged_native_code(core_error.code)); }
  // A core ProtocolError carries the same closed code list; it must precede its std::exception base.
  catch (const ProtocolError& protocol) { result = diagnosed(L"native_failure", L"core_failure:" + windows_privileged_native_code(protocol.code)); }
  catch (const winrt::hresult_error& com) { result = diagnosed(L"native_failure", L"hresult:" + std::wstring(overlay_driver_hresult_class(com.code().value))); }
  catch (const std::exception&) { result = diagnosed(L"native_failure", L"std_exception"); }
  catch (...) { result = diagnosed(L"native_failure", L"unknown"); }
  return result;
}
int OverlayDriverResult::exit_code() const noexcept {
  static constexpr std::array prerequisites{L"isolation_required", L"noninteractive_desktop", L"elevated_parent", L"foreground_unavailable", L"uia_unavailable", L"physical_input", L"medium_token_unavailable"};
  if ((ok && skipped) || (!reason.empty() && !overlay_driver_reason(reason)) || (ok && !reason.empty()) || (!ok && reason.empty()) || (skipped && std::find(prerequisites.begin(), prerequisites.end(), reason) == prerequisites.end())) return 1;
  return ok ? 0 : skipped ? 77 : 1;
}
JsonObject OverlayDriverResult::wire() const {
  const bool coherent = (ok && !skipped && reason.empty()) || (!ok && !reason.empty() && overlay_driver_reason(reason) && (!skipped || exit_code() == 77));
  JsonObject result; result.Insert(L"id", JsonValue::CreateNumberValue(1)); result.Insert(L"protocol", JsonValue::CreateNumberValue(1)); result.Insert(L"check", JsonValue::CreateStringValue(L"native-os-stop")); result.Insert(L"ok", JsonValue::CreateBooleanValue(coherent && ok));
  if (coherent && skipped) result.Insert(L"skipped", JsonValue::CreateBooleanValue(true)); if (!coherent || !reason.empty()) result.Insert(L"reason", JsonValue::CreateStringValue(coherent ? reason : L"native_failure"));
  // Both closed diagnostics or neither, and only on a coherent unskipped failure. A cause other than a
  // driver failure always reported native_failure. Anything else is dropped and nothing else changes.
  if (coherent && !ok && !skipped && overlay_driver_stage(stage) && overlay_driver_cause(cause) && (cause == L"driver_failure" || reason == L"native_failure")) {
    result.Insert(L"stage", JsonValue::CreateStringValue(stage)); result.Insert(L"cause", JsonValue::CreateStringValue(cause));
  }
  return result;
}
int run_overlay_driver(const OverlayDriverOptions& options, HANDLE input, HANDLE output) noexcept {
  std::shared_ptr<Lifetime> life; std::unique_ptr<PipeFrameWriter> writer; OverlayDriverResult result; auto stage = OverlayDriverStage::dpi;
  try {
    require((options.mode == OverlayDriverMode::stop || options.mode == OverlayDriverMode::launch_electron) && overlay_driver_hex(options.nonce), L"control_invalid");
    require(SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) != nullptr, L"native_failure");
    stage = OverlayDriverStage::parent; const auto parent = actual_parent(); require(parent && parent != GetCurrentProcessId() && (options.mode == OverlayDriverMode::launch_electron || parent == options.parent), L"parent_invalid"); life = Lifetime::arm(parent, options.mode == OverlayDriverMode::launch_electron ? 122'000 : 15'000);
    if (options.mode == OverlayDriverMode::stop) { require(GetFileType(input) == FILE_TYPE_PIPE && GetFileType(output) == FILE_TYPE_PIPE, L"control_invalid"); writer = std::make_unique<PipeFrameWriter>(output, life->stop.get(), [life] { life->revoked.store(true); }); }
    stage = OverlayDriverStage::files; const auto files = fixture_files();
    if (options.mode == OverlayDriverMode::launch_electron) { const auto status = launch_electron(options, life, files, output); SetEvent(life->stop.get()); return status; }
    result = click_stop(options, life, files, input, *writer, stage);
  } catch (...) {
    // Classification builds strings. If that itself throws, keep the former key-less native_failure.
    try { result = overlay_driver_caught(options.mode, stage, std::current_exception()); } catch (...) { result = {false, false, L"native_failure"}; }
  }
  if (writer) { if (!writer->write(result.wire())) result = {false, false, L"control_invalid"}; writer->cancel(); (void)writer->close(std::chrono::milliseconds(100)); }
  else if (options.mode == OverlayDriverMode::launch_electron) {
    // The bootstrap forwards Electron's stdout unchanged on success. Its own failure is one fixed
    // machine record and can never be interpreted as the Electron smoke's successful report.
    const auto document = winrt::to_string(result.wire().Stringify()) + "\n"; DWORD written = 0; if (document.size() <= 4096) (void)WriteFile(output, document.data(), static_cast<DWORD>(document.size()), &written, nullptr);
  }
  if (life) SetEvent(life->stop.get()); return result.exit_code();
}
}
