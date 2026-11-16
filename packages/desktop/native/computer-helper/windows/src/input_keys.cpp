#include "input_keys.h"
#include <algorithm>
#include <array>
#include <limits>
#include <regex>

namespace vector::computer {
namespace {
constexpr uint32_t control = input_modifier(InputModifier::control), alt = input_modifier(InputModifier::alt);
constexpr uint32_t shift = input_modifier(InputModifier::shift), meta = input_modifier(InputModifier::meta);
constexpr uint32_t alt_graph = input_modifier(InputModifier::alt_graph), all_modifiers = control | alt | shift | meta | alt_graph;
wchar_t lower(wchar_t c) noexcept { return c >= L'A' && c <= L'Z' ? static_cast<wchar_t>(c + (L'a' - L'A')) : c; }
bool equal_i(std::wstring_view a, std::wstring_view b) noexcept {
  if (a.size() != b.size()) return false;
  for (size_t index = 0; index < a.size(); ++index) if (lower(a[index]) != lower(b[index])) return false;
  return true;
}
std::wstring ascii_lower(std::wstring_view value) {
  std::wstring result(value); for (auto& c : result) c = lower(c); return result;
}
bool whitespace(uint32_t value) noexcept {
  return (value >= 9 && value <= 13) || value == 32 || value == 0xa0 || value == 0x1680 ||
    (value >= 0x2000 && value <= 0x200a) || value == 0x2028 || value == 0x2029 || value == 0x202f ||
    value == 0x205f || value == 0x3000 || value == 0xfeff;
}
bool scalar_at(std::wstring_view value, size_t& index, uint32_t& scalar) noexcept {
  scalar = static_cast<uint16_t>(value[index]);
  if (scalar >= 0xdc00 && scalar <= 0xdfff) return false;
  if (scalar < 0xd800 || scalar > 0xdbff) return true;
  if (++index >= value.size()) return false;
  const auto next = static_cast<uint16_t>(value[index]);
  if (next < 0xdc00 || next > 0xdfff) return false;
  scalar = 0x10000 + ((scalar - 0xd800) << 10) + (next - 0xdc00); return true;
}
bool structural_safe(std::wstring_view value) noexcept {
  for (size_t index = 0; index < value.size(); ++index) {
    uint32_t c = 0; if (!scalar_at(value, index, c)) return false;
    if (c < 32 || (c >= 127 && c <= 159) || c == 0xad || c == 0x061c ||
        (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) ||
        (c >= 0x2060 && c <= 0x206f) || c == 0xfeff || (c >= 0xfff9 && c <= 0xfffb) ||
        (c >= 0xe000 && c <= 0xf8ff) || (c >= 0xf0000 && c <= 0xffffd) ||
        (c >= 0x100000 && c <= 0x10fffd) || (c >= 0xfdd0 && c <= 0xfdef) ||
        (c & 0xffff) == 0xfffe || (c & 0xffff) == 0xffff) return false;
  }
  return true;
}
bool safe(std::wstring_view value, const InputKeyTextRules& rules) {
  if (!structural_safe(value)) return false;
  if (rules.safe) return rules.safe(value);
  return std::all_of(value.begin(), value.end(), [](wchar_t c) { return c >= 32 && c <= 126; });
}
bool one_scalar(std::wstring_view value) noexcept {
  if (value.empty()) return false;
  size_t index = 0; uint32_t scalar = 0;
  return scalar_at(value, index, scalar) && index + 1 == value.size();
}
std::wstring canonical(std::wstring_view value) {
  constexpr std::pair<std::wstring_view, std::wstring_view> aliases[] = {
    {L"return",L"enter"},{L"esc",L"escape"},{L"del",L"delete"},{L"spacebar",L"space"},{L" ",L"space"},
    {L"left",L"arrowleft"},{L"right",L"arrowright"},{L"up",L"arrowup"},{L"down",L"arrowdown"},
    {L"pgup",L"pageup"},{L"pgdn",L"pagedown"},{L"page_down",L"pagedown"},{L"page_up",L"pageup"},
  };
  for (const auto& item : aliases) if (equal_i(value, item.first)) return std::wstring(item.second);
  if (one_scalar(value) && !(value.size() == 1 && value[0] >= L'A' && value[0] <= L'Z')) return std::wstring(value);
  return ascii_lower(value);
}
bool member(std::wstring_view key, std::initializer_list<std::wstring_view> values) noexcept {
  return std::find(values.begin(), values.end(), key) != values.end();
}
bool navigation(std::wstring_view key) noexcept {
  return member(key, {L"arrowleft",L"arrowright",L"arrowup",L"arrowdown",L"home",L"end",L"pageup",L"pagedown",L"enter",L"tab",L"escape",L"backspace",L"delete",L"insert"});
}
bool text_navigation(std::wstring_view key) noexcept {
  return member(key, {L"arrowleft",L"arrowright",L"arrowup",L"arrowdown",L"home",L"end",L"pageup",L"pagedown",L"backspace",L"delete"});
}
bool function_key(std::wstring_view key) noexcept {
  if (key.size() < 2 || key.size() > 3 || key[0] != L'f' || key[1] < L'1' || key[1] > L'9') return false;
  const auto number = key.size() == 2 ? key[1] - L'0' : (key[1] - L'0') * 10 + key[2] - L'0';
  return number >= 1 && number <= 24 && (key.size() != 3 || (key[2] >= L'0' && key[2] <= L'9'));
}
bool printable(std::wstring_view key, const InputKeyTextRules& rules) {
  if (key == L"space") return true;
  if (!one_scalar(key) || !safe(key, rules)) return false;
  size_t index = 0; uint32_t scalar = 0; return scalar_at(key, index, scalar) && !whitespace(scalar);
}
bool forbidden(const InputResolvedChord& value) noexcept {
  const auto& key = value.key; const auto mods = value.modifiers;
  if (member(key, {L"printscreen",L"snapshot",L"power",L"sleep",L"wake",L"eject",L"capslock",L"numlock",L"scrolllock",L"pause",L"fn",L"fnlock",L"contextmenu",L"apps",L"help",L"launchapp1",L"launchapp2",L"launchmail",L"browserhome",L"volumemute",L"volumeup",L"volumedown",L"mediaplaypause",L"medianexttrack",L"mediaprevioustrack",L"mediastop"}) || key == L"f12") return true;
  if ((mods & meta) != 0) return true;
  if ((mods & alt_graph) && (mods & (control | alt | meta))) return true;
  if ((mods & alt) && key == L"tab") return true;
  if (key == L"space" && (mods & (control | alt | meta))) return true;
  if (key == L"escape" && mods != 0) return true;
  if ((mods & (control | alt)) == (control | alt) && member(key, {L"delete",L"end",L"tab",L"arrowleft",L"arrowright",L"arrowup",L"arrowdown"})) return true;
  if ((mods & (control | shift)) == (control | shift) && member(key, {L"i",L"j",L"c"})) return true;
  return (mods & alt) && member(key, {L"f8",L"f11"});
}
bool coherent(std::span<const std::wstring> raw, const InputResolvedChord& value, const InputKeyTextRules& rules) {
  const auto request = parse_input_combo(raw, rules);
  if (!request || !value.complete || value.layout_fingerprint.empty() || value.layout_fingerprint.size() > 1024 ||
      value.layout_fingerprint.find(L'\0') != std::wstring::npos || (value.modifiers & ~all_modifiers) != 0 ||
      (value.modifiers & request->modifiers) != request->modifiers || !safe(value.key, rules) ||
      value.key.empty() || value.key.size() > 32 || canonical(value.key) != value.key || input_physical_key(value.key) || input_modifier_name(value.key)) return false;
  if (request->physical) return value.physical && equal_i(request->key, value.physical_key);
  return !value.physical && value.physical_key.empty() && value.key == request->key;
}
std::optional<std::wstring> normalized_label(std::wstring_view raw, const InputKeyTextRules& rules) {
  if (raw.empty() || raw.size() > 256 || !safe(raw, rules)) return {};
  std::optional<std::wstring> normalized;
  if (rules.normalize_menu) normalized = rules.normalize_menu(raw);
  else if (std::all_of(raw.begin(), raw.end(), [](wchar_t c) { return c >= 32 && c <= 126; })) normalized = std::wstring(raw);
  if (!normalized || normalized->size() > 256 || !safe(*normalized, rules)) return {};
  for (auto& c : *normalized) if (whitespace(static_cast<uint16_t>(c))) c = L' ';
  const auto first = normalized->find_first_not_of(L' '), last = normalized->find_last_not_of(L' ');
  if (first == std::wstring::npos) return {};
  return normalized->substr(first, last - first + 1);
}
const std::wregex& forbidden_label() {
  // JS non-Unicode word boundaries are ASCII, including beside Greek/Cyrillic letters.
  static const std::wregex expression(L"(^|[^A-Za-z0-9_])(?:macros?|scripts?|scripting|javascript|visual[ ]+basic|vb[ ]+editor|terminal|console|powershell|shell|developer|devtools|services|web[ ]+inspector|inspect[ ]+element|task[ ]+manager|mission[ ]+control|screen[ ]*capture|screenshots?|lock[ ]+screen|switch[ ]+user|enable[ ]+content)(?=$|[^A-Za-z0-9_])", std::regex_constants::ECMAScript | std::regex_constants::icase);
  return expression;
}
bool same_menu(const InputMenuShortcut& menu, const InputResolvedChord& chord, const InputKeyTextRules& rules) {
  const auto observed = parse_input_combo(menu.combo, rules);
  return observed && !observed->physical && observed->key == chord.key && observed->modifiers == chord.modifiers;
}
bool label_word(const std::wstring& label, const wchar_t* expression) {
  return std::regex_search(label, std::wregex(expression, std::regex_constants::ECMAScript | std::regex_constants::icase));
}
bool types_key(std::wstring_view key, uint32_t mods, bool physical, const InputKeyTextRules& rules) {
  if (((mods & (control | meta)) && (key == L"v" || key == L"keyv")) || ((mods & shift) && key == L"insert")) return true;
  if (key == L"backspace" || key == L"delete" || ((mods & (control | meta)) && member(key,{L"x",L"y",L"z",L"keyx",L"keyy",L"keyz"}))) return true;
  if (navigation(key) || function_key(key) || member(key, {L"capslock",L"numlock",L"scrolllock",L"printscreen",L"pause",L"help"})) return false;
  if (physical) return false; // Its actual resolved key, below, owns classification; raw paste remains conservative.
  bool shortcut = (mods & (control | meta | alt)) != 0;
  if ((mods & (control | alt)) == (control | alt) && !(mods & meta)) shortcut = false;
  return !printable(key, rules) || !shortcut;
}
}

std::optional<InputModifier> input_modifier_name(std::wstring_view name) noexcept {
  constexpr std::pair<std::wstring_view, InputModifier> aliases[] = {
    {L"ctrl",InputModifier::control},{L"control",InputModifier::control},{L"controlleft",InputModifier::control},{L"controlright",InputModifier::control},{L"⌃",InputModifier::control},
    {L"alt",InputModifier::alt},{L"option",InputModifier::alt},{L"altleft",InputModifier::alt},{L"altright",InputModifier::alt},{L"⌥",InputModifier::alt},
    {L"shift",InputModifier::shift},{L"shiftleft",InputModifier::shift},{L"shiftright",InputModifier::shift},{L"⇧",InputModifier::shift},
    {L"cmd",InputModifier::meta},{L"command",InputModifier::meta},{L"meta",InputModifier::meta},{L"super",InputModifier::meta},{L"win",InputModifier::meta},{L"windows",InputModifier::meta},{L"metaleft",InputModifier::meta},{L"metaright",InputModifier::meta},{L"⌘",InputModifier::meta},
    {L"altgr",InputModifier::alt_graph},{L"altgraph",InputModifier::alt_graph},
  };
  for (const auto& alias : aliases) if (equal_i(name, alias.first)) return alias.second;
  return {};
}
bool input_physical_key(std::wstring_view name) noexcept {
  if (name.size() == 4 && equal_i(name.substr(0, 3), L"key") && lower(name[3]) >= L'a' && lower(name[3]) <= L'z') return true;
  if (name.size() == 6 && equal_i(name.substr(0, 5), L"digit") && name[5] >= L'0' && name[5] <= L'9') return true;
  if (name.size() > 6 && name.size() <= 32 && equal_i(name.substr(0, 6), L"numpad")) return std::all_of(name.begin() + 6, name.end(), [](wchar_t c) { return (lower(c) >= L'a' && lower(c) <= L'z') || (c >= L'0' && c <= L'9') || c == L'_'; });
  for (const auto candidate : {L"backquote",L"minus",L"equal",L"bracketleft",L"bracketright",L"backslash",L"semicolon",L"quote",L"comma",L"period",L"slash"})
    if (equal_i(name, candidate)) return true;
  return false;
}
std::optional<InputCombo> parse_input_combo(std::span<const std::wstring> raw, const InputKeyTextRules& rules) {
  if (raw.empty() || raw.size() > 8) return {};
  InputCombo result; size_t leaves = 0;
  for (const auto& item : raw) {
    if (item.empty() || item.size() > 32 || !structural_safe(item)) return {};
    if (const auto modifier = input_modifier_name(item)) {
      const auto bit = input_modifier(*modifier); if (result.modifiers & bit) return {}; result.modifiers |= bit;
    } else {
      if (++leaves > 1 || !safe(item, rules)) return {};
      result.key = canonical(item); result.physical = input_physical_key(item);
    }
  }
  return leaves == 1 ? std::optional{result} : std::nullopt;
}
std::optional<InputResolvedChord> resolve_input_combo(std::span<const std::wstring> raw, const InputKeyLayout& layout, const InputKeyTextRules& rules) {
  const auto parsed = parse_input_combo(raw, rules); if (!parsed || layout.fingerprint.empty() || layout.fingerprint.size() > 1024) return {};
  InputResolvedChord result{parsed->key, parsed->modifiers, parsed->physical, parsed->physical ? parsed->key : L"", layout.fingerprint, true};
  if (parsed->physical) {
    const InputLayoutKey* found = nullptr;
    for (const auto& entry : layout.keys) if (equal_i(entry.first, parsed->key)) { if (found) return {}; found = &entry.second; }
    if (!found) return {};
    std::optional<std::wstring> key = found->key;
    if (parsed->modifiers & alt_graph) key = parsed->modifiers & shift ? found->shift_alt_graph : found->alt_graph;
    else if (parsed->modifiers & shift) key = found->shift;
    if (!key || key->empty() || !safe(*key, rules)) return {};
    result.key = canonical(*key);
    if (!one_scalar(*key) && !navigation(result.key)) return {};
  }
  return coherent(raw, result, rules) ? std::optional{result} : std::nullopt;
}
bool input_allowed_chord(std::span<const std::wstring> raw, const InputResolvedChord& resolved,
                         const std::optional<std::vector<InputMenuShortcut>>& menus, const InputKeyTextRules& rules) {
  if (!coherent(raw, resolved, rules) || forbidden(resolved) ||
      (!printable(resolved.key, rules) && !navigation(resolved.key) && !function_key(resolved.key)) || (menus && menus->size() > 128)) return false;
  size_t matching = 0;
  for (const auto& menu : menus.value_or(std::vector<InputMenuShortcut>{})) {
    if (!same_menu(menu, resolved, rules)) continue;
    ++matching; const auto label = normalized_label(menu.label, rules);
    if (!label || std::regex_search(*label, forbidden_label())) return false;
  }
  const auto mods = resolved.modifiers;
  if ((mods == 0 || mods == shift) && (printable(resolved.key, rules) || navigation(resolved.key))) return true;
  if (mods & alt_graph) return (mods & ~(shift | alt_graph)) == 0 && printable(resolved.key, rules) && resolved.physical;
  if ((mods & control) && (mods & ~(control | shift)) == 0 &&
      (member(resolved.key, {L"a",L"c",L"v",L"x",L"y",L"z",L"tab"}) || text_navigation(resolved.key))) return true;
  return matching > 0;
}
bool input_chord_paste(const InputResolvedChord& chord) noexcept {
  return ((chord.modifiers & (control | meta)) && chord.key == L"v") || ((chord.modifiers & shift) && chord.key == L"insert");
}
bool input_chord_types_text(std::span<const std::wstring> raw, const InputResolvedChord& resolved,
                           const std::optional<std::vector<InputMenuShortcut>>& menus, const InputKeyTextRules& rules) {
  const auto request = parse_input_combo(raw, rules);
  if (!request || !coherent(raw, resolved, rules) || (menus && menus->size() > 128)) return true;
  if (types_key(request->key, request->modifiers, request->physical, rules) ||
      types_key(resolved.key, resolved.modifiers, false, rules) || input_chord_paste(resolved)) return true;
  for (const auto& menu : menus.value_or(std::vector<InputMenuShortcut>{})) if (same_menu(menu, resolved, rules)) {
    const auto label = normalized_label(menu.label, rules); if (!label) return true;
    if (label_word(*label, L"(^|[^A-Za-z0-9_])paste(?=$|[^A-Za-z0-9_])")) return true;
  }
  return false;
}
bool input_chord_ide_run(const InputResolvedChord& chord, const std::optional<std::vector<InputMenuShortcut>>& menus,
                        const InputKeyTextRules& rules) {
  if (!chord.complete || !menus || menus->size() > 128) return false;
  for (const auto& menu : *menus) if (same_menu(menu, chord, rules)) {
    const auto label = normalized_label(menu.label, rules); if (!label) continue;
    if (label_word(*label, L"^(?:run|build|debug|start[ ]+debugging)(?=$|[^A-Za-z0-9_])")) return true;
    if (chord.key == L"f5" && (chord.modifiers & ~control) == 0) return true;
  }
  return false;
}
bool input_forbidden_menu(std::span<const std::wstring> path, const InputKeyTextRules& rules) {
  if (path.empty() || path.size() > 30) return true;
  std::wstring joined;
  for (const auto& item : path) {
    const auto label = normalized_label(item, rules); if (!label || std::regex_search(*label, forbidden_label())) return true;
    if (!joined.empty()) joined += L' '; joined += *label;
  }
  return std::regex_search(joined, forbidden_label());
}
std::optional<std::vector<std::wstring>> split_input_unicode(std::wstring_view text, size_t chunk_units) {
  if (text.size() > 4000 || chunk_units == 0 || chunk_units > 20) return {};
  std::vector<std::wstring> chunks; std::wstring chunk;
  for (size_t index = 0; index < text.size(); ++index) {
    const size_t start = index; uint32_t scalar = 0;
    if (!scalar_at(text, index, scalar) || scalar == 0) return {};
    const auto units = index - start + 1; if (units > chunk_units) return {};
    if (chunk.size() + units > chunk_units) { chunks.push_back(std::move(chunk)); chunk.clear(); }
    chunk.append(text.substr(start, units));
  }
  if (!chunk.empty()) chunks.push_back(std::move(chunk)); return chunks;
}
std::optional<InputAbsolutePoint> input_absolute_center(int64_t x, int64_t y, const InputDesktopExtent& bounds) noexcept {
  if (bounds.width < 1 || bounds.height < 1 || bounds.width > 65536 || bounds.height > 65536 ||
      x < std::numeric_limits<int32_t>::min() || x > std::numeric_limits<int32_t>::max() ||
      y < std::numeric_limits<int32_t>::min() || y > std::numeric_limits<int32_t>::max() ||
      bounds.x < std::numeric_limits<int32_t>::min() || bounds.y < std::numeric_limits<int32_t>::min() ||
      bounds.x > std::numeric_limits<int32_t>::max() - bounds.width + 1 || bounds.y > std::numeric_limits<int32_t>::max() - bounds.height + 1 ||
      x < bounds.x || y < bounds.y || x - bounds.x >= bounds.width || y - bounds.y >= bounds.height) return {};
  const auto normalize = [](int64_t position, int64_t origin, int64_t extent) {
    return static_cast<int32_t>(((2 * static_cast<uint64_t>(position - origin) + 1) * 65536) / (2 * static_cast<uint64_t>(extent)));
  };
  return InputAbsolutePoint{normalize(x, bounds.x, bounds.width), normalize(y, bounds.y, bounds.height)};
}
}
