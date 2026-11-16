#include "input.h"
#include "input_guardian.h"
#include "input_held.h"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <limits>
#include <map>
#include <set>
#include <thread>

namespace vector::computer {
namespace {
uint64_t monotonic() { return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count()); }
[[noreturn]] void changed() { throw Failure{L"changed", L"The native input observation changed."}; }
[[noreturn]] void invalid() { throw Failure{L"failed", L"The native input arguments are invalid."}; }
[[noreturn]] void failed() { throw Failure{L"failed", L"The native input was not confirmed."}; }
[[noreturn]] void stale() { throw Failure{L"stale_frame", L"A fresh full capture is required."}; }
std::wstring string(const JsonObject& value, const wchar_t* key, size_t maximum = 256) {
  if (!value.HasKey(key) || value.Lookup(key).ValueType() != JsonValueType::String) invalid();
  const std::wstring result(value.GetNamedString(key));
  if (result.empty() || result.size() > maximum || result.find(L'\0') != std::wstring::npos) invalid(); return result;
}
int64_t integer(const JsonObject& value, const wchar_t* key) {
  if (!value.HasKey(key)) invalid(); const auto result = signed_integer(value.Lookup(key)); if (!result) invalid(); return *result;
}
bool fields(const JsonObject& value, const std::set<std::wstring>& allowed) { for (const auto& pair : value) if (!allowed.contains(std::wstring(pair.Key()))) return false; return true; }
std::vector<std::wstring> names(const JsonObject& value, const wchar_t* key, bool empty = false) {
  if (!value.HasKey(key) || value.Lookup(key).ValueType() != JsonValueType::Array) invalid();
  const auto list = value.GetNamedArray(key); if ((!empty && list.Size() == 0) || list.Size() > 8) invalid();
  std::vector<std::wstring> result;
  for (const auto& item : list) { if (item.ValueType() != JsonValueType::String) invalid(); const std::wstring name(item.GetString()); if (name.empty() || name.size() > 32 || name.find(L'\0') != std::wstring::npos) invalid(); result.push_back(name); }
  return result;
}
InputExpectedTarget expected(const JsonObject& value) {
  InputExpectedTarget result;
  if (value.HasKey(L"pid")) { const auto pid = integer(value, L"pid"); if (pid <= 0 || pid > MAXDWORD) invalid(); result.pid = static_cast<DWORD>(pid); }
  if (value.HasKey(L"windowId")) { result.window = parse_window_id(string(value, L"windowId")); if (!result.window) invalid(); }
  if (value.HasKey(L"ref")) result.ref = string(value, L"ref");
  if (value.HasKey(L"elementId")) result.element_id = string(value, L"elementId"); return result;
}
struct InputRequest {
  std::wstring op, capture_id, text;
  std::vector<std::pair<int64_t, int64_t>> points;
  std::vector<InputExpectedTarget> targets;
  std::vector<std::wstring> combo, modifiers;
  uint32_t repeats = 1, milliseconds = 0, count = 1;
  uint8_t button = 0;
  int32_t dx = 0, dy = 0;
  bool pointer = false;
  InputRequest(std::wstring_view operation, const JsonObject& args, const ServerSession& session) : op(operation) {
    const std::set<std::wstring> phase{L"sessionId",L"phaseRevision"}, target{L"pid",L"windowId",L"ref",L"elementId"};
    std::set<std::wstring> allowed = phase;
    auto add = [&](std::initializer_list<const wchar_t*> list) { for (const auto item : list) allowed.insert(item); };
    if (op == L"input.click" || op == L"input.move" || op == L"input.scroll") { allowed.insert(target.begin(), target.end()); add({L"captureId",L"x",L"y"}); pointer = true; }
    if (op == L"input.click") add({L"button",L"count",L"modifiers"});
    else if (op == L"input.scroll") add({L"dx",L"dy",L"unit"});
    else if (op == L"input.drag") { add({L"captureId",L"path",L"targets",L"button",L"modifiers"}); pointer = true; }
    else if (op == L"input.key" || op == L"input.type" || op == L"input.hold") { allowed.insert(target.begin(), target.end()); if (op == L"input.type") add({L"text"}); else add({L"combo", op == L"input.key" ? L"repeat" : L"ms"}); }
    else if (op != L"input.move") throw Failure{L"unsupported_action", L"This native input operation is unavailable."};
    if (!fields(args, allowed)) invalid();
    if (args.HasKey(L"sessionId") && string(args, L"sessionId") != session.id) changed();
    if (session.revision && (!args.HasKey(L"sessionId") || !args.HasKey(L"phaseRevision") || safe_integer(args.Lookup(L"phaseRevision")) != session.revision)) changed();
    if (args.HasKey(L"phaseRevision") && !safe_integer(args.Lookup(L"phaseRevision"))) invalid();
    if (pointer) {
      capture_id = string(args, L"captureId");
      if (op == L"input.drag") {
        if (!args.HasKey(L"path") || args.Lookup(L"path").ValueType() != JsonValueType::Array) invalid(); const auto path = args.GetNamedArray(L"path");
        if (path.Size() < 2 || path.Size() > 50) invalid();
        for (const auto& value : path) { if (value.ValueType() != JsonValueType::Object) invalid(); const auto point = value.GetObject(); if (point.Size() != 2 || !fields(point,{L"x",L"y"})) invalid(); points.emplace_back(integer(point,L"x"), integer(point,L"y")); }
        if (args.HasKey(L"targets")) {
          if (args.Lookup(L"targets").ValueType() != JsonValueType::Array) invalid(); const auto list = args.GetNamedArray(L"targets"); if (list.Size() != points.size()) invalid();
          for (const auto& value : list) { if (value.ValueType() != JsonValueType::Object || !fields(value.GetObject(),target)) invalid(); targets.push_back(expected(value.GetObject())); }
        } else targets.resize(points.size());
      } else { points.emplace_back(integer(args,L"x"), integer(args,L"y")); targets.push_back(expected(args)); }
      if (op == L"input.click" || op == L"input.drag") { const auto raw = string(args,L"button",16); if (raw != L"left" && raw != L"right" && raw != L"middle") invalid(); button = raw == L"right" ? 1 : raw == L"middle" ? 2 : 0; modifiers = names(args,L"modifiers",true); }
      if (op == L"input.click") { const auto raw = integer(args,L"count"); if (raw < 1 || raw > 3) invalid(); count = static_cast<uint32_t>(raw); }
      if (op == L"input.scroll") {
        const auto x = integer(args,L"dx"), y = integer(args,L"dy"); if (x < -10000 || x > 10000 || y < -10000 || y > 10000) invalid(); dx = static_cast<int32_t>(x); dy = static_cast<int32_t>(y);
        if (args.HasKey(L"unit")) { if (string(args,L"unit",16) != L"pixel") invalid(); throw Failure{L"unsupported_action", L"Windows wheel input cannot promise an exact pixel scroll."}; }
      }
    } else {
      targets.push_back(expected(args)); if (!targets.front().pid) invalid();
      if (op == L"input.type") { if (!args.HasKey(L"text") || args.Lookup(L"text").ValueType() != JsonValueType::String) invalid(); text = std::wstring(args.GetNamedString(L"text")); if (text.empty() || !split_input_unicode(text)) invalid(); }
      else { combo = names(args,L"combo"); const auto value = integer(args,op == L"input.key" ? L"repeat" : L"ms"); if (op == L"input.key") { if (value < 1 || value > 20) invalid(); repeats = static_cast<uint32_t>(value); } else { if (value < 0 || value > 10000) invalid(); milliseconds = static_cast<uint32_t>(value); } }
    }
  }
};

struct TimerQueue : std::enable_shared_from_this<TimerQueue> {
  struct Job { std::chrono::steady_clock::time_point at; std::function<void()> body; };
  std::mutex mutex; std::condition_variable wake; std::map<uint64_t, Job> jobs; uint64_t next = 0; bool closed = false, ready=false;
  static std::shared_ptr<TimerQueue> make() {
    auto queue = std::make_shared<TimerQueue>();
    std::thread([queue] {
      try { winrt::init_apartment(winrt::apartment_type::multi_threaded); } catch (...) { std::lock_guard lock(queue->mutex); queue->closed = true; queue->wake.notify_all(); return; }
      std::unique_lock lock(queue->mutex);
      queue->ready=true; queue->wake.notify_all();
      while (!queue->closed) {
        if (queue->jobs.empty()) { queue->wake.wait(lock); continue; }
        auto selected = std::min_element(queue->jobs.begin(), queue->jobs.end(), [](const auto& a, const auto& b) { return a.second.at < b.second.at; });
        const auto deadline=selected->second.at;
        if (std::chrono::steady_clock::now() < deadline) { queue->wake.wait_until(lock, deadline); continue; }
        auto body = std::move(selected->second.body); queue->jobs.erase(selected); lock.unlock(); try { body(); } catch (...) {} lock.lock();
      }
      lock.unlock(); winrt::uninit_apartment();
    }).detach();
    { std::unique_lock lock(queue->mutex); if (!queue->wake.wait_for(lock,std::chrono::milliseconds(100),[&]{return queue->ready || queue->closed;}) || !queue->ready) {
        queue->closed=true; queue->wake.notify_all(); throw Failure{L"unavailable",L"The independent input timer is unavailable."};
      } }
    return queue;
  }
  InputService::Cancel schedule(uint32_t ms, std::function<void()> body) {
    std::lock_guard lock(mutex); if (closed || !ready || jobs.size() >= 256 || next == std::numeric_limits<uint64_t>::max()) throw Failure{L"busy",L"The input timer queue is unavailable."};
    const auto id = ++next; jobs.emplace(id,Job{std::chrono::steady_clock::now()+std::chrono::milliseconds(std::min<uint32_t>(ms,30000)),std::move(body)}); wake.notify_all();
    return [weak=weak_from_this(),id] { if (const auto queue=weak.lock()) { std::lock_guard guard(queue->mutex); queue->jobs.erase(id); queue->wake.notify_all(); } };
  }
  void close() { std::lock_guard lock(mutex); closed=true; jobs.clear(); wake.notify_all(); }
};
bool same_chord(const InputNativeChord& a, const InputNativeChord& b) {
  if (a.semantic.key != b.semantic.key || a.semantic.modifiers != b.semantic.modifiers || a.semantic.layout_fingerprint != b.semantic.layout_fingerprint || a.keys.size() != b.keys.size()) return false;
  for (size_t i=0;i<a.keys.size();++i) if (a.keys[i].release!=b.keys[i].release || a.keys[i].modifier!=b.keys[i].modifier) return false; return true;
}
std::vector<std::wstring> semantic_keys(const InputResolvedChord& chord) {
  std::vector<std::wstring> result;
  for (const auto& item : {std::pair{InputModifier::control,L"control"}, {InputModifier::alt,L"alt"}, {InputModifier::shift,L"shift"}, {InputModifier::meta,L"meta"}, {InputModifier::alt_graph,L"altgraph"}})
    if (chord.modifiers & input_modifier(item.first)) result.emplace_back(item.second);
  result.push_back(chord.key); return result;
}
}

struct InputService::State : std::enable_shared_from_this<InputService::State> {
  struct CleanupCredit { uint32_t released=0; };
  struct OwnedTicket {
    std::wstring id; InputGuardianTicket ticket; InputHeldLease lease;
    bool attempted=false, observed_down=false, observed_up=false, fallback_attempted=false;
    std::optional<uint64_t> down_started_ms;
    std::shared_ptr<CleanupCredit> credit;
  };
  struct Flight {
    InputRequest request; ServerSession session; OperationContext context; Dispatcher::Completion done; InputHeldLease lease;
    WindowsWindow window; std::optional<CaptureReceipt> receipt; std::optional<InputObservation> baseline, prepared;
    std::optional<InputNativeChord> chord; std::optional<std::vector<InputMenuShortcut>> menus; std::wstring layout;
    std::vector<OwnedTicket> tickets;
    std::atomic<bool> expired{false}, finished{false}, timer_armed{false}, full_chord{false}, cleanup_started{false};
    InputService::Cancel cancel, cancel_inspection; uint64_t started=0; std::atomic<uint64_t> hold_started_ms{0};
    Flight(InputRequest value, ServerSession snapshot, OperationContext current, Dispatcher::Completion completion)
      : request(std::move(value)),session(std::move(snapshot)),context(std::move(current)),done(std::move(completion)) {}
  };
  InputObservationProvider observations; InputBackend backend; Schedule schedule, inspections; std::function<uint64_t()> now;
  InputHeldJournal journal; std::shared_ptr<TimerQueue> timers, inspection_timers; std::recursive_mutex mutex;
  struct CleanupWaiter { std::shared_ptr<CleanupCredit> credit; std::function<void(bool,uint32_t)> done; };
  bool closed=false, faulted=false, cleanup_unknown=false; size_t cleaning=0; std::shared_ptr<Flight> active;
  std::map<uint64_t,OwnedTicket> debt; std::vector<CleanupWaiter> cleanup_waiters;
  State(InputObservationProvider provider, InputBackend native, Schedule timer, std::function<uint64_t()> clock, Schedule inspect)
    : observations(std::move(provider)),backend(std::move(native)),schedule(std::move(timer)),inspections(std::move(inspect)),now(clock?std::move(clock):monotonic),
      // The parent journal fences DOWNs and records debt. Only the independent hook-owned guardian
      // posts UPs, including reentrant cancellation during a native post.
      journal([](const InputRelease&){return false;},now) {
    const bool injected=static_cast<bool>(schedule);
    if (!schedule) { timers=TimerQueue::make(); schedule=[queue=timers](auto ms,auto body){return queue->schedule(ms,std::move(body));}; }
    if (!inspections) {
      if (injected) inspections=schedule;
      else { inspection_timers=TimerQueue::make(); inspections=[queue=inspection_timers](auto ms,auto body){return queue->schedule(ms,std::move(body));}; }
    }
    if (!backend.tag || !backend.guardian || !backend.receipt || !backend.capture_current || !backend.focused_window || !backend.point || !backend.foreground ||
        !backend.commit_point || !backend.commit_foreground || !backend.resolve || !backend.pointer_modifiers || !backend.keyboard_current || !backend.keyboard_fingerprint ||
        !backend.post || !backend.post_batch || !backend.quiet || !observations.focused || !observations.pointer || !observations.bind || !observations.same || !observations.fresh)
      throw Failure{L"unavailable",L"The guarded native input backend is incomplete."};
  }
  void require_locked(const std::shared_ptr<Flight>& flight) {
    const auto time=now();
    if (closed || faulted || active!=flight || flight->expired.load() ||
        !journal.current(flight->lease) || time<flight->started || time-flight->started>30000) changed();
    for (const auto& item:flight->tickets) {
      // Start before the actual native DOWN, never after an ACK or a repeated/current lookup.
      // The guardian's independent cap can only release at this time or later; continuation must
      // therefore stop by this conservative deadline even if the old UP receipt remains queryable.
      if (item.attempted && !item.observed_up && item.down_started_ms &&
          (time<*item.down_started_ms || time-*item.down_started_ms>=input_guardian_held_limit_ms)) changed();
    }
  }
  void require(const std::shared_ptr<Flight>& flight) {
    { std::lock_guard lock(mutex); require_locked(flight); }
    // Never acquire Dispatcher authority while holding the input/journal lock.
    if (!flight->context.is_current || !flight->context.is_current()) changed();
    if (backend.available && !backend.available()) throw Failure{L"unavailable",L"The interactive native desktop is unavailable."};
  }
  void finish(const std::shared_ptr<Flight>& flight, Dispatcher::Result result) {
    if (flight->finished.exchange(true)) return;
    Cancel cancel, cancel_inspection;
    { std::lock_guard lock(mutex); cancel=std::move(flight->cancel); cancel_inspection=std::move(flight->cancel_inspection); if (active==flight) active.reset(); }
    if (cancel) cancel(); if (cancel_inspection) cancel_inspection();
    flight->done(std::move(result));
  }
  WindowsWindow target(const CaptureReceipt& receipt, POINT point) {
    if (receipt.window) return *receipt.window;
    for (const auto& surface:receipt.inventory.windows) {
      if (!surface.visible || surface.minimized || surface.cloaked || surface.excluded_overlay || !surface.bounds.contains(point)) continue;
      if (!surface.window) throw Failure{L"protected",L"The native pointer owner is unknown."}; return *surface.window;
    }
    throw Failure{L"not_granted",L"The captured point has no approved app owner."};
  }
  void match(const InputExpectedTarget& expected,const WindowsWindow& window) {
    if ((expected.pid && *expected.pid!=window.owner.process.pid) || (expected.window && *expected.window!=window.hwnd)) changed();
  }
  WindowsPointOwner pointer(const std::shared_ptr<Flight>& flight,size_t index) {
    require(flight); if (!flight->receipt || !backend.capture_current(*flight->receipt,flight->session)) stale();
    const auto point=flight->receipt->point(flight->request.points[index].first,flight->request.points[index].second);
    const auto window=target(*flight->receipt,point); match(flight->request.targets[index],window);
    auto actual=backend.point(window,point,flight->session);
    flight->prepared.reset();
    if (flight->request.targets[index].ref || flight->request.targets[index].element_id) {
      auto observation=observations.pointer(actual.window,point,flight->session);
      if (!same_windows_window(observation.window,actual.window)) changed(); observations.bind(observation,flight->request.targets[index],flight->session);
      if (!observations.fresh(observation,50)) changed(); flight->prepared=std::move(observation);
    }
    require(flight); return actual;
  }
  InputObservation keyboard(const std::shared_ptr<Flight>& flight,bool menus) {
    require(flight); const auto window=backend.foreground(flight->window,flight->session); match(flight->request.targets.front(),window);
    auto observation=observations.focused(window,flight->session);
    if (!same_windows_window(observation.window,window) || !observation.secure || !observation.enabled || !observation.focused || !observation.keyboard_focusable) changed();
    observations.bind(observation,flight->request.targets.front(),flight->session);
    if (menus && flight->request.op!=L"input.type") {
      const auto first=observation;
      flight->menus=observations.menus?observations.menus(observation,flight->session):observation.menus;
      observation=observations.focused(window,flight->session); if (!observations.same(first,observation)) changed();
      observations.bind(observation,flight->request.targets.front(),flight->session);
    }
    if (flight->baseline && !observations.same(*flight->baseline,observation)) changed();
    const auto fingerprint=backend.keyboard_fingerprint(window); if (!flight->layout.empty() && flight->layout!=fingerprint) changed();
    flight->layout=fingerprint;
    bool text=flight->request.op==L"input.type"; std::vector<std::wstring> keys;
    if (!text) {
      const auto chord=backend.resolve(flight->request.combo,observation);
      if (!chord.semantic.complete || chord.semantic.layout_fingerprint!=fingerprint || (flight->chord && !same_chord(*flight->chord,chord))) changed();
      if (!input_allowed_chord(flight->request.combo,chord.semantic,flight->menus,backend.text_rules)) throw Failure{L"blocked",L"This native keyboard shortcut is unavailable."};
      text=input_chord_types_text(flight->request.combo,chord.semantic,flight->menus,backend.text_rules); keys=semantic_keys(chord.semantic); flight->chord=chord;
    }
    WindowsSessionPolicy(flight->session).require(window,text?WindowsPolicyOperation::type_text:WindowsPolicyOperation::key,observation.secure,keys);
    if (text && !observation.editable()) throw Failure{L"blocked",L"The native text field is read-only or unknown."};
    if (!observations.fresh(observation,50)) changed(); if (!flight->baseline) flight->baseline=observation; flight->prepared=observation; require(flight); return observation;
  }
  void commit(const std::shared_ptr<Flight>& flight,const std::optional<WindowsPointOwner>& point,const std::function<void()>& body) {
    auto precondition=[&] {
      std::lock_guard lock(mutex); require_locked(flight);
      // The bounded whole-capture metadata pass precedes the Guard's final actual hit/focus read.
      if (flight->receipt && !backend.capture_current(*flight->receipt,flight->session)) stale();
      if (flight->prepared && !observations.fresh(*flight->prepared,50)) changed();
    };
    auto mutation=[&] {
      std::lock_guard lock(mutex); require_locked(flight);
      if (flight->prepared && !observations.fresh(*flight->prepared,50)) changed();
      if (!backend.guardian->alive() || !backend.quiet() || (backend.available && !backend.available())) changed();
      if (!point && !backend.keyboard_current(flight->layout,flight->window,journal.owned())) changed();
      // The detector can revoke readiness while this same-thread metadata preparation runs.
      // Guard owns Dispatcher authority here; no actor/thread hop is permitted by this callback.
      if (!flight->context.is_current()) changed();
      body();
    };
    if (point) backend.commit_point(*point,flight->session,flight->context,precondition,mutation);
    else {
      const bool text=flight->request.op==L"input.type" || (flight->chord && input_chord_types_text(flight->request.combo,flight->chord->semantic,flight->menus,backend.text_rules));
      const auto keys=flight->chord?semantic_keys(flight->chord->semantic):std::vector<std::wstring>{};
      backend.commit_foreground(flight->window,flight->session,flight->context,text?WindowsPolicyOperation::type_text:WindowsPolicyOperation::key,
        flight->prepared?flight->prepared->secure:std::nullopt,keys,flight->prepared?flight->prepared->observed_at_ms:0,precondition,mutation);
    }
  }
  void complete_cleanup_waiters() noexcept {
    std::vector<std::pair<CleanupWaiter,uint32_t>> waiters; bool complete=false;
    try { { std::lock_guard lock(mutex); if (cleaning) return; complete=debt.empty() && !cleanup_unknown;
        for (auto& waiter:cleanup_waiters) { const auto count=waiter.credit->released; waiters.emplace_back(std::move(waiter),count); } cleanup_waiters.clear(); }
      for (auto& waiter:waiters) try { waiter.first.done(complete,waiter.second); } catch (...) {}
    } catch (...) {}
  }
  bool guardian_cleanup(const std::vector<OwnedTicket>& tickets) {
    const auto started=now(); (void)backend.guardian->drain(250);
    for (const auto& item:tickets) {
      if (!item.attempted) continue;
      const auto time=now(); if (time<started || time-started>=300) break;
      bool known_up=false;
      { std::lock_guard lock(mutex); const auto found=debt.find(item.ticket.id); known_up=found!=debt.end() && found->second.observed_up; }
      if (known_up || backend.guardian->observed(item.ticket,false,static_cast<uint32_t>(std::min<uint64_t>(10,300-(time-started))))) {
        (void)journal.observed_release(item.lease,item.id,item.ticket.release);
        if (backend.forget_release) backend.forget_release(item.ticket.release); backend.guardian->retire(item.ticket);
        std::lock_guard lock(mutex); const auto found=debt.find(item.ticket.id);
        if (found!=debt.end()) { if (found->second.credit) ++found->second.credit->released; debt.erase(found); }
      } else if (backend.guardian->exited()) {
        bool attempt=false;
        { std::lock_guard lock(mutex); const auto found=debt.find(item.ticket.id);
          if (found!=debt.end() && found->second.observed_down && !found->second.observed_up && !found->second.fallback_attempted) {
            found->second.fallback_attempted=true; attempt=true;
          }
        }
        // A dead guardian can have an earlier UP still queued in the OS. This single bounded
        // best-effort attempt never earns release credit or clears debt without an actual receipt.
        if (attempt && backend.release) try { (void)backend.release(item.ticket.release); } catch (...) {}
      }
    }
    bool complete=true;
    { std::lock_guard lock(mutex); for (const auto& item:tickets) if (debt.contains(item.ticket.id)) { complete=false; break; } }
    // A stuck control exchange cannot postpone Stop until the independent10s held cap. Closing
    // signals the child's separate inherited shutdown event before waiting for control I/O.
    if (!complete) backend.guardian->close();
    return complete;
  }
  void queue_cleanup(const std::shared_ptr<Flight>& flight) noexcept {
    try {
      std::vector<OwnedTicket> tickets;
      { std::lock_guard lock(mutex);
        if (flight->cleanup_started.exchange(true)) return;
        ++cleaning; flight->expired.store(true); tickets=flight->tickets;
        for (const auto& item:tickets) if (item.attempted) debt.insert_or_assign(item.ticket.id,item);
        // Invalidate before another admission. Actual UPs are exclusively guardian-owned, so a
        // watchdog expiry and Stop cannot race two independent release posts.
        (void)journal.release(flight->lease,0);
      }
      for (const auto& item:tickets) backend.guardian->retire(item.ticket,!item.attempted);
      schedule(0,[weak=weak_from_this(),tickets=std::move(tickets)] {
        if (const auto state=weak.lock()) {
          bool complete=false; try { complete=state->guardian_cleanup(tickets); } catch (...) {}
          { std::lock_guard lock(state->mutex); if (!complete) state->faulted=true; if (state->cleaning) --state->cleaning; }
          state->complete_cleanup_waiters();
        }
      });
    } catch (...) { { std::lock_guard lock(mutex); faulted=true; cleanup_unknown=true; if (cleaning) --cleaning; } complete_cleanup_waiters(); }
  }
  void hold_tick(const std::shared_ptr<Flight>& flight) {
    const auto time=now(), beginning=flight->hold_started_ms.load();
    // At the requested duration the independent expiry worker owns release and its result. A
    // simultaneous security tick must not turn a valid10s hold into a scheduling-race failure.
    if (flight->timer_armed.load() && time>=beginning && time-beginning>=flight->request.milliseconds) return;
    require(flight);
    if (!flight->full_chord.load()) { schedule_inspection(flight); return; }
    // No menu traversal or value read on a held-key security tick. The initial complete menu and
    // chord proof is immutable after full_chord; actual focus/password/layout facts are observed anew.
    const auto window=backend.foreground(flight->window,flight->session);
    auto observation=observations.focused(window,flight->session);
    if (!same_windows_window(window,flight->window) || !same_windows_window(observation.window,window) ||
        !observation.secure || !observation.enabled || !observation.focused || !observation.keyboard_focusable ||
        !flight->baseline || !observations.same(*flight->baseline,observation)) changed();
    observations.bind(observation,flight->request.targets.front(),flight->session);
    const auto chord=backend.resolve(flight->request.combo,observation);
    if (!flight->chord || !same_chord(*flight->chord,chord) || backend.keyboard_fingerprint(window)!=flight->layout ||
        !backend.keyboard_current(flight->layout,window,journal.owned()) || !backend.guardian->alive() || !backend.quiet()) changed();
    const bool text=input_chord_types_text(flight->request.combo,chord.semantic,flight->menus,backend.text_rules);
    WindowsSessionPolicy(flight->session).require(window,text?WindowsPolicyOperation::type_text:WindowsPolicyOperation::key,observation.secure,semantic_keys(chord.semantic));
    if (text && !observation.editable()) throw Failure{L"blocked",L"The native text field is read-only or unknown."};
    if (!observations.fresh(observation,50)) changed(); require(flight); schedule_inspection(flight);
  }
  void schedule_inspection(const std::shared_ptr<Flight>& flight) {
    const auto cancel=inspections(25,[weak=weak_from_this(),flight] {
      if (const auto state=weak.lock()) {
        if (flight->expired.load() || flight->finished.load()) return;
        try { state->hold_tick(flight); }
        catch (const Failure& failure) { state->queue_cleanup(flight); state->finish(flight,failure); }
        catch (...) { state->queue_cleanup(flight); state->finish(flight,Failure{L"changed",L"The native hold observation changed."}); }
      }
    });
    bool retire=false;
    { std::lock_guard lock(mutex); retire=closed || flight->expired.load() || flight->finished.load(); if (!retire) flight->cancel_inspection=cancel; }
    if (retire && cancel) cancel();
  }
  void arm(const std::shared_ptr<Flight>& flight) {
    if (flight->request.op!=L"input.hold" || flight->request.milliseconds==0 || flight->timer_armed.exchange(true)) return;
    flight->hold_started_ms.store(now());
    const auto cancel=schedule(flight->request.milliseconds,[weak=weak_from_this(),flight] {
      if (const auto state=weak.lock()) {
        flight->expired.store(true);
        std::vector<OwnedTicket> tickets;
        { std::lock_guard lock(state->mutex); if (state->active!=flight || state->closed || flight->cleanup_started.exchange(true)) return;
          ++state->cleaning; tickets=flight->tickets;
          for (const auto& item:tickets) if (item.attempted) state->debt.insert_or_assign(item.ticket.id,item);
          (void)state->journal.release(flight->lease,0); }
        for (const auto& item:tickets) state->backend.guardian->retire(item.ticket,!item.attempted);
        bool complete=false; try { complete=state->guardian_cleanup(tickets); } catch (...) {}
        { std::lock_guard lock(state->mutex); if (state->cleaning) --state->cleaning; if (!complete) state->faulted=true; }
        state->complete_cleanup_waiters();
        if (!complete || !flight->full_chord.load()) state->finish(flight,Failure{L"changed",L"The native hold could not complete safely."});
        else state->finish(flight,Reply{});
      }
    });
    bool retire=false;
    { std::lock_guard lock(mutex); retire=flight->expired.load() || flight->finished.load(); if (!retire) flight->cancel=cancel; }
    if (retire && cancel) cancel();
    if (!retire) schedule_inspection(flight);
  }
  OwnedTicket reserve(const std::shared_ptr<Flight>& flight,const InputRelease& release) {
    require(flight); const auto ticket=backend.guardian->reserve(release); if (!ticket) throw Failure{L"unavailable",L"The native release guardian is unavailable."};
    std::lock_guard lock(mutex);
    try { require_locked(flight); } catch (...) { backend.guardian->retire(*ticket,true); throw; }
    if (flight->tickets.size()>=136) { backend.guardian->retire(*ticket,true); failed(); }
    OwnedTicket owned{L"input_"+std::to_wstring(flight->lease.sequence)+L"_"+std::to_wstring(ticket->id),*ticket,flight->lease}; flight->tickets.push_back(owned); return owned;
  }
  void attempted(const std::shared_ptr<Flight>& flight,const OwnedTicket& ticket,bool value=true) {
    std::lock_guard lock(mutex); for (auto& item:flight->tickets) if (item.ticket==ticket.ticket) {
      if (value && !item.attempted) item.down_started_ms=now();
      item.attempted=value; if (!value) item.down_started_ms.reset(); return;
    }
  }
  void receipt(const std::shared_ptr<Flight>& flight,const OwnedTicket& ticket,bool up) {
    std::lock_guard lock(mutex);
    if (!up && backend.confirm_down) backend.confirm_down(ticket.ticket.release);
    for (auto& item:flight->tickets) if (item.ticket==ticket.ticket) { if (up) item.observed_up=true; else item.observed_down=true; }
    const auto found=debt.find(ticket.ticket.id); if (found!=debt.end()) { if (up) found->second.observed_up=true; else found->second.observed_down=true; }
  }
  void retire_completed(const std::shared_ptr<Flight>& flight,const OwnedTicket& ticket) {
    backend.guardian->retire(ticket.ticket);
    if (backend.forget_release) backend.forget_release(ticket.ticket.release);
    std::lock_guard lock(mutex); std::erase_if(flight->tickets,[&](const auto& item){return item.ticket==ticket.ticket;});
  }
  void down(const std::shared_ptr<Flight>& flight,const OwnedTicket& ticket,const std::optional<WindowsPointOwner>& point) {
    InputPostResult outcome=InputPostResult::not_posted;
    std::optional<Failure> refusal;
    const auto retire_refused = [&] {
      backend.guardian->retire(ticket.ticket,true);
      std::lock_guard lock(mutex); std::erase_if(flight->tickets,[&](const auto& item){return item.ticket==ticket.ticket;});
    };
    try { commit(flight,point,[&] {
      (void)journal.press(flight->lease,ticket.id,ticket.ticket.release,[&] {
        arm(flight); const auto kind=ticket.ticket.release.kind==InputReleaseKind::mouse_button?InputEventKind::button_down:InputEventKind::key_down;
        attempted(flight,ticket); outcome=InputPostResult::uncertain;
        try { outcome=backend.post({kind,point?point->point:POINT{},ticket.ticket.release,0,0,backend.tag},flight->context.is_current); }
        catch (const InputPrePostRefusal& error) {
          if (error.code!=L"changed" && error.code!=L"elevated" && error.code!=L"secure_desktop" && error.code!=L"unavailable") throw;
          refusal=static_cast<const Failure&>(error); outcome=InputPostResult::not_posted;
        }
        if (outcome==InputPostResult::not_posted) attempted(flight,ticket,false);
        return outcome;
      });
    }); } catch (...) { if (refusal) retire_refused(); if (outcome==InputPostResult::uncertain) { std::lock_guard lock(mutex); faulted=true; } throw; }
    if (refusal) { retire_refused(); throw *refusal; }
    if (outcome!=InputPostResult::accepted) { backend.guardian->retire(ticket.ticket,outcome==InputPostResult::not_posted); if (outcome==InputPostResult::uncertain) { std::lock_guard lock(mutex); faulted=true; } failed(); }
    if (!backend.guardian->observed(ticket.ticket,true,50)) { std::lock_guard lock(mutex); faulted=true; failed(); }
    receipt(flight,ticket,false);
    require(flight);
  }
  void up(const std::shared_ptr<Flight>& flight,const OwnedTicket& ticket) {
    require(flight);
    // The guardian serializes all owned UPs against its independent crash/10s release path.
    backend.guardian->retire(ticket.ticket);
    if (!backend.guardian->observed(ticket.ticket,false,50)) { std::lock_guard lock(mutex); faulted=true; failed(); }
    require(flight);
    receipt(flight,ticket,true);
    (void)journal.observed_release(flight->lease,ticket.id,ticket.ticket.release);
    if (backend.forget_release) backend.forget_release(ticket.ticket.release);
    retire_completed(flight,ticket);
  }
  void event(const std::shared_ptr<Flight>& flight,const WindowsPointOwner& point,InputPostedEvent event) {
    event.tag=backend.tag; commit(flight,point,[&] { journal.post(flight->lease,[&] { return backend.post(event,flight->context.is_current); }); });
  }
  void run_pointer(const std::shared_ptr<Flight>& flight) {
    flight->receipt=backend.receipt(flight->request.capture_id,flight->session);
    // Every drag point is admitted before the first modifier/button down, then checked again when used.
    for (size_t i=0;i<flight->request.points.size();++i) (void)pointer(flight,i);
    auto first=pointer(flight,0); const auto modifier_keys=backend.pointer_modifiers(flight->request.modifiers,first.window);
    for (const auto& key:modifier_keys) { const auto ticket=reserve(flight,key.release); first=pointer(flight,0); down(flight,ticket,first); }
    first=pointer(flight,0); event(flight,first,{InputEventKind::move,first.point});
    if (flight->request.op==L"input.click" || flight->request.op==L"input.drag") {
      for (uint32_t click=0;click<flight->request.count;++click) {
        const InputRelease button{InputReleaseKind::mouse_button,0,0,false,flight->request.button}; const auto ticket=reserve(flight,button);
        first=pointer(flight,0); down(flight,ticket,first);
        if (flight->request.op==L"input.drag") for (size_t i=1;i<flight->request.points.size();++i) { const auto point=pointer(flight,i); event(flight,point,{InputEventKind::move,point.point}); }
        up(flight,ticket);
      }
    } else if (flight->request.op==L"input.scroll") {
      if (flight->request.dx) { const auto point=pointer(flight,0); InputPostedEvent scroll{InputEventKind::scroll,point.point}; scroll.dx=flight->request.dx; event(flight,point,scroll); }
      if (flight->request.dy) { const auto point=pointer(flight,0); InputPostedEvent scroll{InputEventKind::scroll,point.point}; scroll.dy=flight->request.dy; event(flight,point,scroll); }
    }
    std::vector<OwnedTicket> remaining; { std::lock_guard lock(mutex); remaining=flight->tickets; }
    for (auto item=remaining.rbegin();item!=remaining.rend();++item) if (item->ticket.release.kind!=InputReleaseKind::mouse_button) up(flight,*item);
  }
  void run_keyboard(const std::shared_ptr<Flight>& flight) {
    flight->window=backend.focused_window(flight->session); match(flight->request.targets.front(),flight->window); (void)keyboard(flight,true);
    if (flight->request.op==L"input.type") {
      const auto chunks=split_input_unicode(flight->request.text); if (!chunks) invalid();
      for (const auto& chunk:*chunks) {
        (void)keyboard(flight,false);
        for (size_t index=0;index<chunk.size();) {
          const auto count=chunk[index]>=0xd800 && chunk[index]<=0xdbff?2U:1U;
          std::vector<OwnedTicket> tickets; std::vector<InputPostedEvent> events;
          for (size_t unit=0;unit<count;++unit) { const InputRelease release{InputReleaseKind::unicode_key,VK_PACKET,static_cast<WORD>(chunk[index+unit]),false,0}; tickets.push_back(reserve(flight,release)); events.push_back({InputEventKind::unicode_down,{},release,0,0,backend.tag}); events.push_back({InputEventKind::unicode_up,{},release,0,0,backend.tag}); }
          if (!flight->prepared || !observations.fresh(*flight->prepared,20)) (void)keyboard(flight,false);
          InputPostResult outcome=InputPostResult::not_posted;
          try { commit(flight,{},[&] { journal.post(flight->lease,[&] {
            for (const auto& ticket:tickets) attempted(flight,ticket);
            outcome=InputPostResult::uncertain; outcome=backend.post_batch(events,flight->context.is_current);
            if (outcome==InputPostResult::not_posted) for (const auto& ticket:tickets) attempted(flight,ticket,false);
            return outcome;
          }); }); } catch (...) { if (outcome==InputPostResult::uncertain) { std::lock_guard lock(mutex); faulted=true; } throw; }
          for (const auto& ticket:tickets) {
            if (outcome!=InputPostResult::accepted) { backend.guardian->retire(ticket.ticket,outcome==InputPostResult::not_posted); if (outcome==InputPostResult::uncertain) { std::lock_guard lock(mutex); faulted=true; } failed(); }
            if (!backend.guardian->observed(ticket.ticket,true,50)) { std::lock_guard lock(mutex); faulted=true; failed(); }
            require(flight);
            receipt(flight,ticket,false);
            if (!backend.guardian->observed(ticket.ticket,false,50)) { std::lock_guard lock(mutex); faulted=true; failed(); }
            require(flight);
            receipt(flight,ticket,true);
            retire_completed(flight,ticket);
          }
          index+=count;
        }
      }
      return;
    }
    for (uint32_t repeat=0;repeat<flight->request.repeats;++repeat) {
      (void)keyboard(flight,true); std::vector<OwnedTicket> tickets;
      for (const auto& key:flight->chord->keys) tickets.push_back(reserve(flight,key.release));
      for (size_t i=0;i<tickets.size();++i) { (void)keyboard(flight,i+1==tickets.size()); down(flight,tickets[i],{}); }
      flight->full_chord.store(true);
      if (flight->request.op==L"input.hold" && flight->request.milliseconds>0) return;
      for (auto item=tickets.rbegin();item!=tickets.rend();++item) up(flight,*item);
    }
  }
  void handle(std::wstring_view op,const JsonObject& args,const OperationContext& context,Dispatcher::Completion done) {
    std::shared_ptr<Flight> flight;
    try {
      if (!context.session || !context.is_current || !context.is_current()) changed();
      InputRequest request(op,args,*context.session);
      flight=std::make_shared<Flight>(std::move(request),*context.session,context,std::move(done));
      {
        std::lock_guard lock(mutex); if (closed || faulted || cleaning || !debt.empty()) throw Failure{L"unavailable",L"Native input cleanup must complete before input."};
        if (active) throw Failure{L"busy",L"Another native input operation is active."}; flight->lease=journal.begin(); flight->started=now(); active=flight;
      }
      if (flight->session.paused) throw Failure{L"stopped",L"The native computer session is paused."};
      if (flight->request.pointer) { flight->receipt=backend.receipt(flight->request.capture_id,flight->session); (void)pointer(flight,0); }
      else { flight->window=backend.focused_window(flight->session); (void)keyboard(flight,true); }
      if (flight->session.mode!=L"foreground") throw Failure{L"needs_foreground",L"Windows input requires foreground mode."};
      if (!backend.guardian->ready()) throw Failure{L"unavailable",L"The native input release guardian is unavailable."}; require(flight);
      if (flight->request.pointer) run_pointer(flight); else run_keyboard(flight);
      if (flight->request.op==L"input.hold" && flight->request.milliseconds>0) return;
      require(flight); (void)journal.release(flight->lease,0); if (journal.pending(flight->lease)) failed(); finish(flight,Reply{});
    } catch (const Failure& failure) {
      if (flight && flight->lease.worker) { queue_cleanup(flight); finish(flight,failure); }
      else if (flight) finish(flight,failure);
      else done(failure);
    } catch (...) {
      if (flight && flight->lease.worker) { queue_cleanup(flight); finish(flight,Failure{L"failed",L"The native input operation failed."}); }
      else if (flight) finish(flight,Failure{L"failed",L"The native input operation failed."});
      else done(Failure{L"failed",L"The native input operation failed."});
    }
  }
  uint32_t release_all() noexcept {
    try {
      std::shared_ptr<Flight> flight; Cancel cancel, cancel_inspection;
      { std::lock_guard lock(mutex); flight=active; if (flight) { flight->expired.store(true); flight->finished.store(true); cancel=std::move(flight->cancel); cancel_inspection=std::move(flight->cancel_inspection); } (void)journal.release_all(0); }
      if (cancel) cancel(); if (cancel_inspection) cancel_inspection();
      // Keep active installed until queue_cleanup has inhibited admissions and invalidated the lease.
      if (flight) queue_cleanup(flight);
      { std::lock_guard lock(mutex); if (active==flight) active.reset(); }
    } catch (...) { std::lock_guard lock(mutex); faulted=true; cleanup_unknown=true; }
    return 0;
  }
  PreparedCleanup prepare_release_all() {
    const auto credit=std::make_shared<CleanupCredit>();
    { std::lock_guard lock(mutex);
      // Each actual release belongs to the first control that claims this exact private ticket.
      // Later controls await the same barrier without receiving duplicate release credit.
      for (auto& item:debt) if (!item.second.credit) item.second.credit=credit;
      if (active) for (auto& item:active->tickets) if (item.attempted && !item.credit) {
        const auto found=debt.find(item.ticket.id);
        item.credit=found!=debt.end() && found->second.credit?found->second.credit:credit;
      }
      (void)release_all();
    }
    return [weak=weak_from_this(),credit,used=std::make_shared<std::atomic<bool>>(false)](CleanupCompletion done) {
      if (used->exchange(true)) { done(false,0); return; }
      if (const auto state=weak.lock()) state->await_cleanup(credit,std::move(done));
      else done(false,0);
    };
  }
  void await_cleanup(std::shared_ptr<CleanupCredit> credit,CleanupCompletion done) {
    std::vector<OwnedTicket> retry;
    { std::lock_guard lock(mutex);
      cleanup_waiters.push_back({std::move(credit),std::move(done)});
      if (!cleaning && !debt.empty()) { for (const auto& item:debt) retry.push_back(item.second); ++cleaning; }
    }
    if (!retry.empty()) {
      try { schedule(0,[weak=weak_from_this(),retry=std::move(retry)] {
        if (const auto state=weak.lock()) {
          try { (void)state->guardian_cleanup(retry); } catch (...) {}
          { std::lock_guard lock(state->mutex); if (state->cleaning) --state->cleaning; }
          state->complete_cleanup_waiters();
        }
      }); } catch (...) { std::lock_guard lock(mutex); faulted=true; if (cleaning) --cleaning; }
    }
    complete_cleanup_waiters();
  }
  void close() noexcept {
    { std::lock_guard lock(mutex); if (closed) return; closed=true; }
    (void)release_all(); // No parent UP is synthesized without the guardian's matching hook receipt.
    try { backend.guardian->close(); if (observations.close) observations.close(); if (backend.close) backend.close(); } catch (...) {}
    if (timers) timers->close();
    if (inspection_timers) inspection_timers->close();
  }
};

InputService::InputService(InputObservationProvider observations,InputBackend backend,Schedule schedule,std::function<uint64_t()> now,Schedule inspections)
  : state_(std::make_shared<State>(std::move(observations),std::move(backend),std::move(schedule),std::move(now),std::move(inspections))) {}
InputService::~InputService() { close(); }
JsonObject InputService::features() const { JsonObject value; value.Insert(L"input.pointer",JsonValue::CreateBooleanValue(true)); value.Insert(L"input.keyboard",JsonValue::CreateBooleanValue(true)); value.Insert(L"input.unicode",JsonValue::CreateBooleanValue(true)); value.Insert(L"background",JsonValue::CreateBooleanValue(false)); return value; }
void InputService::handle(std::wstring_view op,const JsonObject& args,const OperationContext& context,Dispatcher::Completion done) { state_->handle(op,args,context,std::move(done)); }
uint32_t InputService::release_all() noexcept { return state_->release_all(); }
void InputService::release_all_async(CleanupCompletion done) { state_->prepare_release_all()(std::move(done)); }
InputService::PreparedCleanup InputService::prepare_release_all() { return state_->prepare_release_all(); }
void InputService::close() noexcept { if (state_) state_->close(); }
}
