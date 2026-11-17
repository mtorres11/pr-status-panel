// @ts-check
// The panel page: tabs, the PR tab's controls, list and "Copy links", and the footer. Loaded last.
(function () {
  /** @typedef {import('../src/protocol').Payload} Payload */
  /** @typedef {import('../src/model').PrView} PrView */
  /** @typedef {import('../src/copy').CopyGroup} CopyGroup */

  /** @type {any} */
  const ns = (/** @type {any} */ (window)).PrStatus;
  const { h, setOptions, row, signInState, ago } = ns.dom;
  const { send, setState, open, onUpdate } = ns.bridge;
  const { STATUS } = ns.prCard;

  /** @type {Payload} */
  let data;
  let repoMenuOpen = false;
  let repoSearch = '';
  let copyMenuOpen = false;
  /** PRs in the order they are shown in the list (set by renderList). @type {PrView[]} */
  let displayedPrs = [];

  const cards = ns.prCard.create({ rerender: () => renderList(), viewer: () => data.viewerLogin, compact: () => data.compact });
  const deploy = ns.deploy.create();
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));

  // ---------- Copy links: which PRs (group, membership comes with each PR) and how (format) ----------
  /** [id, icon, menu label, button text for n PRs] @type {[CopyGroup, string, string, (n: number) => string][]} */
  const COPY_GROUPS = [
    ['approval', '⏳', 'Needing approval', (n) => `${n} needing approval`],
    ['waiting', '◐', 'Waiting on review', (n) => `${n} waiting on review`],
    ['ready', '✅', 'Ready to merge', (n) => `${n} ready to merge`],
    ['failing', '✖', 'Failing checks', (n) => `${n} failing`],
    ['changes', '✎', 'Changes requested', (n) => `${n} with changes requested`],
    ['running', '◌', 'Checks running', (n) => `${n} running`],
    ['drafts', '○', 'Drafts', (n) => `${n} draft${n === 1 ? '' : 's'}`],
    ['behind', '⤓', 'Behind base branch', (n) => `${n} behind`],
    ['queued', '⇢', 'In merge queue', (n) => `${n} in queue`],
    ['all', '☰', 'All shown', (n) => `all ${n}`],
  ];
  const copyGroupOf = (id) => COPY_GROUPS.find((g) => g[0] === id) || COPY_GROUPS[0];
  /** Shown PRs in a copy group, in list order. @param {CopyGroup} id */
  const inGroup = (id) => displayedPrs.filter((p) => p.copyGroups.includes(id));

  /** @param {CopyGroup} id */
  function copyGroupLinks(id) {
    const ids = inGroup(id).map((p) => p.id);
    if (id !== data.ui.copyGroup) setState({ copyGroup: id });
    if (ids.length) send({ type: 'copyLinks', ids, group: id, format: data.ui.copyFormat });
  }

  // ---------- static skeleton ----------
  const accountSel = h('select', { title: 'Signed-in GitHub account', onchange: (e) => {
    const v = e.target.value;
    if (v === '__add') { send({ type: 'addAccount' }); renderControls(); return; }
    setState({ accountKey: v });
  } });
  const authorSel = h('select', { title: 'Whose pull requests', onchange: (e) => setState({ author: e.target.value }) });
  const showSel = h('select', { title: 'Which relationship to the PR', onchange: (e) => setState({ show: e.target.value }) });
  const sortSel = h('select', { title: 'Sort order', onchange: (e) => setState({ sort: e.target.value }) });
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
  function closeRepoMenu() { repoMenuOpen = false; repoMenu.hidden = true; }

  const copyBtn = h('button', { class: 'secondary copy-btn', onclick: () => copyGroupLinks(copyGroupOf(data.ui.copyGroup)[0]) });
  const copyCaret = h('button', {
    class: 'secondary copy-caret', title: 'Choose which PRs to copy', 'aria-haspopup': 'menu',
    onclick: (e) => { e.stopPropagation(); copyMenuOpen = !copyMenuOpen; renderShare(); },
  }, '▾');
  const copyMenu = h('div', { class: 'pr-menu copy-menu', role: 'menu' });
  const copySplit = h('span', { class: 'copy-split' }, copyBtn, copyCaret, copyMenu);
  const fmtSel = h('select', { class: 'copy-format', title: 'How the copied text looks', onchange: (e) => setState({ copyFormat: e.target.value }) });

  document.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (repoMenuOpen && !repoCombo.contains(target)) closeRepoMenu();
    if (!target.closest('.pr-menu-wrap')) cards.closeMenu();
    if (copyMenuOpen && !copySplit.contains(target)) { copyMenuOpen = false; renderShare(); }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cards.closeMenu(); });

  const controls = h('div', { class: 'controls' },
    row('Account', accountSel),
    row('Author', authorSel),
    row('Repo', repoCombo),
    row('Show', showSel, h('label', { class: 'chk', for: 'drafts' }, draftsChk, 'Drafts'), sortSel),
    row('Share', copySplit),
    row('Format', fmtSel));
  const summary = h('div', { class: 'summary' });
  const list = h('div', { class: 'list' });
  const footer = h('div', { class: 'footer muted' });
  const prsPane = h('div', { class: 'pane' }, controls, summary, list);
  const tabBtn = (id, label) => h('button', { class: 'tab', role: 'tab', 'data-tab': id, onclick: () => { if (data && data.ui.tab !== id) setState({ tab: id }); } }, label);
  const tabs = h('div', { class: 'tabs', role: 'tablist' }, tabBtn('prs', 'Pull Requests'), tabBtn('deploy', 'Deployments'));
  app.append(tabs, prsPane, deploy.el, footer);

  /** Shows the active tab and returns it. */
  function renderTabs() {
    const active = data.ui.tab === 'deploy' ? 'deploy' : 'prs';
    for (const b of Array.from(tabs.children)) {
      const on = b.getAttribute('data-tab') === active;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    }
    prsPane.hidden = active !== 'prs';
    deploy.el.hidden = active !== 'deploy';
    return active;
  }

  function renderFooter() {
    const a = data.about;
    if (!a.author) { footer.replaceChildren(); return; }
    footer.replaceChildren(
      'Created by ', a.author,
      a.repoUrl ? ' · ' : '',
      a.repoUrl ? ns.dom.link('GitHub', a.repoUrl, undefined, a.repoUrl) : '',
      a.version ? ` · v${a.version}` : '');
  }

  // ---------- controls ----------
  function authorOptions() {
    const opts = [['@me', data.viewerLogin ? `Me (${data.viewerLogin})` : 'Me']];
    if (data.team.length) opts.push(['@team', `Whole team (${data.team.length})`]);
    for (const m of data.team) opts.push([m, m]);
    if (!opts.some(([v]) => v === data.ui.author)) opts.push([data.ui.author, data.ui.author]);
    opts.push(['@other', 'Other user…']);
    return opts;
  }

  function renderControls() {
    const ui = data.ui;
    const accts = data.accounts.map((a) => [a.key, a.label]);
    setOptions(accountSel, [...(accts.length ? accts : [['', 'Not signed in']]), ['__add', '＋ Add another account…']], ui.accountKey || '');
    setOptions(authorSel, authorOptions(), ui.author);
    setOptions(showSel, data.options.show, ui.show);
    setOptions(sortSel, data.options.sort, ui.sort);
    draftsChk.checked = ui.drafts;
    repoBtn.textContent = (ui.repo === '*' ? `All repos (${data.repos.length})` : ui.repo) + '  ▾';
    if (repoMenuOpen) renderRepoOptions();
  }

  /** @param {string} value */
  function pickRepo(value) { closeRepoMenu(); setState({ repo: value }); }

  /** @param {string} repo @param {boolean} fav */
  function repoItem(repo, fav) {
    return h('div', { class: 'combo-item' + (data.ui.repo === repo ? ' selected' : ''), onclick: () => pickRepo(repo) },
      h('button', {
        class: 'star' + (fav ? ' on' : ''),
        title: fav ? 'Remove from Favorites' : 'Add to Favorites',
        'aria-pressed': fav ? 'true' : 'false',
        // Stays open so several repos can be starred in a row.
        onclick: (e) => { e.stopPropagation(); send({ type: 'toggleFavorite', repo }); },
      }, fav ? '★' : '☆'),
      h('span', { class: 'combo-text' }, repo));
  }

  function renderRepoOptions() {
    const q = repoSearch.trim().toLowerCase();
    const favs = new Set(data.favorites);
    const match = (r) => !q || r.toLowerCase().includes(q);
    const favList = data.favorites.filter(match);
    const others = data.repos.filter((r) => !favs.has(r) && match(r));
    const children = [
      h('div', { class: 'combo-item' + (data.ui.repo === '*' ? ' selected' : ''), onclick: () => pickRepo('*') },
        h('span', { class: 'star-spacer' }), h('span', { class: 'combo-text' }, `All repos (${data.repos.length})`)),
    ];
    if (favList.length) children.push(h('div', { class: 'combo-sep' }, 'Favorites'), ...favList.map((r) => repoItem(r, true)));
    if (others.length) children.push(h('div', { class: 'combo-sep' }, 'All repositories'), ...others.map((r) => repoItem(r, false)));
    if (!favList.length && !others.length && q) children.push(h('div', { class: 'combo-empty' }, 'No matching repos'));
    repoList.replaceChildren(...children);
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

  // ---------- list ----------
  /** @param {PrView} a @param {PrView} b */
  const attention = (a, b) => STATUS[a.status].order - STATUS[b.status].order || b.updatedAt.localeCompare(a.updatedAt);
  const SORTS = {
    attention,
    updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
    ticket: (a, b) => (a.ticket || '~').localeCompare(b.ticket || '~', undefined, { numeric: true }),
  };

  /** @param {PrView[]} prs @param {(p: PrView) => string} keyOf */
  function groupBy(prs, keyOf) {
    const groups = new Map();
    for (const p of prs) groups.set(keyOf(p), [...(groups.get(keyOf(p)) || []), p]);
    return groups;
  }

  /** The PRs as titled groups: by repository, by status (Needs attention), or one untitled group. */
  function sections() {
    if (data.groupByRepo) {
      const groups = groupBy([...data.prs].sort(attention), (p) => p.repo);
      return [...groups.keys()].sort().map((k) => ({ head: h('div', { class: 'group' }, `${k} (${groups.get(k).length})`), prs: groups.get(k) }));
    }
    const sorted = [...data.prs].sort(SORTS[data.ui.sort] || attention);
    if (data.ui.sort !== 'attention') return [{ head: null, prs: sorted }];
    return [...groupBy(sorted, (p) => p.status)].map(([st, prs]) => ({
      head: h('div', { class: `group ${STATUS[st].cls}` }, `${STATUS[st].icon} ${STATUS[st].label.toUpperCase()} (${prs.length})`),
      prs,
    }));
  }

  function notices() {
    const out = [];
    const retry = h('a', { href: '#', onclick: (e) => { e.preventDefault(); send({ type: 'refresh' }); } }, 'Retry');
    if (data.error) out.push(h('div', { class: 'error' }, `⚠ ${data.error}`, ' ', retry));
    if (!data.prs.length && !data.loading && !data.error) out.push(h('div', { class: 'empty-state muted' }, 'No open pull requests match these filters.'));
    return out;
  }

  function renderList() {
    if (data.needsSignIn) {
      list.replaceChildren(signInState());
      displayedPrs = [];
      renderShare();
      return;
    }
    const groups = sections();
    list.replaceChildren(...notices(), ...groups.flatMap((g) => [g.head, ...g.prs.map(cards.card)]).filter(Boolean));
    displayedPrs = groups.flatMap((g) => g.prs);
    renderShare();
  }

  // ---------- share ----------
  /** One "Copy links" menu entry. @param {typeof COPY_GROUPS[number]} group */
  function copyItem(group) {
    const [gid, icon, glabel] = group;
    const n = inGroup(gid).length;
    const item = h('button', {
      class: 'pr-menu-item copy-item' + (gid === data.ui.copyGroup ? ' current' : ''),
      disabled: n === 0,
      title: n ? `Copy ${n} PR link(s)` : 'None in this list',
      onclick: (e) => { e.stopPropagation(); copyMenuOpen = false; renderShare(); copyGroupLinks(gid); },
    }, h('span', null, `${icon} ${glabel}`), h('span', { class: 'copy-count' }, String(n)));
    return gid === 'all' ? [h('div', { class: 'pr-menu-sep' }), item] : [item];
  }

  function renderShare() {
    const [id, , label, btnText] = copyGroupOf(data.ui.copyGroup);
    const count = inGroup(id).length;
    copyBtn.textContent = `⧉ Copy ${btnText(count)}`;
    copyBtn.disabled = count === 0;
    copyBtn.title = count ? `Copy the links of ${btnText(count)} (${label.toLowerCase()})` : `No PRs in "${label}" in this list`;
    copyCaret.setAttribute('aria-expanded', String(copyMenuOpen));
    copyMenu.hidden = !copyMenuOpen;
    if (copyMenuOpen) copyMenu.replaceChildren(...COPY_GROUPS.flatMap(copyItem));
    setOptions(fmtSel, data.options.copyFormats, data.ui.copyFormat);
  }

  onUpdate((payload) => {
    data = payload;
    if (renderTabs() === 'deploy') deploy.render(data);
    else { renderControls(); renderSummary(); renderList(); }
    renderFooter();
  });
  setInterval(() => { if (!data) return; if (data.ui.tab === 'deploy') deploy.tick(); else renderSummary(); }, 1000);
  send({ type: 'ready' });
})();
