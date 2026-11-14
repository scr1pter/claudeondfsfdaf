#pragma once
#include "availability.h"
#include "server.h"
#include <array>
#include <memory>

namespace vector::computer {
enum class UserInputOrigin { unknown, hardware, injected };
enum class UserInputKind { pointer, click, scroll, key_down, key_up, configuration };
enum class UserInputModifier : uint8_t { none, control_left, control_right, alt_left, alt_right, shift_left, shift_right, meta_left, meta_right };
enum class UserInputReadiness { unavailable, pending, ready };
enum class UserInputSetupState { needs_calibration, calibrating, ready, unavailable };
struct UserInputSetupStatus {
  UserInputSetupState state=UserInputSetupState::needs_calibration;
  bool mouse=false,keyboard=false;
};
UserInputOrigin classify_user_input_origin(const INPUT_MESSAGE_SOURCE&,bool known,DWORD raw_type)noexcept;
struct UserInputCursor {
  int64_t x=0,y=0;
  uintptr_t monitor=0;
  double dpi_scale=0;
};
struct UserInputSample {
  UserInputKind kind=UserInputKind::configuration;
  UserInputOrigin origin=UserInputOrigin::unknown;
  uint64_t listener_generation=0,observed_at_ms=0;
  uint32_t extra_information=0;
  std::optional<UserInputCursor> cursor;
  // Ephemeral Stop/Shift-calibration recognition only. No ordinary key history reaches events/logs.
  WORD virtual_key=0;
  UserInputModifier modifier=UserInputModifier::none;
  bool motion_only=false;
  uint64_t context_generation=0;
};
struct UserInputListenerStatus {
  bool installed=false,registered=false,alive=false;
  uint64_t generation=0;
  uint64_t context_generation=0;
};
struct UserInputChord { WORD key=0; uint32_t modifiers=0; bool operator==(const UserInputChord&)const=default; };
std::optional<UserInputChord> parse_user_input_chord(std::wstring_view);
struct UserInputEnvironment {
  WindowsSurfaceState state=WindowsSurfaceState::unavailable;
  uint64_t observed_at_ms=0;
  uint64_t context_generation=0;
};
// Private listener-thread metadata, never a raw input event or evidence of recent hardware delivery.
struct UserInputHealthChallenge {
  uint64_t listener_generation=0,context_generation=0,scope_ticket=0;
  uint64_t run_epoch=0,observation_epoch=0,revision=0,sequence=0,sent_at_ms=0,deadline_ms=0;
  bool operator==(const UserInputHealthChallenge&)const=default;
};
struct UserInputHealthReceipt {
  UserInputHealthChallenge challenge;
  UserInputEnvironment environment;
  uint64_t observed_at_ms=0;
  bool healthy=false;
};
struct UserInputBackend {
  // Constructors are inert. Only a verified serving worker calls start. The native callback copies
  // bounded structural Raw Input facts; no Dispatcher, UIA, trust, capture or content work runs there.
  std::function<bool(std::function<void(UserInputSample)>,std::function<void(UserInputHealthReceipt)>)> start;
  std::function<UserInputListenerStatus()> status;
  std::function<UserInputEnvironment()> environment;
  // Consumed on the same raw listener thread after bounded pumping and actual route/context checks.
  std::function<bool(const UserInputHealthChallenge&)> health;
  std::function<void()> close;
  static UserInputBackend system();
};
struct UserInputCallbacks {
  // Enqueued off the Raw Input callback. Dispatcher owns exact scope, local revocation, actual
  // input cleanup and final wire publication; callback false means the original scope was retired.
  std::function<bool(const JsonObject&,const ServerSession&,bool takeover)> physical;
  std::function<bool(std::wstring_view by,const ServerSession&)> stop;
  std::function<bool(bool alive,std::wstring_view reason,const ServerSession&)> detection;
  // Enqueue-only wake for a bounded pending-readiness operation; never an implicit Resume.
  std::function<void(const ServerSession&)> readiness_changed;
};
class UserInputService final {
 public:
  using Task=std::function<void()>;
  using Execute=std::function<void(Task)>;
  using Cancel=std::function<void()>;
  using Schedule=std::function<Cancel(uint32_t,Task)>;
  explicit UserInputService(uint64_t private_marker,UserInputCallbacks,
                            UserInputBackend=UserInputBackend::system(),Execute={},Schedule={},std::function<uint64_t()> now={},Execute observations={});
  ~UserInputService();
  bool start();
  UserInputSetupStatus setup_status()const;
  // Private diagnostic metadata only; a healthy pump never grants hardware calibration or mutation.
  bool listener_health_ready()const;
  bool setup_start();
  void setup_reset();
  // Metadata/enqueue only: safe from Dispatcher authority. Every accepted phase gets a new ticket.
  void session_changed(std::optional<ServerSession>);
  UserInputReadiness readiness(const ServerSession&)const;
  bool foreground_ready(const ServerSession&)const;
  JsonObject features()const;
  void close()noexcept;
 private:
  struct State;
  std::shared_ptr<State> state_;
};
size_t run_user_input_tests();
}
