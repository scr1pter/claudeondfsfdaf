#include "program_registry.h"
#include <bcrypt.h>
#include <algorithm>
#include <array>
#include <chrono>
#include <limits>
#include <stdexcept>
#include <utility>

namespace vector::computer {
namespace {
[[noreturn]] void invalid() { throw Failure{L"failed", L"The native program artifact is invalid."}; }
[[noreturn]] void changed() { throw Failure{L"changed", L"The prepared program launch changed."}; }
bool hex(std::wstring_view value, size_t size) {
  return value.size() == size && std::all_of(value.begin(), value.end(), [](wchar_t c) { return (c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f'); });
}
bool safe_text(std::wstring_view value) {
  for (size_t index = 0; index < value.size(); ++index) {
    const auto c = static_cast<uint16_t>(value[index]);
    if (c < 32 || (c >= 127 && c <= 159) || c == 0x061c || (c >= 0x200b && c <= 0x200f) ||
        (c >= 0x2028 && c <= 0x202e) || (c >= 0x2060 && c <= 0x206f) || c == 0xfeff) return false;
    if (c >= 0xd800 && c <= 0xdbff) {
      if (++index >= value.size() || value[index] < 0xdc00 || value[index] > 0xdfff) return false;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}
bool session_valid(const ServerSession& session) {
  return !session.id.empty() && session.id.size() <= 256 && safe_text(session.id) && session.run_epoch != 0 &&
    session.observation_epoch != 0 && (!session.revision || *session.revision <= kMaximumSafeInteger);
}
bool normalized_name(std::wstring_view name) {
  return std::none_of(name.begin(), name.end(), [](wchar_t c) {
    return c == 0x00a0 || c == 0x1680 || (c >= 0x2000 && c <= 0x200a) || c == 0x202f || c == 0x205f || c == 0x3000;
  });
}
void utf8(std::string& result, uint32_t value) {
  if (value < 0x80) result.push_back(static_cast<char>(value));
  else if (value < 0x800) { result.push_back(static_cast<char>(0xc0 | (value >> 6))); result.push_back(static_cast<char>(0x80 | (value & 63))); }
  else if (value < 0x10000) { result.push_back(static_cast<char>(0xe0 | (value >> 12))); result.push_back(static_cast<char>(0x80 | ((value >> 6) & 63))); result.push_back(static_cast<char>(0x80 | (value & 63))); }
  else { result.push_back(static_cast<char>(0xf0 | (value >> 18))); result.push_back(static_cast<char>(0x80 | ((value >> 12) & 63))); result.push_back(static_cast<char>(0x80 | ((value >> 6) & 63))); result.push_back(static_cast<char>(0x80 | (value & 63))); }
}
std::wstring random_hex() {
  std::array<uint8_t, 16> bytes{};
  if (BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) changed();
  constexpr wchar_t digits[] = L"0123456789abcdef";
  std::wstring result;
  for (const auto byte : bytes) { result.push_back(digits[byte >> 4]); result.push_back(digits[byte & 15]); }
  return result;
}
}

std::wstring program_sha256(std::span<const uint8_t> bytes) {
  BCRYPT_ALG_HANDLE algorithm = nullptr; BCRYPT_HASH_HANDLE hash = nullptr;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) invalid();
  struct CloseAlgorithm { BCRYPT_ALG_HANDLE value; ~CloseAlgorithm() { BCryptCloseAlgorithmProvider(value, 0); } } close_algorithm{algorithm};
  DWORD size = 0, received = 0;
  if (BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&size), sizeof(size), &received, 0) < 0 ||
      received != sizeof(size) || size == 0 || size > 65'536) invalid();
  std::vector<uint8_t> object(size);
  if (BCryptCreateHash(algorithm, &hash, object.data(), size, nullptr, 0, 0) < 0) invalid();
  struct CloseHash { BCRYPT_HASH_HANDLE value; ~CloseHash() { BCryptDestroyHash(value); } } close_hash{hash};
  while (!bytes.empty()) {
    const auto count = static_cast<ULONG>(std::min<size_t>(bytes.size(), 65'536));
    if (BCryptHashData(hash, const_cast<PUCHAR>(bytes.data()), count, 0) < 0) invalid();
    bytes = bytes.subspan(count);
  }
  std::array<uint8_t, 32> digest{};
  if (BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0) < 0) invalid();
  constexpr wchar_t digits[] = L"0123456789abcdef";
  std::wstring result;
  for (const auto byte : digest) { result.push_back(digits[byte >> 4]); result.push_back(digits[byte & 15]); }
  return result;
}

// Exact JSON.stringify string bytes, including well-formed escaping of lone UTF-16 surrogates.
std::string program_json_quote(std::wstring_view text) {
  constexpr char digits[] = "0123456789abcdef";
  std::string result = "\"";
  for (size_t index = 0; index < text.size(); ++index) {
    auto value = static_cast<uint32_t>(text[index]);
    if (value == 34) result += "\\\"";
    else if (value == 92) result += "\\\\";
    else if (value == 8) result += "\\b";
    else if (value == 9) result += "\\t";
    else if (value == 10) result += "\\n";
    else if (value == 12) result += "\\f";
    else if (value == 13) result += "\\r";
    else if (value < 32 || (value >= 0xd800 && value <= 0xdfff &&
             !(value <= 0xdbff && index + 1 < text.size() && text[index + 1] >= 0xdc00 && text[index + 1] <= 0xdfff))) {
      result += "\\u";
      for (int shift = 12; shift >= 0; shift -= 4) result.push_back(digits[(value >> shift) & 15]);
    } else {
      if (value >= 0xd800 && value <= 0xdbff) value = 0x10000 + ((value - 0xd800) << 10) + (static_cast<uint32_t>(text[++index]) - 0xdc00);
      utf8(result, value);
    }
  }
  return result + "\"";
}
std::wstring program_key(std::wstring_view path, std::wstring_view binding) {
  const auto json = "[\"windows\"," + program_json_quote(path) + "," + program_json_quote(binding) + "]";
  return L"program:windows:" + program_sha256({reinterpret_cast<const uint8_t*>(json.data()), json.size()});
}
bool canonical_program_path(std::wstring_view path) noexcept {
  if (path.size() < 4 || path.size() > 4096 || !safe_text(path) || path[1] != L':' || path[2] != L'\\' ||
      !((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z'))) return false;
  size_t start = 3;
  for (size_t index = 3; index <= path.size(); ++index) {
    if (index != path.size() && path[index] != L'\\') { if (path[index] == L'/' || path[index] == L':') return false; continue; }
    const auto part = path.substr(start, index - start);
    if (part.empty() || part == L"." || part == L".." || part.back() == L'.' || part.back() == L' ') return false;
    start = index + 1;
  }
  return true;
}
bool valid_program_artifact(const NativeProgramArtifact& artifact) {
  if (!canonical_program_path(artifact.path) || artifact.name.empty() || artifact.name.size() > 256 || !safe_text(artifact.name) || !normalized_name(artifact.name) ||
      artifact.name.front() == L' ' || artifact.name.back() == L' ' || artifact.name.find(L"  ") != std::wstring::npos || !hex(artifact.binding, 64)) return false;
  if (artifact.route == WindowsProgramRoute::executable) return !artifact.handler && !artifact.handler_path && artifact.handler_arguments.empty();
  if (!artifact.handler || !artifact.handler->verified || artifact.handler->kind != WindowsAppKind::exe || artifact.handler->pid || !artifact.handler_path ||
      artifact.handler->exe != *artifact.handler_path || !canonical_program_path(*artifact.handler_path) ||
      artifact.handler->publisher.empty() || artifact.handler->publisher.size() > 256 || !safe_text(artifact.handler->publisher) ||
      artifact.handler->binary.empty() || artifact.handler->binary.size() > 260 || !safe_text(artifact.handler->binary) ||
      artifact.handler->name.empty() || artifact.handler->name.size() > 256 || !safe_text(artifact.handler->name) ||
      artifact.handler->product.size() > 256 || !safe_text(artifact.handler->product)) return false;
  return valid_program_arguments(artifact.handler_arguments);
}
bool valid_program_arguments(const std::vector<std::wstring>& arguments) {
  if (arguments.empty() || arguments.size() > 32) return false;
  size_t operands = 0;
  size_t total = 0;
  for (const auto& argument : arguments) {
    total += argument.size() + 1; if (total > 24'000) return false;
    if (argument == L"%1" || argument == L"%L" || argument == L"%l") { ++operands; continue; }
    if (argument.size() > 4096 || !safe_text(argument) || argument.find(L'%') != std::wstring::npos) return false;
  }
  return operands == 1;
}
bool same_program_artifact(const NativeProgramArtifact& a, const NativeProgramArtifact& b) noexcept {
  return a.path == b.path && a.name == b.name && a.binding == b.binding && a.route == b.route && a.handler_path == b.handler_path &&
    a.handler_arguments == b.handler_arguments && a.handler.has_value() == b.handler.has_value() &&
    (!a.handler || same_windows_identity(*a.handler, *b.handler));
}
JsonObject PreparedProgramLaunch::public_wire() const {
  JsonObject value;
  value.Insert(L"key", JsonValue::CreateStringValue(key)); value.Insert(L"platform", JsonValue::CreateStringValue(L"windows"));
  value.Insert(L"path", JsonValue::CreateStringValue(artifact.path)); value.Insert(L"name", JsonValue::CreateStringValue(artifact.name));
  value.Insert(L"binding", JsonValue::CreateStringValue(artifact.binding));
  return value;
}
JsonObject PreparedProgramLaunch::wire() const {
  auto value = public_wire(); value.Insert(L"token", JsonValue::CreateStringValue(token));
  if (artifact.handler) value.Insert(L"handler", artifact.handler->wire());
  return value;
}

ProgramLaunchRegistry::ProgramLaunchRegistry(size_t limit, uint64_t ttl_ms, Clock clock, Random random)
  : limit_(std::clamp<size_t>(limit, 1, 1000)), ttl_(std::clamp<uint64_t>(ttl_ms, 1, 30'000)),
    clock_(clock ? std::move(clock) : [] { return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count()); }),
    random_(random ? std::move(random) : random_hex), worker_(random_()) {
  if (!hex(worker_, 32)) invalid();
}
bool ProgramLaunchRegistry::observe(uint64_t now) {
  const bool coherent = !last_time_ || now >= *last_time_;
  if (!coherent) entries_.clear();
  for (auto item = entries_.begin(); item != entries_.end();) {
    if (item->second.created > now || now >= item->second.expires) item = entries_.erase(item); else ++item;
  }
  last_time_ = now;
  return coherent;
}
PreparedProgramLaunch ProgramLaunchRegistry::prepare(const NativeProgramArtifact& artifact, const ServerSession& session) {
  if (!valid_program_artifact(artifact) || !session_valid(session)) invalid();
  std::lock_guard guard(mutex_);
  if (closed_) changed();
  const auto now = clock_(); (void)observe(now);
  if (entries_.size() >= limit_ || sequence_ == std::numeric_limits<uint64_t>::max()) throw Failure{L"busy", L"Too many native program preparations are pending."};
  if (now > std::numeric_limits<uint64_t>::max() - ttl_) changed();
  const auto nonce = random_(); if (!hex(nonce, 32)) changed();
  const auto token = L"program_" + worker_ + L"_" + std::to_wstring(++sequence_) + L"_" + nonce;
  PreparedProgramLaunch prepared{artifact, token, program_key(artifact.path, artifact.binding)};
  entries_.emplace(token, Entry{prepared, session.id, session.run_epoch, session.observation_epoch, session.revision, now, now + ttl_});
  return prepared;
}
NativeProgramArtifact ProgramLaunchRegistry::consume(const std::wstring& token, const std::wstring& binding, const ServerSession& session) {
  std::lock_guard guard(mutex_);
  const auto found = entries_.find(token);
  std::optional<Entry> entry;
  if (found != entries_.end()) { entry = found->second; entries_.erase(found); }
  const auto now = clock_(); const auto coherent = observe(now);
  if (closed_ || !coherent || !entry || token.size() > 256 || !session_valid(session) || entry->created > now || now >= entry->expires ||
      entry->session != session.id || entry->run_epoch != session.run_epoch || entry->observation_epoch != session.observation_epoch ||
      entry->revision != session.revision || binding != entry->prepared.artifact.binding) changed();
  return entry->prepared.artifact;
}
void ProgramLaunchRegistry::clear() { std::lock_guard guard(mutex_); entries_.clear(); }
void ProgramLaunchRegistry::close() { std::lock_guard guard(mutex_); closed_ = true; entries_.clear(); }
}
