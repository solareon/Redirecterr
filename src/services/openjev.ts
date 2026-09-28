import type { MediaData, OpenJevConfig, OpenJevFilter, Webhook } from "../types"

const DEFAULT_ENDPOINT = "https://api.openjev.sh/v1/systemone"
const DEFAULT_MODEL = "openjev"
const DEFAULT_TIMEOUT_MS = 10_000

const MEDIA_STATE_FIELDS = [
    "title",
    "name",
    "originalTitle",
    "originalName",
    "tagline",
    "overview",
    "genres",
    "keywords",
    "releaseDate",
    "firstAirDate",
    "adult",
    "contentRatings",
] as const

interface OpenJevResponse {
    answers?: {
        explicit_content?: {
            type?: string
            noul?: number
        }
    }
}

const buildState = (webhook: Webhook, data: MediaData): Record<string, unknown> => {
    const media = Object.fromEntries(
        MEDIA_STATE_FIELDS.flatMap((field) => data[field] === undefined ? [] : [[field, data[field]]])
    )

    return {
        request: {
            media_type: webhook.media.media_type,
            tmdbId: webhook.media.tmdbId,
            requestedBy_username: webhook.request.requestedBy_username,
        },
        media,
    }
}

/**
 * Returns OpenJEV's probability that the requested title matches the filter's
 * explicit-content instructions.
 */
export const queryOpenJev = async (
    webhook: Webhook,
    data: MediaData,
    filter: OpenJevFilter,
    settings: OpenJevConfig = {},
    fetcher: typeof fetch = fetch
): Promise<number> => {
    const apiKey = settings.api_key || process.env.OPENJEV_API_KEY
    if (!apiKey) throw new Error("OpenJEV API key is not configured")

    const response = await fetcher(settings.endpoint || DEFAULT_ENDPOINT, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: settings.model || DEFAULT_MODEL,
            state: buildState(webhook, data),
            questions: {
                explicit_content: {
                    type: "noul",
                    instructions: filter.instructions,
                    criteria: {
                        true: "The media matches the explicit-content policy in the instructions",
                        false: "The media does not match the explicit-content policy in the instructions",
                    },
                },
            },
        }),
        signal: AbortSignal.timeout(settings.timeout_ms ?? DEFAULT_TIMEOUT_MS),
    })

    if (!response.ok) {
        throw new Error(`OpenJEV request failed: ${response.status} ${response.statusText}`)
    }

    const result = await response.json() as OpenJevResponse
    const probability = result.answers?.explicit_content?.noul
    if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) {
        throw new Error("OpenJEV returned an invalid explicit_content answer")
    }

    return probability
}
