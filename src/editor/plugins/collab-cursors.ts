import type { DecorationAttrs } from '@milkdown/kit/prose/view';
import {
  createAgentFaceElement,
  isAgentIdentity,
  resolveAgentFamily,
} from '../../ui/agent-identity-icon';

function normalizeUserName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function normalizeColor(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed : fallback;
}

export function installCollabCursorStyles(): void {
  if (document.getElementById('proof-collab-cursor-styles')) return;
  const style = document.createElement('style');
  style.id = 'proof-collab-cursor-styles';
  style.textContent = `
    /* Cursor widget is provided by y-prosemirror. Keep its inline layout semantics
       (it uses invisible separators) so the caret is positioned correctly. */
    /* y-prosemirror also recommends a small offset fix when a cursor decoration is the
       first child of the editor (common when the first block has margin-top). */
    .ProseMirror > .ProseMirror-yjs-cursor.proof-collab-cursor:first-child {
      margin-top: 16px;
    }

    .ProseMirror-yjs-cursor.proof-collab-cursor {
      position: relative;
      pointer-events: none;
      display: inline-block;
      margin-left: -1px;
      margin-right: -1px;
      border-left: 2px solid var(--proof-collab-cursor-color, #60a5fa);
      border-right: 0;
      word-break: normal;
    }

    .proof-collab-cursor__label {
      position: absolute;
      left: -1px;
      top: -1.15em;
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding: 2px 7px;
      font-size: 10px;
      line-height: 1.1;
      border-radius: 999px;
      background: rgba(17, 24, 39, 0.92);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-left: 3px solid var(--proof-collab-cursor-color, #60a5fa);
      color: rgba(255, 255, 255, 0.92);
      letter-spacing: 0.2px;
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.18);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
    }

    .proof-collab-cursor__face {
      filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.12));
    }
  `;
  document.head.appendChild(style);
}

export function collabCursorBuilder(user: any): HTMLElement {
  installCollabCursorStyles();

  const name = normalizeUserName(user?.name, 'User');
  const color = normalizeColor(user?.color, '#60a5fa');
  const avatar = typeof user?.avatar === 'string' && user.avatar.trim() ? user.avatar.trim() : null;
  const family = resolveAgentFamily({ name, avatar });
  const shouldRenderAgentFace = isAgentIdentity({ name, avatar });

  const cursorWidget = document.createElement('span');
  cursorWidget.className = 'ProseMirror-yjs-cursor proof-collab-cursor';
  cursorWidget.style.setProperty('--proof-collab-cursor-color', color);

  const label = document.createElement('div');
  label.className = 'proof-collab-cursor__label';
  if (shouldRenderAgentFace) {
    label.style.display = 'inline-flex';
    label.style.alignItems = 'center';
    label.style.gap = '6px';
    label.dataset.agentFamily = family;

    const icon = createAgentFaceElement({
      family,
      size: 14,
      title: `${name} icon`,
      wrapperClassName: 'proof-collab-cursor__face',
      className: 'proof-collab-cursor__face-svg',
    });

    const text = document.createElement('span');
    text.textContent = name;

    label.replaceChildren(icon, text);
  } else if (avatar) {
    label.style.display = 'inline-flex';
    label.style.alignItems = 'center';
    label.style.gap = '6px';

    const img = document.createElement('img');
    img.src = avatar;
    img.alt = '';
    img.width = 14;
    img.height = 14;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.style.borderRadius = '999px';
    img.style.objectFit = 'cover';
    img.style.boxShadow = '0 0 0 1px rgba(255,255,255,0.12)';

    const text = document.createElement('span');
    text.textContent = name;

    label.replaceChildren(img, text);
  } else {
    label.textContent = name;
  }

  // y-prosemirror's default builder uses U+2060 separators to ensure stable inline layout.
  cursorWidget.appendChild(document.createTextNode('\u2060'));
  cursorWidget.appendChild(label);
  cursorWidget.appendChild(document.createTextNode('\u2060'));
  return cursorWidget;
}

export function collabSelectionBuilder(user: any): DecorationAttrs {
  const color = normalizeColor(user?.color, '#60a5fa');
  return {
    class: 'ProseMirror-yjs-selection proof-collab-selection',
    style: [
      `background-image: linear-gradient(180deg, ${color}14 0%, ${color}0d 100%)`,
      `outline: 1px solid ${color}2e`,
      'outline-offset: -1px',
      `border-bottom: 2px solid ${color}66`,
      'border-radius: 2px',
    ].join(';'),
  };
}
