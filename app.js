// =============================================
// 설정 및 초기화
// =============================================
const GIST_ID = '3b62f1c184e665d934e29facbcceee45';
const GIST_FILENAME = 'companytasks.json';

let db = { tasks: [], quickMemos: [], categories: ['기획', '보고', '미팅', '개발', '기타'] };
let currentPage = 'dashboard';
let pageHistory = [];
let calendarMode = 'monthly';
let calendarDate = new Date();
let editingSubtasks = [];

// =============================================
// 초기 실행
// =============================================
window.onload = async () => {
  const token = localStorage.getItem('gh_token');
  if (!token) {
    show('setup-screen');
    document.getElementById('setup-gist').value = GIST_ID;
  } else {
    show('app');
    await loadData();
    navigate('dashboard');
  }
};

// 앱으로 돌아왔을 때 자동 동기화 (모바일 탭 전환 등)
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && localStorage.getItem('gh_token')) {
    await loadData();
    renderCurrentPage();
  }
});

async function saveSetup() {
  const token = document.getElementById('setup-token').value.trim();
  const gist = document.getElementById('setup-gist').value.trim();
  if (!token || !gist) {
    document.getElementById('setup-error').textContent = '토큰과 Gist ID를 모두 입력해주세요.';
    return;
  }
  localStorage.setItem('gh_token', token);
  hide('setup-screen');
  show('app');
  await loadData();
  navigate('dashboard');
}

// =============================================
// GitHub Gist API
// =============================================
function getToken() { return localStorage.getItem('gh_token'); }

async function loadData() {
  try {
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}?t=${Date.now()}`, {
      headers: { Authorization: `token ${getToken()}`, Accept: 'application/vnd.github.v3+json' }
    });
    if (!res.ok) throw new Error('불러오기 실패');
    const gist = await res.json();
    const content = gist.files[GIST_FILENAME]?.content;
    if (content && content.trim() !== '{}' && content.trim() !== '') {
      const gistDb = JSON.parse(content);
      if (!gistDb.tasks) gistDb.tasks = [];
      if (!gistDb.quickMemos) gistDb.quickMemos = [];
      if (!gistDb.categories) gistDb.categories = ['기획', '보고', '미팅', '개발', '기타'];
      const pending = getPendingDb();
      if (pending && pending.lastUpdated && (!gistDb.lastUpdated || pending.lastUpdated > gistDb.lastUpdated)) {
        db = gistDb;
        showPendingBanner();
      } else {
        db = gistDb;
        clearPendingDb();
      }
      // Gist 로드 성공 시 last_known_db 갱신
      localStorage.setItem('last_known_db', JSON.stringify(db));
    }
    showToast('데이터를 불러왔어요');
  } catch (e) {
    // Gist 로드 실패 시 last_known_db로 fallback
    const lastKnown = localStorage.getItem('last_known_db');
    if (lastKnown) {
      db = JSON.parse(lastKnown);
      if (!db.tasks) db.tasks = [];
      if (!db.quickMemos) db.quickMemos = [];
      if (!db.categories) db.categories = ['기획', '보고', '미팅', '개발', '기타'];
      showToast('⚠️ 오프라인 상태예요. 마지막 저장 데이터를 표시합니다');
    } else {
      showToast('데이터 로드 실패: 네트워크를 확인해주세요');
    }
  }
}

async function saveData() {
  try {
    db.lastUpdated = new Date().toISOString();
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: 'PATCH',
      headers: {
        Authorization: `token ${getToken()}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ files: { [GIST_FILENAME]: { content: JSON.stringify(db, null, 2) } } })
    });
    if (!res.ok) throw new Error('저장 실패');
    clearPendingDb();
    // Gist 저장 성공 시 last_known_db 갱신
    localStorage.setItem('last_known_db', JSON.stringify(db));
    showToast('저장됐어요 ✓');
  } catch (e) {
    // Gist 저장 실패 시 localStorage에 임시 저장
    db.lastUpdated = new Date().toISOString();
    localStorage.setItem('pending_db', JSON.stringify(db));
    showToast('⚠️ 임시 저장됐어요 (네트워크 연결 시 동기화 필요)');
  }
}

async function syncData() {
  await loadData();
  renderCurrentPage();
}

// 임시 저장 관련 함수
function getPendingDb() {
  const raw = localStorage.getItem('pending_db');
  return raw ? JSON.parse(raw) : null;
}

function clearPendingDb() {
  localStorage.removeItem('pending_db');
  hidePendingBanner();
}

function showPendingBanner() {
  let banner = document.getElementById('pending-banner');
  if (!banner) return;
  banner.classList.remove('hidden');
}

function hidePendingBanner() {
  const banner = document.getElementById('pending-banner');
  if (banner) banner.classList.add('hidden');
}

async function syncPendingData() {
  const pending = getPendingDb();
  if (!pending) return;
  db = pending;
  try {
    db.lastUpdated = new Date().toISOString();
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: 'PATCH',
      headers: {
        Authorization: `token ${getToken()}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ files: { [GIST_FILENAME]: { content: JSON.stringify(db, null, 2) } } })
    });
    if (!res.ok) throw new Error('동기화 실패');
    clearPendingDb();
    renderCurrentPage();
    showToast('동기화 완료! ✓');
  } catch (e) {
    showToast('동기화 실패: 네트워크를 확인해주세요');
  }
}

function logout() {
  if (confirm('토큰 설정을 초기화할까요? 다시 토큰을 입력해야 해요.')) {
    localStorage.clear();
    location.reload();
  }
}

// =============================================
// 네비게이션
// =============================================
function navigate(page, push = true) {
  if (push && currentPage !== page) pageHistory.push(currentPage);
  currentPage = page;

  document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
  show('page-' + page);

  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const navBtn = document.querySelector(`[data-page="${page}"]`);
  if (navBtn) navBtn.classList.add('active');

  const titles = {
    dashboard: '대시보드', calendar: '일정표', tasks: '업무 목록',
    completed: '완료 업무', memo: '빠른 메모', stats: '업무 통계',
    detail: '업무 상세', form: '업무 등록'
  };
  document.getElementById('header-title').textContent = titles[page] || '';
  renderCurrentPage();
}

function goBack() {
  const prev = pageHistory.pop() || 'dashboard';
  navigate(prev, false);
}

function renderCurrentPage() {
  if (currentPage === 'dashboard') renderDashboard();
  else if (currentPage === 'calendar') renderCalendar();
  else if (currentPage === 'tasks') renderTaskList();
  else if (currentPage === 'completed') renderCompleted();
  else if (currentPage === 'memo') renderMemos();
  else if (currentPage === 'stats') renderStats();
}

// =============================================
// 유틸
// =============================================
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }

function calcSubtaskProgress(task) {
  if (!task.subtasks || task.subtasks.length === 0) return null;
  const total = task.subtasks.reduce((sum, s) => sum + (s.progress || 0), 0);
  return Math.round(total / task.subtasks.length);
}
function today() { return new Date().toISOString().slice(0, 10); }
function show(id) { document.getElementById(id)?.classList.remove('hidden'); }
function hide(id) { document.getElementById(id)?.classList.add('hidden'); }

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 2500);
}

function priorityLabel(p) { return { high: '높음', medium: '중간', low: '낮음' }[p] || p; }
function priorityBadgeClass(p) { return { high: 'badge-red', medium: 'badge-yellow', low: 'badge-green' }[p] || 'badge-gray'; }
function statusLabel(s) { return { todo: '시작 전', 'in-progress': '진행 중', completed: '완료' }[s] || s; }

function getDday(dueDate) {
  if (!dueDate) return null;
  const diff = Math.ceil((new Date(dueDate) - new Date(today())) / 86400000);
  if (diff < 0) return { label: `D+${Math.abs(diff)}`, cls: 'badge-gray', delayed: true };
  if (diff === 0) return { label: 'D-Day', cls: 'badge-red' };
  if (diff <= 3) return { label: `D-${diff}`, cls: 'badge-orange' };
  return { label: `D-${diff}`, cls: 'badge-blue' };
}

function getActiveTasks() { return db.tasks.filter(t => t.status !== 'completed'); }
function getCompletedTasks() { return db.tasks.filter(t => t.status === 'completed'); }

// =============================================
// 대시보드
// =============================================
function renderDashboard() {
  const all = db.tasks;
  const active = getActiveTasks();
  const done = getCompletedTasks();
  const delayed = active.filter(t => t.dueDate && t.dueDate < today());

  document.getElementById('stat-total').textContent = all.length;
  document.getElementById('stat-inprogress').textContent = active.filter(t => t.status === 'in-progress').length;
  document.getElementById('stat-delayed').textContent = delayed.length;
  document.getElementById('stat-done').textContent = done.length;

  renderWarnings(active);
  renderTodayTodos(active);
}

function renderWarnings(active) {
  const warnings = [];

  // 중복 업무 감지
  const titles = active.map(t => t.title.trim().toLowerCase());
  const dupes = titles.filter((t, i) => titles.indexOf(t) !== i);
  if (dupes.length > 0) {
    warnings.push({ msg: `유사한 업무명이 감지됐어요: "${dupes[0]}" - 중복 여부를 확인해보세요.`, danger: false });
  }

  // 날짜 과부하 감지 (같은 날 마감 3건 이상)
  const dateCounts = {};
  active.forEach(t => {
    if (t.dueDate) dateCounts[t.dueDate] = (dateCounts[t.dueDate] || 0) + 1;
    (t.subtasks || []).forEach(s => {
      if (s.dueDate) dateCounts[s.dueDate] = (dateCounts[s.dueDate] || 0) + 1;
    });
  });
  Object.entries(dateCounts).forEach(([date, cnt]) => {
    if (cnt >= 3) warnings.push({ msg: `${date}에 마감 업무가 ${cnt}건 몰려 있어요. 일정 분산을 검토해보세요.`, danger: false });
  });

  // 고우선순위 낮은 진행률
  active.filter(t => t.priority === 'high' && (t.progress || 0) < 20 && t.dueDate && t.dueDate <= addDays(today(), 7))
    .forEach(t => warnings.push({ msg: `중요도 높음인 "${t.title}" 업무가 진행률 ${t.progress || 0}%로 마감이 다가오고 있어요.`, danger: true }));

  const el = document.getElementById('warnings-area');
  el.innerHTML = warnings.map(w =>
    `<div class="warning-item${w.danger ? ' danger' : ''}">${w.msg}</div>`
  ).join('');
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function renderTodayTodos(active) {
  const todayStr = today();
  const items = [];

  active.forEach(task => {
    const subs = (task.subtasks || []).filter(s => s.status !== 'completed');
    if (subs.length === 0) {
      // 세부 업무 없으면 메인 업무 표시
      if (task.dueDate <= addDays(todayStr, 3) || task.priority === 'high') {
        items.push({ task, sub: null });
      }
    } else {
      // 세부 업무 있으면 세부 업무 표시
      subs.forEach(s => {
        if (!s.dueDate || s.dueDate <= addDays(todayStr, 3) || s.priority === 'high' || task.priority === 'high') {
          items.push({ task, sub: s });
        }
      });
    }
  });

  // 정렬: 마감일 빠른 순 → 중요도 순
  items.sort((a, b) => {
    const aDate = (a.sub?.dueDate || a.task.dueDate || '9999');
    const bDate = (b.sub?.dueDate || b.task.dueDate || '9999');
    if (aDate !== bDate) return aDate.localeCompare(bDate);
    const pOrder = { high: 0, medium: 1, low: 2 };
    return (pOrder[a.sub?.priority || a.task.priority] || 1) - (pOrder[b.sub?.priority || b.task.priority] || 1);
  });

  const el = document.getElementById('today-todos');
  if (items.length === 0) {
    el.innerHTML = '<div class="empty-state">오늘 처리할 업무가 없어요 🎉</div>';
    return;
  }

  el.innerHTML = items.map(({ task, sub }) => {
    const priority = sub?.priority || task.priority;
    const dueDate = sub?.dueDate || task.dueDate;
    const dday = getDday(dueDate);
    const title = sub ? sub.title : task.title;
    return `
      <div class="todo-item" onclick="showDetail('${task.id}')">
        <div class="todo-priority-bar priority-${priority}"></div>
        <div class="todo-body">
          ${sub ? `<div class="todo-parent">📁 ${task.title}</div>` : ''}
          <div class="todo-title">${title}</div>
          <div class="todo-meta">
            <span class="badge ${priorityBadgeClass(priority)}">${priorityLabel(priority)}</span>
            ${dday ? `<span class="badge ${dday.cls}">${dday.label}</span>` : ''}
            ${dueDate ? `<span class="badge badge-gray">${dueDate}</span>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');
}

// =============================================
// 일정표
// =============================================
function switchCalendar(mode) {
  calendarMode = mode;
  document.getElementById('btn-monthly').classList.toggle('active', mode === 'monthly');
  document.getElementById('btn-weekly').classList.toggle('active', mode === 'weekly');
  renderCalendar();
}

function prevPeriod() {
  if (calendarMode === 'monthly') calendarDate.setMonth(calendarDate.getMonth() - 1);
  else calendarDate.setDate(calendarDate.getDate() - 7);
  renderCalendar();
}

function nextPeriod() {
  if (calendarMode === 'monthly') calendarDate.setMonth(calendarDate.getMonth() + 1);
  else calendarDate.setDate(calendarDate.getDate() + 7);
  renderCalendar();
}

function renderCalendar() {
  if (calendarMode === 'monthly') renderMonthly();
  else renderWeekly();
}

function getAllTaskDates() {
  const map = {};
  db.tasks.forEach(task => {
    const dates = [];
    if (task.dueDate) dates.push(task.dueDate);
    (task.subtasks || []).forEach(s => { if (s.dueDate) dates.push(s.dueDate); });
    dates.forEach(d => {
      if (!map[d]) map[d] = [];
      map[d].push(task);
    });
  });
  return map;
}

function renderMonthly() {
  const y = calendarDate.getFullYear();
  const m = calendarDate.getMonth();
  document.getElementById('calendar-title').textContent = `${y}년 ${m + 1}월`;

  const taskMap = getAllTaskDates();
  const firstDay = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const daysInPrevMonth = new Date(y, m, 0).getDate();
  const todayStr = today();
  const days = ['일', '월', '화', '수', '목', '금', '토'];

  let html = `<div class="monthly-grid">`;
  days.forEach(d => { html += `<div class="cal-day-header">${d}</div>`; });

  // 이전 달 빈칸
  for (let i = 0; i < firstDay; i++) {
    const d = daysInPrevMonth - firstDay + 1 + i;
    html += `<div class="cal-day other-month"><div class="cal-day-num">${d}</div></div>`;
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const isToday = dateStr === todayStr;
    const tasks = taskMap[dateStr] || [];
    const pColors = { high: '#ffe0e0', medium: '#fff3cd', low: '#d4edda' };
    html += `<div class="cal-day${isToday ? ' today' : ''}" onclick="showDetail('${tasks[0]?.id || ''}')">
      <div class="cal-day-num">${d}</div>
      ${tasks.slice(0, 2).map(t =>
        `<div class="cal-task-dot" style="background:${pColors[t.priority] || '#f1f3f5'};color:#2d3436">${t.title}</div>`
      ).join('')}
      ${tasks.length > 2 ? `<div style="font-size:10px;color:#636e72">+${tasks.length - 2}건</div>` : ''}
    </div>`;
  }

  // 남은 칸
  const remaining = 42 - firstDay - daysInMonth;
  for (let d = 1; d <= remaining; d++) {
    html += `<div class="cal-day other-month"><div class="cal-day-num">${d}</div></div>`;
  }

  html += '</div>';
  document.getElementById('calendar-body').innerHTML = html;
}

function renderWeekly() {
  const d = new Date(calendarDate);
  const day = d.getDay();
  d.setDate(d.getDate() - day); // 일요일 시작
  const taskMap = getAllTaskDates();
  const todayStr = today();
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];

  let titleStart = `${d.getMonth() + 1}/${d.getDate()}`;
  const end = new Date(d); end.setDate(end.getDate() + 6);
  let titleEnd = `${end.getMonth() + 1}/${end.getDate()}`;
  document.getElementById('calendar-title').textContent = `${titleStart} - ${titleEnd}`;

  const pColors = { high: '#ffe0e0', medium: '#fff3cd', low: '#d4edda' };
  let html = '<div class="weekly-grid">';

  for (let i = 0; i < 7; i++) {
    const cur = new Date(d); cur.setDate(cur.getDate() + i);
    const dateStr = cur.toISOString().slice(0, 10);
    const isToday = dateStr === todayStr;
    const tasks = taskMap[dateStr] || [];
    html += `<div class="week-day-col">
      <div class="week-day-header${isToday ? ' today-col' : ''}">${dayNames[i]}<br>${cur.getDate()}</div>
      ${tasks.map(t =>
        `<div class="week-task-item" style="background:${pColors[t.priority] || '#f1f3f5'}" onclick="showDetail('${t.id}')">${t.title}</div>`
      ).join('')}
    </div>`;
  }

  html += '</div>';
  document.getElementById('calendar-body').innerHTML = html;
}

// =============================================
// 업무 목록
// =============================================
function renderTaskList() {
  const pFilter = document.getElementById('filter-priority').value;
  const sFilter = document.getElementById('filter-status').value;
  const cFilter = document.getElementById('filter-category').value;

  // 카테고리 옵션 업데이트
  const cats = [...new Set(db.tasks.map(t => t.category).filter(Boolean))];
  const catSel = document.getElementById('filter-category');
  const curCat = catSel.value;
  catSel.innerHTML = '<option value="">전체 카테고리</option>' +
    cats.map(c => `<option value="${c}" ${c === curCat ? 'selected' : ''}>${c}</option>`).join('');

  let tasks = getActiveTasks();
  if (pFilter) tasks = tasks.filter(t => t.priority === pFilter);
  if (sFilter) tasks = tasks.filter(t => t.status === sFilter);
  if (cFilter) tasks = tasks.filter(t => t.category === cFilter);

  tasks.sort((a, b) => {
    const pOrder = { high: 0, medium: 1, low: 2 };
    if (pOrder[a.priority] !== pOrder[b.priority]) return pOrder[a.priority] - pOrder[b.priority];
    return (a.dueDate || '').localeCompare(b.dueDate || '');
  });

  const el = document.getElementById('task-list');
  if (tasks.length === 0) {
    el.innerHTML = '<div class="empty-state">업무가 없어요</div>';
    return;
  }

  el.innerHTML = tasks.map(t => {
    const dday = getDday(t.dueDate);
    return `
      <div class="task-card" onclick="showDetail('${t.id}')">
        <div class="todo-priority-bar priority-${t.priority}" style="align-self:stretch;width:4px;border-radius:4px;flex-shrink:0"></div>
        <div class="task-card-body">
          <div class="task-title">${t.title}</div>
          <div class="task-meta">
            <span class="badge ${priorityBadgeClass(t.priority)}">${priorityLabel(t.priority)}</span>
            <span class="badge badge-gray">${statusLabel(t.status)}</span>
            ${t.category ? `<span class="badge badge-blue">${t.category}</span>` : ''}
            ${dday ? `<span class="badge ${dday.cls}">${dday.label}</span>` : ''}
            ${t.dueDate ? `<span class="badge badge-gray">${t.dueDate}</span>` : ''}
          </div>
          <div class="task-progress-wrap">
            <div class="task-progress-bar"><div class="task-progress-fill" style="width:${t.progress || 0}%"></div></div>
            <span class="task-progress-text">${t.progress || 0}%</span>
          </div>
        </div>
      </div>`;
  }).join('');
}

// =============================================
// 완료 업무
// =============================================
function renderCompleted() {
  const tasks = getCompletedTasks().sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''));
  const el = document.getElementById('completed-list');
  if (tasks.length === 0) {
    el.innerHTML = '<div class="empty-state">완료된 업무가 없어요</div>';
    return;
  }
  el.innerHTML = tasks.map(t => `
    <div class="completed-card">
      <div class="task-meta">
        <span class="badge ${priorityBadgeClass(t.priority)}">${priorityLabel(t.priority)}</span>
        ${t.category ? `<span class="badge badge-blue">${t.category}</span>` : ''}
      </div>
      <div class="task-title">${t.title}</div>
      <div class="completed-date">완료일: ${t.completedAt ? t.completedAt.slice(0, 10) : '-'}</div>
      <div style="margin-top:10px;display:flex;gap:8px">
        <button class="btn-success" onclick="reopenTask('${t.id}')">재개</button>
        <button class="btn-secondary" onclick="showDetail('${t.id}')">상세</button>
      </div>
    </div>`).join('');
}

async function reopenTask(id) {
  const t = db.tasks.find(t => t.id === id);
  if (!t) return;
  t.status = 'in-progress';
  t.completedAt = null;
  await saveData();
  renderCompleted();
  showToast('업무를 재개했어요');
}

// =============================================
// 빠른 메모
// =============================================
function renderMemos() {
  const el = document.getElementById('memo-list');
  const memos = [...(db.quickMemos || [])].reverse();
  if (memos.length === 0) {
    el.innerHTML = '<div class="empty-state">메모가 없어요</div>';
    return;
  }
  el.innerHTML = memos.map(m => `
    <div class="memo-item" id="memo-${m.id}">
      <div class="memo-item-text">${m.content.replace(/\n/g, '<br>')}</div>
      <div class="memo-item-date">${m.createdAt.slice(0, 16).replace('T', ' ')}</div>
      <div class="memo-item-actions">
        <button class="btn-secondary" onclick="convertMemoToTask('${m.id}')">업무로 전환</button>
        <button class="btn-secondary" onclick="showSubtaskSelect('${m.id}')">세부업무로 전환</button>
        <button class="btn-danger" onclick="deleteMemo('${m.id}')">삭제</button>
      </div>
      <div id="subtask-select-${m.id}" class="subtask-select-area hidden">
        <select id="subtask-task-select-${m.id}">
          <option value="">업무 선택...</option>
          ${db.tasks.filter(t => t.status !== 'completed').map(t => `<option value="${t.id}">${t.title}</option>`).join('')}
        </select>
        <button class="btn-primary" onclick="convertMemoToSubtask('${m.id}')">확인</button>
        <button class="btn-secondary" onclick="hideSubtaskSelect('${m.id}')">취소</button>
      </div>
    </div>`).join('');
}

async function addQuickMemo() {
  const input = document.getElementById('memo-input');
  const content = input.value.trim();
  if (!content) return;
  if (!db.quickMemos) db.quickMemos = [];
  db.quickMemos.push({ id: uid(), content, createdAt: new Date().toISOString() });
  input.value = '';
  await saveData();
  renderMemos();
}

async function deleteMemo(id) {
  db.quickMemos = db.quickMemos.filter(m => m.id !== id);
  await saveData();
  renderMemos();
}

function convertMemoToTask(id) {
  const memo = db.quickMemos.find(m => m.id === id);
  if (!memo) return;
  showAddTask(memo.content);
}

function showSubtaskSelect(memoId) {
  document.getElementById(`subtask-select-${memoId}`).classList.remove('hidden');
}

function hideSubtaskSelect(memoId) {
  document.getElementById(`subtask-select-${memoId}`).classList.add('hidden');
}

async function convertMemoToSubtask(memoId) {
  const taskId = document.getElementById(`subtask-task-select-${memoId}`).value;
  if (!taskId) { showToast('업무를 선택해주세요'); return; }
  const memo = db.quickMemos.find(m => m.id === memoId);
  const task = db.tasks.find(t => t.id === taskId);
  if (!memo || !task) return;
  if (!task.subtasks) task.subtasks = [];
  task.subtasks.push({ id: uid(), title: memo.content, priority: 'medium', dueDate: '', status: 'todo', progress: 0, memos: [] });
  db.quickMemos = db.quickMemos.filter(m => m.id !== memoId);
  await saveData();
  renderMemos();
  showToast(`"${task.title}"의 세부업무로 추가됐어요`);
}

// =============================================
// 업무 통계
// =============================================
function renderStats() {
  const all = db.tasks;
  const done = getCompletedTasks();
  const active = getActiveTasks();
  const delayed = active.filter(t => t.dueDate && t.dueDate < today());
  const thisMonth = today().slice(0, 7);
  const monthDone = done.filter(t => t.completedAt && t.completedAt.slice(0, 7) === thisMonth);

  const rate = all.length ? Math.round((done.length / all.length) * 100) : 0;
  document.getElementById('stats-rate').textContent = rate + '%';
  document.getElementById('stats-rate-bar').style.width = rate + '%';
  document.getElementById('stats-delayed').textContent = delayed.length + '건';
  document.getElementById('stats-month-done').textContent = monthDone.length + '건';
  document.getElementById('stats-inprogress').textContent = active.filter(t => t.status === 'in-progress').length + '건';

  // 카테고리별
  const catMap = {};
  db.tasks.forEach(t => {
    const c = t.category || '미분류';
    catMap[c] = (catMap[c] || 0) + 1;
  });
  const maxCat = Math.max(...Object.values(catMap), 1);
  document.getElementById('stats-category').innerHTML = Object.entries(catMap)
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `
      <div class="category-bar-item">
        <div class="category-bar-label"><span>${c}</span><span>${n}건</span></div>
        <div class="category-bar-track"><div class="category-bar-fill" style="width:${Math.round(n / maxCat * 100)}%"></div></div>
      </div>`).join('');

  // 중요도별
  const pMap = { high: 0, medium: 0, low: 0 };
  db.tasks.forEach(t => { if (pMap[t.priority] !== undefined) pMap[t.priority]++; });
  const maxP = Math.max(...Object.values(pMap), 1);
  const pColors = { high: '#d63031', medium: '#fdcb6e', low: '#00b894' };
  document.getElementById('stats-priority').innerHTML = Object.entries(pMap).map(([p, n]) => `
    <div class="category-bar-item">
      <div class="category-bar-label"><span>${priorityLabel(p)}</span><span>${n}건</span></div>
      <div class="category-bar-track"><div class="category-bar-fill" style="width:${Math.round(n / maxP * 100)}%;background:${pColors[p]}"></div></div>
    </div>`).join('');
}

function generateAIText() {
  const active = getActiveTasks();
  let text = `=== 업무 관리 AI 분석 요청 ===\n분석일: ${today()}\n\n`;
  text += `[전체 현황]\n- 진행 중 업무: ${active.length}건\n- 완료 업무: ${getCompletedTasks().length}건\n\n`;
  text += `[업무 목록]\n`;
  active.forEach((t, i) => {
    text += `\n${i + 1}. ${t.title}\n`;
    text += `   중요도: ${priorityLabel(t.priority)} | 마감: ${t.dueDate || '미정'} | 진행률: ${t.progress || 0}%\n`;
    if (t.description) text += `   내용: ${t.description}\n`;
    if (t.subtasks?.length) {
      text += `   세부 업무:\n`;
      t.subtasks.forEach(s => {
        text += `   - ${s.title} (${priorityLabel(s.priority)}, 마감: ${s.dueDate || '미정'}, ${s.progress || 0}%)\n`;
      });
    }
  });
  text += `\n[분석 요청 사항]\n1. 중복되거나 통합 가능한 업무가 있나요?\n2. 우선순위 조정이 필요한 업무가 있나요?\n3. 최적 업무 처리 순서를 제안해주세요.\n4. 일정상 위험 요소가 있나요?`;

  document.getElementById('ai-text').value = text;
  show('ai-text-area');
}

function copyAIText() {
  const text = document.getElementById('ai-text').value;
  navigator.clipboard.writeText(text).then(() => {
    show('copy-confirm');
    setTimeout(() => hide('copy-confirm'), 2000);
  });
}

// =============================================
// 업무 상세
// =============================================
function showDetail(id) {
  if (!id) return;
  const task = db.tasks.find(t => t.id === id);
  if (!task) return;
  navigate('detail');
  renderDetail(task);
}

function renderDetail(task) {
  const dday = getDday(task.dueDate);
  const isCompleted = task.status === 'completed';

  let html = `
    <div class="detail-header">
      <div class="detail-meta">
        <span class="badge ${priorityBadgeClass(task.priority)}">${priorityLabel(task.priority)}</span>
        <span class="badge badge-gray">${statusLabel(task.status)}</span>
        ${task.category ? `<span class="badge badge-blue">${task.category}</span>` : ''}
        ${dday ? `<span class="badge ${dday.cls}">${dday.label}</span>` : ''}
      </div>
      <div class="detail-title">${task.title}</div>
      ${task.dueDate ? `<div style="font-size:13px;color:#636e72">마감일: ${task.dueDate}</div>` : ''}
      ${task.estimatedHours ? `<div style="font-size:13px;color:#636e72">예상 소요: ${task.estimatedHours}시간</div>` : ''}
      <div style="margin-top:10px">
        ${(() => {
          const auto = calcSubtaskProgress(task);
          const progress = auto !== null ? auto : (task.progress || 0);
          return `
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <span style="font-size:12px;color:#636e72">${auto !== null ? '진행률 (세부업무 평균)' : '진행률'}</span>
            ${auto !== null ? `<span style="font-size:11px;color:#0984e3;background:#dfe6e9;padding:2px 6px;border-radius:4px">자동 계산</span>` : ''}
          </div>
          <div class="detail-progress-row">
            <div class="detail-progress-bar"><div class="detail-progress-fill" style="width:${progress}%"></div></div>
            <span style="font-size:13px;font-weight:700">${progress}%</span>
          </div>
          <div style="display:flex;align-items:center;gap:6px;margin-top:8px">
            <input type="number" id="main-progress-input-${task.id}" min="0" max="100" value="${task.progress || 0}" style="width:70px;padding:4px 8px;border:1px solid #ddd;border-radius:6px;font-size:13px">
            <button class="btn-secondary" style="font-size:12px;padding:4px 10px" onclick="updateMainProgress('${task.id}')">직접 수정</button>
          </div>`;
        })()}
      </div>
      <div class="detail-actions">
        <button class="btn-secondary" onclick="showEditTask('${task.id}')">수정</button>
        ${!isCompleted
          ? `<button class="btn-primary" onclick="completeTask('${task.id}')">완료 처리</button>`
          : `<button class="btn-success" onclick="reopenTask('${task.id}')">재개</button>`}
        <button class="btn-danger" onclick="deleteTask('${task.id}')">삭제</button>
      </div>
    </div>`;

  if (task.description) {
    html += `<div class="detail-section"><h4>업무 내용</h4><div class="detail-desc">${task.description.replace(/\n/g, '<br>')}</div></div>`;
  }

  // 메인 업무 메모
  html += `<div class="detail-section">
    <h4>메모</h4>
    ${(task.memos || []).map(m => `
      <div class="memo-entry">
        ${m.content.replace(/\n/g, '<br>')}
        <div class="memo-entry-date">${m.createdAt.slice(0, 16).replace('T', ' ')}</div>
      </div>`).join('')}
    <div class="inline-memo-form">
      <textarea id="main-memo-input" rows="2" placeholder="메모 추가..."></textarea>
      <button class="btn-secondary" onclick="addTaskMemo('${task.id}', null)">메모 저장</button>
    </div>
  </div>`;

  // 세부 업무
  if (task.subtasks && task.subtasks.length > 0) {
    html += `<div class="detail-section"><h4>세부 업무</h4>`;
    task.subtasks.forEach(s => {
      const sdday = getDday(s.dueDate);
      html += `
        <div class="subtask-item">
          <div class="subtask-header" onclick="toggleSubtask('${s.id}')">
            <div class="todo-priority-bar priority-${s.priority}" style="width:4px;height:20px;border-radius:4px;flex-shrink:0"></div>
            <div class="subtask-title">${s.title}</div>
            <span class="subtask-expand">▼</span>
          </div>
          <div class="subtask-detail" id="sub-${s.id}">
            <!-- 보기 모드 -->
            <div id="sub-view-${s.id}">
              <div class="subtask-meta">
                <span class="badge ${priorityBadgeClass(s.priority)}">${priorityLabel(s.priority)}</span>
                <span class="badge badge-gray">${statusLabel(s.status)}</span>
                ${sdday ? `<span class="badge ${sdday.cls}">${sdday.label}</span>` : ''}
                ${s.dueDate ? `<span class="badge badge-gray">${s.dueDate}</span>` : ''}
              </div>
              <div class="task-progress-wrap" style="margin-bottom:10px">
                <div class="task-progress-bar"><div class="task-progress-fill" style="width:${s.progress || 0}%"></div></div>
                <span class="task-progress-text">${s.progress || 0}%</span>
              </div>
              <button class="btn-secondary" style="margin-bottom:10px" onclick="toggleSubtaskEdit('${s.id}')">수정</button>
              ${(s.memos || []).map(m => `
                <div class="memo-entry">
                  ${m.content.replace(/\n/g, '<br>')}
                  <div class="memo-entry-date">${m.createdAt.slice(0, 16).replace('T', ' ')}</div>
                </div>`).join('')}
              <div class="inline-memo-form">
                <textarea id="sub-memo-${s.id}" rows="2" placeholder="세부 업무 메모 추가..."></textarea>
                <button class="btn-secondary" onclick="addTaskMemo('${task.id}', '${s.id}')">메모 저장</button>
              </div>
            </div>
            <!-- 수정 모드 -->
            <div id="sub-edit-${s.id}" class="hidden subtask-edit-form">
              <div class="form-group">
                <label>세부 업무명</label>
                <input type="text" id="sub-edit-title-${s.id}" value="${s.title}">
              </div>
              <div class="form-row">
                <div class="form-group">
                  <label>중요도</label>
                  <select id="sub-edit-priority-${s.id}">
                    <option value="high" ${s.priority==='high'?'selected':''}>높음</option>
                    <option value="medium" ${s.priority==='medium'?'selected':''}>중간</option>
                    <option value="low" ${s.priority==='low'?'selected':''}>낮음</option>
                  </select>
                </div>
                <div class="form-group">
                  <label>마감일</label>
                  <input type="date" id="sub-edit-due-${s.id}" value="${s.dueDate || ''}">
                </div>
              </div>
              <div class="form-row">
                <div class="form-group">
                  <label>진행 상태</label>
                  <select id="sub-edit-status-${s.id}">
                    <option value="todo" ${s.status==='todo'?'selected':''}>시작 전</option>
                    <option value="in-progress" ${s.status==='in-progress'?'selected':''}>진행 중</option>
                    <option value="completed" ${s.status==='completed'?'selected':''}>완료</option>
                  </select>
                </div>
                <div class="form-group">
                  <label>진행률 (%)</label>
                  <input type="number" id="sub-edit-progress-${s.id}" min="0" max="100" value="${s.progress || 0}">
                </div>
              </div>
              <div class="form-actions">
                <button class="btn-secondary" onclick="toggleSubtaskEdit('${s.id}')">취소</button>
                <button class="btn-primary" onclick="saveSubtaskEdit('${task.id}', '${s.id}')">저장</button>
              </div>
            </div>
          </div>
        </div>`;
    });
    html += '</div>';
  }

  document.getElementById('detail-content').innerHTML = html;
}

function toggleSubtask(subId) {
  const el = document.getElementById('sub-' + subId);
  if (el) el.classList.toggle('open');
}

function toggleSubtaskEdit(subId) {
  document.getElementById(`sub-view-${subId}`).classList.toggle('hidden');
  document.getElementById(`sub-edit-${subId}`).classList.toggle('hidden');
}

async function saveSubtaskEdit(taskId, subId) {
  const task = db.tasks.find(t => t.id === taskId);
  if (!task) return;
  const sub = task.subtasks.find(s => s.id === subId);
  if (!sub) return;
  sub.title = document.getElementById(`sub-edit-title-${subId}`).value.trim() || sub.title;
  sub.priority = document.getElementById(`sub-edit-priority-${subId}`).value;
  sub.dueDate = document.getElementById(`sub-edit-due-${subId}`).value;
  sub.status = document.getElementById(`sub-edit-status-${subId}`).value;
  sub.progress = parseInt(document.getElementById(`sub-edit-progress-${subId}`).value) || 0;
  const auto = calcSubtaskProgress(task);
  if (auto !== null) task.progress = auto;
  await saveData();
  renderDetail(task);
  showToast('세부 업무가 수정됐어요');
}

async function updateMainProgress(taskId) {
  const task = db.tasks.find(t => t.id === taskId);
  if (!task) return;
  const val = parseInt(document.getElementById(`main-progress-input-${taskId}`).value);
  if (isNaN(val) || val < 0 || val > 100) { showToast('0~100 사이 숫자를 입력해주세요'); return; }
  task.progress = val;
  await saveData();
  renderDetail(task);
  showToast('진행률이 수정됐어요');
}

async function addTaskMemo(taskId, subId) {
  const inputId = subId ? `sub-memo-${subId}` : 'main-memo-input';
  const input = document.getElementById(inputId);
  const content = input?.value.trim();
  if (!content) return;

  const task = db.tasks.find(t => t.id === taskId);
  if (!task) return;

  const memoEntry = { id: uid(), content, createdAt: new Date().toISOString() };

  if (subId) {
    const sub = task.subtasks.find(s => s.id === subId);
    if (sub) {
      if (!sub.memos) sub.memos = [];
      sub.memos.push(memoEntry);
    }
  } else {
    if (!task.memos) task.memos = [];
    task.memos.push(memoEntry);
  }

  await saveData();
  renderDetail(task);
}

async function completeTask(id) {
  const task = db.tasks.find(t => t.id === id);
  if (!task) return;
  task.status = 'completed';
  task.progress = 100;
  task.completedAt = new Date().toISOString();
  await saveData();
  goBack();
  showToast('업무를 완료했어요 ✓');
}

async function deleteTask(id) {
  if (!confirm('업무를 삭제할까요?')) return;
  db.tasks = db.tasks.filter(t => t.id !== id);
  await saveData();
  goBack();
  showToast('삭제됐어요');
}

// =============================================
// 업무 등록/수정
// =============================================
function showAddTask(prefill = '') {
  editingSubtasks = [];
  document.getElementById('form-id').value = '';
  document.getElementById('form-title').value = prefill || '';
  document.getElementById('form-desc').value = '';
  document.getElementById('form-category').value = '';
  document.getElementById('form-priority').value = 'medium';
  document.getElementById('form-due').value = '';
  document.getElementById('form-hours').value = '';
  document.getElementById('form-status').value = 'todo';
  document.getElementById('form-progress').value = '0';
  document.getElementById('form-memo').value = '';
  document.getElementById('subtask-list-form').innerHTML = '';
  updateCategoryDatalist();
  document.getElementById('header-title').textContent = '업무 등록';
  navigate('form');
}

function showEditTask(id) {
  const task = db.tasks.find(t => t.id === id);
  if (!task) return;
  editingSubtasks = (task.subtasks || []).map(s => ({ ...s }));
  document.getElementById('form-id').value = task.id;
  document.getElementById('form-title').value = task.title;
  document.getElementById('form-desc').value = task.description || '';
  document.getElementById('form-category').value = task.category || '';
  document.getElementById('form-priority').value = task.priority;
  document.getElementById('form-due').value = task.dueDate || '';
  document.getElementById('form-hours').value = task.estimatedHours || '';
  document.getElementById('form-status').value = task.status;
  document.getElementById('form-progress').value = task.progress || 0;
  document.getElementById('form-memo').value = task.memo || '';
  renderSubtaskForm();
  updateCategoryDatalist();
  document.getElementById('header-title').textContent = '업무 수정';
  navigate('form');
}

function updateCategoryDatalist() {
  const cats = [...new Set([...db.categories, ...db.tasks.map(t => t.category).filter(Boolean)])];
  document.getElementById('category-list').innerHTML = cats.map(c => `<option value="${c}">`).join('');
}

function addSubtaskRow() {
  editingSubtasks.push({ id: uid(), title: '', priority: 'medium', dueDate: '', status: 'todo', progress: 0, memos: [] });
  renderSubtaskForm();
}

function removeSubtaskRow(idx) {
  editingSubtasks.splice(idx, 1);
  renderSubtaskForm();
}

function renderSubtaskForm() {
  document.getElementById('subtask-list-form').innerHTML = editingSubtasks.map((s, i) => `
    <div class="subtask-form-row">
      <button type="button" class="subtask-remove-btn" onclick="removeSubtaskRow(${i})">×</button>
      <input type="text" placeholder="세부 업무명" value="${s.title}" oninput="editingSubtasks[${i}].title=this.value">
      <select onchange="editingSubtasks[${i}].priority=this.value">
        <option value="high" ${s.priority === 'high' ? 'selected' : ''}>높음</option>
        <option value="medium" ${s.priority === 'medium' ? 'selected' : ''}>중간</option>
        <option value="low" ${s.priority === 'low' ? 'selected' : ''}>낮음</option>
      </select>
      <input type="date" value="${s.dueDate || ''}" oninput="editingSubtasks[${i}].dueDate=this.value" placeholder="마감일">
      <select onchange="editingSubtasks[${i}].status=this.value">
        <option value="todo" ${s.status === 'todo' ? 'selected' : ''}>시작 전</option>
        <option value="in-progress" ${s.status === 'in-progress' ? 'selected' : ''}>진행 중</option>
        <option value="completed" ${s.status === 'completed' ? 'selected' : ''}>완료</option>
      </select>
    </div>`).join('');
}

async function saveTask(e) {
  e.preventDefault();
  const id = document.getElementById('form-id').value;
  const status = document.getElementById('form-status').value;

  const taskData = {
    id: id || uid(),
    title: document.getElementById('form-title').value.trim(),
    description: document.getElementById('form-desc').value.trim(),
    category: document.getElementById('form-category').value.trim(),
    priority: document.getElementById('form-priority').value,
    dueDate: document.getElementById('form-due').value,
    estimatedHours: parseFloat(document.getElementById('form-hours').value) || null,
    status,
    progress: parseInt(document.getElementById('form-progress').value) || 0,
    memo: document.getElementById('form-memo').value.trim(),
    subtasks: editingSubtasks.filter(s => s.title.trim()),
    createdAt: id ? (db.tasks.find(t => t.id === id)?.createdAt || new Date().toISOString()) : new Date().toISOString(),
    completedAt: status === 'completed' ? (db.tasks.find(t => t.id === id)?.completedAt || new Date().toISOString()) : null,
    memos: id ? (db.tasks.find(t => t.id === id)?.memos || []) : []
  };

  // 카테고리 자동 추가
  if (taskData.category && !db.categories.includes(taskData.category)) {
    db.categories.push(taskData.category);
  }

  if (id) {
    const idx = db.tasks.findIndex(t => t.id === id);
    if (idx !== -1) db.tasks[idx] = taskData;
  } else {
    db.tasks.push(taskData);
  }

  await saveData();
  goBack();
  showToast(id ? '업무를 수정했어요' : '업무를 등록했어요');
}
