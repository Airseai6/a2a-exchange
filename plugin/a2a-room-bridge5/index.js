// A2A Exchange room bridge (Host-only DSH plugin).
//
// Watches one A2A Exchange room and injects a compact prompt into mapped DSH
// sessions when a message mentions their agent. No LLM work happens here; this
// is the "wake adapter" for DSH-to-DSH collaboration.
//
// The other side (Hermes) is not DSH: it cannot be woken by this plugin. For
// non-DSH agents use the room skill's watch loop or connector/room-connector.mjs
// with a platform-specific --wake-cmd.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

export const inject = ['schedule', 'sessionController'];

const STATE_VERSION = 1;

function loadState(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && raw.version === STATE_VERSION && raw.rooms && typeof raw.rooms === 'object') return raw;
  } catch {}
  return { version: STATE_VERSION, rooms: {} };
}

function saveState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
  } catch (error) {
    console.error('[a2a-room-bridge] failed to save state:', error?.message);
  }
}

function mentioned(text, binding) {
  const value = String(text ?? '');
  const lower = value.toLowerCase();
  return lower.includes('@all') ||
    lower.includes('@' + String(binding.agentId).toLowerCase()) ||
    (binding.agentName ? value.includes('@' + binding.agentName) : false);
}

function compactMessage(message) {
  return {
    seq: message.seq,
    from: message.sender?.name ?? 'unknown',
    kind: message.sender?.kind ?? 'agent',
    text: message.text,
    time: message.time,
  };
}

export function apply(ctx, config = {}) {
  const hubUrl = String(config.hubUrl ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
  const roomId = String(config.roomId ?? 'lobby');
  const pollMs = Math.max(500, Number(config.pollMs ?? 1500));
  const token = config.token ? String(config.token) : null;
  const configuredBindings = Array.isArray(config.bindings) ? config.bindings.filter((b) => b && b.agentId && b.sessionId) : [];
  const autoBind = config.autoBind !== false;
  const autoBindIntervalMs = Math.max(5000, Number(config.autoBindIntervalMs ?? 15000));
  const autoBindExclude = new Set(Array.isArray(config.autoBindExclude) ? config.autoBindExclude : ['h2']);
  const guardConfig = config.wakeGuard ?? {};
  const maxWakesPerHour = Math.max(1, Number(guardConfig.maxWakesPerHour ?? 20));
  const maxWakesPerMinute = Math.max(1, Number(guardConfig.maxWakesPerMinute ?? 5));
  const minIntervalMs = Math.max(0, Number(guardConfig.minIntervalMs ?? 5000));
  const wakeHistory = new Map();
  function guardWake(agentId) {
    const now = Date.now();
    const history = (wakeHistory.get(agentId) ?? []).filter((t) => now - t < 60 * 60 * 1000);
    const last = history.at(-1) ?? 0;
    if (now - last < minIntervalMs) return 'min_interval';
    if (history.filter((t) => now - t < 60 * 1000).length >= maxWakesPerMinute) return 'minute_cap';
    if (history.length >= maxWakesPerHour) return 'hour_cap';
    history.push(now);
    wakeHistory.set(agentId, history);
    return null;
  }
  let dynamicBindings = [];
  function effectiveBindings() {
    const merged = new Map();
    for (const binding of configuredBindings) merged.set(binding.agentId, binding);
    for (const binding of dynamicBindings) merged.set(binding.agentId, binding);
    return [...merged.values()];
  }
  async function refreshAutoBindings() {
    if (!autoBind) return;
    try {
      const agentsResponse = await fetch(`${hubUrl}/api/agents`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
      if (!agentsResponse.ok) return;
      const agentsData = await agentsResponse.json();
      const next = [];
      for (const agent of agentsData.agents ?? []) {
        if (!agent?.agentId || autoBindExclude.has(agent.agentId)) continue;
        const cardResponse = await fetch(`${hubUrl}/agents/${encodeURIComponent(agent.agentId)}/.well-known/agent-card.json`);
        if (!cardResponse.ok) continue;
        const card = await cardResponse.json();
        const sessionExtension = (card.capabilities?.extensions ?? []).find((e) => e?.uri === 'urn:a2a-exchange:ext:session-delivery:v1');
        const sessionId = sessionExtension?.params?.sessionId;
        if (!sessionId) continue;
        try {
          // Only bind Sessions this Host can actually inspect; Hermes' fake
          // session ids (e.g. h2-main) are skipped here.
          await ctx.sessionController.inspect(sessionId);
        } catch {
          continue;
        }
        next.push({ agentId: agent.agentId, agentName: card.name ?? agent.name ?? agent.agentId, sessionId });
      }
      dynamicBindings = next;
      for (const binding of effectiveBindings()) {
        if (roomState.bindings[binding.agentId] === undefined) roomState.bindings[binding.agentId] = roomState.lastSeq;
      }
      const names = effectiveBindings().map((b) => `${b.agentId}=${b.sessionId}`).join(',');
      console.log(`[a2a-room-bridge5] auto-bind ${names || '(none)'}`);
    } catch (error) {
      console.error('[a2a-room-bridge5] auto-bind failed:', error?.message);
    }
  }
  const stateFile = String(config.stateFile ?? path.join(process.env.DSH_HOME ?? os.homedir(), 'a2a-room-bridge-state.json'));
  const state = loadState(stateFile);
  const roomState = state.rooms[roomId] ?? (state.rooms[roomId] = { lastSeq: 0 });
  if (!roomState.bindings || typeof roomState.bindings !== 'object') roomState.bindings = {};
  roomState.lastSeq = Number(roomState.lastSeq ?? 0);
  let stopped = false;
  let running = false;

  async function tick() {
    if (running || stopped) return;
    running = true;
    try {
      const bindings = effectiveBindings();
      if (bindings.length === 0) return;
      for (const binding of bindings) {
        if (roomState.bindings[binding.agentId] === undefined) roomState.bindings[binding.agentId] = roomState.lastSeq;
      }
      const cursors = bindings.map((b) => Number(roomState.bindings[b.agentId] ?? 0));
      const since = Math.min(...cursors, roomState.lastSeq);
      const response = await fetch(`${hubUrl}/api/rooms/${encodeURIComponent(roomId)}?since=${since}&limit=100`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) return;
      const data = await response.json();
      const messages = Array.isArray(data.messages) ? data.messages : [];
      if (messages.length === 0) return;
      const latestSeq = messages.at(-1).seq;

      // Per-binding cursors: a message is only consumed for an agent after its
      // wake prompt was admitted (or it did not mention that agent). Guard-
      // suppressed messages stay pending and are retried on a later tick.
      const perBinding = new Map(bindings.map((b) => [b.agentId, []]));
      for (const message of messages) {
        for (const binding of bindings) {
          if (Number(message.seq) <= Number(roomState.bindings[binding.agentId] ?? 0)) continue;
          // Skip only the sender's own messages, not every bound agent's messages.
          if (message.sender?.kind === 'agent' && message.sender?.agentId === binding.agentId) continue;
          if (mentioned(message.text, binding)) {
            perBinding.get(binding.agentId).push(message);
          } else {
            roomState.bindings[binding.agentId] = Math.max(Number(roomState.bindings[binding.agentId] ?? 0), Number(message.seq));
          }
        }
      }

      for (const binding of bindings) {
        const batch = perBinding.get(binding.agentId);
        if (!batch || batch.length === 0) {
          roomState.bindings[binding.agentId] = Math.max(Number(roomState.bindings[binding.agentId] ?? 0), Number(latestSeq));
          continue;
        }
        const digest = batch.map(compactMessage);
        const prompt = [
          `[A2A Exchange 房间 ${roomId} 有新消息 · @${binding.agentId}]`,
          '摘要如下（完整上下文用 room read --mentions 获取）：',
          JSON.stringify(digest, null, 2),
          '',
          '请只处理与你相关的部分；处理后用 room send 回复 @对方；无关则一句话说明。',
        ].join('\n');
        const blocked = guardWake(binding.agentId);
        if (blocked) {
          console.warn(`[a2a-room-bridge5] wake suppressed ${binding.agentId}: ${blocked}; cursor kept for retry`);
          continue;
        }
        try {
          // Direct queue prompt with a real AbortSignal (schedule.create's
          // delivery path currently hits throwIfAborted when signal is absent).
          await ctx.sessionController.prompt(
            {
              requestId: `a2a-${randomUUID()}`,
              sessionId: binding.sessionId,
              mode: 'queue',
              content: [{ type: 'text', text: prompt }],
              clientTimeZone: 'Asia/Shanghai',
            },
            new AbortController().signal,
          );
          roomState.bindings[binding.agentId] = Math.max(Number(roomState.bindings[binding.agentId] ?? 0), Number(batch.at(-1).seq));
          console.log(`[a2a-room-bridge5] prompted wake ${binding.agentId} seq=${batch.at(-1).seq}`);
        } catch (promptError) {
          console.error(`[a2a-room-bridge5] prompt wake failed for ${binding.agentId}:`, promptError?.message);
          try {
            await ctx.schedule.create(binding.sessionId, {
              title: `A2A 房间 ${roomId} 唤醒`,
              prompt,
              after_seconds: 1,
            });
            roomState.bindings[binding.agentId] = Math.max(Number(roomState.bindings[binding.agentId] ?? 0), Number(batch.at(-1).seq));
            console.log(`[a2a-room-bridge5] scheduled wake ${binding.agentId} seq=${batch.at(-1).seq}`);
          } catch (error) {
            // Leave cursor unchanged so the message is retried later.
            console.error(`[a2a-room-bridge5] wake failed for ${binding.agentId}:`, error?.message, error?.stack);
          }
        }
      }

      if (Number(latestSeq) > Number(roomState.lastSeq)) roomState.lastSeq = Number(latestSeq);
      saveState(stateFile, state);
    } catch (error) {
      console.error('[a2a-room-bridge5] tick failed:', error?.message);
    } finally {
      running = false;
    }
  }

  const timer = setInterval(tick, pollMs);
  const bindTimer = setInterval(() => { void refreshAutoBindings(); }, autoBindIntervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  if (typeof bindTimer.unref === 'function') bindTimer.unref();
  void refreshAutoBindings().then(() => tick());
  ctx.effect(() => () => {
    stopped = true;
    clearInterval(timer);
    clearInterval(bindTimer);
  });
  console.log(`[a2a-room-bridge5] watching ${hubUrl} room=${roomId} autoBind=${autoBind}`);
}


