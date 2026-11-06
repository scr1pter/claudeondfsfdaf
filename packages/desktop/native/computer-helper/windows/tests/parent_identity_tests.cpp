#include "parent_identity.h"
#include "identity.h"
#include <stdexcept>
#include <string>
#include <winrt/base.h>

namespace vector::computer {
namespace {
void require(bool condition, const char* label) { if (!condition) throw std::runtime_error(label); }
ParentEvidence fixture() {
  ParentEvidence value;
  value.expected_parent = 42; value.actual_parent = 42; value.helper_pid = 43;
  value.parent_created = 100; value.helper_created = 200;
  value.parent_token.user = {1, 2, 3}; value.parent_token.logon = {4, 5, 6};
  value.parent_token.authentication = 12; value.parent_token.session = 1;
  value.parent_token.integrity = SECURITY_MANDATORY_MEDIUM_RID;
  value.parent_token.elevated = false; value.parent_token.ui_access = false; value.parent_token.app_container = false;
  value.helper_token = value.parent_token;
  value.parent_image.path = L"C:\\Vector\\vector-desktop.exe";
  value.helper_image.path = L"C:\\Vector\\resources\\computer\\vector-computer.exe";
  for (auto* image : {&value.parent_image, &value.helper_image}) {
    image->volume = 10; image->id[0] = 1; image->size = 1024; image->created = 99; image->modified = 100;
    image->sha256[0] = 1; image->signature = SignatureState::unsigned_file;
  }
  value.helper_image.id[0] = 2;
  return value;
}
}

void parent_identity_tests() {
  const auto actual = observe_token(GetCurrentProcess());
  HANDLE raw = nullptr;
  require(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw) != FALSE, "parent.direct-token-open-query-only");
  winrt::handle borrowed_token(raw);
  const auto direct = observe_token_handle(borrowed_token.get());
  require(same_token(actual, direct), "parent.process-and-direct-token-readers-agree");
  DWORD session = 0, returned = 0;
  require(GetTokenInformation(borrowed_token.get(), TokenSessionId, &session, sizeof(session), &returned) != FALSE && returned == sizeof(session) && session == direct.session,
    "parent.direct-token-reader-preserves-borrowed-handle");
  require(same_token(direct, observe_token_handle(borrowed_token.get())), "parent.borrowed-token-remains-readable");
  bool token_as_process_refused = false, process_as_token_refused = false;
  try { (void)observe_token(borrowed_token.get()); } catch (const TokenObservationError&) { token_as_process_refused = true; }
  try { (void)observe_token_handle(GetCurrentProcess()); } catch (const TokenObservationError&) { process_as_token_refused = true; }
  require(token_as_process_refused && process_as_token_refused, "parent.process-and-token-handle-kinds-are-distinct");
  require(same_token(actual, observe_token(GetCurrentProcess())) && same_token(direct, observe_token_handle(borrowed_token.get())),
    "parent.wrong-handle-kind-refusal-preserves-readers");
  const auto value = fixture();
  require(parent_evidence_allowed(value), "parent.unsigned-stability-posture");
  for (const auto& channel : identity::kChannels) {
    auto changed = value;
    changed.parent_image.path = L"C:\\Vector\\" + std::wstring(channel.windowsExecutable.begin(), channel.windowsExecutable.end());
    require(parent_evidence_allowed(changed), "parent.all-generated-channel-paths");
  }
  for (const auto path : {L"C:\\Elsewhere\\vector-desktop.exe", L"C:\\Vector2\\vector-desktop.exe",
                         L"C:\\Vector\\sub\\vector-desktop.exe", L"C:\\Vector\\explorer.exe",
                         L"C:\\Vector\\..\\Vector\\vector-desktop.exe", L"\\\\server\\Vector\\vector-desktop.exe"}) {
    auto changed = value; changed.parent_image.path = path;
    require(!parent_evidence_allowed(changed), "parent.basename-never-authorizes");
  }
  for (const auto path : {L"C:\\Vector\\vector-computer.exe", L"C:\\Vector\\resources\\other\\vector-computer.exe",
                         L"C:\\Vector\\resources\\computer\\..\\computer\\vector-computer.exe",
                         L"C:/Vector/resources/computer/vector-computer.exe", L"relative\\resources\\computer\\vector-computer.exe"}) {
    auto changed = value; changed.helper_image.path = path;
    require(!parent_evidence_allowed(changed), "parent.exact-helper-layout");
  }
  auto changed = value; changed.actual_parent = 99;
  require(!parent_evidence_allowed(changed), "parent.actual-os-parent-required");
  changed = value; changed.helper_pid = changed.expected_parent;
  require(!parent_evidence_allowed(changed), "parent.cannot-self-parent");
  changed = value; changed.parent_created = changed.helper_created + 1;
  require(!parent_evidence_allowed(changed), "parent.pid-reuse-start-fence");
  changed = value; changed.parent_created = 0;
  require(!parent_evidence_allowed(changed), "parent.unknown-start-refused");

  for (int field = 0; field < 9; ++field) {
    changed = value;
    auto& token = changed.parent_token;
    if (field == 0) token.user = {9};
    if (field == 1) token.logon = {9};
    if (field == 2) token.authentication += 1;
    if (field == 3) token.session += 1;
    if (field == 4) token.integrity = SECURITY_MANDATORY_LOW_RID;
    if (field == 5) token.integrity = SECURITY_MANDATORY_HIGH_RID;
    if (field == 6) token.elevated = true;
    if (field == 7) token.ui_access = true;
    if (field == 8) token.app_container = true;
    require(!parent_evidence_allowed(changed), "parent.token-boundary");
    changed.helper_token = token;
    if (field >= 4) require(!parent_evidence_allowed(changed), "parent.same-unsafe-tokens-still-refused");
  }
  for (int field = 0; field < 3; ++field) {
    auto token = value.helper_token;
    if (field == 0) token.user.clear();
    if (field == 1) token.logon.clear();
    if (field == 2) token.authentication = 0;
    require(!serving_token_allowed(token), "parent.unknown-token-refused");
  }
  changed = value; changed.helper_token.elevated = true;
  require(!parent_evidence_allowed(changed), "parent.helper-own-elevation-refused");

  changed = value; changed.helper_image.signature = SignatureState::valid;
  changed.helper_image.signer_subject = {48, 1, 1};
  require(!parent_evidence_allowed(changed), "parent.signed-helper-unsigned-parent-refused");
  changed.parent_image.signature = SignatureState::valid; changed.parent_image.signer_subject = {48, 1, 1};
  require(!parent_evidence_allowed(changed), "parent.authenticated-subject-comparison-required");
  changed.publisher_continuity = true;
  require(parent_evidence_allowed(changed), "parent.valid-signed-subject-continuity");
  changed.publisher_continuity = false; changed.parent_image.signer_subject = {48, 1, 2};
  require(!parent_evidence_allowed(changed), "parent.other-valid-publisher-refused");
  changed = value; changed.parent_image.signature = SignatureState::invalid;
  require(!parent_evidence_allowed(changed), "parent.invalid-signature-not-unsigned");

  for (int field = 0; field < 8; ++field) {
    auto file = value.parent_image;
    if (field == 0) file.path += L"x";
    if (field == 1) file.volume += 1;
    if (field == 2) file.id[0] = static_cast<unsigned char>(file.id[0] + 1);
    if (field == 3) file.size += 1;
    if (field == 4) file.created += 1;
    if (field == 5) file.modified += 1;
    if (field == 6) file.sha256[0] = static_cast<unsigned char>(file.sha256[0] + 1);
    if (field == 7) file.signature = SignatureState::invalid;
    require(!same_file(value.parent_image, file), "parent.held-file-drift");
  }
  changed = value; changed.parent_image.sha256.fill(0);
  require(!parent_evidence_allowed(changed), "parent.unmeasured-hash-refused");
  changed = value; changed.helper_image.id.fill(0);
  require(!parent_evidence_allowed(changed), "parent.unknown-file-id-refused");
  require(same_file(value.parent_image, value.parent_image) && same_token(value.parent_token, value.helper_token), "parent.stable-witnesses");
}
}
