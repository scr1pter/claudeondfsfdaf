export const PUSH_SUBSCRIPTION_ID_LENGTH = 22

export type PushSubscriptionIdentity = { endpoint: string; p256dh: string; auth: string }
export type PushSubscriptionCheck = { id: string; fingerprint: string }

/** The browser and server hash the same ordered identity. Expiration is checked separately on both sides. */
export function pushSubscriptionFingerprintInput({ endpoint, p256dh, auth }: PushSubscriptionIdentity) {
  return JSON.stringify(["vector-phone-push-v1", endpoint, p256dh, auth])
}
