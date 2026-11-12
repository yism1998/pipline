'use client';

import { type RefObject, useLayoutEffect, useRef } from 'react';

const dialogSelector = '[role="dialog"][aria-modal="true"]';
const controlSelector = [
  'a[href]',
  'area[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'iframe',
  'object',
  'embed',
  'audio[controls]',
  'video[controls]',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]',
].join(',');

function isVisible(element: HTMLElement) {
  if (!element.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (style?.visibility === 'hidden' || style?.visibility === 'collapse') return false;
  return Array.from(element.getClientRects()).some(rect => rect.width > 0 && rect.height > 0);
}

function topDialog(document: Document, exclude?: HTMLElement) {
  return Array.from(document.querySelectorAll<HTMLElement>(dialogSelector))
    .filter(dialog => dialog !== exclude && isVisible(dialog))
    .at(-1);
}

function controls(dialog: HTMLElement) {
  return Array.from(dialog.querySelectorAll<HTMLElement>(controlSelector))
    .filter(element => {
      if (element.closest(dialogSelector) !== dialog || !isVisible(element)) return false;
      if (element.matches(':disabled, [disabled], [aria-disabled="true"]')) return false;
      if (element.hasAttribute('tabindex') && element.tabIndex < 0) return false;
      return element.tabIndex >= 0 || element.isContentEditable;
    })
    .map((element, index) => ({ element, index }))
    .sort((a, b) => {
      const aOrder = a.element.tabIndex > 0 ? a.element.tabIndex : Infinity;
      const bOrder = b.element.tabIndex > 0 ? b.element.tabIndex : Infinity;
      return aOrder === bOrder ? a.index - b.index : aOrder - bOrder;
    })
    .map(({ element }) => element);
}

/** Keep keyboard focus inside the topmost mounted modal and restore its opener on close. */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, onClose: () => void) {
  const closeRef = useRef(onClose);

  useLayoutEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    const document = dialog.ownerDocument;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    if (topDialog(document) === dialog) {
      const available = controls(dialog);
      const initial = available.find(element => element.hasAttribute('data-dialog-autofocus')) || available[0] || dialog;
      initial.focus({ preventScroll: true });
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || topDialog(document) !== dialog) return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }

      if (event.key !== 'Tab') return;
      event.preventDefault();
      const available = controls(dialog);
      if (!available.length) {
        dialog.focus({ preventScroll: true });
        return;
      }

      const index = available.findIndex(element => element === document.activeElement);
      const next = index < 0
        ? event.shiftKey ? available.length - 1 : 0
        : (index + (event.shiftKey ? -1 : 1) + available.length) % available.length;
      available[next].focus({ preventScroll: true });
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      const remainingDialog = topDialog(document, dialog);
      if (previousFocus?.isConnected && (!remainingDialog || remainingDialog.contains(previousFocus))) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, [ref]);
}
