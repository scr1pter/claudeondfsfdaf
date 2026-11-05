import Foundation
import Dispatch
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

private struct ProtocolTestFailure: Error, CustomStringConvertible {
    let description: String
}

private func protocolCheck(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !condition() { throw ProtocolTestFailure(description: message) }
}

private func protocolBody(_ body: Data) -> Data {
    let length = UInt32(body.count)
    var frame = Data([
        UInt8((length >> 24) & 0xff), UInt8((length >> 16) & 0xff),
        UInt8((length >> 8) & 0xff), UInt8(length & 0xff),
    ])
    frame.append(body)
    return frame
}

private func protocolFrames(_ data: Data) throws -> [Data] {
    var result: [Data] = []
    var cursor = 0
    while cursor < data.count {
        guard data.count - cursor >= 4 else { throw ProtocolTestFailure(description: "A writer truncated a frame header.") }
        let length = data[cursor..<(cursor + 4)].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        cursor += 4
        guard Int(length) <= data.count - cursor else { throw ProtocolTestFailure(description: "A writer truncated a frame body.") }
        result.append(data.subdata(in: cursor..<(cursor + Int(length))))
        cursor += Int(length)
    }
    return result
}

/// Called by the helper's standalone --self-test entry. No real desktop, permission prompt or XCTest is used.
func runProtocolTests() throws -> Int {
    var checks = 0
    let requestValue: JSONValue = .object([
        "id": .integer(42), "op": .string("hello"),
        "protocol": .object(["min": .integer(1), "max": .integer(1)]),
        "data": .array([.bool(true), .integer(3), .number(1.5), .null, .string("é 🧪")]),
    ])
    let decoder = JSONDecoder()
    let encoded = try JSONEncoder().encode(requestValue)
    try protocolCheck(try decoder.decode(JSONValue.self, from: encoded) == requestValue, "Typed JSON round-trip changed a value.")
    let request = try decoder.decode(Request.self, from: encoded)
    try protocolCheck(request.id == 42 && request.op == "hello", "The request envelope did not round-trip.")
    try protocolCheck(request.args["protocol"]?["min"]?.intValue == 1, "Request arguments were not flattened.")
    try protocolCheck(try decoder.decode(JSONValue.self, from: JSONEncoder().encode(request)) == requestValue, "Encoding a request changed its flattened wire.")
    try protocolCheck(JSONValue.bool(true).intValue == nil && JSONValue.number(1.5).intValue == nil, "Unsafe integer coercion was accepted.")
    try protocolCheck(JSONValue.integer(Int64.min).intValue == nil && JSONValue.integer(Int64.min).doubleValue == nil, "The minimum integer was converted unsafely.")
    checks += 1

    let reader = FrameReader()
    var requests: [Request] = []
    var failures: [Response] = []
    let frame = try FrameWriter.frame(requestValue)
    for byte in frame {
        reader.consume(Data([byte]), onRequest: { requests.append($0) }, onFailure: { failures.append($0) })
    }
    try protocolCheck(requests == [request] && failures.isEmpty, "Bytewise framing did not reassemble a request.")
    reader.consume(frame + frame, onRequest: { requests.append($0) }, onFailure: { failures.append($0) })
    try protocolCheck(requests.count == 3 && reader.finish(), "Coalesced frames were lost or left partial state.")
    checks += 1

    let raw = Data(" \n{  \"id\" : 43,  \"op\" : \"hello\",  \"extra\" : \"é 🧪\"  }\n ".utf8)
    let rawFrame = protocolBody(raw)
    let sized = FrameReader()
    var sizedRequests: [Request] = []
    var rawCosts: [Int] = []
    for byte in rawFrame + frame {
        sized.consume(Data([byte]), onSizedRequest: { request, bytes in
            sizedRequests.append(request); rawCosts.append(bytes)
        }, onFailure: { failures.append($0) })
    }
    try protocolCheck(sizedRequests.map(\.id) == [43, 42] && rawCosts == [rawFrame.count, frame.count] && sized.finish(),
                      "Sized ingress must retain exact UTF-8 wire costs including whitespace/header and request order across fragmented frames.")
    try protocolCheck(rawCosts[0] > (try JSONEncoder().encode(sizedRequests[0]).count + 4) && failures.isEmpty,
                      "Ingress cost must not be reduced by JSON normalization or request decoding.")
    checks += 1

    for body in ["{not json", "[1,2,3]", "{\"op\":\"hello\"}", "{\"id\":0,\"op\":\"hello\"}",
                 "{\"id\":-1,\"op\":\"hello\"}", "{\"id\":true,\"op\":\"hello\"}",
                 "{\"id\":1.5,\"op\":\"hello\"}", "{\"id\":9007199254740992,\"op\":\"hello\"}"] {
        let malformed = FrameReader()
        var observed: [Response] = []
        malformed.consume(protocolBody(Data(body.utf8)) + frame, onRequest: { _ in }, onFailure: { observed.append($0) })
        try protocolCheck(observed.count == 1 && observed[0].value["id"]?.intValue == 0 && observed[0].value["code"]?.stringValue == "failed", "Malformed input was not attributed to id zero.")
        try protocolCheck(malformed.finish(), "Malformed input prevented recovery at the next frame.")
    }
    let malformed = FrameReader()
    var malformedIDs: [Int] = []
    malformed.consume(protocolBody(Data([0xff])) + protocolBody(Data()) + protocolBody(Data("{\"id\":7,\"op\":false}".utf8)),
                      onRequest: { _ in }, onFailure: { malformedIDs.append($0.value["id"]!.intValue!) })
    try protocolCheck(malformedIDs == [0, 0, 7], "UTF-8, empty-body or attributable operation errors were misrouted.")
    checks += 1

    let oversized = FrameReader()
    var oversizedRequests: [Request] = []
    var oversizedFailures: [Response] = []
    let length = UInt32(maxFrameBytes + 1)
    let header = Data([UInt8(length >> 24), UInt8((length >> 16) & 0xff), UInt8((length >> 8) & 0xff), UInt8(length & 0xff)])
    oversized.consume(header, onRequest: { oversizedRequests.append($0) }, onFailure: { oversizedFailures.append($0) })
    try protocolCheck(oversizedFailures.count == 1 && oversizedFailures[0].value["code"]?.stringValue == "frame_too_large", "Oversize was not refused before its body arrived.")
    let chunk = Data(repeating: 0, count: 64 * 1024)
    for _ in 0..<(maxFrameBytes / chunk.count) {
        oversized.consume(chunk, onRequest: { oversizedRequests.append($0) }, onFailure: { oversizedFailures.append($0) })
    }
    oversized.consume(Data([0]) + frame, onRequest: { oversizedRequests.append($0) }, onFailure: { oversizedFailures.append($0) })
    try protocolCheck(oversizedFailures.count == 1 && oversizedRequests == [request] && oversized.finish(), "Oversize discard lost stream alignment.")
    checks += 1

    for partial in [Data([0, 0]), protocolBody(Data("{}".utf8)).dropLast()] {
        let truncated = FrameReader()
        truncated.consume(Data(partial), onRequest: { _ in }, onFailure: { _ in })
        try protocolCheck(!truncated.finish() && truncated.finish(), "EOF did not reset partial framing state.")
    }
    let truncatedOversize = FrameReader()
    truncatedOversize.consume(header, onRequest: { _ in }, onFailure: { _ in })
    try protocolCheck(!truncatedOversize.finish(), "EOF during oversize discard was reported as a complete stream.")
    checks += 1

    let success = Response.success(id: 9, fields: ["id": .integer(99), "ok": .bool(false), "code": .string("forged"), "value": .string("fixed")])
    try protocolCheck(success.value["id"]?.intValue == 9 && success.value["ok"]?.boolValue == true && success.value["code"] == nil, "Response fields replaced a fixed envelope.")
    let event = Event(name: "stop", fields: ["id": .integer(99), "event": .string("forged"), "by": .string("esc")])
    try protocolCheck(event.value["id"] == nil && event.value["event"]?.stringValue == "stop", "Event fields replaced a fixed envelope.")
    try protocolCheck(try decoder.decode(Response.self, from: JSONEncoder().encode(success)) == success, "Response Codable changed the wire.")
    try protocolCheck(try decoder.decode(Event.self, from: JSONEncoder().encode(event)) == event, "Event Codable changed the wire.")
    let failure = Response.failure(id: 0, code: "failed", error: String(repeating: "🧪", count: 2000))
    try protocolCheck((failure.value["error"]?.stringValue?.utf16.count ?? 0) <= 2000, "A failure exceeded the wire's UTF-16 string limit.")
    checks += 1

    var output = Data()
    var interrupted = false
    let writer = FrameWriter(writeBytes: { bytes in
        if !interrupted { interrupted = true; throw POSIXError(.EINTR) }
        let count = min(3, bytes.count)
        output.append(contentsOf: bytes.prefix(count))
        return count
    })
    let image = Data([137, 80, 78, 71, 0, 1, 2, 3])
    let capture = Response.success(id: 10, fields: ["imageBytes": .integer(Int64(image.count))])
    try writer.write(capture, binary: image)
    try writer.write(event)
    let frames = try protocolFrames(output)
    try protocolCheck(frames.count == 3 && frames[1] == image, "Image header/binary framing did not pair.")
    try protocolCheck(try decoder.decode(Response.self, from: frames[0]) == capture, "The capture header did not round-trip.")
    try protocolCheck(try decoder.decode(Event.self, from: frames[2]) == event, "Partial writes or EINTR corrupted the following event.")
    let before = output
    do { try writer.write(capture); throw ProtocolTestFailure(description: "An image header was sent without its binary frame.") }
    catch ProtocolError.imageLengthMismatch {}
    do { try writer.write(capture, binary: Data([0])); throw ProtocolTestFailure(description: "A wrong image length was sent.") }
    catch ProtocolError.imageLengthMismatch {}
    try protocolCheck(output == before, "A rejected image pair partially wrote its header.")
    let tooLarge = Data(repeating: 0, count: maxFrameBytes + 1)
    do {
        try writer.write(.success(id: 11, fields: ["imageBytes": .integer(Int64(tooLarge.count))]), binary: tooLarge)
        throw ProtocolTestFailure(description: "An outbound binary frame exceeded the size limit.")
    } catch ProtocolError.frameTooLarge {}
    try protocolCheck(output == before, "An oversized outbound image wrote a partial header.")
    checks += 1

    let zero = FrameWriter(writeBytes: { _ in 0 })
    do { try zero.write(success); throw ProtocolTestFailure(description: "A zero-byte write did not fail.") }
    catch ProtocolError.shortWrite {}
    let stdout = FrameWriter(descriptor: 1)
    do { try stdout.write(success); throw ProtocolTestFailure(description: "Serving wrote a protocol frame to stdout.") }
    catch ProtocolError.invalidDescriptor {}
    checks += 1

    var descriptors: [Int32] = [-1, -1]
    guard pipe(&descriptors) == 0 else { throw ProtocolTestFailure(description: "The isolated protocol test pipe could not open.") }
    defer { close(descriptors[0]); close(descriptors[1]) }
    let flags = fcntl(descriptors[1], F_GETFL)
    guard flags >= 0, fcntl(descriptors[1], F_SETFL, flags | O_NONBLOCK) == 0 else {
        throw ProtocolTestFailure(description: "The isolated protocol test pipe could not be nonblocking.")
    }
    let filler = Data(repeating: 0, count: 4096)
    while true {
        let count = filler.withUnsafeBytes { bytes in write(descriptors[1], bytes.baseAddress, bytes.count) }
        if count >= 0 { continue }
        if errno == EINTR { continue }
        guard errno == EAGAIN || errno == EWOULDBLOCK else {
            throw ProtocolTestFailure(description: "The isolated protocol test pipe failed before saturation.")
        }
        break
    }
    let blocked = FrameWriter(descriptor: descriptors[1], writeTimeoutMs: 1)
    do {
        try blocked.write(success)
        throw ProtocolTestFailure(description: "A saturated nonblocking channel did not time out.")
    } catch let error as POSIXError where error.code == .ETIMEDOUT {}
    checks += 1

    let firstEntered = DispatchSemaphore(value: 0)
    let releaseFirst = DispatchSemaphore(value: 0)
    let firstFinished = DispatchSemaphore(value: 0)
    let contentionLock = NSLock()
    var contentionCalls = 0
    var contentionOutput = Data()
    var firstFailure: Error?
    let contended = FrameWriter(writeTimeoutMs: 50, writeBytes: { bytes in
        contentionLock.lock()
        contentionCalls += 1
        let first = contentionCalls == 1
        contentionLock.unlock()
        if first {
            firstEntered.signal()
            guard releaseFirst.wait(timeout: .now() + .milliseconds(500)) == .success else { throw POSIXError(.ETIMEDOUT) }
        }
        contentionLock.lock()
        contentionOutput.append(contentsOf: bytes)
        contentionLock.unlock()
        return bytes.count
    })
    defer { releaseFirst.signal() }
    DispatchQueue.global(qos: .userInitiated).async {
        defer { firstFinished.signal() }
        do { try contended.write(success) }
        catch { contentionLock.lock(); firstFailure = error; contentionLock.unlock() }
    }
    let entered = firstEntered.wait(timeout: .now() + .milliseconds(500)) == .success
    var contentionTimedOut = false
    if entered {
        do { try contended.write(event) }
        catch let error as POSIXError where error.code == .ETIMEDOUT { contentionTimedOut = true }
        catch {}
    }
    contentionLock.lock()
    let rejectedWithoutWrite = contentionCalls == 1 && contentionOutput.isEmpty
    contentionLock.unlock()
    releaseFirst.signal()
    let joined = firstFinished.wait(timeout: .now() + .milliseconds(500)) == .success
    try protocolCheck(entered && joined && contentionTimedOut && rejectedWithoutWrite,
                      "A contending writer must use its own total deadline without entering the held callback or writing a partial frame.")
    contentionLock.lock()
    let firstTimedOut = (firstFailure as? POSIXError)?.code == .ETIMEDOUT
    contentionLock.unlock()
    try protocolCheck(firstTimedOut, "The first writer's expired budget must not restart after its blocked callback returns.")
    let freshEvent = Event(name: "stop", fields: ["by": .string("chord")])
    try contended.write(freshEvent)
    let contentionFrames = try protocolFrames(contentionOutput)
    try protocolCheck(contentionFrames.count == 2 &&
                      (try decoder.decode(Response.self, from: contentionFrames[0])) == success &&
                      (try decoder.decode(Event.self, from: contentionFrames[1])) == freshEvent,
                      "A writer timeout must release serialization for a fresh write without leaking the rejected frame.")
    checks += 1

    var concurrentOutput = Data()
    let concurrent = FrameWriter(writeBytes: { bytes in
        let count = min(5, bytes.count)
        concurrentOutput.append(contentsOf: bytes.prefix(count))
        return count
    })
    let errorsLock = NSLock()
    var failed = false
    DispatchQueue.concurrentPerform(iterations: 16) { index in
        do {
            try concurrent.write(.success(id: index + 1, fields: ["imageBytes": .integer(Int64(image.count))]), binary: image)
            try concurrent.write(Event(name: "stop", fields: ["by": .string("esc")]))
        } catch { errorsLock.lock(); failed = true; errorsLock.unlock() }
    }
    let concurrentFrames = try protocolFrames(concurrentOutput)
    try protocolCheck(!failed && concurrentFrames.count == 48, "Concurrent responses lost a frame.")
    var index = 0
    var pairs = 0
    while index < concurrentFrames.count {
        let value = try decoder.decode(JSONValue.self, from: concurrentFrames[index])
        if value["imageBytes"] != nil {
            try protocolCheck(index + 1 < concurrentFrames.count && concurrentFrames[index + 1] == image, "An event interleaved between an image header and its binary frame.")
            pairs += 1
            index += 2
        } else { index += 1 }
    }
    try protocolCheck(pairs == 16, "Concurrent image pairing lost a response.")
    checks += 1
    return checks
}
