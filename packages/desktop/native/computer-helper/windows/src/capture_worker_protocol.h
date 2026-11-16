#pragma once
#include "capture.h"
#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>

namespace vector::computer {
// Private, one-shot, little-endian mapping protocol. No process-local pointers or leases.
inline constexpr size_t capture_worker_request_bytes = 320;
inline constexpr size_t capture_worker_output_header_bytes = 96;
inline constexpr uint64_t capture_worker_max_pixels = 64ULL * 1024 * 1024;
inline constexpr uint64_t capture_worker_max_bytes = capture_worker_max_pixels * 4;
using CaptureWorkerNonce = std::array<uint8_t, 32>;
using CaptureWorkerBinding = std::array<uint8_t, 32>;

struct CaptureWorkerDeadline {
  uint64_t started = 0, expires = 0, frequency = 0;
  bool operator==(const CaptureWorkerDeadline&) const = default;
};
// Exactly floor(3 * frequency / 4) ticks; no overflow, renewal or exact-expiry acceptance.
std::optional<CaptureWorkerDeadline> capture_worker_deadline(uint64_t now, uint64_t frequency) noexcept;
std::optional<CaptureWorkerDeadline> capture_worker_deadline() noexcept;
bool capture_worker_deadline_current(const CaptureWorkerDeadline&, uint64_t now, uint64_t frequency) noexcept;
bool capture_worker_deadline_current(const CaptureWorkerDeadline&) noexcept;
uint32_t capture_worker_remaining_ms(const CaptureWorkerDeadline&, uint64_t now, uint64_t frequency) noexcept;
uint32_t capture_worker_remaining_ms(const CaptureWorkerDeadline&) noexcept;

struct CaptureWorkerExtent {
  uint32_t width = 0, height = 0, stride = 0, bytes = 0;
  bool operator==(const CaptureWorkerExtent&) const = default;
};
std::optional<CaptureWorkerExtent> capture_worker_extent(const WindowsRect& crop) noexcept;

struct CaptureWorkerTarget {
  uint64_t root_hwnd = 0, surface_hwnd = 0;
  uint32_t root_pid = 0, logical_pid = 0;
  uint64_t root_created = 0, logical_created = 0;
  uint32_t root_thread = 0, logical_thread = 0;
  WindowsRect bounds, surface_bounds, frame, crop;
  CaptureWorkerBinding binding{};
};
// SHA-256 of a versioned, length-delimited canonical encoding of all WindowsWindow,
// owner, process, file, token, package and application-identity fields, plus frame/crop.
// Leases are intentionally excluded: the parent keeps originals; the child observes fresh leases.
std::optional<CaptureWorkerBinding> capture_worker_binding(const WindowsWindow&, const WindowsRect& frame, const WindowsRect& crop) noexcept;
std::optional<CaptureWorkerTarget> capture_worker_target(const WindowsWindow&, const WindowsRect& frame, const WindowsRect& crop) noexcept;
bool capture_worker_target_matches(const CaptureWorkerTarget&, const WindowsWindow&, const WindowsRect& frame) noexcept;

struct CaptureWorkerRequest {
  CaptureWorkerNonce nonce{};
  CaptureWorkerDeadline deadline;
  uint32_t parent_pid = 0;
  uint64_t parent_created = 0;
  CaptureWorkerTarget target;
  CaptureWorkerExtent extent;
};
std::optional<CaptureWorkerRequest> capture_worker_request(const WindowsWindow&, const WindowsRect& frame, const WindowsRect& crop,
  uint32_t parent_pid, uint64_t parent_created, const CaptureWorkerNonce&, const CaptureWorkerDeadline&) noexcept;
bool capture_worker_request_valid(const CaptureWorkerRequest&) noexcept;
std::optional<std::array<uint8_t, capture_worker_request_bytes>> encode_capture_worker_request(const CaptureWorkerRequest&) noexcept;
std::optional<CaptureWorkerRequest> decode_capture_worker_request(std::span<const uint8_t>) noexcept;

enum class CaptureWorkerStatus : uint32_t { pending = 0, complete = 1, failed = 2 };
struct CaptureWorkerOutput {
  CaptureWorkerStatus status = CaptureWorkerStatus::pending;
  CaptureReadPhase phase = CaptureReadPhase::none;
  CaptureWorkerNonce nonce{};
  CaptureWorkerBinding binding{};
  CaptureWorkerExtent extent;
};
std::optional<std::array<uint8_t, capture_worker_output_header_bytes>> encode_capture_worker_output(const CaptureWorkerOutput&) noexcept;
std::optional<CaptureWorkerOutput> decode_capture_worker_output(std::span<const uint8_t>) noexcept;
// mapped_bytes includes exactly the 96-byte header + admitted BGRA extent. The parent
// must decode only after observing actual process exit, and pass its ORIGINAL request.
bool capture_worker_accept(const CaptureWorkerRequest&, const CaptureWorkerOutput&, size_t mapped_bytes,
  bool exited, uint32_t exit_code, bool authority_current, uint64_t now, uint64_t frequency) noexcept;
bool capture_worker_accept(const CaptureWorkerRequest&, const CaptureWorkerOutput&, size_t mapped_bytes,
  bool exited, uint32_t exit_code, bool authority_current) noexcept;

// Pure decision over independently observed kernel facts. A wait-only inherited process
// witness must be CompareObjectHandles-bound to the actual immediate parent's held handle.
struct CaptureWorkerParentFacts {
  uint32_t expected_pid = 0, actual_pid = 0, held_pid = 0, child_pid = 0;
  uint64_t expected_created = 0, held_created = 0, child_created = 0;
  bool same_parent_object = false, parent_alive = false;
  WindowsOwner parent, child;
};
bool capture_worker_parent_allowed(const CaptureWorkerParentFacts&) noexcept;
size_t run_capture_worker_tests();
// Last private checkpoint is diagnostic only; it can refine only an already-failed wait/exit.
std::optional<CaptureReadPhase> capture_worker_failure_checkpoint(CaptureReadPhase parent, uint32_t checkpoint) noexcept;
}
