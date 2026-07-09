/* ============================================================================
 *  data.js — Capa de datos (Supabase) · Cancha de Tenis Cerros de la Alhambra
 *  Fase 2 · Hito 2
 *
 *  Qué hace: conecta con Supabase y entrega los datos YA en el formato que usa
 *  el prototipo (reservations[], releases[], closures[], holidays, etc.), para
 *  reusar todo el motor de pintado sin reescribirlo. También expone login,
 *  reservar y cancelar.
 *
 *  CÓMO SE CARGA (en index.html, antes de app.js):
 *    <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
 *    <script src="data.js"></script>
 *    <script src="app.js"></script>
 *
 *  👉 LLENA ESTOS DOS HUECOS (botón "Connect" del proyecto, o Settings → API / API Keys):
 * ========================================================================== */
const SUPABASE_URL  = 'https://lknvospoabzkyljelcuy.supabase.co';
const SUPABASE_ANON = 'sb_publishable_m1SllmJ_TksvKl8pRGA5RA_BlUjvE7S';

/* ---------------------------------------------------------------------------- */
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
const TZ = 'America/Bogota';

// Recuperación de contraseña: cuando el usuario llega por el enlace del correo,
// Supabase dispara este evento. Avisamos a la app para mostrar "nueva contraseña".
try{
  sb.auth.onAuthStateChange((event)=>{
    if(event==='PASSWORD_RECOVERY' && typeof window!=='undefined'){
      window.__recovery=true;
      if(typeof window.startRecovery==='function') window.startRecovery();
    }
  });
}catch(e){}

/* ===== Helpers de fecha/hora (Colombia es UTC−5 fijo, sin horario de verano) ===== */
// ISO (timestamptz) → partes en hora de Bogotá: {date:'YYYY-MM-DD', h, min}
function bogotaParts(iso){
  const f = new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',
    day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date(iso));
  const o={}; f.forEach(p=>o[p.type]=p.value);
  return { date:`${o.year}-${o.month}-${o.day}`, h:(+o.hour)%24, min:+o.minute };
}
// {date,h,min} en Bogotá → ISO en UTC (para mandar a la base)
function toISO(date,h,min){
  const hh=String(h).padStart(2,'0'), mm=String(min||0).padStart(2,'0');
  return new Date(`${date}T${hh}:${mm}:00-05:00`).toISOString();
}
function durMin(startISO,endISO){ return Math.round((new Date(endISO)-new Date(startISO))/60000); }
// Normaliza lo que la persona escribe a una etiqueta canónica, para que la MISMA
// casa nunca se duplique: "29a", "29 A", "casa 29A" → todos "Casa 29A".
function normHouse(s){
  s=(s||'').trim().replace(/^casa\s+/i,'').replace(/\s+/g,'').toUpperCase();
  return s ? 'Casa '+s : '';
}

/* ===== Mapeos: forma de la base → forma del prototipo ===== */
function mapReservation(r){                       // r puede traer joins (houses, profiles)
  const p = bogotaParts(r.starts_at);
  return {
    id: r.id,
    date: p.date, h: p.h, min: p.min,
    dur: durMin(r.starts_at, r.ends_at),
    house: r.house_label || (r.houses && r.houses.label) || r.house,
    name: r.name || r.student_name || (r.profiles && r.profiles.full_name) || null,
    type: r.type,
    profile_id: r.profile_id || null
  };
}
function mapReleasesToHalves(rows){               // rango → medias horas {date,h,half,type,relId}
  const out=[];
  (rows||[]).forEach(r=>{
    let t=new Date(r.starts_at).getTime(); const end=new Date(r.ends_at).getTime();
    while(t<end){ const p=bogotaParts(new Date(t).toISOString());
      out.push({date:p.date, h:p.h, half:p.min>=30?1:0, type:r.type, relId:r.id}); t+=30*60000; }
  });
  return out;
}
function mapClosures(rows){                        // → {id,start,end,reason,kind,allDay,fromH,toH,startTs,endTs}
  return (rows||[]).map(c=>{ const s=bogotaParts(c.starts_at), e=bogotaParts(c.ends_at);
    return {id:c.id, start:s.date, end:e.date, reason:c.reason, kind:c.kind,
            allDay:false, fromH:s.h, toH:e.h + (e.min>0?1:0),
            startTs:new Date(c.starts_at).getTime(), endTs:new Date(c.ends_at).getTime()}; });
}
function relTime(iso){
  const diff=Date.now()-new Date(iso).getTime(), min=Math.round(diff/60000);
  if(min<1) return 'Ahora'; if(min<60) return 'Hace '+min+' min';
  const hr=Math.round(min/60); if(hr<24) return 'Hace '+hr+(hr===1?' hora':' horas');
  const d=Math.round(hr/24); return 'Hace '+d+(d===1?' día':' días');
}

/* ===== Errores del servidor → mensajes amables ===== */
const ERR_MSG = {
  SIN_CUPO:'Esa casa ya no tiene cupo esta semana. Puedes reservar horarios que libera el profesor, o ir con el profesor en su horario: eso no consume cupo.',
  YA_RESERVADO:'Ese horario ya está reservado.',
  HORARIO_DEL_PROFESOR:'Ese horario es del profesor.',
  FUERA_DE_HORARIO:'Ese horario está fuera del horario de la cancha.',
  CANCHA_CERRADA:'La cancha está cerrada en ese horario.',
  SIN_LIBERACION:'Ese horario ya no está disponible.',
  CASA_NO_TUYA:'Esa casa no está vinculada a tu cuenta.',
  FUERA_DE_VENTANA:'Ya no se puede cancelar (muy cerca de la hora).',
  SIN_PERMISO:'No tienes permiso para esta acción.',
  NO_EXISTE:'La reserva ya no existe.',
  PERM_DESHABILITADO:'Los horarios permanentes no están habilitados por ahora.',
  SOLO_RESIDENTE:'Solo un residente puede solicitar un horario permanente.',
  NO_ES_HORA_DEL_PROFESOR:'Un horario permanente solo se puede pedir en una hora del profesor.',
  YA_SOLICITADO:'Ya existe una solicitud o un horario permanente para ese día y hora.',
  YA_RESUELTA:'Esa solicitud ya fue atendida.',
  PEDIR_A_ADMIN:'Ya usaste tu cancelación de último momento de esta semana. Puedes pedirle a administración que la cancele.',
  YA_EMPEZO:'Esa reserva ya empezó; no se puede cancelar.',
  YA_PEDIDO:'Ya enviaste la solicitud de cancelación; espera la respuesta de administración.',
  SOLO_NORMAL:'Solo se puede solicitar la cancelación de una reserva normal.',
  CLASE_YA_TIENE_CASA:'Ese horario de clase ya tiene una casa asignada; no se puede solicitar.',
  SOLO_HORA_COMPLETA:'Por ahora solo se reserva por hora completa.'
};
function mapError(error){
  const raw=(error && (error.message||error.hint||'')) || '';
  for(const k in ERR_MSG){ if(raw.includes(k)){ const e=new Error(ERR_MSG[k]); e.code=k; return e; } }
  return new Error(raw || 'Ocurrió un error.');
}
// Errores de registro / login en lenguaje claro
function authErr(msg){
  msg=msg||'';
  if(/already|registered|exists|duplicate/i.test(msg)) return 'Ese correo ya tiene una cuenta. Intenta iniciar sesión.';
  if(/password/i.test(msg)) return 'La contraseña no es válida (mínimo 6 caracteres).';
  if(/email|correo/i.test(msg)) return 'El correo no es válido.';
  return msg || 'No se pudo crear la cuenta.';
}
// Errores que devuelve la Edge Function admin-create-user
const CREATE_ERR = {
  CORREO_YA_EXISTE:'Ese correo ya tiene una cuenta.',
  SIN_PERMISO:'No tienes permiso para crear cuentas.',
  NO_AUTENTICADO:'Tu sesión expiró. Vuelve a entrar.',
  FALTAN_DATOS:'Faltan datos (correo y clave).',
  CLAVE_CORTA:'La clave debe tener al menos 6 caracteres.',
  ROL_INVALIDO:'Rol no válido.',
  USUARIO_INVALIDO:'Usuario inválido: 3 a 20 letras o números (sin espacios).',
  USUARIO_YA_EXISTE:'Ese usuario ya está en uso.',
  FALTA_CORREO_O_USUARIO:'Pon un correo o un usuario (al menos uno).',
  ULTIMO_ADMIN:'No puedes eliminar al único administrador.',
  FALTA_ID:'Falta indicar la cuenta a eliminar.',
  ERROR_AL_CREAR:'No se pudo crear la cuenta.'
};
function createErr(code){ return new Error(CREATE_ERR[code] || code || 'No se pudo crear la cuenta.'); }

/* ============================================================================
 *  AUTENTICACIÓN
 * ========================================================================== */
// Resuelve un "usuario o correo" al correo real (los usuarios se traducen vía RPC).
async function resolveEmail(identifier){
  const id=(identifier||'').trim();
  if(id.includes('@')) return id;                       // ya es correo
  const {data}=await sb.rpc('email_for_username',{p_username:id});
  return data || null;                                  // null si el usuario no existe
}
const Auth = {
  async signIn(identifier, password){
    const email=await resolveEmail(identifier);
    if(!email) throw new Error('Usuario o contraseña incorrectos.');
    const {error}=await sb.auth.signInWithPassword({email,password});
    if(error) throw new Error('Usuario o contraseña incorrectos.');
  },
  async signUp({email,password,full_name,phone,house,username}){
    const u=(username||'').trim().toLowerCase();
    const contact=(email||'').trim();
    const authEmail = contact || (u + '@cerros.co');        // sin correo → correo interno desde el usuario
    const {error}=await sb.auth.signUp({email:authEmail,password,
      options:{data:{full_name, phone, requested_house: house||null, username: u||null, contact_email: contact||null}}});  // queda 'pending'
    if(error) throw new Error(authErr(error.message));
  },
  async usernameAvailable(username){
    const {data,error}=await sb.rpc('username_available',{p_username:(username||'').trim()});
    if(error) return true;                               // si falla la consulta, no bloquear (lo valida el índice único)
    return data!==false;
  },
  // ¿esa casa ya existe (ya tiene cuenta)? — una casa = una cuenta
  async houseTaken(label){
    const norm=normHouse(label); if(!norm) return false;
    const {data}=await sb.from('houses').select('id').ilike('label',norm).limit(1);
    return !!(data && data.length);
  },
  async signOut(){ await sb.auth.signOut(); },
  async resetPassword(identifier){
    const email=await resolveEmail(identifier);
    if(!email) throw new Error('No encontramos ese usuario o correo.');
    const redirectTo = (typeof location!=='undefined') ? (location.origin + location.pathname.replace(/index\.html$/,'')) : undefined;
    await sb.auth.resetPasswordForEmail(email, redirectTo ? {redirectTo} : undefined);
  },
  async updatePassword(newPass){ const {error}=await sb.auth.updateUser({password:newPass}); if(error) throw new Error(error.message); },
  async currentProfile(){                          // {id,full_name,role,status,phone} o null
    const {data:{user}}=await sb.auth.getUser();
    if(!user) return null;
    let {data,error}=await sb.from('profiles').select('id,full_name,role,status,phone,notif_seen_at,notif_prefs').eq('id',user.id).single();
    if(error){ const r=await sb.from('profiles').select('id,full_name,role,status,phone').eq('id',user.id).single(); data=r.data; } // por si aún no existe notif_prefs
    return data || null;
  },
  // Preferencias de avisos push del residente (qué tipos quiere recibir)
  async setNotifSettings(profileId, {prefs}){
    const {error}=await sb.from('profiles').update({notif_prefs:prefs}).eq('id',profileId);
    if(error) throw mapError(error);
  }
};

/* ===== Notificaciones push (Web Push) ===== */
const VAPID_PUBLIC_KEY = 'BE4pJijzs8Sf6cy62MK5n5N1Sgk-97b5FMCjc1IN9Tf6N1RkaOJsLSjszx9QAQCUtkmIFQbSAvxdGnYjQwPg2Rw';
async function savePushSub(profileId, sub){
  const j = sub.toJSON();
  const {error}=await sb.from('push_subscriptions')
    .upsert({ profile_id:profileId, endpoint:sub.endpoint, p256dh:j.keys.p256dh, auth:j.keys.auth }, { onConflict:'endpoint' });
  if(error) throw mapError(error);
}
async function removePushSub(endpoint){
  const {error}=await sb.from('push_subscriptions').delete().eq('endpoint', endpoint);
  if(error) throw mapError(error);
}

/* ============================================================================
 *  LECTURAS (devuelven datos en formato del prototipo)
 * ========================================================================== */
async function getHouses(){
  const {data}=await sb.from('houses').select('id,label').order('label');
  return data||[];
}
async function getMyHouses(profileId){
  const {data}=await sb.from('house_members')
    .select('is_primary, houses(id,label)').eq('profile_id',profileId);
  return (data||[]).map(r=>({id:r.houses.id, label:r.houses.label, primary:r.is_primary}));
}
// Toda la configuración en UNA sola consulta (cupo, flexible, permanente)
async function getConfig(){
  const {data}=await sb.from('app_config').select('key,value');
  const m={}; (data||[]).forEach(x=>m[x.key]=x.value);
  return {
    cupo: m.weekly_cupo_hours ? Number(m.weekly_cupo_hours) : 2,
    profFlexible: m.prof_flexible==='true',
    permEnabled: m.perm_enabled==='true',
    openStart: m.open_start ? Number(m.open_start) : 5,   // primera hora reservable (4/5/6)
    openEnd:   m.open_end   ? Number(m.open_end)   : 23,  // hora de cierre (22 o 23)
    halfHours: m.half_hours==='true'                      // ¿se permite reservar media hora? (por defecto NO)
  };
}
// Horario del profesor (editable). Si la tabla aún no existe, devuelve [] y la app usa el horario fijo de respaldo.
async function getProfSchedule(){
  const {data}=await sb.from('prof_schedule').select('dow,start_min,end_min').order('dow').order('start_min');
  return (data||[]).map(r=>({dow:r.dow, startMin:r.start_min, endMin:r.end_min}));
}
async function getMaintSchedule(){
  const {data}=await sb.from('maint_schedule').select('dow,start_min,end_min').order('dow').order('start_min');
  return (data||[]).map(r=>({dow:r.dow, startMin:r.start_min, endMin:r.end_min}));
}
async function getClassTemplate(){                    // plantilla de clases (para exportar a Excel)
  const {data}=await sb.from('class_schedule').select('dow,start_min,end_min,houses(label),student_name');
  return (data||[]).map(r=>({dow:r.dow, startMin:r.start_min, endMin:r.end_min, house:(r.houses&&r.houses.label)||'', student_name:r.student_name||''}));
}
async function setClassTemplate(entries){             // cargar/reemplazar la plantilla (importar Excel)
  const {error}=await sb.rpc('set_class_template',{p:entries}); if(error) throw mapError(error);
}
// Horarios permanentes (según RLS: el residente ve los suyos; profesor/admin todos). Resistente si la tabla no existe.
async function getRecurring(){
  const {data}=await sb.from('recurring_classes').select('id,house_id,profile_id,dow,start_min,end_min,status,created_at,houses(label)').order('created_at',{ascending:false});
  return (data||[]).map(r=>({id:r.id, houseId:r.house_id, house:(r.houses&&r.houses.label)||'', profileId:r.profile_id, dow:r.dow, startMin:r.start_min, endMin:r.end_min, status:r.status}));
}
async function getHolidays(){
  const {data}=await sb.from('holidays').select('day');
  return new Set((data||[]).map(r=>r.day));
}
async function getReleases(){
  const {data}=await sb.from('releases').select('id,starts_at,ends_at,type');
  return mapReleasesToHalves(data);
}
async function getClosures(){
  const {data}=await sb.from('closures').select('id,starts_at,ends_at,reason,kind');
  return mapClosures(data);
}
// Calendario: miembros ven solo casa+hora (vista v_calendar); el staff ve nombres
async function getCalendar(role){
  // La app solo muestra la semana actual en adelante, así que no traemos historial
  // viejo (8 días de margen cubren toda la semana en curso). Mantiene la carga liviana.
  const cutoff = new Date(Date.now() - 8*24*60*60*1000).toISOString();
  if(role==='admin' || role==='portero'){
    // OJO: reservations tiene DOS FK a profiles (profile_id y created_by). Hay que
    // desambiguar el embed con !profile_id, si no PostgREST falla y no llega nada.
    const {data,error}=await sb.from('reservations')
      .select('id,starts_at,ends_at,type,profile_id,student_name,houses(label),profiles!profile_id(full_name)')
      .gte('starts_at', cutoff).order('starts_at');
    if(error) console.warn('getCalendar(staff):', error.message);
    const prim = await primaryHouseMap();           // para el detalle "de la Casa X"
    return (data||[]).map(r=>{ const m=mapReservation({...r, house_label:r.houses&&r.houses.label, name:r.profiles&&r.profiles.full_name});
      const home = prim[r.profile_id];
      m.fromHouse = (home && home!==m.house) ? home : null;   // su casa, si reservó a nombre de otra
      return m; });
  }
  const {data}=await sb.from('v_calendar').select('id,house_label,starts_at,ends_at,type,student_name').gte('starts_at', cutoff).order('starts_at');
  return (data||[]).map(mapReservation);
}
async function primaryHouseMap(){                   // profile_id -> etiqueta de su casa principal
  const {data}=await sb.from('house_members').select('profile_id,is_primary,houses(label)').eq('is_primary',true);
  const o={}; (data||[]).forEach(r=>{ o[r.profile_id]=r.houses && r.houses.label; }); return o;
}
async function getNotifications(role, profileId, seenAt){
  const {data}=await sb.from('notifications').select('*, houses(label)')
    .or(`profile_id.eq.${profileId},role.eq.${role}`).order('created_at',{ascending:false});
  const seen = seenAt ? new Date(seenAt).getTime() : 0;   // marca de "todo leído" del usuario
  return (data||[]).map(n=>({
    id:n.id, type:n.type, title:n.title, body:n.body,
    roles: n.role==='member' ? ['member','master'] : (n.role ? [n.role] : ['member','master']),
    resId: n.reservation_id, recId: n.recurring_id, house: n.houses && n.houses.label,
    // No leída solo si no está marcada y es más nueva que la marca del usuario.
    // Así las notificaciones por rol (sin profile_id) tampoco reaparecen tras recargar.
    status: n.status, unread: !n.read && new Date(n.created_at).getTime() > seen, time: relTime(n.created_at)
  }));
}
async function getActivity(){                       // historial (admin/portería)
  const {data,error}=await sb.from('activity_log')
    .select('*, houses(label), profiles!profile_id(full_name)').order('created_at',{ascending:false}).limit(200);
  if(error) console.warn('getActivity:', error.message);
  return (data||[]).map(a=>{ const s=a.res_starts?bogotaParts(a.res_starts):null;
    return { id:a.id, action:a.action,
      name:a.profiles&&a.profiles.full_name, house:a.houses&&a.houses.label,
      date:s&&s.date, h:s&&s.h, min:s&&s.min,
      dur:a.res_starts&&a.res_ends?durMin(a.res_starts,a.res_ends):60,
      type:a.res_type, ts:new Date(a.created_at).getTime() }; });
}

async function getUsers(){                          // lista de cuentas (admin/portería)
  // IMPORTANTE: perfiles SIN cruce (el embed con house_members botaba a los
  // perfiles sin casa, p.ej. los pendientes). Traemos las casas aparte y unimos.
  const {data:profs,error}=await sb.from('profiles')
    .select('id,full_name,role,status,phone,requested_house,username,email')
    .order('full_name');
  if(error) console.warn('getUsers:', error.message);
  const {data:hm}=await sb.from('house_members').select('profile_id,is_primary, houses(label)');
  const byProfile={};
  (hm||[]).forEach(r=>{ (byProfile[r.profile_id]=byProfile[r.profile_id]||[]).push(r); });
  return (profs||[]).map(p=>{
    const mine=byProfile[p.id]||[];
    const hl=mine.map(x=>x.houses&&x.houses.label).filter(Boolean);
    const prim=mine.find(x=>x.is_primary);
    return { id:p.id, name:p.full_name||'(sin nombre)', role:p.role, phone:p.phone||'',
      active:p.status==='active', status:p.status, requestedHouse:p.requested_house||'', username:p.username||'',
      houses:hl, house:(prim&&prim.houses.label)||hl[0]||'—', email:p.email||'' };
  });
}

// Trae TODO lo necesario para pintar, según el perfil logueado
async function fetchAll(profile){
  const member = isMemberRole(profile.role);
  const staff  = profile.role==='admin' || profile.role==='portero';
  const isProf = profile.role==='prof';
  // TODO en un solo lote paralelo (antes había hasta 3 fases secuenciales)
  const [myHouses, reservations, releases, closures, holidays, houses, cfg, notifs, profSchedule, recurring, activity, users, profClasses, absences, maintSchedule, classTemplate] = await Promise.all([
    member ? getMyHouses(profile.id) : Promise.resolve([]),
    getCalendar(profile.role), getReleases(), getClosures(), getHolidays(),
    getHouses(), getConfig(), getNotifications(profile.role, profile.id, profile.notif_seen_at),
    getProfSchedule(), getRecurring(),
    staff ? getActivity() : Promise.resolve([]),
    staff ? getUsers()    : Promise.resolve([]),
    isProf ? getProfClasses() : Promise.resolve([]),
    getAbsences(), getMaintSchedule(),
    (profile.role==='admin') ? getClassTemplate() : Promise.resolve([])
  ]);
  return { profile, myHouses, reservations, releases, closures, holidays, houses,
    cupo:cfg.cupo, profFlexible:cfg.profFlexible, permEnabled:cfg.permEnabled, permRoute:'both',
    openStart:cfg.openStart, openEnd:cfg.openEnd, halfHours:cfg.halfHours,
    notifs, profSchedule, recurring, activity, users, profClasses, absences, maintSchedule, classTemplate };
}
function isMemberRole(role){ return role==='member' || role==='master'; }

/* ============================================================================
 *  ESCRITURAS (validadas en el servidor por las funciones RPC)
 * ========================================================================== */
async function book({houseId, date, h, min, dur, type}){
  const startISO = toISO(date, h, min||0);
  const endISO   = new Date(new Date(startISO).getTime() + dur*60000).toISOString();
  const {data,error}=await sb.rpc('create_reservation',
    {p_house:houseId, p_start:startISO, p_end:endISO, p_type:type});
  if(error) throw mapError(error);
  return data;
}
async function cancel(id){
  const {error}=await sb.rpc('cancel_reservation',{p_id:id});
  if(error) throw mapError(error);
}
async function getProfClasses(){                      // clases del profesor (casa + nombre del alumno)
  const {data,error}=await sb.rpc('prof_classes');
  if(error){ console.warn('prof_classes:', error.message); return []; }
  return (data||[]).map(r=>{ const s=bogotaParts(r.starts_at);
    return { id:r.id, date:s.date, h:s.h, min:s.min, dur:durMin(r.starts_at, r.ends_at),
             type:r.type, house:r.house_label||'', student_name:r.student_name||'' }; });
}
async function changeClassHouse(id, house, student){  // el profesor cambia la casa/alumno de una clase
  const {error}=await sb.rpc('change_class_house',{p_id:id, p_house:house||'', p_student:student||''});
  if(error) throw mapError(error);
}
async function releaseClass(id){                      // el profesor libera una clase (queda 'flex' para residentes)
  const {error}=await sb.rpc('release_class',{p_id:id});
  if(error) throw mapError(error);
}
async function getAbsences(){                         // ausencias del profesor (rangos) → {id,date,startMin,endMin}
  const {data}=await sb.from('prof_absences').select('id,starts_at,ends_at');
  return (data||[]).map(a=>{ const s=bogotaParts(a.starts_at), e=bogotaParts(a.ends_at);
    return { id:a.id, date:s.date, startMin:s.h*60+s.min, endMin:(e.date===s.date? e.h*60+e.min : 1440) }; });
}
async function markAbsence(date, fromMin, toMin){     // admin marca ausencia (null,null = todo el día)
  const {error}=await sb.rpc('mark_prof_absence',{p_date:date, p_start_min:(fromMin==null?null:fromMin), p_end_min:(toMin==null?null:toMin)});
  if(error) throw mapError(error);
}
async function unmarkAbsence(id){
  const {error}=await sb.rpc('unmark_prof_absence',{p_id:id});
  if(error) throw mapError(error);
}
async function requestCancel(id){                     // residente pide a admin/portería cancelar
  const {error}=await sb.rpc('request_cancel',{p_id:id});
  if(error) throw mapError(error);
}
async function decideCancel(id, approve){             // admin/portería aprueban o rechazan
  const {error}=await sb.rpc('decide_cancel',{p_id:id, p_approve:approve});
  if(error) throw mapError(error);
}
/* ===== Horarios permanentes (Etapa 3) ===== */
async function requestRecurring(houseId, dow, startMin, endMin){
  const {data,error}=await sb.rpc('request_recurring',{p_house:houseId, p_dow:dow, p_start_min:startMin, p_end_min:endMin});
  if(error) throw mapError(error); return data;
}
async function decideRecurring(id, approve){ const {error}=await sb.rpc('decide_recurring',{p_id:id, p_approve:approve}); if(error) throw mapError(error); }
async function cancelRecurring(id){ const {error}=await sb.rpc('cancel_recurring',{p_id:id}); if(error) throw mapError(error); }
async function materializeRecurring(){ const {data,error}=await sb.rpc('materialize_recurring'); if(error){ console.warn('materialize_recurring:', error.message); return 0; } return data||0; }
async function materializeClasses(){ const {data,error}=await sb.rpc('materialize_classes'); if(error){ console.warn('materialize_classes:', error.message); return 0; } return data||0; }

/* ===== Acciones de gestión (hitos siguientes; aquí las simples) ===== */
const Admin = {
  async setCupo(hours){ const {error}=await sb.from('app_config').update({value:String(hours)}).eq('key','weekly_cupo_hours'); if(error) throw mapError(error); },
  // Horario de operación: hora de inicio (4/5/6) y de cierre (22 o 23)
  async setOpenHour(which, val){ const key=(which==='start')?'open_start':'open_end'; const {error}=await sb.from('app_config').update({value:String(val)}).eq('key',key); if(error) throw mapError(error); },
  // Permitir reservar media hora (por defecto apagado = solo hora completa)
  async setHalfHours(on){ const {error}=await sb.from('app_config').update({value:on?'true':'false'}).eq('key','half_hours'); if(error) throw mapError(error); },
  // Modo flexible del horario del profesor (interruptor global)
  async setProfFlexible(on){ const {error}=await sb.from('app_config').update({value:on?'true':'false'}).eq('key','prof_flexible'); if(error) throw mapError(error); },
  // Horarios permanentes: habilitar y a quién llegan las solicitudes
  async setPermEnabled(on){ const {error}=await sb.from('app_config').update({value:on?'true':'false'}).eq('key','perm_enabled'); if(error) throw mapError(error); },
  // Reemplaza TODO el horario del profesor por las filas dadas ([{dow,startMin,endMin}])
  async setProfSchedule(rows){
    const del=await sb.from('prof_schedule').delete().gte('dow',0);
    if(del.error) throw mapError(del.error);
    if(rows&&rows.length){
      const ins=await sb.from('prof_schedule').insert(rows.map(r=>({dow:r.dow, start_min:r.startMin, end_min:r.endMin})));
      if(ins.error) throw mapError(ins.error);
    }
  },
  async setMaintSchedule(rows){
    const del=await sb.from('maint_schedule').delete().gte('dow',0);
    if(del.error) throw mapError(del.error);
    if(rows&&rows.length){
      const ins=await sb.from('maint_schedule').insert(rows.map(r=>({dow:r.dow, start_min:r.startMin, end_min:r.endMin})));
      if(ins.error) throw mapError(ins.error);
    }
  },
  // Reiniciar el periodo de clases fijas (para cargar una plantilla nueva)
  async resetClassPeriod(){ const {error}=await sb.rpc('reset_class_period'); if(error) throw mapError(error); },
  async setStatus(profileId, status){ const {error}=await sb.from('profiles').update({status}).eq('id',profileId); if(error) throw mapError(error); },
  async approveUser(profileId){ return Admin.setStatus(profileId,'active'); },
  // Busca una casa por etiqueta (sin distinguir mayúsculas) o la crea. Devuelve su id.
  async findOrCreateHouse(label){
    const norm=normHouse(label); if(!norm) return null;
    const {data:found}=await sb.from('houses').select('id').ilike('label',norm).limit(1);
    if(found && found.length) return found[0].id;
    const {data:ins,error}=await sb.from('houses').insert({label:norm}).select('id').single();
    if(error) throw mapError(error);
    return ins.id;
  },
  // Aprobar una solicitud de auto-registro: crea/vincula la casa (si es residente), fija rol y activa.
  async approve(profileId, houseLabel, role){
    if(houseLabel){ const id=await Admin.findOrCreateHouse(houseLabel); if(id) await Admin.setHouses(profileId,[id]); }
    const {error}=await sb.from('profiles').update({status:'active', role:role||'member'}).eq('id',profileId);
    if(error) throw mapError(error);
  },
  // Crear cuenta desde el panel (vía Edge Function con llave secreta del servidor).
  async createUser(payload){
    const {data,error}=await sb.functions.invoke('admin-create-user',{body:payload});
    if(error){
      let code='', status='';
      try{ status=error.context && error.context.status; }catch(_){}
      try{ const j=await error.context.json(); code=j&&j.error; }catch(_){}
      if(code && CREATE_ERR[code]) throw createErr(code);          // error conocido del servidor
      // error sin código claro → dar pista del problema real
      let msg='No se pudo crear la cuenta';
      if(status) msg+=' (error '+status+')';
      if(String(status)==='404' || !status) msg+='. Revisa que la función "admin-create-user" esté desplegada en Supabase (con ese nombre exacto).';
      else if(String(status)==='401' || String(status)==='403') msg+='. Vuelve a entrar como administrador.';
      else if(code) msg+='. ('+code+')';
      throw new Error(msg);
    }
    if(data&&data.error) throw createErr(data.error);
    return data;
  },
  // Cambiar la clave de otra cuenta (admin) — útil para portería/profesor.
  async setPassword(profileId, password){
    const {data,error}=await sb.functions.invoke('admin-set-password',{body:{user_id:profileId, password}});
    if(error){
      let code='', status='';
      try{ status=error.context && error.context.status; }catch(_){}
      try{ const j=await error.context.json(); code=j&&j.error; }catch(_){}
      if(code && CREATE_ERR[code]) throw createErr(code);
      throw new Error('No se pudo cambiar la clave'+(status?' (error '+status+')':'')+'. Revisa que la función "admin-set-password" esté desplegada.');
    }
    if(data&&data.error) throw createErr(data.error);
    return data;
  },
  // Eliminar una cuenta (vía Edge Function con llave secreta). El admin borra a
  // cualquiera; un usuario se borra a sí mismo pasando su propio id.
  async deleteUser(profileId){
    const {data,error}=await sb.functions.invoke('delete-user',{body:{user_id:profileId}});
    if(error){
      let code='', status='';
      try{ status=error.context && error.context.status; }catch(_){}
      try{ const j=await error.context.json(); code=j&&j.error; }catch(_){}
      if(code && CREATE_ERR[code]) throw createErr(code);
      throw new Error('No se pudo eliminar la cuenta'+(status?' (error '+status+')':'')+'. Revisa que la función "delete-user" esté desplegada en Supabase.');
    }
    if(data&&data.error) throw createErr(data.error);
    return data;
  },
  // reemplaza por completo las casas de una cuenta (recibe ids de casa; la primera es la principal)
  async setHouses(profileId, houseIds){
    await sb.from('house_members').delete().eq('profile_id',profileId);
    if(houseIds.length){ const rows=houseIds.map((id,i)=>({profile_id:profileId, house_id:id, is_primary:i===0}));
      const {error}=await sb.from('house_members').insert(rows); if(error) throw mapError(error); }
  },
  async linkHouse(profileId, houseId, isPrimary=false){
    await sb.from('house_members').upsert({profile_id:profileId, house_id:houseId, is_primary:isPrimary}); },
  async createRelease(startISO,endISO,type){ const {error}=await sb.from('releases').insert({starts_at:startISO,ends_at:endISO,type}); if(error) throw mapError(error); },
  async createReleases(rows){ if(rows&&rows.length){ const {error}=await sb.from('releases').insert(rows); if(error) throw mapError(error); } },
  // avisar a los residentes que se abrió un horario (no rompe si falla)
  async notifyRelease(type, desc){ const {error}=await sb.rpc('notify_release',{p_type:type, p_desc:desc||''}); if(error) console.warn('notify_release:', error.message); },
  async deleteRelease(id){ if(id!=null){ const {error}=await sb.from('releases').delete().eq('id',id); if(error) throw mapError(error); } },
  async createClosure(startISO,endISO,reason,kind='maintenance'){
    const {error}=await sb.from('closures').insert({starts_at:startISO,ends_at:endISO,reason,kind}); if(error) throw mapError(error); },
  async deleteClosure(id){ if(id!=null){ const {error}=await sb.from('closures').delete().eq('id',id); if(error) throw mapError(error); } },
  // borra las reservas que se solapan con un rango (al cerrar la cancha) — solo admin
  async clearReservationsInRange(startISO,endISO){
    const {error}=await sb.from('reservations').delete().lt('starts_at',endISO).gt('ends_at',startISO); if(error) throw mapError(error); },
};

/* ===== Modo lluvia (RPC) y notificaciones ===== */
const Rain = {
  async activate(hours){ const {data,error}=await sb.rpc('activate_rain',{p_hours:hours}); if(error) throw mapError(error); return data; },
  async deactivate(){ const {error}=await sb.rpc('deactivate_rain'); if(error) throw mapError(error); }
};
async function markNotif(id, status){ const {error}=await sb.from('notifications').update({status, read:true}).eq('id',id); if(error) throw mapError(error); }
async function markAllRead(profileId){
  // Marca todo como leído con la HORA DEL SERVIDOR y la devuelve, para que la app
  // la guarde en memoria sin desfase de reloj. Así las notificaciones por rol
  // (que se comparten) tampoco vuelven a salir como nuevas al recargar/refrescar.
  const {data,error}=await sb.rpc('notif_mark_all_read');
  if(error){ // respaldo por si la función aún no está desplegada
    console.warn('notif_mark_all_read:', error.message);
    const now=new Date().toISOString();
    await sb.from('notifications').update({read:true}).eq('profile_id',profileId).eq('read',false);
    await sb.from('profiles').update({notif_seen_at:now}).eq('id',profileId);
    return now;
  }
  return data; // timestamptz del servidor
}

/* ===== API pública del módulo ===== */
window.DB = {
  Auth, Admin, Rain,
  fetchAll, book, cancel, requestCancel, decideCancel, markNotif, markAllRead,
  getProfClasses, changeClassHouse, releaseClass, markAbsence, unmarkAbsence, setClassTemplate,
  requestRecurring, decideRecurring, cancelRecurring, materializeRecurring, materializeClasses,
  VAPID_PUBLIC_KEY, savePushSub, removePushSub,
  getHouses, getMyHouses, getCalendar, getNotifications, getActivity,
  // utilidades por si se necesitan en app.js:
  bogotaParts, toISO, isMemberRole, normHouse
};
