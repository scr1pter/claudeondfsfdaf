#include "capture_worker_protocol.h"
#include <bcrypt.h>
#include <algorithm>
#include <bit>
#include <limits>
#include <stdexcept>
#include <utility>

namespace vector::computer {
namespace {
constexpr uint32_t request_magic = 0x31515743; // CWQ1
constexpr uint32_t output_magic = 0x314f5743; // CWO1
constexpr uint16_t protocol_version = 1;
constexpr uint64_t qpc_max = static_cast<uint64_t>(std::numeric_limits<int64_t>::max());
constexpr size_t canonical_max_bytes = 1024 * 1024;
static_assert(capture_worker_request_bytes <= 512 && capture_worker_output_header_bytes == 96);
static_assert(sizeof(wchar_t) == 2, "The private Windows canonical form uses UTF-16 code units.");

template<class Value> bool nonzero(const Value& value) noexcept {
  return std::any_of(value.begin(), value.end(), [](auto byte) { return byte != 0; });
}
uint64_t acquisition_ticks(uint64_t frequency) noexcept {
  return (frequency / 4) * 3 + ((frequency % 4) * 3) / 4;
}
bool deadline_valid(const CaptureWorkerDeadline& value) noexcept {
  if (!value.frequency || value.frequency > qpc_max || value.started > qpc_max || value.expires > qpc_max) return false;
  const auto ticks = acquisition_ticks(value.frequency);
  return ticks && value.started <= qpc_max - ticks && value.expires == value.started + ticks;
}
std::optional<std::pair<uint64_t, uint64_t>> qpc() noexcept {
  LARGE_INTEGER frequency{}, now{};
  if (!QueryPerformanceFrequency(&frequency) || frequency.QuadPart <= 0 || !QueryPerformanceCounter(&now) || now.QuadPart < 0) return {};
  return std::pair{static_cast<uint64_t>(now.QuadPart), static_cast<uint64_t>(frequency.QuadPart)};
}
bool same_rect(const WindowsRect& a, const WindowsRect& b) noexcept { return a == b; }
bool target_valid(const CaptureWorkerTarget& value) noexcept {
  const auto extent = capture_worker_extent(value.crop);
  const auto frame = capture_worker_extent(value.frame);
  return value.root_hwnd && value.surface_hwnd && value.root_hwnd <= std::numeric_limits<uintptr_t>::max() &&
    value.surface_hwnd <= std::numeric_limits<uintptr_t>::max() && value.root_pid && value.logical_pid &&
    value.root_created && value.logical_created && value.root_thread && value.logical_thread &&
    value.bounds.valid() && value.surface_bounds.valid() && frame && extent && value.frame.contains(value.crop) && nonzero(value.binding);
}
bool same_target(const CaptureWorkerTarget& a, const CaptureWorkerTarget& b) noexcept {
  return a.root_hwnd == b.root_hwnd && a.surface_hwnd == b.surface_hwnd && a.root_pid == b.root_pid && a.logical_pid == b.logical_pid &&
    a.root_created == b.root_created && a.logical_created == b.logical_created && a.root_thread == b.root_thread && a.logical_thread == b.logical_thread &&
    same_rect(a.bounds, b.bounds) && same_rect(a.surface_bounds, b.surface_bounds) && same_rect(a.frame, b.frame) && same_rect(a.crop, b.crop) && a.binding == b.binding;
}
bool extent_valid(const CaptureWorkerExtent& value) noexcept {
  const auto expected = capture_worker_extent({0, 0, value.width, value.height});
  return expected && *expected == value;
}
bool output_valid(const CaptureWorkerOutput& value) noexcept {
  if (value.status != CaptureWorkerStatus::pending && value.status != CaptureWorkerStatus::complete && value.status != CaptureWorkerStatus::failed) return false;
  if (static_cast<uint32_t>(value.phase) >= static_cast<uint32_t>(CaptureReadPhase::count)) return false;
  if (!nonzero(value.nonce) || !nonzero(value.binding)) return false;
  if (value.status == CaptureWorkerStatus::complete) return value.phase == CaptureReadPhase::none && extent_valid(value.extent);
  return (value.extent == CaptureWorkerExtent{} || extent_valid(value.extent)) &&
    (value.status != CaptureWorkerStatus::pending || value.phase == CaptureReadPhase::none);
}
struct Writer {
  std::span<uint8_t> bytes; size_t position = 0;
  void number(uint64_t value, size_t width) {
    if (width > bytes.size() - position) throw std::runtime_error("Capture worker encoding extent.");
    for (size_t index = 0; index < width; ++index) bytes[position++] = static_cast<uint8_t>(value >> (index * 8));
  }
  void raw(std::span<const uint8_t> value) {
    if (value.size() > bytes.size() - position) throw std::runtime_error("Capture worker encoding extent.");
    std::copy(value.begin(), value.end(), bytes.begin() + static_cast<ptrdiff_t>(position)); position += value.size();
  }
  void rectangle(const WindowsRect& value) {
    number(std::bit_cast<uint64_t>(value.x), 8); number(std::bit_cast<uint64_t>(value.y), 8);
    number(std::bit_cast<uint64_t>(value.width), 8); number(std::bit_cast<uint64_t>(value.height), 8);
  }
  void extent(const CaptureWorkerExtent& value) { number(value.width, 4); number(value.height, 4); number(value.stride, 4); number(value.bytes, 4); }
};
struct Reader {
  std::span<const uint8_t> bytes; size_t position = 0;
  uint64_t number(size_t width) {
    if (width > bytes.size() - position) throw std::runtime_error("Capture worker decoding extent.");
    uint64_t value = 0; for (size_t index = 0; index < width; ++index) value |= uint64_t(bytes[position++]) << (index * 8); return value;
  }
  void raw(std::span<uint8_t> value) {
    if (value.size() > bytes.size() - position) throw std::runtime_error("Capture worker decoding extent.");
    std::copy_n(bytes.begin() + static_cast<ptrdiff_t>(position), value.size(), value.begin()); position += value.size();
  }
  WindowsRect rectangle() { return {std::bit_cast<int64_t>(number(8)), std::bit_cast<int64_t>(number(8)), std::bit_cast<int64_t>(number(8)), std::bit_cast<int64_t>(number(8))}; }
  CaptureWorkerExtent extent() { return {static_cast<uint32_t>(number(4)), static_cast<uint32_t>(number(4)), static_cast<uint32_t>(number(4)), static_cast<uint32_t>(number(4))}; }
};
struct Canonical {
  std::vector<uint8_t> bytes;
  void number(uint64_t value, size_t width = 8) {
    if (width > canonical_max_bytes - bytes.size()) throw std::runtime_error("Capture binding capacity.");
    for (size_t index = 0; index < width; ++index) bytes.push_back(static_cast<uint8_t>(value >> (index * 8)));
  }
  void boolean(bool value) { number(value ? 1 : 0, 1); }
  void raw(std::span<const uint8_t> value) {
    if (value.size() > canonical_max_bytes - bytes.size() || value.size() > std::numeric_limits<uint32_t>::max()) throw std::runtime_error("Capture binding capacity.");
    number(static_cast<uint32_t>(value.size()), 4);
    if (value.size() > canonical_max_bytes - bytes.size()) throw std::runtime_error("Capture binding capacity.");
    bytes.insert(bytes.end(), value.begin(), value.end());
  }
  void text(const std::wstring& value) {
    if (value.size() > (canonical_max_bytes - bytes.size()) / 2 || value.size() > std::numeric_limits<uint32_t>::max()) throw std::runtime_error("Capture binding capacity.");
    number(static_cast<uint32_t>(value.size()), 4);
    for (const auto unit : value) number(static_cast<uint16_t>(unit), 2);
  }
  void optional_text(const std::optional<std::wstring>& value) { boolean(value.has_value()); if (value) text(*value); }
  void rectangle(const WindowsRect& value) {
    number(std::bit_cast<uint64_t>(value.x)); number(std::bit_cast<uint64_t>(value.y));
    number(std::bit_cast<uint64_t>(value.width)); number(std::bit_cast<uint64_t>(value.height));
  }
  void file(const FileIdentity& value) {
    text(value.path); number(value.volume); raw(value.id); number(value.size); number(value.created); number(value.modified);
    raw(value.sha256); number(static_cast<uint32_t>(value.signature), 4); raw(value.signer_subject);
  }
  void token(const TokenIdentity& value) {
    raw(value.user); raw(value.logon); number(value.authentication); number(value.session, 4); number(value.integrity, 4);
    boolean(value.elevated); boolean(value.ui_access); boolean(value.app_container);
  }
  void package(const std::optional<WindowsPackageEvidence>& value) {
    boolean(value.has_value()); if (!value) return;
    text(value->aumid); text(value->family); text(value->full_name); text(value->path);
    number(static_cast<uint32_t>(value->trust), 4); boolean(value->development_mode);
  }
  void identity(const WindowsAppIdentity& value) {
    number(static_cast<uint32_t>(value.kind), 4); text(value.aumid); text(value.publisher); text(value.product); text(value.binary); text(value.name); text(value.exe);
    boolean(value.system); boolean(value.verified); boolean(value.pid.has_value()); if (value.pid) number(*value.pid, 4);
  }
  void owner(const WindowsOwner& value) {
    identity(value.identity); number(value.process.pid, 4); number(value.process.creation_time); file(value.process.image); token(value.process.token); package(value.process.package);
  }
};
std::optional<CaptureWorkerBinding> digest(std::span<const uint8_t> bytes) {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) return {};
  struct Algorithm { BCRYPT_ALG_HANDLE value; ~Algorithm() { BCryptCloseAlgorithmProvider(value, 0); } } close_algorithm{algorithm};
  DWORD length = 0, written = 0;
  if (BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&length), sizeof(length), &written, 0) < 0 || written != sizeof(length) || !length || length > canonical_max_bytes) return {};
  std::vector<uint8_t> object(length); BCRYPT_HASH_HANDLE hash = nullptr;
  if (BCryptCreateHash(algorithm, &hash, object.data(), length, nullptr, 0, 0) < 0) return {};
  struct Hash { BCRYPT_HASH_HANDLE value; ~Hash() { BCryptDestroyHash(value); } } close_hash{hash};
  if (bytes.size() > std::numeric_limits<ULONG>::max() || BCryptHashData(hash, const_cast<PUCHAR>(bytes.data()), static_cast<ULONG>(bytes.size()), 0) < 0) return {};
  CaptureWorkerBinding result{};
  if (BCryptFinishHash(hash, result.data(), static_cast<ULONG>(result.size()), 0) < 0 || !nonzero(result)) return {};
  return result;
}
bool image_valid(const FileIdentity& image) {
  return helper_install_root(image.path).has_value() && image.size && image.size <= 1'073'741'824 && image.created && image.modified &&
    nonzero(image.id) && nonzero(image.sha256) &&
    (image.signature == SignatureState::unsigned_file || (image.signature == SignatureState::valid && !image.signer_subject.empty()));
}
}

std::optional<CaptureWorkerDeadline> capture_worker_deadline(uint64_t now, uint64_t frequency) noexcept {
  if (!frequency || frequency > qpc_max || now > qpc_max) return {};
  const auto ticks = acquisition_ticks(frequency);
  if (!ticks || now > qpc_max - ticks) return {};
  return CaptureWorkerDeadline{now, now + ticks, frequency};
}
std::optional<CaptureWorkerDeadline> capture_worker_deadline() noexcept {
  const auto observed = qpc(); return observed ? capture_worker_deadline(observed->first, observed->second) : std::nullopt;
}
bool capture_worker_deadline_current(const CaptureWorkerDeadline& value, uint64_t now, uint64_t frequency) noexcept {
  return deadline_valid(value) && frequency == value.frequency && now >= value.started && now < value.expires;
}
bool capture_worker_deadline_current(const CaptureWorkerDeadline& value) noexcept {
  const auto observed = qpc(); return observed && capture_worker_deadline_current(value, observed->first, observed->second);
}
uint32_t capture_worker_remaining_ms(const CaptureWorkerDeadline& value, uint64_t now, uint64_t frequency) noexcept {
  if (!capture_worker_deadline_current(value, now, frequency)) return 0;
  const auto remaining = value.expires - now;
  // Compare ceil(milliseconds * frequency / 1000) without multiplying two large values.
  uint32_t low = 0, high = 750;
  while (low < high) {
    const auto milliseconds = low + (high - low + 1) / 2;
    const auto ticks = (frequency / 1000) * milliseconds + ((frequency % 1000) * milliseconds + 999) / 1000;
    if (ticks <= remaining) low = milliseconds; else high = milliseconds - 1;
  }
  return low;
}
uint32_t capture_worker_remaining_ms(const CaptureWorkerDeadline& value) noexcept {
  const auto observed = qpc(); return observed ? capture_worker_remaining_ms(value, observed->first, observed->second) : 0;
}
std::optional<CaptureWorkerExtent> capture_worker_extent(const WindowsRect& crop) noexcept {
  if (!crop.valid() || crop.width > 32'768 || crop.height > 32'768) return {};
  const auto width = static_cast<uint64_t>(crop.width), height = static_cast<uint64_t>(crop.height);
  if (width * height > capture_worker_max_pixels) return {};
  const auto stride = width * 4, bytes = stride * height;
  if (!bytes || bytes > capture_worker_max_bytes || bytes > std::numeric_limits<uint32_t>::max()) return {};
  return CaptureWorkerExtent{static_cast<uint32_t>(width), static_cast<uint32_t>(height), static_cast<uint32_t>(stride), static_cast<uint32_t>(bytes)};
}
std::optional<CaptureWorkerBinding> capture_worker_binding(const WindowsWindow& window, const WindowsRect& frame, const WindowsRect& crop) noexcept {
  try {
    if (!capture_worker_extent(frame) || !capture_worker_extent(crop) || !frame.contains(crop)) return {};
    Canonical value; value.number(0x31425743, 4); // CWB1: canonical version/domain separation.
    value.number(reinterpret_cast<uintptr_t>(window.hwnd)); value.number(reinterpret_cast<uintptr_t>(window.surface));
    value.number(window.thread_id, 4); value.number(window.surface_thread_id, 4);
    value.owner(window.physical_owner); value.owner(window.owner); value.rectangle(window.bounds); value.rectangle(window.surface_bounds);
    value.text(window.window_class); value.optional_text(window.host_aumid); value.boolean(window.child_shell.has_value()); if (window.child_shell) value.boolean(*window.child_shell);
    value.boolean(window.visible); value.boolean(window.minimized); value.boolean(window.on_screen); value.boolean(window.cloaked); value.boolean(window.current_desktop); value.boolean(window.elevated);
    value.rectangle(frame); value.rectangle(crop); return digest(value.bytes);
  } catch (...) { return {}; }
}
std::optional<CaptureWorkerTarget> capture_worker_target(const WindowsWindow& window, const WindowsRect& frame, const WindowsRect& crop) noexcept {
  const auto binding = capture_worker_binding(window, frame, crop); if (!binding) return {};
  CaptureWorkerTarget value; value.root_hwnd = reinterpret_cast<uintptr_t>(window.hwnd); value.surface_hwnd = reinterpret_cast<uintptr_t>(window.surface);
  value.root_pid = window.physical_owner.process.pid; value.logical_pid = window.owner.process.pid;
  value.root_created = window.physical_owner.process.creation_time; value.logical_created = window.owner.process.creation_time;
  value.root_thread = window.thread_id; value.logical_thread = window.surface_thread_id;
  value.bounds = window.bounds; value.surface_bounds = window.surface_bounds; value.frame = frame; value.crop = crop; value.binding = *binding;
  return target_valid(value) ? std::optional{value} : std::nullopt;
}
bool capture_worker_target_matches(const CaptureWorkerTarget& expected, const WindowsWindow& window, const WindowsRect& frame) noexcept {
  const auto actual = capture_worker_target(window, frame, expected.crop); return target_valid(expected) && actual && same_target(expected, *actual);
}
std::optional<CaptureWorkerRequest> capture_worker_request(const WindowsWindow& window, const WindowsRect& frame, const WindowsRect& crop,
  uint32_t parent_pid, uint64_t parent_created, const CaptureWorkerNonce& nonce, const CaptureWorkerDeadline& deadline) noexcept {
  const auto target = capture_worker_target(window, frame, crop); const auto extent = capture_worker_extent(crop);
  if (!target || !extent) return {};
  CaptureWorkerRequest value{nonce, deadline, parent_pid, parent_created, *target, *extent};
  return capture_worker_request_valid(value) ? std::optional{value} : std::nullopt;
}
bool capture_worker_request_valid(const CaptureWorkerRequest& value) noexcept {
  const auto extent = capture_worker_extent(value.target.crop);
  return nonzero(value.nonce) && deadline_valid(value.deadline) && value.parent_pid && value.parent_created && target_valid(value.target) && extent && *extent == value.extent;
}
std::optional<std::array<uint8_t, capture_worker_request_bytes>> encode_capture_worker_request(const CaptureWorkerRequest& value) noexcept {
  try {
    if (!capture_worker_request_valid(value)) return {};
    std::array<uint8_t, capture_worker_request_bytes> bytes{}; Writer out{bytes};
    out.number(request_magic, 4); out.number(protocol_version, 2); out.number(capture_worker_request_bytes, 2); out.number(0, 8);
    out.raw(value.nonce); out.raw(value.target.binding); out.number(value.deadline.started, 8); out.number(value.deadline.expires, 8); out.number(value.deadline.frequency, 8);
    out.number(value.target.root_hwnd, 8); out.number(value.target.surface_hwnd, 8); out.number(value.target.root_pid, 4); out.number(value.target.logical_pid, 4);
    out.number(value.target.root_created, 8); out.number(value.target.logical_created, 8); out.number(value.target.root_thread, 4); out.number(value.target.logical_thread, 4);
    out.rectangle(value.target.bounds); out.rectangle(value.target.surface_bounds); out.rectangle(value.target.frame); out.rectangle(value.target.crop); out.extent(value.extent);
    out.number(value.parent_pid, 4); out.number(0, 4); out.number(value.parent_created, 8); out.number(0, 8);
    return out.position == bytes.size() ? std::optional{bytes} : std::nullopt;
  } catch (...) { return {}; }
}
std::optional<CaptureWorkerRequest> decode_capture_worker_request(std::span<const uint8_t> bytes) noexcept {
  try {
    if (bytes.size() != capture_worker_request_bytes) return {};
    Reader in{bytes}; if (in.number(4) != request_magic || in.number(2) != protocol_version || in.number(2) != capture_worker_request_bytes || in.number(8) != 0) return {};
    CaptureWorkerRequest value; in.raw(value.nonce); in.raw(value.target.binding);
    value.deadline = {in.number(8), in.number(8), in.number(8)};
    value.target.root_hwnd = in.number(8); value.target.surface_hwnd = in.number(8); value.target.root_pid = static_cast<uint32_t>(in.number(4)); value.target.logical_pid = static_cast<uint32_t>(in.number(4));
    value.target.root_created = in.number(8); value.target.logical_created = in.number(8); value.target.root_thread = static_cast<uint32_t>(in.number(4)); value.target.logical_thread = static_cast<uint32_t>(in.number(4));
    value.target.bounds = in.rectangle(); value.target.surface_bounds = in.rectangle(); value.target.frame = in.rectangle(); value.target.crop = in.rectangle(); value.extent = in.extent();
    value.parent_pid = static_cast<uint32_t>(in.number(4)); if (in.number(4)) return {}; value.parent_created = in.number(8); if (in.number(8)) return {};
    return in.position == bytes.size() && capture_worker_request_valid(value) ? std::optional{value} : std::nullopt;
  } catch (...) { return {}; }
}
std::optional<std::array<uint8_t, capture_worker_output_header_bytes>> encode_capture_worker_output(const CaptureWorkerOutput& value) noexcept {
  try {
    if (!output_valid(value)) return {};
    std::array<uint8_t, capture_worker_output_header_bytes> bytes{}; Writer out{bytes};
    out.number(output_magic, 4); out.number(protocol_version, 2); out.number(capture_worker_output_header_bytes, 2); out.number(static_cast<uint32_t>(value.status), 4); out.number(static_cast<uint32_t>(value.phase), 4);
    out.raw(value.nonce); out.raw(value.binding); out.extent(value.extent);
    return out.position == bytes.size() ? std::optional{bytes} : std::nullopt;
  } catch (...) { return {}; }
}
std::optional<CaptureWorkerOutput> decode_capture_worker_output(std::span<const uint8_t> bytes) noexcept {
  try {
    if (bytes.size() != capture_worker_output_header_bytes) return {};
    Reader in{bytes}; if (in.number(4) != output_magic || in.number(2) != protocol_version || in.number(2) != capture_worker_output_header_bytes) return {};
    CaptureWorkerOutput value; value.status = static_cast<CaptureWorkerStatus>(in.number(4)); value.phase = static_cast<CaptureReadPhase>(in.number(4)); in.raw(value.nonce); in.raw(value.binding); value.extent = in.extent();
    return in.position == bytes.size() && output_valid(value) ? std::optional{value} : std::nullopt;
  } catch (...) { return {}; }
}
bool capture_worker_accept(const CaptureWorkerRequest& request, const CaptureWorkerOutput& output, size_t mapped_bytes,
  bool exited, uint32_t exit_code, bool authority_current, uint64_t now, uint64_t frequency) noexcept {
  return exited && exit_code == 0 && authority_current && capture_worker_request_valid(request) &&
    capture_worker_deadline_current(request.deadline, now, frequency) && output_valid(output) && output.status == CaptureWorkerStatus::complete &&
    output.nonce == request.nonce && output.binding == request.target.binding && output.extent == request.extent &&
    mapped_bytes == capture_worker_output_header_bytes + static_cast<size_t>(request.extent.bytes);
}
bool capture_worker_accept(const CaptureWorkerRequest& request, const CaptureWorkerOutput& output, size_t mapped_bytes,
  bool exited, uint32_t exit_code, bool authority_current) noexcept {
  const auto observed = qpc(); return observed && capture_worker_accept(request, output, mapped_bytes, exited, exit_code, authority_current, observed->first, observed->second);
}
bool capture_worker_parent_allowed(const CaptureWorkerParentFacts& value) noexcept {
  try {
    return value.expected_pid && value.actual_pid == value.expected_pid && value.held_pid == value.expected_pid && value.child_pid && value.child_pid != value.expected_pid &&
      value.expected_created && value.held_created == value.expected_created && value.child_created >= value.expected_created && value.same_parent_object && value.parent_alive &&
      value.parent.process.pid == value.expected_pid && value.child.process.pid == value.child_pid &&
      value.parent.process.creation_time == value.expected_created && value.child.process.creation_time == value.child_created &&
      image_valid(value.parent.process.image) && image_valid(value.child.process.image) && same_file(value.parent.process.image, value.child.process.image) &&
      serving_token_allowed(value.parent.process.token) && serving_token_allowed(value.child.process.token) && same_token(value.parent.process.token, value.child.process.token);
  } catch (...) { return false; }
}
std::optional<CaptureReadPhase> capture_worker_failure_checkpoint(CaptureReadPhase parent, uint32_t checkpoint) noexcept {
  if (parent != CaptureReadPhase::window_worker_wait && parent != CaptureReadPhase::window_worker_exit) return {};
  if (checkpoint >= static_cast<uint32_t>(CaptureReadPhase::count)) return {};
  switch (static_cast<CaptureReadPhase>(checkpoint)) {
    case CaptureReadPhase::window_worker_prepare: case CaptureReadPhase::window_worker_auth:
    case CaptureReadPhase::window_worker_target: case CaptureReadPhase::window_worker_read:
    case CaptureReadPhase::window_worker_reply: case CaptureReadPhase::window_worker_cleanup:
      return static_cast<CaptureReadPhase>(checkpoint);
    default: return {};
  }
}
}
