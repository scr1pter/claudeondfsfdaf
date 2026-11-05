#include "capture.h"
#include <algorithm>
#include <array>
#include <climits>
#include <cmath>
#include <limits>
#include <set>
#include <utility>

namespace vector::computer {
namespace {
[[noreturn]] void fail(std::wstring code = L"stale_frame", std::wstring message = L"The native capture changed. Take a new screenshot.") { throw Failure{std::move(code), std::move(message)}; }
void require(bool value, std::wstring code = L"stale_frame") { if (!value) fail(std::move(code)); }
IJsonValue field(const JsonObject& value, std::wstring_view key) { const winrt::hstring name(key); return value.HasKey(name) ? value.Lookup(name) : nullptr; }
bool keys(const JsonObject& value, std::initializer_list<std::wstring_view> names) {
  for (const auto& pair : value) if (std::find(names.begin(), names.end(), std::wstring_view(pair.Key())) == names.end()) return false;
  return true;
}
std::optional<std::wstring> string(const IJsonValue& value, size_t maximum = 256) {
  if (!value || value.ValueType() != JsonValueType::String) return {};
  const auto text = value.GetString(); if (text.empty() || text.size() > maximum) return {};
  if (std::any_of(text.begin(), text.end(), [](wchar_t character) { return character < 32 || character == 127; })) return {};
  return std::wstring(text.c_str(), text.size());
}
bool phase(const CaptureReceipt& receipt, const ServerSession& session) {
  return receipt.session_id == session.id && receipt.run_epoch == session.run_epoch && receipt.observation_epoch == session.observation_epoch && receipt.revision == session.revision;
}
bool overlap(const WindowsRect& a, const WindowsRect& b) { return a.valid() && b.valid() && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height; }
bool same_surface(const CaptureSurface& a, const CaptureSurface& b) {
  return a.hwnd == b.hwnd && a.pid == b.pid && a.thread == b.thread && a.bounds == b.bounds && a.frame_bounds == b.frame_bounds &&
    a.frame_known == b.frame_known &&
    a.visible == b.visible && a.minimized == b.minimized && a.cloaked == b.cloaked && a.opaque == b.opaque && a.affinity_known == b.affinity_known &&
    (!a.affinity_known || a.affinity == b.affinity) && a.extended_style == b.extended_style && a.window_class == b.window_class &&
    a.window.has_value() == b.window.has_value() && (!a.window || same_windows_window(*a.window, *b.window));
}
std::wstring owner_key(const WindowsOwner& owner) { return std::to_wstring(owner.process.pid) + L":" + std::to_wstring(owner.process.creation_time); }
bool has_id(const JsonArray& values, HWND window) {
  for (const auto& value : values) if (const auto id = string(value); id && parse_window_id(*id) == window) return true;
  return false;
}
bool has_pid(const JsonArray& values, DWORD pid) { for (const auto& value : values) if (safe_integer(value) == pid) return true; return false; }
CapturePrivacyPlan privacy(const CaptureInventory& inventory, const WindowsRect& bounds, const ServerSession& session) {
  const WindowsSessionPolicy policy(session);
  std::vector<CapturePrivacyWindow> windows;
  for (const auto& surface : inventory.windows) {
    const auto empty = surface.bounds.width == 0 || surface.bounds.height == 0;
    CapturePrivacyWindow value; value.id = window_id(surface.hwnd); value.bounds = empty ? surface.frame_bounds : surface.bounds;
    value.visible = surface.visible && !surface.minimized && !surface.cloaked && value.bounds.valid();
    value.opaque = !empty && surface.opaque; value.overlay = !empty && surface.excluded_overlay;
    value.vector = surface.pid == GetCurrentProcessId() || has_pid(session.vector_pids, surface.pid) || has_id(session.vector_window_ids, surface.hwnd);
    value.owner_key = L"native-pid:" + std::to_wstring(surface.pid);
    if (!empty && surface.window) {
      require(surface.window->hwnd == surface.hwnd && surface.window->physical_owner.process.pid == surface.pid);
      const auto role = windows_surface_role(*surface.window);
      value.include = !value.vector && policy.include_in_display(*surface.window);
      value.regular = role != WindowsSurfaceRole::furniture && role != WindowsSurfaceRole::notification;
      value.notification = role == WindowsSurfaceRole::notification;
      value.owner_key = owner_key(surface.window->owner);
    } else {
      value.include = false;
      // A structural toast class is always masked, even when its owner cannot be queried.
      value.notification = surface.window_class == L"ToastChildWindowClass" || surface.window_class == L"ToastWindowClass";
      value.regular = !value.notification;
    }
    windows.push_back(std::move(value));
  }
  return plan_capture_privacy(windows, bounds);
}
struct Arguments {
  std::optional<std::wstring> display;
  std::optional<HWND> window;
  CaptureBudget budget;
  std::wstring format;
  uint32_t quality = 80;
  std::optional<std::wstring> zoom;
  std::array<int64_t, 4> region{};
};
Arguments decode(const JsonObject& args) {
  require(keys(args, {L"target", L"budget", L"format", L"quality", L"zoom"}), L"failed");
  const auto target = field(args, L"target"), budget = field(args, L"budget");
  require(target && target.ValueType() == JsonValueType::Object && budget && budget.ValueType() == JsonValueType::Object, L"failed");
  require(target.GetObject().Size() == 1 && keys(target.GetObject(), {L"display", L"windowId"}) && budget.GetObject().Size() == 3 && keys(budget.GetObject(), {L"maxWidth", L"maxHeight", L"maxPixels"}), L"failed");
  Arguments result; result.display = string(field(target.GetObject(), L"display"));
  if (const auto id = string(field(target.GetObject(), L"windowId"))) result.window = parse_window_id(*id);
  require(result.display.has_value() != result.window.has_value(), L"failed");
  const auto width = safe_integer(field(budget.GetObject(), L"maxWidth")), height = safe_integer(field(budget.GetObject(), L"maxHeight")), pixels = safe_integer(field(budget.GetObject(), L"maxPixels"));
  require(width && *width > 0 && *width <= 16'384 && height && *height > 0 && *height <= 16'384 && pixels && *pixels > 0 && *pixels <= 16'384ULL * 16'384, L"failed");
  result.budget = {static_cast<uint32_t>(*width), static_cast<uint32_t>(*height), *pixels};
  const auto format = string(field(args, L"format")); require(format && (*format == L"jpeg" || *format == L"png"), L"failed"); result.format = *format;
  if (const auto quality = field(args, L"quality")) { const auto value = safe_integer(quality); require(value && *value >= 1 && *value <= 100, L"failed"); result.quality = static_cast<uint32_t>(*value); }
  if (const auto zoom = field(args, L"zoom")) {
    require(zoom.ValueType() == JsonValueType::Object && zoom.GetObject().Size() == 2 && keys(zoom.GetObject(), {L"captureId", L"region"}), L"failed");
    result.zoom = string(field(zoom.GetObject(), L"captureId")); const auto region = field(zoom.GetObject(), L"region");
    require(result.zoom && region && region.ValueType() == JsonValueType::Object && region.GetObject().Size() == 4 && keys(region.GetObject(), {L"x0", L"y0", L"x1", L"y1"}), L"failed");
    size_t index = 0; for (const auto key : {L"x0", L"y0", L"x1", L"y1"}) { const auto value = signed_integer(field(region.GetObject(), key)); require(value.has_value(), L"failed"); result.region[index++] = *value; }
    result.format = L"png";
  }
  return result;
}
WindowsRect zoom_bounds(const CaptureReceipt& source, const std::array<int64_t, 4>& region) {
  require(!source.zoom_source && region[0] >= 0 && region[1] >= 0 && region[0] < region[2] && region[1] < region[3] && region[2] <= source.width && region[3] <= source.height, L"out_of_bounds");
  // Physical pixels are discrete. Trim only subpixel edge slivers inside the requested full-frame region.
  const auto x0 = std::ceil(double(source.bounds.x) + double(region[0]) / source.image_scale), y0 = std::ceil(double(source.bounds.y) + double(region[1]) / source.image_scale);
  const auto x1 = std::floor(double(source.bounds.x) + double(region[2]) / source.image_scale), y1 = std::floor(double(source.bounds.y) + double(region[3]) / source.image_scale);
  require(std::isfinite(x0) && std::isfinite(y0) && std::isfinite(x1) && std::isfinite(y1) && x0 >= double(source.bounds.x) && y0 >= double(source.bounds.y) &&
    x1 <= double(source.bounds.x + source.bounds.width) && y1 <= double(source.bounds.y + source.bounds.height), L"out_of_bounds");
  WindowsRect result{static_cast<int64_t>(x0), static_cast<int64_t>(y0), static_cast<int64_t>(x1 - x0), static_cast<int64_t>(y1 - y0)};
  require(result.valid() && source.bounds.contains(result), L"out_of_bounds"); return result;
}
bool all_black(const CaptureBitmap& image) {
  for (size_t index = 0; index < image.bgra.size(); index += 4) if (image.bgra[index] || image.bgra[index + 1] || image.bgra[index + 2]) return false;
  return true;
}
std::optional<std::pair<size_t, size_t>> receipt_cost(const CaptureReceipt& receipt) {
  constexpr size_t bytes_limit = 8 * 1024 * 1024, witness_limit = 4096;
  if (receipt.inventory.windows.size() > witness_limit || receipt.inventory.displays.size() > 64) return {};
  size_t bytes = sizeof(CaptureReceipt), witnesses = receipt.inventory.windows.size(); bool valid = witnesses <= witness_limit;
  const auto add = [&](size_t value) { if (value > bytes_limit || bytes > bytes_limit - value) valid = false; else bytes += value; };
  const auto string_cost = [&](const std::wstring& value, size_t copies = 1) {
    if (value.capacity() > bytes_limit / sizeof(wchar_t) / copies) valid = false; else add(value.capacity() * sizeof(wchar_t) * copies);
  };
  const auto owner = [&](const WindowsOwner& value) {
    // Include copied witnesses and a conservative allowance for their opaque retained process/file lease states.
    ++witnesses; add(sizeof(WindowsOwner) * 4 + sizeof(WindowsStaticIdentity) * 2);
    for (const auto* text : {&value.identity.aumid, &value.identity.publisher, &value.identity.product, &value.identity.binary, &value.identity.name, &value.identity.exe, &value.process.image.path}) string_cost(*text, 6);
    for (const auto* data : {&value.process.image.signer_subject, &value.process.token.user, &value.process.token.logon}) {
      if (data->capacity() > bytes_limit / 6) valid = false; else add(data->capacity() * 6);
    }
    if (value.process.package) for (const auto* text : {&value.process.package->aumid, &value.process.package->family, &value.process.package->full_name, &value.process.package->path}) string_cost(*text, 6);
  };
  const auto window = [&](const WindowsWindow& value) { owner(value.owner); owner(value.physical_owner); string_cost(value.window_class); if (value.host_aumid) string_cost(*value.host_aumid); };
  for (const auto* text : {&receipt.id, &receipt.display_id, &receipt.session_id}) string_cost(*text);
  if (receipt.zoom_source) string_cost(*receipt.zoom_source);
  if (receipt.inventory.windows.capacity() > bytes_limit / sizeof(CaptureSurface) || receipt.inventory.displays.capacity() > bytes_limit / sizeof(CaptureDisplay)) valid = false;
  else { add(receipt.inventory.windows.capacity() * sizeof(CaptureSurface)); add(receipt.inventory.displays.capacity() * sizeof(CaptureDisplay)); }
  for (const auto& display : receipt.inventory.displays) string_cost(display.id);
  for (const auto& surface : receipt.inventory.windows) { string_cost(surface.window_class); if (surface.window) window(*surface.window); }
  if (receipt.window) window(*receipt.window);
  if (!valid || witnesses > witness_limit) return {}; return std::pair{bytes, witnesses};
}
}

bool capture_surface_geometry(const CaptureSurface& surface) noexcept {
  if (surface.bounds.valid()) return true;
  const auto canonical = [](const WindowsRect& value) {
    constexpr auto bound = WindowsRect::bound;
    return value.x >= -bound && value.y >= -bound && value.width >= 0 && value.height >= 0 &&
      value.width <= bound && value.height <= bound && value.x <= bound - value.width && value.y <= bound - value.height;
  };
  return canonical(surface.bounds) && (surface.bounds.width == 0 || surface.bounds.height == 0) &&
    surface.frame_known && canonical(surface.frame_bounds);
}
bool same_capture_inventory(const CaptureInventory& a, const CaptureInventory& b) noexcept {
  if (a.displays.size() != b.displays.size()) return false;
  for (size_t index = 0; index < a.displays.size(); ++index) {
    const auto& x = a.displays[index]; const auto& y = b.displays[index];
    if (x.monitor != y.monitor || x.id != y.id || x.bounds != y.bounds || x.dpi_scale != y.dpi_scale || x.primary != y.primary) return false;
  }
  size_t left = 0, right = 0;
  for (;;) {
    while (left < a.windows.size() && a.windows[left].excluded_overlay && a.windows[left].bounds.valid()) ++left;
    while (right < b.windows.size() && b.windows[right].excluded_overlay && b.windows[right].bounds.valid()) ++right;
    if (left == a.windows.size() || right == b.windows.size()) return left == a.windows.size() && right == b.windows.size();
    if (!same_surface(a.windows[left++], b.windows[right++])) return false;
  }
}
POINT CaptureReceipt::point(int64_t x, int64_t y) const {
  require(!zoom_source, L"stale_frame"); require(x >= 0 && y >= 0 && x < width && y < height && bounds.valid() && std::isfinite(image_scale) && image_scale > 0, L"out_of_bounds");
  const auto px = double(bounds.x) + (double(x) + 0.5) / image_scale, py = double(bounds.y) + (double(y) + 0.5) / image_scale;
  require(std::isfinite(px) && std::isfinite(py) && px >= double(bounds.x) && py >= double(bounds.y) && px < double(bounds.x + bounds.width) && py < double(bounds.y + bounds.height) &&
    px >= LONG_MIN && px <= LONG_MAX && py >= LONG_MIN && py <= LONG_MAX, L"out_of_bounds");
  return {static_cast<LONG>(std::floor(px)), static_cast<LONG>(std::floor(py))};
}
void CaptureRegistry::invalidate() noexcept { std::lock_guard lock(mutex_); receipts_.clear(); retained_bytes_ = retained_witnesses_ = 0; if (generation_ == UINT64_MAX) closed_ = true; else ++generation_; }
void CaptureRegistry::close() noexcept { std::lock_guard lock(mutex_); closed_ = true; receipts_.clear(); retained_bytes_ = retained_witnesses_ = 0; }
uint64_t CaptureRegistry::generation() const noexcept { std::lock_guard lock(mutex_); return generation_; }
bool CaptureRegistry::put(CaptureReceipt receipt, uint64_t expected) {
  std::lock_guard lock(mutex_);
  const auto cost = receipt_cost(receipt);
  if (closed_ || generation_ != expected || receipt.generation != expected || receipt.id.empty() || receipt.id.size() > 256 || receipt.session_id.empty() || receipt.run_epoch == 0 || receipt.observation_epoch == 0 ||
      receipt.width == 0 || receipt.height == 0 || receipt.width > 16'384 || receipt.height > 16'384 || uint64_t(receipt.width) * receipt.height > 64ULL * 1024 * 1024 ||
      !receipt.bounds.valid() || !std::isfinite(receipt.image_scale) || receipt.image_scale <= 0 || receipt.image_scale > 1 || !std::isfinite(receipt.dpi_scale) || receipt.dpi_scale <= 0 || receipt.dpi_scale > 16 ||
      std::floor(double(receipt.bounds.width) * receipt.image_scale) != receipt.width || std::floor(double(receipt.bounds.height) * receipt.image_scale) != receipt.height ||
      !cost || std::any_of(receipts_.begin(), receipts_.end(), [&](const auto& value) { return value.receipt.id == receipt.id; })) return false;
  while (!receipts_.empty() && (receipts_.size() >= 32 || cost->first > 8 * 1024 * 1024 - retained_bytes_ || cost->second > 4096 - retained_witnesses_)) {
    retained_bytes_ -= receipts_.front().bytes; retained_witnesses_ -= receipts_.front().witnesses; receipts_.pop_front();
  }
  receipts_.push_back({std::move(receipt), cost->first, cost->second}); retained_bytes_ += cost->first; retained_witnesses_ += cost->second; return true;
}
CaptureReceipt CaptureRegistry::get(std::wstring_view id, const ServerSession& session, bool allow_zoom) const {
  std::lock_guard lock(mutex_);
  const auto found = std::find_if(receipts_.begin(), receipts_.end(), [&](const auto& value) { return value.receipt.id == id; });
  require(!closed_ && found != receipts_.end() && found->receipt.generation == generation_ && phase(found->receipt, session) && (allow_zoom || !found->receipt.zoom_source)); return found->receipt;
}
CaptureService::CaptureService(CaptureBackend backend) : backend_(std::move(backend)) {}
JsonObject CaptureService::features() const {
  const bool implemented = backend_.displays && backend_.inventory && backend_.current && backend_.read && backend_.encode && backend_.available && backend_.now && backend_.identifier;
  JsonObject result; result.Insert(L"capture.display", JsonValue::CreateBooleanValue(implemented)); result.Insert(L"capture.window", JsonValue::CreateBooleanValue(implemented && backend_.window_supported && backend_.window_supported()));
  result.Insert(L"capture.exclude", JsonValue::CreateBooleanValue(implemented)); result.Insert(L"capture.zoom", JsonValue::CreateBooleanValue(implemented)); return result;
}
void CaptureService::displays(const JsonObject& args, const OperationContext& context, Dispatcher::Completion done) {
  try {
    require(args.Size() == 0, L"failed"); require(context.is_current(), L"changed");
    JsonArray items;
    for (const auto& display : backend_.displays()) {
      require(display.bounds.valid() && !display.id.empty() && std::isfinite(display.dpi_scale) && display.dpi_scale > 0, L"capture_unavailable");
      JsonObject size; size.Insert(L"w", JsonValue::CreateNumberValue(static_cast<double>(display.bounds.width))); size.Insert(L"h", JsonValue::CreateNumberValue(static_cast<double>(display.bounds.height)));
      JsonObject value; value.Insert(L"id", JsonValue::CreateStringValue(display.id)); value.Insert(L"bounds", display.bounds.wire()); value.Insert(L"pixelSize", size); value.Insert(L"scale", JsonValue::CreateNumberValue(1)); value.Insert(L"dpiScale", JsonValue::CreateNumberValue(display.dpi_scale)); value.Insert(L"primary", JsonValue::CreateBooleanValue(display.primary)); items.Append(value);
    }
    require(context.is_current(), L"changed"); JsonObject result; result.Insert(L"displays", items); done(Reply{result, {}});
  } catch (const Failure& failure) { done(failure); } catch (...) { done(Failure{L"capture_unavailable", L"Native displays are unavailable."}); }
}
CaptureReceipt CaptureService::receipt(std::wstring_view id, const ServerSession& session, bool allow_zoom) const {
  const auto value = registry_.get(id, session, allow_zoom); require(backend_.available() && backend_.current(value.inventory, session)); return value;
}
bool CaptureService::current(const CaptureReceipt& value, const ServerSession& session) const {
  try {
    const auto stored = registry_.get(value.id, session);
    return value.generation == stored.generation && phase(value, session) && value.bounds == stored.bounds && value.width == stored.width && value.height == stored.height &&
      value.image_scale == stored.image_scale && value.dpi_scale == stored.dpi_scale && value.display_id == stored.display_id && !value.zoom_source &&
      same_capture_inventory(value.inventory, stored.inventory) && value.window.has_value() == stored.window.has_value() &&
      (!value.window || same_windows_window(*value.window, *stored.window)) && backend_.available() && backend_.current(stored.inventory, session);
  } catch (...) { return false; }
}
void CaptureService::invalidate() noexcept { registry_.invalidate(); }
void CaptureService::close() noexcept { registry_.close(); }

void CaptureService::capture(const JsonObject& input, const OperationContext& context, Dispatcher::Completion done) {
  try {
    require(context.session.has_value(), L"unavailable"); const auto& session = *context.session;
    require(context.is_current() && backend_.available(), L"unavailable");
    const auto args = decode(input); const auto generation = registry_.generation();
    if (args.window) require(backend_.window_supported && backend_.window_supported(), L"unsupported_action");
    const auto inventory = backend_.inventory(session, context.is_current); require(context.is_current(), L"changed");
    require(!inventory.displays.empty() && inventory.displays.size() <= 64 && inventory.windows.size() <= 4096, L"capture_unavailable");
    for (const auto& surface : inventory.windows) require(capture_surface_geometry(surface), L"capture_unavailable");
    std::set<std::wstring> display_ids;
    for (const auto& value : inventory.displays) require(value.bounds.valid() && !value.id.empty() && value.id.size() <= 256 && std::isfinite(value.dpi_scale) && value.dpi_scale > 0 && value.dpi_scale <= 16 && display_ids.insert(value.id).second, L"capture_unavailable");
    const CaptureSurface* target = nullptr;
    if (args.window) { const auto found = std::find_if(inventory.windows.begin(), inventory.windows.end(), [&](const auto& value) { return value.hwnd == *args.window; }); require(found != inventory.windows.end() && found->bounds.valid() && found->window.has_value(), L"capture_unavailable"); target = &*found; }
    const CaptureDisplay* display = nullptr;
    if (args.display) {
      const auto found = std::find_if(inventory.displays.begin(), inventory.displays.end(), [&](const auto& value) { return value.id == *args.display; }); require(found != inventory.displays.end(), L"capture_unavailable"); display = &*found;
    } else {
      int64_t greatest_area = -1; double nearest = std::numeric_limits<double>::infinity();
      for (const auto& candidate : inventory.displays) {
        const auto width = std::max<int64_t>(0, std::min(candidate.bounds.x + candidate.bounds.width, target->bounds.x + target->bounds.width) - std::max(candidate.bounds.x, target->bounds.x));
        const auto height = std::max<int64_t>(0, std::min(candidate.bounds.y + candidate.bounds.height, target->bounds.y + target->bounds.height) - std::max(candidate.bounds.y, target->bounds.y));
        const auto area = width * height;
        const auto distance = std::hypot(double(candidate.bounds.x + candidate.bounds.width / 2 - target->bounds.x - target->bounds.width / 2), double(candidate.bounds.y + candidate.bounds.height / 2 - target->bounds.y - target->bounds.height / 2));
        if (area > greatest_area || (area == greatest_area && distance < nearest)) { display = &candidate; greatest_area = area; nearest = distance; }
      }
      require(display != nullptr, L"capture_unavailable");
    }
    std::optional<WindowsWindow> window;
    if (target) {
      window = target->window; WindowsSessionPolicy(session).require(*window, WindowsPolicyOperation::capture);
      if (target->minimized) { require(context.is_current(), L"changed"); JsonObject paused; paused.Insert(L"paused", JsonValue::CreateBooleanValue(true)); done(Reply{paused, {}}); return; }
      require(target->frame_bounds.valid(), L"capture_unavailable");
      require(!target->affinity_known || target->affinity == WDA_NONE, L"blocked_by_os");
    }
    WindowsRect bounds = target ? target->frame_bounds : display->bounds;
    bool occluded = false;
    if (target) {
      occluded = !std::any_of(inventory.displays.begin(), inventory.displays.end(), [&](const auto& value) { return value.bounds.contains(bounds); });
      for (const auto& value : inventory.windows) {
        if (value.hwnd == target->hwnd) break;
        const auto& covering = value.bounds.valid() ? value.bounds : value.frame_bounds;
        if (value.visible && !value.minimized && !value.cloaked && !(value.excluded_overlay && value.bounds.valid()) && overlap(covering, bounds)) occluded = true;
      }
    }
    if (args.zoom) {
      const auto source = registry_.get(*args.zoom, session);
      require(source.display_id == display->id && source.window.has_value() == window.has_value() && (!window || same_windows_window(*source.window, *window)) && same_capture_inventory(source.inventory, inventory));
      bounds = zoom_bounds(source, args.region);
    }
    const auto fit = fit_capture(bounds, args.budget);
    const auto plan = window && occluded ? CapturePrivacyPlan{} : privacy(inventory, bounds, session);
    auto native = backend_.read({bounds, window, occluded}, context.is_current);
    const auto captured_at = backend_.now();
    require(captured_at <= kMaximumSafeInteger, L"capture_unavailable");
    require(native.valid() && native.width == bounds.width && native.height == bounds.height && !all_black(native), L"capture_unavailable");
    require(context.is_current() && backend_.available(), L"changed");
    const auto fresh = backend_.inventory(session, context.is_current); require(same_capture_inventory(inventory, fresh) && context.is_current(), L"stale_frame");
    auto image = resize_capture(native, fit); native = {};
    paint_capture_masks(image, plan, bounds, fit);
    if (backend_.label) backend_.label(image, plan, bounds, fit);
    const auto hash = hash_capture(image); const auto encoded = backend_.encode(image, args.format, args.quality);
    require(!encoded.empty() && encoded.size() <= kMaxFrameBytes, L"capture_unavailable");
    constexpr std::array<uint8_t, 8> png{137, 80, 78, 71, 13, 10, 26, 10};
    require(args.format == L"png" ? encoded.size() >= png.size() && std::equal(png.begin(), png.end(), encoded.begin()) : encoded.size() >= 3 && encoded[0] == 255 && encoded[1] == 216 && encoded[2] == 255, L"capture_unavailable");
    CaptureReceipt record; record.id = backend_.identifier(); record.display_id = display->id; record.session_id = session.id;
    record.run_epoch = session.run_epoch; record.observation_epoch = session.observation_epoch; record.revision = session.revision; record.generation = generation;
    record.bounds = bounds; record.width = fit.width; record.height = fit.height; record.image_scale = fit.scale; record.dpi_scale = display->dpi_scale; record.window = window; record.inventory = inventory; record.zoom_source = args.zoom;
    JsonObject origin; origin.Insert(L"x", JsonValue::CreateNumberValue(static_cast<double>(bounds.x))); origin.Insert(L"y", JsonValue::CreateNumberValue(static_cast<double>(bounds.y)));
    JsonArray masks; for (const auto& mask : capture_pixel_masks(plan, bounds, fit)) masks.Append(mask.wire());
    JsonObject header; header.Insert(L"captureId", JsonValue::CreateStringValue(record.id)); header.Insert(L"width", JsonValue::CreateNumberValue(fit.width)); header.Insert(L"height", JsonValue::CreateNumberValue(fit.height));
    header.Insert(L"origin", origin); header.Insert(L"imageScale", JsonValue::CreateNumberValue(fit.scale)); header.Insert(L"dpiScale", JsonValue::CreateNumberValue(display->dpi_scale));
    header.Insert(L"displayId", JsonValue::CreateStringValue(display->id)); header.Insert(L"capturedAtMs", JsonValue::CreateNumberValue(static_cast<double>(captured_at))); header.Insert(L"masked", masks);
    header.Insert(L"hiddenCount", JsonValue::CreateNumberValue(static_cast<double>(plan.hidden_count))); header.Insert(L"hash", JsonValue::CreateStringValue(winrt::to_hstring(hash))); header.Insert(L"imageBytes", JsonValue::CreateNumberValue(static_cast<double>(encoded.size())));
    require(context.with_current([&] {
      require(backend_.available() && backend_.current(inventory, session) && context.is_current(), L"changed");
      if (window) WindowsSessionPolicy(session).require(*window, WindowsPolicyOperation::capture);
      require(registry_.put(std::move(record), generation), L"stale_frame");
    }), L"changed");
    done(Reply{header, encoded});
  } catch (const Failure& failure) { done(failure); } catch (...) { done(Failure{L"capture_unavailable", L"The native capture could not be completed."}); }
}
}
