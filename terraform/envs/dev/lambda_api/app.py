import json
import os
import uuid
import base64
from datetime import datetime, timezone
from decimal import Decimal

import boto3
from botocore.exceptions import ClientError
from boto3.dynamodb.conditions import Key

dynamodb = boto3.resource("dynamodb")
dynamodb_client = boto3.client("dynamodb")

LISTS_TABLE_NAME = os.environ["LISTS_TABLE"]
LIST_VERSIONS_TABLE_NAME = os.environ["LIST_VERSIONS_TABLE"]
FAVORITES_TABLE_NAME = os.environ["FAVORITES_TABLE"]
USAGE_TABLE_NAME = os.environ["USAGE_TABLE"]

LISTS_TABLE = dynamodb.Table(LISTS_TABLE_NAME)
LIST_VERSIONS_TABLE = dynamodb.Table(LIST_VERSIONS_TABLE_NAME)
FAVORITES_TABLE = dynamodb.Table(FAVORITES_TABLE_NAME)
USAGE_TABLE = dynamodb.Table(USAGE_TABLE_NAME)

MAX_LISTS_PER_USER = int(os.environ.get("MAX_LISTS_PER_USER", "30"))
MAX_WORDS_PER_LIST = int(os.environ.get("MAX_WORDS_PER_LIST", "1000"))
MAX_TOTAL_WORDS_PER_USER = int(os.environ.get("MAX_TOTAL_WORDS_PER_USER", "12000"))
MAX_UPDATES_PER_LIST_PER_DAY = int(os.environ.get("MAX_UPDATES_PER_LIST_PER_DAY", "40"))
MAX_WRITE_OPS_PER_USER_PER_DAY = int(os.environ.get("MAX_WRITE_OPS_PER_USER_PER_DAY", "200"))
MAX_GLOBAL_LISTS = int(os.environ.get("MAX_GLOBAL_LISTS", "500"))
MAX_GLOBAL_WORDS = int(os.environ.get("MAX_GLOBAL_WORDS", "150000"))
MAX_VERSIONS_PER_LIST = int(os.environ.get("MAX_VERSIONS_PER_LIST", "10"))


def _json_default(value):
    if isinstance(value, Decimal):
        if value % 1 == 0:
            return int(value)
        return float(value)
    raise TypeError(f"Unsupported type: {type(value)}")


def response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": {"content-type": "application/json"},
        "body": json.dumps(body, default=_json_default),
    }


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def day_key():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def user_id_from_event(event):
    headers = event.get("headers", {})
    username = headers.get("x-user-id") or headers.get("X-User-Id")
    if not username:
        return None
    return username.strip()


def parse_body(event):
    body = event.get("body")
    if not body:
        return {}
    if event.get("isBase64Encoded"):
        body = base64.b64decode(body).decode("utf-8")
    return json.loads(body)


def usage_get(scope):
    result = USAGE_TABLE.get_item(Key={"scope": scope})
    return result.get("Item", {})


def usage_put_count(scope, lists_delta=0, words_delta=0):
    expr = ["SET updatedAt = :updatedAt"]
    values = {":updatedAt": now_iso(), ":zero": Decimal(0)}
    if lists_delta != 0:
        expr.append("listsCount = if_not_exists(listsCount, :zero) + :listsDelta")
        values[":listsDelta"] = Decimal(lists_delta)
    if words_delta != 0:
        expr.append("wordsCount = if_not_exists(wordsCount, :zero) + :wordsDelta")
        values[":wordsDelta"] = Decimal(words_delta)
    USAGE_TABLE.update_item(
        Key={"scope": scope},
        UpdateExpression=", ".join(expr),
        ExpressionAttributeValues=values,
    )


def ddb_str(value):
    return {"S": value}


def ddb_num(value):
    return {"N": str(value)}


def ddb_item(value):
    serializer = boto3.dynamodb.types.TypeSerializer()
    return {key: serializer.serialize(raw) for key, raw in value.items()}


def increment_daily_user_write_quota(user_id):
    key = f"DAY#USER#{user_id}#{day_key()}"
    try:
        USAGE_TABLE.update_item(
            Key={"scope": key},
            UpdateExpression="SET updatedAt = :updatedAt ADD writesToday :inc",
            ConditionExpression="attribute_not_exists(writesToday) OR writesToday < :maxWrites",
            ExpressionAttributeValues={
                ":inc": Decimal(1),
                ":maxWrites": Decimal(MAX_WRITE_OPS_PER_USER_PER_DAY),
                ":updatedAt": now_iso(),
            },
        )
    except ClientError as ex:
        if ex.response["Error"]["Code"] == "ConditionalCheckFailedException":
            raise ValueError("QUOTA_USER_DAILY_WRITES_EXCEEDED")
        raise


def increment_daily_list_update_quota(list_id):
    key = f"DAY#LIST#{list_id}#{day_key()}"
    try:
        USAGE_TABLE.update_item(
            Key={"scope": key},
            UpdateExpression="SET updatedAt = :updatedAt ADD updatesToday :inc",
            ConditionExpression="attribute_not_exists(updatesToday) OR updatesToday < :maxUpdates",
            ExpressionAttributeValues={
                ":inc": Decimal(1),
                ":maxUpdates": Decimal(MAX_UPDATES_PER_LIST_PER_DAY),
                ":updatedAt": now_iso(),
            },
        )
    except ClientError as ex:
        if ex.response["Error"]["Code"] == "ConditionalCheckFailedException":
            raise ValueError("QUOTA_LIST_DAILY_UPDATES_EXCEEDED")
        raise


def validate_words(words):
    if not isinstance(words, list):
        raise ValueError("VALIDATION_WORDS_REQUIRED")
    if len(words) > MAX_WORDS_PER_LIST:
        raise ValueError("QUOTA_WORDS_PER_LIST_EXCEEDED")
    for word in words:
        if not isinstance(word, str) or len(word.strip()) == 0:
            raise ValueError("VALIDATION_WORD_INVALID")
        if len(word) > 48:
            raise ValueError("VALIDATION_WORD_TOO_LONG")


def version_number(version_value):
    if not isinstance(version_value, str):
        return 0
    if version_value.startswith("v"):
        try:
            return int(version_value[1:])
        except ValueError:
            return 0
    return 0


def trim_old_versions(list_id):
    result = LIST_VERSIONS_TABLE.query(
        KeyConditionExpression=Key("listId").eq(list_id),
    )
    items = result.get("Items", [])
    items.sort(key=lambda item: version_number(item.get("version")), reverse=True)
    for stale in items[MAX_VERSIONS_PER_LIST:]:
        LIST_VERSIONS_TABLE.delete_item(
            Key={"listId": list_id, "version": stale["version"]}
        )


def create_list(event):
    user_id = user_id_from_event(event)
    if not user_id:
        return response(401, {"code": "AUTH_USER_REQUIRED", "message": "x-user-id header is required."})

    payload = parse_body(event)
    title = str(payload.get("title", "")).strip()
    words = payload.get("words", [])
    checksum = str(payload.get("checksum", "")).strip()

    if not title:
        return response(400, {"code": "VALIDATION_TITLE_REQUIRED", "message": "title is required."})
    if len(title) > 60:
        return response(400, {"code": "VALIDATION_TITLE_TOO_LONG", "message": "title exceeds 60 characters."})

    try:
        validate_words(words)
        increment_daily_user_write_quota(user_id)
    except ValueError as ex:
        return response(400, {"code": str(ex), "message": "Validation or quota failure."})

    word_count = len(words)
    user_scope = f"USER#{user_id}"
    global_scope = "GLOBAL#MAIN"
    user_day_scope = f"DAY#USER#{user_id}#{day_key()}"
    now = now_iso()
    list_id = str(uuid.uuid4())

    item = {
        "listId": list_id,
        "ownerUserId": user_id,
        "title": title,
        "words": words,
        "wordCount": word_count,
        "checksum": checksum,
        "currentVersion": "v1",
        "createdAt": now,
        "updatedAt": now,
    }
    version_item = {
        "listId": list_id,
        "version": "v1",
        "words": words,
        "checksum": checksum,
        "updatedBy": user_id,
        "updatedAt": now,
    }
    try:
        dynamodb_client.transact_write_items(
            TransactItems=[
                {
                    "ConditionCheck": {
                        "TableName": USAGE_TABLE_NAME,
                        "Key": {"scope": ddb_str(user_scope)},
                        "ConditionExpression": "attribute_not_exists(listsCount) OR listsCount < :maxLists",
                        "ExpressionAttributeValues": {":maxLists": ddb_num(MAX_LISTS_PER_USER)},
                    }
                },
                {
                    "ConditionCheck": {
                        "TableName": USAGE_TABLE_NAME,
                        "Key": {"scope": ddb_str(user_scope)},
                        "ConditionExpression": "attribute_not_exists(wordsCount) OR wordsCount <= :maxWordsRemaining",
                        "ExpressionAttributeValues": {":maxWordsRemaining": ddb_num(MAX_TOTAL_WORDS_PER_USER - word_count)},
                    }
                },
                {
                    "ConditionCheck": {
                        "TableName": USAGE_TABLE_NAME,
                        "Key": {"scope": ddb_str(global_scope)},
                        "ConditionExpression": "attribute_not_exists(listsCount) OR listsCount < :maxGlobalLists",
                        "ExpressionAttributeValues": {":maxGlobalLists": ddb_num(MAX_GLOBAL_LISTS)},
                    }
                },
                {
                    "ConditionCheck": {
                        "TableName": USAGE_TABLE_NAME,
                        "Key": {"scope": ddb_str(global_scope)},
                        "ConditionExpression": "attribute_not_exists(wordsCount) OR wordsCount <= :maxGlobalWordsRemaining",
                        "ExpressionAttributeValues": {":maxGlobalWordsRemaining": ddb_num(MAX_GLOBAL_WORDS - word_count)},
                    }
                },
                {
                    "Update": {
                        "TableName": USAGE_TABLE_NAME,
                        "Key": {"scope": ddb_str(user_day_scope)},
                        "UpdateExpression": "SET updatedAt = :updatedAt ADD writesToday :inc",
                        "ConditionExpression": "attribute_not_exists(writesToday) OR writesToday < :maxWrites",
                        "ExpressionAttributeValues": {
                            ":updatedAt": ddb_str(now),
                            ":inc": ddb_num(1),
                            ":maxWrites": ddb_num(MAX_WRITE_OPS_PER_USER_PER_DAY),
                        },
                    }
                },
                {
                    "Put": {
                        "TableName": LISTS_TABLE_NAME,
                        "Item": ddb_item(item),
                        "ConditionExpression": "attribute_not_exists(listId)",
                    }
                },
                {"Put": {"TableName": LIST_VERSIONS_TABLE_NAME, "Item": ddb_item(version_item)}},
                {
                    "Update": {
                        "TableName": USAGE_TABLE_NAME,
                        "Key": {"scope": ddb_str(user_scope)},
                        "UpdateExpression": "SET updatedAt = :updatedAt ADD listsCount :listInc, wordsCount :wordInc",
                        "ExpressionAttributeValues": {
                            ":updatedAt": ddb_str(now),
                            ":listInc": ddb_num(1),
                            ":wordInc": ddb_num(word_count),
                        },
                    }
                },
                {
                    "Update": {
                        "TableName": USAGE_TABLE_NAME,
                        "Key": {"scope": ddb_str(global_scope)},
                        "UpdateExpression": "SET updatedAt = :updatedAt ADD listsCount :listInc, wordsCount :wordInc",
                        "ExpressionAttributeValues": {
                            ":updatedAt": ddb_str(now),
                            ":listInc": ddb_num(1),
                            ":wordInc": ddb_num(word_count),
                        },
                    }
                },
            ]
        )
    except ClientError as ex:
        if ex.response["Error"]["Code"] == "TransactionCanceledException":
            return response(429, {"code": "QUOTA_EXCEEDED", "message": "List or global limits reached."})
        raise

    trim_old_versions(list_id)
    return response(201, item)


def list_lists(event):
    query = event.get("queryStringParameters") or {}
    title_filter = (query.get("title") or "").strip().lower()
    owner_filter = (query.get("owner") or "").strip().lower()
    scan_result = LISTS_TABLE.scan(Limit=100)
    items = scan_result.get("Items", [])

    def keep(item):
        title_ok = title_filter in item.get("title", "").lower()
        owner_ok = owner_filter in item.get("ownerUserId", "").lower()
        return title_ok and owner_ok

    filtered = [item for item in items if keep(item)]
    filtered.sort(key=lambda x: x.get("updatedAt", ""), reverse=True)
    return response(200, {"items": filtered})


def get_list(event):
    list_id = (event.get("pathParameters") or {}).get("listId")
    if not list_id:
        return response(400, {"code": "VALIDATION_LIST_ID_REQUIRED", "message": "listId is required."})
    result = LISTS_TABLE.get_item(Key={"listId": list_id})
    item = result.get("Item")
    if not item:
        return response(404, {"code": "NOT_FOUND", "message": "List not found."})
    return response(200, item)


def update_list(event):
    user_id = user_id_from_event(event)
    if not user_id:
        return response(401, {"code": "AUTH_USER_REQUIRED", "message": "x-user-id header is required."})
    list_id = (event.get("pathParameters") or {}).get("listId")
    if not list_id:
        return response(400, {"code": "VALIDATION_LIST_ID_REQUIRED", "message": "listId is required."})

    payload = parse_body(event)
    title = str(payload.get("title", "")).strip()
    words = payload.get("words", [])
    checksum = str(payload.get("checksum", "")).strip()
    base_version = str(payload.get("baseVersion", "")).strip()

    if not title:
        return response(400, {"code": "VALIDATION_TITLE_REQUIRED", "message": "title is required."})
    if not base_version:
        return response(400, {"code": "VALIDATION_BASE_VERSION_REQUIRED", "message": "baseVersion is required."})

    try:
        validate_words(words)
        increment_daily_user_write_quota(user_id)
        increment_daily_list_update_quota(list_id)
    except ValueError as ex:
        return response(429, {"code": str(ex), "message": "Validation or quota failure."})

    current_result = LISTS_TABLE.get_item(Key={"listId": list_id})
    current = current_result.get("Item")
    if not current:
        return response(404, {"code": "NOT_FOUND", "message": "List not found."})
    if current.get("ownerUserId") != user_id:
        return response(403, {"code": "AUTH_NOT_OWNER", "message": "Only the owner can update this list."})

    if current.get("currentVersion") != base_version:
        return response(
            409,
            {
                "code": "CONFLICT_VERSION_MISMATCH",
                "message": "List has a newer version in cloud.",
                "latest": {
                    "currentVersion": current.get("currentVersion"),
                    "checksum": current.get("checksum"),
                    "updatedAt": current.get("updatedAt"),
                },
            },
        )

    current_num = int(base_version[1:]) if base_version.startswith("v") else 1
    new_version = f"v{current_num + 1}"
    now = now_iso()
    word_count = len(words)

    try:
        LISTS_TABLE.update_item(
            Key={"listId": list_id},
            UpdateExpression=(
                "SET title = :title, words = :words, wordCount = :wordCount, checksum = :checksum, "
                "currentVersion = :newVersion, updatedAt = :updatedAt"
            ),
            ConditionExpression="currentVersion = :baseVersion",
            ExpressionAttributeValues={
                ":title": title,
                ":words": words,
                ":wordCount": word_count,
                ":checksum": checksum,
                ":newVersion": new_version,
                ":updatedAt": now,
                ":baseVersion": base_version,
            },
        )
    except ClientError as ex:
        if ex.response["Error"]["Code"] == "ConditionalCheckFailedException":
            latest = LISTS_TABLE.get_item(Key={"listId": list_id}).get("Item")
            return response(
                409,
                {
                    "code": "CONFLICT_VERSION_MISMATCH",
                    "message": "List has a newer version in cloud.",
                    "latest": {
                        "currentVersion": latest.get("currentVersion"),
                        "checksum": latest.get("checksum"),
                        "updatedAt": latest.get("updatedAt"),
                    },
                },
            )
        raise

    LIST_VERSIONS_TABLE.put_item(
        Item={
            "listId": list_id,
            "version": new_version,
            "words": words,
            "checksum": checksum,
            "updatedBy": user_id,
            "updatedAt": now,
        }
    )
    trim_old_versions(list_id)
    # ponytail: word quota deltas on updates are approximate; tighten with transactional counters if needed.
    return response(200, {"listId": list_id, "currentVersion": new_version, "updatedAt": now})


def delete_list(event):
    user_id = user_id_from_event(event)
    if not user_id:
        return response(401, {"code": "AUTH_USER_REQUIRED", "message": "x-user-id header is required."})
    list_id = (event.get("pathParameters") or {}).get("listId")
    if not list_id:
        return response(400, {"code": "VALIDATION_LIST_ID_REQUIRED", "message": "listId is required."})

    current = LISTS_TABLE.get_item(Key={"listId": list_id}).get("Item")
    if not current:
        return response(404, {"code": "NOT_FOUND", "message": "List not found."})
    if current.get("ownerUserId") != user_id:
        return response(403, {"code": "AUTH_NOT_OWNER", "message": "Only the owner can delete this list."})

    now = now_iso()
    word_count = int(current.get("wordCount", 0))
    user_day_scope = f"DAY#USER#{user_id}#{day_key()}"
    try:
        dynamodb_client.transact_write_items(
            TransactItems=[
                {
                    "Update": {
                        "TableName": USAGE_TABLE_NAME,
                        "Key": {"scope": ddb_str(user_day_scope)},
                        "UpdateExpression": "SET updatedAt = :updatedAt ADD writesToday :inc",
                        "ConditionExpression": "attribute_not_exists(writesToday) OR writesToday < :maxWrites",
                        "ExpressionAttributeValues": {
                            ":updatedAt": ddb_str(now),
                            ":inc": ddb_num(1),
                            ":maxWrites": ddb_num(MAX_WRITE_OPS_PER_USER_PER_DAY),
                        },
                    }
                },
                {
                    "Delete": {
                        "TableName": LISTS_TABLE_NAME,
                        "Key": {"listId": ddb_str(list_id)},
                        "ConditionExpression": "ownerUserId = :owner",
                        "ExpressionAttributeValues": {":owner": ddb_str(user_id)},
                    }
                },
                {
                    "Update": {
                        "TableName": USAGE_TABLE_NAME,
                        "Key": {"scope": ddb_str(f"USER#{user_id}")},
                        "UpdateExpression": "SET updatedAt = :updatedAt ADD listsCount :listDec, wordsCount :wordDec",
                        "ExpressionAttributeValues": {
                            ":updatedAt": ddb_str(now),
                            ":listDec": ddb_num(-1),
                            ":wordDec": ddb_num(-word_count),
                        },
                    }
                },
                {
                    "Update": {
                        "TableName": USAGE_TABLE_NAME,
                        "Key": {"scope": ddb_str("GLOBAL#MAIN")},
                        "UpdateExpression": "SET updatedAt = :updatedAt ADD listsCount :listDec, wordsCount :wordDec",
                        "ExpressionAttributeValues": {
                            ":updatedAt": ddb_str(now),
                            ":listDec": ddb_num(-1),
                            ":wordDec": ddb_num(-word_count),
                        },
                    }
                },
            ]
        )
    except ClientError as ex:
        if ex.response["Error"]["Code"] == "TransactionCanceledException":
            return response(429, {"code": "QUOTA_EXCEEDED", "message": "Daily write limit reached."})
        raise

    versions = LIST_VERSIONS_TABLE.query(
        KeyConditionExpression=Key("listId").eq(list_id),
    ).get("Items", [])
    for item in versions:
        LIST_VERSIONS_TABLE.delete_item(Key={"listId": list_id, "version": item["version"]})

    return response(204, {})


def favorite_list(event, remove=False):
    user_id = user_id_from_event(event)
    if not user_id:
        return response(401, {"code": "AUTH_USER_REQUIRED", "message": "x-user-id header is required."})
    list_id = (event.get("pathParameters") or {}).get("listId")
    if not list_id:
        return response(400, {"code": "VALIDATION_LIST_ID_REQUIRED", "message": "listId is required."})

    if remove:
        FAVORITES_TABLE.delete_item(Key={"userId": user_id, "listId": list_id})
        return response(204, {})

    FAVORITES_TABLE.put_item(
        Item={"userId": user_id, "listId": list_id, "addedAt": now_iso()},
        ConditionExpression="attribute_not_exists(userId) AND attribute_not_exists(listId)",
    )
    return response(201, {"userId": user_id, "listId": list_id})


def list_favorites(event):
    user_id = user_id_from_event(event)
    if not user_id:
        return response(401, {"code": "AUTH_USER_REQUIRED", "message": "x-user-id header is required."})

    result = FAVORITES_TABLE.query(
        KeyConditionExpression=Key("userId").eq(user_id),
    )
    items = result.get("Items", [])
    favorite_ids = [item.get("listId") for item in items if item.get("listId")]
    return response(200, {"listIds": favorite_ids})


def handler(event, _context):
    method = event.get("requestContext", {}).get("http", {}).get("method", "")
    route_key = event.get("routeKey", "")

    try:
        if route_key == "POST /lists":
            return create_list(event)
        if route_key == "GET /lists":
            return list_lists(event)
        if route_key == "GET /lists/{listId}":
            return get_list(event)
        if route_key == "PUT /lists/{listId}":
            return update_list(event)
        if route_key == "DELETE /lists/{listId}":
            return delete_list(event)
        if route_key == "POST /favorites/{listId}":
            return favorite_list(event, remove=False)
        if route_key == "GET /favorites":
            return list_favorites(event)
        if route_key == "DELETE /favorites/{listId}":
            return favorite_list(event, remove=True)
        if method == "OPTIONS":
            return response(204, {})
        return response(404, {"code": "NOT_FOUND", "message": "Route not found."})
    except ValueError as ex:
        return response(400, {"code": str(ex), "message": "Invalid request."})
    except ClientError as ex:
        error_code = ex.response.get("Error", {}).get("Code", "AWS_ERROR")
        return response(500, {"code": error_code, "message": "AWS operation failed."})
