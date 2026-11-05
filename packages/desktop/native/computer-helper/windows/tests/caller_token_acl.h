#pragma once
#include "parent_identity.h"
#include <algorithm>
#include <array>
#include <cstring>
#include <cstdint>
#include <stdexcept>
#include <vector>
#include <winrt/base.h>

// Never-shipped Caller startup support. Only a freshly owned restricted token may be changed.
namespace vector::computer::caller_token_acl {
[[noreturn]] inline void refused() { throw std::runtime_error("The restricted token startup ACL could not be verified."); }
inline void mark(const char** stage, const char* value) noexcept { if (stage) *stage = value; }
inline constexpr DWORD query_capacity(TOKEN_INFORMATION_CLASS kind) noexcept {
  const auto fixed = fixed_token_information_size(kind);
  if (fixed) return fixed;
  switch (kind) {
    case TokenMandatoryPolicy: return static_cast<DWORD>(sizeof(TOKEN_MANDATORY_POLICY));
    case TokenHasRestrictions:
    case TokenSandBoxInert: return static_cast<DWORD>(sizeof(DWORD));
    default: return 65'536;
  }
}
inline const char* query_stage(TOKEN_INFORMATION_CLASS kind) noexcept {
  switch (kind) {
    case TokenUser: return "restricted-acl-query-user";
    case TokenOwner: return "restricted-acl-query-owner";
    case TokenPrimaryGroup: return "restricted-acl-query-primary";
    case TokenIntegrityLevel: return "restricted-acl-query-integrity";
    case TokenGroups: return "restricted-acl-query-groups";
    case TokenRestrictedSids: return "restricted-acl-query-restricting";
    case TokenPrivileges: return "restricted-acl-query-privileges";
    case TokenStatistics: return "restricted-acl-query-statistics";
    case TokenMandatoryPolicy: return "restricted-acl-query-mandatory";
    case TokenHasRestrictions: return "restricted-acl-query-restrictions";
    case TokenSandBoxInert: return "restricted-acl-query-inert";
    case TokenDefaultDacl: return "restricted-acl-query-default";
    default: return "restricted-acl-query-unknown";
  }
}
inline std::vector<unsigned char> query(HANDLE token, TOKEN_INFORMATION_CLASS kind, const char** stage = nullptr,
                                       decltype(&GetTokenInformation) reader = &GetTokenInformation) {
  mark(stage, query_stage(kind));
  const auto capacity = query_capacity(kind);
  // Fixed reads match the serving reader's known-size in/out convention exactly.
  std::vector<unsigned char> bytes(capacity); DWORD size = capacity == 65'536 ? 0 : capacity;
  if (!reader(token, kind, bytes.data(), capacity, &size)) {
    const auto error = GetLastError();
    if (kind == TokenHasRestrictions) {
      switch (error) {
        case ERROR_INSUFFICIENT_BUFFER: mark(stage, "restricted-acl-restrictions-buffer"); break;
        case ERROR_BAD_LENGTH: mark(stage, "restricted-acl-restrictions-length"); break;
        case ERROR_INVALID_PARAMETER: mark(stage, "restricted-acl-restrictions-invalid"); break;
        case ERROR_ACCESS_DENIED: mark(stage, "restricted-acl-restrictions-denied"); break;
        case ERROR_NOT_SUPPORTED: mark(stage, "restricted-acl-restrictions-unsupported"); break;
        default: mark(stage, "restricted-acl-restrictions-api"); break;
      }
    }
    refused();
  }
  if (kind == TokenHasRestrictions && size != capacity) {
    mark(stage, !size ? "restricted-acl-restrictions-zero" : size < capacity ? "restricted-acl-restrictions-short" : "restricted-acl-restrictions-large");
  }
  if (!size || size > bytes.size() || (capacity != 65'536 && size != capacity)) refused();
  bytes.resize(size); return bytes;
}
inline bool sid_fits(PSID sid, size_t extent) noexcept {
  if (!sid || extent < 8) return false;
  const auto count = static_cast<const unsigned char*>(sid)[1];
  if (count > SID_MAX_SUB_AUTHORITIES || GetSidLengthRequired(count) > extent) return false;
  return IsValidSid(sid) && GetLengthSid(sid) == GetSidLengthRequired(count);
}
inline std::vector<unsigned char> sid_bytes(const std::vector<unsigned char>& bytes, PSID sid) {
  const auto begin = reinterpret_cast<std::uintptr_t>(bytes.data()), address = reinterpret_cast<std::uintptr_t>(sid);
  if (!sid || address < begin || address - begin > bytes.size() || !sid_fits(sid, bytes.size() - (address - begin))) refused();
  const auto length = GetLengthSid(sid);
  if (!length || length > SECURITY_MAX_SID_SIZE || length > bytes.size() - (address - begin)) refused();
  const auto first = static_cast<const unsigned char*>(sid);
  return {first, first + length};
}
inline PACL acl(const std::vector<unsigned char>& bytes) {
  if (bytes.size() < sizeof(TOKEN_DEFAULT_DACL)) refused();
  const auto value = reinterpret_cast<const TOKEN_DEFAULT_DACL*>(bytes.data())->DefaultDacl;
  const auto begin = reinterpret_cast<std::uintptr_t>(bytes.data()), address = reinterpret_cast<std::uintptr_t>(value);
  if (!value || address < begin || address - begin > bytes.size() || bytes.size() - (address - begin) < sizeof(ACL) ||
      value->AclSize > bytes.size() - (address - begin) || !IsValidAcl(value)) refused();
  return value;
}
struct LowerAcl { std::vector<unsigned char> bytes; bool incomplete = false; };
inline LowerAcl lower_acl(PACL source, const char** stage = nullptr) {
  mark(stage, "restricted-acl-shape-acl");
  if (!source || !IsValidAcl(source) || (source->AclRevision != ACL_REVISION && source->AclRevision != ACL_REVISION_DS)) refused();
  const auto first = reinterpret_cast<unsigned char*>(source);
  LowerAcl result{std::vector<unsigned char>(first, first + source->AclSize), false};
  const auto target = reinterpret_cast<PACL>(result.bytes.data());
  for (DWORD index = 0; index < static_cast<DWORD>(target->AceCount); ++index) {
    void* raw = nullptr;
    mark(stage, "restricted-acl-shape-extent");
    if (!GetAce(target, index, &raw)) refused();
    const auto ace = static_cast<ACCESS_ALLOWED_ACE*>(raw);
    if (static_cast<size_t>(ace->Header.AceSize) < FIELD_OFFSET(ACCESS_ALLOWED_ACE, SidStart) + size_t{8}) refused();
    mark(stage, "restricted-acl-shape-type");
    if (ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE && ace->Header.AceType != ACCESS_DENIED_ACE_TYPE) refused();
    mark(stage, "restricted-acl-shape-flags");
    if (ace->Header.AceFlags & ~INHERITED_ACE) refused();
    const auto sid = const_cast<DWORD*>(&ace->SidStart);
    mark(stage, "restricted-acl-shape-sid");
    if (!sid_fits(sid, static_cast<size_t>(ace->Header.AceSize) - FIELD_OFFSET(ACCESS_ALLOWED_ACE, SidStart))) refused();
    constexpr SID_IDENTIFIER_AUTHORITY creator = SECURITY_CREATOR_SID_AUTHORITY;
    const auto authority = GetSidIdentifierAuthority(sid);
    mark(stage, "restricted-acl-shape-creator");
    if (std::equal(std::begin(creator.Value), std::end(creator.Value), std::begin(authority->Value))) refused();
    const auto generic = ace->Mask & (GENERIC_READ | GENERIC_WRITE | GENERIC_EXECUTE);
    if (generic) result.incomplete = true;
    // Under-allow and over-deny without guessing an object's generic R/W/X mapping.
    // A grant is sufficient; a nongrant with these approximations remains unknown.
    const auto all = (ace->Mask & GENERIC_ALL) != 0;
    ace->Mask &= ~(GENERIC_READ | GENERIC_WRITE | GENERIC_EXECUTE | GENERIC_ALL);
    if (all || (generic && ace->Header.AceType == ACCESS_DENIED_ACE_TYPE)) ace->Mask |= PROCESS_ALL_ACCESS;
  }
  return result;
}
struct Observation { char owner = 'n'; char process_dacl = 'n'; char cause = 'q'; };
inline Observation observe(HANDLE token, const char** stage = nullptr) noexcept {
  Observation result;
  try {
    const auto user = query(token, TokenUser, stage), owner = query(token, TokenOwner, stage);
    mark(stage, "restricted-acl-observe-identity");
    if (user.size() < sizeof(TOKEN_USER) || owner.size() < sizeof(TOKEN_OWNER)) { result.cause = 'o'; return result; }
    std::vector<unsigned char> user_sid, owner_sid;
    try {
      user_sid = sid_bytes(user, reinterpret_cast<const TOKEN_USER*>(user.data())->User.Sid);
      owner_sid = sid_bytes(owner, reinterpret_cast<const TOKEN_OWNER*>(owner.data())->Owner);
    } catch (...) { result.cause = 'o'; return result; }
    result.owner = user_sid == owner_sid ? 'u' : 'x';
    const auto group = query(token, TokenPrimaryGroup, stage), defaults = query(token, TokenDefaultDacl, stage);
    mark(stage, "restricted-acl-observe-default");
    if (group.size() < sizeof(TOKEN_PRIMARY_GROUP)) { result.cause = 'g'; return result; }
    if (defaults.size() < sizeof(TOKEN_DEFAULT_DACL)) { result.cause = 'm'; return result; }
    std::vector<unsigned char> group_sid;
    try { group_sid = sid_bytes(group, reinterpret_cast<const TOKEN_PRIMARY_GROUP*>(group.data())->PrimaryGroup); }
    catch (...) { result.cause = 'g'; return result; }
    if (!reinterpret_cast<const TOKEN_DEFAULT_DACL*>(defaults.data())->DefaultDacl) { result.cause = 'z'; return result; }
    PACL source = nullptr;
    try { source = acl(defaults); } catch (...) { result.cause = 'i'; return result; }
    result.cause = 'e';
    LowerAcl lowered;
    try { lowered = lower_acl(source, stage); } catch (const std::runtime_error&) { result.cause = 't'; return result; }
    SECURITY_DESCRIPTOR descriptor{};
    mark(stage, "restricted-acl-descriptor");
    if (!InitializeSecurityDescriptor(&descriptor, SECURITY_DESCRIPTOR_REVISION) ||
        !SetSecurityDescriptorOwner(&descriptor, owner_sid.data(), FALSE) || !SetSecurityDescriptorGroup(&descriptor, group_sid.data(), FALSE) ||
        !SetSecurityDescriptorDacl(&descriptor, TRUE, reinterpret_cast<PACL>(const_cast<unsigned char*>(lowered.bytes.data())), FALSE)) { result.cause = 'v'; return result; }
    HANDLE raw = nullptr;
    mark(stage, "restricted-acl-duplicate");
    if (!DuplicateTokenEx(token, TOKEN_QUERY | TOKEN_IMPERSONATE, nullptr, SecurityImpersonation, TokenImpersonation, &raw)) { result.cause = 'p'; return result; }
    winrt::handle impersonation{raw}; GENERIC_MAPPING mapping{0, 0, 0, PROCESS_ALL_ACCESS};
    alignas(PRIVILEGE_SET) std::array<unsigned char, 1024> privileges{};
    DWORD size = static_cast<DWORD>(privileges.size()), granted = 0; BOOL allowed = FALSE;
    mark(stage, "restricted-acl-access-check");
    if (!AccessCheck(&descriptor, impersonation.get(), PROCESS_ALL_ACCESS, &mapping,
        reinterpret_cast<PPRIVILEGE_SET>(privileges.data()), &size, &granted, &allowed)) { result.cause = 'a'; return result; }
    if (allowed && (granted & PROCESS_ALL_ACCESS) == PROCESS_ALL_ACCESS) { result.process_dacl = 'g'; result.cause = 's'; }
    else { result.process_dacl = lowered.incomplete ? 'n' : 'd'; result.cause = lowered.incomplete ? 'r' : 's'; }
  } catch (...) {}
  return result;
}
inline std::vector<unsigned char> append_user(PACL source, const std::vector<unsigned char>& user) {
  (void)lower_acl(source); // Reject unsupported creation-time/conditional semantics before any mutation.
  if (!sid_fits(const_cast<unsigned char*>(user.data()), user.size()) || GetLengthSid(const_cast<unsigned char*>(user.data())) != user.size()) refused();
  ACL_SIZE_INFORMATION size{};
  if (!GetAclInformation(source, &size, sizeof(size), AclSizeInformation)) refused();
  const auto total = static_cast<size_t>(size.AclBytesInUse) + sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD) + user.size();
  if (total > 65'535) refused();
  std::vector<unsigned char> result(total);
  const auto target = reinterpret_cast<PACL>(result.data());
  if (!InitializeAcl(target, static_cast<DWORD>(result.size()), source->AclRevision)) refused();
  for (DWORD index = 0; index < static_cast<DWORD>(source->AceCount); ++index) {
    void* raw = nullptr; if (!GetAce(source, index, &raw)) refused();
    const auto header = static_cast<ACE_HEADER*>(raw);
    if (!AddAce(target, source->AclRevision, MAXDWORD, raw, header->AceSize)) refused();
  }
  if (!AddAccessAllowedAceEx(target, source->AclRevision, 0, GENERIC_ALL, const_cast<unsigned char*>(user.data()))) refused();
  return result;
}
inline bool exact_append(PACL before, PACL after, const std::vector<unsigned char>& user) noexcept {
  if (!sid_fits(const_cast<unsigned char*>(user.data()), user.size()) || GetLengthSid(const_cast<unsigned char*>(user.data())) != user.size()) return false;
  if (!before || !after || !IsValidAcl(before) || !IsValidAcl(after) || before->AclRevision != after->AclRevision ||
      static_cast<DWORD>(after->AceCount) != static_cast<DWORD>(before->AceCount) + 1) return false;
  for (DWORD index = 0; index < static_cast<DWORD>(before->AceCount); ++index) {
    void* old = nullptr; void* current = nullptr;
    if (!GetAce(before, index, &old) || !GetAce(after, index, &current)) return false;
    const auto size = static_cast<ACE_HEADER*>(old)->AceSize;
    if (size != static_cast<ACE_HEADER*>(current)->AceSize || std::memcmp(old, current, size)) return false;
  }
  void* raw = nullptr; if (!GetAce(after, before->AceCount, &raw)) return false;
  const auto added = static_cast<ACCESS_ALLOWED_ACE*>(raw);
  if (static_cast<size_t>(added->Header.AceSize) != FIELD_OFFSET(ACCESS_ALLOWED_ACE, SidStart) + user.size() ||
      added->Header.AceType != ACCESS_ALLOWED_ACE_TYPE || added->Header.AceFlags || added->Mask != GENERIC_ALL) return false;
  const auto sid = reinterpret_cast<const unsigned char*>(&added->SidStart);
  return std::equal(user.begin(), user.end(), sid);
}
struct Sid { std::vector<unsigned char> bytes; DWORD attributes = 0; bool operator==(const Sid&) const = default; };
struct Privilege { std::uint64_t id = 0; DWORD attributes = 0; bool operator==(const Privilege&) const = default; };
inline std::vector<Sid> sid_groups(const std::vector<unsigned char>& bytes) {
  if (bytes.size() < sizeof(DWORD)) refused();
  DWORD count = 0; std::memcpy(&count, bytes.data(), sizeof(count));
  if (!count) return {};
  if (bytes.size() < FIELD_OFFSET(TOKEN_GROUPS, Groups) || count > (bytes.size() - FIELD_OFFSET(TOKEN_GROUPS, Groups)) / sizeof(SID_AND_ATTRIBUTES)) refused();
  const auto value = reinterpret_cast<const TOKEN_GROUPS*>(bytes.data());
  std::vector<Sid> entries;
  for (DWORD index = 0; index < count; ++index) entries.push_back({sid_bytes(bytes, value->Groups[index].Sid), value->Groups[index].Attributes});
  return entries;
}
struct Snapshot {
  Sid user, integrity; std::vector<unsigned char> owner, primary; std::vector<Sid> groups, restricting; std::vector<Privilege> privileges;
  std::uint64_t token = 0, authentication = 0; DWORD type = 0, mandatory = 0, restrictions = 0, inert = 0;
  bool operator==(const Snapshot&) const = default;
};
inline std::uint64_t luid(LUID value) noexcept { return (std::uint64_t(static_cast<DWORD>(value.HighPart)) << 32) | value.LowPart; }
inline Snapshot snapshot(HANDLE token, const char** stage = nullptr) {
  Snapshot result;
  const auto user = query(token, TokenUser, stage), owner = query(token, TokenOwner, stage), primary = query(token, TokenPrimaryGroup, stage), integrity = query(token, TokenIntegrityLevel, stage);
  mark(stage, "restricted-acl-snapshot-identity");
  if (user.size() < sizeof(TOKEN_USER) || owner.size() < sizeof(TOKEN_OWNER) || primary.size() < sizeof(TOKEN_PRIMARY_GROUP) || integrity.size() < sizeof(TOKEN_MANDATORY_LABEL)) refused();
  const auto actual_user = reinterpret_cast<const TOKEN_USER*>(user.data());
  result.user = {sid_bytes(user, actual_user->User.Sid), actual_user->User.Attributes};
  result.owner = sid_bytes(owner, reinterpret_cast<const TOKEN_OWNER*>(owner.data())->Owner);
  result.primary = sid_bytes(primary, reinterpret_cast<const TOKEN_PRIMARY_GROUP*>(primary.data())->PrimaryGroup);
  const auto label = reinterpret_cast<const TOKEN_MANDATORY_LABEL*>(integrity.data());
  result.integrity = {sid_bytes(integrity, label->Label.Sid), label->Label.Attributes};
  result.groups = sid_groups(query(token, TokenGroups, stage)); result.restricting = sid_groups(query(token, TokenRestrictedSids, stage));
  const auto privileges = query(token, TokenPrivileges, stage);
  if (privileges.size() < FIELD_OFFSET(TOKEN_PRIVILEGES, Privileges)) refused();
  const auto values = reinterpret_cast<const TOKEN_PRIVILEGES*>(privileges.data());
  if (values->PrivilegeCount > (privileges.size() - FIELD_OFFSET(TOKEN_PRIVILEGES, Privileges)) / sizeof(LUID_AND_ATTRIBUTES)) refused();
  for (DWORD index = 0; index < values->PrivilegeCount; ++index) result.privileges.push_back({luid(values->Privileges[index].Luid), values->Privileges[index].Attributes});
  const auto statistics = query(token, TokenStatistics, stage);
  if (statistics.size() < sizeof(TOKEN_STATISTICS)) refused();
  const auto stats = reinterpret_cast<const TOKEN_STATISTICS*>(statistics.data());
  result.token = luid(stats->TokenId); result.authentication = luid(stats->AuthenticationId); result.type = static_cast<DWORD>(stats->TokenType);
  const auto scalar = [&](TOKEN_INFORMATION_CLASS kind) { const auto bytes = query(token, kind, stage); if (bytes.size() != sizeof(DWORD)) refused(); DWORD value = 0; std::memcpy(&value, bytes.data(), sizeof(value)); return value; };
  result.mandatory = scalar(TokenMandatoryPolicy); result.restrictions = scalar(TokenHasRestrictions); result.inert = scalar(TokenSandBoxInert);
  return result;
}
inline bool ensure_owned_restricted(HANDLE token, const char** stage = nullptr) {
  mark(stage, "restricted-acl-preproof");
  const auto proof = observe(token, stage);
  if (proof.process_dacl == 'g') return false;
  if (proof.cause != 's' && proof.cause != 'r') refused();
  const auto before = snapshot(token, stage);
  mark(stage, "restricted-acl-append-read");
  const auto defaults = query(token, TokenDefaultDacl);
  const auto original = acl(defaults);
  mark(stage, "restricted-acl-append-build");
  auto appended = append_user(original, before.user.bytes);
  const auto expected = reinterpret_cast<PACL>(appended.data());
  mark(stage, "restricted-acl-append-verify");
  if (!exact_append(original, expected, before.user.bytes)) refused();
  TOKEN_DEFAULT_DACL update{expected};
  mark(stage, "restricted-acl-set");
  if (!SetTokenInformation(token, TokenDefaultDacl, &update, sizeof(update))) refused();
  mark(stage, "restricted-acl-readback");
  const auto after = query(token, TokenDefaultDacl);
  if (!exact_append(original, acl(after), before.user.bytes)) refused();
  const auto unchanged = before == snapshot(token, stage);
  mark(stage, "restricted-acl-unchanged");
  if (!unchanged) refused();
  const auto postproof = observe(token, stage);
  if (postproof.process_dacl != 'g') {
    if (postproof.cause == 's' || postproof.cause == 'r') mark(stage, "restricted-acl-postproof");
    refused();
  }
  return true;
}
}
