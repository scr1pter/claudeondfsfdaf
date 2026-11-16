#include "windows_program.h"
#include <stdexcept>

namespace vector::computer {
namespace {
void check(bool condition, const char* label) { if (!condition) throw std::runtime_error(label); }
NativeProgramArtifact executable() {
  NativeProgramArtifact value; value.path = L"C:\\Build\\fixture.exe"; value.name = L"Fixture"; value.binding = std::wstring(64, L'a'); return value;
}
struct Fixture {
  bool current = true, deny_commit = false, permitted = true, protected_handler = false, actually_foreground = true;
  bool closed_before_post = false;
  bool protected_request = false;
  int posts = 0, resolutions = 0, retired = 0, window_checks = 0, closed = 0, identity_observations = 0;
  NativeProgramArtifact artifact = executable();
  WindowsLaunchKind kind = WindowsLaunchKind::program;
  WindowsStaticIdentity application;
  WindowsWindow window;
  std::vector<WindowsApplication> catalog;
  std::vector<WindowsApplication> running_catalog;
  std::function<void()> before_post;
  std::function<void()> after_focus;
  ServerSession authority;
  std::vector<Dispatcher::Result> replies;
  Fixture() {
    authority.id = L"program-service"; authority.run_epoch = 10; authority.observation_epoch = 11; authority.revision = 1;
    application.identity.kind = WindowsAppKind::exe; application.identity.publisher = L"Verified Publisher";
    application.identity.binary = L"fixture.exe"; application.identity.name = L"Fixture"; application.identity.verified = true;
    application.identity.exe = artifact.path; application.image.path = artifact.path;
    window.hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(101)); window.owner.identity = application.identity;
    window.owner.identity.pid = 42;
    window.surface = window.hwnd; window.thread_id = 10; window.surface_thread_id = 10;
    window.owner.process.pid = 42; window.owner.process.creation_time = 100; window.owner.process.image = application.image;
    window.physical_owner = window.owner; window.bounds = {0, 0, 200, 100}; window.surface_bounds = window.bounds;
    window.visible = true; window.on_screen = true; window.current_desktop = true; window.cloaked = false; window.elevated = false;
  }
  OperationContext context() {
    return {authority, [this] { return current; }, [this](const auto& body) {
      if (!current || deny_commit) return false; body(); return true;
    }};
  }
  WindowsProgramPolicy policy() {
    return {
      [this](const auto&) { return protected_request; },
      [this](const WindowsAppIdentity&) -> std::optional<std::wstring> { return protected_handler ? std::optional<std::wstring>{L"security"} : std::nullopt; },
      [this](const auto&, const auto&) { if (!permitted) throw Failure{L"not_granted", L"Synthetic app approval refused."}; },
      [this](const WindowsWindow& actual, const auto&) { ++window_checks; check(actual.hwnd == window.hwnd, "program.live-window-policy"); if (!permitted) throw Failure{L"not_granted", L"Synthetic window approval refused."}; },
    };
  }
  WindowsProgramBackend backend() {
    WindowsProgramBackend value;
    value.resolve = [this](const auto&, const auto& fresh) {
      ++resolutions; if (!fresh()) throw Failure{L"changed", L"Synthetic authority changed."};
      if (kind == WindowsLaunchKind::protected_route) return WindowsLaunchResolution{kind, {}, {}, L"security"};
      return WindowsLaunchResolution{kind, kind == WindowsLaunchKind::app ? std::optional{application} : std::nullopt, artifact, L""};
    };
    value.observe_identity = [this](const auto&) { ++identity_observations; return application; };
    value.launch = [this](const auto&, const OperationContext& context) {
      if (before_post) before_post();
      bool posted = false;
      const auto accepted = context.with_current([&] { ++posts; posted = true; });
      return accepted && posted;
    };
    value.launch_app = [this](const auto&, const OperationContext& context, const auto& policy) {
      if (before_post) before_post();
      bool posted = false;
      const auto accepted = context.with_current([&] { policy(); ++posts; posted = true; });
      return accepted && posted;
    };
    value.retire = [this](const auto&) { ++retired; };
    value.close = [this] { ++closed; };
    return value;
  }
  WindowsBackend windows() {
    WindowsBackend value;
    value.list = [this](bool installed, const auto& current_authority) {
      if (!current_authority()) throw Failure{L"changed", L"Synthetic authority changed."}; return !installed && !running_catalog.empty() ? running_catalog : catalog;
    };
    value.focus = [this](const auto& actual, const OperationContext& context, const auto& commit) {
      const auto result = context.with_current([&] { commit(actual); });
      if (after_focus) after_focus(); return result;
    };
    value.observe = [this](HWND hwnd) { check(hwnd == window.hwnd, "program.actual-focused-hwnd"); return window; };
    value.foreground = [this](const auto&) { return actually_foreground; };
    value.current = [this](const auto&) { return current; };
    return value;
  }
  Dispatcher::Completion completion() { replies.clear(); return [this](auto value) { replies.push_back(std::move(value)); }; }
  JsonObject reply() {
    check(replies.size() == 1 && std::holds_alternative<Reply>(replies.front()), "program.expected-single-success");
    return std::get<Reply>(replies.front()).fields;
  }
  void failure(const wchar_t* code) {
    check(replies.size() == 1 && std::holds_alternative<Failure>(replies.front()) && std::get<Failure>(replies.front()).code == code, "program.expected-single-refusal");
  }
  JsonObject prepare(WindowsProgramService& service) {
    JsonObject args; args.Insert(L"path", JsonValue::CreateStringValue(artifact.path));
    service.resolve(args, context(), completion()); return reply().GetNamedObject(L"program");
  }
  JsonObject launch_args(const JsonObject& prepared) {
    JsonObject args; args.Insert(L"token", prepared.Lookup(L"token")); args.Insert(L"binding", prepared.Lookup(L"binding"));
    args.Insert(L"sessionId", JsonValue::CreateStringValue(authority.id)); args.Insert(L"phaseRevision", JsonValue::CreateNumberValue(static_cast<double>(*authority.revision))); return args;
  }
};
}

size_t run_windows_program_tests() {
  size_t groups = 0; auto test = [&](const auto& body) { body(); ++groups; };
  test([] {
    const std::wstring exe = L"C:\\Viewer\\viewer.exe";
    const auto plan = program_association_plan(exe, {exe, L"--open", L"%1"});
    check(plan && plan->arguments == std::vector<std::wstring>{L"--open", L"%1"}, "program.actual-association-template");
    for (const auto& command : std::vector<std::vector<std::wstring>>{
        {L"C:\\Other\\viewer.exe", L"%1"}, {exe, L"%*"}, {exe, L"--url=%1"}, {exe, L"%1", L"%L"}, {exe, L"%UNTRUSTED%", L"%1"}, {exe}})
      check(!program_association_plan(exe, command), "program.association-no-substitute-or-ambient-expansion");
  });
  test([] {
    check(program_command_line(L"C:\\Program Files\\Viewer.exe", {L"plain", L"with space", L"quote\"end", L"C:\\tail\\"}) ==
      L"\"C:\\Program Files\\Viewer.exe\" \"plain\" \"with space\" \"quote\\\"end\" \"C:\\tail\\\\\"", "program.windows-argv-quoting");
    check(program_extension_allowed(L"C:\\Build\\file.PDF") && program_extension_allowed(L"C:\\Build\\script.ps1"), "program.finite-document-route-candidates");
    for (const auto path : {L"C:\\Build\\alias.lnk", L"C:\\Build\\site.url", L"C:\\Build\\installer.msi", L"C:\\Build\\panel.cpl", L"C:\\Build\\unknown"})
      check(!program_extension_allowed(path), "program.shell-links-and-installers-have-no-fallback");
  });
  test([] {
    Fixture fake; WindowsProgramService service(fake.policy(), fake.backend(), fake.windows());
    const auto prepared = fake.prepare(service);
    check(prepared.GetNamedString(L"platform") == L"windows" && prepared.HasKey(L"token") && fake.posts == 0, "program.prepare-is-not-execution");
    const auto args = fake.launch_args(prepared);
    service.launch_program(args, fake.context(), fake.completion());
    check(fake.reply().GetNamedBoolean(L"launched") && fake.posts == 1 && fake.retired == 1, "program.one-use-actual-launch");
    service.launch_program(args, fake.context(), fake.completion()); fake.failure(L"changed");
    check(fake.posts == 1, "program.replay-does-not-post");
  });
  test([] {
    for (int fact = 0; fact < 3; ++fact) {
      Fixture fake; WindowsProgramService service(fake.policy(), fake.backend(), fake.windows());
      const auto args = fake.launch_args(fake.prepare(service)); const auto original = fake.artifact;
      if (fact == 0) fake.artifact.binding[0] = L'b';
      if (fact == 1) fake.artifact.name += L" changed";
      if (fact == 2) fake.kind = WindowsLaunchKind::app;
      service.launch_program(args, fake.context(), fake.completion()); fake.failure(L"changed");
      fake.artifact = original; fake.kind = WindowsLaunchKind::program;
      service.launch_program(args, fake.context(), fake.completion()); fake.failure(L"changed");
      check(fake.posts == 0 && fake.retired == 1, "program.changed-facts-burn-and-retire");
    }
  });
  test([] {
    Fixture fake; WindowsProgramService service(fake.policy(), fake.backend(), fake.windows());
    auto args = fake.launch_args(fake.prepare(service)); args.Insert(L"binding", JsonValue::CreateStringValue(std::wstring(64, L'b')));
    service.launch_program(args, fake.context(), fake.completion()); fake.failure(L"changed");
    args.Insert(L"binding", JsonValue::CreateStringValue(fake.artifact.binding));
    service.launch_program(args, fake.context(), fake.completion()); fake.failure(L"changed"); check(fake.posts == 0, "program.binding-mismatch-burns-token");
  });
  test([] {
    Fixture fake; WindowsProgramService service(fake.policy(), fake.backend(), fake.windows());
    const auto args = fake.launch_args(fake.prepare(service)); ++fake.authority.observation_epoch;
    service.launch_program(args, fake.context(), fake.completion()); fake.failure(L"changed"); check(fake.posts == 0, "program.native-observation-epoch");
  });
  test([] {
    Fixture fake; WindowsProgramService service(fake.policy(), fake.backend(), fake.windows());
    const auto args = fake.launch_args(fake.prepare(service)); fake.kind = WindowsLaunchKind::protected_route; fake.authority.mode = L"background";
    service.launch_program(args, fake.context(), fake.completion()); fake.failure(L"protected"); check(fake.posts == 0, "program.never-floor-before-foreground");
  });
  test([] {
    Fixture fake; WindowsProgramService service(fake.policy(), fake.backend(), fake.windows());
    const auto args = fake.launch_args(fake.prepare(service)); fake.authority.mode = L"background";
    service.launch_program(args, fake.context(), fake.completion()); fake.failure(L"needs_foreground");
    fake.authority.mode = L"foreground"; service.launch_program(args, fake.context(), fake.completion()); fake.failure(L"changed");
    check(fake.posts == 0, "program.background-never-creates-process");
  });
  test([] {
    for (bool close : {false, true}) {
      Fixture fake; WindowsProgramService service(fake.policy(), fake.backend(), fake.windows());
      const auto args = fake.launch_args(fake.prepare(service));
      fake.before_post = [&] { if (close) service.close(); else fake.current = false; };
      service.launch_program(args, fake.context(), fake.completion()); fake.failure(L"changed");
      check(fake.posts == 0, "program.late-close-and-cancel-cannot-reopen-posting");
    }
  });
  test([] {
    Fixture fake; WindowsProgramService service(fake.policy(), fake.backend(), fake.windows());
    const auto args = fake.launch_args(fake.prepare(service)); fake.deny_commit = true;
    service.launch_program(args, fake.context(), fake.completion()); fake.failure(L"changed"); check(fake.posts == 0, "program.current-test-is-not-authority-fence");
  });
  test([] {
    Fixture fake; WindowsProgramService service(fake.policy(), fake.backend(), fake.windows());
    const auto prepared = fake.prepare(service); service.invalidate_observations();
    service.launch_program(fake.launch_args(prepared), fake.context(), fake.completion()); fake.failure(L"changed");
    check(fake.posts == 0, "program.explicit-phase-invalidation");
  });
  test([] {
    Fixture fake; fake.kind = WindowsLaunchKind::app; fake.application.identity.kind = WindowsAppKind::aumid;
    fake.application.identity.aumid = L"Verified.Package_family!App"; fake.application.identity.binary.clear();
    WindowsApplication app; app.identity = fake.application.identity; app.installed = fake.application;
    fake.window.owner.identity = app.identity; fake.window.owner.identity.pid = 42;
    WindowsApplication running = app; running.identity.pid = 42; running.owner = WindowsOwner{}; running.owner->process.image = fake.application.image; running.windows = {fake.window};
    fake.catalog = {app}; fake.running_catalog = {running};
    WindowsProgramService service(fake.policy(), fake.backend(), fake.windows());
    JsonObject args; args.Insert(L"sessionId", JsonValue::CreateStringValue(fake.authority.id));
    args.Insert(L"phaseRevision", JsonValue::CreateNumberValue(1)); args.Insert(L"identity", app.identity.wire());
    service.launch(args, fake.context(), fake.completion());
    check(fake.reply().GetNamedBoolean(L"foreground") && fake.posts == 1 && fake.window_checks >= 2, "program.actual-packaged-identity-and-window-policy");
  });
  test([] {
    Fixture fake; WindowsApplication app; app.identity = fake.window.owner.identity; app.owner = WindowsOwner{}; app.windows = {fake.window};
    fake.catalog = {app}; fake.actually_foreground = false;
    WindowsProgramService service(fake.policy(), fake.backend(), fake.windows());
    JsonObject args; args.Insert(L"identity", app.identity.wire()); args.Insert(L"sessionId", JsonValue::CreateStringValue(fake.authority.id)); args.Insert(L"phaseRevision", JsonValue::CreateNumberValue(1));
    service.launch(args, fake.context(), fake.completion()); fake.failure(L"not_foreground");
    check(fake.window_checks >= 2, "program.focus-bool-is-not-foreground-proof");
  });
  test([] {
    for (bool after_launch : {false, true}) {
      Fixture fake; fake.kind = WindowsLaunchKind::app;
      WindowsApplication app; app.identity = fake.window.owner.identity; app.owner = fake.window.owner; app.windows = {fake.window};
      JsonObject requested;
      if (after_launch) {
        WindowsApplication installed; installed.identity = fake.application.identity; installed.installed = fake.application;
        fake.catalog = {installed}; fake.running_catalog = {app}; requested = installed.identity.wire();
      } else { fake.catalog = {app}; requested = app.identity.wire(); }
      fake.after_focus = [&] { ++fake.window.owner.process.creation_time; fake.window.owner.identity.pid = 99; fake.window.owner.process.pid = 99; };
      WindowsProgramService service(fake.policy(), fake.backend(), fake.windows());
      JsonObject args; args.Insert(L"identity", requested); args.Insert(L"sessionId", JsonValue::CreateStringValue(fake.authority.id)); args.Insert(L"phaseRevision", JsonValue::CreateNumberValue(1));
      service.launch(args, fake.context(), fake.completion()); fake.failure(L"changed");
      check(fake.actually_foreground && fake.window_checks > 0, "program.recycled-approved-hwnd-is-not-the-selected-target");
    }
  });
  test([] {
    for (bool changed_file : {false, true}) {
      Fixture fake; fake.kind = WindowsLaunchKind::app;
      WindowsApplication running; running.identity = fake.application.identity; running.identity.pid = 42;
      running.owner = WindowsOwner{}; running.owner->process.image = fake.application.image;
      if (changed_file) running.owner->process.image.id[0] = 1;
      running.windows = {fake.window}; fake.catalog = {running};
      WindowsProgramService service(fake.policy(), fake.backend(), fake.windows());
      JsonObject args; args.Insert(L"identity", fake.application.identity.wire());
      args.Insert(L"sessionId", JsonValue::CreateStringValue(fake.authority.id)); args.Insert(L"phaseRevision", JsonValue::CreateNumberValue(1));
      service.launch(args, fake.context(), fake.completion());
      if (changed_file) fake.failure(L"changed");
      else check(fake.reply().GetNamedBoolean(L"foreground"), "program.static-no-pid-finds-same-held-running-file");
      check(fake.posts == 0, "program.running-instance-does-not-create-substitute");
    }
  });
  test([] {
    Fixture fake; WindowsProgramService service(fake.policy(), fake.backend(), fake.windows());
    JsonObject args; args.Insert(L"path", JsonValue::CreateStringValue(fake.artifact.path)); args.Insert(L"sessionId", JsonValue::CreateStringValue(fake.authority.id)); args.Insert(L"phaseRevision", JsonValue::CreateNumberValue(1));
    service.launch(args, fake.context(), fake.completion()); fake.failure(L"not_granted"); check(fake.posts == 0, "program.unsigned-path-does-not-bypass-prepare");
    auto identity = fake.application.identity; identity.verified = false; identity.pid.reset(); args.Remove(L"path"); args.Insert(L"identity", identity.wire());
    service.launch(args, fake.context(), fake.completion()); fake.failure(L"not_granted");
  });
  test([] {
    Fixture fake; fake.protected_request = true;
    WindowsProgramService service(fake.policy(), fake.backend(), fake.windows());
    JsonObject args; args.Insert(L"identity", fake.application.identity.wire()); args.Insert(L"sessionId", JsonValue::CreateStringValue(fake.authority.id)); args.Insert(L"phaseRevision", JsonValue::CreateNumberValue(1));
    service.launch(args, fake.context(), fake.completion()); fake.failure(L"protected");
    check(fake.identity_observations == 0 && fake.resolutions == 0 && fake.posts == 0, "program.protected-request-path-before-native-file-or-registration-work");
  });
  return groups;
}
}
