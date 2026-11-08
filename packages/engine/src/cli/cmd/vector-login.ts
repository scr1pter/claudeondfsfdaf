import { cmd } from "./cmd"
import { UI } from "../ui"
import { confirmStoredSignIn, currentUser, login, signOut, storedTokenMarked, tokenMarked } from "../vector-account"

export const VectorLoginCommand = cmd({
  command: "login",
  describe: "sign in to your free Vector account",
  builder: (yargs) =>
    yargs
      .option("token", {
        type: "string",
        describe: "CLI token copied from vectordev.ai/auth/cli, for free models only (skips the browser)",
      })
      .option("port", {
        type: "number",
        describe: "port on 127.0.0.1 for the browser to return to, for example one forwarded over SSH",
      }),
  handler: async (args) => {
    // Options are checked before anything stored changes, so a mistyped one never signs anyone out.
    if (args.port !== undefined && args.token) {
      UI.error("--port is for the browser sign-in. Leave it out with --token.")
      process.exit(1)
    }
    if (args.port !== undefined && (!Number.isInteger(args.port) || args.port < 1024 || args.port > 65535)) {
      UI.error("Choose a --port from 1024 to 65535.")
      process.exit(1)
    }
    const existing = await currentUser()
    const marked = await storedTokenMarked()
    // A grant stands until vectordev.ai refuses it. One revoked or expired since the day's check is signed out here, so
    // the browser sign-in below replaces it: Codium's sign-in answer sends people to this command.
    const standing = existing && !args.token && marked ? await confirmStoredSignIn() : undefined
    if (existing && standing) {
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + "✓ " + UI.Style.TEXT_NORMAL + "Already signed in as " + existing.email)
      UI.println(UI.Style.TEXT_DIM + 'Run "vector logout" first to switch accounts.')
      return
    }
    if (standing === false)
      UI.println(UI.Style.TEXT_WARNING_BOLD + "Your Vector sign-in has expired or was revoked — sign in again.")
    // A copied token works with free models only; signing in through the browser replaces it once it succeeds, and
    // approving another account there signs this one out.
    if (existing && !args.token && !marked)
      UI.println(
        UI.Style.TEXT_DIM +
          `Signed in as ${existing.email} with a copied token. Sign in again to use Vector Codium; approving another account signs this one out.`,
      )
    if (existing && args.token) await signOut()
    const user = await login(args.token, { port: args.port })
    if (!user) process.exit(1)
    // Commands read VECTOR_CLI_TOKEN before the stored sign-in, so a copied token there keeps Codium refused.
    const environment = process.env.VECTOR_CLI_TOKEN
    if (environment && !tokenMarked(environment))
      UI.println(
        UI.Style.TEXT_DIM +
          "VECTOR_CLI_TOKEN is set to a copied token, which Vector uses before this sign-in and which works with free models only. Unset it to use Vector Codium in this terminal.",
      )
  },
})

export const VectorLogoutCommand = cmd({
  command: "logout",
  describe: "sign out of your Vector account",
  handler: async () => {
    const existing = await currentUser()
    await signOut()
    UI.println(existing ? `Signed out ${existing.email}.` : "No Vector account was signed in on this machine.")
  },
})

export const VectorWhoamiCommand = cmd({
  command: "whoami",
  describe: "show the signed-in Vector account",
  handler: async () => {
    const existing = await currentUser()
    if (!existing) {
      UI.println('Not signed in. Run "vector login".')
      process.exitCode = 1
      return
    }
    UI.println(existing.email)
  },
})
