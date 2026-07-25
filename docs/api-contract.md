# API Contract (Current + Next)

## Current

### `GET /health`

Response `200`:

```json
{
  "status": "ok"
}
```

## Current list endpoints

- `POST /lists`
- `GET /lists`
- `GET /lists/{listId}`
- `PUT /lists/{listId}`
- `DELETE /lists/{listId}`
- `GET /favorites`
- `POST /favorites/{listId}`
- `DELETE /favorites/{listId}`

`GET /lists` query params:

- `title` (substring filter)
- `owner` (substring filter)

## Planned error shape

```json
{
  "code": "QUOTA_USER_LISTS_EXCEEDED",
  "message": "User has reached the list limit."
}
```

Code families:

- `AUTH_*`
- `QUOTA_*`
- `CONFLICT_*`
- `VALIDATION_*`

## Auth-lite header

Write and favorites-read routes require:

- `x-user-id: <username-or-device-linked-id>`

`GET /favorites` response:

```json
{
  "listIds": ["list-id-1", "list-id-2"]
}
```
