# Error Code Documentation

This document provides a list of all possible error codes returned by the Walkie-Talkie API, along with a clear explanation for each.

## 4xx Client Errors

| Error Code | Description |
| --- | --- |
| `rate_limit_exceeded` | The client has made too many requests in a given amount of time. |
| `unauthorized` | The client has not provided a valid authentication token. |
| `missing_room_or_name` | The `room` or `name` query parameter is missing from the request. |
| `missing_room` | The `room` query parameter is missing from the request. |
| `room_protected` | The room is password-protected and the client has not provided a valid `access_token`. |
| `room_read_only` | The room is read-only and the client is not allowed to send messages. |
| `not_allowed` | The client is not allowed to send messages in this room. |
| `duplicate_message` | The client has sent the same message multiple times in a short period of time. |
| `invalid_request` | The request is malformed or contains invalid data. |
| `missing_description_or_notifyList` | The `description` or `notifyList` field is missing from the request body. |
| `decision_not_found` | The requested decision could not be found. |
| `decision_already_resolved` | The requested decision has already been resolved. |
| `invalid_status` | The provided status is invalid. |
| `missing_name` | The `name` field is missing from the request body. |
| `provide {remove: ["name1", ...]}` | The `remove` field is missing from the request body. |
| `room_not_found` | The requested room could not be found. |
| `invalid_json_body` | The request body is not valid JSON. |
| `invalid_secret` | The provided secret is invalid. |
| `room_not_found_or_already_has_an_admin_token` | The requested room could not be found or already has an admin token. |
| `missing_webhook_url` | The `webhook_url` field is missing from the request body. |
| `already_claimed` | The room has already been claimed. |
| `missing_agent_name_or_model` | The `agent_name` or `model` field is missing from the request body. |
| `agent_not_found` | The requested agent could not be found. |
| `missing_message_id` | The `message_id` field is missing from the request body. |
| `missing_q` | The `q` query parameter is missing from the request. |
| `missing_message_or_send_at` | The `message` or `send_at` field is missing from the request body. |
| `missing_filename_or_content` | The `filename` or `content` field is missing from the request body. |
| `file_too_large_max_512kb` | The file is larger than the maximum allowed size of 512kb. |
| `file_not_found` | The requested file could not be found. |
| `missing_from_agent_to_agent_or_summary` | The `from_agent`, `to_agent`, or `summary` field is missing from the request body. |
| `handoff_not_found` | The requested handoff could not be found. |
| `not_assigned_to_you` | The requested handoff is not assigned to you. |
| `template_not_found` | The requested template could not be found. |
| `message_too_large` | The message is larger than the maximum allowed size. |
| `room_expired_or_not_found` | The room has expired or could not be found. |
| `not_in_room` | The user is not in the room. |

## 5xx Server Errors

| Error Code | Description |
| --- | --- |
| `ADMIN_CLAIM_SECRET not set on server` | The `ADMIN_CLAIM_SECRET` environment variable is not set on the server. |
| `stripe_not_configured` | The Stripe API keys are not configured on the server. |
| `invalid_plan` | The provided Stripe plan is invalid. |
| `stripe_plan_not_configured` | The requested Stripe plan is not configured on the server. |
| `stripe_session_failed` | The Stripe checkout session could not be created. |
| `stripe_request_failed` | The request to the Stripe API failed. |
