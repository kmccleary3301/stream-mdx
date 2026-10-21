type WorkerLifecycleEvent = {
  sequence: number;
  workerId: number;
  generation: number | null;
  direction: "input" | "output";
  type: "INIT" | "INITIALIZED" | "FINALIZE" | "FINALIZED";
};

type WorkerLifecycleObserver = {
  sequence: number;
  events: WorkerLifecycleEvent[];
  workerIdFor: (worker: Worker | null | undefined) => number | null;
  watch: (worker: Worker | null | undefined) => number | null;
};

export type PerfWindow = Window & {
  __STREAM_MDX_WORKER_LIFECYCLE__?: WorkerLifecycleObserver;
};

(() => {
  const root = window as PerfWindow;
  if (root.__STREAM_MDX_WORKER_LIFECYCLE__) return;

  type WorkerState = {
    id: number;
    generation: number | null;
    pendingInitializations: number[];
    pendingFinalizations: number[];
    listening: boolean;
  };
  let nextWorkerId = 0;
  let nextGeneration = 0;
  const workerStates = new WeakMap<Worker, WorkerState>();
  const observer: WorkerLifecycleObserver = {
    sequence: 0,
    events: [],
    workerIdFor: (worker) => (worker ? workerStates.get(worker)?.id ?? null : null),
    watch: (worker) => {
      if (!worker) return null;
      const state = stateFor(worker);
      if (!state.listening) {
        state.listening = true;
        worker.addEventListener("message", (event: MessageEvent<unknown>) => {
          const message = event.data as { type?: unknown } | null;
          if (!message || typeof message !== "object") return;
          if (message.type === "INITIALIZED") {
            record(state, "output", "INITIALIZED", state.pendingInitializations.shift() ?? null);
          } else if (message.type === "FINALIZED") {
            record(state, "output", "FINALIZED", state.pendingFinalizations.shift() ?? null);
          }
        });
      }
      return state.id;
    },
  };
  const record = (
    state: WorkerState,
    direction: WorkerLifecycleEvent["direction"],
    type: WorkerLifecycleEvent["type"],
    generation: number | null,
  ) => {
    observer.events.push({
      sequence: ++observer.sequence,
      workerId: state.id,
      generation,
      direction,
      type,
    });
  };
  const stateFor = (worker: Worker): WorkerState => {
    let state = workerStates.get(worker);
    if (!state) {
      state = {
        id: ++nextWorkerId,
        generation: null,
        pendingInitializations: [],
        pendingFinalizations: [],
        listening: false,
      };
      workerStates.set(worker, state);
    }
    return state;
  };

  const originalPostMessage = Worker.prototype.postMessage;
  Object.defineProperty(Worker.prototype, "postMessage", {
    ...Object.getOwnPropertyDescriptor(Worker.prototype, "postMessage"),
    value: function (this: Worker, ...args: unknown[]) {
      const message = args[0] as { type?: unknown } | null | undefined;
      if (message && typeof message === "object") {
        observer.watch(this);
        const state = stateFor(this);
        if (message.type === "INIT") {
          const generation = ++nextGeneration;
          state.generation = generation;
          state.pendingInitializations.push(generation);
          record(state, "input", "INIT", generation);
        } else if (message.type === "FINALIZE") {
          const generation = state.generation;
          if (generation !== null) state.pendingFinalizations.push(generation);
          record(state, "input", "FINALIZE", generation);
        }
      }
      return Reflect.apply(originalPostMessage, this, args);
    },
  });
  root.__STREAM_MDX_WORKER_LIFECYCLE__ = observer;
})();
