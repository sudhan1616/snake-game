import json
import os
import random
import string
import time
from decimal import Decimal
from typing import Any

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION", "us-east-1")
TABLE_NAME = os.environ.get("TABLE_NAME", "SnakeGameState")
TICK_MS = int(os.environ.get("TICK_MS", "150"))
COLS = int(os.environ.get("BOARD_COLS", "30"))
ROWS = int(os.environ.get("BOARD_ROWS", "20"))
MAX_CAS_RETRIES = int(os.environ.get("MAX_CAS_RETRIES", "4"))

ddb = boto3.resource("dynamodb", region_name=REGION)
table = ddb.Table(TABLE_NAME)
apigw = boto3.client("apigatewaymanagementapi", region_name=REGION)

DIRECTIONS = {
    "up": (0, -1),
    "down": (0, 1),
    "left": (-1, 0),
    "right": (1, 0),
}
OPPOSITE = {
    "up": "down", "down": "up", "left": "right", "right": "left"
}


def now_ms() -> int:
    return int(time.time() * 1000)


def json_default(value: Any):
    if isinstance(value, Decimal):
        return int(value) if value % 1 == 0 else float(value)
    raise TypeError(f"Not JSON serializable: {type(value).__name__}")


def encode(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), default=json_default)


def api_client(event):
    rc = event["requestContext"]
    return boto3.client(
        "apigatewaymanagementapi",
        region_name=REGION,
        endpoint_url=f"https://{rc['domainName']}/{rc['stage']}",
    )


def send(client, connection_id, message):
    try:
        client.post_to_connection(
            ConnectionId=connection_id,
            Data=encode(message).encode("utf-8"),
        )
        return True
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        if code in ("GoneException", "410"):
            return False
        print(f"post_to_connection failed: {code}: {exc}")
        return False


def send_error(client, connection_id, message):
    send(client, connection_id, {"action": "error", "message": message})


def room_key(code):
    return {"pk": f"ROOM#{code}", "sk": "META"}


def get_room(code):
    if not code:
        return None
    result = table.get_item(Key=room_key(code), ConsistentRead=True)
    return result.get("Item")


def get_connection(connection_id):
    result = table.get_item(
        Key={"pk": f"CONN#{connection_id}", "sk": "META"},
        ConsistentRead=True,
    )
    return result.get("Item")


def put_connection(connection_id, code, player):
    table.put_item(Item={
        "pk": f"CONN#{connection_id}",
        "sk": "META",
        "roomCode": code,
        "player": player,
        "connectedAt": now_ms(),
    })


def room_connections(room):
    return list(room.get("players", []))


def broadcast(client, room, message):
    # Remove dead connections opportunistically.
    for connection_id in room_connections(room):
        if not send(client, connection_id, message):
            try:
                table.delete_item(
                    Key={"pk": f"CONN#{connection_id}", "sk": "META"}
                )
            except ClientError:
                pass


def rand_food(snakes):
    occupied = {
        (part["x"], part["y"])
        for snake in snakes.values()
        for part in snake
    }
    free = [
        (x, y)
        for x in range(COLS)
        for y in range(ROWS)
        if (x, y) not in occupied
    ]
    if not free:
        return None
    x, y = random.choice(free)
    return {"x": x, "y": y}


def initial_state():
    snakes = {
        "player1": [{"x": 5, "y": 8}, {"x": 4, "y": 8}, {"x": 3, "y": 8}],
        "player2": [
            {"x": COLS - 6, "y": ROWS - 9},
            {"x": COLS - 5, "y": ROWS - 9},
            {"x": COLS - 4, "y": ROWS - 9},
        ],
    }
    return {
        "tick": 0,
        "snakes": snakes,
        "directions": {"player1": "right", "player2": "left"},
        "food": rand_food(snakes),
        "scores": {"player1": 0, "player2": 0},
        "winner": None,
        "loser": None,
        "reason": None,
    }


def public_state(room):
    return {
        "action": "state",
        "roomCode": room["roomCode"],
        "status": room["status"],
        "version": int(room.get("version", 0)),
        "tick": int(room.get("tick", 0)),
        "board": {"cols": COLS, "rows": ROWS},
        "state": json.loads(room.get("gameState", "{}")),
        "tickMs": TICK_MS,
    }


def reply_state(client, room):
    broadcast(client, room, public_state(room))


def find_collision(state):
    snakes = state["snakes"]
    heads = {p: snake[0] for p, snake in snakes.items() if snake}
    if len(heads) != 2:
        return None

    # Walls
    for player, head in heads.items():
        if head["x"] < 0 or head["x"] >= COLS or head["y"] < 0 or head["y"] >= ROWS:
            return player, "wall"

    # Head-on or head-swap collision
    p1, p2 = "player1", "player2"
    h1, h2 = heads[p1], heads[p2]
    if h1 == h2:
        return "both", "head_on"
    old1 = state.get("_oldHeads", {}).get(p1)
    old2 = state.get("_oldHeads", {}).get(p2)
    if old1 and old2 and h1 == old2 and h2 == old1:
        return "both", "head_swap"

    # Body collisions: exclude each snake's own current head.
    for player, head in heads.items():
        opponent = p2 if player == p1 else p1
        own_body = snakes[player][1:]
        other_body = snakes[opponent][1:]
        if head in own_body:
            return player, "self_collision"
        if head in other_body or head == snakes[opponent][0]:
            return player, "snake_collision"

    return None


def advance_state(state):
    state = json.loads(encode(state))
    old_heads = {
        player: snake[0].copy()
        for player, snake in state["snakes"].items()
        if snake
    }
    next_heads = {}
    for player, snake in state["snakes"].items():
        dx, dy = DIRECTIONS[state["directions"][player]]
        next_heads[player] = {"x": snake[0]["x"] + dx, "y": snake[0]["y"] + dy}

    # Determine food-eating before movement; tail cells can vacate unless eaten.
    eats = {
        player: (state.get("food") is not None and head == state["food"])
        for player, head in next_heads.items()
    }

    # Advance snakes simultaneously.
    for player, snake in state["snakes"].items():
        snake.insert(0, next_heads[player])
        if not eats[player]:
            snake.pop()

    state["_oldHeads"] = old_heads
    collision = find_collision(state)
    state.pop("_oldHeads", None)

    if collision:
        loser, reason = collision
        state["loser"] = loser
        state["winner"] = (
            None if loser == "both"
            else ("player2" if loser == "player1" else "player1")
        )
        state["reason"] = reason
        state["tick"] += 1
        return state, True

    # Score and food are decided centrally by Lambda.
    for player, did_eat in eats.items():
        if did_eat:
            state["scores"][player] += 1

    if any(eats.values()):
        state["food"] = rand_food(state["snakes"])
        if state["food"] is None:
            state["winner"] = max(
                state["scores"], key=state["scores"].get
            )
            state["reason"] = "board_filled"
            state["tick"] += 1
            return state, True

    state["tick"] += 1
    return state, False


def conditional_room_update(code, room, **attributes):
    """
    Optimistic concurrency: every mutation increments version and only
    succeeds if the version read is still current.
    """
    names = {"#version": "version"}
    values = {":old_version": int(room.get("version", 0)), ":new_version": int(room.get("version", 0)) + 1}
    sets = ["#version = :new_version"]
    for index, (name, value) in enumerate(attributes.items()):
        nk, vk = f"#n{index}", f":v{index}"
        names[nk] = name
        values[vk] = value
        sets.append(f"{nk} = {vk}")

    return table.update_item(
        Key=room_key(code),
        UpdateExpression="SET " + ", ".join(sets),
        ConditionExpression="#version = :old_version",
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
        ReturnValues="ALL_NEW",
    )["Attributes"]


def message_profile(event):
    try:
        body = event.get("body") or "{}"
        message = json.loads(body) if isinstance(body, str) else body
        return message.get("profile") or {}
    except Exception:
        return {}


def clean_profile(profile):
    if not isinstance(profile, dict):
        profile = {}
    name = " ".join(str(profile.get("name", "Player")).split())[:20] or "Player"
    avatar = str(profile.get("avatar", "🐍"))[:8]
    # Stable browser-generated id lets renamed profiles keep their personal best.
    profile_id = str(profile.get("id", "")).strip()[:80]
    if not profile_id:
        profile_id = "guest-" + "".join(random.choices(string.ascii_lowercase + string.digits, k=16))
    return {"id": profile_id, "name": name, "avatar": avatar}


def get_leaderboard(profile_id=None):
    result = table.query(
        KeyConditionExpression=Key("pk").eq("LEADERBOARD"),
        ConsistentRead=True,
    )
    entries = [item for item in result.get("Items", []) if item.get("sk", "").startswith("PLAYER#")]
    entries.sort(key=lambda item: int(item.get("bestScore", 0)), reverse=True)
    mvp_item = next((item for item in result.get("Items", []) if item.get("sk") == "MVP"), None)
    personal_item = next((item for item in entries if profile_id and item.get("profileId") == profile_id), None)
    return {
        "action": "leaderboard",
        "personalBest": int(personal_item.get("bestScore", 0)) if personal_item else 0,
        "mvp": ({"id": mvp_item.get("profileId"), "name": mvp_item.get("name", "Player"),
                 "avatar": mvp_item.get("avatar", "🐍"), "score": int(mvp_item.get("bestScore", 0))}
                if mvp_item else None),
        "leaderboard": [{"id": item.get("profileId"), "name": item.get("name", "Player"),
                          "avatar": item.get("avatar", "🐍"), "score": int(item.get("bestScore", 0))}
                         for item in entries[:10]],
    }


def update_saved_profile(profile):
    profile = clean_profile(profile)
    profile_id = profile["id"]
    key = {"pk": "LEADERBOARD", "sk": f"PLAYER#{profile_id}"}
    existing = table.get_item(Key=key, ConsistentRead=True).get("Item")
    if existing:
        table.update_item(
            Key=key,
            UpdateExpression="SET #nm = :nm, avatar = :av",
            ExpressionAttributeNames={"#nm": "name"},
            ExpressionAttributeValues={":nm": profile["name"], ":av": profile["avatar"]},
        )
        mvp_key = {"pk": "LEADERBOARD", "sk": "MVP"}
        mvp = table.get_item(Key=mvp_key, ConsistentRead=True).get("Item")
        if mvp and mvp.get("profileId") == profile_id:
            table.update_item(
                Key=mvp_key,
                UpdateExpression="SET #nm = :nm, avatar = :av",
                ExpressionAttributeNames={"#nm": "name"},
                ExpressionAttributeValues={":nm": profile["name"], ":av": profile["avatar"]},
            )


def record_game_results(room, state):
    """Persist per-profile best scores and the all-time MVP in the same DynamoDB table."""
    profiles = room.get("profiles", {})
    scores = state.get("scores", {})
    for player_name in ("player1", "player2"):
        profile = profiles.get(player_name) or {}
        profile_id = str(profile.get("id", "")).strip()
        if not profile_id:
            continue
        score = int(scores.get(player_name, 0))
        key = {"pk": "LEADERBOARD", "sk": f"PLAYER#{profile_id}"}
        old = table.get_item(Key=key, ConsistentRead=True).get("Item")
        old_best = int(old.get("bestScore", 0)) if old else -1
        if score > old_best:
            table.put_item(Item={
                **key, "profileId": profile_id, "name": profile.get("name", "Player"),
                "avatar": profile.get("avatar", "🐍"), "bestScore": score,
                "updatedAt": now_ms(),
            })
        # Refresh the stored name/avatar even when a player's record did not improve.
        elif old:
            table.update_item(
                Key=key,
                UpdateExpression="SET #nm = :nm, avatar = :av",
                ExpressionAttributeNames={"#nm": "name"},
                ExpressionAttributeValues={":nm": profile.get("name", "Player"), ":av": profile.get("avatar", "🐍")},
            )
    # MVP means the all-time highest single-game score, not the current room winner.
    result = table.query(KeyConditionExpression=Key("pk").eq("LEADERBOARD"), ConsistentRead=True)
    entries = [item for item in result.get("Items", []) if item.get("sk", "").startswith("PLAYER#")]
    if entries:
        champion = max(entries, key=lambda item: int(item.get("bestScore", 0)))
        existing = table.get_item(Key={"pk": "LEADERBOARD", "sk": "MVP"}, ConsistentRead=True).get("Item")
        if not existing or int(champion.get("bestScore", 0)) >= int(existing.get("bestScore", 0)):
            table.put_item(Item={
                "pk": "LEADERBOARD", "sk": "MVP", "profileId": champion.get("profileId"),
                "name": champion.get("name", "Player"), "avatar": champion.get("avatar", "🐍"),
                "bestScore": int(champion.get("bestScore", 0)), "updatedAt": now_ms(),
            })


def handle_create(event, client, connection_id):
    code = "".join(random.choices(string.ascii_uppercase + string.digits, k=6))
    # Conditional put prevents the very unlikely room-code collision.
    item = {
        **room_key(code),
        "roomCode": code,
        "players": [connection_id],
        "playerMap": {connection_id: "player1"},
        "profiles": {"player1": clean_profile(message_profile(event))},
        "status": "waiting",
        "version": 0,
        "createdAt": now_ms(),
        "expiresAt": int(time.time()) + 86400,
    }
    try:
        table.put_item(
            Item=item,
            ConditionExpression="attribute_not_exists(pk)",
        )
    except ClientError as exc:
        error_code = exc.response.get("Error", {}).get("Code", "")
        if error_code == "ConditionalCheckFailedException":
            # A room-code collision is rare; generate another code.
            return handle_create(event, client, connection_id)
        # Surface real AWS errors (permissions, throttling, table issues)
        # instead of retrying recursively forever.
        raise

    put_connection(connection_id, code, "player1")
    send(client, connection_id, {
        "action": "roomCreated",
        "roomCode": code,
        "player": "player1",
        "profiles": item["profiles"],
        "status": "waiting",
        "message": "Room created. Waiting for player 2.",
    })


def handle_join(client, connection_id, message):
    code = str(message.get("roomCode", "")).strip().upper()
    room = get_room(code)
    if not room:
        send_error(client, connection_id, "Room not found.")
        return

    if room.get("status") != "waiting":
        send_error(client, connection_id, "Room is not available to join.")
        return

    if connection_id in room_connections(room):
        send(client, connection_id, {
            "action": "roomJoined", "roomCode": code,
            "player": room.get("playerMap", {}).get(connection_id, "player1"),
            "profiles": room.get("profiles", {}), "status": room.get("status", "waiting")
        })
        return

    # A room is strictly two-player. Check after the duplicate-connection
    # branch so an existing member can safely retry joining.
    if len(room_connections(room)) >= 2:
        send_error(client, connection_id, "Room is full.")
        return

    try:
        game_state = initial_state()
        updated = conditional_room_update(
            code,
            room,
            players=room_connections(room) + [connection_id],
            playerMap={**room.get("playerMap", {}), connection_id: "player2"},
            profiles={**room.get("profiles", {}), "player2": clean_profile(message.get("profile", {}))},
            status="waiting",
            gameState=encode(game_state),
            tick=0,
            lastTickAt=0,
        )
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            send_error(client, connection_id, "Room changed. Please try joining again.")
            return
        raise

    put_connection(connection_id, code, "player2")
    # Send a player-specific join event so each browser knows its own role.
    # A shared broadcast with player="player2" would incorrectly tell player 1
    # that it is player 2 as well.
    for joined_connection_id in room_connections(updated):
        assigned_player = updated.get("playerMap", {}).get(joined_connection_id)
        send(client, joined_connection_id, {
            "action": "playerJoined",
            "roomCode": code,
            "player": assigned_player,
            "profiles": updated.get("profiles", {}),
            "status": "waiting",
            "message": "Both players connected. Waiting for the room creator to start.",
        })
    reply_state(client, updated)


def handle_start_game(client, connection_id):
    connection = get_connection(connection_id)
    if not connection:
        send_error(client, connection_id, "Create or join a room first.")
        return
    if connection.get("player") != "player1":
        send_error(client, connection_id, "Only the room creator can start the game.")
        return
    code = connection["roomCode"]
    for _ in range(MAX_CAS_RETRIES):
        room = get_room(code)
        if not room:
            send_error(client, connection_id, "Room not found.")
            return
        if room.get("status") == "playing":
            reply_state(client, room)
            return
        if room.get("status") != "waiting":
            send_error(client, connection_id, "This room cannot be started.")
            return
        if len(room_connections(room)) != 2 or not room.get("profiles", {}).get("player2"):
            send_error(client, connection_id, "Wait until the second player joins.")
            return
        game_state = initial_state()
        now = now_ms()
        try:
            updated = conditional_room_update(
                code, room, status="playing", gameState=encode(game_state),
                tick=0, lastTickAt=now, startedAt=now
            )
            broadcast(client, updated, {
                "action": "gameStarted", "roomCode": code, "status": "playing",
                "profiles": updated.get("profiles", {}), "message": "The game has started!"
            })
            reply_state(client, updated)
            return
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
                raise
    send_error(client, connection_id, "Could not start due to simultaneous updates. Please try again.")


def handle_move(client, connection_id, message):
    connection = get_connection(connection_id)
    if not connection:
        send_error(client, connection_id, "Create or join a room first.")
        return
    code = connection["roomCode"]
    player = connection["player"]
    direction = message.get("direction")
    if direction not in DIRECTIONS:
        send_error(client, connection_id, "Invalid direction.")
        return

    for _ in range(MAX_CAS_RETRIES):
        room = get_room(code)
        if not room or room.get("status") != "playing":
            send_error(client, connection_id, "The game is not active.")
            return
        state = json.loads(room["gameState"])
        current = state["directions"][player]
        if direction == OPPOSITE[current]:
            return
        if direction == current:
            return
        state["directions"][player] = direction
        try:
            updated = conditional_room_update(
                code, room, gameState=encode(state)
            )
            reply_state(client, updated)
            return
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
                raise
    send_error(client, connection_id, "Busy game state; retry your move.")


def handle_tick(client, connection_id):
    connection = get_connection(connection_id)
    if not connection:
        send_error(client, connection_id, "Create or join a room first.")
        return

    code = connection["roomCode"]
    now = now_ms()

    for _ in range(MAX_CAS_RETRIES):
        room = get_room(code)
        if not room or room.get("status") != "playing":
            return

        last_tick = int(room.get("lastTickAt", now))
        # Any connected player may request a tick, but Lambda controls the
        # actual cadence and advances at most one step per accepted tick.
        if now - last_tick < TICK_MS:
            return

        state = json.loads(room["gameState"])
        next_state, finished = advance_state(state)

        try:
            updated = conditional_room_update(
                code,
                room,
                gameState=encode(next_state),
                tick=int(next_state["tick"]),
                lastTickAt=now,
                status="finished" if finished else "playing",
                finishedAt=now if finished else room.get("finishedAt", 0),
            )
            reply_state(client, updated)
            if finished:
                record_game_results(updated, next_state)
                broadcast(client, updated, {
                    "action": "gameOver",
                    "roomCode": code,
                    "status": "finished",
                    "winner": next_state.get("winner"),
                    "loser": next_state.get("loser"),
                    "reason": next_state.get("reason"),
                    "scores": next_state.get("scores"),
                    "message": game_over_message(next_state),
                })
            return
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
                raise

    # Contention is normal when both browsers send ticks.
    return


def game_over_message(state):
    reason = state.get("reason", "collision")
    winner = state.get("winner")
    loser = state.get("loser")
    if winner and loser:
        return f"{loser} lost ({reason}). {winner} wins!"
    if reason == "board_filled":
        return f"Board filled! {winner or 'A player'} wins!"
    return f"Game over: {reason}."


def handle_disconnect(event, client, connection_id):
    connection = get_connection(connection_id)
    if not connection:
        return

    code = connection.get("roomCode")
    room = get_room(code)
    if room and room.get("status") == "playing":
        # Production policy: disconnect forfeits the game. This is a
        # conditional update so only one disconnect can finish the room.
        for _ in range(MAX_CAS_RETRIES):
            room = get_room(code)
            if not room or room.get("status") != "playing":
                break
            state = json.loads(room["gameState"])
            player = connection.get("player")
            state["loser"] = player
            state["winner"] = "player2" if player == "player1" else "player1"
            state["reason"] = "disconnect"
            try:
                updated = conditional_room_update(
                    code, room,
                    gameState=encode(state),
                    status="finished",
                    finishedAt=now_ms(),
                )
                record_game_results(updated, state)
                broadcast(client, updated, {
                    "action": "gameOver",
                    "roomCode": code,
                    "status": "finished",
                    "winner": state["winner"],
                    "loser": player,
                    "reason": "disconnect",
                    "scores": state["scores"],
                    "message": f"{player} disconnected. {state['winner']} wins.",
                })
                break
            except ClientError as exc:
                if exc.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
                    raise

    # Keep finished room membership for the game-over notification/history,
    # but delete the disconnected connection lookup.
    table.delete_item(Key={"pk": f"CONN#{connection_id}", "sk": "META"})


def lambda_handler(event, context):
    request_context = event.get("requestContext", {})
    route = request_context.get("routeKey", "")
    connection_id = request_context.get("connectionId")

    if route == "$connect":
        return {"statusCode": 200, "body": "Connected"}

    try:
        client = api_client(event)
        if route == "$disconnect":
            handle_disconnect(event, client, connection_id)
            return {"statusCode": 200, "body": "Disconnected"}

        raw_body = event.get("body") or "{}"
        message = json.loads(raw_body) if isinstance(raw_body, str) else raw_body
        action = message.get("action") or route

        if action == "createRoom":
            handle_create(event, client, connection_id)
        elif action == "joinRoom":
            handle_join(client, connection_id, message)
        elif action == "startGame":
            handle_start_game(client, connection_id)
        elif action == "move":
            handle_move(client, connection_id, message)
        elif action == "tick":
            handle_tick(client, connection_id)
        elif action == "getLeaderboard":
            profile_id = str(message.get("profileId", ""))[:80]
            send(client, connection_id, get_leaderboard(profile_id))
        elif action == "updateProfile":
            update_saved_profile(message.get("profile", {}))
            send(client, connection_id, {"action": "profileUpdated", "message": "Profile updated."})
        elif action == "ping":
            send(client, connection_id, {"action": "pong", "time": now_ms()})
        else:
            send_error(client, connection_id, f"Unsupported action: {action}")

        return {"statusCode": 200, "body": "OK"}

    except Exception as exc:
        print(f"Unhandled error: {type(exc).__name__}: {exc}")
        try:
            if connection_id:
                send(api_client(event), connection_id, {
                    "action": "error",
                    "message": "Internal server error. Check Lambda logs.",
                })
        except Exception:
            pass
        return {"statusCode": 500, "body": "Internal server error"}
