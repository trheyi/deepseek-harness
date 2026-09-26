/** Wire-content admission for base64 images from Go client. @module */

import type { Context } from '@deepseek-ai/cordis'
import { admitEncodedImages, type EncodedImageAttachment, type ImageAttachmentRef, type ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** Wire content from Go client: text passthrough or base64 image needing admission. */
export type WireContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string; name?: string }
  | { type: 'image'; attachment: ImageAttachmentRef }

const ALLOWED_IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
])

/**
 * Admit wire content: text blocks pass through, base64 image blocks are persisted
 * via the attachment store and replaced with durable ImageAttachmentRef.
 * Already-durable image refs pass through unchanged.
 *
 * Two-pass pattern follows {@link admitAcpPrompt} in dsh-acp.
 * @param ctx - harness context carrying attachment and llm services.
 * @param wireBlocks - untrusted wire blocks from the Go JSON-RPC client.
 * @param provider - configured provider route for model-info resolution.
 * @param model - configured model id for modality check.
 * @returns core content with durable image references in wire order.
 */
export async function admitContent(
  ctx: Context,
  wireBlocks: readonly WireContentPart[],
  provider: string,
  model: string,
): Promise<ContentBlock[]> {
  const images: EncodedImageAttachment[] = []
  let hasWireImages = false

  for (const block of wireBlocks) {
    if (block.type !== 'image') continue
    if ('attachment' in block) continue
    if (!ALLOWED_IMAGE_TYPES.has(block.mediaType)) {
      throw new Error(`unsupported image media type: ${block.mediaType}`)
    }
    hasWireImages = true
    images.push({
      mediaType: block.mediaType as ImageMediaType,
      data: block.data,
      ...block.name === undefined ? {} : { name: block.name },
    })
  }

  let refs: readonly ImageAttachmentRef[] = []
  if (hasWireImages) {
    const llm = ctx.get('llm')
    if (llm !== undefined) {
      const info = await llm.resolveModelInfo(provider, model)
      if (info.inputModalities !== undefined && !info.inputModalities.includes('image')) {
        throw new Error(`model "${model}" does not support image input`)
      }
    }
    const attachments = ctx.get('attachments')
    if (attachments === undefined) {
      throw new Error('image support requires dsh-attachment-local plugin')
    }
    refs = await admitEncodedImages(attachments, images)
  }

  const content: ContentBlock[] = []
  let pendingText = ''
  let imageIndex = 0

  const flushText = (): void => {
    if (pendingText.length === 0) return
    content.push({ type: 'text', text: pendingText })
    pendingText = ''
  }

  for (const block of wireBlocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) pendingText += block.text
        break
      case 'image':
        flushText()
        if ('attachment' in block) {
          content.push({ type: 'image', attachment: block.attachment })
        } else {
          const ref = refs[imageIndex++] as ImageAttachmentRef
          content.push({ type: 'image', attachment: ref })
        }
        break
      default:
        break
    }
  }
  flushText()

  if (content.length === 0) throw new Error('empty prompt')
  return content
}
