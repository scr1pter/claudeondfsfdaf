#include "user_input.h"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <deque>
#include <limits>
#include <map>
#include <mutex>
#include <thread>

namespace vector::computer {
namespace {
uint64_t monotonic() { return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count()); }
bool same_session(const ServerSession& a,const ServerSession& b) {
  return a.run_epoch!=0 && a.observation_epoch!=0 && a.run_epoch==b.run_epoch && a.observation_epoch==b.observation_epoch && a.id==b.id && a.revision==b.revision;
}
bool valid_cursor(const UserInputCursor& value) { return value.monitor!=0 && std::isfinite(value.dpi_scale) && value.dpi_scale>=0.25 && value.dpi_scale<=16; }
bool healthy(const UserInputListenerStatus& value) { return value.installed && value.registered && value.alive && value.generation!=0; }
std::wstring lower(std::wstring_view value) { std::wstring result(value); for (auto& c:result) if (c>=L'A' && c<=L'Z') c=static_cast<wchar_t>(c+32); return result; }
std::wstring trim(std::wstring_view value) { while (!value.empty() && value.front()==L' ') value.remove_prefix(1); while (!value.empty() && value.back()==L' ') value.remove_suffix(1); return lower(value); }
WORD stop_key(std::wstring_view key) {
  if (key.size()==1 && ((key[0]>=L'a' && key[0]<=L'z') || (key[0]>=L'0' && key[0]<=L'9'))) return static_cast<WORD>(key[0]>=L'a'?key[0]-32:key[0]);
  const std::map<std::wstring_view,WORD> values{{L"escape",WORD{VK_ESCAPE}},{L"esc",WORD{VK_ESCAPE}},{L"space",WORD{VK_SPACE}},{L"spacebar",WORD{VK_SPACE}},
    {L"enter",WORD{VK_RETURN}},{L"return",WORD{VK_RETURN}},{L"tab",WORD{VK_TAB}},{L"backspace",WORD{VK_BACK}},{L"delete",WORD{VK_DELETE}},{L"del",WORD{VK_DELETE}},
    {L"insert",WORD{VK_INSERT}},{L"ins",WORD{VK_INSERT}},{L"left",WORD{VK_LEFT}},{L"arrowleft",WORD{VK_LEFT}},{L"right",WORD{VK_RIGHT}},{L"arrowright",WORD{VK_RIGHT}},
    {L"up",WORD{VK_UP}},{L"arrowup",WORD{VK_UP}},{L"down",WORD{VK_DOWN}},{L"arrowdown",WORD{VK_DOWN}},{L"home",WORD{VK_HOME}},{L"end",WORD{VK_END}},{L"pageup",WORD{VK_PRIOR}},{L"pagedown",WORD{VK_NEXT}},
    {L"plus",WORD{VK_OEM_PLUS}},{L"minus",WORD{VK_OEM_MINUS}},{L"-",WORD{VK_OEM_MINUS}}};
  if (const auto found=values.find(key);found!=values.end()) return found->second;
  if (key.size()>=2 && key.size()<=3 && key[0]==L'f') {
    unsigned n=0; for (size_t i=1;i<key.size();++i) { if (key[i]<L'0' || key[i]>L'9') return 0; n=n*10+static_cast<unsigned>(key[i]-L'0'); }
    if (n>=1 && n<=24) return static_cast<WORD>(VK_F1+n-1);
  }
  return 0;
}
// Separate finite event/observation workers and an independent timer. No thread starts until the
// verified serving worker explicitly calls start; injected unit seams create no native thread.
struct UserInputRuntime : std::enable_shared_from_this<UserInputRuntime> {
  using Task=UserInputService::Task;
  struct Queue { std::mutex mutex; std::condition_variable wake; std::deque<Task> jobs; bool closed=false,ready=false; };
  struct Timers { std::mutex mutex; std::condition_variable wake; std::map<uint64_t,std::pair<uint64_t,Task>> jobs; uint64_t next=0; bool closed=false,ready=false; };
  std::shared_ptr<Queue> events=std::make_shared<Queue>(),observations=std::make_shared<Queue>();
  std::shared_ptr<Timers> timers=std::make_shared<Timers>(); bool started=false;
  static void run(const std::shared_ptr<Queue>& queue) {
    try { winrt::init_apartment(winrt::apartment_type::multi_threaded); } catch (...) { std::lock_guard lock(queue->mutex); queue->closed=true;queue->wake.notify_all(); return; }
    std::unique_lock lock(queue->mutex);
    queue->ready=true;queue->wake.notify_all();
    while (!queue->closed) { if (queue->jobs.empty()) { queue->wake.wait(lock); continue; }
      auto body=std::move(queue->jobs.front()); queue->jobs.pop_front(); lock.unlock(); try { body(); } catch (...) {} lock.lock(); }
    lock.unlock(); winrt::uninit_apartment();
  }
  void start() {
    if (started) return; started=true;
    std::thread([queue=events]{run(queue);}).detach(); std::thread([queue=observations]{run(queue);}).detach();
    std::thread([clock=timers] {
      try { winrt::init_apartment(winrt::apartment_type::multi_threaded); } catch (...) { std::lock_guard lock(clock->mutex); clock->closed=true;clock->wake.notify_all(); return; }
      std::unique_lock lock(clock->mutex);
      clock->ready=true;clock->wake.notify_all();
      while (!clock->closed) {
        if (clock->jobs.empty()) { clock->wake.wait(lock); continue; }
        const auto selected=std::min_element(clock->jobs.begin(),clock->jobs.end(),[](const auto& a,const auto& b){return a.second.first<b.second.first;});
        const auto due=selected->second.first,time=monotonic(); if (time<due) { clock->wake.wait_for(lock,std::chrono::milliseconds(due-time)); continue; }
        auto body=std::move(selected->second.second); clock->jobs.erase(selected); lock.unlock(); try { body(); } catch (...) {} lock.lock();
      }
      lock.unlock(); winrt::uninit_apartment();
    }).detach();
    for(const auto& queue:{events,observations}) {std::unique_lock lock(queue->mutex);if(!queue->wake.wait_for(lock,std::chrono::milliseconds(100),[&]{return queue->ready || queue->closed;}) || !queue->ready)throw Failure{L"unavailable",L"The independent input detector worker is unavailable."};}
    std::unique_lock lock(timers->mutex);if(!timers->wake.wait_for(lock,std::chrono::milliseconds(100),[&]{return timers->ready || timers->closed;}) || !timers->ready)throw Failure{L"unavailable",L"The independent input detector timer is unavailable."};
  }
  UserInputService::Execute execute(bool observe) {
    return [queue=observe?observations:events](Task task) { std::lock_guard lock(queue->mutex);
      if (queue->closed || queue->jobs.size()>=256) throw Failure{L"unavailable",L"The input detector queue is unavailable."};
      queue->jobs.push_back(std::move(task)); queue->wake.notify_one(); };
  }
  UserInputService::Cancel schedule(uint32_t ms,Task task) {
    std::lock_guard lock(timers->mutex); if (timers->closed || timers->jobs.size()>=256 || timers->next==std::numeric_limits<uint64_t>::max()) throw Failure{L"unavailable",L"The input detector timer is unavailable."};
    const auto id=++timers->next; timers->jobs.emplace(id,std::make_pair(monotonic()+std::min<uint32_t>(ms,30000),std::move(task))); timers->wake.notify_all();
    return [clock=timers,id] {std::lock_guard lock(clock->mutex);clock->jobs.erase(id);clock->wake.notify_all();};
  }
  void close() { for (const auto& queue:{events,observations}) { std::lock_guard lock(queue->mutex); queue->closed=true;queue->jobs.clear();queue->wake.notify_all(); }
    std::lock_guard lock(timers->mutex);timers->closed=true;timers->jobs.clear();timers->wake.notify_all(); }
};
}

std::optional<UserInputChord> parse_user_input_chord(std::wstring_view value) {
  if (value.empty() || value.size()>64 || std::any_of(value.begin(),value.end(),[](wchar_t c){return c<32 || c>126;})) return {};
  UserInputChord chord; size_t start=0,parts=0,mods=0;
  for (size_t index=0;index<=value.size();++index) {
    if (index<value.size() && value[index]!=L'+') continue;
    if (++parts>5) return {}; const auto token=trim(value.substr(start,index-start)); start=index+1; if (token.empty()) return {};
    uint32_t bit=0;
    if (token==L"ctrl" || token==L"control" || token==L"ctl" || token==L"commandorcontrol" || token==L"cmdorctrl") bit=1;
    else if (token==L"alt" || token==L"option" || token==L"opt") bit=2;
    else if (token==L"shift") bit=4;
    else if (token==L"meta" || token==L"super" || token==L"win" || token==L"windows" || token==L"cmd" || token==L"command") return {};
    if (bit) { if (chord.modifiers&bit) return {}; chord.modifiers|=bit;++mods;continue; }
    if(chord.key)return {};const auto key=stop_key(token);if(!key)return {};chord.key=key;
  }
  if (!chord.key || mods<2 || !(chord.modifiers&3)) return {};
  const bool control=(chord.modifiers&1)!=0,alt=(chord.modifiers&2)!=0;
  if ((alt && (chord.key==VK_TAB || chord.key==VK_SPACE || chord.key==VK_F4)) ||
      (alt && !control && chord.key==VK_ESCAPE) || (control && !alt && chord.key==VK_ESCAPE) ||
      (control && alt && (chord.key==VK_DELETE || chord.key==VK_END || chord.key==VK_TAB || (chord.key>=VK_LEFT && chord.key<=VK_DOWN)))) return {};
  return chord;
}

struct UserInputService::State : std::enable_shared_from_this<UserInputService::State> {
  struct Scope {
    ServerSession session; uint64_t ticket=0,listener=0,created=0; std::optional<UserInputChord> chord;
    std::optional<UserInputCursor> cursor; std::optional<uint64_t> pulse,last_probe; std::optional<UserInputEnvironment> environment;
    bool revoked=false,failed=false; std::optional<bool> reported; std::wstring reason;
  };
  struct Challenge { std::shared_ptr<Scope> scope; uint64_t sequence=0,marker=0,sent=0; };
  struct Notice { enum Kind{physical,stop,detection,wake} kind; std::shared_ptr<Scope> scope; UserInputKind input=UserInputKind::pointer;
    std::optional<double> dx,dy; bool flag=false; std::wstring reason; };
  const uint64_t marker; UserInputCallbacks callbacks; UserInputBackend backend; Execute execute,observe; Schedule schedule; std::function<uint64_t()> now;
  std::shared_ptr<UserInputRuntime> runtime; mutable std::mutex mutex; bool started=false,closed=false,observation_busy=false;
  uint64_t sequence=0,scope_ticket=0; UserInputListenerStatus listener; std::shared_ptr<Scope> scope; std::optional<Challenge> challenge;
  std::array<bool,8> modifiers{}; Cancel cancel_tick,cancel_challenge;
  State(uint64_t own,UserInputCallbacks receiver,UserInputBackend source,Execute events,Schedule timer,std::function<uint64_t()> clock,Execute observations)
    :marker(own),callbacks(std::move(receiver)),backend(std::move(source)),execute(std::move(events)),observe(std::move(observations)),schedule(std::move(timer)),now(clock?std::move(clock):monotonic) {
    if (!marker || !backend.start || !backend.status || !backend.environment || !backend.probe || !backend.close || !callbacks.physical || !callbacks.stop || !callbacks.detection)
      throw Failure{L"unavailable",L"The physical input detector is incomplete."};
    if (!execute || !schedule) { runtime=std::make_shared<UserInputRuntime>(); if (!execute) execute=runtime->execute(false);
      if (!observe) observe=runtime->execute(true); if (!schedule) schedule=[timer_runtime=runtime](auto ms,auto body){return timer_runtime->schedule(ms,std::move(body));}; }
    if (!observe) observe=execute;
  }
  bool current_locked(const std::shared_ptr<Scope>& value)const { return started && !closed && scope==value && value && value->ticket!=0; }
  UserInputReadiness ready_locked(const std::shared_ptr<Scope>& value,uint64_t time)const {
    if (!current_locked(value) || !healthy(listener) || listener.generation!=value->listener || !value->chord || value->revoked || value->failed) return UserInputReadiness::unavailable;
    if(challenge && challenge->scope==value && (time<challenge->sent || time-challenge->sent>=500))return UserInputReadiness::unavailable;
    if(!value->environment && (time<value->created || time-value->created>=500))return UserInputReadiness::unavailable;
    if (!value->environment || !value->pulse) return UserInputReadiness::pending;
    if (value->environment->state!=WindowsSurfaceState::ready || time<value->environment->observed_at_ms || time-value->environment->observed_at_ms>=500 ||
        time<*value->pulse || time-*value->pulse>=2500) return UserInputReadiness::unavailable;
    return UserInputReadiness::ready;
  }
  void deliver(Notice notice) {
    {std::lock_guard lock(mutex);if (!current_locked(notice.scope)) return;
      if(notice.kind==Notice::detection && (notice.scope->reported!=notice.flag || notice.scope->reason!=notice.reason ||
          (notice.flag && ready_locked(notice.scope,now())!=UserInputReadiness::ready)))return;
    }
    const auto& session=notice.scope->session;
    if (notice.kind==Notice::wake) {if(callbacks.readiness_changed)callbacks.readiness_changed(session);return;}
    if (notice.kind==Notice::stop) {(void)callbacks.stop(notice.reason,session);return;}
    if (notice.kind==Notice::detection) {(void)callbacks.detection(notice.flag,notice.reason,session);return;}
    JsonObject fields;
    fields.Insert(L"kind",JsonValue::CreateStringValue(notice.input==UserInputKind::pointer?L"pointer":notice.input==UserInputKind::click?L"click":notice.input==UserInputKind::scroll?L"scroll":L"key"));
    if(notice.dx)fields.Insert(L"dx",JsonValue::CreateNumberValue(*notice.dx));if(notice.dy)fields.Insert(L"dy",JsonValue::CreateNumberValue(*notice.dy));
    (void)callbacks.physical(event_document(L"user_input",fields),session,notice.flag);
  }
  void post(Notice notice)noexcept {
    const auto expected=notice.scope;
    try {execute([weak=weak_from_this(),notice=std::move(notice)] {if(const auto state=weak.lock())state->deliver(notice);});}
    catch (...) {std::lock_guard lock(mutex);if(current_locked(expected)){expected->failed=true;expected->revoked=true;}}
  }
  std::optional<Notice> detection_locked(const std::shared_ptr<Scope>& value,bool alive,std::wstring reason) {
    if(!current_locked(value) || value->session.mode!=L"foreground")return {};
    if(!alive)value->revoked=true;
    if(value->reported==alive && value->reason==reason)return {};
    value->reported=alive;value->reason=reason;return Notice{Notice::detection,value,UserInputKind::pointer,{},{},alive,std::move(reason)};
  }
  void sample(UserInputSample value)noexcept {
    std::shared_ptr<Scope> expected;
    try {
      std::vector<Notice> notices;Cancel retire_timeout;
      {std::lock_guard lock(mutex);const auto current=scope;expected=current;const auto time=now();
        if(!started || closed || !value.listener_generation || value.listener_generation!=listener.generation)return;
        // The listener outlives tasks. Actual hardware modifier releases between accepted sessions
        // must retire their matching state even though no task can receive an event at that time.
        if(value.origin==UserInputOrigin::hardware && (value.kind==UserInputKind::key_down || value.kind==UserInputKind::key_up) && value.modifier!=UserInputModifier::none &&
            value.observed_at_ms<=time && time-value.observed_at_ms<500) {
          const auto index=static_cast<size_t>(value.modifier)-1;if(index<modifiers.size())modifiers[index]=value.kind==UserInputKind::key_down;
        }
        if(!current_locked(current) || value.listener_generation!=current->listener || value.observed_at_ms<current->created || value.observed_at_ms>time || time-value.observed_at_ms>=500)return;
        if(value.kind==UserInputKind::configuration) {current->failed=true;if(auto notice=detection_locked(current,false,L"probe_missing"))notices.push_back(std::move(*notice));}
        else {
          std::optional<double> dx,dy;
          if(value.kind==UserInputKind::pointer || value.kind==UserInputKind::click || value.kind==UserInputKind::scroll) {
            if(value.cursor && valid_cursor(*value.cursor)) {
              if(current->cursor && current->cursor->monitor==value.cursor->monitor && current->cursor->dpi_scale==value.cursor->dpi_scale) {
                dx=(static_cast<double>(value.cursor->x)-static_cast<double>(current->cursor->x))/value.cursor->dpi_scale;
                dy=(static_cast<double>(value.cursor->y)-static_cast<double>(current->cursor->y))/value.cursor->dpi_scale;
              }
              current->cursor=value.cursor;
            } else current->cursor.reset();
          }
          const bool probe=challenge && challenge->scope==current && value.origin==UserInputOrigin::injected && value.kind==UserInputKind::pointer && value.motion_only &&
            value.extra_information==static_cast<uint32_t>(challenge->marker) && value.observed_at_ms>=challenge->sent && time>=challenge->sent && time-challenge->sent<500;
          if(probe) {
            current->pulse=time;current->failed=false;challenge.reset();retire_timeout=std::move(cancel_challenge);
            if(ready_locked(current,time)==UserInputReadiness::ready)if(auto notice=detection_locked(current,true,L""))notices.push_back(std::move(*notice));
            notices.push_back({Notice::wake,current});
          } else if(value.origin==UserInputOrigin::unknown) {current->failed=true;if(auto notice=detection_locked(current,false,L"probe_missing"))notices.push_back(std::move(*notice));}
          else if(value.origin==UserInputOrigin::hardware) {
            uint32_t bits=0;for(size_t i=0;i<modifiers.size();++i)if(modifiers[i])bits|=1U<<(i/2);
            const bool key_down=value.kind==UserInputKind::key_down;
            const bool chord=key_down && current->chord && value.virtual_key==current->chord->key && bits==current->chord->modifiers;
            const bool escape=key_down && value.virtual_key==VK_ESCAPE && bits==0 && current->session.mode==L"foreground" && !current->session.paused && current->session.esc_stops;
            if(chord || escape) {current->revoked=true;notices.push_back({Notice::stop,current,UserInputKind::pointer,{},{},false,chord?L"chord":L"esc"});}
            else {
              const bool working=current->session.mode==L"foreground" && !current->session.paused;
              const bool takeover=working && (value.kind!=UserInputKind::pointer || !dx || !dy || std::hypot(*dx,*dy)>=8);
              if(takeover)current->revoked=true;
              if(value.kind!=UserInputKind::pointer || !working || takeover)notices.push_back({Notice::physical,current,value.kind,dx,dy,takeover});
            }
          }
        }
      }
      if(retire_timeout)retire_timeout();
      for(auto& notice:notices)post(std::move(notice));
    } catch (...) {std::lock_guard lock(mutex);if(current_locked(expected)){expected->failed=true;expected->revoked=true;}}
  }
  void challenge_expired(const std::shared_ptr<Scope>& expected,uint64_t expected_sequence) {
    std::optional<Notice> notice;
    {std::lock_guard lock(mutex);if(!current_locked(expected) || !challenge || challenge->scope!=expected || challenge->sequence!=expected_sequence)return;
      const auto time=now();if(time>=challenge->sent && time-challenge->sent<500)return;
      challenge.reset();cancel_challenge={};expected->failed=true;notice=detection_locked(expected,false,L"probe_missing");
    }
    if(notice)post(std::move(*notice));post({Notice::wake,expected});
  }
  void cycle(const std::shared_ptr<Scope>& expected) {
    {std::lock_guard lock(mutex);if(!current_locked(expected)){observation_busy=false;return;}}
    UserInputListenerStatus status;UserInputEnvironment environment;
    try {status=backend.status();environment=backend.environment();}catch(...){environment={WindowsSurfaceState::unavailable,now()};}
    std::vector<Notice> notices;std::optional<uint64_t> probe;
    {std::lock_guard lock(mutex);observation_busy=false;if(!current_locked(expected))return;listener=status;const auto time=now();expected->environment=environment;
      const auto reason=environment.state==WindowsSurfaceState::secure_desktop?L"secure_desktop":environment.state==WindowsSurfaceState::elevated?L"elevated_foreground":L"probe_missing";
      if(!healthy(status) || status.generation!=expected->listener || environment.state!=WindowsSurfaceState::ready || environment.observed_at_ms>time || time-environment.observed_at_ms>=500 || !expected->chord) {
        expected->failed=true;if(auto notice=detection_locked(expected,false,reason))notices.push_back(std::move(*notice));
      } else if(!challenge && (!expected->last_probe || time<*expected->last_probe || time-*expected->last_probe>=2000)) {
        uint32_t projection=0;bool found=false;
        while(sequence<MAXDWORD) {projection=static_cast<uint32_t>(marker)^static_cast<uint32_t>(++sequence);if(projection && projection!=static_cast<uint32_t>(marker)){found=true;break;}}
        if(found) {const auto token=(marker&0xffffffff00000000ULL)|projection;challenge=Challenge{expected,sequence,token,time};expected->last_probe=time;probe=token;}
        else {expected->failed=true;if(auto notice=detection_locked(expected,false,L"probe_missing"))notices.push_back(std::move(*notice));}
      }
      if(ready_locked(expected,time)==UserInputReadiness::ready)if(auto notice=detection_locked(expected,true,L""))notices.push_back(std::move(*notice));
    }
    for(auto& notice:notices)post(std::move(notice));
    if(probe) {
      uint64_t ticket=0,sent=0;
      {std::lock_guard lock(mutex);if(current_locked(expected) && challenge && challenge->marker==*probe){ticket=challenge->sequence;sent=challenge->sent;}}
      if(!ticket)return;
      const auto time=now();const auto remaining=time>=sent && time-sent<500?static_cast<uint32_t>(500-(time-sent)):0U;
      Cancel timeout;
      try{timeout=schedule(remaining,[weak=weak_from_this(),expected,ticket]{if(const auto state=weak.lock())state->challenge_expired(expected,ticket);});}
      catch(...){std::optional<Notice> notice;{std::lock_guard lock(mutex);if(current_locked(expected)){challenge.reset();expected->failed=true;notice=detection_locked(expected,false,L"probe_missing");}}if(notice)post(std::move(*notice));return;}
      bool retire=false;
      {std::lock_guard lock(mutex);retire=!current_locked(expected) || !challenge || challenge->sequence!=ticket;if(!retire)cancel_challenge=timeout;}
      if(retire){if(timeout)timeout();return;}
      bool submitted=false;try{submitted=backend.probe(*probe);}catch(...){}
      if(!submitted) {std::optional<Notice> notice;{std::lock_guard lock(mutex);if(current_locked(expected) && challenge && challenge->marker==*probe){challenge.reset();expected->failed=true;notice=detection_locked(expected,false,L"probe_missing");}}if(notice)post(std::move(*notice));}
    }
  }
  void tick() {
    std::shared_ptr<Scope> current;std::vector<Notice> notices;bool sample=false;
    {std::lock_guard lock(mutex);if(!started || closed)return;current=scope;const auto time=now();
      if(current && current->session.mode==L"foreground") {
        if(challenge && challenge->scope==current && (time<challenge->sent || time-challenge->sent>=500)) {challenge.reset();current->failed=true;if(auto notice=detection_locked(current,false,L"probe_missing"))notices.push_back(std::move(*notice));}
        if(current->environment && (time<current->environment->observed_at_ms || time-current->environment->observed_at_ms>=500)) {current->failed=true;if(auto notice=detection_locked(current,false,L"probe_missing"))notices.push_back(std::move(*notice));}
        if(!current->environment && (time<current->created || time-current->created>=500)) {current->failed=true;if(auto notice=detection_locked(current,false,L"probe_missing"))notices.push_back(std::move(*notice));}
        if(!observation_busy){observation_busy=true;sample=true;}
      }
    }
    for(auto& notice:notices)post(std::move(notice));
    if(sample)try{observe([weak=weak_from_this(),current]{if(const auto state=weak.lock())state->cycle(current);});}catch(...){std::lock_guard lock(mutex);observation_busy=false;if(current_locked(current)){current->failed=true;current->revoked=true;}}
    Cancel cancel;
    try{cancel=schedule(100,[weak=weak_from_this()]{if(const auto state=weak.lock())state->tick();});}
    catch(...){std::optional<Notice> notice;{std::lock_guard lock(mutex);if(current_locked(current)){current->failed=true;notice=detection_locked(current,false,L"probe_missing");}}if(notice)post(std::move(*notice));return;}
    bool retire=false;{std::lock_guard lock(mutex);retire=closed;if(!retire)cancel_tick=cancel;}if(retire && cancel)cancel();
  }
  bool start() {
    {std::lock_guard lock(mutex);if(closed || started)return started && !closed && healthy(listener);started=true;}
    bool installed=false;
    try {if(runtime)runtime->start();installed=backend.start([weak=weak_from_this()](UserInputSample sample){if(const auto state=weak.lock())state->sample(std::move(sample));});const auto status=backend.status();installed=installed && healthy(status);
      std::lock_guard lock(mutex);installed=installed && !closed;listener=installed?status:UserInputListenerStatus{};
      if(installed && scope){const auto accepted=scope->session;bind_locked(accepted);}
    }catch(...){installed=false;}
    if(!installed){try{backend.close();}catch(...){}if(runtime)runtime->close();return false;}
    tick();return true;
  }
  void bind_locked(std::optional<ServerSession> session) {
    challenge.reset();scope.reset();
    if(session && !session->id.empty() && session->run_epoch && session->observation_epoch && scope_ticket!=std::numeric_limits<uint64_t>::max()) {
      scope=std::make_shared<Scope>();scope->session=std::move(*session);scope->ticket=++scope_ticket;scope->listener=listener.generation;scope->created=now();scope->chord=parse_user_input_chord(scope->session.stop_chord);
    }
  }
  void session_changed(std::optional<ServerSession> session) {
    Cancel retire;{std::lock_guard lock(mutex);if(closed)return;retire=std::move(cancel_challenge);bind_locked(std::move(session));}if(retire)retire();
    // A metadata-only phase hook never calls native APIs or the Dispatcher recursively.
  }
  UserInputReadiness readiness(const ServerSession& expected)const {std::lock_guard lock(mutex);return scope && same_session(scope->session,expected)?ready_locked(scope,now()):UserInputReadiness::unavailable;}
  JsonObject features()const {std::lock_guard lock(mutex);const auto installed=started && !closed && healthy(listener);JsonObject result;for(const auto key:{L"userInput.detect",L"stop.esc",L"stop.chord"})result.Insert(key,JsonValue::CreateBooleanValue(installed));return result;}
  void close()noexcept {
    Cancel cancel,challenge_cancel;{std::lock_guard lock(mutex);if(closed)return;closed=true;scope.reset();challenge.reset();cancel=std::move(cancel_tick);challenge_cancel=std::move(cancel_challenge);}
    try{if(cancel)cancel();if(challenge_cancel)challenge_cancel();backend.close();}catch(...){}if(runtime)runtime->close();
  }
};

UserInputService::UserInputService(uint64_t marker,UserInputCallbacks callbacks,UserInputBackend backend,Execute execute,Schedule schedule,std::function<uint64_t()> now,Execute observations)
  :state_(std::make_shared<State>(marker,std::move(callbacks),std::move(backend),std::move(execute),std::move(schedule),std::move(now),std::move(observations))){}
UserInputService::~UserInputService(){close();}
bool UserInputService::start(){return state_->start();}
void UserInputService::session_changed(std::optional<ServerSession> session){state_->session_changed(std::move(session));}
UserInputReadiness UserInputService::readiness(const ServerSession& session)const{return state_->readiness(session);}
bool UserInputService::foreground_ready(const ServerSession& session)const{return readiness(session)==UserInputReadiness::ready;}
JsonObject UserInputService::features()const{return state_->features();}
void UserInputService::close()noexcept{if(state_)state_->close();}
}
