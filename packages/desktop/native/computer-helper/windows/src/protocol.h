#pragma once
#include <windows.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Data.Json.h>
#include <array>
#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <exception>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace vector::computer {
using JsonObject = winrt::Windows::Data::Json::JsonObject;
using JsonArray = winrt::Windows::Data::Json::JsonArray;
using JsonValue = winrt::Windows::Data::Json::JsonValue;
using IJsonValue = winrt::Windows::Data::Json::IJsonValue;
using JsonValueType = winrt::Windows::Data::Json::JsonValueType;
inline constexpr size_t kMaxFrameBytes = 16U * 1024U * 1024U;
inline constexpr uint64_t kMaximumSafeInteger = 9'007'199'254'740'991ULL;

struct Request {
  uint64_t id = 0;
  std::wstring op;
  JsonObject args;
  // Actual received body plus its four-byte header, never a normalized JSON re-encoding.
  size_t encoded_bytes = 0;
};
struct Reply { JsonObject fields; std::vector<uint8_t> image; };
struct Failure { std::wstring code; std::wstring message; };

class ProtocolError final : public std::exception {
 public:
  ProtocolError(uint64_t request_id, std::wstring error_code, std::wstring error_message);
  const char* what() const noexcept override;
  uint64_t id;
  std::wstring code;
  std::wstring message;
};

std::optional<uint64_t> safe_integer(const IJsonValue& value);
std::optional<int64_t> signed_integer(const IJsonValue& value);
bool strict_utf8(std::span<const uint8_t> bytes) noexcept;
Request parse_request(std::span<const uint8_t> body);
JsonObject response_success(uint64_t id, const JsonObject& fields = JsonObject{});
JsonObject response_failure(uint64_t id, std::wstring_view code, std::wstring_view message);
JsonObject event_document(std::wstring_view name, const JsonObject& fields = JsonObject{});
std::vector<uint8_t> encode_json(const IJsonValue& value);
size_t encoded_size(const JsonObject& document);
std::vector<uint8_t> frame_bytes(std::span<const uint8_t> bytes);
std::vector<uint8_t> frame_document(const JsonObject& document);
bool run_protocol_self_test();

/// One I/O reader owns this state. Oversize bodies are discarded without allocation or parsing.
class FrameReader final {
 public:
  using OnRequest = std::function<void(Request)>;
  using OnFailure = std::function<void(JsonObject)>;
  void consume(std::span<const uint8_t> bytes, const OnRequest& request, const OnFailure& failure);
  bool finish() noexcept;
 private:
  std::array<uint8_t, 4> header_{};
  size_t header_used_ = 0;
  std::optional<size_t> expected_;
  std::vector<uint8_t> body_;
  uint64_t discarded_ = 0;
};

using ProtocolClock = std::chrono::steady_clock;
using ProtocolDeadline = ProtocolClock::time_point;
enum class WriteStatus { written, retry, cancelled, failed };
struct WriteResult { size_t bytes = 0; WriteStatus status = WriteStatus::failed; };

/// The injected callback must honor the supplied nonrenewable deadline. Production uses PipeFrameWriter's
/// dedicated native I/O thread; no synchronous WriteFile executes on a publication/authority thread.
class FrameWriter final {
 public:
  using Write = std::function<WriteResult(std::span<const uint8_t>, ProtocolDeadline)>;
  explicit FrameWriter(Write write, std::chrono::milliseconds timeout = std::chrono::milliseconds(50),
                       std::function<bool()> cancelled = {});
  bool write(const JsonObject& document, std::span<const uint8_t> image = {});
  void cancel() noexcept;
 private:
  bool write_all(std::span<const uint8_t> bytes, ProtocolDeadline deadline);
  Write write_;
  std::chrono::milliseconds timeout_;
  std::function<bool()> cancelled_;
  std::atomic_bool stopped_{false};
  std::timed_mutex serialization_;
};

/// Anonymous inherited pipes are synchronous. This adapter confines WriteFile to one owned thread, waits
/// only until FrameWriter's total deadline, and cancels through CancelSynchronousIo on timeout/parent stop.
/// The independent lifecycle stop callback must arm its hard fuse without waiting for this worker.
class PipeFrameWriter final {
 public:
  PipeFrameWriter(HANDLE output, HANDLE stop_event, std::function<void()> failure);
  ~PipeFrameWriter();
  PipeFrameWriter(const PipeFrameWriter&) = delete;
  PipeFrameWriter& operator=(const PipeFrameWriter&) = delete;
  bool write(const JsonObject& document, std::span<const uint8_t> image = {});
  void cancel() noexcept;
  bool close(std::chrono::milliseconds budget = std::chrono::milliseconds(200)) noexcept;
 private:
  struct State;
  std::unique_ptr<State> state_;
  std::unique_ptr<FrameWriter> writer_;
};
}
