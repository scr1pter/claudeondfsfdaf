#include "protocol.h"
#include <algorithm>
#include <charconv>
#include <cmath>
#include <limits>
#include <process.h>
#include <utility>

namespace vector::computer {
namespace {
[[noreturn]] void invalid(uint64_t id = 0, std::wstring code = L"failed") {
  throw ProtocolError(id, std::move(code), L"The protocol request is malformed.");
}
bool high(uint32_t value) noexcept { return value >= 0xd800U && value <= 0xdbffU; }
bool low(uint32_t value) noexcept { return value >= 0xdc00U && value <= 0xdfffU; }
bool valid_utf16(std::wstring_view value) noexcept {
  for (size_t index = 0; index < value.size(); ++index) {
    const auto unit = static_cast<uint32_t>(value[index]);
    if (high(unit)) {
      if (++index >= value.size() || !low(static_cast<uint32_t>(value[index]))) return false;
    } else if (low(unit)) return false;
  }
  return true;
}
std::wstring_view text_view(const winrt::hstring& value) noexcept { return {value.c_str(), value.size()}; }
bool short_name(const winrt::hstring& value) {
  return !value.empty() && value.size() <= 128U && valid_utf16(text_view(value)) && winrt::to_string(value).size() <= 128U;
}
std::optional<uint32_t> hex4(std::span<const uint8_t> bytes, size_t offset) noexcept {
  if (offset > bytes.size() || bytes.size() - offset < 4U) return std::nullopt;
  uint32_t value = 0;
  for (size_t index = 0; index < 4U; ++index) {
    const auto item = bytes[offset + index];
    uint32_t digit = 0;
    if (item >= '0' && item <= '9') digit = static_cast<uint32_t>(item - '0');
    else if (item >= 'a' && item <= 'f') digit = static_cast<uint32_t>(item - 'a') + 10U;
    else if (item >= 'A' && item <= 'F') digit = static_cast<uint32_t>(item - 'A') + 10U;
    else return std::nullopt;
    value = (value << 4U) | digit;
  }
  return value;
}
// Validate strict grammar and bounded recursion before the SDK allocates a JSON graph. This also prevents
// any SDK tolerance for comments/trailing commas or replacement of malformed UTF8/UTF16 escapes.
class JsonSyntax final {
 public:
  explicit JsonSyntax(std::span<const uint8_t> bytes) : bytes_(bytes) {}
  bool valid() noexcept { if (!value(0)) return false; space(); return cursor_ == bytes_.size(); }
 private:
  void space() noexcept {
    while (cursor_ < bytes_.size() && (bytes_[cursor_] == ' ' || bytes_[cursor_] == '\r' || bytes_[cursor_] == '\n' || bytes_[cursor_] == '\t')) ++cursor_;
  }
  bool take(uint8_t expected) noexcept {
    if (cursor_ >= bytes_.size() || bytes_[cursor_] != expected) return false;
    ++cursor_; return true;
  }
  bool digit() const noexcept { return cursor_ < bytes_.size() && bytes_[cursor_] >= '0' && bytes_[cursor_] <= '9'; }
  bool literal(std::string_view expected) noexcept {
    if (expected.size() > bytes_.size() - cursor_) return false;
    for (const char item : expected) if (bytes_[cursor_++] != static_cast<uint8_t>(item)) return false;
    return true;
  }
  bool string() noexcept {
    if (!take('"')) return false;
    while (cursor_ < bytes_.size()) {
      const auto item = bytes_[cursor_++];
      if (item == '"') return true;
      if (item < 0x20U) return false;
      if (item != '\\') continue;
      if (cursor_ >= bytes_.size()) return false;
      const auto escape = bytes_[cursor_++];
      if (escape == 'u') {
        const auto unit = hex4(bytes_, cursor_);
        if (!unit) return false;
        cursor_ += 4U;
        if (high(*unit)) {
          if (!take('\\') || !take('u')) return false;
          const auto second = hex4(bytes_, cursor_);
          if (!second || !low(*second)) return false;
          cursor_ += 4U;
        } else if (low(*unit)) return false;
      } else if (escape != '"' && escape != '\\' && escape != '/' && escape != 'b' && escape != 'f' &&
                 escape != 'n' && escape != 'r' && escape != 't') return false;
    }
    return false;
  }
  bool number() noexcept {
    take('-');
    if (take('0')) { if (digit()) return false; }
    else { if (!digit() || bytes_[cursor_] == '0') return false; while (digit()) ++cursor_; }
    if (take('.')) { if (!digit()) return false; while (digit()) ++cursor_; }
    if (take('e') || take('E')) {
      if (!take('+')) take('-');
      if (!digit()) return false;
      while (digit()) ++cursor_;
    }
    return true;
  }
  bool value(unsigned depth) noexcept {
    space();
    if (depth > 64U || cursor_ >= bytes_.size()) return false;
    const auto first = bytes_[cursor_];
    if (first == '"') return string();
    if (first == 't') return literal("true");
    if (first == 'f') return literal("false");
    if (first == 'n') return literal("null");
    if (first == '-' || digit()) return number();
    if (take('[')) {
      space(); if (take(']')) return true;
      do { if (!value(depth + 1U)) return false; space(); if (take(']')) return true; } while (take(','));
      return false;
    }
    if (take('{')) {
      space(); if (take('}')) return true;
      do {
        space(); if (!string()) return false; space();
        if (!take(':') || !value(depth + 1U)) return false;
        space(); if (take('}')) return true;
      } while (take(','));
    }
    return false;
  }
  std::span<const uint8_t> bytes_;
  size_t cursor_ = 0;
};
bool json_preflight(std::span<const uint8_t> bytes) noexcept {
  return !bytes.empty() && bytes.size() <= kMaxFrameBytes && strict_utf8(bytes) && JsonSyntax(bytes).valid();
}
bool json_valid(const IJsonValue& value, unsigned depth = 0) {
  if (!value || depth > 64U) return false;
  switch (value.ValueType()) {
    case JsonValueType::Null: case JsonValueType::Boolean: return true;
    case JsonValueType::Number: return std::isfinite(value.GetNumber());
    case JsonValueType::String: return valid_utf16(text_view(value.GetString()));
    case JsonValueType::Array:
      for (const auto& item : value.GetArray()) if (!json_valid(item, depth + 1U)) return false;
      return true;
    case JsonValueType::Object:
      for (const auto& item : value.GetObject()) {
        if (!valid_utf16(text_view(item.Key())) || !json_valid(item.Value(), depth + 1U)) return false;
      }
      return true;
    default: return false;
  }
}

class JsonEncoder final {
 public:
  explicit JsonEncoder(std::optional<ProtocolDeadline> deadline = {}) : deadline_(deadline) {}
  std::vector<uint8_t> encode(const IJsonValue& value) {
    tick(); append_value(value, 0); tick(); return std::move(bytes_);
  }
 private:
  void tick() const {
    if (deadline_ && ProtocolClock::now() >= *deadline_) throw ProtocolError(0, L"timeout", L"The protocol publication timed out.");
  }
  void put(uint8_t value) {
    if (bytes_.size() >= kMaxFrameBytes) throw ProtocolError(0, L"frame_too_large", L"The protocol frame exceeds its size limit.");
    bytes_.push_back(value);
    if (++since_clock_ >= 4096U) { since_clock_ = 0; tick(); }
  }
  void append(std::string_view value) {
    tick();
    if (value.size() > kMaxFrameBytes - bytes_.size()) throw ProtocolError(0, L"frame_too_large", L"The protocol frame exceeds its size limit.");
    bytes_.insert(bytes_.end(), value.begin(), value.end()); tick();
  }
  void scalar(uint32_t value) {
    if (value <= 0x7fU) put(static_cast<uint8_t>(value));
    else if (value <= 0x7ffU) {
      put(static_cast<uint8_t>(0xc0U | (value >> 6U))); put(static_cast<uint8_t>(0x80U | (value & 0x3fU)));
    } else if (value <= 0xffffU) {
      put(static_cast<uint8_t>(0xe0U | (value >> 12U))); put(static_cast<uint8_t>(0x80U | ((value >> 6U) & 0x3fU)));
      put(static_cast<uint8_t>(0x80U | (value & 0x3fU)));
    } else {
      put(static_cast<uint8_t>(0xf0U | (value >> 18U))); put(static_cast<uint8_t>(0x80U | ((value >> 12U) & 0x3fU)));
      put(static_cast<uint8_t>(0x80U | ((value >> 6U) & 0x3fU))); put(static_cast<uint8_t>(0x80U | (value & 0x3fU)));
    }
  }
  void string(std::wstring_view value) {
    put('"');
    constexpr char digits[] = "0123456789abcdef";
    for (size_t index = 0; index < value.size(); ++index) {
      auto unit = static_cast<uint32_t>(value[index]);
      if (unit == '"' || unit == '\\') { put('\\'); put(static_cast<uint8_t>(unit)); }
      else if (unit < 0x20U) {
        put('\\'); put('u'); put('0'); put('0'); put(static_cast<uint8_t>(digits[(unit >> 4U) & 15U]));
        put(static_cast<uint8_t>(digits[unit & 15U]));
      } else {
        if (high(unit)) {
          if (++index >= value.size() || !low(static_cast<uint32_t>(value[index]))) invalid();
          unit = 0x10000U + ((unit - 0xd800U) << 10U) + (static_cast<uint32_t>(value[index]) - 0xdc00U);
        } else if (low(unit)) invalid();
        scalar(unit);
      }
    }
    put('"');
  }
  void append_value(const IJsonValue& value, unsigned depth) {
    tick();
    if (!value || depth > 64U) invalid();
    switch (value.ValueType()) {
      case JsonValueType::Null: append("null"); return;
      case JsonValueType::Boolean: append(value.GetBoolean() ? "true" : "false"); return;
      case JsonValueType::Number: {
        const double number = value.GetNumber();
        if (!std::isfinite(number)) invalid();
        std::array<char, 64> text{};
        const auto result = std::to_chars(text.data(), text.data() + text.size(), number, std::chars_format::general);
        if (result.ec != std::errc{}) invalid();
        append({text.data(), static_cast<size_t>(result.ptr - text.data())}); return;
      }
      case JsonValueType::String: string(text_view(value.GetString())); return;
      case JsonValueType::Array: {
        put('['); bool first = true;
        for (const auto& item : value.GetArray()) { if (!first) put(','); first = false; append_value(item, depth + 1U); }
        put(']'); return;
      }
      case JsonValueType::Object: {
        put('{'); bool first = true;
        for (const auto& item : value.GetObject()) {
          if (!first) put(','); first = false; string(text_view(item.Key())); put(':'); append_value(item.Value(), depth + 1U);
        }
        put('}'); return;
      }
      default: invalid();
    }
  }
  std::optional<ProtocolDeadline> deadline_;
  std::vector<uint8_t> bytes_;
  size_t since_clock_ = 0;
};

bool outgoing_envelope(const JsonObject& value) {
  if (value.HasKey(L"event")) {
    const auto event = value.Lookup(L"event");
    return !value.HasKey(L"id") && event.ValueType() == JsonValueType::String && short_name(event.GetString());
  }
  return value.HasKey(L"id") && safe_integer(value.Lookup(L"id")).has_value() && value.HasKey(L"ok") &&
      value.Lookup(L"ok").ValueType() == JsonValueType::Boolean;
}
DWORD remaining_ms(ProtocolDeadline deadline) noexcept {
  const auto now = ProtocolClock::now();
  if (now >= deadline) return 0;
  const auto count = std::chrono::ceil<std::chrono::milliseconds>(deadline - now).count();
  return static_cast<DWORD>(std::clamp<int64_t>(static_cast<int64_t>(count), 1, 50));
}
}

ProtocolError::ProtocolError(uint64_t request_id, std::wstring error_code, std::wstring error_message)
    : id(request_id), code(std::move(error_code)), message(std::move(error_message)) {}
const char* ProtocolError::what() const noexcept { return "The computer helper protocol rejected a frame."; }

std::optional<uint64_t> safe_integer(const IJsonValue& value) {
  try {
    if (!value || value.ValueType() != JsonValueType::Number) return std::nullopt;
    const double number = value.GetNumber();
    if (!std::isfinite(number) || number < 0 || number > static_cast<double>(kMaximumSafeInteger) || std::floor(number) != number) return std::nullopt;
    return static_cast<uint64_t>(number);
  } catch (...) { return std::nullopt; }
}
std::optional<int64_t> signed_integer(const IJsonValue& value) {
  try {
    if (!value || value.ValueType() != JsonValueType::Number) return std::nullopt;
    const double number = value.GetNumber();
    if (!std::isfinite(number) || number < -static_cast<double>(kMaximumSafeInteger) || number > static_cast<double>(kMaximumSafeInteger) || std::floor(number) != number) return std::nullopt;
    return static_cast<int64_t>(number);
  } catch (...) { return std::nullopt; }
}
bool strict_utf8(std::span<const uint8_t> bytes) noexcept {
  for (size_t index = 0; index < bytes.size();) {
    const auto first = bytes[index++];
    if (first < 0x80U) continue;
    unsigned count = 0; uint8_t lower = 0x80U, upper = 0xbfU;
    if (first >= 0xc2U && first <= 0xdfU) count = 1;
    else if (first >= 0xe0U && first <= 0xefU) { count = 2; if (first == 0xe0U) lower = 0xa0U; if (first == 0xedU) upper = 0x9fU; }
    else if (first >= 0xf0U && first <= 0xf4U) { count = 3; if (first == 0xf0U) lower = 0x90U; if (first == 0xf4U) upper = 0x8fU; }
    else return false;
    if (bytes.size() - index < count || bytes[index] < lower || bytes[index] > upper) return false;
    ++index;
    for (unsigned tail = 1; tail < count; ++tail, ++index) if (bytes[index] < 0x80U || bytes[index] > 0xbfU) return false;
  }
  return true;
}
Request parse_request(std::span<const uint8_t> body) {
  try {
    if (!json_preflight(body)) invalid();
    const auto text = std::string_view(reinterpret_cast<const char*>(body.data()), body.size());
    const auto document = JsonObject::Parse(winrt::to_hstring(text));
    if (!json_valid(document) || !document.HasKey(L"id")) invalid();
    const auto id = safe_integer(document.Lookup(L"id"));
    if (!id || *id == 0) invalid();
    if (!document.HasKey(L"op") || document.Lookup(L"op").ValueType() != JsonValueType::String) invalid(*id, L"unsupported_action");
    const auto op = document.Lookup(L"op").GetString();
    if (!short_name(op)) invalid(*id, L"unsupported_action");
    JsonObject args;
    for (const auto& item : document) if (item.Key() != L"id" && item.Key() != L"op") args.Insert(item.Key(), item.Value());
    return Request{*id, std::wstring(op.c_str(), op.size()), std::move(args), body.size() + 4U};
  } catch (const ProtocolError&) { throw; }
  catch (...) { invalid(); }
}
JsonObject response_success(uint64_t id, const JsonObject& fields) {
  if (id > kMaximumSafeInteger) invalid();
  JsonObject result;
  for (const auto& item : fields) if (item.Key() != L"id" && item.Key() != L"ok" && item.Key() != L"code" && item.Key() != L"error") result.Insert(item.Key(), item.Value());
  result.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(id)));
  result.Insert(L"ok", JsonValue::CreateBooleanValue(true));
  return result;
}
JsonObject response_failure(uint64_t id, std::wstring_view code, std::wstring_view message) {
  if (id > kMaximumSafeInteger) id = 0;
  auto bounded = message.substr(0, std::min<size_t>(2000U, message.size()));
  if (!bounded.empty() && high(static_cast<uint32_t>(bounded.back()))) bounded.remove_suffix(1);
  JsonObject result;
  result.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(id)));
  result.Insert(L"ok", JsonValue::CreateBooleanValue(false));
  result.Insert(L"code", JsonValue::CreateStringValue(winrt::hstring(code)));
  result.Insert(L"error", JsonValue::CreateStringValue(winrt::hstring(bounded)));
  return result;
}
JsonObject event_document(std::wstring_view name, const JsonObject& fields) {
  const winrt::hstring event(name);
  if (!short_name(event)) invalid();
  JsonObject result;
  for (const auto& item : fields) if (item.Key() != L"id" && item.Key() != L"event") result.Insert(item.Key(), item.Value());
  result.Insert(L"event", JsonValue::CreateStringValue(event));
  return result;
}
std::vector<uint8_t> encode_json(const IJsonValue& value) { return JsonEncoder{}.encode(value); }
size_t encoded_size(const JsonObject& document) { return encode_json(document).size(); }
std::vector<uint8_t> frame_bytes(std::span<const uint8_t> bytes) {
  if (bytes.size() > kMaxFrameBytes) throw ProtocolError(0, L"frame_too_large", L"The protocol frame exceeds its size limit.");
  const auto length = static_cast<uint32_t>(bytes.size());
  std::vector<uint8_t> result;
  result.reserve(bytes.size() + 4U);
  result.push_back(static_cast<uint8_t>(length >> 24U)); result.push_back(static_cast<uint8_t>(length >> 16U));
  result.push_back(static_cast<uint8_t>(length >> 8U)); result.push_back(static_cast<uint8_t>(length));
  result.insert(result.end(), bytes.begin(), bytes.end()); return result;
}
std::vector<uint8_t> frame_document(const JsonObject& document) { return frame_bytes(encode_json(document)); }

void FrameReader::consume(std::span<const uint8_t> bytes, const OnRequest& request, const OnFailure& failure) {
  size_t cursor = 0;
  while (cursor < bytes.size()) {
    if (discarded_ > 0) {
      const auto count = std::min<uint64_t>(discarded_, static_cast<uint64_t>(bytes.size() - cursor));
      cursor += static_cast<size_t>(count); discarded_ -= count; continue;
    }
    if (!expected_) {
      const auto count = std::min<size_t>(4U - header_used_, bytes.size() - cursor);
      std::copy_n(bytes.begin() + static_cast<ptrdiff_t>(cursor), count, header_.begin() + static_cast<ptrdiff_t>(header_used_));
      cursor += count; header_used_ += count;
      if (header_used_ != 4U) continue;
      uint32_t length = 0;
      for (const auto byte : header_) length = (length << 8U) | byte;
      header_used_ = 0;
      if (length > kMaxFrameBytes) {
        discarded_ = length; failure(response_failure(0, L"frame_too_large", L"The protocol frame exceeds its size limit.")); continue;
      }
      if (length == 0U) { failure(response_failure(0, L"failed", L"The protocol request is malformed.")); continue; }
      expected_ = static_cast<size_t>(length); body_.reserve(*expected_);
    }
    const auto count = std::min(*expected_ - body_.size(), bytes.size() - cursor);
    body_.insert(body_.end(), bytes.begin() + static_cast<ptrdiff_t>(cursor), bytes.begin() + static_cast<ptrdiff_t>(cursor + count));
    cursor += count;
    if (body_.size() != *expected_) continue;
    auto complete = std::move(body_); body_ = {}; expected_.reset();
    try { request(parse_request(complete)); }
    catch (const ProtocolError& error) { failure(response_failure(error.id, error.code, error.message)); }
  }
}
bool FrameReader::finish() noexcept {
  const bool clean = header_used_ == 0U && !expected_ && discarded_ == 0;
  header_used_ = 0; expected_.reset(); body_.clear(); discarded_ = 0; return clean;
}

FrameWriter::FrameWriter(Write write, std::chrono::milliseconds timeout, std::function<bool()> cancelled)
    : write_(std::move(write)), timeout_(std::clamp(timeout, std::chrono::milliseconds(1), std::chrono::milliseconds(50))), cancelled_(std::move(cancelled)) {}
void FrameWriter::cancel() noexcept { stopped_.store(true); }
bool FrameWriter::write(const JsonObject& document, std::span<const uint8_t> image) {
  const auto deadline = ProtocolClock::now() + timeout_;
  try {
    if (stopped_.load() || (cancelled_ && cancelled_()) || !write_ || !outgoing_envelope(document) || image.size() > kMaxFrameBytes) return false;
    if (!image.empty()) {
      if (document.HasKey(L"event") || !document.Lookup(L"ok").GetBoolean() || !document.HasKey(L"imageBytes")) return false;
      const auto size = safe_integer(document.Lookup(L"imageBytes"));
      if (!size || *size == 0 || *size != image.size()) return false;
    } else if (document.HasKey(L"imageBytes")) return false;
    const auto header = frame_bytes(JsonEncoder{deadline}.encode(document));
    const auto binary = image.empty() ? std::vector<uint8_t>{} : frame_bytes(image);
    std::unique_lock<std::timed_mutex> lease(serialization_, std::defer_lock);
    while (!lease.try_lock_until(std::min(deadline, ProtocolClock::now() + std::chrono::milliseconds(2)))) {
      if (ProtocolClock::now() >= deadline || stopped_.load() || (cancelled_ && cancelled_())) return false;
    }
    if (!write_all(header, deadline)) return false;
    return binary.empty() || write_all(binary, deadline);
  } catch (...) { return false; }
}
bool FrameWriter::write_all(std::span<const uint8_t> bytes, ProtocolDeadline deadline) {
  while (!bytes.empty()) {
    if (ProtocolClock::now() >= deadline || stopped_.load() || (cancelled_ && cancelled_())) return false;
    const auto result = write_(bytes.first(std::min<size_t>(bytes.size(), 65'536U)), deadline);
    if (ProtocolClock::now() >= deadline || stopped_.load() || (cancelled_ && cancelled_())) return false;
    if (result.status == WriteStatus::retry) { if (result.bytes != 0) return false; continue; }
    if (result.status != WriteStatus::written || result.bytes == 0 || result.bytes > std::min<size_t>(bytes.size(), 65'536U)) return false;
    bytes = bytes.subspan(result.bytes);
  }
  return true;
}

struct PipeFrameWriter::State {
  struct Job {
    explicit Job(std::span<const uint8_t> value, ProtocolDeadline limit)
        : bytes(value.begin(), value.end()), deadline(limit), done(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {}
    const std::vector<uint8_t> bytes;
    ProtocolDeadline deadline;
    winrt::handle done;
    std::atomic<size_t> written{0};
    std::atomic<DWORD> error{ERROR_IO_PENDING};
  };
  winrt::handle output;
  winrt::handle stop;
  winrt::handle cancel;
  winrt::handle wake;
  winrt::handle thread;
  std::mutex mutex;
  std::shared_ptr<Job> queued;
  std::shared_ptr<Job> active;
  std::atomic_bool failed{false};
  std::function<void()> failure;

  State(HANDLE destination, HANDLE external_stop, std::function<void()> on_failure) : failure(std::move(on_failure)) {
    if (!destination || destination == INVALID_HANDLE_VALUE || GetFileType(destination) != FILE_TYPE_PIPE ||
        !external_stop || external_stop == INVALID_HANDLE_VALUE) invalid();
    HANDLE copied = nullptr;
    if (!DuplicateHandle(GetCurrentProcess(), destination, GetCurrentProcess(), &copied, 0, FALSE, DUPLICATE_SAME_ACCESS)) invalid();
    output.attach(copied); copied = nullptr;
    if (!DuplicateHandle(GetCurrentProcess(), external_stop, GetCurrentProcess(), &copied, SYNCHRONIZE, FALSE, 0)) invalid();
    stop.attach(copied);
    const auto state = WaitForSingleObject(stop.get(), 0);
    if (state != WAIT_OBJECT_0 && state != WAIT_TIMEOUT) invalid();
    cancel.attach(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    wake.attach(CreateEventW(nullptr, FALSE, FALSE, nullptr));
    if (!cancel || !wake) invalid();
    thread.attach(reinterpret_cast<HANDLE>(_beginthreadex(nullptr, 0, entry, this, 0, nullptr)));
    if (!thread) invalid();
  }
  ~State() {
    // Also covers construction failure after the worker starts but before PipeFrameWriter is complete.
    request_cancel();
    if (thread && WaitForSingleObject(thread.get(), 200) != WAIT_OBJECT_0) TerminateProcess(GetCurrentProcess(), 1);
  }
  static unsigned __stdcall entry(void* context) noexcept {
    auto* self = static_cast<State*>(context);
    try { self->run(); }
    catch (...) { self->notify_failure(); }
    return 0;
  }
  bool stopped() const noexcept {
    return failed.load() || WaitForSingleObject(cancel.get(), 0) == WAIT_OBJECT_0 || WaitForSingleObject(stop.get(), 0) == WAIT_OBJECT_0;
  }
  void request_cancel() noexcept {
    if (cancel) SetEvent(cancel.get());
    if (thread) CancelSynchronousIo(thread.get());
  }
  void notify_failure() noexcept {
    request_cancel();
    if (!failed.exchange(true) && failure) { try { failure(); } catch (...) {} }
  }
  WriteResult chunk(std::span<const uint8_t> bytes, ProtocolDeadline deadline) {
    if (stopped() || ProtocolClock::now() >= deadline || bytes.empty() || bytes.size() > 65'536U) return {};
    const auto job = std::make_shared<Job>(bytes, deadline);
    if (!job->done) return {};
    {
      std::lock_guard guard(mutex);
      if (stopped() || queued || active) return {};
      queued = job;
      if (!SetEvent(wake.get())) { queued.reset(); return {}; }
    }
    const std::array<HANDLE, 3> waits{job->done.get(), cancel.get(), stop.get()};
    const auto waited = WaitForMultipleObjects(static_cast<DWORD>(waits.size()), waits.data(), FALSE, remaining_ms(deadline));
    if (waited != WAIT_OBJECT_0 || ProtocolClock::now() >= deadline) {
      request_cancel();
      return {0, WriteStatus::cancelled};
    }
    const auto error = job->error.load(std::memory_order_acquire);
    if (error != ERROR_SUCCESS) return {0, error == ERROR_OPERATION_ABORTED ? WriteStatus::cancelled : WriteStatus::failed};
    return {job->written.load(std::memory_order_acquire), WriteStatus::written};
  }
  void run() {
    const std::array<HANDLE, 3> waits{cancel.get(), stop.get(), wake.get()};
    while (true) {
      const auto waited = WaitForMultipleObjects(static_cast<DWORD>(waits.size()), waits.data(), FALSE, INFINITE);
      if (waited == WAIT_OBJECT_0 || waited == WAIT_OBJECT_0 + 1U) return;
      if (waited != WAIT_OBJECT_0 + 2U) { notify_failure(); return; }
      std::shared_ptr<Job> job;
      {
        std::lock_guard guard(mutex);
        job = std::move(queued); active = job;
      }
      if (!job) continue;
      DWORD written = 0, error = ERROR_OPERATION_ABORTED;
      if (!stopped() && ProtocolClock::now() < job->deadline) {
        const auto ok = WriteFile(output.get(), job->bytes.data(), static_cast<DWORD>(job->bytes.size()), &written, nullptr);
        error = ok ? ERROR_SUCCESS : GetLastError();
      }
      job->written.store(written, std::memory_order_release);
      job->error.store(error, std::memory_order_release);
      {
        std::lock_guard guard(mutex);
        active.reset();
      }
      SetEvent(job->done.get());
      if (error != ERROR_SUCCESS || written == 0) { notify_failure(); return; }
    }
  }
};

PipeFrameWriter::PipeFrameWriter(HANDLE output, HANDLE stop_event, std::function<void()> failure)
    : state_(std::make_unique<State>(output, stop_event, std::move(failure))) {
  writer_ = std::make_unique<FrameWriter>(
      [this](std::span<const uint8_t> bytes, ProtocolDeadline deadline) { return state_->chunk(bytes, deadline); },
      std::chrono::milliseconds(50), [this] { return state_->stopped(); });
}
PipeFrameWriter::~PipeFrameWriter() {
  // A synchronous pipe call may ignore cancellation. Its live buffer and State must never be detached or
  // freed underneath it; the lifecycle fuse is independent, and this final fallback kills only this helper.
  if (!close()) TerminateProcess(GetCurrentProcess(), 1);
}
bool PipeFrameWriter::write(const JsonObject& document, std::span<const uint8_t> image) {
  if (!writer_ || !state_) return false;
  const bool result = writer_->write(document, image);
  if (!result) state_->notify_failure();
  return result;
}
void PipeFrameWriter::cancel() noexcept {
  if (writer_) writer_->cancel();
  if (state_) state_->request_cancel();
}
bool PipeFrameWriter::close(std::chrono::milliseconds budget) noexcept {
  cancel();
  if (!state_ || !state_->thread) return true;
  const auto bounded = std::clamp<int64_t>(budget.count(), 0, 200);
  const auto until = ProtocolClock::now() + std::chrono::milliseconds(bounded);
  while (true) {
    const auto waited = WaitForSingleObject(state_->thread.get(), 0);
    if (waited == WAIT_OBJECT_0) return true;
    if (waited != WAIT_TIMEOUT || ProtocolClock::now() >= until) return false;
    state_->request_cancel();
    const auto remain = std::chrono::ceil<std::chrono::milliseconds>(until - ProtocolClock::now()).count();
    if (remain <= 0) return false;
    if (WaitForSingleObject(state_->thread.get(), static_cast<DWORD>(std::min<int64_t>(remain, 5))) == WAIT_OBJECT_0) return true;
  }
}

bool run_protocol_self_test() {
  try {
    JsonObject args; args.Insert(L"id", JsonValue::CreateNumberValue(1)); args.Insert(L"op", JsonValue::CreateStringValue(L"hello"));
    JsonObject range; range.Insert(L"min", JsonValue::CreateNumberValue(1)); range.Insert(L"max", JsonValue::CreateNumberValue(1));
    args.Insert(L"protocol", range);
    const auto framed = frame_document(args);
    FrameReader reader; unsigned requests = 0, failures = 0;
    for (const auto byte : framed) reader.consume({&byte, 1}, [&](Request request) {
      if (request.id == 1 && request.op == L"hello" && request.encoded_bytes == framed.size()) ++requests;
    }, [&](JsonObject) { ++failures; });
    if (requests != 1 || failures != 0 || !reader.finish()) return false;
    std::vector<uint8_t> output;
    FrameWriter writer([&](std::span<const uint8_t> bytes, ProtocolDeadline) {
      const auto count = std::min<size_t>(bytes.size(), 3U); output.insert(output.end(), bytes.begin(), bytes.begin() + static_cast<ptrdiff_t>(count));
      return WriteResult{count, WriteStatus::written};
    });
    const auto result = response_success(1);
    return writer.write(result) && output == frame_document(result);
  } catch (...) { return false; }
}
}
