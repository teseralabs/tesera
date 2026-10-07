// Chrome over the DevTools protocol on a pipe, so the harness needs nothing installed.
import { spawn } from "node:child_process"

/** A headless Chrome with its own profile. `send` speaks to the browser; `page` opens a tab. */
export function launch(chrome, profile, extra = []) {
  const proc = spawn(
    chrome,
    [
      "--headless=new",
      `--user-data-dir=${profile}`,
      "--remote-debugging-pipe",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      ...extra,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
  )
  const writer = proc.stdio[3]
  const reader = proc.stdio[4]
  let next = 0
  const pending = new Map()
  const listeners = new Set()
  let buffer = Buffer.alloc(0)
  reader.on("data", (data) => {
    buffer = Buffer.concat([buffer, data])
    for (let end = buffer.indexOf(0); end !== -1; end = buffer.indexOf(0)) {
      const message = JSON.parse(buffer.subarray(0, end).toString("utf8"))
      buffer = buffer.subarray(end + 1)
      const waiting = message.id !== undefined ? pending.get(message.id) : null
      if (waiting) {
        pending.delete(message.id)
        if (message.error) waiting.reject(new Error(`${waiting.method}: ${message.error.message}`))
        else waiting.resolve(message.result)
      } else {
        if (message.method === "Target.detachedFromTarget") {
          detached.add(message.params.sessionId)
          for (const [id, call] of pending) {
            if (call.sessionId !== message.params.sessionId) continue
            pending.delete(id)
            call.reject(new Error(`${call.method}: the tab is closed`))
          }
        }
        for (const listener of listeners) listener(message)
      }
    }
  })
  const closed = new Promise((resolve) => proc.once("exit", resolve))
  closed.then(() => {
    for (const waiting of pending.values()) waiting.reject(new Error(`${waiting.method}: chrome exited`))
    pending.clear()
  })
  const detached = new Set()
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      if (sessionId && detached.has(sessionId)) return reject(new Error(`${method}: the tab is closed`))
      const id = ++next
      pending.set(id, { resolve, reject, method, sessionId })
      writer.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`)
    })
  const browser = {
    proc,
    profile,
    send,
    on: (listener) => listeners.add(listener),
    off: (listener) => listeners.delete(listener),
    async page(url, { setup = [], onConsole } = {}) {
      const { targetId } = await send("Target.createTarget", { url: "about:blank" })
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true })
      const call = (method, params) => send(method, params, sessionId)
      browser.on((message) => {
        if (message.sessionId !== sessionId) return
        if (message.method === "Page.javascriptDialogOpening") void call("Page.handleJavaScriptDialog", { accept: true }).catch(() => {})
        if (onConsole && message.method === "Runtime.exceptionThrown") onConsole(`exception ${message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text}`)
        if (onConsole && message.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(message.params.type)) {
          onConsole(`${message.params.type} ${message.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`)
        }
      })
      await call("Page.enable")
      await call("Runtime.enable")
      for (const step of setup) await call(step.method, step.params)
      const page = {
        targetId,
        sessionId,
        call,
        async eval(expression) {
          const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
          if (result.exceptionDetails) throw new Error(`${expression}: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`)
          return result.result.value
        },
        /** A real mouse click, which counts as a user gesture, in the middle of the element. */
        async click(selector) {
          const box = await page.eval(`(() => {
            const el = document.querySelector(${JSON.stringify(selector)})
            if (!el) return null
            el.scrollIntoView({ block: "center" })
            const r = el.getBoundingClientRect()
            return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width }
          })()`)
          if (!box || box.w === 0) throw new Error(`nothing visible at ${selector}`)
          for (const type of ["mousePressed", "mouseReleased"]) {
            await call("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 })
          }
        },
        async setFiles(selector, files) {
          const { root } = await call("DOM.getDocument", { depth: 0 })
          const { nodeId } = await call("DOM.querySelector", { nodeId: root.nodeId, selector })
          await call("DOM.setFileInputFiles", { nodeId, files })
        },
        async waitFor(expression, { timeoutMs = 30_000, everyMs = 100, what = expression } = {}) {
          const until = Date.now() + timeoutMs
          for (;;) {
            const value = await page.eval(expression).catch(() => null)
            if (value) return value
            if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
            await new Promise((resolve) => setTimeout(resolve, everyMs))
          }
        },
        navigate: (to) => call("Page.navigate", { url: to }),
        close: () => send("Target.closeTarget", { targetId }),
      }
      await call("Page.navigate", { url })
      return page
    },
    async close() {
      proc.kill("SIGKILL")
      await closed
    },
  }
  return browser
}
