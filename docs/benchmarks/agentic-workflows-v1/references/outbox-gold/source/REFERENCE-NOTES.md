# Private complete-product qualification control

This application is a private qualification control, not a study submission or production candidate. It was authored from the public task and seed. The protected fixture, dependency pins and public task were copied unchanged; dependencies are private dereferenced copies from the qualification seed application.

The implementation stores immutable envelopes and request/key bindings in a SQLite outbox. Admission is one transaction, each explicit drain snapshots eligible work and atomically claims individual rows, attempts are durable before transmission, and interrupted active claims return to pending on restart. Concurrent drains skip already-claimed work. Provider acceptance/cancellation replies are validated against the durable envelope. Terminal outcomes and too-late cancellation explanations survive late responses. Cancellation of untransmitted work is local; possibly transmitted work uses the real protected provider cancellation protocol.

The browser uses the application origin only, keeps explicit Process queue and Refresh controls, retains failed-save text, and shows saved reply status and details. It does not inspect fixture control state or use fixture control endpoints.

Authoring did not run Bun, Node, a server, a browser or a model. Runtime qualification is owned by the coordinating agent. The existing public smoke test is preserved. Deliberate limits: this finite control uses one Bun process; clustered/multiple-process app workers and migration of historical v1 sent-message metadata are outside the synthetic seed scenario. Existing draft rows remain readable because the new outbox is a separate table.
