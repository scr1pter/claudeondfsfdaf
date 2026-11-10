#pragma once
#include "capture_math.h"
#include "windows_policy.h"
#include <deque>
#include <mutex>

namespace vector::computer {
struct CaptureDisplay {
  HMONITOR monitor = nullptr;
  std::wstring id;
  WindowsRect bounds;
  double dpi_scale = 0;
  bool primary = false;
};
struct CaptureSurface {
  HWND hwnd = nullptr;
  DWORD pid = 0, thread = 0;
  WindowsRect bounds;
  WindowsRect frame_bounds;
  bool visible = false, minimized = false, cloaked = true;
  // Unknown alpha never establishes an opaque occluder of a private window behind it.
  bool opaque = false;
  bool excluded_overlay = false;
  bool affinity_known = false;
  DWORD affinity = 0;
  LONG_PTR extended_style = 0;
  std::wstring window_class;
  std::optional<WindowsWindow> window;
  // A zero-area outer HWND is retained only with an observed, canonical DWM footprint.
  bool frame_known = false;
};
bool capture_surface_geometry(const CaptureSurface&) noexcept;
struct CaptureInventory {
  std::vector<CaptureDisplay> displays;
  // Every visible top-level structural HWND, in native front-to-back order, including unknown owners.
  std::vector<CaptureSurface> windows;
};
bool same_capture_inventory(const CaptureInventory&, const CaptureInventory&) noexcept;
struct CaptureReadRequest {
  WindowsRect bounds;
  std::optional<WindowsWindow> window;
  bool isolate_window = false;
};
// Failure-only metadata for the private self-test. No native values or content are observed.
enum class CaptureReadPhase {
  none, surface_before, context_before, screen_bounds, screen_dc, screen_memory_dc,
  screen_dib, screen_select, screen_blit, screen_flush, screen_copy, window_supported, window_frame,
  window_device, window_interop, window_factory_ticket, window_factory, window_factory_current,
  window_factory_context, window_factory_retired, window_item_ticket, window_item_create, window_item_expired_cancelled,
  window_item_full_cancelled_setup_lt25_rpc_lt25, window_item_full_cancelled_setup_lt25_rpc_from25to49,
  window_item_full_cancelled_setup_lt25_rpc_ge50, window_item_full_cancelled_setup_ge25_rpc_lt25,
  window_item_full_cancelled_setup_ge25_rpc_from25to49, window_item_full_cancelled_setup_ge25_rpc_ge50,
  window_item_expired_denied,
  window_item_expired_other, window_item_current_cancelled, window_item_current_denied,
  window_item_current_other, window_item_current, window_item_acquisition_expired,
  window_item_full_ticket_expired,
  window_item_full_expired_setup_lt25_rpc_lt25, window_item_full_expired_setup_lt25_rpc_from25to49,
  window_item_full_expired_setup_lt25_rpc_ge50, window_item_full_expired_setup_ge25_rpc_lt25,
  window_item_full_expired_setup_ge25_rpc_from25to49, window_item_full_expired_setup_ge25_rpc_ge50,
  window_item_truncated_ticket_expired, window_item_context, window_item_retired,
  window_item_size, window_pool, window_session, window_start_ticket, window_start,
  window_start_current, window_first_frame, window_content_size, window_texture,
  window_description, window_staging, window_copy, window_map, window_crop,
  window_current, surface_after, context_after, count
};
// RPC span includes the unchanged immediate pre/post checks; no claim of pure OS execution time.
// Unknown or invalid observations preserve the original full-ticket-expired diagnostic.
CaptureReadPhase capture_item_ticket_expiry(std::optional<int64_t> setup_ms, std::optional<int64_t> rpc_span_ms) noexcept;
// The same buckets distinguish an actually cancelled HRESULT; unknown timing retains that legacy cause.
CaptureReadPhase capture_item_cancelled_ticket_expiry(std::optional<int64_t> setup_ms, std::optional<int64_t> rpc_span_ms) noexcept;
using CaptureReadObserver = void (*)(CaptureReadPhase);
struct CaptureBackend {
  std::function<std::vector<CaptureDisplay>()> displays;
  std::function<CaptureInventory(const ServerSession&, const std::function<bool()>&)> inventory;
  // Fast native metadata only: no trust/hash, process-tree scan, UIA, deployment or manifest RPC.
  std::function<bool(const CaptureInventory&, const ServerSession&)> current;
  std::function<CaptureBitmap(const CaptureReadRequest&, const std::function<bool()>&)> read;
  std::function<void(CaptureBitmap&, const CapturePrivacyPlan&, const WindowsRect&, const CaptureFit&)> label;
  std::function<std::vector<uint8_t>(const CaptureBitmap&, std::wstring_view, uint32_t)> encode;
  std::function<bool()> window_supported;
  std::function<bool()> available;
  std::function<uint64_t()> now;
  std::function<std::wstring()> identifier;
  static CaptureBackend system(WindowsInventoryObserver diagnostic = nullptr, CaptureReadObserver read_diagnostic = nullptr);
};

struct CaptureReceipt {
  std::wstring id, display_id, session_id;
  uint64_t run_epoch = 0, observation_epoch = 0, generation = 0;
  std::optional<uint64_t> revision;
  WindowsRect bounds;
  uint32_t width = 0, height = 0;
  double image_scale = 0, dpi_scale = 0;
  std::optional<WindowsWindow> window;
  CaptureInventory inventory;
  std::optional<std::wstring> zoom_source;
  POINT point(int64_t x, int64_t y) const;
};
class CaptureRegistry final {
 public:
  void invalidate() noexcept;
  void close() noexcept;
  uint64_t generation() const noexcept;
  bool put(CaptureReceipt receipt, uint64_t expected_generation);
  CaptureReceipt get(std::wstring_view id, const ServerSession&, bool allow_zoom = false) const;
 private:
  mutable std::mutex mutex_;
  uint64_t generation_ = 1;
  bool closed_ = false;
  struct Entry { CaptureReceipt receipt; size_t bytes = 0, witnesses = 0; };
  size_t retained_bytes_ = 0, retained_witnesses_ = 0;
  std::deque<Entry> receipts_;
};

class CaptureService final {
 public:
  explicit CaptureService(CaptureBackend backend = CaptureBackend::system());
  JsonObject features() const;
  void displays(const JsonObject&, const OperationContext&, Dispatcher::Completion);
  void capture(const JsonObject&, const OperationContext&, Dispatcher::Completion);
  CaptureReceipt receipt(std::wstring_view id, const ServerSession&, bool allow_zoom = false) const;
  bool current(const CaptureReceipt&, const ServerSession&) const;
  void invalidate() noexcept;
  void close() noexcept;
 private:
  CaptureBackend backend_;
  CaptureRegistry registry_;
};
size_t run_capture_tests();
}
