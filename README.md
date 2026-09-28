# Redirecterr

## Docker Compose

```yaml
services:
  redirecterr:
    image: ghcr.io/solareon/redirecterr:latest
    container_name: redirecterr
    hostname: redirecterr
    ports:
      - 8481:8481
    volumes:
      - /path/to/config.yaml:/config/config.yaml
      - /path/to/logs:/logs
    environment:
      - LOG_LEVEL=info
      - OPENJEV_API_KEY= # Required only when an OpenJEV filter is configured
```

## Webhook setup

> [!IMPORTANT]  
> Disable automatic request approval for your users

In Seerr go to **Settings -> Notifications -> Webhook** and configure the following:

- **Enable Agent**: Enabled
- **Webhook URL**: `http://redirecterr:8481/webhook`
- **Notification Types**: Select **Request Pending Approval**
- **JSON Payload**: Reset to default

## Config

Create a `config.yaml` file with the following sections:

### Seerr settings

```yaml
seerr_url: ""
seerr_api_token: ""
approve_on_no_match: true # Auto-approve if no filters match
```

> [!NOTE]
> The legacy `overseerr_url` / `overseerr_api_token` names are still accepted for backwards compatibility. Provide either the new `seerr_*` names or the old `overseerr_*` names (do not mix). `seerr_*` takes precedence when both are present.

> [!NOTE]
> `seerr_email` and `seerr_password` are optional. They're only required when CSRF protection is enabled on Seerr (Settings -> Security), where API-key-only requests are rejected with 403. If set, Redirecterr logs into a local session to satisfy CSRF.

```yaml
seerr_email: ""
seerr_password: ""
```

### OpenJEV settings

[OpenJEV](https://openjev.sh/docs) can classify a request after its normal filter conditions match. The API key can be supplied with the `OPENJEV_API_KEY` environment variable (recommended) or in this optional section:

```yaml
openjev:
  # api_key: "" # Prefer OPENJEV_API_KEY so the secret is not stored in this file
  # endpoint: "https://api.openjev.sh/v1/systemone"
  # model: "openjev"
  # timeout_ms: 10000
```

### Instances

Define your Radarr/Sonarr instances

```yaml
instances:
  radarr:
    server_id: 0 # Match the order in Seerr > Settings > Services (example below)
    root_folder: /mnt/movies
    # quality_profile_id: 1  # Optional
    # approve: false         # Optional (default is true)
```

- `server_id`: Starts at 0, increases left to right in Seerr UI. [Visual example](https://github.com/user-attachments/assets/a7a60d91-0f24-42a9-bbe1-ea4f1c945e6a)
- `quality_profile_id` (Optional): Override Seerr default. Get IDs from:

  ```
  http://<arr-url>/api/v3/qualityProfile?apiKey=<api-key>
  ```

- `approve`: Set to false to disable auto-approval.

### Filters

Filters route requests based on conditions.

```yaml
filters:
  - media_type: movie
    # is_4k: true  # Optional
    conditions:
      keywords:
        include: ["anime", "animation"]
      contentRatings:
        exclude: [12, 16]
      requestedBy_username: user
      max_seasons: 2
    apply: radarr_anime
```

#### Fields

- `media_type`: `movie` or `tv`
- `is_4k` (Optional): Set to `true` to only match 4K requests. Set to `false` to only match non-4k requests. Leave empty to match both.
- `conditions`:
  - `field`:
    - `require`: All values must match
    - `exclude`: None of the values must match
    - `include`: At least one value matches
- `apply`: One or more instance names

> [!TIP]  
> For a list of possible condition fields see [fields.md](https://github.com/varthe/Redirecterr/blob/main/fields.md)

#### OpenJEV content decisions

Add `openjev` to a filter to make a yes/no (`noul`) content decision. Redirecterr evaluates `conditions` first, so only the selected users and media types are sent to OpenJEV. A result at or above `deny_threshold` declines the pending request through Seerr; a lower result routes and approves it through the filter's normal `apply` target.

```yaml
filters:
  - media_type: movie
    conditions:
      requestedBy_username:
        include: ["child-user", "guest-user"]
    openjev:
      instructions: >-
        Could this movie contain sexually explicit material or nudity that is
        unsuitable for a child? Use the title, synopsis, genres, keywords,
        adult flag, and content ratings in the supplied media metadata.
      deny_threshold: 0.70
      on_error: deny
    apply: radarr
```

- `instructions`: Required policy question. Define what counts as explicit for your household.
- `deny_threshold`: Optional number from `0` to `1`; default `0.5`.
- `on_error`: Optional `deny` or `allow`; default `deny` (fail closed).

OpenJEV receives the media title/name, synopsis, tagline, genres, keywords, dates, `adult` flag, content ratings, media type, TMDB ID, and requester username. The requester email is not sent. OpenJEV does not browse external URLs; classification quality depends on Seerr's metadata. Tune the threshold against representative titles before enabling automatic declines.

### Sample config

```yaml
seerr_url: ""
seerr_api_token: ""

approve_on_no_match: true

instances:
  sonarr:
    server_id: 0
    root_folder: "/mnt/plex/Shows"
  sonarr_4k:
    server_id: 1
    root_folder: "/mnt/plex/Shows - 4K"
  sonarr_anime:
    server_id: 2
    root_folder: "/mnt/plex/Anime"
  radarr:
    server_id: 0
    root_folder: "/mnt/plex/Movies"
  radarr_4k:
    server_id: 1
    root_folder: "/mnt/plex/Movies - 4K"
  radarr_anime:
    server_id: 2
    root_folder: "/mnt/plex/Anime Movies"


filters:
  # Send anime to sonarr_anime
  - media_type: tv
    conditions:
      keywords: anime
    apply: sonarr_anime

  # Send everything else to sonarr and sonarr_4k instances
  - media_type: tv
    apply: ["sonarr", "sonarr_4k"]

  # Send anime to radarr_anime
  - media_type: movies
    conditions:
      keywords: anime
    apply: radarr_anime

  # Send everything else to radarr and radarr_4k instances
  - media_type: movies
    apply: ["radarr", "radarr_4k"]
```
