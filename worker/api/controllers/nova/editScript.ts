/**
 * Click-and-type inside the site preview (contract §3). Served at
 * /api/nova/edit.js and added to every preview page; it does nothing unless
 * the page is framed by an allowed Nova OS origin and edit mode is on
 * (`nova_edit=1` on the first load, or a message from Nova OS).
 *
 * Only the text node that changed is reported, so a headline with an
 * <em> inside still maps to exactly one string in the source.
 */
export function buildEditScript(allowedOrigins: string[]): string {
	return `(() => {
  if (window.parent === window || window.__novaEdit) return;
  window.__novaEdit = true;
  const ORIGINS = ${JSON.stringify(allowedOrigins)};
  const KEY = 'nova-edit';
  const post = (msg) => ORIGINS.forEach((o) => { try { window.parent.postMessage({ source: 'nova-sites', ...msg }, o); } catch (e) {} });
  if (new URLSearchParams(location.search).get('nova_edit') === '1') sessionStorage.setItem(KEY, '1');
  let on = sessionStorage.getItem(KEY) === '1';
  let editing = null;
  const style = document.createElement('style');
  style.textContent = '[data-nova-editable]{cursor:text;outline:1px dashed transparent;outline-offset:3px;transition:outline-color .15s cubic-bezier(.22,1,.36,1)}' +
    'html[data-nova-edit] [data-nova-editable]:hover{outline-color:rgba(99,102,241,.7)}' +
    'html[data-nova-edit] img{cursor:pointer}html[data-nova-edit] img:hover{outline:2px solid rgba(99,102,241,.7);outline-offset:2px}' +
    '[data-nova-editing]{outline:2px solid rgb(99,102,241)!important;outline-offset:3px}';
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
    const nodes = el.__novaNodes || [];
    el.removeAttribute('contenteditable');
    el.removeAttribute('data-nova-editing');
    editing = null;
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
    if (e.data.type === 'edit-mode') { on = !!e.data.on; sessionStorage.setItem(KEY, on ? '1' : '0'); if (!on && editing) finish(editing, true); mark(); }
  });
  const start = () => { mark(); new MutationObserver(() => { if (on && !editing) mark(); }).observe(document.body, { childList: true, subtree: true }); post({ type: 'ready' }); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();`;
}
