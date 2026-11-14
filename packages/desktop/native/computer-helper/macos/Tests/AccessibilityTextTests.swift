import Foundation

private struct AccessibilityTextTestFailure: Error { let message: String }
private func accessibilityTextCheck(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw AccessibilityTextTestFailure(message: message) }
}
private func textState(_ value: String, location: Int, length: Int = 0,
                       valueSettable: Bool = true, selectionSettable: Bool = true) -> AccessibilityTextState {
    AccessibilityTextState(value: value, selection: AccessibilitySelection(location: location, length: length),
                           valueSettable: valueSettable, selectionSettable: selectionSettable)
}

/// Pure text arithmetic and encoding checks. No AX object, application, native clipboard, or keyboard is used.
func runAccessibilityTextTests() throws -> Int {
    var count = 0
    func test(_ body: () throws -> Void) throws { try body(); count += 1 }

    try test {
        let cases: [(old: String, location: Int, inserted: String, expected: String, caret: Int)] = [
            ("", 0, "Hello", "Hello", 5), ("Hello", 5, "!", "Hello!", 6),
            ("World", 0, "Hello ", "Hello World", 6), ("acd", 1, "b", "abcd", 2),
        ]
        for item in cases {
            guard let result = AccessibilityTextEdit.insert(item.inserted, into: textState(item.old, location: item.location)) else {
                throw AccessibilityTextTestFailure(message: "A valid empty-field, prepend, append or interior insertion was refused.")
            }
            try accessibilityTextCheck(result.value.utf8.elementsEqual(item.expected.utf8) &&
                                       result.selection == AccessibilitySelection(location: item.caret, length: 0),
                                       "Insertion preserves surrounding content and collapses the caret after the inserted UTF16 units.")
        }
    }
    try test {
        let cases: [(old: String, location: Int, length: Int, inserted: String, expected: String, caret: Int)] = [
            ("abcdef", 2, 2, "X", "abXef", 3), ("abcdef", 2, 2, "XYZ", "abXYZef", 5),
            ("red blue green", 4, 4, "cyan", "red cyan green", 8), ("abcdef", 0, 6, "Ω😀", "Ω😀", 3),
        ]
        for item in cases {
            guard let result = AccessibilityTextEdit.insert(item.inserted, into: textState(item.old, location: item.location, length: item.length)) else {
                throw AccessibilityTextTestFailure(message: "A valid selected-text replacement was refused.")
            }
            try accessibilityTextCheck(result.value.utf8.elementsEqual(item.expected.utf8) &&
                                       result.selection == AccessibilitySelection(location: item.caret, length: 0),
                                       "Replacement uses the selected range rather than appending or retaining the old selection length.")
        }
    }
    try test {
        let cases: [(old: String, location: Int, length: Int, inserted: String, expected: String, caret: Int)] = [
            ("A😀B", 1, 0, "🌍", "A🌍😀B", 3), ("A😀B", 3, 0, "e\u{301}", "A😀e\u{301}B", 5),
            ("A😀B", 1, 2, "X", "AXB", 2), ("A😀B", 3, 1, "🌍", "A😀🌍", 5),
            ("😀🌍", 2, 0, "X", "😀X🌍", 3),
        ]
        for item in cases {
            guard let result = AccessibilityTextEdit.insert(item.inserted, into: textState(item.old, location: item.location, length: item.length)) else {
                throw AccessibilityTextTestFailure(message: "A valid UTF16 boundary beside an astral character was refused.")
            }
            try accessibilityTextCheck(result.value.utf8.elementsEqual(item.expected.utf8) &&
                                       result.selection == AccessibilitySelection(location: item.caret, length: 0),
                                       "Astral characters use two UTF16 units for selection and the resulting caret.")
        }
    }
    try test {
        for range in [AccessibilitySelection(location: 2, length: 0), AccessibilitySelection(location: 1, length: 1),
                      AccessibilitySelection(location: 2, length: 1), AccessibilitySelection(location: 0, length: 2),
                      AccessibilitySelection(location: 2, length: 2)] {
            try accessibilityTextCheck(AccessibilityTextEdit.insert("X", into: textState("A😀B", location: range.location, length: range.length)) == nil,
                                       "Neither the start nor end of a selection may bisect an existing surrogate pair.")
        }
    }
    try test {
        for range in [AccessibilitySelection(location: -1, length: 0), AccessibilitySelection(location: 0, length: -1),
                      AccessibilitySelection(location: 4, length: 0), AccessibilitySelection(location: 2, length: 2),
                      AccessibilitySelection(location: Int.max, length: 0), AccessibilitySelection(location: 0, length: Int.max),
                      AccessibilitySelection(location: 1, length: Int.max), AccessibilitySelection(location: Int.min, length: Int.max),
                      AccessibilitySelection(location: 0, length: Int.min)] {
            try accessibilityTextCheck(AccessibilityTextEdit.insert("X", into: textState("abc", location: range.location, length: range.length)) == nil,
                                       "Negative, out-of-bounds and overflowing selections fail before any index addition or slicing.")
        }
    }
    try test {
        for state in [textState("", location: 0), textState("abc", location: 1), textState("abc", location: 0, length: 3)] {
            try accessibilityTextCheck(AccessibilityTextEdit.insert("", into: state) == nil,
                                       "An empty insertion is not an implicit delete or a successful text action.")
        }
    }
    try test {
        let maximum = String(repeating: "a", count: 4000)
        guard let inserted = AccessibilityTextEdit.insert(maximum, into: textState("", location: 0)),
              let appended = AccessibilityTextEdit.insert("b", into: textState(String(repeating: "a", count: 3999), location: 3999)) else {
            throw AccessibilityTextTestFailure(message: "A result exactly at the 4000-unit limit must be representable.")
        }
        try accessibilityTextCheck(inserted.value.utf8.elementsEqual(maximum.utf8) && inserted.selection.location == 4000 &&
                                   appended.value.utf16.count == 4000 && appended.selection.location == 4000,
                                   "The full value limit includes existing text and inserted text, with the exact limit accepted.")
        try accessibilityTextCheck(AccessibilityTextEdit.insert("b", into: textState(maximum, location: 4000)) == nil &&
                                   AccessibilityTextEdit.insert(maximum + "b", into: textState("", location: 0)) == nil &&
                                   AccessibilityTextEdit.insert("b", into: textState(maximum + "a", location: 0, length: 4001)) == nil,
                                   "An oversized result, insertion or original field is refused rather than truncated.")
    }
    try test {
        let maximum = String(repeating: "a", count: 4000)
        guard let sameSize = AccessibilityTextEdit.insert("b", into: textState(maximum, location: 3999, length: 1)),
              let replaced = AccessibilityTextEdit.insert("X", into: textState(maximum, location: 0, length: 4000)) else {
            throw AccessibilityTextTestFailure(message: "Selected content must be subtracted before testing the result size.")
        }
        try accessibilityTextCheck(sameSize.value.utf16.count == 4000 && sameSize.selection.location == 4000 &&
                                   replaced.value.utf8.elementsEqual("X".utf8) && replaced.selection == AccessibilitySelection(location: 1, length: 0),
                                   "Replacing a bounded full field can preserve its size or shrink it without exceeding the growth cap.")
    }
    try test {
        let maximum = String(repeating: "😀", count: 2000)
        guard let inserted = AccessibilityTextEdit.insert(maximum, into: textState("", location: 0)),
              let replaced = AccessibilityTextEdit.insert("a", into: textState(maximum, location: 3998, length: 2)) else {
            throw AccessibilityTextTestFailure(message: "A 4000-unit astral value and whole-pair replacement should be allowed.")
        }
        try accessibilityTextCheck(inserted.value.utf8.elementsEqual(maximum.utf8) && inserted.selection.location == 4000 &&
                                   replaced.value.utf16.count == 3999 && replaced.selection.location == 3999,
                                   "The text limit counts UTF16 units rather than emoji or grapheme counts.")
        try accessibilityTextCheck(AccessibilityTextEdit.insert(maximum + "😀", into: textState("", location: 0)) == nil &&
                                   AccessibilityTextEdit.insert("a", into: textState(maximum, location: 4000)) == nil,
                                   "Astral content cannot double the permitted text size or grow an already full value.")
    }
    try test {
        let cases: [(old: String, location: Int, length: Int, inserted: String, expected: String, caret: Int)] = [
            ("café", 3, 1, "e\u{301}", "cafe\u{301}", 5), ("cafe\u{301}", 3, 2, "é", "café", 4),
            ("e\u{301}-z", 3, 1, "Q", "e\u{301}-Q", 4), ("e\u{301}", 1, 0, "x", "ex\u{301}", 2),
        ]
        for item in cases {
            guard let result = AccessibilityTextEdit.insert(item.inserted, into: textState(item.old, location: item.location, length: item.length)) else {
                throw AccessibilityTextTestFailure(message: "A non-surrogate UTF16 selection must not depend on grapheme or normalization boundaries.")
            }
            try accessibilityTextCheck(result.value.utf8.elementsEqual(item.expected.utf8) &&
                                       result.selection == AccessibilitySelection(location: item.caret, length: 0),
                                       "Editing preserves exact NFC/NFD bytes and uses the original UTF16 selection without normalizing the field.")
        }
    }
    try test {
        let nfc = textState("é", location: 0), nfd = textState("e\u{301}", location: 0)
        try accessibilityTextCheck(!nfc.sameContent(nfd) && !nfd.sameContent(nfc),
                                   "Canonically equivalent Swift strings with different UTF8 bytes are different observed content.")
        try accessibilityTextCheck(nfc.sameContent(textState("é", location: 0)) &&
                                   !nfc.sameContent(textState("é", location: 1)) &&
                                   !nfc.sameContent(textState("é", location: 0, length: 1)) &&
                                   !nfc.sameContent(textState("e", location: 0)),
                                   "Content comparison includes exact bytes and both selection coordinates.")
        try accessibilityTextCheck(nfc.sameContent(textState("é", location: 0, valueSettable: false, selectionSettable: false)),
                                   "Content identity does not pretend that independently checked settable capabilities are text changes.")
    }
    try test {
        for valueSettable in [false, true] {
            for selectionSettable in [false, true] {
                let state = textState("a", location: 1, valueSettable: valueSettable, selectionSettable: selectionSettable)
                guard let result = AccessibilityTextEdit.insert("b", into: state) else {
                    throw AccessibilityTextTestFailure(message: "Pure edit calculation must retain, rather than replace, observed capability flags.")
                }
                try accessibilityTextCheck(result.valueSettable == valueSettable && result.selectionSettable == selectionSettable &&
                                           state.value.utf8.elementsEqual("a".utf8) && state.selection == AccessibilitySelection(location: 1, length: 0),
                                           "Computing a proposed value preserves both capability flags and leaves the original observation untouched.")
            }
        }
    }
    try test {
        let valid: [[UInt16]] = [[], [0x0000], [0x0041, 0x0301, 0xFFFF], [0xD800, 0xDC00], [0xDBFF, 0xDFFF],
                                 [0x0041, 0xD83D, 0xDE00, 0x0042, 0xD83C, 0xDF0D]]
        for units in valid {
            try accessibilityTextCheck(AccessibilityTextEdit.validUnicode(units),
                                       "Well-formed UTF16 accepts BMP units and complete surrogate pairs, including scalar limits and adjacent text.")
        }
    }
    try test {
        let invalid: [[UInt16]] = [[0xD800], [0xDBFF], [0xDC00], [0xDFFF], [0xDC00, 0xD800],
                                   [0xD800, 0x0041], [0xD800, 0xD800, 0xDC00], [0xD800, 0xDC00, 0xDC00],
                                   [0x0041, 0xD83D, 0xDE00, 0xDBFF]]
        for units in invalid {
            try accessibilityTextCheck(!AccessibilityTextEdit.validUnicode(units),
                                       "Lone, reversed, doubled or truncated surrogates fail directly before String decoding could repair them.")
        }
    }
    return count
}
