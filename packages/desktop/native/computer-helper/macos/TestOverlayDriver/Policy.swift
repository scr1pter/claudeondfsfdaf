import CoreGraphics
import Darwin
import Foundation

// This policy is compiled into the never-shipped C8 driver and its pure native tests only.
// No production helper CLI, caller policy, target guard or grant is changed by this target.
enum OverlayDriverReason: String, CaseIterable {
    case artifactInvalid = "artifact_invalid", parentInvalid = "parent_invalid", requestInvalid = "request_invalid"
    case responsibilityMissing = "responsibility_missing", isolationRequired = "isolation_required"
    case desktopUnavailable = "desktop_unavailable", accessibilityDenied = "accessibility_denied"
    case postEventDenied = "post_event_denied", screenDenied = "screen_denied"
    case targetUnavailable = "target_unavailable", windowChanged = "window_changed", buttonUnavailable = "button_unavailable"
    case captureFailed = "capture_failed", assertionFailed = "assertion_failed", cleanupFailed = "cleanup_failed"
    case deadlineExceeded = "deadline_exceeded", sourceUnavailable = "source_unavailable"
    var maySkip: Bool {
        [.responsibilityMissing, .isolationRequired, .desktopUnavailable, .accessibilityDenied,
         .postEventDenied, .screenDenied, .targetUnavailable].contains(self)
    }
}

struct OverlayDriverError: Error { let reason: OverlayDriverReason }

struct OverlayDriverOutcome {
    let ok: Bool
    var skipped = false
    var reason: OverlayDriverReason? = nil
    var valid: Bool { !(ok && skipped) && (ok ? reason == nil : reason != nil) && (!skipped || reason?.maySkip == true) }
    var wire: JSONValue {
        guard valid else { return OverlayDriverOutcome(ok: false, reason: .assertionFailed).wire }
        var fields: [String: JSONValue] = ["ok": .bool(ok)]
        if skipped { fields["skipped"] = .bool(true) }
        if let reason { fields["reason"] = .string(reason.rawValue) }
        return .object(fields)
    }
    static func skip(_ reason: OverlayDriverReason) -> OverlayDriverOutcome {
        reason.maySkip ? OverlayDriverOutcome(ok: false, skipped: true, reason: reason) : OverlayDriverOutcome(ok: false, reason: .assertionFailed)
    }
}

struct OverlayDriverResult {
    let stop: OverlayDriverOutcome
    var capture: OverlayDriverOutcome? = nil
    var exitCode: Int32 {
        let values = [stop] + (capture.map { [$0] } ?? [])
        if values.contains(where: { !$0.valid || (!$0.ok && !$0.skipped) }) { return 1 }
        return values.contains(where: { $0.skipped }) ? 77 : 0
    }
    var wire: JSONValue {
        var fields = stop.wire.objectValue ?? [:]
        fields["id"] = .integer(1); fields["protocol"] = .integer(1); fields["check"] = .string("native-os-stop")
        if let capture { fields["capture"] = capture.wire }
        return .object(fields)
    }
}

struct OverlayDriverOptions: Equatable {
    let parent: pid_t
    let nonce: String
    var supervisor: pid_t? = nil
    var worker: Bool { supervisor != nil }
    static func parse(_ values: [String]) -> OverlayDriverOptions? {
        let parentText: String, nonce: String, supervisor: pid_t?
        if values.count == 5, values[0] == "--overlay-stop", values[1] == "--parent-pid", values[3] == "--nonce" {
            parentText = values[2]; nonce = values[4]; supervisor = nil
        } else if values.count == 7, values[0] == "--overlay-worker", values[1] == "--parent-pid",
                  values[3] == "--supervisor-pid", values[5] == "--nonce",
                  let parsed = OverlayDriverPolicy.pid(values[4]) {
            parentText = values[2]; nonce = values[6]; supervisor = parsed
        } else { return nil }
        guard let parent = OverlayDriverPolicy.pid(parentText), parent != supervisor,
              OverlayDriverPolicy.hex(nonce) else { return nil }
        return OverlayDriverOptions(parent: parent, nonce: nonce, supervisor: supervisor)
    }
}

struct OverlayDriverRect: Equatable {
    let x: Double, y: Double, w: Double, h: Double
    init(x: Double, y: Double, w: Double, h: Double) { self.x = x; self.y = y; self.w = w; self.h = h }
    init(_ value: CGRect) { x = value.origin.x; y = value.origin.y; w = value.width; h = value.height }
    var valid: Bool {
        [x, y, w, h].allSatisfy { $0.isFinite && abs($0) <= 1_000_000 } && w > 0 && h > 0 && w <= 16_384 && h <= 16_384
    }
    var cg: CGRect { CGRect(x: x, y: y, width: w, height: h) }
    var center: CGPoint { CGPoint(x: x + w / 2, y: y + h / 2) }
    func contains(_ other: OverlayDriverRect) -> Bool {
        valid && other.valid && other.x >= x && other.y >= y && other.x + other.w <= x + w && other.y + other.h <= y + h
    }
    func matchesHint(_ other: OverlayDriverRect) -> Bool {
        valid && other.valid && zip([x, y, w, h], [other.x, other.y, other.w, other.h]).allSatisfy { abs($0 - $1) <= 1 }
    }
    static func decode(_ value: JSONValue?) -> OverlayDriverRect? {
        guard let fields = value?.objectValue, Set(fields.keys) == ["x", "y", "w", "h"],
              let x = fields["x"]?.doubleValue, let y = fields["y"]?.doubleValue,
              let w = fields["w"]?.doubleValue, let h = fields["h"]?.doubleValue else { return nil }
        let result = OverlayDriverRect(x: x, y: y, w: w, h: h)
        return result.valid ? result : nil
    }
}

struct OverlayDriverRequest {
    let nonce: String, start: String, source: String, title: String
    let parent: pid_t, banner: CGWindowID
    let bounds: OverlayDriverRect, stop: OverlayDriverRect
    let glows: [CGWindowID]
    static func decode(_ value: JSONValue, options: OverlayDriverOptions, start: String, source: String) -> OverlayDriverRequest? {
        guard let fields = value.objectValue,
              Set(fields.keys).isSuperset(of: ["protocol", "nonce", "parentPID", "parentCreationTime", "sourceDigest", "bannerWindowId", "bannerBounds", "stopBounds", "bannerTitle"]),
              Set(fields.keys).isSubset(of: ["protocol", "nonce", "parentPID", "parentCreationTime", "sourceDigest", "bannerWindowId", "bannerBounds", "stopBounds", "bannerTitle", "glowWindowIds"]),
              fields["protocol"]?.intValue == 1, fields["nonce"]?.stringValue == options.nonce,
              fields["parentPID"]?.intValue == Int(options.parent), fields["parentCreationTime"]?.stringValue == start,
              OverlayDriverPolicy.start(start), OverlayDriverPolicy.hex(source), fields["sourceDigest"]?.stringValue == source,
              let raw = fields["bannerWindowId"]?.stringValue, let banner = OverlayDriverPolicy.window(raw),
              let bounds = OverlayDriverRect.decode(fields["bannerBounds"]), let stop = OverlayDriverRect.decode(fields["stopBounds"]), bounds.contains(stop),
              let title = fields["bannerTitle"]?.stringValue, title == "Vector computer smoke " + options.nonce else { return nil }
        let glows: [CGWindowID]
        if let values = fields["glowWindowIds"] {
            guard let list = values.arrayValue, list.count <= 256 else { return nil }
            let parsed = list.compactMap { $0.stringValue.flatMap(OverlayDriverPolicy.window) }
            guard parsed.count == list.count, Set(parsed).count == parsed.count, !parsed.contains(banner) else { return nil }
            glows = parsed
        } else { glows = [] }
        return OverlayDriverRequest(nonce: options.nonce, start: start, source: source, title: title,
            parent: options.parent, banner: banner, bounds: bounds, stop: stop, glows: glows)
    }
}

enum OverlayDriverPolicy {
    static func hex(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
    static func pid(_ value: String) -> pid_t? {
        guard !value.isEmpty, value.utf8.count <= 10, value.utf8.allSatisfy({ (48...57).contains($0) }),
              let parsed = Int32(value), parsed > 1, String(parsed) == value else { return nil }
        return parsed
    }
    static func window(_ value: String) -> CGWindowID? {
        guard !value.isEmpty, value.utf8.count <= 10, value.utf8.allSatisfy({ (48...57).contains($0) }),
              let parsed = UInt32(value), parsed > 0, String(parsed) == value else { return nil }
        return parsed
    }
    static func start(_ value: String) -> Bool {
        let parts = value.split(separator: ":", omittingEmptySubsequences: false)
        guard value.utf8.count <= 40, parts.count == 2, let seconds = UInt64(parts[0]), seconds > 0,
              let micros = UInt64(parts[1]), micros < 1_000_000 else { return false }
        return String(seconds) == parts[0] && String(micros) == parts[1]
    }
    /// Expected native strips are integers in top-left display points, matching the product layout.
    static func strips(_ display: OverlayDriverRect) -> [OverlayDriverRect] {
        guard display.valid else { return [] }
        let thick = min(24, floor(min(display.w, display.h) / 3)), side = display.h - 2 * thick
        guard thick >= 1 && side > 0 else { return [] }
        return [OverlayDriverRect(x: display.x, y: display.y, w: display.w, h: thick),
            OverlayDriverRect(x: display.x + display.w - thick, y: display.y + thick, w: thick, h: side),
            OverlayDriverRect(x: display.x, y: display.y + display.h - thick, w: display.w, h: thick),
            OverlayDriverRect(x: display.x, y: display.y + thick, w: thick, h: side)]
    }
    static func violet(_ red: UInt8, _ green: UInt8, _ blue: UInt8) -> Bool {
        Int(blue) >= Int(red) + 10 && Int(blue) >= Int(green) + 15 && red >= 32 && blue >= 64
    }
}
