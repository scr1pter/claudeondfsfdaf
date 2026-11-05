#include "windows_enum.h"
#include "core.h"
#include <algorithm>
#include <set>
#include <utility>

namespace vector::computer {
namespace {
[[noreturn]] void fail(std::wstring code = L"failed") { throw Failure{std::move(code), L"The app or window operation is unavailable."}; }
IJsonValue field(const JsonObject& value, std::wstring_view key) {
  return value.HasKey(winrt::hstring(key)) ? value.Lookup(winrt::hstring(key)) : nullptr;
}
bool allowed(const JsonObject& value, std::initializer_list<std::wstring_view> keys) {
  for (const auto& pair : value) if (std::find(keys.begin(), keys.end(), std::wstring_view(pair.Key())) == keys.end()) return false;
  return true;
}
bool current(const OperationContext& context) { return context.is_current && context.is_current(); }
bool phase(const JsonObject& args, const ServerSession& session) {
  const auto id = field(args, L"sessionId"), revision = field(args, L"phaseRevision");
  if (id && (id.ValueType() != JsonValueType::String || id.GetString() != session.id)) return false;
  if (revision && !safe_integer(revision)) return false;
  return !session.revision || (id && safe_integer(revision) == session.revision);
}
template<class Body> void perform(const OperationContext& context, const Dispatcher::Completion& done, Body body) {
  try {
    if (!current(context)) fail(L"changed");
    auto reply = body();
    if (!current(context)) fail(L"changed");
    done(std::move(reply));
  } catch (const Failure& error) { done(error); }
  catch (...) { done(Failure{L"failed", L"The native app or window operation failed."}); }
}
}

WindowService::WindowService(WindowPolicy policy, WindowsBackend backend) : policy_(std::move(policy)), backend_(std::move(backend)) {}
JsonObject WindowService::features() const {
  JsonObject value;
  value.Insert(L"apps.list", JsonValue::CreateBooleanValue(static_cast<bool>(backend_.list)));
  value.Insert(L"apps.open", JsonValue::CreateBooleanValue(static_cast<bool>(policy_.require) && backend_.observe && backend_.focus && backend_.foreground));
  value.Insert(L"cursor.position", JsonValue::CreateBooleanValue(static_cast<bool>(backend_.cursor)));
  return value;
}
void WindowService::list(const JsonObject& args, const OperationContext& context, Dispatcher::Completion done) {
  perform(context, done, [&]() -> Reply {
    if (!allowed(args, {L"installed"}) || (field(args, L"installed") && field(args, L"installed").ValueType() != JsonValueType::Boolean) || !backend_.list) fail();
    const auto applications = backend_.list(field(args, L"installed") && field(args, L"installed").GetBoolean(), [&] { return current(context); });
    if (applications.size() > 1000) fail(L"unavailable");
    std::set<HWND> observed;
    size_t total_windows = 0;
    JsonArray apps;
    for (const auto& app : applications) {
      if (!current(context)) fail(L"changed");
      if (app.windows.size() > 1000 || (!app.owner && !app.windows.empty())) fail(L"unavailable");
      JsonArray windows;
      for (const auto& window : app.windows) {
        if (++total_windows > 4096) fail(L"unavailable");
        if (!current(context)) fail(L"changed");
        if (!eligible_windows_window(window)) continue;
        if (!observed.insert(window.hwnd).second || !app.owner ||
            !same_windows_process(app.owner->process, window.owner.process) || !same_windows_identity(app.identity, window.owner.identity)) fail(L"changed");
        const auto disclose = policy_.disclose && policy_.disclose(window, context.session);
        std::wstring title;
        if (disclose && backend_.title) {
          if (!backend_.current || !backend_.current(window) || !current(context)) fail(L"changed");
          title = backend_.title(window);
          if (!backend_.current(window) || !current(context) || !policy_.disclose(window, context.session)) fail(L"changed");
          if (title.size() > 1024) fail(L"unavailable");
        }
        JsonObject value;
        value.Insert(L"windowId", JsonValue::CreateStringValue(window_id(window.hwnd))); value.Insert(L"title", JsonValue::CreateStringValue(title));
        value.Insert(L"bounds", window.bounds.wire()); value.Insert(L"minimized", JsonValue::CreateBooleanValue(window.minimized));
        value.Insert(L"onScreen", JsonValue::CreateBooleanValue(window.on_screen)); value.Insert(L"elevated", JsonValue::CreateBooleanValue(window.elevated)); windows.Append(value);
      }
      JsonObject value;
      value.Insert(L"identity", app.identity.wire()); value.Insert(L"active", JsonValue::CreateBooleanValue(app.active)); value.Insert(L"windows", windows);
      if (app.icon) {
        if (!app.icon->starts_with("data:image/png;base64,") || app.icon->size() > 22 + ((8192 + 2) / 3) * 4) fail(L"unavailable");
        value.Insert(L"icon", JsonValue::CreateStringValue(winrt::to_hstring(*app.icon)));
      }
      apps.Append(value);
    }
    JsonObject value; value.Insert(L"apps", apps); return Reply{value, {}};
  });
}
void WindowService::activate(const JsonObject& args, const OperationContext& context, Dispatcher::Completion done) { mutate(args, context, std::move(done), true); }
void WindowService::focus(const JsonObject& args, const OperationContext& context, Dispatcher::Completion done) { mutate(args, context, std::move(done), false); }
void WindowService::mutate(const JsonObject& args, const OperationContext& context, Dispatcher::Completion done, bool activate) {
  perform(context, done, [&]() -> Reply {
    if (!context.session) fail(L"unavailable");
    if (!phase(args, *context.session)) fail(L"changed");
    WindowsWindow selected;
    if (activate) {
      if (!allowed(args, {L"identity", L"sessionId", L"phaseRevision"}) || !field(args, L"identity") || field(args, L"identity").ValueType() != JsonValueType::Object || !backend_.list) fail();
      const auto apps = backend_.list(false, [&] { return current(context); });
      if (apps.size() > 1000) fail(L"unavailable");
      std::vector<WindowsWindow> matches;
      for (const auto& app : apps) if (app.owner && json_equal(app.identity.wire(), field(args, L"identity"))) {
        if (!current(context)) fail(L"changed");
        for (const auto& window : app.windows) if (eligible_windows_window(window)) {
          if (matches.size() >= 1000) fail(L"unavailable"); matches.push_back(window);
        }
      }
      if (matches.empty() || matches.size() > 1000) fail(L"changed");
      auto chosen = std::find_if(matches.begin(), matches.end(), [&](const auto& window) { return backend_.foreground && backend_.foreground(window); });
      if (chosen == matches.end()) chosen = std::find_if(matches.begin(), matches.end(), [](const auto& window) { return !window.minimized; });
      selected = chosen == matches.end() ? matches.front() : *chosen;
    } else {
      if (!allowed(args, {L"windowId", L"sessionId", L"phaseRevision"}) || !field(args, L"windowId") || field(args, L"windowId").ValueType() != JsonValueType::String || !backend_.observe) fail();
      const auto id = parse_window_id(field(args, L"windowId").GetString()); if (!id) fail();
      selected = backend_.observe(*id);
    }
    if (!eligible_windows_window(selected) || !backend_.current || !backend_.current(selected)) fail(L"changed");
    if (!policy_.require) fail(L"protected");
    policy_.require(selected, *context.session, activate ? WindowIntent::activate : WindowIntent::focus);
    if (context.session->mode == L"background") fail(L"needs_foreground");
    if (context.session->paused || !current(context)) fail(L"changed");
    if (!backend_.focus || !backend_.foreground || !backend_.observe) fail(L"unsupported_action");
    if (!backend_.focus(selected, context, [&](const WindowsWindow& live) {
      if (!current(context) || !same_windows_window_target(live, selected) || !eligible_windows_window(live)) fail(L"changed");
      policy_.require(live, *context.session, activate ? WindowIntent::activate : WindowIntent::focus);
    })) fail(L"not_foreground");
    const auto live = backend_.observe(selected.hwnd);
    if (!same_windows_window_target(live, selected) || !eligible_windows_window(live) || !backend_.current(live)) fail(L"changed");
    policy_.require(live, *context.session, activate ? WindowIntent::activate : WindowIntent::focus);
    if (!backend_.foreground(live)) fail(L"not_foreground");
    JsonObject value; value.Insert(L"foreground", JsonValue::CreateBooleanValue(true)); return Reply{value, {}};
  });
}
void WindowService::cursor(const JsonObject& args, const OperationContext& context, Dispatcher::Completion done) {
  perform(context, done, [&]() -> Reply {
    if (args.Size() != 0) fail(); if (!backend_.cursor) fail(L"unsupported_action");
    const auto cursor = backend_.cursor(); if (cursor.display_id.empty() || cursor.display_id.size() > 256) fail(L"unavailable");
    JsonObject value; value.Insert(L"x", JsonValue::CreateNumberValue(cursor.point.x)); value.Insert(L"y", JsonValue::CreateNumberValue(cursor.point.y));
    value.Insert(L"displayId", JsonValue::CreateStringValue(cursor.display_id)); return Reply{value, {}};
  });
}
}
