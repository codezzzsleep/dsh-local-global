/**
 * Model adapters. The Global agent only needs `chat({ messages, tools })`
 * that resolves to `{ content, tool_calls }` in OpenAI chat format.
 */

/** Any OpenAI-compatible chat endpoint (DeepSeek, most gateways). */
export class OpenAICompatibleModel {
  constructor({ baseUrl, apiKey, model, fetchImpl = globalThis.fetch, timeoutMs = 120_000 }) {
    if (!apiKey) throw new Error('an API key is required')
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.apiKey = apiKey
    this.model = model
    this.fetch = fetchImpl
    this.timeoutMs = timeoutMs
  }

  async chat({ messages, tools }) {
    const body = {
      model: this.model,
      messages,
      ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
    }
    const response = await this.fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!response.ok) {
      const text = await response.text()
      throw new Error(`model HTTP ${response.status}: ${text.slice(0, 300)}`)
    }
    const json = await response.json()
    const message = json.choices?.[0]?.message
    if (!message) throw new Error('model returned no message')
    return { role: 'assistant', content: message.content ?? '', tool_calls: message.tool_calls }
  }
}

/** Test double: replays fixed replies. A step may be a function of the request. */
export class ScriptedModel {
  constructor(steps) {
    this.steps = [...steps]
    this.requests = []
  }

  async chat(request) {
    this.requests.push(structuredClone(request))
    if (this.steps.length === 0) throw new Error('ScriptedModel has no reply left')
    const step = this.steps.shift()
    const reply = typeof step === 'function' ? step(request) : step
    return { role: 'assistant', content: reply.content ?? '', tool_calls: reply.tool_calls }
  }
}

let callCounter = 0

/** Build an OpenAI-format tool call for ScriptedModel replies. */
export function toolCall(name, args) {
  callCounter += 1
  return {
    id: `call_${callCounter}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  }
}
