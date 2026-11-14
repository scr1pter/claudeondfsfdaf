#pragma once
#include "parent_identity.h"
#include <aclapi.h>
#include <bcrypt.h>
#include <sddl.h>
#include <array>
#include <exception>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>
#include <winrt/base.h>

// Never-shipped Caller support. Existing USER objects and their ACLs are read only.
namespace vector::computer::caller_desktop {
inline constexpr DWORD station_all = STANDARD_RIGHTS_REQUIRED | WINSTA_ENUMDESKTOPS | WINSTA_READATTRIBUTES |
  WINSTA_ACCESSCLIPBOARD | WINSTA_CREATEDESKTOP | WINSTA_ACCESSGLOBALATOMS | WINSTA_EXITWINDOWS | WINSTA_ENUMERATE;
inline constexpr DWORD desktop_all = STANDARD_RIGHTS_REQUIRED | DESKTOP_READOBJECTS | DESKTOP_CREATEWINDOW | DESKTOP_CREATEMENU |
  DESKTOP_HOOKCONTROL | DESKTOP_JOURNALRECORD | DESKTOP_JOURNALPLAYBACK | DESKTOP_ENUMERATE | DESKTOP_WRITEOBJECTS | DESKTOP_SWITCHDESKTOP;
enum class Access { allowed, denied, unknown };
inline bool may_isolate(Access access) noexcept { return access == Access::denied; }
[[noreturn]] inline void refused() { throw std::runtime_error("The test desktop could not be proved."); }
[[noreturn]] inline void restoration_failed() noexcept { (void)TerminateProcess(GetCurrentProcess(), 1); std::terminate(); }

struct Binding {
  Binding() = default;
  Binding(const Binding&) = delete;
  Binding& operator=(const Binding&) = delete;
  std::wstring path;
  HWINSTA station = nullptr;
  HDESK desktop = nullptr;
  ~Binding() { if (desktop) (void)CloseDesktop(desktop); if (station) (void)CloseWindowStation(station); }
};
struct Station {
  HWINSTA value = nullptr;
  ~Station() { if (value) (void)CloseWindowStation(value); }
};
struct Desktop {
  HDESK value = nullptr;
  ~Desktop() { if (value) (void)CloseDesktop(value); }
};
struct Local {
  HLOCAL value = nullptr;
  ~Local() { if (value) (void)LocalFree(value); }
};

inline std::wstring name(HANDLE object) {
  std::array<wchar_t, 256> value{}; DWORD bytes = 0;
  if (!object || !GetUserObjectInformationW(object, UOI_NAME, value.data(), static_cast<DWORD>(sizeof(value)), &bytes) ||
      bytes < 2 * sizeof(wchar_t) || bytes > sizeof(value) || bytes % sizeof(wchar_t) || value[bytes / sizeof(wchar_t) - 1]) refused();
  std::wstring result(value.data(), bytes / sizeof(wchar_t) - 1);
  for (const auto character : result) if (character < 32 || character == 127 || character == L'\\' || character == L'/' || character == L':') refused();
  return result;
}

class Impersonation final {
 public:
  explicit Impersonation(HANDLE candidate) {
    HANDLE previous = nullptr;
    if (OpenThreadToken(GetCurrentThread(), TOKEN_QUERY | TOKEN_IMPERSONATE, TRUE, &previous)) previous_.attach(previous);
    else if (GetLastError() != ERROR_NO_TOKEN) refused();
    HANDLE duplicate = nullptr;
    if (!DuplicateTokenEx(candidate, TOKEN_QUERY | TOKEN_IMPERSONATE, nullptr, SecurityImpersonation, TokenImpersonation, &duplicate)) refused();
    token_.attach(duplicate);
    if (!SetThreadToken(nullptr, token_.get())) refused();
    active_ = true;
  }
  ~Impersonation() {
    if (active_ && !SetThreadToken(nullptr, previous_ ? previous_.get() : nullptr))
      restoration_failed();
  }
 private:
  winrt::handle previous_, token_;
  bool active_ = false;
};

// OpenDesktop is relative to the process station. Only the private creation scope switches it.
inline Access probe(HANDLE candidate, const std::wstring& station_name, const std::wstring& desktop_name) {
  Impersonation impersonation(candidate);
  Station station{OpenWindowStationW(station_name.c_str(), FALSE, GENERIC_ALL)};
  if (!station.value) return GetLastError() == ERROR_ACCESS_DENIED ? Access::denied : Access::unknown;
  Desktop desktop{OpenDesktopW(desktop_name.c_str(), 0, FALSE, GENERIC_ALL)};
  if (!desktop.value) return GetLastError() == ERROR_ACCESS_DENIED ? Access::denied : Access::unknown;
  return name(station.value) == station_name && name(desktop.value) == desktop_name ? Access::allowed : Access::unknown;
}

class StationSwitch final {
 public:
  explicit StationSwitch(HWINSTA station) : original_(GetProcessWindowStation()), original_desktop_(GetThreadDesktop(GetCurrentThreadId())) {
    if (!original_ || !original_desktop_ || !SetProcessWindowStation(station)) refused();
    active_ = true;
  }
  void restore() noexcept {
    if (active_) {
      if (!SetProcessWindowStation(original_)) restoration_failed();
      // CreateDesktop may assign its desktop to this thread. Restore both borrowed objects.
      if (GetThreadDesktop(GetCurrentThreadId()) != original_desktop_ && !SetThreadDesktop(original_desktop_)) restoration_failed();
      active_ = false;
    }
  }
  ~StationSwitch() { restore(); }
 private:
  HWINSTA original_ = nullptr; // Borrowed; never closed.
  HDESK original_desktop_ = nullptr; // Borrowed; never closed.
  bool active_ = false;
};

inline std::wstring sid_text(const std::vector<unsigned char>& sid) {
  if (sid.empty() || !IsValidSid(const_cast<unsigned char*>(sid.data()))) refused();
  LPWSTR raw = nullptr;
  if (!ConvertSidToStringSidW(const_cast<unsigned char*>(sid.data()), &raw)) refused();
  Local close{raw};
  return raw;
}

inline bool descriptor_matches(PSECURITY_DESCRIPTOR descriptor, const TokenIdentity& token, DWORD all_access) noexcept {
  if (!descriptor || !IsValidSecurityDescriptor(descriptor) || token.user.empty() || token.logon.empty()) return false;
  SECURITY_DESCRIPTOR_CONTROL control{}; DWORD revision = 0;
  if (!GetSecurityDescriptorControl(descriptor, &control, &revision) || !(control & SE_DACL_PROTECTED)) return false;
  PSID owner = nullptr; BOOL defaulted = FALSE, present = FALSE; PACL dacl = nullptr, sacl = nullptr;
  if (!GetSecurityDescriptorOwner(descriptor, &owner, &defaulted) || defaulted || !owner ||
      !EqualSid(owner, const_cast<unsigned char*>(token.user.data())) ||
      !GetSecurityDescriptorDacl(descriptor, &present, &dacl, &defaulted) || !present || !dacl || defaulted ||
      !IsValidAcl(dacl) || dacl->AceCount != 2) return false;
  bool user = false, logon = false;
  for (DWORD index = 0; index < dacl->AceCount; ++index) {
    void* raw = nullptr;
    if (!GetAce(dacl, index, &raw)) return false;
    const auto ace = static_cast<const ACCESS_ALLOWED_ACE*>(raw);
    if (ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE || ace->Header.AceFlags || ace->Header.AceSize < sizeof(ACCESS_ALLOWED_ACE) ||
        (ace->Mask != GENERIC_ALL && ace->Mask != all_access)) return false;
    const auto sid = const_cast<DWORD*>(&ace->SidStart);
    if (!IsValidSid(sid) || GetLengthSid(sid) > static_cast<DWORD>(ace->Header.AceSize) - static_cast<DWORD>(FIELD_OFFSET(ACCESS_ALLOWED_ACE, SidStart))) return false;
    if (EqualSid(sid, const_cast<unsigned char*>(token.user.data())) && !user) user = true;
    else if (EqualSid(sid, const_cast<unsigned char*>(token.logon.data())) && !logon) logon = true;
    else return false;
  }
  if (!user || !logon || !GetSecurityDescriptorSacl(descriptor, &present, &sacl, &defaulted) || !present || !sacl || defaulted || !IsValidAcl(sacl) || sacl->AceCount != 1) return false;
  void* raw = nullptr;
  if (!GetAce(sacl, 0, &raw)) return false;
  const auto label = static_cast<const SYSTEM_MANDATORY_LABEL_ACE*>(raw);
  if (label->Header.AceType != SYSTEM_MANDATORY_LABEL_ACE_TYPE || label->Header.AceFlags || label->Header.AceSize < sizeof(SYSTEM_MANDATORY_LABEL_ACE) || label->Mask != SYSTEM_MANDATORY_LABEL_NO_WRITE_UP) return false;
  const auto sid = const_cast<DWORD*>(&label->SidStart);
  return IsValidSid(sid) && GetLengthSid(sid) <= static_cast<DWORD>(label->Header.AceSize) - static_cast<DWORD>(FIELD_OFFSET(SYSTEM_MANDATORY_LABEL_ACE, SidStart)) && IsWellKnownSid(sid, WinMediumLabelSid);
}

inline void verify_security(HANDLE object, const TokenIdentity& token, DWORD all_access) {
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  const auto error = GetSecurityInfo(object, SE_WINDOW_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION,
    nullptr, nullptr, nullptr, nullptr, &descriptor);
  Local close{descriptor};
  if (error != ERROR_SUCCESS || !descriptor_matches(descriptor, token, all_access)) refused();
}

inline std::wstring unique_name() {
  std::array<unsigned char, 16> random{};
  if (BCryptGenRandom(nullptr, random.data(), static_cast<ULONG>(random.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) refused();
  constexpr wchar_t hex[] = L"0123456789abcdef";
  std::wstring result = L"VectorComputerTest-";
  for (const auto value : random) { result.push_back(hex[value >> 4]); result.push_back(hex[value & 15]); }
  return result;
}

inline std::shared_ptr<Binding> prepare(HANDLE candidate, const TokenIdentity& candidate_identity, const char*& stage) {
  const auto began = GetTickCount64();
  const auto bounded = [&] { if (GetTickCount64() - began >= 1000) refused(); };
  stage = "desktop-observation";
  const auto token = observe_token(GetCurrentProcess());
  if (candidate_identity.integrity != SECURITY_MANDATORY_MEDIUM_RID || !serving_token_allowed(candidate_identity) ||
      token.user != candidate_identity.user || token.logon != candidate_identity.logon || token.authentication != candidate_identity.authentication ||
      token.session != candidate_identity.session) refused();
  const auto station_name = name(GetProcessWindowStation());
  const auto desktop_name = name(GetThreadDesktop(GetCurrentThreadId()));
  stage = "desktop-access";
  const auto access = probe(candidate, station_name, desktop_name);
  auto result = std::make_shared<Binding>();
  if (access == Access::allowed) { bounded(); result->path = station_name + L"\\" + desktop_name; return result; }
  if (!may_isolate(access)) refused();
  bounded();
  stage = "desktop-private-security";
  const auto user = sid_text(candidate_identity.user), logon = sid_text(candidate_identity.logon);
  const auto sddl = L"O:" + user + L"D:P(A;;GA;;;" + user + L")(A;;GA;;;" + logon + L")S:(ML;;NW;;;ME)";
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr)) refused();
  Local close{descriptor};
  SECURITY_ATTRIBUTES security{static_cast<DWORD>(sizeof(SECURITY_ATTRIBUTES)), descriptor, FALSE};
  stage = "desktop-private-station";
  std::wstring owned_name;
  for (unsigned attempt = 0; attempt < 4; ++attempt) {
    bounded(); owned_name = unique_name();
    result->station = CreateWindowStationW(owned_name.c_str(), CWF_CREATE_ONLY, GENERIC_ALL, &security);
    if (result->station) break;
    if (GetLastError() != ERROR_ALREADY_EXISTS) refused();
  }
  if (!result->station) refused();
  verify_security(result->station, candidate_identity, station_all);
  USEROBJECTFLAGS flags{}; DWORD bytes = 0;
  if (!GetUserObjectInformationW(result->station, UOI_FLAGS, &flags, sizeof(flags), &bytes) || bytes != sizeof(flags) || (flags.dwFlags & WSF_VISIBLE)) refused();
  stage = "desktop-private-default";
  {
    StationSwitch switched(result->station);
    bounded();
    result->desktop = CreateDesktopW(L"Default", nullptr, nullptr, 0, GENERIC_ALL | DESKTOP_CREATEWINDOW | DESKTOP_READOBJECTS | DESKTOP_WRITEOBJECTS, &security);
    if (!result->desktop) refused();
    verify_security(result->desktop, candidate_identity, desktop_all);
    stage = "desktop-private-access";
    if (probe(candidate, owned_name, L"Default") != Access::allowed) refused();
    switched.restore();
  }
  bounded();
  result->path = owned_name + L"\\Default";
  return result;
}
}
