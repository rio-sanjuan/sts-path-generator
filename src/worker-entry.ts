// Web Worker entry: `new Worker(new URL('sts-path-generator/worker', import.meta.url), { type: 'module' })`.

import { handleRequest, transferables, type WorkerRequest } from './worker.ts';

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const res = handleRequest(event.data);
  scope.postMessage(res, transferables(res));
};
