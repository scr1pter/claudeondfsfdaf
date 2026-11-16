#include "windows_identity.h"
#include <array>
#include <cstddef>
#include <stdexcept>
#include <string>
#include <utility>

namespace vector::computer {
namespace {
void require_identity(bool value, const char* label) {
  if (!value) throw std::runtime_error(label);
}
template <typename Work> void rejects_identity(Work&& work, const char* label) {
  try { std::forward<Work>(work)(); }
  catch (...) { return; }
  throw std::runtime_error(label);
}

WindowsIdentityFacts identity_facts() {
  WindowsIdentityFacts facts;
  facts.image.path = L"C:\\Applications\\writer.exe";
  facts.image.volume = 42;
  facts.image.id[0] = 7;
  facts.image.size = 4096;
  facts.image.created = 10;
  facts.image.modified = 20;
  facts.image.sha256.fill(0xAB);
  facts.image.signature = SignatureState::valid;
  facts.image.signer_subject = {0x30, 0x01, 0x01};
  facts.signature_source = WindowsSignatureSource::embedded;
  facts.publisher = L"Sample Publisher";
  facts.original_filename = L"writer.exe";
  facts.system_root = L"C:\\Windows";
  facts.pid = 101;
  return facts;
}

WindowsIdentityFacts packaged_facts() {
  auto facts = identity_facts();
  facts.package = WindowsPackageEvidence{
    L"Sample.App_abcdefghijklm!App", L"Sample.App_abcdefghijklm",
    L"Sample.App_1.0.0.0_x64__abcdefghijklm",
    L"C:\\Program Files\\WindowsApps\\Sample.App_1.0.0.0_x64__abcdefghijklm",
    WindowsPackageTrust::store, false};
  facts.image.path = facts.package->path + L"\\writer.exe";
  return facts;
}

WindowsProcessWitness process_witness() {
  const auto facts = packaged_facts();
  WindowsProcessWitness witness;
  witness.pid = 101;
  witness.creation_time = 100;
  witness.image = facts.image;
  witness.package = facts.package;
  witness.token.user = {1, 2, 3};
  witness.token.logon = {4, 5, 6};
  witness.token.authentication = 12;
  witness.token.session = 1;
  witness.token.integrity = SECURITY_MANDATORY_MEDIUM_RID;
  witness.token.elevated = false;
  witness.token.ui_access = false;
  witness.token.app_container = false;
  return witness;
}
}

// Only synthetic, already-observed facts are passed to pure classifiers/comparisons. No native observation runs.
size_t run_windows_identity_tests() {
  size_t count = 0;
  const auto test = [&](auto&& work) { work(); ++count; };

  test([&] {
    for (const auto source : {WindowsSignatureSource::embedded, WindowsSignatureSource::catalog}) {
      auto facts = identity_facts(); facts.signature_source = source;
      const auto identity = windows_identity_from_facts(facts);
      require_identity(identity.kind == WindowsAppKind::exe && identity.verified && !identity.system &&
        identity.publisher == L"Sample Publisher" && identity.product.empty() && identity.binary == L"writer.exe" &&
        identity.exe == facts.image.path && identity.pid == facts.pid && identity.aumid.empty(),
        "windows-identity.embedded-and-catalog-verified-original-name");
    }
  });
  test([&] {
    const auto facts = identity_facts();
    const auto original = windows_identity_from_facts(facts);
    auto renamed = facts; renamed.image.path = L"D:\\Copied Apps\\calculator.exe";
    renamed.image.id[0] = 9; renamed.image.volume = 99;
    const auto copy = windows_identity_from_facts(renamed);
    require_identity(copy.publisher == original.publisher && copy.product == original.product && copy.binary == original.binary &&
      copy.binary == L"writer.exe" && copy.exe == renamed.image.path && copy.verified && !same_windows_identity(original, copy),
      "windows-identity.renamed-copy-keeps-signed-authority-not-path-witness");
    require_identity(copy.product.empty() && original.product.empty(), "windows-identity.product-name-never-authority");
  });
  test([&] {
    std::wstring expected = L"unverified-";
    for (size_t index = 0; index < 32; ++index) expected += L"AB";
    for (const auto signature : {SignatureState::unsigned_file, SignatureState::invalid}) {
      auto facts = identity_facts(); facts.image.signature = signature;
      facts.signature_source = WindowsSignatureSource::none; facts.image.signer_subject.clear();
      const auto identity = windows_identity_from_facts(facts);
      require_identity(identity.kind == WindowsAppKind::exe && !identity.verified && !identity.system && identity.publisher.empty() &&
        identity.product.empty() && identity.binary == expected, "windows-identity.untrusted-content-hash-marker");
      auto renamed = facts; renamed.image.path = L"C:\\Applications\\MicrosoftCalculator.exe";
      renamed.original_filename = L"another-forged-name.exe";
      const auto copy = windows_identity_from_facts(renamed);
      require_identity(copy.binary == identity.binary && copy.product == identity.product && copy.publisher.empty(),
        "windows-identity.untrusted-basename-and-version-name-do-not-identify");
      facts.image.sha256[31] = static_cast<unsigned char>(facts.image.sha256[31] ^ 1U);
      require_identity(windows_identity_from_facts(facts).binary != identity.binary,
        "windows-identity.untrusted-marker-binds-complete-content-hash");
    }
  });
  test([&] {
    for (int field = 0; field < 6; ++field) {
      auto facts = identity_facts();
      if (field == 0) facts.signature_source = WindowsSignatureSource::none;
      if (field == 1) facts.image.signer_subject.clear();
      if (field == 2) facts.publisher.clear();
      if (field == 3) facts.original_filename.clear();
      if (field == 4) facts.original_filename = L"subdirectory\\writer.exe";
      if (field == 5) facts.signature_source = static_cast<WindowsSignatureSource>(99);
      const auto identity = windows_identity_from_facts(facts);
      require_identity(!identity.verified && !identity.system && identity.publisher.empty() && identity.product.empty() &&
        identity.binary.starts_with(L"unverified-"), "windows-identity.incomplete-signature-proof-demotes");
    }
  });
  test([&] {
    for (int field = 0; field < 9; ++field) {
      auto facts = identity_facts();
      if (field == 0) facts.image.path = L"relative\\writer.exe";
      if (field == 1) facts.image.path = L"C:\\Applications\\..\\writer.exe";
      if (field == 2) facts.image.size = 0;
      if (field == 3) facts.image.size = 1'073'741'825;
      if (field == 4) facts.image.created = 0;
      if (field == 5) facts.image.modified = 0;
      if (field == 6) facts.image.id.fill(0);
      if (field == 7) facts.image.sha256.fill(0);
      if (field == 8) facts.pid = 0;
      rejects_identity([&] { (void)windows_identity_from_facts(facts); }, "windows-identity.malformed-image-facts-refused");
    }
  });
  test([&] {
    auto facts = identity_facts(); facts.image.path = L"C:\\Windows\\System32\\writer.exe";
    facts.publisher = L"Microsoft Corporation";
    require_identity(!windows_identity_from_facts(facts).system, "windows-identity.publisher-name-is-not-microsoft-root-proof");
    facts.microsoft_root = true;
    require_identity(windows_identity_from_facts(facts).system, "windows-identity.microsoft-root-and-system-root-conjunction");
    facts.system_root = L"c:\\WINDOWS";
    require_identity(windows_identity_from_facts(facts).system, "windows-identity.system-containment-windows-case");
    for (const auto path : {L"C:\\WindowsCopy\\writer.exe", L"C:\\Applications\\writer.exe", L"C:\\Windows.exe"}) {
      facts.image.path = path;
      require_identity(!windows_identity_from_facts(facts).system, "windows-identity.system-root-requires-directory-boundary");
    }
    facts.image.path = L"C:\\Windows\\System32\\writer.exe";
    facts.image.signature = SignatureState::unsigned_file;
    require_identity(!windows_identity_from_facts(facts).system, "windows-identity.unsigned-microsoft-claims-not-system");
    facts = identity_facts(); facts.image.path = L"C:\\Windows\\System32\\unknown-host.exe";
    facts.microsoft_root = true; facts.original_filename.clear();
    const auto platform = windows_identity_from_facts(facts);
    require_identity(platform.system && !platform.verified && platform.publisher.empty() && platform.product.empty() &&
      platform.binary.starts_with(L"unverified-"), "windows-identity.unknown-signed-platform-image-stays-protected");
  });
  test([&] {
    auto facts = identity_facts();
    facts.image.path = L"C:\\Applications\\\U0001F600\\writer.exe";
    facts.publisher = L"Sample \U0001F600 Publisher";
    facts.original_filename = L"writer-\U0001F600.exe";
    const auto identity = windows_identity_from_facts(facts);
    require_identity(identity.verified && identity.exe == facts.image.path && identity.publisher == facts.publisher &&
      identity.binary == facts.original_filename, "windows-identity.valid-paired-utf16-path-and-signer-label");
  });
  test([&] {
    const std::array<std::wstring, 4> invalid{
      std::wstring(1, static_cast<wchar_t>(0xD800)), std::wstring(1, static_cast<wchar_t>(0xDC00)),
      std::wstring{static_cast<wchar_t>(0xD800), L'A'},
      std::wstring{static_cast<wchar_t>(0xDC00), static_cast<wchar_t>(0xD800)}};
    for (const auto& units : invalid) {
      auto facts = identity_facts(); facts.image.path = L"C:\\Applications\\" + units + L"\\writer.exe";
      rejects_identity([&] { (void)windows_identity_from_facts(facts); }, "windows-identity.malformed-utf16-path-refused");
      facts = identity_facts(); facts.publisher = L"Publisher" + units;
      require_identity(!windows_identity_from_facts(facts).verified, "windows-identity.malformed-utf16-signer-label-demotes");
      facts = identity_facts(); facts.original_filename = L"writer" + units + L".exe";
      require_identity(!windows_identity_from_facts(facts).verified, "windows-identity.malformed-utf16-original-name-demotes");
      facts = packaged_facts(); facts.package->aumid += units;
      rejects_identity([&] { (void)windows_identity_from_facts(facts); }, "windows-identity.malformed-utf16-package-refused");
    }
  });
  test([&] {
    const auto facts = packaged_facts();
    const auto identity = windows_identity_from_facts(facts);
    require_identity(identity.kind == WindowsAppKind::aumid && identity.verified && !identity.system &&
      identity.aumid == facts.package->aumid && identity.exe == facts.image.path && identity.pid == facts.pid,
      "windows-identity.actual-package-facts-issue-aumid-identity");
    auto unsigned_member = facts;
    unsigned_member.image.signature = SignatureState::unsigned_file; unsigned_member.signature_source = WindowsSignatureSource::none;
    unsigned_member.image.signer_subject.clear(); unsigned_member.publisher.clear();
    const auto package = windows_identity_from_facts(unsigned_member);
    require_identity(package.kind == WindowsAppKind::aumid && package.verified && package.publisher.empty() && !package.system,
      "windows-identity.trusted-package-signature-is-separate-from-pe-signature");
  });
  test([&] {
    for (const auto trust : {WindowsPackageTrust::unknown, WindowsPackageTrust::none, WindowsPackageTrust::developer,
         WindowsPackageTrust::enterprise, WindowsPackageTrust::store, WindowsPackageTrust::system,
         static_cast<WindowsPackageTrust>(99)}) {
      const bool trusted = trust == WindowsPackageTrust::enterprise || trust == WindowsPackageTrust::store ||
        trust == WindowsPackageTrust::system;
      for (const bool development : {false, true}) {
        auto facts = packaged_facts(); facts.package->trust = trust; facts.package->development_mode = development;
        const auto identity = windows_identity_from_facts(facts);
        require_identity(identity.kind == WindowsAppKind::aumid && identity.aumid == facts.package->aumid &&
          identity.verified == (trusted && !development) && !identity.system,
          "windows-identity.package-verification-requires-trusted-signature-and-no-development-mode");
        facts.image.signature = SignatureState::unsigned_file; facts.signature_source = WindowsSignatureSource::none;
        facts.image.signer_subject.clear(); facts.publisher.clear();
        const auto unsigned_member = windows_identity_from_facts(facts);
        require_identity(unsigned_member.verified == (trusted && !development) && unsigned_member.publisher.empty(),
          "windows-identity.package-trust-does-not-depend-on-member-authenticode");
      }
    }
  });
  test([&] {
    auto facts = packaged_facts();
    const WindowsPackageEvidence defaults;
    facts.package->trust = defaults.trust; facts.package->development_mode = defaults.development_mode;
    const auto identity = windows_identity_from_facts(facts);
    require_identity(defaults.trust == WindowsPackageTrust::unknown && defaults.development_mode &&
      identity.kind == WindowsAppKind::aumid && !identity.verified && identity.aumid == facts.package->aumid,
      "windows-identity.unobserved-package-trust-defaults-never-verify");
  });
  test([&] {
    for (int field = 0; field < 9; ++field) {
      auto facts = packaged_facts();
      if (field == 0) facts.package->aumid.clear();
      if (field == 1) facts.package->aumid = facts.package->family;
      if (field == 2) facts.package->aumid = L"!App";
      if (field == 3) facts.package->aumid = facts.package->family + L"!";
      if (field == 4) facts.package->aumid += L"!Other";
      if (field == 5) facts.package->family = L"Other.App_abcdefghijklm";
      if (field == 6) facts.package->full_name.clear();
      if (field == 7) facts.package->full_name = L"Other.App_1.0.0.0_x64__abcdefghijklm";
      if (field == 8) facts.package->full_name = L"Sample.App_1.0.0.0_x64__zzzzzzzzzzzzz";
      rejects_identity([&] { (void)windows_identity_from_facts(facts); }, "windows-identity.package-identifiers-must-agree");
    }
  });
  test([&] {
    auto facts = packaged_facts();
    facts.image.path = facts.package->path + L"-copy\\writer.exe";
    rejects_identity([&] { (void)windows_identity_from_facts(facts); }, "windows-identity.package-sibling-prefix-is-not-containment");
    facts = packaged_facts(); facts.package->path += L"\\different";
    rejects_identity([&] { (void)windows_identity_from_facts(facts); }, "windows-identity.package-root-must-contain-executable");
    facts = packaged_facts(); facts.package->path = L"relative\\package";
    rejects_identity([&] { (void)windows_identity_from_facts(facts); }, "windows-identity.package-root-is-canonical");
    facts = packaged_facts(); facts.package->path = L"c:\\PROGRAM FILES\\WINDOWSAPPS\\Sample.App_1.0.0.0_x64__abcdefghijklm";
    require_identity(windows_identity_from_facts(facts).kind == WindowsAppKind::aumid,
      "windows-identity.package-containment-windows-case");
  });
  test([&] {
    const auto identity = windows_identity_from_facts(identity_facts());
    require_identity(same_windows_identity(identity, identity), "windows-identity.identity-reflexive");
    for (int field = 0; field < 11; ++field) {
      auto changed = identity;
      if (field == 0) changed.kind = WindowsAppKind::aumid;
      if (field == 1) changed.aumid = L"Sample.App_abcdefghijklm!App";
      if (field == 2) changed.publisher += L" Other";
      if (field == 3) changed.product = L"Forged ProductName";
      if (field == 4) changed.binary = L"other.exe";
      if (field == 5) changed.name = L"Another display label";
      if (field == 6) changed.exe = L"C:\\Applications\\copy.exe";
      if (field == 7) changed.system = !changed.system;
      if (field == 8) changed.verified = !changed.verified;
      if (field == 9) changed.pid = 102;
      if (field == 10) changed.pid.reset();
      require_identity(!same_windows_identity(identity, changed) && !same_windows_identity(changed, identity),
        "windows-identity.identity-comparison-detects-every-field");
    }
  });
  test([&] {
    const auto witness = process_witness();
    require_identity(same_windows_process(witness, witness), "windows-identity.process-witness-reflexive");
    for (int field = 0; field < 27; ++field) {
      auto changed = witness;
      if (field == 0) changed.pid += 1;
      if (field == 1) changed.creation_time += 1;
      if (field == 2) changed.image.path += L".copy";
      if (field == 3) changed.image.volume += 1;
      if (field == 4) changed.image.id[15] = static_cast<unsigned char>(changed.image.id[15] ^ 1U);
      if (field == 5) changed.image.size += 1;
      if (field == 6) changed.image.created += 1;
      if (field == 7) changed.image.modified += 1;
      if (field == 8) changed.image.sha256[31] = static_cast<unsigned char>(changed.image.sha256[31] ^ 1U);
      if (field == 9) changed.image.signature = SignatureState::invalid;
      if (field == 10) changed.image.signer_subject.push_back(2);
      if (field == 11) changed.token.user.push_back(9);
      if (field == 12) changed.token.logon.push_back(9);
      if (field == 13) changed.token.authentication += 1;
      if (field == 14) changed.token.session += 1;
      if (field == 15) changed.token.integrity = SECURITY_MANDATORY_HIGH_RID;
      if (field == 16) changed.token.elevated = true;
      if (field == 17) changed.token.ui_access = true;
      if (field == 18) changed.token.app_container = true;
      if (field == 19) changed.package.reset();
      if (field == 20) changed.package->aumid += L"Other";
      if (field == 21) changed.package->family += L"Other";
      if (field == 22) changed.package->full_name += L"Other";
      if (field == 23) changed.package->path += L"Other";
      if (field == 24) changed.image.signer_subject.clear();
      if (field == 25) changed.package->trust = WindowsPackageTrust::developer;
      if (field == 26) changed.package->development_mode = true;
      require_identity(!same_windows_process(witness, changed) && !same_windows_process(changed, witness),
        "windows-identity.process-witness-detects-token-file-signer-package-drift");
    }
  });
  test([&] {
    auto witness = process_witness(); witness.pid = 0;
    require_identity(!same_windows_process(witness, witness), "windows-identity.zero-process-id-is-not-a-witness");
    witness = process_witness(); witness.creation_time = 0;
    require_identity(!same_windows_process(witness, witness), "windows-identity.unknown-creation-time-is-not-a-witness");
    const auto plain = [&] { auto value = process_witness(); value.package.reset(); return value; }();
    require_identity(same_windows_process(plain, plain) && !same_windows_process(plain, process_witness()),
      "windows-identity.package-presence-is-part-of-process-witness");
  });
  test([&] {
    auto facts = packaged_facts(); facts.image.signature = SignatureState::unsigned_file;
    facts.image.signer_subject.clear(); facts.signature_source = WindowsSignatureSource::none;
    auto witness = process_witness(); witness.image = facts.image;
    const auto identity = windows_identity_from_facts(facts);
    require_identity(identity.verified && windows_package_identity_matches(identity, witness),
      "windows-identity.trusted-package-owns-unsigned-member-image");
    witness.package->trust = WindowsPackageTrust::developer;
    require_identity(!windows_package_identity_matches(identity, witness), "windows-identity.package-coherence-rechecks-trust");
    auto once = identity; once.verified = false;
    require_identity(windows_package_identity_matches(once, witness), "windows-identity.untrusted-package-remains-task-only");
    witness.package->full_name = L"Other.App_1.0.0.0_x64__abcdefghijklm";
    require_identity(!windows_package_identity_matches(once, witness), "windows-identity.package-coherence-rechecks-family");
    witness = process_witness(); once.pid = 102;
    require_identity(!windows_package_identity_matches(once, witness), "windows-identity.package-coherence-binds-real-process");
  });
  return count;
}
}
