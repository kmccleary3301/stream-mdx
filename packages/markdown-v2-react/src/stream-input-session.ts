import { useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { MarkdownRenderer } from "./renderer";
import type { StreamingMarkdownProps } from "./streaming-markdown";

export function useStreamInputSession({
  renderer, text, stream, workerReady, inputReady, inputReadyRef, initializationEpoch, initializationError, session, managedWorker,
  readyRendererRef,
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
      void renderer.renderStatic(text).then(() => {
        if (cancelled || readyRendererRef.current !== renderer) return;
        renderer.finalize();
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
        renderer.restart();
        await renderer.whenInitialized();
        for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) {
          if (cancelled || activeIteratorRef.current !== iteratorOwner) {
            break;
          }
          renderer.append(chunk);
          if (process.env.NODE_ENV !== "production" && DEBUG_WORKER) {
            // eslint-disable-next-line no-console
            console.info("[debug] streaming chunk", chunk.length);
          }
        }
        if (!cancelled && activeIteratorRef.current === iteratorOwner) {
          renderer.finalize();
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
  }, [renderer, text, stream, workerReady, inputReady, inputReadyRef, initializationEpoch, initializationError, session, managedWorker, readyRendererRef, imperativeActivityRef, onErrorRef, DEBUG_WORKER]);
  return { streamStatus, setStreamStatus, activeIteratorRef };
}
