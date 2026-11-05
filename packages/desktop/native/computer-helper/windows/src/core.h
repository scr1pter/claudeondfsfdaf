#pragma once
#include <windows.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Data.Json.h>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace vector::computer {
enum class Mode { version, probe, serve, self_test };
struct Command {
  Mode mode;
  DWORD parent = 0;
  std::wstring self_test;
  std::wstring target;
  std::wstring report;
};

std::optional<Command> parse_command(std::span<const std::wstring> arguments);
std::string_view architecture();
winrt::Windows::Data::Json::JsonObject version_document();
std::optional<bool> process_elevated(std::string* diagnostic = nullptr);
bool write_utf8(HANDLE output, std::string_view value);
int run_command(const Command& command, HANDLE output, HANDLE error);
bool json_equal(const winrt::Windows::Data::Json::IJsonValue& left,
                const winrt::Windows::Data::Json::IJsonValue& right, unsigned depth = 0);
}
