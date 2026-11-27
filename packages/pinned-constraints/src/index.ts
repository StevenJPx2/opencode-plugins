import { Plugin } from "@opencode/plugin"
import { register } from "./constraints.ts"

export default Plugin.define({
  id: "pinned-constraints",
  async setup(ctx) {
    const { stop } = await register(ctx, Date.now)

    return stop
  },
})
