#include "input_guardian.h"
#include <atomic>
#include <future>
#include <stdexcept>
#include <thread>

namespace vector::computer {
namespace {
constexpr uint64_t own_tag=0x0123456789abcdefULL;
void check(bool value,const char* label) { if (!value) throw std::runtime_error(label); }
InputRelease scan(WORD key=static_cast<WORD>('A'),WORD code=0x1e,bool extended=false) { return {InputReleaseKind::scan_key,key,code,extended,0}; }
InputRelease unicode(WORD unit=0x03c0) { return {InputReleaseKind::unicode_key,VK_PACKET,unit,false,0}; }
InputRelease mouse(uint8_t button=0) { return {InputReleaseKind::mouse_button,0,0,false,button}; }
InputGuardianEvent event(const InputRelease& release,bool down,uint64_t time=100) { return {release,own_tag,true,down,time}; }
InputGuardianTicket reserve(InputGuardianLedger& ledger,const InputRelease& release,bool diagnostic=false) {
  const auto ticket=ledger.reserve(release,diagnostic); check(ticket.has_value(),"guardian.synthetic-reservation"); return *ticket;
}
InputIoDeadlineSnapshot arm(InputIoDeadlineFence& fence,uint64_t deadline) {
  const auto observed=fence.arm(deadline); check(observed.has_value(),"guardian.io-generation-arms"); return *observed;
}
std::vector<std::wstring> args() {
  return {L"--computer-input-guardian",L"--parent-pid",L"42",L"--input-nonce",std::wstring(64,L'a'),L"--input-tag",L"0123456789abcdef",L"--shutdown-event",L"128"};
}
}

// Pure metadata, codec and CLI fixtures only. No process, pipe, hook, key, mouse or desktop operation runs.
size_t run_input_guardian_tests() {
  size_t groups=0; const auto test=[&](const auto& body) { body(); ++groups; };
  test([] {
    InputIoDeadlineFence fence; size_t cancellations=0;
    check(!fence.snapshot(),"guardian.io-unarmed-has-no-cancellation-target"); const auto observed=arm(fence,100);
    check(observed.generation!=0 && observed.deadline==100 && fence.snapshot()==observed,"guardian.io-snapshot-binds-generation-and-original-deadline");
    check(!fence.cancel_if_due(observed,99,false,[&] { ++cancellations; }) && cancellations==0,"guardian.io-current-unexpired-transfer-is-not-cancelled");
    check(fence.cancel_if_due(observed,100,false,[&] { ++cancellations; }) &&
          fence.cancel_if_due(observed,101,false,[&] { ++cancellations; }) && cancellations==2 && fence.snapshot()==observed,
          "guardian.io-current-expired-transfer-keeps-repeated-cancellation-without-renewal");
    check(fence.retire(observed) && !fence.snapshot() && !fence.retire(observed),"guardian.io-transfer-retirement-is-idempotent");
    check(!fence.cancel_if_due(observed,200,true,[&] { ++cancellations; }) && cancellations==2,"guardian.io-retired-transfer-cannot-cancel-anything");
  });
  test([] {
    InputIoDeadlineFence fence; size_t cancellations=0;
    const auto previous=arm(fence,100), delayed=*fence.snapshot();
    check(fence.retire(previous),"guardian.io-reply-completed-before-next-read"); const auto next=arm(fence,0);
    // Deterministic version of the timer being descheduled after sampling the previous reply.
    check(!fence.cancel_if_due(delayed,150,false,[&] { ++cancellations; }) && cancellations==0 && fence.snapshot()==next,
          "guardian.io-delayed-expired-reply-snapshot-cannot-cancel-successor-blocking-read");
    check(!fence.cancel_if_due(next,150,false,[&] { ++cancellations; }),"guardian.io-unbounded-read-does-not-inherit-previous-deadline");
    check(fence.cancel_if_due(next,150,true,[&] { ++cancellations; }) && cancellations==1,"guardian.io-close-still-cancels-the-active-unbounded-read");
  });
  test([] {
    InputIoDeadlineFence fence; size_t cancellations=0;
    const auto previous=arm(fence,100), next=arm(fence,100);
    check(previous.generation!=next.generation && previous.deadline==next.deadline,"guardian.io-same-deadline-successor-still-has-distinct-lineage");
    check(!fence.cancel_if_due(previous,100,true,[&] { ++cancellations; }) && !fence.retire(previous) && fence.snapshot()==next,
          "guardian.io-old-close-snapshot-or-retirement-cannot-touch-a-new-generation");
    check(fence.cancel_if_due(next,100,false,[&] { ++cancellations; }) && cancellations==1,"guardian.io-current-lineage-remains-cancellable");
  });
  test([] {
    InputIoDeadlineFence fence; size_t cancellations=0; const auto initial=arm(fence,0);
    // The existing first-partial-read rule arms its one absolute 100 ms boundary. Later samples
    // and cancellation attempts cannot move it, and the prior indefinite phase is no longer valid.
    const auto partial=arm(fence,1100);
    check(!fence.cancel_if_due(initial,2000,true,[&] { ++cancellations; }) &&
          !fence.cancel_if_due(partial,1099,false,[&] { ++cancellations; }) && fence.snapshot()==partial,
          "guardian.io-first-partial-budget-has-an-independent-fixed-generation");
    check(fence.cancel_if_due(partial,1100,false,[&] { ++cancellations; }) &&
          fence.cancel_if_due(partial,1200,false,[&] { ++cancellations; }) && cancellations==2 && partial.deadline==1100,
          "guardian.io-partial-deadline-is-not-renewed-by-repeated-observations");
  });
  test([] {
    InputIoDeadlineFence fence; size_t cancellations=0; const auto current=arm(fence,100);
    auto changed=current; ++changed.deadline;
    check(!fence.cancel_if_due(changed,200,true,[&] { ++cancellations; }) && !fence.retire(changed),"guardian.io-deadline-is-part-of-the-snapshot-identity");
    changed=current; ++changed.generation;
    check(!fence.cancel_if_due(changed,200,true,[&] { ++cancellations; }) && !fence.retire(changed),"guardian.io-unknown-generation-is-never-a-cancellation-target");
    check(!fence.cancel_if_due(InputIoDeadlineSnapshot{},200,true,[&] { ++cancellations; }) && cancellations==0 && fence.snapshot()==current,
          "guardian.io-default-snapshot-cannot-act-as-a-wildcard");
  });
  test([] {
    InputIoDeadlineFence fence; size_t cancellations=0; auto previous=arm(fence,50);
    for (uint64_t index=0; index<256; ++index) {
      check(fence.retire(previous),"guardian.io-sequential-transfer-retires-exact-owner"); const auto next=arm(fence,50);
      check(!fence.cancel_if_due(previous,100,true,[&] { ++cancellations; }) && fence.snapshot()==next,
            "guardian.io-repeated-successor-transfers-never-reuse-old-cancellation-proof"); previous=next;
    }
    check(cancellations==0 && fence.cancel_if_due(previous,100,true,[&] { ++cancellations; }) && cancellations==1,
          "guardian.io-only-the-final-live-transfer-can-be-cancelled");
  });
  test([] {
    InputIoDeadlineFence fence; const auto previous=arm(fence,100);
    std::promise<void> started; auto starting=started.get_future(); std::atomic<bool> finished{false};
    std::optional<InputIoDeadlineSnapshot> next; std::thread armer; bool serialized=false;
    const auto cancelled=fence.cancel_if_due(previous,100,false,[&] {
      armer=std::thread([&] { started.set_value(); next=fence.arm(200); finished.store(true); });
      starting.wait(); serialized=!finished.load();
    });
    armer.join();
    check(cancelled && serialized && finished.load() && next && fence.snapshot()==next,
          "guardian.io-successor-arm-cannot-pass-the-actual-cancellation-callback");
    size_t stale=0; check(!fence.cancel_if_due(previous,300,true,[&] { ++stale; }) && stale==0,
          "guardian.io-joined-concurrent-successor-keeps-its-own-lineage");
  });
  test([] {
    check(input_guardian_protocol_self_test(),"guardian.finite-authenticated-private-protocol");
    const auto value=parse_input_guardian(args());
    check(value && value->parent==42 && value->nonce==std::wstring(64,L'a') && value->tag==own_tag && value->shutdown_event==128,"guardian.strict-private-cli");
  });
  test([] {
    for (int field=0; field<16; ++field) {
      auto value=args();
      if (field==0) value[0]=L"--stdio";
      if (field==1) value[2]=L"0";
      if (field==2) value[2]=L"042";
      if (field==3) value[2]=L"4294967296";
      if (field==4) value[2]=L"-1";
      if (field==5) value[4]=std::wstring(64,L'A');
      if (field==6) value[4]=std::wstring(63,L'a');
      if (field==7) value[6]=std::wstring(16,L'0');
      if (field==8) value[6]=L"0123456789abcdeg";
      if (field==9) value.push_back(L"--target=C:\\unrelated.exe");
      if (field==10) value[7]=L"--event";
      if (field==11) value[8]=L"0";
      if (field==12) value[8]=L"0128";
      if (field==13) value[8]=L"18446744073709551615";
      if (field==14) value[8]=L"18446744073709551616";
      if (field==15) value.resize(7);
      check(!parse_input_guardian(value),"guardian.cli-never-selects-an-arbitrary-route-or-identity");
    }
    auto value=args(); std::swap(value[1],value[3]); check(!parse_input_guardian(value),"guardian.cli-order-is-finite");
  });
  test([] {
    InputGuardianLedger ledger(own_tag); const auto ticket=reserve(ledger,scan());
    check(!ledger.pending() && ledger.releases().empty() && ledger.released_count()==0 &&
          !ledger.observed(ticket,true) && !ledger.observed(ticket,false),"guardian.reservation-alone-never-authorizes-up");
    check(!ledger.observe(event(scan(),false)) && ledger.releases().empty(),"guardian.unpaired-up-cannot-create-proof");
  });
  test([] {
    InputGuardianLedger ledger(own_tag); const auto ticket=reserve(ledger,scan());
    auto foreign=event(scan(),true); foreign.tag=own_tag+1;
    check(!ledger.observe(foreign),"guardian.foreign-tag-is-not-owned");
    foreign.tag=own_tag; foreign.injected=false;
    check(!ledger.observe(foreign) && !ledger.pending() && ledger.releases().empty() && !ledger.observed(ticket,true),"guardian.physical-down-is-not-owned-even-with-matching-extra-info");
  });
  test([] {
    InputGuardianLedger ledger(own_tag); const auto descriptor=scan(); const auto ticket=reserve(ledger,descriptor);
    check(ledger.observe(event(descriptor,true)) && ledger.observed(ticket,true) && ledger.pending(),"guardian.actual-tagged-down-creates-cleanup-obligation");
    check(ledger.releases()==std::vector{ticket} && ledger.released_count()==0,"guardian.only-the-exact-observed-release-is-exposed");
    check(ledger.observe(event(descriptor,false)) && ledger.observed(ticket,false) && !ledger.pending() && ledger.releases().empty() && ledger.released_count()==1,"guardian.actual-tagged-up-retires-obligation");
    check(!ledger.observe(event(descriptor,false)) && !ledger.observe(event(descriptor,true)) && ledger.released_count()==1,"guardian.completed-ticket-cannot-rearm-or-double-count");
  });
  test([] {
    InputGuardianLedger ledger(own_tag); const auto descriptor=scan(); const auto ticket=reserve(ledger,descriptor);
    ledger.retire(ticket,false);
    check(!ledger.reserve(descriptor) && !ledger.pending() && ledger.releases(true).empty(),"guardian.uncertain-unobserved-ticket-is-quarantined-without-up-authority");
    check(ledger.observe(event(descriptor,true)) && ledger.releases(true)==std::vector{ticket},"guardian.late-actual-own-down-is-release-only");
    check(ledger.observe(event(descriptor,false)) && ledger.observed(ticket,false) && ledger.releases().empty(),"guardian.late-release-preserves-completion-proof");
    const auto successor=reserve(ledger,descriptor); check(successor.id!=ticket.id,"guardian.quarantine-does-not-reuse-ticket-lineage");
  });
  test([] {
    InputGuardianLedger ledger(own_tag); const auto descriptor=scan(); const auto ticket=reserve(ledger,descriptor);
    ledger.retire(ticket,true); const auto successor=reserve(ledger,descriptor);
    check(successor.id!=ticket.id && !ledger.observed(ticket,true) && !ledger.observed(ticket,false) && ledger.releases().empty(),"guardian.trusted-no-call-can-free-reservation-but-never-invents-up-proof");
    ledger.retire(ticket,true); check(!ledger.reserve(descriptor),"guardian.old-retirement-cannot-erase-successor-reservation");
  });
  test([] {
    InputGuardianLedger ledger(own_tag); const auto descriptor=scan(); const auto ticket=reserve(ledger,descriptor);
    check(ledger.observe(event(descriptor,true)),"guardian.actual-down-before-cancel");
    ledger.retire(ticket,true);
    check(ledger.pending() && ledger.releases(true)==std::vector{ticket} && !ledger.reserve(descriptor),"guardian-no-call-claim-never-drops-an-already-observed-down");
  });
  test([] {
    InputGuardianLedger ledger(own_tag); const auto a=reserve(ledger,scan()),control=reserve(ledger,scan(VK_LCONTROL,0x1d));
    check(ledger.observe(event(control.release,true,100)) && ledger.observe(event(a.release,true,101)),"guardian.actual-post-order");
    check(ledger.releases()==std::vector{a,control},"guardian.cleanup-reverses-actual-down-order-not-reservation-order");
  });
  test([] {
    InputGuardianLedger ledger(own_tag); const auto descriptor=scan(); const auto ticket=reserve(ledger,descriptor);
    for (int field=0; field<4; ++field) {
      auto altered=ticket;
      if (field==0) ++altered.id;
      if (field==1) ++altered.release.virtual_key;
      if (field==2) ++altered.release.scan;
      if (field==3) altered.release.extended=true;
      ledger.retire(altered,true);
      check(!ledger.observed(altered,true) && !ledger.observed(altered,false),"guardian.ticket-fields-do-not-retarget");
    }
    check(ledger.observe(event(descriptor,true)) && ledger.releases()==std::vector{ticket},"guardian.original-private-descriptor-retained");
  });
  test([] {
    InputGuardianLedger ledger(own_tag); const auto ticket=reserve(ledger,scan());
    for (const auto altered : {scan(static_cast<WORD>('B'),0x1e),scan(static_cast<WORD>('A'),0x30),scan(static_cast<WORD>('A'),0x1e,true),unicode(),mouse()})
      check(!ledger.observe(event(altered,true)),"guardian.unreserved-or-replaced-event-cannot-own-a-release");
    check(!ledger.pending() && !ledger.observed(ticket,true),"guardian.no-descriptor-fallback");
  });
  test([] {
    InputGuardianLedger ledger(own_tag); const auto ticket=reserve(ledger,unicode());
    check(ledger.observe(event(unicode(),true)) && ledger.releases()==std::vector{ticket},"guardian.actual-vk-packet-utf16-scan-proof");
    check(!ledger.observe(event(unicode(0x03c1),false)),"guardian.unicode-unit-must-match-exactly");
    check(ledger.observe(event(unicode(),false)) && ledger.released_count()==1,"guardian.matching-unicode-up");
  });
  test([] {
    InputGuardianLedger ledger(own_tag); std::vector<InputGuardianTicket> keys;
    for (WORD code=1; code<=128; ++code) keys.push_back(reserve(ledger,unicode(code)));
    check(!ledger.reserve(unicode(129)),"guardian.keyboard-reservation-cap");
    for (uint8_t button=0; button<3; ++button) (void)reserve(ledger,mouse(button));
    check(!ledger.reserve(mouse(3)),"guardian.only-explicit-supported-mouse-buttons");
    check(ledger.releases().empty(),"guardian-full-reservation-catalog-still-grants-zero-ups");
    ledger.retire(keys.front(),true); check(ledger.reserve(unicode(129)).has_value(),"guardian.definitive-no-post-retires-bounded-slot");
  });
  test([] {
    InputGuardianLedger ledger(own_tag);
    for (const auto value : {InputRelease{},scan(0,1),scan(VK_PACKET,1),scan(1,0),scan(1,0x100),
        InputRelease{InputReleaseKind::unicode_key,0,1,false,0},InputRelease{InputReleaseKind::unicode_key,VK_PACKET,1,true,0},
        InputRelease{InputReleaseKind::mouse_button,1,0,false,0},InputRelease{static_cast<InputReleaseKind>(99),0,0,false,0}})
      check(!ledger.reserve(value) && !ledger.observe(event(value,true)),"guardian.invalid-release-descriptors-have-no-authority");
    InputGuardianLedger unarmed(0); check(!unarmed.reserve(scan()),"guardian.zero-tag-is-never-armed");
  });
  test([] {
    InputGuardianLedger ledger(own_tag); const auto ticket=reserve(ledger,scan()); ledger.close();
    check(!ledger.reserve(unicode()),"guardian.close-cannot-grant-new-reservations");
    check(ledger.observe(event(ticket.release,true)) && ledger.releases()==std::vector{ticket},"guardian-parentdeath-still-observes-prior-reservations-late-downs");
    check(ledger.observe(event(ticket.release,false)) && !ledger.pending(),"guardian.cleanup-survives-authority-close");
  });
  test([] {
    InputGuardianLedger ledger(own_tag); const auto ticket=reserve(ledger,scan());
    check(ledger.observe(event(ticket.release,true,100)),"guardian.hard-duration-observation");
    check(ledger.releases(true,10'099).empty() && ledger.releases(true,10'100)==std::vector{ticket},"guardian.hard-ten-seconds-independent-of-parent-timers");
    check(!ledger.observe(event(ticket.release,true,10'000)) && ledger.releases(true,10'100)==std::vector{ticket},"guardian-repeat-does-not-extend-owned-hold-cap");
    check(ledger.releases(true,99).empty(),"guardian.clock-underflow-cannot-invent-expiry");
  });
  test([] {
    InputGuardianLedger ledger(own_tag); const auto descriptor=scan(); InputGuardianTicket first{},latest{};
    for (int index=0; index<140; ++index) {
      const auto ticket=reserve(ledger,descriptor); if (index==0) first=ticket; latest=ticket;
      check(ledger.observe(event(descriptor,true)) && ledger.observe(event(descriptor,false)),"guardian.actual-completed-pair"); ledger.retire(ticket);
    }
    check(!ledger.observed(first,false) && ledger.observed(latest,false) && ledger.releases().empty() && ledger.released_count()==140,"guardian.completed-history-is-bounded-proof-never-release-authority");
  });
  test([] {
    InputGuardianLedger ledger(own_tag); const auto ticket=reserve(ledger,scan());
    check(ledger.observe(event(ticket.release,true)),"guardian.own-down-before-foreign-up");
    auto physical=event(ticket.release,false); physical.injected=false;
    check(!ledger.observe(physical) && ledger.pending(),"guardian.foreign-physical-up-is-not-an-owned-completion-receipt");
    physical.injected=true; physical.tag=own_tag+1;
    check(!ledger.observe(physical) && !ledger.observed(ticket,false),"guardian.foreign-tag-up-cannot-retire-owned-obligation");
  });
  test([] {
    InputGuardianReceiptEvidence evidence;
    evidence.own_move=true; evidence.own_up=true; evidence.own_down_refused=true;
    check(input_guardian_receipt_diagnostic(evidence,100,200)==InputGuardianReceiptDiagnostic::none,"guardian.diagnostic-evidence-is-inert-without-opt-in");
    evidence={true,false,false,false};
    check(input_guardian_receipt_diagnostic(evidence,100,100)==InputGuardianReceiptDiagnostic::no_callback_pump_stalled &&
          input_guardian_receipt_diagnostic(evidence,100,101)==InputGuardianReceiptDiagnostic::no_callback_pump_progressed &&
          input_guardian_receipt_diagnostic(evidence,100,99)==InputGuardianReceiptDiagnostic::no_callback_pump_stalled,
          "guardian.diagnostic-pump-snapshot-is-monotonic-without-underflow");
    evidence.own_move=true;
    check(input_guardian_receipt_diagnostic(evidence,100,100)==InputGuardianReceiptDiagnostic::own_move_only,"guardian.diagnostic-own-move-precedes-pump-only-bucket");
    evidence.own_up=true;
    check(input_guardian_receipt_diagnostic(evidence,100,200)==InputGuardianReceiptDiagnostic::own_up_only,"guardian.diagnostic-own-up-is-not-misreported-as-move-only");
    evidence.own_down_refused=true;
    check(input_guardian_receipt_diagnostic(evidence,100,200)==InputGuardianReceiptDiagnostic::own_down_refused,"guardian.diagnostic-refused-down-has-precedence-over-move-and-up");
  });
  test([] {
    InputGuardianLedger ledger(own_tag); const auto ticket=reserve(ledger,mouse());
    InputGuardianReceiptDiagnostic diagnostic=InputGuardianReceiptDiagnostic::own_down_refused;
    ledger.observe_move(own_tag,true);
    check(!ledger.diagnostics_enabled() && !ledger.observed(ticket,true,&diagnostic,100,200) && diagnostic==InputGuardianReceiptDiagnostic::none,
          "guardian.ordinary-reservation-does-not-enable-or-return-diagnostics");
    check(!ledger.observe(event(ticket.release,false)) && !ledger.observed(ticket,true,&diagnostic,100,200) && diagnostic==InputGuardianReceiptDiagnostic::none,
          "guardian.ordinary-own-callbacks-still-have-zero-diagnostic-field");
    check(!ledger.pending() && ledger.releases().empty() && ledger.released_count()==0,"guardian.diagnostics-do-not-invent-obligations-or-success");
  });
  test([] {
    InputGuardianLedger ledger(own_tag); const auto ticket=reserve(ledger,mouse(),true);
    InputGuardianReceiptDiagnostic diagnostic;
    auto foreign=event(ticket.release,true); foreign.injected=false;
    check(!ledger.observe(foreign),"guardian.diagnostic-physical-callback-still-refused");
    foreign.injected=true; foreign.tag=own_tag+1;
    check(!ledger.observe(foreign),"guardian.diagnostic-foreign-tag-still-refused");
    ledger.observe_move(own_tag,false); ledger.observe_move(own_tag+1,true);
    check(!ledger.observed(ticket,true,&diagnostic,100,100) && diagnostic==InputGuardianReceiptDiagnostic::no_callback_pump_stalled,
          "guardian.diagnostics-never-record-hardware-or-other-tags");
    check(!ledger.observed(ticket,true,&diagnostic,100,101) && diagnostic==InputGuardianReceiptDiagnostic::no_callback_pump_progressed,
          "guardian.no-own-callback-can-report-only-existing-pump-progress");
  });
  test([] {
    InputGuardianLedger ledger(own_tag); ledger.observe_move(own_tag,true);
    const auto ticket=reserve(ledger,mouse(),true), ordinary=reserve(ledger,mouse(1)), key=reserve(ledger,scan(),true);
    InputGuardianReceiptDiagnostic diagnostic;
    check(!ledger.observed(ticket,true,&diagnostic,100,100) && diagnostic==InputGuardianReceiptDiagnostic::no_callback_pump_stalled,
          "guardian.pre-reservation-move-cannot-contaminate-new-ticket");
    ledger.observe_move(own_tag,true);
    check(!ledger.observed(ticket,true,&diagnostic,100,200) && diagnostic==InputGuardianReceiptDiagnostic::own_move_only,
          "guardian.own-injected-move-is-metadata-without-down-proof");
    check(!ledger.observed(ordinary,true,&diagnostic,100,200) && diagnostic==InputGuardianReceiptDiagnostic::none,
          "guardian.own-move-diagnostics-stay-opted-in");
    check(!ledger.observed(key,true,&diagnostic,100,200) && diagnostic==InputGuardianReceiptDiagnostic::no_callback_pump_progressed,
          "guardian.mouse-move-does-not-contaminate-key-reservation");
    check(!ledger.pending() && ledger.releases().empty() && ledger.released_count()==0,"guardian.move-diagnostic-is-never-a-down-receipt");
  });
  test([] {
    InputGuardianLedger ledger(own_tag); const auto left=reserve(ledger,mouse(),true), right=reserve(ledger,mouse(1),true);
    InputGuardianReceiptDiagnostic diagnostic;
    check(!ledger.observe(event(right.release,false)),"guardian.unpaired-own-up-still-refused-with-diagnostics");
    check(!ledger.observed(right,true,&diagnostic,100,200) && diagnostic==InputGuardianReceiptDiagnostic::own_up_only,
          "guardian.matching-own-up-is-honest-callback-evidence-without-down");
    check(!ledger.observed(left,true,&diagnostic,100,200) && diagnostic==InputGuardianReceiptDiagnostic::no_callback_pump_progressed,
          "guardian.other-reservation-callback-cannot-label-this-ticket");
    auto altered=right; ++altered.id;
    check(!ledger.observed(altered,true,&diagnostic,100,200) && diagnostic==InputGuardianReceiptDiagnostic::none,
          "guardian.diagnostic-query-requires-exact-ticket-lineage");
    altered=right; altered.release=left.release;
    check(!ledger.observed(altered,true,&diagnostic,100,200) && diagnostic==InputGuardianReceiptDiagnostic::none,
          "guardian.diagnostic-query-cannot-retarget-another-descriptor");
    check(!ledger.observed(right,false,&diagnostic,100,200) && diagnostic==InputGuardianReceiptDiagnostic::none,
          "guardian.diagnostics-are-exclusive-to-negative-down-query");
  });
  test([] {
    InputGuardianLedger ledger(own_tag); const auto ticket=reserve(ledger,mouse(),true);
    InputGuardianReceiptDiagnostic diagnostic;
    check(ledger.observe(event(ticket.release,true)) && !ledger.observe(event(ticket.release,true)),"guardian.duplicate-own-down-remains-refused");
    check(ledger.observed(ticket,true,&diagnostic,100,200) && diagnostic==InputGuardianReceiptDiagnostic::none && ledger.pending() && ledger.releases()==std::vector{ticket},
          "guardian.diagnostic-refusal-never-replaces-existing-success-or-obligation");
    ledger.retire(ticket);
    check(ledger.observe(event(ticket.release,false)) && ledger.observed(ticket,true,&diagnostic,100,200) && diagnostic==InputGuardianReceiptDiagnostic::none &&
          !ledger.pending() && !ledger.diagnostics_enabled() && ledger.released_count()==1,
          "guardian.normal-retirement-and-own-up-release-evidence-and-diagnostic-slot-together");
  });
  test([] {
    InputGuardianLedger ledger(own_tag); const auto previous=reserve(ledger,mouse(),true);
    InputGuardianReceiptDiagnostic diagnostic;
    ledger.observe_move(own_tag,true); ledger.retire(previous,true);
    check(!ledger.diagnostics_enabled(),"guardian.definite-no-call-erases-diagnostic-interval");
    const auto current=reserve(ledger,mouse(),true);
    check(current.id!=previous.id && !ledger.observed(current,true,&diagnostic,100,100) && diagnostic==InputGuardianReceiptDiagnostic::no_callback_pump_stalled,
          "guardian.successor-ticket-never-inherits-old-callback-evidence");
    ledger.retire(previous,true);
    check(ledger.diagnostics_enabled() && !ledger.observed(previous,true,&diagnostic,100,200) && diagnostic==InputGuardianReceiptDiagnostic::none,
          "guardian.old-retirement-or-query-cannot-touch-successor-diagnostics");
    ledger.retire(current,true); const auto ordinary=reserve(ledger,mouse());
    check(!ledger.diagnostics_enabled() && !ledger.observed(ordinary,true,&diagnostic,100,200) && diagnostic==InputGuardianReceiptDiagnostic::none,
          "guardian.opt-in-does-not-persist-after-slot-reuse");
  });
  test([] {
    InputGuardianLedger ledger(own_tag); const auto ordinary=reserve(ledger,mouse());
    check(!ledger.reserve(ordinary.release,true) && !ledger.reserve(InputRelease{},true) && !ledger.diagnostics_enabled(),
          "guardian.failed-or-invalid-diagnostic-reservation-does-not-arm-history");
    const auto left=reserve(ledger,mouse(1),true), right=reserve(ledger,mouse(2),true);
    ledger.retire(left,true);
    check(ledger.diagnostics_enabled(),"guardian-erasing-one-opt-in-keeps-other-live-ticket-enabled");
    ledger.retire(right,true);
    check(!ledger.diagnostics_enabled(),"guardian-erasing-last-opt-in-restores-zero-diagnostic-fast-path");
  });
  return groups;
}
}
