#include "server.h"
#include "core.h"
#include <algorithm>
#include <deque>
#include <memory>
#include <stdexcept>
#include <utility>

namespace vector::computer {
namespace {
using Task = std::function<void()>;
void require(bool value, const char* name) { if (!value) throw std::runtime_error(name); }
JsonObject object(std::wstring_view value) { return JsonObject::Parse(winrt::hstring(value)); }
Request request(uint64_t id, std::wstring_view op, JsonObject args = {}) {
  args.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(id)));
  args.Insert(L"op", JsonValue::CreateStringValue(op));
  return parse_request(encode_json(args));
}
JsonObject begin_args(std::optional<uint64_t> revision = {}) {
  auto args = object(LR"({"sessionId":"synthetic","mode":"foreground","approved":[],"vectorPids":[],"vectorWindowIds":[],"overlayWindowIds":[],"escStops":true,"stopChord":"Control+Alt+Shift+Escape","heartbeatMs":2000})");
  if (revision) args.Insert(L"phaseRevision", JsonValue::CreateNumberValue(static_cast<double>(*revision)));
  return args;
}
struct Timer { uint64_t due; Task body; bool cancelled = false; };
struct Delivered { JsonObject value; std::vector<uint8_t> image; };
struct Fixture {
  uint64_t time = 100;
  std::deque<Task> work, output;
  std::vector<std::shared_ptr<Timer>> timers;
  std::vector<Delivered> delivered;
  std::vector<std::wstring> cleanup;
  std::vector<ServerSession> announced;
  uint32_t releases = 0, invalidations = 0, stops = 0;
  bool write_ok = true, available = true, ready = true;
  std::unique_ptr<Dispatcher> dispatcher;
  explicit Fixture(size_t queue_limit = 1000, size_t byte_limit = 2 * kMaxFrameBytes, size_t output_limit = 2 * kMaxFrameBytes + 8, bool responsible = true) {
    Dispatcher::Options options;
    options.send = [this](const JsonObject& value, std::span<const uint8_t> image) {
      if (!write_ok) return false;
      delivered.push_back(Delivered{JsonObject::Parse(value.Stringify()), {image.begin(), image.end()}}); return true;
    };
    options.stopped = [this] { ++stops; };
    options.release_all = [this] { return ++releases; };
    options.cleanup = [this](auto reason) { cleanup.emplace_back(reason); };
    options.observations_invalidated = [this] { ++invalidations; };
    options.session_changed = [this](const auto& session) { if (session) announced.push_back(*session); };
    options.available = [this] { return available; };
    options.foreground_ready = [this](const auto&) { return ready; };
    options.execute = [this](Task task) { work.push_back(std::move(task)); };
    options.output_execute = [this](Task task) { output.push_back(std::move(task)); };
    options.schedule = [this](uint32_t ms, Task task) {
      auto timer = std::make_shared<Timer>(Timer{time + ms, std::move(task)}); timers.push_back(timer);
      return [timer] { timer->cancelled = true; };
    };
    options.now = [this] { return time; }; options.responsible = responsible;
    options.queue_limit = queue_limit; options.pending_limit_bytes = byte_limit; options.output_limit_bytes = output_limit;
    dispatcher = std::make_unique<Dispatcher>(std::move(options));
  }
  void workers() { for (size_t count = 0; !work.empty(); ++count) { require(count < 2000, "server.worker-bound"); auto task = std::move(work.front()); work.pop_front(); task(); } }
  void outputs() { for (size_t count = 0; !output.empty(); ++count) { require(count < 2000, "server.output-bound"); auto task = std::move(output.front()); output.pop_front(); task(); } }
  void drain() { workers(); outputs(); }
  void receive(uint64_t id, std::wstring_view op, JsonObject args = {}) { dispatcher->receive(request(id, op, std::move(args))); }
  void begin(std::optional<uint64_t> revision = {}) { receive(1, L"session.begin", begin_args(revision)); drain(); }
  void advance(uint64_t ms) {
    const auto limit = time + ms;
    for (size_t count = 0; count < 2000; ++count) {
      std::shared_ptr<Timer> next;
      for (const auto& timer : timers) if (!timer->cancelled && timer->due <= limit && (!next || timer->due < next->due)) next = timer;
      if (!next) { time = limit; drain(); return; }
      time = next->due; next->cancelled = true; next->body(); drain();
    }
    throw std::runtime_error("server.timer-bound");
  }
  JsonObject reply(uint64_t id) const {
    for (auto it = delivered.rbegin(); it != delivered.rend(); ++it) if (it->value.HasKey(L"id") && safe_integer(it->value.Lookup(L"id")) == id) return it->value;
    throw std::runtime_error("server.missing-reply");
  }
  size_t replies(uint64_t id) const {
    return static_cast<size_t>(std::count_if(delivered.begin(), delivered.end(), [id](const auto& item) { return item.value.HasKey(L"id") && safe_integer(item.value.Lookup(L"id")) == id; }));
  }
  bool code(uint64_t id, std::wstring_view expected) const { const auto value = reply(id); return value.HasKey(L"code") && value.GetNamedString(L"code") == expected; }
};
}

size_t run_server_tests() {
  size_t groups = 0;
  const auto test = [&](const Task& body) { body(); ++groups; };
  test([] {
    Fixture fixture;
    fixture.receive(1, L"hello", object(LR"({"protocol":{"min":1,"max":1}})")); fixture.drain();
    const auto hello = fixture.reply(1);
    require(hello.GetNamedBoolean(L"ok") && hello.GetNamedBoolean(L"responsible"), "server.hello");
    require(hello.GetNamedObject(L"helper").GetNamedString(L"platform") == L"windows", "server.platform-wire");
    require(hello.GetNamedObject(L"limits").GetNamedNumber(L"maxFrameBytes") == 16'777'216, "server.frame-limit");
    for (const auto& feature : hello.GetNamedObject(L"features")) require(!feature.Value().GetBoolean(), "server.no-unimplemented-features");
    fixture.receive(2, L"hello", object(LR"({"protocol":{"min":999,"max":999}})")); fixture.drain(); require(fixture.code(2, L"helper_incompatible"), "server.negotiation");
    fixture.receive(3, L"hello", object(LR"({"protocol":{"min":2,"max":1}})")); fixture.drain(); require(fixture.code(3, L"failed"), "server.invalid-range");
  });
  test([] {
    Fixture fixture;
    fixture.receive(1, L"permissions.status"); fixture.drain();
    require(fixture.reply(1).GetNamedString(L"screen") == L"n/a" && fixture.reply(1).GetNamedString(L"accessibility") == L"n/a", "server.permission-status");
    uint64_t id = 2;
    for (const auto op : {L"permissions.request", L"permissions.reset", L"clipboard.read", L"clipboard.write", L"capture", L"ui.tree", L"input.key", L"conformance.unknown"}) {
      fixture.receive(id, op); fixture.drain(); require(fixture.code(id, L"unsupported_action"), "server.pending-native-unsupported"); ++id;
    }
    require(!fixture.dispatcher->register_handler(L"clipboard.write", 100, false, true, [](const auto&, const auto&, auto) {}), "server.clipboard-never-registered");
  });
  test([] {
    Fixture fixture; fixture.begin(7);
    const auto original = fixture.dispatcher->session_snapshot(); require(original && original->revision == 7, "server.begin");
    fixture.receive(2, L"session.update", object(LR"({"sessionId":"synthetic","phaseRevision":7,"escStops":false})")); fixture.drain();
    const auto updated = fixture.dispatcher->session_snapshot();
    require(updated && updated->run_epoch == original->run_epoch && updated->observation_epoch != original->observation_epoch && !updated->esc_stops, "server.private-update-epoch");
    fixture.receive(3, L"session.begin", begin_args(7)); fixture.drain();
    require(fixture.dispatcher->session_snapshot()->run_epoch != original->run_epoch, "server.same-wire-id-new-run");
    fixture.receive(4, L"session.end"); fixture.drain(); require(!fixture.dispatcher->session_snapshot(), "server.end");
  });
  test([] {
    Fixture fixture;
    auto background = begin_args(); background.Insert(L"mode", JsonValue::CreateStringValue(L"background"));
    fixture.receive(1, L"session.begin", background); fixture.drain(); require(fixture.code(1, L"unsupported_action") && !fixture.dispatcher->session_snapshot(), "server.no-background");
    fixture.begin(4);
    for (const auto args : {LR"({"sessionId":"other","phaseRevision":4})", LR"({"sessionId":"synthetic","phaseRevision":3})", LR"({"escStops":false})", LR"({"sessionId":"synthetic","phaseRevision":4,"mode":"background"})"}) {
      fixture.receive(2, L"session.update", object(args)); fixture.drain(); require(!fixture.reply(2).GetNamedBoolean(L"ok"), "server.update-identity-revision");
    }
  });
  test([] {
    Fixture fixture;
    for (const auto entry : {LR"({"platform":"macos","bundleId":"fake"})", LR"({"platform":"windows","kind":"exe","name":"x","system":false,"verified":false,"publisher":"","product":"","binary":"x.exe","exe":"C:\\x.exe"})"}) {
      auto args = begin_args(); JsonArray approved; approved.Append(object(entry)); args.Insert(L"approved", approved);
      fixture.receive(2, L"session.begin", args); fixture.drain(); require(fixture.code(2, L"failed"), "server.malformed-approvals");
    }
    auto args = begin_args(); args.Insert(L"vectorPids", JsonArray::Parse(L"[4294967296]")); fixture.receive(3, L"session.begin", args); fixture.drain(); require(fixture.code(3, L"failed"), "server.native-pid-bound");
  });
  test([] {
    Fixture fixture; fixture.receive(1, L"cancel"); fixture.receive(2, L"cancel", object(LR"({"target":41})")); fixture.drain();
    require(fixture.reply(1).GetNamedBoolean(L"ok") && fixture.reply(2).GetNamedBoolean(L"ok"), "server.idle-cancel");
    fixture.receive(3, L"heartbeat", object(LR"({"extra":true})")); fixture.drain(); require(fixture.code(3, L"failed"), "server.control-strict-args");
  });
  test([] {
    Fixture fixture; fixture.begin();
    std::vector<Dispatcher::Completion> completions; std::vector<OperationContext> contexts;
    fixture.dispatcher->register_handler(L"synthetic.read", 10'000, true, false, [&](const auto&, const auto& context, auto done) { contexts.push_back(context); completions.push_back(done); });
    fixture.receive(2, L"synthetic.read"); fixture.receive(3, L"synthetic.read"); fixture.workers();
    require(completions.size() == 1 && contexts[0].is_current(), "server.one-active");
    completions[0](Reply{}); fixture.workers(); require(completions.size() == 2 && !contexts[0].is_current(), "server.serial-successor");
    completions[0](Failure{L"failed", L"Late callback."}); completions[1](Reply{}); fixture.drain();
    require(fixture.replies(2) == 1 && fixture.replies(3) == 1, "server.one-reply-per-token");
  });
  test([] {
    Fixture fixture; fixture.begin(1); OperationContext context; Dispatcher::Completion done;
    fixture.dispatcher->register_handler(L"synthetic.write", 10'000, true, true, [&](const auto&, const auto& value, auto finish) { context = value; done = finish; });
    fixture.receive(2, L"synthetic.write", object(LR"({"sessionId":"synthetic","phaseRevision":1})")); fixture.workers();
    int writes = 0; require(context.with_current([&] { ++writes; }) && writes == 1, "server.commit-fence-current");
    fixture.receive(3, L"session.update", object(LR"({"sessionId":"synthetic","phaseRevision":1})")); fixture.drain();
    require(!context.with_current([&] { ++writes; }) && writes == 1 && fixture.code(2, L"changed"), "server.same-revision-retired");
    done(Reply{}); fixture.drain(); require(fixture.replies(2) == 1, "server.late-completion-refused");
  });
  test([] {
    Fixture fixture; fixture.begin(); OperationContext context;
    fixture.dispatcher->register_handler(L"synthetic.write", 10'000, true, true, [&](const auto&, const auto& value, auto) { context = value; });
    fixture.receive(2, L"synthetic.write"); fixture.receive(3, L"synthetic.write"); fixture.workers(); const auto before = fixture.releases;
    fixture.receive(4, L"cancel", object(LR"({"target":2})")); fixture.drain();
    require(!context.is_current() && fixture.releases > before && fixture.code(2, L"failed") && fixture.code(3, L"changed"), "server.cancel-release-and-retire");
    require(std::find(fixture.cleanup.begin(), fixture.cleanup.end(), L"cancel") != fixture.cleanup.end(), "server.cancel-resource-cleanup");
  });
  test([] {
    Fixture fixture; fixture.begin();
    fixture.dispatcher->register_handler(L"synthetic.read", 10'000, true, false, [](const auto&, const auto&, auto) {});
    fixture.receive(2, L"synthetic.read"); fixture.receive(3, L"synthetic.read"); fixture.workers();
    fixture.receive(4, L"cancel", object(LR"({"target":3})")); fixture.drain(); require(fixture.code(3, L"failed") && fixture.replies(2) == 0, "server.cancel-queued-only");
    fixture.receive(5, L"input.releaseAll"); fixture.drain(); require(fixture.reply(5).GetNamedNumber(L"released") > 0 && fixture.replies(2) == 0, "server.release-control-priority");
  });
  test([] {
    Fixture fixture; fixture.begin(); OperationContext context;
    fixture.dispatcher->register_handler(L"input.key", 10'000, true, true, [&](const auto&, const auto& value, auto) { context = value; });
    fixture.receive(2, L"input.key"); fixture.workers(); const auto before = fixture.releases;
    fixture.advance(5000); require(!context.is_current() && fixture.code(2, L"stopped") && fixture.releases > before, "server.heartbeat-stops-active");
    fixture.receive(3, L"heartbeat"); fixture.receive(4, L"session.update", object(LR"({"paused":false})")); fixture.receive(5, L"input.key"); fixture.drain();
    require(fixture.code(5, L"stopped"), "server.heartbeat-cannot-unhalt");
    fixture.receive(6, L"session.begin", begin_args()); fixture.receive(7, L"input.key"); fixture.workers(); require(context.is_current(), "server.new-begin-unhalts");
  });
  test([] {
    Fixture fixture; fixture.begin();
    fixture.dispatcher->register_handler(L"synthetic.write", 100, true, true, [](const auto&, const auto&, auto) {});
    fixture.receive(2, L"synthetic.write"); fixture.workers(); const auto before = fixture.releases;
    fixture.advance(101); fixture.receive(3, L"synthetic.write"); fixture.drain();
    require(fixture.code(2, L"timeout") && fixture.code(3, L"stopped") && fixture.releases > before, "server.timeout-mutation-latch");
  });
  test([] {
    Fixture fixture; fixture.begin(); size_t called = 0;
    fixture.dispatcher->register_handler(L"synthetic.read", 100, true, false, [&](const auto&, const auto&, auto done) { if (++called == 2) done(Reply{}); });
    fixture.receive(2, L"synthetic.read"); fixture.receive(3, L"synthetic.read"); fixture.workers(); fixture.advance(101);
    require(fixture.code(2, L"timeout") && fixture.reply(3).GetNamedBoolean(L"ok"), "server.read-timeout-pumps-successor");
  });
  test([] {
    Fixture fixture; fixture.begin();
    fixture.dispatcher->register_handler(L"synthetic.read", 1000, true, false, [](const auto&, const auto&, auto done) { JsonObject fields; fields.Insert(L"private", JsonValue::CreateStringValue(L"not delivered")); done(Reply{fields, {1, 2, 3}}); });
    fixture.receive(2, L"synthetic.read"); fixture.workers();
    fixture.receive(3, L"session.update", object(LR"({"escStops":false})")); fixture.outputs();
    require(fixture.code(2, L"changed") && fixture.delivered[1].image.empty() && !fixture.reply(2).HasKey(L"private"), "server.delivery-authority-rechecked");
  });
  test([] {
    Fixture fixture; fixture.begin(); fixture.dispatcher->register_handler(L"synthetic.write", 1000, true, true, [](const auto&, const auto&, auto) {});
    fixture.receive(2, L"synthetic.write"); fixture.workers(); const auto old = *fixture.dispatcher->session_snapshot();
    const auto before = fixture.releases;
    require(fixture.dispatcher->stop_from_physical_input(L"esc", old), "server.actual-stop-seam"); fixture.drain();
    require(fixture.code(2, L"stopped") && fixture.releases > before, "server.stop-cleans-active");
    fixture.receive(3, L"session.begin", begin_args()); fixture.drain(); require(!fixture.dispatcher->stop_from_physical_input(L"chord", old), "server.old-run-event-rejected");
    const auto current = *fixture.dispatcher->session_snapshot();
    require(fixture.dispatcher->physical_input(event_document(L"user_input", object(LR"({"kind":"click"})")), current, true), "server.physical-pause");
    fixture.receive(4, L"session.update", object(LR"({"paused":false})")); fixture.drain(); require(fixture.code(4, L"changed"), "server.physical-pause-no-update-resume");
  });
  test([] {
    Fixture fixture(1); fixture.begin(); fixture.dispatcher->register_handler(L"synthetic.read", 1000, true, false, [](const auto&, const auto&, auto) {});
    fixture.receive(2, L"synthetic.read"); fixture.receive(3, L"synthetic.read"); fixture.receive(4, L"synthetic.read"); fixture.receive(2, L"synthetic.read"); fixture.drain();
    require(fixture.code(4, L"busy") && fixture.code(2, L"failed"), "server.queue-count-and-active-duplicate");
    Fixture bytes(1000, 4); bytes.receive(1, L"conformance.unknown"); bytes.drain(); require(bytes.code(1, L"busy"), "server.ingress-byte-bound");
  });
  test([] {
    Fixture fixture; fixture.begin(); OperationContext context;
    fixture.dispatcher->register_handler(L"synthetic.write", 1000, true, true, [&](const auto&, const auto& value, auto) { context = value; });
    fixture.receive(2, L"synthetic.write"); fixture.workers(); fixture.receive(3, L"shutdown");
    require(fixture.dispatcher->closed() && !context.is_current() && fixture.stops == 0, "server.shutdown-revokes-before-output");
    fixture.outputs(); require(fixture.reply(3).GetNamedBoolean(L"ok") && fixture.stops == 1, "server.shutdown-ack-before-exit");
    fixture.dispatcher->close(); require(fixture.stops == 1, "server.close-once");
  });
  test([] {
    Fixture fixture; fixture.write_ok = false; fixture.receive(1, L"permissions.status"); fixture.drain();
    require(fixture.dispatcher->closed() && fixture.stops == 1 && fixture.releases > 0, "server.failed-output-closes-and-releases");
    Fixture bounded(1000, 2 * kMaxFrameBytes, 4); bounded.receive(1, L"permissions.status");
    require(bounded.dispatcher->closed() && bounded.stops == 1, "server.output-backpressure-closes");
  });
  test([] {
    Fixture fixture; fixture.begin(); OperationContext context; Dispatcher::Completion complete;
    fixture.dispatcher->register_handler(L"synthetic.write", 1000, true, true, [&](const auto&, const auto& value, auto done) { context = value; complete = done; });
    fixture.receive(2, L"synthetic.write"); fixture.workers(); const auto before = fixture.releases;
    fixture.dispatcher->close(L"parent-death"); fixture.dispatcher->close(L"eof"); int writes = 0;
    require(!context.with_current([&] { ++writes; }) && writes == 0 && fixture.stops == 1 && fixture.releases > before, "server.parent-close-revokes-releases");
    complete(Reply{}); fixture.outputs(); require(fixture.replies(2) == 0, "server.closed-late-reply-suppressed");
  });
  test([] {
    Fixture fixture(1000, 2 * kMaxFrameBytes, 2 * kMaxFrameBytes + 8, false);
    fixture.receive(1, L"hello", object(LR"({"protocol":{"min":1,"max":1}})")); fixture.receive(2, L"session.begin", begin_args()); fixture.drain();
    require(!fixture.reply(1).GetNamedBoolean(L"responsible") && fixture.code(2, L"responsible_missing"), "server.unverified-caller-no-session");
  });
  test([] {
    Fixture fixture; fixture.begin(); OperationContext context;
    fixture.dispatcher->register_handler(L"synthetic.read", 1000, true, false, [&](const auto&, const auto& value, auto) { context = value; });
    auto snapshot = fixture.dispatcher->session_snapshot(); snapshot->vector_pids.Append(JsonValue::CreateNumberValue(42));
    fixture.announced.back().overlay_window_ids.Append(JsonValue::CreateStringValue(L"fabricated"));
    fixture.receive(2, L"synthetic.read"); fixture.workers(); context.session->approved.Append(object(LR"({"unexpected":true})"));
    const auto live = fixture.dispatcher->session_snapshot();
    require(live->vector_pids.Size() == 0 && live->overlay_window_ids.Size() == 0 && live->approved.Size() == 0 && context.is_current(), "server.snapshot-array-ownership-private");
  });
  test([] {
    for (const auto control_op : {L"cancel", L"input.releaseAll"}) {
      Fixture fixture; fixture.begin();
      fixture.dispatcher->register_handler(L"synthetic.read", 1000, true, false, [](const auto&, const auto&, auto done) { done(Reply{object(LR"({"private":"retired"})"), {9}}); });
      fixture.receive(2, L"synthetic.read"); fixture.workers(); const auto before = fixture.releases;
      fixture.receive(3, control_op); fixture.outputs();
      require(fixture.code(2, L"changed") && !fixture.reply(2).HasKey(L"private") && fixture.delivered[1].image.empty() && fixture.releases > before,
          "server.priority-control-retires-completed-output");
    }
  });
  test([] {
    Fixture fixture; fixture.begin();
    const auto old = *fixture.dispatcher->session_snapshot();
    require(fixture.dispatcher->physical_input(event_document(L"user_input", object(LR"({"kind":"click"})")), old, false), "server.pending-real-event");
    fixture.dispatcher->notify_display_change(); fixture.outputs();
    require(std::none_of(fixture.delivered.begin(), fixture.delivered.end(), [](const auto& value) { return value.value.HasKey(L"id") && safe_integer(value.value.Lookup(L"id")) == 0; }), "server.stale-event-never-id-zero-response");
    require(!fixture.dispatcher->stop_from_physical_input(L"chord", old), "server.display-retirement-rejects-old-native-callback");
    const auto fresh = *fixture.dispatcher->session_snapshot();
    require(fixture.dispatcher->physical_input(event_document(L"user_input", object(LR"({"kind":"click"})")), fresh, true), "server.fresh-physical-event");
    require(!fixture.dispatcher->stop_from_physical_input(L"chord", fresh), "server.physical-retirement-rejects-old-native-callback");
  });
  test([] {
    Fixture fixture; fixture.begin();
    fixture.dispatcher->register_handler(L"synthetic.write", 1000, true, true, [](const auto&, const auto&, auto done) { done(Failure{L"failed", L"Synthetic failure after an attempted mutation."}); });
    const auto before = fixture.releases; fixture.receive(2, L"synthetic.write"); fixture.drain();
    require(fixture.code(2, L"failed") && fixture.releases > before && std::find(fixture.cleanup.begin(), fixture.cleanup.end(), L"error") != fixture.cleanup.end(), "server.failed-mutation-releases-before-next-operation");
  });
  test([] {
    Fixture fixture; fixture.begin(); fixture.dispatcher->register_handler(L"synthetic.read", 10000, true, false, [](const auto&, const auto&, auto) {});
    for (uint64_t id = 2; id < 202; ++id) fixture.receive(id, L"synthetic.read");
    // Cancellation can exhaust the bounded reply queue; closure must not invalidate a live deque iterator.
    fixture.receive(202, L"session.end"); fixture.outputs();
    require(fixture.dispatcher->closed() && fixture.stops == 1, "server.cancel-backpressure-safe-iteration");
  });
  test([] {
    Fixture fixture; fixture.begin(); OperationContext context; Dispatcher::Completion done;
    fixture.dispatcher->register_handler(L"synthetic.write", 100, true, true, [&](const auto&, const auto& value, auto finish) { context = value; done = finish; });
    fixture.receive(2, L"synthetic.write"); fixture.workers(); fixture.time += 101;
    int posts = 0; require(!context.with_current([&] { ++posts; }) && posts == 0, "server.actual-deadline-before-delayed-timer");
    done(Reply{}); fixture.outputs(); require(fixture.code(2, L"timeout"), "server.expired-completion-is-timeout");
  });
  test([] {
    Fixture fixture; fixture.receive(1, L"permissions.status");
    require(!fixture.dispatcher->wait_for_output(0), "server.output-retirement-requires-closed-authority");
    fixture.dispatcher->close(L"eof");
    require(fixture.dispatcher->wait_for_output(0), "server.closed-injected-output-is-idle");
    fixture.outputs(); require(fixture.delivered.empty(), "server.close-drops-queued-wire-output");
  });
  return groups;
}
}
