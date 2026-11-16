#include "capture.h"
#include "capture_worker_protocol.h"
#include "availability.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <stdexcept>

namespace vector::computer {
namespace {
void check(bool value, const char* label) { if (!value) throw std::runtime_error(label); }
template<class Work> void rejects(Work work, std::wstring_view code, const char* label) {
  try { work(); } catch (const Failure& failure) { check(failure.code == code, label); return; }
  throw std::runtime_error(label);
}
WindowsWindow ordinary_window() {
  WindowsOwner owner;
  owner.identity.publisher = L"Sample Publisher"; owner.identity.binary = L"writer.exe"; owner.identity.name = L"Writer"; owner.identity.exe = L"C:\\Apps\\writer.exe";
  owner.identity.verified = true; owner.identity.pid = 4243;
  owner.process.pid = 4243; owner.process.creation_time = 10; owner.process.image.path = owner.identity.exe;
  owner.process.image.signature = SignatureState::valid; owner.process.image.signer_subject = {1, 2, 3}; owner.process.image.sha256[0] = 1;
  owner.process.image.id[0] = 1; owner.process.image.created = 1; owner.process.image.modified = 2; owner.process.image.size = 100;
  owner.process.token.user = {1}; owner.process.token.logon = {2}; owner.process.token.authentication = 3;
  owner.process.token.integrity = SECURITY_MANDATORY_MEDIUM_RID; owner.process.token.elevated = owner.process.token.ui_access = owner.process.token.app_container = false;
  WindowsWindow window; window.hwnd = reinterpret_cast<HWND>(uintptr_t(10)); window.surface = window.hwnd; window.thread_id = window.surface_thread_id = 50;
  window.owner = owner; window.physical_owner = owner; window.bounds = window.surface_bounds = {-6, -3, 6, 4}; window.window_class = L"WriterWindow"; window.child_shell = false;
  window.visible = window.on_screen = window.current_desktop = true; window.minimized = window.cloaked = window.elevated = false; return window;
}
CaptureSurface surface(const WindowsWindow& window) {
  CaptureSurface value; value.hwnd = window.hwnd; value.pid = window.physical_owner.process.pid; value.thread = window.thread_id;
  value.bounds = value.frame_bounds = window.bounds; value.window_class = window.window_class; value.window = window;
  value.visible = true; value.cloaked = false; value.affinity_known = true; return value;
}
CaptureSurface empty_surface() {
  CaptureSurface value; value.hwnd = reinterpret_cast<HWND>(uintptr_t(99)); value.pid = 9001; value.thread = 99;
  value.bounds = {-7, -3, 0, 0}; value.frame_bounds = value.bounds; value.frame_known = true;
  value.visible = true; value.cloaked = false; value.window_class = L"EmptyVisibleWindow"; return value;
}
struct Fixture {
  ServerSession session;
  CaptureInventory world;
  bool alive = true, available = true, metadata_current = true, black = false, bad_encoding = false;
  unsigned ids = 0, reads = 0, encodes = 0, labels = 0;
  std::vector<CaptureReadRequest> requests;
  CaptureBitmap encoded;
  std::wstring format;
  std::function<void()> during_read, during_encode;
  std::optional<WindowsAvailabilityObservation> availability;
  std::unique_ptr<CaptureService> service;
  Fixture() {
    session.id = L"capture-test"; session.run_epoch = 1; session.observation_epoch = 2; session.revision = 1;
    session.approved.Append(ordinary_window().owner.identity.wire());
    world.displays.push_back({reinterpret_cast<HMONITOR>(uintptr_t(1)), L"D1", {-8, -4, 16, 8}, 1.5, true});
    world.windows.push_back(surface(ordinary_window()));
    CaptureBackend backend;
    backend.displays = [this] { return world.displays; };
    backend.inventory = [this](const auto&, const auto&) { return world; };
    backend.current = [this](const auto& expected, const auto&) { return metadata_current && same_capture_inventory(expected, world); };
    backend.available = [this] { if (availability) require_windows_capture(*availability); return available; }; backend.window_supported = [] { return true; };
    backend.read = [this](const CaptureReadRequest& request, const auto&) {
      ++reads; requests.push_back(request); if (during_read) during_read();
      CaptureBitmap result{static_cast<uint32_t>(request.bounds.width), static_cast<uint32_t>(request.bounds.height), std::vector<uint8_t>(static_cast<size_t>(request.bounds.width * request.bounds.height) * 4, 0)};
      for (size_t index = 0; index < result.bgra.size(); index += 4) { result.bgra[index] = black ? 0 : 40; result.bgra[index + 1] = black ? 0 : 80; result.bgra[index + 2] = black ? 0 : 120; result.bgra[index + 3] = 255; }
      return result;
    };
    backend.label = [this](auto&, const auto&, const auto&, const auto&) { ++labels; };
    backend.encode = [this](const CaptureBitmap& image, std::wstring_view kind, uint32_t) {
      ++encodes; encoded = image; format = kind; if (during_encode) during_encode();
      if (bad_encoding) return std::vector<uint8_t>{1, 2, 3};
      return kind == L"png" ? std::vector<uint8_t>{137, 80, 78, 71, 13, 10, 26, 10, 1} : std::vector<uint8_t>{255, 216, 255, 1};
    };
    backend.now = [] { return uint64_t(1000); }; backend.identifier = [this] { return L"capture-" + std::to_wstring(++ids); };
    service = std::make_unique<CaptureService>(std::move(backend));
  }
  OperationContext context() {
    const auto epoch = session.observation_epoch, run = session.run_epoch;
    OperationContext value; value.session = session;
    value.is_current = [this, epoch, run] { return alive && epoch == session.observation_epoch && run == session.run_epoch; };
    value.with_current = [current = value.is_current](const auto& action) { if (!current()) return false; action(); return true; }; return value;
  }
  JsonObject args(bool window = false) {
    return JsonObject::Parse(window ? LR"({"target":{"windowId":"10"},"budget":{"maxWidth":8,"maxHeight":8,"maxPixels":64},"format":"png"})" :
      LR"({"target":{"display":"D1"},"budget":{"maxWidth":8,"maxHeight":8,"maxPixels":64},"format":"png"})");
  }
  Dispatcher::Result take(const JsonObject& args) {
    std::optional<Dispatcher::Result> result; unsigned calls = 0;
    service->capture(args, context(), [&](auto value) { result = std::move(value); ++calls; });
    check(result.has_value() && calls == 1, "capture.single-completion"); return std::move(*result);
  }
};
std::string failure_code(std::wstring_view code) {
  constexpr std::array<std::wstring_view, 15> fixed{L"changed", L"unavailable", L"capture_unavailable", L"secure_desktop", L"elevated", L"protected", L"not_granted", L"failed", L"stale_frame", L"out_of_bounds", L"unsupported_action", L"stopped", L"paused", L"blocked_by_os", L"blocked"};
  if (std::find(fixed.begin(), fixed.end(), code) == fixed.end()) return "unknown";
  std::string result; for (const auto character : code) result.push_back(character == L'_' ? '-' : static_cast<char>(character)); return result;
}
const Reply& success(const Dispatcher::Result& result) {
  if (const auto refused = std::get_if<Failure>(&result)) throw std::runtime_error("capture.expected-image-success." + failure_code(refused->code));
  return std::get<Reply>(result);
}
void failure(const Dispatcher::Result& result, std::wstring_view code) {
  const auto refused = std::get_if<Failure>(&result);
  if (!refused) throw std::runtime_error("capture.expected-safe-failure.got-success");
  if (refused->code != code) throw std::runtime_error("capture.expected-" + failure_code(code) + ".got-" + failure_code(refused->code));
}
CaptureReceipt receipt(std::wstring id, uint64_t generation, const ServerSession& session) {
  CaptureReceipt result; result.id = std::move(id); result.generation = generation; result.session_id = session.id; result.run_epoch = session.run_epoch;
  result.observation_epoch = session.observation_epoch; result.revision = session.revision; result.display_id = L"D1"; result.bounds = {-8, -4, 8, 8}; result.width = result.height = 8; result.image_scale = 1; result.dpi_scale = 1.5; return result;
}
}

size_t run_capture_tests() {
  size_t groups = 0; const auto test = [&](const auto& work) {
    try { work(); }
    catch (const std::exception& error) {
      const std::string_view detail(error.what());
      const bool fixed = detail.starts_with("capture.") && detail.size() <= 112 &&
        std::all_of(detail.begin(), detail.end(), [](char value) { return (value >= 'a' && value <= 'z') || (value >= '0' && value <= '9') || value == '.' || value == '-'; });
      throw std::runtime_error("capture.group-" + std::to_string(groups + 1) + "." + (fixed ? std::string(detail.substr(8)) : "unexpected"));
    }
    catch (...) { throw std::runtime_error("capture.group-" + std::to_string(groups + 1) + ".unexpected"); }
    ++groups;
  };
  test([] { check(run_capture_worker_tests() > 0, "capture.worker-tests-registered"); });
  test([] {
    struct Case { int64_t setup, rpc; CaptureReadPhase expected, cancelled; };
    constexpr std::array cases{
      Case{0, 0, CaptureReadPhase::window_item_full_expired_setup_lt25_rpc_lt25, CaptureReadPhase::window_item_full_cancelled_setup_lt25_rpc_lt25},
      Case{24, 24, CaptureReadPhase::window_item_full_expired_setup_lt25_rpc_lt25, CaptureReadPhase::window_item_full_cancelled_setup_lt25_rpc_lt25},
      Case{24, 25, CaptureReadPhase::window_item_full_expired_setup_lt25_rpc_from25to49, CaptureReadPhase::window_item_full_cancelled_setup_lt25_rpc_from25to49},
      Case{24, 49, CaptureReadPhase::window_item_full_expired_setup_lt25_rpc_from25to49, CaptureReadPhase::window_item_full_cancelled_setup_lt25_rpc_from25to49},
      Case{24, 50, CaptureReadPhase::window_item_full_expired_setup_lt25_rpc_ge50, CaptureReadPhase::window_item_full_cancelled_setup_lt25_rpc_ge50},
      Case{24, 51, CaptureReadPhase::window_item_full_expired_setup_lt25_rpc_ge50, CaptureReadPhase::window_item_full_cancelled_setup_lt25_rpc_ge50},
      Case{25, 24, CaptureReadPhase::window_item_full_expired_setup_ge25_rpc_lt25, CaptureReadPhase::window_item_full_cancelled_setup_ge25_rpc_lt25},
      Case{26, 24, CaptureReadPhase::window_item_full_expired_setup_ge25_rpc_lt25, CaptureReadPhase::window_item_full_cancelled_setup_ge25_rpc_lt25},
      Case{25, 25, CaptureReadPhase::window_item_full_expired_setup_ge25_rpc_from25to49, CaptureReadPhase::window_item_full_cancelled_setup_ge25_rpc_from25to49},
      Case{25, 49, CaptureReadPhase::window_item_full_expired_setup_ge25_rpc_from25to49, CaptureReadPhase::window_item_full_cancelled_setup_ge25_rpc_from25to49},
      Case{25, 50, CaptureReadPhase::window_item_full_expired_setup_ge25_rpc_ge50, CaptureReadPhase::window_item_full_cancelled_setup_ge25_rpc_ge50},
      Case{25, 51, CaptureReadPhase::window_item_full_expired_setup_ge25_rpc_ge50, CaptureReadPhase::window_item_full_cancelled_setup_ge25_rpc_ge50},
      Case{51, 25, CaptureReadPhase::window_item_full_expired_setup_ge25_rpc_from25to49, CaptureReadPhase::window_item_full_cancelled_setup_ge25_rpc_from25to49}};
    for (const auto& value : cases) {
      check(capture_item_ticket_expiry(value.setup, value.rpc) == value.expected, "capture.ticket-expiry-timing-boundaries");
      check(capture_item_cancelled_ticket_expiry(value.setup, value.rpc) == value.cancelled, "capture.cancelled-ticket-expiry-timing-boundaries");
    }
    const auto original = CaptureReadPhase::window_item_full_ticket_expired;
    check(capture_item_ticket_expiry({}, {}) == original && capture_item_ticket_expiry({}, 25) == original &&
      capture_item_ticket_expiry(25, {}) == original && capture_item_ticket_expiry(-1, 25) == original &&
      capture_item_ticket_expiry(25, -1) == original, "capture.ticket-expiry-unknown-observations-stay-original");
    const auto cancelled = CaptureReadPhase::window_item_expired_cancelled;
    check(capture_item_cancelled_ticket_expiry({}, {}) == cancelled && capture_item_cancelled_ticket_expiry({}, 25) == cancelled &&
      capture_item_cancelled_ticket_expiry(25, {}) == cancelled && capture_item_cancelled_ticket_expiry(-1, 25) == cancelled &&
      capture_item_cancelled_ticket_expiry(25, -1) == cancelled, "capture.cancelled-ticket-expiry-unknown-observations-stay-original");
  });
  test([] {
    Fixture fixture; auto helper = ordinary_window().owner.process.token;
    fixture.availability = WindowsAvailabilityObservation{helper, {true, false, true}, false};
    const auto result = fixture.take(fixture.args());
    check(std::holds_alternative<Failure>(result) && std::get<Failure>(result).code == L"secure_desktop" && fixture.reads == 0 && fixture.encodes == 0,
      "capture.secure-desktop-gate-precedes-every-native-pixel-read");
  });
  test([] {
    for (const auto policy : {std::optional<bool>{}, std::optional<bool>{true}}) {
      Fixture fixture; fixture.availability = WindowsAvailabilityObservation{ordinary_window().owner.process.token, {true, true, true}, policy};
      const auto result = fixture.take(fixture.args());
      check(std::holds_alternative<Failure>(result) && std::get<Failure>(result).code == L"capture_unavailable" && fixture.reads == 0,
        "capture.unknown-or-observed-policy-block-never-reads-pixels");
    }
  });
  test([] {
    Fixture fixture; fixture.availability = WindowsAvailabilityObservation{ordinary_window().owner.process.token, {true, true, true}, false};
    fixture.during_read = [&] { fixture.availability->desktop.default_name = false; };
    const auto result = fixture.take(fixture.args());
    check(std::holds_alternative<Failure>(result) && std::get<Failure>(result).code == L"secure_desktop" && fixture.ids == 0,
      "capture.desktop-switch-before-publication-retains-typed-refusal-and-no-receipt");
  });
  test([] {
    Fixture fixture; const auto result = fixture.take(fixture.args()); const auto& image = success(result);
    check(image.fields.GetNamedNumber(L"width") == 8 && image.fields.GetNamedNumber(L"height") == 4 && image.fields.GetNamedNumber(L"imageScale") == 0.5 && image.fields.GetNamedNumber(L"dpiScale") == 1.5, "capture.negative-origin-mixed-dpi-isotropic-header");
    const auto origin = image.fields.GetNamedObject(L"origin"); check(origin.GetNamedNumber(L"x") == -8 && origin.GetNamedNumber(L"y") == -4, "capture.physical-global-origin");
    const auto stored = fixture.service->receipt(L"capture-1", fixture.session); const auto point = stored.point(0, 0);
    check(point.x == -7 && point.y == -3 && fixture.service->current(stored, fixture.session), "capture.receipt-center-round-trip");
    check(image.fields.GetNamedNumber(L"imageBytes") == static_cast<double>(image.image.size()) && image.fields.GetNamedString(L"hash").size() == 16 && fixture.reads == 1 && fixture.encodes == 1, "capture.actual-data-bounds-and-hash");
  });
  test([] {
    Fixture fixture; std::optional<Dispatcher::Result> result;
    fixture.service->displays(JsonObject{}, fixture.context(), [&](auto value) { result = std::move(value); });
    check(result && std::holds_alternative<Reply>(*result), "capture.displays-success");
    const auto value = std::get<Reply>(*result).fields.GetNamedArray(L"displays").GetAt(0).GetObject();
    check(value.GetNamedNumber(L"scale") == 1 && value.GetNamedNumber(L"dpiScale") == 1.5 && value.GetNamedObject(L"pixelSize").GetNamedNumber(L"w") == 16 && fixture.reads == 0, "capture.displays-physical-pixels-without-capture");
  });
  test([] {
    Fixture fixture; const auto result = fixture.take(fixture.args(true)); const auto& image = success(result);
    check(image.fields.GetNamedNumber(L"width") == 6 && fixture.requests.size() == 1 && !fixture.requests[0].isolate_window && fixture.requests[0].window.has_value(), "capture.unobscured-window-primary-screen-path");
  });
  test([] {
    Fixture fixture; auto private_lower = empty_surface(); private_lower.bounds = private_lower.frame_bounds = fixture.world.displays[0].bounds;
    fixture.world.windows.push_back(private_lower);
    const auto result = fixture.take(fixture.args(true)); const auto& image = success(result);
    check(fixture.requests.size() == 1 && fixture.requests[0].isolate_window && fixture.requests[0].window.has_value() &&
      fixture.requests[0].window->hwnd == fixture.world.windows[0].hwnd && fixture.requests[0].bounds == fixture.world.windows[0].frame_bounds,
      "capture.unknown-alpha-with-private-lower-window-uses-isolated-source");
    check(image.fields.GetNamedArray(L"masked").Size() == 0 && image.fields.GetNamedNumber(L"hiddenCount") == 0 &&
      fixture.encoded.bgra[0] == 40 && fixture.encoded.bgra[1] == 80 && fixture.encoded.bgra[2] == 120 && fixture.encoded.bgra[3] == 255,
      "capture.isolated-window-retains-only-its-independent-pixels");
  });
  test([] {
    Fixture fixture; auto private_lower = empty_surface(); private_lower.bounds = private_lower.frame_bounds = fixture.world.displays[0].bounds;
    fixture.world.windows.push_back(private_lower);
    const auto result = fixture.take(fixture.args()); const auto& image = success(result);
    check(fixture.requests.size() == 1 && !fixture.requests[0].isolate_window && !fixture.requests[0].window.has_value() &&
      image.fields.GetNamedArray(L"masked").Size() == 1 && image.fields.GetNamedNumber(L"hiddenCount") == 1,
      "capture.display-keeps-composed-screen-and-private-lower-mask");
    for (size_t index = 0; index < fixture.encoded.bgra.size(); index += 4)
      check(fixture.encoded.bgra[index] == 0 && fixture.encoded.bgra[index + 1] == 0 && fixture.encoded.bgra[index + 2] == 0 && fixture.encoded.bgra[index + 3] == 255,
        "capture.unknown-alpha-display-never-exposes-lower-private-pixels");
  });
  test([] {
    Fixture fixture; fixture.world.windows[0].opaque = true;
    auto private_lower = empty_surface(); private_lower.bounds = private_lower.frame_bounds = fixture.world.displays[0].bounds;
    fixture.world.windows.push_back(private_lower);
    const auto result = fixture.take(fixture.args(true)); const auto& image = success(result);
    check(fixture.requests.size() == 1 && !fixture.requests[0].isolate_window && fixture.requests[0].window.has_value() &&
      image.fields.GetNamedArray(L"masked").Size() == 0 && fixture.encoded.bgra[0] == 40,
      "capture.proven-opaque-target-without-screen-masks-retains-bitblt");
  });
  test([] {
    for (const bool change_scene : {false, true}) {
      Fixture fixture; auto private_lower = empty_surface(); private_lower.bounds = private_lower.frame_bounds = fixture.world.displays[0].bounds;
      fixture.world.windows.push_back(private_lower);
      fixture.during_read = [&] { if (change_scene) ++fixture.world.windows.back().bounds.x; else ++fixture.session.observation_epoch; };
      failure(fixture.take(fixture.args(true)), change_scene ? L"stale_frame" : L"changed");
      check(fixture.requests.size() == 1 && fixture.requests[0].isolate_window && fixture.encodes == 0 && fixture.ids == 0,
        "capture.isolated-window-still-rejects-scene-or-authority-change");
    }
  });
  test([] {
    Fixture fixture; CaptureSurface top; top.hwnd = reinterpret_cast<HWND>(uintptr_t(99)); top.pid = 9001; top.thread = 99; top.bounds = top.frame_bounds = {-6, -3, 2, 2}; top.visible = true; top.cloaked = false;
    fixture.world.windows.insert(fixture.world.windows.begin(), top); const auto result = fixture.take(fixture.args(true)); const auto& image = success(result);
    check(fixture.requests[0].isolate_window && image.fields.GetNamedArray(L"masked").Size() == 0 && image.fields.GetNamedNumber(L"hiddenCount") == 0, "capture.occluded-window-uses-independent-source");
  });
  test([] {
    Fixture fixture; auto& target = fixture.world.windows[0]; target.bounds = target.frame_bounds = {100, 100, 6, 4};
    target.window->bounds = target.window->surface_bounds = target.bounds; target.window->on_screen = false;
    const auto result = fixture.take(fixture.args(true)); const auto& image = success(result);
    check(fixture.requests[0].isolate_window && image.fields.GetNamedObject(L"origin").GetNamedNumber(L"x") == 100, "capture.offscreen-approved-window-uses-independent-source");
  });
  test([] {
    Fixture fixture; CaptureSurface unknown; unknown.hwnd = reinterpret_cast<HWND>(uintptr_t(99)); unknown.pid = 9001; unknown.thread = 99; unknown.bounds = unknown.frame_bounds = {-8, -4, 4, 4}; unknown.visible = true; unknown.cloaked = false;
    fixture.world.windows.insert(fixture.world.windows.begin(), unknown); const auto result = fixture.take(fixture.args()); const auto& image = success(result);
    check(image.fields.GetNamedNumber(L"hiddenCount") == 1 && image.fields.GetNamedArray(L"masked").Size() > 0, "capture.unknown-owner-is-masked");
    check(fixture.encoded.bgra[0] == 0 && fixture.encoded.bgra[1] == 0 && fixture.encoded.bgra[2] == 0 && fixture.encoded.bgra[3] == 255, "capture.mask-is-opaque-before-encoding");
  });
  test([] {
    auto value = empty_surface();
    check(capture_surface_geometry(value), "capture.known-empty-structural-frame-is-canonical");
    value.frame_known = false; check(!capture_surface_geometry(value), "capture.empty-structural-frame-must-be-observed");
    value = empty_surface(); value.frame_bounds.width = -1;
    check(!capture_surface_geometry(value), "capture.negative-empty-frame-refuses");
    value = empty_surface(); value.frame_bounds = {WindowsRect::bound, 0, 1, 1};
    check(!capture_surface_geometry(value), "capture.out-of-range-empty-frame-refuses");
    value = empty_surface(); value.bounds.width = -1;
    check(!capture_surface_geometry(value), "capture.negative-outer-frame-still-refuses");
    value = empty_surface(); value.bounds = {WindowsRect::bound, 0, 0, 1}; value.frame_bounds = value.bounds;
    check(capture_surface_geometry(value) && !value.bounds.valid(), "capture.internal-empty-does-not-change-public-rectangle-contract");
    value = surface(ordinary_window()); value.frame_known = false;
    check(capture_surface_geometry(value), "capture.positive-outer-legacy-frame-fallback-is-preserved");
  });
  test([] {
    Fixture fixture; fixture.world.windows.insert(fixture.world.windows.begin(), empty_surface());
    const auto result = fixture.take(fixture.args()); const auto& image = success(result);
    check(image.fields.GetNamedArray(L"masked").Size() == 0 && image.fields.GetNamedNumber(L"hiddenCount") == 0,
      "capture.known-empty-frame-has-no-painted-footprint");
    const auto stored = fixture.service->receipt(L"capture-1", fixture.session);
    check(stored.inventory.windows.size() == 2 && stored.inventory.windows.front().hwnd == empty_surface().hwnd &&
      stored.inventory.windows.front().frame_known && fixture.service->current(stored, fixture.session),
      "capture.empty-hwnd-remains-in-complete-currentness-witness");
  });
  test([] {
    Fixture fixture; auto empty = empty_surface(); empty.frame_bounds = {-8, -4, 4, 4};
    // Even an inconsistent optional identity or claimed overlay cannot make a zero-area HWND approved.
    empty.window = ordinary_window(); empty.excluded_overlay = true; empty.opaque = true;
    fixture.world.windows.insert(fixture.world.windows.begin(), empty);
    const auto result = fixture.take(fixture.args()); const auto& image = success(result);
    check(image.fields.GetNamedArray(L"masked").Size() > 0 && image.fields.GetNamedNumber(L"hiddenCount") == 1 &&
      fixture.encoded.bgra[0] == 0 && fixture.encoded.bgra[1] == 0 && fixture.encoded.bgra[2] == 0,
      "capture.empty-outer-positive-frame-is-always-private");
    auto selected = fixture.args(true); selected.GetNamedObject(L"target").Insert(L"windowId", JsonValue::CreateStringValue(L"99"));
    failure(fixture.take(selected), L"capture_unavailable");
    fixture.requests.clear(); success(fixture.take(fixture.args(true)));
    check(fixture.requests.size() == 1 && fixture.requests.front().isolate_window,
      "capture.empty-outer-positive-frame-still-occludes-window-source");
  });
  test([] {
    for (unsigned change = 0; change < 8; ++change) {
      Fixture fixture; auto empty = empty_surface(); empty.excluded_overlay = true;
      fixture.world.windows.insert(fixture.world.windows.begin(), empty);
      success(fixture.take(fixture.args())); const auto stored = fixture.service->receipt(L"capture-1", fixture.session);
      auto& value = fixture.world.windows.front();
      if (change == 0) value.bounds.width = value.bounds.height = 1;
      if (change == 1) ++value.bounds.x;
      if (change == 2) value.frame_bounds.width = value.frame_bounds.height = 1;
      if (change == 3) value.frame_known = false;
      if (change == 4) value.visible = false;
      if (change == 5) value.minimized = true;
      if (change == 6) value.cloaked = true;
      if (change == 7) value.pid = 9002;
      check(!same_capture_inventory(stored.inventory, fixture.world) && !fixture.service->current(stored, fixture.session),
        "capture.every-empty-surface-transition-retires-the-frame");
    }
  });
  test([] {
    Fixture fixture; auto empty = empty_surface(); empty.frame_known = false;
    fixture.world.windows.insert(fixture.world.windows.begin(), empty);
    failure(fixture.take(fixture.args()), L"capture_unavailable");
    check(fixture.reads == 0 && fixture.encodes == 0, "capture.unknown-empty-frame-never-reads-pixels");
    fixture.world.windows.front() = empty_surface();
    fixture.during_read = [&] { fixture.world.windows.front().bounds.width = fixture.world.windows.front().bounds.height = 1; };
    failure(fixture.take(fixture.args()), L"stale_frame");
    check(fixture.encodes == 0 && fixture.ids == 0, "capture.empty-window-growth-during-read-cannot-publish");
  });
  test([] {
    Fixture fixture; CaptureSurface toast; toast.hwnd = reinterpret_cast<HWND>(uintptr_t(99)); toast.pid = 9001; toast.thread = 99;
    toast.bounds = toast.frame_bounds = {-8, -4, 4, 4}; toast.visible = true; toast.cloaked = false; toast.window_class = L"ToastWindowClass";
    fixture.world.windows.insert(fixture.world.windows.begin(), toast); const auto result = fixture.take(fixture.args()); const auto& image = success(result);
    check(image.fields.GetNamedNumber(L"hiddenCount") == 0 && image.fields.GetNamedArray(L"masked").Size() > 0 && fixture.encoded.bgra[0] == 0,
      "capture.structural-notification-is-private-without-inflating-app-count");
  });
  test([] {
    Fixture fixture; auto extra = fixture.world.windows.front(); extra.hwnd = reinterpret_cast<HWND>(uintptr_t(99)); extra.excluded_overlay = true;
    // Native inventory keeps an exactly excluded overlay structural; it does not copy another
    // window's owner/identity witness into that overlay's distinct HWND.
    extra.window.reset();
    fixture.world.windows.insert(fixture.world.windows.begin(), extra); const auto result = fixture.take(fixture.args(true)); success(result);
    check(!fixture.requests[0].isolate_window, "capture.exact-excluded-overlay-does-not-occlude-or-mask");
    auto changed = fixture.world; changed.windows.front().excluded_overlay = false;
    check(!same_capture_inventory(fixture.world, changed), "capture.lost-overlay-proof-reenters-inventory");
  });
  test([] {
    Fixture fixture; auto inconsistent = fixture.world.windows.front(); inconsistent.hwnd = reinterpret_cast<HWND>(uintptr_t(99));
    fixture.world.windows.insert(fixture.world.windows.begin(), inconsistent);
    failure(fixture.take(fixture.args()), L"stale_frame");
    check(fixture.reads == 0 && fixture.encodes == 0 && fixture.ids == 0, "capture.changed-structural-hwnd-cannot-borrow-another-window-witness");
  });
  test([] {
    Fixture fixture; fixture.session.vector_pids.Append(JsonValue::CreateNumberValue(4243)); const auto result = fixture.take(fixture.args()); const auto& image = success(result);
    check(image.fields.GetNamedNumber(L"hiddenCount") == 1 && fixture.labels == 1, "capture.vector-main-is-opaque-labeled-mask");
    failure(fixture.take(fixture.args(true)), L"protected");
  });
  test([] {
    Fixture fixture; fixture.session.approved.Clear(); failure(fixture.take(fixture.args(true)), L"not_granted"); check(fixture.reads == 0, "capture.unapproved-window-never-read");
  });
  test([] {
    Fixture fixture; fixture.world.windows[0].minimized = true; fixture.world.windows[0].window->minimized = true;
    const auto result = fixture.take(fixture.args(true)); check(success(result).fields.GetNamedBoolean(L"paused") && fixture.reads == 0, "capture.minimized-window-is-paused-not-guessed-image");
  });
  test([] {
    Fixture fixture; fixture.world.windows[0].affinity = WDA_EXCLUDEFROMCAPTURE;
    failure(fixture.take(fixture.args(true)), L"blocked_by_os"); check(fixture.reads == 0, "capture.app-own-display-affinity-is-respected");
  });
  test([] { Fixture fixture; fixture.black = true; failure(fixture.take(fixture.args()), L"capture_unavailable"); check(fixture.encodes == 0, "capture.all-black-is-unavailable"); });
  test([] { Fixture fixture; fixture.bad_encoding = true; failure(fixture.take(fixture.args()), L"capture_unavailable"); rejects([&] { fixture.service->receipt(L"capture-1", fixture.session); }, L"stale_frame", "capture.bad-codec-never-creates-action-receipt"); });
  test([] {
    Fixture fixture; fixture.during_read = [&] { ++fixture.session.observation_epoch; };
    failure(fixture.take(fixture.args()), L"changed"); check(fixture.encodes == 0, "capture.phase-change-drops-late-native-image");
  });
  test([] {
    Fixture fixture; fixture.during_read = [&] { fixture.world.windows[0].bounds.x += 1; };
    failure(fixture.take(fixture.args()), L"stale_frame"); check(fixture.encodes == 0, "capture.window-change-before-encode-refuses");
  });
  test([] {
    Fixture fixture; fixture.during_encode = [&] { fixture.service->invalidate(); };
    failure(fixture.take(fixture.args()), L"stale_frame"); rejects([&] { fixture.service->receipt(L"capture-1", fixture.session); }, L"stale_frame", "capture.late-encoder-cannot-revive-retired-registry");
  });
  test([] {
    Fixture fixture; fixture.during_encode = [&] { fixture.service->close(); };
    failure(fixture.take(fixture.args()), L"stale_frame");
  });
  test([] { Fixture fixture; fixture.during_encode = [&] { fixture.available = false; }; failure(fixture.take(fixture.args()), L"changed"); });
  test([] {
    Fixture fixture; const auto first = fixture.take(fixture.args()); success(first);
    auto zoom = fixture.args(); zoom.Insert(L"zoom", JsonObject::Parse(LR"({"captureId":"capture-1","region":{"x0":0,"y0":0,"x1":4,"y1":2}})"));
    zoom.Insert(L"format", JsonValue::CreateStringValue(L"jpeg")); const auto result = fixture.take(zoom); success(result);
    check(fixture.format == L"png" && fixture.requests.back().bounds == WindowsRect{-8, -4, 8, 4}, "capture.zoom-rereads-native-region-and-forces-png");
    rejects([&] { fixture.service->receipt(L"capture-2", fixture.session); }, L"stale_frame", "capture.zoom-is-not-action-authority");
  });
  test([] {
    Fixture fixture; const auto result = fixture.take(fixture.args()); success(result); const auto stored = fixture.service->receipt(L"capture-1", fixture.session);
    rejects([&] { stored.point(-1, 0); }, L"out_of_bounds", "capture.negative-image-point-refused");
    rejects([&] { stored.point(stored.width, 0); }, L"out_of_bounds", "capture.right-edge-point-refused");
    fixture.world.displays[0].dpi_scale = 2; check(!fixture.service->current(stored, fixture.session), "capture.changed-display-dpi-retires-point-authority");
  });
  test([] {
    Fixture fixture; const auto result = fixture.take(fixture.args()); success(result);
    auto successor = fixture.session; ++successor.run_epoch;
    rejects([&] { fixture.service->receipt(L"capture-1", successor); }, L"stale_frame", "capture.reused-wire-session-cannot-reuse-old-frame");
    successor = fixture.session; ++successor.observation_epoch;
    rejects([&] { fixture.service->receipt(L"capture-1", successor); }, L"stale_frame", "capture.reused-wire-revision-cannot-reuse-old-frame");
  });
  test([] {
    Fixture fixture; CaptureRegistry registry; const auto generation = registry.generation();
    for (unsigned index = 0; index < 33; ++index) check(registry.put(receipt(L"id-" + std::to_wstring(index), generation, fixture.session), generation), "capture.registry-bounded-insertion");
    rejects([&] { registry.get(L"id-0", fixture.session); }, L"stale_frame", "capture.registry-evicts-oldest-of-32");
    check(registry.get(L"id-32", fixture.session).id == L"id-32", "capture.registry-keeps-newest-metadata");
    check(!registry.put(receipt(L"id-32", generation, fixture.session), generation), "capture.registry-never-reuses-live-capture-id");
  });
  test([] {
    Fixture fixture; CaptureRegistry registry; const auto generation = registry.generation();
    auto giant = receipt(L"large", generation, fixture.session); giant.inventory.windows.resize(4097);
    check(!registry.put(std::move(giant), generation), "capture.registry-refuses-excess-single-receipt-witnesses");
    for (unsigned index = 0; index < 3; ++index) {
      auto value = receipt(L"many-" + std::to_wstring(index), generation, fixture.session); value.inventory.windows.resize(2048);
      check(registry.put(std::move(value), generation), "capture.registry-admits-bounded-witness-set");
    }
    rejects([&] { registry.get(L"many-0", fixture.session); }, L"stale_frame", "capture.registry-evicts-on-total-witness-budget");
  });
  test([] {
    Fixture fixture; CaptureRegistry registry; const auto generation = registry.generation();
    for (unsigned index = 0; index < 4; ++index) {
      auto value = receipt(L"bytes-" + std::to_wstring(index), generation, fixture.session); value.inventory.windows.resize(1);
      value.inventory.windows[0].window_class.reserve(1024 * 1024);
      check(registry.put(std::move(value), generation), "capture.registry-admits-bounded-metadata-capacity");
    }
    rejects([&] { registry.get(L"bytes-0", fixture.session); }, L"stale_frame", "capture.registry-evicts-on-total-byte-budget");
    auto oversized = receipt(L"oversized", generation, fixture.session); oversized.inventory.windows.resize(1); oversized.inventory.windows[0].window_class.reserve(4 * 1024 * 1024);
    check(!registry.put(std::move(oversized), generation), "capture.registry-refuses-single-oversized-capacity");
  });
  test([] {
    Fixture fixture; auto args = fixture.args(); args.Insert(L"quality", JsonValue::CreateBooleanValue(true)); failure(fixture.take(args), L"failed");
    check(fixture.reads == 0, "capture.malformed-request-never-reaches-native-backend");
  });
  test([] {
    Fixture fixture; CaptureRegistry registry; const auto generation = registry.generation();
    auto value = receipt(L"mismatched", generation, fixture.session); value.image_scale = 0.5;
    check(!registry.put(std::move(value), generation), "capture.registry-rejects-anisotropic-or-invented-scale");
    value = receipt(L"underflow", generation, fixture.session); value.image_scale = 1e-300;
    check(!registry.put(std::move(value), generation), "capture.registry-rejects-unmappable-tiny-scale");
    CaptureService inert(CaptureBackend{});
    check(!inert.features().GetNamedBoolean(L"capture.display") && !inert.features().GetNamedBoolean(L"capture.window"), "capture.empty-backend-does-not-advertise-implementation");
  });
  return groups;
}
}
