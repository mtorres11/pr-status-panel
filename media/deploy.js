// @ts-check
// Deployments tab: where each PR is now. Open (local) → in the chosen branch → each CodePipeline stage,
// with the date it got there and who approved it. Loaded before main.js, which creates it.
(function () {
  const WHEN = [[7, '7 days'], [14, '14 days'], [30, '30 days'], [90, '90 days'], [180, '6 months'], [365, '1 year']];
  const STATES = [['all', 'Open + merged'], ['open', 'Open only'], ['merged', 'Merged only']];
  /** Location → dot icon, CSS class, label. */
  const WHERE = {
    open: ['◐', 'st-running', 'Open (not merged)'],
    reverted: ['⚠', 'st-failing', 'Reverted'],
    missing: ['✖', 'st-failing', 'Merged, not in branch'],
    merged: ['●', 'st-waiting', 'Merged'],
    partial: ['↗', 'st-waiting', 'On the way'],
    done: ['✔', 'st-ready', 'In the last stage'],
  };

  /** Helpers from main.js. @type {any} */
  let d = null;
  /** @type {any} */
  let data = null;
  /** @type {any} */
  let ui = null;
  const expanded = new Set();

  const dep = () => data.deploy;
  /** "Production-Deployment" → "Production" */
  const short = (name) => name.replace(/[-_ ]?deploy(ment)?$/i, '') || name;
  const u = () => data.ui;
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');
  const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

  // ---------- model helpers ----------
  /** Stage names in pipeline order, across all of a PR's pipelines. */
  function stageNames(pr) {
    const names = [];
    for (const t of pr.tracks) for (const s of t.stages) if (!names.includes(s.name)) names.push(s.name);
    return names;
  }

  /** Per stage: how many pipelines have it there, and the earliest arrival. */
  function stageSummary(pr, name) {
    const cells = pr.tracks.map((t) => t.stages.find((s) => s.name === name)).filter(Boolean);
    const done = cells.filter((c) => c.state === 'deployed').sort((a, b) => a.firstAt.localeCompare(b.firstAt));
    const unknown = cells.every((c) => c.state === 'unknown');
    return { name, total: cells.length, deployed: done.length, first: done[0], unknown };
  }

  function whereOf(pr) {
    if (pr.state === 'OPEN') return 'open';
    if (pr.revert) return 'reverted';
    if (pr.inBranch === false) return 'missing';
    const names = stageNames(pr);
    if (!names.length) return 'merged';
    const last = stageSummary(pr, names[names.length - 1]);
    if (last.deployed && last.deployed === last.total) return 'done';
    return names.some((n) => stageSummary(pr, n).deployed) ? 'partial' : 'merged';
  }

  /** Every stage name seen in the list, for the Where filter. */
  function allStages() {
    const names = [];
    for (const pr of dep().prs) for (const n of stageNames(pr)) if (!names.includes(n)) names.push(n);
    return names;
  }

  const FILTERS = {
    '': () => true,
    open: (pr) => pr.state === 'OPEN',
    inBranch: (pr) => pr.state === 'MERGED' && pr.inBranch !== false && !pr.revert,
    notInBranch: (pr) => pr.state === 'MERGED' && (pr.inBranch === false || !!pr.revert),
    reverted: (pr) => !!pr.revert,
  };

  function matches(pr, f) {
    if (FILTERS[f]) return FILTERS[f](pr);
    const [kind, name] = f.split(':');
    if (pr.state !== 'MERGED') return false;
    const s = stageSummary(pr, name);
    return kind === 'in' ? s.deployed > 0 : s.total > 0 && s.deployed < s.total;
  }

  // ---------- controls ----------
  /**
   * @param {{ h: Function, send: Function, setState: Function, open: Function, ago: Function }} deps
   */
  function create(deps) {
    d = deps;
    const h = d.h;
    const sel = (title, key, numeric) => h('select', { title, onchange: (e) => d.setState({ [key]: numeric ? Number(e.target.value) : e.target.value }) });
    const whoSel = sel('Whose PRs', 'deployWho');
    const whenSel = sel('Open PRs updated, or PRs merged, in this window', 'deployWhen', true);
    const repoSel = sel('Repository', 'deployRepo');
    const stateSel = sel('Which PRs', 'deployState');
    const whereSel = sel('Where the PR is now', 'deployStage');
    const branchIn = h('input', { class: 'combo-search mini-input', title: 'Branch to check whether the change is in it', onkeydown: (e) => { if (e.key === 'Enter') d.setState({ deployBranch: e.target.value.trim() || 'main' }); }, onblur: (e) => { const v = e.target.value.trim() || 'main'; if (v !== u().deployBranch) d.setState({ deployBranch: v }); } });
    const findIn = h('input', { class: 'combo-search', placeholder: 'PR #, PR link, ticket key or title words', onkeydown: (e) => { if (e.key === 'Enter') d.setState({ deployFind: e.target.value.trim() }); } });
    const clearBtn = h('button', { class: 'secondary', title: 'Clear', onclick: () => { findIn.value = ''; d.setState({ deployFind: '' }); } }, '✕');
    const row = (label, ...c) => h('div', { class: 'row' }, h('span', { class: 'row-label' }, label), h('div', { class: 'inline' }, ...c));
    const aws = h('div', { class: 'aws-bar' });
    const summary = h('div', { class: 'summary' });
    const list = h('div', { class: 'list' });
    const controls = h('div', { class: 'controls' },
      row('Who', whoSel, whenSel), row('Repo', repoSel), row('Show', stateSel, h('span', { class: 'muted small-label' }, 'in'), branchIn),
      row('Find', findIn, clearBtn), row('Where', whereSel));
    ui = { whoSel, whenSel, repoSel, stateSel, whereSel, branchIn, findIn, aws, summary, list };
    return { el: h('div', { class: 'pane' }, controls, aws, summary, list), render, tick: () => { if (data) renderSummary(); } };
  }

  function setOptions(selEl, options, value) {
    selEl.replaceChildren(...options.map(([v, label]) => d.h('option', { value: String(v) }, label)));
    selEl.value = String(value);
  }

  function renderControls() {
    const who = [['@me', data.viewerLogin ? `Mine (${data.viewerLogin})` : 'Mine']];
    if (data.team.length) who.push(['@team', `My team (${data.team.length})`]);
    who.push(['@anyone', 'Anyone'], ...data.team.map((m) => [m, m]));
    if (!who.some(([v]) => v === u().deployWho)) who.push([u().deployWho, u().deployWho]);
    setOptions(ui.whoSel, who, u().deployWho);
    setOptions(ui.whenSel, WHEN.map(([v, l]) => [v, `Last ${l}`]), u().deployWhen);
    const repos = [...new Set([...data.favorites, ...data.repos])];
    setOptions(ui.repoSel, [['*', 'All repos'], ...repos.map((r) => [r, `${data.favorites.includes(r) ? '★ ' : ''}${r}`])], u().deployRepo);
    setOptions(ui.stateSel, STATES, u().deployState);
    renderWhere();
    if (document.activeElement !== ui.branchIn) ui.branchIn.value = u().deployBranch;
    if (document.activeElement !== ui.findIn) ui.findIn.value = u().deployFind;
  }

  function renderWhere() {
    const b = u().deployBranch;
    const opts = [['', 'Anywhere'], ['open', 'Open (not merged)'], ['inBranch', `Merged · in ${b}`], ['notInBranch', `Merged · NOT in ${b}`], ['reverted', 'Reverted']];
    for (const n of allStages()) opts.push([`in:${n}`, `In ${short(n)}`], [`notin:${n}`, `Not in ${short(n)} yet`]);
    if (!opts.some(([v]) => v === u().deployStage)) opts.push([u().deployStage, u().deployStage]);
    setOptions(ui.whereSel, opts, u().deployStage);
  }

  // ---------- AWS status ----------
  function renderAws() {
    const h = d.h;
    const a = dep().aws || { state: 'ok' };
    const profileBtn = h('button', { class: 'act', onclick: () => d.send({ type: 'awsProfile' }) }, dep().profile ? `Profile: ${dep().profile}` : 'Choose AWS profile');
    const signInBtn = h('button', { class: 'act', onclick: () => d.send({ type: 'awsSignIn' }) }, dep().canSignIn ? 'Sign in to AWS' : 'Set AWS sign-in command');
    const msg = {
      ok: null,
      off: 'Pipeline stages are off (PR Status › Aws: Enabled).',
      signin: 'Pipeline stages need an AWS sign-in.',
      nocli: a.message,
      error: a.message,
    }[a.state];
    ui.aws.className = 'aws-bar' + (msg ? ' warn-bar' : '');
    ui.aws.replaceChildren(
      msg ? h('div', { class: 'aws-msg', title: a.message || '' }, `⚠ ${msg}`) : h('span', { class: 'muted' }, 'Stages from AWS CodePipeline'),
      h('div', { class: 'actions' }, a.state === 'signin' || a.state === 'error' ? signInBtn : null, profileBtn));
  }

  // ---------- summary ----------
  function renderSummary() {
    const prs = dep().prs;
    const count = (k) => prs.filter((p) => whereOf(p) === k).length;
    const parts = Object.keys(WHERE).filter((k) => count(k)).map((k) => d.h('span', { class: `chip ${WHERE[k][1]}`, title: WHERE[k][2] }, `${WHERE[k][0]} ${count(k)} ${WHERE[k][2].toLowerCase()}`));
    ui.summary.replaceChildren(
      d.h('span', null, `${prs.length} PR${prs.length === 1 ? '' : 's'}`), ...parts,
      d.h('span', { class: 'muted' }, dep().loading ? ' · refreshing…' : ` · updated ${d.ago(dep().updatedAt)}`));
  }

  // ---------- list ----------
  function renderList() {
    const h = d.h;
    if (data.needsSignIn) {
      ui.list.replaceChildren(h('div', { class: 'empty-state' }, h('p', null, 'Sign in to GitHub to see your pull requests.'),
        h('button', { class: 'primary', onclick: () => d.send({ type: 'signIn' }) }, 'Sign in to GitHub')));
      return;
    }
    const out = [];
    if (dep().error) out.push(h('div', { class: 'error' }, `⚠ ${dep().error}`));
    if (dep().hint) out.push(h('div', { class: 'hint muted' }, dep().hint));
    const prs = dep().prs.filter((p) => matches(p, u().deployStage));
    if (!prs.length && !dep().loading && !dep().error && !dep().hint) out.push(h('div', { class: 'empty-state muted' }, 'No pull requests match these filters.'));
    ui.list.replaceChildren(...out, ...prs.map(cardEl));
  }

  function link(text, url, cls) {
    return d.h('a', { class: cls, href: '#', title: url, onclick: (e) => { e.preventDefault(); e.stopPropagation(); d.open(url); } }, text);
  }

  function metaLine(pr) {
    const by = `by ${pr.author}`;
    return `${by}${pr.isDraft ? ' · draft' : ''}`;
  }

  function cardEl(pr) {
    const h = d.h;
    const [icon, cls, label] = WHERE[whereOf(pr)];
    return h('div', { class: `card ${cls}` },
      h('div', { class: 'card-top' },
        h('span', { class: 'dot', title: label }, icon),
        pr.ticket ? (pr.ticketUrl ? link(`${pr.ticket} ↗`, pr.ticketUrl, 'ticket') : h('span', { class: 'ticket' }, pr.ticket)) : h('span', { class: 'ticket none' }, 'no ticket'),
        h('span', { class: 'repo', title: pr.repo }, pr.repo.split('/')[1])),
      link(`#${pr.number} ${pr.title} ↗`, pr.url, 'pr-link'),
      h('div', { class: 'muted small' }, metaLine(pr)),
      track(pr),
      pr.revert ? h('div', { class: 'warn', title: `${pr.revert.message}\n${when(pr.revert.date)}` }, `⚠ Reverted in ${u().deployBranch} by `, link(pr.revert.sha.slice(0, 7), `${pr.url.replace(/\/pull\/\d+$/, '')}/commit/${pr.revert.sha}`)) : null,
      pipelines(pr));
  }

  const DEFAULT_STEPS = ['Development', 'Staging', 'Production'];

  /** One step: [✔] Local in green when reached, [ ] in mustard when not, ✖ in red when something went wrong. */
  function step(label, state, title) {
    const box = { done: '✔', todo: '', partial: '◐', bad: '✖' }[state];
    return d.h('span', { class: `step ${state}`, title }, d.h('span', { class: 'box' }, box), label);
  }

  /** Local → Merged → Development → Staging → Production; dates and approvers only in the tooltips. */
  function track(pr) {
    const h = d.h;
    const arrow = () => h('span', { class: 'arrow' }, '→');
    const stages = allStages();
    const names = stages.length ? stages : DEFAULT_STEPS;
    const parts = [localStep(pr), arrow(), mergedStep(pr)];
    for (const n of names) parts.push(arrow(), stageStep(pr, n));
    return h('div', { class: 'steps' }, ...parts);
  }

  function localStep(pr) {
    const draft = pr.isDraft ? ' (draft)' : '';
    return step('Local', 'done', `Opened ${when(pr.createdAt)} by ${pr.author}${draft}`);
  }

  function mergedStep(pr) {
    const b = u().deployBranch;
    if (pr.state === 'OPEN') return step('Merged', 'todo', pr.inBranch ? `Not merged, but its commits are already in ${b}` : `Not merged into ${b} yet`);
    const merged = `Merged ${when(pr.mergedAt)}${pr.mergedBy ? ` by ${pr.mergedBy}` : ''}`;
    if (pr.revert) return step('Merged', 'bad', `${merged}\nReverted in ${b} on ${when(pr.revert.date)}`);
    if (pr.inBranch === false) return step('Merged', 'bad', `${merged}\nThe change is NOT in ${b}`);
    return step('Merged', 'done', `${merged}${pr.inBranch ? `\nIn ${b}` : ''}`);
  }

  function stageStep(pr, name) {
    const label = short(name);
    if (pr.state !== 'MERGED') return step(label, 'todo', `Not merged yet`);
    const s = stageSummary(pr, name);
    if (!s.total) return step(label, 'todo', pr.pipelineCount ? `Not deployed to ${label} yet (no pipeline has built it)` : 'No pipeline data');
    const count = s.total > 1 ? `\n${s.deployed} of ${s.total} pipelines` : '';
    if (!s.deployed) return step(label, 'todo', `Not in ${label} yet${count}`);
    const approver = s.first.by ? `\nApproved by ${s.first.by}` : '';
    const title = `In ${label} since ${s.first.orEarlier ? 'on or before ' : ''}${when(s.first.firstAt)}${approver}${count}`;
    return step(label, s.deployed === s.total ? 'done' : 'partial', title);
  }

  /** Expandable per-pipeline detail: each stage with date and approver. */
  function pipelines(pr) {
    const h = d.h;
    if (!pr.tracks.length) return null;
    const open = expanded.has(pr.id);
    const toggle = h('div', { class: 'checks-toggle', onclick: () => { open ? expanded.delete(pr.id) : expanded.add(pr.id); renderList(); } },
      `${open ? '▾' : '▸'} ${pr.tracks.length} of ${pr.pipelineCount || pr.tracks.length} pipelines`);
    if (!open) return h('div', { class: 'section' }, toggle);
    const prefix = commonPrefix(pr.tracks.map((t) => t.pipeline));
    return h('div', { class: 'section' }, toggle, h('ul', { class: 'checks pipelines' }, ...pr.tracks.map((t) =>
      h('li', { class: 'pipe' }, h('span', { class: 'pipe-name', title: t.pipeline }, t.pipeline.slice(prefix.length) || t.pipeline),
        h('span', { class: 'pipe-stages' }, ...t.stages.map(cellEl))))));
  }

  function cellEl(c) {
    const label = short(c.name);
    const status = c.latestStatus ? `\nLatest run: ${c.latestStatus}` : '';
    if (c.state !== 'deployed') return step(label, 'todo', `${c.state === 'not-yet' ? `Not in ${label} yet` : 'No run history'}${status}`);
    const by = c.by ? `\nApproved by ${c.by}` : '';
    return step(label, 'done', `In ${label} since ${c.orEarlier ? 'on or before ' : ''}${when(c.firstAt)}${by}${status}`);
  }

  function commonPrefix(names) {
    if (names.length < 2) return '';
    let p = names[0];
    for (const n of names) while (!n.startsWith(p)) p = p.slice(0, -1);
    return p.slice(0, p.lastIndexOf('-') + 1);
  }

  function render(next) {
    data = next;
    renderControls();
    renderAws();
    renderSummary();
    renderList();
  }

  // @ts-ignore: shared with main.js through the webview's window
  window.PrStatusDeploy = { create };
})();
