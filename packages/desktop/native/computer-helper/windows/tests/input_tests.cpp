#include "input.h"
#include "input_guardian.h"
#include "availability.h"
#include <algorithm>
#include <map>
#include <stdexcept>

namespace vector::computer {
namespace {
void check(bool value, const char* label) { if (!value) throw std::runtime_error(label); }
constexpr uint64_t own_tag = 0x123456789abcdef0ULL;
WindowsWindow window_fixture() {
  WindowsWindow value; value.hwnd = reinterpret_cast<HWND>(uintptr_t(100)); value.surface = value.hwnd;
  value.thread_id = value.surface_thread_id = 11;
  value.owner.identity.publisher = L"Synthetic Publisher"; value.owner.identity.binary = L"writer.exe";
  value.owner.identity.name = L"Writer"; value.owner.identity.exe = L"C:\\Fixture\\writer.exe";
  value.owner.identity.verified = true; value.owner.identity.pid = 123;
  value.owner.process.pid = 123; value.owner.process.creation_time = 50;
  value.owner.process.image.path = value.owner.identity.exe; value.owner.process.image.signature = SignatureState::valid;
  value.owner.process.image.size = 100; value.owner.process.image.id[0] = 1; value.owner.process.image.sha256[0] = 1;
  value.physical_owner = value.owner; value.bounds = value.surface_bounds = {-100, -50, 200, 100};
  value.window_class = L"WriterWindow"; value.child_shell = false;
  value.visible = value.on_screen = value.current_desktop = true; value.cloaked = value.elevated = false; return value;
}
struct ManualQueue {
  struct Job { uint64_t due; std::function<void()> body; };
  uint64_t& now; uint64_t next = 0; std::map<uint64_t, Job> jobs; std::vector<std::function<void()>> history;
  InputService::Cancel add(uint32_t delay, std::function<void()> body) {
    const auto id = ++next; history.push_back(body); jobs.emplace(id, Job{now + delay, std::move(body)});
    return [this, id] { jobs.erase(id); };
  }
  void run() {
    for (size_t count = 0; count < 256; ++count) {
      auto selected = jobs.end();
      for (auto item = jobs.begin(); item != jobs.end(); ++item)
        if (item->second.due <= now && (selected == jobs.end() || item->second.due < selected->second.due)) selected = item;
      if (selected == jobs.end()) return;
      auto body = std::move(selected->second.body); jobs.erase(selected); body();
    }
    throw std::runtime_error("input.synthetic-schedule-did-not-quiesce");
  }
};
class FakeGuardian final : public InputGuardian {
 public:
  explicit FakeGuardian(bool& authority, uint64_t& clock) : inside(authority), now(clock), ledger(own_tag) {}
  bool& inside; uint64_t& now; InputGuardianLedger ledger;
  bool running = true, armed = false, ready_result = true, reserve_result = true, auto_up = true, wrong_up_tag = false, process_exited=false, drain_under_authority=false;
  unsigned ready_calls = 0, reserve_calls = 0, drain_calls = 0, close_calls = 0;
  std::vector<InputRelease> ups;
  std::function<void()> on_ready;
  std::function<void(bool down)> on_observed;
  uint64_t tag() const noexcept override { return own_tag; }
  bool alive() const noexcept override { return running && armed; }
  bool exited() const noexcept override { return process_exited; }
  bool ready() override {
    check(!inside, "input.guardian-startup-is-outside-authority"); ++ready_calls;
    if (on_ready) on_ready(); armed = running && ready_result; return armed;
  }
  std::optional<InputGuardianTicket> reserve(const InputRelease& release) override {
    check(!inside, "input.guardian-reservation-is-outside-authority"); ++reserve_calls;
    return running && reserve_result ? ledger.reserve(release) : std::nullopt;
  }
  bool observed(const InputGuardianTicket& ticket, bool down, uint32_t) override {
    check(!inside, "input.guardian-observation-wait-is-outside-authority");
    if (on_observed) on_observed(down);
    if (!running) return false;
    if (!down && auto_up) release(true); return ledger.observed(ticket, down);
  }
  void retire(const InputGuardianTicket& ticket, bool not_posted = false) noexcept override { ledger.retire(ticket, not_posted); }
  uint32_t drain(uint32_t = 300) noexcept override {
    drain_under_authority = drain_under_authority || inside;
    ++drain_calls; if (!running || !auto_up) return 0; return release(false);
  }
  uint32_t release(bool retired_only) noexcept {
    const auto before = ledger.released_count();
    for (const auto& ticket : ledger.releases(retired_only)) {
      ups.push_back(ticket.release);
      ledger.observe({ticket.release, wrong_up_tag ? own_tag + 1 : own_tag, true, false, now});
    }
    return static_cast<uint32_t>(ledger.released_count() - before);
  }
  void event(const InputPostedEvent& event) {
    const bool down = event.kind == InputEventKind::key_down || event.kind == InputEventKind::button_down || event.kind == InputEventKind::unicode_down;
    const bool up = event.kind == InputEventKind::key_up || event.kind == InputEventKind::button_up || event.kind == InputEventKind::unicode_up;
    if (down || up) ledger.observe({event.release, event.tag, true, down, now});
  }
  void close() noexcept override { ++close_calls; ledger.close(); if (running && auto_up) release(false); running = false; }
};
struct Element final : InputElementWitness {};
struct Fixture {
  uint64_t now = 1000; bool inside = false, live = true, admitted = true, capture_valid = true, metadata_current = true;
  bool point_current = true, foreground_current = true, keyboard_current = true, quiet = true, available = true;
  bool enabled = true, focused = true, focusable = true, value_pattern = true, text_pattern = false, ref_current = true, element_current = true;
  std::optional<bool> secure = false, read_only = false, text_read_only;
  std::optional<WindowsAvailabilityObservation> availability;
  uint64_t observation_age = 0;
  WindowsWindow world = window_fixture(); ServerSession session; CaptureReceipt capture;
  std::shared_ptr<InputElementWitness> element = std::make_shared<Element>();
  std::wstring fingerprint = L"synthetic-us-layout", actual_ref = L"actual-ref", actual_element_id = L"actual-element";
  InputKeyLayout layout;
  std::optional<std::vector<InputMenuShortcut>> menus = std::vector<InputMenuShortcut>{};
  InputPostResult post_result = InputPostResult::accepted, batch_result = InputPostResult::accepted;
  bool reflect_uncertain = false, azerty = false;
  size_t observations = 0, binds = 0, menu_reads = 0, capture_checks = 0, point_checks = 0, commits = 0, parent_ups = 0, forgets = 0;
  std::function<void()> before_fence, before_observe, during_menus,during_capture_current,during_freshness,during_native_preparation;
  std::function<void(const InputPostedEvent&)> after_post;
  std::function<void(size_t)> after_batch;
  std::function<void(POINT)> on_point;
  std::vector<InputPostedEvent> events;
  std::vector<std::vector<InputPostedEvent>> batches;
  ManualQueue timers{now}, inspections{now};
  std::shared_ptr<FakeGuardian> guardian = std::make_shared<FakeGuardian>(inside, now);
  std::optional<Dispatcher::Result> result; size_t completions = 0;
  std::shared_ptr<WindowsGuard> guard;
  std::unique_ptr<InputService> service;
  Fixture() {
    session.id = L"input-test"; session.run_epoch = 1; session.observation_epoch = 2; session.revision = 1;
    approve(); capture.id = L"full-frame"; capture.display_id = L"D1"; capture.session_id = session.id;
    capture.run_epoch = session.run_epoch; capture.observation_epoch = session.observation_epoch; capture.revision = session.revision;
    capture.generation = 1; capture.bounds = world.bounds; capture.width = 200; capture.height = 100;
    capture.image_scale = capture.dpi_scale = 1; capture.window = world;
    layout.keys = {{L"KeyA", {L"a", L"A"}}, {L"KeyQ", {L"q", L"Q"}}, {L"Digit4", {L"4", L"$"}}};
    WindowsGuardBackend native;
    native.point = [this](POINT point, const auto&) {
      ++point_checks; if (on_point) on_point(point);
      return WindowsPointOwner{world, world.surface, point, {}, world.owner.process.pid, world.surface_thread_id, world.window_class};
    };
    native.foreground = [this] { return world; };
    native.current = [this](const auto& old) { return metadata_current && same_windows_window(old, world); };
    native.point_current = [this](const auto& old, const auto&) { return point_current && same_windows_window(old.window, world); };
    native.foreground_current = [this](const auto& old) { return foreground_current && same_windows_window(old, world); };
    native.keyboard_current = [this](const auto& old) { return keyboard_current && foreground_current && same_windows_window(old, world); };
    native.require_surface = [this](const WindowsWindow& window) {
      if (!availability) return;
      require_windows_surface(*availability, &window.owner.process.token);
      require_windows_surface(*availability, &window.physical_owner.process.token);
    };
    native.now = [this] { return now; }; guard = std::make_shared<WindowsGuard>(std::move(native));
    InputObservationProvider provider;
    provider.focused = [this](const auto&, const auto&) { return observe(); };
    provider.pointer = [this](const auto&, POINT, const auto&) { return observe(); };
    provider.bind = [this](const auto& observation, const InputExpectedTarget& expected, const auto&) {
      ++binds;
      if (!ref_current || (expected.pid && *expected.pid != observation.window.owner.process.pid) ||
          (expected.window && *expected.window != observation.window.hwnd) || (expected.ref && *expected.ref != actual_ref) ||
          (expected.element_id && *expected.element_id != actual_element_id)) throw Failure{L"stale_ref", L"Synthetic target changed."};
    };
    provider.same = [](const InputObservation& a, const InputObservation& b) {
      return same_windows_window(a.window, b.window) && a.element == b.element && a.secure == b.secure && a.enabled == b.enabled &&
        a.focused == b.focused && a.keyboard_focusable == b.keyboard_focusable && a.value_pattern == b.value_pattern && a.read_only == b.read_only &&
        a.text_pattern == b.text_pattern && a.text_read_only == b.text_read_only;
    };
    provider.fresh = [this](const auto& value, uint64_t age) {
      if(inside && during_freshness)during_freshness();
      return element_current && now >= value.observed_at_ms && now - value.observed_at_ms <= age;
    };
    provider.menus = [this](const auto&, const auto&) { ++menu_reads; if (during_menus) during_menus(); return menus; };
    InputBackend backend; backend.tag = own_tag; backend.guardian = guardian;
    backend.receipt = [this](std::wstring_view id, const ServerSession& authority) {
      if (id != capture.id || authority.id != capture.session_id || authority.run_epoch != capture.run_epoch ||
          authority.observation_epoch != capture.observation_epoch || authority.revision != capture.revision) throw Failure{L"stale_frame", L"Synthetic frame retired."};
      return capture;
    };
    backend.capture_current = [this](const auto& old, const ServerSession& authority) {
      ++capture_checks;
      if(inside && during_capture_current)during_capture_current();
      return capture_valid && old.generation == capture.generation && old.run_epoch == authority.run_epoch &&
        old.observation_epoch == authority.observation_epoch && old.revision == authority.revision;
    };
    backend.focused_window = [this](const auto& authority) { WindowsSessionPolicy(authority).require(world, WindowsPolicyOperation::observe); return world; };
    backend.point = [this](const auto& old, POINT point, const auto& authority) { return guard->point(old, point, authority); };
    backend.foreground = [this](const auto& old, const auto& authority) {
      WindowsSessionPolicy(authority).require(world, WindowsPolicyOperation::observe);
      if (!same_windows_window(old, world) || !foreground_current) throw Failure{L"changed", L"Synthetic foreground changed."}; return world;
    };
    backend.commit_point = [this](const auto& point, const auto& authority, const auto& context,const auto& precondition,const auto& action) {
      ++commits; guard->commit_point(point, authority, context, action,precondition);
    };
    backend.commit_foreground = [this](const auto& window, const auto& authority, const auto& context, auto operation, auto password, auto keys,uint64_t observed_at,const auto& precondition,const auto& action) {
      ++commits; guard->commit_foreground(window, authority, context,WindowsGuardStamp(authority,observed_at), operation, action, password, keys,precondition);
    };
    backend.resolve = [this](auto raw, const auto&) { return resolve(raw); };
    backend.pointer_modifiers = [this](auto raw, const auto&) {
      std::vector<InputNativeKey> result; uint32_t bits = 0;
      for (const auto& name : raw) {
        const auto modifier = input_modifier_name(name);
        if (!modifier || *modifier == InputModifier::meta || *modifier == InputModifier::alt_graph || (bits & input_modifier(*modifier)))
          throw Failure{L"unsupported_action", L"Synthetic modifier unavailable."};
        bits |= input_modifier(*modifier);
      }
      return modifiers(bits);
    };
    backend.keyboard_current = [this](auto proof, const auto&, auto) { return keyboard_current && proof == fingerprint; };
    backend.keyboard_fingerprint = [this](const auto&) { return fingerprint; };
    backend.quiet = [this] { return quiet; };
    backend.available = [this] { if (availability) require_windows_surface(*availability); return available; };
    backend.post = [this](const InputPostedEvent& event,const std::function<bool()>& current) {
      check(inside, "input.native-post-only-inside-current-authority");
      if(during_native_preparation)during_native_preparation();
      if(!current || !current())throw Failure{L"changed",L"Synthetic native input authority changed."};
      if (post_result == InputPostResult::accepted || (post_result == InputPostResult::uncertain && reflect_uncertain)) {
        events.push_back(event); guardian->event(event);
      }
      if (after_post) after_post(event); return post_result;
    };
    backend.post_batch = [this](auto posted,const std::function<bool()>& current) {
      check(inside, "input.native-batch-only-inside-current-authority");
      if(during_native_preparation)during_native_preparation();
      if(!current || !current())throw Failure{L"changed",L"Synthetic native input authority changed."};
      batches.emplace_back(posted.begin(), posted.end());
      size_t accepted = batch_result == InputPostResult::accepted ? posted.size() : (reflect_uncertain ? 1U : 0U);
      for (size_t index = 0; index < accepted; ++index) { events.push_back(posted[index]); guardian->event(posted[index]); }
      if (after_batch) after_batch(batches.size()); return batch_result;
    };
    backend.release = [this](const auto&) { ++parent_ups; return false; };
    backend.forget_release = [this](const auto&) { ++forgets; };
    service = std::make_unique<InputService>(std::move(provider), std::move(backend),
      [this](auto ms, auto body) { return timers.add(ms, std::move(body)); }, [this] { return now; },
      [this](auto ms, auto body) { return inspections.add(ms, std::move(body)); });
  }
  void available_surface() {
    TokenIdentity helper;
    helper.user = {1}; helper.logon = {2}; helper.authentication = 3; helper.session = 1;
    helper.integrity = SECURITY_MANDATORY_MEDIUM_RID;
    helper.elevated = helper.ui_access = helper.app_container = false;
    availability = WindowsAvailabilityObservation{helper, {true, true, true}, false};
    world.owner.process.token = helper; world.physical_owner = world.owner; capture.window = world;
  }
  void approve() { session.approved.Clear(); session.approved.Append(world.owner.identity.wire()); }
  InputObservation observe() {
    check(!inside, "input.uia-observation-is-outside-authority"); ++observations; if (before_observe) before_observe();
    InputObservation value; value.window = world; value.secure = secure; value.element = element; value.menus = menus;
    value.observed_at_ms = now >= observation_age ? now - observation_age : 0;
    value.enabled = enabled; value.focused = focused; value.keyboard_focusable = focusable;
    value.value_pattern = value_pattern; value.read_only = read_only;
    value.text_pattern = text_pattern; value.text_read_only = text_read_only; return value;
  }
  std::vector<InputNativeKey> modifiers(uint32_t bits) {
    std::vector<InputNativeKey> keys;
    for (const auto item : {std::pair{InputModifier::control, InputRelease{InputReleaseKind::scan_key, VK_CONTROL, 0x1d, false, 0}},
      {InputModifier::alt, {InputReleaseKind::scan_key, VK_MENU, 0x38, false, 0}},
      {InputModifier::shift, {InputReleaseKind::scan_key, VK_SHIFT, 0x2a, false, 0}},
      {InputModifier::meta, {InputReleaseKind::scan_key, VK_LWIN, 0x5b, true, 0}},
      {InputModifier::alt_graph, {InputReleaseKind::scan_key, VK_RMENU, 0x38, true, 0}}})
      if (bits & input_modifier(item.first)) keys.push_back({item.second, input_modifier(item.first)});
    return keys;
  }
  InputNativeChord resolve(std::span<const std::wstring> raw) {
    auto current = layout; current.fingerprint = fingerprint;
    const auto semantic = resolve_input_combo(raw, current);
    if (!semantic) throw Failure{L"unsupported_action", L"Synthetic key has no complete mapping."};
    InputNativeChord value; value.semantic = *semantic; value.keys = modifiers(semantic->modifiers);
    InputRelease release{InputReleaseKind::scan_key, 'A', 0x1e, false, 0};
    const std::map<std::wstring, std::pair<WORD, WORD>> codes{{L"a", {WORD{'A'}, WORD{0x1e}}}, {L"c", {WORD{'C'}, WORD{0x2e}}}, {L"i", {WORD{'I'}, WORD{0x17}}},
      {L"q", {WORD{'Q'}, WORD{0x10}}}, {L"s", {WORD{'S'}, WORD{0x1f}}}, {L"v", {WORD{'V'}, WORD{0x2f}}}, {L"x", {WORD{'X'}, WORD{0x2d}}}, {L"y", {WORD{'Y'}, WORD{0x15}}}, {L"z", {WORD{'Z'}, WORD{0x2c}}},
      {L"4", {WORD{'4'}, WORD{0x05}}}, {L"$", {WORD{'4'}, WORD{0x05}}}, {L"f5", {WORD{VK_F5}, WORD{0x3f}}}, {L"f12", {WORD{VK_F12}, WORD{0x58}}},
      {L"arrowleft", {WORD{VK_LEFT}, WORD{0x4b}}}, {L"tab", {WORD{VK_TAB}, WORD{0x0f}}}, {L"backspace", {WORD{VK_BACK}, WORD{0x0e}}}, {L"delete", {WORD{VK_DELETE}, WORD{0x53}}}};
    const auto found = codes.find(semantic->key);
    if (found != codes.end()) { release.virtual_key = found->second.first; release.scan = found->second.second; }
    release.extended = semantic->key == L"arrowleft" || semantic->key == L"delete";
    if (azerty && semantic->physical_key == L"keyq") { release.virtual_key = 'A'; release.scan = 0x10; }
    if (azerty && !semantic->physical && semantic->key == L"q") { release.virtual_key = 'Q'; release.scan = 0x1e; }
    value.keys.push_back({release, 0}); return value;
  }
  OperationContext context() {
    const auto run = session.run_epoch, epoch = session.observation_epoch;
    OperationContext value; value.session = session;
    value.is_current = [this, run, epoch] { return live && run == session.run_epoch && epoch == session.observation_epoch; };
    value.with_current = [this, current = value.is_current](const auto& action) {
      if (!current() || !admitted) return false;
      if (before_fence) before_fence(); if (!current()) return false;
      struct Fence { bool& value; ~Fence() { value = false; } } fence{inside}; inside = true; action(); return true;
    }; return value;
  }
  JsonObject args(std::wstring_view op) {
    JsonObject value;
    value.Insert(L"sessionId", JsonValue::CreateStringValue(session.id)); value.Insert(L"phaseRevision", JsonValue::CreateNumberValue(1));
    if (op == L"input.key" || op == L"input.type" || op == L"input.hold") {
      value.Insert(L"pid", JsonValue::CreateNumberValue(123)); value.Insert(L"windowId", JsonValue::CreateStringValue(L"100"));
      value.Insert(L"ref", JsonValue::CreateStringValue(actual_ref)); value.Insert(L"elementId", JsonValue::CreateStringValue(actual_element_id));
      if (op == L"input.type") value.Insert(L"text", JsonValue::CreateStringValue(L"hello"));
      else { value.Insert(L"combo", JsonArray::Parse(LR"(["Control","a"])")); value.Insert(op == L"input.key" ? L"repeat" : L"ms", JsonValue::CreateNumberValue(op == L"input.key" ? 1 : 100)); }
      return value;
    }
    value.Insert(L"captureId", JsonValue::CreateStringValue(capture.id));
    if (op == L"input.drag") value.Insert(L"path", JsonArray::Parse(LR"([{"x":10,"y":10},{"x":20,"y":10},{"x":30,"y":10}])"));
    else { value.Insert(L"x", JsonValue::CreateNumberValue(10)); value.Insert(L"y", JsonValue::CreateNumberValue(10)); }
    if (op == L"input.click" || op == L"input.drag") { value.Insert(L"button", JsonValue::CreateStringValue(L"left")); value.Insert(L"modifiers", JsonArray{}); }
    if (op == L"input.click") value.Insert(L"count", JsonValue::CreateNumberValue(1));
    if (op == L"input.scroll") { value.Insert(L"dx", JsonValue::CreateNumberValue(1)); value.Insert(L"dy", JsonValue::CreateNumberValue(-2)); }
    return value;
  }
  void send(std::wstring_view op, const JsonObject& args) {
    result.reset(); completions = 0;
    service->handle(op, args, context(), [this](auto value) { result = std::move(value); ++completions; });
  }
  void send(std::wstring_view op) { send(op, args(op)); }
  const Dispatcher::Result& take(std::wstring_view op, const JsonObject& args) {
    send(op, args); check(result.has_value() && completions == 1, "input.single-synchronous-completion"); return *result;
  }
  const Dispatcher::Result& take(std::wstring_view op) { return take(op, args(op)); }
  void advance(uint64_t ms) { now += ms; timers.run(); inspections.run(); timers.run(); }
  void pump() { timers.run(); inspections.run(); timers.run(); }
};
void success(const Dispatcher::Result& result) { check(std::holds_alternative<Reply>(result), "input.expected-success"); }
void failure(const Dispatcher::Result& result, std::wstring_view code) {
  check(std::holds_alternative<Failure>(result) && std::get<Failure>(result).code == code, "input.expected-refusal");
}
JsonArray combo(std::initializer_list<const wchar_t*> names) {
  JsonArray value; for (const auto name : names) value.Append(JsonValue::CreateStringValue(name)); return value;
}
size_t downs(const Fixture& fixture) {
  return std::count_if(fixture.events.begin(), fixture.events.end(), [](const auto& event) {
    return event.kind == InputEventKind::key_down || event.kind == InputEventKind::button_down || event.kind == InputEventKind::unicode_down;
  });
}
}

size_t run_input_tests() {
  size_t groups = 0; const auto test = [&](const auto& body) { body(); ++groups; };
  test([] {
    for (const auto op : {L"input.move", L"input.click", L"input.scroll", L"input.drag", L"input.key", L"input.type", L"input.hold"}) {
      Fixture fixture; fixture.available_surface(); fixture.availability->desktop.default_name = false;
      failure(fixture.take(op), L"secure_desktop");
      check(fixture.events.empty() && fixture.batches.empty(), "input.secure-desktop-returns-typed-handoff-before-all-native-posts");
    }
  });
  test([] {
    for (const auto op : {L"input.click", L"input.key", L"input.type"}) {
      for (int field = 0; field < 4; ++field) {
        Fixture fixture; fixture.available_surface(); auto& token = fixture.world.owner.process.token;
        if (field == 0) token.elevated = true;
        if (field == 1) token.integrity = SECURITY_MANDATORY_HIGH_RID;
        if (field == 2) token.integrity = SECURITY_MANDATORY_MEDIUM_PLUS_RID;
        if (field == 3) token.ui_access = true;
        fixture.world.physical_owner = fixture.world.owner; fixture.capture.window = fixture.world;
        failure(fixture.take(op), L"elevated");
        check(fixture.events.empty() && fixture.batches.empty(), "input.actual-target-token-handoff-overrides-an-ordinary-window-flag");
      }
    }
  });
  test([] {
    for (const auto op : {L"input.click", L"input.type"}) {
      Fixture fixture; fixture.available_surface();
      fixture.before_fence = [&] { fixture.availability->desktop.opened = false; };
      failure(fixture.take(op), L"secure_desktop");
      check(fixture.events.empty() && fixture.batches.empty(), "input.desktop-switch-at-commit-keeps-typed-refusal-with-zero-posts");
    }
  });
  test([] {
    Fixture fixture; fixture.available_surface(); fixture.send(L"input.hold");
    check(downs(fixture) == 2 && !fixture.result, "input.owned-hold-is-established-before-the-desktop-switch");
    fixture.availability->desktop.default_name = false; fixture.advance(25); fixture.pump();
    check(fixture.result.has_value(), "input.desktop-switch-finishes-held-action-after-cleanup");
    failure(*fixture.result, L"secure_desktop");
    check(downs(fixture) == 2 && fixture.guardian->ups.size() == 2 && !fixture.guardian->ledger.pending(),
      "input.desktop-switch-keeps-owned-up-cleanup-without-another-down");
  });
  test([] {
    Fixture fixture; const auto features = fixture.service->features();
    check(features.GetNamedBoolean(L"input.pointer") && features.GetNamedBoolean(L"input.keyboard") &&
          features.GetNamedBoolean(L"input.unicode") && !features.GetNamedBoolean(L"background"), "input.truthful-injected-feature-set");
  });
  test([] {
    for (const auto op : {L"input.move", L"input.click", L"input.scroll", L"input.drag", L"input.key", L"input.type"}) {
      Fixture fixture; success(fixture.take(op));
      check(!fixture.events.empty() && fixture.guardian->ready_calls == 1 && fixture.parent_ups == 0 &&
            !fixture.guardian->ledger.pending(), "input.all-atomic-operations-use-current-tagged-posts-and-guardian-only-ups");
      for (const auto& event : fixture.events) check(event.tag == own_tag, "input.private-source-tag-on-every-post");
    }
  });
  test([] {
    Fixture fixture; success(fixture.take(L"input.move"));
    check(fixture.events.size() == 1 && fixture.events[0].kind == InputEventKind::move && fixture.events[0].point.x == -90 &&
          fixture.events[0].point.y == -40 && fixture.guardian->reserve_calls == 0, "input.capture-pixel-centers-use-native-negative-origin");
  });
  test([] {
    Fixture fixture; auto value = fixture.args(L"input.click"); value.Insert(L"count", JsonValue::CreateNumberValue(3));
    value.Insert(L"modifiers", combo({L"Shift"})); success(fixture.take(L"input.click", value));
    check(downs(fixture) == 4 && fixture.guardian->ups.size() == 4 && fixture.guardian->ups.back().virtual_key == VK_SHIFT &&
          fixture.guardian->ups.front().kind == InputReleaseKind::mouse_button, "input.multiclick-retains-explicit-modifier-until-all-buttons-release");
    for (const auto& event : fixture.events) if (event.kind == InputEventKind::button_down)
      check(event.point.x == -90 && event.point.y == -40, "input.button-down-carries-the-same-revalidated-native-point");
  });
  test([] {
    Fixture fixture; success(fixture.take(L"input.scroll"));
    check(fixture.events.size() == 3 && fixture.events[0].kind == InputEventKind::move && fixture.events[1].dx == 1 &&
          fixture.events[1].dy == 0 && fixture.events[2].dx == 0 && fixture.events[2].dy == -2 && fixture.guardian->reserve_calls == 0,
          "input.wheel-axes-post-separately-at-current-point");
  });
  test([] {
    Fixture fixture; auto value = fixture.args(L"input.scroll"); value.Insert(L"unit", JsonValue::CreateStringValue(L"pixel"));
    failure(fixture.take(L"input.scroll", value), L"unsupported_action");
    check(fixture.events.empty() && fixture.guardian->ready_calls == 0 && fixture.observations == 0, "input.pixel-scroll-refuses-before-native-preparation");
  });
  test([] {
    for (int field = 0; field < 10; ++field) {
      Fixture fixture; auto value = fixture.args(L"input.click");
      if (field == 0) value.Insert(L"count", JsonValue::CreateNumberValue(0));
      if (field == 1) value.Insert(L"count", JsonValue::CreateNumberValue(4));
      if (field == 2) value.Insert(L"x", JsonValue::CreateNumberValue(1.5));
      if (field == 3) value.Insert(L"button", JsonValue::CreateStringValue(L"back"));
      if (field == 4) value.Insert(L"extra", JsonValue::CreateBooleanValue(true));
      if (field == 5) value.Insert(L"modifiers", JsonValue::CreateStringValue(L"Shift"));
      if (field == 6) value.Insert(L"modifiers", combo({L"Shift", L"Shift", L"Shift", L"Shift", L"Shift", L"Shift", L"Shift", L"Shift", L"Shift"}));
      if (field == 7) value.Insert(L"pid", JsonValue::CreateNumberValue(0));
      if (field == 8) value.Insert(L"windowId", JsonValue::CreateStringValue(L"0100"));
      if (field == 9) value.Insert(L"ref", JsonValue::CreateStringValue(L""));
      failure(fixture.take(L"input.click", value), L"failed"); check(fixture.events.empty(), "input.malformed-pointer-never-posts");
    }
  });
  test([] {
    for (int field = 0; field < 7; ++field) {
      Fixture fixture; auto value = fixture.args(L"input.key");
      if (field == 0) value.Remove(L"pid");
      if (field == 1) value.Insert(L"repeat", JsonValue::CreateNumberValue(0));
      if (field == 2) value.Insert(L"repeat", JsonValue::CreateNumberValue(21));
      if (field == 3) value.Insert(L"combo", JsonArray{});
      if (field == 4) value.Insert(L"combo", combo({L"Control", L"a", L"b"}));
      if (field == 5) value.Insert(L"sessionId", JsonValue::CreateStringValue(L"other"));
      if (field == 6) value.Remove(L"phaseRevision");
      const auto& result = fixture.take(L"input.key", value);
      if (field >= 5) failure(result, L"changed");
      else if (field == 4) failure(result, L"unsupported_action");
      else failure(result, L"failed");
      check(fixture.events.empty(), "input.invalid-key-authority-or-bounds-never-posts");
    }
  });
  test([] {
    for (const auto op : {L"input.type", L"input.key", L"input.click"}) {
      Fixture fixture; fixture.session.paused = true; failure(fixture.take(op), L"stopped");
      check(fixture.events.empty() && fixture.guardian->ready_calls == 0, "input.paused-refuses-before-guardian-or-owner-observation");
    }
  });
  test([] {
    Fixture fixture; fixture.session.approved.Clear(); failure(fixture.take(L"input.key"), L"not_granted");
    check(fixture.observations == 0 && fixture.events.empty(), "input.unapproved-owner-precedes-uia");
  });
  test([] {
    Fixture fixture; fixture.available = false; failure(fixture.take(L"input.key"), L"unavailable");
    check(fixture.events.empty() && fixture.guardian->ready_calls == 0, "input.unavailable-desktop-refuses-without-prompt-or-post");
  });
  test([] {
    Fixture fixture; fixture.world.owner.identity.binary = L"CredentialUIBroker.exe"; fixture.world.physical_owner = fixture.world.owner;
    fixture.approve(); failure(fixture.take(L"input.key"), L"protected");
    check(fixture.observations == 0 && fixture.events.empty(), "input.protected-owner-cannot-be-approved-around-floor");
  });
  test([] {
    Fixture fixture; fixture.session.mode = L"background"; failure(fixture.take(L"input.key"), L"unsupported_action");
    check(fixture.events.empty() && fixture.guardian->ready_calls == 0, "input.background-is-truthfully-unavailable");
  });
  test([] {
    for (const auto op : {L"input.click", L"input.key"}) {
      Fixture fixture; fixture.guardian->ready_result = false; failure(fixture.take(op), L"unavailable");
      check(fixture.events.empty(), "input.no-down-or-move-without-ready-release-guardian");
    }
  });
  test([] {
    Fixture fixture; fixture.before_fence = [&] { fixture.guardian->running = false; };
    failure(fixture.take(L"input.key"), L"changed"); check(fixture.events.empty(), "input.guardian-process-death-at-final-fence-refuses-down");
  });
  test([] {
    Fixture fixture; fixture.guardian->reserve_result = false; failure(fixture.take(L"input.key"), L"unavailable");
    check(fixture.events.empty() && !fixture.guardian->ledger.pending(), "input.no-down-without-private-guardian-reservation");
  });
  test([] {
    Fixture fixture; fixture.guardian->on_ready = [&] { ++fixture.session.observation_epoch; };
    failure(fixture.take(L"input.key"), L"changed"); check(fixture.events.empty(), "input.authority-rechecked-after-potentially-slow-guardian-startup");
  });
  test([] {
    for (int changed = 0; changed < 5; ++changed) {
      Fixture fixture;
      fixture.before_fence = [&] {
        if (changed == 0) fixture.capture_valid = false;
        if (changed == 1) ++fixture.world.owner.process.creation_time;
        if (changed == 2) ++fixture.world.bounds.x;
        if (changed == 3) fixture.point_current = false;
        if (changed == 4) fixture.foreground_current = false;
      };
      failure(fixture.take(L"input.click"), changed == 0 ? L"stale_frame" : L"changed");
      check(fixture.events.empty(), "input.capture-pid-geometry-hit-and-foreground-rechecked-at-commit");
    }
  });
  test([] {
    for (int changed = 0; changed < 5; ++changed) {
      Fixture fixture; fixture.before_fence = [&] {
        if (changed == 0) fixture.live = false;
        if (changed == 1) ++fixture.session.observation_epoch;
        if (changed == 2) fixture.keyboard_current = false;
        if (changed == 3) fixture.quiet = false;
        if (changed == 4) fixture.element_current = false;
      };
      failure(fixture.take(L"input.key"), L"changed"); check(fixture.events.empty(), "input.final-authority-layout-quiet-and-field-fence");
    }
  });
  test([] {
    Fixture fixture; fixture.admitted = false; failure(fixture.take(L"input.key"), L"changed");
    check(fixture.events.empty(), "input.is-current-alone-does-not-bypass-with-current");
  });
  test([] {
    Fixture fixture; fixture.before_fence = [&] { fixture.now += 51; };
    failure(fixture.take(L"input.key"), L"changed");
    check(fixture.events.empty(), "input-prepared-owner-fence-never-posts-after-50ms-age-budget");
  });
  test([] {
    Fixture fixture; auto value = fixture.args(L"input.move"); value.Insert(L"pid", JsonValue::CreateNumberValue(999));
    failure(fixture.take(L"input.move", value), L"changed");
    check(fixture.point_checks == 0 && fixture.events.empty(), "input.expected-pid-compared-before-pointer-preparation");
  });
  test([] {
    for (const auto op : {L"input.move", L"input.key"}) {
      Fixture fixture; auto value = fixture.args(op); value.Insert(L"ref", JsonValue::CreateStringValue(L"other-ref"));
      failure(fixture.take(op, value), L"stale_ref"); check(fixture.events.empty(), "input.actual-ref-never-retargeted-to-current-field");
    }
  });
  test([] {
    Fixture fixture; auto value = fixture.args(L"input.move"); value.Insert(L"elementId", JsonValue::CreateStringValue(L"other-element"));
    failure(fixture.take(L"input.move", value), L"stale_ref"); check(fixture.observations == 1 && fixture.events.empty(), "input.pointer-element-id-binds-actual-hit");
  });
  test([] {
    Fixture fixture; fixture.capture.zoom_source = L"base"; failure(fixture.take(L"input.move"), L"stale_frame");
    check(fixture.events.empty(), "input.zoom-image-is-never-an-input-coordinate-frame");
  });
  test([] {
    Fixture fixture; fixture.capture.window.reset();
    CaptureSurface actual; actual.hwnd = fixture.world.hwnd; actual.pid = fixture.world.owner.process.pid;
    actual.bounds = actual.frame_bounds = fixture.world.bounds; actual.visible = true; actual.cloaked = false; actual.window = fixture.world;
    auto overlay = actual; overlay.hwnd = reinterpret_cast<HWND>(uintptr_t(999)); overlay.excluded_overlay = true; overlay.window.reset();
    fixture.capture.inventory.windows = {overlay, actual}; success(fixture.take(L"input.move"));
    check(fixture.events.size() == 1, "input.display-capture-selects-actual-owner-beneath-exact-excluded-overlay");
  });
  test([] {
    Fixture fixture; fixture.capture.window.reset(); CaptureSurface unknown;
    unknown.bounds = fixture.world.bounds; unknown.visible = true; unknown.cloaked = false;
    fixture.capture.inventory.windows = {unknown}; failure(fixture.take(L"input.move"), L"protected");
    check(fixture.events.empty() && fixture.point_checks == 0, "input.display-capture-unknown-visible-owner-never-falls-through");
  });
  test([] {
    Fixture fixture; auto value = fixture.args(L"input.move"); value.Insert(L"x", JsonValue::CreateNumberValue(200));
    failure(fixture.take(L"input.move", value), L"out_of_bounds"); check(fixture.events.empty(), "input.last-pixel-edge-is-exclusive");
  });
  test([] {
    Fixture fixture; fixture.on_point = [](POINT point) { if (point.x == -70) throw Failure{L"protected", L"Synthetic protected endpoint."}; };
    failure(fixture.take(L"input.drag"), L"protected");
    check(fixture.events.empty() && fixture.guardian->reserve_calls == 0, "input.all-drag-points-admitted-before-any-button-or-modifier");
  });
  test([] {
    Fixture fixture; auto value = fixture.args(L"input.drag");
    value.Insert(L"targets", JsonArray::Parse(LR"([{"pid":123},{"pid":123},{"pid":999}])"));
    failure(fixture.take(L"input.drag", value), L"changed");
    check(fixture.events.empty() && fixture.guardian->reserve_calls == 0, "input.every-drag-endpoint-binds-expected-owner-before-any-down");
  });
  test([] {
    Fixture fixture; size_t last_point_checks = 0;
    fixture.on_point = [&](POINT point) { if (point.x == -70 && ++last_point_checks > 1) throw Failure{L"changed", L"Synthetic drag owner changed."}; };
    failure(fixture.take(L"input.drag"), L"changed"); fixture.pump();
    check(downs(fixture) == 1 && !fixture.guardian->ledger.pending() && fixture.guardian->ups.size() == 1,
          "input.drag-owner-rechecked-during-path-and-owned-button-released-on-failure");
  });
  test([] {
    Fixture fixture; fixture.secure = true; failure(fixture.take(L"input.type"), L"secure_field");
    check(fixture.events.empty() && fixture.batches.empty(), "input.secure-field-text-never-posts-or-reads-values");
    fixture.pump(); auto value = fixture.args(L"input.key"); value.Insert(L"combo", combo({L"ArrowLeft"}));
    success(fixture.take(L"input.key", value));
  });
  test([] {
    for (int unknown = 0; unknown < 4; ++unknown) {
      Fixture fixture;
      if (unknown == 0) fixture.secure.reset();
      if (unknown == 1) fixture.enabled = false;
      if (unknown == 2) fixture.focused = false;
      if (unknown == 3) fixture.focusable = false;
      failure(fixture.take(L"input.type"), L"changed"); check(fixture.batches.empty(), "input.incomplete-or-unfocused-native-field-proof-fails-closed");
    }
  });
  test([] {
    for (const auto keys : {combo({L"Control", L"v"}), combo({L"Control", L"x"}), combo({L"Control", L"z"}),
      combo({L"Control", L"y"}), combo({L"Backspace"}), combo({L"Delete"})}) {
      Fixture fixture; fixture.secure = true; auto value = fixture.args(L"input.key"); value.Insert(L"combo", keys);
      failure(fixture.take(L"input.key", value), L"secure_field"); check(fixture.events.empty(), "input.editing-shortcuts-cannot-bypass-secure-field-floor");
    }
  });
  test([] {
    for (const auto state : {std::optional<bool>{true}, std::optional<bool>{}}) {
      Fixture fixture; fixture.read_only = state; failure(fixture.take(L"input.type"), L"blocked");
      check(fixture.events.empty(), "input.read-only-or-unknown-value-pattern-refuses-text");
    }
  });
  test([] {
    Fixture fixture; fixture.value_pattern = false; fixture.read_only.reset(); fixture.text_pattern = true; fixture.text_read_only = false;
    success(fixture.take(L"input.type")); check(fixture.batches.size() == 5, "input.rich-text-pattern-proves-editability-without-value-pattern");
  });
  test([] {
    for (int kind = 0; kind < 4; ++kind) {
      Fixture fixture;
      if (kind == 0) fixture.value_pattern = false;
      if (kind == 1) { fixture.value_pattern = false; fixture.text_pattern = true; fixture.text_read_only.reset(); }
      if (kind == 2) { fixture.value_pattern = false; fixture.text_pattern = true; fixture.text_read_only = true; }
      if (kind == 3) { fixture.text_pattern = true; fixture.text_read_only = true; }
      failure(fixture.take(L"input.type"), L"blocked");
      check(fixture.batches.empty(), "input.no-edit-pattern-or-any-unknown-read-only-pattern-refuses-text");
    }
  });
  test([] {
    Fixture fixture; fixture.world.owner.identity.binary = L"Code.exe"; fixture.world.physical_owner = fixture.world.owner; fixture.approve();
    failure(fixture.take(L"input.type"), L"blocked"); check(fixture.events.empty(), "input.developer-app-remains-click-only-for-text");
    fixture.pump(); fixture.menus = std::vector<InputMenuShortcut>{{{L"F5"}, L"Run"}};
    auto value = fixture.args(L"input.key"); value.Insert(L"combo", combo({L"F5"})); success(fixture.take(L"input.key", value));
    check(downs(fixture) == 1, "input.safe-observed-nontext-ide-run-is-representable");
  });
  test([] {
    for (const auto keys : {combo({L"F12"}), combo({L"Control", L"Shift", L"i"}), combo({L"Meta", L"a"}), combo({L"Alt", L"Tab"})}) {
      Fixture fixture; auto value = fixture.args(L"input.key"); value.Insert(L"combo", keys);
      failure(fixture.take(L"input.key", value), L"blocked"); check(fixture.events.empty(), "input.system-and-inspector-shortcuts-always-refuse");
    }
  });
  test([] {
    Fixture fixture; auto value = fixture.args(L"input.key"); value.Insert(L"combo", combo({L"Control", L"s"}));
    failure(fixture.take(L"input.key", value), L"blocked"); fixture.pump();
    fixture.menus = std::vector<InputMenuShortcut>{{{L"Control", L"s"}, L"Save"}};
    success(fixture.take(L"input.key", value));
  });
  test([] {
    Fixture fixture; fixture.menus = std::vector<InputMenuShortcut>{{{L"Control", L"a"}, L"Open Console"}};
    failure(fixture.take(L"input.key"), L"blocked"); check(fixture.events.empty(), "input.actual-unsafe-menu-overrides-otherwise-default-chord");
  });
  test([] {
    Fixture fixture; fixture.menus = std::vector<InputMenuShortcut>{{{L"Control", L"s"}, L"Paste"}}; fixture.secure = true;
    auto value = fixture.args(L"input.key"); value.Insert(L"combo", combo({L"Control", L"s"}));
    failure(fixture.take(L"input.key", value), L"secure_field"); check(fixture.events.empty(), "input.actual-custom-paste-menu-is-text-changing");
  });
  test([] {
    Fixture fixture; fixture.during_menus = [&] { fixture.element = std::make_shared<Element>(); };
    failure(fixture.take(L"input.key"), L"changed"); check(fixture.events.empty(), "input.focused-element-refreshed-after-menu-observation");
  });
  test([] {
    Fixture fixture; fixture.observation_age = 51; failure(fixture.take(L"input.key"), L"changed");
    check(fixture.events.empty(), "input.old-uia-field-proof-never-reaches-native-post");
  });
  test([] {
    Fixture fixture; auto value = fixture.args(L"input.key"); value.Insert(L"repeat", JsonValue::CreateNumberValue(3));
    value.Insert(L"combo", combo({L"Control", L"Shift", L"a"})); success(fixture.take(L"input.key", value));
    check(downs(fixture) == 9 && fixture.guardian->ups.size() == 9 && fixture.guardian->ups[0].virtual_key == 'A' &&
          fixture.guardian->ups[1].virtual_key == VK_SHIFT && fixture.guardian->ups[2].virtual_key == VK_CONTROL,
          "input.repeat-releases-key-and-modifiers-in-reverse-before-next-cycle");
  });
  test([] {
    Fixture fixture; fixture.azerty = true; fixture.fingerprint = L"synthetic-azerty";
    fixture.layout.keys[L"KeyQ"] = {L"a", L"A"}; auto value = fixture.args(L"input.key"); value.Insert(L"combo", combo({L"KeyQ"}));
    success(fixture.take(L"input.key", value)); check(fixture.events[0].release.scan == 0x10 && fixture.events[0].release.virtual_key == 'A',
      "input.physical-key-uses-observed-layout-position");
    fixture.events.clear(); value.Insert(L"combo", combo({L"q"})); success(fixture.take(L"input.key", value));
    check(fixture.events[0].release.scan == 0x1e && fixture.events[0].release.virtual_key == 'Q', "input.literal-key-keeps-semantic-layout-mapping");
  });
  test([] {
    Fixture fixture; fixture.after_post = [&](const auto&) { fixture.fingerprint = L"different-layout"; };
    failure(fixture.take(L"input.key"), L"changed"); fixture.pump();
    check(downs(fixture) == 1 && !fixture.guardian->ledger.pending(), "input.layout-change-stops-before-next-key-and-releases-only-observed-modifier");
  });
  test([] {
    Fixture fixture; auto value = fixture.args(L"input.type");
    std::wstring text(19, L'a'); text.push_back(wchar_t(0xd83d)); text.push_back(wchar_t(0xde00)); text += L"b";
    value.Insert(L"text", JsonValue::CreateStringValue(text)); success(fixture.take(L"input.type", value));
    check(fixture.batches.size() == 21 && fixture.batches[19].size() == 4 && fixture.batches[19][0].release.scan == 0xd83d &&
          fixture.batches[19][2].release.scan == 0xde00 && fixture.batches[20].size() == 2 && fixture.menu_reads == 0,
          "input.unicode-scalar-pairs-are-one-atomic-batch-across-20-unit-chunk-boundary");
  });
  test([] {
    Fixture fixture; auto value = fixture.args(L"input.type"); value.Insert(L"text", JsonValue::CreateStringValue(std::wstring(21, L'a')));
    fixture.after_batch = [&](size_t count) { if (count == 20) fixture.secure = true; };
    failure(fixture.take(L"input.type", value), L"changed");
    check(fixture.batches.size() == 20 && !fixture.guardian->ledger.pending(), "input.field-security-reobserved-before-next-unicode-chunk");
  });
  test([] {
    for (const auto text : {std::wstring{}, std::wstring(4001, L'a'), std::wstring(1, wchar_t(0xd800)), std::wstring(1, wchar_t(0xdc00)), std::wstring(L"a\0b", 3)}) {
      Fixture fixture; auto value = fixture.args(L"input.type"); value.Insert(L"text", JsonValue::CreateStringValue(text));
      failure(fixture.take(L"input.type", value), L"failed"); check(fixture.batches.empty(), "input.invalid-unicode-never-emits-prefix");
    }
  });
  test([] {
    Fixture fixture; fixture.batch_result = InputPostResult::uncertain; fixture.reflect_uncertain = true;
    failure(fixture.take(L"input.type"), L"failed"); fixture.pump();
    check(fixture.batches.size() == 1 && fixture.events.size() == 1 && fixture.guardian->ups.size() == 1 && fixture.parent_ups == 0,
          "input.partial-unicode-batch-is-not-retried-and-only-actual-down-is-cleaned");
    fixture.batch_result = InputPostResult::accepted;
    failure(fixture.take(L"input.key"), L"unavailable"); check(fixture.events.size() == 1, "input.uncertain-native-outcome-latches-before-successor");
  });
  test([] {
    Fixture fixture; fixture.post_result = InputPostResult::not_posted; failure(fixture.take(L"input.key"), L"failed"); fixture.pump();
    check(fixture.guardian->ups.empty() && fixture.events.empty() && fixture.parent_ups == 0, "input.definitive-no-post-does-not-authorize-any-up");
    fixture.post_result = InputPostResult::accepted; success(fixture.take(L"input.key"));
  });
  test([] {
    Fixture fixture; fixture.guardian->auto_up = false; failure(fixture.take(L"input.key"), L"failed"); fixture.pump();
    check(fixture.guardian->ledger.pending() && fixture.parent_ups == 0, "input.failed-matching-up-proof-keeps-cleanup-debt");
    failure(fixture.take(L"input.key"), L"unavailable");
  });
  test([] {
    Fixture fixture; fixture.guardian->wrong_up_tag = true; failure(fixture.take(L"input.key"), L"failed"); fixture.pump();
    check(fixture.guardian->ledger.pending(), "input.foreign-tagged-up-never-counts-as-owned-cleanup");
    bool done = false, complete = true; uint32_t count = 99;
    fixture.service->release_all_async([&](bool value, uint32_t released) { done = true; complete = value; count = released; }); fixture.pump();
    check(done && !complete && count == 0, "input.cleanup-report-requires-actual-matching-tagged-up");
  });
  test([] {
    Fixture fixture; fixture.send(L"input.hold"); check(!fixture.result && downs(fixture) == 2, "input.hold-awaits-first-down-relative-timer");
    fixture.advance(99); check(!fixture.result && fixture.guardian->ledger.pending(), "input.hold-remains-owned-before-deadline");
    fixture.advance(1); check(fixture.result.has_value() && fixture.completions == 1, "input.hold-completes-once-after-cleanup");
    success(*fixture.result); check(!fixture.guardian->ledger.pending() && fixture.guardian->ups.size() == 2, "input.hold-success-requires-observed-ups");
  });
  test([] {
    for (const auto duration : {-1, 10001}) {
      Fixture fixture; auto value = fixture.args(L"input.hold"); value.Insert(L"ms", JsonValue::CreateNumberValue(duration));
      failure(fixture.take(L"input.hold", value), L"failed"); check(fixture.events.empty(), "input.hold-cap-is-enforced-before-posting");
    }
    Fixture fixture; auto value = fixture.args(L"input.hold"); value.Insert(L"ms", JsonValue::CreateNumberValue(0));
    size_t observed_ups = 0;
    fixture.guardian->on_observed = [&](bool down) {
      if (!down) { check(!fixture.inside && !fixture.result, "input.zero-hold-awaits-matching-up-outside-post-fence-before-success"); ++observed_ups; }
    };
    fixture.send(L"input.hold", value);
    check(fixture.result.has_value() && observed_ups == 2 && downs(fixture) == 2 && fixture.guardian->ups.size() == 2 && !fixture.guardian->ledger.pending(),
      "input.zero-hold-completes-only-after-the-whole-chord-has-matching-ups");
    success(*fixture.result);
    check(fixture.guardian->drain_calls == 0 && fixture.timers.jobs.empty() && fixture.inspections.jobs.empty(), "input.zero-hold-needs-no-expiry-or-blocking-cleanup-under-post-fence");
    fixture.pump(); check(fixture.completions == 1 && fixture.guardian->ups.size() == 2, "input.zero-hold-has-no-late-second-release-or-completion");
  });
  test([] {
    Fixture fixture; auto value = fixture.args(L"input.hold"); value.Insert(L"ms", JsonValue::CreateNumberValue(0));
    fixture.guardian->on_observed = [&](bool down) { if (down) fixture.live = false; };
    fixture.send(L"input.hold", value);
    check(fixture.result.has_value(), "input.zero-hold-cancellation-is-observed-after-actual-down"); failure(*fixture.result, L"changed");
    fixture.pump();
    check(downs(fixture) == 1 && fixture.guardian->ups.size() == 1 && !fixture.guardian->ledger.pending() &&
      !fixture.guardian->drain_under_authority && fixture.completions == 1,
      "input.zero-hold-cancellation-stops-the-chord-and-cleans-only-owned-input-outside-authority");
  });
  test([] {
    Fixture fixture; size_t first = 0;
    fixture.after_post = [&](const auto&) { if (++first == 1) fixture.now += 40; };
    fixture.send(L"input.hold"); check(!fixture.result && fixture.now == 1040, "input.hold-post-sequence-can-take-time");
    fixture.advance(60); check(fixture.result.has_value(), "input.hold-deadline-starts-at-first-down-not-last-modifier"); success(*fixture.result);
  });
  test([] {
    Fixture fixture; fixture.send(L"input.hold"); const auto stale_callbacks = fixture.inspections.history;
    fixture.secure = true; fixture.advance(25); check(fixture.result.has_value(), "input.hold-security-tick-revokes-without-waiting-for-duration");
    failure(*fixture.result, L"changed"); fixture.pump(); const auto events = fixture.events.size();
    for (const auto& callback : stale_callbacks) callback(); fixture.advance(100);
    check(fixture.completions == 1 && fixture.events.size() == events && !fixture.guardian->ledger.pending(), "input.late-held-inspection-cannot-post-or-complete-again");
  });
  test([] {
    for (int change = 0; change < 4; ++change) {
      Fixture fixture; fixture.send(L"input.hold");
      if (change == 0) fixture.keyboard_current = false;
      if (change == 1) fixture.quiet = false;
      if (change == 2) fixture.element = std::make_shared<Element>();
      if (change == 3) fixture.guardian->running = false;
      fixture.advance(25); check(fixture.result.has_value(), "input.held-security-tick-observes-focus-layout-quiet-and-guardian-loss");
      failure(*fixture.result, L"changed"); fixture.pump();
      check(fixture.guardian->ledger.pending() == (change == 3) && fixture.parent_ups == 0,
            "input.tick-failure-uses-only-live-guardian-cleanup-and-retains-unknown-debt-after-guardian-death");
    }
  });
  test([] {
    Fixture fixture; fixture.send(L"input.hold"); fixture.guardian->auto_up = false;
    bool done = false; bool complete = false; uint32_t released = 99;
    fixture.service->release_all_async([&](bool value, uint32_t count) { done = true; complete = value; released = count; });
    check(!done && !fixture.result, "input.async-stop-does-not-report-before-independent-cleanup-job");
    failure(fixture.take(L"input.key"), L"unavailable"); fixture.guardian->auto_up = true; fixture.pump();
    check(done && complete && released == 2 && fixture.parent_ups == 0 && !fixture.guardian->ledger.pending(),
          "input.async-stop-counts-only-actual-matching-owned-ups-before-success");
    success(fixture.take(L"input.key"));
  });
  test([] {
    Fixture fixture; fixture.send(L"input.hold");
    auto first = fixture.service->prepare_release_all(), second = fixture.service->prepare_release_all();
    size_t first_calls = 0, second_calls = 0; bool first_ok = false, second_ok = false; uint32_t first_count = 99, second_count = 99;
    first([&](bool complete, uint32_t count) { ++first_calls; first_ok = complete; first_count = count; });
    second([&](bool complete, uint32_t count) { ++second_calls; second_ok = complete; second_count = count; });
    check(first_calls == 0 && second_calls == 0, "input.concurrent-controls-both-await-the-same-up-barrier"); fixture.pump();
    check(first_calls == 1 && second_calls == 1 && first_ok && second_ok && first_count == 2 && second_count == 0,
          "input.only-first-prepared-control-owns-exact-ticket-release-credit");
    first([&](bool complete, uint32_t count) { check(!complete && count == 0, "input.prepared-cleanup-provider-is-one-use"); ++first_calls; });
    check(first_calls == 2 && fixture.guardian->ups.size() == 2, "input.replayed-provider-cannot-repeat-cleanup-or-release-credit");
  });
  test([] {
    Fixture fixture; fixture.send(L"input.hold"); auto prepared = fixture.service->prepare_release_all(); fixture.pump();
    check(!fixture.guardian->ledger.pending(), "input.cleanup-can-finish-before-control-provider-start");
    size_t calls = 0; prepared([&](bool complete, uint32_t count) {
      ++calls; check(complete && count == 2, "input.immutable-prepared-credit-survives-completion-before-provider-start");
    }); check(calls == 1, "input.late-provider-observes-one-finite-completion");
  });
  test([] {
    Fixture fixture; fixture.send(L"input.hold"); const auto old_timers = fixture.timers.history;
    check(fixture.service->release_all() == 0, "input.synchronous-stop-only-revokes-and-enqueues"); fixture.pump();
    success(fixture.take(L"input.key")); const auto posts = fixture.events.size(), calls = fixture.completions;
    for (const auto& callback : old_timers) callback(); fixture.pump();
    check(fixture.events.size() == posts && fixture.completions == calls, "input.old-hold-timer-does-not-release-or-complete-successor");
  });
  test([] {
    Fixture fixture; fixture.send(L"input.hold"); fixture.guardian->auto_up = false; fixture.advance(100);
    check(fixture.result.has_value(), "input.hold-failed-cleanup-finishes-truthfully"); failure(*fixture.result, L"changed");
    failure(fixture.take(L"input.key"), L"unavailable");
  });
  test([] {
    Fixture fixture; fixture.send(L"input.hold"); fixture.service->close(); fixture.pump();
    check(fixture.guardian->close_calls == 1 && !fixture.guardian->ledger.pending(), "input.close-preserves-independent-owned-up-cleanup");
    failure(fixture.take(L"input.key"), L"unavailable");
  });
  test([] {
    Fixture fixture; auto value=fixture.args(L"input.hold"); value.Insert(L"ms",JsonValue::CreateNumberValue(0));
    success(fixture.take(L"input.hold",value));
    check(downs(fixture)==2 && fixture.guardian->ups.size()==2 && !fixture.guardian->ledger.pending() && fixture.timers.jobs.empty(),
      "input.zero-duration-hold-is-one-atomic-press-release-without-a-racing-expiry");
  });
  test([] {
    const std::array<std::optional<std::wstring>,4> stable{L"1",L"1",L"1",L"1"}, letter{L"a",L"A",L"a",L"A"}, nonlatin{L"ж",L"Ж",L"ж",L"Ж"};
    check(input_toggle_invariant(stable)==L"1" && !input_toggle_invariant(letter) && input_toggle_invariant(letter,true)==L"a" &&
      !input_toggle_invariant(nonlatin,true),"input.native-toggle-unknown-refuses-sensitive-text-but-proves-ascii-shortcut-case");
    auto missing=stable; missing[3].reset(); check(!input_toggle_invariant(missing,true),"input.native-toggle-proof-needs-every-alternative");
  });
  test([] {
    Fixture fixture; const auto proof=fixture.guard->point(fixture.world,POINT{-90,-40},fixture.session); bool posted=false;
    fixture.now+=51;
    try { fixture.guard->commit_point(proof,fixture.session,fixture.context(),[&]{posted=true;}); throw std::runtime_error("input.expired-private-point-proof-was-accepted"); }
    catch (const Failure& value) { check(value.code==L"changed" && !posted,"input.point-commit-retains-original-preparation-time"); }
    fixture.now-=51; ++fixture.session.observation_epoch;
    try { fixture.guard->commit_point(proof,fixture.session,fixture.context(),[&]{posted=true;}); throw std::runtime_error("input.old-native-epoch-point-proof-was-accepted"); }
    catch (const Failure& value) { check(value.code==L"changed" && !posted,"input.point-commit-retains-original-private-authority"); }
  });
  test([] {
    for (const bool exited:{false,true}) {
      Fixture fixture; fixture.send(L"input.hold"); fixture.guardian->running=false; fixture.guardian->process_exited=exited;
      bool completed=false, complete=true; uint32_t count=99;
      fixture.service->release_all_async([&](bool result,uint32_t released){completed=true;complete=result;count=released;}); fixture.pump();
      check(completed && !complete && count==0 && fixture.parent_ups==(exited?2U:0U),"input.only-confirmed-dead-guardian-permits-one-best-effort-owned-up-attempt");
      fixture.service->release_all_async([&](bool result,uint32_t){check(!result,"input.dead-guardian-fallback-never-creates-a-hook-receipt");}); fixture.pump();
      check(fixture.parent_ups==(exited?2U:0U),"input.dead-guardian-fallback-retains-debt-without-retrying-uncertain-ups");
    }
  });
  test([] {
    Fixture fixture; auto value=fixture.args(L"input.click"); value.Insert(L"modifiers",combo({L"Shift"}));
    fixture.after_post=[&](const auto& event) { if (event.kind==InputEventKind::key_down) { fixture.now+=input_guardian_held_limit_ms+1; (void)fixture.guardian->release(false); } };
    failure(fixture.take(L"input.click",value),L"changed"); fixture.pump();
    check(fixture.events.size()==1 && fixture.events[0].kind==InputEventKind::key_down && !fixture.guardian->ledger.pending(),
      "input.expired-modifier-ticket-cannot-continue-with-move-or-button-down");
  });
  test([] {
    for (const auto op:{L"input.click",L"input.drag"}) {
      Fixture fixture;
      fixture.after_post=[&](const auto& event) { if (event.kind==InputEventKind::button_down) { fixture.now+=input_guardian_held_limit_ms+1; (void)fixture.guardian->release(false); } };
      failure(fixture.take(op),L"changed"); fixture.pump();
      check(fixture.events.size()==2 && fixture.events[0].kind==InputEventKind::move && fixture.events[1].kind==InputEventKind::button_down &&
        fixture.guardian->ups.size()==1 && !fixture.guardian->ledger.pending(),
        "input.expired-button-ticket-cannot-drag-or-accept-historical-up-as-action-success");
    }
  });
  test([] {
    Fixture fixture; auto value=fixture.args(L"input.hold"); value.Insert(L"ms",JsonValue::CreateNumberValue(10000)); fixture.send(L"input.hold",value);
    fixture.now+=input_guardian_held_limit_ms; fixture.inspections.run();
    check(!fixture.result,"input.hold-at-cap-awaits-its-independent-expiry-result"); fixture.timers.run();
    check(fixture.result.has_value(),"input.hold-at-cap-finishes-after-owned-cleanup"); success(*fixture.result);
  });
  test([] {
    for (const auto op:{L"input.click",L"input.type"}) {
      Fixture fixture; bool crossed=false; auto value=fixture.args(op);
      if (std::wstring_view(op)==L"input.type") value.Insert(L"text",JsonValue::CreateStringValue(L"a"));
      fixture.after_post=[&](const auto& event) { if (event.kind==InputEventKind::button_down) fixture.now+=input_guardian_held_limit_ms-1; };
      fixture.after_batch=[&](size_t) { fixture.now+=input_guardian_held_limit_ms-1; };
      fixture.guardian->on_observed=[&](bool down) { if (!down && !crossed) { crossed=true; fixture.now+=2; } };
      failure(fixture.take(op,value),L"changed"); fixture.pump();
      check(crossed && fixture.guardian->ledger.released_count()==1 && !fixture.guardian->ledger.pending(),
        "input.up-receipt-crossing-held-cap-cannot-erase-the-age-witness-and-report-success");
    }
  });
  test([] {
    Fixture fixture;fixture.during_capture_current=[&]{fixture.live=false;};
    failure(fixture.take(L"input.click"),L"changed");fixture.pump();
    check(fixture.events.empty() && fixture.guardian->ups.empty(),"input.hardware-revocation-during-capture-precondition-prevents-native-mutation");
  });
  test([] {
    Fixture fixture;fixture.during_freshness=[&]{fixture.live=false;};
    failure(fixture.take(L"input.key"),L"changed");fixture.pump();
    check(fixture.events.empty() && fixture.guardian->ups.empty(),"input.hardware-revocation-during-keyboard-precondition-prevents-native-mutation");
  });
  test([] {
    for(const auto op:{L"input.click",L"input.key",L"input.type"}){
      Fixture fixture;fixture.during_native_preparation=[&]{fixture.live=false;};
      auto args=fixture.args(op);if(std::wstring_view(op)==L"input.type")args.Insert(L"text",JsonValue::CreateStringValue(L"a"));
      failure(fixture.take(op,args),L"changed");fixture.pump();
      check(fixture.events.empty() && fixture.batches.empty() && fixture.guardian->ups.empty(),"input.hardware-revocation-during-last-native-preparation-prevents-sendinput");
    }
  });
  return groups;
}
}
