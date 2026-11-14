#pragma once
#include <cstddef>
#include <cstdint>
#include <functional>
#include <map>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace vector::computer {
// Semantic modifier bits, deliberately independent of Win32 INPUT/key-state bits.
enum class InputModifier : uint32_t { control = 1, alt = 2, shift = 4, meta = 8, alt_graph = 16 };
constexpr uint32_t input_modifier(InputModifier value) noexcept { return static_cast<uint32_t>(value); }

struct InputKeyTextRules {
  // Actual Unicode category and NFKC facts. Empty callbacks accept only known safe ASCII.
  std::function<bool(std::wstring_view)> safe;
  std::function<std::optional<std::wstring>(std::wstring_view)> normalize_menu;
};
struct InputCombo {
  std::wstring key;
  uint32_t modifiers = 0;
  bool physical = false;
};
struct InputLayoutKey {
  std::wstring key;
  std::optional<std::wstring> shift;
  std::optional<std::wstring> alt_graph;
  std::optional<std::wstring> shift_alt_graph;
};
struct InputKeyLayout {
  // Actual pre-observed keyboard/IME/effective-modifier witness, never a wire value.
  std::wstring fingerprint;
  std::map<std::wstring, InputLayoutKey> keys;
};
struct InputResolvedChord {
  std::wstring key;
  uint32_t modifiers = 0;
  bool physical = false;
  std::wstring physical_key;
  std::wstring layout_fingerprint;
  bool complete = false;
};
struct InputMenuShortcut {
  // Semantic keys from an actual complete app-scoped observation, never unresolved physical positions.
  std::vector<std::wstring> combo;
  std::wstring label;
};

std::optional<InputModifier> input_modifier_name(std::wstring_view name) noexcept;
bool input_physical_key(std::wstring_view name) noexcept;
std::optional<InputCombo> parse_input_combo(std::span<const std::wstring> raw, const InputKeyTextRules& rules = {});
std::optional<InputResolvedChord> resolve_input_combo(std::span<const std::wstring> raw, const InputKeyLayout& layout,
                                                    const InputKeyTextRules& rules = {});
bool input_allowed_chord(std::span<const std::wstring> raw, const InputResolvedChord& resolved,
                         const std::optional<std::vector<InputMenuShortcut>>& menus = {},
                         const InputKeyTextRules& rules = {});
bool input_chord_paste(const InputResolvedChord&) noexcept;
bool input_chord_types_text(std::span<const std::wstring> raw, const InputResolvedChord& resolved,
                           const std::optional<std::vector<InputMenuShortcut>>& menus = {},
                           const InputKeyTextRules& rules = {});
// Classification only. Exact once-only IDE run consent remains the caller's authority boundary.
bool input_chord_ide_run(const InputResolvedChord&, const std::optional<std::vector<InputMenuShortcut>>& menus,
                        const InputKeyTextRules& rules = {});
bool input_forbidden_menu(std::span<const std::wstring> path, const InputKeyTextRules& rules = {});

// Pure UTF-16 chunking. No partial scalar, hidden NUL, oversized request or chunk can be emitted.
std::optional<std::vector<std::wstring>> split_input_unicode(std::wstring_view text, size_t chunk_units = 20);
struct InputDesktopExtent { int64_t x = 0, y = 0, width = 0, height = 0; };
struct InputAbsolutePoint { int32_t x = 0, y = 0; bool operator==(const InputAbsolutePoint&) const = default; };
// Target the normalized bucket containing this physical pixel's center, including negative desktop origins.
std::optional<InputAbsolutePoint> input_absolute_center(int64_t x, int64_t y, const InputDesktopExtent&) noexcept;
size_t run_input_keys_tests();
}
