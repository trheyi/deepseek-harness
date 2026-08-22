import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { admitContent, type WireContentPart } from '../src/admit-content.ts'

const REF: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 3,
  width: 1,
  height: 1,
}

const PNG_BASE64 = 'AAAA'

interface Fixture {
  ctx: Context
  saveImages: ReturnType<typeof vi.fn<(inputs: readonly SaveImageAttachment[]) => Promise<readonly ImageAttachmentRef[]>>>
  resolveModelInfo: ReturnType<typeof vi.fn>
}

function fixture(options: { attachments?: boolean; llm?: boolean; imageCapable?: boolean } = {}): Fixture {
  const saveImages = vi.fn(async (inputs: readonly SaveImageAttachment[]) => inputs.map((input, index) => ({
    ...REF,
    attachmentId: AttachmentId(`sha256:${String(index + 1).padStart(64, '0')}`),
    mediaType: input.mediaType,
    bytes: input.data.byteLength,
  })))
  const resolveModelInfo = vi.fn(async () => ({
    provider: 'mock',
    id: 'vision-model',
    name: 'vision-model',
    inputModalities: options.imageCapable === false ? ['text'] as const : ['text', 'image'] as const,
  }))
  const attachments = options.attachments === false ? undefined : { saveImages }
  const llm = options.llm === false ? undefined : { resolveModelInfo }
  const ctx = {
    get(name: string) {
      if (name === 'attachments') return attachments
      if (name === 'llm') return llm
      return undefined
    },
  } as unknown as Context
  return { ctx, saveImages, resolveModelInfo }
}

describe('admitContent', () => {
  it('passes text-only content through without attachment store interaction', async () => {
    const { ctx, saveImages } = fixture()
    const blocks: WireContentPart[] = [
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world' },
    ]
    const result = await admitContent(ctx, blocks, 'mock', 'vision-model')
    expect(result).toEqual([{ type: 'text', text: 'hello world' }])
    expect(saveImages).not.toHaveBeenCalled()
  })

  it('admits wire images and produces durable refs in order', async () => {
    const { ctx, saveImages } = fixture()
    const blocks: WireContentPart[] = [
      { type: 'text', text: 'look: ' },
      { type: 'image', mediaType: 'image/png', data: PNG_BASE64, name: 'screenshot.png' },
      { type: 'text', text: ' and ' },
      { type: 'image', mediaType: 'image/jpeg', data: PNG_BASE64 },
    ]
    const result = await admitContent(ctx, blocks, 'mock', 'vision-model')
    expect(result).toHaveLength(4)
    expect(result[0]).toEqual({ type: 'text', text: 'look: ' })
    expect(result[1]?.type).toBe('image')
    expect(result[2]).toEqual({ type: 'text', text: ' and ' })
    expect(result[3]?.type).toBe('image')
    expect(saveImages).toHaveBeenCalledOnce()
  })

  it('passes through already-durable image refs unchanged', async () => {
    const { ctx, saveImages } = fixture()
    const blocks: WireContentPart[] = [
      { type: 'image', attachment: REF },
    ]
    const result = await admitContent(ctx, blocks, 'mock', 'vision-model')
    expect(result).toEqual([{ type: 'image', attachment: REF }])
    expect(saveImages).not.toHaveBeenCalled()
  })

  it('rejects unsupported media types before any store call', async () => {
    const { ctx, saveImages } = fixture()
    const blocks: WireContentPart[] = [
      { type: 'image', mediaType: 'image/tiff', data: PNG_BASE64 },
    ]
    await expect(admitContent(ctx, blocks, 'mock', 'vision-model'))
      .rejects.toThrow(/unsupported image media type/)
    expect(saveImages).not.toHaveBeenCalled()
  })

  it('rejects when model does not support image input', async () => {
    const { ctx } = fixture({ imageCapable: false })
    const blocks: WireContentPart[] = [
      { type: 'image', mediaType: 'image/png', data: PNG_BASE64 },
    ]
    await expect(admitContent(ctx, blocks, 'mock', 'text-only'))
      .rejects.toThrow(/does not support image input/)
  })

  it('rejects when no attachment store is mounted', async () => {
    const { ctx } = fixture({ attachments: false })
    const blocks: WireContentPart[] = [
      { type: 'image', mediaType: 'image/png', data: PNG_BASE64 },
    ]
    await expect(admitContent(ctx, blocks, 'mock', 'vision-model'))
      .rejects.toThrow(/requires dsh-attachment-local/)
  })

  it('rejects empty prompt', async () => {
    const { ctx } = fixture()
    await expect(admitContent(ctx, [], 'mock', 'vision-model'))
      .rejects.toThrow(/empty prompt/)
  })

  it('skips modality check when no llm service is available', async () => {
    const { ctx, saveImages } = fixture({ llm: false })
    const blocks: WireContentPart[] = [
      { type: 'image', mediaType: 'image/png', data: PNG_BASE64 },
    ]
    const result = await admitContent(ctx, blocks, 'mock', 'vision-model')
    expect(result).toHaveLength(1)
    expect(result[0]?.type).toBe('image')
    expect(saveImages).toHaveBeenCalledOnce()
  })

  it('handles image-only prompt without text', async () => {
    const { ctx } = fixture()
    const blocks: WireContentPart[] = [
      { type: 'image', mediaType: 'image/webp', data: PNG_BASE64 },
    ]
    const result = await admitContent(ctx, blocks, 'mock', 'vision-model')
    expect(result).toHaveLength(1)
    expect(result[0]?.type).toBe('image')
  })

  it('skips empty text blocks', async () => {
    const { ctx } = fixture()
    const blocks: WireContentPart[] = [
      { type: 'text', text: '' },
      { type: 'text', text: 'hello' },
      { type: 'text', text: '' },
    ]
    const result = await admitContent(ctx, blocks, 'mock', 'vision-model')
    expect(result).toEqual([{ type: 'text', text: 'hello' }])
  })
})
