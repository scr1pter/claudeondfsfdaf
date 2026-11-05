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
enum class CleanupMode { synchronous, deferred, prepared };
struct Fixture {
  uint64_t time = 100;
  std::deque<Task> work, output, cleanup_work;
  std::vector<Dispatcher::CleanupCompletion> cleanup_completions;
  std::vector<uint32_t> prepared_baselines;
  std::vector<std::shared_ptr<Timer>> timers;
  std::vector<Delivered> delivered;
  std::vector<std::wstring> cleanup;
  std::vector<ServerSession> announced;
  uint32_t releases = 0, invalidations = 0, stops = 0;
  bool write_ok = true, available = true, ready = true, receiving = false, throw_cleanup = false;
  std::unique_ptr<Dispatcher> dispatcher;
  explicit Fixture(CleanupMode mode) : Fixture(1000, 2 * kMaxFrameBytes, 2 * kMaxFrameBytes + 8, true, mode != CleanupMode::synchronous, mode == CleanupMode::prepared) {}
  explicit Fixture(size_t queue_limit = 1000, size_t byte_limit = 2 * kMaxFrameBytes, size_t output_limit = 2 * kMaxFrameBytes + 8, bool responsible = true, bool deferred_cleanup = false, bool prepared_cleanup = false) {
    Dispatcher::Options options;
    options.send = [this](const JsonObject& value, std::span<const uint8_t> image) {
      if (!write_ok) return false;
      delivered.push_back(Delivered{JsonObject::Parse(value.Stringify()), {image.begin(), image.end()}}); return true;
    };
    options.stopped = [this] { ++stops; };
    options.release_all = [this] { return ++releases; };
    if (deferred_cleanup) {
      options.cleanup_execute = [this](Task task) { cleanup_work.push_back(std::move(task)); };
      if (prepared_cleanup) options.prepare_release_all = [this] {
        const auto baseline = ++releases;
        return [this, baseline](Dispatcher::CleanupCompletion done) {
          require(!receiving, "server.prepared-cleanup-outside-ingress");
          prepared_baselines.push_back(baseline); cleanup_completions.push_back(std::move(done));
        };
      };
      else options.release_all_async = [this](Dispatcher::CleanupCompletion done) {
        require(!receiving, "server.cleanup-outside-ingress");
        if (throw_cleanup) throw std::runtime_error("server.synthetic-cleanup-provider-failure");
        cleanup_completions.push_back(std::move(done));
      };
    }
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
  void cleaners() { for (size_t count = 0; !cleanup_work.empty(); ++count) { require(count < 2000, "server.cleanup-bound"); auto task = std::move(cleanup_work.front()); cleanup_work.pop_front(); task(); } }
  void outputs() { for (size_t count = 0; !output.empty(); ++count) { require(count < 2000, "server.output-bound"); auto task = std::move(output.front()); output.pop_front(); task(); } }
  void drain() { workers(); outputs(); }
  void receive(uint64_t id, std::wstring_view op, JsonObject args = {}) { receiving = true; dispatcher->receive(request(id, op, std::move(args))); receiving = false; }
  void begin(std::optional<uint64_t> revision = {}) { receive(1, L"session.begin", begin_args(revision)); drain(); }
  void begin_deferred(std::optional<uint64_t> revision = {}) { begin(revision); cleaners(); require(cleanup_completions.size() == 1, "server.begin-cleanup-prepared"); cleanup_completions[0](true, 0); drain(); }
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
  test([] {
    Fixture fixture(CleanupMode::deferred); size_t writes = 0;
    fixture.dispatcher->register_handler(L"synthetic.write", 1000, true, true, [&](const auto&, const auto&, auto done) { ++writes; done(Reply{}); });
    fixture.begin(); fixture.receive(2, L"synthetic.write"); fixture.receive(3, L"permissions.status"); fixture.drain();
    require(fixture.replies(1) == 0 && fixture.code(2, L"unavailable") && fixture.reply(3).GetNamedString(L"screen") == L"n/a" && writes == 0, "server.pending-begin-cleanup-inhibits-mutations-only");
    require(fixture.cleanup_completions.empty() && fixture.cleanup_work.size() == 1, "server.cleanup-never-inline-under-control-ingress");
    fixture.cleaners(); fixture.cleanup_completions[0](true, 0); fixture.drain();
    fixture.receive(4, L"synthetic.write"); fixture.drain();
    require(fixture.reply(1).GetNamedBoolean(L"ok") && fixture.reply(4).GetNamedBoolean(L"ok") && writes == 1, "server.confirmed-begin-cleanup-admits-mutations");
  });
  test([] {
    Fixture fixture(CleanupMode::deferred); fixture.begin_deferred(); OperationContext context;
    fixture.dispatcher->register_handler(L"input.key", 1000, true, true, [&](const auto&, const auto& actual, auto) { context = actual; });
    fixture.receive(2, L"input.key"); fixture.workers(); fixture.receive(3, L"input.releaseAll"); fixture.drain();
    require(!context.is_current() && fixture.replies(2) == 0 && fixture.replies(3) == 0, "server.release-revokes-before-confirmation");
    fixture.cleaners(); fixture.cleanup_completions[1](true, 3); fixture.drain();
    require(fixture.code(2, L"failed") && fixture.reply(3).GetNamedBoolean(L"ok") && fixture.reply(3).GetNamedNumber(L"released") == 3, "server.release-count-and-interrupted-operation-follow-actual-up-receipts");
    fixture.cleanup_completions[1](false, 0); fixture.drain(); require(fixture.replies(3) == 1, "server.duplicate-cleanup-callback-inert");
  });
  test([] {
    Fixture fixture(CleanupMode::deferred); fixture.begin_deferred(); OperationContext context;
    fixture.dispatcher->register_handler(L"synthetic.write", 1000, true, true, [&](const auto&, const auto& actual, auto) { context = actual; });
    fixture.receive(2, L"synthetic.write"); fixture.receive(3, L"synthetic.write"); fixture.workers();
    fixture.receive(4, L"cancel", object(LR"({"target":2})")); fixture.drain();
    require(!context.is_current() && fixture.replies(2) == 0 && fixture.code(3, L"changed") && fixture.replies(4) == 0, "server.cancel-ack-waits-for-owned-release");
    fixture.cleaners(); fixture.cleanup_completions[1](true, 2); fixture.drain(); require(fixture.code(2, L"failed") && fixture.reply(4).GetNamedBoolean(L"ok"), "server.cancel-ack-and-interrupted-operation-after-cleanup");
  });
  test([] {
    Fixture fixture(CleanupMode::deferred); fixture.begin_deferred(); size_t writes = 0;
    fixture.dispatcher->register_handler(L"synthetic.write", 1000, true, true, [&](const auto&, const auto&, auto done) { ++writes; done(Reply{}); });
    fixture.receive(2, L"input.releaseAll"); fixture.cleaners(); fixture.cleanup_completions[1](false, 1); fixture.drain();
    fixture.receive(3, L"synthetic.write"); fixture.drain();
    require(fixture.code(2, L"failed") && !fixture.reply(2).HasKey(L"released") && fixture.code(3, L"unavailable") && writes == 0, "server.failed-cleanup-does-not-claim-release-or-admit-writes");
    fixture.cleanup_completions[1](true, 100); fixture.receive(4, L"synthetic.write"); fixture.drain();
    require(fixture.code(4, L"unavailable"), "server.failed-ticket-late-success-cannot-clear-debt");
    fixture.receive(5, L"input.releaseAll"); fixture.cleaners(); fixture.cleanup_completions[2](true, 1); fixture.drain();
    fixture.receive(6, L"synthetic.write"); fixture.drain(); require(fixture.reply(6).GetNamedBoolean(L"ok") && writes == 1, "server.new-confirmed-cleanup-retires-debt");
  });
  test([] {
    Fixture fixture(CleanupMode::deferred); fixture.begin_deferred();
    fixture.receive(2, L"input.releaseAll"); fixture.cleaners(); fixture.time += 750;
    fixture.cleanup_completions[1](true, 2); fixture.drain();
    require(fixture.code(2, L"failed") && !fixture.reply(2).HasKey(L"released"), "server.cleanup-deadline-checked-before-delayed-timer");
    fixture.advance(1); require(fixture.replies(2) == 1, "server.cleanup-timeout-one-reply");
  });
  test([] {
    Fixture fixture(CleanupMode::deferred); fixture.begin_deferred(4); size_t writes = 0;
    fixture.dispatcher->register_handler(L"synthetic.write", 1000, true, true, [&](const auto&, const auto&, auto done) { ++writes; done(Reply{}); });
    fixture.receive(2, L"input.releaseAll"); fixture.cleaners(); const auto old = *fixture.dispatcher->session_snapshot();
    fixture.receive(3, L"session.begin", begin_args(4)); fixture.cleaners(); fixture.drain();
    require(fixture.replies(2) == 0 && fixture.replies(3) == 0 && fixture.dispatcher->session_snapshot()->run_epoch != old.run_epoch, "server.replacement-carries-old-control-without-early-terminal");
    fixture.cleanup_completions[1](true, 99); fixture.receive(4, L"synthetic.write", object(LR"({"sessionId":"synthetic","phaseRevision":4})")); fixture.drain();
    require(fixture.code(4, L"unavailable") && fixture.replies(3) == 0 && writes == 0, "server.old-run-cleanup-cannot-admit-replacement");
    fixture.cleanup_completions[2](true, 0); fixture.drain(); fixture.receive(5, L"synthetic.write", object(LR"({"sessionId":"synthetic","phaseRevision":4})")); fixture.drain();
    require(fixture.code(2, L"changed") && fixture.reply(3).GetNamedBoolean(L"ok") && fixture.reply(5).GetNamedBoolean(L"ok") && writes == 1 && fixture.replies(2) == 1, "server.new-run-own-cleanup-confirms-authority-and-old-control-error");
  });
  test([] {
    Fixture fixture(CleanupMode::deferred); fixture.begin_deferred(4);
    fixture.receive(2, L"input.releaseAll"); fixture.cleaners(); const auto old = *fixture.dispatcher->session_snapshot();
    fixture.receive(3, L"session.update", object(LR"({"sessionId":"synthetic","phaseRevision":4,"escStops":false})")); fixture.cleaners();
    fixture.cleanup_completions[1](false, 0); fixture.outputs();
    require(fixture.replies(2) == 0 && fixture.replies(3) == 0 && fixture.dispatcher->session_snapshot()->run_epoch == old.run_epoch && fixture.dispatcher->session_snapshot()->observation_epoch != old.observation_epoch, "server.same-revision-new-observation-carries-cleanup-control");
    fixture.cleanup_completions[2](true, 0); fixture.drain(); require(fixture.code(2, L"changed") && fixture.reply(3).GetNamedBoolean(L"ok"), "server.phase-cleanup-confirms-current-and-retired-control-independently");
  });
  test([] {
    Fixture fixture(CleanupMode::deferred); fixture.begin_deferred(); OperationContext context;
    fixture.dispatcher->register_handler(L"input.key", 1000, true, true, [&](const auto&, const auto& actual, auto) { context = actual; });
    fixture.receive(2, L"input.key"); fixture.workers(); const auto old = *fixture.dispatcher->session_snapshot();
    require(fixture.dispatcher->stop_from_physical_input(L"esc", old), "server.deferred-stop-admitted"); fixture.drain();
    const auto stop_events = [&] { return std::count_if(fixture.delivered.begin(), fixture.delivered.end(), [](const auto& value) { return value.value.HasKey(L"event") && value.value.GetNamedString(L"event") == L"stop"; }); };
    require(!context.is_current() && fixture.replies(2) == 0 && stop_events() == 0, "server.stop-event-and-interrupted-operation-wait-for-owned-ups");
    fixture.cleaners(); fixture.cleanup_completions[1](true, 2); fixture.drain(); require(fixture.code(2, L"stopped") && stop_events() == 1, "server.stop-event-after-confirmed-cleanup");
  });
  test([] {
    Fixture fixture(CleanupMode::deferred); fixture.begin_deferred();
    require(fixture.dispatcher->stop_from_physical_input(L"chord", *fixture.dispatcher->session_snapshot()), "server.failing-stop-admitted");
    fixture.cleaners(); fixture.cleanup_completions[1](false, 0); fixture.drain(); fixture.cleanup_completions[1](true, 1); fixture.drain();
    require(std::none_of(fixture.delivered.begin(), fixture.delivered.end(), [](const auto& value) { return value.value.HasKey(L"event") && value.value.GetNamedString(L"event") == L"stop"; }), "server.failed-cleanup-never-publishes-stop-success");
    fixture.dispatcher->register_handler(L"input.key", 1000, true, true, [](const auto&, const auto&, auto) {});
    fixture.receive(2, L"input.key"); fixture.drain(); require(fixture.code(2, L"stopped"), "server.failed-stop-remains-halted");
  });
  test([] {
    Fixture fixture(CleanupMode::deferred); fixture.begin_deferred(); auto event = event_document(L"user_input", object(LR"({"kind":"click"})"));
    require(fixture.dispatcher->physical_input(event, *fixture.dispatcher->session_snapshot(), true), "server.deferred-physical-takeover");
    event.Insert(L"kind", JsonValue::CreateStringValue(L"substituted")); fixture.outputs();
    require(std::none_of(fixture.delivered.begin(), fixture.delivered.end(), [](const auto& value) { return value.value.HasKey(L"event"); }), "server.takeover-publication-waits-cleanup");
    fixture.cleaners(); fixture.cleanup_completions[1](true, 1); fixture.drain();
    const auto found = std::find_if(fixture.delivered.begin(), fixture.delivered.end(), [](const auto& value) { return value.value.HasKey(L"event"); });
    require(found != fixture.delivered.end() && found->value.GetNamedString(L"kind") == L"click", "server.deferred-event-private-snapshot");
  });
  test([] {
    Fixture fixture(CleanupMode::deferred); fixture.begin_deferred(); fixture.receive(2, L"input.releaseAll"); fixture.cleaners();
    const auto before = fixture.releases; fixture.dispatcher->close(L"parent-death"); fixture.cleanup_completions[1](true, 1); fixture.drain();
    require(fixture.dispatcher->closed() && fixture.stops == 1 && fixture.releases > before && fixture.replies(2) == 0, "server.emergency-close-does-not-await-cleanup-callback");
  });
  test([] {
    Fixture fixture(CleanupMode::deferred);
    for (uint64_t id = 1; id <= 128; ++id) fixture.receive(id, L"input.releaseAll");
    fixture.receive(129, L"input.releaseAll"); fixture.outputs();
    require(fixture.cleanup_work.size() == 128 && fixture.code(129, L"busy") && !fixture.dispatcher->closed(), "server.cleanup-control-count-is-bounded");
    fixture.cleaners(); require(fixture.cleanup_completions.size() == 128, "server.cleanup-executor-has-finite-pending-work");
  });
  test([] {
    Fixture fixture(CleanupMode::deferred); fixture.begin_deferred(); fixture.receive(2, L"input.releaseAll"); fixture.receive(2, L"cancel"); fixture.outputs();
    require(fixture.code(2, L"failed") && fixture.cleanup_work.size() == 1, "server.pending-cleanup-request-id-is-reserved");
  });
  test([] {
    Fixture fixture(CleanupMode::prepared); fixture.begin_deferred(); fixture.receive(2, L"input.releaseAll");
    const auto baseline = fixture.releases; fixture.releases += 100; fixture.cleaners();
    require(fixture.prepared_baselines.back() == baseline, "server.cleanup-preparation-retains-immutable-revocation-baseline");
    fixture.cleanup_completions[1](true, 4); fixture.drain(); require(fixture.reply(2).GetNamedNumber(L"released") == 4, "server.prepared-count-uses-actual-completion");
  });
  test([] {
    Fixture fixture(CleanupMode::deferred); fixture.begin_deferred(); fixture.receive(2, L"input.releaseAll"); fixture.cleaners();
    fixture.cleanup_completions[1](true, 1);
    fixture.receive(3, L"session.update", object(LR"({"escStops":false})")); fixture.outputs();
    require(fixture.code(2, L"changed") && fixture.replies(3) == 0, "server.confirmed-cleanup-ack-rechecks-authority-at-wire-publication");
  });
  test([] {
    Fixture fixture(CleanupMode::deferred); fixture.begin_deferred(); size_t writes = 0;
    fixture.dispatcher->register_handler(L"synthetic.write", 1000, true, true, [&](const auto&, const auto&, auto done) {
      if (++writes == 1) done(Failure{L"failed", L"Synthetic attempted write failed."}); else done(Reply{});
    });
    fixture.receive(2, L"synthetic.write"); fixture.drain(); fixture.receive(3, L"synthetic.write"); fixture.drain();
    require(fixture.replies(2) == 0 && fixture.code(3, L"unavailable") && writes == 1, "server.failed-mutation-error-and-successor-wait-for-cleanup");
    fixture.cleaners(); fixture.cleanup_completions[1](true, 1); fixture.receive(4, L"synthetic.write"); fixture.drain();
    require(fixture.code(2, L"failed") && fixture.reply(4).GetNamedBoolean(L"ok") && writes == 2, "server.successor-after-attempted-write-release-confirmation");
  });
  test([] {
    Fixture fixture(CleanupMode::deferred); fixture.begin_deferred(); OperationContext context;
    fixture.dispatcher->register_handler(L"input.key", 1000, true, true, [&](const auto&, const auto& actual, auto) { context = actual; });
    fixture.receive(2, L"input.key"); fixture.workers(); fixture.receive(3, L"cancel"); fixture.cleaners();
    fixture.cleanup_completions[1](false, 1); fixture.drain();
    require(!context.is_current() && fixture.code(2, L"failed") && fixture.code(3, L"failed") && fixture.replies(2) == 1 && !fixture.reply(3).HasKey(L"released"), "server.unconfirmed-cleanup-returns-failure-for-interrupted-operation-and-control");
    fixture.cleanup_completions[1](true, 2); fixture.drain(); require(fixture.replies(2) == 1 && fixture.replies(3) == 1, "server.late-up-proof-cannot-rewrite-terminal-errors");
  });
  test([] {
    Fixture fixture(CleanupMode::deferred); fixture.begin_deferred(4); OperationContext context;
    fixture.dispatcher->register_handler(L"input.key", 1000, true, true, [&](const auto&, const auto& actual, auto) { context = actual; });
    fixture.receive(2, L"input.key", object(LR"({"sessionId":"synthetic","phaseRevision":4})")); fixture.workers();
    fixture.receive(3, L"cancel"); fixture.cleaners(); fixture.receive(4, L"session.begin", begin_args(4)); fixture.cleaners(); fixture.drain();
    require(!context.is_current() && fixture.replies(2) == 0 && fixture.replies(3) == 0 && fixture.replies(4) == 0, "server.replacement-carries-unreleased-terminal-and-control-without-returning-early");
    fixture.cleanup_completions[1](true, 1); fixture.drain(); require(fixture.replies(2) == 0 && fixture.replies(4) == 0, "server.retired-cleanup-cannot-publish-detached-terminal");
    fixture.cleanup_completions[2](true, 1); fixture.drain();
    require(fixture.code(2, L"failed") && fixture.code(3, L"changed") && fixture.reply(4).GetNamedBoolean(L"ok") && fixture.replies(2) == 1, "server.current-cleanup-publishes-original-failed-ids-after-actual-release");
  });
  test([] {
    Fixture fixture; fixture.begin(); OperationContext context;
    fixture.dispatcher->register_handler(L"input.key", 1000, true, true, [&](const auto&, const auto& actual, auto) { context = actual; });
    fixture.receive(2, L"input.key"); fixture.workers(); fixture.receive(3, L"input.releaseAll"); fixture.drain();
    require(!context.is_current() && fixture.code(2, L"failed") && fixture.reply(3).GetNamedBoolean(L"ok") && fixture.reply(3).GetNamedNumber(L"released") > 0 && fixture.cleanup_work.empty(), "server.inline-no-input-fallback-publishes-interrupted-terminal-and-control");
  });
  test([] {
    Fixture fixture(CleanupMode::deferred); fixture.begin_deferred(); fixture.throw_cleanup = true;
    fixture.receive(2, L"input.releaseAll"); fixture.cleaners(); fixture.drain();
    require(fixture.code(2, L"failed") && !fixture.reply(2).HasKey(L"released") && fixture.cleanup_completions.size() == 1, "server.throwing-cleanup-provider-never-claims-release");
    fixture.dispatcher->register_handler(L"input.key", 1000, true, true, [](const auto&, const auto&, auto) {});
    fixture.receive(3, L"input.key"); fixture.drain(); require(fixture.code(3, L"unavailable"), "server.throwing-cleanup-retains-mutation-debt");
  });
  test([] {
    Fixture fixture(CleanupMode::deferred); fixture.begin_deferred(); fixture.receive(2, L"input.releaseAll"); fixture.cleaners();
    fixture.time += 700; fixture.receive(3, L"session.begin", begin_args()); fixture.cleaners();
    fixture.time += 50; fixture.cleanup_completions[2](true, 1); fixture.drain();
    require(fixture.code(2, L"failed") && fixture.code(3, L"failed") && !fixture.reply(2).HasKey(L"released"), "server.replacement-cannot-extend-original-cleanup-deadline-or-claim-late-release");
    fixture.cleanup_completions[1](true, 1); fixture.drain(); require(fixture.replies(2) == 1 && fixture.replies(3) == 1, "server.expired-carried-controls-ignore-old-completion");
  });
  test([] {
    Fixture fixture(CleanupMode::deferred);
    for (uint64_t id = 1; id <= 128; ++id) fixture.receive(id, L"session.begin", begin_args());
    const auto accepted_run = fixture.dispatcher->session_snapshot()->run_epoch;
    fixture.receive(129, L"session.begin", begin_args()); fixture.outputs();
    require(fixture.code(129, L"busy") && fixture.cleanup_work.size() == 128 && fixture.dispatcher->session_snapshot()->run_epoch == accepted_run, "server.retired-control-metadata-count-is-bounded-before-new-authority");
    fixture.cleaners(); require(fixture.cleanup_completions.size() == 1, "server.retired-preparations-never-start-late-cleanup-providers");
    fixture.cleanup_completions[0](true, 0); fixture.outputs();
    require(fixture.code(1, L"changed") && fixture.code(127, L"changed") && fixture.reply(128).GetNamedBoolean(L"ok") && !fixture.dispatcher->closed(), "server.bounded-retired-controls-return-only-after-current-confirmed-cleanup");
  });
  return groups;
}
}
