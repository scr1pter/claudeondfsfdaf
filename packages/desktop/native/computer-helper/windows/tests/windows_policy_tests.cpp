#include "windows_policy.h"
#include "blocklist.h"
#include <algorithm>
#include <array>
#include <stdexcept>

namespace vector::computer {
namespace {
void require(bool value, const char* name) { if (!value) throw std::runtime_error(name); }
WindowsWindow fixture() {
  WindowsWindow window;
  window.hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(100)); window.surface = window.hwnd;
  window.thread_id = 10; window.surface_thread_id = 10;
  auto& owner = window.owner;
  owner.identity.kind = WindowsAppKind::exe; owner.identity.publisher = L"Fixture Publisher";
  owner.identity.binary = L"fixture.exe"; owner.identity.name = L"Fixture";
  owner.identity.exe = L"C:\\Fixture\\fixture.exe"; owner.identity.verified = true; owner.identity.pid = 123;
  owner.process.pid = 123; owner.process.creation_time = 100;
  owner.process.image.path = owner.identity.exe; owner.process.image.signature = SignatureState::valid;
  owner.process.image.size = 1024; owner.process.image.volume = 1; owner.process.image.id[0] = 1; owner.process.image.sha256[0] = 1;
  window.physical_owner = owner; window.bounds = {0, 0, 800, 600}; window.surface_bounds = window.bounds;
  window.window_class = L"FixtureWindow"; window.visible = true; window.on_screen = true;
  window.cloaked = false; window.current_desktop = true; window.elevated = false; window.child_shell = false;
  return window;
}
ServerSession session_for(const WindowsWindow& window) {
  ServerSession session;
  session.id = L"synthetic"; session.run_epoch = 1; session.observation_epoch = 2;
  session.approved.Append(window.owner.identity.wire());
  return session;
}
void refusal(const WindowsWindow& window, const ServerSession& session, std::wstring_view code,
             WindowsPolicyOperation operation = WindowsPolicyOperation::pointer, std::optional<bool> secure = false,
             std::span<const std::wstring> keys = {}) {
  try { WindowsSessionPolicy(session, 9999).require(window, operation, secure, keys); }
  catch (const Failure& error) { require(error.code == code, "policy.wrong-refusal"); return; }
  throw std::runtime_error("policy.missing-refusal");
}
std::string generated_json() {
  std::string value;
  for (const auto part : blocklist::kJsonParts) value += part;
  return value;
}
}

size_t run_windows_policy_tests() {
  size_t groups = 0;
  const auto test = [&](const std::function<void()>& body) { body(); ++groups; };
  test([] {
    const auto rules = WindowsBlocklist::generated();
    require(!rules.entries().empty(), "policy.generated-entries");
    for (const auto& row : rules.entries()) {
      if (row.list != L"never") continue;
      for (const auto& binary : row.binaries) {
        auto app = fixture().owner.identity;
        app.binary = binary.back() == L'*' ? binary.substr(0, binary.size() - 1) + L"Fixture" : binary;
        require(rules.refusal(app).has_value(), "policy.every-generated-never-binary");
      }
      for (const auto& aumid : row.aumids) {
        auto app = fixture().owner.identity; app.kind = WindowsAppKind::aumid;
        app.aumid = aumid.back() == L'*' ? aumid.substr(0, aumid.size() - 1) + L"Fixture" : aumid;
        require(rules.refusal(app).has_value(), "policy.every-generated-never-aumid");
      }
      for (const auto& window_class : row.window_classes) {
        require(rules.refusal(fixture().owner.identity, {window_class, false}).has_value(), "policy.every-generated-never-class");
      }
    }
  });
  test([] {
    const auto rules = WindowsBlocklist::generated(); auto app = fixture().owner.identity;
    require(!rules.refusal(app), "policy.ordinary-app");
    require(rules.category(app, {L"ConsoleWindowClass", false}) == L"terminal", "policy.console-class");
    require(rules.category(app, {L"CASCADIA_HOSTING_WINDOW_CLASS", false}) == L"terminal", "policy.terminal-class");
    app.binary = L"powershell.exe"; app.exe = L"C:\\Ordinary\\renamed.exe";
    require(rules.refusal(app) == L"terminal", "policy.renamed-signed-terminal");
  });
  test([] {
    const auto rules = WindowsBlocklist::generated(); auto app = fixture().owner.identity;
    app.system = true;
    require(rules.refusal(app) == L"security", "policy.unknown-system-default-deny");
    app.binary = L"notepad.exe";
    require(!rules.refusal(app), "policy.benign-system");
    app.binary = L"SystemSettings.exe";
    require(rules.refusal(app) == L"security", "policy.security-system");
    app.verified = false;
    require(windows_identity_refusal(app) == L"security", "policy.unverified-system-not-benign");
  });
  test([] {
    const auto rules = WindowsBlocklist::generated(); auto app = fixture().owner.identity;
    require(rules.category(app, {L"", true}) == L"terminal", "policy.actual-child-shell");
    app.binary = L"Code.exe";
    require(rules.category(app, {L"", true}) == L"developer" && rules.click_only(app), "policy.developer-child-shell-exemption");
  });
  test([] {
    const auto window = fixture(); const auto session = session_for(window);
    WindowsSessionPolicy policy(session, 9999);
    policy.require(window, WindowsPolicyOperation::pointer);
    require(policy.disclose(window) && policy.include_in_display(window), "policy.approved-content");
  });
  test([] {
    auto window = fixture(); auto session = session_for(window); session.approved.Clear();
    refusal(window, session, L"not_granted");
    require(!WindowsSessionPolicy(session, 9999).disclose(window), "policy.unapproved-title-blank");
    session = session_for(window); session.vector_pids.Append(JsonValue::CreateNumberValue(window.owner.process.pid));
    refusal(window, session, L"protected");
    require(!WindowsSessionPolicy(session, 9999).disclose(window), "policy.vector-title-blank");
  });
  test([] {
    auto window = fixture(); const auto session = session_for(window);
    for (const auto binary : {L"cmd.exe", L"KeePassXC.exe", L"SecHealthUI.exe", L"SystemSettings.exe", L"mstsc.exe", L"AnyDesk.exe", L"vmconnect.exe"}) {
      window.owner.identity.binary = binary; window.physical_owner = window.owner;
      refusal(window, session_for(window), L"protected");
    }
    window = fixture(); window.window_class = L"ConsoleWindowClass";
    refusal(window, session, L"protected");
  });
  test([] {
    auto window = fixture(); auto session = session_for(window);
    session.vector_window_ids.Append(JsonValue::CreateStringValue(window_id(window.hwnd)));
    refusal(window, session, L"protected");
    session = session_for(window); session.overlay_window_ids.Append(JsonValue::CreateStringValue(window_id(window.surface)));
    refusal(window, session, L"protected");
    session = session_for(window);
    bool rejected = false;
    try { WindowsSessionPolicy(session, window.owner.process.pid).require(window, WindowsPolicyOperation::pointer); }
    catch (const Failure& error) { rejected = error.code == L"protected"; }
    require(rejected, "policy.helper-own-pid");
  });
  test([] {
    auto window = fixture(); const auto session = session_for(window);
    window.child_shell = std::nullopt;
    refusal(window, session, L"unavailable");
    require(!WindowsSessionPolicy(session, 9999).disclose(window), "policy.unknown-tree-title-blank");
    window.child_shell = true;
    refusal(window, session, L"protected");
  });
  test([] {
    auto window = fixture(); window.owner.identity.binary = L"Code.exe"; window.physical_owner = window.owner;
    window.child_shell = std::nullopt; const auto session = session_for(window);
    WindowsSessionPolicy(session, 9999).require(window, WindowsPolicyOperation::pointer);
    refusal(window, session, L"blocked", WindowsPolicyOperation::type_text);
    refusal(window, session, L"blocked", WindowsPolicyOperation::set_value);
    const std::array<std::wstring, 2> paste{L"Control", L"KeyV"};
    refusal(window, session, L"blocked", WindowsPolicyOperation::key, false, paste);
    const std::array<std::wstring, 2> copy{L"Control", L"KeyC"};
    WindowsSessionPolicy(session, 9999).require(window, WindowsPolicyOperation::key, std::nullopt, copy);
  });
  test([] {
    const auto window = fixture(); const auto session = session_for(window);
    refusal(window, session, L"secure_field", WindowsPolicyOperation::type_text, std::nullopt);
    refusal(window, session, L"secure_field", WindowsPolicyOperation::type_text, true);
    WindowsSessionPolicy(session, 9999).require(window, WindowsPolicyOperation::type_text, false);
  });
  test([] {
    auto window = fixture(); auto session = session_for(window);
    session.paused = true;
    refusal(window, session, L"paused");
    WindowsSessionPolicy(session, 9999).require(window, WindowsPolicyOperation::observe);
    session.paused = false; session.mode = L"background";
    refusal(window, session, L"unsupported_action");
    session.mode = L"foreground"; window.elevated = true;
    refusal(window, session, L"elevated");
    window.elevated = false; window.cloaked = true;
    refusal(window, session, L"unavailable");
    window.cloaked = false; window.current_desktop = false;
    refusal(window, session, L"unavailable");
  });
  test([] {
    auto window = fixture(); const auto session = session_for(window);
    window.owner.process.creation_time = 0;
    refusal(window, session, L"changed");
    window = fixture(); window.owner.identity.exe = L"C:\\Elsewhere\\different.exe";
    refusal(window, session, L"changed");
    window = fixture(); window.owner.identity.pid = 999;
    refusal(window, session, L"changed");
    window = fixture(); window.owner.process.image.signature = SignatureState::invalid;
    refusal(window, session, L"changed");
  });
  test([] {
    auto window = fixture();
    window.owner.identity.kind = WindowsAppKind::aumid; window.owner.identity.aumid = L"Fixture_trusted!App";
    window.owner.identity.publisher.clear(); window.owner.identity.binary.clear();
    window.owner.identity.exe = L"C:\\Packages\\Fixture\\app.exe";
    window.owner.process.image.path = window.owner.identity.exe; window.owner.process.image.signature = SignatureState::unsigned_file;
    WindowsPackageEvidence package;
    package.aumid = window.owner.identity.aumid; package.family = L"Fixture_trusted";
    package.full_name = L"Fixture_1.0.0.0_x64__trusted"; package.path = L"C:\\Packages\\Fixture";
    package.trust = WindowsPackageTrust::store; package.development_mode = false;
    window.owner.process.package = package; window.physical_owner = window.owner;
    const auto session = session_for(window);
    WindowsSessionPolicy(session, 9999).require(window, WindowsPolicyOperation::pointer);
    window.owner.process.package->development_mode = true; window.physical_owner = window.owner;
    refusal(window, session, L"changed");
    window.owner.process.package = package; window.owner.process.package->trust = WindowsPackageTrust::developer; window.physical_owner = window.owner;
    refusal(window, session, L"changed");
    window.owner.process.package = package; window.owner.process.package->full_name = L"Different_1.0.0.0_x64__trusted"; window.physical_owner = window.owner;
    refusal(window, session, L"changed");
  });
  test([] {
    auto window = fixture(); window.owner.identity.system = true; window.owner.identity.binary = L"explorer.exe";
    window.physical_owner = window.owner; const auto session = session_for(window);
    window.window_class = L"CabinetWClass";
    WindowsSessionPolicy(session, 9999).require(window, WindowsPolicyOperation::pointer);
    window.window_class = L"#32770";
    refusal(window, session, L"protected");
    window.window_class = L"ToastChildWindowClass";
    refusal(window, session, L"protected");
  });
  test([] {
    auto window = fixture(); window.physical_owner.process.pid = 200; window.physical_owner.identity.pid = 200;
    window.physical_owner.identity.binary = L"ApplicationFrameHost.exe"; window.physical_owner.identity.system = true;
    window.physical_owner.identity.exe = L"C:\\Windows\\System32\\ApplicationFrameHost.exe";
    window.physical_owner.process.image.path = window.physical_owner.identity.exe;
    const auto session = session_for(window);
    WindowsSessionPolicy(session, 9999).require(window, WindowsPolicyOperation::pointer);
    window.physical_owner.identity.binary = L"CredentialUIBroker.exe";
    refusal(window, session, L"protected");
  });
  test([] {
    auto window = fixture(); window.owner.identity.verified = false; window.owner.identity.publisher = L"unsigned";
    window.owner.identity.binary = L"sha256:fixed-synthetic-content"; window.owner.process.image.signature = SignatureState::unsigned_file;
    window.physical_owner = window.owner; const auto session = session_for(window);
    WindowsSessionPolicy(session, 9999).require(window, WindowsPolicyOperation::pointer);
    window.owner.identity.pid = 200; window.owner.process.pid = 200; window.physical_owner = window.owner;
    refusal(window, session, L"not_granted");
    window = fixture(); window.owner.identity.verified = false; window.owner.identity.publisher = L"unsigned";
    window.owner.identity.binary = L"sha256:fixed-synthetic-content"; window.owner.process.image.signature = SignatureState::unsigned_file;
    window.owner.identity.exe = L"C:\\Elsewhere\\fixture.exe"; window.owner.process.image.path = window.owner.identity.exe; window.physical_owner = window.owner;
    refusal(window, session, L"not_granted");
  });
  test([] {
    auto window = fixture(); const auto session = session_for(window);
    window.owner.identity.name = L"New presentation name"; window.physical_owner = window.owner;
    WindowsSessionPolicy(session, 9999).require(window, WindowsPolicyOperation::pointer);
    window.owner.identity.publisher = L"Different Publisher"; window.physical_owner = window.owner;
    refusal(window, session, L"not_granted");
  });
  test([] {
    auto window = fixture(); auto session = session_for(window);
    WindowsSessionPolicy policy(session, 9999);
    session.approved.Clear(); session.vector_pids.Append(JsonValue::CreateNumberValue(123));
    policy.require(window, WindowsPolicyOperation::pointer);
    auto launch = window.owner.identity; launch.pid.reset();
    policy.require_launch(launch);
    launch.verified = false;
    bool rejected = false;
    try { policy.require_launch(launch); } catch (const Failure& error) { rejected = error.code == L"unavailable"; }
    require(rejected, "policy.static-unverified-not-app-launch");
  });
  test([] {
    auto window = fixture(); window.owner.identity.binary = L"explorer.exe"; window.owner.identity.system = true;
    window.physical_owner = window.owner; window.window_class = L"Shell_TrayWnd";
    auto session = session_for(window); session.approved.Clear();
    const WindowsSessionPolicy policy(session, 9999);
    require(policy.include_in_display(window) && !policy.disclose(window), "policy.furniture-visible-not-grant-target");
    window.owner.identity.system = false; window.physical_owner = window.owner;
    require(!policy.include_in_display(window), "policy.forged-furniture-masked");
  });
  test([] {
    for (const auto path : {L"C:\\repo\\.env", L"C:\\repo\\.env.local", L"C:\\Users\\fixture\\.ssh\\id_ed25519", L"C:\\Users\\fixture\\.aws\\credentials",
        L"C:\\repo\\AGENTS.md", L"C:\\repo\\brain\\notes.txt", L"C:\\Users\\fixture\\AppData\\Local\\Microsoft\\Credentials\\secret",
        L"C:\\Windows\\System32\\config\\SAM", L"C:\\repo\\..\\secret", L"\\\\server\\share\\app.exe", L"C:\\repo\\file:stream", L"C:\\repo\\file. ", L"relative.exe"}) {
      require(windows_protected_path(path), "policy.protected-artifact-path");
    }
    for (const auto path : {L"C:\\repo\\app.exe", L"C:\\repo\\README.md", L"C:\\repo\\env.example", L"C:\\Windows\\System32\\notepad.exe", L"C:\\Users\\fixture\\AppData\\Local\\Programs\\Fixture\\app.exe"}) require(!windows_protected_path(path), "policy.ordinary-artifact-path");
  });
  test([] {
    const auto types = [](std::initializer_list<std::wstring> keys) { return windows_keys_type_text(std::span<const std::wstring>(keys.begin(), keys.size())); };
    for (const auto& keys : {std::vector<std::wstring>{L"KeyA"}, {L"Shift", L"KeyA"}, {L"AltGraph", L"KeyQ"}, {L"Control", L"AltGraph", L"KeyQ"}, {L"Control", L"Alt", L"KeyQ"}, {L"Alt", L"Numpad1"}, {L"Control", L"KeyV"}, {L"Shift", L"Insert"}, {L"UnknownKey"}, {L"F25"}, {L"Media1"}, {L"AudioVolume"}}) require(windows_keys_type_text(keys), "policy.windows-text-combo");
    require(!types({L"Control", L"KeyC"}) && !types({L"Alt", L"KeyF"}) && !types({L"Win", L"KeyR"}) && !types({L"F24"}) && !types({L"ArrowLeft"}), "policy.windows-nontext-combo");
  });
  test([] {
    auto window = fixture();
    require(windows_surface_role(window) == WindowsSurfaceRole::application, "policy.ordinary-surface-role");
    window.window_class = L"ToastChildWindowClass";
    require(windows_surface_role(window) == WindowsSurfaceRole::notification, "policy.toast-role");
    window.window_class = L"Shell_TrayWnd"; window.owner.identity.binary = L"explorer.exe"; window.owner.identity.system = true; window.physical_owner = window.owner;
    require(windows_surface_role(window) == WindowsSurfaceRole::furniture, "policy.verified-furniture-role");
    window.owner.identity.system = false; window.physical_owner = window.owner;
    require(windows_surface_role(window) == WindowsSurfaceRole::protected_surface, "policy.forged-furniture-role");
  });
  test([] {
    const auto json = generated_json();
    for (const auto changed : {std::string("{}"), json.substr(0, json.size() / 2)}) {
      bool rejected = false;
      try { const WindowsBlocklist invalid(changed); (void)invalid; } catch (...) { rejected = true; }
      require(rejected, "policy.invalid-generated-data");
    }
    auto root = JsonObject::Parse(winrt::to_hstring(json));
    root.Insert(L"never", JsonArray{});
    bool rejected = false;
    try { const WindowsBlocklist invalid(winrt::to_string(root.Stringify())); (void)invalid; } catch (...) { rejected = true; }
    require(rejected, "policy.weakened-never-data");
  });
  return groups;
}
}
