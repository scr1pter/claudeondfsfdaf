import { createMemo } from "solid-js"
import { pickerModelKey, type PickerModel } from "@/utils/provider-brand"

// A host may replace its draft or selected model object without changing the
// selection. Keep those object dependencies out of section/list reconstruction.
export function createPickerCurrent(current: () => Pick<PickerModel, "id" | "provider"> | undefined) {
  return createMemo(() => {
    const value = current()
    return value ? pickerModelKey(value) : undefined
  })
}
