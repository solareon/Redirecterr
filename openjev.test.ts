import { describe, expect, it } from "bun:test"
import { evaluateFilters } from "./src/services/filter"
import { queryOpenJev } from "./src/services/openjev"
import type { Filter, MediaData, Webhook } from "./src/types"

const webhook: Webhook = {
    notification_type: "MEDIA_PENDING",
    media: {
        media_type: "movie",
        tmdbId: "123",
        status: "PENDING",
        status4k: "UNKNOWN",
    },
    request: {
        request_id: "42",
        requestedBy_email: "private@example.com",
        requestedBy_username: "restricted-user",
    },
    extra: [],
}

const media: MediaData = {
    originalTitle: "Example Movie",
    overview: "A deliberately detailed synopsis.",
    genres: [{ id: 18, name: "Drama" }],
    keywords: [{ name: "adult themes" }],
    contentRatings: { results: [{ iso_3116_1: "US", rating: "R" }] },
}

const filters: Filter[] = [{
    media_type: "movie",
    conditions: { requestedBy_username: "restricted-user" },
    openjev: {
        instructions: "Does this title contain sexually explicit material?",
        deny_threshold: 0.7,
    },
    apply: "radarr",
}]

describe("OpenJEV content decisions", () => {
    it("declines a matching user's request at the configured probability threshold", async () => {
        const decision = await evaluateFilters(webhook, media, filters, {}, async () => 0.7)

        expect(decision).toEqual({
            action: "deny",
            reason: "OpenJEV explicit-content probability 0.700",
        })
    })

    it("routes content below the threshold", async () => {
        const decision = await evaluateFilters(webhook, media, filters, {}, async () => 0.69)

        expect(decision).toEqual({ action: "route", instances: "radarr" })
    })

    it("fails closed by default and supports an explicit allow-on-error policy", async () => {
        const unavailable = async (): Promise<number> => {
            throw new Error("provider unavailable")
        }
        const denied = await evaluateFilters(webhook, media, filters, {}, unavailable)
        const allowOnError: Filter[] = [{
            ...filters[0]!,
            openjev: { ...filters[0]!.openjev!, on_error: "allow" },
        }]
        const routed = await evaluateFilters(webhook, media, allowOnError, {}, unavailable)

        expect(denied).toEqual({ action: "deny", reason: "OpenJEV evaluation failed (fail-closed)" })
        expect(routed).toEqual({ action: "route", instances: "radarr" })
    })

    it("sends relevant Seerr metadata without the requester's email", async () => {
        let requestBody = ""
        let authorization = ""
        const fetcher: typeof fetch = async (_input, init) => {
            requestBody = String(init?.body)
            authorization = new Headers(init?.headers).get("Authorization") ?? ""
            return new Response(JSON.stringify({
                answers: { explicit_content: { type: "noul", noul: 0.82 } },
            }), { status: 200, headers: { "Content-Type": "application/json" } })
        }

        const probability = await queryOpenJev(
            webhook,
            media,
            filters[0]!.openjev!,
            { api_key: "secret", endpoint: "https://openjev.example/v1/systemone" },
            fetcher
        )
        const payload = JSON.parse(requestBody) as { state: { request: object; media: object } }

        expect(probability).toBe(0.82)
        expect(authorization).toBe("Bearer secret")
        expect(payload.state).toEqual({
            request: {
                media_type: "movie",
                tmdbId: "123",
                requestedBy_username: "restricted-user",
            },
            media: {
                originalTitle: "Example Movie",
                overview: "A deliberately detailed synopsis.",
                genres: [{ id: 18, name: "Drama" }],
                keywords: [{ name: "adult themes" }],
                contentRatings: { results: [{ iso_3116_1: "US", rating: "R" }] },
            },
        })
        expect(requestBody).not.toContain("private@example.com")
    })
})
