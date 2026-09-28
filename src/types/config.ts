export type Condition = string | string[] | number | ConditionValueObject

export interface ConditionValueObject {
    include?: string | string[]
    exclude?: string | string[]
    require?: string | string[]
}

interface FilterCondition {
    [key: string]: Condition // For dynamic condition keys like "tag", "language" etc.
}

export interface OpenJevFilter {
    instructions: string
    deny_threshold?: number
    on_error?: "allow" | "deny"
}

export interface Filter {
    media_type: "movie" | "tv"
    is_4k?: boolean
    conditions?: FilterCondition
    openjev?: OpenJevFilter
    apply: string | string[]
}

interface InstanceConfig {
    server_id: number
    root_folder: string
    quality_profile_id?: number
    approve?: boolean
}

export interface OpenJevConfig {
    api_key?: string
    endpoint?: string
    model?: string
    timeout_ms?: number
}

export interface Config {
    overseerr_url: string
    overseerr_api_token: string
    approve_on_no_match?: boolean
    openjev?: OpenJevConfig
    instances: {
        [key: string]: InstanceConfig // For dynamic instance names
    }
    filters: Filter[]
}
