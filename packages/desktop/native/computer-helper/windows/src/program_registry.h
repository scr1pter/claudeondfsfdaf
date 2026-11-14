#pragma once
#include "server.h"
#include "windows_identity.h"
#include <functional>
#include <map>
#include <mutex>
#include <optional>
#include <span>

namespace vector::computer {
enum class WindowsProgramRoute { executable, document };
struct NativeProgramArtifact {
  std::wstring path;
  std::wstring name;
  std::wstring binding;
  WindowsProgramRoute route = WindowsProgramRoute::executable;
  std::optional<WindowsAppIdentity> handler;
  std::optional<std::wstring> handler_path;
  // Private actual argv template. Exactly one complete %1/%L argument marks a document operand.
  std::vector<std::wstring> handler_arguments;
};
std::wstring program_sha256(std::span<const uint8_t> bytes);
std::string program_json_quote(std::wstring_view text);
std::wstring program_key(std::wstring_view path, std::wstring_view binding);
bool canonical_program_path(std::wstring_view path) noexcept;
bool valid_program_arguments(const std::vector<std::wstring>& arguments);
bool valid_program_artifact(const NativeProgramArtifact& artifact);
bool same_program_artifact(const NativeProgramArtifact& left, const NativeProgramArtifact& right) noexcept;

struct PreparedProgramLaunch {
  NativeProgramArtifact artifact;
  std::wstring token;
  std::wstring key;
  JsonObject public_wire() const;
  JsonObject wire() const;
};

// Ephemeral native capabilities, never app approvals. The exact artifact must be re-resolved after consume.
class ProgramLaunchRegistry final {
 public:
  using Clock = std::function<uint64_t()>; // Monotonic milliseconds.
  using Random = std::function<std::wstring()>;
  explicit ProgramLaunchRegistry(size_t limit = 1000, uint64_t ttl_ms = 30'000, Clock clock = {}, Random random = {});
  PreparedProgramLaunch prepare(const NativeProgramArtifact& artifact, const ServerSession& session);
  NativeProgramArtifact consume(const std::wstring& token, const std::wstring& binding, const ServerSession& session);
  void clear();
  void close();
 private:
  struct Entry {
    PreparedProgramLaunch prepared;
    std::wstring session;
    uint64_t run_epoch = 0;
    uint64_t observation_epoch = 0;
    std::optional<uint64_t> revision;
    uint64_t created = 0;
    uint64_t expires = 0;
  };
  bool observe(uint64_t now);
  std::mutex mutex_;
  size_t limit_;
  uint64_t ttl_;
  Clock clock_;
  Random random_;
  std::wstring worker_;
  uint64_t sequence_ = 0;
  std::optional<uint64_t> last_time_;
  bool closed_ = false;
  std::map<std::wstring, Entry> entries_;
};
size_t run_program_registry_tests();
}
