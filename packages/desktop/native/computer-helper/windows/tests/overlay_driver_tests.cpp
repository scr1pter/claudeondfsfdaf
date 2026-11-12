#include "overlay_driver.h"
#include "uia_native.h"
#include "input_guardian.h"
#include "privileged_self_test.h"
#include <propidl.h>
#include <uiautomation.h>
#include <algorithm>
#include <limits>
#include <new>
#include <set>
#include <stdexcept>

namespace vector::computer {
namespace {
void require(bool value, const char* label) { if (!value) throw std::runtime_error(label); }
std::wstring named(const JsonObject& value, const wchar_t* key) { return std::wstring(value.GetNamedString(key)); }
std::set<std::wstring> wire_keys(const JsonObject& value) { std::set<std::wstring> result; for (const auto& entry : value) result.insert(std::wstring(entry.Key())); return result; }
std::vector<std::wstring> driver_causes() {
  std::vector<std::wstring> result{L"driver_failure", L"std_exception", L"unknown"};
  for (const auto code : windows_privileged_native_codes) result.push_back(L"core_failure:" + std::wstring(code));
  for (const auto bucket : overlay_driver_hresult_classes) result.push_back(L"hresult:" + std::wstring(bucket));
  return result;
}
std::vector<std::wstring> stop_options() { return {L"--overlay-stop", L"--parent-pid", L"42", L"--nonce", std::wstring(64, L'a')}; }
OverlayStopRequest request() { return {42, 123, std::wstring(64, L'a'), std::wstring(64, L'b'), L"Vector computer smoke " + std::wstring(64, L'a'), reinterpret_cast<HWND>(uintptr_t{100}), {-200, 20, 600, 90}, {250, 40, 80, 40}}; }
JsonObject wire_request() {
  const auto fixture = request(); JsonObject result;
  result.Insert(L"protocol", JsonValue::CreateNumberValue(1)); result.Insert(L"nonce", JsonValue::CreateStringValue(fixture.nonce)); result.Insert(L"parentPID", JsonValue::CreateNumberValue(fixture.parent)); result.Insert(L"parentCreationTime", JsonValue::CreateStringValue(L"123")); result.Insert(L"sourceDigest", JsonValue::CreateStringValue(fixture.source_digest)); result.Insert(L"bannerWindowId", JsonValue::CreateStringValue(L"100")); result.Insert(L"bannerBounds", fixture.banner_bounds.wire()); result.Insert(L"stopBounds", fixture.stop_bounds.wire()); result.Insert(L"bannerTitle", JsonValue::CreateStringValue(fixture.title)); return result;
}
}

// Pure wire/decision fixtures. They start no process, query no HWND/token/file, and post no input.
size_t run_overlay_driver_tests() {
  size_t count = 0; const auto test = [&](const auto& body) { body(); ++count; };
  test([] {
    for (const auto phase : {InputGuardianPhase::none, InputGuardianPhase::confirmed, static_cast<InputGuardianPhase>(255)})
      require(!overlay_driver_guardian_stage(phase), "overlay-driver.guardian-success-or-unknown-cannot-diagnose-failed-down");
    std::set<OverlayDriverStage> stages;
    for (const auto phase : {InputGuardianPhase::request_invalid, InputGuardianPhase::lock_expired, InputGuardianPhase::budget_expired,
        InputGuardianPhase::inactive, InputGuardianPhase::write_refused, InputGuardianPhase::read_refused,
        InputGuardianPhase::reply_invalid, InputGuardianPhase::setup_failed, InputGuardianPhase::reply_negative,
        InputGuardianPhase::reply_negative_zero_budget, InputGuardianPhase::reply_negative_short_budget,
        InputGuardianPhase::reply_negative_full_budget, InputGuardianPhase::reply_negative_no_callback_pump_stalled,
        InputGuardianPhase::reply_negative_no_callback_pump_progressed, InputGuardianPhase::reply_negative_own_move_only,
        InputGuardianPhase::reply_negative_own_down_refused, InputGuardianPhase::reply_negative_own_up_only,
        InputGuardianPhase::reply_negative_own_tag_unflagged}) {
      const auto stage = overlay_driver_guardian_stage(phase);
      require(stage && stages.insert(*stage).second && overlay_driver_stage(overlay_driver_stage_name(*stage)),
        "overlay-driver.guardian-failure-buckets-are-unique-closed-stages");
    }
  });
  test([] {
    for (int flags = 0; flags < 16; ++flags) {
      const LONG_PTR extended = ((flags & 1) ? static_cast<LONG_PTR>(WS_EX_NOACTIVATE) : LONG_PTR{0}) |
        ((flags & 2) ? static_cast<LONG_PTR>(WS_EX_TRANSPARENT) : LONG_PTR{0}) |
        ((flags & 4) ? static_cast<LONG_PTR>(WS_EX_LAYERED) : LONG_PTR{0});
      const LONG_PTR style = (flags & 8) ? static_cast<LONG_PTR>(WS_CAPTION) : LONG_PTR{0};
      require(valid_overlay_stop_styles(extended, style) == ((flags & 1) != 0 && (flags & 2) == 0 && (flags & 8) == 0),
        "overlay-driver.clickable-stop-style-authority-is-independent-of-layering");
    }
    for (const LONG_PTR layered : {LONG_PTR{0}, static_cast<LONG_PTR>(WS_EX_LAYERED)}) {
      const auto extended = static_cast<LONG_PTR>(WS_EX_NOACTIVATE) | layered;
      require(valid_overlay_stop_styles(extended | WS_EX_TOOLWINDOW, static_cast<LONG_PTR>(WS_POPUP) | WS_VISIBLE),
        "overlay-driver.clickable-frameless-banner-allows-either-compositor-style");
      for (const LONG_PTR caption : {static_cast<LONG_PTR>(WS_CAPTION), static_cast<LONG_PTR>(WS_BORDER), static_cast<LONG_PTR>(WS_DLGFRAME)})
        require(!valid_overlay_stop_styles(extended, caption), "overlay-driver.any-caption-bit-still-refuses-stop");
    }
  });
  test([] {
    const auto parsed = parse_overlay_driver_options(stop_options());
    require(parsed && parsed->mode == OverlayDriverMode::stop && parsed->parent == 42 && parsed->nonce == std::wstring(64, L'a'), "overlay-driver.finite-stop-cli");
    const auto bootstrap = parse_overlay_driver_options(std::vector<std::wstring>{L"--launch-electron", L"--nonce", std::wstring(64, L'b')});
    require(bootstrap && bootstrap->mode == OverlayDriverMode::launch_electron && bootstrap->parent == 0, "overlay-driver.finite-bootstrap-cli");
  });
  test([] {
    for (const auto value : {L"0", L"042", L"-42", L"+42", L"42 ", L"4294967296", L"18446744073709551615", L""}) {
      auto arguments = stop_options(); arguments[2] = value; require(!parse_overlay_driver_options(arguments), "overlay-driver.parent-is-canonical-dword");
    }
    auto arguments = stop_options(); arguments[2] = L"4294967295"; require(parse_overlay_driver_options(arguments).has_value(), "overlay-driver.full-dword-parent-does-not-overflow");
  });
  test([] {
    for (const auto& nonce : {std::wstring(63, L'a'), std::wstring(65, L'a'), std::wstring(64, L'A'), std::wstring(64, L'g'), std::wstring(64, L'\0'), std::wstring{}}) {
      auto arguments = stop_options(); arguments[4] = nonce; require(!parse_overlay_driver_options(arguments), "overlay-driver.nonce-is-exact-lowercase-hex");
    }
  });
  test([] {
    for (const auto extra : {L"--stdio", L"--target=C:\\other.exe", L"--script=other.js", L"--no-sandbox", L"--report=private.txt", L"--force-renderer-accessibility", L"--disable-renderer-accessibility"}) {
      auto arguments = stop_options(); arguments.push_back(extra); require(!parse_overlay_driver_options(arguments), "overlay-driver.no-arbitrary-stop-command-argument");
      const std::vector<std::wstring> bootstrap{L"--launch-electron", L"--nonce", std::wstring(64, L'a'), extra}; require(!parse_overlay_driver_options(bootstrap), "overlay-driver.no-arbitrary-electron-argument");
    }
  });
  test([] {
    auto arguments = stop_options(); arguments[0] = L"--click"; require(!parse_overlay_driver_options(arguments), "overlay-driver.no-generic-input-mode");
    arguments = stop_options(); arguments[1] = L"--target-pid"; require(!parse_overlay_driver_options(arguments), "overlay-driver.no-retargeting-pid-option");
    arguments = stop_options(); std::swap(arguments[1], arguments[3]); require(!parse_overlay_driver_options(arguments), "overlay-driver.canonical-option-order");
  });
  test([] {
    require(valid_overlay_stop_request(request()), "overlay-driver.bounded-private-stop-request"); const auto parsed = parse_overlay_stop_request(wire_request());
    require(parsed && parsed->parent == 42 && parsed->parent_created == 123 && parsed->banner == request().banner && parsed->stop_bounds == request().stop_bounds, "overlay-driver.private-wire-preserves-exact-native-scope");
  });
  test([] {
    for (const auto key : {L"x", L"pid", L"command", L"keys", L"path", L"text"}) {
      const auto value = wire_request(); value.Insert(key, JsonValue::CreateStringValue(L"not a stop target")); require(!parse_overlay_stop_request(value), "overlay-driver.private-wire-has-no-unclassified-input-authority");
    }
    const auto missing = wire_request(); missing.Remove(L"nonce"); require(!parse_overlay_stop_request(missing), "overlay-driver.private-wire-requires-nonce");
  });
  test([] {
    const auto value = wire_request(); value.Insert(L"parentCreationTime", JsonValue::CreateStringValue(L"18446744073709551615"));
    const auto parsed = parse_overlay_stop_request(value); require(parsed && parsed->parent_created == std::numeric_limits<uint64_t>::max(), "overlay-driver-native-filetime-is-a-lossless-string");
    for (const auto wrong : {L"0", L"0123", L"-1", L"18446744073709551616", L"123.0", L""}) {
      value.Insert(L"parentCreationTime", JsonValue::CreateStringValue(wrong)); require(!parse_overlay_stop_request(value), "overlay-driver-native-filetime-is-never-coerced");
    }
    value.Insert(L"parentCreationTime", JsonValue::CreateNumberValue(123)); require(!parse_overlay_stop_request(value), "overlay-driver-filetime-never-rounds-through-json-double");
  });
  test([] {
    const auto value = wire_request(); value.Insert(L"protocol", JsonValue::CreateNumberValue(2)); require(!parse_overlay_stop_request(value), "overlay-driver.only-private-protocol-one");
    value.Insert(L"protocol", JsonValue::CreateStringValue(L"1")); require(!parse_overlay_stop_request(value), "overlay-driver.protocol-is-not-coerced");
    value.Insert(L"protocol", JsonValue::CreateNumberValue(1)); value.Insert(L"bannerWindowId", JsonValue::CreateStringValue(L"0100")); require(!parse_overlay_stop_request(value), "overlay-driver.window-id-is-canonical");
    value.Insert(L"bannerWindowId", JsonValue::CreateNumberValue(100)); require(!parse_overlay_stop_request(value), "overlay-driver.window-id-is-lossless-string");
  });
  test([] {
    for (int change = 0; change < 5; ++change) {
      auto value = request(); if (change == 0) value.parent = 0; if (change == 1) value.parent_created = 0; if (change == 2) value.banner = nullptr; if (change == 3) value.nonce[0] = L'g'; if (change == 4) value.source_digest[0] = L'B';
      require(!valid_overlay_stop_request(value), "overlay-driver.private-scope-has-no-unknown-owner-or-source");
    }
  });
  test([] {
    for (const auto title : {L"Stop", L"Vector computer smoke", L"Vector computer smoke other", L"Vector computer smoke \u202e"}) {
      auto value = request(); value.title = title; require(!valid_overlay_stop_request(value), "overlay-driver.title-binds-the-same-private-banner-nonce");
    }
    const auto value = wire_request(); value.Insert(L"bannerTitle", JsonValue::CreateStringValue(request().title + L" ")); require(!parse_overlay_stop_request(value), "overlay-driver.banner-title-is-not-trimmed-or-normalized");
  });
  test([] {
    for (int change = 0; change < 6; ++change) {
      auto value = request(); if (change == 0) value.stop_bounds.width = 0; if (change == 1) value.stop_bounds.height = -1; if (change == 2) value.stop_bounds.x = value.banner_bounds.x - 1;
      if (change == 3) value.stop_bounds.y = value.banner_bounds.y + value.banner_bounds.height; if (change == 4) value.banner_bounds.width = 4097; if (change == 5) value.stop_bounds.width = 513;
      require(!valid_overlay_stop_request(value), "overlay-driver.stop-hint-is-bounded-inside-the-owned-banner");
    }
  });
  test([] {
    const WindowsRect native{-200, 30, 80, 40}; require(overlay_stop_bounds_match(native, native), "overlay-driver.native-stop-bounds-match-their-own-hint");
    for (const auto delta : {-1LL, 1LL}) { auto hint = native; hint.x += delta; hint.y += delta; require(overlay_stop_bounds_match(hint, native), "overlay-driver-dom-hint-allows-one-physical-pixel-rounding"); }
    auto hint = native; hint.x += 2; require(!overlay_stop_bounds_match(hint, native), "overlay-driver-hint-cannot-widen-or-retarget-native-stop"); hint = native; hint.width += 2; require(!overlay_stop_bounds_match(hint, native), "overlay-driver-both-native-edges-must-match");
  });
  test([] {
    const OverlayDriverResult passed{true, false, {}}; require(passed.exit_code() == 0, "overlay-driver-owned-down-and-up-success-code"); const auto wire = passed.wire();
    require(wire.Size() == 4 && wire.GetNamedNumber(L"id") == 1 && wire.GetNamedNumber(L"protocol") == 1 && wire.GetNamedString(L"check") == L"native-os-stop" && wire.GetNamedBoolean(L"ok"), "overlay-driver-success-report-has-no-observed-content");
    const OverlayDriverResult skip{false, true, L"noninteractive_desktop"}; require(skip.exit_code() == 77 && skip.wire().GetNamedBoolean(L"skipped"), "overlay-driver-observed-missing-prerequisite-is-explicit-skip");
    const OverlayDriverResult failed{false, false, L"cleanup_failed"}; require(failed.exit_code() == 1 && !failed.wire().GetNamedBoolean(L"ok"), "overlay-driver-unknown-release-is-a-real-failure");
  });
  test([] {
    for (const auto& result : {OverlayDriverResult{true, true, L"noninteractive_desktop"}, OverlayDriverResult{false, true, L"input_post_failed"}, OverlayDriverResult{false, true, {}}, OverlayDriverResult{false, false, L"private window/path or payload"}}) {
      require(result.exit_code() == 1, "overlay-driver-assertions-or-unknown-details-never-become-skips"); const auto wire = result.wire();
      require(!wire.GetNamedBoolean(L"ok") && !wire.HasKey(L"skipped") && wire.GetNamedString(L"reason") == L"native_failure", "overlay-driver-invalid-report-is-sanitized");
    }
  });
  test([] {
    const auto causes = driver_causes(); require(causes.size() == 40 && std::set<std::wstring>(causes.begin(), causes.end()).size() == 40, "overlay-driver.failure-cause-grammar-is-closed");
    for (const auto stage : overlay_driver_stages) for (const auto& cause : causes) for (const auto reason : {L"native_failure", L"parent_invalid"}) {
      const OverlayDriverResult value{false, false, reason, std::wstring(stage), cause}; const auto wire = value.wire();
      require(value.exit_code() == 1 && !wire.GetNamedBoolean(L"ok") && !wire.HasKey(L"skipped") && named(wire, L"reason") == reason, "overlay-driver.failure-diagnostics-keep-the-failure");
      // A non-driver cause always reported native_failure; any other pairing is dropped, never reported.
      if (cause == L"driver_failure" || std::wstring_view(reason) == L"native_failure") require(wire.Size() == 7 && named(wire, L"stage") == std::wstring(stage) && named(wire, L"cause") == cause, "overlay-driver.failure-stage-and-cause-round-trip");
      else require(wire.Size() == 5 && !wire.HasKey(L"stage") && !wire.HasKey(L"cause"), "overlay-driver.non-driver-cause-requires-native-failure");
    }
    for (size_t index = 0; index < overlay_driver_stages.size(); ++index) require(overlay_driver_stage_name(static_cast<OverlayDriverStage>(index)) == overlay_driver_stages[index], "overlay-driver.stage-names-follow-the-closed-order");
    require(overlay_driver_stage_name(static_cast<OverlayDriverStage>(overlay_driver_stages.size())).empty(), "overlay-driver.out-of-range-stage-has-no-name");
  });
  test([] {
    require(!overlay_driver_uia_stage(WindowsUiaPhase::none) && !overlay_driver_uia_stage(static_cast<WindowsUiaPhase>(windows_uia_phases.size())), "overlay-driver.uia-unknown-phases-have-no-stage");
    for (size_t index = 1; index < windows_uia_phases.size(); ++index) {
      const auto stage = overlay_driver_uia_stage(static_cast<WindowsUiaPhase>(index));
      require(stage && overlay_driver_stage_name(*stage) == L"uia-" + std::wstring(windows_uia_phases[index]), "overlay-driver.uia-phase-maps-to-its-closed-stage");
      try { throw Failure{L"no_ui_tree", L"PRIVATE NATIVE CONTENT"}; }
      catch (...) {
        const auto result = overlay_driver_caught(OverlayDriverMode::stop, *stage, std::current_exception());
        require(!result.ok && !result.skipped && result.exit_code() == 1 && result.cause == L"core_failure:no_ui_tree" && result.stage == overlay_driver_stage_name(*stage), "overlay-driver.uia-stage-keeps-original-failure-and-exit");
      }
    }
  });
  test([] {
    for (const auto stage : {L"", L"bogus", L"Files", L"files ", L"observe_parent", L"C:\\Windows", L"0x80070005"}) {
      const OverlayDriverResult value{false, false, L"native_failure", stage, L"unknown"}; const auto wire = value.wire();
      require(value.exit_code() == 1 && wire.Size() == 5 && !wire.HasKey(L"stage") && !wire.HasKey(L"cause") && named(wire, L"reason") == L"native_failure", "overlay-driver.unknown-stage-is-dropped");
    }
    for (const auto cause : {L"", L"driver_skip", L"core_failure:", L"core_failure:PRIVATE", L"core_failure:native_operation_failed", L"hresult:", L"hresult:0x80070005", L"hresult:-2147024891", L"Unknown", L"std_exception ", L"hresult:access_denied "}) {
      const OverlayDriverResult value{false, false, L"native_failure", L"files", cause}; const auto wire = value.wire();
      require(value.exit_code() == 1 && wire.Size() == 5 && !wire.HasKey(L"stage") && !wire.HasKey(L"cause") && named(wire, L"reason") == L"native_failure", "overlay-driver.unknown-cause-is-dropped");
    }
  });
  test([] {
    const OverlayDriverResult passed{true, false, {}, L"post", L"unknown"}; const auto success = passed.wire();
    require(passed.exit_code() == 0 && success.Size() == 4 && success.GetNamedBoolean(L"ok") && !success.HasKey(L"stage") && !success.HasKey(L"cause"), "overlay-driver.success-never-carries-diagnostics");
    const OverlayDriverResult skip{false, true, L"noninteractive_desktop", L"desktop", L"std_exception"}; const auto skipped = skip.wire();
    require(skip.exit_code() == 77 && skipped.Size() == 6 && skipped.GetNamedBoolean(L"skipped") && !skipped.HasKey(L"stage") && !skipped.HasKey(L"cause"), "overlay-driver.skip-never-carries-diagnostics");
    const OverlayDriverResult incoherent{false, true, L"input_post_failed", L"post", L"unknown"}; const auto sanitized = incoherent.wire();
    require(incoherent.exit_code() == 1 && sanitized.Size() == 5 && named(sanitized, L"reason") == L"native_failure" && !sanitized.HasKey(L"stage") && !sanitized.HasKey(L"cause"), "overlay-driver.sanitized-report-never-carries-diagnostics");
  });
  test([] {
    for (const auto& base : {OverlayDriverResult{true, false, {}}, OverlayDriverResult{false, true, L"noninteractive_desktop"}, OverlayDriverResult{false, false, L"cleanup_failed"}, OverlayDriverResult{false, false, L"native_failure"},
           OverlayDriverResult{true, true, L"noninteractive_desktop"}, OverlayDriverResult{false, true, L"input_post_failed"}, OverlayDriverResult{false, true, {}}, OverlayDriverResult{false, false, L"private window/path or payload"}, OverlayDriverResult{false, false, {}}})
      for (const auto stage : {L"", L"files", L"post", L"bogus"}) for (const auto cause : {L"", L"unknown", L"driver_failure", L"hresult:rpc", L"PRIVATE"}) {
        auto value = base; value.stage = stage; value.cause = cause; const auto wire = value.wire(), plain = base.wire(); const auto document = winrt::to_string(wire.Stringify());
        require(value.exit_code() == base.exit_code() && wire.GetNamedBoolean(L"ok") == plain.GetNamedBoolean(L"ok") && wire.HasKey(L"skipped") == plain.HasKey(L"skipped") && wire.HasKey(L"reason") == plain.HasKey(L"reason") && (!plain.HasKey(L"reason") || named(wire, L"reason") == named(plain, L"reason")), "overlay-driver.diagnostics-never-change-exit-codes");
        require(wire.Size() == plain.Size() + (wire.HasKey(L"stage") ? 2u : 0u) && wire.HasKey(L"stage") == wire.HasKey(L"cause") && document.find("PRIVATE") == std::string::npos && document.find("bogus") == std::string::npos, "overlay-driver.diagnostics-are-both-or-neither");
      }
  });
  test([] {
    const auto launch = [](std::exception_ptr error) { return overlay_driver_caught(OverlayDriverMode::launch_electron, OverlayDriverStage::files, error); };
    const auto unavailable = launch(std::make_exception_ptr(DriverFailure{L"medium_token_unavailable"}));
    require(unavailable.skipped && unavailable.exit_code() == 77 && unavailable.stage.empty() && unavailable.cause.empty() && wire_keys(unavailable.wire()) == std::set<std::wstring>{L"id", L"protocol", L"check", L"ok", L"skipped", L"reason"}, "overlay-driver.bootstrap-unavailable-record-is-unchanged");
    for (const auto& error : {std::make_exception_ptr(DriverFailure{L"bootstrap_failed"}), std::make_exception_ptr(std::runtime_error("C:\\private")), std::make_exception_ptr(Failure{L"unavailable", L"private"}), std::make_exception_ptr(ProtocolError(0, L"timeout", L"private")), std::make_exception_ptr(winrt::hresult_error(E_ACCESSDENIED)), std::make_exception_ptr(7), std::exception_ptr{}}) {
      const auto value = launch(error);
      require(!value.ok && !value.skipped && value.stage.empty() && value.cause.empty() && value.exit_code() == 1 && wire_keys(value.wire()) == std::set<std::wstring>{L"id", L"protocol", L"check", L"ok", L"reason"}, "overlay-driver.bootstrap-record-is-unchanged");
    }
    require(launch(std::make_exception_ptr(DriverFailure{L"bootstrap_failed"})).reason == L"bootstrap_failed" && launch(std::make_exception_ptr(std::runtime_error("C:\\private"))).reason == L"native_failure", "overlay-driver.bootstrap-reasons-are-unchanged");
    const auto skip = launch(std::make_exception_ptr(DriverSkip{L"noninteractive_desktop"}));
    require(skip.skipped && skip.exit_code() == 77 && skip.stage.empty() && skip.cause.empty(), "overlay-driver.bootstrap-skip-is-unchanged");
    const auto stopped = overlay_driver_caught(OverlayDriverMode::stop, OverlayDriverStage::envelope_read, std::make_exception_ptr(DriverFailure{L"medium_token_unavailable"}));
    require(!stopped.skipped && stopped.exit_code() == 1 && stopped.stage == L"envelope-read" && stopped.cause == L"driver_failure", "overlay-driver.stop-mode-medium-token-is-never-a-skip");
  });
  test([] {
    struct Case { std::exception_ptr error; const wchar_t* reason; const wchar_t* cause; };
    const std::vector<Case> cases{
      {std::make_exception_ptr(Failure{L"unavailable", L"private"}), L"native_failure", L"core_failure:unavailable"},
      {std::make_exception_ptr(Failure{L"target_validation_failed", L"private"}), L"native_failure", L"core_failure:unknown"},
      {std::make_exception_ptr(Failure{L"C:\\private", L"private"}), L"native_failure", L"core_failure:unknown"},
      // A ProtocolError is a std::exception, but its closed code is kept rather than reported as std_exception.
      {std::make_exception_ptr(ProtocolError(0, L"frame_too_large", L"private")), L"native_failure", L"core_failure:frame_too_large"},
      {std::make_exception_ptr(ProtocolError(0, L"C:\\private", L"private")), L"native_failure", L"core_failure:unknown"},
      {std::make_exception_ptr(winrt::hresult_error(E_ACCESSDENIED, L"private message")), L"native_failure", L"hresult:access_denied"},
      {std::make_exception_ptr(winrt::hresult_error(RPC_E_DISCONNECTED)), L"native_failure", L"hresult:rpc"},
      {std::make_exception_ptr(winrt::hresult_error(HRESULT_FROM_WIN32(RPC_S_SERVER_UNAVAILABLE))), L"native_failure", L"hresult:rpc"},
      {std::make_exception_ptr(winrt::hresult_error(static_cast<HRESULT>(UIA_E_ELEMENTNOTAVAILABLE))), L"native_failure", L"hresult:not_found"},
      {std::make_exception_ptr(winrt::hresult_error(static_cast<HRESULT>(UIA_E_TIMEOUT))), L"native_failure", L"hresult:timeout"},
      {std::make_exception_ptr(winrt::hresult_error(RPC_E_TIMEOUT)), L"native_failure", L"hresult:timeout"},
      {std::make_exception_ptr(winrt::hresult_error(E_FAIL)), L"native_failure", L"hresult:other"},
      {std::make_exception_ptr(std::runtime_error("C:\\private")), L"native_failure", L"std_exception"},
      {std::make_exception_ptr(std::bad_alloc()), L"native_failure", L"std_exception"},
      {std::make_exception_ptr(7), L"native_failure", L"unknown"},
      {std::exception_ptr{}, L"native_failure", L"unknown"},
      {std::make_exception_ptr(DriverFailure{L"parent_invalid"}), L"parent_invalid", L"driver_failure"}};
    for (size_t index = 0; index < overlay_driver_stages.size(); ++index) for (const auto& item : cases) {
      const auto value = overlay_driver_caught(OverlayDriverMode::stop, static_cast<OverlayDriverStage>(index), item.error); const auto wire = value.wire(); const auto document = winrt::to_string(wire.Stringify());
      require(!value.ok && !value.skipped && value.reason == item.reason && value.cause == item.cause && value.stage == std::wstring(overlay_driver_stages[index]) && value.exit_code() == 1, "overlay-driver.caught-exceptions-map-to-closed-causes");
      require(wire.Size() == 7 && named(wire, L"stage") == std::wstring(overlay_driver_stages[index]) && named(wire, L"cause") == item.cause && named(wire, L"reason") == item.reason, "overlay-driver.caught-diagnostics-reach-the-result-frame");
      for (const auto banned : {"private", "0x", "8007", "-2147", "C:"}) require(document.find(banned) == std::string::npos, "overlay-driver.caught-diagnostics-carry-no-native-detail");
    }
    const auto skip = overlay_driver_caught(OverlayDriverMode::stop, OverlayDriverStage::desktop, std::make_exception_ptr(DriverSkip{L"noninteractive_desktop"}));
    require(skip.skipped && skip.exit_code() == 77 && skip.stage.empty() && skip.cause.empty() && !skip.wire().HasKey(L"stage"), "overlay-driver.caught-skips-carry-no-diagnostics");
  });
  test([] {
    for (unsigned facility = 0; facility < 0x2000; facility += 7) for (const unsigned code : {0u, 5u, 0x6bau, 0x490u, 0xffffu}) {
      const auto bucket = overlay_driver_hresult_class(static_cast<HRESULT>(0x80000000u | (facility << 16) | code));
      require(std::find(overlay_driver_hresult_classes.begin(), overlay_driver_hresult_classes.end(), bucket) != overlay_driver_hresult_classes.end(), "overlay-driver.hresult-classes-are-buckets");
    }
    for (const auto code : {static_cast<HRESULT>(UIA_E_TIMEOUT), RPC_E_TIMEOUT, HRESULT_FROM_WIN32(ERROR_TIMEOUT)}) require(overlay_driver_hresult_class(code) == L"timeout", "overlay-driver.hresult-timeouts-precede-rpc");
    for (const auto code : {RPC_E_DISCONNECTED, RPC_E_CALL_REJECTED, HRESULT_FROM_WIN32(RPC_S_SERVER_UNAVAILABLE), HRESULT_FROM_WIN32(RPC_S_CALL_FAILED), HRESULT_FROM_WIN32(RPC_S_CALL_FAILED_DNE)}) require(overlay_driver_hresult_class(code) == L"rpc", "overlay-driver.hresult-rpc-bucket");
    for (const auto code : {static_cast<HRESULT>(UIA_E_ELEMENTNOTAVAILABLE), HRESULT_FROM_WIN32(ERROR_NOT_FOUND), HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND), HRESULT_FROM_WIN32(ERROR_PATH_NOT_FOUND), HRESULT_FROM_WIN32(ERROR_INVALID_WINDOW_HANDLE)}) require(overlay_driver_hresult_class(code) == L"not_found", "overlay-driver.hresult-not-found-bucket");
    for (const auto code : {E_FAIL, E_INVALIDARG, E_OUTOFMEMORY, S_OK, S_FALSE}) require(overlay_driver_hresult_class(code) == L"other", "overlay-driver.hresult-other-bucket");
    require(overlay_driver_hresult_class(E_ACCESSDENIED) == L"access_denied", "overlay-driver.hresult-access-denied-bucket");
  });
  return count;
}
}
