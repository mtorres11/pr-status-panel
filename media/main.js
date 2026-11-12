// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');

  /** @type {any} */
  let data = null;
  const expanded = new Set();
  let repoMenuOpen = false;
  let repoSearch = '';

  // ---------- tiny DOM helper ----------
  /**
   * @param {string} tag
   * @param {Record<string, any>} [attrs]
   * @param {...(Node|string|null|undefined|false)} children
   */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      // The webview CSP blocks inline style attributes; set flex through the CSSOM instead.
      else if (k === 'flex') el.style.flex = `${v} 1 0`;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }

  const send = (msg) => vscode.postMessage(msg);
  const setState = (patch) => send({ type: 'setState', patch });
  const open = (url) => send({ type: 'open', url });

  // ---------- static skeleton ----------
  const accountSel = h('select', { title: 'Signed-in GitHub account', onchange: (e) => {
    const v = e.target.value;
    if (v === '__add') { send({ type: 'addAccount' }); renderControls(); return; }
    setState({ accountKey: v });
  } });
  const authorSel = h('select', { title: 'Whose pull requests', onchange: (e) => setState({ author: e.target.value }) });
  const showSel = h('select', { title: 'Which relationship to the PR', onchange: (e) => setState({ show: e.target.value }) },
    h('option', { value: 'authored' }, 'Authored'),
    h('option', { value: 'review' }, 'Review requested'),
    h('option', { value: 'assigned' }, 'Assigned'),
    h('option', { value: 'all' }, 'All of these'));
  const sortSel = h('select', { title: 'Sort order', onchange: (e) => setState({ sort: e.target.value }) },
    h('option', { value: 'attention' }, 'Needs attention'),
    h('option', { value: 'updated' }, 'Last updated'),
    h('option', { value: 'ticket' }, 'Ticket'));
  const draftsChk = h('input', { type: 'checkbox', id: 'drafts', onchange: (e) => setState({ drafts: e.target.checked }) });

  const repoBtn = h('button', { class: 'combo-btn', title: 'Repository', onclick: () => {
    repoMenuOpen = !repoMenuOpen;
    repoMenu.hidden = !repoMenuOpen;
    if (repoMenuOpen) { repoInput.value = repoSearch; renderRepoOptions(); repoInput.focus(); }
  } });
  const repoInput = h('input', { class: 'combo-search', placeholder: 'Search repos…', oninput: (e) => { repoSearch = e.target.value; renderRepoOptions(); },
    onkeydown: (e) => { if (e.key === 'Escape') closeRepoMenu(); } });
  const repoList = h('div', { class: 'combo-list' });
  const repoMenu = h('div', { class: 'combo-menu', hidden: true }, repoInput, repoList);
  const repoCombo = h('div', { class: 'combo' }, repoBtn, repoMenu);
  /** id of the PR whose ⚙ menu is open, if any */
  let openMenuId = null;
  document.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (repoMenuOpen && !repoCombo.contains(target)) closeRepoMenu();
    if (openMenuId && !target.closest('.pr-menu-wrap')) { openMenuId = null; renderList(); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openMenuId) { openMenuId = null; renderList(); }
  });
  function closeRepoMenu() { repoMenuOpen = false; repoMenu.hidden = true; }

  /** PRs in the order they are shown in the list (set by renderList). */
  let displayedPrs = [];
  /** Needs approval = not fully approved yet and not in the merge queue. */
  const needsApproval = (p) => p.approvals.approved < p.approvals.required && !p.inMergeQueue;
  const descChk = h('input', { type: 'checkbox', id: 'adddesc', onchange: (e) => setState({ addDescription: e.target.checked }) });
  const copyBtn = h('button', { class: 'secondary copy-btn', onclick: () => {
    const ids = displayedPrs.filter(needsApproval).map((p) => p.id);
    if (ids.length) send({ type: 'copyLinks', ids, withDescription: descChk.checked });
  } });

  const row = (label, control) => h('label', { class: 'row' }, h('span', { class: 'row-label' }, label), control);
  const controls = h('div', { class: 'controls' },
    row('Account', accountSel),
    row('Author', authorSel),
    h('div', { class: 'row' }, h('span', { class: 'row-label' }, 'Repo'), repoCombo),
    h('div', { class: 'row' }, h('span', { class: 'row-label' }, 'Show'),
      h('div', { class: 'inline' }, showSel,
        h('label', { class: 'chk', for: 'drafts' }, draftsChk, 'Drafts'),
        sortSel)),
    h('div', { class: 'row' }, h('span', { class: 'row-label' }, 'Share'),
      h('div', { class: 'inline' }, copyBtn,
        h('label', { class: 'chk', for: 'adddesc' }, descChk, 'Add description'))));
  const summary = h('div', { class: 'summary' });
  const list = h('div', { class: 'list' });
  const footer = h('div', { class: 'footer muted' });
  app.append(controls, summary, list, footer);

  function renderFooter() {
    const a = data.about;
    if (!a || !a.author) { footer.replaceChildren(); return; }
    footer.replaceChildren(
      'Created by ', a.author,
      a.repoUrl ? ' · ' : '',
      a.repoUrl ? h('a', { href: '#', title: a.repoUrl, onclick: (e) => { e.preventDefault(); open(a.repoUrl); } }, 'GitHub') : null,
      a.version ? ` · v${a.version}` : '');
  }

  // ---------- rendering ----------
  function setOptions(sel, options, value) {
    sel.replaceChildren(...options.map(([v, label]) => h('option', { value: v }, label)));
    sel.value = value;
  }

  function renderControls() {
    const ui = data.ui;
    const accts = data.accounts.map((a) => [a.key, a.label]);
    setOptions(accountSel, [...(accts.length ? accts : [['', 'Not signed in']]), ['__add', '＋ Add another account…']], ui.accountKey || '');

    const authorOpts = [['@me', data.viewerLogin ? `Me (${data.viewerLogin})` : 'Me']];
    if (data.team.length) authorOpts.push(['@team', `Whole team (${data.team.length})`]);
    for (const m of data.team) authorOpts.push([m, m]);
    const special = ['@me', '@team', ...data.team];
    if (!special.includes(ui.author)) authorOpts.push([ui.author, ui.author]);
    authorOpts.push(['@other', 'Other user…']);
    setOptions(authorSel, authorOpts, ui.author);

    showSel.value = ui.show;
    sortSel.value = ui.sort;
    draftsChk.checked = ui.drafts;
    repoBtn.textContent = (ui.repo === '*' ? `All repos (${data.repos.length})` : ui.repo) + '  ▾';
    if (repoMenuOpen) renderRepoOptions();
  }

  function renderRepoOptions() {
    const q = repoSearch.trim().toLowerCase();
    const favs = new Set(data.favorites);
    const match = (r) => !q || r.toLowerCase().includes(q);
    const pick = (value) => { closeRepoMenu(); setState({ repo: value }); };
    const item = (repo) => {
      const fav = favs.has(repo);
      return h('div', { class: 'combo-item' + (data.ui.repo === repo ? ' selected' : ''), onclick: () => pick(repo) },
        h('button', {
          class: 'star' + (fav ? ' on' : ''),
          title: fav ? 'Remove from Favorites' : 'Add to Favorites',
          'aria-pressed': fav ? 'true' : 'false',
          // Stays open so several repos can be starred in a row.
          onclick: (e) => { e.stopPropagation(); send({ type: 'toggleFavorite', repo }); },
        }, fav ? '★' : '☆'),
        h('span', { class: 'combo-text' }, repo));
    };

    const favList = data.favorites.filter(match);
    const others = data.repos.filter((r) => !favs.has(r) && match(r));
    const children = [
      h('div', { class: 'combo-item' + (data.ui.repo === '*' ? ' selected' : ''), onclick: () => pick('*') },
        h('span', { class: 'star-spacer' }), h('span', { class: 'combo-text' }, `All repos (${data.repos.length})`)),
    ];
    if (favList.length) children.push(h('div', { class: 'combo-sep' }, 'Favorites'), ...favList.map(item));
    if (others.length) children.push(h('div', { class: 'combo-sep' }, 'All repositories'), ...others.map(item));
    if (!favList.length && !others.length && q) children.push(h('div', { class: 'combo-empty' }, 'No matching repos'));
    // Never pass null to replaceChildren: it would be rendered as the text "null".
    repoList.replaceChildren(...children);
  }

  function ago(ts) {
    if (!ts) return 'never';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    return `${Math.round(s / 3600)}h ago`;
  }

  function renderSummary() {
    const prs = data.prs;
    const n = (st) => prs.filter((p) => p.status === st).length;
    const parts = [`${prs.length} open`];
    if (n('ready')) parts.push(`${n('ready')} ready`);
    if (n('failing')) parts.push(`${n('failing')} failing`);
    if (n('changes')) parts.push(`${n('changes')} changes requested`);
    summary.replaceChildren(
      h('span', null, parts.join(' · ')),
      h('span', { class: 'muted' }, data.loading ? ' · refreshing…' : ` · updated ${ago(data.updatedAt)}`),
    );
  }

  const STATUS = {
    failing: { order: 0, icon: '✖', label: 'Checks failing', cls: 'st-failing' },
    changes: { order: 1, icon: '●', label: 'Changes requested', cls: 'st-changes' },
    running: { order: 2, icon: '◌', label: 'Checks running', cls: 'st-running' },
    waiting: { order: 3, icon: '◐', label: 'Waiting on review', cls: 'st-waiting' },
    ready: { order: 4, icon: '●', label: 'Ready to merge', cls: 'st-ready' },
    draft: { order: 5, icon: '○', label: 'Drafts', cls: 'st-draft' },
  };

  /** segments: [{n, cls}] ; total */
  function bar(segments, total) {
    const el = h('div', { class: 'bar' });
    if (!total) { el.classList.add('empty'); return el; }
    for (const s of segments) if (s.n > 0) el.append(h('div', { class: `seg ${s.cls}`, flex: s.n }));
    const used = segments.reduce((a, s) => a + s.n, 0);
    if (total > used) el.append(h('div', { class: 'seg rest', flex: total - used }));
    return el;
  }

  function boxes(pr, compact) {
    const c = pr.checks;
    const checkTitle = `${c.passed} passed, ${c.failed} failed, ${c.running} running, ${c.pending} pending, ${c.skipped} skipped`;
    const t = pr.threads;
    const a = pr.approvals;
    const box = (label, value, barEl, title) =>
      h('div', { class: 'box', title }, compact ? null : h('div', { class: 'box-head' }, h('span', null, label), h('span', { class: 'val' }, value)), barEl);
    return h('div', { class: 'boxes' + (compact ? ' compact' : '') },
      box('Checks', c.total ? `${c.passed + c.skipped}/${c.total}` : '—',
        bar([{ n: c.passed + c.skipped, cls: 'ok' }, { n: c.failed, cls: 'bad' }, { n: c.running, cls: 'run' }], c.total), checkTitle),
      box('Comments', t.total ? `${t.resolved}/${t.total}` : '—',
        // unresolved threads get their own yellow segment, like running checks, instead of falling into the gray rest
        bar([{ n: t.resolved, cls: 'ok' }, { n: t.total - t.resolved, cls: 'run' }], t.total),
        t.total ? `${t.resolved} of ${t.total} review comments resolved, ${t.total - t.resolved} open` : 'No review comments'),
      box('Approvals', `${a.approved}/${a.required}`,
        bar([{ n: Math.min(a.approved, Math.max(a.required, 1)), cls: 'ok' }, { n: a.changesRequested, cls: 'bad' }], Math.max(a.required, a.approved + a.changesRequested, 1)),
        `${a.approved} approval(s) of ${a.required} required${a.changesRequested ? `, ${a.changesRequested} requested changes` : ''}`));
  }

  /** Small copy icon: the extension copies the URL from its own data; shows ✓ briefly. */
  function copyIcon(pr, which, label) {
    const btn = h('button', {
      class: 'copy-icon', title: `Copy ${label}`, 'aria-label': `Copy ${label}`,
      onclick: (e) => {
        e.preventDefault(); e.stopPropagation();
        send({ type: 'copyUrl', prId: pr.id, which });
        btn.textContent = '✓'; btn.classList.add('done');
        setTimeout(() => { btn.textContent = '⧉'; btn.classList.remove('done'); }, 1500);
      },
    }, '⧉');
    return btn;
  }

  function cardEl(pr) {
    const st = STATUS[pr.status];
    const repoName = pr.repo.split('/')[1];
    const ticket = pr.ticket
      ? h('a', { class: 'ticket', href: '#', title: pr.ticketUrl ? `Open ${pr.ticket} in Jira` : 'Set up the Jira link',
          onclick: (e) => {
            e.preventDefault(); e.stopPropagation();
            if (pr.ticketUrl) open(pr.ticketUrl);
            else send({ type: 'configureJira', ticket: pr.ticket });
          } },
          pr.ticket, ' ↗')
      : h('span', { class: 'ticket none' }, `#${pr.number}`);

    if (data.compact) {
      return h('div', { class: `card compact ${st.cls}`, title: `${pr.repo}#${pr.number}: ${pr.title}`, onclick: () => open(pr.url) },
        h('span', { class: 'dot' }, st.icon), ticket, h('span', { class: 'title' }, pr.title), boxes(pr, true), prMenu(pr));
    }

    const problems = pr.checks.items.filter((i) => i.state === 'failed' || i.state === 'running' || i.state === 'pending');
    const a = pr.approvals;
    const missing = Math.max(a.required - a.approved, 0);
    const approvalLabel = [
      missing ? `${missing} approval(s) missing` : '',
      a.changesRequested ? `${a.changesRequested} requested changes` : '',
    ].filter(Boolean).join(', ')
      // nothing missing: still list who approved, so the section is there to check
      || (a.items.length ? `${a.approved} approval(s)` : '');
    return h('div', { class: `card ${st.cls}` },
      h('div', { class: 'card-top' },
        h('span', { class: 'dot', title: st.label }, st.icon), ticket,
        pr.ticketUrl ? copyIcon(pr, 'ticket', `${pr.ticket} link`) : null,
        h('span', { class: 'repo', title: pr.repo }, repoName),
        prMenu(pr)),
      h('div', { class: 'pr-row' },
        h('a', { class: 'pr-link', href: '#', title: pr.url, onclick: (e) => { e.preventDefault(); open(pr.url); } },
          `#${pr.number} ${pr.title}`, ' ↗'),
        copyIcon(pr, 'pr', 'PR link')),
      h('div', { class: 'url muted' }, pr.url.replace(/^https?:\/\//, '')),
      boxes(pr, false),
      pr.mergeable === 'CONFLICTING' ? h('div', { class: 'warn' }, '⚠ Merge conflicts') : null,
      section(pr, 'checks', problems.length ? `${problems.length} check(s) not passing` : '', problems, (c) =>
        h('li', { class: `ck ${c.state}` },
          h('span', null, c.state === 'failed' ? '✖' : c.state === 'running' ? '◌' : '○'),
          link(c.name, c.url))),
      section(pr, 'comments', pr.threads.items.length ? `${pr.threads.items.length} comment(s) unresolved` : '', pr.threads.items, (t) =>
        h('li', { class: 'ck running', title: t.snippet },
          h('span', null, '●'),
          h('span', { class: 'ck-text' },
            link(t.author, t.url),
            t.where ? h('span', { class: 'muted' }, ` · ${t.where}`) : null,
            t.outdated ? h('span', { class: 'muted' }, ' · outdated') : null,
            t.snippet ? h('span', { class: 'snippet' }, ` — ${t.snippet}`) : null))),
      section(pr, 'approvals', approvalLabel, a.items, (r) =>
        h('li', { class: `ck ${r.state === 'changes' ? 'failed' : r.state === 'requested' ? 'pending' : 'passed'}` },
          h('span', null, r.state === 'changes' ? '✖' : r.state === 'requested' ? '○' : '✔'),
          h('span', { class: 'ck-text' },
            link(r.name, r.url),
            h('span', { class: 'muted' }, r.state === 'changes' ? ' · requested changes' : r.state === 'requested' ? ' · review requested' : ' · approved')))),
      pr.author !== data.viewerLogin ? h('div', { class: 'muted small' }, `by ${pr.author}`) : null,
    );
  }

  /** Text that opens url (https only, checked again by the extension); plain text when there is no url. */
  function link(text, url) {
    return url ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); open(url); } }, text) : h('span', null, text);
  }

  /**
   * A collapsible list under the card: "▸ <label>", and the items when expanded.
   * Each section of each PR opens on its own. Nothing is drawn when label is empty.
   */
  function section(pr, kind, label, items, renderItem) {
    if (!label) return null;
    const key = `${pr.id}:${kind}`;
    const isOpen = expanded.has(key);
    return h('div', { class: `section ${kind}` },
      h('div', { class: 'checks-toggle', onclick: () => { isOpen ? expanded.delete(key) : expanded.add(key); renderList(); } },
        `${isOpen ? '▾' : '▸'} ${label}`),
      isOpen && items.length ? h('ul', { class: 'checks' }, ...items.map(renderItem)) : null);
  }

  /** ⚙ button + per-PR options menu. Add future per-PR options here. */
  function prMenu(pr) {
    const isOpen = openMenuId === pr.id;
    const failed = pr.checks.failed;
    // Each button has its own rule: "failed" needs a failed Actions run, "all" only needs any Actions run.
    // A failing non-Actions check (e.g. AWS CodeBuild) must not disable "all", which is how it gets re-triggered.
    const failedReason = pr.rerun.failedRunIds.length > 0
      ? undefined
      : failed === 0
        ? 'No failed checks to re-run'
        : 'The failing checks are not GitHub Actions workflows yet; use Re-run all checks';
    const allReason = pr.rerun.allRunIds.length > 0 ? undefined : 'No GitHub Actions workflows behind these checks';
    const reason = (failed > 0 && failedReason) || allReason;
    const item = (label, mode, title, why) => h('button', {
      class: 'pr-menu-item',
      disabled: why !== undefined,
      title: why || title,
      onclick: (e) => {
        e.stopPropagation();
        openMenuId = null;
        renderList();
        send({ type: 'rerun', prId: pr.id, mode });
      },
    }, label);

    return h('span', { class: 'pr-menu-wrap', onclick: (e) => e.stopPropagation() },
      h('button', {
        class: 'gear' + (isOpen ? ' open' : ''),
        title: 'PR options',
        'aria-haspopup': 'menu',
        'aria-expanded': isOpen ? 'true' : 'false',
        onclick: (e) => { e.stopPropagation(); openMenuId = isOpen ? null : pr.id; renderList(); },
      }, '⚙'),
      isOpen
        ? h('div', { class: 'pr-menu', role: 'menu' },
            item(`↻ Re-run failed checks${failed ? ` (${failed})` : ''}`, 'failed', 'Re-run only the failed jobs', failedReason),
            item('↻ Re-run all checks', 'all', 'Re-run every job in the workflow runs for this PR', allReason),
            reason ? h('div', { class: 'pr-menu-note' }, reason) : null)
        : null);
  }

  function attentionSort(a, b) {
    return STATUS[a.status].order - STATUS[b.status].order || b.updatedAt.localeCompare(a.updatedAt);
  }

  function renderList() {
    if (data.needsSignIn) {
      list.replaceChildren(h('div', { class: 'empty-state' },
        h('p', null, 'Sign in to GitHub to see your pull requests.'),
        h('button', { class: 'primary', onclick: () => send({ type: 'signIn' }) }, 'Sign in to GitHub')));
      displayedPrs = [];
      renderShare();
      return;
    }
    const nodes = [];
    if (data.error) nodes.push(h('div', { class: 'error' }, `⚠ ${data.error}`, ' ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); send({ type: 'refresh' }); } }, 'Retry')));
    const prs = [...data.prs];
    if (!prs.length && !data.loading && !data.error) nodes.push(h('div', { class: 'empty-state muted' }, 'No open pull requests match these filters.'));

    const ordered = [];
    const card = (p) => { ordered.push(p); return cardEl(p); };
    const groups = new Map();
    if (data.groupByRepo) {
      prs.sort(attentionSort);
      for (const p of prs) { if (!groups.has(p.repo)) groups.set(p.repo, []); groups.get(p.repo).push(p); }
      for (const k of [...groups.keys()].sort()) {
        nodes.push(h('div', { class: 'group' }, `${k} (${groups.get(k).length})`), ...groups.get(k).map(card));
      }
    } else if (data.ui.sort === 'attention') {
      prs.sort(attentionSort);
      for (const p of prs) { if (!groups.has(p.status)) groups.set(p.status, []); groups.get(p.status).push(p); }
      for (const [st, items] of groups) {
        nodes.push(h('div', { class: `group ${STATUS[st].cls}` }, `${STATUS[st].icon} ${STATUS[st].label.toUpperCase()} (${items.length})`), ...items.map(card));
      }
    } else {
      prs.sort(data.ui.sort === 'updated'
        ? (a, b) => b.updatedAt.localeCompare(a.updatedAt)
        : (a, b) => (a.ticket || '~').localeCompare(b.ticket || '~', undefined, { numeric: true }));
      nodes.push(...prs.map(card));
    }
    list.replaceChildren(...nodes);
    displayedPrs = ordered;
    renderShare();
  }

  function renderShare() {
    const todo = displayedPrs.filter(needsApproval);
    const skipped = displayedPrs.length - todo.length;
    copyBtn.textContent = `⧉ Copy PR links (${todo.length})`;
    copyBtn.disabled = todo.length === 0;
    copyBtn.title = todo.length
      ? `Copy the links of the ${todo.length} PR(s) still waiting for approval` +
        (skipped ? ` (${skipped} already approved or in the merge queue are skipped)` : '')
      : 'No PRs waiting for approval in this list';
    descChk.checked = !!data.ui.addDescription;
  }

  window.addEventListener('message', (e) => {
    if (e.data?.type !== 'update') return;
    data = e.data.payload;
    renderControls();
    renderSummary();
    renderList();
    renderFooter();
  });
  setInterval(() => { if (data) renderSummary(); }, 1000);
  send({ type: 'ready' });
})();
