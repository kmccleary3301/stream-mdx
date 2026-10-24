import { useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { MarkdownRenderer } from "./renderer";
import type { StreamingMarkdownProps } from "./streaming-markdown";
import { SourceCapacityError, type AppendResult } from "@stream-mdx/protocol";
import { SOURCE_ADMISSION_HARD_LIMIT, SOURCE_ADMISSION_SOFT_LIMIT } from "./source-admission-limits";

const MAX_ITERATOR_OFFER_UNITS = Math.min(SOURCE_ADMISSION_SOFT_LIMIT, SOURCE_ADMISSION_HARD_LIMIT);

export function useStreamInputSession({
  renderer, text, stream, workerReady, inputReady, inputReadyRef, initializationEpoch, initializationError, session, managedWorker,
  readyRendererRef, onSourceSessionReset,
  imperativeActivityRef, onErrorRef, debug: DEBUG_WORKER,
}: {
  renderer: MarkdownRenderer;
  text: string | undefined;
  stream: AsyncIterable<string> | undefined;
  workerReady: boolean;
  inputReady: boolean;
  inputReadyRef: MutableRefObject<boolean>;
  initializationEpoch: number;
  initializationError: Error | null;
  session: number;
  managedWorker: boolean;
  readyRendererRef: MutableRefObject<MarkdownRenderer | null>;
  onSourceSessionReset: () => void;
  imperativeActivityRef: MutableRefObject<boolean>;
  onErrorRef: MutableRefObject<StreamingMarkdownProps["onError"]>;
  debug: boolean;
}) {
  const [streamStatus, setStreamStatus] = useState<"idle" | "streaming" | "done">("idle");
  const iteratorSequenceRef = useRef(0);
  const activeIteratorRef = useRef<number | null>(null);
  const consumedIteratorsRef = useRef<WeakSet<AsyncIterator<string>>>();

  useEffect(() => {
    setStreamStatus("idle");
  }, [session]);

  useEffect(() => {
    const restartToken = session;
    void restartToken;
    // Re-run after every attach-time initialization, even when `inputReady` itself did not change between renders.
    const initializationToken = initializationEpoch;
    void initializationToken;
    let cancelled = false;
    if (initializationError) {
      setStreamStatus(imperativeActivityRef.current ? "streaming" : "done");
      return () => {
        cancelled = true;
      };
    }

    if (managedWorker) {
      return () => {
        cancelled = true;
      };
    }

    if (text !== undefined) {
      setStreamStatus("streaming");
      if (!workerReady || !inputReady || !inputReadyRef.current || readyRendererRef.current !== renderer) {
        return () => {
          cancelled = true;
        };
      }
      imperativeActivityRef.current = false;
      onSourceSessionReset();
      void renderer.renderStatic(text).then(async () => {
        if (cancelled || readyRendererRef.current !== renderer) return;
        await renderer.finalize();
        if (cancelled || readyRendererRef.current !== renderer) return;
        setStreamStatus(imperativeActivityRef.current ? "streaming" : "done");
      }).catch((error: unknown) => {
        if (cancelled || readyRendererRef.current !== renderer) return;
        setStreamStatus(imperativeActivityRef.current ? "streaming" : "done");
        onErrorRef.current?.(error instanceof Error ? error : new Error(String(error)));
      });
      return () => {
        cancelled = true;
      };
    }

    if (!stream) {
      return () => {
        cancelled = true;
      };
    }
    setStreamStatus("streaming");
    if (!workerReady || !inputReady || !inputReadyRef.current || readyRendererRef.current !== renderer) {
      return () => {
        cancelled = true;
      };
    }
    let iterator: AsyncIterator<string>;
    // Different iterable wrappers can return the same single-use iterator.
    try {
      iterator = stream[Symbol.asyncIterator]();
      const consumedIterators = consumedIteratorsRef.current ??= new WeakSet<AsyncIterator<string>>();
      const consumed = consumedIterators.has(iterator);
      if (consumed) return;
      consumedIterators.add(iterator);
    } catch (error) {
      onErrorRef.current?.(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const iteratorOwner = ++iteratorSequenceRef.current;
    activeIteratorRef.current = iteratorOwner;
    (async () => {
      try {
        imperativeActivityRef.current = false;
        setStreamStatus("streaming");
        onSourceSessionReset();
        renderer.restart();
        await renderer.whenInitialized();
        for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) {
          if (cancelled || activeIteratorRef.current !== iteratorOwner) {
            break;
          }
          const needsSlicing = chunk.length > MAX_ITERATOR_OFFER_UNITS;
          for (let offset = 0; offset < chunk.length;) {
            if (cancelled || activeIteratorRef.current !== iteratorOwner) return;
            const end = Math.min(offset + MAX_ITERATOR_OFFER_UNITS, chunk.length);
            const offer = needsSlicing ? chunk.slice(offset, end) : chunk;
            let result: AppendResult;
            for (;;) {
              try {
                result = renderer.append(offer);
                break;
              } catch (error) {
                if (!(error instanceof SourceCapacityError) || !error.retryable) throw error;
                await renderer.waitForCapacity({ units: offer.length });
                if (cancelled || activeIteratorRef.current !== iteratorOwner) return;
              }
            }
            offset = end;
            if (result.shouldPause) await renderer.waitForCapacity({ units: 0 });
            if (cancelled || activeIteratorRef.current !== iteratorOwner) return;
          }
        }
        if (!cancelled && activeIteratorRef.current === iteratorOwner) {
          await renderer.finalize();
          if (cancelled || activeIteratorRef.current !== iteratorOwner) return;
          setStreamStatus(imperativeActivityRef.current ? "streaming" : "done");
        }
      } catch (error) {
        if (!cancelled && activeIteratorRef.current === iteratorOwner) {
          setStreamStatus(imperativeActivityRef.current ? "streaming" : "done");
          onErrorRef.current?.(error instanceof Error ? error : new Error(String(error)));
        }
      } finally {
        if (activeIteratorRef.current === iteratorOwner) activeIteratorRef.current = null;
      }
    })();

    return () => {
      cancelled = true;
      if (activeIteratorRef.current === iteratorOwner) {
        activeIteratorRef.current = null;
        setStreamStatus(imperativeActivityRef.current ? "streaming" : "idle");
      }
    };
  }, [renderer, text, stream, workerReady, inputReady, inputReadyRef, initializationEpoch, initializationError, session, managedWorker, readyRendererRef, onSourceSessionReset, imperativeActivityRef, onErrorRef, DEBUG_WORKER]);
  return { streamStatus, setStreamStatus, activeIteratorRef };
}
