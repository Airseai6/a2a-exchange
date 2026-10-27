// SDK / client used by the CLI, the skill scripts, examples and tests.
export class ExchangeError extends Error {
  constructor(message, { code, data, httpStatus } = {}) {
    super(message);
    this.name = 'ExchangeError';
    this.code = code;
    this.data = data;
    this.httpStatus = httpStatus;
  }
}

function trimBase(baseUrl) {
  return String(baseUrl).replace(/\/+$/, '');
}

function makeTextMessage(text, { role = 'ROLE_USER', messageId, contextId, taskId, mediaType = 'text/plain' } = {}) {
  return {
    messageId: messageId ?? cryptoRandomId(),
    role,
    parts: [{ text: String(text), mediaType }],
    ...(contextId ? { contextId } : {}),
    ...(taskId ? { taskId } : {}),
  };
}

function makeDataMessage(data, opts = {}) {
  const msg = makeTextMessage('', opts);
  msg.parts = [{ data, mediaType: 'application/json' }];
  return msg;
}

function makeUrlMessage(url, { mediaType = 'text/plain', filename, ...rest } = {}) {
  return {
    messageId: rest.messageId ?? cryptoRandomId(),
    role: rest.role ?? 'ROLE_USER',
    parts: [{ url, mediaType, ...(filename ? { filename } : {}) }],
  };
}

function cryptoRandomId() {
  // crypto.randomUUID is available in Node >= 20
  return globalThis.crypto.randomUUID();
}

async function* parseSse(response) {
  const decoder = new TextDecoder();
  let buffer = '';
  const reader = response.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const lines = raw.split('\n');
        const event = { id: undefined, event: 'message', data: undefined };
        const dataLines = [];
        for (const line of lines) {
          if (line.startsWith(':')) continue;
          const field = line.slice(0, line.indexOf(':'));
          const rest = line.slice(line.indexOf(':') + 1).replace(/^ /, '');
          if (field === 'id') event.id = rest;
          else if (field === 'event') event.event = rest;
          else if (field === 'data') dataLines.push(rest);
        }
        if (dataLines.length) {
          event.data = dataLines.join('\n');
          yield event;
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
}

export class ExchangeClient {
  constructor({ baseUrl = 'http://127.0.0.1:8787', serverToken, agentId, agentToken, fetchImpl = fetch, timeoutMs = 30000 } = {}) {
    this.baseUrl = trimBase(baseUrl);
    this.serverToken = serverToken;
    this.agentId = agentId;
    this.agentToken = agentToken;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  headers(extra = {}) {
    const headers = { 'content-type': 'application/json', ...extra };
    if (this.serverToken) headers.authorization = `Bearer ${this.serverToken}`;
    if (this.agentToken) headers['x-agent-token'] = this.agentToken;
    return headers;
  }

  async request(path, { method = 'GET', body, headers = {}, raw = false, signal } = {}) {
    if (raw) {
      // Streaming responses keep the caller's signal for the lifetime of the body.
      return this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(headers),
        body: body === undefined ? undefined : JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(headers),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = { raw: text };
      }
      if (!response.ok) {
        throw new ExchangeError(payload?.error?.message ?? payload?.error ?? `HTTP ${response.status}`, {
          code: payload?.error?.code,
          data: payload?.error,
          httpStatus: response.status,
        });
      }
      return payload;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }

  async rpc(path, method, params = {}) {
    const payload = await this.request(path, { method: 'POST', body: { jsonrpc: '2.0', id: cryptoRandomId(), method, params } });
    if (payload?.error) {
      throw new ExchangeError(payload.error.message, { code: payload.error.code, data: payload.error.data });
    }
    return payload?.result;
  }

  hub(method, params) {
    return this.rpc('/a2a', method, params);
  }

  agentCall(agentId, method, params) {
    return this.rpc(`/agents/${encodeURIComponent(agentId)}/a2a`, method, params);
  }

  /* ── registry ── */
  register(params) {
    return this.hub('exchange/register', params);
  }
  async unregister(agentId, token = this.agentToken) {
    const headers = token ? { 'x-agent-token': token } : {};
    const payload = await this.request('/a2a', { method: 'POST', headers, body: { jsonrpc: '2.0', id: cryptoRandomId(), method: 'exchange/unregister', params: { agentId } } });
    if (payload?.error) throw new ExchangeError(payload.error.message, { code: payload.error.code, data: payload.error.data });
    return payload?.result;
  }
  async heartbeat(agentId = this.agentId, token = this.agentToken) {
    const headers = token ? { 'x-agent-token': token } : {};
    const payload = await this.request('/a2a', { method: 'POST', headers, body: { jsonrpc: '2.0', id: cryptoRandomId(), method: 'exchange/heartbeat', params: { agentId } } });
    if (payload?.error) throw new ExchangeError(payload.error.message, { code: payload.error.code, data: payload.error.data });
    return payload?.result;
  }
  discover(params = {}) {
    return this.hub('exchange/discover', params);
  }

  /* ── A2A ── */
  sendMessage(agentId, { message, configuration = { returnImmediately: true }, metadata } = {}) {
    return this.agentCall(agentId, 'SendMessage', { message, configuration, ...(metadata ? { metadata } : {}) });
  }
  sendText(agentId, text, opts = {}) {
    return this.sendMessage(agentId, { message: makeTextMessage(text, opts), configuration: { returnImmediately: true } });
  }
  getTask(agentId, taskId, { historyLength } = {}) {
    return this.agentCall(agentId, 'GetTask', { id: taskId, ...(historyLength !== undefined ? { historyLength } : {}) });
  }
  listTasks(agentId, params = {}) {
    return this.agentCall(agentId, 'ListTasks', params);
  }
  cancelTask(agentId, taskId) {
    return this.agentCall(agentId, 'CancelTask', { id: taskId });
  }
  extendedCard(agentId) {
    return this.agentCall(agentId, 'GetExtendedAgentCard', {});
  }
  async card(agentId) {
    return this.request(`/agents/${encodeURIComponent(agentId)}/.well-known/agent-card.json`);
  }
  async hubCard() {
    return this.request('/.well-known/agent-card.json');
  }

  /* ── exchange agent-side ── */
  inbox(agentId = this.agentId, params = {}) {
    return this.agentCall(agentId, 'exchange/inbox', params);
  }
  claim(agentId, taskId) {
    return this.agentCall(agentId, 'exchange/claim', { taskId });
  }
  update(agentId, taskId, params = {}) {
    return this.agentCall(agentId, 'exchange/update', { taskId, ...params });
  }
  complete(agentId, taskId, { text, artifacts } = {}) {
    return this.update(agentId, taskId, {
      status: { state: 'TASK_STATE_COMPLETED', ...(text ? { message: makeTextMessage(text, { role: 'ROLE_AGENT' }) } : {}) },
      ...(artifacts ? { artifacts } : {}),
    });
  }
  fail(agentId, taskId, text) {
    return this.update(agentId, taskId, { status: { state: 'TASK_STATE_FAILED', ...(text ? { message: makeTextMessage(text, { role: 'ROLE_AGENT' }) } : {}) } });
  }
  reply(agentId, taskId, text) {
    return this.agentCall(agentId, 'exchange/reply', { taskId, text });
  }
  info(agentId) {
    return this.agentCall(agentId, 'exchange/info', {});
  }

  /* ── rooms (local collaboration UI/API) ── */
  async listRooms() {
    return this.request('/api/rooms');
  }
  async createRoom({ roomId, name, description } = {}) {
    return this.request('/api/rooms', { method: 'POST', body: { roomId, name, description } });
  }
  async getRoom(roomId, { since = 0, limit = 200 } = {}) {
    return this.request(`/api/rooms/${encodeURIComponent(roomId)}?since=${encodeURIComponent(since)}&limit=${encodeURIComponent(limit)}`);
  }
  async joinRoom(roomId, agentId = this.agentId) {
    return this.request(`/api/rooms/${encodeURIComponent(roomId)}/join`, { method: 'POST', body: { agentId } });
  }
  async postHumanRoomMessage(roomId, text, name) {
    return this.request(`/api/rooms/${encodeURIComponent(roomId)}/messages`, { method: 'POST', body: { text, ...(name ? { name } : {}) } });
  }
  async sendRoomMessage(roomId, text, agentId = this.agentId, type = 'chat') {
    return this.request(`/api/rooms/${encodeURIComponent(roomId)}/agent-messages`, { method: 'POST', body: { agentId, text, ...(type && type !== 'chat' ? { type } : {}) } });
  }
  async sendRoomTask(roomId, task, agentId = this.agentId) {
    return this.request(`/api/rooms/${encodeURIComponent(roomId)}/agent-messages`, { method: 'POST', body: { agentId, text: task.title, task } });
  }
  async listRoomTasks(roomId) {
    return this.request(`/api/rooms/${encodeURIComponent(roomId)}/tasks`);
  }
  async createRoomTask(roomId, task) {
    return this.request(`/api/rooms/${encodeURIComponent(roomId)}/tasks`, { method: 'POST', body: task });
  }
  async roomTaskAction(roomId, taskId, action, extra = {}) {
    return this.request(`/api/rooms/${encodeURIComponent(roomId)}/tasks/${encodeURIComponent(taskId)}/${encodeURIComponent(action)}`, { method: 'POST', body: extra });
  }
  async readRoom(roomId, since = 0) {
    const data = await this.request(`/api/rooms/${encodeURIComponent(roomId)}?since=${encodeURIComponent(since)}&limit=500`);
    return { roomId: data.room.id, messages: data.messages, lastSeq: data.lastSeq };
  }
  async pinRoomMessage(roomId, seq, pinned = true) {
    return this.request(`/api/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(seq)}/pin`, { method: 'POST', body: { pinned } });
  }
  async roomPending(roomId, agentId = this.agentId) {
    return this.request(`/api/rooms/${encodeURIComponent(roomId)}/pending?agentId=${encodeURIComponent(agentId)}`);
  }
  async roomAck(roomId, agentId = this.agentId, seq) {
    return this.request(`/api/rooms/${encodeURIComponent(roomId)}/ack`, { method: 'POST', body: { agentId, ...(seq === undefined ? {} : { seq }) } });
  }
  async inviteRoom(roomId, agentId, role) {
    return this.request(`/api/rooms/${encodeURIComponent(roomId)}/invite`, { method: 'POST', body: { agentId, ...(role ? { role } : {}) } });
  }
  async kickRoom(roomId, agentId) {
    return this.request(`/api/rooms/${encodeURIComponent(roomId)}/kick`, { method: 'POST', body: { agentId } });
  }
  async setRoomRole(roomId, agentId, role) {
    return this.request(`/api/rooms/${encodeURIComponent(roomId)}/role`, { method: 'POST', body: { agentId, role } });
  }
  async updateRoom(roomId, patch) {
    return this.request(`/api/rooms/${encodeURIComponent(roomId)}`, { method: 'PATCH', body: patch });
  }
  async deleteRoom(roomId) {
    return this.request(`/api/rooms/${encodeURIComponent(roomId)}`, { method: 'DELETE' });
  }

  /* ── streaming ── */
  async streamTask(agentId, taskId, onEvent, { signal } = {}) {
    const response = await this.request(`/agents/${encodeURIComponent(agentId)}/a2a`, {
      method: 'POST',
      raw: true,
      signal,
      headers: { accept: 'text/event-stream' },
      body: { jsonrpc: '2.0', id: cryptoRandomId(), method: 'SubscribeToTask', params: { id: taskId } },
    });
    if (!response.ok) throw new ExchangeError(`HTTP ${response.status}`, { httpStatus: response.status });
    for await (const event of parseSse(response)) {
      if (event.data) {
        const payload = JSON.parse(event.data);
        if (payload?.error) throw new ExchangeError(payload.error.message, { code: payload.error.code, data: payload.error.data });
        await onEvent?.(payload?.result, event);
      }
    }
  }

  async sendStreamingMessage(agentId, { message, onEvent, signal } = {}) {
    const response = await this.request(`/agents/${encodeURIComponent(agentId)}/a2a`, {
      method: 'POST',
      raw: true,
      signal,
      headers: { accept: 'text/event-stream' },
      body: { jsonrpc: '2.0', id: cryptoRandomId(), method: 'SendStreamingMessage', params: { message, configuration: { returnImmediately: true } } },
    });
    if (!response.ok) throw new ExchangeError(`HTTP ${response.status}`, { httpStatus: response.status });
    for await (const event of parseSse(response)) {
      if (event.data) {
        const payload = JSON.parse(event.data);
        if (payload?.error) throw new ExchangeError(payload.error.message, { code: payload.error.code, data: payload.error.data });
        await onEvent?.(payload?.result, event);
      }
    }
  }

  async streamAgentEvents(agentId, onEvent, { lastEventId = 0, signal, token = this.agentToken } = {}) {
    const response = await this.request(`/agents/${encodeURIComponent(agentId)}/events?lastEventId=${encodeURIComponent(lastEventId)}`, {
      method: 'GET',
      raw: true,
      signal,
      headers: { accept: 'text/event-stream', ...(token ? { 'x-agent-token': token } : {}) },
    });
    if (!response.ok) throw new ExchangeError(`HTTP ${response.status}`, { httpStatus: response.status });
    for await (const event of parseSse(response)) {
      await onEvent?.(event);
    }
  }

  /* ── convenience factories ── */
  static textMessage(text, opts) {
    return makeTextMessage(text, opts);
  }
  static dataMessage(data, opts) {
    return makeDataMessage(data, opts);
  }
  static urlMessage(url, opts) {
    return makeUrlMessage(url, opts);
  }
  static textPart(text) {
    return { text: String(text), mediaType: 'text/plain' };
  }
  static dataPart(data) {
    return { data, mediaType: 'application/json' };
  }
  static urlPart(url, opts = {}) {
    return { url, mediaType: opts.mediaType ?? 'text/plain', ...(opts.filename ? { filename: opts.filename } : {}) };
  }
}

export { makeTextMessage, makeDataMessage, makeUrlMessage, parseSse };
