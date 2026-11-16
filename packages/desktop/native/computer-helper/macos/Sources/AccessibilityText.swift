import CoreGraphics
import Foundation

struct AccessibilitySelection: Equatable {
    let location: Int
    let length: Int
}

struct AccessibilityTextState {
    let value: String
    let selection: AccessibilitySelection
    let valueSettable: Bool
    let selectionSettable: Bool

    func sameContent(_ other: AccessibilityTextState) -> Bool {
        value.utf8.elementsEqual(other.value.utf8) && selection == other.selection
    }
}

/// The native implementation uses short AX message timeouts. No injected fixture falls through to OS calls.
struct AccessibilityTextBackend {
    let attributes: (AccessibilityElement) throws -> AccessibilityAttributes
    let state: (AccessibilityElement) throws -> AccessibilityTextState?
    let focused: (AccessibilityElement) throws -> AccessibilityElement
    let window: (AccessibilityElement) throws -> AccessibilityElement?
    let bounds: (AccessibilityElement) throws -> CGRect
    let document: (AccessibilityElement) throws -> String?
    let setValue: (AccessibilityElement, String) throws -> Bool
    let setSelection: (AccessibilityElement, AccessibilitySelection) throws -> Bool
}

enum AccessibilityTextEdit {
    static func insert(_ text: String, into state: AccessibilityTextState) -> AccessibilityTextState? {
        let old = Array(state.value.utf16), inserted = Array(text.utf16)
        let range = state.selection
        guard !inserted.isEmpty, inserted.count <= 4000, old.count <= 4000,
              range.location >= 0, range.length >= 0, range.location <= old.count,
              range.length <= old.count - range.location else { return nil }
        let end = range.location + range.length
        guard boundary(range.location, old), boundary(end, old), validUnicode(old), validUnicode(inserted),
              old.count - range.length <= 4000 - inserted.count else { return nil }
        let result = Array(old[..<range.location]) + inserted + Array(old[end...])
        guard validUnicode(result) else { return nil }
        return AccessibilityTextState(value: String(decoding: result, as: UTF16.self),
            selection: AccessibilitySelection(location: range.location + inserted.count, length: 0),
            valueSettable: state.valueSettable, selectionSettable: state.selectionSettable)
    }

    static func validUnicode(_ units: [UInt16]) -> Bool {
        var index = 0
        while index < units.count {
            let unit = units[index]
            if (0xD800...0xDBFF).contains(unit) {
                guard index + 1 < units.count, (0xDC00...0xDFFF).contains(units[index + 1]) else { return false }
                index += 2
            } else {
                guard !(0xDC00...0xDFFF).contains(unit) else { return false }; index += 1
            }
        }
        return true
    }
    private static func boundary(_ index: Int, _ units: [UInt16]) -> Bool {
        index == 0 || index == units.count || !((0xD800...0xDBFF).contains(units[index - 1]) && (0xDC00...0xDFFF).contains(units[index]))
    }
}
