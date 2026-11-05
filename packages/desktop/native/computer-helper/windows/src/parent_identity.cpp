#include "parent_identity.h"
#include "identity.h"
#include <bcrypt.h>
#include <softpub.h>
#include <tlhelp32.h>
#include <wincrypt.h>
#include <wintrust.h>
#include <algorithm>
#include <limits>
#include <stdexcept>
#include <utility>
#include <winrt/base.h>

namespace vector::computer {
namespace {
[[noreturn]] void unknown() { throw std::runtime_error("The helper parent identity could not be verified."); }

std::wstring fold_ascii(std::wstring value) {
  for (auto& character : value) if (character >= L'A' && character <= L'Z') character = static_cast<wchar_t>(character + (L'a' - L'A'));
  return value;
}

bool canonical_shape(const std::wstring& path) {
  if (path.size() < 4 || path.size() > 32'000 || path[1] != L':' || path[2] != L'\\' ||
      !((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z')) || path.back() == L'\\') return false;
  size_t start = 3;
  for (size_t index = 3; index <= path.size(); ++index) {
    if (index != path.size() && path[index] != L'\\') {
      if (path[index] < 32 || path[index] == 127 || path[index] == L'/' || path[index] == L':') return false;
      continue;
    }
    const auto part = path.substr(start, index - start);
    if (part.empty() || part == L"." || part == L".." || part.back() == L'.' || part.back() == L' ') return false;
    start = index + 1;
  }
  return true;
}

bool valid_image(const FileIdentity& file) {
  return canonical_shape(file.path) && file.size > 0 && file.size <= 1'073'741'824 && file.created > 0 && file.modified > 0 &&
    std::any_of(file.id.begin(), file.id.end(), [](unsigned char value) { return value != 0; }) &&
    std::any_of(file.sha256.begin(), file.sha256.end(), [](unsigned char value) { return value != 0; }) &&
    file.signature != SignatureState::invalid && (file.signature != SignatureState::valid || !file.signer_subject.empty());
}

bool same_install_parent(const std::wstring& helper, const std::wstring& parent) {
  const auto root = helper_install_root(helper);
  if (!root || !canonical_shape(parent)) return false;
  for (const auto& channel : identity::kChannels) {
    const std::wstring executable(channel.windowsExecutable.begin(), channel.windowsExecutable.end());
    if (fold_ascii(parent) == fold_ascii(*root + L"\\" + executable)) return true;
  }
  return false;
}

std::vector<unsigned char> information(HANDLE token, TOKEN_INFORMATION_CLASS kind) {
  DWORD size = 0;
  const auto first = GetTokenInformation(token, kind, nullptr, 0, &size);
  const auto first_error = first ? DWORD{ERROR_SUCCESS} : GetLastError();
  if (first || first_error != ERROR_INSUFFICIENT_BUFFER || size == 0)
    throw TokenObservationError(static_cast<DWORD>(kind), first_error, TokenObservationError::Step::size);
  if (size > 65'536) throw TokenObservationError(static_cast<DWORD>(kind), ERROR_INSUFFICIENT_BUFFER, TokenObservationError::Step::capacity);
  std::vector<unsigned char> value(size);
  if (!GetTokenInformation(token, kind, value.data(), size, &size)) throw TokenObservationError(static_cast<DWORD>(kind), GetLastError(), TokenObservationError::Step::read);
  if (size > value.size()) throw TokenObservationError(static_cast<DWORD>(kind), ERROR_INSUFFICIENT_BUFFER, TokenObservationError::Step::extent);
  return value;
}

std::vector<unsigned char> sid_bytes(PSID sid) {
  if (!sid || !IsValidSid(sid)) unknown();
  const auto size = GetLengthSid(sid);
  if (size == 0 || size > SECURITY_MAX_SID_SIZE) unknown();
  std::vector<unsigned char> result(size);
  if (!CopySid(size, result.data(), sid)) unknown();
  return result;
}

std::uint64_t file_time(const FILETIME& value) { return (std::uint64_t(value.dwHighDateTime) << 32) | value.dwLowDateTime; }
std::uint64_t creation(HANDLE process) {
  FILETIME created{}, exited{}, kernel{}, user{};
  if (!GetProcessTimes(process, &created, &exited, &kernel, &user)) unknown();
  return file_time(created);
}

std::wstring process_image(HANDLE process) {
  std::wstring path(32'768, L'\0');
  DWORD size = static_cast<DWORD>(path.size());
  if (!QueryFullProcessImageNameW(process, 0, path.data(), &size) || size == 0 || size >= path.size()) unknown();
  path.resize(size);
  return path;
}

std::wstring final_path(HANDLE file) {
  std::wstring path(32'768, L'\0');
  const auto size = GetFinalPathNameByHandleW(file, path.data(), static_cast<DWORD>(path.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (size == 0 || size >= path.size()) unknown();
  path.resize(size);
  if (!path.starts_with(L"\\\\?\\") || path.starts_with(L"\\\\?\\UNC\\")) unknown();
  path.erase(0, 4);
  if (!canonical_shape(path)) unknown();
  return path;
}

FileIdentity metadata(HANDLE file) {
  FILE_ID_INFO id{};
  FILE_STANDARD_INFO standard{};
  FILE_BASIC_INFO basic{};
  if (!GetFileInformationByHandleEx(file, FileIdInfo, &id, sizeof(id)) ||
      !GetFileInformationByHandleEx(file, FileStandardInfo, &standard, sizeof(standard)) ||
      !GetFileInformationByHandleEx(file, FileBasicInfo, &basic, sizeof(basic)) || standard.Directory || standard.DeletePending ||
      standard.EndOfFile.QuadPart <= 0 || standard.EndOfFile.QuadPart > 1'073'741'824 ||
      (basic.FileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) != 0) unknown();
  FileIdentity result;
  result.path = final_path(file);
  result.volume = id.VolumeSerialNumber;
  std::copy(std::begin(id.FileId.Identifier), std::end(id.FileId.Identifier), result.id.begin());
  result.size = static_cast<std::uint64_t>(standard.EndOfFile.QuadPart);
  result.created = static_cast<std::uint64_t>(basic.CreationTime.QuadPart);
  result.modified = static_cast<std::uint64_t>(basic.LastWriteTime.QuadPart);
  return result;
}

std::array<unsigned char, 32> hash_file(HANDLE file, std::uint64_t expected) {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) unknown();
  struct AlgorithmClose { BCRYPT_ALG_HANDLE value; ~AlgorithmClose() { BCryptCloseAlgorithmProvider(value, 0); } } close_algorithm{algorithm};
  DWORD size = 0, written = 0;
  if (BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&size), sizeof(size), &written, 0) < 0 ||
      written != sizeof(size) || size == 0 || size > 65'536) unknown();
  std::vector<unsigned char> object(size), buffer(65'536);
  if (BCryptCreateHash(algorithm, &hash, object.data(), size, nullptr, 0, 0) < 0) unknown();
  struct HashClose { BCRYPT_HASH_HANDLE value; ~HashClose() { BCryptDestroyHash(value); } } close_hash{hash};
  LARGE_INTEGER zero{};
  if (!SetFilePointerEx(file, zero, nullptr, FILE_BEGIN)) unknown();
  std::uint64_t count = 0;
  const auto deadline = GetTickCount64() + 5000;
  for (;;) {
    DWORD received = 0;
    if (GetTickCount64() >= deadline || !ReadFile(file, buffer.data(), static_cast<DWORD>(buffer.size()), &received, nullptr)) unknown();
    if (received == 0) break;
    if (received > expected - count || BCryptHashData(hash, buffer.data(), received, 0) < 0) unknown();
    count += received;
  }
  std::array<unsigned char, 32> digest{};
  if (count != expected || BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0) < 0) unknown();
  return digest;
}

SignatureState signature(HANDLE file, const std::wstring& path, std::vector<unsigned char>& subject) {
  WINTRUST_FILE_INFO info{};
  info.cbStruct = sizeof(info); info.pcwszFilePath = path.c_str(); info.hFile = file;
  WINTRUST_DATA data{};
  data.cbStruct = sizeof(data); data.dwUIChoice = WTD_UI_NONE; data.fdwRevocationChecks = WTD_REVOKE_NONE;
  data.dwUnionChoice = WTD_CHOICE_FILE; data.pFile = &info; data.dwStateAction = WTD_STATEACTION_VERIFY;
  // No UI or network retrieval. This is the installed file's actual offline Authenticode result,
  // not a publisher string, PE resource, or a promise of online revocation freshness.
  data.dwProvFlags = WTD_CACHE_ONLY_URL_RETRIEVAL;
  GUID policy = WINTRUST_ACTION_GENERIC_VERIFY_V2;
  const auto status = WinVerifyTrust(nullptr, &policy, &data);
  if (status == ERROR_SUCCESS) {
    const auto provider = WTHelperProvDataFromStateData(data.hWVTStateData);
    const auto signer = provider ? WTHelperGetProvSignerFromChain(provider, 0, FALSE, 0) : nullptr;
    const auto certificate = signer && signer->csCertChain > 0 && signer->pasCertChain ? signer->pasCertChain[0].pCert : nullptr;
    if (certificate && certificate->pCertInfo && certificate->pCertInfo->Subject.cbData > 0 && certificate->pCertInfo->Subject.cbData <= 65'536) {
      const auto& name = certificate->pCertInfo->Subject;
      subject.assign(name.pbData, name.pbData + name.cbData);
    }
  }
  data.dwStateAction = WTD_STATEACTION_CLOSE;
  (void)WinVerifyTrust(nullptr, &policy, &data);
  if (status == ERROR_SUCCESS) return subject.empty() ? SignatureState::invalid : SignatureState::valid;
  if (status == TRUST_E_NOSIGNATURE) return SignatureState::unsigned_file;
  return SignatureState::invalid;
}

winrt::handle image_file(HANDLE process) {
  const auto path = process_image(process);
  // Denying write/delete sharing holds these actual bytes and pathname throughout serving.
  const auto raw = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (!raw || raw == INVALID_HANDLE_VALUE) unknown();
  winrt::handle file{raw};
  if (GetFileType(file.get()) != FILE_TYPE_DISK) unknown();
  return file;
}

FileIdentity image_identity(HANDLE file) {
  auto before = metadata(file);
  before.sha256 = hash_file(file, before.size);
  before.signature = signature(file, before.path, before.signer_subject);
  auto after = metadata(file);
  after.sha256 = before.sha256; after.signature = before.signature; after.signer_subject = before.signer_subject;
  if (!same_file(before, after)) unknown();
  return before;
}

DWORD actual_parent() {
  const auto raw = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (!raw || raw == INVALID_HANDLE_VALUE) unknown();
  winrt::handle snapshot{raw};
  PROCESSENTRY32W process{}; process.dwSize = sizeof(process);
  if (!Process32FirstW(snapshot.get(), &process)) unknown();
  do { if (process.th32ProcessID == GetCurrentProcessId()) return process.th32ParentProcessID; } while (Process32NextW(snapshot.get(), &process));
  unknown();
}
}

bool serving_token_allowed(const TokenIdentity& token) noexcept {
  return !token.user.empty() && !token.logon.empty() && token.authentication != 0 &&
    token.integrity >= SECURITY_MANDATORY_MEDIUM_RID && token.integrity < SECURITY_MANDATORY_HIGH_RID &&
    !token.elevated && !token.ui_access && !token.app_container;
}

bool same_token(const TokenIdentity& left, const TokenIdentity& right) noexcept {
  return left.user == right.user && left.logon == right.logon && left.authentication == right.authentication &&
    left.session == right.session && left.integrity == right.integrity && left.elevated == right.elevated &&
    left.ui_access == right.ui_access && left.app_container == right.app_container;
}

bool same_file(const FileIdentity& left, const FileIdentity& right) noexcept {
  return left.path == right.path && left.volume == right.volume && left.id == right.id && left.size == right.size &&
    left.created == right.created && left.modified == right.modified && left.sha256 == right.sha256 && left.signature == right.signature &&
    left.signer_subject == right.signer_subject;
}

std::optional<std::wstring> helper_install_root(const std::wstring& helper) {
  constexpr std::wstring_view suffix = L"\\resources\\computer\\vector-computer.exe";
  if (!canonical_shape(helper)) return std::nullopt;
  const auto folded = fold_ascii(helper);
  if (!folded.ends_with(suffix) || folded.size() <= suffix.size() + 2) return std::nullopt;
  const auto root = helper.substr(0, helper.size() - suffix.size());
  return canonical_shape(root + L"\\placeholder") ? std::optional{root} : std::nullopt;
}

bool parent_evidence_allowed(const ParentEvidence& value) {
  if (value.expected_parent == 0 || value.actual_parent != value.expected_parent || value.helper_pid == 0 ||
      value.expected_parent == value.helper_pid || value.parent_created == 0 || value.helper_created < value.parent_created ||
      !serving_token_allowed(value.parent_token) || !serving_token_allowed(value.helper_token) ||
      !same_token(value.parent_token, value.helper_token) || !valid_image(value.parent_image) || !valid_image(value.helper_image) ||
      (value.helper_image.signature == SignatureState::valid &&
       (value.parent_image.signature != SignatureState::valid || !value.publisher_continuity ||
        value.helper_image.signer_subject.empty() || value.parent_image.signer_subject.empty()))) return false;
  return same_install_parent(value.helper_image.path, value.parent_image.path);
}

TokenIdentity observe_token(HANDLE process) {
  HANDLE raw = nullptr;
  if (!OpenProcessToken(process, TOKEN_QUERY, &raw)) throw TokenObservationError(0, GetLastError(), TokenObservationError::Step::open_token);
  winrt::handle token{raw};
  TokenIdentity result;
  auto user = information(token.get(), TokenUser);
  if (user.size() < sizeof(TOKEN_USER)) unknown();
  result.user = sid_bytes(reinterpret_cast<const TOKEN_USER*>(user.data())->User.Sid);
  auto groups = information(token.get(), TokenGroups);
  if (groups.size() < FIELD_OFFSET(TOKEN_GROUPS, Groups)) unknown();
  const auto group = reinterpret_cast<const TOKEN_GROUPS*>(groups.data());
  if (group->GroupCount > (groups.size() - FIELD_OFFSET(TOKEN_GROUPS, Groups)) / sizeof(SID_AND_ATTRIBUTES)) unknown();
  for (DWORD index = 0; index < group->GroupCount; ++index) {
    if ((group->Groups[index].Attributes & SE_GROUP_LOGON_ID) != SE_GROUP_LOGON_ID) continue;
    if (!result.logon.empty()) unknown();
    result.logon = sid_bytes(group->Groups[index].Sid);
  }
  auto stats = information(token.get(), TokenStatistics);
  if (stats.size() < sizeof(TOKEN_STATISTICS)) unknown();
  const auto authentication = reinterpret_cast<const TOKEN_STATISTICS*>(stats.data())->AuthenticationId;
  result.authentication = (std::uint64_t(static_cast<DWORD>(authentication.HighPart)) << 32) | authentication.LowPart;
  auto session = information(token.get(), TokenSessionId);
  auto integrity = information(token.get(), TokenIntegrityLevel);
  auto elevated = information(token.get(), TokenElevation);
  auto ui = information(token.get(), TokenUIAccess);
  auto container = information(token.get(), TokenIsAppContainer);
  if (session.size() < sizeof(DWORD) || integrity.size() < sizeof(TOKEN_MANDATORY_LABEL) || elevated.size() < sizeof(TOKEN_ELEVATION) ||
      ui.size() < sizeof(DWORD) || container.size() < sizeof(DWORD)) unknown();
  result.session = *reinterpret_cast<const DWORD*>(session.data());
  const auto sid = reinterpret_cast<const TOKEN_MANDATORY_LABEL*>(integrity.data())->Label.Sid;
  if (!sid || !IsValidSid(sid) || *GetSidSubAuthorityCount(sid) == 0) unknown();
  result.integrity = *GetSidSubAuthority(sid, static_cast<DWORD>(*GetSidSubAuthorityCount(sid) - 1));
  result.elevated = reinterpret_cast<const TOKEN_ELEVATION*>(elevated.data())->TokenIsElevated != 0;
  result.ui_access = *reinterpret_cast<const DWORD*>(ui.data()) != 0;
  result.app_container = *reinterpret_cast<const DWORD*>(container.data()) != 0;
  return result;
}

struct ParentIdentity::State {
  winrt::handle parent;
  winrt::handle parent_file;
  winrt::handle helper_file;
  ParentEvidence evidence;
};
ParentIdentity::ParentIdentity(std::unique_ptr<State> state) : state_(std::move(state)) {}
ParentIdentity::~ParentIdentity() = default;
HANDLE ParentIdentity::process_handle() const noexcept { return state_->parent.get(); }
const ParentEvidence& ParentIdentity::evidence() const noexcept { return state_->evidence; }
bool ParentIdentity::unchanged() const noexcept {
  try {
    if (WaitForSingleObject(state_->parent.get(), 0) != WAIT_TIMEOUT || creation(state_->parent.get()) != state_->evidence.parent_created ||
        !same_token(observe_token(state_->parent.get()), state_->evidence.parent_token) ||
        !same_token(observe_token(GetCurrentProcess()), state_->evidence.helper_token)) return false;
    auto parent = metadata(state_->parent_file.get()), helper = metadata(state_->helper_file.get());
    parent.sha256 = state_->evidence.parent_image.sha256; parent.signature = state_->evidence.parent_image.signature;
    parent.signer_subject = state_->evidence.parent_image.signer_subject;
    helper.sha256 = state_->evidence.helper_image.sha256; helper.signature = state_->evidence.helper_image.signature;
    helper.signer_subject = state_->evidence.helper_image.signer_subject;
    return same_file(parent, state_->evidence.parent_image) && same_file(helper, state_->evidence.helper_image);
  } catch (...) { return false; }
}

std::shared_ptr<ParentIdentity> verify_parent(DWORD expected_parent) {
  auto state = std::make_unique<ParentIdentity::State>();
  state->parent.attach(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, expected_parent));
  if (!state->parent || WaitForSingleObject(state->parent.get(), 0) != WAIT_TIMEOUT) unknown();
  auto& value = state->evidence;
  value.expected_parent = expected_parent; value.actual_parent = actual_parent(); value.helper_pid = GetCurrentProcessId();
  if (expected_parent == 0 || expected_parent == value.helper_pid || value.actual_parent != expected_parent) unknown();
  value.parent_created = creation(state->parent.get()); value.helper_created = creation(GetCurrentProcess());
  value.parent_token = observe_token(state->parent.get()); value.helper_token = observe_token(GetCurrentProcess());
  if (value.parent_created == 0 || value.helper_created < value.parent_created ||
      !serving_token_allowed(value.parent_token) || !serving_token_allowed(value.helper_token) || !same_token(value.parent_token, value.helper_token)) unknown();
  state->parent_file = image_file(state->parent.get()); state->helper_file = image_file(GetCurrentProcess());
  if (!same_install_parent(final_path(state->helper_file.get()), final_path(state->parent_file.get()))) unknown();
  value.parent_image = image_identity(state->parent_file.get()); value.helper_image = image_identity(state->helper_file.get());
  if (value.helper_image.signature == SignatureState::valid && value.parent_image.signature == SignatureState::valid) {
    CERT_NAME_BLOB helper_subject{static_cast<DWORD>(value.helper_image.signer_subject.size()), value.helper_image.signer_subject.data()};
    CERT_NAME_BLOB parent_subject{static_cast<DWORD>(value.parent_image.signer_subject.size()), value.parent_image.signer_subject.data()};
    value.publisher_continuity = CertCompareCertificateName(X509_ASN_ENCODING | PKCS_7_ASN_ENCODING, &helper_subject, &parent_subject) != FALSE;
  }
  if (!parent_evidence_allowed(value) || actual_parent() != expected_parent) unknown();
  auto result = std::shared_ptr<ParentIdentity>(new ParentIdentity(std::move(state)));
  if (!result->unchanged()) unknown();
  return result;
}
}
