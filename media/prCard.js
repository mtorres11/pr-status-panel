// @ts-check
// One PR card of the PR tab: status, ticket, links, the Checks / Comments / Approvals boxes, the expandable
// lists and the ⚙ menu. Every fact comes from the extension; this file only draws it.
(function () {
  /** @typedef {import('../src/core/model').PrView} PrView */

  /** @type {any} */
  const ns = ((/** @type {any} */ (window)).PrStatus ??= {});
  const { h, link } = ns.dom;
  const { send, open } = ns.bridge;

  /** Status → list order, icon, label, CSS class. */
  const STATUS = {
    failing: { order: 0, icon: '✖', label: 'Checks failing', cls: 'st-failing' },
    changes: { order: 1, icon: '●', label: 'Changes requested', cls: 'st-changes' },
    running: { order: 2, icon: '◌', label: 'Checks running', cls: 'st-running' },
    waiting: { order: 3, icon: '◐', label: 'Waiting on review', cls: 'st-waiting' },
    ready: { order: 4, icon: '●', label: 'Ready to merge', cls: 'st-ready' },
    draft: { order: 5, icon: '○', label: 'Drafts', cls: 'st-draft' },
  };

  /** Check state → icon. */
  const CHECK_ICON = { failed: '✖', running: '◌', pending: '○' };

  /** Reviewer state → list class, icon, label. */
  const REVIEWER = {
    changes: ['failed', '✖', ' · requested changes'],
    requested: ['pending', '○', ' · review requested'],
    approved: ['passed', '✔', ' · approved'],
  };

  /** What the page tells the cards. @type {{ rerender: () => void, viewer: () => string | undefined, compact: () => boolean }} */
  let view;
  const expanded = new Set();
  /** id of the PR whose ⚙ menu is open, if any @type {string | null} */
  let openMenuId = null;

  /** Closes the open ⚙ menu; false when none was open. */
  function closeMenu() {
    if (!openMenuId) return false;
    openMenuId = null;
    view.rerender();
    return true;
  }

  /** segments: [{n, cls}] ; total @param {{ n: number, cls: string }[]} segments @param {number} total */
  function bar(segments, total) {
    const el = h('div', { class: 'bar' });
    if (!total) { el.classList.add('empty'); return el; }
    for (const s of segments) if (s.n > 0) el.append(h('div', { class: `seg ${s.cls}`, flex: s.n }));
    const used = segments.reduce((a, s) => a + s.n, 0);
    if (total > used) el.append(h('div', { class: 'seg rest', flex: total - used }));
    return el;
  }

  /** @param {string} label @param {string} value @param {HTMLElement} barEl @param {string} title @param {boolean} compact */
  const box = (label, value, barEl, title, compact) =>
    h('div', { class: 'box', title }, compact ? null : h('div', { class: 'box-head' }, h('span', null, label), h('span', { class: 'val' }, value)), barEl);

  /** @param {PrView} pr @param {boolean} compact */
  function boxes(pr, compact) {
    const c = pr.checks;
    const t = pr.threads;
    const a = pr.approvals;
    const checkTitle = `${c.passed} passed, ${c.failed} failed, ${c.running} running, ${c.pending} pending, ${c.skipped} skipped`;
    const threadTitle = t.total ? `${t.resolved} of ${t.total} review comments resolved, ${t.total - t.resolved} open` : 'No review comments';
    return h('div', { class: 'boxes' + (compact ? ' compact' : '') },
      box('Checks', c.total ? `${c.passed + c.skipped}/${c.total}` : '—',
        bar([{ n: c.passed + c.skipped, cls: 'ok' }, { n: c.failed, cls: 'bad' }, { n: c.running, cls: 'run' }], c.total), checkTitle, compact),
      // unresolved threads get their own yellow segment, like running checks, instead of falling into the gray rest
      box('Comments', t.total ? `${t.resolved}/${t.total}` : '—',
        bar([{ n: t.resolved, cls: 'ok' }, { n: t.total - t.resolved, cls: 'run' }], t.total), threadTitle, compact),
      // extra approvals still fill the bar: met = fully green, never a gray gap
      box('Approvals', approvalValue(a),
        bar([{ n: a.approved, cls: 'ok' }, { n: a.changesRequested, cls: 'bad' }], Math.max(a.required, a.approved + a.changesRequested, 1)),
        approvalTitle(a), compact));
  }

  /** "2/2 +1" when there are more approvals than required, so it never reads as "3 of 2". @param {PrView['approvals']} a */
  function approvalValue(a) {
    const extra = a.approved - a.required;
    return a.required > 0 && extra > 0 ? `${a.required}/${a.required} +${extra}` : `${a.approved}/${a.required}`;
  }

  /** @param {PrView['approvals']} a */
  function approvalTitle(a) {
    const met = a.approved >= a.required ? ': requirement met' : `: ${a.required - a.approved} more needed`;
    return `${a.approved} approval(s) (${a.required} required)${met}${a.changesRequested ? `, ${a.changesRequested} requested changes` : ''}`;
  }

  /** Small copy icon: the extension copies the URL from its own data; shows ✓ briefly. @param {PrView} pr @param {'pr' | 'ticket'} which @param {string} label */
  function copyIcon(pr, which, label) {
    const btn = h('button', {
      class: 'copy-icon', title: `Copy ${label}`, 'aria-label': `Copy ${label}`,
      onclick: (/** @type {Event} */ e) => {
        e.preventDefault(); e.stopPropagation();
        send({ type: 'copyUrl', prId: pr.id, which });
        btn.textContent = '✓'; btn.classList.add('done');
        setTimeout(() => { btn.textContent = '⧉'; btn.classList.remove('done'); }, 1500);
      },
    }, '⧉');
    return btn;
  }

  /** The ticket key (opens Jira, or asks for the Jira site), or the PR number without one. @param {PrView} pr */
  function ticketEl(pr) {
    if (!pr.ticket) return h('span', { class: 'ticket none' }, `#${pr.number}`);
    const click = (/** @type {Event} */ e) => {
      e.preventDefault(); e.stopPropagation();
      if (pr.ticketUrl) open(pr.ticketUrl);
      else send({ type: 'configureJira', ticket: pr.ticket });
    };
    const title = pr.ticketUrl ? `Open ${pr.ticket} in Jira` : 'Set up the Jira link';
    return h('a', { class: 'ticket', href: '#', title, onclick: click }, pr.ticket, ' ↗');
  }

  /**
   * A collapsible list under the card: "▸ <label>", and the items when expanded.
   * Each section of each PR opens on its own. Nothing is drawn when label is empty.
   * @param {PrView} pr @param {string} kind @param {string} label @param {any[]} items @param {(item: any) => HTMLElement} renderItem
   */
  function section(pr, kind, label, items, renderItem) {
    if (!label) return null;
    const key = `${pr.id}:${kind}`;
    const isOpen = expanded.has(key);
    const toggle = () => { if (!expanded.delete(key)) expanded.add(key); view.rerender(); };
    return h('div', { class: `section ${kind}` },
      h('div', { class: 'checks-toggle', onclick: toggle }, `${isOpen ? '▾' : '▸'} ${label}`),
      isOpen && items.length ? h('ul', { class: 'checks' }, ...items.map(renderItem)) : null);
  }

  /** @param {PrView} pr */
  function checksSection(pr) {
    const problems = pr.checks.items.filter((i) => i.state in CHECK_ICON);
    return section(pr, 'checks', problems.length ? `${problems.length} check(s) not passing` : '', problems, (c) =>
      h('li', { class: `ck ${c.state}` }, h('span', null, CHECK_ICON[c.state]), link(c.name, c.url)));
  }

  /** @param {PrView} pr */
  function commentsSection(pr) {
    const items = pr.threads.items;
    return section(pr, 'comments', items.length ? `${items.length} comment(s) unresolved` : '', items, (t) =>
      h('li', { class: 'ck running', title: t.snippet },
        h('span', null, '●'),
        h('span', { class: 'ck-text' },
          link(t.author, t.url),
          t.where ? h('span', { class: 'muted' }, ` · ${t.where}`) : null,
          t.outdated ? h('span', { class: 'muted' }, ' · outdated') : null,
          t.snippet ? h('span', { class: 'snippet' }, ` — ${t.snippet}`) : null)));
  }

  /** What is missing, or who approved when nothing is, so the section is there to check. @param {PrView['approvals']} a */
  function approvalLabel(a) {
    const missing = Math.max(a.required - a.approved, 0);
    const parts = [missing ? `${missing} approval(s) missing` : '', a.changesRequested ? `${a.changesRequested} requested changes` : ''];
    return parts.filter(Boolean).join(', ') || (a.items.length ? `${a.approved} approval(s)` : '');
  }

  /** @param {PrView} pr */
  function approvalsSection(pr) {
    const a = pr.approvals;
    return section(pr, 'approvals', approvalLabel(a), a.items, (r) => {
      const [cls, icon, label] = REVIEWER[r.state];
      return h('li', { class: `ck ${cls}` }, h('span', null, icon),
        h('span', { class: 'ck-text' }, link(r.name, r.url), h('span', { class: 'muted' }, label)));
    });
  }

  /** Why each re-run is not possible, if it is not. @param {PrView} pr */
  function rerunReasons(pr) {
    const failed = pr.checks.failed;
    // Each button has its own rule: "failed" needs a failed Actions run, "all" only needs any Actions run.
    // A failing non-Actions check (e.g. AWS CodeBuild) must not disable "all", which is how it gets re-triggered.
    const failedWhy = pr.rerun.failedRunIds.length ? undefined
      : failed ? 'The failing checks are not GitHub Actions workflows yet; use Re-run all checks' : 'No failed checks to re-run';
    const allWhy = pr.rerun.allRunIds.length ? undefined : 'No GitHub Actions workflows behind these checks';
    return { failedWhy, allWhy, note: (failed > 0 && failedWhy) || allWhy };
  }

  /** Why "Update branch" is not possible, if it is not. @param {PrView} pr */
  function updateReason(pr) {
    if (pr.canUpdateBranch) return undefined;
    return pr.mergeable === 'CONFLICTING'
      ? 'Merge conflicts: resolve them locally first'
      : `Nothing to update: up to date with ${pr.baseRef}, or you can't push to this branch`;
  }

  /** A menu entry that closes the menu and sends `msg`. @param {string} label @param {string} title @param {string | undefined} why @param {object} msg */
  const menuItem = (label, title, why, msg) => h('button', {
    class: 'pr-menu-item', disabled: why !== undefined, title: why || title,
    onclick: (/** @type {Event} */ e) => { e.stopPropagation(); openMenuId = null; view.rerender(); send(msg); },
  }, label);

  /** @param {PrView} pr */
  function menuItems(pr) {
    const { failedWhy, allWhy, note } = rerunReasons(pr);
    const updateWhy = updateReason(pr);
    const base = pr.baseRef;
    const failed = pr.checks.failed;
    return [
      menuItem(`↻ Re-run failed checks${failed ? ` (${failed})` : ''}`, 'Re-run only the failed jobs', failedWhy, { type: 'rerun', prId: pr.id, mode: 'failed' }),
      menuItem('↻ Re-run all checks', 'Re-run every job in the workflow runs for this PR', allWhy, { type: 'rerun', prId: pr.id, mode: 'all' }),
      note ? h('div', { class: 'pr-menu-note' }, note) : null,
      h('div', { class: 'pr-menu-sep' }),
      menuItem(`⤓ Update branch (merge ${base})`, `Merge the latest ${base} into this branch, like GitHub's Update branch button`, updateWhy, { type: 'updateBranch', prId: pr.id, method: 'merge' }),
      menuItem('⤓ Update branch (rebase)', `Replay this branch on top of the latest ${base} (rewrites the branch)`, updateWhy, { type: 'updateBranch', prId: pr.id, method: 'rebase' }),
      !pr.canUpdateBranch && pr.mergeable === 'CONFLICTING' ? h('div', { class: 'pr-menu-note' }, updateWhy) : null,
    ];
  }

  /** ⚙ button + per-PR options menu. Add future per-PR options to menuItems. @param {PrView} pr */
  function prMenu(pr) {
    const isOpen = openMenuId === pr.id;
    const gear = h('button', {
      class: 'gear' + (isOpen ? ' open' : '') + (pr.behind ? ' has-action' : ''),
      title: pr.behind ? `PR options · behind ${pr.baseRef}, can be updated` : 'PR options',
      'aria-haspopup': 'menu',
      'aria-expanded': isOpen ? 'true' : 'false',
      onclick: (/** @type {Event} */ e) => { e.stopPropagation(); openMenuId = isOpen ? null : pr.id; view.rerender(); },
    }, '⚙');
    return h('span', { class: 'pr-menu-wrap', onclick: (/** @type {Event} */ e) => e.stopPropagation() },
      gear, isOpen ? h('div', { class: 'pr-menu', role: 'menu' }, ...menuItems(pr)) : null);
  }

  /** Small, quiet labels: behind its base (the action lives in ⚙), queued to merge. @param {PrView} pr */
  function flags(pr) {
    return [
      pr.behind ? h('span', { class: 'behind', title: `Behind ${pr.baseRef}: update available in ⚙` }, '⤓ behind') : null,
      pr.inMergeQueue ? h('span', { class: 'queued', title: 'In the merge queue: GitHub will merge it when its checks pass' }, '⇢ in queue') : null,
    ];
  }

  /** @param {PrView} pr */
  function compactCard(pr) {
    const st = STATUS[pr.status];
    return h('div', { class: `card compact ${st.cls}`, title: `${pr.repo}#${pr.number}: ${pr.title}`, onclick: () => open(pr.url) },
      h('span', { class: 'dot' }, st.icon), ticketEl(pr), h('span', { class: 'title' }, pr.title), boxes(pr, true), prMenu(pr));
  }

  /** @param {PrView} pr */
  function fullCard(pr) {
    const st = STATUS[pr.status];
    return h('div', { class: `card ${st.cls}` },
      h('div', { class: 'card-top' },
        h('span', { class: 'dot', title: st.label }, st.icon), ticketEl(pr),
        pr.ticketUrl ? copyIcon(pr, 'ticket', `${pr.ticket} link`) : null,
        h('span', { class: 'repo', title: pr.repo }, pr.repo.split('/')[1]),
        ...flags(pr),
        prMenu(pr)),
      h('div', { class: 'pr-row' }, link(`#${pr.number} ${pr.title} ↗`, pr.url, 'pr-link', pr.url), copyIcon(pr, 'pr', 'PR link')),
      h('div', { class: 'url muted' }, pr.url.replace(/^https?:\/\//, '')),
      boxes(pr, false),
      pr.mergeable === 'CONFLICTING' ? h('div', { class: 'warn' }, '⚠ Merge conflicts') : null,
      checksSection(pr),
      commentsSection(pr),
      approvalsSection(pr),
      pr.author !== view.viewer() ? h('div', { class: 'muted small' }, `by ${pr.author}`) : null);
  }

  /** @param {PrView} pr */
  const card = (pr) => (view.compact() ? compactCard(pr) : fullCard(pr));

  /**
   * Starts drawing cards for the page. Only one page uses it.
   * @param {{ rerender: () => void, viewer: () => string | undefined, compact: () => boolean }} page
   */
  function create(page) {
    view = page;
    return { card, closeMenu };
  }

  ns.prCard = { create, STATUS };
})();
