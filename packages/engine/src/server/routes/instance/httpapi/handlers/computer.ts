import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ForbiddenError } from "@vectordevai/protocol/errors"
import { RequestPrincipal } from "@vectordevai/protocol/middleware/authorization"
import { ComputerPrune } from "@/computer/prune"
import { ComputerProtection } from "@/computer/protection"
import { InstanceHttpApi } from "../api"
import { InvalidRequestError, UnknownError } from "../errors"

export const computerHandlers = HttpApiBuilder.group(InstanceHttpApi, "computer", (handlers) =>
  Effect.gen(function* () {
    const screenshots = yield* ComputerPrune.Service
    const protection = yield* ComputerProtection.Service
    return handlers
      .handle("protectedPaths", () =>
        Effect.gen(function* () {
          const principal = yield* RequestPrincipal
          if (principal.kind !== "owner")
            return yield* new ForbiddenError({ message: "Only the server owner can read protected computer paths." })
          return yield* protection
            .read()
            .pipe(
              Effect.catchTag("ComputerProtectionError", () =>
                Effect.fail(new UnknownError({ message: "Protected computer paths could not be checked." })),
              ),
            )
        }),
      )
      .handle("pruneScreenshots", ({ payload }) =>
        Effect.gen(function* () {
          const principal = yield* RequestPrincipal
          if (principal.kind !== "owner")
            return yield* new ForbiddenError({ message: "Only the server owner can delete computer screenshots." })
          return yield* screenshots
            .prune(payload)
            .pipe(
              Effect.catchTag(
                "ComputerPruneError",
                (error): Effect.Effect<never, InvalidRequestError | UnknownError> =>
                  error.code === "invalid"
                    ? Effect.fail(new InvalidRequestError({ message: error.message }))
                    : Effect.fail(
                        new UnknownError({ message: "Stored computer screenshots could not be fully deleted." }),
                      ),
              ),
            )
        }),
      )
  }),
)
