import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { suggestionWithStatus } from '../shared/suggestion-status';
import type { StoredMark } from '../formats/marks';
import { ReviewDecisionHistory } from '../editor/review-decision-history';

const doc = new Y.Doc(); const marks = doc.getMap('marks'); const fragment = doc.getXmlFragment('prosemirror');
const paragraph = new Y.XmlElement('paragraph'); const text = new Y.XmlText(); text.insert(0, 'Original'); paragraph.insert(0, [text]); fragment.insert(0, [paragraph]);
marks.set('suggestion', { kind: 'replace', content: 'Changed', quote: 'Original' });
const before = { text: fragment.toString(), marks: marks.toJSON() };
const history = new ReviewDecisionHistory(doc);
history.decide(() => { text.delete(0, 8); text.insert(0, 'Changed'); marks.set('suggestion', suggestionWithStatus(marks.get('suggestion') as StoredMark, 'accepted', 'human:Bob'));  });
assert.equal(history.undo(), true);
assert.deepEqual({ text: fragment.toString(), marks: marks.toJSON() }, before, 'Undo restores both text and exact mark data');
assert.equal(history.redo(), true); assert.equal(text.toString(), 'Changed'); assert.equal((marks.get('suggestion') as StoredMark).status, 'accepted');
text.insert(text.length, ' typed');
assert.equal(history.undo(), true); assert.equal(text.toString(), 'Original typed', 'Typing is outside decision undo');
history.destroy(); doc.destroy();
console.log('✓ scoped decision undo/redo');
