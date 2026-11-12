#include "capture_worker_protocol.h"
#include "capture_worker.h"
#include <algorithm>
#include <array>
#include <functional>
#include <limits>
#include <stdexcept>
#include <vector>

namespace vector::computer {
namespace {
void check(bool value, const char* label) { if (!value) throw std::runtime_error(label); }
WindowsOwner worker_owner(DWORD pid, uint64_t created) {
  WindowsOwner value;
  value.identity.kind = WindowsAppKind::exe; value.identity.aumid = L"Sample.App"; value.identity.publisher = L"Publisher";
  value.identity.product = L"Product"; value.identity.binary = L"sample.exe"; value.identity.name = L"Sample";
  value.identity.exe = LR"(C:\Apps\sample.exe)"; value.identity.system = false; value.identity.verified = true; value.identity.pid = pid;
  value.process.pid = pid; value.process.creation_time = created;
  auto& image = value.process.image; image.path = value.identity.exe; image.volume = 7; image.id[0] = 1; image.size = 100;
  image.created = 2; image.modified = 3; image.sha256[0] = 4; image.signature = SignatureState::valid; image.signer_subject = {5, 6};
  auto& token = value.process.token; token.user = {1, 2}; token.logon = {3, 4}; token.authentication = 5; token.session = 6;
  token.integrity = SECURITY_MANDATORY_MEDIUM_RID; token.elevated = token.ui_access = token.app_container = false;
  value.process.package = WindowsPackageEvidence{L"Sample.App", L"Sample_family", L"Sample_full", LR"(C:\Apps)", WindowsPackageTrust::store, false};
  return value;
}
WindowsWindow worker_window() {
  WindowsWindow value; value.hwnd = reinterpret_cast<HWND>(uintptr_t(100)); value.surface = reinterpret_cast<HWND>(uintptr_t(101));
  value.thread_id = 10; value.surface_thread_id = 11; value.physical_owner = worker_owner(20, 30); value.owner = worker_owner(21, 31);
  value.bounds = {-12, -8, 100, 80}; value.surface_bounds = {-10, -6, 90, 70}; value.window_class = L"SyntheticWindow";
  value.host_aumid = L"Synthetic.Host"; value.child_shell = false; value.visible = value.on_screen = value.current_desktop = true;
  value.minimized = value.cloaked = value.elevated = false; return value;
}
CaptureWorkerRequest worker_request() {
  CaptureWorkerNonce nonce{}; nonce[0] = 1; nonce[31] = 9;
  const auto deadline = capture_worker_deadline(100, 1000); check(deadline.has_value(), "capture.worker-fixture-deadline");
  const auto value = capture_worker_request(worker_window(), {-12, -8, 100, 80}, {-10, -6, 20, 10}, 90, 5, nonce, *deadline);
  check(value.has_value(), "capture.worker-fixture-request"); return *value;
}
CaptureWorkerOutput worker_output(const CaptureWorkerRequest& request) {
  return {CaptureWorkerStatus::complete, CaptureReadPhase::none, request.nonce, request.target.binding, request.extent};
}
CaptureWorkerParentFacts worker_parent() {
  CaptureWorkerParentFacts value; value.expected_pid = value.actual_pid = value.held_pid = 100; value.child_pid = 101;
  value.expected_created = value.held_created = 10; value.child_created = 11; value.same_parent_object = value.parent_alive = true;
  value.parent = worker_owner(100, 10); value.child = worker_owner(101, 11);
  value.parent.process.image.path = value.child.process.image.path = LR"(C:\Vector\resources\computer\vector-computer.exe)";
  return value;
}
}
size_t run_capture_worker_tests() {
  size_t groups = 0;
  const auto test = [&](const auto& work) { work(); ++groups; };
  test([] {
    const std::vector<std::wstring> valid{L"--computer-capture-worker", L"--parent-pid", L"42",
      L"--request-mapping", L"64", L"--output-mapping", L"68", L"--parent-witness", L"72",
      L"--cancel-event", L"76", L"--capture-nonce", std::wstring(64, L'a')};
    const auto parsed = parse_capture_worker(valid);
    check(parsed && parsed->parent == 42 && parsed->request_mapping == 64 && parsed->output_mapping == 68 &&
      parsed->parent_witness == 72 && parsed->cancel_event == 76, "capture.worker-private-mode-exact-inherited-handle-schema");
    for (const auto value : {L"0", L"042", L"-1", L"4294967296", L"18446744073709551616"}) {
      auto args = valid; args[2] = value;
      check(!parse_capture_worker(args), "capture.worker-private-parent-canonical-dword-only");
    }
    for (const auto index : {size_t(4), size_t(6), size_t(8), size_t(10)}) {
      for (const auto value : {L"0", L"064", L"-1", L"18446744073709551615", L"18446744073709551616"}) {
        auto args = valid; args[index] = value;
        check(!parse_capture_worker(args), "capture.worker-private-handle-canonical-nonzero-only");
      }
    }
    for (const auto index : {size_t(6), size_t(8), size_t(10)}) {
      auto args = valid; args[index] = valid[4];
      check(!parse_capture_worker(args), "capture.worker-private-handle-alias-refused");
    }
    for (const auto nonce : {std::wstring(64, L'0'), std::wstring(64, L'A'), std::wstring(63, L'a'), std::wstring(65, L'a')}) {
      auto args = valid; args[12] = nonce;
      check(!parse_capture_worker(args), "capture.worker-private-nonce-exact-lowercase-nonzero");
    }
    for (const auto extra : {L"--stdio", L"--no-sandbox", L"--budget=10000", LR"(--target=C:\other.exe)"}) {
      auto args = valid; args.push_back(extra);
      check(!parse_capture_worker(args), "capture.worker-private-mode-has-no-arbitrary-resource-or-budget");
    }
    auto reordered = valid; std::swap(reordered[3], reordered[5]);
    check(!parse_capture_worker(reordered), "capture.worker-private-mode-canonical-order-only");
  });
  test([] {
    const auto value = capture_worker_deadline(100, 1000); check(value && *value == CaptureWorkerDeadline{100, 850, 1000}, "capture.worker-deadline-exact-original-750");
    check(capture_worker_deadline_current(*value, 100, 1000) && capture_worker_deadline_current(*value, 849, 1000), "capture.worker-deadline-before-expiry");
    check(!capture_worker_deadline_current(*value, 850, 1000) && !capture_worker_deadline_current(*value, 851, 1000), "capture.worker-deadline-exact-expiry-refused");
    check(!capture_worker_deadline_current(*value, 99, 1000) && !capture_worker_deadline_current(*value, 100, 1001), "capture.worker-deadline-backward-frequency-refused");
    auto renewed = *value; ++renewed.expires; check(!capture_worker_deadline_current(renewed, 100, 1000), "capture.worker-deadline-renewal-malformed");
    renewed = *value; --renewed.expires; check(!capture_worker_deadline_current(renewed, 100, 1000), "capture.worker-deadline-truncation-malformed");
    check(capture_worker_remaining_ms(*value, 100, 1000) == 750 && capture_worker_remaining_ms(*value, 101, 1000) == 749 &&
      capture_worker_remaining_ms(*value, 849, 1000) == 1 && capture_worker_remaining_ms(*value, 850, 1000) == 0, "capture.worker-remaining-original-not-renewed");
  });
  test([] {
    check(!capture_worker_deadline(0, 0) && !capture_worker_deadline(0, 1), "capture.worker-deadline-zero-ticks-refused");
    const auto low = capture_worker_deadline(0, 3); check(low && low->expires == 2 && capture_worker_remaining_ms(*low, 0, 3) == 666, "capture.worker-deadline-floor-low-frequency");
    const auto maximum = static_cast<uint64_t>(std::numeric_limits<int64_t>::max());
    const auto ticks = (maximum / 4) * 3 + ((maximum % 4) * 3) / 4;
    const auto edge = capture_worker_deadline(maximum - ticks, maximum);
    check(edge && edge->expires == maximum && capture_worker_remaining_ms(*edge, edge->started, maximum) == 749, "capture.worker-deadline-no-large-multiply-overflow");
    check(!capture_worker_deadline(maximum - ticks + 1, maximum) && !capture_worker_deadline(0, maximum + 1) &&
      !capture_worker_deadline(std::numeric_limits<uint64_t>::max(), 1000), "capture.worker-deadline-overflow-refused");
  });
  test([] {
    const auto largest = capture_worker_extent({-100, -100, 8192, 8192});
    check(largest && largest->bytes == capture_worker_max_bytes && largest->stride == 32768, "capture.worker-extent-64mp-256mib");
    check(capture_worker_extent({0, 0, 32768, 1}).has_value(), "capture.worker-extent-supported-edge-width");
    for (const auto crop : std::array{WindowsRect{0, 0, 0, 1}, WindowsRect{0, 0, -1, 1}, WindowsRect{0, 0, 32769, 1},
      WindowsRect{0, 0, 8193, 8192}, WindowsRect{std::numeric_limits<int64_t>::max(), 0, 2, 2}, WindowsRect{0, 0, 1, std::numeric_limits<int64_t>::max()}})
      check(!capture_worker_extent(crop), "capture.worker-extent-invalid-overflow-or-cap");
  });
  test([] {
    const auto request = worker_request(); const auto bytes = encode_capture_worker_request(request);
    check(bytes && bytes->size() == 320 && (*bytes)[0] == 'C' && (*bytes)[1] == 'W' && (*bytes)[2] == 'Q' && (*bytes)[3] == '1', "capture.worker-request-fixed-little-endian-domain");
    const auto decoded = decode_capture_worker_request(*bytes); check(decoded && decoded->deadline == request.deadline && decoded->nonce == request.nonce &&
      decoded->parent_pid == request.parent_pid && decoded->parent_created == request.parent_created && decoded->extent == request.extent &&
      capture_worker_target_matches(decoded->target, worker_window(), request.target.frame), "capture.worker-request-full-roundtrip");
    const auto again = encode_capture_worker_request(*decoded); check(again && *again == *bytes, "capture.worker-request-canonical-roundtrip");
    check(!decode_capture_worker_request(std::span<const uint8_t>(*bytes).first(319)), "capture.worker-request-truncated-refused");
    std::vector<uint8_t> appended(bytes->begin(), bytes->end()); appended.push_back(0); check(!decode_capture_worker_request(appended), "capture.worker-request-trailing-byte-refused");
  });
  test([] {
    const auto original = *encode_capture_worker_request(worker_request());
    for (const auto offset : std::array<size_t, 11>{0, 4, 6, 8, 12, 300, 301, 303, 312, 315, 319}) {
      auto bytes = original; bytes[offset] ^= 1; check(!decode_capture_worker_request(bytes), "capture.worker-request-magic-version-size-reserved-refused");
    }
    auto bytes = original; std::fill(bytes.begin() + 16, bytes.begin() + 48, uint8_t(0)); check(!decode_capture_worker_request(bytes), "capture.worker-request-zero-nonce-refused");
    bytes = original; std::fill(bytes.begin() + 48, bytes.begin() + 80, uint8_t(0)); check(!decode_capture_worker_request(bytes), "capture.worker-request-zero-binding-refused");
    for (const auto offset : std::array<size_t, 3>{88, 280, 292}) { bytes = original; bytes[offset] ^= 1; check(!decode_capture_worker_request(bytes), "capture.worker-request-deadline-extent-inconsistency-refused"); }
  });
  test([] {
    const auto original = worker_request();
    const std::vector<std::function<void(CaptureWorkerRequest&)>> mutate{
      [](auto& r) { r.parent_pid = 0; }, [](auto& r) { r.parent_created = 0; }, [](auto& r) { r.target.root_hwnd = 0; }, [](auto& r) { r.target.surface_hwnd = 0; },
      [](auto& r) { r.target.root_pid = 0; }, [](auto& r) { r.target.logical_pid = 0; }, [](auto& r) { r.target.root_created = 0; }, [](auto& r) { r.target.logical_created = 0; },
      [](auto& r) { r.target.root_thread = 0; }, [](auto& r) { r.target.logical_thread = 0; }, [](auto& r) { r.target.bounds.width = 0; }, [](auto& r) { r.target.surface_bounds.height = 0; },
      [](auto& r) { r.target.crop.x = r.target.frame.x - 1; }, [](auto& r) { r.target.frame.width = 1; }, [](auto& r) { ++r.extent.bytes; }, [](auto& r) { ++r.extent.stride; }
    };
    for (const auto& change : mutate) { auto request = original; change(request); check(!capture_worker_request_valid(request) && !encode_capture_worker_request(request), "capture.worker-request-malformed-endpoint-or-extent-refused"); }
  });
  test([] {
    const auto request = worker_request(); const auto original = worker_window();
    const std::vector<std::function<void(WindowsWindow&)>> mutate{
      [](auto& w) { w.hwnd = reinterpret_cast<HWND>(uintptr_t(102)); }, [](auto& w) { w.surface = reinterpret_cast<HWND>(uintptr_t(102)); },
      [](auto& w) { ++w.thread_id; }, [](auto& w) { ++w.surface_thread_id; }, [](auto& w) { ++w.bounds.x; }, [](auto& w) { ++w.bounds.y; },
      [](auto& w) { ++w.bounds.width; }, [](auto& w) { ++w.bounds.height; }, [](auto& w) { ++w.surface_bounds.x; }, [](auto& w) { ++w.surface_bounds.y; },
      [](auto& w) { ++w.surface_bounds.width; }, [](auto& w) { ++w.surface_bounds.height; }, [](auto& w) { w.window_class += L"x"; },
      [](auto& w) { w.host_aumid.reset(); }, [](auto& w) { *w.host_aumid += L"x"; }, [](auto& w) { w.child_shell.reset(); }, [](auto& w) { w.child_shell = true; },
      [](auto& w) { w.visible = false; }, [](auto& w) { w.minimized = true; }, [](auto& w) { w.on_screen = false; }, [](auto& w) { w.cloaked = true; },
      [](auto& w) { w.current_desktop = false; }, [](auto& w) { w.elevated = true; }
    };
    for (const auto& change : mutate) { auto window = original; change(window); check(!capture_worker_target_matches(request.target, window, request.target.frame), "capture.worker-binding-window-field-drift-refused"); }
    auto frame = request.target.frame; ++frame.x; check(!capture_worker_target_matches(request.target, original, frame), "capture.worker-binding-frame-drift-refused");
    auto changed = request.target; --changed.crop.width; check(!capture_worker_target_matches(changed, original, request.target.frame), "capture.worker-binding-crop-drift-refused");
    changed = request.target; changed.binding[0] ^= 1; check(!capture_worker_target_matches(changed, original, request.target.frame), "capture.worker-binding-digest-drift-refused");
  });
  test([] {
    const auto request = worker_request();
    const std::vector<std::function<void(WindowsOwner&)>> mutate{
      [](auto& o) { o.identity.kind = WindowsAppKind::aumid; }, [](auto& o) { o.identity.aumid += L"x"; }, [](auto& o) { o.identity.publisher += L"x"; },
      [](auto& o) { o.identity.product += L"x"; }, [](auto& o) { o.identity.binary += L"x"; }, [](auto& o) { o.identity.name += L"x"; }, [](auto& o) { o.identity.exe += L"x"; },
      [](auto& o) { o.identity.system = true; }, [](auto& o) { o.identity.verified = false; }, [](auto& o) { o.identity.pid.reset(); }, [](auto& o) { ++*o.identity.pid; },
      [](auto& o) { ++o.process.pid; }, [](auto& o) { ++o.process.creation_time; }, [](auto& o) { o.process.image.path += L"x"; }, [](auto& o) { ++o.process.image.volume; },
      [](auto& o) { ++o.process.image.id[0]; }, [](auto& o) { ++o.process.image.size; }, [](auto& o) { ++o.process.image.created; }, [](auto& o) { ++o.process.image.modified; },
      [](auto& o) { ++o.process.image.sha256[0]; }, [](auto& o) { o.process.image.signature = SignatureState::unsigned_file; }, [](auto& o) { o.process.image.signer_subject.push_back(9); },
      [](auto& o) { o.process.token.user.push_back(9); }, [](auto& o) { o.process.token.logon.push_back(9); }, [](auto& o) { ++o.process.token.authentication; },
      [](auto& o) { ++o.process.token.session; }, [](auto& o) { ++o.process.token.integrity; }, [](auto& o) { o.process.token.elevated = true; },
      [](auto& o) { o.process.token.ui_access = true; }, [](auto& o) { o.process.token.app_container = true; }, [](auto& o) { o.process.package.reset(); },
      [](auto& o) { o.process.package->aumid += L"x"; }, [](auto& o) { o.process.package->family += L"x"; }, [](auto& o) { o.process.package->full_name += L"x"; },
      [](auto& o) { o.process.package->path += L"x"; }, [](auto& o) { o.process.package->trust = WindowsPackageTrust::developer; }, [](auto& o) { o.process.package->development_mode = true; }
    };
    for (const bool physical : {false, true}) for (const auto& change : mutate) {
      auto window = worker_window(); change(physical ? window.physical_owner : window.owner);
      check(!capture_worker_target_matches(request.target, window, request.target.frame), "capture.worker-binding-every-owner-process-image-token-package-identity-field-refused");
    }
    auto window = worker_window(); window.owner.identity.aumid = L"ab"; window.owner.identity.publisher = L"c";
    const auto a = capture_worker_binding(window, request.target.frame, request.target.crop); window.owner.identity.aumid = L"a"; window.owner.identity.publisher = L"bc";
    const auto b = capture_worker_binding(window, request.target.frame, request.target.crop); check(a && b && *a != *b, "capture.worker-binding-length-delimited-not-concatenated");
    window = worker_window(); window.window_class.resize(1024 * 1024, L'x'); check(!capture_worker_binding(window, request.target.frame, request.target.crop), "capture.worker-binding-bounded-canonical-memory");
  });
  test([] {
    const auto request = worker_request(); const auto output = worker_output(request); const auto bytes = encode_capture_worker_output(output);
    check(bytes && bytes->size() == 96 && (*bytes)[0] == 'C' && (*bytes)[2] == 'O', "capture.worker-output-fixed-header-domain");
    const auto decoded = decode_capture_worker_output(*bytes); check(decoded && decoded->nonce == request.nonce && decoded->binding == request.target.binding && decoded->extent == request.extent, "capture.worker-output-roundtrip");
    check(!decode_capture_worker_output(std::span<const uint8_t>(*bytes).first(95)), "capture.worker-output-truncated-refused");
    std::vector<uint8_t> extended(bytes->begin(), bytes->end()); extended.push_back(0); check(!decode_capture_worker_output(extended), "capture.worker-output-trailing-refused");
    for (const auto offset : std::array<size_t, 7>{0, 4, 6, 8, 12, 88, 92}) { auto changed = *bytes; changed[offset] ^= offset == 8 ? 4 : 1; check(!decode_capture_worker_output(changed), "capture.worker-output-invalid-metadata-refused"); }
  });
  test([] {
    const auto request = worker_request(); const auto output = worker_output(request); const auto length = capture_worker_output_header_bytes + request.extent.bytes;
    check(capture_worker_accept(request, output, length, true, 0, true, 849, 1000), "capture.worker-admits-current-exited-complete-exact-output");
    check(!capture_worker_accept(request, output, length, false, 0, true, 849, 1000), "capture.worker-live-child-never-admitted");
    check(!capture_worker_accept(request, output, length, true, 1, true, 849, 1000), "capture.worker-nonzero-exit-never-admitted");
    check(!capture_worker_accept(request, output, length, true, 0, false, 849, 1000), "capture.worker-revoked-authority-never-admitted");
    check(!capture_worker_accept(request, output, length, true, 0, true, 850, 1000) && !capture_worker_accept(request, output, length, true, 0, true, 851, 1000), "capture.worker-late-cleanup-copy-exit-never-admitted");
    check(!capture_worker_accept(request, output, length - 1, true, 0, true, 849, 1000) && !capture_worker_accept(request, output, length + 1, true, 0, true, 849, 1000), "capture.worker-output-exact-admitted-mapping-length");
    auto changed = output; changed.nonce[0] ^= 1; check(!capture_worker_accept(request, changed, length, true, 0, true, 849, 1000), "capture.worker-stale-ticket-never-admitted");
    changed = output; changed.binding[31] ^= 1; check(!capture_worker_accept(request, changed, length, true, 0, true, 849, 1000), "capture.worker-wrong-target-never-admitted");
    changed = output; ++changed.extent.bytes; check(!capture_worker_accept(request, changed, length, true, 0, true, 849, 1000), "capture.worker-wrong-extent-never-admitted");
    changed = output; changed.status = CaptureWorkerStatus::pending; check(!capture_worker_accept(request, changed, length, true, 0, true, 849, 1000), "capture.worker-partial-result-never-admitted");
    changed.status = CaptureWorkerStatus::failed; check(!capture_worker_accept(request, changed, length, true, 0, true, 849, 1000), "capture.worker-failed-result-never-admitted");
  });
  test([] {
    const auto request = worker_request(); const auto output = worker_output(request); const auto length = capture_worker_output_header_bytes + request.extent.bytes;
    // Every intermediate phase consumes the SAME original ticket. A ready/frame reply is not a new admission.
    for (const auto now : std::array<uint64_t, 5>{100, 300, 500, 700, 849}) check(capture_worker_accept(request, output, length, true, 0, true, now, 1000), "capture.worker-original-ticket-valid-before-bound");
    for (const auto now : std::array<uint64_t, 3>{850, 900, 1599}) check(!capture_worker_accept(request, output, length, true, 0, true, now, 1000), "capture.worker-original-ticket-does-not-renew-after-phase");
    auto next = request; next.nonce[1] ^= 1; next.deadline = *capture_worker_deadline(850, 1000);
    check(!capture_worker_accept(next, output, length, true, 0, true, 851, 1000), "capture.worker-previous-response-cannot-fulfill-successor");
  });
  test([] {
    const auto original = worker_parent(); check(capture_worker_parent_allowed(original), "capture.worker-same-image-current-actual-parent-allowed");
    const std::vector<std::function<void(CaptureWorkerParentFacts&)>> mutate{
      [](auto& f) { ++f.actual_pid; }, [](auto& f) { ++f.held_pid; }, [](auto& f) { ++f.held_created; }, [](auto& f) { f.child_pid = f.expected_pid; },
      [](auto& f) { f.child_created = f.expected_created - 1; }, [](auto& f) { f.same_parent_object = false; }, [](auto& f) { f.parent_alive = false; },
      [](auto& f) { ++f.parent.process.creation_time; }, [](auto& f) { ++f.child.process.creation_time; }, [](auto& f) { ++f.parent.process.pid; }, [](auto& f) { ++f.child.process.pid; },
      [](auto& f) { f.parent.process.image.sha256[0] ^= 1; }, [](auto& f) { f.parent.process.image.path = f.child.process.image.path = LR"(C:\Other\not-the-helper.exe)"; },
      [](auto& f) { f.parent.process.image.signature = f.child.process.image.signature = SignatureState::invalid; },
      [](auto& f) { f.parent.process.token.elevated = true; }, [](auto& f) { f.child.process.token.ui_access = true; }, [](auto& f) { f.child.process.token.app_container = true; },
      [](auto& f) { ++f.child.process.token.session; }, [](auto& f) { f.child.process.token.logon.push_back(9); }, [](auto& f) { ++f.child.process.token.authentication; }
    };
    for (const auto& change : mutate) { auto facts = original; change(facts); check(!capture_worker_parent_allowed(facts), "capture.worker-parent-witness-token-image-substitution-refused"); }
    auto unsigned_image = original; unsigned_image.parent.process.image.signature = unsigned_image.child.process.image.signature = SignatureState::unsigned_file;
    unsigned_image.parent.process.image.signer_subject.clear(); unsigned_image.child.process.image.signer_subject.clear();
    check(capture_worker_parent_allowed(unsigned_image), "capture.worker-unsigned-same-actual-image-continuity-remains-supported");
  });
  test([] {
    for (const auto parent : {CaptureReadPhase::window_worker_wait, CaptureReadPhase::window_worker_exit}) {
      for (const auto phase : {CaptureReadPhase::window_worker_prepare, CaptureReadPhase::window_worker_auth,
          CaptureReadPhase::window_worker_target, CaptureReadPhase::window_worker_read, CaptureReadPhase::window_worker_reply,
          CaptureReadPhase::window_worker_cleanup})
        check(capture_worker_failure_checkpoint(parent, static_cast<uint32_t>(phase)) == phase, "capture.worker-failure-checkpoint-closed-metadata");
      for (const auto phase : {CaptureReadPhase::none, CaptureReadPhase::window_worker_wait, CaptureReadPhase::window_factory,
          CaptureReadPhase::context_after, CaptureReadPhase::count})
        check(!capture_worker_failure_checkpoint(parent, static_cast<uint32_t>(phase)), "capture.worker-failure-checkpoint-other-phases-refused");
      check(!capture_worker_failure_checkpoint(parent, std::numeric_limits<uint32_t>::max()), "capture.worker-failure-checkpoint-untrusted-range-refused");
    }
    for (uint32_t value = 0; value <= static_cast<uint32_t>(CaptureReadPhase::count); ++value) {
      const auto parent = static_cast<CaptureReadPhase>(value);
      if (parent == CaptureReadPhase::window_worker_wait || parent == CaptureReadPhase::window_worker_exit) continue;
      check(!capture_worker_failure_checkpoint(parent, static_cast<uint32_t>(CaptureReadPhase::window_worker_read)),
        "capture.worker-progress-cannot-override-success-or-specific-failure");
    }
    auto request = worker_request(); auto output = worker_output(request);
    output.status = CaptureWorkerStatus::pending; output.phase = CaptureReadPhase::window_worker_read;
    check(!capture_worker_accept(request, output, capture_worker_output_header_bytes + request.extent.bytes, false, 0, true, 200, 1000) &&
      !capture_worker_accept(request, output, capture_worker_output_header_bytes + request.extent.bytes, true, 0, true, 200, 1000),
      "capture.worker-checkpoint-never-substitutes-complete-exited-output");
  });
  return groups;
}
}
