import { isOpen, reminderText, signature, type Todo } from "./todos.ts"

export type NudgeOptions = {
  /** How long a finished turn waits before the reminder, so anything else that wakes the agent goes first. */
  readonly delayMs: number
  /** Reminders for one unchanged list before it stops; a changed list starts the count again. */
  readonly maxNudges: number
  /** The reminder, with `{todos}` standing for the open ones. */
  readonly reminder: string
}

export type NudgeHost = {
  readonly read: (sessionID: string) => Promise<ReadonlyArray<Todo>>
  readonly send: (sessionID: string, text: string) => Promise<void>
  /** Runs `run` after `ms`; the returned function cancels it. */
  readonly later: (run: () => void, ms: number) => () => void
}

type State = { cancel?: () => void; count: number; seen?: string; epoch: number }

/**
 * Reminds an idle agent about the todos it left open. The reminder waits out a
 * short delay and is dropped if anything else wakes the session meanwhile, and
 * it stops once the same list has been reminded about, so an agent waiting on
 * the user or on something outside its control is not woken again and again.
 */
export class Nudger {
  private readonly sessions = new Map<string, State>()

  constructor(private readonly host: NudgeHost, private readonly options: NudgeOptions) {}

  private state(sessionID: string): State {
    const known = this.sessions.get(sessionID)

    if (known) return known

    const created: State = { count: 0, epoch: 0 }

    this.sessions.set(sessionID, created)

    return created
  }

  /** Drops a pending reminder, and any one already reading the list, by moving the epoch on. */
  private cancel(state: State): void {
    state.cancel?.()
    delete state.cancel
    state.epoch += 1
  }

  /** A turn finished: remind after the delay unless the session stirs first. */
  turnEnded(sessionID: string): void {
    const state = this.state(sessionID)

    this.cancel(state)

    const epoch = state.epoch

    state.cancel = this.host.later(() => void this.remind(sessionID, state, epoch), this.options.delayMs)
  }

  /** Something else is waking, or has woken, the session: drop a pending reminder. */
  stirred(sessionID: string): void {
    this.cancel(this.state(sessionID))
  }

  /** The agent wrote its list; a changed list counts as progress and starts the count again. */
  listWritten(sessionID: string, todos: ReadonlyArray<Todo>): void {
    const state = this.state(sessionID)
    const now = signature(todos)

    if (state.seen !== now) state.count = 0

    state.seen = now
  }

  forget(sessionID: string): void {
    const state = this.sessions.get(sessionID)

    if (state) this.cancel(state)

    this.sessions.delete(sessionID)
  }

  private async remind(sessionID: string, state: State, epoch: number): Promise<void> {
    delete state.cancel

    const todos = await this.host.read(sessionID)
    const open = todos.filter(isOpen)

    // Something stirred the session while the list was being read.
    if (open.length === 0 || state.epoch !== epoch) return

    // A list written before the plugin saw it is still a new list.
    this.listWritten(sessionID, todos)

    if (state.count >= this.options.maxNudges) return

    state.count += 1

    await this.host.send(sessionID, reminderText(this.options.reminder, todos))
  }
}
