#include "protocol.h"
#include "core.h"
#include <algorithm>
#include <array>
#include <condition_variable>
#include <future>
#include <limits>
#include <mutex>
#include <stdexcept>
#include <thread>

namespace vector::computer {
namespace {
class ProtocolTestFailure final : public std::exception {
 public:
  explicit ProtocolTestFailure(const char* label) : label_(label) {}
  const char* what() const noexcept override { return label_; }
 private:
  const char* label_;
};
void require_protocol(bool condition, const char* label) { if (!condition) throw ProtocolTestFailure(label); }
std::vector<uint8_t> raw(std::string_view text) { return {text.begin(), text.end()}; }
JsonObject object(std::string_view text) { return JsonObject::Parse(winrt::to_hstring(text)); }
void rejected(std::string_view value, uint64_t id = 0, std::wstring_view code = L"failed") {
  try { static_cast<void>(parse_request(raw(value))); }
  catch (const ProtocolError& error) { require_protocol(error.id == id && error.code == code, "protocol.error-attribution"); return; }
  throw ProtocolTestFailure("protocol.malformed-accepted");
}
std::vector<std::vector<uint8_t>> frames(std::span<const uint8_t> bytes) {
  std::vector<std::vector<uint8_t>> result;
  size_t cursor = 0;
  while (cursor < bytes.size()) {
    require_protocol(bytes.size() - cursor >= 4U, "protocol.truncated-output-header");
    uint32_t length = 0;
    for (unsigned index = 0; index < 4U; ++index) length = (length << 8U) | bytes[cursor++];
    require_protocol(length <= bytes.size() - cursor, "protocol.truncated-output-body");
    result.emplace_back(bytes.begin() + static_cast<ptrdiff_t>(cursor), bytes.begin() + static_cast<ptrdiff_t>(cursor + length));
    cursor += length;
  }
  return result;
}
JsonObject decode_object(std::span<const uint8_t> bytes) {
  return object({reinterpret_cast<const char*>(bytes.data()), bytes.size()});
}
}

// Fixed/injected codec and thread tests only. No real pipe, desktop, grant, input or parent process.
int run_protocol_tests() {
  int groups = 0;
  const auto test = [&](const auto& body) { body(); ++groups; };
  test([] { require_protocol(run_protocol_self_test(), "protocol.shipped-self-test"); });
  test([] {
    const auto bytes = raw(" \n{ \"id\":42, \"op\":\"hello\", \"extra\":\"é 🧪\", \"items\":[true,1,1.5,null] } \n");
    const auto request = parse_request(bytes);
    require_protocol(request.id == 42 && request.op == L"hello" && request.encoded_bytes == bytes.size() + 4U &&
        !request.args.HasKey(L"id") && !request.args.HasKey(L"op") && request.args.GetNamedString(L"extra") == L"é 🧪", "protocol.flattened-request");
    const auto values = request.args.GetNamedArray(L"items");
    require_protocol(values.GetAt(0).ValueType() == JsonValueType::Boolean && values.GetAt(2).GetNumber() == 1.5 &&
        values.GetAt(3).ValueType() == JsonValueType::Null, "protocol.typed-json");
  });
  test([] {
    for (const auto& value : {JsonValue::CreateBooleanValue(true), JsonValue::CreateNumberValue(1.5), JsonValue::CreateNumberValue(-1),
                             JsonValue::CreateNumberValue(9'007'199'254'740'992.0), JsonValue::CreateStringValue(L"1")}) {
      require_protocol(!safe_integer(value), "protocol.safe-integer-refusal");
    }
    require_protocol(safe_integer(JsonValue::CreateNumberValue(0)) == 0U &&
        safe_integer(JsonValue::CreateNumberValue(9'007'199'254'740'991.0)) == kMaximumSafeInteger &&
        signed_integer(JsonValue::CreateNumberValue(-9'007'199'254'740'991.0)) == -static_cast<int64_t>(kMaximumSafeInteger), "protocol.safe-integer-boundary");
  });
  test([] {
    for (const auto value : {"{not json", "[1,2,3]", "null", "{\"op\":\"hello\"}", "{\"id\":0,\"op\":\"hello\"}",
                            "{\"id\":-1,\"op\":\"hello\"}", "{\"id\":true,\"op\":\"hello\"}", "{\"id\":1.5,\"op\":\"hello\"}",
                            "{\"id\":9007199254740992,\"op\":\"hello\"}"}) rejected(value);
    rejected("{\"id\":7,\"op\":false}", 7, L"unsupported_action");
    rejected("{\"id\":8,\"op\":\"\"}", 8, L"unsupported_action");
    rejected("{\"id\":9}", 9, L"unsupported_action");
    JsonObject valid; valid.Insert(L"id", JsonValue::CreateNumberValue(10));
    valid.Insert(L"op", JsonValue::CreateStringValue(winrt::hstring(std::wstring(64, L'é'))));
    require_protocol(parse_request(encode_json(valid)).id == 10, "protocol.operation-utf8-limit");
    valid.Insert(L"op", JsonValue::CreateStringValue(winrt::hstring(std::wstring(65, L'é'))));
    try { static_cast<void>(parse_request(encode_json(valid))); throw ProtocolTestFailure("protocol.long-operation"); }
    catch (const ProtocolError& error) { require_protocol(error.id == 10 && error.code == L"unsupported_action", "protocol.long-operation-attribution"); }
  });
  test([] {
    const std::vector<std::vector<uint8_t>> malformed{{0xff}, {0x80}, {0xc0, 0xaf}, {0xe2, 0x82}, {0xed, 0xa0, 0x80}, {0xf4, 0x90, 0x80, 0x80}};
    for (const auto& value : malformed) {
      require_protocol(!strict_utf8(value), "protocol.invalid-utf8");
      try { static_cast<void>(parse_request(value)); throw ProtocolTestFailure("protocol.invalid-utf8-request"); }
      catch (const ProtocolError& error) { require_protocol(error.id == 0 && error.code == L"failed", "protocol.invalid-utf8-attribution"); }
    }
    require_protocol(strict_utf8(raw("é 日本語 🧪")), "protocol.valid-utf8");
    require_protocol(parse_request(raw("{\"id\":1,\"op\":\"hello\",\"value\":\"\\ud83e\\uddea\"}")).args.GetNamedString(L"value") == L"🧪", "protocol.escaped-scalar");
    for (const auto value : {"{\"id\":1,\"op\":\"hello\",\"v\":\"\\ud800\"}", "{\"id\":1,\"op\":\"hello\",\"v\":\"\\udc00\"}",
                            "{\"id\":1,\"op\":\"hello\",\"v\":\"\\ud800x\"}", "{\"id\":1,\"op\":\"hello\",\"v\":\"\\uZZZZ\"}"}) rejected(value);
  });
  test([] {
    for (const auto value : {"{\"id\":1,\"op\":\"hello\",}", "{\"id\":1,\"op\":\"hello\",\"x\":[1,]}", "{\"id\":1,/*x*/\"op\":\"hello\"}",
                            "{\"id\":01,\"op\":\"hello\"}", "{\"id\":1.,\"op\":\"hello\"}", "{\"id\":1e,\"op\":\"hello\"}",
                            "{\"id\":1,\"op\":\"hello\"}{}", "{\"id\":1,\"op\":\"hel\nlo\"}"}) rejected(value);
    const auto prefix = std::string("{\"id\":1,\"op\":\"hello\",\"x\":");
    require_protocol(parse_request(raw(prefix + std::string(63, '[') + "0" + std::string(63, ']') + "}")).id == 1, "protocol.depth64");
    rejected(prefix + std::string(64, '[') + "0" + std::string(64, ']') + "}");
  });
  test([] {
    FrameReader reader; std::vector<Request> requests; std::vector<JsonObject> errors;
    const auto body = raw(" \n{  \"id\" : 43, \"op\" : \"hello\", \"extra\" : \"é 🧪\" }\n ");
    const auto framed = frame_bytes(body);
    for (const auto byte : framed) reader.consume({&byte, 1}, [&](Request value) { requests.push_back(std::move(value)); }, [&](JsonObject value) { errors.push_back(std::move(value)); });
    std::vector<uint8_t> coalesced = framed; coalesced.insert(coalesced.end(), framed.begin(), framed.end());
    reader.consume(coalesced, [&](Request value) { requests.push_back(std::move(value)); }, [&](JsonObject value) { errors.push_back(std::move(value)); });
    require_protocol(requests.size() == 3U && errors.empty() && requests.front().encoded_bytes == framed.size() && reader.finish(), "protocol.fragmented-coalesced-exact-cost");
  });
  test([] {
    FrameReader reader; unsigned requests = 0; std::vector<JsonObject> failures;
    const auto malformed = frame_bytes(raw("{bad")), valid = frame_bytes(raw("{\"id\":1,\"op\":\"hello\"}"));
    std::vector<uint8_t> joined{0, 0, 0, 0}; joined.insert(joined.end(), malformed.begin(), malformed.end()); joined.insert(joined.end(), valid.begin(), valid.end());
    reader.consume(joined, [&](Request) { ++requests; }, [&](JsonObject value) { failures.push_back(std::move(value)); });
    require_protocol(requests == 1U && failures.size() == 2U && failures[0].GetNamedString(L"code") == L"failed" && reader.finish(), "protocol.malformed-stream-recovery");
  });
  test([] {
    FrameReader reader; unsigned requests = 0, failures = 0;
    const uint32_t length = static_cast<uint32_t>(kMaxFrameBytes + 1U);
    const std::array<uint8_t, 4> header{static_cast<uint8_t>(length >> 24U), static_cast<uint8_t>(length >> 16U), static_cast<uint8_t>(length >> 8U), static_cast<uint8_t>(length)};
    const auto on_failure = [&](JsonObject value) { ++failures; require_protocol(value.GetNamedString(L"code") == L"frame_too_large", "protocol.oversize-code"); };
    reader.consume(header, [&](Request) { ++requests; }, on_failure);
    require_protocol(failures == 1U, "protocol.oversize-early-rejection");
    const std::vector<uint8_t> chunk(65'536U, 0);
    for (size_t index = 0; index < kMaxFrameBytes / chunk.size(); ++index) reader.consume(chunk, [&](Request) { ++requests; }, on_failure);
    std::vector<uint8_t> tail{0}; const auto valid = frame_bytes(raw("{\"id\":1,\"op\":\"hello\"}")); tail.insert(tail.end(), valid.begin(), valid.end());
    reader.consume(tail, [&](Request) { ++requests; }, on_failure);
    require_protocol(failures == 1U && requests == 1U && reader.finish(), "protocol.oversize-discard-alignment");
    reader.consume(std::array<uint8_t, 4>{0xff, 0xff, 0xff, 0xff}, [&](Request) { ++requests; }, on_failure);
    require_protocol(!reader.finish() && reader.finish(), "protocol.oversize-uint32-eof");
  });
  test([] {
    for (const auto partial : {std::vector<uint8_t>{0, 0}, std::vector<uint8_t>{0, 0, 0, 3, '{'}}) {
      FrameReader reader; reader.consume(partial, [](Request) {}, [](JsonObject) {});
      require_protocol(!reader.finish() && reader.finish(), "protocol.partial-eof-reset");
    }
  });
  test([] {
    JsonObject fields; fields.Insert(L"id", JsonValue::CreateNumberValue(99)); fields.Insert(L"ok", JsonValue::CreateBooleanValue(false));
    fields.Insert(L"code", JsonValue::CreateStringValue(L"forged")); fields.Insert(L"error", JsonValue::CreateStringValue(L"forged"));
    fields.Insert(L"value", JsonValue::CreateStringValue(L"fixed"));
    const auto success = response_success(9, fields);
    require_protocol(success.GetNamedNumber(L"id") == 9 && success.GetNamedBoolean(L"ok") && !success.HasKey(L"code") && !success.HasKey(L"error"), "protocol.response-fixed-envelope");
    fields.Insert(L"event", JsonValue::CreateStringValue(L"forged")); const auto event = event_document(L"stop", fields);
    require_protocol(!event.HasKey(L"id") && event.GetNamedString(L"event") == L"stop", "protocol.event-fixed-envelope");
    std::wstring message(1999, L'a'); message.push_back(static_cast<wchar_t>(0xd83e)); message.push_back(static_cast<wchar_t>(0xddea));
    require_protocol(response_failure(0, L"failed", message).GetNamedString(L"error").size() == 1999U, "protocol.failure-utf16-cap");
  });
  test([] {
    JsonObject document; document.Insert(L"text", JsonValue::CreateStringValue(winrt::hstring(std::wstring(L"é 🧪\0x", 7))));
    document.Insert(L"fraction", JsonValue::CreateNumberValue(1.5)); document.Insert(L"negative", JsonValue::CreateNumberValue(-23));
    const auto bytes = encode_json(document);
    require_protocol(strict_utf8(bytes) && std::find(bytes.begin(), bytes.end(), 0) == bytes.end() && json_equal(document, decode_object(bytes)) &&
        encoded_size(document) == bytes.size(), "protocol.strict-json-encoding-roundtrip");
    bool refused = false;
    try { JsonObject bad; bad.Insert(L"value", JsonValue::CreateStringValue(winrt::hstring(std::wstring(1, static_cast<wchar_t>(0xd800))))); static_cast<void>(encode_json(bad)); }
    catch (...) { refused = true; }
    require_protocol(refused, "protocol.unpaired-output-scalar");
  });
  test([] {
    std::vector<uint8_t> output; unsigned calls = 0;
    FrameWriter writer([&](std::span<const uint8_t> bytes, ProtocolDeadline) {
      if (++calls == 1U) return WriteResult{0, WriteStatus::retry};
      const auto length = std::min<size_t>(bytes.size(), 3U); output.insert(output.end(), bytes.begin(), bytes.begin() + static_cast<ptrdiff_t>(length));
      return WriteResult{length, WriteStatus::written};
    });
    const std::vector<uint8_t> image{137, 80, 78, 71, 0, 1, 2, 3};
    JsonObject fields; fields.Insert(L"imageBytes", JsonValue::CreateNumberValue(static_cast<double>(image.size())));
    const auto capture = response_success(10, fields), event = event_document(L"stop");
    require_protocol(writer.write(capture, image) && writer.write(event), "protocol.short-write-retry");
    const auto all = frames(output);
    require_protocol(all.size() == 3U && all[1] == image && json_equal(decode_object(all[0]), capture) && json_equal(decode_object(all[2]), event), "protocol.image-header-binary-pair");
    const auto before = output;
    require_protocol(!writer.write(capture) && !writer.write(capture, std::array<uint8_t, 1>{0}) && output == before, "protocol.image-mismatch-no-partial-header");
  });
  test([] {
    size_t writes = 0;
    FrameWriter writer([&](std::span<const uint8_t> bytes, ProtocolDeadline) { ++writes; return WriteResult{bytes.size(), WriteStatus::written}; });
    JsonObject bad; bad.Insert(L"id", JsonValue::CreateNumberValue(1)); bad.Insert(L"ok", JsonValue::CreateNumberValue(1));
    require_protocol(!writer.write(bad), "protocol.output-bool-envelope");
    bad = response_success(1); bad.Insert(L"event", JsonValue::CreateStringValue(L"stop")); require_protocol(!writer.write(bad), "protocol.output-mixed-envelope");
    JsonObject fields; const std::vector<uint8_t> oversized(kMaxFrameBytes + 1U, 0);
    fields.Insert(L"imageBytes", JsonValue::CreateNumberValue(static_cast<double>(oversized.size())));
    require_protocol(!writer.write(response_success(1, fields), oversized) && writes == 0U, "protocol.output-overcap-no-write");
  });
  test([] {
    const std::vector<uint8_t> exact(kMaxFrameBytes, 0);
    const auto framed = frame_bytes(exact);
    require_protocol(framed.size() == kMaxFrameBytes + 4U && framed[0] == 1U && framed[1] == 0U && framed[2] == 0U && framed[3] == 0U,
        "protocol.exact-frame-cap");
    bool oversized = false;
    try { static_cast<void>(frame_bytes(std::vector<uint8_t>(kMaxFrameBytes + 1U, 0))); }
    catch (const ProtocolError& error) { oversized = error.code == L"frame_too_large"; }
    require_protocol(oversized, "protocol.outbound-frame-cap");
    oversized = false;
    try {
      JsonObject value; value.Insert(L"text", JsonValue::CreateStringValue(winrt::hstring(std::wstring(kMaxFrameBytes / 6U + 1U, L'\x01'))));
      static_cast<void>(encode_json(value));
    } catch (const ProtocolError& error) { oversized = error.code == L"frame_too_large"; }
    require_protocol(oversized, "protocol.escaped-json-byte-cap");
    bool finite = false;
    try { JsonObject value; value.Insert(L"number", JsonValue::CreateNumberValue(std::numeric_limits<double>::infinity())); static_cast<void>(encode_json(value)); }
    catch (...) { finite = true; }
    require_protocol(finite, "protocol.nonfinite-json-refusal");
  });
  test([] {
    for (const auto status : {WriteStatus::written, WriteStatus::failed, WriteStatus::cancelled, WriteStatus::retry}) {
      FrameWriter writer([&](std::span<const uint8_t>, ProtocolDeadline) { return WriteResult{status == WriteStatus::retry ? 1U : 0U, status}; });
      require_protocol(!writer.write(response_success(1)), "protocol.zero-error-retry-partial-refusal");
    }
    FrameWriter impossible([](std::span<const uint8_t> bytes, ProtocolDeadline) { return WriteResult{bytes.size() + 1U, WriteStatus::written}; });
    require_protocol(!impossible.write(response_success(1)), "protocol.impossible-write-count");
  });
  test([] {
    std::atomic_bool cancelled{false}; unsigned calls = 0;
    FrameWriter writer([&](std::span<const uint8_t> bytes, ProtocolDeadline) { ++calls; cancelled.store(true); return WriteResult{bytes.size(), WriteStatus::written}; },
        std::chrono::milliseconds(50), [&] { return cancelled.load(); });
    require_protocol(!writer.write(response_success(1)) && calls == 1U && !writer.write(response_success(2)) && calls == 1U, "protocol.cancellation-fences-further-output");
    FrameWriter own([&](std::span<const uint8_t> bytes, ProtocolDeadline) { ++calls; return WriteResult{bytes.size(), WriteStatus::written}; });
    own.cancel(); require_protocol(!own.write(response_success(3)) && calls == 1U, "protocol.own-cancel-before-write");
  });
  test([] {
    unsigned calls = 0; ProtocolDeadline first{}; bool same_deadline = true;
    FrameWriter writer([&](std::span<const uint8_t> bytes, ProtocolDeadline deadline) {
      ++calls; if (calls == 1U) first = deadline;
      else { same_deadline = deadline == first; std::this_thread::sleep_until(deadline); }
      return WriteResult{bytes.size(), WriteStatus::written};
    });
    JsonObject fields; fields.Insert(L"imageBytes", JsonValue::CreateNumberValue(1));
    require_protocol(!writer.write(response_success(1, fields), std::array<uint8_t, 1>{0}) && calls == 2U && same_deadline, "protocol.image-budget-not-renewed");
  });
  test([] {
    std::mutex mutex; std::condition_variable entered, release;
    bool first_entered = false, released = false, automatic_release = false;
    size_t calls = 0; std::vector<uint8_t> output;
    FrameWriter writer([&](std::span<const uint8_t> bytes, ProtocolDeadline) {
      std::unique_lock guard(mutex); ++calls;
      if (calls == 1U) {
        first_entered = true; entered.notify_one();
        if (!release.wait_for(guard, std::chrono::milliseconds(500), [&] { return released; })) automatic_release = true;
      }
      output.insert(output.end(), bytes.begin(), bytes.end()); return WriteResult{bytes.size(), WriteStatus::written};
    });
    const auto first_document = response_success(1), second_document = event_document(L"stop");
    bool first_result = true;
    std::thread first([&] {
      bool initialized = false;
      try { winrt::init_apartment(winrt::apartment_type::multi_threaded); initialized = true; first_result = writer.write(first_document); }
      catch (...) { first_result = false; }
      if (initialized) winrt::uninit_apartment();
    });
    bool started = false;
    { std::unique_lock guard(mutex); started = entered.wait_for(guard, std::chrono::milliseconds(500), [&] { return first_entered; }); }
    const bool second_result = started ? writer.write(second_document) : true;
    bool untouched = false;
    { std::lock_guard guard(mutex); untouched = calls == 1U && output.empty() && !automatic_release; released = true; release.notify_one(); }
    first.join();
    require_protocol(started && !first_result && !second_result && untouched, "protocol.serial-wait-in-total-budget");
    require_protocol(writer.write(event_document(L"display_change")) && frames(output).size() == 2U, "protocol.timeout-releases-serialization");
  });
  test([] {
    std::vector<uint8_t> output; std::atomic_bool failed{false};
    FrameWriter writer([&](std::span<const uint8_t> bytes, ProtocolDeadline) {
      const auto count = std::min<size_t>(5U, bytes.size()); output.insert(output.end(), bytes.begin(), bytes.begin() + static_cast<ptrdiff_t>(count));
      return WriteResult{count, WriteStatus::written};
    });
    const std::vector<uint8_t> image{137, 80, 78, 71, 4, 3, 2, 1}; std::vector<std::thread> threads;
    for (unsigned index = 0; index < 4U; ++index) threads.emplace_back([&, index] {
      bool initialized = false;
      try {
        winrt::init_apartment(winrt::apartment_type::multi_threaded); initialized = true;
        JsonObject fields; fields.Insert(L"imageBytes", JsonValue::CreateNumberValue(static_cast<double>(image.size())));
        if (!writer.write(response_success(index + 1U, fields), image) || !writer.write(event_document(L"stop"))) failed.store(true);
      } catch (...) { failed.store(true); }
      if (initialized) winrt::uninit_apartment();
    });
    for (auto& thread : threads) thread.join();
    const auto all = frames(output); size_t pairs = 0;
    for (size_t index = 0; index < all.size(); ++index) {
      const auto value = decode_object(all[index]);
      if (value.HasKey(L"imageBytes")) { require_protocol(index + 1U < all.size() && all[index + 1U] == image, "protocol.atomic-pair-concurrency"); ++pairs; ++index; }
    }
    require_protocol(!failed.load() && all.size() == 12U && pairs == 4U, "protocol.concurrent-frame-count");
  });
  return groups;
}
}
