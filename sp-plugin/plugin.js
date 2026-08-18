/**
 * Home Assistant Bridge v5.0 - Super Productivity Plugin
 * 
 * Architecture:
 * - plugin.js = credential manager + HA API proxy + rules engine (survives navigation)
 * - index.html (iframe) = UI only, communicates via window.parent.haBridge
 * 
 * SECURITY: haToken stored via PluginAPI.setSecret() (never synced/exported).
 * Non-secret config stored via PluginAPI.persistDataSynced().
 */

// ============================================================
// CONFIG & SECRETS
// ============================================================

let config = { haUrl: '', webhookId: '', rules: [], showSensors: '', autoTaskSync: true };
let haToken = '';
let deviceId = '';
let configReady = false;

async function loadConfig() {
  // Load non-secret config from synced storage
  try {
    const raw = await PluginAPI.loadSyncedData();
    if (raw && raw.length > 2) {
      const parsed = JSON.parse(raw);
      // Migration: if old config has token in synced data, move to secrets
      if (parsed.haToken || parsed._token) {
        const tok = parsed.haToken || parsed._token;
        await PluginAPI.setSecret('haToken', tok);
        haToken = tok;
        delete parsed.haToken;
        delete parsed._token;
        await PluginAPI.persistDataSynced(JSON.stringify(parsed));
        console.log('[HA Bridge] Migrated token to secret storage');
      }
      config = parsed;
    }
  } catch (e) { console.log('[HA Bridge] Config load error:', e); }
  if (!config.rules) config.rules = [];
  if (typeof config.autoTaskSync !== 'boolean') config.autoTaskSync = true;

  // Load token from secret storage (local-only, never synced)
  try {
    const secret = await PluginAPI.getSecret('haToken');
    if (secret) haToken = secret;
  } catch (e) { console.log('[HA Bridge] getSecret error:', e); }

  // A device identifier must remain local. If it were stored in synced plugin
  // data, two SP installations would identify as the same sync participant.
  try {
    deviceId = await PluginAPI.getSecret('deviceId') || '';
    if (!deviceId) {
      deviceId = typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `sp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await PluginAPI.setSecret('deviceId', deviceId);
    }
  } catch (e) { console.log('[HA Bridge] device id error:', e); }

  configReady = true;
  console.log('[HA Bridge] Config ready:', config.rules.length, 'rules, haUrl:', config.haUrl ? 'set' : 'empty', 'token:', haToken ? 'set' : 'empty');
  return config;
}

async function saveConfig() {
  // Never include token in synced data
  const safe = { ...config };
  delete safe.haToken;
  delete safe._token;
  try {
    await PluginAPI.persistDataSynced(JSON.stringify(safe));
    console.log('[HA Bridge] Config saved');
  } catch (e) { console.log('[HA Bridge] Config save error:', e); }
}

async function saveToken(token) {
  haToken = token;
  try {
    await PluginAPI.setSecret('haToken', token);
    console.log('[HA Bridge] Token saved to secrets');
  } catch (e) { console.log('[HA Bridge] setSecret error:', e); }
}

// ============================================================
// HA API (all calls from plugin.js, never from iframe)
// ============================================================

async function haApi(method, path, body = null) {
  if (!config.haUrl || !haToken) return null;
  const opts = { method, headers: { 'Authorization': `Bearer ${haToken}`, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  try { const r = await fetch(`${config.haUrl.replace(/\/$/, '')}/api/${path}`, opts); return r.ok ? await r.json() : null; }
  catch (e) { return null; }
}

async function executeAction(action, context = {}) {
  if (!action || !haToken) return;
  const msg = (action.message || '').replace('{title}', context.title || '').replace('{project}', context.projectTitle || '').replace('{time}', context.timeSpentMin || '0').replace('{estimate}', context.timeEstimateMin || '0');
  try {
    switch (action.type) {
      case 'scene': await haApi('POST', 'services/scene/turn_on', { entity_id: action.entity }); break;
      case 'automation': await haApi('POST', 'services/automation/trigger', { entity_id: action.entity }); break;
      case 'script': await haApi('POST', 'services/script/turn_on', { entity_id: action.entity }); break;
      case 'toggle': await haApi('POST', 'services/homeassistant/toggle', { entity_id: action.entity }); break;
      case 'light': const ld = { entity_id: action.entity }; if (action.brightness) ld.brightness = parseInt(action.brightness); if (action.temperature) ld.color_temp_kelvin = parseInt(action.temperature); await haApi('POST', 'services/light/turn_on', ld); break;
      case 'light_off': await haApi('POST', 'services/light/turn_off', { entity_id: action.entity }); break;
      case 'media': await haApi('POST', `services/media_player/${action.mediaAction || 'media_play_pause'}`, { entity_id: action.entity }); break;
      case 'tts': await haApi('POST', 'services/tts/speak', { entity_id: action.ttsEntity || 'tts.google_en', media_player_entity_id: action.entity, message: msg }); break;
      case 'notify': await haApi('POST', 'services/notify/mobile_app_jphone', { title: action.title || 'Super Productivity', message: msg }); break;
      case 'service': const [domain, svc] = (action.service || '').split('.'); const data = action.entity ? { entity_id: action.entity, ...(action.data || {}) } : (action.data || {}); if (domain && svc) await haApi('POST', `services/${domain}/${svc}`, data); break;
    }
  } catch (e) { console.log('[HA Bridge] Action error:', e); }
}

async function notifyWebhook(event, data = {}) {
  if (!config.webhookId || !config.haUrl) return;
  try {
    const response = await fetch(`${config.haUrl.replace(/\/$/, '')}/api/webhook/${config.webhookId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event,
        ...data,
        deviceId,
        taskSyncEnabled: config.autoTaskSync !== false,
        timestamp: Date.now(),
      }),
    });
    return response.ok ? await response.json() : null;
  } catch (e) { return null; }
}

// ============================================================
// LIVE TRACKED-TASK SYNC
// ============================================================

const TASK_SYNC_POLL_MS = 2000;
const TASK_SYNC_RETRY_MS = 5000;
const TASK_SYNC_MAX_RETRIES = 3;
let taskSyncInterval = null;
let lastSyncVersion = 0;
let pendingRemoteTaskId;
let taskSyncPolling = false;
let pendingTaskRetry = null;

function cancelPendingTaskRetry() {
  if (pendingTaskRetry?.timeout) clearTimeout(pendingTaskRetry.timeout);
  pendingTaskRetry = null;
}

function applyRemoteTask(taskId, version) {
  cancelPendingTaskRetry();
  pendingRemoteTaskId = taskId;
  PluginAPI.dispatchAction({ type: '[Task] SetCurrentTask', id: taskId });
  lastSyncVersion = Math.max(lastSyncVersion, version);
}

function scheduleRemoteTaskRetry(state, attempt) {
  cancelPendingTaskRetry();
  pendingTaskRetry = {
    version: state.version,
    taskId: state.taskId,
    attempt,
    timeout: setTimeout(async () => {
      const retry = pendingTaskRetry;
      if (!retry || retry.version !== state.version || !config.autoTaskSync) return;
      try {
        const tasks = await PluginAPI.getTasks();
        if (tasks.some(task => task.id === state.taskId)) {
          applyRemoteTask(state.taskId, state.version);
          return;
        }
        if (attempt < TASK_SYNC_MAX_RETRIES) {
          console.log(`[HA Bridge] Task ${state.taskId} still missing; retry ${attempt + 1}/${TASK_SYNC_MAX_RETRIES} in 5s`);
          scheduleRemoteTaskRetry(state, attempt + 1);
        } else {
          console.log(`[HA Bridge] Giving up remote task switch after ${TASK_SYNC_MAX_RETRIES} retries:`, state.taskId);
          cancelPendingTaskRetry();
        }
      } catch (e) {
        console.log('[HA Bridge] Remote task retry error:', e);
        if (attempt < TASK_SYNC_MAX_RETRIES) scheduleRemoteTaskRetry(state, attempt + 1);
        else cancelPendingTaskRetry();
      }
    }, TASK_SYNC_RETRY_MS),
  };
}

async function recoverMissingRemoteTask(state) {
  lastSyncVersion = state.version;
  cancelPendingTaskRetry();
  console.log('[HA Bridge] Remote task missing locally; triggering SP sync:', state.taskId);
  try {
    if (typeof PluginAPI.triggerSync === 'function') await PluginAPI.triggerSync();
    else console.log('[HA Bridge] This SP version does not expose PluginAPI.triggerSync()');
  } catch (e) {
    console.log('[HA Bridge] SP sync failed; continuing with scheduled retries:', e);
  }
  scheduleRemoteTaskRetry(state, 1);
}

async function pollTrackedTaskState() {
  if (taskSyncPolling || !config.autoTaskSync || !configReady || !config.webhookId || !config.haUrl || !deviceId) return;
  taskSyncPolling = true;
  try {
    const state = await notifyWebhook('sync_poll', { lastVersion: lastSyncVersion });
    if (!state || typeof state.version !== 'number' || state.version <= lastSyncVersion) return;
    if (pendingTaskRetry && state.version > pendingTaskRetry.version) cancelPendingTaskRetry();
    if (state.sourceDeviceId === deviceId || state.taskId === trackingTaskId) {
      lastSyncVersion = state.version;
      return;
    }

    const desiredTaskId = state.taskId || null;
    if (desiredTaskId) {
      const tasks = await PluginAPI.getTasks();
      if (!tasks.some(task => task.id === desiredTaskId)) {
        await recoverMissingRemoteTask(state);
        return;
      }
    }

    // currentTaskChange will fire after dispatch. Mark this exact transition so
    // it is not published back to HA and echoed indefinitely between devices.
    applyRemoteTask(desiredTaskId, state.version);
  } catch (e) {
    pendingRemoteTaskId = undefined;
    console.log('[HA Bridge] Tracked-task sync error:', e);
  } finally {
    taskSyncPolling = false;
  }
}

function startTrackedTaskSync() {
  if (taskSyncInterval) clearInterval(taskSyncInterval);
  taskSyncInterval = null;
  cancelPendingTaskRetry();
  if (!config.autoTaskSync) return;
  taskSyncInterval = setInterval(() => { pollTrackedTaskState(); }, TASK_SYNC_POLL_MS);
  pollTrackedTaskState();
}

// ============================================================
// IFRAME BRIDGE - exposed as window.haBridge for iframe access
// ============================================================

const haBridge = {
  // Get current config (without token - iframe gets masked version)
  getConfig: () => ({ ...config, hasToken: !!haToken }),
  
  // Get token (masked for display)
  getTokenMasked: () => haToken ? haToken.substring(0, 10) + '...' : '',
  
  // Save settings from iframe
  saveSettings: async (settings) => {
    config.haUrl = (settings.haUrl || '').replace(/\/$/, '');
    config.webhookId = settings.webhookId || '';
    config.showSensors = settings.showSensors || '';
    config.autoTaskSync = settings.autoTaskSync !== false;
    await saveConfig();
    startTrackedTaskSync();
    if (settings.token) await saveToken(settings.token);
    return true;
  },
  
  // Save rules from iframe
  saveRules: async (rules) => {
    config.rules = rules;
    await saveConfig();
    return true;
  },
  
  // HA API proxy - iframe requests go through here
  callHaApi: async (method, path, body) => {
    return await haApi(method, path, body);
  },
  
  // Test connection
  testConnection: async () => {
    const result = await haApi('GET', 'config');
    return result ? { ok: true, version: result.version, name: result.location_name } : { ok: false };
  },
  
  // Fetch all HA entities for dropdowns
  fetchEntities: async () => {
    const states = await haApi('GET', 'states');
    if (!states || !Array.isArray(states)) return null;
    return {
      scenes: states.filter(s => s.entity_id.startsWith('scene.')),
      lights: states.filter(s => s.entity_id.startsWith('light.')),
      switches: states.filter(s => s.entity_id.startsWith('switch.')),
      scripts: states.filter(s => s.entity_id.startsWith('script.')),
      automations: states.filter(s => s.entity_id.startsWith('automation.')),
      sensors: states.filter(s => s.entity_id.startsWith('sensor.') || s.entity_id.startsWith('binary_sensor.')),
      media_players: states.filter(s => s.entity_id.startsWith('media_player.')),
    };
  },
  
  // Get sensor states
  getSensorStates: async (entityIds) => {
    const results = [];
    for (const id of entityIds) {
      const state = await haApi('GET', `states/${id}`);
      results.push(state);
    }
    return results;
  },
  
  // Check if ready
  isReady: () => configReady,
};

// Expose to iframe
if (typeof window !== 'undefined') {
  window.haBridge = haBridge;
}

// ============================================================
// RULES ENGINE
// ============================================================

async function evaluateRules(trigger, context = {}) {
  for (const rule of config.rules) {
    if (!rule.enabled) continue;
    if (rule.trigger !== trigger) continue;
    let match = true;
    if (rule.conditions) {
      if (rule.conditions.projectId && context.projectId !== rule.conditions.projectId) match = false;
      if (rule.conditions.tagId && !(context.tagIds || []).includes(rule.conditions.tagId)) match = false;
      if (rule.conditions.titleContains && !(context.title || '').toLowerCase().includes(rule.conditions.titleContains.toLowerCase())) match = false;
    }
    if (match) {
      console.log(`[HA Bridge] Rule fired: ${rule.name} (${trigger})`);
      await executeAction(rule.action, context);
    }
  }
}

// ============================================================
// TIMER & IDLE
// ============================================================

let trackingStartTime = null, trackingTaskId = null, timerCheckInterval = null;
let idleCheckInterval = null, firedTimerRules = new Set(), firedIdleRules = new Set();
let lastTrackingStopTime = null, sessionTasksStarted = 0;

function startTimerChecks() {
  if (timerCheckInterval) clearInterval(timerCheckInterval);
  trackingStartTime = Date.now(); firedTimerRules.clear();
  if (idleCheckInterval) { clearInterval(idleCheckInterval); idleCheckInterval = null; } firedIdleRules.clear();
  timerCheckInterval = setInterval(async () => {
    if (!trackingStartTime) return;
    const elapsedMin = (Date.now() - trackingStartTime) / 60000;
    for (const rule of config.rules) {
      if (!rule.enabled || rule.trigger !== 'timer') continue;
      const threshold = rule.conditions?.minutes || 0;
      if (threshold > 0 && elapsedMin >= threshold && !firedTimerRules.has(rule.id)) {
        firedTimerRules.add(rule.id); await executeAction(rule.action, { timeSpentMin: Math.round(elapsedMin).toString() });
      }
    }
  }, 15000);
}

function stopTimerChecks() {
  if (timerCheckInterval) { clearInterval(timerCheckInterval); timerCheckInterval = null; }
  trackingStartTime = null; trackingTaskId = null; firedTimerRules.clear();
  lastTrackingStopTime = Date.now(); firedIdleRules.clear(); startIdleChecks();
}

function startIdleChecks() {
  if (idleCheckInterval) clearInterval(idleCheckInterval);
  idleCheckInterval = setInterval(async () => {
    if (!lastTrackingStopTime) return;
    const idleMin = (Date.now() - lastTrackingStopTime) / 60000;
    for (const rule of config.rules) {
      if (!rule.enabled || rule.trigger !== 'idle') continue;
      const threshold = rule.conditions?.minutes || 0;
      if (threshold > 0 && idleMin >= threshold && !firedIdleRules.has(rule.id)) {
        firedIdleRules.add(rule.id); await executeAction(rule.action, {});
      }
    }
  }, 30000);
}

function buildContext(task) {
  if (!task) return {};
  return { taskId: task.id, title: task.title || '', projectId: task.projectId || null, tagIds: task.tagIds || [], parentId: task.parentId || null, timeSpentMin: Math.round((task.timeSpent || 0) / 60000).toString(), timeEstimateMin: Math.round((task.timeEstimate || 0) / 60000).toString() };
}

// ============================================================
// HOOKS (all non-blocking via setTimeout)
// ============================================================

PluginAPI.registerHook('currentTaskChange', (data) => { setTimeout(() => onCurrentTaskChange(data), 10); });
PluginAPI.registerHook('taskCreated', (data) => { setTimeout(() => onTaskCreated(data), 10); });
PluginAPI.registerHook('taskComplete', (data) => { setTimeout(() => onTaskComplete(data), 10); });
PluginAPI.registerHook('taskUpdate', (data) => { setTimeout(() => onTaskUpdate(data), 10); });
PluginAPI.registerHook('taskDelete', (data) => { setTimeout(() => onTaskDelete(data), 10); });
PluginAPI.registerHook('finishDay', (data) => { setTimeout(() => onFinishDay(data), 10); });
PluginAPI.registerHook('anyTaskUpdate', (data) => { setTimeout(() => notifyWebhook('task_activity', { action: data?.action, taskId: data?.taskId }), 10); });
PluginAPI.registerHook('projectListUpdate', (data) => { setTimeout(() => evaluateRules('project_list_changed', { action: data?.action, projectId: data?.projectId }), 10); });
PluginAPI.registerHook('workContextChange', (data) => { setTimeout(() => evaluateRules('context_switch', { contextId: data?.id, contextType: data?.type, contextTitle: data?.title }), 10); });
PluginAPI.registerHook('persistedDataChanged', () => {
  setTimeout(() => { loadConfig().then(() => startTrackedTaskSync()); }, 100);
});

async function onCurrentTaskChange(data) {
  const currentTask = data?.current || null;
  const previousTask = data?.previous || null;
  const newTaskId = currentTask?.id || null;
  const isRemoteTransition = pendingRemoteTaskId !== undefined && pendingRemoteTaskId === newTaskId;
  if (isRemoteTransition) pendingRemoteTaskId = undefined;
  else cancelPendingTaskRetry();
  console.log('[HA Bridge] currentTaskChange:', currentTask?.id || 'null', '<-', previousTask?.id || 'null');

  if (currentTask) {
    sessionTasksStarted++;
    trackingTaskId = currentTask.id;
    const ctx = buildContext(currentTask);
    await evaluateRules('task_start', ctx);
    if (sessionTasksStarted === 1) await evaluateRules('first_task_of_day', ctx);
    if (previousTask) await evaluateRules('task_switch', ctx);
    startTimerChecks();
    if (!isRemoteTransition) {
      const state = await notifyWebhook('task_started', { taskId: currentTask.id, title: currentTask.title });
      if (state?.version) lastSyncVersion = Math.max(lastSyncVersion, state.version);
    }
  } else {
    const ctx = previousTask ? buildContext(previousTask) : {};
    stopTimerChecks();
    await evaluateRules('task_stop', ctx);
    if (!isRemoteTransition) {
      const state = await notifyWebhook('task_stopped', { taskId: previousTask?.id });
      if (state?.version) lastSyncVersion = Math.max(lastSyncVersion, state.version);
    }
  }
}

async function onTaskCreated(data) { await evaluateRules('task_created', buildContext(data?.task)); await notifyWebhook('task_created', { taskId: data?.taskId, title: data?.task?.title }); }

async function onTaskComplete(data) {
  const ctx = buildContext(data?.task || {});
  await evaluateRules('task_complete', ctx);
  await notifyWebhook('task_completed', { taskId: data?.taskId, title: data?.task?.title });
  // Check all done using dueDay/dueWithTime (TODAY is virtual, never in tagIds)
  try {
    const tasks = await PluginAPI.getTasks();
    const today = new Date().toISOString().split('T')[0];
    const startOfDay = new Date(today).getTime();
    const endOfDay = startOfDay + 86400000;
    const todayTasks = tasks.filter(t => (t.dueWithTime && t.dueWithTime >= startOfDay && t.dueWithTime < endOfDay) || t.dueDay === today);
    if (todayTasks.length > 0 && todayTasks.every(t => t.isDone)) {
      await evaluateRules('all_done', { count: todayTasks.length });
      await notifyWebhook('all_today_done', { count: todayTasks.length });
    }
  } catch(e) {}
}

async function onTaskUpdate(data) {
  const ctx = buildContext(data?.task || {});
  ctx.changes = data?.changes || {};
  await evaluateRules('task_updated', ctx);
  if (ctx.changes.tagIds) await evaluateRules('tags_changed', ctx);
  if (ctx.changes.projectId) await evaluateRules('project_changed', ctx);
  if (ctx.changes.dueDay || ctx.changes.dueWithTime) await evaluateRules('due_date_changed', ctx);
  if (ctx.changes.timeEstimate) await evaluateRules('estimate_changed', ctx);
  if (ctx.changes.notes) await evaluateRules('notes_changed', ctx);
  if (data?.task?.timeEstimate > 0 && data?.task?.timeSpent > data?.task?.timeEstimate) await evaluateRules('estimate_exceeded', ctx);
}

async function onTaskDelete(data) { await evaluateRules('task_deleted', { taskId: data?.taskId }); await notifyWebhook('task_deleted', { taskId: data?.taskId }); }

async function onFinishDay(data) {
  await evaluateRules('day_end', { date: data?.date });
  sessionTasksStarted = 0;
  try {
    const tasks = await PluginAPI.getTasks();
    const done = tasks.filter(t => t.isDone);
    const totalTime = tasks.reduce((s, t) => s + (t.timeSpent || 0), 0);
    await notifyWebhook('day_finished', { date: data?.date, completed: done.length, total: tasks.length, hoursWorked: Math.round(totalTime / 3600000 * 100) / 100 });
  } catch(e) {}
}

// ============================================================
// INIT
// ============================================================

loadConfig().then(() => {
  console.log(`[HA Bridge v5.2] Ready. ${config.rules.length} rules. Token: ${haToken ? 'set' : 'not set'}.`);
  startTrackedTaskSync();
});

if (PluginAPI.onUnload) {
  PluginAPI.onUnload(() => {
    if (taskSyncInterval) clearInterval(taskSyncInterval);
    cancelPendingTaskRetry();
  });
}
