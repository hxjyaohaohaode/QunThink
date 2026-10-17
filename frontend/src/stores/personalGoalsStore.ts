import { useEffect, type Dispatch, type SetStateAction } from 'react';
import { create } from 'zustand';
import { getAuthGeneration } from '../services/api';
import { getCacheUserId } from '../utils/cacheUtils';
import type { PersonalGoal, PersonalGoalBrief, PersonalGoalDetail, PersonalRunDetail } from '../services/personalGoals';

interface GoalValues {
  goals: PersonalGoal[]; loading: boolean; listError: string; actionError: string; notice: string;
  executionAvailable: boolean; outcome: string; constraintsText: string; checksText: string;
  runDrafts: Record<string, string>; showCreate: boolean; showRunCreate: boolean;
  selectedId: string | null; detail: PersonalGoalDetail | null; detailLoading: boolean;
  runDetail: PersonalRunDetail | null; brief: PersonalGoalBrief | null; briefLoading: boolean; busy: string;
}
type Attempt = { payload: string; key: string };
const reference = <T,>(current: T) => ({ current });
const emptyValues = (): GoalValues => ({
  goals: [], loading: true, listError: '', actionError: '', notice: '', executionAvailable: false,
  outcome: '', constraintsText: '', checksText: '', runDrafts: {}, showCreate: false, showRunCreate: false,
  selectedId: null, detail: null, detailLoading: false, runDetail: null, brief: null, briefLoading: false, busy: '',
});
const emptyReferences = () => ({
  createAttempt: reference<Attempt | null>(null), runAttempts: reference(new Map<string, Attempt>()),
  transitionKeys: reference(new Map<string, string>()), briefAttempts: reference(new Map<string, string>()),
  busyRef: reference(false), selectionEpoch: reference(0), runEpoch: reference(0), briefEpoch: reference(0), listEpoch: reference(0),
});
interface GoalSession {
  accountId: string | null; authGeneration: number; generation: number;
  values: GoalValues; references: ReturnType<typeof emptyReferences>;
  activate: () => void; cleanup: () => void;
}

// Text, operation keys and in-flight locks live only in this account's tab.
// Unmounting a page must not turn an unknown save into a fresh submission.
export const usePersonalGoalsStore = create<GoalSession>((set, get) => ({
  accountId: null, authGeneration: -1, generation: 0, values: emptyValues(), references: emptyReferences(),
  activate: () => {
    const accountId = getCacheUserId(), authGeneration = getAuthGeneration();
    if (get().accountId === accountId && get().authGeneration === authGeneration) return;
    set({ accountId, authGeneration, generation: get().generation + 1, values: emptyValues(), references: emptyReferences() });
  },
  cleanup: () => set({ accountId: null, authGeneration: -1, generation: get().generation + 1,
    values: emptyValues(), references: emptyReferences() }),
}));

// Keep the unload guard active when the user moves to chat or another page.
if (typeof window !== 'undefined') window.addEventListener('beforeunload', event => {
  const state = usePersonalGoalsStore.getState(), values = state.values, refs = state.references;
  if (!state.accountId || state.accountId !== getCacheUserId() || state.authGeneration !== getAuthGeneration()) return;
  if (!(values.outcome || values.constraintsText || values.checksText || Object.values(values.runDrafts).some(Boolean)
    || values.busy || refs.createAttempt.current || refs.runAttempts.current.size
    || refs.briefAttempts.current.size || refs.transitionKeys.current.size)) return;
  event.preventDefault(); event.returnValue = '';
});

export function usePersonalGoalSession() {
  const session = usePersonalGoalsStore();
  const accountId = getCacheUserId(), authGeneration = getAuthGeneration();
  const active = !!accountId && session.accountId === accountId && session.authGeneration === authGeneration;
  useEffect(() => { usePersonalGoalsStore.getState().activate(); }, [accountId, authGeneration]);
  const current = () => {
    const latest = usePersonalGoalsStore.getState();
    return active && latest.generation === session.generation && latest.accountId === getCacheUserId()
      && latest.authGeneration === getAuthGeneration();
  };
  const values = active ? session.values : emptyValues();
  function field<K extends keyof GoalValues>(key: K): [GoalValues[K], Dispatch<SetStateAction<GoalValues[K]>>] {
    return [values[key], next => {
      if (!current()) return;
      usePersonalGoalsStore.setState(latest => ({ values: { ...latest.values,
        [key]: typeof next === 'function' ? (next as (previous: GoalValues[K]) => GoalValues[K])(latest.values[key]) : next } }));
    }];
  }
  return { active, current, field, references: session.references,
    scopeKey: `${session.generation}:${active}`, read: () => current() ? usePersonalGoalsStore.getState().values : emptyValues() };
}
