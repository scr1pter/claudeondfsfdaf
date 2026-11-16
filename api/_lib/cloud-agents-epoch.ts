/*
 * The meter epoch rule, in a module with no api/_lib imports. The ledger and the run-token check both read it at load
 * time, and they sit on one import cycle (the ledger reaches the run-token check through the entitlement, the
 * provisioners, hosted jobs and the model-plan caller), so neither may own it: whichever loads first would hand the
 * other a binding that is not initialized yet.
 */

/** A meter epoch: the local `p<periodStart>`, or Codium's `<subscription>:<periodStart>` (and its `none`). */
export const METER_EPOCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,127}$/
