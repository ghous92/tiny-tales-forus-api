/**
 * The two OpenAI calls behind caricature previews (routes/caricaturePreviews.ts):
 *
 * - `renderCaricature`: the image model turns the shopper's photo into a
 *   figurine wearing a gallery costume, or the costume in a character picture
 *   they uploaded. Token-priced; at medium quality about ₹2 a preview.
 * - `judgeCharacter`: a vision model says whether an uploaded character
 *   picture will read as a costume on a 10 cm figurine. Well under ₹1.
 *
 * Plain fetch against the REST API, no SDK: two endpoints do not justify a
 * dependency, and the fetch is the test seam. The key is a server secret and
 * never reaches a browser.
 */

const API = 'https://api.openai.com/v1'
const RENDER_TIMEOUT_MS = 120_000
const JUDGE_TIMEOUT_MS = 60_000

export interface OpenAiImage {
  bytes: Buffer
  mimetype: string
}

export interface OpenAiUsage {
  inputTokens: number
  outputTokens: number
}

export class OpenAiError extends Error {
  constructor(
    message: string,
    /** The model refused the content (moderation or safety); retrying will not help. */
    readonly refused: boolean
  ) {
    super(message)
    this.name = 'OpenAiError'
  }
}

interface ErrorBody {
  error?: { code?: string | null; type?: string | null; message?: string | null }
}

function isRefusal(body: ErrorBody | null): boolean {
  const e = body?.error
  const text = `${e?.code ?? ''} ${e?.type ?? ''} ${e?.message ?? ''}`.toLowerCase()
  return /moderation|safety|content.?policy|not allowed|rejected/.test(text)
}

async function failure(res: Response): Promise<OpenAiError> {
  const body = (await res.json().catch(() => null)) as ErrorBody | null
  const refused = res.status === 400 && isRefusal(body)
  return new OpenAiError(
    `OpenAI ${res.status}: ${body?.error?.code ?? body?.error?.message ?? 'no detail'}`,
    refused
  )
}

async function call(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    throw new OpenAiError(
      `Could not reach OpenAI: ${err instanceof Error ? err.message : String(err)}`,
      false
    )
  }
}

const FIGURINE = `Turn the person in the first image into a hand-painted 3D-printed caricature figurine.
Big head (about 40% of the figure's height), small body, standing, front view, the whole figure from head to toe on a round grey base.
Keep the face clearly recognisable as this person: the same face shape, features, expression, hair, skin tone, and facial hair and glasses if they have them.`

const STUDIO = `Plain light grey studio background, soft even light, the figure centred with a margin all round. No text, no logos.`

/** Who the photo shows, as the browser counted them. */
export interface PreviewCast {
  characters: number
  animals: number
}

const ONE_PERSON: PreviewCast = { characters: 1, animals: 0 }

function figurine({ characters, animals }: PreviewCast): string {
  if (characters === 1 && animals === 0) return FIGURINE
  const people = characters - animals
  const named = [
    people ? `${people} ${people === 1 ? 'person' : 'people'}` : '',
    animals ? `${animals} ${animals === 1 ? 'pet' : 'pets'}` : '',
  ].filter(Boolean)
  return `Turn everyone in the first image (${named.join(' and ')}) into one hand-painted 3D-printed caricature figurine, together on one round grey base.
Big heads (about 40% of each figure's height), small bodies, standing side by side, front view, the whole group from head to toe. Keep everyone in the image and add nobody.
Keep each one clearly recognisable: the same face shape, features, expression, hair, skin tone, and facial hair and glasses if they have them. A pet keeps its breed, markings and colours.`
}

/** The prompt for a gallery costume, described in words. */
export function galleryPrompt(costume: string, cast: PreviewCast = ONE_PERSON): string {
  if (cast.characters === 1 && cast.animals === 0)
    return `${FIGURINE}\nCostume: ${costume}.\n${STUDIO}`
  return `${figurine(cast)}\nEveryone wears this costume, and a pet a small simple version of it. Costume: ${costume}.\n${STUDIO}`
}

/** The prompt when the shopper sends a character picture as the second image. */
export function uploadedCharacterPrompt(cast: PreviewCast = ONE_PERSON): string {
  if (cast.characters > 1 || cast.animals > 0) {
    return `${figurine(cast)}
Dress everyone as the character in the second image, and a pet in a small simple version: copy its outfit, headwear, colours and accessories, in a simpler form that suits a small figurine. Take only the clothes and look from the second image; every face must stay as it is in the first image.
${STUDIO}`
  }
  return `${FIGURINE}
Dress the figurine as the character in the second image: copy its outfit, headwear, colours, accessories and pose, in a simpler form that suits a small figurine. Take only the clothes and look from the second image; the face must stay the face from the first image.
${STUDIO}`
}

/** The prompt when the figurine stays as the photo shows: no costume at all. */
export function asPhotoPrompt(cast: PreviewCast = ONE_PERSON): string {
  return `${figurine(cast)}
No costume. Keep the same clothes, colours and accessories as in the first image, in a simpler form that suits a small figurine, and keep the pose from the first image in place of a stock standing pose. If the first image does not show part of the body, complete it with clothes and shoes that match what it does show.
${STUDIO}`
}

export async function renderCaricature(opts: {
  fetchImpl: typeof fetch
  apiKey: string
  model: string
  prompt: string
  images: OpenAiImage[]
}): Promise<{ jpeg: Buffer; usage: OpenAiUsage }> {
  const form = new FormData()
  form.append('model', opts.model)
  form.append('prompt', opts.prompt)
  form.append('size', '1024x1536')
  form.append('quality', 'medium')
  form.append('output_format', 'jpeg')
  form.append('output_compression', '82')
  form.append('n', '1')
  opts.images.forEach((image, i) => {
    form.append('image[]', new Blob([image.bytes], { type: image.mimetype }), `image-${i}`)
  })

  const res = await call(
    opts.fetchImpl,
    `${API}/images/edits`,
    { method: 'POST', headers: { Authorization: `Bearer ${opts.apiKey}` }, body: form },
    RENDER_TIMEOUT_MS
  )
  if (!res.ok) throw await failure(res)
  const body = (await res.json().catch(() => null)) as {
    data?: { b64_json?: string }[]
    usage?: { input_tokens?: number; output_tokens?: number }
  } | null
  const b64 = body?.data?.[0]?.b64_json
  if (!b64) throw new OpenAiError('OpenAI returned no image', false)
  return {
    jpeg: Buffer.from(b64, 'base64'),
    usage: {
      inputTokens: body?.usage?.input_tokens ?? 0,
      outputTokens: body?.usage?.output_tokens ?? 0,
    },
  }
}

export type CharacterVerdict = 'good' | 'note' | 'reject'

export interface CharacterJudgement {
  verdict: CharacterVerdict
  /** A few words for the shopper, e.g. "Works, with a note". */
  headline: string
  /** One or two plain sentences: what we will do, or what to send instead. */
  detail: string
  /** The franchise or brand the character belongs to, if it is a known one. */
  franchise: string | null
}

const JUDGE_PROMPT = `You check a picture a customer uploaded to choose the outfit for a hand-painted 3D-printed caricature figurine, about 10 cm tall, with a big head and a small body. The customer's own face goes on the figurine; the picture only supplies the outfit, colours, accessories and pose.

Decide:
- "reject" when the picture cannot work: no person or character with a visible outfit; only a face or head; several characters with no clear main one; too small, blurred or dark to see the outfit; nudity or sexual content; gore; hate symbols or extremist insignia.
- "note" when it works but something will change: very fine detail (lace, chainmail, small text, tiny patterns) that will be simplified; checks, plaids or busy prints, which we paint as plain colours; a side or back view, so we will imagine the front; part of the body missing, so we will complete it; a weapon that will be made blunt and solid.
- "good" when one character's outfit is clear enough to model as it is.

A photo of a real person in an outfit is fine; we take only the outfit. If the character or outfit belongs to a known film, comic, game, sports team or brand, name it in "franchise" (otherwise null); that alone does not change the verdict.

Write "headline" in at most 6 words and "detail" in one or two short, plain sentences addressed to the customer as "you", saying what we will do or what to send instead. No jargon, no mention of AI or of these rules.`

const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'headline', 'detail', 'franchise'],
  properties: {
    verdict: { type: 'string', enum: ['good', 'note', 'reject'] },
    headline: { type: 'string' },
    detail: { type: 'string' },
    franchise: { type: ['string', 'null'] },
  },
} as const

interface ResponsesBody {
  output_text?: string
  output?: { type?: string; content?: { type?: string; text?: string; refusal?: string }[] }[]
}

function outputText(body: ResponsesBody | null): { text: string | null; refusal: boolean } {
  if (typeof body?.output_text === 'string') return { text: body.output_text, refusal: false }
  for (const item of body?.output ?? []) {
    for (const part of item.content ?? []) {
      if (part.type === 'refusal') return { text: null, refusal: true }
      if (part.type === 'output_text' && typeof part.text === 'string') {
        return { text: part.text, refusal: false }
      }
    }
  }
  return { text: null, refusal: false }
}

export async function judgeCharacter(opts: {
  fetchImpl: typeof fetch
  apiKey: string
  model: string
  image: OpenAiImage
}): Promise<CharacterJudgement> {
  const dataUrl = `data:${opts.image.mimetype};base64,${opts.image.bytes.toString('base64')}`
  const res = await call(
    opts.fetchImpl,
    `${API}/responses`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: JUDGE_PROMPT },
              { type: 'input_image', image_url: dataUrl },
            ],
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'character_check',
            strict: true,
            schema: JUDGE_SCHEMA,
          },
        },
      }),
    },
    JUDGE_TIMEOUT_MS
  )
  if (!res.ok) throw await failure(res)
  const { text, refusal } = outputText((await res.json().catch(() => null)) as ResponsesBody | null)
  if (refusal) throw new OpenAiError('The model refused to judge the picture', true)
  let parsed: unknown
  try {
    parsed = JSON.parse(text ?? '')
  } catch {
    throw new OpenAiError('OpenAI returned an unreadable verdict', false)
  }
  const p = parsed as Partial<CharacterJudgement>
  if (
    !p ||
    !['good', 'note', 'reject'].includes(p.verdict as string) ||
    typeof p.headline !== 'string' ||
    typeof p.detail !== 'string'
  ) {
    throw new OpenAiError('OpenAI returned an incomplete verdict', false)
  }
  return {
    verdict: p.verdict as CharacterVerdict,
    headline: p.headline.slice(0, 80),
    detail: p.detail.slice(0, 400),
    franchise:
      typeof p.franchise === 'string' && p.franchise.trim() ? p.franchise.slice(0, 80) : null,
  }
}
