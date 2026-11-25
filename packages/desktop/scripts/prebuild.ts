#!/usr/bin/env bun
import { $ } from "bun"

import { resolveChannel } from "./utils"

await $`${process.execPath} --no-env-file ../../script/dependency-notices.ts`

const channel = resolveChannel()
await $`${process.execPath} --no-env-file ./scripts/copy-icons.ts ${channel}`
await $`${process.execPath} --no-env-file ./scripts/copy-metainfo.ts ${channel}`

await $`cd ../engine && ${process.execPath} --no-env-file script/build-node.ts --windows-holder-electron`
