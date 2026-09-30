/**
 * Click-and-type inside the site preview (contract §3). Served at
 * /api/nova/edit.js and added to every preview page; it does nothing unless
 * the page is framed by an allowed Nova OS origin and Nova OS has turned
 * edit mode on with an `edit-mode` message (the pencil). It is never on by
 * itself: not on load, not from the address (`nova_edit=1` only marks the
 * page as framed by the editor), so the page looks exactly as it does live.
 *
 * Only the text node that changed is reported, so a headline with an
 * <em> inside still maps to exactly one string in the source.
 */
export function buildEditScript(allowedOrigins: string[]): string {
	return `(() => {
  if (window.parent === window || window.__novaEdit) return;
  window.__novaEdit = true;
  const ORIGINS = ${JSON.stringify(allowedOrigins)};
  const post = (msg) => ORIGINS.forEach((o) => { try { window.parent.postMessage({ source: 'nova-sites', ...msg }, o); } catch (e) {} });
  let on = false;
  let editing = null;
  const style = document.createElement('style');
  // Nova's accent (#4292b2) for the outlines; hover is the 150 ms colour recipe on Nova's curve, the
  // element being edited gets a solid ring with a soft halo; with Reduce Motion nothing transitions.
  // Nothing here may change how the page looks: no border-radius (a rounded button must stay rounded;
  // the outline follows the element's own corners), only the outline while editing is on.
  style.textContent = 'html[data-nova-edit] [data-nova-editable]{cursor:text;outline:1px solid transparent;outline-offset:3px;transition:outline-color .15s cubic-bezier(.22,1,.36,1),box-shadow .15s cubic-bezier(.22,1,.36,1)}' +
    'html[data-nova-edit] [data-nova-editable]:hover{outline-color:rgba(66,146,178,.85)}' +
    'html[data-nova-edit] img{outline:2px solid transparent;outline-offset:2px;transition:outline-color .15s cubic-bezier(.22,1,.36,1)}' +
    'html[data-nova-edit] img{cursor:pointer}html[data-nova-edit] img:hover{outline-color:rgba(66,146,178,.85)}' +
    '[data-nova-editing]{outline:2px solid #4292b2!important;outline-offset:3px;box-shadow:0 0 0 6px rgba(66,146,178,.22)!important}' +
    '@media(prefers-reduced-motion:reduce){[data-nova-editable],html[data-nova-edit] img{transition:none}}';
  document.head.appendChild(style);
  const hasOwnText = (el) => Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.data.trim());
  const textNodes = (el) => { const out = []; const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); while (w.nextNode()) out.push(w.currentNode); return out; };
  const mark = () => {
    document.documentElement.toggleAttribute('data-nova-edit', on);
    document.querySelectorAll('body *').forEach((el) => {
      if (['SCRIPT','STYLE','NOSCRIPT','SVG','PATH','IFRAME','TEXTAREA','INPUT','SELECT','OPTION'].includes(el.tagName)) return;
      if (on && hasOwnText(el)) el.setAttribute('data-nova-editable', ''); else el.removeAttribute('data-nova-editable');
    });
  };
  const finish = (el, keep) => {
    if (el.__novaFinished) return;
    el.__novaFinished = true;
    const nodes = el.__novaNodes || [];
    editing = null;
    el.removeAttribute('contenteditable');
    el.removeAttribute('data-nova-editing');
    if (!keep) { nodes.forEach((n, i) => { n.data = el.__novaBefore[i]; }); return; }
    const changed = nodes.map((n, i) => ({ before: el.__novaBefore[i], after: n.isConnected ? n.data : null })).filter((c) => c.after !== c.before);
    if (changed.length === 0) return;
    if (changed.length === 1 && changed[0].after !== null) {
      post({ type: 'text', before: changed[0].before.trim(), after: changed[0].after.trim() });
    } else {
      post({ type: 'text', before: el.__novaBeforeText.trim(), after: el.innerText.trim() });
    }
  };
  document.addEventListener('click', (e) => {
    if (!on) return;
    const img = e.target.closest && e.target.closest('img');
    if (img) { e.preventDefault(); e.stopPropagation(); post({ type: 'image', src: img.getAttribute('src') || '', alt: img.getAttribute('alt') || '' }); return; }
    const el = e.target.closest && e.target.closest('[data-nova-editable]');
    if (!el) return;
    e.preventDefault(); e.stopPropagation();
    if (editing === el) return;
    if (editing) finish(editing, true);
    editing = el;
    el.__novaFinished = false;
    el.__novaNodes = textNodes(el);
    el.__novaBefore = el.__novaNodes.map((n) => n.data);
    el.__novaBeforeText = el.innerText;
    el.setAttribute('contenteditable', 'plaintext-only');
    el.setAttribute('data-nova-editing', '');
    el.focus();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (!editing) { if (e.key === 'Escape' && on) post({ type: 'escape' }); return; }
    if (e.key === 'Escape') { e.preventDefault(); finish(editing, false); }
    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(editing, true); }
  }, true);
  document.addEventListener('focusout', (e) => { if (editing && e.target === editing) finish(editing, true); }, true);
  window.addEventListener('message', (e) => {
    if (!ORIGINS.includes(e.origin) || !e.data || e.data.source !== 'nova-os') return;
    if (e.data.type === 'ping') { post({ type: 'ready' }); return; }
    if (e.data.type === 'scroll-to' && typeof e.data.y === 'number') { window.scrollTo({ top: e.data.y, behavior: 'instant' }); return; }
    if (e.data.type === 'edit-mode') { on = !!e.data.on; if (!on && editing) finish(editing, true); mark(); }
  });
  // Where the page is scrolled, so a new version of it opens at the same place (one message per frame at most).
  let scrollTick = null;
  window.addEventListener('scroll', () => { if (scrollTick !== null) return; scrollTick = requestAnimationFrame(() => { scrollTick = null; post({ type: 'scroll', y: window.scrollY }); }); }, { passive: true });
  const start = () => { mark(); new MutationObserver(() => { if (on && !editing) mark(); }).observe(document.body, { childList: true, subtree: true }); post({ type: 'ready' }); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();`;
}
