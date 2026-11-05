// The relay's fixed limits. Each ticket carries the plan's public caps from the API's snapshot: its paired computers
// (ENTITLEMENTS remote.computers) and its rank. §4.2's server-only Remote limits stay on the servers: the viewer-hours
// per rank are below, beside the rest of §4.2's Remote line and the relay's own housekeeping, because a ticket is
// readable by the device that holds it. test/remote-relay-contract.test.ts (repository root) keeps the shared values
// equal to the API's `REMOTE_LIMITS` (api/_lib/codium-limits.ts).

/** A plan's rank (ENTITLEMENTS rank, public): Plus 1, Pro 2, Max 3, Ultra 4. */
export type PlanRank = 1 | 2 | 3 | 4
export const PLAN_RANKS: readonly PlanRank[] = [1, 2, 3, 4]

/** §4.2: viewer-hours per period, by the plan's rank (REMOTE_LIMITS.viewerHours, server only). */
export const VIEWER_HOURS: Readonly<Record<PlanRank, number>> = { 1: 60, 2: 100, 3: 200, 4: 200 }

export const RELAY_LIMITS = {
  /** §4.2: phones per account, whatever the plan. */
  phones: 5,
  /** The most computers any plan pairs (ENTITLEMENTS remote.computers on Max and Ultra). A ticket asking more is invalid. */
  maxComputers: 5,
  /** §4.2: awake-hours per account are at most this multiple of the plan's viewer-hours. */
  awakeFactor: 1.5,
  /** §4.2: a viewer that sent nothing for this long is closed. */
  viewerIdleMs: 30 * 60_000,
  /** §4.2: the largest data frame. */
  frameBytes: 64 * 1024,
  /** §4.2: frames a second per connection, on average. A connection may burst to twice this. */
  framesPerSecond: 20,
  burstFrames: 40,
  /** A connection that keeps sending too fast (more refused frames than this within the window) is closed. */
  tooFastRefusals: 100,
  tooFastWindowMs: 10_000,
  /** Control messages are JSON text; anything longer is not one. */
  controlBytes: 8 * 1024,
  /** A computer that sends this many data frames within the window while no viewer is attached is closed. */
  noViewerFrames: 20,
  noViewerWindowMs: 60_000,
  /** Tickets: at most five minutes from issue to expiry, and an issue time at most this far ahead of the relay's clock. */
  ticketMaxSeconds: 300,
  ticketSkewSeconds: 60,
  /** Clients send the heartbeat every 25 s; a connection silent for longer than this is closed. */
  heartbeatEveryMs: 25_000,
  heartbeatStaleMs: 75_000,
  /** A viewer must refresh its ticket in-band before it expires; this long after expiry it is closed. */
  viewerTicketGraceMs: 60_000,
  /**
   * A computer refreshes only when it has something to send (a viewer arriving asks it to), so an idle computer stays
   * connected while hibernated. One whose ticket expired more than a day ago is closed the next time the relay wakes.
   */
  computerTicketMaxAgeMs: 24 * 60 * 60_000,
  /** The alarm's period while a viewer is attached, and the shortest gap between two writes of the time meters. */
  alarmEveryMs: 60_000,
  flushEveryMs: 60_000,
  /** How long the runtime keeps an idle Durable Object awake after an event before it hibernates (the awake estimate). */
  idleTailMs: 10_000,
  /** Fair use is checked from messages at most this often (the alarm checks it every minute while viewers stay). */
  fairCheckEveryMs: 10_000,
  /** Error notices to one connection, at most one per this period. */
  noticeEveryMs: 1_000,
  /** Internal API bodies. */
  internalBodyBytes: 16 * 1024,
} as const
