import Foundation
import Dispatch
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

let maxFrameBytes = 16 * 1024 * 1024
private let maximumSafeInteger: Int64 = 9_007_199_254_740_991

/// JSON stays typed across the native boundary; booleans and fractional numbers never become integer IDs.
indirect enum JSONValue: Codable, Equatable {
    case null
    case bool(Bool)
    case integer(Int64)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        guard decoder.codingPath.count <= 64 else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "JSON nesting is too deep."))
        }
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Int64.self) { self = .integer(value) }
        else if let value = try? container.decode(Double.self), value.isFinite { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([JSONValue].self) { self = .array(value) }
        else { self = .object(try container.decode([String: JSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .integer(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    var objectValue: [String: JSONValue]? { if case .object(let value) = self { return value }; return nil }
    var arrayValue: [JSONValue]? { if case .array(let value) = self { return value }; return nil }
    var stringValue: String? { if case .string(let value) = self { return value }; return nil }
    var boolValue: Bool? { if case .bool(let value) = self { return value }; return nil }
    var intValue: Int? {
        switch self {
        case .integer(let value):
            guard value >= -maximumSafeInteger, value <= maximumSafeInteger else { return nil }
            return Int(exactly: value)
        case .number(let value):
            guard value.isFinite, value.rounded(.towardZero) == value,
                  value >= -Double(maximumSafeInteger), value <= Double(maximumSafeInteger) else { return nil }
            return Int(exactly: value)
        default: return nil
        }
    }
    var doubleValue: Double? {
        switch self {
        case .integer(let value): return value >= -maximumSafeInteger && value <= maximumSafeInteger ? Double(value) : nil
        case .number(let value): return value.isFinite ? value : nil
        default: return nil
        }
    }
    subscript(_ key: String) -> JSONValue? { objectValue?[key] }
}

enum ProtocolError: Error {
    case invalidRequest(id: Int, code: String)
    case invalidEnvelope
    case frameTooLarge
    case imageLengthMismatch
    case invalidDescriptor
    case shortWrite
}

struct Request: Codable, Equatable {
    let id: Int
    let op: String
    let args: [String: JSONValue]

    init(id: Int, op: String, args: [String: JSONValue] = [:]) throws {
        guard id > 0, Int64(id) <= maximumSafeInteger else { throw ProtocolError.invalidRequest(id: 0, code: "failed") }
        guard !op.isEmpty, op.utf8.count <= 128 else { throw ProtocolError.invalidRequest(id: id, code: "unsupported_action") }
        self.id = id
        self.op = op
        self.args = args.filter { $0.key != "id" && $0.key != "op" }
    }

    init(from decoder: Decoder) throws {
        let value = try JSONValue(from: decoder)
        guard var object = value.objectValue, let id = object["id"]?.intValue, id > 0 else {
            throw ProtocolError.invalidRequest(id: 0, code: "failed")
        }
        guard let op = object["op"]?.stringValue else {
            throw ProtocolError.invalidRequest(id: id, code: "unsupported_action")
        }
        object.removeValue(forKey: "id")
        object.removeValue(forKey: "op")
        try self.init(id: id, op: op, args: object)
    }

    func encode(to encoder: Encoder) throws {
        var object = args
        object["id"] = .integer(Int64(id))
        object["op"] = .string(op)
        try JSONValue.object(object).encode(to: encoder)
    }
}

struct Response: Codable, Equatable {
    let value: JSONValue

    static func success(id: Int, fields: [String: JSONValue] = [:]) -> Response {
        var object = fields.filter { !["id", "ok", "code", "error"].contains($0.key) }
        object["id"] = .integer(Int64(id))
        object["ok"] = .bool(true)
        return Response(value: .object(object))
    }

    static func failure(id: Int, code: String, error: String) -> Response {
        let prefix = Array(error.utf16.prefix(2000))
        let units = prefix.last.map { (0xD800...0xDBFF).contains($0) } == true ? Array(prefix.dropLast()) : prefix
        return Response(value: .object([
            "id": .integer(Int64(id)), "ok": .bool(false), "code": .string(code),
            "error": .string(String(decoding: units, as: UTF16.self)),
        ]))
    }

    init(value: JSONValue) { self.value = value }
    init(from decoder: Decoder) throws {
        let value = try JSONValue(from: decoder)
        guard let object = value.objectValue, let id = object["id"]?.intValue, id >= 0,
              object["ok"]?.boolValue != nil, object["event"] == nil else { throw ProtocolError.invalidEnvelope }
        self.value = value
    }
    func encode(to encoder: Encoder) throws { try value.encode(to: encoder) }
}

struct Event: Codable, Equatable {
    let value: JSONValue

    init(name: String, fields: [String: JSONValue] = [:]) {
        var object = fields.filter { $0.key != "id" && $0.key != "event" }
        object["event"] = .string(name)
        value = .object(object)
    }
    init(from decoder: Decoder) throws {
        let value = try JSONValue(from: decoder)
        guard let object = value.objectValue, let name = object["event"]?.stringValue,
              !name.isEmpty, name.utf8.count <= 128, object["id"] == nil else { throw ProtocolError.invalidEnvelope }
        self.value = value
    }
    func encode(to encoder: Encoder) throws { try value.encode(to: encoder) }
}

/// Feed bounded pipe reads from the I/O queue. Oversized bodies are discarded without allocation or JSON parsing.
final class FrameReader {
    private var header: [UInt8] = []
    private var expected: Int?
    private var body = Data()
    private var discarded: UInt64 = 0

    func consume(_ data: Data, onRequest: (Request) -> Void, onFailure: (Response) -> Void) {
        consume(data, onSizedRequest: { request, _ in onRequest(request) }, onFailure: onFailure)
    }

    /// The bounded ingress queue accounts for actual wire bytes, including whitespace and the frame header.
    func consume(_ data: Data, onSizedRequest: (Request, Int) -> Void, onFailure: (Response) -> Void) {
        var cursor = data.startIndex
        while cursor < data.endIndex {
            if discarded > 0 {
                let count = min(discarded, UInt64(data.distance(from: cursor, to: data.endIndex)))
                cursor += Int(count)
                discarded -= count
                continue
            }
            if expected == nil {
                let count = min(4 - header.count, data.distance(from: cursor, to: data.endIndex))
                header.append(contentsOf: data[cursor..<(cursor + count)])
                cursor += count
                if header.count < 4 { continue }
                let length = header.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
                header.removeAll(keepingCapacity: true)
                if length > UInt32(maxFrameBytes) {
                    discarded = UInt64(length)
                    onFailure(.failure(id: 0, code: "frame_too_large", error: "The protocol frame exceeds its size limit."))
                    continue
                }
                if length == 0 {
                    onFailure(.failure(id: 0, code: "failed", error: "The protocol request is malformed."))
                    continue
                }
                expected = Int(length)
                body.reserveCapacity(Int(length))
            }
            let count = min(expected! - body.count, data.distance(from: cursor, to: data.endIndex))
            body.append(contentsOf: data[cursor..<(cursor + count)])
            cursor += count
            if body.count != expected { continue }
            let complete = body
            let wireBytes = complete.count + 4
            body = Data()
            expected = nil
            do {
                guard String(data: complete, encoding: .utf8) != nil else { throw ProtocolError.invalidEnvelope }
                onSizedRequest(try JSONDecoder().decode(Request.self, from: complete), wireBytes)
            } catch ProtocolError.invalidRequest(let id, let code) {
                onFailure(.failure(id: id, code: code, error: "The protocol request is malformed."))
            } catch {
                onFailure(.failure(id: 0, code: "failed", error: "The protocol request is malformed."))
            }
        }
    }

    /// EOF is terminal for the caller even if a peer closed halfway through a frame.
    func finish() -> Bool {
        let clean = header.isEmpty && expected == nil && discarded == 0
        header.removeAll()
        body = Data()
        expected = nil
        discarded = 0
        return clean
    }
}

/// One bounded serialization lease covers an entire JSON/binary pair and all short-write/EINTR retries.
final class FrameWriter {
    private let serialization = DispatchSemaphore(value: 1)
    private let writeBytes: (UnsafeRawBufferPointer) throws -> Int
    private let descriptor: Int32?
    private let writeTimeoutMs: Int

    init(descriptor: Int32 = 3, writeTimeoutMs: Int = 5000) {
        self.descriptor = descriptor
        self.writeTimeoutMs = max(1, min(10_000, writeTimeoutMs))
        writeBytes = { bytes in
            guard descriptor > STDERR_FILENO else { throw ProtocolError.invalidDescriptor }
            #if canImport(Darwin)
            let count = Darwin.write(descriptor, bytes.baseAddress, bytes.count)
            #else
            let count = Glibc.write(descriptor, bytes.baseAddress, bytes.count)
            #endif
            if count < 0 { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
            return count
        }
    }

    init(writeTimeoutMs: Int = 5000, writeBytes: @escaping (UnsafeRawBufferPointer) throws -> Int) {
        self.descriptor = nil
        self.writeTimeoutMs = max(1, min(10_000, writeTimeoutMs))
        self.writeBytes = writeBytes
    }

    static func frame(_ value: JSONValue) throws -> Data {
        try frameBytes(JSONEncoder().encode(value))
    }

    private static func frameBytes(_ bytes: Data) throws -> Data {
        guard bytes.count <= maxFrameBytes else { throw ProtocolError.frameTooLarge }
        let length = UInt32(bytes.count)
        var framed = Data([
            UInt8((length >> 24) & 0xff), UInt8((length >> 16) & 0xff),
            UInt8((length >> 8) & 0xff), UInt8(length & 0xff),
        ])
        framed.append(bytes)
        return framed
    }

    func write(_ response: Response, binary: Data? = nil) throws {
        let deadline = DispatchTime.now().uptimeNanoseconds + UInt64(writeTimeoutMs) * 1_000_000
        let imageBytes = response.value["imageBytes"]
        if let binary = binary {
            guard response.value["ok"]?.boolValue == true, let count = imageBytes?.intValue,
                  count > 0, count == binary.count else { throw ProtocolError.imageLengthMismatch }
        } else if imageBytes != nil { throw ProtocolError.imageLengthMismatch }
        let header = try FrameWriter.frame(response.value)
        let image = try binary.map(FrameWriter.frameBytes)
        guard serialization.wait(timeout: DispatchTime(uptimeNanoseconds: deadline)) == .success else {
            throw POSIXError(.ETIMEDOUT)
        }
        defer { serialization.signal() }
        try writeAll(header, deadline: deadline)
        if let image = image { try writeAll(image, deadline: deadline) }
    }

    func write(_ event: Event) throws {
        let deadline = DispatchTime.now().uptimeNanoseconds + UInt64(writeTimeoutMs) * 1_000_000
        let frame = try FrameWriter.frame(event.value)
        guard serialization.wait(timeout: DispatchTime(uptimeNanoseconds: deadline)) == .success else {
            throw POSIXError(.ETIMEDOUT)
        }
        defer { serialization.signal() }
        try writeAll(frame, deadline: deadline)
    }

    private func writable(until deadline: UInt64) throws {
        guard let descriptor = descriptor else { throw POSIXError(.EAGAIN) }
        while true {
            let now = DispatchTime.now().uptimeNanoseconds
            guard now < deadline else { throw POSIXError(.ETIMEDOUT) }
            let remaining = Int32(min(UInt64(Int32.max), (deadline - now + 999_999) / 1_000_000))
            var item = pollfd(fd: descriptor, events: Int16(POLLOUT), revents: 0)
            let result = poll(&item, 1, remaining)
            if result > 0 {
                guard item.revents & Int16(POLLERR | POLLHUP | POLLNVAL) == 0,
                      item.revents & Int16(POLLOUT) != 0 else { throw POSIXError(.EPIPE) }
                return
            }
            if result == 0 { throw POSIXError(.ETIMEDOUT) }
            if errno != EINTR { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        }
    }

    private func writeAll(_ data: Data, deadline: UInt64) throws {
        try data.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
            var offset = 0
            while offset < bytes.count {
                guard DispatchTime.now().uptimeNanoseconds < deadline else { throw POSIXError(.ETIMEDOUT) }
                do {
                    let count = try writeBytes(UnsafeRawBufferPointer(rebasing: bytes[offset...]))
                    guard count > 0, count <= bytes.count - offset else { throw ProtocolError.shortWrite }
                    offset += count
                    guard DispatchTime.now().uptimeNanoseconds < deadline else { throw POSIXError(.ETIMEDOUT) }
                } catch let error as POSIXError where error.code == .EINTR { continue }
                catch let error as POSIXError where error.code.rawValue == EAGAIN || error.code.rawValue == EWOULDBLOCK {
                    try writable(until: deadline)
                }
            }
        }
    }
}
