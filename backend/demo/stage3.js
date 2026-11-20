const $ = selector => document.querySelector(selector);
const state = { config: null, demo: null, view: 'consultation', kind: 'consultations', admin: null, assignees: [],
  selected: null, items: [], total: 0, offset: 0, limit: 8, loading: false, keys: {}, toastTimer: null, receiptView: null };
const statusNames = { new: '신규 접수', reviewing: '검토 중', needs_info: '추가 정보 요청', proposed: '일정 제안', confirmed: '일정 확정', completed: '처리 완료', cancelled: '취소' };
const typeNames = { individual: '개인 상담', organization: '조직·팀', other: '기타 상담', general: '일반 문의', press: '언론·취재', research: '연구·자료', partnership: '협업·제휴', site_issue: '사이트 이용' };
const transitions = {
  consultations: { new: ['reviewing', 'cancelled'], reviewing: ['needs_info', 'proposed', 'cancelled'], needs_info: ['reviewing', 'cancelled'], proposed: ['reviewing', 'needs_info', 'confirmed', 'cancelled'], confirmed: ['proposed', 'completed', 'cancelled'], completed: [], cancelled: [] },
  inquiries: { new: ['reviewing', 'cancelled'], reviewing: ['needs_info', 'completed', 'cancelled'], needs_info: ['reviewing', 'completed', 'cancelled'], completed: [], cancelled: [] },
};
const errors = {
  IDEMPOTENCY_CONFLICT: '같은 접수 키에 다른 내용이 있습니다. 내용을 확인한 뒤 다시 접수해 주세요.',
  VERSION_CONFLICT: '다른 작업이 먼저 저장되었습니다. 최신 내용을 다시 불러와 확인해 주세요.',
  INVALID_STATUS_TRANSITION: '현재 상태에서 변경할 수 없는 처리 단계입니다.',
  CONFIRMED_TIME_REQUIRED: '일정을 확정하려면 미래의 확정 일시를 입력해 주세요.',
  PREFERRED_TIME_IN_PAST: '희망 일정은 현재보다 이후로 선택해 주세요.', FOLLOW_UP_IN_PAST: '후속 확인 일정은 현재보다 이후로 선택해 주세요.',
  TOO_MANY_ATTEMPTS: '접수 시도가 많습니다. 잠시 후 다시 이용해 주세요.',
  INTAKE_NOT_CONFIGURED: '접수 설정을 확인할 수 없습니다. 로컬 데모 서버에서 열어 주세요.',
  SESSION_EXPIRED: '테스트 관리자 세션이 만료되었습니다. 다시 입장해 주세요.', SESSION_REQUIRED: '테스트 운영자로 먼저 입장해 주세요.',
  INVALID_EMAIL: '이메일 형식을 확인해 주세요.', INVALID_PHONE: '연락처 형식을 확인해 주세요.',
  INVALID_INPUT: '입력 내용의 길이와 형식을 확인해 주세요.', INVALID_ASSIGNEE: '담당자 선택을 다시 확인해 주세요.',
  TURNSTILE_INVALID: '테스트 검증에 실패했습니다. 다시 접수해 주세요.', TURNSTILE_REUSED: '접수 검증을 새로 준비했습니다. 다시 접수해 주세요.',
  TURNSTILE_UNAVAILABLE: '접수 검증을 잠시 사용할 수 없습니다. 다시 시도해 주세요.', INTAKE_CONSENT_REQUIRED: '입력 내용의 임시 저장 안내를 확인해 주세요.',
};

function toast(message, error = false) {
  clearTimeout(state.toastTimer);
  const target = $('#page-message');
  target.textContent = message;
  target.classList.toggle('error', error);
  target.hidden = false;
  state.toastTimer = setTimeout(() => { target.hidden = true; }, error ? 9000 : 4500);
}

async function api(path, { method = 'GET', body, csrf, key } = {}) {
  const response = await fetch(path, { method, credentials: 'same-origin', headers: {
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(key ? { 'Idempotency-Key': key } : {}),
  }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(errors[data.error] ?? '처리하지 못했습니다. 잠시 후 다시 시도해 주세요.'), { code: data.error, status: response.status });
  return data;
}

function dateTime(seconds, short = false) {
  if (!seconds) return '미정';
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    ...(short ? {} : { hour: '2-digit', minute: '2-digit', hour12: false }) }).format(new Date(seconds * 1000));
}

function inputTime(seconds) {
  return seconds ? new Date((seconds + 9 * 3600) * 1000).toISOString().slice(0, 16) : '';
}
function epoch(value) { return value ? Math.floor(new Date(`${value}+09:00`).getTime() / 1000) : null; }
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function option(value, label) { const node = element('option', label); node.value = value; return node; }
function badge(status) { const node = element('span', statusNames[status] ?? status, 'status-badge'); node.dataset.status = status; return node; }

function route() {
  const view = location.hash.slice(1);
  state.view = ['consultation', 'inquiry', 'admin'].includes(view) ? view : 'consultation';
  const admin = state.view === 'admin';
  $('#public-view').hidden = admin;
  $('#admin-view').hidden = !admin;
  document.querySelectorAll('[data-view]').forEach(link => {
    const selected = link.dataset.view === state.view;
    link.classList.toggle('active', selected);
    if (selected) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
  if (admin) { if (state.admin) refreshAdmin().catch(error => toast(error.message, true)); return; }
  const inquiry = state.view === 'inquiry';
  $('#consultation-form').hidden = inquiry;
  $('#inquiry-form').hidden = !inquiry;
  $('#form-category').textContent = inquiry ? 'CONTACT MLI' : 'CONSULTATION';
  $('#form-title').textContent = inquiry ? 'MLI에 문의하기' : '리더십 상담 신청';
  $('#form-description').textContent = inquiry ? '궁금한 점이나 함께하고 싶은 제안을 남겨주세요.' : '아래 내용을 남겨주시면 상담 준비에 도움이 됩니다.';
  $('#public-title').replaceChildren();
  $('#public-title').append(inquiry ? '함께 나눌 이야기,' : '나의 강점에서 시작하는', document.createElement('br'), inquiry ? 'MLI가 듣겠습니다.' : '더 나은 리더십.');
  $('#public-description').replaceChildren();
  $('#public-description').append(inquiry ? '연구, 협업, 교육에 대한 생각을' : '혼자 고민하던 리더십의 질문,', document.createElement('br'), inquiry ? '편하게 들려주세요.' : 'MLI와 함께 다음 방향을 찾아보세요.');
  const receipt = state.receiptView === state.view;
  $('#form-panel').hidden = receipt;
  $('#receipt-panel').hidden = !receipt;
}

function example() {
  const form = $(state.view === 'inquiry' ? '#inquiry-form' : '#consultation-form');
  form.elements.name.value = '화면 확인용 신청자';
  form.elements.email.value = `preview-${crypto.randomUUID().slice(0, 8)}@example.invalid`;
  if (state.view === 'inquiry') {
    form.elements.inquiryType.value = 'partnership';
    form.elements.message.value = '청년 리더십 프로그램을 함께 운영하고 싶습니다. 협업 가능한 교육 구성과 진행 방식을 문의합니다.';
  } else {
    form.elements.phone.value = '010-0000-0000';
    form.elements.organization.value = '함께성장 팀 (예시)';
    form.elements.topic.value = '새로 팀장을 맡아 팀원의 강점을 이해하고 싶습니다. 각자의 강점에 맞게 역할을 나누고 소통하는 방법을 상담하고 싶습니다.';
    form.elements.preferredTime1.value = inputTime(Math.floor(Date.now() / 1000) + 3 * 86400);
  }
  state.keys[state.view] = null;
  toast('예시 내용을 채웠습니다. 임시 저장 안내를 확인하고 접수해 보세요.');
}

async function submit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const inquiry = form.id === 'inquiry-form';
  const view = inquiry ? 'inquiry' : 'consultation';
  if (!state.config || !state.demo) return toast('로컬 데모 설정을 불러온 뒤 이용해 주세요.', true);
  const button = form.querySelector('[type=submit]');
  button.disabled = true;
  const before = button.textContent;
  button.textContent = '접수하고 있습니다…';
  state.keys[view] ??= crypto.randomUUID();
  const values = Object.fromEntries(new FormData(form));
  const body = { name: values.name, email: values.email, preferredLanguage: 'ko',
    consent: { privacy: values.privacy === 'on', privacyVersion: state.config.privacyVersion },
    turnstileToken: `${view}:${crypto.randomUUID()}` };
  if (inquiry) Object.assign(body, { inquiryType: values.inquiryType, message: values.message });
  else Object.assign(body, { consultationType: values.consultationType, topic: values.topic, phone: values.phone || null,
    organization: values.organization || null, preferredMode: values.preferredMode, preferredTimezone: 'Asia/Seoul',
    preferredTime1: epoch(values.preferredTime1) });
  try {
    const result = await api(`/api/${inquiry ? 'inquiries' : 'consultations'}`, { method: 'POST', body, key: state.keys[view] });
    $('#receipt-title').textContent = inquiry ? '문의를 접수했습니다.' : '상담 신청을 접수했습니다.';
    $('#receipt-number').textContent = result.receiptNumber;
    $('#receipt-time').textContent = `${dateTime(result.receivedAt)} 접수`;
    state.receiptView = view;
    route();
    $('#receipt-panel').focus({ preventScroll: true });
  } catch (error) {
    if (error.code === 'IDEMPOTENCY_CONFLICT') state.keys[view] = null;
    toast(error.message, true);
  } finally { button.disabled = false; button.textContent = before; }
}

async function adminLogin() {
  const button = $('#admin-login');
  button.disabled = true;
  button.textContent = '테스트 운영자를 연결하고 있습니다…';
  try {
    if (!state.demo) throw new Error('로컬 데모 서버에서 화면을 열어 주세요.');
    const challenge = await api('/api/auth/challenge', { method: 'POST' });
    const credential = await api('/demo/credential', { method: 'POST', body: { account: 'operator', nonce: challenge.nonce } });
    const member = await api('/api/auth/google', { method: 'POST', body: { credential: credential.credential, csrfToken: challenge.csrfToken } });
    state.admin = await api('/api/admin/session', { method: 'POST', csrf: member.csrfToken, body: { code: state.demo.demoAdminCode } });
    await refreshAdmin();
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; button.textContent = '테스트 운영자로 입장'; }
}

function statusFilter() {
  const select = $('#status-filter');
  select.replaceChildren(option('', '모든 상태'), ...Object.keys(transitions[state.kind]).map(status => option(status, statusNames[status])));
}

async function refreshAdmin() {
  if (!state.admin) return;
  $('#admin-gate').hidden = true;
  $('#admin-workspace').hidden = false;
  $('#refresh-button').disabled = true;
  try {
    const [consultations, inquiries, assignees] = await Promise.all([
      api('/api/admin/consultations?limit=100'), api('/api/admin/inquiries?limit=100'), api('/api/admin/intake-assignees'),
    ]);
    state.assignees = assignees.items;
    $('#stat-total').textContent = consultations.total + inquiries.total;
    $('#sidebar-total').textContent = consultations.total + inquiries.total;
    $('#stat-new').textContent = [...consultations.items, ...inquiries.items].filter(item => item.status === 'new').length;
    $('#stat-confirmed').textContent = consultations.items.filter(item => item.status === 'confirmed').length;
    $('#consultations-count').textContent = consultations.total;
    $('#inquiries-count').textContent = inquiries.total;
    await loadList();
    if (!$('#audit-panel').hidden) await loadAudit();
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      state.admin = null; state.selected = null;
      $('#admin-workspace').hidden = true; $('#admin-gate').hidden = false;
      $('#inbox-rows').replaceChildren(); $('#detail-content').hidden = true;
    }
    throw error;
  } finally { $('#refresh-button').disabled = false; }
}

async function loadList() {
  const params = new URLSearchParams({ limit: state.limit, offset: state.offset });
  const status = $('#status-filter').value;
  if (status) params.set('status', status);
  const data = await api(`/api/admin/${state.kind}?${params}`);
  state.items = data.items;
  state.total = data.total;
  const selectedId = state.selected?.id;
  renderRows();
  const selected = data.items.find(item => item.id === selectedId) ?? data.items[0];
  if (selected) await openDetail(selected.id);
  else {
    state.selected = null; $('#detail-content').hidden = true; $('#detail-empty').hidden = false;
    $('#detail-badge').textContent = '';
  }
}

function renderRows() {
  const tbody = $('#inbox-rows');
  tbody.replaceChildren();
  for (const item of state.items) {
    const row = document.createElement('tr');
    row.classList.toggle('selected', item.id === state.selected?.id);
    const person = document.createElement('td'); person.append(element('strong', item.name), element('small', item.receiptNumber));
    row.append(person, element('td', typeNames[item.type] ?? item.type), element('td', dateTime(item.createdAt, true)));
    const status = document.createElement('td'); status.append(badge(item.status)); row.append(status);
    const action = document.createElement('td');
    const button = element('button', '상세 보기', 'row-open'); button.type = 'button'; button.dataset.openId = item.id;
    button.setAttribute('aria-label', `${item.name} 상세 보기`); action.append(button); row.append(action); tbody.append(row);
  }
  $('#inbox-empty').hidden = state.items.length !== 0;
  $('#list-summary').textContent = state.total ? `전체 ${state.total}건 · ${state.offset + 1}–${state.offset + state.items.length}건` : '전체 0건';
  $('#previous-page').disabled = state.offset === 0;
  $('#next-page').disabled = state.offset + state.limit >= state.total;
}

let detailRequest = 0;
async function openDetail(id) {
  const serial = ++detailRequest;
  const kind = state.kind;
  const result = await api(`/api/admin/${kind}/${id}`);
  if (serial !== detailRequest || kind !== state.kind) return;
  state.selected = result.item;
  renderRows();
  renderDetail();
}

function renderDetail() {
  const item = state.selected;
  $('#detail-empty').hidden = true; $('#detail-content').hidden = false;
  const status = $('#detail-badge'); status.textContent = statusNames[item.status]; status.dataset.status = item.status;
  $('#detail-receipt').textContent = item.receiptNumber;
  $('#detail-name').textContent = item.name;
  $('#detail-contact').textContent = `${item.email}${item.phone ? `\n${item.phone}` : ''}`;
  $('#detail-type').textContent = typeNames[item.consultationType ?? item.inquiryType];
  $('#detail-message').textContent = item.topic ?? item.message;
  $('#detail-preferred').textContent = item.preferredTime1 ? dateTime(item.preferredTime1) : '입력된 희망 일정 없음';
  $('#detail-mode').textContent = item.preferredMode === 'online' ? '온라인' : item.preferredMode === 'offline' ? '오프라인' : '별도 협의';
  $('#detail-organization').textContent = item.organization || '입력된 소속 없음';
  $('#detail-preferred').parentElement.hidden = state.kind !== 'consultations';
  $('#detail-mode').parentElement.hidden = state.kind !== 'consultations';
  $('#detail-organization').parentElement.hidden = state.kind !== 'consultations';
  $('#update-status').replaceChildren(...[item.status, ...transitions[state.kind][item.status]].map(status => option(status, statusNames[status])));
  $('#update-assignee').replaceChildren(option('', '미배정'), ...state.assignees.map(person => option(person.id, person.nickname)));
  if (item.assignedAdminId && !state.assignees.some(person => person.id === item.assignedAdminId)) {
    $('#update-assignee').append(option(item.assignedAdminId, '기존 담당자 (현재 비활성)'));
  }
  $('#update-assignee').value = item.assignedAdminId ?? '';
  $('#update-note').value = item.internalNote;
  $('#update-follow-up').value = inputTime(item.followUpAt);
  $('#update-confirmed').value = inputTime(item.confirmedTime);
  $('#save-feedback').textContent = '';
  confirmedVisibility();
}

function confirmedVisibility() {
  const visible = state.kind === 'consultations' && $('#update-status').value === 'confirmed';
  $('#confirmed-label').hidden = !visible;
  $('#update-confirmed').required = visible;
}

async function save(event) {
  event.preventDefault();
  if (!state.selected || !state.admin || state.loading) return;
  const item = state.selected;
  const kind = state.kind;
  const body = { version: item.version };
  const status = $('#update-status').value;
  if (status !== item.status) body.status = status;
  const assigned = $('#update-assignee').value || null;
  if (assigned !== item.assignedAdminId) body.assignedAdminId = assigned;
  if ($('#update-note').value !== item.internalNote) body.internalNote = $('#update-note').value;
  const followUp = epoch($('#update-follow-up').value);
  if (inputTime(followUp) !== inputTime(item.followUpAt)) body.followUpAt = followUp;
  if (kind === 'consultations' && status === 'confirmed') {
    const confirmed = epoch($('#update-confirmed').value);
    if (status !== item.status || inputTime(confirmed) !== inputTime(item.confirmedTime)) body.confirmedTime = confirmed;
  }
  if (Object.keys(body).length === 1) return toast('변경한 내용이 없습니다.');
  state.loading = true; $('#save-button').disabled = true; $('#save-button').textContent = '저장 중…';
  try {
    await api(`/api/admin/${kind}/${item.id}`, { method: 'PATCH', csrf: state.admin.csrfToken, body });
    await refreshAdmin();
    $('#save-feedback').textContent = '변경 사항을 저장했습니다.';
    toast('처리 정보와 변경 이력을 저장했습니다.');
  } catch (error) { toast(error.message, true); }
  finally { state.loading = false; $('#save-button').disabled = false; $('#save-button').textContent = '변경 사항 저장'; }
}

async function loadAudit() {
  const data = await api('/api/admin/audit-events?limit=30');
  const list = $('#audit-list'); list.replaceChildren();
  const actions = { 'intake.demo_seeded': '예시 신청 준비', 'intake.submitted': '신규 신청 접수', 'intake.viewed': '신청 상세 조회', 'intake.updated': '처리 정보 변경' };
  for (const item of data.items) {
    const row = element('div', undefined, 'audit-item');
    const label = actions[item.action] ?? item.action;
    row.append(element('span', `${label}${item.previousState && item.nextState !== item.previousState ? ` · ${statusNames[item.previousState]} → ${statusNames[item.nextState]}` : ''}`), element('small', dateTime(item.createdAt)));
    list.append(row);
  }
}

async function bootstrap() {
  route(); statusFilter();
  try {
    const demo = await api('/demo/config');
    if (demo.mode !== 'local-test' || demo.stage !== 3) throw new Error('3단계 로컬 데모 서버에서 열어 주세요.');
    state.demo = demo;
    state.config = await api('/api/intake/config');
    try { state.admin = await api('/api/admin/session'); } catch { /* User enters the test account explicitly. */ }
    if (state.admin && state.view === 'admin') await refreshAdmin();
  } catch (error) {
    document.querySelectorAll('.submit-button, #admin-login, #example-button').forEach(button => { button.disabled = true; });
    toast('3단계 로컬 데모 서버에서 열어 주세요. npm run demo 실행 후 /stage3에서 이용할 수 있습니다.', true);
  }
}

window.addEventListener('hashchange', route);
$('#example-button').addEventListener('click', example);
$('#consultation-form').addEventListener('submit', submit);
$('#inquiry-form').addEventListener('submit', submit);
for (const form of [$('#consultation-form'), $('#inquiry-form')]) form.addEventListener('input', () => { state.keys[form.id === 'inquiry-form' ? 'inquiry' : 'consultation'] = null; });
$('#new-request').addEventListener('click', () => {
  $(state.view === 'inquiry' ? '#inquiry-form' : '#consultation-form').reset();
  state.keys[state.view] = null; state.receiptView = null; route();
});
$('#open-inbox').addEventListener('click', () => { location.hash = 'admin'; });
$('#admin-login').addEventListener('click', adminLogin);
$('#refresh-button').addEventListener('click', () => refreshAdmin().catch(error => toast(error.message, true)));
document.querySelectorAll('[data-kind]').forEach(button => button.addEventListener('click', () => {
  if (state.loading) return;
  state.kind = button.dataset.kind; state.offset = 0; state.selected = null; ++detailRequest; statusFilter();
  document.querySelectorAll('[data-kind]').forEach(tab => tab.classList.toggle('active', tab === button));
  loadList().catch(error => toast(error.message, true));
}));
$('#status-filter').addEventListener('change', () => { state.offset = 0; loadList().catch(error => toast(error.message, true)); });
$('#previous-page').addEventListener('click', () => { state.offset = Math.max(0, state.offset - state.limit); loadList().catch(error => toast(error.message, true)); });
$('#next-page').addEventListener('click', () => { state.offset += state.limit; loadList().catch(error => toast(error.message, true)); });
$('#inbox-rows').addEventListener('click', event => {
  const button = event.target.closest('[data-open-id]');
  if (button && !state.loading) openDetail(button.dataset.openId).catch(error => toast(error.message, true));
});
$('#update-status').addEventListener('change', confirmedVisibility);
$('#update-form').addEventListener('submit', save);
$('#audit-toggle').addEventListener('click', () => {
  if (!state.admin) return toast('테스트 운영자로 먼저 입장해 주세요.');
  const panel = $('#audit-panel'); panel.hidden = !panel.hidden;
  if (!panel.hidden) loadAudit().then(() => panel.scrollIntoView({ behavior: 'smooth', block: 'start' })).catch(error => toast(error.message, true));
});
$('#audit-refresh').addEventListener('click', () => loadAudit().catch(error => toast(error.message, true)));
bootstrap();
