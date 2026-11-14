import { expect, test } from "bun:test"
import { sanitizeActionsLog } from "../../src/cli/cmd/github.output"

test("Actions logs neutralize both command protocols across every physical line", () => {
  expect(
    sanitizeActionsLog(
      "ordinary output\n::warning::model prose\r\u0085::add-mask::fixture\r\ninline ##[error]text\n##[add-mask]fixture",
    ),
  ).toBe(
    "ordinary output\nVector output: ::warning::model prose\nVector output: \u0085::add-mask::fixture\ninline ## [error]text\n## [add-mask]fixture",
  )
  expect(sanitizeActionsLog("Codium was busy\nvector session ses_fixture")).toBe(
    "Codium was busy\nvector session ses_fixture",
  )
})
