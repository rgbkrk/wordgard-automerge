import {createContext, useContext, useSyncExternalStore} from 'react';
import {DemoSession, type Projection} from '../session.ts';

export const SessionContext = createContext<DemoSession | null>(null);
export function useSession() {
  const session = useContext(SessionContext);
  if (!session) throw Error('Native prose requires a session provider');
  return session;
}
function useProjection<T>(projection: Projection<T>) {
  return useSyncExternalStore(projection.subscribe, projection.getSnapshot, projection.getSnapshot);
}
export function useConnection() { return useProjection(useSession().connection); }
export function useSaveState() { return useProjection(useSession().saveState); }
export function useStorageError() { return useProjection(useSession().storageError); }
export function useActivity() { return useProjection(useSession().activity); }
export function useLeftDocument() { return useProjection(useSession().leftDocument); }
