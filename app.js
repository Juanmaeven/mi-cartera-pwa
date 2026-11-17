'use strict';
const $ = (id) => document.getElementById(id);
const AAD = new TextEncoder().encode('mi-cartera-tickrmeter-pwa/v2');
let secret = null; // Solo memoria. No se almacena en localStorage, cookies ni IndexedDB.
let lastSuccess = null;
let demoMode = false;
let busy = false;

const TRIGGER_URL = 'https://videoteca.tailf4304b.ts.net:8443/trigger';
const TRIGGER_POLL_MS = 12000;
const TRIGGER_WAIT_MS = 180000;
let triggerSending = false;
let triggerPending = false;
let triggerPreviousAt = 0;
let triggerPollTimer = null;
let triggerTimeoutTimer = null;

function b64bytes(b64) {
  const raw = atob(b64);
  return Uint8Array.from(raw, ch => ch.charCodeAt(0));
}
async function decodeSnapshot(bundle, phrase) {
  if (bundle.v !== 2 || bundle.alg !== 'AES-256-GCM' || bundle.kdf !== 'PBKDF2-SHA256'
      || !Number.isInteger(bundle.iterations) || bundle.iterations < 300000
      || bundle.iterations > 3000000) throw new Error('Formato de datos no compatible.');
  const input = await crypto.subtle.importKey('raw', new TextEncoder().encode(phrase), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    {name:'PBKDF2',salt:b64bytes(bundle.salt),iterations:bundle.iterations,hash:'SHA-256'},
    input, {name:'AES-GCM',length:256}, false, ['decrypt']
  );
  const plaintext = await crypto.subtle.decrypt(
    {name:'AES-GCM',iv:b64bytes(bundle.nonce),additionalData:AAD,tagLength:128},
    key, b64bytes(bundle.ciphertext)
  );
  const payload = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plaintext));
  if (!payload || !payload.values || !['data1','data2','data3'].every(k=>typeof payload.values[k]==='number'&&Number.isFinite(payload.values[k]))) {
    throw new Error('Faltan valores válidos en el resultado.');
  }
  if (!payload.calculatedAt || !Number.isFinite(Date.parse(payload.calculatedAt))) throw new Error('Falta fecha de cálculo.');
  if(Date.parse(payload.calculatedAt)>Date.now()+300000) throw new Error('El reloj o la fecha de datos no coinciden.');
  return payload;
}
const signedEuro=(n)=>`${n<0?'−':n>0?'+':''}${Math.round(Math.abs(n))} €`;
const totalEuro=(n)=>`${Math.round(n)}`; // Sin separador, como tus TickrMeter físicos.
const percent=(n)=>`${n<0?'−':n>0?'+':''}${Math.abs(n).toFixed(2)} %`;
const timeText=(t)=>new Intl.DateTimeFormat('es-ES',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(t));
function status(state,label) { $('status').dataset.state=state; $('statusText').textContent=label; }
function render(p) {
  const {data1,data2,data3}=p.values;
  $('totalValue').replaceChildren(document.createTextNode(totalEuro(data2)+' '));
  const unit=document.createElement('small');unit.textContent='€';$('totalValue').append(unit);
  $('percentValue').textContent=percent(data1);
  $('gainValue').textContent=signedEuro(data3);
  $('screenTime').textContent=timeText(p.calculatedAt);
  const color=data1>0?'green':'red';
  $('device').dataset.led=color;
  $('led').setAttribute('aria-label',`LED ${color==='green'?'verde':'rojo'}`);
  const age=Date.now()-Date.parse(p.calculatedAt);
  $('updated').textContent=`Último cálculo correcto: ${timeText(p.calculatedAt)} · Se comprueba automáticamente cada minuto.`;
  if (demoMode) {
    status('demo','Demostración');
    $('description').textContent='Ejemplo visual: estas cifras NO son las de tu cartera.';
  } else if(age>100*60000 || age<0) {
    status('stale','Datos antiguos');
    $('description').textContent='Se muestra la última lectura disponible, pero está desactualizada.';
  } else {
    status('ok','Datos recibidos');
    $('description').textContent=data1>0?'La cartera está en positivo.':data1<0?'La cartera está en negativo.':'La cartera está sin variación diaria.';
  }
  if (triggerPending && !demoMode && Date.parse(p.calculatedAt) > triggerPreviousAt) {
    resetTrigger();
    triggerNotice('¡Lectura nueva recibida! La cartera se ha actualizado.', 'ok');
  }
}
function clearView() {
  $('totalValue').textContent='— €'; $('percentValue').textContent='— %'; $('gainValue').textContent='— €';
  $('screenTime').textContent='—'; $('device').dataset.led='off';
  $('description').textContent='Introduce tu frase secreta para ver la cartera.'; $('updated').textContent='Sin datos desbloqueados.';
  status('locked','Protegida');
  $('refresh').disabled=true; $('lock').disabled=true; $('triggerUpdate').disabled=true;
}
function lock(){resetTrigger();secret=null;lastSuccess=null;demoMode=false;clearView();triggerNotice('Desbloquea la cartera para solicitar una actualización.');$('gate').hidden=false;$('passphrase').value='';$('gateError').textContent='';}
async function update() {
  if(!secret || busy || demoMode)return;
  busy=true;$('refresh').disabled=true;
  try {
    const response=await fetch('./snapshot.enc.json?refresh='+Date.now(),{cache:'no-store'});
    if(!response.ok)throw new Error(response.status===404?'Aún no se han publicado datos reales.':'No se pudieron descargar los datos.');
    const b=await response.json();
    const p=await decodeSnapshot(b,secret);
    lastSuccess=p;render(p);
  } catch (e) {
    if(lastSuccess){render(lastSuccess);status('stale','Sin actualización');$('description').textContent='Sin datos nuevos; se muestra la última lectura correcta.';}
    else throw e;
  } finally {busy=false;$('refresh').disabled=false;}
}
$('unlockForm').addEventListener('submit',async(e)=>{
  e.preventDefault();
  const phrase=$('passphrase').value;
  $('gateError').textContent='';$('unlockBtn').disabled=true;$('unlockBtn').textContent='Descifrando…';
  try {
    if(phrase.length<20) throw new Error('La frase debe tener al menos 20 caracteres.');
    secret=phrase;await update();
    $('passphrase').value='';$('gate').hidden=true;$('lock').disabled=false;$('refresh').disabled=false;
    $('triggerUpdate').disabled=false;triggerNotice('Si GitHub se retrasa, puedes pedir un cálculo nuevo desde aquí.');
  }catch(err){secret=null;$('gateError').textContent=err.message?.includes('publicado')?err.message:'No se pudo desbloquear. Comprueba la frase y que los datos estén publicados.';}
  finally{$('unlockBtn').disabled=false;$('unlockBtn').textContent='Desbloquear';}
});
$('demoBtn').addEventListener('click',()=>{
  resetTrigger();secret=null;demoMode=true;lastSuccess=null;$('passphrase').value='';$('gate').hidden=true;
  render({values:{data1:-1.74,data2:35969,data3:-637},calculatedAt:new Date().toISOString()});
  $('refresh').disabled=true;$('lock').disabled=false;$('triggerUpdate').disabled=true;
  triggerNotice('La actualización manual solo está disponible con la cartera desbloqueada.');
});

function triggerNotice(message, state = '') {
  $('triggerMessage').textContent = message;
  $('triggerMessage').dataset.state = state;
}
function resetTrigger() {
  clearInterval(triggerPollTimer);
  clearTimeout(triggerTimeoutTimer);
  triggerPollTimer = null;
  triggerTimeoutTimer = null;
  triggerSending = false;
  triggerPending = false;
  $('triggerUpdate').disabled = !secret || demoMode;
  $('triggerUpdate').textContent = '⚡ Actualizar ahora';
}
async function requestManualUpdate() {
  if (!secret || demoMode || triggerSending || triggerPending) return;
  triggerSending = true;
  triggerPreviousAt = lastSuccess ? Date.parse(lastSuccess.calculatedAt) : 0;
  $('triggerUpdate').disabled = true;
  $('triggerUpdate').textContent = 'Solicitando…';
  triggerNotice('Contactando con la Raspberry mediante Tailscale…');
  const controller = new AbortController();
  const requestTimeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(TRIGGER_URL, {
      method: 'POST',
      mode: 'cors',
      cache: 'no-store',
      headers: {'Content-Type': 'application/json', 'X-Cartera-Request': '1'},
      body: '{}',
      signal: controller.signal
    });
    if (response.status === 429) throw new Error('Ya has solicitado una actualización. Espera un minuto y vuelve a probar.');
    if (response.status === 403) throw new Error('Tailscale no reconoce este dispositivo. Comprueba que has iniciado sesión con tu cuenta.');
    if (!response.ok) throw new Error('GitHub no ha aceptado la solicitud. Inténtalo más tarde.');
    const result = await response.json();
    if (response.status !== 202 || result.status !== 'accepted') throw new Error('No se pudo confirmar la orden de actualización.');
    if (!secret || demoMode) return;
    triggerSending = false;
    triggerPending = true;
    $('triggerUpdate').textContent = 'Esperando a GitHub…';
    triggerNotice('Orden enviada a GitHub. Esperando a que publique una lectura nueva…');
    triggerPollTimer = setInterval(() => {
      if (secret && triggerPending) update().catch(() => {});
    }, TRIGGER_POLL_MS);
    triggerTimeoutTimer = setTimeout(() => {
      if (!triggerPending) return;
      resetTrigger();
      triggerNotice('La orden se envió, pero aún no hay datos nuevos. GitHub podría seguir trabajando.', 'error');
    }, TRIGGER_WAIT_MS);
  } catch (error) {
    if (!secret || demoMode) return;
    resetTrigger();
    const message = error instanceof TypeError || error?.name === 'AbortError'
      ? 'Sin conexión con la Raspberry. Activa Tailscale y, si Chrome lo pide, permite el acceso a la red local.'
      : error.message;
    triggerNotice(message, 'error');
  } finally {
    clearTimeout(requestTimeout);
    if (!triggerPending) {
      triggerSending = false;
      $('triggerUpdate').disabled = !secret || demoMode;
    }
  }
}
$('triggerUpdate').addEventListener('click', requestManualUpdate);
$('refresh').addEventListener('click',()=>update().catch(()=>{status('error','Conexión fallida');$('description').textContent='No se pudieron recuperar los datos cifrados. Revisa la conexión.';}));
$('lock').addEventListener('click',lock);
setInterval(()=>{if(secret&&!demoMode)update().catch(()=>{status('stale','Sin conexión');$('description').textContent='No se pudieron consultar datos nuevos.';});},60000);
if('serviceWorker'in navigator&&location.protocol==='https:')navigator.serviceWorker.register('./sw.js').catch(()=>{});
clearView();
