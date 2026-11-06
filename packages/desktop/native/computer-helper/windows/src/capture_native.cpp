#include "capture.h"
#include "guard.h"
#include "windows_com.h"
#include "windows_process_tree.h"
#include "availability.h"
#include <d3d11.h>
#include <dwmapi.h>
#include <objidl.h>
#include <ocidl.h>
#include <shellscalingapi.h>
#include <wincodec.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstring>
#include <limits>
#include <thread>

namespace vector::computer {
namespace {
using Clock = std::chrono::steady_clock;
[[noreturn]] void unavailable(std::wstring code = L"capture_unavailable") { throw Failure{std::move(code), L"The native capture is unavailable. Check Windows Privacy & security settings."}; }
void require(bool value, std::wstring code = L"capture_unavailable") { if (!value) unavailable(std::move(code)); }
WindowsRect rectangle(const RECT& value) { return {value.left, value.top, int64_t(value.right) - value.left, int64_t(value.bottom) - value.top}; }
void require_capture_surface(const std::optional<WindowsWindow>& window = {}) {
  const auto actual = observe_windows_availability(WindowsAvailabilityBackend::system());
  if (window) {
    require_windows_capture(actual, &window->owner.process.token);
    require_windows_capture(actual, &window->physical_owner.process.token);
  } else require_windows_capture(actual);
  require(AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) != FALSE);
}
std::vector<CaptureDisplay> native_displays() {
  struct State { std::vector<CaptureDisplay> displays; bool complete = true; } state;
  const auto callback = [](HMONITOR monitor, HDC, LPRECT, LPARAM raw) -> BOOL {
    auto& result = *reinterpret_cast<State*>(raw);
    try {
      if (result.displays.size() >= 64) { result.complete = false; return FALSE; }
      MONITORINFOEXW info{}; info.cbSize = sizeof(info);
      UINT x = 0, y = 0;
      if (!GetMonitorInfoW(monitor, reinterpret_cast<MONITORINFO*>(&info)) || FAILED(GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &x, &y)) || x == 0 || x != y || x > 1536) { result.complete = false; return FALSE; }
      const auto end = std::find(std::begin(info.szDevice), std::end(info.szDevice), L'\0');
      const auto bounds = rectangle(info.rcMonitor);
      if (end == std::end(info.szDevice) || end == std::begin(info.szDevice) || !bounds.valid()) { result.complete = false; return FALSE; }
      result.displays.push_back({monitor, std::wstring(std::begin(info.szDevice), end), bounds, double(x) / 96, (info.dwFlags & MONITORINFOF_PRIMARY) != 0});
      return TRUE;
    } catch (...) { result.complete = false; return FALSE; }
  };
  require(EnumDisplayMonitors(nullptr, nullptr, callback, reinterpret_cast<LPARAM>(&state)) && state.complete && !state.displays.empty());
  std::sort(state.displays.begin(), state.displays.end(), [](const auto& left, const auto& right) { return left.id < right.id; });
  return state.displays;
}
CaptureSurface structural(HWND hwnd, const ServerSession& session, WindowsInventoryObserver diagnostic) {
  CaptureSurface value; value.hwnd = hwnd;
  value.thread = GetWindowThreadProcessId(hwnd, &value.pid);
  RECT bounds{}; DWORD cloak = 0;
  if (value.thread == 0 || value.pid == 0 || GetAncestor(hwnd, GA_ROOT) != hwnd) { observe_windows_inventory_failure(diagnostic, WindowsInventoryDiagnostic::capture_identity); unavailable(L"changed"); }
  if (!GetWindowRect(hwnd, &bounds)) { observe_windows_inventory_failure(diagnostic, WindowsInventoryDiagnostic::capture_bounds_read); unavailable(L"changed"); }
  value.bounds = rectangle(bounds);
  const auto bounds_reason = windows_capture_bounds_diagnostic(value.bounds);
  if (bounds_reason != WindowsInventoryDiagnostic::none && bounds_reason != WindowsInventoryDiagnostic::capture_bounds_empty) {
    observe_windows_inventory_failure(diagnostic, bounds_reason); unavailable(L"changed");
  }
  RECT frame{};
  value.frame_known = SUCCEEDED(DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &frame, sizeof(frame)));
  if (value.frame_known) value.frame_bounds = rectangle(frame);
  if (!capture_surface_geometry(value)) {
    auto reason = windows_capture_bounds_diagnostic(value.bounds);
    if (reason == WindowsInventoryDiagnostic::capture_bounds_empty)
      reason = value.frame_known ? WindowsInventoryDiagnostic::capture_empty_frame_geometry : WindowsInventoryDiagnostic::capture_empty_frame_unknown;
    observe_windows_inventory_failure(diagnostic, reason); unavailable(L"changed");
  }
  value.visible = IsWindowVisible(hwnd) != FALSE; value.minimized = IsIconic(hwnd) != FALSE;
  if (FAILED(DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &cloak, sizeof(cloak)))) { observe_windows_inventory_failure(diagnostic, WindowsInventoryDiagnostic::capture_cloak); unavailable(L"changed"); }
  value.cloaked = cloak != 0;
  wchar_t name[257]{}; const auto length = GetClassNameW(hwnd, name, 257);
  if (length <= 0 || length > 256) { observe_windows_inventory_failure(diagnostic, WindowsInventoryDiagnostic::capture_class); unavailable(L"changed"); }
  value.window_class.assign(name, static_cast<size_t>(length));
  SetLastError(ERROR_SUCCESS); value.extended_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
  if (value.extended_style == 0 && GetLastError() != ERROR_SUCCESS) { observe_windows_inventory_failure(diagnostic, WindowsInventoryDiagnostic::capture_style); unavailable(L"changed"); }
  value.affinity_known = GetWindowDisplayAffinity(hwnd, &value.affinity) != FALSE;
  value.excluded_overlay = value.bounds.valid() && value.affinity_known && value.affinity == WDA_EXCLUDEFROMCAPTURE &&
    windows_overlay_passthrough_allowed({hwnd, value.pid, value.extended_style}, session);
  // WS_EX_LAYERED's absence does not establish a wholly opaque DWM/glass surface.
  value.opaque = false; return value;
}
struct NativeCapture {
  WindowsBackend windows = WindowsBackend::system(windows_child_shell);
  WindowsInventoryObserver diagnostic = nullptr;
  CaptureInventory inventory(const ServerSession& session, const std::function<bool()>& current, bool resolve = true) const {
    require_capture_surface();
    CaptureInventory result; result.displays = native_displays();
    struct State {
      const NativeCapture* native; const ServerSession* session; const std::function<bool()>* current;
      std::vector<CaptureSurface>* windows; Clock::time_point deadline; bool resolve; size_t count = 0; bool complete = true;
    } state{this, &session, &current, &result.windows, Clock::now() + std::chrono::seconds(4), resolve};
    const auto callback = [](HWND hwnd, LPARAM raw) -> BOOL {
      auto& data = *reinterpret_cast<State*>(raw);
      const auto current = [&] {
        try { return (*data.current)(); }
        catch (...) { observe_windows_inventory_failure(data.native->diagnostic, WindowsInventoryDiagnostic::capture_context); throw; }
      };
      try {
        if (++data.count > 4096) { observe_windows_inventory_failure(data.native->diagnostic, WindowsInventoryDiagnostic::capture_cap); data.complete = false; return FALSE; }
        if (Clock::now() >= data.deadline) { observe_windows_inventory_failure(data.native->diagnostic, WindowsInventoryDiagnostic::capture_deadline); data.complete = false; return FALSE; }
        if (!current()) { observe_windows_inventory_failure(data.native->diagnostic, WindowsInventoryDiagnostic::capture_context); data.complete = false; return FALSE; }
        if (!IsWindowVisible(hwnd) && !IsIconic(hwnd)) return TRUE;
        auto surface = structural(hwnd, *data.session, data.native->diagnostic);
        if (data.resolve && surface.bounds.valid() && !surface.excluded_overlay) {
          try { surface.window = data.native->windows.observe(hwnd); } catch (...) { /* Unknown owners remain structural privacy masks. */ }
        }
        if (!current()) { observe_windows_inventory_failure(data.native->diagnostic, WindowsInventoryDiagnostic::capture_context); data.complete = false; return FALSE; }
        data.windows->push_back(std::move(surface)); return TRUE;
      } catch (...) { observe_windows_inventory_failure(data.native->diagnostic, WindowsInventoryDiagnostic::capture_structure); data.complete = false; return FALSE; }
    };
    const auto enumerated = EnumWindows(callback, reinterpret_cast<LPARAM>(&state));
    if (!enumerated) { if (state.complete) observe_windows_inventory_failure(diagnostic, WindowsInventoryDiagnostic::capture_enum); unavailable(L"changed"); }
    if (!state.complete) unavailable(L"changed");
    bool final_current = false;
    try { final_current = current(); } catch (...) { observe_windows_inventory_failure(diagnostic, WindowsInventoryDiagnostic::capture_context); throw; }
    if (!final_current) { observe_windows_inventory_failure(diagnostic, WindowsInventoryDiagnostic::capture_context); unavailable(L"changed"); }
    return result;
  }
  bool current(const CaptureInventory& expected, const ServerSession& session) const {
    try {
      const auto start = Clock::now();
      const auto fresh = inventory(session, [&] { return Clock::now() - start < std::chrono::milliseconds(40); }, false);
      // Structural comparison is repeated without content, provider calls or signature verification.
      if (fresh.displays.size() != expected.displays.size()) return false;
      auto structural_expected = expected;
      for (auto& surface : structural_expected.windows) surface.window.reset();
      if (!same_capture_inventory(structural_expected, fresh)) return false;
      for (const auto& surface : expected.windows) {
        if (surface.excluded_overlay || !surface.window) continue;
        if (Clock::now() - start >= std::chrono::milliseconds(40) || !windows_owner_current(surface.window->owner) || !windows_owner_current(surface.window->physical_owner)) return false;
      }
      return Clock::now() - start < std::chrono::milliseconds(40);
    } catch (...) { return false; }
  }
};

CaptureBitmap screen_bitmap(const WindowsRect& bounds, CaptureReadPhase& phase) {
  phase = CaptureReadPhase::screen_bounds;
  require(bounds.valid() && bounds.width <= 32'768 && bounds.height <= 32'768 && uint64_t(bounds.width) * uint64_t(bounds.height) <= 64ULL * 1024 * 1024);
  phase = CaptureReadPhase::screen_dc;
  struct Screen { HDC dc; ~Screen() { if (dc) ReleaseDC(nullptr, dc); } } screen{GetDC(nullptr)};
  require(screen.dc != nullptr);
  phase = CaptureReadPhase::screen_memory_dc;
  struct DC { HDC dc; ~DC() { if (dc) DeleteDC(dc); } } memory{CreateCompatibleDC(screen.dc)};
  require(memory.dc != nullptr);
  BITMAPINFO info{}; info.bmiHeader.biSize = sizeof(info.bmiHeader); info.bmiHeader.biWidth = static_cast<LONG>(bounds.width); info.bmiHeader.biHeight = -static_cast<LONG>(bounds.height);
  info.bmiHeader.biPlanes = 1; info.bmiHeader.biBitCount = 32; info.bmiHeader.biCompression = BI_RGB;
  void* pixels = nullptr;
  phase = CaptureReadPhase::screen_dib;
  struct Bitmap { HBITMAP value; ~Bitmap() { if (value) DeleteObject(value); } } bitmap{CreateDIBSection(screen.dc, &info, DIB_RGB_COLORS, &pixels, nullptr, 0)};
  require(bitmap.value && pixels);
  phase = CaptureReadPhase::screen_select;
  const auto previous = SelectObject(memory.dc, bitmap.value); require(previous && previous != HGDI_ERROR);
  struct Selection { HDC dc; HGDIOBJ previous; ~Selection() { SelectObject(dc, previous); } } selection{memory.dc, previous};
  phase = CaptureReadPhase::screen_blit;
  const auto copied = BitBlt(memory.dc, 0, 0, static_cast<int>(bounds.width), static_cast<int>(bounds.height), screen.dc, static_cast<int>(bounds.x), static_cast<int>(bounds.y), SRCCOPY | CAPTUREBLT);
  if (copied) phase = CaptureReadPhase::screen_flush;
  require(copied && GdiFlush());
  phase = CaptureReadPhase::screen_copy;
  CaptureBitmap result{static_cast<uint32_t>(bounds.width), static_cast<uint32_t>(bounds.height), std::vector<uint8_t>(static_cast<size_t>(bounds.width) * static_cast<size_t>(bounds.height) * 4)};
  std::memcpy(result.bgra.data(), pixels, result.bgra.size());
  for (size_t index = 3; index < result.bgra.size(); index += 4) result.bgra[index] = 255;
  return result;
}

bool window_capture_supported() {
  try { return winrt::Windows::Graphics::Capture::GraphicsCaptureSession::IsSupported(); } catch (...) { return false; }
}
CaptureBitmap window_bitmap(const CaptureReadRequest& request, const std::function<bool()>& current, CaptureReadPhase& phase) {
  using winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool;
  using winrt::Windows::Graphics::Capture::GraphicsCaptureItem;
  using winrt::Windows::Graphics::DirectX::DirectXPixelFormat;
  phase = CaptureReadPhase::window_supported;
  require(request.window && window_capture_supported() && current());
  phase = CaptureReadPhase::window_frame;
  RECT native_frame{};
  require(SUCCEEDED(DwmGetWindowAttribute(request.window->hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &native_frame, sizeof(native_frame))));
  const auto bounds = rectangle(native_frame); require(bounds.valid() && bounds.contains(request.bounds));
  require(bounds.width <= 32'768 && bounds.height <= 32'768 && uint64_t(bounds.width) * uint64_t(bounds.height) <= 64ULL * 1024 * 1024);
  phase = CaptureReadPhase::window_device;
  winrt::com_ptr<ID3D11Device> device; winrt::com_ptr<ID3D11DeviceContext> commands;
  const auto create = [&](D3D_DRIVER_TYPE type) { return D3D11CreateDevice(nullptr, type, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION, device.put(), nullptr, commands.put()); };
  auto status = create(D3D_DRIVER_TYPE_HARDWARE);
  if (FAILED(status)) { device = nullptr; commands = nullptr; status = create(D3D_DRIVER_TYPE_WARP); }
  require(SUCCEEDED(status) && current());
  phase = CaptureReadPhase::window_interop;
  const auto dxgi = device.as<IDXGIDevice>(); winrt::com_ptr<IInspectable> inspectable;
  winrt::check_hresult(CreateDirect3D11DeviceFromDXGIDevice(dxgi.get(), inspectable.put()));
  const auto graphics = inspectable.as<winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice>();
  GraphicsCaptureItem item{nullptr};
  winrt::com_ptr<IGraphicsCaptureItemInterop> interop;
  // Two distinct metadata calls each retain a <=50ms ticket and share one absolute acceptance bound.
  const auto metadata_deadline = Clock::now() + std::chrono::milliseconds(100);
  const auto metadata_current = [&] {
    require(Clock::now() < metadata_deadline && current());
    require_capture_surface(request.window);
    require(windows_window_current(*request.window));
    RECT fresh{};
    require(SUCCEEDED(DwmGetWindowAttribute(request.window->hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &fresh, sizeof(fresh))) && rectangle(fresh) == bounds);
    require(current() && Clock::now() < metadata_deadline);
  };
  const auto ticket_budget = [&] {
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(metadata_deadline - Clock::now()).count();
    require(remaining > 0);
    return static_cast<uint32_t>(std::min<int64_t>(50, remaining));
  };
  phase = CaptureReadPhase::window_factory_ticket; metadata_current();
  { WindowsComCall call(ticket_budget()); require(call.current());
    require(current() && Clock::now() < metadata_deadline && call.current());
    phase = CaptureReadPhase::window_factory;
    interop = winrt::get_activation_factory<GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
    phase = CaptureReadPhase::window_factory_current; require(call.current() && Clock::now() < metadata_deadline);
    phase = CaptureReadPhase::window_factory_context; require(current());
  } // Retire and join the first timer before admitting any successor RPC on this thread.
  phase = CaptureReadPhase::window_factory_retired; metadata_current();
  phase = CaptureReadPhase::window_item_ticket;
  { WindowsComCall call(ticket_budget()); require(call.current());
    require(current() && Clock::now() < metadata_deadline && call.current());
    phase = CaptureReadPhase::window_item_create;
    const auto created = interop->CreateForWindow(request.window->hwnd, winrt::guid_of<GraphicsCaptureItem>(), winrt::put_abi(item));
    if (FAILED(created)) {
      const auto observation = call.observation();
      const auto cancelled = created == RPC_E_CALL_CANCELED || created == HRESULT_FROM_WIN32(RPC_S_CALL_CANCELLED) || created == HRESULT_FROM_WIN32(ERROR_CANCELLED);
      if (observation == WindowsComObservation::expired)
        phase = cancelled ? CaptureReadPhase::window_item_expired_cancelled : created == E_ACCESSDENIED ? CaptureReadPhase::window_item_expired_denied : CaptureReadPhase::window_item_expired_other;
      if (observation == WindowsComObservation::current)
        phase = cancelled ? CaptureReadPhase::window_item_current_cancelled : created == E_ACCESSDENIED ? CaptureReadPhase::window_item_current_denied : CaptureReadPhase::window_item_current_other;
    }
    winrt::check_hresult(created);
    phase = CaptureReadPhase::window_item_current; require(call.current() && Clock::now() < metadata_deadline);
    phase = CaptureReadPhase::window_item_context; require(current()); }
  phase = CaptureReadPhase::window_item_retired; metadata_current();
  phase = CaptureReadPhase::window_item_size;
  const auto size = item.Size();
  // DWM's real extended frame and the OS capture item must agree; no guessed shadow/border offset.
  require(size.Width == bounds.width && size.Height == bounds.height);
  phase = CaptureReadPhase::window_pool;
  auto pool = Direct3D11CaptureFramePool::CreateFreeThreaded(graphics, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size);
  phase = CaptureReadPhase::window_session;
  auto session = pool.CreateCaptureSession(item);
  struct Close { decltype(pool)& frame_pool; decltype(session)& capture_session; ~Close() { try { capture_session.Close(); } catch (...) {} try { frame_pool.Close(); } catch (...) {} } } close{pool, session};
  const auto deadline = Clock::now() + std::chrono::milliseconds(750);
  phase = CaptureReadPhase::window_start_ticket;
  { WindowsComCall call; require(call.current()); phase = CaptureReadPhase::window_start;
    session.IsCursorCaptureEnabled(false); session.StartCapture(); phase = CaptureReadPhase::window_start_current; require(call.current() && current()); }
  phase = CaptureReadPhase::window_first_frame;
  winrt::Windows::Graphics::Capture::Direct3D11CaptureFrame frame{nullptr};
  while (!frame && Clock::now() < deadline && current()) {
    frame = pool.TryGetNextFrame(); if (!frame) std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  require(frame && current() && Clock::now() < deadline);
  phase = CaptureReadPhase::window_content_size;
  const auto content = frame.ContentSize(); require(content.Width == size.Width && content.Height == size.Height);
  phase = CaptureReadPhase::window_texture;
  const auto access = frame.Surface().as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
  winrt::com_ptr<ID3D11Texture2D> texture; winrt::check_hresult(access->GetInterface(__uuidof(ID3D11Texture2D), texture.put_void()));
  phase = CaptureReadPhase::window_description;
  D3D11_TEXTURE2D_DESC description{}; texture->GetDesc(&description);
  require(description.Width >= static_cast<uint32_t>(size.Width) && description.Height >= static_cast<uint32_t>(size.Height) && description.Format == DXGI_FORMAT_B8G8R8A8_UNORM && description.SampleDesc.Count == 1);
  description.Width = static_cast<uint32_t>(size.Width); description.Height = static_cast<uint32_t>(size.Height); description.MipLevels = 1; description.ArraySize = 1;
  description.Usage = D3D11_USAGE_STAGING; description.BindFlags = 0; description.CPUAccessFlags = D3D11_CPU_ACCESS_READ; description.MiscFlags = 0;
  phase = CaptureReadPhase::window_staging;
  winrt::com_ptr<ID3D11Texture2D> staging; winrt::check_hresult(device->CreateTexture2D(&description, nullptr, staging.put()));
  phase = CaptureReadPhase::window_copy;
  D3D11_BOX region{0, 0, 0, description.Width, description.Height, 1}; commands->CopySubresourceRegion(staging.get(), 0, 0, 0, 0, texture.get(), 0, &region);
  D3D11_MAPPED_SUBRESOURCE mapped{};
  phase = CaptureReadPhase::window_map;
  for (;;) {
    require(current() && Clock::now() < deadline);
    const auto map = commands->Map(staging.get(), 0, D3D11_MAP_READ, D3D11_MAP_FLAG_DO_NOT_WAIT, &mapped);
    if (map == DXGI_ERROR_WAS_STILL_DRAWING) { std::this_thread::sleep_for(std::chrono::milliseconds(5)); continue; }
    require(SUCCEEDED(map)); break;
  }
  struct Unmap { ID3D11DeviceContext* context; ID3D11Texture2D* texture; ~Unmap() { context->Unmap(texture, 0); } } unmap{commands.get(), staging.get()};
  phase = CaptureReadPhase::window_crop;
  require(mapped.pData && mapped.RowPitch >= description.Width * 4U);
  CaptureBitmap result{static_cast<uint32_t>(request.bounds.width), static_cast<uint32_t>(request.bounds.height), std::vector<uint8_t>(static_cast<size_t>(request.bounds.width) * static_cast<size_t>(request.bounds.height) * 4)};
  const auto x = static_cast<size_t>(request.bounds.x - bounds.x), y = static_cast<size_t>(request.bounds.y - bounds.y);
  for (size_t row = 0; row < result.height; ++row) std::memcpy(result.bgra.data() + row * result.width * 4U,
    static_cast<const uint8_t*>(mapped.pData) + (row + y) * mapped.RowPitch + x * 4U, static_cast<size_t>(result.width) * 4U);
  for (size_t index = 0; index < result.bgra.size(); index += 4) {
    // Transparent/partially transparent pixels never expose an uninitialised GPU RGB value.
    if (result.bgra[index + 3] != 255) result.bgra[index] = result.bgra[index + 1] = result.bgra[index + 2] = 0;
    result.bgra[index + 3] = 255;
  }
  phase = CaptureReadPhase::window_current;
  require(current() && Clock::now() < deadline); return result;
}

class BoundedStream final : public IStream {
 public:
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void** result) override {
    if (!result) return E_POINTER; *result = nullptr;
    if (id == __uuidof(IUnknown) || id == __uuidof(ISequentialStream) || id == __uuidof(IStream)) { *result = static_cast<IStream*>(this); AddRef(); return S_OK; }
    return E_NOINTERFACE;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++references_; }
  ULONG STDMETHODCALLTYPE Release() override { const auto count = --references_; if (!count) delete this; return count; }
  HRESULT STDMETHODCALLTYPE Read(void* value, ULONG count, ULONG* read) override {
    if (read) *read = 0; if (!value && count) return STG_E_INVALIDPOINTER;
    std::lock_guard lock(mutex_); const auto bytes = std::min<size_t>(count, data_.size() - std::min(data_.size(), position_));
    if (bytes) std::memcpy(value, data_.data() + position_, bytes); position_ += bytes; if (read) *read = static_cast<ULONG>(bytes); return bytes == count ? S_OK : S_FALSE;
  }
  HRESULT STDMETHODCALLTYPE Write(const void* value, ULONG count, ULONG* written) override {
    if (written) *written = 0; if (!value && count) return STG_E_INVALIDPOINTER;
    std::lock_guard lock(mutex_); if (position_ > kMaxFrameBytes || count > kMaxFrameBytes - position_) return STG_E_MEDIUMFULL;
    try { if (data_.size() < position_ + count) data_.resize(position_ + count); if (count) std::memcpy(data_.data() + position_, value, count); position_ += count; }
    catch (...) { return E_OUTOFMEMORY; }
    if (written) *written = count; return S_OK;
  }
  HRESULT STDMETHODCALLTYPE Seek(LARGE_INTEGER offset, DWORD origin, ULARGE_INTEGER* result) override {
    std::lock_guard lock(mutex_); const auto base = origin == STREAM_SEEK_SET ? int64_t(0) : origin == STREAM_SEEK_CUR ? static_cast<int64_t>(position_) : origin == STREAM_SEEK_END ? static_cast<int64_t>(data_.size()) : int64_t(-1);
    if (base < 0 || offset.QuadPart < -base || offset.QuadPart > static_cast<int64_t>(kMaxFrameBytes) - base) return STG_E_INVALIDFUNCTION;
    position_ = static_cast<size_t>(base + offset.QuadPart); if (result) result->QuadPart = position_; return S_OK;
  }
  HRESULT STDMETHODCALLTYPE SetSize(ULARGE_INTEGER size) override {
    std::lock_guard lock(mutex_); if (size.QuadPart > kMaxFrameBytes) return STG_E_MEDIUMFULL;
    try { data_.resize(static_cast<size_t>(size.QuadPart)); return S_OK; } catch (...) { return E_OUTOFMEMORY; }
  }
  HRESULT STDMETHODCALLTYPE CopyTo(IStream*, ULARGE_INTEGER, ULARGE_INTEGER*, ULARGE_INTEGER*) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE Commit(DWORD) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE Revert() override { return STG_E_REVERTED; }
  HRESULT STDMETHODCALLTYPE LockRegion(ULARGE_INTEGER, ULARGE_INTEGER, DWORD) override { return STG_E_INVALIDFUNCTION; }
  HRESULT STDMETHODCALLTYPE UnlockRegion(ULARGE_INTEGER, ULARGE_INTEGER, DWORD) override { return STG_E_INVALIDFUNCTION; }
  HRESULT STDMETHODCALLTYPE Stat(STATSTG* value, DWORD) override {
    if (!value) return E_POINTER; std::lock_guard lock(mutex_); *value = {}; value->type = STGTY_STREAM; value->grfMode = STGM_READWRITE; value->cbSize.QuadPart = data_.size(); return S_OK;
  }
  HRESULT STDMETHODCALLTYPE Clone(IStream**) override { return E_NOTIMPL; }
  std::vector<uint8_t> bytes() const { std::lock_guard lock(mutex_); return data_; }
 private:
  std::atomic<ULONG> references_{1}; mutable std::mutex mutex_; std::vector<uint8_t> data_; size_t position_ = 0;
};
std::vector<uint8_t> encode_bitmap(const CaptureBitmap& image, std::wstring_view format, uint32_t quality) {
  require(image.valid() && (format == L"jpeg" || format == L"png") && quality >= 1 && quality <= 100);
  winrt::com_ptr<IWICImagingFactory> factory;
  winrt::check_hresult(CoCreateInstance(CLSID_WICImagingFactory2, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(factory.put())));
  winrt::com_ptr<BoundedStream> stream; stream.attach(new BoundedStream);
  winrt::com_ptr<IWICBitmapEncoder> encoder; winrt::check_hresult(factory->CreateEncoder(format == L"png" ? GUID_ContainerFormatPng : GUID_ContainerFormatJpeg, nullptr, encoder.put()));
  winrt::check_hresult(encoder->Initialize(stream.get(), WICBitmapEncoderNoCache));
  winrt::com_ptr<IWICBitmapFrameEncode> frame; winrt::com_ptr<IPropertyBag2> properties;
  winrt::check_hresult(encoder->CreateNewFrame(frame.put(), properties.put()));
  if (format == L"jpeg") { wchar_t name[] = L"ImageQuality"; PROPBAG2 option{}; option.pstrName = name; VARIANT value{}; value.vt = VT_R4; value.fltVal = static_cast<float>(quality) / 100;
    require(properties.get() != nullptr); winrt::check_hresult(properties->Write(1, &option, &value)); }
  winrt::check_hresult(frame->Initialize(properties.get())); winrt::check_hresult(frame->SetSize(image.width, image.height));
  WICPixelFormatGUID pixel_format = format == L"png" ? GUID_WICPixelFormat32bppBGRA : GUID_WICPixelFormat24bppBGR;
  winrt::check_hresult(frame->SetPixelFormat(&pixel_format));
  winrt::com_ptr<IWICBitmap> bitmap; winrt::check_hresult(factory->CreateBitmapFromMemory(image.width, image.height, GUID_WICPixelFormat32bppBGRA, image.width * 4U,
    static_cast<UINT>(image.bgra.size()), const_cast<BYTE*>(image.bgra.data()), bitmap.put()));
  winrt::com_ptr<IWICFormatConverter> converter; winrt::check_hresult(factory->CreateFormatConverter(converter.put()));
  winrt::check_hresult(converter->Initialize(bitmap.get(), pixel_format, WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeCustom));
  winrt::check_hresult(frame->WriteSource(converter.get(), nullptr)); winrt::check_hresult(frame->Commit()); winrt::check_hresult(encoder->Commit());
  auto bytes = stream->bytes(); require(!bytes.empty() && bytes.size() <= kMaxFrameBytes); return bytes;
}
void label_vector(CaptureBitmap& image, const CapturePrivacyPlan& plan, const WindowsRect& bounds, const CaptureFit& fit) {
  require(image.valid());
  CapturePrivacyPlan vectors; for (const auto& mask : plan.masks) if (mask.vector) vectors.masks.push_back(mask);
  const auto masks = capture_pixel_masks(vectors, bounds, fit); if (masks.empty()) return;
  struct DC { HDC value; ~DC() { if (value) DeleteDC(value); } } dc{CreateCompatibleDC(nullptr)}; require(dc.value != nullptr);
  BITMAPINFO info{}; info.bmiHeader.biSize = sizeof(info.bmiHeader); info.bmiHeader.biWidth = static_cast<LONG>(image.width); info.bmiHeader.biHeight = -static_cast<LONG>(image.height);
  info.bmiHeader.biPlanes = 1; info.bmiHeader.biBitCount = 32; info.bmiHeader.biCompression = BI_RGB; void* pixels = nullptr;
  struct Bitmap { HBITMAP value; ~Bitmap() { if (value) DeleteObject(value); } } bitmap{CreateDIBSection(dc.value, &info, DIB_RGB_COLORS, &pixels, nullptr, 0)}; require(bitmap.value && pixels);
  const auto previous = SelectObject(dc.value, bitmap.value); require(previous && previous != HGDI_ERROR);
  struct Restore { HDC dc; HGDIOBJ object; ~Restore() { SelectObject(dc, object); } } restore{dc.value, previous};
  struct Font { HFONT value; ~Font() { if (value) DeleteObject(value); } } font{CreateFontW(-14, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, NONANTIALIASED_QUALITY, DEFAULT_PITCH | FF_SWISS, L"Segoe UI")};
  require(font.value != nullptr); const auto previous_font = SelectObject(dc.value, font.value); require(previous_font && previous_font != HGDI_ERROR);
  Restore restore_font{dc.value, previous_font}; SIZE label{}; require(GetTextExtentPoint32W(dc.value, L"Vector", 6, &label) != FALSE);
  std::memcpy(pixels, image.bgra.data(), image.bgra.size()); SetBkMode(dc.value, TRANSPARENT); SetTextColor(dc.value, RGB(180, 180, 180));
  for (const auto& mask : masks) {
    if (mask.width < label.cx + 4 || mask.height < label.cy + 4) continue;
    const auto saved = SaveDC(dc.value); require(saved != 0);
    struct Saved { HDC dc; int ticket; ~Saved() { RestoreDC(dc, ticket); } } saved_state{dc.value, saved};
    IntersectClipRect(dc.value, static_cast<int>(mask.x), static_cast<int>(mask.y), static_cast<int>(mask.x + mask.width), static_cast<int>(mask.y + mask.height));
    RECT region{static_cast<LONG>(mask.x), static_cast<LONG>(mask.y), static_cast<LONG>(mask.x + mask.width), static_cast<LONG>(mask.y + mask.height)};
    require(DrawTextW(dc.value, L"Vector", 6, &region, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX) > 0);
  }
  require(GdiFlush() != FALSE); std::memcpy(image.bgra.data(), pixels, image.bgra.size());
  for (size_t index = 3; index < image.bgra.size(); index += 4) image.bgra[index] = 255;
}
}

CaptureBackend CaptureBackend::system(WindowsInventoryObserver diagnostic, CaptureReadObserver read_diagnostic) {
  const auto native = std::make_shared<NativeCapture>();
  native->diagnostic = diagnostic;
  CaptureBackend backend; backend.displays = native_displays;
  backend.inventory = [native](const ServerSession& session, const std::function<bool()>& current) { return native->inventory(session, current); };
  backend.current = [native](const CaptureInventory& inventory, const ServerSession& session) { return native->current(inventory, session); };
  backend.read = [read_diagnostic](const CaptureReadRequest& request, const std::function<bool()>& current) {
    auto phase = CaptureReadPhase::surface_before;
    try {
      require_capture_surface(request.window); phase = CaptureReadPhase::context_before; require(current(), L"changed");
      const auto result = request.window && request.isolate_window ? window_bitmap(request, current, phase) : screen_bitmap(request.bounds, phase);
      phase = CaptureReadPhase::surface_after; require_capture_surface(request.window);
      phase = CaptureReadPhase::context_after; require(current(), L"changed"); return result;
    } catch (...) {
      // A best-effort observer cannot replace, suppress or recover the original native failure.
      if (read_diagnostic) try { read_diagnostic(phase); } catch (...) {}
      throw;
    }
  };
  backend.label = label_vector; backend.encode = encode_bitmap;
  // The supported Windows floor has WGC. Feature reads publish implemented operations without a
  // potentially blocking WinRT activation under Dispatcher authority; actual support is checked at read time.
  backend.window_supported = [] { return true; }; backend.available = [] { require_capture_surface(); return true; };
  backend.now = [] { FILETIME time{}; GetSystemTimeAsFileTime(&time); const auto ticks = (uint64_t(time.dwHighDateTime) << 32) | time.dwLowDateTime; require(ticks >= 116'444'736'000'000'000ULL); return (ticks - 116'444'736'000'000'000ULL) / 10'000; };
  backend.identifier = [] {
    GUID value{}; winrt::check_hresult(CoCreateGuid(&value)); wchar_t text[40]{}; require(StringFromGUID2(value, text, 40) > 0);
    std::wstring result = L"cap_"; for (const auto character : std::wstring_view(text)) if (character != L'{' && character != L'}') result.push_back(character >= L'A' && character <= L'F' ? static_cast<wchar_t>(character + L'a' - L'A') : character); return result;
  };
  return backend;
}
}
