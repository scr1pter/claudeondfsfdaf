#include "windows_identity.h"
#include "windows_com.h"
#include <appmodel.h>
#include <appxpackaging.h>
#include <bcrypt.h>
#include <wincrypt.h>
#include <wintrust.h>
#include <mscat.h>
#include <objidl.h>
#include <softpub.h>
#include <winrt/Windows.ApplicationModel.h>
#include <winrt/Windows.Management.Deployment.h>
#include <winrt/Windows.Storage.h>
#include <algorithm>
#include <array>
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <utility>

namespace vector::computer {
namespace {
[[noreturn]] void unavailable() { throw std::runtime_error("Windows app identity is unavailable."); }
void require(bool value) { if (!value) unavailable(); }
bool text(std::wstring_view value, size_t maximum, bool empty = false) {
  if ((!empty && value.empty()) || value.size() > maximum) return false;
  for (size_t index = 0; index < value.size(); ++index) {
    const auto character = value[index];
    if (character < 32 || character == 127 || (character >= 0xDC00 && character <= 0xDFFF)) return false;
    if (character >= 0xD800 && character <= 0xDBFF && (++index == value.size() || value[index] < 0xDC00 || value[index] > 0xDFFF)) return false;
  }
  return true;
}
bool path_shape(std::wstring_view path) {
  if (!text(path, 32'000) || path.size() < 4 || path[1] != L':' || path[2] != L'\\' || path.back() == L'\\' ||
      !((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z'))) return false;
  size_t begin = 3;
  for (size_t index = 3; index <= path.size(); ++index) {
    if (index < path.size() && path[index] != L'\\') { if (path[index] == L'/' || path[index] == L':') return false; continue; }
    const auto part = path.substr(begin, index - begin);
    if (part.empty() || part == L"." || part == L".." || part.back() == L'.' || part.back() == L' ') return false;
    begin = index + 1;
  }
  return true;
}
bool equal_path(std::wstring_view left, std::wstring_view right) {
  return left.size() <= 32'000 && right.size() <= 32'000 && CompareStringOrdinal(left.data(), static_cast<int>(left.size()), right.data(), static_cast<int>(right.size()), TRUE) == CSTR_EQUAL;
}
bool inside(std::wstring_view path, std::wstring_view directory) {
  return path_shape(path) && path_shape(directory) && path.size() > directory.size() + 1 && path[directory.size()] == L'\\' && equal_path(path.substr(0, directory.size()), directory);
}
bool original_name(std::wstring_view value) {
  return text(value, 260) && value != L"." && value != L".." && value.back() != L'.' && value.back() != L' ' &&
    value.find_first_of(L"\\/:*?\"<>|") == std::wstring_view::npos;
}
std::wstring hex(std::span<const unsigned char> bytes) {
  constexpr wchar_t digits[] = L"0123456789ABCDEF";
  std::wstring result; result.reserve(bytes.size() * 2);
  for (const auto byte : bytes) { result.push_back(digits[byte >> 4]); result.push_back(digits[byte & 15]); }
  return result;
}
bool valid_image(const FileIdentity& image) {
  return path_shape(image.path) && image.size > 0 && image.size <= 1'073'741'824 && image.created > 0 && image.modified > 0 &&
    std::any_of(image.id.begin(), image.id.end(), [](auto value) { return value != 0; }) &&
    std::any_of(image.sha256.begin(), image.sha256.end(), [](auto value) { return value != 0; });
}
bool valid_package(const WindowsPackageEvidence& package, const FileIdentity& image) {
  if (!text(package.aumid, 512) || !text(package.family, 64) || !text(package.full_name, 127) || !inside(image.path, package.path)) return false;
  const auto separator = package.aumid.find(L'!');
  std::array<std::wstring_view, 5> parts{}; size_t begin = 0;
  for (size_t index = 0; index < parts.size(); ++index) {
    const auto end = package.full_name.find(L'_', begin);
    if ((index + 1 == parts.size()) != (end == std::wstring::npos)) return false;
    parts[index] = std::wstring_view(package.full_name).substr(begin, end == std::wstring::npos ? end : end - begin);
    if (index != 3 && parts[index].empty()) return false;
    if (end != std::wstring::npos) begin = end + 1;
  }
  return separator != std::wstring::npos && separator > 0 && separator + 1 < package.aumid.size() &&
    package.aumid.find(L'!', separator + 1) == std::wstring::npos && package.aumid.substr(0, separator) == package.family &&
    package.family == std::wstring(parts[0]) + L"_" + std::wstring(parts[4]);
}
bool metadata_equal(const FileIdentity& left, const FileIdentity& right) {
  return left.path == right.path && left.volume == right.volume && left.id == right.id && left.size == right.size && left.created == right.created && left.modified == right.modified;
}
std::wstring final_path(HANDLE file) {
  std::wstring path(32'768, L'\0');
  const auto length = GetFinalPathNameByHandleW(file, path.data(), static_cast<DWORD>(path.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  require(length > 0 && length < path.size()); path.resize(length);
  require(path.starts_with(L"\\\\?\\") && !path.starts_with(L"\\\\?\\UNC\\")); path.erase(0, 4);
  require(path_shape(path)); return path;
}
FileIdentity metadata(HANDLE file) {
  require(file && file != INVALID_HANDLE_VALUE && GetFileType(file) == FILE_TYPE_DISK);
  FILE_ID_INFO id{}; FILE_STANDARD_INFO standard{}; FILE_BASIC_INFO basic{};
  require(GetFileInformationByHandleEx(file, FileIdInfo, &id, sizeof(id)) &&
    GetFileInformationByHandleEx(file, FileStandardInfo, &standard, sizeof(standard)) &&
    GetFileInformationByHandleEx(file, FileBasicInfo, &basic, sizeof(basic)) && !standard.Directory && !standard.DeletePending &&
    standard.EndOfFile.QuadPart > 0 && standard.EndOfFile.QuadPart <= 1'073'741'824 &&
    basic.CreationTime.QuadPart > 0 && basic.LastWriteTime.QuadPart > 0 &&
    (basic.FileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) == 0);
  FileIdentity result; result.path = final_path(file); result.volume = id.VolumeSerialNumber;
  std::copy(std::begin(id.FileId.Identifier), std::end(id.FileId.Identifier), result.id.begin());
  result.size = static_cast<uint64_t>(standard.EndOfFile.QuadPart); result.created = static_cast<uint64_t>(basic.CreationTime.QuadPart); result.modified = static_cast<uint64_t>(basic.LastWriteTime.QuadPart);
  return result;
}
winrt::handle open_image(const std::wstring& path) {
  require(path_shape(path));
  winrt::handle file(CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  require(file && file.get() != INVALID_HANDLE_VALUE && equal_path(metadata(file.get()).path, path)); return file;
}
void rewind(HANDLE file) { LARGE_INTEGER zero{}; require(SetFilePointerEx(file, zero, nullptr, FILE_BEGIN) != FALSE); }
void require_pe_image(HANDLE file, uint64_t size) {
  rewind(file); DWORD received = 0; IMAGE_DOS_HEADER dos{};
  require(ReadFile(file, &dos, sizeof(dos), &received, nullptr) && received == sizeof(dos) && dos.e_magic == IMAGE_DOS_SIGNATURE &&
    dos.e_lfanew >= static_cast<LONG>(sizeof(dos)) && dos.e_lfanew <= 1'048'576 && static_cast<uint64_t>(dos.e_lfanew) + sizeof(DWORD) + sizeof(IMAGE_FILE_HEADER) + sizeof(IMAGE_OPTIONAL_HEADER64) <= size);
  LARGE_INTEGER position{}; position.QuadPart = dos.e_lfanew; require(SetFilePointerEx(file, position, nullptr, FILE_BEGIN) != FALSE);
  DWORD signature = 0; IMAGE_FILE_HEADER header{};
  require(ReadFile(file, &signature, sizeof(signature), &received, nullptr) && received == sizeof(signature) && signature == IMAGE_NT_SIGNATURE &&
    ReadFile(file, &header, sizeof(header), &received, nullptr) && received == sizeof(header) &&
    (header.Characteristics & IMAGE_FILE_EXECUTABLE_IMAGE) && !(header.Characteristics & (IMAGE_FILE_DLL | IMAGE_FILE_SYSTEM)));
  WORD magic = 0; require(ReadFile(file, &magic, sizeof(magic), &received, nullptr) && received == sizeof(magic));
  require((magic == IMAGE_NT_OPTIONAL_HDR64_MAGIC && header.SizeOfOptionalHeader >= sizeof(IMAGE_OPTIONAL_HEADER64)) ||
    (magic == IMAGE_NT_OPTIONAL_HDR32_MAGIC && header.SizeOfOptionalHeader >= sizeof(IMAGE_OPTIONAL_HEADER32)));
  position.QuadPart = static_cast<LONGLONG>(dos.e_lfanew) + sizeof(DWORD) + sizeof(IMAGE_FILE_HEADER) + offsetof(IMAGE_OPTIONAL_HEADER64, Subsystem);
  require(SetFilePointerEx(file, position, nullptr, FILE_BEGIN) != FALSE);
  WORD subsystem = 0; require(ReadFile(file, &subsystem, sizeof(subsystem), &received, nullptr) && received == sizeof(subsystem) &&
    (subsystem == IMAGE_SUBSYSTEM_WINDOWS_GUI || subsystem == IMAGE_SUBSYSTEM_WINDOWS_CUI));
}
std::array<unsigned char, 32> sha256(HANDLE file, uint64_t expected) {
  BCRYPT_ALG_HANDLE algorithm = nullptr; BCRYPT_HASH_HANDLE hash = nullptr;
  require(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) >= 0);
  struct Algorithm { BCRYPT_ALG_HANDLE value; ~Algorithm() { BCryptCloseAlgorithmProvider(value, 0); } } close_algorithm{algorithm};
  DWORD length = 0, written = 0;
  require(BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&length), sizeof(length), &written, 0) >= 0 && written == sizeof(length) && length > 0 && length <= 65'536);
  std::vector<unsigned char> object(length), bytes(65'536);
  require(BCryptCreateHash(algorithm, &hash, object.data(), length, nullptr, 0, 0) >= 0);
  struct Hash { BCRYPT_HASH_HANDLE value; ~Hash() { BCryptDestroyHash(value); } } close_hash{hash};
  rewind(file); uint64_t count = 0; const auto start = GetTickCount64();
  for (;;) {
    DWORD received = 0;
    require(GetTickCount64() - start < 5000 && ReadFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &received, nullptr));
    if (received == 0) break;
    require(count <= expected && received <= expected - count && BCryptHashData(hash, bytes.data(), received, 0) >= 0); count += received;
  }
  std::array<unsigned char, 32> digest{};
  require(count == expected && BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0) >= 0); return digest;
}
struct Signature {
  SignatureState state = SignatureState::invalid;
  WindowsSignatureSource source = WindowsSignatureSource::none;
  std::wstring publisher;
  std::vector<unsigned char> subject;
  bool microsoft = false;
};
Signature verify_trust(WINTRUST_DATA& data, WindowsSignatureSource source) {
  data.cbStruct = sizeof(data); data.dwUIChoice = WTD_UI_NONE; data.fdwRevocationChecks = WTD_REVOKE_WHOLECHAIN;
  data.dwProvFlags = WTD_CACHE_ONLY_URL_RETRIEVAL | WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT; data.dwStateAction = WTD_STATEACTION_VERIFY;
  GUID policy = WINTRUST_ACTION_GENERIC_VERIFY_V2;
  const auto status = WinVerifyTrust(nullptr, &policy, &data);
  struct Close { WINTRUST_DATA& data; GUID& policy; ~Close() { data.dwStateAction = WTD_STATEACTION_CLOSE; (void)WinVerifyTrust(nullptr, &policy, &data); } } close{data, policy};
  Signature result;
  if (status == TRUST_E_NOSIGNATURE) { result.state = SignatureState::unsigned_file; return result; }
  if (status != ERROR_SUCCESS) return result;
  const auto provider = WTHelperProvDataFromStateData(data.hWVTStateData);
  const auto signer = provider ? WTHelperGetProvSignerFromChain(provider, 0, FALSE, 0) : nullptr;
  const auto certificate = signer && signer->csCertChain > 0 && signer->pasCertChain ? signer->pasCertChain[0].pCert : nullptr;
  if (!certificate || !certificate->pCertInfo || certificate->pCertInfo->Subject.cbData == 0 || certificate->pCertInfo->Subject.cbData > 65'536) return result;
  const auto length = CertGetNameStringW(certificate, CERT_NAME_SIMPLE_DISPLAY_TYPE, 0, nullptr, nullptr, 0);
  if (length < 2 || length > 257) return result;
  std::wstring publisher(length, L'\0');
  if (CertGetNameStringW(certificate, CERT_NAME_SIMPLE_DISPLAY_TYPE, 0, nullptr, publisher.data(), length) != length || publisher.back() != L'\0') return result;
  publisher.pop_back(); if (!text(publisher, 256)) return result;
  const auto& subject = certificate->pCertInfo->Subject;
  result.subject.assign(subject.pbData, subject.pbData + subject.cbData); result.publisher = std::move(publisher);
  CERT_CHAIN_POLICY_PARA parameters{}; parameters.cbSize = sizeof(parameters);
  CERT_CHAIN_POLICY_STATUS chain{}; chain.cbSize = sizeof(chain);
  // This evaluates the already verified chain, with no new URL retrieval or UI.
  result.microsoft = signer->pChainContext && CertVerifyCertificateChainPolicy(CERT_CHAIN_POLICY_MICROSOFT_ROOT, signer->pChainContext, &parameters, &chain) && chain.dwError == ERROR_SUCCESS;
  result.state = SignatureState::valid; result.source = source; return result;
}
Signature signature(HANDLE file, const std::wstring& path) {
  WINTRUST_FILE_INFO info{}; info.cbStruct = sizeof(info); info.pcwszFilePath = path.c_str(); info.hFile = file;
  WINTRUST_DATA data{}; data.dwUnionChoice = WTD_CHOICE_FILE; data.pFile = &info;
  auto embedded = verify_trust(data, WindowsSignatureSource::embedded);
  if (embedded.state == SignatureState::valid) return embedded;
  // Catalog member hashes use Authenticode's PE exclusions, not the ordinary flat file SHA256 witness.
  // https://learn.microsoft.com/windows/win32/api/wintrust/ns-wintrust-wintrust_catalog_info
  for (const auto algorithm : {BCRYPT_SHA256_ALGORITHM, BCRYPT_SHA1_ALGORITHM}) {
    HCATADMIN admin = nullptr;
    GUID subsystem = DRIVER_ACTION_VERIFY;
    if (!CryptCATAdminAcquireContext2(&admin, &subsystem, algorithm, nullptr, 0)) continue;
    struct Admin { HCATADMIN value; ~Admin() { CryptCATAdminReleaseContext(value, 0); } } close_admin{admin};
    DWORD length = 0; rewind(file);
    if (!CryptCATAdminCalcHashFromFileHandle2(admin, file, &length, nullptr, 0) || length == 0 || length > 128) continue;
    std::vector<unsigned char> hash(length); rewind(file);
    if (!CryptCATAdminCalcHashFromFileHandle2(admin, file, &length, hash.data(), 0) || length != hash.size()) continue;
    const auto tag = hex(hash);
    HCATINFO cursor = nullptr;
    struct Catalogs { HCATADMIN admin; HCATINFO& cursor; ~Catalogs() { if (cursor) CryptCATAdminReleaseCatalogContext(admin, cursor, 0); } } close_catalogs{admin, cursor};
    for (unsigned count = 0; count < 32; ++count) {
      cursor = CryptCATAdminEnumCatalogFromHash(admin, hash.data(), length, 0, &cursor);
      if (!cursor) break;
      CATALOG_INFO catalog{}; catalog.cbStruct = sizeof(catalog);
      if (!CryptCATCatalogInfoFromContext(cursor, &catalog, 0)) continue;
      const auto end = std::find(std::begin(catalog.wszCatalogFile), std::end(catalog.wszCatalogFile), L'\0');
      if (end == std::end(catalog.wszCatalogFile)) continue;
      WINTRUST_CATALOG_INFO member{}; member.cbStruct = sizeof(member); member.pcwszCatalogFilePath = catalog.wszCatalogFile;
      member.pcwszMemberTag = tag.c_str(); member.pcwszMemberFilePath = path.c_str(); member.hMemberFile = file;
      member.pbCalculatedFileHash = hash.data(); member.cbCalculatedFileHash = length; member.hCatAdmin = admin;
      WINTRUST_DATA catalog_data{}; catalog_data.dwUnionChoice = WTD_CHOICE_CATALOG; catalog_data.pCatalog = &member;
      auto verified = verify_trust(catalog_data, WindowsSignatureSource::catalog);
      if (verified.state == SignatureState::valid) return verified;
    }
  }
  return embedded;
}

std::wstring original_filename(const std::wstring& path) {
  DWORD ignored = 0;
  // Neutral-only prevents a separate MUI file from supplying an unverified identity string.
  const auto size = GetFileVersionInfoSizeExW(FILE_VER_GET_NEUTRAL, path.c_str(), &ignored);
  if (size == 0 || size > 1'048'576) return {};
  std::vector<unsigned char> bytes(size);
  if (!GetFileVersionInfoExW(FILE_VER_GET_NEUTRAL, path.c_str(), 0, size, bytes.data())) return {};
  const auto bounded = [&](const void* pointer, size_t length) {
    const auto begin = reinterpret_cast<uintptr_t>(bytes.data()), value = reinterpret_cast<uintptr_t>(pointer);
    return pointer && value >= begin && value - begin <= bytes.size() && length <= bytes.size() - (value - begin);
  };
  struct Translation { WORD language; WORD codepage; };
  void* pointer = nullptr; UINT length = 0;
  if (!VerQueryValueW(bytes.data(), L"\\VarFileInfo\\Translation", &pointer, &length) || !bounded(pointer, length) || length == 0 || length % sizeof(Translation) != 0 || length / sizeof(Translation) > 32) return {};
  std::wstring found;
  for (size_t index = 0; index < length / sizeof(Translation); ++index) {
    Translation translation{}; std::memcpy(&translation, static_cast<const unsigned char*>(pointer) + index * sizeof(Translation), sizeof(translation));
    wchar_t key[64]{};
    if (swprintf_s(key, L"\\StringFileInfo\\%04x%04x\\OriginalFilename", static_cast<unsigned>(translation.language), static_cast<unsigned>(translation.codepage)) < 0) return {};
    void* value = nullptr; UINT characters = 0;
    if (!VerQueryValueW(bytes.data(), key, &value, &characters) || characters < 2 || characters > 261 || !bounded(value, static_cast<size_t>(characters) * sizeof(wchar_t))) continue;
    const auto string = static_cast<const wchar_t*>(value);
    if (string[characters - 1] != L'\0') return {};
    const std::wstring current(string, characters - 1);
    if (!original_name(current) || (!found.empty() && found != current)) return {};
    found = current;
  }
  return found;
}
std::wstring system_root() {
  std::wstring path(32'768, L'\0');
  const auto length = GetSystemWindowsDirectoryW(path.data(), static_cast<UINT>(path.size()));
  require(length > 0 && length < path.size()); path.resize(length);
  winrt::handle directory(CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  require(directory && directory.get() != INVALID_HANDLE_VALUE);
  FILE_BASIC_INFO basic{}; require(GetFileInformationByHandleEx(directory.get(), FileBasicInfo, &basic, sizeof(basic)) && (basic.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) && !(basic.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT));
  return final_path(directory.get());
}
uint64_t created(HANDLE process) {
  FILETIME start{}, exit{}, kernel{}, user{}; require(GetProcessTimes(process, &start, &exit, &kernel, &user) != FALSE);
  const auto value = (uint64_t(start.dwHighDateTime) << 32) | start.dwLowDateTime; require(value > 0); return value;
}
std::wstring process_path(HANDLE process) {
  std::wstring path(32'768, L'\0'); DWORD length = static_cast<DWORD>(path.size());
  require(QueryFullProcessImageNameW(process, 0, path.data(), &length) && length > 0 && length < path.size()); path.resize(length); require(path_shape(path)); return path;
}
template<class Query> std::optional<std::wstring> package_string(Query query, UINT32 maximum, LONG absent) {
  UINT32 length = 0; const auto first = query(&length, nullptr);
  if (first == absent) return {};
  require(first == ERROR_INSUFFICIENT_BUFFER && length > 1 && length <= maximum);
  std::wstring value(length, L'\0'); const auto expected = length;
  require(query(&length, value.data()) == ERROR_SUCCESS && length == expected && value.back() == L'\0'); value.pop_back();
  require(text(value, maximum - 1)); return value;
}
std::wstring package_path(const std::wstring& full_name) {
  const auto path = package_string([&](UINT32* length, PWSTR value) { return GetPackagePathByFullName(full_name.c_str(), length, value); }, 32'001, APPMODEL_ERROR_NO_PACKAGE);
  require(path.has_value() && path_shape(*path));
  winrt::handle directory(CreateFileW(path->c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  require(directory && directory.get() != INVALID_HANDLE_VALUE);
  FILE_BASIC_INFO basic{}; require(GetFileInformationByHandleEx(directory.get(), FileBasicInfo, &basic, sizeof(basic)) && (basic.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) && !(basic.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT));
  const auto canonical = final_path(directory.get()); require(equal_path(canonical, *path)); return canonical;
}
WindowsPackageEvidence trusted_package(WindowsPackageEvidence evidence) {
  WindowsComCall call;
  require(call.current());
  using winrt::Windows::ApplicationModel::PackageSignatureKind;
  const winrt::Windows::Management::Deployment::PackageManager manager;
  const auto package = manager.FindPackageForUser(L"", winrt::hstring(evidence.full_name));
  require(call.current());
  require(package && package.Id().FullName() == winrt::hstring(evidence.full_name) && package.Id().FamilyName() == winrt::hstring(evidence.family) &&
    equal_path(package.InstalledLocation().Path().c_str(), evidence.path));
  evidence.development_mode = package.IsDevelopmentMode();
  switch (package.SignatureKind()) {
    case PackageSignatureKind::None: evidence.trust = WindowsPackageTrust::none; break;
    case PackageSignatureKind::Developer: evidence.trust = WindowsPackageTrust::developer; break;
    case PackageSignatureKind::Enterprise: evidence.trust = WindowsPackageTrust::enterprise; break;
    case PackageSignatureKind::Store: evidence.trust = WindowsPackageTrust::store; break;
    case PackageSignatureKind::System: evidence.trust = WindowsPackageTrust::system; break;
    default: evidence.trust = WindowsPackageTrust::unknown; break;
  }
  require(call.current());
  return evidence;
}
std::optional<WindowsPackageEvidence> process_package(HANDLE process, const WindowsPackageEvidence* expected = nullptr) {
  const auto full = package_string([&](UINT32* length, PWSTR value) { return GetPackageFullName(process, length, value); }, 128, APPMODEL_ERROR_NO_PACKAGE);
  const auto family = package_string([&](UINT32* length, PWSTR value) { return GetPackageFamilyName(process, length, value); }, 65, APPMODEL_ERROR_NO_PACKAGE);
  const auto aumid = package_string([&](UINT32* length, PWSTR value) { return GetApplicationUserModelId(process, length, value); }, 130, APPMODEL_ERROR_NO_APPLICATION);
  if (!full && !family && !aumid) return {};
  require(full && family && aumid);
  const auto derived = package_string([&](UINT32* length, PWSTR value) { return PackageFamilyNameFromFullName(full->c_str(), length, value); }, 65, APPMODEL_ERROR_NO_PACKAGE);
  require(derived && *derived == *family);
  if (expected) {
    // Package trust belongs to this exact held process/image/full-name observation. Final metadata checks
    // refresh kernel process identity without deployment RPC, filesystem traversal, trust, or manifest I/O.
    require(*aumid == expected->aumid && *family == expected->family && *full == expected->full_name);
    return *expected;
  }
  return trusted_package({*aumid, *family, *full, package_path(*full)});
}

std::vector<std::wstring> registered_names(const std::wstring& family) {
  WindowsComCall call;
  require(call.current());
  UINT32 count = 0, characters = 0;
  const auto first = GetPackagesByPackageFamily(family.c_str(), &count, nullptr, &characters, nullptr);
  require(first == ERROR_INSUFFICIENT_BUFFER && count > 0 && count <= 64 && characters > 1 && characters <= 65'536);
  std::vector<PWSTR> names(count); std::vector<wchar_t> buffer(characters);
  const auto expected_count = count, expected_characters = characters;
  require(GetPackagesByPackageFamily(family.c_str(), &count, names.data(), &characters, buffer.data()) == ERROR_SUCCESS && count == expected_count && characters <= expected_characters);
  require(call.current());
  std::vector<std::wstring> result;
  const auto begin = reinterpret_cast<uintptr_t>(buffer.data()), end = begin + buffer.size() * sizeof(wchar_t);
  for (const auto pointer : names) {
    const auto address = reinterpret_cast<uintptr_t>(pointer);
    require(pointer && address >= begin && address < end && (address - begin) % sizeof(wchar_t) == 0);
    const auto maximum = std::min<size_t>((end - address) / sizeof(wchar_t), 128);
    const auto length = wcsnlen_s(pointer, maximum); require(length > 0 && length < maximum);
    const std::wstring name(pointer, length); require(text(name, 127));
    const auto actual_family = package_string([&](UINT32* size, PWSTR value) { return PackageFamilyNameFromFullName(name.c_str(), size, value); }, 65, APPMODEL_ERROR_NO_PACKAGE);
    require(actual_family && *actual_family == family); result.push_back(name);
  }
  std::sort(result.begin(), result.end()); require(call.current() && std::adjacent_find(result.begin(), result.end()) == result.end()); return result;
}
struct CoString {
  LPWSTR value = nullptr;
  ~CoString() { CoTaskMemFree(value); }
  std::wstring copy(size_t maximum) const {
    require(value != nullptr); const auto length = wcsnlen_s(value, maximum + 1);
    require(length > 0 && length <= maximum); std::wstring result(value, length); require(text(result, maximum)); return result;
  }
};
winrt::com_ptr<IStream> manifest_stream(const std::wstring& root) {
  const auto path = root + L"\\AppxManifest.xml";
  auto file = open_image(path); const auto before = metadata(file.get()); require(before.size <= 1'048'576);
  std::vector<unsigned char> bytes(static_cast<size_t>(before.size)); DWORD received = 0;
  require(ReadFile(file.get(), bytes.data(), static_cast<DWORD>(bytes.size()), &received, nullptr) && received == bytes.size() && metadata_equal(before, metadata(file.get())));
  winrt::com_ptr<IStream> stream; winrt::check_hresult(CreateStreamOnHGlobal(nullptr, TRUE, stream.put()));
  ULONG written = 0; winrt::check_hresult(stream->Write(bytes.data(), static_cast<ULONG>(bytes.size()), &written)); require(written == bytes.size());
  LARGE_INTEGER zero{}; winrt::check_hresult(stream->Seek(zero, STREAM_SEEK_SET, nullptr)); return stream;
}
struct RegisteredApplication { WindowsPackageEvidence package; std::wstring executable; };
RegisteredApplication registered_application(const std::wstring& aumid) {
  require(text(aumid, 512)); const auto delimiter = aumid.find(L'!');
  require(delimiter != std::wstring::npos && delimiter > 0 && delimiter + 1 < aumid.size() && aumid.find(L'!', delimiter + 1) == std::wstring::npos);
  const auto family = aumid.substr(0, delimiter); require(text(family, 64));
  const auto names = registered_names(family);
  winrt::com_ptr<IAppxFactory> factory;
  { WindowsComCall call; require(call.current());
    winrt::check_hresult(CoCreateInstance(__uuidof(AppxFactory), nullptr, CLSCTX_INPROC_SERVER, __uuidof(IAppxFactory), factory.put_void()));
    require(call.current()); }
  std::optional<RegisteredApplication> found;
  for (const auto& full_name : names) {
    const auto root = package_path(full_name); const auto stream = manifest_stream(root);
    WindowsComCall call; require(call.current());
    winrt::com_ptr<IAppxManifestReader> manifest; winrt::check_hresult(factory->CreateManifestReader(stream.get(), manifest.put()));
    winrt::com_ptr<IAppxManifestPackageId> id; winrt::check_hresult(manifest->GetPackageId(id.put()));
    CoString actual_full, actual_family;
    winrt::check_hresult(id->GetPackageFullName(&actual_full.value)); winrt::check_hresult(id->GetPackageFamilyName(&actual_family.value));
    require(actual_full.copy(127) == full_name && actual_family.copy(64) == family);
    winrt::com_ptr<IAppxManifestApplicationsEnumerator> applications; winrt::check_hresult(manifest->GetApplications(applications.put()));
    BOOL current = FALSE; winrt::check_hresult(applications->GetHasCurrent(&current)); unsigned count = 0;
    while (current) {
      require(++count <= 512); winrt::com_ptr<IAppxManifestApplication> application; winrt::check_hresult(applications->GetCurrent(application.put()));
      CoString actual_aumid; winrt::check_hresult(application->GetAppUserModelId(&actual_aumid.value));
      if (actual_aumid.copy(512) == aumid) {
        require(!found); CoString executable; winrt::check_hresult(application->GetStringValue(L"Executable", &executable.value));
        auto relative = executable.copy(4096); std::replace(relative.begin(), relative.end(), L'/', L'\\');
        const auto path = root + L"\\" + relative; require(inside(path, root));
        found = RegisteredApplication{{aumid, family, full_name, root}, path};
      }
      winrt::check_hresult(applications->MoveNext(&current));
      require(call.current());
    }
    require(call.current());
  }
  require(found.has_value() && registered_names(family) == names);
  // Deployment is a separate bounded call scope, after manifest COM scopes retired, never nested.
  found->package = trusted_package(found->package); return *found;
}
}

WindowsAppIdentity windows_identity_from_facts(const WindowsIdentityFacts& facts) {
  require(valid_image(facts.image) && (!facts.pid || *facts.pid != 0));
  WindowsAppIdentity result; result.exe = facts.image.path; result.pid = facts.pid;
  const auto slash = facts.image.path.find_last_of(L'\\'); result.name = facts.image.path.substr(slash + 1);
  if (result.name.size() > 256) result.name = L"Application";
  const bool authenticated = facts.image.signature == SignatureState::valid &&
    (facts.signature_source == WindowsSignatureSource::embedded || facts.signature_source == WindowsSignatureSource::catalog) &&
    !facts.image.signer_subject.empty() && facts.image.signer_subject.size() <= 65'536 && text(facts.publisher, 256);
  const bool signed_image = authenticated && original_name(facts.original_filename);
  result.system = authenticated && facts.microsoft_root && inside(facts.image.path, facts.system_root);
  if (facts.package) {
    require(valid_package(*facts.package, facts.image));
    result.kind = WindowsAppKind::aumid; result.aumid = facts.package->aumid;
    result.verified = !facts.package->development_mode &&
      (facts.package->trust == WindowsPackageTrust::enterprise || facts.package->trust == WindowsPackageTrust::store || facts.package->trust == WindowsPackageTrust::system);
    if (signed_image) result.publisher = facts.publisher;
    return result;
  }
  result.kind = WindowsAppKind::exe; result.verified = signed_image;
  if (signed_image) { result.publisher = facts.publisher; result.binary = facts.original_filename; return result; }
  result.binary = L"unverified-" + hex(facts.image.sha256); return result;
}
JsonObject WindowsAppIdentity::wire() const {
  JsonObject value; value.Insert(L"platform", JsonValue::CreateStringValue(L"windows"));
  value.Insert(L"kind", JsonValue::CreateStringValue(kind == WindowsAppKind::aumid ? L"aumid" : L"exe"));
  if (kind == WindowsAppKind::aumid) {
    value.Insert(L"aumid", JsonValue::CreateStringValue(aumid));
    if (!publisher.empty()) value.Insert(L"publisher", JsonValue::CreateStringValue(publisher));
  } else {
    value.Insert(L"publisher", JsonValue::CreateStringValue(publisher)); value.Insert(L"product", JsonValue::CreateStringValue(product)); value.Insert(L"binary", JsonValue::CreateStringValue(binary));
  }
  value.Insert(L"name", JsonValue::CreateStringValue(name)); value.Insert(L"exe", JsonValue::CreateStringValue(exe));
  value.Insert(L"verified", JsonValue::CreateBooleanValue(verified)); value.Insert(L"system", JsonValue::CreateBooleanValue(system));
  if (pid) value.Insert(L"pid", JsonValue::CreateNumberValue(*pid)); return value;
}
bool same_windows_identity(const WindowsAppIdentity& left, const WindowsAppIdentity& right) noexcept {
  return left.kind == right.kind && left.aumid == right.aumid && left.publisher == right.publisher && left.product == right.product && left.binary == right.binary &&
    left.name == right.name && left.exe == right.exe && left.system == right.system && left.verified == right.verified && left.pid == right.pid;
}
bool same_windows_process(const WindowsProcessWitness& left, const WindowsProcessWitness& right) noexcept {
  return left.pid != 0 && left.creation_time != 0 && left.pid == right.pid && left.creation_time == right.creation_time &&
    same_file(left.image, right.image) && same_token(left.token, right.token) && left.package == right.package;
}
bool windows_package_identity_matches(const WindowsAppIdentity& identity, const WindowsProcessWitness& process) noexcept {
  try {
    if (identity.kind != WindowsAppKind::aumid || !process.package || process.pid == 0 || process.creation_time == 0 ||
        identity.pid != process.pid || identity.exe != process.image.path || identity.aumid != process.package->aumid ||
        !valid_image(process.image) || !valid_package(*process.package, process.image)) return false;
    const auto& package = *process.package;
    return !identity.verified || (!package.development_mode &&
      (package.trust == WindowsPackageTrust::enterprise || package.trust == WindowsPackageTrust::store || package.trust == WindowsPackageTrust::system));
  } catch (...) { return false; }
}

struct WindowsFileLease::State {
  winrt::handle file;
  WindowsIdentityFacts facts;
  WindowsAppIdentity identity;
};
WindowsFileLease::WindowsFileLease(std::unique_ptr<State> state) : state_(std::move(state)) {}
WindowsFileLease::~WindowsFileLease() = default;
HANDLE WindowsFileLease::file_handle() const noexcept { return state_->file.get(); }

WindowsStaticIdentity observe_windows_file(const std::wstring& path) {
  auto state = std::make_unique<WindowsFileLease::State>(); state->file = open_image(path);
  const auto before = metadata(state->file.get());
  require_pe_image(state->file.get(), before.size);
  // Weak cache entries never outlive the immutable held file. A reopened path alone cannot revive old trust.
  static std::mutex cache_mutex;
  static std::vector<std::weak_ptr<WindowsFileLease>> cache;
  {
    std::lock_guard lock(cache_mutex);
    std::erase_if(cache, [](const auto& weak) { return weak.expired(); });
    for (const auto& weak : cache) if (const auto held = weak.lock(); held && metadata_equal(before, held->state_->facts.image))
      return {held->state_->identity, held->state_->facts.image, held};
  }
  state->facts.image = before; state->facts.image.sha256 = sha256(state->file.get(), before.size);
  const auto trust = signature(state->file.get(), before.path);
  state->facts.image.signature = trust.state; state->facts.image.signer_subject = trust.subject;
  state->facts.signature_source = trust.source; state->facts.publisher = trust.publisher; state->facts.microsoft_root = trust.microsoft;
  if (trust.state == SignatureState::valid) state->facts.original_filename = original_filename(before.path);
  state->facts.system_root = system_root();
  require(metadata_equal(before, metadata(state->file.get())));
  state->identity = windows_identity_from_facts(state->facts);
  auto lease = std::shared_ptr<WindowsFileLease>(new WindowsFileLease(std::move(state)));
  { std::lock_guard lock(cache_mutex); if (cache.size() >= 64) cache.erase(cache.begin()); cache.emplace_back(lease); }
  return {lease->state_->identity, lease->state_->facts.image, lease};
}
WindowsStaticIdentity observe_windows_file(HANDLE file) {
  const auto before = metadata(file);
  auto result = observe_windows_file(before.path);
  require(metadata_equal(before, result.image) && metadata_equal(before, metadata(file))); return result;
}
bool windows_file_current(const WindowsStaticIdentity& identity) noexcept {
  try {
    if (!identity.lease || !same_windows_identity(identity.identity, identity.lease->state_->identity) || !same_file(identity.image, identity.lease->state_->facts.image)) return false;
    if (!metadata_equal(identity.image, metadata(identity.lease->file_handle()))) return false;
    if (const auto& package = identity.lease->state_->facts.package) {
      const auto current = registered_application(package->aumid);
      return current.package == *package && equal_path(current.executable, identity.image.path);
    }
    return true;
  } catch (...) { return false; }
}

struct WindowsProcessLease::State {
  winrt::handle process;
  WindowsStaticIdentity image;
  WindowsProcessWitness witness;
  WindowsAppIdentity identity;
};
WindowsProcessLease::WindowsProcessLease(std::unique_ptr<State> state) : state_(std::move(state)) {}
WindowsProcessLease::~WindowsProcessLease() = default;
HANDLE WindowsProcessLease::process_handle() const noexcept { return state_->process.get(); }
WindowsOwner observe_windows_process(DWORD pid) {
  require(pid != 0);
  auto state = std::make_unique<WindowsProcessLease::State>();
  state->process.attach(OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
  require(state->process && GetProcessId(state->process.get()) == pid && WaitForSingleObject(state->process.get(), 0) == WAIT_TIMEOUT);
  state->witness.pid = pid; state->witness.creation_time = created(state->process.get()); state->witness.token = observe_token(state->process.get());
  state->image = observe_windows_file(process_path(state->process.get())); state->witness.image = state->image.image;
  state->witness.package = process_package(state->process.get());
  auto facts = state->image.lease->state_->facts; facts.package = state->witness.package; facts.pid = pid;
  state->identity = windows_identity_from_facts(facts);
  auto lease = std::shared_ptr<WindowsProcessLease>(new WindowsProcessLease(std::move(state)));
  WindowsOwner result{lease->state_->identity, lease->state_->witness, lease}; require(windows_owner_current(result)); return result;
}
bool windows_owner_current(const WindowsOwner& owner) noexcept {
  try {
    if (!owner.lease || !same_windows_identity(owner.identity, owner.lease->state_->identity) || !same_windows_process(owner.process, owner.lease->state_->witness)) return false;
    const auto& state = *owner.lease->state_;
    if (!windows_file_current(state.image) || GetProcessId(state.process.get()) != owner.process.pid || WaitForSingleObject(state.process.get(), 0) != WAIT_TIMEOUT ||
      created(state.process.get()) != owner.process.creation_time || !equal_path(process_path(state.process.get()), owner.process.image.path) ||
      !same_token(observe_token(state.process.get()), owner.process.token)) return false;
    return process_package(state.process.get(), owner.process.package ? &*owner.process.package : nullptr) == owner.process.package;
  } catch (...) { return false; }
}

WindowsStaticIdentity observe_windows_aumid(const std::wstring& aumid) {
  const auto application = registered_application(aumid);
  const auto image = observe_windows_file(application.executable);
  auto state = std::make_unique<WindowsFileLease::State>(); state->file = open_image(image.image.path);
  require(metadata_equal(image.image, metadata(state->file.get())));
  state->facts = image.lease->state_->facts; state->facts.package = application.package;
  state->identity = windows_identity_from_facts(state->facts);
  auto lease = std::shared_ptr<WindowsFileLease>(new WindowsFileLease(std::move(state)));
  WindowsStaticIdentity result{lease->state_->identity, lease->state_->facts.image, lease}; require(windows_file_current(result)); return result;
}
}
