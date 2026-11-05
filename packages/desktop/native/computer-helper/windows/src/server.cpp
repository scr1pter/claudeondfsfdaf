#include "server.h"
#include "core.h"
#include "identity.h"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <limits>
#include <map>
#include <mutex>
#include <set>
#include <thread>
#include <utility>

namespace vector::computer {
namespace {
using JsonValueType = winrt::Windows::Data::Json::JsonValueType;
constexpr uint64_t safe_max = 9'007'199'254'740'991;
constexpr size_t frame_limit = 16'777'216;
using Task = std::function<void()>;

uint64_t monotonic_ms() {
  return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now().time_since_epoch()).count());
}
IJsonValue field(const JsonObject& object, std::wstring_view key) {
  const winrt::hstring name(key);
  return object.HasKey(name) ? object.Lookup(name) : nullptr;
}
std::optional<std::wstring> text(const IJsonValue& value, size_t maximum, bool empty = false) {
  if (!value || value.ValueType() != JsonValueType::String) return {};
  const auto string = value.GetString();
  if ((!empty && string.empty()) || string.size() > maximum || std::find(string.begin(), string.end(), L'\0') != string.end()) return {};
  return std::wstring(string.c_str(), string.size());
}
std::optional<bool> boolean(const IJsonValue& value) {
  if (!value || value.ValueType() != JsonValueType::Boolean) return {};
  return value.GetBoolean();
}
bool keys(const JsonObject& object, std::initializer_list<std::wstring_view> allowed) {
  for (const auto& pair : object) if (std::find(allowed.begin(), allowed.end(), std::wstring_view(pair.Key())) == allowed.end()) return false;
  return true;
}
bool required(const JsonObject& object, std::initializer_list<std::wstring_view> names) {
  return std::all_of(names.begin(), names.end(), [&](auto name) { return object.HasKey(winrt::hstring(name)); });
}
std::optional<JsonArray> ids(const IJsonValue& value) {
  if (!value || value.ValueType() != JsonValueType::Array) return {};
  const auto array = value.GetArray();
  if (array.Size() > 4096) return {};
  for (const auto& entry : array) if (!text(entry, 256)) return {};
  return array;
}
bool approval(const IJsonValue& value) {
  if (!value || value.ValueType() != JsonValueType::Object) return false;
  const auto object = value.GetObject();
  const auto platform = text(field(object, L"platform"), 16), kind = text(field(object, L"kind"), 16);
  if (platform != L"windows" || !boolean(field(object, L"system")) || !boolean(field(object, L"verified")) || !text(field(object, L"name"), 256)) return false;
  const auto pid_value = field(object, L"pid");
  const auto pid = safe_integer(pid_value);
  if (pid_value && (!pid || *pid == 0 || *pid > std::numeric_limits<uint32_t>::max())) return false;
  const auto exe = field(object, L"exe");
  if (exe && !text(exe, 4096)) return false;
  if (boolean(field(object, L"verified")) == false && (!exe || !pid)) return false;
  if (kind == L"aumid") {
    return keys(object, {L"platform", L"kind", L"aumid", L"publisher", L"system", L"verified", L"name", L"exe", L"pid"}) &&
        text(field(object, L"aumid"), 512).has_value() && (!field(object, L"publisher") || text(field(object, L"publisher"), 256).has_value());
  }
  return kind == L"exe" && keys(object, {L"platform", L"kind", L"publisher", L"product", L"binary", L"system", L"verified", L"name", L"exe", L"pid"}) &&
      text(field(object, L"publisher"), 256, true) && text(field(object, L"product"), 256, true) &&
      text(field(object, L"binary"), 260) && text(exe, 4096);
}
bool valid_update(const JsonObject& args) {
  if (field(args, L"sessionId") && !text(field(args, L"sessionId"), 256)) return false;
  if (field(args, L"phaseRevision") && !safe_integer(field(args, L"phaseRevision"))) return false;
  if (const auto mode = field(args, L"mode"); mode && text(mode, 16) != L"foreground" && text(mode, 16) != L"background") return false;
  for (const auto key : {L"paused", L"escStops"}) if (field(args, key) && !boolean(field(args, key))) return false;
  if (const auto approved = field(args, L"approved")) {
    if (approved.ValueType() != JsonValueType::Array || approved.GetArray().Size() > 1000) return false;
    for (const auto& entry : approved.GetArray()) if (!approval(entry)) return false;
  }
  return !field(args, L"overlayWindowIds") || ids(field(args, L"overlayWindowIds")).has_value();
}
std::optional<ServerSession> decode_session(const JsonObject& args) {
  if (!keys(args, {L"sessionId", L"phaseRevision", L"mode", L"approved", L"vectorPids", L"vectorWindowIds", L"overlayWindowIds", L"escStops", L"stopChord", L"heartbeatMs", L"paused"}) ||
      !required(args, {L"sessionId", L"mode", L"approved", L"vectorPids", L"vectorWindowIds", L"overlayWindowIds", L"escStops", L"stopChord", L"heartbeatMs"}) || !valid_update(args)) return {};
  const auto name = text(field(args, L"sessionId"), 256), mode = text(field(args, L"mode"), 16), chord = text(field(args, L"stopChord"), 64);
  const auto vector_ids = ids(field(args, L"vectorWindowIds")), overlays = ids(field(args, L"overlayWindowIds"));
  const auto escape = boolean(field(args, L"escStops"));
  const auto pids = field(args, L"vectorPids");
  if (!name || !mode || !chord || !vector_ids || !overlays || !escape || safe_integer(field(args, L"heartbeatMs")) != 2000 ||
      !pids || pids.ValueType() != JsonValueType::Array || pids.GetArray().Size() > 4096) return {};
  for (const auto& pid : pids.GetArray()) { const auto number = safe_integer(pid); if (!number || *number == 0 || *number > std::numeric_limits<uint32_t>::max()) return {}; }
  ServerSession session;
  session.id = *name; session.mode = *mode; session.revision = safe_integer(field(args, L"phaseRevision"));
  session.approved = field(args, L"approved").GetArray(); session.vector_pids = pids.GetArray();
  session.vector_window_ids = *vector_ids; session.overlay_window_ids = *overlays;
  session.esc_stops = *escape; session.paused = boolean(field(args, L"paused")).value_or(false); session.stop_chord = *chord;
  return session;
}
bool mutation(std::wstring_view op) {
  static const std::set<std::wstring_view> values{L"input.click", L"input.move", L"input.drag", L"input.scroll", L"input.key", L"input.type", L"input.hold",
      L"ui.perform", L"ui.setValue", L"app.activate", L"app.launch", L"program.launch", L"window.focus", L"clipboard.write"};
  return values.contains(op);
}
bool control(std::wstring_view op) {
  static const std::set<std::wstring_view> values{L"heartbeat", L"cancel", L"input.releaseAll", L"shutdown", L"session.begin", L"session.update", L"session.end"};
  return values.contains(op);
}
bool builtin(std::wstring_view op) { return control(op) || op == L"hello" || op == L"permissions.status"; }
JsonObject permission_document() {
  JsonObject value; value.Insert(L"screen", JsonValue::CreateStringValue(L"n/a")); value.Insert(L"accessibility", JsonValue::CreateStringValue(L"n/a")); return value;
}
JsonObject feature_document() {
  JsonObject result;
  for (const auto key : {L"capture.display", L"capture.window", L"capture.exclude", L"capture.zoom", L"cursor.position", L"input.pointer", L"input.keyboard", L"input.unicode", L"ui.tree", L"ui.actions", L"ui.secureFieldDetect", L"apps.list", L"apps.open", L"apps.resolve", L"program.launch", L"clipboard", L"stop.esc", L"stop.chord", L"userInput.detect", L"background", L"locked"}) result.Insert(key, JsonValue::CreateBooleanValue(false));
  return result;
}
std::optional<ServerSession> clone_session(const std::optional<ServerSession>& original) {
  if (!original) return {};
  auto copy = *original;
  copy.approved = JsonArray::Parse(original->approved.Stringify());
  copy.vector_pids = JsonArray::Parse(original->vector_pids.Stringify());
  copy.vector_window_ids = JsonArray::Parse(original->vector_window_ids.Stringify());
  copy.overlay_window_ids = JsonArray::Parse(original->overlay_window_ids.Stringify());
  return copy;
}

// The parent/EOF lifecycle owns the independent exit fuse. Closing these queues never joins a
// possibly blocked native handler. Detached loops retain only their own bounded queue state.
class Runtime final {
  struct Queue { std::mutex mutex; std::condition_variable condition; bool closed = false; bool finished = false; std::thread::id thread; std::deque<Task> jobs; };
  struct Clock { std::mutex mutex; std::condition_variable condition; bool closed = false; uint64_t sequence = 0; std::map<uint64_t, std::pair<uint64_t, Task>> jobs; };
  std::shared_ptr<Queue> operations_ = std::make_shared<Queue>(), output_ = std::make_shared<Queue>(), cleanup_ = std::make_shared<Queue>();
  std::shared_ptr<Clock> clock_ = std::make_shared<Clock>();
  static void run(const std::shared_ptr<Queue>& queue) {
    { std::lock_guard lock(queue->mutex); queue->thread = std::this_thread::get_id(); }
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    while (true) {
      Task task;
      { std::unique_lock lock(queue->mutex); queue->condition.wait(lock, [&] { return queue->closed || !queue->jobs.empty(); });
        if (queue->closed) break; task = std::move(queue->jobs.front()); queue->jobs.pop_front(); }
      try { task(); } catch (...) { /* Individual dispatcher tasks own fixed failure output. */ }
    }
    winrt::uninit_apartment();
    { std::lock_guard lock(queue->mutex); queue->finished = true; queue->condition.notify_all(); }
  }
 public:
  Runtime() {
    std::thread([queue = operations_] { run(queue); }).detach();
    std::thread([queue = output_] { run(queue); }).detach();
    std::thread([queue = cleanup_] { run(queue); }).detach();
    std::thread([clock = clock_] {
      winrt::init_apartment(winrt::apartment_type::multi_threaded);
      while (true) {
        Task task;
        { std::unique_lock lock(clock->mutex);
          if (clock->closed) break;
          auto next = std::min_element(clock->jobs.begin(), clock->jobs.end(), [](const auto& a, const auto& b) { return a.second.first < b.second.first; });
          if (next == clock->jobs.end()) { clock->condition.wait(lock); continue; }
          const auto now = monotonic_ms(), due = next->second.first;
          if (due > now) { clock->condition.wait_for(lock, std::chrono::milliseconds(due - now)); continue; }
          task = std::move(next->second.second); clock->jobs.erase(next); }
        try { task(); } catch (...) {}
      }
      winrt::uninit_apartment();
    }).detach();
  }
  ~Runtime() { close(); }
  Dispatcher::Execute executor(bool output) {
    return [queue = output ? output_ : operations_](Task task) {
      std::lock_guard lock(queue->mutex);
      if (!queue->closed && queue->jobs.size() < 2048) { queue->jobs.push_back(std::move(task)); queue->condition.notify_one(); }
    };
  }
  Dispatcher::Execute cleanup_executor() {
    return [queue = cleanup_](Task task) {
      std::lock_guard lock(queue->mutex);
      if (!queue->closed && queue->jobs.size() < 128) { queue->jobs.push_back(std::move(task)); queue->condition.notify_one(); }
    };
  }
  Dispatcher::Cancel schedule(uint32_t milliseconds, Task task) {
    std::lock_guard lock(clock_->mutex);
    if (clock_->closed || clock_->jobs.size() >= 2048) return [] {};
    const auto ticket = ++clock_->sequence;
    clock_->jobs.emplace(ticket, std::make_pair(monotonic_ms() + milliseconds, std::move(task))); clock_->condition.notify_one();
    return [clock = clock_, ticket] { std::lock_guard guard(clock->mutex); clock->jobs.erase(ticket); clock->condition.notify_one(); };
  }
  void close() {
    for (const auto& queue : {operations_, output_, cleanup_}) { std::lock_guard lock(queue->mutex); queue->closed = true; queue->jobs.clear(); queue->condition.notify_all(); }
    std::lock_guard lock(clock_->mutex); clock_->closed = true; clock_->jobs.clear(); clock_->condition.notify_all();
  }
  bool stop_output(std::chrono::steady_clock::time_point deadline) {
    std::unique_lock lock(output_->mutex);
    output_->closed = true; output_->jobs.clear(); output_->condition.notify_all();
    if (output_->thread == std::this_thread::get_id()) return false;
    return output_->condition.wait_until(lock, deadline, [&] { return output_->finished; });
  }
};
}

struct Dispatcher::State : std::enable_shared_from_this<Dispatcher::State> {
  struct Registration { uint32_t deadline; bool requires_session; bool mutating; Handler handler; };
  struct Queued { Request request; uint64_t generation; };
  struct Authority { uint64_t generation; std::optional<ServerSession> session; bool requires_session; bool mutating; };
  struct Active { Request request; Registration registration; Authority authority; uint64_t token; uint64_t deadline_at; Cancel timer; };
  struct Warmup { uint64_t ticket, request_id, generation, deadline_at; std::optional<ServerSession> session; uint32_t attempts = 0; Cancel timer; };
  enum class WarmupStatus { ready, waiting, expired };
  struct Terminal { Request request; std::wstring code, message; uint64_t deadline_at; };
  struct Cleanup {
    Authority authority; std::optional<Request> request; JsonObject event;
    std::vector<Terminal> terminals; size_t bytes = 0; bool report_count = false; uint64_t deadline_at = 0; Cancel timer;
  };
  struct Output { JsonObject document; std::vector<uint8_t> image; size_t bytes; std::optional<Authority> authority; uint64_t publication; bool stop = false; };
  mutable std::recursive_mutex mutex;
  std::mutex idle_mutex;
  std::condition_variable idle_condition;
  bool output_busy = false;
  Options options;
  std::shared_ptr<Runtime> runtime;
  std::map<std::wstring, Registration> handlers;
  std::deque<Queued> queue;
  std::optional<Active> active;
  std::optional<Warmup> warmup;
  std::map<uint64_t, Cleanup> releases;
  std::vector<Terminal> pending_terminals;
  std::optional<ServerSession> session;
  std::deque<Output> outputs;
  size_t pending_bytes = 0, output_bytes = 0, output_count = 0, release_bytes = 0;
  uint64_t generation = 0, token = 0, epoch = 0, publication = 0, heartbeat_ticket = 0, release_ticket = 0, warmup_ticket = 0;
  bool ended = false, halted = false, physical_pause = false, output_scheduled = false, notified_stop = false;
  bool release_failed = false;
  bool owned_output = false;
  Cancel heartbeat_timer;

  explicit State(Options supplied) : options(std::move(supplied)) {
    if (!options.execute || !options.output_execute || !options.schedule || ((options.release_all_async || options.prepare_release_all) && !options.cleanup_execute)) {
      runtime = std::make_shared<Runtime>();
      if (!options.execute) options.execute = runtime->executor(false);
      if (!options.output_execute) { options.output_execute = runtime->executor(true); owned_output = true; }
      if (!options.schedule) options.schedule = [native = runtime](auto ms, auto work) { return native->schedule(ms, std::move(work)); };
      if (!options.cleanup_execute) options.cleanup_execute = runtime->cleanup_executor();
    }
    if (!options.now) options.now = monotonic_ms;
    if (!options.features) options.features = feature_document;
    options.queue_limit = std::min<size_t>(options.queue_limit, 1000);
    options.pending_limit_bytes = std::min<size_t>(options.pending_limit_bytes, 2 * frame_limit);
    options.output_limit_bytes = std::min<size_t>(options.output_limit_bytes, 2 * frame_limit + 8);
  }
  ~State() { if (runtime) runtime->close(); }
  bool matches(const std::optional<ServerSession>& expected) const {
    if (!session || !expected) return !session && !expected;
    return session->run_epoch == expected->run_epoch && session->observation_epoch == expected->observation_epoch &&
        session->id == expected->id && session->revision == expected->revision;
  }
  bool observed(const Authority& authority) const {
    return !ended && (!authority.requires_session && !authority.session ? true : authority.generation == generation && matches(authority.session));
  }
  bool foreground_ready() const {
    const auto snapshot = clone_session(session);
    return snapshot && options.foreground_ready(*snapshot);
  }
  bool foreground_pending() const {
    const auto snapshot = clone_session(session);
    return snapshot && snapshot->mode == L"foreground" && !snapshot->paused && options.foreground_pending(*snapshot);
  }
  void cancel_warmup() {
    if (!warmup) return;
    if (warmup->timer) warmup->timer(); warmup.reset();
  }
  WarmupStatus wait_for_foreground(const Queued& queued, const Registration& registration) {
    const bool same = warmup && warmup->request_id == queued.request.id && warmup->generation == generation && matches(warmup->session);
    if (same && options.now() >= warmup->deadline_at) { cancel_warmup(); return WarmupStatus::expired; }
    const bool waiting = registration.mutating && session && session->mode == L"foreground" && !session->paused &&
      !halted && !physical_pause && releases.empty() && !release_failed && options.responsible && options.available() &&
      queued.generation == generation && !foreground_ready() && foreground_pending();
    if (!waiting) { cancel_warmup(); return WarmupStatus::ready; }
    if (!same) {
      cancel_warmup();
      const auto now = options.now();
      const auto deadline = std::numeric_limits<uint64_t>::max() - now < 1000 ? std::numeric_limits<uint64_t>::max() : now + 1000;
      if (warmup_ticket == std::numeric_limits<uint64_t>::max()) return WarmupStatus::expired;
      warmup = Warmup{++warmup_ticket, queued.request.id, generation, deadline, clone_session(session)};
    }
    if (warmup->timer) return WarmupStatus::waiting;
    if (warmup->attempts >= 100 || options.now() >= warmup->deadline_at) { cancel_warmup(); return WarmupStatus::expired; }
    const auto ticket = warmup->ticket; ++warmup->attempts;
    const auto timer = options.schedule(10, [weak = weak_from_this(), ticket] {
      const auto self = weak.lock(); if (!self) return;
      std::lock_guard lock(self->mutex);
      if (!self->warmup || self->warmup->ticket != ticket || self->ended) return;
      self->warmup->timer = {};
      if (self->warmup->generation != self->generation || !self->matches(self->warmup->session) || self->queue.empty() || self->queue.front().request.id != self->warmup->request_id) { self->cancel_warmup(); return; }
      self->pump();
    });
    if (warmup && warmup->ticket == ticket) warmup->timer = timer; else if (timer) timer();
    return WarmupStatus::waiting;
  }
  bool current(uint64_t expected) const {
    if (!active || active->token != expected || options.now() >= active->deadline_at || !observed(active->authority) || !options.available()) return false;
    return !active->registration.mutating || (!halted && !physical_pause && releases.empty() && !release_failed && session && !session->paused && foreground_ready());
  }
  void stopped() { if (!notified_stop) { notified_stop = true; options.stopped(); } }
  void changed_session() { options.session_changed(clone_session(session)); }
  void cleanup(std::wstring_view reason) { options.cleanup(reason); }
  void fail(const Request& request, std::wstring_view code, std::wstring_view message) { emit(response_failure(request.id, std::wstring(code), std::wstring(message))); }
  uint64_t cleanup_deadline() const {
    const auto now = options.now(); return std::numeric_limits<uint64_t>::max() - now < 750 ? std::numeric_limits<uint64_t>::max() : now + 750;
  }
  size_t cleanup_slots() const {
    size_t count = pending_terminals.size();
    for (const auto& item : releases) count += item.second.terminals.size() + (item.second.request ? 1 : 0);
    return count;
  }
  size_t cleanup_bytes() const {
    size_t count = release_bytes;
    for (const auto& terminal : pending_terminals) count += terminal.request.encoded_bytes;
    return count;
  }
  void retire_releases() {
    auto retired = std::move(releases); releases.clear(); release_bytes = 0;
    for (auto& item : retired) {
      if (item.second.timer) item.second.timer();
      if (!ended) for (auto& terminal : item.second.terminals) pending_terminals.push_back(std::move(terminal));
      if (!ended && item.second.request) pending_terminals.push_back({std::move(*item.second.request), L"changed", L"The computer session changed during input cleanup.", item.second.deadline_at});
    }
  }
  void finish_release(uint64_t ticket, bool complete, uint32_t count) {
    std::lock_guard lock(mutex);
    const auto found = releases.find(ticket); if (found == releases.end()) return;
    auto cleanup = std::move(found->second); releases.erase(found);
    release_bytes -= std::min(release_bytes, cleanup.bytes); if (cleanup.timer) cleanup.timer();
    if (ended) return;
    if (!observed(cleanup.authority)) {
      for (auto& terminal : cleanup.terminals) pending_terminals.push_back(std::move(terminal));
      if (cleanup.request) pending_terminals.push_back({std::move(*cleanup.request), L"changed", L"The computer session changed during input cleanup.", cleanup.deadline_at});
      release_input(); pump(); return;
    }
    if (options.now() >= cleanup.deadline_at) complete = false;
    // Only the current exact authority may clear a failed cleanup latch. A successful provider
    // result means all its outstanding owned-input debt has actual matching UP receipts.
    release_failed = !complete;
    for (const auto& terminal : cleanup.terminals) {
      if (complete) fail(terminal.request, terminal.code, terminal.message);
      else fail(terminal.request, L"failed", L"Owned input cleanup was not confirmed.");
      if (ended) return;
    }
    if (cleanup.request) {
      if (!complete) fail(*cleanup.request, L"failed", L"Owned input cleanup was not confirmed.");
      else {
        JsonObject fields; if (cleanup.report_count) fields.Insert(L"released", JsonValue::CreateNumberValue(count));
        emit(response_success(cleanup.request->id, fields), {}, cleanup.authority);
      }
    }
    if (complete && cleanup.event.Size()) emit(cleanup.event, {}, cleanup.authority);
    pump();
  }
  void release_input(std::optional<Request> request = {}, bool report_count = false, JsonObject event = {}) {
    if (ended) { options.release_all(); return; }
    release_failed = true;
    const auto count = options.prepare_release_all ? 0U : options.release_all();
    const auto prepared = options.prepare_release_all ? options.prepare_release_all() : options.release_all_async;
    if (!prepared && options.prepare_release_all) {
      auto terminals = std::move(pending_terminals); pending_terminals.clear();
      for (const auto& terminal : terminals) { fail(terminal.request, L"failed", L"Owned input cleanup could not be prepared."); if (ended) return; }
      if (request) fail(*request, L"failed", L"Owned input cleanup could not be prepared."); return;
    }
    if (!prepared) {
      release_failed = false;
      auto terminals = std::move(pending_terminals); pending_terminals.clear();
      for (const auto& terminal : terminals) { fail(terminal.request, terminal.code, terminal.message); if (ended) return; }
      if (request) { JsonObject fields; if (report_count) fields.Insert(L"released", JsonValue::CreateNumberValue(count)); emit(response_success(request->id, fields)); }
      if (event.Size()) emit(event, {}, Authority{generation, session, true, false});
      return;
    }
    auto bytes = request ? request->encoded_bytes : size_t{0};
    for (const auto& terminal : pending_terminals) bytes += terminal.request.encoded_bytes;
    if (releases.size() >= 128 || cleanup_slots() + (request ? 1 : 0) > 128 || bytes > options.pending_limit_bytes - std::min(release_bytes, options.pending_limit_bytes) || release_ticket == std::numeric_limits<uint64_t>::max()) {
      release_failed = true; if (request) fail(*request, L"busy", L"The input cleanup queue is full."); return;
    }
    const auto ticket = ++release_ticket;
    event = JsonObject::Parse(event.Stringify());
    const auto now = options.now();
    auto deadline = cleanup_deadline();
    for (const auto& terminal : pending_terminals) deadline = std::min(deadline, terminal.deadline_at);
    auto terminals = std::move(pending_terminals); pending_terminals.clear();
    releases.emplace(ticket, Cleanup{Authority{generation, clone_session(session), true, false}, std::move(request), std::move(event), std::move(terminals), bytes, report_count, deadline, {}});
    release_bytes += bytes;
    const auto delay = deadline <= now ? 0U : static_cast<uint32_t>(std::min<uint64_t>(750, deadline - now));
    const auto timer = options.schedule(delay, [weak = weak_from_this(), ticket] {
      if (const auto self = weak.lock()) self->finish_release(ticket, false, 0);
    });
    if (const auto found = releases.find(ticket); found != releases.end()) found->second.timer = timer; else if (timer) timer();
    options.cleanup_execute([weak = weak_from_this(), ticket, prepared] {
      const auto self = weak.lock(); if (!self) return;
      { std::lock_guard lock(self->mutex); if (self->ended || !self->releases.contains(ticket)) return; }
      // No Dispatcher lock is held while the provider talks to its independent release guardian.
      try { prepared([weak, ticket](bool complete, uint32_t count) { if (const auto current = weak.lock()) current->finish_release(ticket, complete, count); }); }
      catch (...) { self->finish_release(ticket, false, 0); }
    });
  }
  void emit(JsonObject document, std::vector<uint8_t> image = {}, std::optional<Authority> authority = {}, bool stop = false) {
    document = JsonObject::Parse(document.Stringify());
    const auto size = encoded_size(document);
    if (size > frame_limit || image.size() > frame_limit || size + image.size() + 8 > options.output_limit_bytes - std::min(output_bytes, options.output_limit_bytes) || output_count >= 128) {
      outputs.clear(); output_bytes = 0; output_count = 0; close(L"output-backpressure"); stopped(); return;
    }
    const auto count = size + image.size() + 8;
    outputs.push_back(Output{std::move(document), std::move(image), count, std::move(authority), publication, stop}); output_bytes += count; ++output_count;
    if (output_scheduled) return;
    output_scheduled = true;
    options.output_execute([weak = weak_from_this()] { if (const auto self = weak.lock()) self->drain_output(); });
  }
  void drain_output() {
    std::lock_guard lock(mutex);
    if (!outputs.empty()) {
      { std::lock_guard idle(idle_mutex); output_busy = true; }
      auto output = std::move(outputs.front()); outputs.pop_front();
      bool delivered = false;
      try {
        if (output.authority && (!observed(*output.authority) || output.publication != publication)) {
          const auto id = safe_integer(field(output.document, L"id"));
          // A retired native event is dropped; it must never become an id=0 request response.
          delivered = !id || (options.send && options.send(response_failure(*id, L"changed", L"The native observation changed before delivery."), {}));
        } else if (output.document.HasKey(L"event") && !options.native_event_current(output.document, output.authority ? output.authority->session : std::optional<ServerSession>{})) delivered = true;
        else delivered = options.send && options.send(output.document, output.image);
      } catch (...) { delivered = false; }
      output_bytes -= std::min(output_bytes, output.bytes);
      output_count -= std::min<size_t>(output_count, 1);
      if (!delivered) {
        outputs.clear(); output_bytes = 0; output_count = 0; output_scheduled = false;
        { std::lock_guard idle(idle_mutex); output_busy = false; idle_condition.notify_all(); }
        close(L"output-failure"); stopped(); return;
      }
      if (output.stop) stopped();
      { std::lock_guard idle(idle_mutex); output_busy = false; idle_condition.notify_all(); }
    }
    if (outputs.empty()) output_scheduled = false;
    else options.output_execute([weak = weak_from_this()] { if (const auto self = weak.lock()) self->drain_output(); });
  }
  void cancel_active(std::wstring_view code, std::wstring_view message) {
    if (!active) return;
    const auto request = active->request; const bool deferred = active->registration.mutating && (options.prepare_release_all || options.release_all_async);
    if (active->timer) active->timer(); active.reset();
    pending_bytes -= std::min(pending_bytes, request.encoded_bytes);
    if (deferred) pending_terminals.push_back({request, std::wstring(code), std::wstring(message), cleanup_deadline()});
    else fail(request, code, message);
  }
  void cancel_queue(bool only_mutations, std::wstring_view code = L"changed") {
    std::vector<Request> cancelled;
    for (auto it = queue.begin(); it != queue.end();) {
      if (only_mutations && !mutation(it->request.op) && !(handlers.contains(it->request.op) && handlers.at(it->request.op).mutating)) { ++it; continue; }
      auto request = it->request; it = queue.erase(it); pending_bytes -= std::min(pending_bytes, request.encoded_bytes); cancelled.push_back(std::move(request));
    }
    // A bounded output refusal can close/clear the live queue; never retain its iterators across emit.
    for (const auto& request : cancelled) { if (ended) break; fail(request, code, L"The native operation was cancelled."); }
  }
  void invalidate() {
    cancel_warmup();
    ++generation; ++publication; if (session) session->observation_epoch = ++epoch; options.observations_invalidated();
    retire_releases();
    cancel_active(L"changed", L"The computer session changed."); cancel_queue(false);
  }
  void close(std::wstring_view reason, bool notify = true) {
    if (ended) { if (notify) stopped(); return; }
    ended = true; halted = true; ++generation;
    cancel_warmup();
    retire_releases();
    pending_terminals.clear();
    outputs.clear(); output_bytes = 0; output_count = 0;
    if (heartbeat_timer) heartbeat_timer(); heartbeat_timer = {};
    options.observations_invalidated(); cleanup(reason); options.release_all();
    if (active && active->timer) active->timer(); active.reset(); queue.clear(); pending_bytes = 0;
    session.reset(); changed_session();
    if (notify) stopped();
  }
  void arm_heartbeat() {
    if (heartbeat_timer) heartbeat_timer();
    const auto ticket = ++heartbeat_ticket;
    heartbeat_timer = options.schedule(5000, [weak = weak_from_this(), ticket] {
      if (const auto self = weak.lock()) {
        std::lock_guard lock(self->mutex);
        if (self->ended || !self->session || self->heartbeat_ticket != ticket) return;
        self->heartbeat_timer = {}; self->cancel_warmup(); self->halted = true; self->session->paused = true; self->session->esc_stops = false;
        ++self->generation; ++self->publication; self->session->observation_epoch = ++self->epoch;
        self->options.observations_invalidated(); self->retire_releases(); self->cleanup(L"heartbeat");
        self->cancel_active(L"stopped", L"Input stopped because no heartbeat arrived."); self->cancel_queue(true, L"stopped");
        self->changed_session(); self->release_input(); self->pump();
      }
    });
  }
  void expire(uint64_t selected) {
    std::lock_guard lock(mutex);
    if (!active || active->token != selected) return;
    cleanup(L"timeout");
    const bool mutating = active->registration.mutating;
    if (mutating) { halted = true; cancel_queue(true, L"stopped"); }
    cancel_active(L"timeout", L"The native operation timed out."); if (mutating) release_input(); pump();
  }
  bool builtin_request(const Request& request) {
    const auto& args = request.args;
    if (request.op == L"hello") {
      const auto protocol = field(args, L"protocol");
      if (!keys(args, {L"protocol"}) || !protocol || protocol.ValueType() != JsonValueType::Object || !keys(protocol.GetObject(), {L"min", L"max"})) { fail(request, L"failed", L"Invalid protocol range."); return true; }
      const auto minimum = safe_integer(field(protocol.GetObject(), L"min")), maximum = safe_integer(field(protocol.GetObject(), L"max"));
      if (!minimum || !maximum || *minimum == 0 || *maximum == 0 || *minimum > *maximum) { fail(request, L"failed", L"Invalid protocol range."); return true; }
      if (*minimum > identity::kProtocolMax || *maximum < identity::kProtocolMin) { fail(request, L"helper_incompatible", L"The helper uses an incompatible protocol."); return true; }
      JsonObject version; version.Insert(L"min", JsonValue::CreateNumberValue(identity::kProtocolMin)); version.Insert(L"max", JsonValue::CreateNumberValue(identity::kProtocolMax));
      JsonObject helper; helper.Insert(L"version", JsonValue::CreateStringValue(winrt::to_hstring(identity::kHelperVersion)));
      helper.Insert(L"platform", JsonValue::CreateStringValue(L"windows")); helper.Insert(L"arch", JsonValue::CreateStringValue(winrt::to_hstring(architecture()))); helper.Insert(L"os", JsonValue::CreateStringValue(options.os.substr(0, 128)));
      JsonObject limits; limits.Insert(L"maxFrameBytes", JsonValue::CreateNumberValue(frame_limit));
      JsonObject fields; fields.Insert(L"protocol", version); fields.Insert(L"helper", helper); fields.Insert(L"features", options.features());
      fields.Insert(L"permissions", permission_document()); fields.Insert(L"limits", limits); fields.Insert(L"responsible", JsonValue::CreateBooleanValue(options.responsible)); emit(response_success(request.id, fields)); return true;
    }
    if (request.op == L"permissions.status") {
      if (args.Size() != 0) fail(request, L"failed", L"Invalid permission status arguments."); else emit(response_success(request.id, permission_document())); return true;
    }
    return false;
  }
  void control_request(const Request& request) {
    const auto& args = request.args;
    if (request.op == L"session.begin") {
      const auto next = decode_session(args);
      if (!next) { fail(request, L"failed", L"Invalid session arguments."); return; }
      if (!options.responsible) { fail(request, L"responsible_missing", L"The helper caller was not verified."); return; }
      if (next->mode == L"background") { fail(request, L"unsupported_action", L"Background operation is unavailable."); return; }
      if (session) cleanup(L"replacement");
      invalidate(); if (ended) return;
      session = *next; session->run_epoch = ++epoch; session->observation_epoch = ++epoch;
      halted = false; physical_pause = false; arm_heartbeat(); changed_session(); release_input(request); return;
    }
    if (request.op == L"session.update") {
      if (!session) { fail(request, L"unavailable", L"No computer session is active."); return; }
      if (!keys(args, {L"sessionId", L"phaseRevision", L"approved", L"mode", L"escStops", L"paused", L"overlayWindowIds"}) || !valid_update(args)) { fail(request, L"failed", L"Invalid session update arguments."); return; }
      const auto id = text(field(args, L"sessionId"), 256);
      const auto revision = safe_integer(field(args, L"phaseRevision"));
      if ((id && *id != session->id) || (session->revision && (!id || !revision || *revision < *session->revision))) { fail(request, L"changed", L"The computer session phase changed."); return; }
      if (text(field(args, L"mode"), 16) == L"background") { fail(request, L"unsupported_action", L"Background operation is unavailable."); return; }
      if (physical_pause && boolean(field(args, L"paused")) == false) { fail(request, L"changed", L"Physical take-over needs a fresh session."); return; }
      auto next = *session; if (revision) next.revision = revision;
      if (field(args, L"approved")) next.approved = field(args, L"approved").GetArray();
      if (const auto value = text(field(args, L"mode"), 16)) next.mode = *value;
      if (const auto value = boolean(field(args, L"paused"))) next.paused = *value;
      if (const auto value = boolean(field(args, L"escStops"))) next.esc_stops = *value;
      if (const auto value = ids(field(args, L"overlayWindowIds"))) next.overlay_window_ids = *value;
      invalidate(); if (ended) return;
      next.observation_epoch = ++epoch; session = std::move(next);
      changed_session(); release_input(request); return;
    }
    if (request.op == L"session.end") {
      if (args.Size() != 0) { fail(request, L"failed", L"Invalid session end arguments."); return; }
      cleanup(L"end"); invalidate(); if (heartbeat_timer) heartbeat_timer(); heartbeat_timer = {}; ++heartbeat_ticket;
      session.reset(); halted = false; physical_pause = false; changed_session(); release_input(request); return;
    }
    if (!keys(args, request.op == L"cancel" ? std::initializer_list<std::wstring_view>{L"target"} : std::initializer_list<std::wstring_view>{})) { fail(request, L"failed", L"Invalid control arguments."); return; }
    if (request.op == L"heartbeat") { if (session) arm_heartbeat(); emit(response_success(request.id)); return; }
    if (request.op == L"cancel") {
      const auto target = field(args, L"target");
      if (target && !safe_integer(target)) { fail(request, L"failed", L"Invalid cancellation target."); return; }
      ++publication; cleanup(L"cancel");
      const auto id = safe_integer(target);
      const auto found = std::find_if(queue.begin(), queue.end(), [&](const auto& item) { return id && item.request.id == *id; });
      if (!id) { cancel_queue(true); cancel_active(L"failed", L"Cancelled."); }
      else if (found != queue.end()) { const auto cancelled_request = found->request; queue.erase(found); pending_bytes -= std::min(pending_bytes, cancelled_request.encoded_bytes); fail(cancelled_request, L"failed", L"Cancelled."); }
      else if (active && active->request.id == *id) { cancel_queue(true); cancel_active(L"failed", L"Cancelled."); }
      if (active && active->registration.mutating) cancel_active(L"failed", L"Owned input was revoked during cancellation.");
      release_input(request); pump(); return;
    }
    if (request.op == L"input.releaseAll") {
      ++publication; cleanup(L"release-all"); cancel_queue(true); if (active && active->registration.mutating) cancel_active(L"failed", L"Input was released.");
      release_input(request, true); pump(); return;
    }
    if (request.op == L"shutdown") { close(L"shutdown", false); emit(response_success(request.id), {}, {}, true); }
  }
  void pump() {
    if (ended || active) return;
    if (queue.empty()) { cancel_warmup(); return; }
    const auto pending = handlers.find(queue.front().request.op);
    if (pending != handlers.end()) {
      const auto readiness = wait_for_foreground(queue.front(), pending->second);
      if (readiness == WarmupStatus::waiting) return;
      if (readiness == WarmupStatus::expired) {
        const auto request = std::move(queue.front().request); queue.pop_front(); pending_bytes -= std::min(pending_bytes, request.encoded_bytes);
        fail(request, L"paused", L"Fresh native input detection was not confirmed before admission."); pump(); return;
      }
    }
    cancel_warmup();
    auto queued = std::move(queue.front()); queue.pop_front();
    if (builtin_request(queued.request)) { pending_bytes -= std::min(pending_bytes, queued.request.encoded_bytes); pump(); return; }
    const auto entry = handlers.find(queued.request.op);
    if (entry == handlers.end()) {
      pending_bytes -= std::min(pending_bytes, queued.request.encoded_bytes);
      fail(queued.request, L"unsupported_action", L"This operation is not implemented."); pump(); return;
    }
    const auto registration = entry->second;
    if (!options.responsible || (registration.requires_session && !session) || !options.available() || queued.generation != generation ||
        (registration.mutating && (halted || physical_pause || !releases.empty() || release_failed || (session && session->paused) || !session || !foreground_ready()))) {
      const auto code = !options.responsible ? L"responsible_missing" : registration.mutating && halted ? L"stopped" : queued.generation != generation ? L"changed" : registration.mutating && session && (physical_pause || session->paused || !foreground_ready()) ? L"paused" : L"unavailable";
      pending_bytes -= std::min(pending_bytes, queued.request.encoded_bytes); fail(queued.request, code, L"The native operation is not currently available."); pump(); return;
    }
    if (registration.mutating && session->revision && (text(field(queued.request.args, L"sessionId"), 256) != session->id || safe_integer(field(queued.request.args, L"phaseRevision")) != session->revision)) {
      pending_bytes -= std::min(pending_bytes, queued.request.encoded_bytes); fail(queued.request, L"changed", L"The computer session phase changed."); pump(); return;
    }
    const auto selected = ++token;
    const auto now = options.now();
    const auto deadline = std::numeric_limits<uint64_t>::max() - now < registration.deadline ? std::numeric_limits<uint64_t>::max() : now + registration.deadline;
    active = Active{std::move(queued.request), registration, Authority{generation, session, registration.requires_session, registration.mutating}, selected, deadline, {}};
    const auto timer = options.schedule(registration.deadline, [weak = weak_from_this(), selected] {
      if (const auto self = weak.lock()) self->expire(selected);
    });
    if (active && active->token == selected) active->timer = timer; else timer();
    options.execute([weak = weak_from_this(), selected] {
      const auto self = weak.lock(); if (!self) return;
      Request request; Handler handler; OperationContext context;
      { std::lock_guard lock(self->mutex);
        if (!self->active || self->active->token != selected) return;
        if (self->options.now() >= self->active->deadline_at) { self->expire(selected); return; }
        if (!self->current(selected)) {
          // A fresh probe may become pending after the request was queued to the operation
          // executor. No handler has run yet, so retain the exact original request for warmup.
          if (self->active->registration.mutating && self->observed(self->active->authority) && !self->halted && !self->physical_pause &&
              self->releases.empty() && !self->release_failed && self->session && !self->session->paused && self->options.available() &&
              !self->foreground_ready() && self->foreground_pending()) {
            auto waiting = Queued{std::move(self->active->request), self->active->authority.generation};
            if (self->active->timer) self->active->timer(); self->active.reset(); self->queue.push_front(std::move(waiting)); self->pump();
          }
          return;
        }
        request = self->active->request; handler = self->active->registration.handler; context.session = clone_session(self->active->authority.session); }
      context.is_current = [weak, selected] { const auto state = weak.lock(); if (!state) return false; std::lock_guard lock(state->mutex); return state->current(selected); };
      context.with_current = [weak, selected](const Task& body) { const auto state = weak.lock(); if (!state) return false; std::lock_guard lock(state->mutex); if (!state->current(selected)) return false; body(); return true; };
      try { handler(request, context, [weak, selected](Result result) { if (const auto state = weak.lock()) state->complete(selected, std::move(result)); }); }
      catch (...) { self->complete(selected, Failure{L"failed", L"The native operation failed."}); }
    });
  }
  void complete(uint64_t selected, Result result) {
    std::lock_guard lock(mutex);
    if (!active || active->token != selected) return;
    if (options.now() >= active->deadline_at) { expire(selected); return; }
    if (!current(selected)) { const bool mutating = active->registration.mutating; cancel_active(L"changed", L"The computer session changed during the operation."); if (mutating) release_input(); pump(); return; }
    const auto request = active->request;
    const auto authority = active->authority;
    if (active->timer) active->timer(); active.reset(); pending_bytes -= std::min(pending_bytes, request.encoded_bytes);
    if (const auto failure = std::get_if<Failure>(&result)) {
      cleanup(L"error");
      if (authority.mutating && (options.prepare_release_all || options.release_all_async)) pending_terminals.push_back({request, failure->code, failure->message, cleanup_deadline()});
      if (authority.mutating) release_input();
      if (!authority.mutating || (!options.prepare_release_all && !options.release_all_async)) fail(request, failure->code, failure->message);
    }
    else { auto reply = std::get<Reply>(std::move(result)); emit(response_success(request.id, reply.fields), std::move(reply.image), authority); }
    pump();
  }
  void receive(const Request& supplied) {
    std::lock_guard lock(mutex);
    if (ended) return;
    if (supplied.id == 0 || supplied.id > safe_max) { emit(response_failure(0, L"failed", L"A request needs a positive integer id.")); return; }
    if ((active && active->request.id == supplied.id) || std::any_of(queue.begin(), queue.end(), [&](const auto& item) { return item.request.id == supplied.id; }) ||
        std::any_of(pending_terminals.begin(), pending_terminals.end(), [&](const auto& item) { return item.request.id == supplied.id; }) ||
        std::any_of(releases.begin(), releases.end(), [&](const auto& item) {
          return (item.second.request && item.second.request->id == supplied.id) || std::any_of(item.second.terminals.begin(), item.second.terminals.end(), [&](const auto& terminal) { return terminal.request.id == supplied.id; });
        })) { fail(supplied, L"failed", L"This request id is already active."); return; }
    // Snapshot mutable WinRT JSON ownership before any deferred handler or phase update observes it.
    auto request = supplied; request.args = JsonObject::Parse(supplied.args.Stringify());
    if (control(request.op) && request.op != L"heartbeat" && request.op != L"shutdown" && (options.prepare_release_all || options.release_all_async)) {
      const auto active_bytes = active && active->registration.mutating ? active->request.encoded_bytes : size_t{0};
      const auto retained = cleanup_bytes() + active_bytes;
      if (cleanup_slots() + (active && active->registration.mutating ? 1 : 0) >= 128 || request.encoded_bytes > options.pending_limit_bytes - std::min(retained, options.pending_limit_bytes)) {
        fail(request, L"busy", L"The input cleanup queue is full."); return;
      }
    }
    if (control(request.op)) { control_request(request); return; }
    if (request.encoded_bytes > frame_limit + 4) { fail(request, L"frame_too_large", L"The request exceeds the frame limit."); return; }
    if (queue.size() >= options.queue_limit || request.encoded_bytes > options.pending_limit_bytes - std::min(pending_bytes, options.pending_limit_bytes)) { fail(request, L"busy", L"The operation queue is full."); return; }
    pending_bytes += request.encoded_bytes; queue.push_back(Queued{std::move(request), generation}); pump();
  }
};

Dispatcher::Dispatcher(Options options) : state_(std::make_shared<State>(std::move(options))) {}
Dispatcher::~Dispatcher() { close(); }
bool Dispatcher::register_handler(std::wstring op, uint32_t deadline, bool requires_session, bool mutating, Handler handler) {
  std::lock_guard lock(state_->mutex);
  if (state_->ended || op.empty() || op.size() > 128 || builtin(op) || deadline == 0 || deadline > 600'000 || !handler || op == L"permissions.request" || op == L"permissions.reset" || op.starts_with(L"clipboard.")) return false;
  const auto actual_mutating = mutating || mutation(op);
  return state_->handlers.emplace(std::move(op), State::Registration{deadline, requires_session || actual_mutating, actual_mutating, std::move(handler)}).second;
}
void Dispatcher::receive(const Request& request) { try { state_->receive(request); } catch (...) { close(L"dispatch-failure"); } }
void Dispatcher::send_protocol_failure(const JsonObject& response) { std::lock_guard lock(state_->mutex); if (!state_->ended) state_->emit(response); }
void Dispatcher::close(std::wstring_view reason) { if (state_) { std::lock_guard lock(state_->mutex); state_->close(reason); } }
bool Dispatcher::wait_for_output(uint32_t budget_ms) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(std::min<uint32_t>(budget_ms, 200));
  if (!closed()) return false;
  if (state_->owned_output && state_->runtime && !state_->runtime->stop_output(deadline)) return false;
  std::unique_lock lock(state_->idle_mutex);
  return state_->idle_condition.wait_until(lock, deadline, [&] { return !state_->output_busy; });
}
std::optional<ServerSession> Dispatcher::session_snapshot() const { std::lock_guard lock(state_->mutex); return clone_session(state_->session); }
bool Dispatcher::closed() const { std::lock_guard lock(state_->mutex); return state_->ended; }
bool Dispatcher::physical_input(const JsonObject& event, const ServerSession& expected, bool takeover) {
  std::lock_guard lock(state_->mutex);
  if (state_->ended || !state_->matches(expected) || text(field(event, L"event"), 64) != L"user_input") return false;
  if (takeover && state_->session->mode == L"foreground") {
    state_->cancel_warmup();
    state_->physical_pause = true; state_->session->paused = true; state_->session->esc_stops = false; ++state_->generation; ++state_->publication; state_->session->observation_epoch = ++state_->epoch;
    state_->options.observations_invalidated(); state_->retire_releases(); state_->cleanup(L"physical-input");
    state_->cancel_active(L"paused", L"Physical input paused the task."); state_->cancel_queue(true, L"paused"); state_->changed_session();
    state_->release_input({}, false, event); state_->pump(); return true;
  }
  state_->emit(event, {}, State::Authority{state_->generation, state_->session, true, false}); state_->pump(); return true;
}
bool Dispatcher::stop_from_physical_input(std::wstring_view by, const ServerSession& expected) {
  std::lock_guard lock(state_->mutex);
  if (state_->ended || state_->halted || !state_->matches(expected) || (by != L"esc" && by != L"chord") ||
      (by == L"esc" && (!state_->session->esc_stops || state_->session->mode != L"foreground" || state_->session->paused))) return false;
  state_->cancel_warmup(); state_->halted = true; state_->physical_pause = true; state_->session->paused = true; state_->session->esc_stops = false; ++state_->generation; ++state_->publication; state_->session->observation_epoch = ++state_->epoch;
  state_->options.observations_invalidated(); state_->retire_releases(); state_->cleanup(L"stop");
  state_->cancel_active(L"stopped", L"Physical Stop ended this task."); state_->cancel_queue(true, L"stopped"); state_->changed_session();
  JsonObject fields; fields.Insert(L"by", JsonValue::CreateStringValue(by)); state_->release_input({}, false, event_document(L"stop", fields)); state_->pump(); return true;
}
bool Dispatcher::input_detection(bool alive, std::wstring_view reason, const ServerSession& expected) {
  std::lock_guard lock(state_->mutex);
  if (state_->ended || !state_->session || !state_->matches(expected) || state_->session->mode != L"foreground" ||
      (alive ? !reason.empty() : reason != L"probe_missing" && reason != L"elevated_foreground" && reason != L"secure_desktop")) return false;
  JsonObject fields; fields.Insert(L"alive", JsonValue::CreateBooleanValue(alive));
  if (!alive) fields.Insert(L"reason", JsonValue::CreateStringValue(reason));
  const auto event = event_document(L"input_detection", fields);
  if (alive) {
    if (!state_->options.native_event_current(event, state_->session)) return false;
    state_->emit(event, {}, State::Authority{state_->generation, state_->session, true, false}); state_->pump(); return true;
  }
  state_->cancel_warmup();
  if (!state_->physical_pause || !state_->session->paused || state_->session->esc_stops) {
    state_->physical_pause = true; state_->session->paused = true; state_->session->esc_stops = false;
    ++state_->generation; ++state_->publication; state_->session->observation_epoch = ++state_->epoch;
    state_->options.observations_invalidated(); state_->retire_releases();
    state_->cleanup(L"input-detection"); state_->cancel_active(L"paused", L"Native input detection became unavailable."); state_->cancel_queue(true, L"paused"); state_->changed_session();
  }
  state_->release_input({}, false, event); state_->pump(); return true;
}
void Dispatcher::foreground_readiness_changed(const ServerSession& expected) {
  std::lock_guard lock(state_->mutex);
  if (!state_->ended && state_->session && state_->matches(expected)) state_->pump();
}
void Dispatcher::notify_display_change() {
  std::lock_guard lock(state_->mutex); if (state_->ended) return;
  state_->invalidate(); if (state_->ended) return; state_->changed_session(); state_->release_input(); state_->emit(event_document(L"display_change", {})); state_->pump();
}
}
