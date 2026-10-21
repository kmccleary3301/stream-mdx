import type { WorkerIn, WorkerOut } from "@stream-mdx/core";
import { MarkdownEngine } from "../../packages/markdown-v2-worker/src/engine/engine";
import type { MarkdownEngineOptions } from "../../packages/markdown-v2-worker/src/engine/types";
import { SessionCounterSink } from "./counter-sink";
import {
  PROGRESS_OBSERVATION_TRACE_MARKER,
  type ProgressObservationTraceMessage,
} from "./progress-observation-protocol";

interface ProgressObservationWorkerScope {
  addEventListener(type: "message", listener: (event: MessageEvent<WorkerIn>) => void): void;
  postMessage(message: WorkerOut | ProgressObservationTraceMessage): void;
}

const scope = self as unknown as ProgressObservationWorkerScope;
const campaignCounters = new SessionCounterSink({
  enableProgressTrace: true,
  onProgressTrace(event) {
    scope.postMessage({
      [PROGRESS_OBSERVATION_TRACE_MARKER]: true,
      event,
    });
  },
});

const engineOptions: MarkdownEngineOptions & { campaignCounters: SessionCounterSink } = {
  post(message) {
    scope.postMessage(message);
  },
  campaignCounters,
};
const engine = new MarkdownEngine(engineOptions);

scope.addEventListener("message", (event) => {
  void engine.handle(event.data);
});
