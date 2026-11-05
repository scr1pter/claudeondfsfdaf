#include "user_input.h"
#include <algorithm>
#include <deque>
#include <map>
#include <stdexcept>

namespace vector::computer {
namespace {
void check(bool value,const char* label){if(!value)throw std::runtime_error(label);}
constexpr uint64_t private_marker=0x1234567800000001ULL;
struct WorkQueue {
  std::deque<UserInputService::Task> jobs;
  void run(){for(size_t i=0;!jobs.empty();++i){check(i<1024,"user-input.synthetic-queue-quiesces");auto body=std::move(jobs.front());jobs.pop_front();body();}}
};
struct TimerQueue {
  struct Entry{uint64_t at;UserInputService::Task body;};
  uint64_t& now;uint64_t sequence=0;std::map<uint64_t,Entry> jobs;std::vector<UserInputService::Task> history;
  UserInputService::Cancel add(uint32_t ms,UserInputService::Task body){const auto id=++sequence;history.push_back(body);jobs.emplace(id,Entry{now+ms,std::move(body)});return [this,id]{jobs.erase(id);};}
  std::optional<uint64_t> next()const{std::optional<uint64_t> value;for(const auto& pair:jobs)if(!value || pair.second.at<*value)value=pair.second.at;return value;}
  void run(){for(size_t i=0;i<1024;++i){auto first=jobs.end();for(auto item=jobs.begin();item!=jobs.end();++item)if(item->second.at<=now && (first==jobs.end() || item->second.at<first->second.at))first=item;
    if(first==jobs.end())return;auto body=std::move(first->second.body);jobs.erase(first);body();}throw std::runtime_error("user-input.synthetic-timers-quiesce");}
};
struct Fixture {
  uint64_t now=1000;ServerSession session;UserInputListenerStatus listener{true,true,true,1};WindowsSurfaceState environment=WindowsSurfaceState::ready;
  bool start_ok=true,probe_ok=true,backend_closed=false;uint64_t environment_age=0;
  size_t starts=0,closes=0,samples=0,wakes=0;std::function<void(UserInputSample)> receiver;
  WorkQueue events,observations;TimerQueue timers{now};std::vector<uint64_t> probes;
  struct Physical{JsonObject document;ServerSession session;bool takeover,locally_halted;};
  struct Stop{std::wstring by;ServerSession session;bool locally_halted;};
  struct Detection{bool alive;std::wstring reason;ServerSession session;};
  std::vector<Physical> physical;std::vector<Stop> stops;std::vector<Detection> detection;
  std::unique_ptr<UserInputService> service;
  explicit Fixture(bool begin=true){
    session.id=L"raw-input-test";session.run_epoch=10;session.observation_epoch=11;session.revision=1;
    session.mode=L"foreground";session.esc_stops=true;session.stop_chord=L"Control+Alt+Shift+Escape";
    UserInputBackend backend;
    backend.start=[this](auto callback){++starts;receiver=std::move(callback);return start_ok;};
    backend.status=[this]{return listener;};
    backend.environment=[this]{++samples;return UserInputEnvironment{environment,now>=environment_age?now-environment_age:0};};
    backend.probe=[this](uint64_t marker){probes.push_back(marker);return probe_ok;};
    backend.close=[this]{if(!backend_closed){backend_closed=true;++closes;}};
    UserInputCallbacks callbacks;
    callbacks.physical=[this](const auto& document,const auto& authority,bool takeover){physical.push_back({document,authority,takeover,!service->foreground_ready(authority)});return true;};
    callbacks.stop=[this](auto by,const auto& authority){stops.push_back({std::wstring(by),authority,!service->foreground_ready(authority)});return true;};
    callbacks.detection=[this](bool alive,auto reason,const auto& authority){detection.push_back({alive,std::wstring(reason),authority});return true;};
    callbacks.readiness_changed=[this](const auto&){++wakes;};
    service=std::make_unique<UserInputService>(private_marker,std::move(callbacks),std::move(backend),
      [this](auto body){events.jobs.push_back(std::move(body));},[this](auto ms,auto body){return timers.add(ms,std::move(body));},[this]{return now;},
      [this](auto body){observations.jobs.push_back(std::move(body));});
    if(begin){check(service->start(),"user-input.synthetic-listener-start");service->session_changed(session);advance(100);}
  }
  void drain(){observations.run();events.run();}
  void advance(uint64_t ms,bool observe=true,bool deliver=true){const auto target=now+ms;
    for(size_t i=0;;++i){check(i<4096,"user-input.synthetic-clock-bounded");const auto at=timers.next();if(!at || *at>target)break;now=*at;timers.run();if(observe)observations.run();if(deliver)events.run();}
    now=target;if(observe)observations.run();if(deliver)events.run();
  }
  UserInputSample sample(UserInputKind kind=UserInputKind::pointer,UserInputOrigin source=UserInputOrigin::hardware){
    UserInputSample value;value.kind=kind;value.origin=source;value.listener_generation=listener.generation;value.observed_at_ms=now;value.motion_only=kind==UserInputKind::pointer;return value;
  }
  void emit(UserInputSample value,bool deliver=true){check(static_cast<bool>(receiver),"user-input.synthetic-receiver-installed");receiver(std::move(value));if(deliver)events.run();}
  void ack(std::optional<uint64_t> marker={}){check(!probes.empty(),"user-input.probe-actually-requested");auto value=sample(UserInputKind::pointer,UserInputOrigin::injected);value.extra_information=static_cast<uint32_t>(marker.value_or(probes.back()));value.cursor=UserInputCursor{0,0,1,2};emit(std::move(value));}
  void ready(){ack();check(service->foreground_ready(session),"user-input.actual-injected-probe-proof-is-ready");}
  void key(WORD key,UserInputModifier modifier=UserInputModifier::none,UserInputOrigin source=UserInputOrigin::hardware,bool down=true){auto value=sample(down?UserInputKind::key_down:UserInputKind::key_up,source);value.virtual_key=key;value.modifier=modifier;emit(std::move(value));}
  void point(int64_t x,int64_t y,uintptr_t monitor=1,double dpi=2,UserInputOrigin source=UserInputOrigin::hardware){auto value=sample(UserInputKind::pointer,source);value.cursor=UserInputCursor{x,y,monitor,dpi};emit(std::move(value));}
  bool failed(std::wstring_view reason)const{return std::any_of(detection.begin(),detection.end(),[&](const auto& value){return !value.alive && value.reason==reason;});}
};
}

size_t run_user_input_tests(){
  size_t groups=0;const auto test=[&](const auto& body){body();++groups;};
  test([]{
    check(parse_user_input_chord(L"Control+Alt+Shift+Escape")==UserInputChord{VK_ESCAPE,7} && parse_user_input_chord(L"Ctrl+Shift+X")==UserInputChord{'X',5} &&
      parse_user_input_chord(L"Ctrl+Alt+Plus")==UserInputChord{VK_OEM_PLUS,3} && parse_user_input_chord(L"Control+Shift+-")==UserInputChord{VK_OEM_MINUS,5},"user-input.stop-chord-canonical-virtual-keys");
    for(const auto chord:{L"Escape",L"Shift+X",L"Ctrl+X",L"Control+Control+Shift+X",L"Win+Shift+X",L"Ctrl+Alt+Delete",L"Ctrl+Alt+Left",L"Alt+Shift+Tab",L"Ctrl+Shift+Escape",L"Ctrl+Alt+Unknown",L"Ctrl++Shift+X",L"Ctrl+Shift+é"})
      check(!parse_user_input_chord(chord),"user-input.stop-chord-refuses-ambiguous-or-reserved-config");
  });
  test([]{INPUT_MESSAGE_SOURCE source{};source.deviceType=IMDT_KEYBOARD;source.originId=IMO_HARDWARE;
    check(classify_user_input_origin(source,true,RIM_TYPEKEYBOARD)==UserInputOrigin::hardware && classify_user_input_origin(source,false,RIM_TYPEKEYBOARD)==UserInputOrigin::unknown &&
      classify_user_input_origin(source,true,RIM_TYPEMOUSE)==UserInputOrigin::unknown,"user-input-actual-native-origin-requires-current-known-matching-message-source");
    source.originId=IMO_INJECTED;check(classify_user_input_origin(source,true,RIM_TYPEKEYBOARD)==UserInputOrigin::injected,"user-input-native-sendinput-origin-is-distinguished");
    source.deviceType=IMDT_TOUCHPAD;source.originId=IMO_HARDWARE;check(classify_user_input_origin(source,true,RIM_TYPEMOUSE)==UserInputOrigin::hardware,"user-input-touchpad-origin-does-not-depend-on-nonnull-device-handle");
    source.originId=IMO_SYSTEM;check(classify_user_input_origin(source,true,RIM_TYPEMOUSE)==UserInputOrigin::unknown,"user-input-system-source-is-not-invented-physical-input");});
  test([]{Fixture f(false);check(f.starts==0 && f.samples==0 && f.probes.empty() && !f.service->features().GetNamedBoolean(L"userInput.detect"),"user-input.constructor-is-inert");f.service->close();check(f.closes==1,"user-input.inert-close-is-bounded-and-idempotent");});
  test([]{Fixture f(false);f.start_ok=false;check(!f.service->start() && !f.service->start() && f.starts==1 && !f.service->features().GetNamedBoolean(L"stop.chord"),"user-input.failed-start-never-advertises-or-replaces-listener");});
  test([]{Fixture f(false);f.service->session_changed(f.session);check(f.service->readiness(f.session)==UserInputReadiness::unavailable,"user-input-prestart-session-has-no-positive-proof");check(f.service->start(),"user-input-explicit-start-can-bind-accepted-prestart-session");f.drain();f.ack();check(f.service->foreground_ready(f.session),"user-input-prestart-session-still-needs-real-poststart-probe");});
  test([]{Fixture f;check(f.service->readiness(f.session)==UserInputReadiness::pending && f.probes.size()==1 && f.detection.empty(),"user-input-registration-and-send-acceptance-alone-do-not-prove-delivery");});
  test([]{Fixture f;f.ready();check(f.detection.size()==1 && f.detection[0].alive && f.wakes==1 && f.service->features().GetNamedBoolean(L"userInput.detect"),"user-input-positive-actual-probe-publishes-health");});
  test([]{Fixture f;check(static_cast<uint32_t>(f.probes[0])!=0 && static_cast<uint32_t>(f.probes[0])!=static_cast<uint32_t>(private_marker) && (f.probes[0]>>32)==(private_marker>>32),"user-input-probe-is-distinct-private32bit-projection-not-full-tag-roundtrip");});
  test([]{Fixture f;auto value=f.sample(UserInputKind::pointer,UserInputOrigin::unknown);value.extra_information=static_cast<uint32_t>(f.probes[0]);f.emit(value);check(!f.service->foreground_ready(f.session) && f.failed(L"probe_missing"),"user-input-unknown-source-cannot-ack-even-with-matching-marker");});
  test([]{Fixture f;f.emit(f.sample(UserInputKind::key_down,UserInputOrigin::unknown),false);f.ack();f.events.run();check(!f.service->foreground_ready(f.session) && f.failed(L"probe_missing") && std::none_of(f.detection.begin(),f.detection.end(),[](const auto& value){return value.alive;}),"user-input-valid-probe-cannot-silently-unpause-after-unknown-input");});
  test([]{Fixture f;auto value=f.sample(UserInputKind::pointer,UserInputOrigin::hardware);value.extra_information=static_cast<uint32_t>(f.probes[0]);f.emit(value);check(!f.service->foreground_ready(f.session) && f.physical.size()==1 && f.physical[0].takeover,"user-input-marker-alone-never-hides-hardware-style-input");});
  test([]{Fixture f;auto value=f.sample(UserInputKind::click,UserInputOrigin::injected);value.extra_information=static_cast<uint32_t>(f.probes[0]);f.emit(value);check(f.service->readiness(f.session)==UserInputReadiness::pending && f.physical.empty(),"user-input-injected-button-is-never-a-motion-probe-receipt");});
  test([]{Fixture f;auto value=f.sample(UserInputKind::pointer,UserInputOrigin::injected);value.extra_information=static_cast<uint32_t>(private_marker);f.emit(value);check(f.service->readiness(f.session)==UserInputReadiness::pending && f.detection.empty(),"user-input-regular-own-source-input-cannot-renew-probe-proof");});
  test([]{Fixture f;f.advance(499);check(!f.failed(L"probe_missing"),"user-input-probe-has-its-whole500ms-budget");f.advance(1);check(f.failed(L"probe_missing") && f.service->readiness(f.session)==UserInputReadiness::unavailable,"user-input-missing-real-receipt-fails-at500ms");f.ack();check(!f.service->foreground_ready(f.session),"user-input-late-receipt-cannot-recover-expired-challenge");});
  test([]{Fixture f;f.ready();f.advance(1999);check(f.probes.size()==1,"user-input-no-extra-probes-before2s");f.advance(1);check(f.probes.size()==2 && f.probes[0]!=f.probes[1] && f.service->foreground_ready(f.session),"user-input-current-proof-survives-pending-next-challenge");f.ack();check(f.service->foreground_ready(f.session),"user-input-second-real-receipt-renews-health");});
  test([]{Fixture f;const auto old=f.probes.back();++f.session.observation_epoch;f.service->session_changed(f.session);f.advance(100);f.ack(old);check(!f.service->foreground_ready(f.session),"user-input-old-phase-probe-never-renews-new-phase");f.ack();check(f.service->foreground_ready(f.session),"user-input-new-phase-needs-its-own-challenge");});
  test([]{Fixture f;const auto old=f.session;f.ready();++f.session.run_epoch;f.service->session_changed(f.session);check(!f.service->foreground_ready(old) && !f.service->foreground_ready(f.session),"user-input-reused-wire-session-retires-private-run-proof");f.advance(100);f.ack();check(f.service->foreground_ready(f.session) && !f.service->foreground_ready(old),"user-input-fresh-run-proof-does-not-authorize-old-run");});
  test([]{Fixture f;auto value=f.sample(UserInputKind::pointer,UserInputOrigin::injected);value.extra_information=static_cast<uint32_t>(f.probes.back());++value.listener_generation;f.emit(value);check(!f.service->foreground_ready(f.session),"user-input-foreign-listener-generation-cannot-ack");});
  test([]{Fixture f;f.ready();++f.listener.generation;f.advance(100);check(!f.service->foreground_ready(f.session) && f.failed(L"probe_missing"),"user-input-listener-replacement-invalidates-old-proof");++f.session.observation_epoch;f.service->session_changed(f.session);f.advance(100);f.ack();check(f.service->foreground_ready(f.session),"user-input-new-listener-requires-new-private-phase");});
  test([]{Fixture f;f.ready();f.key('A');check(f.physical.size()==1 && f.physical[0].takeover && f.physical[0].locally_halted && !f.service->foreground_ready(f.session),"user-input-hardware-key-halts-locally-before-callback");const auto doc=f.physical[0].document;check(doc.GetNamedString(L"event")==L"user_input" && doc.GetNamedString(L"kind")==L"key" && doc.Size()==2,"user-input-ordinary-key-identity-never-enters-wire-event");});
  test([]{Fixture f;f.ready();f.key(VK_LSHIFT,UserInputModifier::shift_left,UserInputOrigin::injected);f.key(VK_ESCAPE);check(f.stops.size()==1 && f.stops[0].by==L"esc" && f.stops[0].locally_halted,"user-input-injected-modifiers-never-become-hardware-stop-state");});
  test([]{Fixture f;f.ready();f.key(VK_ESCAPE,UserInputModifier::none,UserInputOrigin::injected);check(f.stops.empty() && f.physical.empty() && f.service->foreground_ready(f.session),"user-input-agent-escape-never-triggers-stop");});
  test([]{Fixture f;f.session.esc_stops=false;f.service->session_changed(f.session);f.advance(100);f.ready();f.key(VK_ESCAPE);check(f.stops.empty() && f.physical.size()==1 && f.physical[0].takeover,"user-input-escape-suspension-keeps-other-hardware-takeover-active");});
  test([]{Fixture f;f.session.paused=true;f.session.esc_stops=false;f.service->session_changed(f.session);f.advance(100);f.ready();f.key(VK_LCONTROL,UserInputModifier::control_left);f.key(VK_LMENU,UserInputModifier::alt_left);f.key(VK_LSHIFT,UserInputModifier::shift_left);f.key(VK_ESCAPE);check(f.stops.size()==1 && f.stops[0].by==L"chord" && f.stops[0].locally_halted,"user-input-stop-chord-is-active-during-paused-phase");});
  test([]{Fixture f;f.session.paused=true;f.service->session_changed(f.session);f.advance(100);f.ready();f.key(VK_ESCAPE);check(f.stops.empty() && f.physical.size()==1 && !f.physical[0].takeover,"user-input-plain-escape-outside-working-is-not-stop");});
  test([]{Fixture f;f.session.paused=true;f.service->session_changed(f.session);f.advance(100);f.ready();f.key(VK_LCONTROL,UserInputModifier::control_left);
    f.service->session_changed({});const auto before=f.physical.size();f.key(VK_LCONTROL,UserInputModifier::control_left,UserInputOrigin::hardware,false);
    check(f.physical.size()==before && f.stops.empty(),"user-input-unscoped-hardware-release-updates-only-listener-state");
    ++f.session.run_epoch;++f.session.observation_epoch;f.session.paused=false;f.service->session_changed(f.session);f.advance(100);f.ready();f.key(VK_ESCAPE);
    check(f.stops.size()==1 && f.stops[0].by==L"esc","user-input-real-modifier-up-between-tasks-does-not-mask-next-plain-escape");});
  test([]{for(const bool foreign_listener:{false,true}){Fixture f;f.session.paused=true;f.service->session_changed(f.session);f.advance(100);f.ready();f.key(VK_LCONTROL,UserInputModifier::control_left);f.service->session_changed({});
    auto release=f.sample(UserInputKind::key_up,foreign_listener?UserInputOrigin::hardware:UserInputOrigin::injected);release.virtual_key=VK_LCONTROL;release.modifier=UserInputModifier::control_left;if(foreign_listener)++release.listener_generation;f.emit(release);
    ++f.session.run_epoch;++f.session.observation_epoch;f.session.paused=false;f.service->session_changed(f.session);f.advance(100);f.ready();f.key(VK_ESCAPE);
    check(f.stops.empty() && f.physical.back().takeover,"user-input-unscoped-injected-or-foreign-listener-release-cannot-fabricate-no-modifier-proof");}});
  test([]{Fixture f;f.ready();f.point(14,0);check(f.physical.empty() && f.service->foreground_ready(f.session),"user-input-7dip-motion-is-ignored");f.point(30,0);check(f.physical.size()==1 && f.physical[0].document.GetNamedNumber(L"dx")==8 && f.physical[0].takeover,"user-input-8dip-motion-pauses-with-real-scaled-distance");});
  test([]{Fixture f;f.ready();f.point(1000,0,1,2,UserInputOrigin::injected);f.point(1014,0);check(f.physical.empty() && f.service->foreground_ready(f.session),"user-input-own-cursor-motion-rebases-real-physical-position-without-takeover");});
  test([]{Fixture f;f.ready();f.point(1,1,2,1.5);check(f.physical.size()==1 && f.physical[0].takeover && !f.physical[0].document.HasKey(L"dx"),"user-input-monitor-dpi-transition-never-guesses-global-logical-delta");});
  test([]{for(const auto kind:{UserInputKind::click,UserInputKind::scroll}){Fixture f;f.ready();f.emit(f.sample(kind));check(f.physical.size()==1 && f.physical[0].takeover && f.physical[0].locally_halted,"user-input-real-button-or-wheel-takes-over-without-distance-threshold");}});
  test([]{for(const auto state:{WindowsSurfaceState::elevated,WindowsSurfaceState::secure_desktop,WindowsSurfaceState::unavailable}){Fixture f(false);f.environment=state;check(f.service->start(),"user-input-listener-is-not-an-elevation-bypass");f.service->session_changed(f.session);f.advance(100);check(f.probes.empty() && !f.service->foreground_ready(f.session) && f.failed(state==WindowsSurfaceState::elevated?L"elevated_foreground":state==WindowsSurfaceState::secure_desktop?L"secure_desktop":L"probe_missing"),"user-input-unavailable-desktop-never-posts-probe-or-claims-alive");}});
  test([]{Fixture f;f.ready();f.environment_age=500;f.advance(100);check(!f.service->foreground_ready(f.session) && f.failed(L"probe_missing"),"user-input-environment-proof-must-be-current-not-only-well-typed");});
  test([]{Fixture f;f.ready();f.advance(500,false,true);check(!f.service->foreground_ready(f.session) && f.failed(L"probe_missing"),"user-input-independent-timer-detects-stalled-environment-worker");});
  test([]{Fixture f;auto value=f.sample(UserInputKind::pointer,UserInputOrigin::injected);value.extra_information=static_cast<uint32_t>(f.probes.back());f.emit(value,false);++f.session.observation_epoch;f.service->session_changed(f.session);f.events.run();check(f.detection.empty() && f.wakes==0,"user-input-queued-old-health-notice-never-publishes-to-new-phase");});
  test([]{Fixture f;auto value=f.sample(UserInputKind::pointer,UserInputOrigin::injected);value.extra_information=static_cast<uint32_t>(f.probes.back());f.emit(value,false);f.environment=WindowsSurfaceState::secure_desktop;f.advance(100,true,false);f.events.run();check(std::none_of(f.detection.begin(),f.detection.end(),[](const auto& value){return value.alive;}) && f.failed(L"secure_desktop"),"user-input-queued-alive-notice-rechecks-current-same-phase-facts");});
  test([]{Fixture f;f.ready();f.physical.clear();auto value=f.sample(UserInputKind::click);f.emit(value,false);++f.session.run_epoch;f.service->session_changed(f.session);f.events.run();check(f.physical.empty(),"user-input-queued-old-hardware-event-cannot-act-on-replacement-run");});
  test([]{Fixture f;f.ready();const auto callbacks=f.timers.history;f.service->close();f.service->close();f.key('A');for(const auto& callback:callbacks)callback();f.drain();check(f.closes==1 && f.physical.empty() && !f.service->foreground_ready(f.session),"user-input-close-retires-callbacks-timers-and-listener-once");});
  return groups;
}
}
