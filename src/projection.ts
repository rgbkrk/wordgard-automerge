import {diffArrays} from 'diff';
import {Leaf, Plot, Token, Mark, ChangeSet, type Node} from 'wordgard/doc';

interface Unit {key: string; token: Token; length: number; marks: readonly Mark[]; text: boolean}
function units(doc: Plot.Doc) {
  const out: Unit[] = [];
  const walk = (node: Node) => {
    if (node.isText) {
      for (const char of String(node.param)) out.push({key: `text:${char}`, token: Leaf.text(char, node.marks), length: char.length, marks: node.marks, text: true});
    } else if (node.isPlot) {
      out.push({key: JSON.stringify(node.tag.toJSON()), token: node.tag, length: 1, marks: [], text: false});
      node.content.forEach(walk);
      out.push({key: 'close', token: Plot.End, length: 1, marks: [], text: false});
    } else out.push({key: JSON.stringify(node.toJSON()), token: node, length: node.length, marks: [], text: false});
  };
  doc.content.forEach(walk);
  return out;
}

// Preserve equal text as equal text, even when its marks change. Replacing a
// marked passage wholesale would damage selection and local undo mappings.
export function projectChanges(before: Plot.Doc, after: Plot.Doc): ChangeSet {
  if (before.eq(after)) return ChangeSet.empty(before.length);
  const oldUnits = units(before), newUnits = units(after);
  const diff = diffArrays(oldUnits, newUnits, {comparator: (a, b) => a.key === b.key});
  const specs: ChangeSet.Change[] = [];
  let oldIndex = 0, newIndex = 0, pos = 0;
  let replacement: {from: number; to: number; insert: Token[]} | null = null;
  const flush = () => { if (replacement) specs.push(replacement); replacement = null; };
  for (const part of diff) {
    if (part.added || part.removed) {
      replacement ??= {from: pos, to: pos, insert: []};
      if (part.removed) {
        for (const unit of part.value) { pos += unit.length; oldIndex++; }
        replacement.to = pos;
      } else {
        replacement.insert.push(...part.value.map(u => u.token)); newIndex += part.count;
      }
    } else {
      flush();
      for (let i = 0; i < part.count; i++) {
        const old = oldUnits[oldIndex++], next = newUnits[newIndex++];
        if (old.text) {
          for (const mark of old.marks) if (!next.marks.some(m => m.eq(mark))) specs.push({from: pos, to: pos + old.length, remove: mark});
          for (const mark of next.marks) if (!old.marks.some(m => m.eq(mark))) specs.push({from: pos, to: pos + old.length, add: mark});
        }
        pos += old.length;
      }
    }
  }
  flush();
  const changes = ChangeSet.create(before, specs);
  if (!changes.apply(before).eq(after)) throw Error('Projection did not reproduce the Automerge document');
  return changes;
}
