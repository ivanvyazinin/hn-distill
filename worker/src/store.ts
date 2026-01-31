import { createR2Store, mapR2KeyDefault, type ObjectStore, type R2BucketLike } from "@utils/object-store";

export function createWorkerStore(bucket: R2BucketLike): ObjectStore {
  return createR2Store(bucket, { mapKey: mapR2KeyDefault });
}
