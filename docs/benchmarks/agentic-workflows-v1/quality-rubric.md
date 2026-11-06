# Blinded delivery review

Freeze this rubric before the first paid arm. Reviewers receive opaque submission labels, the public task/seed, selected delivery source and independent screenshots. They do not receive runtime identity, costs, request counts or the optimization hypothesis. Retain a private mapping and publish the mapping only after scores are recorded. Use the same reviewer and rubric for both arms of a task; do not pool scores from incompatible review methods.

| Dimension                        | Maximum | Evidence                                                                                                                                       |
| -------------------------------- | ------: | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract and data integrity      |      12 | Complete behavior, validation, transaction boundaries, idempotency and invariant preservation                                                  |
| Durable state and recovery       |      10 | Migration preservation, restart/retry semantics, version/history correctness and explicit failure states                                       |
| Structure and maintainability    |       8 | Clear state ownership, cohesive modules, understandable control flow, limited duplication and appropriate abstractions                         |
| Errors and resource bounds       |       6 | Useful errors, bounded concurrency/work, cancellation/cleanup and defensive handling of malformed input                                        |
| Added verification               |       6 | Meaningful new tests for the requested behavior, especially failures/races/restarts; do not credit unchanged seed tests as model-authored work |
| User interface and accessibility |       6 | Truthful live state, readable feedback, usable forms, keyboard/semantic controls and mobile behavior within supplied evidence                  |
| **Total**                        |  **48** |                                                                                                                                                |

Use integer scores. A maximum requires clear evidence for the dimension's relevant requirements. Missing evidence is a limitation, not an assumed success. Do not reward output length or additional unrequested features. A concise complete implementation can score as highly as a larger one. Distinguish a review risk from a demonstrated defect.

Record critical findings separately: plausible data loss/corruption, cross-boundary access, unsafe execution beyond the task contract, lost authoritative results, incorrect citations, persistent stale search content, or equivalent task-specific failures. A new critical finding blocks an equal-quality claim even if the total score is high. Functional acceptance still requires every required independent check to pass; a review score cannot override failed tests.

Static source review and supplied screenshots have bounded coverage. Record files/images inspected, unobserved interaction states, and whether any independent execution was performed. Do not describe this review as a production security or usability audit. Blinding limits expectation bias but does not make a small adaptive study statistically conclusive.
