#pragma once
#include "protocol.h"
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <variant>

namespace vector::computer {

struct ServerSession {
  // Accepted native authority, never decoded from reusable wire IDs/revisions.
  uint64_t run_epoch = 0;
  uint64_t observation_epoch = 0;
  std::wstring id;
  std::optional<uint64_t> revision;
  std::wstring mode = L"foreground";
  bool paused = false;
  JsonArray approved;
  JsonArray vector_pids;
  JsonArray vector_window_ids;
  JsonArray overlay_window_ids;
  bool esc_stops = false;
  std::wstring stop_chord;
};

struct OperationContext {
  std::optional<ServerSession> session;
  std::function<bool()> is_current;
  // Every actual mutation must execute inside this short authority fence.
  std::function<bool(const std::function<void()>&)> with_current;
};

class Dispatcher final {
 public:
  using Result = std::variant<Reply, Failure>;
  using Completion = std::function<void(Result)>;
  using Handler = std::function<void(const Request&, const OperationContext&, Completion)>;
  using Cancel = std::function<void()>;
  using Execute = std::function<void(std::function<void()>)>;
  using Schedule = std::function<Cancel(uint32_t, std::function<void()>)>;
  struct Options {
    // Invoked on a separate serial output executor. Native writer must obey its total 50ms
    // deadline; the final current-authority fence covers actual wire publication.
    std::function<bool(const JsonObject&, std::span<const uint8_t>)> send;
    std::function<void()> stopped = [] {};
    std::function<uint32_t()> release_all = [] { return 0U; };
    // Metadata-only/enqueue-only hooks: never native IPC or a wait under authority.
    std::function<void(std::wstring_view)> cleanup = [](std::wstring_view) {};
    std::function<void()> observations_invalidated = [] {};
    std::function<void(std::optional<ServerSession>)> session_changed = [](auto) {};
    std::function<bool()> available = [] { return true; };
    std::function<bool(const ServerSession&)> foreground_ready = [](const auto&) { return true; };
    std::function<JsonObject()> features;
    std::wstring os = L"Windows";
    bool responsible = true;
    size_t queue_limit = 1000;
    size_t pending_limit_bytes = 2 * 16'777'216;
    size_t output_limit_bytes = 2 * 16'777'216 + 8;
    Execute execute;
    Execute output_execute;
    Schedule schedule;
    std::function<uint64_t()> now;
  };

  explicit Dispatcher(Options options);
  ~Dispatcher();
  Dispatcher(const Dispatcher&) = delete;
  Dispatcher& operator=(const Dispatcher&) = delete;
  bool register_handler(std::wstring op, uint32_t deadline_ms, bool requires_session, bool mutating, Handler handler);
  void receive(const Request& request);
  // Safe for malformed-frame replies supplied by the codec, before any session exists.
  void send_protocol_failure(const JsonObject& response);
  void close(std::wstring_view reason = L"closed");
  // After close only, outside authority: bound the output executor's retirement before writer teardown.
  bool wait_for_output(uint32_t budget_ms = 200);
  std::optional<ServerSession> session_snapshot() const;
  bool closed() const;
  bool physical_input(const JsonObject& event, const ServerSession& expected, bool takeover);
  bool stop_from_physical_input(std::wstring_view by, const ServerSession& expected);
  void notify_display_change();

 private:
  struct State;
  std::shared_ptr<State> state_;
};

size_t run_server_tests();
}
