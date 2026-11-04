#include "core.h"
#include "identity.h"
#include "build-config.h"
#include <algorithm>
#include <array>
#include <limits>
#include <map>
#include <set>
#include <winrt/Windows.Foundation.h>

namespace vector::computer {
using winrt::Windows::Data::Json::JsonArray;
using winrt::Windows::Data::Json::JsonObject;
using winrt::Windows::Data::Json::JsonValue;
using winrt::Windows::Data::Json::JsonValueType;

std::optional<Command> parse_command(std::span<const std::wstring> arguments) {
  std::set<std::wstring> flags;
  std::map<std::wstring, std::wstring> values;
  for (size_t index = 0; index < arguments.size(); ++index) {
    const auto& argument = arguments[index];
    if (argument == L"--version" || argument == L"--probe" || argument == L"--json" || argument == L"--stdio") {
      if (!flags.insert(argument).second) return std::nullopt;
    } else if (argument == L"--parent-pid" || argument == L"--target" || argument == L"--report") {
      if (++index >= arguments.size() || values.contains(argument)) return std::nullopt;
      const auto& value = arguments[index];
      if (value.empty() || value.size() > 16'384 || value.find(L'\0') != std::wstring::npos || value.starts_with(L"--")) return std::nullopt;
      values.emplace(argument, value);
    } else if (argument.starts_with(L"--self-test=")) {
      const auto mode = argument.substr(12);
      if ((mode != L"unprivileged" && mode != L"privileged" && mode != L"packaged") || !values.emplace(L"self-test", mode).second) return std::nullopt;
    } else return std::nullopt;
  }
  if (values.contains(L"self-test")) {
    if (!flags.empty() || values.contains(L"--parent-pid")) return std::nullopt;
    return Command{Mode::self_test, 0, values[L"self-test"], values[L"--target"], values[L"--report"]};
  }
  if (values.empty() && flags == std::set<std::wstring>{L"--version", L"--json"}) return Command{Mode::version};
  if (values.empty() && flags == std::set<std::wstring>{L"--probe", L"--json"}) return Command{Mode::probe};
  if (flags != std::set<std::wstring>{L"--stdio"} || values.size() != 1 || !values.contains(L"--parent-pid")) return std::nullopt;
  uint64_t parent = 0;
  for (const wchar_t digit : values[L"--parent-pid"]) {
    if (digit < L'0' || digit > L'9') return std::nullopt;
    parent = parent * 10 + static_cast<unsigned>(digit - L'0');
    if (parent > std::numeric_limits<DWORD>::max()) return std::nullopt;
  }
  if (parent == 0) return std::nullopt;
  return Command{Mode::serve, static_cast<DWORD>(parent)};
}

std::string_view architecture() {
#if defined(_M_X64)
  return "x64";
#elif defined(_M_ARM64)
  return "arm64";
#else
#error Unsupported helper architecture
#endif
}

JsonObject version_document() {
  JsonObject protocol;
  protocol.Insert(L"min", JsonValue::CreateNumberValue(identity::kProtocolMin));
  protocol.Insert(L"max", JsonValue::CreateNumberValue(identity::kProtocolMax));
  JsonObject value;
  value.Insert(L"helperVersion", JsonValue::CreateStringValue(winrt::to_hstring(identity::kHelperVersion)));
  value.Insert(L"protocol", protocol);
  value.Insert(L"platform", JsonValue::CreateStringValue(L"win32"));
  value.Insert(L"arch", JsonValue::CreateStringValue(winrt::to_hstring(architecture())));
  value.Insert(L"sourceDigest", JsonValue::CreateStringValue(winrt::to_hstring(build::kSourceDigest)));
  return value;
}

std::optional<bool> process_elevated() {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return std::nullopt;
  [[maybe_unused]] winrt::handle close{token};
  DWORD length = 0;
  if (GetTokenInformation(token, TokenIntegrityLevel, nullptr, 0, &length) || GetLastError() != ERROR_INSUFFICIENT_BUFFER || length < sizeof(TOKEN_MANDATORY_LABEL) || length > 65'536) return std::nullopt;
  std::vector<unsigned char> data(length);
  if (!GetTokenInformation(token, TokenIntegrityLevel, data.data(), length, &length)) return std::nullopt;
  const auto label = reinterpret_cast<const TOKEN_MANDATORY_LABEL*>(data.data());
  if (!IsValidSid(label->Label.Sid)) return std::nullopt;
  const auto count = *GetSidSubAuthorityCount(label->Label.Sid);
  if (count == 0) return std::nullopt;
  return *GetSidSubAuthority(label->Label.Sid, static_cast<DWORD>(count - 1)) >= static_cast<DWORD>(SECURITY_MANDATORY_HIGH_RID);
}

bool write_utf8(HANDLE output, std::string_view value) {
  if (!output || output == INVALID_HANDLE_VALUE) return false;
  while (!value.empty()) {
    DWORD written = 0;
    const auto count = static_cast<DWORD>(std::min<size_t>(value.size(), 65'536));
    if (!WriteFile(output, value.data(), count, &written, nullptr) || written == 0 || written > count) return false;
    value.remove_prefix(written);
  }
  return true;
}

int run_command(const Command& command, HANDLE output, HANDLE error) {
  JsonObject result;
  if (command.mode == Mode::version) result = version_document();
  else if (command.mode == Mode::probe) {
    const auto elevated = process_elevated();
    if (!elevated) { write_utf8(error, "The helper process token could not be read.\n"); return 1; }
    JsonObject permissions;
    permissions.Insert(L"screen", JsonValue::CreateStringValue(L"n/a"));
    permissions.Insert(L"accessibility", JsonValue::CreateStringValue(L"n/a"));
    result.Insert(L"permissions", permissions);
    result.Insert(L"responsible", JsonValue::CreateBooleanValue(true));
    result.Insert(L"elevated", JsonValue::CreateBooleanValue(*elevated));
    // W8 supplies the actual capture availability probe. A skeleton must never advertise capture readiness.
    result.Insert(L"captureBlocked", JsonValue::CreateBooleanValue(true));
  } else if (command.mode == Mode::self_test) {
    JsonObject check;
    check.Insert(L"name", JsonValue::CreateStringValue(L"native-runtime-pending"));
    check.Insert(L"ok", JsonValue::CreateBooleanValue(false));
    check.Insert(L"skipped", JsonValue::CreateBooleanValue(true));
    JsonArray checks;
    checks.Append(check);
    result.Insert(L"checks", checks);
    return write_utf8(output, winrt::to_string(result.Stringify()) + "\n") ? 77 : 1;
  } else {
    write_utf8(error, "The Windows computer protocol is not implemented yet.\n");
    return 1;
  }
  return write_utf8(output, winrt::to_string(result.Stringify()) + "\n") ? 0 : 1;
}

bool json_equal(const winrt::Windows::Data::Json::IJsonValue& left,
                const winrt::Windows::Data::Json::IJsonValue& right, unsigned depth) {
  if (depth > 64 || left.ValueType() != right.ValueType()) return false;
  switch (left.ValueType()) {
    case JsonValueType::Null: return true;
    case JsonValueType::Boolean: return left.GetBoolean() == right.GetBoolean();
    case JsonValueType::Number: return left.GetNumber() == right.GetNumber();
    case JsonValueType::String: return left.GetString() == right.GetString();
    case JsonValueType::Array: {
      const auto a = left.GetArray();
      const auto b = right.GetArray();
      if (a.Size() != b.Size()) return false;
      for (uint32_t index = 0; index < a.Size(); ++index) if (!json_equal(a.GetAt(index), b.GetAt(index), depth + 1)) return false;
      return true;
    }
    case JsonValueType::Object: {
      const auto a = left.GetObject();
      const auto b = right.GetObject();
      if (a.Size() != b.Size()) return false;
      for (const auto& pair : a) if (!b.HasKey(pair.Key()) || !json_equal(pair.Value(), b.Lookup(pair.Key()), depth + 1)) return false;
      return true;
    }
    default: return false;
  }
}
}
