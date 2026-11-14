#include "program_registry.h"
#include <atomic>
#include <limits>
#include <stdexcept>
#include <thread>

namespace vector::computer {
namespace {
void check(bool value, const char* name) { if (!value) throw std::runtime_error(name); }
template<class Body> void refuses(const wchar_t* code, Body body) {
  try { body(); } catch (const Failure& failure) { check(failure.code == code, "program.registry-refusal-category"); return; }
  throw std::runtime_error("program.registry-refusal-missing");
}
ServerSession session() {
  ServerSession value; value.id = L"program-unit"; value.run_epoch = 10; value.observation_epoch = 11; value.revision = 1; return value;
}
NativeProgramArtifact artifact() {
  NativeProgramArtifact value; value.path = L"C:\\Vector\\fixture.exe"; value.name = L"Fixture"; value.binding = std::wstring(64, L'a'); return value;
}
NativeProgramArtifact document() {
  auto value = artifact(); value.path = L"C:\\Vector\\document.txt"; value.route = WindowsProgramRoute::document;
  WindowsAppIdentity handler; handler.name = L"Viewer"; handler.binary = L"viewer.exe"; handler.publisher = L"Actual Publisher";
  handler.verified = true; handler.exe = L"C:\\Viewer\\viewer.exe"; value.handler = handler; value.handler_path = handler.exe;
  value.handler_arguments = {L"--open", L"%1"}; return value;
}
std::wstring random() { return std::wstring(32, L'a'); }
}
size_t run_program_registry_tests() {
  size_t groups = 0;
  auto test = [&](const auto& body) { body(); ++groups; };
  test([] {
    check(program_sha256({}) == L"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "program.sha256-empty");
    const std::string abc = "abc";
    check(program_sha256({reinterpret_cast<const uint8_t*>(abc.data()), abc.size()}) == L"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "program.sha256-content");
    const std::wstring binding(64, L'a');
    check(program_key(L"C:\\Vector\\fixture.exe", binding) == L"program:windows:ad9f84e5a17f5e3df4f7b2d1ebe566412dfa546ece24746bf61de9e40d2537c6", "program.key-js-json-bytes");
    check(program_key(L"C:\\工具\U0001f600\\build.exe", binding) == L"program:windows:1cdeeb3e638774a45e9f99ff1015bb7561549a7f6424f332b218eedfa2f5b456", "program.key-utf8-surrogate-pair");
    check(program_key(L"C:\\é\\file.exe", binding) == L"program:windows:3a5bf821bcadec84baa5231a367b37a72b1c95be1b459dda5c316849b662f80c" &&
          program_key(L"C:\\e\u0301\\file.exe", binding) == L"program:windows:784e5e04a69e3099dda11e6723cc2e90a453faf62cf1b65796973b59a9ebf3db", "program.key-no-unicode-folding");
  });
  test([] {
    check(program_json_quote(L"\"\\\b\t\n\f\r") == "\"\\\"\\\\\\b\\t\\n\\f\\r\"", "program.json-escaping");
    check(program_json_quote(std::wstring(1, static_cast<wchar_t>(0xd800))) == "\"\\ud800\"" &&
          program_json_quote(std::wstring(1, static_cast<wchar_t>(0xdc00))) == "\"\\udc00\"", "program.json-lone-surrogates");
  });
  test([] {
    const auto value = artifact(); const auto authority = session(); ProgramLaunchRegistry registry(1000, 30000, [] { return 100ULL; }, random);
    const auto prepared = registry.prepare(value, authority);
    const auto public_value = prepared.public_wire(), private_value = prepared.wire();
    check(public_value.Size() == 5 && !public_value.HasKey(L"token") && !public_value.HasKey(L"handler") &&
          private_value.Size() == 6 && private_value.HasKey(L"token"), "program.public-capability-separation");
    check(prepared.token.size() <= 256 && prepared.key == program_key(value.path, value.binding), "program.exact-preparation");
    check(same_program_artifact(registry.consume(prepared.token, value.binding, authority), value), "program.consume-once");
    refuses(L"changed", [&] { (void)registry.consume(prepared.token, value.binding, authority); });
    check(authority.approved.Size() == 0, "program.no-app-approval-side-effect");
  });
  test([] {
    const auto value = document(); ProgramLaunchRegistry registry(1000, 30000, [] { return 100ULL; }, random);
    const auto prepared = registry.prepare(value, session());
    check(prepared.wire().HasKey(L"handler") && !prepared.public_wire().HasKey(L"handler"), "program.handler-private");
    check(same_program_artifact(registry.consume(prepared.token, value.binding, session()), value), "program.handler-preserved");
    for (int field = 0; field < 5; ++field) {
      auto altered = value;
      if (field == 0) altered.handler->publisher += L" changed";
      if (field == 1) altered.handler_path = L"C:\\Other\\viewer.exe";
      if (field == 2) altered.handler_arguments = {L"--different", L"%1"};
      if (field == 3) altered.binding[0] = L'b';
      if (field == 4) altered.name += L" changed";
      check(!same_program_artifact(value, altered), "program.exact-handler-and-content-facts");
    }
  });
  test([] {
    for (int failure = 0; failure < 7; ++failure) {
      uint64_t now = 100; ProgramLaunchRegistry registry(1000, 30, [&] { return now; }, random);
      const auto value = artifact(); auto authority = session(); const auto prepared = registry.prepare(value, authority);
      auto binding = value.binding;
      if (failure == 0) binding[0] = L'b';
      if (failure == 1) authority.id += L"changed";
      if (failure == 2) ++authority.run_epoch;
      if (failure == 3) ++authority.observation_epoch;
      if (failure == 4) authority.revision = 2;
      if (failure == 5) now = 130;
      if (failure == 6) now = 99;
      refuses(L"changed", [&] { (void)registry.consume(prepared.token, binding, authority); });
      now = 100;
      refuses(L"changed", [&] { (void)registry.consume(prepared.token, value.binding, session()); });
    }
  });
  test([] {
    uint64_t now = 100; ProgramLaunchRegistry registry(1, 30, [&] { return now; }, random);
    const auto first = registry.prepare(artifact(), session());
    refuses(L"busy", [&] { (void)registry.prepare(artifact(), session()); });
    now = 130; const auto second = registry.prepare(artifact(), session());
    check(first.token != second.token, "program.expiry-never-reuses-capability");
    refuses(L"changed", [&] { (void)registry.consume(first.token, artifact().binding, session()); });
  });
  test([] {
    ProgramLaunchRegistry registry(1000, 30000, [] { return 100ULL; }, random);
    const auto first = registry.prepare(artifact(), session()); registry.clear();
    const auto second = registry.prepare(artifact(), session());
    check(first.token != second.token, "program.clear-preserves-monotonic-token-lineage");
    refuses(L"changed", [&] { (void)registry.consume(first.token, artifact().binding, session()); });
    registry.close(); refuses(L"changed", [&] { (void)registry.consume(second.token, artifact().binding, session()); });
    refuses(L"changed", [&] { (void)registry.prepare(artifact(), session()); });
  });
  test([] {
    ProgramLaunchRegistry registry(1000, 30000, [] { return std::numeric_limits<uint64_t>::max(); }, random);
    refuses(L"changed", [&] { (void)registry.prepare(artifact(), session()); });
  });
  test([] {
    for (const auto path : {L"relative.exe", L"C:relative.exe", L"C:\\Vector\\..\\x.exe", L"C:\\Vector\\.\\x.exe", L"C:\\Vector\\x.exe.", L"C:/Vector/x.exe", L"\\\\?\\C:\\x.exe", L"C:\\x.exe:stream"}) {
      auto value = artifact(); value.path = path; check(!valid_program_artifact(value), "program.noncanonical-path-refused");
    }
    auto value = artifact(); value.name = L" leading"; check(!valid_program_artifact(value), "program.name-leading-space");
    value.name = L"double  space"; check(!valid_program_artifact(value), "program.name-double-space");
    value.name = L"non\u00a0breaking"; check(!valid_program_artifact(value), "program.name-shared-clean-parity");
    value.name = L"bidi\u202e"; check(!valid_program_artifact(value), "program.name-bidi-refused");
  });
  test([] {
    for (int field = 0; field < 6; ++field) {
      auto value = document();
      if (field == 0) value.handler.reset();
      if (field == 1) value.handler->verified = false;
      if (field == 2) value.handler->pid = 42;
      if (field == 3) value.handler_arguments = {L"%*"};
      if (field == 4) value.handler_arguments = {L"--prefix=%1"};
      if (field == 5) value.handler_arguments = {L"%1", L"%L"};
      check(!valid_program_artifact(value), "program.handler-authority-coherence");
    }
    auto value = artifact(); value.handler = document().handler; check(!valid_program_artifact(value), "program.direct-route-has-no-handler");
  });
  test([] {
    ProgramLaunchRegistry registry(1000, 30000, [] { return 100ULL; }, random);
    const auto value = artifact(); const auto authority = session(); const auto prepared = registry.prepare(value, authority);
    std::atomic<int> successes{0}; std::vector<std::thread> consumers;
    for (int index = 0; index < 8; ++index) consumers.emplace_back([&] { try { (void)registry.consume(prepared.token, value.binding, authority); ++successes; } catch (...) {} });
    for (auto& consumer : consumers) consumer.join();
    check(successes.load() == 1, "program.concurrent-consumers-have-one-winner");
  });
  return groups;
}
}
