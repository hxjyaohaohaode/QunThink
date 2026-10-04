// Cache cleanup retires already-scheduled writes without cancelling unrelated
// business requests or discarding the current editor's in-memory state.
let generation = 0;
export const getLocalCacheGeneration = () => generation;
export function invalidateLocalCacheWork() { generation++; }
