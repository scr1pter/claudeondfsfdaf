# Image reservations and the remaining study allowance

Recorded November 2, 2026. This is a financial-instrument limitation, not a
measured product cost saving. No counting request or additional model call was
made for this investigation. The active v5 source, $48 total limit and approved
actor allocations remain unchanged.

The frozen v5 inherits a deliberately conservative bound: any image anywhere in
retained input reserves the full 1,050,000 input allowance at $5 per million,
plus 32,000 generated tokens at $15 per million: **$5.73 per outstanding call**.
These rates cover the admitted 30-minute cache-write schedule and long-context
multipliers. Reasoning is included in generated tokens. See the official
[model](https://developers.openai.com/api/docs/models/gpt-6.1-sol) and
[pricing](https://developers.openai.com/api/docs/pricing) documentation.

After the first heavy Vector episode, its cumulative usage is $17.6761006 and
its approved ceiling is $24.73654725. Remaining headroom is $7.06044665, leaving
only **$1.33044665** additional settled spending before a subsequent $5.73 image
reservation becomes unaffordable, potentially earlier with other reservations.
The original episode had 131 maximum-reservation requests, first appearing at
ordinal 152. An image can remain in later input history. A fresh complete heavy
image-capable pair is therefore not reliably affordable merely because the
account has remaining credits. The stopped-early outcome must not be presented
as an intrinsic quality or tokenomics failure.

The official [counting guide](https://developers.openai.com/api/docs/guides/token-counting)
documents exact input counting including images, tools and framing, and the
[endpoint schema](https://developers.openai.com/api/reference/resources/responses/subresources/input_tokens/methods/count)
accepts the relevant structured context. This is a promising future alternative
to guessing image multipliers. The opened official guide, reference and pricing
pages did **not establish that counting is unbilled**. Sol compatibility and an
exact projection of creation-only fields also remain untested. No such endpoint
is used by this study, and it must not be treated as a free hidden helper.

A future reviewed instrument could count the immutable effective context,
journal both hashes, reserve unknown-cache worst-case input plus maximum output,
then reconcile actual usage. Counting's own billing, latency and calls need
explicit accounting first. Keep historical charges, actor/global ceilings,
durable admission and uncertainty halts. Historical cache-hit percentages are
not a safe reservation discount. The official
[controller example](https://developers.openai.com/cookbook/articles/per_run_spending_controller_responses_api)
illustrates count/reserve/reconcile, without establishing the missing billing
or streaming qualifications for this instrument.

Reducing image capability, reasoning, context or required verification is not a
supported way to obtain a cheaper matched result. Future task admission must
assess a full-quality comparison under the unchanged approved budget.
