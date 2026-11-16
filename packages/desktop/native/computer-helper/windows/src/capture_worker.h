#pragma once
#include "capture_worker_protocol.h"
#include <functional>
#include <optional>
#include <span>
#include <string>

namespace vector::computer {
// Only an exact same-image private child mode. Handles name inherited kernel objects,
// never paths, executable choices, arbitrary target commands or a public capture API.
struct CaptureWorkerCommand {
  DWORD parent = 0;
  uintptr_t request_mapping = 0, output_mapping = 0, parent_witness = 0, cancel_event = 0;
  CaptureWorkerNonce nonce{};
};
std::optional<CaptureWorkerCommand> parse_capture_worker(std::span<const std::wstring>) noexcept;
// Owns COM initialization; dispatch this mode before the entry's ordinary apartment setup.
int run_capture_worker(const CaptureWorkerCommand&) noexcept;

// A new process and new mappings for every isolated acquisition. The caller supplies the
// original admission deadline; neither transport, authentication nor teardown renews it.
CaptureBitmap capture_window_isolated(const CaptureReadRequest&, const CaptureWorkerDeadline&,
  const std::function<bool()>& current, CaptureReadPhase& phase);

// The native WGC implementation is callable only by the authenticated private worker.
CaptureBitmap capture_worker_window_bitmap(const CaptureReadRequest&, const CaptureWorkerDeadline&,
  const std::function<bool()>& current, CaptureReadPhase& phase);
}
