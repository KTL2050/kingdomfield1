/* ═══════════════════════════════════════════════════════════════════════════
   KTLSALES — LEAVE: FILE ON BEHALF + BACKFILL PAST LEAVE
   Add-on for ktl-leave.js. Load it AFTER the main module:

       <script src="ktl-leave.js"></script>
       <script src="ktl-leave-admin.js"></script>

   What it adds, for admins and managers only:
     • Pick the employee a request is being filed for. The saved record carries
       that employee's id and name, so it appears everywhere exactly as if they
       had submitted it themselves.
     • "Record past leave" mode — backdated dates, saved straight as approved,
       so leave that already happened shows as Completed.
     • Optional notification to the employee, off by default when backfilling.

   Sales reps see the original form, unchanged.

   Note on the audit trail: the request itself reads as the employee's, but
   leave_audit_log records who actually keyed it in. That is deliberate — it
   keeps the visible record clean without losing who did what.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
'use strict';

// ─── HOST APP ACCESS ───────────────────────────────────────────────────────
function me()        { try { return currentUser || null; } catch (e) { return null; } }
function DB()        { try { return sb; } catch (e) { return null; } }
function roleAdmin() { try { return canAdmin();  } catch (e) { return me()?.role === 'admin'; } }
function roleMgr()   { try { return canManage(); } catch (e) { return ['admin','manager'].includes(me()?.role); } }

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

function todayISO() { return new Date().toISOString().split('T')[0]; }
function parseD(s)  { if (!s) return null; const [y,m,d] = String(s).split('T')[0].split('-').map(Number); return new Date(y, m-1, d); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate()+n); return x; }
function fmtDate(s) {
  const d = parseD(s); if (!d) return '—';
  return d.toLocaleDateString('en-UG', { day:'2-digit', month:'short', year:'numeric' });
}
function countDays(a, b, excludeWeekends) {
  const s = parseD(a), e = parseD(b);
  if (!s || !e || e < s) return 0;
  let n = 0;
  for (let d = new Date(s); d <= e; d = addDays(d, 1)) {
    if (excludeWeekends && (d.getDay() === 0 || d.getDay() === 6)) continue;
    n++;
  }
  return n;
}
function countWorkingDays(a, b) {
  const s = parseD(a), e = parseD(b);
  if (!s || !e || e < s) return 0;
  let n = 0;
  for (let d = new Date(s); d <= e; d = addDays(d, 1)) if (d.getDay() !== 0 && d.getDay() !== 6) n++;
  return n;
}
function toast(msg, kind) {
  try { if (window.Leave && window.Leave._toast) return window.Leave._toast(msg, kind); } catch (e) {}
  document.getElementById('lv-toast')?.remove();
  const bg = kind === 'error' ? '#A32D2D' : kind === 'warn' ? '#854F0B' : '#1D9E75';
  const el = document.createElement('div');
  el.id = 'lv-toast'; el.className = 'lv-toast';
  el.style.background = bg; el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('out'), 3200);
  setTimeout(() => el.remove(), 3600);
}

// ─── LOCAL STATE ───────────────────────────────────────────────────────────
const A = {
  mode:        'request',   // request | record
  staff:       [],          // employees this user may file for
  loaded:      false,
  forceOverlap:false,
};

function S()   { return window.Leave?.state  || {}; }
function CFG() { return window.Leave?.config || { bucket:'leave-attachments', maxAttachmentMB:5, excludeWeekends:false }; }

// ─── WHO CAN THIS USER FILE FOR ────────────────────────────────────────────
async function loadStaff() {
  const u = me();
  if (!u) { A.staff = []; return; }

  let users = S().users || [];
  if (!users.length) {
    const { data } = await DB().from('users').select('id,full_name,email,role,is_active').order('full_name');
    users = data || [];
  }
  const active = users.filter(x => x.is_active !== false);

  if (roleAdmin()) { A.staff = active; A.loaded = true; return; }

  // Managers may only file for the employees assigned to them, plus themselves.
  const { data } = await DB().from('leave_approvers').select('employee_id').eq('manager_id', u.id);
  const ids = new Set((data || []).map(r => String(r.employee_id)));
  ids.add(String(u.id));
  A.staff = active.filter(x => ids.has(String(x.id)));
  A.loaded = true;
}

async function ensureTypes() {
  if ((S().types || []).length) return S().types;
  const { data } = await DB().from('leave_types').select('*').order('sort_order');
  if (window.Leave?.state) window.Leave.state.types = data || [];
  return data || [];
}

// ─── FORM ──────────────────────────────────────────────────────────────────
function modal(html, width) {
  document.getElementById('lv-ov')?.remove();
  const ov = document.createElement('div');
  ov.className = 'lv-ov'; ov.id = 'lv-ov';
  ov.innerHTML = `<div class="lv-modal"${width ? ` style="max-width:${width}px;"` : ''}>${html}</div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
  return ov;
}
function closeModal() { document.getElementById('lv-ov')?.remove(); }

async function openAdminForm(mode) {
  const u = me();
  if (!u) return;

  const types = (await ensureTypes()).filter(t => t.is_active);
  if (!types.length) { toast('No leave types are set up yet. Add one in Settings first.', 'warn'); return; }

  if (!A.loaded) await loadStaff();
  if (!A.staff.length) { toast('You have no employees assigned to you yet.', 'warn'); return; }

  A.mode = mode || A.mode || 'request';
  A.forceOverlap = false;

  const t        = todayISO();
  const record   = A.mode === 'record';
  const defStart = record ? t : t;

  modal(`
    <div class="lv-modal-hd">
      <div>
        <div style="font-size:15px;font-weight:700;">${record ? 'Record past leave' : 'File a leave request'}</div>
        <div style="font-size:11.5px;color:var(--txt2);margin-top:2px;">
          ${record
            ? 'Saved as already approved, in the employee’s name.'
            : 'Filed in the employee’s name and routed to their approvers.'}
        </div>
      </div>
      <button class="lv-x" onclick="LeaveAdmin.close()">×</button>
    </div>

    <div class="lv-modal-bd">
      <div id="lv-form-err" class="alert ad" style="display:none;"></div>

      <div class="fg">
        <label class="flbl">What are you doing</label>
        <div style="display:flex;gap:6px;">
          <button type="button" class="btn ${record ? '' : 'btn-royal'}" style="flex:1;"
            onclick="LeaveAdmin.open('request')">New request</button>
          <button type="button" class="btn ${record ? 'btn-royal' : ''}" style="flex:1;"
            onclick="LeaveAdmin.open('record')">Record past leave</button>
        </div>
      </div>

      <div class="fg">
        <label class="flbl">Employee</label>
        <select class="fin" id="lva-emp">
          ${A.staff.map(x => `<option value="${esc(x.id)}"${String(x.id) === String(u.id) ? ' selected' : ''}>${esc(x.full_name)}${String(x.id) === String(u.id) ? ' (you)' : ''}</option>`).join('')}
        </select>
        <div style="font-size:11px;color:var(--txt3);margin-top:3px;">
          The request is saved under this person’s name, exactly as if they had submitted it.
        </div>
      </div>

      <div class="fg">
        <label class="flbl">Leave type</label>
        <select class="fin" id="lva-type" onchange="LeaveAdmin.recalc()">
          ${types.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}
        </select>
      </div>

      <div class="fgrid">
        <div class="fg"><label class="flbl">Start date</label>
          <input type="date" class="fin" id="lva-start" ${record ? '' : `min="${t}"`} value="${defStart}" onchange="LeaveAdmin.recalc()"/></div>
        <div class="fg"><label class="flbl">End date</label>
          <input type="date" class="fin" id="lva-end" ${record ? '' : `min="${t}"`} value="${defStart}" onchange="LeaveAdmin.recalc()"/></div>
      </div>

      <div class="alert ai" id="lva-days-box"><span>🗓️</span><div id="lva-days-txt">1 day of leave.</div></div>

      ${record ? `
        <div class="fgrid">
          <div class="fg"><label class="flbl">Date it was requested</label>
            <input type="date" class="fin" id="lva-reqon" value="${defStart}"/>
            <div style="font-size:11px;color:var(--txt3);margin-top:3px;">Leave as-is if you are unsure.</div>
          </div>
          <div class="fg"><label class="flbl">Save as</label>
            <select class="fin" id="lva-status">
              <option value="approved" selected>Approved (already granted)</option>
              <option value="pending">Pending (still needs a decision)</option>
            </select>
          </div>
        </div>
      ` : ''}

      <div class="fg"><label class="flbl">Reason</label>
        <textarea class="fin" id="lva-reason" rows="3"
          placeholder="${record ? 'e.g. Annual leave taken in July' : 'Briefly explain the reason for this leave'}"></textarea></div>

      <div class="fg"><label class="flbl">Attachment <span style="color:var(--txt3);font-weight:400;">(optional — max ${CFG().maxAttachmentMB}MB)</span></label>
        <input type="file" class="fin" id="lva-file" accept="image/*,.pdf,.doc,.docx"/></div>

      <div class="fg" style="display:flex;align-items:center;gap:8px;">
        <input type="checkbox" id="lva-notify" ${record ? '' : 'checked'} style="width:16px;height:16px;"/>
        <label for="lva-notify" style="font-size:12.5px;color:var(--txt2);cursor:pointer;">
          Notify the employee${record ? '' : ' and their approvers'}
        </label>
      </div>
    </div>

    <div class="lv-modal-ft">
      <button class="btn" onclick="LeaveAdmin.close()">Cancel</button>
      <button class="btn btn-royal" id="lva-save" onclick="LeaveAdmin.save()">
        ${record ? 'Save record' : 'File request'}
      </button>
    </div>`, 560);

  recalc();
}

function recalc() {
  const s = document.getElementById('lva-start')?.value;
  const e = document.getElementById('lva-end')?.value;
  const box = document.getElementById('lva-days-box');
  const txt = document.getElementById('lva-days-txt');
  if (!s || !e || !txt) return;

  if (e < s) {
    box.className = 'alert ad';
    txt.innerHTML = 'The end date is before the start date.';
    return;
  }
  const d    = countDays(s, e, CFG().excludeWeekends);
  const wd   = countWorkingDays(s, e);
  const type = (S().types || []).find(x => String(x.id) === String(document.getElementById('lva-type')?.value));
  const over = type?.max_days_per_request && d > type.max_days_per_request;
  const past = e < todayISO();

  box.className = over ? 'alert aw' : 'alert ai';
  txt.innerHTML = `<strong>${d} day${d === 1 ? '' : 's'}</strong> of leave · ${wd} working day${wd === 1 ? '' : 's'}
    ${past ? '<br>These dates are in the past, so this will show as <strong>Completed</strong>.' : ''}
    ${over ? `<br>That is over the ${type.max_days_per_request}-day limit for ${esc(type.name)}.` : ''}`;
}

function formErr(msg, allowForce) {
  const el = document.getElementById('lv-form-err');
  if (!el) { toast(msg, 'error'); return; }
  el.innerHTML = `<span>⚠️</span><div>${esc(msg)}
    ${allowForce ? `<br><button type="button" class="btn" style="margin-top:6px;padding:4px 10px;font-size:11.5px;"
      onclick="LeaveAdmin.forceSave()">Save anyway</button>` : ''}</div>`;
  el.style.display = 'flex';
  el.scrollIntoView?.({ behavior:'smooth', block:'nearest' });
}

function forceSave() { A.forceOverlap = true; save(); }

// ─── SAVE ──────────────────────────────────────────────────────────────────
async function save() {
  const u = me(); if (!u) return;
  const btn    = document.getElementById('lva-save');
  const record = A.mode === 'record';

  const empId  = document.getElementById('lva-emp').value;
  const typeId = document.getElementById('lva-type').value;
  const start  = document.getElementById('lva-start').value;
  const end    = document.getElementById('lva-end').value;
  const reason = document.getElementById('lva-reason').value.trim();
  const file   = document.getElementById('lva-file').files[0];
  const notifyOn = document.getElementById('lva-notify').checked;
  const status = record ? (document.getElementById('lva-status')?.value || 'approved') : 'pending';
  const reqOn  = record ? (document.getElementById('lva-reqon')?.value || start) : null;

  const emp  = A.staff.find(x => String(x.id) === String(empId));
  const type = (S().types || []).find(x => String(x.id) === String(typeId));

  if (!emp)           return formErr('Choose the employee this leave belongs to.');
  if (!typeId)        return formErr('Choose a leave type.');
  if (!start || !end) return formErr('Choose both a start and an end date.');
  if (end < start)    return formErr('The end date cannot be before the start date.');
  if (!reason)        return formErr('Add a short reason so the record makes sense later.');
  if (file && file.size > CFG().maxAttachmentMB * 1024 * 1024)
    return formErr(`Attachment is larger than ${CFG().maxAttachmentMB}MB.`);

  const days = countDays(start, end, CFG().excludeWeekends);
  if (days < 1) return formErr('That date range covers no leave days.');
  if (!record && type?.max_days_per_request && days > type.max_days_per_request)
    return formErr(`${type.name} allows a maximum of ${type.max_days_per_request} days per request.`);

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner" style="border-top-color:#fff;"></span>Saving…';

  const unlock = () => {
    btn.disabled = false;
    btn.textContent = record ? 'Save record' : 'File request';
  };

  // Overlap guard — blocks by default, overridable when backfilling.
  if (!A.forceOverlap) {
    const { data: clash } = await DB().from('leave_requests')
      .select('id,start_date,end_date,status')
      .eq('employee_id', emp.id).in('status', ['pending','approved'])
      .lte('start_date', end).gte('end_date', start);
    if (clash && clash.length) {
      unlock();
      return formErr(
        `${emp.full_name} already has ${clash[0].status} leave from ${fmtDate(clash[0].start_date)} to ${fmtDate(clash[0].end_date)}.`,
        record);
    }
  }

  // Attachment — stored under the employee's folder, same as a self-submission.
  let path = null, fname = null;
  if (file) {
    const safe = file.name.replace(/[^\w.\-]/g, '_');
    path  = `${emp.id}/${Date.now()}_${safe}`;
    fname = file.name;
    const { error } = await DB().storage.from(CFG().bucket)
      .upload(path, file, { contentType: file.type, upsert: false });
    if (error) { unlock(); return formErr('Attachment upload failed: ' + error.message); }
  }

  const row = {
    employee_id:    emp.id,
    employee_name:  emp.full_name,
    leave_type_id:  typeId,
    leave_type_name: type?.name || '',
    start_date:     start,
    end_date:       end,
    days_count:     days,
    working_days:   countWorkingDays(start, end),
    reason,
    attachment_path: path,
    attachment_name: fname,
    status,
    requested_at:   record ? new Date(reqOn + 'T09:00:00').toISOString() : new Date().toISOString(),
  };
  if (status === 'approved') {
    row.decided_by      = u.id;
    row.decided_by_name = u.full_name;
    row.decided_at      = new Date().toISOString();
  }

  const { data, error } = await DB().from('leave_requests').insert(row).select().single();
  if (error) { unlock(); return formErr('Could not save: ' + error.message); }

  // Audit trail keeps the truth about who keyed it in.
  const onBehalf = String(emp.id) !== String(u.id);
  const note = onBehalf
    ? `Filed by ${u.full_name} on behalf of ${emp.full_name}${record ? ' (historical record)' : ''}`
    : (record ? 'Historical record entered by the employee' : null);

  await auditRow(data.id, 'submitted', null, 'pending', note);
  if (status === 'approved') {
    await auditRow(data.id, 'approved', 'pending', 'approved',
      record ? `Recorded as already approved by ${u.full_name}` : `Approved on entry by ${u.full_name}`);
  }

  // Notifications
  if (notifyOn) {
    if (onBehalf) {
      await notifyUsers([emp.id], status === 'approved' ? 'approved' : 'new_request',
        status === 'approved' ? 'Leave recorded for you' : 'Leave request filed for you',
        `${u.full_name} ${status === 'approved' ? 'recorded' : 'filed'} ${type?.name} for you from ${fmtDate(start)} to ${fmtDate(end)} (${days} day${days === 1 ? '' : 's'}).`,
        data.id);
    }
    if (status === 'pending') {
      const approvers = (await approverIds(emp.id)).filter(x => String(x) !== String(u.id));
      await notifyUsers(approvers, 'new_request', 'New leave request',
        `${emp.full_name} has requested ${type?.name} from ${fmtDate(start)} to ${fmtDate(end)} (${days} day${days === 1 ? '' : 's'}).`,
        data.id);
    }
  }

  closeModal();
  toast(record
    ? `Recorded. ${emp.full_name}'s leave is in the system.`
    : `Request filed for ${emp.full_name}.`);
  try { await window.Leave.refresh(); } catch (e) {}
}

async function auditRow(requestId, action, fromStatus, toStatus, note) {
  const u = me();
  const { error } = await DB().from('leave_audit_log').insert({
    request_id: requestId, action,
    actor_id: u?.id, actor_name: u?.full_name,
    from_status: fromStatus, to_status: toStatus, note: note || null,
  });
  if (error) console.warn('[leave-admin] audit:', error.message);
}

async function notifyUsers(userIds, type, title, body, requestId) {
  const uniq = [...new Set((userIds || []).filter(Boolean).map(String))];
  if (!uniq.length) return;
  const { error } = await DB().from('leave_notifications')
    .insert(uniq.map(uid => ({ user_id: uid, type, title, body, request_id: requestId })));
  if (error) console.warn('[leave-admin] notify:', error.message);
}

async function approverIds(employeeId) {
  const { data } = await DB().from('leave_approvers').select('manager_id').eq('employee_id', employeeId);
  let ids = (data || []).map(r => r.manager_id);
  if (!ids.length) {
    const { data: admins } = await DB().from('users').select('id').eq('role','admin').eq('is_active', true);
    ids = (admins || []).map(x => x.id);
  }
  return [...new Set(ids.map(String))].filter(id => String(id) !== String(employeeId));
}

// ─── HOOK INTO THE EXISTING MODULE ─────────────────────────────────────────
function patch() {
  if (!window.Leave || window.Leave.__adminPatched) return !!window.Leave?.__adminPatched;

  const original = window.Leave.openRequestForm;

  window.Leave.openRequestForm = function () {
    // Sales reps keep the original self-service form untouched.
    if (!roleMgr()) return original.apply(this, arguments);
    openAdminForm('request');
  };

  window.Leave.__adminPatched = true;
  window.LeaveAdmin = {
    open:  openAdminForm,
    close: closeModal,
    save,
    forceSave,
    recalc,
    reloadStaff: () => { A.loaded = false; return loadStaff(); },
    state: A,
  };

  console.log('%c[KTL] Leave admin add-on ready — file on behalf + backfill', 'color:#1a3a6b;font-weight:700');
  return true;
}

if (!patch()) {
  const timer = setInterval(() => { if (patch()) clearInterval(timer); }, 400);
  setTimeout(() => clearInterval(timer), 30000);
}
})();