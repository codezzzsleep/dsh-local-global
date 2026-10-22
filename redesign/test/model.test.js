import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAICompatibleModel } from '../src/model.js'

function stubFetch(reply) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) })
    return reply(calls.length)
  }
  return { fetchImpl, calls }
}

const ok = (message) => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message }] }),
})

test('the adapter posts OpenAI-format requests and returns tool calls', async () => {
  const toolCalls = [{ id: 'c1', type: 'function', function: { name: 'save_memory', arguments: '{"text":"x"}' } }]
  const { fetchImpl, calls } = stubFetch(() => ok({ content: null, tool_calls: toolCalls }))
  const model = new OpenAICompatibleModel({
    baseUrl: 'https://api.example.com/v1/',
    apiKey: 'test-key',
    model: 'deepseek-chat',
    fetchImpl,
  })

  const reply = await model.chat({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'save_memory', parameters: {} } }],
  })

  assert.equal(calls[0].url, 'https://api.example.com/v1/chat/completions')
  assert.equal(calls[0].init.headers.authorization, 'Bearer test-key')
  assert.equal(calls[0].body.model, 'deepseek-chat')
  assert.equal(calls[0].body.tool_choice, 'auto')
  assert.deepEqual(reply.tool_calls, toolCalls)
  assert.equal(reply.content, '')
})

test('without tools the request carries no tool fields', async () => {
  const { fetchImpl, calls } = stubFetch(() => ok({ content: 'plain answer' }))
  const model = new OpenAICompatibleModel({ baseUrl: 'https://x', apiKey: 'k', model: 'm', fetchImpl })
  const reply = await model.chat({ messages: [{ role: 'user', content: 'hi' }], tools: [] })
  assert.equal('tools' in calls[0].body, false)
  assert.equal(reply.content, 'plain answer')
})

test('HTTP errors surface with their status', async () => {
  const { fetchImpl } = stubFetch(() => ({ ok: false, status: 503, text: async () => 'overloaded' }))
  const model = new OpenAICompatibleModel({ baseUrl: 'https://x', apiKey: 'k', model: 'm', fetchImpl })
  await assert.rejects(model.chat({ messages: [], tools: [] }), /model HTTP 503: overloaded/)
})

test('an API key is required', () => {
  assert.throws(() => new OpenAICompatibleModel({ baseUrl: 'https://x', model: 'm' }), /API key is required/)
})
