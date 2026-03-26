// ── 상수 ──────────────────────────────────────────────
const GIST_ID       = '3b62f1c184e665d934e29facbcceee45';
const GIST_FILENAME = 'companytasks.json';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

// ── 상태 ──────────────────────────────────────────────
let db = { projects: [], quickMemos: [], lastUpdated: null };
let ghToken    = '';
let claudeKey  = '';
let currentPage       = 'dashboard';
let currentProjectId  = null; // null = 전체
let calendarMode      = 'monthly';
let calendarDate      = new Date();
let pageHistory       = [];
let aiModalActions    = [];

// ── 초기화 ────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  ghToken   = localStorage.getItem('gh_token') || '';
  claudeKey = localStorage.getItem('claude_key') || '';
  const gistId = localStorage.getItem('gist_id') || '';

  if (!ghToken || !gistId) {
    show('setup-screen');
  } else {
    show('app');
    loadData();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && ghToken) loadData();
  });
});

// ── 설정 ──────────────────────────────────────────────
function saveSetup() {
  const token  = document.getElementById('setup-token').value.trim();
  const gist   = document.getElementById('setup-gist').value.trim();
  const claude = document.getElementById('setup-claude').value.trim();
  const err    = document.getElementById('setup-error');

  if (!token || !gist) { err.textContent = '토큰과 Gist ID는 필수입니다.'; return; }

  localStorage.setItem('gh_token', token);
  localStorage.setItem('gist_id', gist);
  if (claude) localStorage.setItem('claude_key', claude);

  ghToken   = token;
  claudeKey = claude;

  hide('setup-screen');
  show('app');
  loadData();
}

function logout() {
  if (!confirm('설정을 초기화하고 로그아웃할까요?')) return;
  ['gh_token','gist_id','claude_key','last_known_db','pending_db'].forEach(k => localStorage.removeItem(k));
  location.reload();
}

// ── 데이터 마이그레이션 ────────────────────────────────
function migrateData(raw) {
  if (!raw || typeof raw !== 'object') return { projects: [], quickMemos: [], lastUpdated: null };

  if (raw.projects) {
    if (!Array.isArray(raw.quickMemos)) raw.quickMemos = [];
    return raw;
  }

  // 구버전 { tasks:[], quickMemos:[], categories:[] } → 신버전
  const oldTasks = Array.isArray(raw.tasks) ? raw.tasks : [];
  const defaultProject = {
    id: 'default',
    name: '기본 프로젝트',
    color: '#6c5ce7',
    categories: Array.isArray(raw.categories) ? raw.categories : [],
    tasks: oldTasks
  };
  return {
    projects: [defaultProject],
    quickMemos: Array.isArray(raw.quickMemos) ? raw.quickMemos : [],
    lastUpdated: raw.lastUpdated || null
  };
}

// ── Gist API ───────────────────────────────────────────
async function loadData() {
  const gistId = localStorage.getItem('gist_id');
  try {
    const res = await fetch(`https://api.github.com/gists/${gistId}?t=${Date.now()}`, {
      headers: { 'Authorization': `token ${ghToken}`, 'Accept': 'application/vnd.github.v3+json' }
    });
    if (!res.ok) throw new Error('load failed');
    const data = await res.json();
    const raw  = JSON.parse(data.files[GIST_FILENAME]?.content || '{}');
    db = migrateData(raw);
    localStorage.setItem('last_known_db', JSON.stringify(db));
    checkPendingData();
    renderAll();
  } catch (e) {
    const cached = localStorage.getItem('last_known_db');
    if (cached) {
      db = migrateData(JSON.parse(cached));
      showToast('오프라인: 캐시 데이터를 불러왔어요');
    } else {
      db = { projects: [], quickMemos: [], lastUpdated: null };
      showToast('데이터를 불러오지 못했어요');
    }
    checkPendingData();
    renderAll();
  }
}

async function saveData() {
  const gistId = localStorage.getItem('gist_id');
  db.lastUpdated = new Date().toISOString();
  try {
    const res = await fetch(`https://api.github.com/gists/${gistId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `token ${ghToken}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ files: { [GIST_FILENAME]: { content: JSON.stringify(db, null, 2) } } })
    });
    if (!res.ok) throw new Error('save failed');
    localStorage.setItem('last_known_db', JSON.stringify(db));
    localStorage.removeItem('pending_db');
    hide('pending-banner');
    showToast('저장됐어요');
  } catch (e) {
    localStorage.setItem('pending_db', JSON.stringify(db));
    showToast('⚠️ 임시 저장됐어요 (동기화 필요)');
    show('pending-banner');
  }
}

async function syncData() {
  showToast('동기화 중...');
  await loadData();
}

function checkPendingData() {
  const pending = localStorage.getItem('pending_db');
  if (!pending) { hide('pending-banner'); return; }
  try {
    const pendingDb  = JSON.parse(pending);
    const currentDt  = new Date(db.lastUpdated || 0);
    const pendingDt  = new Date(pendingDb.lastUpdated || 0);
    if (pendingDt > currentDt) { show('pending-banner'); }
    else { localStorage.removeItem('pending_db'); }
  } catch (e) { localStorage.removeItem('pending_db'); }
}

async function syncPendingData() {
  const pending = localStorage.getItem('pending_db');
  if (!pending) return;
  db = JSON.parse(pending);
  await saveData();
  renderAll();
}

function clearPendingDb() {
  localStorage.removeItem('pending_db');
  hide('pending-banner');
  showToast('무시했어요');
}

// ── 헬퍼: 프로젝트/업무 ────────────────────────────────
function getContextTasks() {
  if (!db.projects) return [];
  if (currentProjectId === null) {
    return db.projects.flatMap(p =>
      (p.tasks || []).map(t => ({ ...t, projectId: p.id, projectName: p.name, projectColor: p.color }))
    );
  }
  const proj = db.projects.find(p => p.id === currentProjectId);
  if (!proj) return [];
  return (proj.tasks || []).map(t => ({ ...t, projectId: proj.id, projectName: proj.name, projectColor: proj.color }));
}

function findTask(id) {
  for (const proj of db.projects || []) {
    const task = (proj.tasks || []).find(t => t.id === id);
    if (task) return { task, project: proj };
  }
  return null;
}

function findSubtask(taskId, subtaskId) {
  const found = findTask(taskId);
  if (!found) return null;
  const sub = (found.task.subtasks || []).find(s => s.id === subtaskId);
  return sub ? { subtask: sub, task: found.task, project: found.project } : null;
}

function getProject(id) { return (db.projects || []).find(p => p.id === id); }

function allCategories() {
  const cats = new Set();
  (db.projects || []).forEach(p => (p.categories || []).forEach(c => cats.add(c)));
  return [...cats];
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// ── 날짜 유틸 ─────────────────────────────────────────
function today() { return new Date().toISOString().slice(0, 10); }

function dday(dueDateStr) {
  if (!dueDateStr) return null;
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const due = new Date(dueDateStr); due.setHours(0, 0, 0, 0);
  return Math.floor((due - now) / 86400000);
}

function ddayBadge(dueDateStr, status) {
  if (status === 'completed') return '';
  const d = dday(dueDateStr);
  if (d === null) return '';
  if (d < 0)   return `<span class="badge badge-gray">지연 D+${Math.abs(d)}</span>`;
  if (d === 0) return `<span class="badge badge-red">D-DAY</span>`;
  if (d <= 3)  return `<span class="badge badge-orange">D-${d}</span>`;
  return `<span class="badge badge-gray">D-${d}</span>`;
}

function priorityLabel(p) { return p === 'high' ? '높음' : p === 'medium' ? '중간' : '낮음'; }
function priorityColor(p) { return p === 'high' ? '#d63031' : p === 'medium' ? '#fdcb6e' : '#00b894'; }
function priorityClass(p) { return p === 'high' ? 'priority-high' : p === 'medium' ? 'priority-medium' : 'priority-low'; }
function statusLabel(s) { return s === 'completed' ? '완료' : s === 'in-progress' ? '진행 중' : '시작 전'; }

// ── 전체 렌더 ─────────────────────────────────────────
function renderAll() {
  renderProjectTabs();
  renderDashboard();
  renderTaskList();
  renderCompleted();
  renderMemoList();
  renderStats();
  renderCalendar();
  updateCategoryFilter();
}

// ── 프로젝트 탭 ────────────────────────────────────────
function renderProjectTabs() {
  const wrap = document.getElementById('project-tabs');
  const pagesWithTabs = ['dashboard','tasks','calendar','stats'];
  if (!db.projects || db.projects.length === 0 || !pagesWithTabs.includes(currentPage)) {
    hide('project-filter-bar'); return;
  }
  show('project-filter-bar');

  let html = `<button class="proj-tab ${currentProjectId === null ? 'active' : ''}" onclick="setProject(null)">전체</button>`;
  db.projects.forEach(p => {
    html += `<button class="proj-tab ${currentProjectId === p.id ? 'active' : ''}" onclick="setProject('${p.id}')">
      <span class="tab-dot" style="background:${p.color}"></span>${escHtml(p.name)}
    </button>`;
  });
  wrap.innerHTML = html;
}

function setProject(id) {
  currentProjectId = id;
  renderProjectTabs();
  renderDashboard();
  renderTaskList();
  renderCalendar();
  renderStats();
}

// ── 네비게이션 ────────────────────────────────────────
const pageTitles = {
  dashboard:'대시보드', calendar:'일정표', tasks:'업무 목록',
  completed:'완료 업무', memo:'빠른 메모', stats:'업무 통계',
  detail:'업무 상세', form:'업무 등록'
};

function navigate(page) {
  pageHistory = [];
  currentPage = page;
  document.querySelectorAll('.page').forEach(el => el.classList.add('hidden'));
  document.getElementById(`page-${page}`)?.classList.remove('hidden');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  document.getElementById('header-title').textContent = pageTitles[page] || '';
  renderProjectTabs();
  if (page === 'calendar')   renderCalendar();
  if (page === 'stats')      renderStats();
  if (page === 'tasks')      renderTaskList();
  if (page === 'completed')  renderCompleted();
  if (page === 'memo')       renderMemoList();
  if (page === 'dashboard')  renderDashboard();
}

function showPage(page) {
  pageHistory.push(currentPage);
  currentPage = page;
  document.querySelectorAll('.page').forEach(el => el.classList.add('hidden'));
  document.getElementById(`page-${page}`)?.classList.remove('hidden');
  document.getElementById('header-title').textContent = pageTitles[page] || '';
  renderProjectTabs();
}

function goBack() {
  const prev = pageHistory.pop();
  if (prev && ['dashboard','calendar','tasks','completed','memo','stats'].includes(prev)) navigate(prev);
  else if (prev) showPage(prev);
  else navigate('dashboard');
}

// ── 대시보드 ──────────────────────────────────────────
function renderDashboard() {
  const tasks    = getContextTasks();
  const todayStr = today();

  document.getElementById('stat-total').textContent      = tasks.length;
  document.getElementById('stat-inprogress').textContent = tasks.filter(t => t.status === 'in-progress').length;
  document.getElementById('stat-delayed').textContent    = tasks.filter(t => t.status !== 'completed' && t.dueDate && t.dueDate < todayStr).length;
  document.getElementById('stat-done').textContent       = tasks.filter(t => t.status === 'completed').length;

  // 경고
  const warns = [];
  tasks.filter(t => t.status !== 'completed' && t.priority === 'high' && (t.progress || 0) < 30)
    .forEach(t => warns.push({ type:'danger', msg:`⚠️ [${escHtml(t.projectName)}] "${escHtml(t.title)}" 높은 우선순위 / 진행률 ${t.progress||0}%` }));
  tasks.filter(t => { const d = dday(t.dueDate); return t.status !== 'completed' && d !== null && d <= 3 && d >= 0; })
    .forEach(t => warns.push({ msg:`📅 [${escHtml(t.projectName)}] "${escHtml(t.title)}" 마감 ${dday(t.dueDate) === 0 ? '오늘' : `D-${dday(t.dueDate)}`}` }));
  document.getElementById('warnings-area').innerHTML = warns.slice(0, 5)
    .map(w => `<div class="warning-item ${w.type||''}">${w.msg}</div>`).join('');

  // 오늘의 할 일
  let todoItems = [];
  tasks.filter(t => t.status !== 'completed').forEach(task => {
    const subs = task.subtasks || [];
    if (subs.length > 0) {
      const todaySubs = subs.filter(s => s.status !== 'completed' && s.dueDate === todayStr);
      if (todaySubs.length > 0) {
        todaySubs.forEach(s => todoItems.push({ title: s.title, parent: `[${task.projectName}] ${task.title}`, priority: s.priority || task.priority, dueDate: s.dueDate, status: s.status, taskId: task.id }));
      } else {
        const first = subs.find(s => s.status !== 'completed');
        if (first) todoItems.push({ title: first.title, parent: `[${task.projectName}] ${task.title}`, priority: first.priority || task.priority, dueDate: first.dueDate, status: first.status, taskId: task.id });
      }
    } else {
      todoItems.push({ title: task.title, parent: `[${task.projectName}]`, priority: task.priority, dueDate: task.dueDate, status: task.status, taskId: task.id });
    }
  });

  const todoEl = document.getElementById('today-todos');
  if (todoItems.length === 0) {
    todoEl.innerHTML = `<div class="empty-state">오늘 할 일이 없어요 🎉</div>`;
  } else {
    todoEl.innerHTML = todoItems.slice(0, 10).map(item => `
      <div class="todo-item" onclick="showDetail('${item.taskId}')">
        <div class="todo-priority-bar ${priorityClass(item.priority)}"></div>
        <div class="todo-body">
          <div class="todo-parent">${escHtml(item.parent)}</div>
          <div class="todo-title">${escHtml(item.title)}</div>
          <div class="todo-meta">
            ${ddayBadge(item.dueDate, item.status)}
            <span class="badge badge-gray">${priorityLabel(item.priority)}</span>
          </div>
        </div>
      </div>`).join('');
  }
}

// ── 업무 목록 ─────────────────────────────────────────
function renderTaskList() {
  const priority = document.getElementById('filter-priority')?.value || '';
  const status   = document.getElementById('filter-status')?.value   || '';
  const category = document.getElementById('filter-category')?.value || '';

  let tasks = getContextTasks().filter(t => t.status !== 'completed');
  if (priority) tasks = tasks.filter(t => t.priority === priority);
  if (status)   tasks = tasks.filter(t => t.status   === status);
  if (category) tasks = tasks.filter(t => t.category === category);

  tasks.sort((a, b) => {
    const po = { high:0, medium:1, low:2 };
    return (po[a.priority]||1) - (po[b.priority]||1) || (a.dueDate||'').localeCompare(b.dueDate||'');
  });

  const el = document.getElementById('task-list');
  if (tasks.length === 0) { el.innerHTML = `<div class="empty-state">업무가 없어요</div>`; return; }

  el.innerHTML = tasks.map(task => `
    <div class="task-card" onclick="showDetail('${task.id}')">
      <div class="todo-priority-bar ${priorityClass(task.priority)}" style="width:5px;border-radius:4px;flex-shrink:0;align-self:stretch"></div>
      <div class="task-card-body">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
          <div class="task-title">${escHtml(task.title)}</div>
          ${ddayBadge(task.dueDate, task.status)}
        </div>
        <div class="task-meta">
          <span class="badge" style="background:${priorityColor(task.priority)}22;color:${priorityColor(task.priority)}">${priorityLabel(task.priority)}</span>
          ${task.category ? `<span class="badge badge-blue">${escHtml(task.category)}</span>` : ''}
          <span class="badge badge-gray">${escHtml(task.projectName)}</span>
          <span class="badge badge-gray">${statusLabel(task.status)}</span>
        </div>
        <div class="task-progress-wrap">
          <div class="task-progress-bar"><div class="task-progress-fill" style="width:${task.progress||0}%"></div></div>
          <span class="task-progress-text">${task.progress||0}%</span>
        </div>
      </div>
    </div>`).join('');
}

function updateCategoryFilter() {
  const sel = document.getElementById('filter-category');
  if (!sel) return;
  const cats = allCategories();
  const prev = sel.value;
  sel.innerHTML = `<option value="">전체 카테고리</option>` +
    cats.map(c => `<option value="${escHtml(c)}" ${c === prev ? 'selected' : ''}>${escHtml(c)}</option>`).join('');
}

// ── 완료 목록 ─────────────────────────────────────────
function renderCompleted() {
  const tasks = getContextTasks().filter(t => t.status === 'completed');
  tasks.sort((a, b) => (b.completedAt||'').localeCompare(a.completedAt||''));
  const el = document.getElementById('completed-list');
  if (tasks.length === 0) { el.innerHTML = `<div class="empty-state">완료된 업무가 없어요</div>`; return; }
  el.innerHTML = tasks.map(task => `
    <div class="completed-card">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div class="task-title" style="text-decoration:line-through;color:#636e72">${escHtml(task.title)}</div>
        <button class="btn-success" onclick="resumeTask('${task.id}')">재개</button>
      </div>
      <div class="task-meta" style="margin-top:6px">
        <span class="badge badge-green">완료</span>
        ${task.category ? `<span class="badge badge-blue">${escHtml(task.category)}</span>` : ''}
        <span class="badge badge-gray">${escHtml(task.projectName)}</span>
      </div>
      <div class="completed-date">완료: ${task.completedAt ? task.completedAt.slice(0,10) : '-'}</div>
    </div>`).join('');
}

function resumeTask(id) {
  const found = findTask(id);
  if (!found) return;
  found.task.status = 'in-progress';
  found.task.completedAt = null;
  if (found.task.progress >= 100) found.task.progress = 80;
  saveData().then(() => { renderAll(); navigate('tasks'); });
}

// ── 업무 상세 ─────────────────────────────────────────
function showDetail(taskId) {
  const found = findTask(taskId);
  if (!found) return;
  const { task, project: proj } = found;

  // 세부업무 있으면 진행률 자동 계산
  if (task.subtasks && task.subtasks.length > 0) {
    task.progress = Math.round(task.subtasks.reduce((s, st) => s + (st.progress || 0), 0) / task.subtasks.length);
  }

  showPage('detail');

  const memosHtml = (memos) => (memos || []).map(m =>
    `<div class="memo-entry"><div>${escHtml(m.content)}</div><div class="memo-entry-date">${(m.createdAt||'').slice(0,16).replace('T',' ')}</div></div>`
  ).join('');

  const subtasksHtml = (task.subtasks || []).map(s => `
    <div class="subtask-item" id="sub-${s.id}">
      <div class="subtask-header" onclick="toggleSubtask('${s.id}')">
        <div class="todo-priority-bar ${priorityClass(s.priority||'medium')}" style="width:4px;border-radius:4px;align-self:stretch;flex-shrink:0"></div>
        <div class="subtask-title">${escHtml(s.title)}</div>
        <span class="badge ${s.status==='completed'?'badge-green':'badge-gray'}">${statusLabel(s.status)}</span>
        <span class="subtask-expand">▼</span>
      </div>
      <div class="subtask-detail" id="subdetail-${s.id}">
        <div class="subtask-meta">
          <span class="badge" style="background:${priorityColor(s.priority||'medium')}22;color:${priorityColor(s.priority||'medium')}">${priorityLabel(s.priority||'medium')}</span>
          ${s.dueDate ? `<span class="badge badge-gray">마감: ${s.dueDate}</span>` : ''}
          ${ddayBadge(s.dueDate, s.status)}
        </div>
        <div class="subtask-edit-form">
          <div class="form-group" style="margin-bottom:8px">
            <label style="font-size:12px">업무명</label>
            <input type="text" id="sedit-title-${s.id}" value="${escHtml(s.title)}" style="padding:6px 10px;font-size:13px">
          </div>
          <div class="form-row" style="gap:8px;margin-bottom:8px">
            <div class="form-group" style="margin-bottom:0">
              <label style="font-size:12px">중요도</label>
              <select id="sedit-priority-${s.id}" style="padding:6px 10px;font-size:13px">
                <option value="high" ${s.priority==='high'?'selected':''}>높음</option>
                <option value="medium" ${(s.priority||'medium')==='medium'?'selected':''}>중간</option>
                <option value="low" ${s.priority==='low'?'selected':''}>낮음</option>
              </select>
            </div>
            <div class="form-group" style="margin-bottom:0">
              <label style="font-size:12px">마감일</label>
              <input type="date" id="sedit-due-${s.id}" value="${s.dueDate||''}" style="padding:6px 10px;font-size:13px">
            </div>
          </div>
          <div class="form-row" style="gap:8px;margin-bottom:8px">
            <div class="form-group" style="margin-bottom:0">
              <label style="font-size:12px">상태</label>
              <select id="sedit-status-${s.id}" style="padding:6px 10px;font-size:13px">
                <option value="todo" ${s.status==='todo'?'selected':''}>시작 전</option>
                <option value="in-progress" ${s.status==='in-progress'?'selected':''}>진행 중</option>
                <option value="completed" ${s.status==='completed'?'selected':''}>완료</option>
              </select>
            </div>
            <div class="form-group" style="margin-bottom:0">
              <label style="font-size:12px">진행률 (%)</label>
              <input type="number" id="sedit-progress-${s.id}" value="${s.progress||0}" min="0" max="100" style="padding:6px 10px;font-size:13px">
            </div>
          </div>
          <button class="btn-primary" style="width:100%;padding:8px;font-size:13px" onclick="saveSubtaskEdit('${taskId}','${s.id}')">세부 업무 저장</button>
        </div>
        <div style="margin-top:10px">
          <div class="section-title" style="font-size:13px;margin:8px 0 6px">메모</div>
          <div id="smemos-${s.id}">${memosHtml(s.memos)}</div>
          <div class="inline-memo-form">
            <textarea id="smemo-${s.id}" rows="2" placeholder="세부 업무 메모..."></textarea>
            <button class="btn-secondary" style="width:100%;padding:7px;font-size:13px" onclick="addSubMemo('${taskId}','${s.id}')">메모 추가</button>
          </div>
        </div>
      </div>
    </div>`).join('');

  document.getElementById('detail-content').innerHTML = `
    <div class="detail-header">
      <div style="font-size:12px;color:#b2bec3;margin-bottom:4px">${escHtml(proj.name)}</div>
      <div class="detail-title">${escHtml(task.title)}</div>
      <div class="detail-meta">
        <span class="badge" style="background:${priorityColor(task.priority)}22;color:${priorityColor(task.priority)}">${priorityLabel(task.priority)}</span>
        <span class="badge badge-gray">${statusLabel(task.status)}</span>
        ${task.category ? `<span class="badge badge-blue">${escHtml(task.category)}</span>` : ''}
        ${task.dueDate ? `<span class="badge badge-gray">마감 ${task.dueDate}</span>` : ''}
        ${ddayBadge(task.dueDate, task.status)}
      </div>
      ${task.description ? `<div class="detail-desc" style="margin-top:10px">${escHtml(task.description)}</div>` : ''}
    </div>

    <div class="detail-section">
      <h4>진행률</h4>
      <div class="detail-progress-row">
        <div class="detail-progress-bar"><div class="detail-progress-fill" id="main-prog-bar" style="width:${task.progress||0}%"></div></div>
        <input type="number" id="main-progress-input" value="${task.progress||0}" min="0" max="100"
          style="width:60px;padding:4px 8px;border:1.5px solid #dfe6e9;border-radius:6px;font-size:14px;text-align:center"
          onchange="updateMainProgress('${taskId}',this.value)">
        <span style="font-size:13px;color:#636e72">%</span>
      </div>
    </div>

    <div class="detail-section">
      <div class="detail-actions">
        <button class="btn-secondary" onclick="showEditTask('${taskId}')">✏️ 수정</button>
        <button class="btn-${task.status==='completed'?'success':'primary'}" onclick="toggleComplete('${taskId}')">
          ${task.status==='completed'?'↩ 재개':'✓ 완료'}
        </button>
        <button class="btn-danger" onclick="deleteTask('${taskId}')">삭제</button>
      </div>
    </div>

    <div class="detail-section">
      <h4>메인 업무 메모</h4>
      <div id="main-memos">${memosHtml(task.memos)}</div>
      <div class="inline-memo-form">
        <textarea id="main-memo-input" rows="2" placeholder="메모 추가..."></textarea>
        <button class="btn-secondary" style="width:100%;padding:8px;font-size:13px" onclick="addMainMemo('${taskId}')">메모 추가</button>
      </div>
    </div>

    ${task.subtasks && task.subtasks.length > 0 ? `
    <div class="detail-section">
      <h4>세부 업무 (${task.subtasks.length}건)</h4>
      ${subtasksHtml}
    </div>` : ''}
  `;
}

function toggleSubtask(subId) {
  document.getElementById(`subdetail-${subId}`)?.classList.toggle('open');
}

function updateMainProgress(taskId, value) {
  const found = findTask(taskId);
  if (!found) return;
  found.task.progress = Math.min(100, Math.max(0, parseInt(value) || 0));
  document.getElementById('main-prog-bar').style.width = found.task.progress + '%';
  saveData();
}

function addMainMemo(taskId) {
  const input   = document.getElementById('main-memo-input');
  const content = input.value.trim();
  if (!content) return;
  const found = findTask(taskId);
  if (!found) return;
  if (!found.task.memos) found.task.memos = [];
  found.task.memos.unshift({ id: uid(), content, createdAt: new Date().toISOString() });
  input.value = '';
  saveData().then(() => showDetail(taskId));
}

function addSubMemo(taskId, subtaskId) {
  const input   = document.getElementById(`smemo-${subtaskId}`);
  const content = input.value.trim();
  if (!content) return;
  const found = findSubtask(taskId, subtaskId);
  if (!found) return;
  if (!found.subtask.memos) found.subtask.memos = [];
  found.subtask.memos.unshift({ id: uid(), content, createdAt: new Date().toISOString() });
  input.value = '';
  saveData().then(() => showDetail(taskId));
}

function saveSubtaskEdit(taskId, subtaskId) {
  const found = findSubtask(taskId, subtaskId);
  if (!found) return;
  const s = found.subtask;
  s.title    = document.getElementById(`sedit-title-${subtaskId}`)?.value.trim() || s.title;
  s.priority = document.getElementById(`sedit-priority-${subtaskId}`)?.value || s.priority;
  s.dueDate  = document.getElementById(`sedit-due-${subtaskId}`)?.value || '';
  s.status   = document.getElementById(`sedit-status-${subtaskId}`)?.value || s.status;
  s.progress = parseInt(document.getElementById(`sedit-progress-${subtaskId}`)?.value) || 0;
  if (s.status === 'completed') s.progress = 100;

  // 메인 업무 진행률 자동 재계산
  const task = found.task;
  if (task.subtasks && task.subtasks.length > 0) {
    task.progress = Math.round(task.subtasks.reduce((sum, st) => sum + (st.progress || 0), 0) / task.subtasks.length);
  }

  saveData().then(() => { showDetail(taskId); showToast('저장됐어요'); });
}

function toggleComplete(taskId) {
  const found = findTask(taskId);
  if (!found) return;
  const task = found.task;
  if (task.status === 'completed') {
    task.status = 'in-progress';
    task.completedAt = null;
    if (task.progress >= 100) task.progress = 80;
  } else {
    task.status = 'completed';
    task.completedAt = new Date().toISOString();
    task.progress = 100;
    (task.subtasks || []).forEach(s => { s.status = 'completed'; s.progress = 100; });
  }
  saveData().then(() => { showDetail(taskId); renderAll(); });
}

function deleteTask(taskId) {
  if (!confirm('이 업무를 삭제할까요?')) return;
  for (const proj of db.projects) {
    const idx = (proj.tasks || []).findIndex(t => t.id === taskId);
    if (idx >= 0) { proj.tasks.splice(idx, 1); break; }
  }
  saveData().then(() => { renderAll(); goBack(); });
}

// ── 업무 폼 ───────────────────────────────────────────
function showAddTask() {
  if (!db.projects || db.projects.length === 0) {
    showToast('먼저 프로젝트를 만드세요 (상단 📁 버튼)'); return;
  }
  showPage('form');
  document.getElementById('task-form').reset();
  document.getElementById('form-id').value = '';
  document.getElementById('form-progress').value = '0';
  document.getElementById('subtask-list-form').innerHTML = '';
  document.getElementById('header-title').textContent = '업무 추가';
  populateProjectSelect();
  document.getElementById('category-list').innerHTML = allCategories().map(c => `<option value="${escHtml(c)}">`).join('');
}

function showEditTask(taskId) {
  const found = findTask(taskId);
  if (!found) return;
  const { task } = found;

  showPage('form');
  document.getElementById('header-title').textContent = '업무 수정';
  populateProjectSelect(task.projectId);

  document.getElementById('form-id').value         = task.id;
  document.getElementById('form-project-id').value = task.projectId;
  document.getElementById('form-title').value       = task.title || '';
  document.getElementById('form-desc').value        = task.description || '';
  document.getElementById('form-category').value    = task.category || '';
  document.getElementById('form-priority').value    = task.priority || 'medium';
  document.getElementById('form-due').value         = task.dueDate || '';
  document.getElementById('form-hours').value       = task.estimatedHours || '';
  document.getElementById('form-status').value      = task.status || 'todo';
  document.getElementById('form-progress').value    = task.progress || 0;
  document.getElementById('form-memo').value        = task.memo || '';
  document.getElementById('category-list').innerHTML = allCategories().map(c => `<option value="${escHtml(c)}">`).join('');

  document.getElementById('subtask-list-form').innerHTML = '';
  (task.subtasks || []).forEach(s => addSubtaskRow(s));
}

function populateProjectSelect(selectedId) {
  const sel = document.getElementById('form-project');
  const targetId = selectedId || currentProjectId || db.projects[0]?.id;
  sel.innerHTML = db.projects.map(p =>
    `<option value="${p.id}" ${p.id === targetId ? 'selected' : ''}>${escHtml(p.name)}</option>`
  ).join('');
  document.getElementById('form-project-id').value = sel.value;
}

function addSubtaskRow(data = {}) {
  const id = data.id || uid();
  // 마감일 미지정 시 메인 업무 마감일 기본값으로
  if (!data.dueDate) data.dueDate = document.getElementById('form-due')?.value || '';
  const div = document.createElement('div');
  div.className = 'subtask-form-row';
  div.id = `strow-${id}`;
  div.innerHTML = `
    <button type="button" class="subtask-remove-btn" onclick="document.getElementById('strow-${id}').remove()">×</button>
    <input type="text" id="st-title-${id}" placeholder="세부 업무명 *" value="${escHtml(data.title||'')}">
    <div class="form-row" style="gap:6px">
      <select id="st-priority-${id}">
        <option value="high"   ${data.priority==='high'  ?'selected':''}>높음</option>
        <option value="medium" ${(data.priority||'medium')==='medium'?'selected':''}>중간</option>
        <option value="low"    ${data.priority==='low'   ?'selected':''}>낮음</option>
      </select>
      <input type="date" id="st-due-${id}" value="${data.dueDate||''}">
    </div>
    <div class="form-row" style="gap:6px">
      <div>
        <label style="font-size:11px;color:#636e72;display:block;margin-bottom:2px">상태</label>
        <select id="st-status-${id}">
          <option value="todo"        ${data.status==='todo'       ?'selected':''}>시작 전</option>
          <option value="in-progress" ${data.status==='in-progress'?'selected':''}>진행 중</option>
          <option value="completed"   ${data.status==='completed'  ?'selected':''}>완료</option>
        </select>
      </div>
      <div>
        <label style="font-size:11px;color:#636e72;display:block;margin-bottom:2px">진행률 (%)</label>
        <input type="number" id="st-progress-${id}" value="${data.progress||0}" min="0" max="100">
      </div>
    </div>
    <input type="hidden" id="st-id-${id}" value="${id}">
  `;
  document.getElementById('subtask-list-form').appendChild(div);
}

async function aiSuggestSubtaskDates() {
  const mainTitle = document.getElementById('form-title')?.value.trim();
  const mainDue   = document.getElementById('form-due')?.value;
  const mainDesc  = document.getElementById('form-desc')?.value.trim();
  if (!mainDue)   { showToast('메인 업무 마감일을 먼저 입력해주세요'); return; }

  const rows = document.querySelectorAll('.subtask-form-row');
  if (rows.length === 0) { showToast('세부 업무를 먼저 추가해주세요'); return; }

  // 세부업무 목록 수집
  const subtaskList = [];
  rows.forEach((row, i) => {
    const rowId    = row.id.replace('strow-', '');
    const title    = document.getElementById(`st-title-${rowId}`)?.value.trim() || `세부업무 ${i+1}`;
    const priority = document.getElementById(`st-priority-${rowId}`)?.value || 'medium';
    subtaskList.push({ rowId, title, priority, index: i+1 });
  });

  showToast('AI가 일정을 분석 중이에요...');

  const prompt = `메인 업무: "${mainTitle}"
${mainDesc ? `업무 내용: "${mainDesc}"` : ''}
메인 마감일: ${mainDue}
오늘 날짜: ${today()}

세부 업무 목록 (순서대로):
${subtaskList.map(s => `${s.index}. ${s.title} (중요도: ${priorityLabel(s.priority)})`).join('\n')}

위 세부업무들의 추천 마감일을 아래 조건에 맞게 제안해줘:
- 업무 순서와 의존관계 고려 (앞 업무가 완료돼야 다음 업무 가능한 경우)
- 중요도 높은 업무는 여유 있게 앞에 배치
- 마지막 세부업무는 메인 마감일(${mainDue})을 넘지 않도록
- 오늘(${today()}) 이후 날짜만
- 반드시 세부업무 수(${subtaskList.length}개)만큼 YYYY-MM-DD 형식 날짜만 한 줄에 하나씩 출력. 설명 없이 날짜만.`;

  try {
    const result = await callClaude(prompt, '당신은 프로젝트 일정 전문가입니다. 날짜만 YYYY-MM-DD 형식으로 출력하세요.');
    const dates  = result.trim().split('\n')
      .map(l => l.trim())
      .filter(l => /^\d{4}-\d{2}-\d{2}$/.test(l));

    if (dates.length < subtaskList.length) {
      showToast('AI 응답 파싱 실패. 균등 배분으로 대체할게요'); distributeSubtaskDates(); return;
    }

    subtaskList.forEach((s, i) => {
      const input = document.getElementById(`st-due-${s.rowId}`);
      if (input && dates[i]) input.value = dates[i];
    });
    showToast(`✨ AI가 ${subtaskList.length}개 세부업무 일정을 추천했어요`);
  } catch (e) {
    showToast('AI 요청 실패. 균등 배분으로 대체할게요'); distributeSubtaskDates();
  }
}

function distributeSubtaskDates() {
  const mainDue = document.getElementById('form-due')?.value;
  if (!mainDue) { showToast('메인 업무 마감일을 먼저 입력해주세요'); return; }

  const rows = document.querySelectorAll('.subtask-form-row');
  if (rows.length === 0) { showToast('세부 업무를 먼저 추가해주세요'); return; }

  const start   = new Date(); start.setHours(0,0,0,0);
  const end     = new Date(mainDue); end.setHours(0,0,0,0);
  const totalMs = end - start;
  const count   = rows.length;

  rows.forEach((row, i) => {
    const rowId  = row.id.replace('strow-', '');
    const input  = document.getElementById(`st-due-${rowId}`);
    if (!input) return;
    // 마지막 세부업무는 메인 마감일과 동일
    const ratio  = (i + 1) / count;
    const dateMs = start.getTime() + totalMs * ratio;
    input.value  = new Date(dateMs).toISOString().slice(0, 10);
  });

  showToast(`${count}개 세부업무 일정을 배분했어요`);
}

function saveTask(e) {
  e.preventDefault();
  const id        = document.getElementById('form-id').value;
  const projectId = document.getElementById('form-project').value;
  const title     = document.getElementById('form-title').value.trim();
  if (!title)     { showToast('업무명을 입력해주세요'); return; }
  if (!projectId) { showToast('프로젝트를 선택해주세요'); return; }

  // 세부 업무 수집
  const subtasks = [];
  document.querySelectorAll('.subtask-form-row').forEach(row => {
    const rowId  = row.id.replace('strow-', '');
    const sTitle = document.getElementById(`st-title-${rowId}`)?.value.trim();
    if (!sTitle) return;
    subtasks.push({
      id:       document.getElementById(`st-id-${rowId}`)?.value || uid(),
      title:    sTitle,
      priority: document.getElementById(`st-priority-${rowId}`)?.value || 'medium',
      dueDate:  document.getElementById(`st-due-${rowId}`)?.value || '',
      status:   document.getElementById(`st-status-${rowId}`)?.value || 'todo',
      progress: parseInt(document.getElementById(`st-progress-${rowId}`)?.value) || 0,
      memos:    []
    });
  });

  const statusVal  = document.getElementById('form-status').value;
  let progressVal  = parseInt(document.getElementById('form-progress').value) || 0;
  if (subtasks.length > 0) {
    progressVal = Math.round(subtasks.reduce((s, t) => s + (t.progress || 0), 0) / subtasks.length);
  }

  const proj = getProject(projectId);
  if (!proj) { showToast('프로젝트를 찾을 수 없어요'); return; }

  const cat = document.getElementById('form-category').value.trim();
  if (cat && !(proj.categories || []).includes(cat)) {
    if (!proj.categories) proj.categories = [];
    proj.categories.push(cat);
  }

  if (id) {
    // 수정
    const found = findTask(id);
    if (found) {
      const task = found.task;
      Object.assign(task, {
        title,
        description:    document.getElementById('form-desc').value.trim(),
        category:       cat,
        priority:       document.getElementById('form-priority').value,
        dueDate:        document.getElementById('form-due').value,
        estimatedHours: parseFloat(document.getElementById('form-hours').value) || null,
        status:         statusVal,
        progress:       progressVal,
        memo:           document.getElementById('form-memo').value.trim(),
        subtasks
      });
      if (statusVal === 'completed' && !task.completedAt) task.completedAt = new Date().toISOString();
      if (statusVal !== 'completed') task.completedAt = null;
      // 프로젝트 이동
      if (found.project.id !== projectId) {
        found.project.tasks = (found.project.tasks || []).filter(t => t.id !== id);
        if (!proj.tasks) proj.tasks = [];
        proj.tasks.push(task);
      }
    }
  } else {
    // 신규
    if (!proj.tasks) proj.tasks = [];
    proj.tasks.push({
      id: uid(), title,
      description:    document.getElementById('form-desc').value.trim(),
      category:       cat,
      priority:       document.getElementById('form-priority').value,
      dueDate:        document.getElementById('form-due').value,
      estimatedHours: parseFloat(document.getElementById('form-hours').value) || null,
      status:         statusVal,
      progress:       progressVal,
      memo:           document.getElementById('form-memo').value.trim(),
      memos: [], subtasks,
      createdAt:   new Date().toISOString(),
      completedAt: statusVal === 'completed' ? new Date().toISOString() : null
    });
  }

  saveData().then(() => { renderAll(); goBack(); showToast(id ? '수정됐어요' : '등록됐어요'); });
}

// ── 빠른 메모 ─────────────────────────────────────────
function addQuickMemo() {
  const input   = document.getElementById('memo-input');
  const content = input.value.trim();
  if (!content) return;
  if (!db.quickMemos) db.quickMemos = [];
  db.quickMemos.unshift({ id: uid(), content, createdAt: new Date().toISOString() });
  input.value = '';
  saveData().then(() => renderMemoList());
}

function renderMemoList() {
  const el = document.getElementById('memo-list');
  if (!db.quickMemos || db.quickMemos.length === 0) {
    el.innerHTML = `<div class="empty-state">저장된 메모가 없어요</div>`; return;
  }
  const activeTasks = getContextTasks().filter(t => t.status !== 'completed');
  el.innerHTML = db.quickMemos.map(m => `
    <div class="memo-item" id="memoitem-${m.id}">
      <div class="memo-item-text">${escHtml(m.content)}</div>
      <div class="memo-item-date">${(m.createdAt||'').slice(0,16).replace('T',' ')}</div>
      <div class="memo-item-actions">
        <button class="btn-secondary" style="font-size:12px;padding:6px 10px" onclick="convertMemoToTask('${m.id}')">업무로 전환</button>
        <button class="btn-secondary" style="font-size:12px;padding:6px 10px" onclick="showSubtaskConvert('${m.id}')">세부업무로 전환</button>
        <button class="btn-danger"    style="font-size:12px;padding:6px 10px" onclick="deleteMemo('${m.id}')">삭제</button>
      </div>
      <div class="subtask-select-area hidden" id="subtask-select-${m.id}">
        <select id="subtask-task-sel-${m.id}" style="flex:1;padding:6px;border:1.5px solid #dfe6e9;border-radius:8px;font-size:13px">
          ${activeTasks.map(t => `<option value="${t.id}">${escHtml('['+t.projectName+'] '+t.title)}</option>`).join('')}
        </select>
        <button class="btn-primary" style="font-size:12px;padding:6px 12px" onclick="confirmSubtaskConvert('${m.id}')">확인</button>
        <button class="btn-secondary" style="font-size:12px;padding:6px 12px" onclick="document.getElementById('subtask-select-${m.id}').classList.add('hidden')">취소</button>
      </div>
    </div>`).join('');
}

function deleteMemo(id) {
  db.quickMemos = (db.quickMemos || []).filter(m => m.id !== id);
  saveData().then(() => renderMemoList());
}

function convertMemoToTask(memoId) {
  const memo = (db.quickMemos || []).find(m => m.id === memoId);
  if (!memo) return;
  if (!db.projects || db.projects.length === 0) { showToast('먼저 프로젝트를 만드세요'); return; }
  db.quickMemos = db.quickMemos.filter(m => m.id !== memoId);
  showAddTask();
  document.getElementById('form-title').value = memo.content.slice(0, 80);
  document.getElementById('form-desc').value  = memo.content;
  showToast('메모를 업무 폼으로 옮겼어요');
}

function showSubtaskConvert(memoId) {
  document.getElementById(`subtask-select-${memoId}`)?.classList.remove('hidden');
}

function confirmSubtaskConvert(memoId) {
  const memo   = (db.quickMemos || []).find(m => m.id === memoId);
  const taskId = document.getElementById(`subtask-task-sel-${memoId}`)?.value;
  if (!memo || !taskId) return;
  const found = findTask(taskId);
  if (!found) return;
  if (!found.task.subtasks) found.task.subtasks = [];
  found.task.subtasks.push({ id: uid(), title: memo.content.slice(0, 80), priority: 'medium', dueDate: '', status: 'todo', progress: 0, memos: [] });
  db.quickMemos = db.quickMemos.filter(m => m.id !== memoId);
  saveData().then(() => { renderMemoList(); showToast('세부 업무로 추가됐어요'); });
}

// ── 통계 ──────────────────────────────────────────────
function renderStats() {
  const tasks    = getContextTasks();
  const todayStr = today();
  const total    = tasks.length;
  const done     = tasks.filter(t => t.status === 'completed').length;
  const delayed  = tasks.filter(t => t.status !== 'completed' && t.dueDate && t.dueDate < todayStr).length;
  const thisMonth = new Date().toISOString().slice(0, 7);
  const monthDone = tasks.filter(t => t.status === 'completed' && (t.completedAt||'').slice(0,7) === thisMonth).length;
  const inprog    = tasks.filter(t => t.status === 'in-progress').length;
  const rate      = total > 0 ? Math.round(done / total * 100) : 0;

  document.getElementById('stats-rate').textContent       = rate + '%';
  document.getElementById('stats-rate-bar').style.width   = rate + '%';
  document.getElementById('stats-delayed').textContent    = delayed + '건';
  document.getElementById('stats-month-done').textContent = monthDone + '건';
  document.getElementById('stats-inprogress').textContent = inprog + '건';

  // 카테고리별
  const catMap = {};
  tasks.forEach(t => { const c = t.category || '미분류'; catMap[c] = (catMap[c]||0) + 1; });
  const maxCat = Math.max(...Object.values(catMap), 1);
  document.getElementById('stats-category').innerHTML = Object.entries(catMap).map(([c, n]) => `
    <div class="category-bar-item">
      <div class="category-bar-label"><span>${escHtml(c)}</span><span>${n}건</span></div>
      <div class="category-bar-track"><div class="category-bar-fill" style="width:${n/maxCat*100}%"></div></div>
    </div>`).join('') || `<div class="empty-state">데이터 없음</div>`;

  // 중요도별
  const priMap = { high:0, medium:0, low:0 };
  tasks.forEach(t => { if (priMap[t.priority] !== undefined) priMap[t.priority]++; });
  const maxPri = Math.max(...Object.values(priMap), 1);
  const priColors = { high:'#d63031', medium:'#fdcb6e', low:'#00b894' };
  document.getElementById('stats-priority').innerHTML = ['high','medium','low'].map(p => `
    <div class="category-bar-item">
      <div class="category-bar-label"><span>${priorityLabel(p)}</span><span>${priMap[p]}건</span></div>
      <div class="category-bar-track"><div class="category-bar-fill" style="width:${priMap[p]/maxPri*100}%;background:${priColors[p]}"></div></div>
    </div>`).join('');
}

function generateAIText() {
  const tasks    = getContextTasks();
  const todayStr = today();
  const lines = [
    `[업무 현황 요약 - ${todayStr}]`,
    `전체: ${tasks.length}건 / 진행 중: ${tasks.filter(t=>t.status==='in-progress').length}건 / 완료: ${tasks.filter(t=>t.status==='completed').length}건 / 지연: ${tasks.filter(t=>t.status!=='completed'&&t.dueDate&&t.dueDate<todayStr).length}건`,
    '',
    ...(db.projects||[]).flatMap(p => {
      if (currentProjectId && p.id !== currentProjectId) return [];
      return [
        `[프로젝트: ${p.name}]`,
        ...(p.tasks||[]).map(t =>
          `- [${statusLabel(t.status)}][${priorityLabel(t.priority)}] ${t.title} (마감: ${t.dueDate||'미정'}, 진행: ${t.progress||0}%)` +
          (t.subtasks?.length ? `\n  세부: ${t.subtasks.map(s=>`${s.title}(${statusLabel(s.status)})`).join(', ')}` : '')
        ),
        ''
      ];
    })
  ];
  document.getElementById('ai-text').value = lines.join('\n');
  document.getElementById('ai-text-area').classList.remove('hidden');
}

function copyAIText() {
  navigator.clipboard.writeText(document.getElementById('ai-text').value).then(() => {
    document.getElementById('copy-confirm').classList.remove('hidden');
    setTimeout(() => document.getElementById('copy-confirm').classList.add('hidden'), 2000);
  });
}

// ── 달력 ──────────────────────────────────────────────
function renderCalendar() {
  document.getElementById('btn-monthly').classList.toggle('active', calendarMode === 'monthly');
  document.getElementById('btn-weekly').classList.toggle('active', calendarMode === 'weekly');
  calendarMode === 'monthly' ? renderMonthly() : renderWeekly();
}

function switchCalendar(mode) { calendarMode = mode; renderCalendar(); }
function prevPeriod() { calendarMode === 'monthly' ? calendarDate.setMonth(calendarDate.getMonth()-1) : calendarDate.setDate(calendarDate.getDate()-7); renderCalendar(); }
function nextPeriod() { calendarMode === 'monthly' ? calendarDate.setMonth(calendarDate.getMonth()+1) : calendarDate.setDate(calendarDate.getDate()+7); renderCalendar(); }

function renderMonthly() {
  const y = calendarDate.getFullYear(), m = calendarDate.getMonth();
  document.getElementById('calendar-title').textContent = `${y}년 ${m+1}월`;
  const last     = new Date(y, m+1, 0);
  const todayStr = today();
  const tasks    = getContextTasks();
  const days     = ['일','월','화','수','목','금','토'];

  let html = `<div class="monthly-grid">${days.map(d=>`<div class="cal-day-header">${d}</div>`).join('')}`;
  for (let i = 0; i < new Date(y, m, 1).getDay(); i++) html += `<div class="cal-day other-month"></div>`;
  for (let d = 1; d <= last.getDate(); d++) {
    const dateStr   = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const dayTasks  = tasks.filter(t => t.dueDate === dateStr);
    const isToday   = dateStr === todayStr;
    const isWeekend = [0,6].includes(new Date(y,m,d).getDay());
    html += `<div class="cal-day ${isToday?'today':''}">
      <div class="cal-day-num" style="color:${isWeekend?'#e17055':''}">${d}</div>
      ${dayTasks.slice(0,3).map(t => {
        const urgent = dday(t.dueDate) !== null && dday(t.dueDate) <= 3 && t.status !== 'completed';
        return `<div class="cal-task-dot" style="background:${urgent?'#ffe5d0':'#f1f3f5'};color:${urgent?'#e17055':'#636e72'};opacity:${t.status==='completed'?0.4:1}"
          onclick="showDetail('${t.id}')">${escHtml(t.title)}</div>`;
      }).join('')}
      ${dayTasks.length > 3 ? `<div style="font-size:9px;color:#b2bec3">+${dayTasks.length-3}</div>` : ''}
    </div>`;
  }
  html += '</div>';
  document.getElementById('calendar-body').innerHTML = html;
}

function renderWeekly() {
  const base = new Date(calendarDate);
  base.setDate(base.getDate() - base.getDay());
  const todayStr = today();
  const tasks    = getContextTasks();
  const days     = ['일','월','화','수','목','금','토'];
  const end      = new Date(base); end.setDate(end.getDate()+6);
  document.getElementById('calendar-title').textContent = `${base.getMonth()+1}/${base.getDate()} ~ ${end.getMonth()+1}/${end.getDate()}`;

  let html = '<div class="weekly-grid">';
  for (let i = 0; i < 7; i++) {
    const d = new Date(base); d.setDate(d.getDate()+i);
    const dateStr  = d.toISOString().slice(0,10);
    const isToday  = dateStr === todayStr;
    const dayTasks = tasks.filter(t => t.dueDate === dateStr);
    html += `<div class="week-day-col">
      <div class="week-day-header ${isToday?'today-col':''}">${days[i]}<br>${d.getDate()}</div>
      ${dayTasks.map(t => {
        const urgent = dday(t.dueDate) !== null && dday(t.dueDate) <= 3 && t.status !== 'completed';
        return `<div class="week-task-item" style="background:${urgent?'#ffe5d0':'#f1f3f5'};color:${urgent?'#e17055':'#636e72'};opacity:${t.status==='completed'?0.4:1}"
          onclick="showDetail('${t.id}')">${escHtml(t.title)}</div>`;
      }).join('')}
    </div>`;
  }
  html += '</div>';
  document.getElementById('calendar-body').innerHTML = html;
}

// ── 프로젝트 관리 모달 ────────────────────────────────
function openProjectModal() {
  renderProjectModal();
  document.getElementById('project-modal').classList.remove('hidden');
}

function closeProjectModal() {
  document.getElementById('project-modal').classList.add('hidden');
}

function renderProjectModal() {
  const el = document.getElementById('project-list-modal');
  if (!db.projects || db.projects.length === 0) {
    el.innerHTML = `<div class="empty-state" style="padding:20px 0">프로젝트가 없어요</div>`; return;
  }
  el.innerHTML = db.projects.map(p => {
    const count = (p.tasks || []).length;
    return `<div class="project-modal-item">
      <span class="proj-color-dot" style="background:${p.color}"></span>
      <span class="proj-item-name">${escHtml(p.name)}</span>
      <span class="proj-item-count">${count}건</span>
      <button class="btn-danger" style="padding:4px 10px;font-size:12px" onclick="deleteProject('${p.id}')">삭제</button>
    </div>`;
  }).join('');
}

function addProject() {
  const nameInput  = document.getElementById('new-project-name');
  const colorInput = document.getElementById('new-project-color');
  const name = nameInput.value.trim();
  if (!name) { showToast('프로젝트명을 입력해주세요'); return; }
  if (!db.projects) db.projects = [];
  db.projects.push({ id: uid(), name, color: colorInput.value, categories: [], tasks: [] });
  nameInput.value = '';
  saveData().then(() => { renderProjectModal(); renderProjectTabs(); showToast('프로젝트 추가됐어요'); });
}

function deleteProject(id) {
  const proj  = getProject(id);
  if (!proj) return;
  const count = (proj.tasks || []).length;
  if (count > 0 && !confirm(`"${proj.name}" 프로젝트와 업무 ${count}건을 삭제할까요?`)) return;
  db.projects = db.projects.filter(p => p.id !== id);
  if (currentProjectId === id) currentProjectId = null;
  saveData().then(() => { renderProjectModal(); renderAll(); });
}

// ── AI 모달 ───────────────────────────────────────────
function showAiModal(title, content, actions = []) {
  document.getElementById('ai-modal-title').textContent = title;
  document.getElementById('ai-modal-content').innerHTML = content;
  aiModalActions = actions;
  document.getElementById('ai-modal-actions').innerHTML = actions.map((a, i) =>
    `<button class="btn-${a.type||'secondary'}" onclick="aiModalActions[${i}].fn()">${escHtml(a.label)}</button>`
  ).join('');
  document.getElementById('ai-modal').classList.remove('hidden');
}

function closeAiModal() {
  document.getElementById('ai-modal').classList.add('hidden');
  aiModalActions = [];
}

// ── Groq API ──────────────────────────────────────────
async function callClaude(prompt, system) {
  if (!claudeKey) claudeKey = localStorage.getItem('claude_key') || '';
  if (!claudeKey) { showToast('Groq API 키를 설정에서 입력해주세요'); throw new Error('no key'); }
  if (!system) system = '당신은 업무 관리 도우미입니다. 한국어로 간결하게 답변하세요.';

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${claudeKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: prompt }
      ],
      max_tokens: 1024
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `API 오류 (${res.status})`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// ── AI 기능 ───────────────────────────────────────────
async function aiBreakdownTask() {
  const title = document.getElementById('form-title').value.trim();
  if (!title) { showToast('먼저 업무명을 입력해주세요'); return; }
  showAiModal('AI 세부업무 생성 중', `<div class="ai-loading">분석 중...</div>`);
  try {
    const result = await callClaude(
      `업무: "${title}"\n이 업무를 3~5개의 구체적인 세부 업무로 나눠줘. 각 항목을 "- 세부업무명" 형식으로만 작성해.`,
      '당신은 업무 분류 전문가입니다. 세부업무명만 간결하게 작성하세요.'
    );
    const subtasks = result.split('\n').map(l => l.replace(/^[-*\d.]+\s*/, '').trim()).filter(l => l.length > 2);
    showAiModal('AI 세부업무 제안', `<div class="ai-result">${escHtml(result)}</div>`, [
      { label: '이 세부업무 추가하기', type: 'primary', fn: () => {
        subtasks.forEach(t => addSubtaskRow({ title: t }));
        distributeSubtaskDates();
        closeAiModal();
        showToast(`${subtasks.length}개 세부업무를 추가했어요`);
      }},
      { label: '닫기', fn: closeAiModal }
    ]);
  } catch (e) {
    showAiModal('오류', `<div class="ai-result">요청 실패: ${e.message}</div>`, [{ label: '닫기', fn: closeAiModal }]);
  }
}

async function aiSuggestPriority() {
  const title = document.getElementById('form-title').value.trim();
  const desc  = document.getElementById('form-desc').value.trim();
  const due   = document.getElementById('form-due').value;
  if (!title) { showToast('업무명을 먼저 입력해주세요'); return; }
  showAiModal('AI 중요도 추천 중', `<div class="ai-loading">분석 중...</div>`);
  try {
    const result = await callClaude(
      `업무: "${title}"\n내용: "${desc}"\n마감일: ${due||'미정'}\n\n이 업무의 우선순위를 high/medium/low 중 하나로 추천하고 이유를 2문장으로 설명해줘. 첫 줄에 high, medium, low 중 하나만 적어.`,
      '당신은 업무 우선순위 전문가입니다.'
    );
    const lines  = result.trim().split('\n');
    const sugPri = ['high','medium','low'].find(p => lines[0].toLowerCase().includes(p)) || 'medium';
    showAiModal('AI 중요도 추천', `<div class="ai-result">${escHtml(result)}</div>`, [
      { label: `"${priorityLabel(sugPri)}"으로 설정`, type: 'primary', fn: () => {
        document.getElementById('form-priority').value = sugPri;
        closeAiModal();
      }},
      { label: '닫기', fn: closeAiModal }
    ]);
  } catch (e) {
    showAiModal('오류', `<div class="ai-result">요청 실패: ${e.message}</div>`, [{ label: '닫기', fn: closeAiModal }]);
  }
}

async function aiSummarizeProgress() {
  const tasks = getContextTasks();
  if (tasks.length === 0) { showToast('업무가 없어요'); return; }
  const summaryEl = document.getElementById('ai-summary-result');
  summaryEl.innerHTML = '<div class="ai-loading">분석 중...</div>';
  summaryEl.classList.remove('hidden');
  const todayStr  = today();
  const taskLines = tasks.slice(0, 30).map(t =>
    `- [${statusLabel(t.status)}][${priorityLabel(t.priority)}] ${t.title} (마감: ${t.dueDate||'미정'}, 진행: ${t.progress||0}%)`
  ).join('\n');
  try {
    const result = await callClaude(
      `오늘: ${todayStr}\n\n업무 목록:\n${taskLines}\n\n위 업무의 진행 상황을 분석해서:\n1. 전반적 진행 평가\n2. 주의 필요한 업무\n3. 이번 주 우선순위 제안`,
      '당신은 프로젝트 매니저입니다. 실용적인 조언을 한국어로 제공하세요.'
    );
    summaryEl.innerHTML = `<div class="ai-result">${escHtml(result)}</div>`;
  } catch (e) {
    summaryEl.innerHTML = `<div class="ai-result">요청 실패: ${e.message}</div>`;
  }
}

async function aiOrganizeMemos() {
  if (!db.quickMemos || db.quickMemos.length === 0) { showToast('정리할 메모가 없어요'); return; }
  showAiModal('AI 메모 정리 중', `<div class="ai-loading">분석 중...</div>`);
  const memoTexts = db.quickMemos.map((m, i) => `${i+1}. ${m.content}`).join('\n');
  try {
    const result = await callClaude(
      `아래 메모들을 분석해서 업무로 전환할 항목 제안, 카테고리별 그룹화, 우선순위를 정리해줘.\n\n메모:\n${memoTexts}`,
      '당신은 업무 정리 전문가입니다.'
    );
    showAiModal('AI 메모 정리 결과', `<div class="ai-result">${escHtml(result)}</div>`, [
      { label: '닫기', fn: closeAiModal }
    ]);
  } catch (e) {
    showAiModal('오류', `<div class="ai-result">요청 실패: ${e.message}</div>`, [{ label: '닫기', fn: closeAiModal }]);
  }
}

// ── 유틸 ──────────────────────────────────────────────
function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function show(id) { document.getElementById(id)?.classList.remove('hidden'); }
function hide(id) { document.getElementById(id)?.classList.add('hidden'); }

function showToast(msg, duration = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), duration);
}
