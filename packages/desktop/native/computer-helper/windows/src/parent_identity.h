#pragma once
#include <windows.h>
#include <array>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace vector::computer {
struct TokenIdentity {
  std::vector<unsigned char> user;
  std::vector<unsigned char> logon;
  std::uint64_t authentication = 0;
  DWORD session = 0;
  DWORD integrity = 0;
  bool elevated = true;
  bool ui_access = true;
  bool app_container = true;
};

enum class SignatureState { unsigned_file, valid, invalid };
struct FileIdentity {
  std::wstring path;
  std::uint64_t volume = 0;
  std::array<unsigned char, 16> id{};
  std::uint64_t size = 0;
  std::uint64_t created = 0;
  std::uint64_t modified = 0;
  std::array<unsigned char, 32> sha256{};
  SignatureState signature = SignatureState::invalid;
  // DER Subject of the actual signer selected by successful WinVerifyTrust, never a PE label.
  std::vector<unsigned char> signer_subject;
};

struct ParentEvidence {
  DWORD expected_parent = 0;
  DWORD actual_parent = 0;
  DWORD helper_pid = 0;
  std::uint64_t parent_created = 0;
  std::uint64_t helper_created = 0;
  TokenIdentity parent_token;
  TokenIdentity helper_token;
  FileIdentity parent_image;
  FileIdentity helper_image;
  bool publisher_continuity = false;
};

// Pure decisions over already observed witnesses; no process, token, path or trust lookup.
bool serving_token_allowed(const TokenIdentity& token) noexcept;
bool same_token(const TokenIdentity& left, const TokenIdentity& right) noexcept;
bool same_file(const FileIdentity& left, const FileIdentity& right) noexcept;
std::optional<std::wstring> helper_install_root(const std::wstring& helper);
bool parent_evidence_allowed(const ParentEvidence& evidence);

// Throws on unknown observations. Callers must not synthesize a non-elevated token on failure.
TokenIdentity observe_token(HANDLE process);

class ParentIdentity final {
 public:
  ~ParentIdentity();
  ParentIdentity(const ParentIdentity&) = delete;
  ParentIdentity& operator=(const ParentIdentity&) = delete;
  HANDLE process_handle() const noexcept;
  const ParentEvidence& evidence() const noexcept;
  bool unchanged() const noexcept;
 private:
  struct State;
  explicit ParentIdentity(std::unique_ptr<State> state);
  std::unique_ptr<State> state_;
  friend std::shared_ptr<ParentIdentity> verify_parent(DWORD expected_parent);
};

// Actual immediate OS parent only, with a held process handle/start time and held image files.
// Unsigned releases rely on same-install-root/token/file continuity, not publisher authentication.
std::shared_ptr<ParentIdentity> verify_parent(DWORD expected_parent);
}
