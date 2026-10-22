import {test, expect, type Page} from '@playwright/test';
import {randomUUID} from 'node:crypto';

declare global { interface Window { nativeProse: any } }
async function open(page: Page) {
  await page.goto(`/?document=${randomUUID()}`);
  await expect(page.getByRole('textbox', {name: 'You document', exact: true})).toBeVisible();
}
async function select(page: Page, pane: number, text?: string) {
  await page.evaluate(({pane, text}) => {
    const editor = window.nativeProse.views[pane].editor;
    if (!text) editor.dispatch({selection: {anchor: editor.state.doc.length - 1}});
    else {
      let from = -1;
      editor.state.doc.iterate((node: any, pos: number) => { if (node.isText && String(node.param).includes(text)) { from = pos + String(node.param).indexOf(text); return false; } });
      if (from < 0) throw Error(`Text not found: ${text}`);
      editor.dispatch({selection: {anchor: from, head: from + text.length}});
    }
    editor.focus();
  }, {pane, text});
}
async function converged(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const {A, left, right, PATH, views} = window.nativeProse;
    return {left: A.spans(left.doc, PATH), right: A.spans(right.doc, PATH), viewsEqual: views[0].editor.state.doc.eq(views[1].editor.state.doc), headsEqual: JSON.stringify(A.getHeads(left.doc).sort()) === JSON.stringify(A.getHeads(right.doc).sort())};
  })).toEqual({left: expect.any(Array), right: expect.any(Array), viewsEqual: true, headsEqual: true});
  const spans = await page.evaluate(() => { const {A,left,right,PATH} = window.nativeProse; return [A.spans(left.doc,PATH), A.spans(right.doc,PATH)]; });
  expect(spans[0]).toEqual(spans[1]);
  await expect(page.locator('.editor-error:visible')).toHaveCount(0);
}

test('typing, overlapping offline formatting, and reconnect converge in both views', async ({page}) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await open(page); await page.getByRole('button', {name: 'Pause connection', exact: true}).click();
  await select(page, 0, 'best ideas'); await page.locator('#left .toolbar').getByRole('button', {name: 'Bold', exact: true}).click();
  await select(page, 1, 'ideas get better'); await page.locator('#right .toolbar').getByRole('button', {name: 'Italic', exact: true}).click();
  await select(page, 0); await page.keyboard.insertText(' From you 🌊.');
  await select(page, 1); await page.keyboard.insertText(' From a collaborator.');
  await page.getByRole('button', {name: 'Reconnect views'}).click(); await converged(page);
  await expect(page.locator('#left wg-content')).toContainText('From a collaborator.');
  await expect(page.locator('#right wg-content')).toContainText('From you 🌊.');
  const marks = await page.evaluate(() => { const {A,left,PATH} = window.nativeProse; return A.marksAt(left.doc,PATH,left.doc.body.indexOf('ideas')); });
  expect(marks).toMatchObject({strong: true, em: true}); expect(errors).toEqual([]);
});
test('local undo after a remote edit keeps the collaborator text', async ({page}) => {
  await open(page); await select(page, 0); await page.keyboard.insertText(' LOCAL'); await converged(page);
  await select(page, 1); await page.keyboard.insertText(' REMOTE'); await converged(page);
  await page.locator('#left .toolbar').getByRole('button', {name: 'Undo', exact: true}).click(); await converged(page);
  await expect(page.locator('#left wg-content')).not.toContainText('LOCAL');
  await expect(page.locator('#left wg-content')).toContainText('REMOTE');
  await page.locator('#left .toolbar').getByRole('button', {name: 'Redo', exact: true}).click(); await converged(page);
  await expect(page.locator('#right wg-content')).toContainText('LOCAL');
});
test('selection toolbar comments track text, sync, resolve, and survive reload', async ({page}) => {
  await open(page); await select(page, 0, 'people and agents');
  const floating = page.locator('#left .selection-toolbar'); await expect(floating).toBeVisible();
  await floating.getByRole('button', {name: 'Comment', exact: true}).click();
  await page.locator('#left').getByRole('textbox', {name: 'Comment text'}).fill('Keep the human and agent collaboration here.');
  await page.locator('#left').getByRole('button', {name: 'Add comment', exact: true}).click();
  await expect(page.locator('#right .comment-card')).toContainText('Keep the human and agent collaboration here.');
  await page.getByRole('button', {name: 'Try an agent edit'}).click(); await converged(page);
  await expect(page.locator('#left wg-content')).toContainText('strongest ideas');
  await expect(page.locator('#right .comment-card')).toContainText('On this passage');
  await page.reload(); await expect(page.locator('#left .comment-card')).toContainText('people and agents');
  await page.locator('#right .comment-card').getByRole('button', {name: 'Resolve', exact: true}).click();
  await expect(page.locator('#left .comment-card')).toContainText('Resolved');
});
test('backticks create a code block and its language is native shared metadata', async ({page}) => {
  await open(page); await select(page, 0); await page.keyboard.press('Enter');
  await page.keyboard.insertText('```'); await page.keyboard.press('Enter');
  await page.keyboard.insertText('print("hello")');
  await expect(page.locator('#left wg-content pre')).toHaveCount(2);
  await page.locator('#left .wg-code-language').last().selectOption('python');
  await converged(page); await expect(page.locator('#right wg-content pre').last()).toContainText('print("hello")');
  const blocks = await page.evaluate(() => { const {A,left,PATH}=window.nativeProse; return A.spans(left.doc,PATH).filter((s:any)=>s.type==='block').map((s:any)=>s.value); });
  expect(blocks.at(-1)).toMatchObject({type: 'code-block', attrs: {language: 'python'}});
});
test('Mermaid stays source backed; links can be edited and opened', async ({page}) => {
  await open(page); await expect(page.locator('#left .diagram-mount svg')).toBeVisible();
  expect(await page.locator('#left .diagram-mount svg script, #left .diagram-mount svg foreignObject').count()).toBe(0);
  await select(page, 0, 'people and agents'); await page.locator('#left .toolbar').getByRole('button', {name: 'Link', exact: true}).click();
  await page.locator('#left').getByRole('textbox', {name: 'Link URL'}).fill('https://automerge.org/');
  await page.locator('#left').getByRole('button', {name: 'Apply', exact: true}).click(); await converged(page);
  await expect(page.locator('#right wg-content a')).toHaveAttribute('href', 'https://automerge.org/');
  await page.locator('#left wg-content a').click();
  await expect(page.locator('#left .open-link')).toHaveAttribute('href', 'https://automerge.org/');
});
test('remote presence is ephemeral and native spans contain no view decorations', async ({page}) => {
  await open(page); await select(page, 0, 'people and agents');
  await expect(page.locator('#right .peer-selection')).toBeVisible();
  await expect(page.locator('#right .peer-caret')).toBeVisible();
  await page.getByRole('button', {name: 'Inspect document'}).click();
  const serialized = await page.locator('#spans').textContent();
  expect(serialized).not.toContain('peer-caret'); expect(serialized).not.toContain('<svg'); expect(serialized).toContain('"strong": true');
  await page.getByRole('button', {name: 'Pause connection', exact: true}).click();
  await expect(page.locator('.peer-caret')).toHaveCount(0);
});
test('remote carets stay inside paragraph ends without changing line wrapping', async ({page}) => {
  await page.setViewportSize({width: 1265, height: 1000});
  await open(page);
  const baseline = await page.locator('#right wg-content').evaluate(el => [...el.children].map(child => ({top: child.getBoundingClientRect().top, height: child.getBoundingClientRect().height})));
  // Walk both sides of every soft wrap, plus the hard paragraph end.
  const positions = await page.evaluate(() => {
    const editor = window.nativeProse.views[0].editor;
    let start = 0; const positions: number[] = [];
    for (const node of editor.state.doc.content) {
      const end = start + node.length - 1;
      positions.push(end);
      let previousY: number | undefined;
      for (let pos = start + 1; pos < end; pos++) {
        const y = editor.coordsAtPos(pos)?.top;
        if (previousY !== undefined && y !== previousY) positions.push(pos - 1, pos);
        previousY = y;
      }
      start += node.length;
    }
    return positions;
  });
  for (const pos of positions) {
    await page.evaluate(pos => {const editor = window.nativeProse.views[0].editor; editor.dispatch({selection: {anchor: pos}}); editor.focus();}, pos);
    const caret = page.locator('#right .peer-caret');
    await expect(caret).toHaveCount(1);
    const frames = await page.evaluate(async () => {
      const frames = [];
      for (let i = 0; i < 5; i++) {
        await new Promise(requestAnimationFrame);
        const content = document.querySelector('#right wg-content')!;
        frames.push({inside: !!content.querySelector('.peer-caret')?.closest('p,h1,h2,h3,pre'), layout: [...content.children].map(child => ({top: child.getBoundingClientRect().top, height: child.getBoundingClientRect().height}))});
      }
      return frames;
    });
    for (const frame of frames) expect(frame, `Caret at ${pos}`).toEqual({inside: true, layout: baseline});
  }
});
test('typing does not hide the remote cursor while document sync is delayed', async ({page}) => {
  await open(page); await converged(page); await select(page, 0);
  await expect(page.locator('#right .peer-caret')).toBeVisible();
  // Hold only document delivery: presence still arrives immediately, as it
  // does during the normal transport's 35 ms batch window.
  await page.evaluate(() => { window.nativeProse.left.sendChanges = () => {}; });
  await page.keyboard.insertText(' typing');
  const pending = await page.evaluate(async () => {
    const {A,right} = window.nativeProse;
    const missingHeads = !A.hasHeads(right.doc, right.peer.heads);
    const frames = [];
    for (let i = 0; i < 12; i++) {
      await new Promise(requestAnimationFrame);
      frames.push(document.querySelectorAll('#right .peer-caret').length);
    }
    return {missingHeads, frames};
  });
  expect(pending.missingHeads).toBe(true);
  expect(pending.frames).toEqual(Array(12).fill(1));
  await page.evaluate(() => window.nativeProse.link.flush()); await converged(page);
  await expect(page.locator('#right .peer-caret')).toBeVisible();
  const range = await page.evaluate(() => window.nativeProse.right.peerRange());
  expect(range.anchor).toBe(range.head);
  await expect(page.locator('#right wg-content')).toContainText('typing');
  await page.getByRole('button', {name: 'Pause connection', exact: true}).click();
  await expect(page.locator('#right .peer-caret')).toHaveCount(0);
});
test('wide and narrow layouts remain usable', async ({page}) => {
  await open(page); await expect(page.locator('#left .diagram-mount svg')).toBeVisible();
  await page.screenshot({path: '../wordgard-native-editor-wide.png', fullPage: true});
  await page.setViewportSize({width: 390, height: 844});
  await expect(page.getByRole('button', {name: 'Pause connection', exact: true})).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({path: '../wordgard-native-editor-narrow.png', fullPage: true});
});
test('unreadable saved data is preserved and never reported as saved', async ({page}) => {
  const id = randomUUID();
  await page.addInitScript(id => localStorage.setItem(`nteract-wordgard-native-v1:${id}`, 'unreadable fixture'), id);
  await page.goto(`/?document=${id}`);
  await expect(page.locator('#storage-error')).toContainText('stored data has been kept');
  await expect(page.locator('#left .save-state')).toContainText('Not saved');
  await select(page, 0); await page.keyboard.insertText(' temporary');
  expect(await page.evaluate(id => localStorage.getItem(`nteract-wordgard-native-v1:${id}`), id)).toBe('unreadable fixture');
});
test('React rerenders preserve Wordgard identity, selection, and undo history', async ({page}) => {
  await open(page); await select(page, 0); await page.keyboard.insertText(' REACT'); await converged(page);
  const before = await page.evaluate(() => {
    const editor = window.nativeProse.views[0].editor;
    return {id: editor.contentDOM.id, anchor: editor.state.selection.anchor, head: editor.state.selection.head};
  });
  await page.getByRole('button', {name: 'Focus view', exact: true}).click();
  await page.getByRole('button', {name: 'Inspect document', exact: true}).click();
  await page.getByRole('button', {name: 'Side by side', exact: true}).click();
  const after = await page.evaluate(() => {
    const editor = window.nativeProse.views[0].editor;
    return {id: editor.contentDOM.id, anchor: editor.state.selection.anchor, head: editor.state.selection.head};
  });
  expect(after).toEqual(before);
  await page.locator('#left .toolbar').getByRole('button', {name: 'Undo', exact: true}).click(); await converged(page);
  await expect(page.locator('#left wg-content')).not.toContainText('REACT');
});
test('Strict Mode mounts and remounts views without duplicating subscriptions or replicas', async ({page}) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await open(page); await select(page, 0); await page.keyboard.insertText(' PERSISTENT'); await converged(page);
  const actors = await page.evaluate(() => {const {A,left,right} = window.nativeProse; return [A.getActorId(left.doc),A.getActorId(right.doc)];});
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => window.nativeProse.renderEditors(false));
    await expect(page.locator('wg-content')).toHaveCount(0);
    const detached = await page.evaluate(() => {const {left,right,views} = window.nativeProse; return {listeners: [left.listeners.size,right.listeners.size], presence: [left.presenceListeners.size,right.presenceListeners.size], views: views.every((v: unknown) => v === null)};});
    expect(detached).toEqual({listeners: [1,1], presence: [0,0], views: true});
    await page.evaluate(() => {window.nativeProse.session.agentEdit(); window.nativeProse.link.flush(); window.nativeProse.renderEditors(true);});
    await expect(page.locator('wg-content')).toHaveCount(2); await converged(page);
    await expect(page.locator('#right wg-content')).toContainText('PERSISTENT');
    const attached = await page.evaluate(() => {const {A,left,right} = window.nativeProse; return {actors: [A.getActorId(left.doc),A.getActorId(right.doc)], listeners: [left.listeners.size,right.listeners.size], presence: [left.presenceListeners.size,right.presenceListeners.size]};});
    expect(attached).toEqual({actors, listeners: [1,1], presence: [1,1]});
  }
  expect(errors).toEqual([]);
});
