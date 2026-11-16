#include "input_keys.h"
#include <limits>
#include <stdexcept>

namespace vector::computer {
namespace {
constexpr auto ctrl = input_modifier(InputModifier::control), shift = input_modifier(InputModifier::shift);
constexpr auto alt = input_modifier(InputModifier::alt), meta = input_modifier(InputModifier::meta), altgr = input_modifier(InputModifier::alt_graph);
void check(bool value, const char* label) { if (!value) throw std::runtime_error(label); }
std::vector<std::wstring> names(std::initializer_list<const wchar_t*> raw) { std::vector<std::wstring> result; for (const auto item : raw) result.emplace_back(item); return result; }
InputMenuShortcut menu(std::initializer_list<const wchar_t*> combo, std::wstring label) { return {names(combo), std::move(label)}; }
// Complete synthetic facts for the exact stable Unicode scalars in these fixtures. No platform API is called.
InputKeyTextRules unicode_rules() {
  return {
    [](std::wstring_view value) {
      for (const auto c : value) {
        if ((c >= 32 && c <= 126) || c == 0x00e9 || c == 0x0301 || c == 0x0391 || c == 0x03b1 ||
            c == 0x0416 || c == 0x0436 || c == 0x00a0 || (c >= 0xff01 && c <= 0xff5e) || c == 0xd83d || c == 0xde00) continue;
        return false;
      }
      return true;
    },
    [](std::wstring_view value) -> std::optional<std::wstring> {
      std::wstring result(value);
      for (auto& c : result) if (c >= 0xff01 && c <= 0xff5e) c = static_cast<wchar_t>(c - 0xfee0); else if (c == 0xa0) c = L' ';
      return result;
    },
  };
}
InputResolvedChord resolved(const std::vector<std::wstring>& raw, const InputKeyTextRules& rules = {}) {
  InputKeyLayout layout; layout.fingerprint = L"synthetic-hkl-ime-modifiers";
  const auto chord = resolve_input_combo(raw, layout, rules);
  check(chord.has_value(), "input-keys.synthetic-chord-resolution"); return *chord;
}
bool allowed(std::initializer_list<const wchar_t*> raw, std::optional<std::vector<InputMenuShortcut>> menus = {}, const InputKeyTextRules& rules = {}) {
  const auto values = names(raw); const auto chord = resolved(values, rules); return input_allowed_chord(values, chord, menus, rules);
}
}

size_t run_input_keys_tests() {
  size_t groups = 0; const auto test = [&](const auto& body) { body(); ++groups; };
  test([] {
    check(input_modifier_name(L"CTRL") == InputModifier::control && input_modifier_name(L"controlright") == InputModifier::control &&
          input_modifier_name(L"⌃") == InputModifier::control && input_modifier_name(L"Option") == InputModifier::alt &&
          input_modifier_name(L"Win") == InputModifier::meta && input_modifier_name(L"AltGr") == InputModifier::alt_graph, "input-keys.modifier-aliases");
    for (const auto& values : std::vector<std::vector<std::wstring>>{{}, {L""}, {L"ctrl"}, {L"a",L"b"}, {L"ctrl",L"control",L"s"}, {L"shift",L"shiftleft",L"a"}, {L"a\n"}, {std::wstring(33,L'a')}})
      check(!parse_input_combo(values), "input-keys.ambiguous-or-invalid-combo");
    check(!parse_input_combo(std::vector<std::wstring>(9,L"shift")), "input-keys.combo-cap");
  });
  test([] {
    for (const auto key : {L"a",L"A",L" ",L"spacebar",L"Return",L"esc",L"left",L"PgUp",L"page_down",L"Delete"})
      check(allowed({key}), "input-keys.default-text-and-navigation");
    check(allowed({L"Shift",L"a"}) && allowed({L"shift",L"left"}), "input-keys.shift-selection");
    check(!allowed({L"f1"}) && allowed({L"f1"}, std::vector{menu({L"F1"},L"Open Documentation")}), "input-keys.function-requires-observed-menu");
  });
  test([] {
    for (const auto key : {L"a",L"c",L"v",L"x",L"y",L"z",L"arrowleft",L"backspace",L"delete",L"home",L"tab"}) {
      check(allowed({L"ctrl",key}), "input-keys.windows-primary-editing");
      if (std::wstring_view(key) == L"c") check(!allowed({L"control",L"shift",key}), "input-keys.inspector-floor-overrides-shift-copy");
      else check(allowed({L"control",L"shift",key}), "input-keys.shift-primary-editing");
    }
    check(!allowed({L"cmd",L"c"}) && !allowed({L"Win",L"r"},std::vector{menu({L"Win",L"r"},L"Save")}), "input-keys.no-win-meta-global-keys");
  });
  test([] {
    for (const auto key : {L"PrintScreen",L"snapshot",L"Power",L"Sleep",L"CapsLock",L"NumLock",L"ScrollLock",L"Pause",L"Fn",L"ContextMenu",L"Help",L"LaunchMail",L"BrowserHome",L"VolumeUp",L"MediaPlayPause",L"F12"})
      check(!allowed({key},std::vector{menu({key},L"Save")}), "input-keys.system-floor-overrides-menu");
  });
  test([] {
    for (const auto& raw : std::vector<std::vector<std::wstring>>{
        {L"alt",L"tab"},{L"ctrl",L"space"},{L"alt",L"space"},{L"shift",L"escape"},{L"ctrl",L"alt",L"delete"},
        {L"ctrl",L"alt",L"end"},{L"ctrl",L"alt",L"arrowleft"},{L"ctrl",L"shift",L"i"},{L"ctrl",L"shift",L"j"},
        {L"ctrl",L"shift",L"c"},{L"alt",L"f8"},{L"alt",L"f11"}}) {
      const auto chord = resolved(raw);
      check(!input_allowed_chord(raw,chord,std::vector<InputMenuShortcut>{{raw,L"Save"}}), "input-keys.unsafe-os-inspector-floor");
    }
  });
  test([] {
    check(!allowed({L"ctrl",L"s"}) && !allowed({L"ctrl",L"s"},std::vector<InputMenuShortcut>{}), "input-keys.unknown-menu-never-authorizes-save");
    check(allowed({L"ctrl",L"s"},std::vector{menu({L"CONTROL",L"S"},L"Save")}), "input-keys.exact-observed-save");
    check(!allowed({L"ctrl",L"s"},std::vector{menu({L"ctrl",L"shift",L"s"},L"Save As")}) &&
          !allowed({L"ctrl",L"s"},std::vector{menu({L"ctrl",L"KeyS"},L"Save")}), "input-keys.no-modifier-or-physical-menu-substitution");
  });
  test([] {
    for (const auto label : {L"",L"  ",L"Run Macro",L"Scripts",L"JavaScript Console",L"Visual Basic",L"Terminal",L"PowerShell",L"Developer Tools",L"Web Inspector",L"Task Manager",L"Screen Capture",L"Screenshot",L"Lock Screen",L"Switch User",L"Enable Content"})
      check(!allowed({L"ctrl",L"c"},std::vector{menu({L"ctrl",L"c"},label)}), "input-keys.matching-unsafe-menu-overrides-default");
    check(allowed({L"ctrl",L"c"},std::vector{menu({L"ctrl",L"r"},L"Run Macro")}), "input-keys.nonmatching-menu-does-not-retarget");
    check(!allowed({L"ctrl",L"c"},std::vector{menu({L"ctrl",L"c"},L"Copy"),menu({L"ctrl",L"c"},L"Run Macro")}), "input-keys.any-unsafe-matching-binding-refuses");
  });
  test([] {
    const auto rules = unicode_rules();
    for (const auto label : {L"Ｍａｃｒｏ",L"αScripts",L"Scriptsα",L"αMacroα",L"Co\u202epy"})
      check(!allowed({L"ctrl",L"c"},std::vector{menu({L"ctrl",L"c"},label)},rules), "input-keys-nfkc-and-ascii-word-boundaries");
    check(input_forbidden_menu(names({L"Tools",L"Web",L"Inspector"}),rules) &&
          input_forbidden_menu(names({L"Enable",L"Content"}),rules), "input-keys.full-menu-ancestry");
    check(!input_forbidden_menu(names({L"File",L"Save"}),rules) && input_forbidden_menu(std::vector<std::wstring>{},rules), "input-keys.menu-root-readonly");
  });
  test([] {
    InputKeyLayout azerty; azerty.fingerprint = L"actual-azerty-proof"; azerty.keys[L"KeyQ"] = {L"a",L"A",{}, {}};
    azerty.keys[L"Digit4"] = {L"'",L"4",{}, {}};
    const auto raw = names({L"KeyQ"}); const auto chord = resolve_input_combo(raw,azerty);
    check(chord && chord->key == L"a" && chord->physical && input_allowed_chord(raw,*chord), "input-keys.actual-azerty-physical-semantic-proof");
    const auto digit = names({L"Shift",L"Digit4"}); const auto number = resolve_input_combo(digit,azerty);
    check(number && number->key == L"4" && input_allowed_chord(digit,*number), "input-keys.shift-level-is-observed-not-guessed");
    check(!resolve_input_combo(names({L"KeyW"}),azerty) && !resolve_input_combo(names({L"altgraph",L"Digit4"}),azerty), "input-keys.missing-physical-level-fails-closed");
    check(input_physical_key(L"NumpadEnter") && input_physical_key(L"Backquote") && !input_physical_key(L"Numpad-Enter"), "input-keys.physical-name-contract");
  });
  test([] {
    const auto raw = names({L"ctrl",L"i"}); auto chord = resolved(raw); chord.modifiers |= shift;
    check(!input_allowed_chord(raw,chord,std::vector{menu({L"ctrl",L"shift",L"i"},L"Save")}), "input-keys.actual-required-shift-cannot-hide-inspector");
    chord.modifiers = 0; check(!input_allowed_chord(raw,chord), "input-keys.actual-modifiers-cannot-drop-requested-control");
    chord = resolved(raw); chord.modifiers |= 0x80000000U; check(!input_allowed_chord(raw,chord), "input-keys.unknown-effective-modifiers-refused");
  });
  test([] {
    InputKeyLayout german; german.fingerprint = L"actual-german-altgraph"; german.keys[L"KeyQ"] = {L"q",L"Q",L"@",L"@"};
    const auto raw = names({L"AltGraph",L"KeyQ"}); const auto chord = resolve_input_combo(raw,german);
    check(chord && chord->key == L"@" && chord->modifiers == altgr && input_allowed_chord(raw,*chord), "input-keys.altgraph-needs-actual-physical-level");
    check(!allowed({L"AltGraph",L"a"}), "input-keys.literal-altgraph-is-not-a-physical-proof");
    auto unsafe = *chord; unsafe.modifiers |= ctrl;
    check(!input_allowed_chord(raw,unsafe), "input-keys.altgraph-cannot-hide-control-alt-global-chord");
    check(input_chord_types_text(raw,*chord), "input-keys.altgraph-remains-text-for-ide-secure-floor");
  });
  test([] {
    const auto rules = unicode_rules();
    check(allowed({L"Ж"},{},rules) && allowed({L"α"},{},rules) && allowed({L"😀"},{},rules), "input-keys-observed-safe-nonlatin-scalars");
    const auto raw = names({L"ctrl",L"Α"}); const auto chord = resolved(raw,rules);
    check(!input_allowed_chord(raw,chord,std::vector{menu({L"ctrl",L"α"},L"Save")},rules) &&
          input_allowed_chord(raw,chord,std::vector{menu({L"ctrl",L"Α"},L"Save")},rules), "input-keys.nonlatin-case-exact-menu-binding");
    InputKeyLayout cyrillic; cyrillic.fingerprint = L"actual-cyrillic"; cyrillic.keys[L"KeyS"] = {L"ж",L"Ж",{}, {}};
    const auto uppercase = resolve_input_combo(names({L"shift",L"KeyS"}),cyrillic,rules);
    check(uppercase && uppercase->key == L"Ж" && uppercase->modifiers == shift, "input-keys.cyrillic-uppercase-level-retained");
  });
  test([] {
    for (const auto& raw : {names({L"ctrl",L"v"}),names({L"shift",L"insert"})}) {
      const auto chord = resolved(raw); check(input_chord_paste(chord) && input_chord_types_text(raw,chord), "input-keys.paste-is-text");
    }
    const auto raw = names({L"ctrl",L"s"}); const auto chord = resolved(raw);
    check(!input_chord_types_text(raw,chord,std::vector{menu({L"ctrl",L"s"},L"Save")}) &&
          input_chord_types_text(raw,chord,std::vector{menu({L"ctrl",L"s"},L"Paste Special")}), "input-keys.actual-custom-paste-binding");
    check(input_chord_types_text(raw,chord,std::vector{menu({L"ctrl",L"s"},L"Ｐａｓｔｅ")},unicode_rules()), "input-keys.custom-paste-nfkc");
    InputKeyLayout dvorak; dvorak.fingerprint = L"actual-dvorak"; dvorak.keys[L"Period"] = {L"v",L"V",{}, {}};
    const auto physical = names({L"ctrl",L"Period"}); const auto paste = resolve_input_combo(physical,dvorak);
    check(paste && input_chord_types_text(physical,*paste), "input-keys.actual-physical-paste-semantics");
  });
  test([] {
    const auto raw = names({L"ctrl",L"r"}); const auto chord = resolved(raw);
    check(input_allowed_chord(raw,chord,std::vector{menu({L"ctrl",L"r"},L"Run")}) &&
          input_chord_ide_run(chord,std::vector{menu({L"ctrl",L"r"},L"Run")}), "input-keys.observed-run-is-classified-for-separate-consent");
    check(!input_chord_ide_run(chord,{}) && !input_chord_ide_run(chord,std::vector{menu({L"ctrl",L"s"},L"Run")}), "input-keys.no-guessed-run-menu");
    const auto f5 = resolved(names({L"f5"})); check(input_chord_ide_run(f5,std::vector{menu({L"f5"},L"Fortsetzen")}), "input-keys-observed-f5-run-safety-floor");
  });
  test([] {
    const auto raw = names({L"ctrl",L"s"}); const auto chord = resolved(raw); const auto save = menu({L"ctrl",L"s"},L"Save");
    check(input_allowed_chord(raw,chord,std::vector<InputMenuShortcut>(128,save)) &&
          !input_allowed_chord(raw,chord,std::vector<InputMenuShortcut>(129,save)), "input-keys.bounded-menu-catalog");
    check(!input_allowed_chord(raw,chord,std::vector{menu({L"ctrl",L"s"},std::wstring(257,L'a'))}), "input-keys.complete-label-cap");
  });
  test([] {
    const std::wstring text = std::wstring(19,L'a') + L"😀" + std::wstring(19,L'b');
    const auto chunks = split_input_unicode(text); check(chunks && chunks->size() == 3 && (*chunks)[0].size() == 19 && (*chunks)[1].size() == 20 && (*chunks)[2].size() == 1, "input-keys.unicode-chunks-never-split-surrogate-pair");
    std::wstring joined; for (const auto& chunk : *chunks) { check(chunk.size() <= 20,"input-keys.chunk-cap"); joined += chunk; }
    check(joined == text && split_input_unicode(L"")->empty() && split_input_unicode(std::wstring(4000,L'a'))->size() == 200, "input-keys.unicode-content-and-request-cap");
  });
  test([] {
    check(!split_input_unicode(std::wstring(1,static_cast<wchar_t>(0xd800))) && !split_input_unicode(std::wstring(1,static_cast<wchar_t>(0xdc00))) &&
          !split_input_unicode(std::wstring{L'a',L'\0',L'b'}) && !split_input_unicode(std::wstring(4001,L'a')) &&
          !split_input_unicode(L"😀",1) && !split_input_unicode(L"a",21) && !split_input_unicode(L"a",0), "input-keys.malformed-utf16-and-bounds-refused");
  });
  test([] {
    const InputDesktopExtent extent{-1920,-1080,3840,2160};
    for (const auto x : {-1920LL,-1919LL,-1LL,0LL,1919LL}) for (const auto y : {-1080LL,-1079LL,0LL,1079LL}) {
      const auto absolute = input_absolute_center(x,y,extent); check(absolute.has_value(), "input-keys.negative-origin-point");
      check(static_cast<int64_t>((static_cast<uint64_t>(absolute->x) * static_cast<uint64_t>(extent.width)) / 65536) + extent.x == x &&
            static_cast<int64_t>((static_cast<uint64_t>(absolute->y) * static_cast<uint64_t>(extent.height)) / 65536) + extent.y == y, "input-keys.pixel-center-normalization-roundtrip");
    }
    check(input_absolute_center(0,0,{0,0,1,1}) == std::optional{InputAbsolutePoint{32768,32768}}, "input-keys.single-pixel-center");
  });
  test([] {
    check(!input_absolute_center(-1,0,{0,0,100,100}) && !input_absolute_center(100,0,{0,0,100,100}) &&
          !input_absolute_center(0,100,{0,0,100,100}) && !input_absolute_center(0,0,{0,0,0,100}) &&
          !input_absolute_center(0,0,{0,0,65537,100}) && !input_absolute_center(std::numeric_limits<int64_t>::max(),0,{-1,0,100,100}) &&
          !input_absolute_center(0,0,{std::numeric_limits<int32_t>::max(),0,100,100}), "input-keys.absolute-extent-and-overflow-refusal");
  });
  test([] {
    const auto raw = names({L"a"}); auto chord = resolved(raw); chord.complete = false; check(!input_allowed_chord(raw,chord), "input-keys.unknown-semantic-facts");
    chord = resolved(raw); chord.layout_fingerprint.clear(); check(!input_allowed_chord(raw,chord), "input-keys.unknown-layout-fingerprint");
    InputKeyLayout absent; absent.fingerprint = L"observed-layout"; check(!resolve_input_combo(names({L"Ж"}),absent), "input-keys.unobserved-unicode-category-refused");
    check(input_forbidden_menu(names({L"Ｍａｃｒｏ"})), "input-keys.unobserved-nfkc-fails-closed");
  });
  test([] {
    for (const auto& raw : {names({L"ctrl",L"x"}),names({L"ctrl",L"z"}),names({L"ctrl",L"y"}),names({L"Backspace"}),names({L"Delete"})})
      check(input_chord_types_text(raw,resolved(raw)),"input-keys.editing-chords-require-secure-developer-readonly-text-floor");
    for (const auto& raw : {names({L"ctrl",L"c"}),names({L"ctrl",L"a"}),names({L"ctrl",L"s"})})
      check(!input_chord_types_text(raw,resolved(raw)),"input-keys.copy-select-and-observed-save-retain-nonediting-classification");
  });
  return groups;
}
}
