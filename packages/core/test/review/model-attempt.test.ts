import { expect, test } from "bun:test"
import { createServer } from "node:http"
import { ModelAttempt } from "../../src/review/model-attempt"

const url = "http://127.0.0.1/model-attempt-fixture"
const refused = (value: Promise<unknown>) => expect(value).rejects.toBeInstanceOf(ModelAttempt.Refused)

test("a genuine asynchronous checkpoint finishes before any send and its inputs cannot be replaced", async () => {
  const started = Promise.withResolvers<void>()
  const decision = Promise.withResolvers<boolean>()
  const owner = new AbortController()
  const counts = { checks: 0, sends: 0 }
  const input = {
    owner: owner.signal,
    checkpoint: async () => {
      counts.checks++
      started.resolve()
      return decision.promise
    },
    send: async () => {
      counts.sends++
      return new Response("accepted", { status: 201, statusText: "Created", headers: { "x-fixture": "safe" } })
    },
  }
  const lease = ModelAttempt.create(input)
  input.checkpoint = async () => false
  input.send = async () => {
    throw new Error("Replaced callback must not run")
  }
  expect(Object.isFrozen(lease)).toBe(true)
  expect(Object.isFrozen(lease.fetch)).toBe(true)
  const waiting = lease.fetch(url)
  await started.promise
  expect(counts).toEqual({ checks: 1, sends: 0 })
  decision.resolve(true)
  const response = await waiting
  expect(response.status).toBe(201)
  expect(response.statusText).toBe("Created")
  expect(response.headers.get("x-fixture")).toBe("safe")
  expect(await response.text()).toBe("accepted")
  expect(counts).toEqual({ checks: 1, sends: 1 })
  await lease.release()
})

test("each repeated HTTP call needs a fresh decision, including the call after a retryable response", async () => {
  const counts = { checks: 0, sends: 0 }
  const lease = ModelAttempt.create({
    owner: new AbortController().signal,
    checkpoint: async () => ++counts.checks === 1,
    send: async () => {
      counts.sends++
      return new Response("busy", { status: 503 })
    },
  })
  expect((await lease.fetch(url)).status).toBe(503)
  await refused(lease.fetch(url))
  await refused(lease.fetch(url))
  expect(counts).toEqual({ checks: 2, sends: 1 })
  expect(lease.signal.aborted).toBe(true)
  await lease.release()
})

test.each(["false", "throw"])("checkpoint %s permanently refuses without exposing its diagnostic", async (mode) => {
  const counts = { checks: 0, sends: 0 }
  const lease = ModelAttempt.create({
    owner: new AbortController().signal,
    checkpoint: async () => {
      counts.checks++
      if (mode === "throw") throw new Error("PRIVATE_CHECKPOINT_DIAGNOSTIC")
      return false
    },
    send: async () => {
      counts.sends++
      return new Response("must not send")
    },
  })
  const error = await lease.fetch(url).then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(error).toBeInstanceOf(ModelAttempt.Refused)
  expect(String(error)).not.toContain("PRIVATE_CHECKPOINT_DIAGNOSTIC")
  await refused(lease.fetch(url))
  expect(counts).toEqual({ checks: 1, sends: 0 })
  await lease.release()
})

test("an already-aborted owner never checkpoints, and a release cannot be reversed by a late decision", async () => {
  const aborted = new AbortController()
  aborted.abort()
  const counts = { checks: 0, sends: 0 }
  const decision = Promise.withResolvers<boolean>()
  const started = Promise.withResolvers<void>()
  const create = (owner: AbortSignal) =>
    ModelAttempt.create({
      owner,
      checkpoint: async () => {
        counts.checks++
        started.resolve()
        return decision.promise
      },
      send: async () => {
        counts.sends++
        return new Response("never")
      },
    })
  const closed = create(aborted.signal)
  await refused(closed.fetch(url))
  expect(counts).toEqual({ checks: 0, sends: 0 })
  const lease = create(new AbortController().signal)
  const waiting = lease.fetch(url)
  void waiting.catch(() => {})
  await started.promise
  await lease.release()
  await refused(waiting)
  decision.resolve(true)
  await decision.promise
  await refused(lease.fetch(url))
  expect(counts).toEqual({ checks: 1, sends: 0 })
})

test("owner abort interrupts a checkpoint that ignores its signal and keeps every later send refused", async () => {
  const owner = new AbortController()
  const decision = Promise.withResolvers<boolean>()
  const started = Promise.withResolvers<AbortSignal>()
  let sends = 0
  const lease = ModelAttempt.create({
    owner: owner.signal,
    checkpoint: async (signal) => {
      started.resolve(signal)
      return decision.promise
    },
    send: async () => {
      sends++
      return new Response("never")
    },
  })
  const waiting = lease.fetch(url)
  void waiting.catch(() => {})
  const combined = await started.promise
  owner.abort()
  await refused(waiting)
  expect(combined.aborted).toBe(true)
  decision.resolve(true)
  await refused(lease.fetch(url))
  expect(sends).toBe(0)
  await lease.release()
})

test("init signal overrides Request signal (including null), while owner authority is never dropped", async () => {
  for (const override of ["live", "null"] as const) {
    const owner = new AbortController()
    const request = new AbortController()
    request.abort()
    const counts = { checks: 0, sends: 0 }
    const lease = ModelAttempt.create({
      owner: owner.signal,
      checkpoint: async (signal) => {
        counts.checks++
        expect(signal.aborted).toBe(false)
        return true
      },
      send: async (_input, init) => {
        counts.sends++
        expect(init?.signal?.aborted).toBe(false)
        expect(init?.redirect).toBe("error")
        return new Response("valid override")
      },
    })
    expect(
      await (
        await lease.fetch(new Request(url, { signal: request.signal }), {
          signal: override === "null" ? null : new AbortController().signal,
        })
      ).text(),
    ).toBe("valid override")
    owner.abort()
    await refused(lease.fetch(url))
    expect(counts).toEqual({ checks: 1, sends: 1 })
    await lease.release()
  }
})

test("a request aborted before or during its checkpoint starts no HTTP send", async () => {
  for (const before of [true, false]) {
    const request = new AbortController()
    if (before) request.abort()
    const counts = { checks: 0, sends: 0 }
    const lease = ModelAttempt.create({
      owner: new AbortController().signal,
      checkpoint: async () => {
        counts.checks++
        request.abort()
        return true
      },
      send: async () => {
        counts.sends++
        return new Response("must not send")
      },
    })
    await refused(lease.fetch(url, { signal: request.signal }))
    expect(counts).toEqual({ checks: before ? 0 : 1, sends: 0 })
    expect(lease.signal.aborted).toBe(true)
    await refused(lease.fetch(url))
    await lease.release()
  }
})

test("effective request abort poisons a lease and cancels a body even with a locked consumer reader", async () => {
  const request = new AbortController()
  const cancelled = Promise.withResolvers<void>()
  const counts = { checks: 0, sends: 0, cancels: 0 }
  const signals: AbortSignal[] = []
  const lease = ModelAttempt.create({
    owner: new AbortController().signal,
    checkpoint: async (signal) => {
      signals.push(signal)
      counts.checks++
      return true
    },
    send: async (_input, init) => {
      counts.sends++
      expect(init?.signal).toBe(signals[0])
      return new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            counts.cancels++
            cancelled.resolve()
          },
        }),
      )
    },
  })
  const response = await lease.fetch(new Request(url, { signal: request.signal }))
  const reader = response.body!.getReader()
  const reading = reader.read()
  void reading.catch(() => {})
  request.abort()
  await refused(reading)
  await cancelled.promise
  await lease.release()
  await refused(lease.fetch(url))
  expect(counts).toEqual({ checks: 1, sends: 1, cancels: 1 })
  expect(signals[0]?.aborted).toBe(true)
  reader.releaseLock()
})

test("finishing one request cannot detach the owner's abort or another request's shared signal", async () => {
  for (const sharedOwner of [true, false]) {
    const owner = new AbortController()
    const shared = sharedOwner ? owner : new AbortController()
    const waiting = Promise.withResolvers<boolean>()
    const checking = Promise.withResolvers<void>()
    const counts = { checks: 0, sends: 0 }
    const lease = ModelAttempt.create({
      owner: owner.signal,
      checkpoint: async () => {
        if (++counts.checks === 1) return true
        checking.resolve()
        return waiting.promise
      },
      send: async () => {
        counts.sends++
        return new Response(null, { status: 204 })
      },
    })
    const first = lease.fetch(url, { signal: shared.signal })
    const second = lease.fetch(url, { signal: shared.signal })
    void second.catch(() => {})
    await checking.promise
    expect((await first).status).toBe(204)
    shared.abort()
    await refused(second)
    expect(lease.signal.aborted).toBe(true)
    waiting.resolve(true)
    await refused(lease.fetch(url))
    expect(counts).toEqual({ checks: 2, sends: 1 })
    await lease.release()
  }
})

test("release waits for acquired body cleanup and closes every concurrent response exactly once", async () => {
  const cancelling = Promise.withResolvers<void>()
  const complete = Promise.withResolvers<void>()
  const counts = { sends: 0, cancels: 0 }
  const lease = ModelAttempt.create({
    owner: new AbortController().signal,
    checkpoint: async () => true,
    send: async () => {
      counts.sends++
      return new Response(
        new ReadableStream<Uint8Array>({
          async cancel() {
            counts.cancels++
            if (counts.cancels === 2) cancelling.resolve()
            await complete.promise
          },
        }),
      )
    },
  })
  const responses = await Promise.all([lease.fetch(url), lease.fetch(url)])
  const reader = responses[0]!.body!.getReader()
  const reading = reader.read()
  void reading.catch(() => {})
  let released = false
  const closing = lease.release().then(() => {
    released = true
  })
  await cancelling.promise
  expect(released).toBe(false)
  await refused(reading)
  complete.resolve()
  await closing
  await lease.release()
  expect(counts).toEqual({ sends: 2, cancels: 2 })
  await refused(lease.fetch(url))
  reader.releaseLock()
})

test("a sender completing after abort cannot leak an unowned late response body", async () => {
  const owner = new AbortController()
  const started = Promise.withResolvers<void>()
  const answer = Promise.withResolvers<Response>()
  const cancelled = Promise.withResolvers<void>()
  let cancels = 0
  const lease = ModelAttempt.create({
    owner: owner.signal,
    checkpoint: async () => true,
    send: async () => {
      started.resolve()
      return answer.promise
    },
  })
  const waiting = lease.fetch(url)
  void waiting.catch(() => {})
  await started.promise
  owner.abort()
  await refused(waiting)
  await lease.release()
  answer.resolve(
    new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancels++
          cancelled.resolve()
        },
      }),
    ),
  )
  await cancelled.promise
  await lease.release()
  expect(cancels).toBe(1)
})

test("normal terminal-frame body cancellation permits a later freshly checked request", async () => {
  const counts = { checks: 0, cancels: 0 }
  const lease = ModelAttempt.create({
    owner: new AbortController().signal,
    checkpoint: async () => {
      counts.checks++
      return true
    },
    send: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            counts.cancels++
          },
        }),
      ),
  })
  await (await lease.fetch(url)).body!.cancel()
  expect(lease.signal.aborted).toBe(false)
  await (await lease.fetch(url)).body!.cancel()
  expect(counts).toEqual({ checks: 2, cancels: 2 })
  await lease.release()
})

test("null-body HTTP responses retain their status and identity without double consumption", async () => {
  const received = [new Response(null), ...[204, 205, 304].map((status) => new Response(null, { status }))]
  let index = 0
  const lease = ModelAttempt.create({
    owner: new AbortController().signal,
    checkpoint: async () => true,
    send: async () => received[index++]!,
  })
  for (const raw of received) {
    const response = await lease.fetch(url, { method: "HEAD" })
    expect(response).toBe(raw)
    expect(response.body).toBe(null)
    expect(await response.text()).toBe("")
  }
  await lease.release()
})

test("Response.error is preserved only without a body; an unsupported body is refused and actually cancelled", async () => {
  const response = Response.error()
  const body = response.body
  const counts = { sends: 0, cancels: 0 }
  const cancelled = Promise.withResolvers<boolean>()
  if (body) {
    // Tap this one fixture stream, then delegate to its real runtime cancellation; no global API is replaced.
    const original = body.cancel.bind(body)
    body.cancel = (reason?: unknown) => {
      counts.cancels++
      return original(reason).then(
        () => cancelled.resolve(true),
        (error: unknown) => {
          cancelled.resolve(false)
          throw error
        },
      )
    }
  }
  const lease = ModelAttempt.create({
    owner: new AbortController().signal,
    checkpoint: async () => true,
    send: async () => {
      counts.sends++
      return response
    },
  })
  if (!body) {
    expect(await lease.fetch(url)).toBe(response)
    expect(counts).toEqual({ sends: 1, cancels: 0 })
    await lease.release()
    return
  }
  await refused(lease.fetch(url))
  expect(lease.signal.aborted).toBe(true)
  const clean = await cancelled.promise
  const released = await lease.release().then(
    () => true,
    (error: unknown) => {
      expect(error).toBeInstanceOf(ModelAttempt.Refused)
      return false
    },
  )
  expect(released).toBe(clean)
  expect(counts).toEqual({ sends: 1, cancels: 1 })
  await refused(lease.fetch(url))
})

test("body bytes are consumed once; ordinary transport failure still requires a new checkpoint", async () => {
  const counts = { checks: 0, sends: 0, pulls: 0 }
  const source = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        counts.pulls++
        if (counts.pulls === 1) controller.enqueue(new TextEncoder().encode("first"))
        if (counts.pulls === 2) controller.enqueue(new TextEncoder().encode("second"))
        if (counts.pulls === 3) controller.close()
      },
    }),
  )
  const lease = ModelAttempt.create({
    owner: new AbortController().signal,
    checkpoint: async () => {
      counts.checks++
      return true
    },
    send: async () => {
      if (++counts.sends === 1) throw new Error("fixed transport failure")
      return source
    },
  })
  await expect(lease.fetch(url)).rejects.toThrow("fixed transport failure")
  expect(await (await lease.fetch(url)).text()).toBe("firstsecond")
  expect(source.bodyUsed).toBe(true)
  expect(counts).toEqual({ checks: 2, sends: 2, pulls: 3 })
  await lease.release()
})

test("a failed cancellation never reports successful release or exposes its raw diagnostic", async () => {
  const lease = ModelAttempt.create({
    owner: new AbortController().signal,
    checkpoint: async () => true,
    send: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            throw new Error("PRIVATE_BODY_CLEANUP_DIAGNOSTIC")
          },
        }),
      ),
  })
  await lease.fetch(url)
  const error = await lease.release().then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(error).toBeInstanceOf(ModelAttempt.Refused)
  expect(String(error)).not.toContain("PRIVATE_BODY_CLEANUP_DIAGNOSTIC")
  await refused(lease.release())
  await refused(lease.fetch(url))
})

test("an actual loopback redirect has a positive unbound control and no leased second-hop request", async () => {
  const counts = { origin: 0, target: 0, checks: 0 }
  const server = createServer((request, response) => {
    if (request.url === "/redirect") {
      counts.origin++
      response.writeHead(302, { location: "/target" })
      response.end()
      return
    }
    counts.target++
    response.end("fixed local control")
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  try {
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing loopback fixture address")
    const target = `http://127.0.0.1:${address.port}/redirect`
    expect(await (await fetch(target)).text()).toBe("fixed local control")
    expect(counts).toEqual({ origin: 1, target: 1, checks: 0 })
    const lease = ModelAttempt.create({
      owner: new AbortController().signal,
      checkpoint: async () => {
        counts.checks++
        return true
      },
      send: (input, init) => fetch(input, init),
    })
    await expect(lease.fetch(target, { redirect: "follow" })).rejects.toThrow()
    expect(counts).toEqual({ origin: 2, target: 1, checks: 1 })
    await lease.release()
  } finally {
    expect(server.listening).toBe(true)
    const closed = new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    server.closeAllConnections()
    await closed
  }
})
