#include "windows_enum.h"
#include <limits>
#include <stdexcept>
#include <utility>

namespace vector::computer {
namespace {
void require(bool condition, const char* reason) { if (!condition) throw std::runtime_error(reason); }
HWND handle(uintptr_t value) { return reinterpret_cast<HWND>(value); }
WindowsOwner owner(DWORD pid = 101, uint64_t created = 100) {
  WindowsOwner value;
  value.identity.kind = WindowsAppKind::exe; value.identity.name = L"Synthetic app"; value.identity.exe = L"C:\\Fixture\\app.exe";
  value.identity.verified = true; value.identity.publisher = L"Synthetic signer"; value.identity.binary = L"app.exe"; value.identity.pid = pid;
  value.process.pid = pid; value.process.creation_time = created; value.process.image.path = value.identity.exe;
  value.process.image.size = 100; value.process.image.modified = 50; value.process.image.created = 40;
  value.process.image.sha256[0] = 1; value.process.image.id[0] = 1; value.process.image.signature = SignatureState::valid;
  value.process.image.signer_subject = {1, 2, 3}; value.process.token.integrity = 0x2000; return value;
}
WindowsWindow window() {
  WindowsWindow value; value.hwnd = handle(42); value.surface = value.hwnd; value.thread_id = 1010; value.surface_thread_id = 1010;
  value.owner = owner(); value.physical_owner = value.owner; value.bounds = {-100, -20, 600, 400}; value.surface_bounds = value.bounds;
  value.window_class = L"FixtureClass"; value.visible = true; value.on_screen = true; value.minimized = false;
  value.cloaked = false; value.current_desktop = true; value.elevated = false; value.child_shell = false; return value;
}
struct Fixture {
  ServerSession session;
  WindowsWindow observed = window();
  bool current = true, allow = true, disclose = true, live = true, focused = false, focus_result = true;
  size_t title_reads = 0, policy_reads = 0, mutations = 0, focus_calls = 0;
  std::function<void()> before_commit, after_focus, on_title;
  std::vector<Dispatcher::Result> results;
  std::unique_ptr<WindowService> service;
  Fixture() {
    session.id = L"fixture"; session.revision = 1; session.run_epoch = 1; session.observation_epoch = 2;
    WindowsBackend backend;
    backend.list = [this](bool, const auto& valid) {
      require(valid(), "windows-enum.fixture-current");
      return std::vector<WindowsApplication>{WindowsApplication{observed.owner.identity, observed.owner, {}, focused, {observed}}};
    };
    backend.observe = [this](HWND hwnd) { if (hwnd != observed.hwnd) throw Failure{L"changed", L"The fixture window changed."}; return observed; };
    backend.current = [this](const auto&) { return live; };
    backend.title = [this](const auto&) { ++title_reads; if (on_title) on_title(); return L"Actual fixture title"; };
    backend.foreground = [this](const auto&) { return focused; };
    backend.focus = [this](const WindowsWindow& target, const OperationContext& context, const auto& guard) {
      ++focus_calls; if (before_commit) before_commit();
      if (!context.with_current([&] { guard(observed); require(same_windows_window_target(observed, target), "windows-enum.fixture-owner"); ++mutations; focused = focus_result; })) throw Failure{L"changed", L"The fixture phase changed."};
      if (after_focus) after_focus(); return focus_result;
    };
    backend.cursor = [] { return WindowsCursor{POINT{-50, 120}, L"actual-display"}; };
    WindowPolicy policy;
    policy.disclose = [this](const auto&, const auto& scope) { return disclose && scope.has_value(); };
    policy.require = [this](const auto&, const auto&, auto) { ++policy_reads; if (!allow) throw Failure{L"protected", L"Protected fixture."}; };
    service = std::make_unique<WindowService>(std::move(policy), std::move(backend));
  }
  OperationContext context(bool active = true) {
    return OperationContext{active ? std::optional<ServerSession>(session) : std::nullopt,
      [this] { return current; }, [this](const auto& body) { if (!current) return false; body(); return true; }};
  }
  JsonObject args() const {
    JsonObject value; value.Insert(L"sessionId", JsonValue::CreateStringValue(session.id)); value.Insert(L"phaseRevision", JsonValue::CreateNumberValue(1));
    value.Insert(L"windowId", JsonValue::CreateStringValue(window_id(observed.hwnd))); return value;
  }
  auto done() { return [this](Dispatcher::Result value) { results.push_back(std::move(value)); }; }
  std::wstring code() const { require(results.size() == 1 && std::holds_alternative<Failure>(results[0]), "windows-enum.expected-failure"); return std::get<Failure>(results[0]).code; }
  JsonObject reply() const { require(results.size() == 1 && std::holds_alternative<Reply>(results[0]), "windows-enum.expected-success"); return std::get<Reply>(results[0]).fields; }
};
}

size_t run_windows_enum_tests() {
  size_t groups = 0; const auto test = [&](const std::function<void()>& body) { body(); ++groups; };
  test([] {
    const WindowsRect bounds{-100, -20, 600, 400};
    require(bounds.valid() && bounds.contains(POINT{-100, -20}) && !bounds.contains(POINT{500, 380}), "windows-enum.rect-edges");
    require(bounds.contains(WindowsRect{-90, -10, 20, 20}) && !bounds.contains(WindowsRect{-101, -10, 20, 20}), "windows-enum.rect-containment");
    require(!WindowsRect{0, 0, 0, 1}.valid() && !WindowsRect{std::numeric_limits<int64_t>::max(), 0, 1, 1}.valid(), "windows-enum.rect-overflow");
    require(bounds.wire().GetNamedNumber(L"x") == -100, "windows-enum.rect-native-origin");
  });
  test([] {
    for (const auto number : {uintptr_t(1), uintptr_t(42), std::numeric_limits<uintptr_t>::max()}) require(parse_window_id(window_id(handle(number))) == handle(number), "windows-enum.opaque-hwnd-roundtrip");
    for (const auto value : {L"", L"0", L"00", L"042", L"-1", L"1.0", L"0x42", L"18446744073709551616", L"42x"}) require(!parse_window_id(value), "windows-enum.invalid-hwnd");
  });
  test([] {
    auto value = window(); require(eligible_windows_window(value), "windows-enum.current-window");
    value.cloaked = true; require(!eligible_windows_window(value), "windows-enum.cloaked-filter");
    value.cloaked = false; value.current_desktop = false; require(!eligible_windows_window(value), "windows-enum.other-desktop-filter");
    value.current_desktop = true; value.visible = false; require(!eligible_windows_window(value), "windows-enum.hidden-filter");
    value.minimized = true; require(eligible_windows_window(value), "windows-enum.actual-minimized-preserved");
  });
  test([] {
    auto original = window(), changed = original; changed.owner.process.creation_time += 1;
    require(!same_windows_window_target(original, changed), "windows-enum-pid-recycle");
    changed = original; changed.surface = handle(44); require(!same_windows_window_target(original, changed), "windows-enum-client-surface-replacement");
    changed = original; changed.bounds.x += 20; changed.surface_bounds.x += 20;
    require(same_windows_window_target(original, changed) && !same_windows_window(original, changed), "windows-enum-geometry-private-witness");
    changed = original; changed.child_shell = true; require(!same_windows_window(original, changed), "windows-enum-child-tree-witness");
  });
  test([] {
    auto hosted = window(); hosted.surface = handle(44); hosted.surface_thread_id = 2020;
    hosted.physical_owner = owner(202); hosted.owner.identity.kind = WindowsAppKind::aumid; hosted.owner.identity.aumid = L"actual.family!App";
    hosted.owner.identity.verified = false; hosted.host_aumid = hosted.owner.identity.aumid;
    hosted.surface_bounds = {-90, 0, 580, 360};
    require(eligible_windows_window(hosted) && hosted.owner.process.pid != hosted.physical_owner.process.pid, "windows-enum-actual-two-endpoint-host");
    auto changed = hosted; changed.physical_owner.process.creation_time += 1;
    require(!same_windows_window_target(hosted, changed), "windows-enum-host-recycle");
    changed = hosted; changed.surface_bounds = {-110, 0, 580, 360}; require(!eligible_windows_window(changed), "windows-enum-contained-client-only");
  });
  test([] {
    Fixture fixture; fixture.service->list(JsonObject{}, fixture.context(), fixture.done());
    const auto apps = fixture.reply().GetNamedArray(L"apps"); const auto node = apps.GetObjectAt(0).GetNamedArray(L"windows").GetObjectAt(0);
    require(node.GetNamedString(L"title") == L"Actual fixture title" && fixture.title_reads == 1, "windows-enum-approved-title");
    require(node.GetNamedObject(L"bounds").GetNamedNumber(L"x") == -100 && !node.GetNamedBoolean(L"elevated"), "windows-enum-native-window-facts");
  });
  test([] {
    Fixture fixture; fixture.disclose = false; fixture.service->list(JsonObject{}, fixture.context(), fixture.done());
    require(fixture.reply().GetNamedArray(L"apps").GetObjectAt(0).GetNamedArray(L"windows").GetObjectAt(0).GetNamedString(L"title").empty() && fixture.title_reads == 0, "windows-enum-protected-title-never-read");
    Fixture without; without.service->list(JsonObject{}, without.context(false), without.done()); require(without.title_reads == 0, "windows-enum-sessionless-metadata-only");
  });
  test([] {
    Fixture fixture; fixture.on_title = [&] { fixture.live = false; }; fixture.service->list(JsonObject{}, fixture.context(), fixture.done());
    require(fixture.code() == L"changed" && fixture.title_reads == 1, "windows-enum-title-owner-rechecked-before-disclosure");
  });
  test([] {
    Fixture fixture; fixture.observed.cloaked = true; fixture.service->list(JsonObject{}, fixture.context(), fixture.done());
    require(fixture.reply().GetNamedArray(L"apps").GetObjectAt(0).GetNamedArray(L"windows").Size() == 0 && fixture.title_reads == 0, "windows-enum-filter-before-content");
  });
  test([] {
    Fixture fixture; fixture.service->focus(fixture.args(), fixture.context(), fixture.done());
    require(fixture.reply().GetNamedBoolean(L"foreground") && fixture.mutations == 1 && fixture.policy_reads == 3, "windows-enum-focus-policy-at-observe-commit-confirm");
  });
  test([] {
    Fixture fixture; fixture.focus_result = false; fixture.service->focus(fixture.args(), fixture.context(), fixture.done());
    require(fixture.code() == L"not_foreground", "windows-enum-focus-never-invents-success");
    Fixture late; late.after_focus = [&] { late.focused = false; }; late.service->focus(late.args(), late.context(), late.done());
    require(late.code() == L"not_foreground", "windows-enum-actual-foreground-readback");
  });
  test([] {
    Fixture fixture; fixture.allow = false; fixture.session.mode = L"background";
    fixture.service->focus(fixture.args(), fixture.context(), fixture.done());
    require(fixture.code() == L"protected" && fixture.mutations == 0 && fixture.focus_calls == 0, "windows-enum-protected-before-background");
    Fixture background; background.session.mode = L"background"; background.service->focus(background.args(), background.context(), background.done());
    require(background.code() == L"needs_foreground" && background.mutations == 0, "windows-enum-no-background-activation");
  });
  test([] {
    Fixture fixture; fixture.before_commit = [&] { fixture.current = false; }; fixture.service->focus(fixture.args(), fixture.context(), fixture.done());
    require(fixture.code() == L"changed" && fixture.mutations == 0, "windows-enum-no-late-post-after-phase");
    Fixture protected_late; protected_late.before_commit = [&] { protected_late.allow = false; }; protected_late.service->focus(protected_late.args(), protected_late.context(), protected_late.done());
    require(protected_late.code() == L"protected" && protected_late.mutations == 0, "windows-enum-policy-repeated-at-actual-action");
  });
  test([] {
    Fixture fixture; fixture.before_commit = [&] { fixture.observed.owner.process.creation_time += 1; };
    fixture.service->focus(fixture.args(), fixture.context(), fixture.done()); require(fixture.code() == L"changed" && fixture.mutations == 0, "windows-enum-no-focus-on-recycled-process");
  });
  test([] {
    Fixture fixture; auto args = fixture.args(); args.Insert(L"phaseRevision", JsonValue::CreateNumberValue(0));
    fixture.service->focus(args, fixture.context(), fixture.done()); require(fixture.code() == L"changed" && fixture.focus_calls == 0, "windows-enum-exact-phase");
    Fixture extra; auto malformed = extra.args(); malformed.Insert(L"hwnd", JsonValue::CreateStringValue(L"42"));
    extra.service->focus(malformed, extra.context(), extra.done()); require(extra.code() == L"failed" && extra.focus_calls == 0, "windows-enum-exact-wire-vocabulary");
  });
  test([] {
    Fixture fixture; JsonObject args; args.Insert(L"identity", fixture.observed.owner.identity.wire());
    args.Insert(L"sessionId", JsonValue::CreateStringValue(fixture.session.id)); args.Insert(L"phaseRevision", JsonValue::CreateNumberValue(1));
    fixture.service->activate(args, fixture.context(), fixture.done()); require(fixture.reply().GetNamedBoolean(L"foreground"), "windows-enum-activate-real-listed-owner");
    Fixture forged; auto identity = forged.observed.owner.identity.wire(); identity.Insert(L"publisher", JsonValue::CreateStringValue(L"forged")); args.Insert(L"identity", identity);
    forged.service->activate(args, forged.context(), forged.done()); require(forged.code() == L"changed" && forged.mutations == 0, "windows-enum-no-display-name-or-model-identity-grant");
  });
  test([] {
    Fixture fixture; fixture.service->cursor(JsonObject{}, fixture.context(false), fixture.done());
    require(fixture.reply().GetNamedNumber(L"x") == -50 && fixture.reply().GetNamedString(L"displayId") == L"actual-display", "windows-enum-real-native-cursor-seam");
    require(fixture.service->features().GetNamedBoolean(L"apps.open") && fixture.service->features().GetNamedBoolean(L"cursor.position"), "windows-enum-installed-feature-seams");
  });
  return groups;
}
}
