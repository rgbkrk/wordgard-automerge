import {memo, useLayoutEffect, useRef} from 'react';
import {NativeEditor} from '../editor.ts';
import type {EditorSession} from '../session.ts';
import {useSaveState} from './session-hooks.ts';

export type ViewListener = (pane: 0 | 1, view: NativeEditor | null) => void;
/** React owns this empty host; Wordgard owns everything inside it. */
export const WordgardEditor = memo(function WordgardEditor({session, pane, onView}: {session: EditorSession; pane: 0 | 1; onView?: ViewListener}) {
  const host = useRef<HTMLElement>(null);
  const view = useRef<NativeEditor | null>(null);
  const saveState = useSaveState();
  useLayoutEffect(() => {
    const element = host.current!;
    const mounted = new NativeEditor(element, session);
    view.current = mounted; onView?.(pane, mounted);
    return () => {
      onView?.(pane, null); view.current = null;
      mounted.destroy(); element.replaceChildren();
    };
  }, [session, pane, onView]);
  useLayoutEffect(() => { view.current?.setSaveState(saveState); }, [saveState, session]);
  return <section ref={host} className={`editor-pane${pane ? ' peer-pane' : ''}`} id={pane ? 'right' : 'left'} aria-label={pane ? 'Collaborator editing view' : 'Your editing view'} />;
});
