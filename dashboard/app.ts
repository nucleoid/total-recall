import './styles.css';
import { api, ApiError, clearKey, hasKey, isRemembered, restoreKey, setKey } from './api.js';
import type { Capabilities, MediaStats, MemoryRecord, PagedMemories, TraceRecord } from './types.js';

type View = 'overview' | 'memories' | 'search' | 'traces' | 'media' | 'agents' | 'audit';
const views: View[] = ['overview', 'memories', 'search', 'traces', 'media', 'agents', 'audit'];
let capabilities: Capabilities | null = null;
let activeController: AbortController | null = null;

const authGate = document.querySelector<HTMLElement>('#auth-gate')!;
const dashboard = document.querySelector<HTMLElement>('#dashboard')!;
const authForm = document.querySelector<HTMLFormElement>('#auth-form')!;
const keyInput = document.querySelector<HTMLInputElement>('#api-key')!;
const rememberInput = document.querySelector<HTMLInputElement>('#remember-key')!;
const main = document.querySelector<HTMLElement>('#main-content')!;
const live = document.querySelector<HTMLElement>('#live-region')!;
const identity = document.querySelector<HTMLElement>('#identity')!;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function announce(message: string): void {
  live.textContent = message;
}

function formatDate(value: unknown): string {
  if (typeof value !== 'string') return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatDuration(value: number): string {
  const minutes = Math.round((value || 0) / 60_000);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function jsonBlock(value: unknown): HTMLElement {
  const pre = el('pre', JSON.stringify(value, null, 2), 'json');
  pre.tabIndex = 0;
  return pre;
}

function panel(title: string): HTMLElement {
  const section = el('section', undefined, 'panel');
  section.append(el('h2', title));
  return section;
}

function loading(): void {
  main.replaceChildren(el('p', 'Loading…', 'state'));
}

function fail(error: unknown): void {
  if (error instanceof DOMException && error.name === 'AbortError') return;
  const message = error instanceof Error ? error.message : 'Unexpected dashboard error';
  main.replaceChildren(el('div', message, 'state error'));
  announce(message);
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) showGate();
}

function showGate(): void {
  capabilities = null;
  dashboard.hidden = true;
  authGate.hidden = false;
  keyInput.value = '';
  keyInput.focus();
}

function logout(): void {
  activeController?.abort();
  clearKey();
  history.replaceState(null, '', '/dashboard/');
  showGate();
}

function currentView(): View {
  const segment = location.pathname.replace(/^\/dashboard\/?/, '').split('/')[0] as View;
  return views.includes(segment) ? segment : 'overview';
}

function navigate(view: View): void {
  history.pushState(null, '', view === 'overview' ? '/dashboard/' : `/dashboard/${view}`);
  void render();
}

function linkButton(view: View, label: string): HTMLButtonElement {
  const button = el('button', label, 'nav-link');
  button.type = 'button';
  button.dataset.view = view;
  button.addEventListener('click', () => navigate(view));
  return button;
}

async function authenticate(): Promise<void> {
  capabilities = await api<Capabilities>('/api/capabilities');
  identity.textContent = `${capabilities.name} · ${capabilities.namespaces.join(', ')}`;
  authGate.hidden = true;
  dashboard.hidden = false;
  await render();
}

function card(label: string, value: string): HTMLElement {
  const item = el('div', undefined, 'metric');
  item.append(el('span', label, 'metric-label'), el('strong', value));
  return item;
}

async function renderOverview(): Promise<void> {
  const section = panel('Overview');
  const metrics = el('div', undefined, 'metrics');
  if (capabilities?.capabilities.admin) {
    const stats = await api<any>('/api/stats');
    metrics.append(
      card('Active memories', String(stats.total_memories ?? 0)),
      card('Documents', String(stats.total_documents ?? 0)),
      card('Oldest', formatDate(stats.oldest_memory)),
      card('Newest', formatDate(stats.newest_memory)),
    );
    section.append(metrics, el('h3', 'By namespace'), table(stats.by_namespace ?? [], ['namespace', 'count']));
  } else {
    const stats = await api<PagedMemories>('/api/memories?limit=1');
    metrics.append(
      card('Accessible memories', String(stats.total)),
      card('Namespaces', String(capabilities?.namespaces.length ?? 0)),
      card('Access ceiling', capabilities?.max_access_level ?? 'normal'),
      card('Mode', capabilities?.capabilities.write ? 'Read / write' : 'Read only'),
    );
    section.append(metrics, el('p', 'Global agents, traces, audit, and media statistics require the explicit admin permission.', 'muted'));
  }
  main.replaceChildren(section);
}

function table(rows: Array<Record<string, unknown>>, columns: string[]): HTMLTableElement {
  const result = el('table');
  const head = el('thead');
  const header = el('tr');
  for (const column of columns) header.append(el('th', column.replaceAll('_', ' ')));
  head.append(header);
  const body = el('tbody');
  if (rows.length === 0) {
    const cell = el('td', 'No records', 'empty');
    cell.colSpan = columns.length;
    const row = el('tr'); row.append(cell); body.append(row);
  }
  for (const data of rows) {
    const row = el('tr');
    for (const column of columns) {
      const value = data[column];
      const cell = el('td', value === null || value === undefined ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value));
      row.append(cell);
    }
    body.append(row);
  }
  result.append(head, body);
  return result;
}

function memoryCard(memory: MemoryRecord): HTMLElement {
  const article = el('article', undefined, 'memory-card');
  const heading = el('h3', `${memory.namespace} · ${memory.source}`);
  const content = el('p', memory.content, 'memory-content');
  const meta = el('p', `${memory.access_level} · ${formatDate(memory.created_at)} · ${memory.access_count} accesses`, 'muted');
  const tags = el('p', memory.tags?.join(' · ') || 'No tags', 'tags');
  const actions = el('div', undefined, 'actions');
  const inspect = el('button', 'Inspect');
  inspect.type = 'button';
  inspect.addEventListener('click', () => showMemory(memory));
  actions.append(inspect);
  article.append(heading, content, tags, meta, actions);
  return article;
}

function showMemory(memory: MemoryRecord): void {
  const dialog = document.querySelector<HTMLDialogElement>('#memory-dialog')!;
  const title = dialog.querySelector<HTMLElement>('h2')!;
  const body = dialog.querySelector<HTMLElement>('.dialog-body')!;
  const actions = dialog.querySelector<HTMLElement>('.dialog-actions')!;
  title.textContent = `Memory ${memory.id}`;
  body.replaceChildren(
    el('p', memory.content, 'memory-content'),
    el('h3', 'Tags'), el('p', memory.tags.join(', ') || 'None'),
    el('h3', 'Metadata'), jsonBlock(memory.metadata),
    el('h3', 'Immutable provenance'),
    table([memory as unknown as Record<string, unknown>], ['namespace', 'source', 'client_id', 'agent_id', 'session_id', 'created_at']),
  );
  actions.replaceChildren();
  if (capabilities?.capabilities.write) {
    const edit = el('button', 'Edit'); edit.type = 'button'; edit.addEventListener('click', () => void editMemory(memory, dialog)); actions.append(edit);
  }
  if (capabilities?.capabilities.delete) {
    const remove = el('button', 'Delete', 'danger'); remove.type = 'button'; remove.addEventListener('click', () => void deleteMemory(memory, dialog)); actions.append(remove);
  }
  if (!capabilities?.capabilities.write && !capabilities?.capabilities.delete) actions.append(el('span', 'Read-only key: mutation controls are unavailable.', 'muted'));
  const close = el('button', 'Close'); close.type = 'button'; close.addEventListener('click', () => dialog.close()); actions.append(close);
  dialog.showModal();
}

async function editMemory(memory: MemoryRecord, dialog: HTMLDialogElement): Promise<void> {
  const content = prompt('Edit memory content. Changing content regenerates its embedding.', memory.content);
  if (content === null || content === memory.content) return;
  try {
    const response = await api<{ memory: MemoryRecord }>(`/api/memories/${memory.id}`, {
      method: 'PATCH', headers: { 'If-Match': `"${memory.updated_at}"` }, body: JSON.stringify({ content }),
    });
    dialog.close(); announce('Memory updated and re-embedded.'); await renderMemories();
    memory = response.memory;
  } catch (error) { fail(error); }
}

async function deleteMemory(memory: MemoryRecord, dialog: HTMLDialogElement): Promise<void> {
  const confirmation = prompt(`Soft-delete this memory? Type its full ID to confirm:\n${memory.id}`);
  if (confirmation !== memory.id) { announce('Delete cancelled.'); return; }
  try {
    await api('/api/memories', { method: 'DELETE', body: JSON.stringify({ ids: [memory.id], reason: 'dashboard deletion' }) });
    dialog.close(); announce('Memory soft-deleted.'); await renderMemories();
  } catch (error) { fail(error); }
}

function memoryFilters(): HTMLFormElement {
  const form = el('form', undefined, 'filters');
  const fields: Array<[string, string, string]> = [
    ['namespace', 'Namespace', 'text'], ['source', 'Source', 'text'], ['tag', 'Tag', 'text'],
    ['created_after', 'Created after', 'datetime-local'], ['created_before', 'Created before', 'datetime-local'],
  ];
  for (const [name, label, type] of fields) {
    const wrap = el('label'); wrap.append(document.createTextNode(label));
    const input = el('input'); input.name = name; input.type = type; wrap.append(input); form.append(wrap);
  }
  const activeLabel = el('label'); activeLabel.append(document.createTextNode('Status'));
  const active = el('select'); active.name = 'active';
  for (const value of ['active', 'all', 'superseded', 'expired']) { const option = el('option', value); option.value = value; active.append(option); }
  activeLabel.append(active); form.append(activeLabel);
  const sortLabel = el('label'); sortLabel.append(document.createTextNode('Sort'));
  const sort = el('select'); sort.name = 'sort';
  for (const value of ['created_at', 'updated_at', 'accessed_at', 'access_count', 'relevance']) { const option = el('option', value); option.value = value; sort.append(option); }
  sortLabel.append(sort); form.append(sortLabel);
  const submit = el('button', 'Apply filters'); submit.type = 'submit'; form.append(submit);
  form.addEventListener('submit', (event) => { event.preventDefault(); void loadMemoryResults(form); });
  return form;
}

async function loadMemoryResults(form: HTMLFormElement): Promise<void> {
  activeController?.abort(); activeController = new AbortController();
  const params = new URLSearchParams();
  for (const [name, value] of new FormData(form)) {
    if (typeof value === 'string' && value) params.append(name, value.endsWith('T00:00') ? `${value}:00Z` : value);
  }
  const result = await api<PagedMemories>(`/api/memories?${params}`, { signal: activeController.signal });
  const list = document.querySelector<HTMLElement>('#memory-results')!;
  list.replaceChildren(el('p', `${result.total} matching memories`, 'muted'), ...result.memories.map(memoryCard));
}

async function renderMemories(): Promise<void> {
  const section = panel('Memories');
  section.append(el('p', 'Browse active memory records. Filters and sorting execute on the server.', 'muted'));
  const form = memoryFilters();
  const results = el('div'); results.id = 'memory-results';
  section.append(form, results); main.replaceChildren(section);
  await loadMemoryResults(form);
}

async function renderSearch(): Promise<void> {
  const section = panel('Search');
  const form = el('form', undefined, 'search-form');
  const label = el('label'); label.append(document.createTextNode('Hybrid memory search'));
  const input = el('input'); input.name = 'query'; input.required = true; input.placeholder = 'What do you remember?'; label.append(input);
  const submit = el('button', 'Search'); submit.type = 'submit'; form.append(label, submit);
  const results = el('div');
  let timer = 0;
  const run = async () => {
    if (!input.value.trim()) return;
    activeController?.abort(); activeController = new AbortController();
    try {
      const response = await api<{ results: MemoryRecord[] }>('/api/search', {
        method: 'POST', signal: activeController.signal, body: JSON.stringify({ query: input.value.trim(), limit: 25 }),
      });
      results.replaceChildren(...response.results.map(memoryCard)); announce(`${response.results.length} search results`);
    } catch (error) { fail(error); }
  };
  form.addEventListener('submit', (event) => { event.preventDefault(); void run(); });
  input.addEventListener('input', () => { window.clearTimeout(timer); timer = window.setTimeout(() => void run(), 450); });
  section.append(form, results); main.replaceChildren(section); input.focus();
}

async function renderTraces(): Promise<void> {
  const section = panel('Recall traces');
  if (!capabilities?.capabilities.admin) { section.append(el('p', 'Trace observability requires admin permission.', 'state')); main.replaceChildren(section); return; }
  const response = await api<{ traces: TraceRecord[] }>('/api/traces?limit=50');
  for (const trace of response.traces) {
    const item = el('article', undefined, 'trace');
    const open = el('button', trace.query_text, 'link-button'); open.type = 'button';
    open.addEventListener('click', () => void showTrace(trace.id));
    item.append(open, el('p', `${trace.result_count} results · ${trace.duration_ms ?? '—'} ms · ${formatDate(trace.created_at)}`, 'muted'));
    section.append(item);
  }
  if (!response.traces.length) section.append(el('p', 'No recorded traces.', 'state'));
  main.replaceChildren(section);
}

async function showTrace(id: string): Promise<void> {
  try {
    const response = await api<{ trace: TraceRecord; memories: MemoryRecord[] }>(`/api/traces/${id}`);
    const section = panel('Recorded score evidence');
    section.append(
      el('p', response.trace.query_text, 'lead'),
      el('p', `${response.trace.agent_name ?? 'Unknown agent'} · ${response.trace.session_id ?? 'No session'} · ${response.trace.duration_ms ?? '—'} ms · ${formatDate(response.trace.created_at)}`, 'muted'),
      el('h3', 'Stored score components'), jsonBlock(response.trace.scores),
      el('h3', 'Accessible result memories'), ...response.memories.map(memoryCard),
      el('p', 'This is recorded retrieval evidence, not a model-generated explanation.', 'notice'),
    );
    main.replaceChildren(section);
  } catch (error) { fail(error); }
}

async function renderMedia(): Promise<void> {
  const section = panel('Media listening stats');
  if (!capabilities?.capabilities.admin) { section.append(el('p', 'Media statistics require admin permission.', 'state')); main.replaceChildren(section); return; }
  const stats = await api<MediaStats>('/api/media/stats');
  const metrics = el('div', undefined, 'metrics'); metrics.append(card('Events', String(stats.total_events)), card('Listening time', formatDuration(stats.listening_duration_ms)));
  section.append(metrics, el('h3', 'By service'), table(stats.plays_by_service, ['service', 'count', 'duration_ms']), el('h3', 'Top artists'), table(stats.top_artists, ['artist', 'plays', 'duration_ms']), el('h3', 'Top albums'), table(stats.top_albums, ['album', 'artist', 'plays']), el('h3', 'Top tracks'), table(stats.top_tracks, ['title', 'artist', 'plays']), el('h3', 'Daily'), table(stats.daily, ['date', 'count', 'duration_ms']));
  main.replaceChildren(section);
}

async function renderAgents(): Promise<void> {
  const section = panel('Agents and activity');
  if (!capabilities?.capabilities.admin) { section.append(el('p', 'Agent observability requires admin permission.', 'state')); main.replaceChildren(section); return; }
  const response = await api<{ agents: Array<Record<string, unknown>> }>('/api/agents');
  section.append(table(response.agents, ['name', 'type', 'model', 'runtime', 'memory_count', 'last_memory_at', 'last_seen_at'])); main.replaceChildren(section);
}

async function renderAudit(): Promise<void> {
  const section = panel('Audit log');
  if (!capabilities?.capabilities.admin) { section.append(el('p', 'Audit observability requires admin permission.', 'state')); main.replaceChildren(section); return; }
  const response = await api<{ audit: Array<Record<string, unknown>> }>('/api/audit?limit=100');
  section.append(table(response.audit, ['created_at', 'action', 'namespace', 'memory_id', 'agent_name', 'session_id', 'result_count'])); main.replaceChildren(section);
}

async function render(): Promise<void> {
  if (!capabilities) return;
  activeController?.abort();
  const view = currentView();
  document.querySelectorAll<HTMLButtonElement>('.nav-link').forEach((button) => button.setAttribute('aria-current', button.dataset.view === view ? 'page' : 'false'));
  loading();
  try {
    if (view === 'overview') await renderOverview();
    if (view === 'memories') await renderMemories();
    if (view === 'search') await renderSearch();
    if (view === 'traces') await renderTraces();
    if (view === 'media') await renderMedia();
    if (view === 'agents') await renderAgents();
    if (view === 'audit') await renderAudit();
  } catch (error) { fail(error); }
}

authForm.addEventListener('submit', (event) => {
  event.preventDefault();
  setKey(keyInput.value, rememberInput.checked);
  void authenticate().catch(fail);
});
document.querySelector('#logout')!.addEventListener('click', logout);
const nav = document.querySelector('#primary-nav')!;
nav.replaceChildren(...views.map((view) => linkButton(view, view[0].toUpperCase() + view.slice(1))));
window.addEventListener('popstate', () => void render());

const restored = restoreKey();
rememberInput.checked = isRemembered();
if (restored && hasKey()) void authenticate().catch(fail);
else showGate();
