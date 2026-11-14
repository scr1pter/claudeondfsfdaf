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
bool healthy(const UserInputListenerStatus& value) { return value.installed && value.registered && value.alive && value.generation!=0 && value.context_generation!=0; }
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
    try{std::thread([queue=events]{run(queue);}).detach();}catch(...){throw UserInputFailure::runtime_events;}
    try{std::thread([queue=observations]{run(queue);}).detach();}catch(...){throw UserInputFailure::runtime_observations;}
    try{std::thread([clock=timers] {
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
    }).detach();}catch(...){throw UserInputFailure::runtime_timer;}
    for(const auto& queue:{events,observations}) {std::unique_lock lock(queue->mutex);if(!queue->wake.wait_for(lock,std::chrono::milliseconds(100),[&]{return queue->ready || queue->closed;}) || !queue->ready)throw queue==events?UserInputFailure::runtime_events:UserInputFailure::runtime_observations;}
    std::unique_lock lock(timers->mutex);if(!timers->wake.wait_for(lock,std::chrono::milliseconds(100),[&]{return timers->ready || timers->closed;}) || !timers->ready)throw UserInputFailure::runtime_timer;
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

std::wstring_view user_input_failure_stage(UserInputFailure failure)noexcept {
  constexpr std::array<std::wstring_view,static_cast<size_t>(UserInputFailure::count)> stages{
    L"",L"input-start-runtime-events",L"input-start-runtime-observations",L"input-start-runtime-timer",
    L"input-start-native-owner",L"input-start-native-generation",L"input-start-native-events",L"input-start-native-thread",
    L"input-start-native-class",L"input-start-native-window",L"input-start-native-routes-query",L"input-start-native-routes-existing",
    L"input-start-native-register",L"input-start-native-readback",L"input-start-native-ready-timeout",L"input-start-native-status",
    L"input-listener-native-failed",L"input-listener-native-wait",L"input-listener-native-route-lost",L"input-listener-native-quit",
    L"input-start-service",L"input-listener-service-closed"};
  const auto index=static_cast<size_t>(failure);return index<stages.size()?stages[index]:std::wstring_view{};
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
    std::optional<ServerSession> session; bool setup=false;
    uint64_t ticket=0,listener=0,context=0,created=0;
    std::optional<UserInputChord> chord; std::optional<UserInputCursor> cursor;
    std::optional<uint64_t> pulse,last_health; std::optional<UserInputEnvironment> environment;
    bool revoked=false,failed=false; std::optional<bool> reported; std::wstring reason;
  };
  struct Calibration {
    UserInputSetupState state=UserInputSetupState::needs_calibration;
    uint64_t listener=0,context=0;
    bool mouse=false,keyboard=false; UserInputModifier shift=UserInputModifier::none;
    std::optional<UserInputCursor> cursor;
  } calibration;
  struct Challenge { std::shared_ptr<Scope> scope; UserInputHealthChallenge request; };
  struct Notice { enum Kind{physical,stop,detection,wake} kind; std::shared_ptr<Scope> scope; UserInputKind input=UserInputKind::pointer;
    std::optional<double> dx,dy; bool flag=false; std::wstring reason; };
  UserInputCallbacks callbacks; UserInputBackend backend; Execute execute,observe; Schedule schedule; std::function<uint64_t()> now;
  std::shared_ptr<UserInputRuntime> runtime; mutable std::mutex mutex;
  bool started=false,closed=false,observation_busy=false;
  bool start_succeeded=false;UserInputFailure start_failure=UserInputFailure::none;UserInputListenerStatus start_snapshot;
  uint64_t sequence=0,scope_ticket=0; UserInputListenerStatus listener;
  std::optional<UserInputEnvironment> environment;
  std::shared_ptr<Scope> scope,setup_scope; std::optional<Challenge> challenge;
  std::array<bool,8> modifiers{}; Cancel cancel_tick,cancel_challenge,deferred_cancel;
  std::optional<Notice> deferred_notice;
  State(uint64_t own,UserInputCallbacks receiver,UserInputBackend source,Execute events,Schedule timer,std::function<uint64_t()> clock,Execute observations)
    :callbacks(std::move(receiver)),backend(std::move(source)),execute(std::move(events)),observe(std::move(observations)),schedule(std::move(timer)),now(clock?std::move(clock):monotonic) {
    if (!own || !backend.start || !backend.status || !backend.environment || !backend.health || !backend.close || !callbacks.physical || !callbacks.stop || !callbacks.detection)
      throw Failure{L"unavailable",L"The physical input detector is incomplete."};
    if (!execute || !schedule) { runtime=std::make_shared<UserInputRuntime>(); if (!execute) execute=runtime->execute(false);
      if (!observe) observe=runtime->execute(true); if (!schedule) schedule=[timer_runtime=runtime](auto ms,auto body){return timer_runtime->schedule(ms,std::move(body));}; }
    if (!observe) observe=execute;
  }
  bool current_locked(const std::shared_ptr<Scope>& value)const { return started && !closed && scope==value && value && value->ticket!=0 && value->session.has_value(); }
  bool active_locked(const std::shared_ptr<Scope>& value)const {return started && !closed && value && value->ticket && (scope==value || setup_scope==value);}
  std::shared_ptr<Scope> selected_locked()const{return setup_scope?setup_scope:scope;}
  bool calibrated_locked()const {return calibration.state==UserInputSetupState::ready && calibration.listener==listener.generation && calibration.context==listener.context_generation;}
  bool fresh_environment(const UserInputEnvironment& value,uint64_t time,uint64_t context)const {
    return value.state==WindowsSurfaceState::ready && context && value.context_generation==context && value.observed_at_ms<=time && time-value.observed_at_ms<500;
  }
  bool health_ready_locked(const std::shared_ptr<Scope>& value,uint64_t time)const {
    return active_locked(value) && healthy(listener) && value->listener==listener.generation && value->context==listener.context_generation && !value->failed && !value->revoked &&
      value->pulse && time>=*value->pulse && time-*value->pulse<2500 && value->environment && fresh_environment(*value->environment,time,value->context) &&
      (!challenge || challenge->scope!=value || (time>=challenge->request.sent_at_ms && time<challenge->request.deadline_ms));
  }
  std::shared_ptr<Scope> make_scope_locked(bool setup,const std::optional<ServerSession>& session={}) {
    if(scope_ticket==std::numeric_limits<uint64_t>::max())return {};
    auto value=std::make_shared<Scope>();value->setup=setup;value->ticket=++scope_ticket;
    value->listener=listener.generation;value->context=listener.context_generation;value->created=now();
    if(session){value->session=*session;value->chord=parse_user_input_chord(session->stop_chord);}
    return value;
  }
  Cancel retire_locked(){challenge.reset();return std::move(cancel_challenge);}
  UserInputReadiness ready_locked(const std::shared_ptr<Scope>& value,uint64_t time)const {
    if(!current_locked(value) || !healthy(listener) || !calibrated_locked() || value->listener!=listener.generation || value->context!=listener.context_generation || !value->chord || value->revoked || value->failed)return UserInputReadiness::unavailable;
    if(challenge && challenge->scope==value && (time<challenge->request.sent_at_ms || time>=challenge->request.deadline_ms))return UserInputReadiness::unavailable;
    if(!value->environment || !value->pulse)return time>=value->created && time-value->created<500?UserInputReadiness::pending:UserInputReadiness::unavailable;
    if(!fresh_environment(*value->environment,time,value->context) || time<*value->pulse || time-*value->pulse>=2500)return UserInputReadiness::unavailable;
    return UserInputReadiness::ready;
  }
  void deliver(Notice notice) {
    {std::lock_guard lock(mutex);if(!current_locked(notice.scope))return;
      if(notice.kind==Notice::detection && (notice.scope->reported!=notice.flag || notice.scope->reason!=notice.reason || (notice.flag && ready_locked(notice.scope,now())!=UserInputReadiness::ready)))return;
    }
    const auto& session=*notice.scope->session;
    if(notice.kind==Notice::wake){if(callbacks.readiness_changed)callbacks.readiness_changed(session);return;}
    if(notice.kind==Notice::stop){(void)callbacks.stop(notice.reason,session);return;}
    if(notice.kind==Notice::detection){(void)callbacks.detection(notice.flag,notice.reason,session);return;}
    JsonObject fields;fields.Insert(L"kind",JsonValue::CreateStringValue(notice.input==UserInputKind::pointer?L"pointer":notice.input==UserInputKind::click?L"click":notice.input==UserInputKind::scroll?L"scroll":L"key"));
    if(notice.dx)fields.Insert(L"dx",JsonValue::CreateNumberValue(*notice.dx));if(notice.dy)fields.Insert(L"dy",JsonValue::CreateNumberValue(*notice.dy));
    (void)callbacks.physical(event_document(L"user_input",fields),session,notice.flag);
  }
  void post(Notice notice)noexcept {
    try{execute([weak=weak_from_this(),notice=std::move(notice)]{if(const auto state=weak.lock())state->deliver(notice);});}
    catch(...){std::lock_guard lock(mutex);calibration={};calibration.state=UserInputSetupState::unavailable;if(scope){scope->failed=true;scope->revoked=true;}}
  }
  std::optional<Notice> detection_locked(const std::shared_ptr<Scope>& value,bool alive,std::wstring reason) {
    if(!current_locked(value) || value->session->mode!=L"foreground")return {};
    if(!alive)value->revoked=true;
    if(value->reported==alive && value->reason==reason)return {};
    value->reported=alive;value->reason=reason;return Notice{Notice::detection,value,UserInputKind::pointer,{},{},alive,std::move(reason)};
  }
  void fail_locked(std::vector<Notice>& notices,std::wstring reason=L"probe_missing") {
    calibration={};calibration.state=UserInputSetupState::unavailable;
    if(setup_scope){setup_scope->failed=true;setup_scope->revoked=true;}
    if(scope){scope->failed=true;if(auto notice=detection_locked(scope,false,std::move(reason)))notices.push_back(std::move(*notice));}
  }
  void finish_calibration_locked(uint64_t time) {
    if(calibration.state==UserInputSetupState::calibrating && calibration.mouse && calibration.keyboard && setup_scope && !setup_scope->failed && !setup_scope->revoked &&
      setup_scope->pulse && time>=*setup_scope->pulse && time-*setup_scope->pulse<2500 && setup_scope->environment && fresh_environment(*setup_scope->environment,time,calibration.context)) {
      calibration.state=UserInputSetupState::ready;calibration.cursor.reset();calibration.shift=UserInputModifier::none;
    }
  }
  void health_receipt(UserInputHealthReceipt value)noexcept {
    std::vector<Notice> notices;Cancel retire;
    try{{std::lock_guard lock(mutex);if(!challenge || !active_locked(challenge->scope) || value.challenge!=challenge->request)return;
      const auto expected=challenge->scope;const auto time=now();const auto& request=challenge->request;
      if(expected->failed || expected->revoked)return;
      if(!value.healthy || !healthy(listener) || request.listener_generation!=listener.generation || request.context_generation!=listener.context_generation ||
        time<request.sent_at_ms || time>=request.deadline_ms || request.deadline_ms-request.sent_at_ms!=500 || value.observed_at_ms<request.sent_at_ms || value.observed_at_ms>time ||
        value.environment.observed_at_ms<request.sent_at_ms || value.environment.observed_at_ms>value.observed_at_ms || !fresh_environment(value.environment,time,request.context_generation)) {
        fail_locked(notices);retire=retire_locked();
      } else {
        expected->pulse=time;expected->environment=value.environment;environment=value.environment;retire=retire_locked();
        if(expected->setup)finish_calibration_locked(time);
        else {if(ready_locked(expected,time)==UserInputReadiness::ready)if(auto notice=detection_locked(expected,true,L""))notices.push_back(std::move(*notice));notices.push_back({Notice::wake,expected});}
      }
    }if(retire)retire();for(auto& notice:notices)post(std::move(notice));}
    catch(...){std::lock_guard lock(mutex);calibration={};calibration.state=UserInputSetupState::unavailable;if(scope){scope->failed=true;scope->revoked=true;}}
  }
  void sample(UserInputSample value)noexcept {
    std::vector<Notice> notices;Cancel retire;
    try{{std::lock_guard lock(mutex);const auto time=now();
      if(!started || closed || !value.listener_generation || value.listener_generation<listener.generation)return;
      if(value.listener_generation!=listener.generation || !value.context_generation || value.context_generation>listener.context_generation) {
        if(value.listener_generation==listener.generation && value.context_generation>listener.context_generation)listener.context_generation=value.context_generation;
        fail_locked(notices);retire=retire_locked();
      } else if(value.context_generation==listener.context_generation && value.observed_at_ms<=time && time-value.observed_at_ms<500) {
        if(value.kind==UserInputKind::configuration || value.origin==UserInputOrigin::unknown){fail_locked(notices);retire=retire_locked();}
        else {
          if(value.origin==UserInputOrigin::hardware && (value.kind==UserInputKind::key_down || value.kind==UserInputKind::key_up) && value.modifier!=UserInputModifier::none) {
            const auto index=static_cast<size_t>(value.modifier)-1;if(index<modifiers.size())modifiers[index]=value.kind==UserInputKind::key_down;
          }
          const bool setup_event=setup_scope && calibration.state==UserInputSetupState::calibrating;
          if(setup_event && health_ready_locked(setup_scope,time) && value.observed_at_ms>=*setup_scope->pulse && value.origin==UserInputOrigin::hardware) {
            if(value.kind==UserInputKind::pointer && value.motion_only && value.cursor && valid_cursor(*value.cursor)) {
              if(calibration.cursor && calibration.cursor->monitor==value.cursor->monitor && calibration.cursor->dpi_scale==value.cursor->dpi_scale && (calibration.cursor->x!=value.cursor->x || calibration.cursor->y!=value.cursor->y))calibration.mouse=true;
              calibration.cursor=value.cursor;
            }
            const bool shift=value.modifier==UserInputModifier::shift_left || value.modifier==UserInputModifier::shift_right;
            const bool matching_key=value.virtual_key==VK_SHIFT || (value.modifier==UserInputModifier::shift_left && value.virtual_key==VK_LSHIFT) || (value.modifier==UserInputModifier::shift_right && value.virtual_key==VK_RSHIFT);
            if((value.kind==UserInputKind::key_down || value.kind==UserInputKind::key_up) && (!shift || !matching_key))calibration.shift=UserInputModifier::none;
            if(shift && matching_key) {
              if(value.kind==UserInputKind::key_down && std::none_of(modifiers.begin(),modifiers.begin()+4,[](bool down){return down;}) && std::none_of(modifiers.begin()+6,modifiers.end(),[](bool down){return down;}))calibration.shift=value.modifier;
              if(value.kind==UserInputKind::key_up && calibration.shift==value.modifier && std::none_of(modifiers.begin(),modifiers.end(),[](bool down){return down;})){calibration.keyboard=true;calibration.shift=UserInputModifier::none;}
            }
            finish_calibration_locked(time);
          }
          const auto current=scope;
          if(!setup_event && current_locked(current) && value.observed_at_ms>=current->created) {
            std::optional<double> dx,dy;
            if(value.kind==UserInputKind::pointer || value.kind==UserInputKind::click || value.kind==UserInputKind::scroll) {
              if(value.cursor && valid_cursor(*value.cursor)) {
                if(current->cursor && current->cursor->monitor==value.cursor->monitor && current->cursor->dpi_scale==value.cursor->dpi_scale){dx=(static_cast<double>(value.cursor->x)-static_cast<double>(current->cursor->x))/value.cursor->dpi_scale;dy=(static_cast<double>(value.cursor->y)-static_cast<double>(current->cursor->y))/value.cursor->dpi_scale;}
                current->cursor=value.cursor;
              }else current->cursor.reset();
            }
            if(value.origin==UserInputOrigin::hardware) {
              uint32_t bits=0;for(size_t i=0;i<modifiers.size();++i)if(modifiers[i])bits|=1U<<(i/2);
              const bool down=value.kind==UserInputKind::key_down;
              const bool chord=down && current->chord && value.virtual_key==current->chord->key && bits==current->chord->modifiers;
              const bool escape=down && value.virtual_key==VK_ESCAPE && bits==0 && current->session->mode==L"foreground" && !current->session->paused && current->session->esc_stops;
              if(chord || escape){current->revoked=true;notices.push_back({Notice::stop,current,UserInputKind::pointer,{},{},false,chord?L"chord":L"esc"});}
              else {const bool working=current->session->mode==L"foreground" && !current->session->paused;const bool takeover=working && (value.kind!=UserInputKind::pointer || !dx || !dy || std::hypot(*dx,*dy)>=8);
                if(takeover)current->revoked=true;if(value.kind!=UserInputKind::pointer || !working || takeover)notices.push_back({Notice::physical,current,value.kind,dx,dy,takeover});}
              if(current->revoked && calibrated_locked()){retire=retire_locked();if(!setup_scope)setup_scope=make_scope_locked(true);}
            }
          }
        }
      }
    }if(retire)retire();for(auto& notice:notices)post(std::move(notice));}
    catch(...){std::lock_guard lock(mutex);calibration={};calibration.state=UserInputSetupState::unavailable;if(scope){scope->failed=true;scope->revoked=true;}}
  }
  void challenge_expired(uint64_t expected_sequence) {
    std::vector<Notice> notices;std::shared_ptr<Scope> expected;
    {std::lock_guard lock(mutex);if(!challenge || challenge->request.sequence!=expected_sequence || !active_locked(challenge->scope))return;
      const auto time=now();if(time>=challenge->request.sent_at_ms && time<challenge->request.deadline_ms)return;
      expected=challenge->scope;challenge.reset();cancel_challenge={};fail_locked(notices);
    }for(auto& notice:notices)post(std::move(notice));if(expected && !expected->setup)post({Notice::wake,expected});
  }
  void cycle(const std::shared_ptr<Scope>& expected) {
    {std::lock_guard lock(mutex);if(!started || closed || selected_locked()!=expected){observation_busy=false;return;}}
    UserInputListenerStatus status;UserInputEnvironment observed_environment;
    try{status=backend.status();observed_environment=backend.environment();}catch(...){observed_environment={WindowsSurfaceState::unavailable,now(),0};}
    std::vector<Notice> notices;std::optional<UserInputHealthChallenge> issued;Cancel retire;
    {std::lock_guard lock(mutex);observation_busy=false;if(!started || closed || selected_locked()!=expected)return;
      listener=status;environment=observed_environment;const auto time=now();if(expected)expected->environment=observed_environment;
      const auto reason=observed_environment.state==WindowsSurfaceState::secure_desktop?L"secure_desktop":observed_environment.state==WindowsSurfaceState::elevated?L"elevated_foreground":L"probe_missing";
      if(!healthy(status) || !fresh_environment(observed_environment,time,status.context_generation) ||
        ((calibration.state==UserInputSetupState::calibrating || calibration.state==UserInputSetupState::ready) && (calibration.listener!=status.generation || calibration.context!=status.context_generation)) ||
        (expected && (expected->listener!=status.generation || expected->context!=status.context_generation))) {
        fail_locked(notices,reason);retire=retire_locked();
      } else if(expected && !expected->failed && !expected->revoked && (expected->setup || calibrated_locked()) &&
        !challenge && (!expected->last_health || time<*expected->last_health || time-*expected->last_health>=2000)) {
        if(sequence==std::numeric_limits<uint64_t>::max() || time>std::numeric_limits<uint64_t>::max()-500){fail_locked(notices);retire=retire_locked();}
        else {UserInputHealthChallenge request{status.generation,status.context_generation,expected->ticket,expected->session?expected->session->run_epoch:0,expected->session?expected->session->observation_epoch:0,expected->session?expected->session->revision.value_or(0):0,++sequence,time,time+500};
          challenge=Challenge{expected,request};expected->last_health=time;issued=request;}
      }
      if(expected && !expected->setup && ready_locked(expected,time)==UserInputReadiness::ready)if(auto notice=detection_locked(expected,true,L""))notices.push_back(std::move(*notice));
    }
    if(retire)retire();for(auto& notice:notices)post(std::move(notice));
    if(issued) {
      const auto time=now();const auto remaining=time>=issued->sent_at_ms && time<issued->deadline_ms?static_cast<uint32_t>(issued->deadline_ms-time):0U;
      Cancel timeout;try{timeout=schedule(remaining,[weak=weak_from_this(),ticket=issued->sequence]{if(const auto state=weak.lock())state->challenge_expired(ticket);});}
      catch(...){std::vector<Notice> failures;{std::lock_guard lock(mutex);if(challenge && challenge->request==*issued){fail_locked(failures);challenge.reset();}}for(auto& notice:failures)post(std::move(notice));return;}
      bool retired=false;{std::lock_guard lock(mutex);retired=!challenge || challenge->request!=*issued;if(!retired)cancel_challenge=timeout;}
      if(retired){if(timeout)timeout();return;}
      bool submitted=false;try{submitted=backend.health(*issued);}catch(...){}
      if(!submitted){std::vector<Notice> failures;Cancel cancel;{std::lock_guard lock(mutex);if(challenge && challenge->request==*issued){fail_locked(failures);cancel=retire_locked();}}if(cancel)cancel();for(auto& notice:failures)post(std::move(notice));}
    }
  }
  void tick() {
    std::shared_ptr<Scope> expected;std::vector<Notice> notices;Cancel retire,deferred;bool sample_metadata=false;
    {std::lock_guard lock(mutex);if(!started || closed)return;const auto time=now();expected=selected_locked();deferred=std::move(deferred_cancel);
      if(deferred_notice){notices.push_back(std::move(*deferred_notice));deferred_notice.reset();}
      if((challenge && (time<challenge->request.sent_at_ms || time>=challenge->request.deadline_ms)) ||
        (environment && !fresh_environment(*environment,time,listener.context_generation) && (calibration.state==UserInputSetupState::ready || calibration.state==UserInputSetupState::calibrating))) {
        fail_locked(notices);retire=retire_locked();
      }
      if(!observation_busy){observation_busy=true;sample_metadata=true;}
    }
    if(deferred)deferred();if(retire)retire();for(auto& notice:notices)post(std::move(notice));
    if(sample_metadata)try{observe([weak=weak_from_this(),expected]{if(const auto state=weak.lock())state->cycle(expected);});}
      catch(...){std::lock_guard lock(mutex);observation_busy=false;calibration={};calibration.state=UserInputSetupState::unavailable;if(scope){scope->failed=true;scope->revoked=true;}}
    Cancel cancel;try{cancel=schedule(100,[weak=weak_from_this()]{if(const auto state=weak.lock())state->tick();});}
      catch(...){std::lock_guard lock(mutex);calibration={};calibration.state=UserInputSetupState::unavailable;if(scope){scope->failed=true;scope->revoked=true;}return;}
    bool retired=false;{std::lock_guard lock(mutex);retired=closed;if(!retired)cancel_tick=cancel;}if(retired && cancel)cancel();
  }
  bool start() {
    {std::lock_guard lock(mutex);if(closed || started)return started && !closed && healthy(listener);started=true;}
    bool installed=false;UserInputListenerStatus snapshot;UserInputFailure failure=UserInputFailure::none;
    try{if(runtime)runtime->start();installed=backend.start([weak=weak_from_this()](UserInputSample sample){if(const auto state=weak.lock())state->sample(std::move(sample));},
      [weak=weak_from_this()](UserInputHealthReceipt receipt){if(const auto state=weak.lock())state->health_receipt(std::move(receipt));});const auto status=backend.status();snapshot=status;installed=installed && healthy(status);
      if(!installed)failure=status.failure==UserInputFailure::none?UserInputFailure::native_status:status.failure;
      std::lock_guard lock(mutex);installed=installed && !closed;listener=installed?status:UserInputListenerStatus{};
      if(installed && scope){const auto accepted=scope->session;scope=make_scope_locked(false,accepted);if(scope)scope->revoked=true;}
    }catch(UserInputFailure reason){failure=reason;installed=false;}catch(...){failure=UserInputFailure::service_start;installed=false;}
    {std::lock_guard lock(mutex);start_succeeded=installed;start_snapshot=snapshot;start_failure=closed?UserInputFailure::service_closed:failure;if(!installed)listener={};}
    if(!installed){try{backend.close();}catch(...){}if(runtime)runtime->close();return false;}
    tick();return true;
  }
  UserInputSetupStatus setup_status()const {
    std::lock_guard lock(mutex);auto state=started && !closed && healthy(listener)?calibration.state:UserInputSetupState::unavailable;
    if(state==UserInputSetupState::ready){const auto selected=selected_locked();const auto time=now();if(!health_ready_locked(selected,time))
      state=selected && !selected->failed && !selected->revoked && !selected->pulse && time>=selected->created && time-selected->created<500?UserInputSetupState::calibrating:UserInputSetupState::unavailable;}
    return {state,calibration.mouse,calibration.keyboard};
  }
  bool listener_health_ready()const {std::lock_guard lock(mutex);return health_ready_locked(selected_locked(),now());}
  UserInputDiagnostic diagnostic()const {std::lock_guard lock(mutex);return {started,start_succeeded,closed,start_failure!=UserInputFailure::none?start_failure:listener.failure,start_succeeded?listener:start_snapshot};}
  bool setup_start() {
    // Called inside the trusted UI's short Dispatcher fence: retire authority now, but
    // leave cancellation, native observation and user/Dispatcher callbacks to the timer.
    std::lock_guard lock(mutex);if(!started || closed || !healthy(listener))return false;
    if(cancel_challenge)deferred_cancel=std::move(cancel_challenge);challenge.reset();
    if(scope){scope->failed=true;scope->revoked=true;if(auto notice=detection_locked(scope,false,L"probe_missing"))deferred_notice=std::move(*notice);}
    calibration={};calibration.state=UserInputSetupState::calibrating;calibration.listener=listener.generation;calibration.context=listener.context_generation;
    setup_scope.reset();try{setup_scope=make_scope_locked(true);}catch(...){calibration.state=UserInputSetupState::unavailable;return false;}
    if(!setup_scope){calibration.state=UserInputSetupState::unavailable;return false;}return true;
  }
  void setup_reset() {
    std::lock_guard lock(mutex);if(cancel_challenge)deferred_cancel=std::move(cancel_challenge);challenge.reset();setup_scope.reset();calibration={};
    if(scope){scope->failed=true;scope->revoked=true;if(auto notice=detection_locked(scope,false,L"probe_missing"))deferred_notice=std::move(*notice);}
  }
  void session_changed(std::optional<ServerSession> session) {
    Cancel retire;{std::lock_guard lock(mutex);if(closed)return;
      // A session phase cannot retire the separate challenge of an ongoing explicit setup.
      // It retains its exact setup ticket and original deadline; actual-session health never does.
      if(calibration.state!=UserInputSetupState::calibrating || !setup_scope || !challenge || challenge->scope!=setup_scope)retire=retire_locked();
      scope.reset();
      if(calibration.state!=UserInputSetupState::calibrating)setup_scope.reset();
      if(session && !session->id.empty() && session->run_epoch && session->observation_epoch){scope=make_scope_locked(false,session);if(scope && !calibrated_locked())scope->revoked=true;}
      else if(calibrated_locked())setup_scope=make_scope_locked(true);
    }if(retire)retire();
  }
  UserInputReadiness readiness(const ServerSession& expected)const {std::lock_guard lock(mutex);return scope && scope->session && same_session(*scope->session,expected)?ready_locked(scope,now()):UserInputReadiness::unavailable;}
  JsonObject features()const {std::lock_guard lock(mutex);const auto installed=started && !closed && healthy(listener);JsonObject result;for(const auto key:{L"userInput.detect",L"stop.esc",L"stop.chord"})result.Insert(key,JsonValue::CreateBooleanValue(installed));return result;}
  void close()noexcept {
    Cancel cancel,health_cancel,pending;{std::lock_guard lock(mutex);if(closed)return;closed=true;scope.reset();setup_scope.reset();challenge.reset();calibration={};calibration.state=UserInputSetupState::unavailable;cancel=std::move(cancel_tick);health_cancel=std::move(cancel_challenge);pending=std::move(deferred_cancel);deferred_notice.reset();}
    try{if(cancel)cancel();if(health_cancel)health_cancel();if(pending)pending();backend.close();}catch(...){}if(runtime)runtime->close();
  }
};

UserInputService::UserInputService(uint64_t marker,UserInputCallbacks callbacks,UserInputBackend backend,Execute execute,Schedule schedule,std::function<uint64_t()> now,Execute observations)
  :state_(std::make_shared<State>(marker,std::move(callbacks),std::move(backend),std::move(execute),std::move(schedule),std::move(now),std::move(observations))){}
UserInputService::~UserInputService(){close();}
bool UserInputService::start(){return state_->start();}
UserInputSetupStatus UserInputService::setup_status()const{return state_->setup_status();}
bool UserInputService::listener_health_ready()const{return state_->listener_health_ready();}
UserInputDiagnostic UserInputService::diagnostic()const{return state_->diagnostic();}
bool UserInputService::setup_start(){return state_->setup_start();}
void UserInputService::setup_reset(){state_->setup_reset();}
void UserInputService::session_changed(std::optional<ServerSession> session){state_->session_changed(std::move(session));}
UserInputReadiness UserInputService::readiness(const ServerSession& session)const{return state_->readiness(session);}
bool UserInputService::foreground_ready(const ServerSession& session)const{return readiness(session)==UserInputReadiness::ready;}
JsonObject UserInputService::features()const{return state_->features();}
void UserInputService::close()noexcept{if(state_)state_->close();}
}
