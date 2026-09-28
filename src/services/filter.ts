import logger from "../utils/logger"
import { normalizeToArray, isObject, buildDebugLogMessage } from "../utils/helpers"
import type { Webhook, MediaData, Filter, Condition, Keyword, ContentRatings, OpenJevConfig } from "../types"
import { queryOpenJev } from "./openjev"

/**
 * Matches filter values against arbitrary data structures.
 * - required=true: exact match against any extracted string
 * - required=false: substring match against any extracted string
 */
export const matchValue = (filterValue: unknown, dataValue: unknown, required = false): boolean => {
	const requiredSet = required ? new Set(normalizeToArray(filterValue)) : null
	const anySet = required ? null : new Set(normalizeToArray(filterValue))

	let anyMatched = false

	const visit = (val: unknown): void => {
		if (anyMatched && !required) return

		if (isObject(val)) {
			for (const v of Object.values(val as Record<PropertyKey, unknown>)) visit(v)
			return
		}

		if (Array.isArray(val)) {
			for (const el of val) visit(el)
			return
		}

		const s = String(val).toLowerCase()

		if (required) {
			if (requiredSet!.has(s)) requiredSet!.delete(s)
		} else {
			// substring "include" semantics
			for (const f of anySet!) {
				if (s.includes(f)) {
					anyMatched = true
					break
				}
			}
		}
	}

	visit(dataValue)

	return required ? requiredSet!.size === 0 : anyMatched
}

/**
 * Specialized keyword matcher: handles require/include/exclude directly on keyword names.
 */
export const matchKeywords = (keywords: Array<Keyword>, filterCondition: Condition): boolean => {
	const names = keywords.map((k) => k.name.toLowerCase())

	if (typeof filterCondition === "object" && filterCondition !== null) {
		if ("require" in filterCondition && filterCondition.require) {
			const req = new Set(normalizeToArray(filterCondition.require))
			if (!names.some((n) => req.has(n))) return false
		}

		if ("include" in filterCondition && filterCondition.include) {
			const inc = normalizeToArray(filterCondition.include)
			if (!names.some((n) => inc.some((v) => n.includes(v)))) return false
		}

		if ("exclude" in filterCondition && filterCondition.exclude) {
			const exc = normalizeToArray(filterCondition.exclude)
			if (names.some((n) => exc.some((v) => n.includes(v)))) return false
		}

		return true
	}

	const vals = normalizeToArray(filterCondition)
	return names.some((n) => vals.some((v) => n.includes(v)))
}

/**
 * Specialized content rating matcher: handles require/include/exclude on rating strings.
 */
export const matchContentRatings = (contentRatings: ContentRatings, filterCondition: Condition): boolean => {
	if (!contentRatings || !contentRatings.results || contentRatings.results.length === 0) return false

	const ratings: string[] = contentRatings.results.map((rating) => String(rating.rating).toLowerCase())

	if (typeof filterCondition === "object" && filterCondition !== null) {
		if ("require" in filterCondition && filterCondition.require) {
			const req = new Set(normalizeToArray(filterCondition.require))
			if (!ratings.some((r) => req.has(r))) return false
		}

		if ("include" in filterCondition && filterCondition.include) {
			const inc = normalizeToArray(filterCondition.include)
			if (!ratings.some((r) => inc.some((v) => r.includes(v)))) return false
		}

		if ("exclude" in filterCondition && filterCondition.exclude) {
			const exc = normalizeToArray(filterCondition.exclude)
			if (ratings.some((r) => exc.some((v) => r.includes(v)))) return false
		}

		return true
	}

	const vals = normalizeToArray(filterCondition)
	return ratings.some((r) => vals.some((v) => r.includes(v)))
}

const filterMatches = (
	webhook: Webhook,
	data: MediaData,
	{ media_type, is_4k, conditions }: Filter
): boolean => {
	if (media_type !== webhook.media.media_type) return false
	if (is_4k === false && webhook.media.status !== "PENDING") return false
	if (is_4k === true && webhook.media.status4k !== "PENDING") return false

	if (!conditions || Object.keys(conditions).length === 0) return true

	const priorityKeys = ["keywords", "contentRatings", "max_seasons"]

	for (const priorityKey of priorityKeys) {
		if (!(priorityKey in conditions)) continue
		const value = conditions[priorityKey]
		if (value === undefined) continue

		if (priorityKey === "keywords") {
			if (!data.keywords) return false
			if (!matchKeywords(data.keywords, value)) return false

			if (logger.isDebugEnabled()) {
				logger.debug(
					buildDebugLogMessage("Filter check:", {
						Field: priorityKey,
						"Filter value": value,
						"Request value": "Keywords array (matched)",
					})
				)
			}
		} else if (priorityKey === "contentRatings") {
			if (!data.contentRatings) return false
			if (!matchContentRatings(data.contentRatings, value)) return false

			if (logger.isDebugEnabled()) {
				logger.debug(
					buildDebugLogMessage("Filter check:", {
						Field: priorityKey,
						"Filter value": value,
						"Request value": "Content ratings array (matched)",
					})
				)
			}
		} else if (priorityKey === "max_seasons" && webhook.extra) {
			const requestedSeasons = webhook.extra.find((item) => item.name === "Requested Seasons")?.value?.split(",")
			const max = typeof value === "number" ? value : Number.parseInt(String(value), 10)
			if (Number.isFinite(max) && requestedSeasons && requestedSeasons.length > max) return false
		}
	}

	for (const [key, value] of Object.entries(conditions)) {
		if (priorityKeys.includes(key)) continue

		const requestValue = data[key] ?? webhook.request[key]

		if (requestValue === undefined || requestValue === null) {
			logger.debug(`Filter check skipped - Key "${key}" not found in webhook or data`)
			return false
		}

		if (logger.isDebugEnabled()) {
			logger.debug(
				buildDebugLogMessage("Filter check:", {
					Field: key,
					"Filter value": value,
					"Request value": requestValue,
				})
			)
		}

		if (typeof value === "object" && value !== null) {
			if ("require" in value && value.require) {
				if (!matchValue(value.require, requestValue, true)) {
					logger.debug(`Filter check for required key "${key}" failed.`)
					return false
				}
			}

			if ("include" in value && value.include) {
				if (!matchValue(value.include, requestValue, false)) {
					logger.debug(`Filter check for included key "${key}" failed.`)
					return false
				}
			}

			if ("exclude" in value && value.exclude) {
				if (matchValue(value.exclude, requestValue, false)) {
					logger.debug(`Filter check for excluded key "${key}" matched an excluded value.`)
					return false
				}
			}
		} else if (!matchValue(value, requestValue, false)) {
			logger.debug(`Filter check for key "${key}" failed.`)
			return false
		}
	}

	return true
}

const findMatchingFilter = (webhook: Webhook, data: MediaData, filters: Filter[]): Filter | null => {
	const matchingFilter = filters.find((filter) => filterMatches(webhook, data, filter)) ?? null
	if (!matchingFilter) {
		logger.info("No matching filter found for the current webhook")
		return null
	}

	logger.info(`Found matching filter at index ${filters.indexOf(matchingFilter)}`)
	return matchingFilter
}

/**
 * Finds the first local filter match and returns its configured instances.
 */
export const findInstances = (webhook: Webhook, data: MediaData, filters: Filter[]): string | string[] | null => {
	try {
		return findMatchingFilter(webhook, data, filters)?.apply ?? null
	} catch (error) {
		logger.error(`Error finding matching filter: ${error}`)
		return null
	}
}

export type FilterDecision =
	| { action: "route"; instances: string | string[] }
	| { action: "deny"; reason: string }

/**
 * Evaluates local conditions first, then asks OpenJEV whether the matched
 * request should be denied. Local matching keeps API calls scoped to selected
 * users and media types.
 */
export const evaluateFilters = async (
	webhook: Webhook,
	data: MediaData,
	filters: Filter[],
	openJevSettings: OpenJevConfig = {},
	query: typeof queryOpenJev = queryOpenJev
): Promise<FilterDecision | null> => {
	const filter = findMatchingFilter(webhook, data, filters)
	if (!filter) return null
	if (!filter.openjev) return { action: "route", instances: filter.apply }

	try {
		const probability = await query(webhook, data, filter.openjev, openJevSettings)
		const threshold = filter.openjev.deny_threshold ?? 0.5
		logger.info(`OpenJEV explicit-content probability: ${probability.toFixed(3)} (deny at ${threshold})`)

		if (probability >= threshold) {
			return { action: "deny", reason: `OpenJEV explicit-content probability ${probability.toFixed(3)}` }
		}

		return { action: "route", instances: filter.apply }
	} catch (error) {
		logger.error(`OpenJEV evaluation failed: ${error}`)
		if ((filter.openjev.on_error ?? "deny") === "deny") {
			return { action: "deny", reason: "OpenJEV evaluation failed (fail-closed)" }
		}

		return { action: "route", instances: filter.apply }
	}
}
