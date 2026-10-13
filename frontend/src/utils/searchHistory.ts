import { getAuthGeneration } from '../services/api';
import { getCacheUserId } from './cacheUtils';

let owner = '', entries: string[] = [];
function current() {
  const next = JSON.stringify([getCacheUserId(), getAuthGeneration()]);
  if (owner !== next) { owner = next; entries = []; }
}
export function readSearchHistory() { current(); return [...entries]; }
export function rememberSearch(query: string) {
  current();
  const value = query.trim();
  if (value) entries = [value, ...entries.filter(entry => entry !== value)].slice(0, 8);
  return [...entries];
}
export function clearSearchHistory() { entries = []; owner = ''; }
