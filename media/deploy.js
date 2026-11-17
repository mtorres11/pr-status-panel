// @ts-check
// Deployments tab: where each PR is now. Open (local) → in the chosen branch → each CodePipeline stage,
// with the date it got there and who approved it. Where each PR is, and per stage how many pipelines have
// it, come from the extension; this file only draws them.
(function () {
  /** @typedef {import('../src/protocol').Payload} Payload */
  /** @typedef {import('../src/deploySummary').DeployPrView} DeployPrView */
  /** @typedef {import('../src/deploySummary').StageSummary} StageSummary */

  /** @type {any} */
  const ns = ((/** @type {any} */ (window)).PrStatus ??= {});
  const { h, setOptions, link, row, signInState, ago } = ns.dom;
  const { send, setState } = ns.bridge;

  /** Where a PR is → dot icon, CSS class, label. */
  const WHERE = {
    open: ['◐', 'st-running', 'Open (not merged)'],
    reverted: ['⚠', 'st-failing', 'Reverted'],
    missing: ['✖', 'st-failing', 'Merged, not in branch'],
    merged: ['●', 'st-waiting', 'Merged'],
    partial: ['↗', 'st-waiting', 'On the way'],
    done: ['✔', 'st-ready', 'In the last stage'],
  };
  /** Step state → box mark. */
  const BOX = { done: '✔', todo: '', partial: '◐', bad: '✖' };
  /** Steps drawn before any pipeline data exists. */
  const DEFAULT_STEPS = ['Development', 'Staging', 'Production'];
  /** A stage none of the PR's pipelines has. @type {StageSummary} */
  const NO_STAGE = { name: '', total: 0, deployed: 0 };

  /** @type {Payload} */
  let data;
  /** @type {any} */
  let ui = null;
  const expanded = new Set();

  const dep = () => data.deploy;
  const u = () => data.ui;
  /** "Production-Deployment" → "Production" @param {string} name */
  const short = (name) => name.replace(/[-_ ]?deploy(ment)?$/i, '') || name;
  /** @param {string | undefined} iso */
  const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

  // ---------- controls ----------
  function create() {
    const sel = (title, key, numeric) => h('select', { title, onchange: (e) => setState({ [key]: numeric ? Number(e.target.value) : e.target.value }) });
    const branch = (e) => e.target.value.trim() || 'main';
    const branchIn = h('input', { class: 'combo-search mini-input', title: 'Branch to check whether the change is in it',
      onkeydown: (e) => { if (e.key === 'Enter') setState({ deployBranch: branch(e) }); },
      onblur: (e) => { if (branch(e) !== u().deployBranch) setState({ deployBranch: branch(e) }); } });
    const findIn = h('input', { class: 'combo-search', placeholder: 'PR #, PR link, ticket key or title words', onkeydown: (e) => { if (e.key === 'Enter') setState({ deployFind: e.target.value.trim() }); } });
    const clearBtn = h('button', { class: 'secondary', title: 'Clear', onclick: () => { findIn.value = ''; setState({ deployFind: '' }); } }, '✕');
    ui = {
      whoSel: sel('Whose PRs', 'deployWho'),
      whenSel: sel('Open PRs updated, or PRs merged, in this window', 'deployWhen', true),
      repoSel: sel('Repository', 'deployRepo'),
      stateSel: sel('Which PRs', 'deployState'),
      whereSel: sel('Where the PR is now', 'deployStage'),
      branchIn, findIn,
      aws: h('div', { class: 'aws-bar' }),
      summary: h('div', { class: 'summary' }),
      list: h('div', { class: 'list' }),
    };
    const controls = h('div', { class: 'controls' },
      row('Who', ui.whoSel, ui.whenSel), row('Repo', ui.repoSel), row('Show', ui.stateSel, h('span', { class: 'muted small-label' }, 'in'), branchIn),
      row('Find', findIn, clearBtn), row('Where', ui.whereSel));
    return { el: h('div', { class: 'pane' }, controls, ui.aws, ui.summary, ui.list), render, tick: () => { if (data) renderSummary(); } };
  }

  function whoOptions() {
    const who = [['@me', data.viewerLogin ? `Mine (${data.viewerLogin})` : 'Mine']];
    if (data.team.length) who.push(['@team', `My team (${data.team.length})`]);
    who.push(['@anyone', 'Anyone'], ...data.team.map((m) => [m, m]));
    if (!who.some(([v]) => v === u().deployWho)) who.push([u().deployWho, u().deployWho]);
    return who;
  }

  function renderControls() {
    setOptions(ui.whoSel, whoOptions(), u().deployWho);
    setOptions(ui.whenSel, data.options.deployWhen, u().deployWhen);
    const repos = [...new Set([...data.favorites, ...data.repos])];
    setOptions(ui.repoSel, [['*', 'All repos'], ...repos.map((r) => [r, `${data.favorites.includes(r) ? '★ ' : ''}${r}`])], u().deployRepo);
    setOptions(ui.stateSel, data.options.deployStates, u().deployState);
    renderWhere();
    if (document.activeElement !== ui.branchIn) ui.branchIn.value = u().deployBranch;
    if (document.activeElement !== ui.findIn) ui.findIn.value = u().deployFind;
  }

  function renderWhere() {
    const b = u().deployBranch;
    const opts = [['', 'Anywhere'], ['open', 'Open (not merged)'], ['inBranch', `Merged · in ${b}`], ['notInBranch', `Merged · NOT in ${b}`], ['reverted', 'Reverted']];
    for (const n of dep().stageNames) opts.push([`in:${n}`, `In ${short(n)}`], [`notin:${n}`, `Not in ${short(n)} yet`]);
    if (!opts.some(([v]) => v === u().deployStage)) opts.push([u().deployStage, u().deployStage]);
    setOptions(ui.whereSel, opts, u().deployStage);
  }

  // ---------- AWS status ----------
  function renderAws() {
    const a = dep().aws;
    const profileBtn = h('button', { class: 'act', onclick: () => send({ type: 'awsProfile' }) }, dep().profile ? `Profile: ${dep().profile}` : 'Choose AWS profile');
    const signInBtn = h('button', { class: 'act', onclick: () => send({ type: 'awsSignIn' }) }, dep().canSignIn ? 'Sign in to AWS' : 'Set AWS sign-in command');
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
    const count = (k) => prs.filter((p) => p.where === k).length;
    const parts = Object.keys(WHERE).filter((k) => count(k)).map((k) => h('span', { class: `chip ${WHERE[k][1]}`, title: WHERE[k][2] }, `${WHERE[k][0]} ${count(k)} ${WHERE[k][2].toLowerCase()}`));
    ui.summary.replaceChildren(
      h('span', null, `${prs.length} PR${prs.length === 1 ? '' : 's'}`), ...parts,
      h('span', { class: 'muted' }, dep().loading ? ' · refreshing…' : ` · updated ${ago(dep().updatedAt)}`));
  }

  // ---------- list ----------
  function renderList() {
    if (data.needsSignIn) { ui.list.replaceChildren(signInState()); return; }
    const d = dep();
    const out = [];
    if (d.error) out.push(h('div', { class: 'error' }, `⚠ ${d.error}`));
    if (d.hint) out.push(h('div', { class: 'hint muted' }, d.hint));
    const prs = d.prs.filter((p) => p.shown);
    if (!prs.length && !d.loading && !d.error && !d.hint) out.push(h('div', { class: 'empty-state muted' }, 'No pull requests match these filters.'));
    ui.list.replaceChildren(...out, ...prs.map(cardEl));
  }

  /** @param {DeployPrView} pr */
  function ticketEl(pr) {
    if (!pr.ticket) return h('span', { class: 'ticket none' }, 'no ticket');
    return pr.ticketUrl ? link(`${pr.ticket} ↗`, pr.ticketUrl, 'ticket', pr.ticketUrl) : h('span', { class: 'ticket' }, pr.ticket);
  }

  /** @param {DeployPrView} pr */
  function revertEl(pr) {
    if (!pr.revert) return null;
    const commitUrl = `${pr.url.replace(/\/pull\/\d+$/, '')}/commit/${pr.revert.sha}`;
    return h('div', { class: 'warn', title: `${pr.revert.message}\n${when(pr.revert.date)}` },
      `⚠ Reverted in ${u().deployBranch} by `, link(pr.revert.sha.slice(0, 7), commitUrl, undefined, commitUrl));
  }

  /** @param {DeployPrView} pr */
  function cardEl(pr) {
    const [icon, cls, label] = WHERE[pr.where];
    return h('div', { class: `card ${cls}` },
      h('div', { class: 'card-top' },
        h('span', { class: 'dot', title: label }, icon),
        ticketEl(pr),
        h('span', { class: 'repo', title: pr.repo }, pr.repo.split('/')[1])),
      link(`#${pr.number} ${pr.title} ↗`, pr.url, 'pr-link', pr.url),
      h('div', { class: 'muted small' }, `by ${pr.author}${pr.isDraft ? ' · draft' : ''}`),
      track(pr),
      revertEl(pr),
      pipelines(pr));
  }

  /** One step: [✔] in green when reached, [ ] in mustard when not, ✖ in red when something went wrong. */
  function step(label, state, title) {
    return h('span', { class: `step ${state}`, title }, h('span', { class: 'box' }, BOX[state]), label);
  }

  /** Local → Merged → Development → Staging → Production; dates and approvers only in the tooltips. @param {DeployPrView} pr */
  function track(pr) {
    const arrow = () => h('span', { class: 'arrow' }, '→');
    const names = dep().stageNames.length ? dep().stageNames : DEFAULT_STEPS;
    const parts = [localStep(pr), arrow(), mergedStep(pr)];
    names.forEach((n, i) => parts.push(arrow(), stageStep(pr, short(n), pr.stages[i] || NO_STAGE)));
    return h('div', { class: 'steps' }, ...parts);
  }

  /** @param {DeployPrView} pr */
  function localStep(pr) {
    return step('Local', 'done', `Opened ${when(pr.createdAt)} by ${pr.author}${pr.isDraft ? ' (draft)' : ''}`);
  }

  /** @param {DeployPrView} pr */
  function mergedStep(pr) {
    const b = u().deployBranch;
    if (pr.state === 'OPEN') return step('Merged', 'todo', pr.inBranch ? `Not merged, but its commits are already in ${b}` : `Not merged into ${b} yet`);
    const merged = `Merged ${when(pr.mergedAt)}${pr.mergedBy ? ` by ${pr.mergedBy}` : ''}`;
    if (pr.revert) return step('Merged', 'bad', `${merged}\nReverted in ${b} on ${when(pr.revert.date)}`);
    if (pr.inBranch === false) return step('Merged', 'bad', `${merged}\nThe change is NOT in ${b}`);
    return step('Merged', 'done', `${merged}${pr.inBranch ? `\nIn ${b}` : ''}`);
  }

  /** @param {DeployPrView} pr @param {string} label @param {StageSummary} s */
  function stageStep(pr, label, s) {
    if (pr.state !== 'MERGED') return step(label, 'todo', 'Not merged yet');
    if (!s.total) return step(label, 'todo', pr.pipelineCount ? `Not deployed to ${label} yet (no pipeline has built it)` : 'No pipeline data');
    const count = s.total > 1 ? `\n${s.deployed} of ${s.total} pipelines` : '';
    if (!s.deployed || !s.first) return step(label, 'todo', `Not in ${label} yet${count}`);
    const approver = s.first.by ? `\nApproved by ${s.first.by}` : '';
    const title = `In ${label} since ${s.first.orEarlier ? 'on or before ' : ''}${when(s.first.firstAt)}${approver}${count}`;
    return step(label, s.deployed === s.total ? 'done' : 'partial', title);
  }

  /** Expandable per-pipeline detail: each stage with date and approver. @param {DeployPrView} pr */
  function pipelines(pr) {
    if (!pr.tracks.length) return null;
    const open = expanded.has(pr.id);
    const toggle = h('div', { class: 'checks-toggle', onclick: () => { if (!expanded.delete(pr.id)) expanded.add(pr.id); renderList(); } },
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

  /** @param {string[]} names */
  function commonPrefix(names) {
    if (names.length < 2) return '';
    let p = names[0];
    for (const n of names) while (!n.startsWith(p)) p = p.slice(0, -1);
    return p.slice(0, p.lastIndexOf('-') + 1);
  }

  /** @param {Payload} next */
  function render(next) {
    data = next;
    renderControls();
    renderAws();
    renderSummary();
    renderList();
  }

  ns.deploy = { create };
})();
