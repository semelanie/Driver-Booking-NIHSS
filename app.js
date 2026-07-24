/* ============================================================
   NIHSS Driver Booking — Supabase-backed data layer (v2)
   Adds: destination field, reschedule proposals, management
   permission levels (1=View Only, 2=Approver), a structured
   audit trail (with best-effort client-side IP lookup), and
   driver/manager edit + delete + password reset.
   Passwords never travel through this file's own queries —
   everything touching the password column goes through the
   SECURITY DEFINER functions in the schema SQL files.
   ============================================================ */

const SUPABASE_URL = 'https://ytcsntxpfcursvdmstlb.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl0Y3NudHhwZmN1cnN2ZG1zdGxiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ1NTY3MDYsImV4cCI6MjEwMDEzMjcwNn0.wp3ADJSChH1M29Ri8p-E0Dz5XaQPy6riUYKoU4qGAuc';
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const SESSION_KEY = 'nihss_session';

function dayName(dateStr){
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-GB',{ weekday:'long' });
}
function timeToMin(t){ const [h,m] = t.split(':').map(Number); return h*60+m; }

/* ---------- Toast ---------- */
function toast(msg){
  let el = document.getElementById('toast');
  if(!el){ el = document.createElement('div'); el.id='toast'; document.body.appendChild(el); }
  el.textContent = msg; el.classList.add('show');
  clearTimeout(window.__toastT);
  window.__toastT = setTimeout(()=> el.classList.remove('show'), 3200);
}

/* ---------- Simulated email ----------
   Real sending needs a backend (see supabase/functions/send-email in the
   project — deploy it with a Resend API key to make this actually send). */
function simulateEmail(to, subject, body){
  console.log(`[simulated email] To: ${to} | Subject: ${subject}${body ? ' | ' + body : ''}`);
}

/* ---------- Best-effort client IP (for the audit trail) ---------- */
let __cachedIP = null;
async function getClientIP(){
  if(__cachedIP) return __cachedIP;
  try{
    const res = await fetch('https://api.ipify.org?format=json');
    const j = await res.json();
    __cachedIP = j.ip;
  }catch(e){ __cachedIP = 'unknown'; }
  return __cachedIP;
}

/* ---------- Auth ---------- */
async function login(role, username, password){
  const fn = role === 'driver' ? 'authenticate_driver' : role === 'management' ? 'authenticate_manager' : 'authenticate_admin';
  const { data, error } = await sb.rpc(fn, { p_username: username, p_password: password });
  const ip = await getClientIP();
  if(error){
    console.error(error);
    await logAudit({ username, action:'Login', status:'Failed', role, details:'Database error during login' });
    return false;
  }
  if(!data || !data.length){
    await logAudit({ username, action:'Login', status:'Failed', role, details:'Incorrect username or password' });
    return false;
  }
  const user = data[0];
  localStorage.setItem(SESSION_KEY, JSON.stringify({ role, id:user.id, name:user.name, username:user.username, level:user.level || null }));
  await logAudit({ username:user.username, fullName:user.name, action:'Login', status:'Success', role });
  return true;
}
function currentSession(){
  try{ return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch(e){ return null; }
}
async function logout(){
  const s = currentSession();
  if(s) await logAudit({ username:s.username, fullName:s.name, action:'Logout', status:'Success', role:s.role });
  localStorage.removeItem(SESSION_KEY);
  window.location.href = 'index.html';
}
function requireRole(role){
  const s = currentSession();
  if(!s || s.role !== role){ window.location.href = role + '-login.html'; return null; }
  return s;
}
/* Management Level 2 = Approver, Level 1 = View Only */
function isApprover(session){ return session.role === 'management' && Number(session.level) === 2; }

/* ---------- Bookings ---------- */
function mapBooking(row){
  return {
    id: row.id, day: row.day, date: row.date, name: row.name, dept: row.dept,
    contact: row.contact, email: row.email, location: row.location, destination: row.destination,
    timeLeave: (row.time_leave || '').slice(0,5), timeCollect: (row.time_collect || '').slice(0,5),
    purpose: row.purpose, remarks: row.remarks, status: row.status,
    acceptedBy: row.accepted_by, submittedAt: row.submitted_at, acceptedAt: row.accepted_at,
    proposedDate: row.proposed_date,
    proposedTimeLeave: row.proposed_time_leave ? row.proposed_time_leave.slice(0,5) : null,
    proposedTimeCollect: row.proposed_time_collect ? row.proposed_time_collect.slice(0,5) : null
  };
}

async function getBookings(){
  const { data, error } = await sb.from('bookings').select('*');
  if(error){ console.error(error); toast('Could not load bookings — check your connection.'); return []; }
  return data.map(mapBooking);
}

/* ---------- Leg duration setting ----------
   The driver isn't "busy" for the whole booking window — only for the
   short drop-off leg (school → location) and the short pickup leg
   (location → school) around it. In between, he's back at school and
   free for other bookings. leg_minutes controls how long each of those
   legs is assumed to take; adjust it from the Admin panel. */
let __cachedLegMinutes = null;
async function getLegMinutes(){
  if(__cachedLegMinutes != null) return __cachedLegMinutes;
  const { data, error } = await sb.from('app_settings').select('value').eq('key','leg_minutes').single();
  __cachedLegMinutes = (!error && data) ? Number(data.value) : 30;
  return __cachedLegMinutes;
}
async function setLegMinutes(minutes){
  const { error } = await sb.from('app_settings').upsert({ key:'leg_minutes', value:String(minutes) });
  if(!error) __cachedLegMinutes = Number(minutes);
  return !error;
}

function legWindows(timeLeave, timeCollect, legMinutes){
  const dl = timeToMin(timeLeave), dc = timeToMin(timeCollect);
  return [
    { label:'Drop-off', start: dl, end: dl + legMinutes },
    { label:'Pick-up',  start: dc, end: dc + legMinutes }
  ];
}
function windowsOverlap(a, b){ return Math.max(a.start,b.start) < Math.min(a.end,b.end); }

async function findConflicts(date, timeLeave, timeCollect, excludeId){
  const legMinutes = await getLegMinutes();
  const all = await getBookings();
  const candidate = legWindows(timeLeave, timeCollect, legMinutes);
  return all.filter(b => {
    if(b.date !== date || b.status !== 'Accepted' || b.id === excludeId) return false;
    const existing = legWindows(b.timeLeave, b.timeCollect, legMinutes);
    return candidate.some(cw => existing.some(ew => windowsOverlap(cw, ew)));
  });
}

async function addBooking(data){
  const conflicts = await findConflicts(data.date, data.timeLeave, data.timeCollect, null);
  const { data: inserted, error } = await sb.from('bookings').insert({
    day: data.day, date: data.date, name: data.name, dept: data.dept, contact: data.contact,
    email: data.email, location: data.location, destination: data.destination,
    time_leave: data.timeLeave, time_collect: data.timeCollect,
    purpose: data.purpose, remarks: data.remarks, status: 'Pending'
  }).select().single();
  if(error){ console.error(error); toast('Could not submit the request — please try again.'); return { booking:null, conflicts }; }
  const b = mapBooking(inserted);
  await logAudit({ action:'Booking Created', status:'Success', details:`${b.name} requested ${b.date} ${b.timeLeave}-${b.timeCollect}` });
  return { booking: b, conflicts };
}

async function acceptBooking(id, acceptedByLabel, actorSession){
  const { data, error } = await sb.from('bookings')
    .update({ status:'Accepted', accepted_by:acceptedByLabel, accepted_at:new Date().toISOString() })
    .eq('id', id).select().single();
  if(error){ console.error(error); toast('Could not accept the request.'); return null; }
  const b = mapBooking(data);
  simulateEmail(b.email, `Booking accepted — ${b.date} ${b.timeLeave} to ${b.timeCollect}`);
  await logAudit({ username:actorSession?.username, fullName:actorSession?.name, role:actorSession?.role,
    action:'Booking Accepted', status:'Success', details:`${b.name} on ${b.date} (by ${acceptedByLabel})` });
  return b;
}

async function denyBooking(id, byLabel, actorSession){
  const { data, error } = await sb.from('bookings')
    .update({ status:'Denied', accepted_by:null })
    .eq('id', id).select().single();
  if(error){ console.error(error); toast('Could not deny the request.'); return null; }
  const b = mapBooking(data);
  simulateEmail(b.email, `Booking denied — ${b.date} ${b.timeLeave} to ${b.timeCollect}`);
  await logAudit({ username:actorSession?.username, fullName:actorSession?.name, role:actorSession?.role,
    action:'Booking Denied', status:'Success', details:`${b.name} on ${b.date} (by ${byLabel})` });
  return b;
}

async function rescheduleBooking(id, newDate, newTimeLeave, newTimeCollect, byLabel, actorSession){
  const { data, error } = await sb.from('bookings')
    .update({ status:'Rescheduled', accepted_by:byLabel, proposed_date:newDate, proposed_time_leave:newTimeLeave, proposed_time_collect:newTimeCollect })
    .eq('id', id).select().single();
  if(error){ console.error(error); toast('Could not reschedule the request.'); return null; }
  const b = mapBooking(data);
  simulateEmail(b.email, `Booking rescheduled — proposed ${b.proposedDate} ${b.proposedTimeLeave} to ${b.proposedTimeCollect}`);
  await logAudit({ username:actorSession?.username, fullName:actorSession?.name, role:actorSession?.role,
    action:'Booking Rescheduled', status:'Success', details:`${b.name}: proposed ${b.proposedDate} ${b.proposedTimeLeave}-${b.proposedTimeCollect} (by ${byLabel})` });
  return b;
}

/* ---------- Day rail rendering (07:00–18:00 window) ----------
   Draws a short block for the drop-off leg and a separate short block
   for the pickup leg — the gap between them is when the driver is back
   at school and free for another booking. Each booking gets its own
   colour (both of its legs share it) so it's easy to tell whose is
   whose when several bookings sit close together on the same day. */
const RAIL_PALETTE = [
  { bg:'#F0DDA6', border:'#A66B2E', text:'#7A4D18' }, // gold
  { bg:'#DCEFF1', border:'#2C7E8C', text:'#1F5861' }, // teal
  { bg:'#E4EFDF', border:'#3F7A53', text:'#2C5A3C' }, // green
  { bg:'#EDE1F1', border:'#7C4C8C', text:'#5B3667' }, // plum
  { bg:'#F4E1D8', border:'#AE5A3E', text:'#7E3F2C' }, // terracotta
  { bg:'#F9E1E1', border:'#B8544F', text:'#853A36' }, // rose
  { bg:'#E1E7F4', border:'#4A5FA6', text:'#333F73' }  // indigo
];
function colorForBooking(id){
  let hash = 0;
  for(let i=0;i<id.length;i++){ hash = (hash * 31 + id.charCodeAt(i)) | 0; }
  return RAIL_PALETTE[Math.abs(hash) % RAIL_PALETTE.length];
}

async function renderDayRail(container, date){
  const startH = 7, endH = 18;
  const legMinutes = await getLegMinutes();
  const all = await getBookings();
  const bookings = all.filter(b => b.date === date && b.status === 'Accepted');
  const track = container.querySelector('.rail-track');
  track.innerHTML = '';
  bookings.forEach(b => {
    const c = colorForBooking(b.id);
    legWindows(b.timeLeave, b.timeCollect, legMinutes).forEach(w => {
      const left = ((w.start - startH*60) / ((endH-startH)*60)) * 100;
      const width = ((w.end - w.start) / ((endH-startH)*60)) * 100;
      const el = document.createElement('div');
      el.className = 'rail-block';
      el.style.left = Math.max(0,left) + '%';
      el.style.width = Math.max(2,width) + '%';
      el.style.background = c.bg;
      el.style.borderColor = c.border;
      el.style.color = c.text;
      el.title = `${w.label}: ${b.name} (${b.location}${b.destination ? ' → ' + b.destination : ''})`;
      track.appendChild(el);
    });
  });
  const hours = container.querySelector('.rail-hours');
  if(hours){
    hours.innerHTML = '';
    for(let h=startH; h<=endH; h+=1){
      const s = document.createElement('span'); s.textContent = String(h).padStart(2,'0')+':00';
      hours.appendChild(s);
    }
  }
}

/* ---------- Audit trail ---------- */
async function logAudit({ username, fullName, role, action, status='Success', details=''}){
  const ip = await getClientIP();
  const { error } = await sb.from('audit_log').insert({
    username: username || null, full_name: fullName || null, role: role || null,
    ip_address: ip, action, status, details
  });
  if(error) console.error(error);
}
async function getAuditLog(){
  const { data, error } = await sb.from('audit_log').select('*').order('at', { ascending:false }).limit(500);
  if(error){ console.error(error); return []; }
  return data;
}
function auditToCSV(rows){
  const header = ['Date & Time','Username','Full Name','Role','IP Address','Action','Status','Details'];
  const lines = [header.join(',')];
  rows.forEach(r => {
    const line = [
      new Date(r.at).toLocaleString(), r.username||'', r.full_name||'', r.role||'',
      r.ip_address||'', r.action, r.status, (r.details||'').replace(/,/g,';')
    ].map(v => `"${String(v).replace(/"/g,'""')}"`).join(',');
    lines.push(line);
  });
  return lines.join('\n');
}

/* ---------- Driver accounts (admin only — via security-definer RPCs) ---------- */
async function listDrivers(){
  const { data, error } = await sb.rpc('list_drivers');
  if(error){ console.error(error); return []; }
  return data;
}
async function createDriver(name, username, password, contact, vehicle){
  const { error } = await sb.rpc('create_driver', { p_name:name, p_username:username, p_password:password, p_contact:contact, p_vehicle:vehicle });
  if(error){ console.error(error); toast(`Could not create driver account: ${error.message}`); return false; }
  return true;
}
async function updateDriver(id, name, contact, vehicle){
  const { error } = await sb.rpc('update_driver', { p_id:id, p_name:name, p_contact:contact, p_vehicle:vehicle });
  if(error){ console.error(error); toast('Could not update driver.'); return false; }
  return true;
}
async function deleteDriver(id){
  const { error } = await sb.rpc('delete_driver', { p_id:id });
  if(error){ console.error(error); toast('Could not delete driver.'); return false; }
  return true;
}
async function resetDriverPassword(id, newPassword){
  const { error } = await sb.rpc('reset_driver_password', { p_id:id, p_new_password:newPassword });
  if(error){ console.error(error); toast('Could not reset password.'); return false; }
  return true;
}
async function toggleDriverActive(id){
  const { error } = await sb.rpc('toggle_driver_active', { p_id: id });
  if(error) console.error(error);
}

/* ---------- Management accounts (admin only) ---------- */
async function listManagers(){
  const { data, error } = await sb.rpc('list_managers');
  if(error){ console.error(error); return []; }
  return data;
}
async function createManager(name, username, password, level){
  const { error } = await sb.rpc('create_manager', { p_name:name, p_username:username, p_password:password, p_level:Number(level) });
  if(error){ console.error(error); toast(`Could not create account: ${error.message}`); return false; }
  return true;
}
async function updateManager(id, name, level){
  const { error } = await sb.rpc('update_manager', { p_id:id, p_name:name, p_level:Number(level) });
  if(error){ console.error(error); toast('Could not update account.'); return false; }
  return true;
}
async function deleteManager(id){
  const { error } = await sb.rpc('delete_manager', { p_id:id });
  if(error){ console.error(error); toast('Could not delete account.'); return false; }
  return true;
}
async function resetManagerPassword(id, newPassword){
  const { error } = await sb.rpc('reset_manager_password', { p_id:id, p_new_password:newPassword });
  if(error){ console.error(error); toast('Could not reset password.'); return false; }
  return true;
}
async function toggleManagerActive(id){
  const { error } = await sb.rpc('toggle_manager_active', { p_id: id });
  if(error) console.error(error);
}

/* ---------- Admin accounts (admin only) ---------- */
async function listAdmins(){
  const { data, error } = await sb.rpc('list_admins');
  if(error){ console.error(error); return []; }
  return data;
}
async function createAdmin(name, username, password){
  const { error } = await sb.rpc('create_admin', { p_name:name, p_username:username, p_password:password });
  if(error){ console.error(error); toast(`Could not create admin account: ${error.message}`); return false; }
  return true;
}
async function toggleAdminActive(id){
  const { error } = await sb.rpc('toggle_admin_active', { p_id: id });
  if(error) console.error(error);
}
async function deleteAdmin(id){
  const { error } = await sb.rpc('delete_admin', { p_id:id });
  if(error){ console.error(error); toast('Could not delete admin.'); return false; }
  return true;
}
async function resetAdminPassword(id, newPassword){
  const { error } = await sb.rpc('reset_admin_password', { p_id:id, p_new_password:newPassword });
  if(error){ console.error(error); toast('Could not reset password.'); return false; }
  return true;
}

/* ---------- Monthly report recipients ---------- */
async function getReportEmails(){
  const { data, error } = await sb.from('report_emails').select('*').order('name');
  if(error){ console.error(error); return []; }
  return data;
}
async function addReportEmail(name, email){
  const { error } = await sb.from('report_emails').insert({ name, email, enabled:true });
  if(error) console.error(error);
}
async function updateReportEmail(id, name, email, enabled){
  const { error } = await sb.rpc('update_report_email', { p_id:id, p_name:name, p_email:email, p_enabled:enabled });
  if(error) console.error(error);
}
async function removeReportEmail(id){
  const { error } = await sb.from('report_emails').delete().eq('id', id);
  if(error) console.error(error);
}

/* ---------- Dashboard column visibility (cosmetic — kept local per browser) ---------- */
function getViewSettings(fallback){
  try{ const v = JSON.parse(localStorage.getItem('nihss_view_settings')); return v || fallback; }
  catch(e){ return fallback; }
}
function setViewSettings(s){ localStorage.setItem('nihss_view_settings', JSON.stringify(s)); }
