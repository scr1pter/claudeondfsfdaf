import { unavailable } from "./hosted-entitlement.js"
import type { HostedProvider } from "./hosted-provider.js"

/*
 * Cloudflare as the cloud computer's provider: the fallback contract §8.1 risk 1 names if Vercel does not give its
 * written OK. It is an interface stub (contract WP A52): it is never configured, so `VECTOR_HOSTED_PROVIDER=cloudflare`
 * starts nothing, and every call refuses with 503 `HOSTED_UNAVAILABLE` without a network request. The provider
 * contract tests in test/hosted-provider.test.ts run against it, and their full suite runs once it is built.
 *
 * Building it needs the same written OK from Cloudflare, then, to pass that suite:
 * - a persistent computer per name, made from the base image the first time and resumed from its own saved disk after
 *   (Cloudflare keeps a container's disk only through backups to R2, kept for the computer's retention);
 * - 2 or 4 vCPUs, a timeout of the job's deadline plus 5 minutes, and the viewer port as the only one reachable;
 * - egress through Cloudflare's outbound proxy, refusing every block in `HOSTED_DENIED_SUBNETS` and adding the run
 *   token header for the run-API host only, so the token never exists inside the container;
 * - tags (or names) that keep the modes apart, and a listing the reconciler can read;
 * - rates of its own in hosted-rates.ts: today's rates are Vercel's, and a block must never be charged below what the
 *   provider it runs on costs (M8).
 */

export function cloudflareProvider(): HostedProvider {
  const refuse = async (): Promise<never> => {
    throw unavailable()
  }
  return {
    id: "cloudflare",
    configured: () => false,
    problems: () => ["VECTOR_HOSTED_PROVIDER=cloudflare names a provider that is not built yet"],
    start: refuse,
    setRunToken: refuse,
    stop: refuse,
    destroy: refuse,
    list: refuse,
  }
}
