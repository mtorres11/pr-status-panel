// @ts-check
// Shared webview helpers: an element builder, dropdown options, links, form rows, the sign-in state and
// "updated … ago". Loaded first; the other scripts find these on window.PrStatus.dom.
(function () {
  /** @type {any} */
  const ns = ((/** @type {any} */ (window)).PrStatus ??= {});

  /** @param {unknown} v */
  const isEmpty = (v) => v === undefined || v === null || v === false;

  /**
   * One attribute: `on…` adds a listener, `class` sets the class, `flex` sets the flex size (the CSP blocks
   * inline style attributes, so it goes through the CSSOM), anything else is a plain attribute.
   * @param {HTMLElement} el @param {string} k @param {any} v
   */
  function setAttr(el, k, v) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'flex') el.style.flex = `${v} 1 0`;
    else el.setAttribute(k, v === true ? '' : String(v));
  }

  /**
   * Builds an element. Empty attributes and children (undefined, null, false) are skipped.
   * @param {string} tag
   * @param {Record<string, any> | null} [attrs]
   * @param {...(Node | string | null | undefined | false | (Node | string | null | undefined | false)[])} children
   * @returns {any}
   */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) if (!isEmpty(v)) setAttr(el, k, v);
    for (const c of children.flat()) if (!isEmpty(c)) el.append(typeof c === 'string' ? document.createTextNode(c) : /** @type {Node} */ (c));
    return el;
  }

  /**
   * Replaces a dropdown's choices and selects `value`.
   * @param {HTMLSelectElement} sel @param {readonly (readonly [string | number, string])[]} options @param {string | number} value
   */
  function setOptions(sel, options, value) {
    sel.replaceChildren(...options.map(([v, label]) => h('option', { value: String(v) }, label)));
    sel.value = String(value);
  }

  /**
   * Text that opens `url` in the browser (https only, checked again by the extension); plain text without one.
   * @param {string} text @param {string | undefined} url @param {string} [cls] @param {string} [title]
   */
  function link(text, url, cls, title) {
    if (!url) return h('span', { class: cls }, text);
    const open = (/** @type {Event} */ e) => { e.preventDefault(); e.stopPropagation(); ns.bridge.open(url); };
    return h('a', { class: cls, href: '#', title, onclick: open }, text);
  }

  /**
   * A labelled form row. A single select or input sits in a <label>, so clicking the label focuses it;
   * several controls share one line.
   * @param {string} label @param {...HTMLElement} controls
   */
  function row(label, ...controls) {
    const single = controls.length === 1 ? controls[0] : null;
    const tag = single && /^(SELECT|INPUT)$/.test(single.tagName) ? 'label' : 'div';
    return h(tag, { class: 'row' }, h('span', { class: 'row-label' }, label), single || h('div', { class: 'inline' }, ...controls));
  }

  /** "Sign in to GitHub" in place of a list. */
  function signInState() {
    return h('div', { class: 'empty-state' },
      h('p', null, 'Sign in to GitHub to see your pull requests.'),
      h('button', { class: 'primary', onclick: () => ns.bridge.send({ type: 'signIn' }) }, 'Sign in to GitHub'));
  }

  /** @param {number | undefined} ts */
  function ago(ts) {
    if (!ts) return 'never';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    return `${Math.round(s / 3600)}h ago`;
  }

  ns.dom = { h, setOptions, link, row, signInState, ago };
})();
