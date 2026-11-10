export * as ServerAuth from "./auth"
export {
  assertSecurePasswordTransport,
  isOwnerOnlyRoute,
  ownerPrincipal,
  principal,
  refusedRequest,
  unauthorizedMessage,
} from "@vectordevai/server/auth"

import { Flag } from "@vectordevai/core/flag/flag"
import { legacyName } from "@vectordevai/core/flag/legacy"
import { SessionV2 } from "@vectordevai/core/session"
import { WorkspaceV2 } from "@vectordevai/core/workspace"
import { Config as EffectConfig, Context, Effect, Layer, Option, Redacted, Schema } from "effect"

export type Credentials = {
  password?: string
  username?: string
}

export type DecodedCredentials = {
  readonly username: string
  readonly password: Redacted.Redacted
}

/** Which configured credential pair a request matched. */
export type Identity = "owner" | "guest"

// Guest fields are optional: owner-only configs (existing call sites, tests,
// and `@vectordevai/server`'s twin of this service) stay assignable.
export type Info = {
  readonly password: Option.Option<string>
  readonly username: string
  /** Also accepted as the owner username; set only while no username is configured. */
  readonly legacyUsername?: string
  readonly guestPassword?: Option.Option<string>
  readonly guestUsername?: string
  readonly guestWorkspaceIDs?: ReadonlyArray<string>
  readonly guestWorkspaceDirectories?: Readonly<Record<string, string>>
  readonly guestSessionIDs?: ReadonlyArray<string>
}

export class Config extends Context.Service<Config, Info>()("@vector/ServerAuthConfig") {
  /** Provide already-parsed config, useful in tests. */
  static configLayer(input: Info) {
    return Layer.succeed(this, this.of(input))
  }

  /** Parse config once from the active Effect ConfigProvider and provide the service. */
  static get layer() {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        const config = yield* EffectConfig.all({
          password: EffectConfig.string("VECTOR_SERVER_PASSWORD").pipe(EffectConfig.option),
          username: EffectConfig.string("VECTOR_SERVER_USERNAME").pipe(EffectConfig.option),
          guestPassword: EffectConfig.string("VECTOR_SERVER_GUEST_PASSWORD").pipe(EffectConfig.option),
          guestUsername: EffectConfig.string("VECTOR_SERVER_GUEST_USERNAME").pipe(EffectConfig.withDefault("guest")),
          guestWorkspaces: EffectConfig.string("VECTOR_SERVER_GUEST_WORKSPACES").pipe(EffectConfig.option),
          guestWorkspaceDirectories: EffectConfig.string("VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES").pipe(
            EffectConfig.option,
          ),
          guestSessions: EffectConfig.string("VECTOR_SERVER_GUEST_SESSIONS").pipe(EffectConfig.option),
        })
        return Config.of({
          password: config.password,
          guestPassword: config.guestPassword,
          guestUsername: config.guestUsername,
          guestWorkspaceIDs: claims(config.guestWorkspaces, Schema.decodeUnknownOption(WorkspaceV2.ID)),
          guestWorkspaceDirectories: directoryClaims(config.guestWorkspaceDirectories),
          guestSessionIDs: claims(config.guestSessions, Schema.decodeUnknownOption(SessionV2.ID)),
          username: Option.getOrElse(config.username, () => "vector"),
          // The earlier product defaulted the owner username to its own name, and saved
          // connections and scripts still send it. The password is still required.
          legacyUsername: Option.isNone(config.username) ? legacyName : undefined,
        })
      }),
    )
  }
}

// Any configured credential turns authentication on. Reading only the owner
// password would leave a server started with just a guest password wide open —
// the opposite of what configuring a password means.
export function required(config: Info) {
  const set = (value: Option.Option<string> | undefined) =>
    Option.match(value ?? Option.none(), { onNone: () => false, onSome: (item) => item !== "" })
  return set(config.password) || set(config.guestPassword)
}

/** The identity a credential pair matches, or undefined when it matches neither. */
export function identity(credentials: DecodedCredentials, config: Info): Identity | undefined {
  const password = Redacted.value(credentials.password)
  if (
    Option.isSome(config.password) &&
    config.password.value !== "" &&
    (credentials.username === config.username || credentials.username === config.legacyUsername) &&
    password === config.password.value
  )
    return "owner"
  const guestPassword = config.guestPassword ?? Option.none<string>()
  if (
    Option.isSome(guestPassword) &&
    guestPassword.value !== "" &&
    credentials.username === (config.guestUsername ?? "guest") &&
    password === guestPassword.value
  )
    return "guest"
  return undefined
}

export function authorized(credentials: DecodedCredentials, config: Info) {
  return identity(credentials, config) !== undefined
}

export function header(credentials?: Credentials) {
  const password = credentials?.password ?? Flag.VECTOR_SERVER_PASSWORD
  if (!password) return undefined

  const username = credentials?.username ?? Flag.VECTOR_SERVER_USERNAME ?? "vector"
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

export function headers(credentials?: Credentials) {
  const authorization = header(credentials)
  if (!authorization) return undefined
  return { Authorization: authorization }
}

function claims<A extends string>(input: Option.Option<string>, decode: (input: unknown) => Option.Option<A>) {
  if (Option.isNone(input)) return []
  return input.value
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "")
    .flatMap((value): A[] => Option.match(decode(value), { onNone: () => [], onSome: (claim) => [claim] }))
}

function directoryClaims(input: Option.Option<string>) {
  if (Option.isNone(input)) return {}
  const json = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(input.value)
  if (Option.isNone(json)) return {}
  return Option.getOrElse(
    Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.String))(json.value),
    () => ({}),
  )
}
