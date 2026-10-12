import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMailClient } from 'agentmail'
import { toJSONSchema } from 'zod'

import { AgentMailToolkit } from '../src/mcp.js'
import { SendMessageParams, ReplyToMessageParams, ForwardMessageParams } from '../src/schemas.js'

const operations = [
    {
        name: 'send_message',
        schema: SendMessageParams,
        args: { inboxId: 'test-inbox', to: ['recipient@example.invalid'], subject: 'Same subject', text: 'Same body' },
        path: '/v0/inboxes/test-inbox/messages/send',
        body: { to: ['recipient@example.invalid'], subject: 'Same subject', text: 'Same body' },
    },
    {
        name: 'reply_to_message',
        schema: ReplyToMessageParams,
        args: { inboxId: 'test-inbox', messageId: 'original-message', text: 'Same body' },
        path: '/v0/inboxes/test-inbox/messages/original-message/reply',
        body: { text: 'Same body' },
    },
    {
        name: 'forward_message',
        schema: ForwardMessageParams,
        args: {
            inboxId: 'test-inbox',
            messageId: 'original-message',
            to: ['recipient@example.invalid'],
            subject: 'Same subject',
            text: 'Same body',
        },
        path: '/v0/inboxes/test-inbox/messages/original-message/forward',
        body: { to: ['recipient@example.invalid'], subject: 'Same subject', text: 'Same body' },
    },
] as const

type Operation = (typeof operations)[number]
type Attempt = { path: string; key: string | null; body: Record<string, unknown> }
type Delivery = { body: string; result: { message_id: string; thread_id: string } }

// A tiny API model, not a replacement SDK: the real client still serializes bodies,
// sets headers, retries HTTP errors and parses responses. No network is used. The
// model deduplicates only by an explicit operation key, never by message content.
function mockApi(operation: Operation, failure?: 'timeout' | '503') {
    const attempts: Attempt[] = []
    const deliveries: Delivery[] = []
    const byKey = new Map<string, Delivery>()
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        expect(url.origin).toBe('https://agentmail.invalid')
        expect(init?.method).toBe('POST')
        const key = new Headers(init?.headers).get('Idempotency-Key')
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        attempts.push({ path: url.pathname, key, body })

        const fingerprint = JSON.stringify(body)
        const scope = `${url.pathname}:${key}`
        let delivery = key === null ? undefined : byKey.get(scope)
        if (delivery && delivery.body !== fingerprint) {
            return Response.json({ message: 'Idempotency key reused with a different body' }, { status: 409 })
        }
        if (!delivery) {
            delivery = { body: fingerprint, result: { message_id: `message-${deliveries.length + 1}`, thread_id: 'thread-1' } }
            deliveries.push(delivery)
            if (key !== null) byKey.set(scope, delivery)
        }

        // Commit first, then lose the response. A retry must recover this delivery
        // using the same operation key rather than silently creating another one.
        if (attempts.length === 1 && failure === 'timeout') {
            throw new DOMException('Mock response lost after commit', 'TimeoutError')
        }
        if (attempts.length === 1 && failure === '503') {
            return Response.json({ message: 'Mock response lost after commit' }, { status: 503 })
        }
        return Response.json(delivery.result)
    })
    const client = new AgentMailClient({
        apiKey: 'mock-key-not-a-production-credential',
        baseUrl: 'https://agentmail.invalid',
        fetch: fetchMock,
        maxRetries: 1,
    })
    const toolkit = new AgentMailToolkit(client)
    return {
        attempts,
        deliveries,
        fetchMock,
        invoke: (args: Record<string, unknown> = {}) => toolkit.invoke(operation.name, client, { ...operation.args, ...args }),
    }
}

beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal(
        'fetch',
        vi.fn(() => {
            throw new Error('Unexpected network access')
        })
    )
})

afterEach(() => {
    // The SDK may leave its timeout timer pending when the injected fetch throws.
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

describe.each(operations)('$name idempotency at the HTTP boundary', (operation) => {
    it('advertises an optional key and enforces its API length and charset', () => {
        const advertised = toJSONSchema(operation.schema, { unrepresentable: 'any' }) as {
            properties: { idempotencyKey: { type: string; minLength: number; maxLength: number; pattern: string } }
            required?: string[]
        }
        expect(advertised.properties.idempotencyKey).toMatchObject({ type: 'string', minLength: 1, maxLength: 256 })
        expect(advertised.required).not.toContain('idempotencyKey')
        expect(operation.schema.safeParse(operation.args).success).toBe(true)
        for (const idempotencyKey of ['a', 'AZaz09._~-', 'a'.repeat(256)]) {
            expect(operation.schema.safeParse({ ...operation.args, idempotencyKey }).success).toBe(true)
        }
        for (const idempotencyKey of ['', 'a'.repeat(257), 'has space', 'invalid/slash', 'é', 'key\n']) {
            expect(operation.schema.safeParse({ ...operation.args, idempotencyKey }).success).toBe(false)
        }
    })

    it('rejects an invalid key before calling the SDK transport', async () => {
        const api = mockApi(operation)
        expect((await api.invoke({ idempotencyKey: 'has space' })).isError).toBe(true)
        expect(api.fetchMock).not.toHaveBeenCalled()
        expect(api.deliveries).toHaveLength(0)
    })

    it('puts an explicit key in the HTTP header and keeps routing fields and the key out of the body', async () => {
        const api = mockApi(operation)
        const result = await api.invoke({ idempotencyKey: 'caller-operation-1' })
        expect(result.isError).toBe(false)
        expect(result.structuredContent).toEqual({ messageId: 'message-1', threadId: 'thread-1' })
        expect(api.attempts).toEqual([{ path: operation.path, key: 'caller-operation-1', body: operation.body }])
    })

    it('recovers a committed delivery after a lost response when a separate call reuses its explicit key', async () => {
        const api = mockApi(operation, 'timeout')
        const first = await api.invoke({ idempotencyKey: 'caller-operation-1' })
        expect(first.isError).toBe(true)
        expect(api.attempts).toHaveLength(1)
        expect(api.deliveries).toHaveLength(1)

        const retry = await api.invoke({ idempotencyKey: 'caller-operation-1' })
        expect(retry.isError).toBe(false)
        expect(retry.structuredContent).toEqual({ messageId: 'message-1', threadId: 'thread-1' })
        expect(api.attempts.map(({ key }) => key)).toEqual(['caller-operation-1', 'caller-operation-1'])
        expect(api.deliveries).toHaveLength(1)
    })

    it('generates a fresh key for a separate call without a caller key, including a retry after a lost response', async () => {
        const api = mockApi(operation, 'timeout')
        expect((await api.invoke()).isError).toBe(true)
        const retry = await api.invoke()
        expect(retry.isError).toBe(false)
        expect(retry.structuredContent).toEqual({ messageId: 'message-2', threadId: 'thread-1' })
        expect(api.attempts).toHaveLength(2)
        for (const { key } of api.attempts) {
            expect(key).toMatch(/^[A-Za-z0-9._~-]{1,256}$/)
        }
        expect(api.attempts[1].key).not.toBe(api.attempts[0].key)
        expect(api.attempts[1].body).toEqual(api.attempts[0].body)
        expect(api.deliveries).toHaveLength(2)
    })

    it('allows intentional identical deliveries when the caller supplies distinct operation keys', async () => {
        const api = mockApi(operation)
        const first = await api.invoke({ idempotencyKey: 'caller-operation-1' })
        const second = await api.invoke({ idempotencyKey: 'caller-operation-2' })
        expect(first.isError).toBe(false)
        expect(second.isError).toBe(false)
        expect(first.structuredContent).not.toEqual(second.structuredContent)
        expect(api.attempts[1].body).toEqual(api.attempts[0].body)
        expect(api.deliveries).toHaveLength(2)
    })

    it('surfaces a conflict for changed content under the same key without creating a second delivery', async () => {
        const api = mockApi(operation)
        expect((await api.invoke({ idempotencyKey: 'caller-operation-1' })).isError).toBe(false)
        const conflict = await api.invoke({ idempotencyKey: 'caller-operation-1', text: 'Different body' })
        expect(conflict.isError).toBe(true)
        expect(conflict.content).toEqual([{ type: 'text', text: expect.stringContaining('HTTP 409') }])
        expect(api.attempts).toHaveLength(2)
        expect(api.deliveries).toHaveLength(1)
    })

    it('reuses the generated key across the SDK internal 503 retry', async () => {
        const api = mockApi(operation, '503')
        const pending = api.invoke()
        await vi.runAllTimersAsync()
        const result = await pending
        expect(result.isError).toBe(false)
        expect(result.structuredContent).toEqual({ messageId: 'message-1', threadId: 'thread-1' })
        expect(api.attempts).toHaveLength(2)
        expect(api.attempts[0].key).toMatch(/^[A-Za-z0-9._~-]{1,256}$/)
        expect(api.attempts[1]).toEqual(api.attempts[0])
        expect(api.deliveries).toHaveLength(1)
    })
})
