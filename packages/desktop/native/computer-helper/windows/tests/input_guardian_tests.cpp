#include "input_guardian.h"
#include <stdexcept>

namespace vector::computer {
namespace {
constexpr uint64_t own_tag=0x0123456789abcdefULL;
void check(bool value,const char* label) { if (!value) throw std::runtime_error(label); }
InputRelease scan(WORD key=static_cast<WORD>('A'),WORD code=0x1e,bool extended=false) { return {InputReleaseKind::scan_key,key,code,extended,0}; }
InputRelease unicode(WORD unit=0x03c0) { return {InputReleaseKind::unicode_key,VK_PACKET,unit,false,0}; }
InputRelease mouse(uint8_t button=0) { return {InputReleaseKind::mouse_button,0,0,false,button}; }
InputGuardianEvent event(const InputRelease& release,bool down,uint64_t time=100) { return {release,own_tag,true,down,time}; }
InputGuardianTicket reserve(InputGuardianLedger& ledger,const InputRelease& release) {
  const auto ticket=ledger.reserve(release); check(ticket.has_value(),"guardian.synthetic-reservation"); return *ticket;
}
std::vector<std::wstring> args() {
  return {L"--computer-input-guardian",L"--parent-pid",L"42",L"--input-nonce",std::wstring(64,L'a'),L"--input-tag",L"0123456789abcdef",L"--shutdown-event",L"128"};
}
}

// Pure metadata, codec and CLI fixtures only. No process, pipe, hook, key, mouse or desktop operation runs.
size_t run_input_guardian_tests() {
  size_t groups=0; const auto test=[&](const auto& body) { body(); ++groups; };
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
  return groups;
}
}
